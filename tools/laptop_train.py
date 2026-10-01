"""Single-device learning baseline for the user's local Parameter Golf GPT.

Reuses model definitions from the reviewed train_gpt.py, never calls its main().
This is next-token training, not object discovery or a competition score.
"""
from __future__ import annotations

import argparse
import ast
from contextlib import nullcontext
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import random
import sys
import time
import uuid

# Hash the normalized source so Windows/Linux newline conversion is harmless.
MODEL_DEFINITIONS = {"RMSNorm", "CastedLinear", "Rotary", "apply_rotary_emb",
                     "CausalSelfAttention", "MLP", "Block", "GPT"}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load_gpt(source: Path):
    import torch
    import torch.nn.functional as F
    text = source.read_text(encoding="utf-8")
    expected = Path(__file__).with_name("model-source.sha256").read_text().strip()
    if digest(text.encode()) != expected:
        raise ValueError("train_gpt.py differs from the reviewed source. Stop and review the new file first.")
    tree = ast.parse(text)
    nodes = [n for n in tree.body if isinstance(n, (ast.ClassDef, ast.FunctionDef))
             and n.name in MODEL_DEFINITIONS]
    if {n.name for n in nodes} != MODEL_DEFINITIONS:
        raise ValueError("Missing GPT model definitions")
    namespace = {"torch": torch, "nn": torch.nn, "Tensor": torch.Tensor, "F": F}
    # Only the eight reviewed model definitions are evaluated, not the upstream
    # imports, environment hyperparameters, optimizer, or training entry point.
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source), "exec"), namespace)
    return namespace["GPT"], digest(text.encode())


def snapshot(files: list[Path], limit: int):
    import numpy as np
    pieces, provenance, remaining = [], [], limit
    for path in files:
        if remaining <= 0:
            break
        header = np.fromfile(path, dtype="<i4", count=256)
        if len(header) != 256 or tuple(header[:2]) != (20240520, 1) or int(header[2]) <= 0:
            raise ValueError(f"Invalid token shard header: {path}")
        count = int(header[2])
        if path.stat().st_size != 1024 + 2 * count:
            raise ValueError(f"Token shard length mismatch: {path}")
        take = min(remaining, count)
        # Read only the prefix used in this experiment, never the full 10B corpus.
        part = np.fromfile(path, dtype="<u2", count=take, offset=1024)
        if len(part) != take:
            raise ValueError(f"Short read: {path}")
        pieces.append(part)
        provenance.append({"file": str(path), "startToken": 0, "tokenCount": take})
        remaining -= take
    if not pieces:
        raise ValueError("No usable token shards found")
    tokens = np.concatenate(pieces).astype("<u2", copy=False)
    return tokens, digest(tokens.tobytes()), provenance


def infer_shape(state: dict) -> dict:
    import torch
    if not state or not all(isinstance(v, torch.Tensor) for v in state.values()):
        raise ValueError("Expected an unquantized GPT tensor state_dict")
    vocab, dim = state["tok_emb.weight"].shape
    layers = sorted({int(k.split(".")[1]) for k in state if k.startswith("blocks.")})
    if layers != list(range(len(layers))) or not layers:
        raise ValueError("Nonconsecutive GPT block indices")
    heads = state["blocks.0.attn.q_gain"].numel()
    if dim % heads:
        raise ValueError("Invalid head dimension")
    kv_rows = state["blocks.0.attn.c_k.weight"].shape[0]
    hidden = state["blocks.0.mlp.fc.weight"].shape[0]
    if kv_rows % (dim // heads) or hidden % dim:
        raise ValueError("Invalid KV/MLP dimensions")
    return dict(vocab_size=vocab, model_dim=dim, num_layers=len(layers),
                num_heads=heads, num_kv_heads=kv_rows // (dim // heads),
                mlp_mult=hidden // dim, tie_embeddings="lm_head.weight" not in state)


def load_checkpoint(path: Path):
    import torch
    obj = torch.load(path, map_location="cpu", weights_only=True)
    if isinstance(obj, dict) and "model_state_dict" in obj:
        return obj["model_state_dict"], obj.get("model_config")
    return obj, None


def logits(model, ids):
    """Same inference path as the uploaded GPT.forward, retaining token logits."""
    import torch
    import torch.nn.functional as F
    x = F.rms_norm(model.tok_emb(ids), (model.tok_emb.embedding_dim,))
    x0, skips = x, []
    for i in range(model.num_encoder_layers):
        x = model.blocks[i](x, x0)
        skips.append(x)
    for i in range(model.num_decoder_layers):
        if skips:
            x = x + model.skip_weights[i].to(x.dtype)[None, None, :] * skips.pop()
        x = model.blocks[model.num_encoder_layers + i](x, x0)
    x = model.final_norm(x)
    projection = F.linear(x, model.tok_emb.weight) if model.tie_embeddings else model.lm_head(x)
    return model.logit_softcap * torch.tanh(projection / model.logit_softcap)


def autocast(device, enabled):
    import torch
    return torch.autocast("cuda", dtype=torch.bfloat16) if enabled else nullcontext()


def batch(tokens, starts, length, device):
    import numpy as np
    import torch
    spans = np.stack([tokens[i:i + length + 1] for i in starts]).astype(np.int64)
    t = torch.from_numpy(spans).to(device)
    return t[:, :-1], t[:, 1:]


def evaluate(model, tokens, length, windows, device, mixed):
    import torch
    import torch.nn.functional as F
    loss_sum, correct, total = 0.0, 0, 0
    model.eval()
    # RoPE caches are reused by later gradient updates; keep ordinary tensors.
    with torch.no_grad():
        for i in range(min(windows, (len(tokens) - 1) // length)):
            x, y = batch(tokens, [i * length], length, device)
            with autocast(device, mixed):
                scores = logits(model, x)
                loss = F.cross_entropy(scores.float().reshape(-1, scores.size(-1)), y.reshape(-1))
            loss_sum += loss.item() * y.numel()
            correct += (scores.argmax(-1) == y).sum().item()
            total += y.numel()
    model.train()
    if not total or not math.isfinite(loss_sum):
        raise ValueError("Invalid validation result")
    return {"loss": loss_sum / total, "nextTokenAccuracy": correct / total,
            "evaluatedTokens": total}


def predictions(model, train, evaluation, sp, device, mixed):
    import torch
    result = []
    model.eval()
    with torch.no_grad():
        for split, tokens in [("train", train), ("eval", evaluation)]:
            for offset in [0, 32]:
                context = [int(t) for t in tokens[offset:offset + 24]]
                target = int(tokens[offset + 24])
                ids = torch.tensor([context], device=device)
                with autocast(device, mixed):
                    predicted = int(logits(model, ids)[0, -1].argmax().item())
                result.append({"input": f"{sp.decode(context)!r} [tokens={context}]",
                               "target": f"{sp.decode([target])!r} [token={target}]",
                               "prediction": f"{sp.decode([predicted])!r} [token={predicted}]",
                               "split": split})
    model.train()
    return result


def json_write(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")


def run(args):
    import numpy as np
    import torch
    import sentencepiece as spm
    project = args.project.resolve()
    source = project / "train_gpt.py"
    GPT, source_sha = load_gpt(source)
    data = project / "data" / "datasets" / "fineweb10B_sp1024"
    def shards(pattern, default):
        if pattern:
            import glob
            return sorted(Path(p).resolve() for p in glob.glob(pattern))
        found = sorted(data.glob(default))
        return found or sorted((project / "data").rglob(default))
    train_files = shards(args.train_glob, "fineweb_train_*.bin")
    eval_files = shards(args.eval_glob, "fineweb_val_*.bin")
    if not train_files or not eval_files:
        raise ValueError("Missing train/validation .bin shards under project/data. No data was downloaded or fabricated.")
    if {p.resolve() for p in train_files} & {p.resolve() for p in eval_files}:
        raise ValueError("Training and validation files overlap")
    tokenizer = args.tokenizer or project / "data/tokenizers/fineweb_1024_bpe.model"
    if not tokenizer.is_file():
        raise ValueError(f"Missing tokenizer: {tokenizer}; use --tokenizer with its actual path")
    sp = spm.SentencePieceProcessor(model_file=str(tokenizer))
    train, train_sha, train_provenance = snapshot(train_files, args.train_tokens)
    evaluation, eval_sha, eval_provenance = snapshot(eval_files, args.eval_tokens)
    if train_sha == eval_sha:
        raise ValueError("Training and validation token snapshots are identical")
    if min(len(train), len(evaluation)) <= max(args.seq_len, 56):
        raise ValueError("Insufficient tokens for the configured context and probes")
    state, saved_config = None, None
    checkpoint = args.checkpoint or project / "final_model.pt"
    if args.init == "checkpoint":
        if not checkpoint.is_file():
            raise ValueError(f"Checkpoint missing: {checkpoint}. Use --init random only for an intentional fresh run.")
        state, saved_config = load_checkpoint(checkpoint)
        shape = infer_shape(state)
    else:
        shape = dict(vocab_size=sp.vocab_size(), num_layers=4, model_dim=128,
                     num_heads=4, num_kv_heads=2, mlp_mult=2, tie_embeddings=True)
    if shape["vocab_size"] != sp.vocab_size():
        raise ValueError("Checkpoint vocabulary size does not match tokenizer")
    if max(int(train.max()), int(evaluation.max())) >= sp.vocab_size():
        raise ValueError("Dataset contains out-of-vocabulary token IDs")
    config = dict(shape, tied_embed_init_std=0.005, logit_softcap=30.0,
                  rope_base=10000.0, qk_gain_init=1.5)
    if saved_config:
        if any(saved_config[k] != v for k, v in shape.items()):
            raise ValueError("Saved model config disagrees with checkpoint shapes")
        config.update(saved_config)
    # For raw upstream checkpoints, RoPE base and logit softcap aren't stored;
    # use the reviewed source defaults and record this assumption explicitly.
    torch.manual_seed(args.seed)
    random.seed(args.seed)
    model = GPT(**config)
    if state is not None:
        model.load_state_dict(state, strict=True)
        del state
    count = sum(p.numel() for p in model.parameters())
    if count > 100_000_000:
        raise ValueError("Model exceeds Training Lab's 100M parameter limit")
    manifest = {"runId": "gpt-laptop-" + uuid.uuid4().hex[:12], "modelConfig": config,
                "modelParameterCount": count, "modelSourceSha256": source_sha,
                "runnerSha256": file_digest(Path(__file__)), "torchVersion": str(torch.__version__),
                "numpyVersion": np.__version__, "tokenizerSha256": file_digest(tokenizer),
                "trainSnapshotSha256": train_sha, "evalSnapshotSha256": eval_sha,
                "trainProvenance": train_provenance, "evalProvenance": eval_provenance,
                "initialization": args.init, "initialCheckpointSha256": file_digest(checkpoint) if args.init == "checkpoint" else None,
                "rawCheckpointDefaultsAssumed": args.init == "checkpoint" and not saved_config,
                "optimizer": "AdamW, fresh state (not a continuation of upstream Muon state)",
                "settings": {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()},
                "evaluation": "fixed prefix windows; teacher-forced next-token accuracy, not free generation or official BPB",
                "scope": "ordinary language-model baseline; no teacher, object definitions, or Brain feedback"}
    print(json.dumps({"status": "preflight_ok", "parameters": count, "modelConfig": config,
                      "trainTokens": len(train), "evalTokens": len(evaluation),
                      "cudaAvailable": torch.cuda.is_available(), "initialization": args.init}, indent=2), flush=True)
    if args.inspect:
        return None
    if args.device == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA unavailable; stopped rather than silently training on CPU")
    device = torch.device(args.device)
    mixed = args.device == "cuda" and torch.cuda.is_bf16_supported()
    manifest["precision"] = "fp32 parameters with bf16 autocast" if mixed else "fp32"
    out = args.out or project / "laptop_runs" / manifest["runId"]
    out.mkdir(parents=True, exist_ok=False)
    json_write(out / "manifest.json", manifest)
    (out / "train.tokens.u16").write_bytes(train.tobytes())
    (out / "eval.tokens.u16").write_bytes(evaluation.tobytes())
    model.to(device)
    if args.device == "cuda":
        torch.cuda.reset_peak_memory_stats()
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, betas=(0.9, 0.95), foreach=False)
    before = evaluate(model, evaluation, args.seq_len, args.eval_windows, device, mixed)
    json_write(out / "before.json", before)
    print(f"Before: validation loss={before['loss']:.4f}, next-token accuracy={before['nextTokenAccuracy']:.4f}", flush=True)
    rng = random.Random(args.seed)
    round_id, train_seconds, loss_sum, finished = 0, 0.0, 0.0, 0

    def emit(step, mean_loss):
        nonlocal round_id
        round_id += 1
        check_path = out / f"checkpoint-{round_id:03d}.pt"
        torch.save({"model_state_dict": {k: v.detach().cpu() for k, v in model.state_dict().items()},
                    "model_config": config, "steps": step}, check_path)
        score = evaluate(model, evaluation, args.seq_len, args.eval_windows, device, mixed)
        json_write(out / f"evaluation-{round_id:03d}.json", score)
        m = {"steps": step, "trainLoss": mean_loss, "trainSeconds": train_seconds,
             "evalAccuracy": score["nextTokenAccuracy"]}
        if args.device == "cuda":
            m["peakVramMb"] = torch.cuda.max_memory_allocated() / (1024 * 1024)
        record = {"schemaVersion": 1, "kind": "training", "runId": manifest["runId"],
                  "round": round_id, "recordedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                  "student": {"model": f"parameter-golf-{config['num_layers']}x{config['model_dim']}-baseline",
                              "parameterCount": count, "checkpointSha256": file_digest(check_path)},
                  "dataset": {"trainSha256": train_sha, "evalSha256": eval_sha},
                  "config": {"mode": "baseline", "device": str(device), "seed": args.seed},
                  "measurements": m,
                  "predictions": predictions(model, train, evaluation, sp, device, mixed),
                  "candidates": []}
        path = out / f"round-{round_id:03d}.json"
        json_write(path, record)
        print(f"Saved: {path}; validation loss={score['loss']:.4f}", flush=True)

    model.train()
    for step in range(1, args.steps + 1):
        if finished and args.max_seconds > 0 and train_seconds >= args.max_seconds:
            break
        if args.device == "cuda":
            torch.cuda.synchronize()
        started = time.perf_counter()
        optimizer.zero_grad(set_to_none=True)
        step_loss = 0.0
        for _ in range(args.accum):
            starts = [rng.randrange(len(train) - args.seq_len) for _ in range(args.batch_size)]
            x, y = batch(train, starts, args.seq_len, device)
            with autocast(device, mixed):
                loss = model(x, y)
            if not torch.isfinite(loss):
                raise ValueError("Nonfinite loss; training stopped")
            step_loss += loss.item() / args.accum
            (loss / args.accum).backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0, error_if_nonfinite=True)
        optimizer.step()
        if args.device == "cuda":
            torch.cuda.synchronize()
        train_seconds += time.perf_counter() - started
        loss_sum += step_loss
        finished = step
        print(f"step {step}/{args.steps}: train loss={step_loss:.4f}, training time={train_seconds:.1f}s", flush=True)
        if step % args.round_every == 0:
            emit(step, loss_sum / finished)
    if finished % args.round_every:
        emit(finished, loss_sum / finished)
    print(f"DONE. Output directory: {out}", flush=True)
    return out


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--project", type=Path, required=True)
    p.add_argument("--inspect", action="store_true", help="Read local assets and checkpoint shapes; no updates or output files")
    p.add_argument("--init", choices=["checkpoint", "random"], default="checkpoint")
    p.add_argument("--checkpoint", type=Path)
    p.add_argument("--tokenizer", type=Path)
    p.add_argument("--train-glob")
    p.add_argument("--eval-glob")
    p.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
    p.add_argument("--out", type=Path)
    p.add_argument("--steps", type=int, default=20)
    p.add_argument("--round-every", type=int, default=10)
    p.add_argument("--seq-len", type=int, default=128)
    p.add_argument("--batch-size", type=int, default=1)
    p.add_argument("--accum", type=int, default=2)
    p.add_argument("--train-tokens", type=int, default=65536)
    p.add_argument("--eval-tokens", type=int, default=4096)
    p.add_argument("--eval-windows", type=int, default=4)
    p.add_argument("--max-seconds", type=float, default=120)
    p.add_argument("--lr", type=float, default=0.0001)
    p.add_argument("--seed", type=int, default=1337)
    return p


def main():
    args = parser().parse_args()
    for k in ["steps", "round_every", "seq_len", "batch_size", "accum", "train_tokens", "eval_tokens", "eval_windows"]:
        if getattr(args, k) < 1:
            raise ValueError(f"{k} must be positive")
    if args.steps > 1000 or args.train_tokens > 1_000_000 or args.eval_tokens > 1_000_000:
        raise ValueError("Learning-run limits exceeded")
    if args.seq_len > 1024 or args.batch_size > 8 or args.accum > 16 or args.eval_windows > 32 or args.seed < 0:
        raise ValueError("Invalid learning-run settings")
    if not math.isfinite(args.lr) or args.lr <= 0 or not math.isfinite(args.max_seconds) or args.max_seconds < 0:
        raise ValueError("Invalid learning rate or time budget")
    return run(args)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"STOPPED: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
