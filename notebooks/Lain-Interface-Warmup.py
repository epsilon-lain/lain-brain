"""Paste this whole cell into the existing ModelScope Notebook.

Bounded CPU SFT preparation, not the zip reward experiment. Existing downloads
and v2 tools are reused. The key stays in the session environment.
"""
from pathlib import Path
import hashlib, os, subprocess, uuid

work = Path("/mnt/workspace/lain-zip-pilot")
tools = work / "tools-v2" if (work / "tools-v2").is_dir() else work / "tools"
student = work / "models/Apertus-v1.1-0.5B-Instruct"
python = work / "student-env/bin/python"
if not (student / "model.safetensors").is_file() or not python.is_file():
    raise RuntimeError("当前实例找不到之前的学生模型或 student-env；本格不会重新下载。")
expected_tools = {'zip_pilot.py': '72031cd0db0f2189b379f306a8f0724b03be9dc5ba231dffff03e898de7b4945', 'zip_pilot_protocol.py': 'f7c9df1574ebaff35494397b7e1726877ee019b8d0afdfc109efe44d1d18f819', 'zip_pilot_model.py': '2530e390412848344b8beb64f1f282fee326669627c201bc49f45d4c5c839c14', 'research_reward_probe.py': '4fa71099207dddb1971c2289092ec0a0543d19e0a4b7495c4a5ed823c945dec3'}
for name, expected in expected_tools.items():
    if not (tools / name).is_file() or hashlib.sha256((tools / name).read_bytes()).hexdigest() != expected:
        raise RuntimeError("已有 v2 实验脚本校验未通过：" + name)

worker = r'''
"""Bounded supervised interface/task preparation, separate from zip rewards.

Six program-supplied, independently verified training demonstrations. No
student-owned zip archive, no policy-gradient updates, and no final evaluation.
The frozen foundation plus a small generation adapter is the resulting student.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import time

import torch
from torch import nn
from safetensors.torch import load_file, save_file

from zip_pilot import base_generate, file_digest, load_student, new_run, source_hashes
from zip_pilot_model import sft_loss, state_digest
from zip_pilot_protocol import PROTOCOL, Teacher, canonical, prompt, tasks, transition, verify, write_json


class InterfaceAdapter(nn.Module):
    """Same generation-adapter shape as ZipPilot; no memory or dummy notes."""
    def __init__(self, base, tokenizer, rank=32):
        super().__init__()
        self.base, self.tokenizer, self.rank = base, tokenizer, rank
        self.base.eval().requires_grad_(False)
        self.base.gradient_checkpointing_disable()
        d = base.config.hidden_size
        self.generation_adapter = nn.Sequential(nn.Linear(d, rank), nn.SiLU(), nn.Linear(rank, d))
        # Exactly the foundation's function before the first parameter update.
        nn.init.zeros_(self.generation_adapter[-1].weight)
        nn.init.zeros_(self.generation_adapter[-1].bias)
        self.generation_adapter.to(next(base.parameters()).device)
        self.layer_index = len(base.model.layers) // 2
        self._hook = base.model.layers[self.layer_index].register_forward_hook(self._read)

    def _read(self, module, args, output):
        hidden = output[0] if isinstance(output, tuple) else output
        result = hidden + self.generation_adapter(hidden.float()).to(hidden.dtype)
        return (result,) + output[1:] if isinstance(output, tuple) else result

    def train(self, mode=True):
        super().train(mode)
        self.base.eval()
        return self

    def forward(self, ids, keep=0):
        return self.base(input_ids=ids, use_cache=False, logits_to_keep=keep).logits

    def parameters_to_train(self):
        return list(self.generation_adapter.parameters())

    def adapter_state(self):
        return {"generation_adapter." + name: value.detach().cpu().contiguous()
                for name, value in self.generation_adapter.state_dict().items()}

    def close(self):
        self._hook.remove()


def demonstrations():
    """These are supplied SFT targets, never attributed to student discovery."""
    examples = []
    for task in tasks("train"):
        a = task.scale
        if task.family == "square":
            expression = f"{2*a}*x*u+{a}*u**2"
            definition = "The change contains a linear term and a quadratic remainder."
        else:
            expression = f"{a}*x*v+{a}*y*u+{a}*u*v"
            definition = "The change combines the two first-order terms and a mixed term."
        answer = canonical(dict(definition=definition, expression=expression,
                                scope="exact", radius="0.1", status="asserted"))
        checked = verify(task, answer)
        if not checked["accepted"] or checked["score"] != 1:
            raise RuntimeError("A supplied training demonstration failed verification")
        examples.append((task, answer))
    return examples


def evaluate_interface(model, out, tag, max_tokens=128):
    # One training item measures possible memorisation. One public dev item
    # measures transfer; it never supplies a target or receives teacher feedback.
    records = []
    for task in [tasks("train")[0], tasks("dev")[0]]:
        output = base_generate(model.base, model.tokenizer, prompt(task), max_tokens)
        checked = verify(task, output["raw"])
        item = dict(task=asdict(task), output=output, verification=checked,
                    formatValid="claim" in checked)
        records.append(item)
        print(f"{tag} {task.key}: 格式={item['formatValid']}，覆盖分={checked['score']:.1f}", flush=True)
        print("原文：", output["raw"], flush=True)
    language = base_generate(model.base, model.tokenizer,
        [{"role": "user", "content": "请用两句话解释图书馆是什么。"}], max_tokens)
    print(f"{tag} 中文检查：{language['raw']}", flush=True)
    result = dict(records=records, language=language, teacherCalls=0, trainingUpdates=0,
                  languagePreservationAutomaticallyCertified=False, finalTestOpened=False)
    write_json(out / (tag + ".json"), result)
    return result


def supervised_updates(model, examples, *, steps, lr, max_seconds, log):
    optimizer = torch.optim.AdamW(model.parameters_to_train(), lr=lr, weight_decay=0)
    started, updates = time.monotonic(), 0
    model.train()
    for step in range(steps):
        if time.monotonic() - started >= max_seconds:
            return updates, "training-time-cap"
        task, answer = examples[step % len(examples)]
        optimizer.zero_grad(set_to_none=True)
        loss = sft_loss(model, prompt(task), answer)
        loss.backward()
        norm = torch.nn.utils.clip_grad_norm_(model.parameters_to_train(), 1.0, error_if_nonfinite=True)
        optimizer.step()
        updates += 1
        log(dict(stage="supervised-interface-and-toy-task-preparation", update=updates,
                 task=asdict(task), loss=float(loss.detach()), gradNorm=float(norm),
                 seconds=time.monotonic()-started, teacherCalls=0, rewardUpdates=0))
    return updates, "requested-updates-complete"


def restore_interface(path, base, tokenizer, metadata):
    """Restore the actual warmed student, rather than silently reloading raw base."""
    path = Path(path)
    manifest = json.loads((path / "manifest.json").read_text())
    result = json.loads((path / "result.json").read_text())
    if manifest.get("protocol") != PROTOCOL or manifest.get("stage") != "supervised-interface-and-toy-task-preparation":
        raise ValueError("Not an interface-preparation run")
    if manifest["snapshotSha256"] != metadata["snapshotSha256"]:
        raise ValueError("Warmup foundation snapshot mismatch")
    if file_digest(path / "interface.safetensors") != result["adapterSha256"]:
        raise ValueError("Warmup adapter checkpoint hash mismatch")
    model = InterfaceAdapter(base, tokenizer, rank=manifest["rank"])
    try:
        stored = load_file(str(path / "interface.safetensors"))
        expected = model.adapter_state()
        if set(stored) != set(expected) or any(stored[k].shape != expected[k].shape for k in stored):
            raise ValueError("Interface adapter schema mismatch")
        model.generation_adapter.load_state_dict(
            {k.removeprefix("generation_adapter."): v for k, v in stored.items()}, strict=True)
        return model.eval()
    except BaseException:
        model.close()
        raise


def feedback_after_warmup(model, after, args, out):
    initial_item = after["records"][0]
    if not initial_item["formatValid"] or not args.review:
        reason = "student-format-not-ready" if not initial_item["formatValid"] else "review-disabled"
        result = dict(skipped=True, reason=reason, teacherCalls=0, trainingUpdates=0)
        write_json(out / "feedback.json", result)
        print("本轮不追加老师调用：" + reason, flush=True)
        return result
    task = tasks("train")[0]
    initial = initial_item["output"]
    first = transition(task, initial["raw"], 0, initial["generatedTokens"])
    teacher = Teacher(args.teacher_base_url, args.teacher_model,
        args.teacher_revision, out.parent / "teacher-cache", max_calls=1)
    print("格式通过；老师审阅一次，学生使用刚训练过的适配器修改……", flush=True)
    review = teacher.review(task, initial["raw"], initial_item["verification"])
    write_json(out / "teacher.json", review)
    feedback = dict(draft=initial["raw"], programFeedback=dict(
        accepted=initial_item["verification"]["accepted"], reason=initial_item["verification"]["reason"]))
    if review["critique"]:
        feedback["teacherCritique"] = review["critique"]
    revised = base_generate(model.base, model.tokenizer, prompt(task, feedback), args.max_new_tokens)
    second = transition(task, revised["raw"], first["after"], revised["generatedTokens"])
    result = dict(skipped=False, task=asdict(task), initial=initial, initialTransition=first,
                  teacher=review, revision=revised, revisionTransition=second, teacherCalls=teacher.calls,
                  adapterUsed=True, trainingUpdates=0, rewardUpdates=0, archiveChanged=False,
                  independentDiscovery=False, teacherAnswerLeakageExcluded=False)
    write_json(out / "feedback.json", result)
    print("老师反馈：", review["raw"], flush=True)
    print("学生修改：", revised["raw"], flush=True)
    print(f"提示前后覆盖分：{first['verification']['score']:.1f} → {second['verification']['score']:.1f}", flush=True)
    return result


def run(args):
    if PROTOCOL != "lain-zip-pilot-v2":
        raise RuntimeError("Need the existing v2 pilot tools; original results are not overwritten")
    out = new_run(args.out)
    examples = demonstrations()
    torch.manual_seed(args.seed)
    print("1/4 加载已下载的学生模型（CPU）；基础权重冻结……", flush=True)
    base, tokenizer, metadata = load_student(args.student_path, "cpu")
    base_hash = state_digest(base)
    model = InterfaceAdapter(base, tokenizer, args.rank)
    initial = {k: v.clone() for k, v in model.adapter_state().items()}
    write_json(out / "manifest.json", dict(metadata, protocol=PROTOCOL,
        stage="supervised-interface-and-toy-task-preparation", seed=args.seed, rank=args.rank,
        stepsRequested=args.steps, learningRate=args.lr, maxTrainingSeconds=args.max_seconds,
        layerIndex=model.layer_index, trainableParameters=sum(p.numel() for p in model.parameters_to_train()),
        sources=source_hashes(), warmupSourceSha256=file_digest(Path(__file__)), baseStateSha256=base_hash,
        demonstrationOrigin="program-supplied verified training targets; not student-owned notes",
        finalTestOpened=False, zipMemoryEnabled=False, rewardUpdates=0))
    write_json(out / "demonstrations.json", dict(examples=[dict(task=asdict(t), answer=a,
        verification=verify(t, a)) for t, a in examples], proseCertified=False, studentDiscovered=False))
    try:
        print("2/4 记录训练前输出（训练题、开发题、中文）……", flush=True)
        before = evaluate_interface(model, out, "before", args.max_new_tokens)
        with torch.no_grad():
            loss_before = float(sft_loss(model, prompt(examples[0][0]), examples[0][1]))
        print(f"3/4 最多 {args.steps} 次监督更新，只训练新增小适配器……", flush=True)
        def log(record):
            save_file(model.adapter_state(), str(out / f"checkpoint-{record['update']:03d}.safetensors"))
            write_json(out / f"update-{record['update']:03d}.json", record)
            print(f"更新 {record['update']}/{args.steps}: loss={record['loss']:.4f}，"
                  f"累计训练 {record['seconds']:.1f}s", flush=True)
        updates, stop_reason = supervised_updates(model, examples, steps=args.steps, lr=args.lr,
                                                  max_seconds=args.max_seconds, log=log)
        model.eval()
        with torch.no_grad():
            loss_after = float(sft_loss(model, prompt(examples[0][0]), examples[0][1]))
        if state_digest(base) != base_hash or any(p.grad is not None for p in base.parameters()):
            raise RuntimeError("Frozen foundation changed or received gradients")
        changed = [k for k, v in model.adapter_state().items() if not torch.equal(initial[k], v)]
        if updates and not changed:
            raise RuntimeError("No adapter parameter changed")
        # Save before post-training inference/remote feedback, which may fail.
        save_file(model.adapter_state(), str(out / "interface.safetensors"))
        result = dict(updates=updates, stopReason=stop_reason, baseWeightsUnchanged=True,
            changedAdapterTensors=changed, adapterSha256=file_digest(out / "interface.safetensors"),
            sameTrainingExampleLossBefore=loss_before, sameTrainingExampleLossAfter=loss_after,
            teacherCallsDuringTraining=0, rewardUpdates=0, archiveChanged=False,
            studentDiscovered=False, finalTestOpened=False, memoryBenefitMeasured=False,
            optimizerStateSaved=False, comparisonScope="training loss and two public object checks; not proof of general improvement")
        write_json(out / "result.json", result)
        print("4/4 保存适配器，核验训练后输出……", flush=True)
        after = evaluate_interface(model, out, "after", args.max_new_tokens)
        feedback_after_warmup(model, after, args, out)
        write_json(out / "summary.json", dict(result, before=before, after=after))
        print(f"完成：真实监督更新={updates}；基础权重未变；奖励更新=0。", flush=True)
        print(f"同一道训练示例 loss：{loss_before:.4f} → {loss_after:.4f}", flush=True)
        print("训练题/开发题覆盖分：", [r["verification"]["score"] for r in before["records"]],
              "→", [r["verification"]["score"] for r in after["records"]], flush=True)
        print("记录和可复用适配器：", out, flush=True)
    finally:
        model.close()


def cli():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--student-path", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--steps", type=int, choices=range(1, 33), default=12)
    p.add_argument("--rank", type=int, choices=[8, 16, 32], default=32)
    p.add_argument("--seed", type=int, choices=[1337, 2027, 4099], default=1337)
    p.add_argument("--lr", type=float, default=0.001)
    p.add_argument("--max-seconds", type=int, choices=range(30, 601), default=180)
    p.add_argument("--max-new-tokens", type=int, choices=range(1, 129), default=128)
    p.add_argument("--review", action="store_true")
    p.add_argument("--teacher-base-url", default="https://api.inference.cscs.ch/v1")
    p.add_argument("--teacher-model", default="swiss-ai/Apertus-v1.5-8B")
    p.add_argument("--teacher-revision", default="CSCS service observed 2026-10-02; weight revision unknown")
    args = p.parse_args()
    if not 0 < args.lr <= 0.001:
        p.error("lr must be in (0, 0.001]")
    try:
        run(args)
    except KeyboardInterrupt:
        print("已停止，已完成的记录和逐步适配器保留，不自动重启。", flush=True)
        raise SystemExit(130)
    except Exception as error:
        safe = str(error) if isinstance(error, (ValueError, RuntimeError, FileNotFoundError)) else type(error).__name__
        print("本轮停止：", safe, "；已完成的记录和适配器保留。", flush=True)
        raise SystemExit(1)


if __name__ == "__main__":
    cli()
'''

tag = uuid.uuid4().hex[:8]
script = work / ("interface-warmup-" + tag + ".py")
with script.open("x", encoding="utf-8") as f:
    f.write(worker)
out = work / ("interface-warmup-" + tag)
env = dict(os.environ)
env["PYTHONPATH"] = str(tools) + os.pathsep + env.get("PYTHONPATH", "")
env["HF_HUB_OFFLINE"] = "1"
args = [str(python), "-u", str(script), "--student-path", str(student), "--out", str(out)]
if env.get("LAIN_TEACHER_API_KEY", "").strip():
    args.append("--review")
print("开始 CPU 热身：最多12次监督更新，训练计时到180秒后停止追加更新；每步保存小适配器。", flush=True)
print("已有模型不重下载；训练后格式通过才再审阅一次；这段不计作 zip 奖励收益。", flush=True)
subprocess.run(args, env=env, check=True, timeout=900)
