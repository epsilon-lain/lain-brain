"""Offline, inference-only diagnostic for existing Parameter Golf language GPTs.

No optimizer, teacher, provider, Brain mutation, or automatic capability verdict.
Diagnostic prompts are public development probes, never future held-out tests.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import gc
import json
import math
from pathlib import Path
import sys
import time
import uuid

from laptop_train import (file_digest, infer_shape, json_write, load_checkpoint,
                          load_gpt, logits, snapshot)

DEFAULTS = dict(tied_embed_init_std=0.005, logit_softcap=30.0,
                rope_base=10000.0, qk_gain_init=1.5)
GENERATIONS = [
    ("ordinary_continuation", "A library is a place where people"),
    ("ordinary_continuation", "Water can be a solid, a liquid, or"),
    ("rule_completion", "The rule is y = 2*x + 1. When x = 3, y ="),
    ("few_shot_rule", "Double then add one: 1 -> 3; 2 -> 5; 3 -> 7; 4 ->"),
    ("explanation", "Explain in simple words what y = 2*x + 1 means.\nExplanation:"),
    ("composition", "First double the number 3. Then add 1 to the result.\nResult:"),
]
CHOICES = [
    ("The rule is y = 2*x + 1. When x = 3, y =", [" 5", " 6", " 7", " 8"], 2),
    ("The rule is y = x + 2. When x = 4, y =", [" 4", " 5", " 6", " 7"], 2),
    ("Double then add one: 1 -> 3; 2 -> 5; 3 -> 7; 4 ->", [" 6", " 7", " 8", " 9"], 3),
    ("First double the number 2. Then add 1 to the result.\nResult:", [" 3", " 4", " 5", " 6"], 2),
]


def inspect_checkpoint(path, vocab_size):
    import torch
    if not path.is_file() or not 0 < path.stat().st_size <= 512 * 1024**2:
        raise ValueError("Missing/empty checkpoint or file exceeds 512 MiB")
    state, saved = load_checkpoint(path)
    shape = infer_shape(state)
    if shape["vocab_size"] != vocab_size:
        raise ValueError(f"Vocabulary {shape['vocab_size']} != language tokenizer {vocab_size}; not this language GPT")
    count = sum(t.numel() for t in state.values())
    if not 0 < count <= 100_000_000:
        raise ValueError("Checkpoint exceeds 100M tensor elements")
    if not all(t.is_floating_point() and torch.isfinite(t).all().item() for t in state.values()):
        raise ValueError("Expected finite, unquantized floating tensors")
    config = dict(shape, **DEFAULTS)
    if saved is not None:
        if not isinstance(saved, dict) or set(saved) != set(config):
            raise ValueError("Unsupported saved model config")
        if any(saved[k] != v for k, v in shape.items()):
            raise ValueError("Saved config disagrees with tensor shapes")
        for key in DEFAULTS:
            value = saved[key]
            if not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise ValueError(f"Invalid config value: {key}")
        config.update(saved)
    metadata = {"path": str(path), "sha256": file_digest(path),
                "parameterCount": count, "modelConfig": config,
                "rawCheckpointDefaultsAssumed": saved is None}
    return state, metadata


def candidate_paths(project):
    paths = []
    if (project / "final_model.pt").is_file():
        paths.append(project / "final_model.pt")
    runs = project / "laptop_runs"
    if runs.is_dir():
        for folder in runs.glob("gpt-laptop-*"):
            if not folder.is_dir():
                continue
            checkpoints = sorted(folder.glob("checkpoint-*.pt"))
            if checkpoints:
                paths.append(checkpoints[-1])
    # Bounded scan, language runs only. Do not select affine/reviewer models.
    final = project / "final_model.pt"
    rest = sorted((p for p in paths if p != final), key=lambda p: p.stat().st_mtime_ns, reverse=True)
    return ([final] if final in paths else []) + rest[:9]


def select_candidates(valid, limit):
    ordered = sorted(valid, key=lambda item: (item["parameterCount"], Path(item["path"]).stat().st_mtime_ns), reverse=True)
    final = [item for item in valid if Path(item["path"]).name == "final_model.pt"]
    selected, seen = [], set()
    for item in final + ordered:
        if item["sha256"] not in seen:
            selected.append(item)
            seen.add(item["sha256"])
        if len(selected) == limit:
            break
    return selected


def encode(sp, text):
    ids = sp.encode(text, out_type=int)
    if not ids or len(ids) > 512:
        raise ValueError("Probe text must encode to 1..512 tokens")
    return ids


def generate(model, sp, prompt, device, new_tokens):
    import torch
    ids = encode(sp, prompt)
    generated = []
    with torch.no_grad():
        for _ in range(new_tokens):
            scores = logits(model, torch.tensor([ids + generated], device=device))[0, -1].float()
            if not torch.isfinite(scores).all().item():
                raise ValueError("Nonfinite generation logits")
            token = int(scores.argmax().item())
            generated.append(token)
            if sp.eos_id() >= 0 and token == sp.eos_id():
                break
    return {"prompt": prompt, "generatedTokenIds": generated,
            "continuation": sp.decode(generated), "promptUnknownTokens": ids.count(sp.unk_id())}


def score_choice(model, sp, prompt, choices, correct, device):
    import torch
    import torch.nn.functional as F
    prefix = encode(sp, prompt)
    scores, lengths = [], []
    with torch.no_grad():
        for choice in choices:
            suffix = encode(sp, choice)
            sequence = prefix + suffix
            ids = torch.tensor([sequence], device=device)
            values = F.log_softmax(logits(model, ids[:, :-1]).float(), dim=-1)[0]
            targets = ids[0, len(prefix):]
            lp = values[len(prefix) - 1:, :].gather(1, targets[:, None]).sum().item()
            if not math.isfinite(lp):
                raise ValueError("Nonfinite choice likelihood")
            scores.append(lp)
            lengths.append(len(suffix))
    # Candidate suffixes are tokenized separately, explicitly recorded below.
    # Total suffix log likelihood, not length-normalized or a reasoning score.
    picked = max(range(len(scores)), key=scores.__getitem__)
    return {"prompt": prompt, "choices": choices, "correctIndex": correct,
            "predictedIndex": picked, "correct": picked == correct,
            "suffixLogLikelihoods": scores, "suffixTokenCounts": lengths,
            "tokenization": "encode(prompt) + encode(suffix); no target in model input before its position"}


def language_eval(model, tokens, device):
    import torch
    import torch.nn.functional as F
    length = 256
    total, correct, loss_sum = 0, 0, 0.0
    with torch.no_grad():
        for start in range(0, len(tokens) - length, length):
            ids = torch.tensor([[int(t) for t in tokens[start:start + length + 1]]], device=device)
            scores = logits(model, ids[:, :-1]).float()
            loss = F.cross_entropy(scores.reshape(-1, scores.shape[-1]), ids[:, 1:].reshape(-1))
            loss_sum += float(loss.item()) * length
            correct += int((scores.argmax(-1) == ids[:, 1:]).sum().item())
            total += length
    if not total or not math.isfinite(loss_sum):
        raise ValueError("Invalid language evaluation")
    return {"loss": loss_sum / total, "nextTokenAccuracy": correct / total, "evaluatedTokens": total}


def markdown(report):
    lines = ["# GPT 起点能力检查", "", "这是开发诊断，未训练、未调用老师；不是正式研究评测或能力证明。", "",
             "英文提示适配现有 FineWeb 英文训练背景。续写差不直接证明无法训练，指令表现差也不等于没有语言能力。", "",
             "选择题只有四道，每题四个选项；它不代替解释及自由生成检查。后续实验必须另设未使用过的测试。", ""]
    for item in report["models"]:
        lines += [f"## {Path(item['path']).parent.name}/{Path(item['path']).name}", "",
                  f"参数：{item['parameterCount']:,}；权重 SHA256：`{item['sha256']}`", "",
                  f"选择题：{item['choicesCorrect']}/4（辅助诊断）", ""]
        if item["languageEvaluation"]:
            value = item["languageEvaluation"]
            lines += [f"固定验证前缀：loss={value['loss']:.4f}；下一 token 准确率={value['nextTokenAccuracy']:.4f}；{value['evaluatedTokens']} tokens。", ""]
        for sample in item["generations"]:
            # JSON quoting avoids interpreting generated markdown/code as report instructions.
            lines += [f"提示：{json.dumps(sample['prompt'], ensure_ascii=False)}", "",
                      f"续写：{json.dumps(sample['continuation'], ensure_ascii=False)}", ""]
    lines += ["## 下一步", "", "人工读取以上原始输出，再决定能否直接进入 zip 实验；本脚本不自动判定理解、智能或训练成功。", "",
              "Apertus 将作为示范/反例/修订的指导者，训练发生在本地学生；奖励仍按经过检验的建模与推进。", ""]
    return "\n".join(lines)


def run(args):
    import torch
    import sentencepiece as spm
    project = args.project.resolve()
    GPT, source_sha = load_gpt(project / "train_gpt.py")
    tokenizer = (args.tokenizer or project / "data/tokenizers/fineweb_1024_bpe.model").resolve()
    sp = spm.SentencePieceProcessor(model_file=str(tokenizer))
    paths = [p.resolve() for p in args.checkpoint] if args.checkpoint else candidate_paths(project)
    valid, rejected = [], []
    for path in paths:
        try:
            state, metadata = inspect_checkpoint(path, sp.vocab_size())
            valid.append(metadata)
            del state
        except (ValueError, KeyError, RuntimeError, OSError) as error:
            if args.checkpoint:
                raise
            rejected.append({"path": str(path), "reason": str(error)})
    if not valid:
        raise ValueError("No compatible language checkpoint found; affine/reviewer weights are not language weights")
    selected = select_candidates(valid, args.max_models)
    print(json.dumps({"status": "probe_preflight_ok", "selected": selected, "rejected": rejected}, ensure_ascii=False, indent=2), flush=True)
    if args.inspect:
        return
    if args.device == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA unavailable; use --device cpu explicitly")
    device = torch.device(args.device)
    torch.manual_seed(1337)
    if args.device == "cpu":
        torch.set_num_threads(min(torch.get_num_threads(), 4))
    else:
        torch.backends.cuda.enable_flash_sdp(False)
        torch.backends.cuda.enable_mem_efficient_sdp(False)
        torch.backends.cuda.enable_math_sdp(True)
        torch.backends.cuda.enable_cudnn_sdp(False)
        torch.backends.cuda.matmul.allow_tf32 = False
    evaluation, evaluation_sha, provenance, evaluation_note = None, None, [], None
    files = sorted((project / "data").rglob("fineweb_val_*.bin"))
    if files:
        evaluation, evaluation_sha, provenance = snapshot(files, 1025)
        if len(evaluation) < 257 or int(evaluation.max()) >= sp.vocab_size():
            raise ValueError("Invalid/insufficient language evaluation tokens")
    else:
        evaluation_note = "No validation shard; generation and choice probes only"
    out = args.out or project / "laptop_runs" / ("gpt-probe-" + uuid.uuid4().hex[:12])
    out.mkdir(parents=True, exist_ok=False)
    report = {"schemaVersion": 1, "kind": "inference_diagnostic", "trainingUpdates": 0,
              "teacherCalls": 0, "device": args.device, "precision": "fp32",
              "recordedAt": datetime.now(timezone.utc).isoformat(), "modelSourceSha256": source_sha,
              "runnerSha256": file_digest(Path(__file__)), "tokenizerSha256": file_digest(tokenizer),
              "torchVersion": str(torch.__version__), "selected": selected, "inventory": valid,
              "rejected": rejected, "evalSnapshotSha256": evaluation_sha, "evalProvenance": provenance,
              "evaluationNote": evaluation_note, "models": [],
              "scope": "Public development probes; not a held-out research test. Greedy generation, 4-way suffix likelihood ranking; no capability threshold.",
              "choiceChanceReference": 0.25, "maxNewTokens": args.new_tokens}
    json_write(out / "manifest.json", {k: v for k, v in report.items() if k != "models"})
    for index, metadata in enumerate(selected, 1):
        print(f"PROBE {index}/{len(selected)}: {metadata['path']}", flush=True)
        started = time.perf_counter()
        state, loaded = inspect_checkpoint(Path(metadata["path"]), sp.vocab_size())
        if loaded != metadata:
            raise ValueError("Checkpoint changed after inventory")
        model = GPT(**metadata["modelConfig"])
        model.load_state_dict(state, strict=True)
        del state
        model.requires_grad_(False).to(device).eval()
        samples = []
        for kind, prompt in GENERATIONS:
            sample = generate(model, sp, prompt, device, args.new_tokens)
            samples.append(dict(kind=kind, **sample))
            print(f"  {kind}: {json.dumps(sample['continuation'], ensure_ascii=False)}", flush=True)
        choices = [score_choice(model, sp, prompt, options, correct, device) for prompt, options, correct in CHOICES]
        item = dict(metadata, generations=samples, choices=choices,
                    choicesCorrect=sum(c["correct"] for c in choices),
                    languageEvaluation=language_eval(model, evaluation, device) if evaluation is not None else None,
                    elapsedSeconds=time.perf_counter() - started)
        if file_digest(Path(metadata["path"])) != metadata["sha256"]:
            raise ValueError("Checkpoint changed while probing")
        report["models"].append(item)
        json_write(out / f"model-{index:03}.json", item)
        del model
        gc.collect()
        if args.device == "cuda":
            torch.cuda.empty_cache()
        print(f"  choice diagnostic: {item['choicesCorrect']}/4", flush=True)
    json_write(out / "report.json", report)
    (out / "report.md").write_text(markdown(report), encoding="utf-8")
    print(f"DONE. Diagnostic only, no training. Report: {out / 'report.md'}", flush=True)


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--project", type=Path, required=True)
    p.add_argument("--checkpoint", type=Path, action="append", default=[])
    p.add_argument("--tokenizer", type=Path)
    p.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
    p.add_argument("--max-models", type=int, choices=[1, 2], default=2)
    p.add_argument("--new-tokens", type=int, choices=range(1, 65), default=24)
    p.add_argument("--inspect", action="store_true", help="Inventory only; no inference or report writes")
    p.add_argument("--out", type=Path)
    return p


if __name__ == "__main__":
    try:
        run(parser().parse_args())
    except KeyboardInterrupt:
        print("Stopped. Existing checkpoint unchanged; partial diagnostic files retained.", file=sys.stderr)
        sys.exit(130)
    except Exception as error:
        print(f"STOP: {error}", file=sys.stderr)
        sys.exit(1)
