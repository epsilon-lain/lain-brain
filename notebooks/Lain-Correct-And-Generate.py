"""Copy this whole file into one cell of the already connected Notebook."""
from pathlib import Path
import hashlib, os, subprocess, uuid

work = Path("/mnt/workspace/lain-zip-pilot")
tools = work / "tools-v2" if (work / "tools-v2").is_dir() else work / "tools"
student = work / "models/Apertus-v1.1-0.5B-Instruct"
python = work / "student-env/bin/python"
parent = work / "interface-warmup-8dec83c6"
archive = work / "zip-notes-4f3785ac/archive.json"
generator = work / "zip-notes-4f3785ac.py"
if not os.environ.get("LAIN_TEACHER_API_KEY", "").strip():
    raise RuntimeError("请保持之前接通老师的 Notebook 会话；本格不会索取或保存密钥。")
if not python.is_file() or not (student / "model.safetensors").is_file():
    raise RuntimeError("找不到已下载的学生或现有环境；本格不会重新下载/安装。")
if not all((parent / n).is_file() for n in ["manifest.json", "result.json", "interface.safetensors"]):
    raise RuntimeError("找不到已保存的热身适配器。")
if not archive.is_file() or not generator.is_file():
    raise RuntimeError("找不到刚才的笔记记录或生成脚本；请保留之前生成笔记的文件。")
expected_tools = {'zip_pilot.py': '72031cd0db0f2189b379f306a8f0724b03be9dc5ba231dffff03e898de7b4945', 'zip_pilot_protocol.py': 'f7c9df1574ebaff35494397b7e1726877ee019b8d0afdfc109efe44d1d18f819', 'zip_pilot_model.py': '2530e390412848344b8beb64f1f282fee326669627c201bc49f45d4c5c839c14', 'research_reward_probe.py': '4fa71099207dddb1971c2289092ec0a0543d19e0a4b7495c4a5ed823c945dec3'}
for name, expected in expected_tools.items():
    if not (tools / name).is_file() or hashlib.sha256((tools / name).read_bytes()).hexdigest() != expected:
        raise RuntimeError("已有 v2 脚本校验未通过：" + name)

worker = r'''
"""Resume an interface adapter with supplied targets and replayed feedback.

This is bounded supervised preparation, not research-reward learning. Existing
verified loaders and note gates are reused without changing their acceptance.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict
import gc
import importlib.util
import json
import os
from pathlib import Path
import time
from types import SimpleNamespace

import torch
from safetensors.torch import save_file

from zip_pilot import base_generate, file_digest, load_student, new_run, source_hashes
from zip_pilot_protocol import PROTOCOL, prompt, tasks, verify, write_json

GENERATOR_SHA256 = "43ec98a71de2cf6d618de3ef9a29384ac36fd238f8fa0e82a6c7ca5eddac9481"
STAGE = "supervised-interface-and-toy-task-preparation"
INSTRUCTION = ("Give one short concrete sentence about the modeled input/output change. "
               "Keep any certified formula and scope unless you find an error. "
               "Avoid repetitive descriptions of polynomial order.")


def load_generator(path):
    if file_digest(path) != GENERATOR_SHA256:
        raise ValueError("Installed note generator failed its pinned source hash")
    spec = importlib.util.spec_from_file_location("lain_verified_note_generator", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def correction_examples(warmup, archive, parent_sha):
    if archive.get("protocol") != "lain-zip-notes-v1" or archive.get("warmupAdapterSha256") != parent_sha:
        raise ValueError("Feedback archive does not belong to the selected starting adapter")
    examples = []
    supplied = {t.key: (t, answer) for t, answer in warmup.demonstrations()}
    selected = [tasks("train")[0], tasks("train")[3]]
    records = archive.get("records", [])
    for task in selected:
        matches = [r for r in records if r.get("task") == asdict(task)]
        if len(matches) != 1 or not matches[0].get("candidates"):
            raise ValueError("Need exactly one saved training record per correction object")
        candidate = matches[0]["candidates"][0]
        draft = candidate["output"]["raw"]
        if not isinstance(draft, str):
            raise ValueError("Saved student draft is not text")
        # Recompute mathematical verification rather than trusting saved scores.
        checked = verify(task, draft)
        feedback = dict(draft=draft, programFeedback=dict(
            accepted=checked["accepted"], reason=checked["reason"]), definitionInstruction=INSTRUCTION)
        critique = candidate["teacher"].get("critique")
        if critique is not None:
            if (not isinstance(critique, dict)
                    or set(critique) != {"assessment", "hint", "counterexample", "scope_note"}
                    or not all(isinstance(v, str) for v in critique.values())):
                raise ValueError("Saved critique schema differs from the reviewed protocol")
            feedback["teacherCritique"] = critique
        _, answer = supplied[task.key]
        for kind, messages in [("ordinary", prompt(task)), ("replayed-feedback", prompt(task, feedback))]:
            examples.append(dict(task=asdict(task), context=kind, messages=messages, answer=answer,
                targetVerification=verify(task, answer), targetOrigin="program-supplied verified SFT demonstration",
                feedbackRequestHash=candidate["teacher"].get("requestHash") if kind != "ordinary" else None,
                teacherOpinionTreatedAsTruth=False, studentDiscovered=False))
    return examples


def updates(model, examples, warmup, *, steps, lr, max_seconds, log):
    optimizer = torch.optim.AdamW(model.parameters_to_train(), lr=lr, weight_decay=0)
    started, count = time.monotonic(), 0
    model.train()
    for index in range(steps):
        if time.monotonic() - started >= max_seconds:
            return count, "training-time-cap"
        example = examples[index % len(examples)]
        optimizer.zero_grad(set_to_none=True)
        loss = warmup.sft_loss(model, example["messages"], example["answer"])
        loss.backward()
        norm = torch.nn.utils.clip_grad_norm_(model.parameters_to_train(), 1.0, error_if_nonfinite=True)
        optimizer.step()
        count += 1
        log(dict(update=count, task=example["task"], context=example["context"], loss=float(loss.detach()),
            gradNorm=float(norm), seconds=time.monotonic()-started, teacherCalls=0, rewardUpdates=0))
    return count, "requested-updates-complete"


def evaluate(model, out, tag, max_tokens):
    records = []
    # Public dev tasks provide no targets or teacher calls; final tests stay shut.
    for task in [tasks("train")[0], tasks("train")[3], tasks("dev")[0], tasks("dev")[2]]:
        output = base_generate(model.base, model.tokenizer, prompt(task), max_tokens)
        checked = verify(task, output["raw"])
        records.append(dict(task=asdict(task), output=output, verification=checked))
        print(f"{tag} {task.key}: 格式={'claim' in checked}，覆盖={checked['score']:.1f}", flush=True)
    language = base_generate(model.base, model.tokenizer,
        [{"role": "user", "content": "请用两句话解释图书馆是什么。"}], max_tokens)
    print(f"{tag} 中文：{language['raw']}", flush=True)
    result = dict(records=records, language=language, teacherCalls=0, trainingUpdates=0,
        finalTestOpened=False, languagePreservationAutomaticallyCertified=False)
    write_json(out / (tag + ".json"), result)
    return result


def prepare(args, generator):
    warmup = generator.load_warmup_module(args.parent_run)
    parent_result = json.loads((args.parent_run / "result.json").read_text())
    if not parent_result.get("baseWeightsUnchanged") or parent_result.get("updates", 0) < 1:
        raise ValueError("Need the successfully prepared starting adapter")
    if file_digest(args.parent_run / "interface.safetensors") != parent_result["adapterSha256"]:
        raise ValueError("Starting adapter checkpoint hash mismatch")
    archive = json.loads(args.archive.read_text())
    examples = correction_examples(warmup, archive, parent_result["adapterSha256"])
    out = new_run(args.out)
    # This is the unchanged restore loader, not the correction algorithm source.
    with out.with_suffix(".py").open("xb") as stream:
        stream.write(args.parent_run.with_suffix(".py").read_bytes())
    torch.manual_seed(1337)
    print("1/4 恢复原来的已训练适配器；基础权重冻结，优化器重新开始……", flush=True)
    base, tokenizer, metadata = load_student(args.student_path, "cpu")
    model = warmup.restore_interface(args.parent_run, base, tokenizer, metadata)
    base_hash = warmup.state_digest(base)
    initial = {k: v.clone() for k, v in model.adapter_state().items()}
    write_json(out / "manifest.json", dict(metadata, protocol=PROTOCOL, stage=STAGE,
        preparationKind="supervised-correction-with-replayed-training-feedback", rank=model.rank,
        warmupSourceSha256=generator.WARMUP_WORKER_SHA256,
        correctionSourceSha256=file_digest(Path(__file__)),
        generatorSourceSha256=file_digest(args.generator), sources=source_hashes(),
        parentRun=str(args.parent_run), parentAdapterSha256=parent_result["adapterSha256"],
        parentManifestSha256=file_digest(args.parent_run / "manifest.json"),
        parentResultSha256=file_digest(args.parent_run / "result.json"),
        feedbackArchive=str(args.archive), feedbackArchiveSha256=file_digest(args.archive),
        stepsRequested=args.steps, learningRate=args.lr, maxTrainingSeconds=args.max_seconds,
        baseStateSha256=base_hash, optimizerStateResumed=False,
        demonstrationOrigin="existing program-supplied verified targets; not teacher-written or discovered",
        finalTestOpened=False, zipMemoryEnabled=False, rewardUpdates=0))
    write_json(out / "supervised-examples.json", dict(examples=examples,
        targetOrigin="existing supplied demonstrations", proseCertified=False, rewardTraining=False))
    try:
        print("2/4 记录训练题、公开开发题和中文输出……", flush=True)
        before = evaluate(model, out, "before", args.max_new_tokens)
        with torch.no_grad():
            before_losses = [float(warmup.sft_loss(model, e["messages"], e["answer"])) for e in examples]
        print(f"3/4 最多 {args.steps} 次监督纠正；不新增老师请求……", flush=True)
        def log(record):
            save_file(model.adapter_state(), str(out / f"checkpoint-{record['update']:03d}.safetensors"))
            write_json(out / f"update-{record['update']:03d}.json", record)
            print(f"更新 {record['update']}/{args.steps}: {record['context']}，loss={record['loss']:.4f}，"
                  f"累计训练 {record['seconds']:.1f}s", flush=True)
        count, reason = updates(model, examples, warmup, steps=args.steps, lr=args.lr,
                                max_seconds=args.max_seconds, log=log)
        model.eval()
        with torch.no_grad():
            after_losses = [float(warmup.sft_loss(model, e["messages"], e["answer"])) for e in examples]
        if warmup.state_digest(base) != base_hash or any(p.grad is not None for p in base.parameters()):
            raise RuntimeError("Frozen foundation changed or received gradients")
        changed = [k for k, v in model.adapter_state().items() if not torch.equal(v, initial[k])]
        if not count or not changed:
            raise RuntimeError("No corrective update completed; no automatic note regeneration")
        save_file(model.adapter_state(), str(out / "interface.safetensors"))
        result = dict(updates=count, correctionUpdates=count,
            cumulativeSupervisedUpdates=parent_result.get("cumulativeSupervisedUpdates", parent_result["updates"])+count,
            stopReason=reason, baseWeightsUnchanged=True, changedAdapterTensors=changed,
            adapterSha256=file_digest(out / "interface.safetensors"),
            parentAdapterSha256=parent_result["adapterSha256"], fixedTrainingContextLossBefore=before_losses,
            fixedTrainingContextLossAfter=after_losses, teacherCallsDuringTraining=0,
            rewardUpdates=0, independentDiscovery=False, memoryBenefitMeasured=False,
            optimizerStateResumed=False, optimizerStateSaved=False, finalTestOpened=False)
        # Persist reusable weights before later generation or network operations.
        write_json(out / "result.json", result)
        print("4/4 已保存纠正后的适配器，检查输出……", flush=True)
        after = evaluate(model, out, "after", args.max_new_tokens)
        write_json(out / "summary.json", dict(result, before=before, after=after))
        print(f"纠正完成：实际监督更新={count}；奖励更新=0。适配器：{out}", flush=True)
    finally:
        model.close()


def run(args):
    if PROTOCOL != "lain-zip-pilot-v2":
        raise ValueError("Need the verified v2 pilot tools")
    if not os.environ.get("LAIN_TEACHER_API_KEY", "").strip():
        raise RuntimeError("请保持之前已接通老师的 Notebook 会话；没有发出请求。")
    generator = load_generator(args.generator)
    prepare(args, generator)
    gc.collect()
    print("自动重新生成两份笔记；使用刚保存的新适配器，老师最多新增4次请求……", flush=True)
    generator.run(SimpleNamespace(student_path=args.student_path, warmup_run=args.out,
        out=args.notes_out, max_new_tokens=args.max_new_tokens, max_seconds=300,
        teacher_base_url=args.teacher_base_url, teacher_model=args.teacher_model,
        teacher_revision=args.teacher_revision))


def cli():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["student-path", "parent-run", "archive", "generator", "out", "notes-out"]:
        parser.add_argument("--"+name, type=Path, required=True)
    parser.add_argument("--steps", type=int, choices=range(1,25), default=24)
    parser.add_argument("--lr", type=float, default=0.001)
    parser.add_argument("--max-seconds", type=int, choices=range(30,181), default=180)
    parser.add_argument("--max-new-tokens", type=int, choices=range(1,129), default=128)
    parser.add_argument("--teacher-base-url", default="https://api.inference.cscs.ch/v1")
    parser.add_argument("--teacher-model", default="swiss-ai/Apertus-v1.5-8B")
    parser.add_argument("--teacher-revision", default="CSCS service observed 2026-10-02; weight revision unknown")
    args = parser.parse_args()
    if not 0 < args.lr <= 0.001:
        parser.error("lr must be in (0, 0.001]")
    try:
        run(args)
    except KeyboardInterrupt:
        print("已停止；已完成的纠正权重与记录保留，不自动重启。", flush=True)
        raise SystemExit(130)
    except Exception as error:
        safe = str(error) if isinstance(error, (ValueError, RuntimeError, FileNotFoundError)) else type(error).__name__
        print("本轮停止：", safe, "；已保存的纠正适配器和记录保留，不自动重试。", flush=True)
        raise SystemExit(1)


if __name__ == "__main__":
    cli()
'''

tag = uuid.uuid4().hex[:8]
script = work / ("interface-correction-worker-" + tag + ".py")
with script.open("x", encoding="utf-8") as stream:
    stream.write(worker)
out = work / ("interface-correction-" + tag)
notes = work / ("zip-notes-corrected-" + tag)
env = dict(os.environ)
env["PYTHONPATH"] = str(tools) + os.pathsep + env.get("PYTHONPATH", "")
env["HF_HUB_OFFLINE"] = "1"
print("开始监督纠正：恢复旧适配器，最多24次更新；训练计时180秒后停止追加更新。", flush=True)
print("纠正训练不新增老师请求；随后自动生成两份笔记，老师最多新增4次请求。", flush=True)
print("这段是范例教学，不记为 zip 奖励或新发现；原模型和旧记录保留。", flush=True)
try:
    subprocess.run([str(python), "-u", str(script), "--student-path", str(student),
        "--parent-run", str(parent), "--archive", str(archive), "--generator", str(generator),
        "--out", str(out), "--notes-out", str(notes)], env=env, check=True, timeout=900)
except subprocess.TimeoutExpired:
    print("到达总时限，子进程已停止；已保存的逐步权重与记录保留。", flush=True)
    raise
