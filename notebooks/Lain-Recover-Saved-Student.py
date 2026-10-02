"""Paste this whole file into one cell of the existing ModelScope Notebook."""
from pathlib import Path
import hashlib, os, subprocess, uuid

work = Path("/mnt/workspace/lain-zip-pilot")
tools = work / "tools-v2" if (work / "tools-v2").is_dir() else work / "tools"
python = work / "student-env/bin/python"
student = work / "models/Apertus-v1.1-0.5B-Instruct"
failed_notes = work / "zip-notes-corrected-5cdb54c9"
generator = work / "zip-notes-4f3785ac.py"
if not os.environ.get("LAIN_TEACHER_API_KEY", "").strip():
    raise RuntimeError("请保持原来接通老师的 Notebook 会话；本格不会索取或保存密钥。")
if not python.is_file() or not (student / "model.safetensors").is_file():
    raise RuntimeError("找不到现有学生环境或模型；本格不安装、不下载。")
if not all((failed_notes / n).is_file() for n in ["manifest.json", "archive.json"]) or not generator.is_file():
    raise RuntimeError("找不到刚才的运行记录或已有生成脚本。")
expected_tools = {'zip_pilot.py': '72031cd0db0f2189b379f306a8f0724b03be9dc5ba231dffff03e898de7b4945', 'zip_pilot_protocol.py': 'f7c9df1574ebaff35494397b7e1726877ee019b8d0afdfc109efe44d1d18f819', 'zip_pilot_model.py': '2530e390412848344b8beb64f1f282fee326669627c201bc49f45d4c5c839c14', 'research_reward_probe.py': '4fa71099207dddb1971c2289092ec0a0543d19e0a4b7495c4a5ed823c945dec3'}
for name, expected in expected_tools.items():
    if not (tools / name).is_file() or hashlib.sha256((tools / name).read_bytes()).hexdigest() != expected:
        raise RuntimeError("已有 v2 脚本校验未通过：" + name)

worker = r'''
"""Screen saved adapters for regression before further teacher review.

No training. Public train/dev checks select a single checkpoint; this is not a
blind test, independent mathematical discovery, or evidence of zip benefit.
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
from safetensors.torch import load_file, save_file

from zip_pilot import base_generate, file_digest, load_student, new_run, source_hashes
from zip_pilot_protocol import PROTOCOL, prompt, tasks, verify, write_json

GENERATOR_SHA256 = "43ec98a71de2cf6d618de3ef9a29384ac36fd238f8fa0e82a6c7ca5eddac9481"
REVIEW_REQUEST = (
    "Review the actual definition in this draft together with its expression and the task. "
    "Start assessment with exactly CLEAR:, NEEDS_REVISION:, or UNCERTAIN:. "
    "CLEAR means the sentence understandably and accurately describes the input/output change "
    "and scope in this context. It need not repeat every coefficient or use a preferred wording. "
    "If unclear or incorrect, explain the specific issue and quote the exact words from this "
    "draft that support your assessment; do not attribute words absent from the definition. "
    "Give a short revision hint, not a replacement definition or formula. "
    "Use an empty counterexample string when none is needed. "
    "Distinguish mathematical errors from explanation problems. Your opinion is not a proof."
)


def load_generator(path):
    if file_digest(path) != GENERATOR_SHA256:
        raise ValueError("Installed note generator source differs from the inspected version")
    spec = importlib.util.spec_from_file_location("lain_recovery_note_generator", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def checked_state(path, model):
    stored, expected = load_file(str(path)), model.adapter_state()
    if set(stored) != set(expected):
        raise ValueError("Candidate adapter schema differs from starting student")
    for key, value in stored.items():
        if (value.shape != expected[key].shape or value.dtype != expected[key].dtype
                or not torch.isfinite(value).all()):
            raise ValueError("Candidate adapter shape, dtype or finite-value check failed")
    return stored


def install(model, state):
    model.generation_adapter.load_state_dict(
        {k.removeprefix("generation_adapter."): v for k,v in state.items()}, strict=True)
    model.requires_grad_(False).eval()


def scores(records):
    return {r["task"]["key"]: r["verification"]["score"] for r in records}


def improvement(baseline, candidate, best):
    # Preserve each previously certified coverage, not just the total score.
    return (set(candidate) == set(baseline)
            and all(candidate[k] >= baseline[k] for k in baseline)
            and sum(candidate.values()) > sum(best.values()))


def evaluate(model, selected_tasks, label, out, deadline):
    records = []
    for task in selected_tasks:
        if time.monotonic() >= deadline:
            raise RuntimeError("Checkpoint scan time cap reached; completed records retained")
        output = base_generate(model.base, model.tokenizer, prompt(task), 128)
        checked = verify(task, output["raw"])
        record = dict(task=asdict(task), output=output, verification=checked)
        records.append(record)
        write_json(out / (label+"-"+task.key+".json"), record)
    return records


def select(args, generator):
    failed_notes = json.loads((args.failed_notes / "manifest.json").read_text())
    failed_archive = json.loads((args.failed_notes / "archive.json").read_text())
    source_run = Path(failed_notes["warmupRun"])
    source_manifest = json.loads((source_run / "manifest.json").read_text())
    source_result = json.loads((source_run / "result.json").read_text())
    parent = Path(source_manifest["parentRun"])
    parent_manifest = json.loads((parent / "manifest.json").read_text())
    parent_result = json.loads((parent / "result.json").read_text())
    if (source_manifest.get("preparationKind") != "supervised-correction-with-replayed-training-feedback"
            or source_manifest.get("protocol") != PROTOCOL
            or failed_archive.get("protocol") != "lain-zip-notes-v1"
            or not source_result.get("baseWeightsUnchanged")
            or not parent_result.get("baseWeightsUnchanged")
            or parent_result.get("updates", 0) < 1):
        raise ValueError("Need the recorded correction and its successful preparation parent")
    if (file_digest(source_run / "interface.safetensors") != source_result["adapterSha256"]
            or source_result["adapterSha256"] != failed_notes["warmupAdapterSha256"]
            or source_result["adapterSha256"] != failed_archive["warmupAdapterSha256"]
            or source_manifest["parentAdapterSha256"] != parent_result["adapterSha256"]
            or file_digest(parent / "interface.safetensors") != parent_result["adapterSha256"]
            or source_manifest["snapshotSha256"] != parent_manifest["snapshotSha256"]
            or source_manifest["rank"] != parent_manifest["rank"]):
        raise ValueError("Saved runs, foundation or adapter provenance mismatch")
    warmup = generator.load_warmup_module(parent)
    out = new_run(args.out)
    with out.with_suffix(".py").open("xb") as stream:
        stream.write(parent.with_suffix(".py").read_bytes())
    print("1/3 加载现有学生，检查旧起点和四个中途权重；本轮训练更新=0……", flush=True)
    base, tokenizer, metadata = load_student(args.student_path, "cpu")
    model = warmup.restore_interface(parent, base, tokenizer, metadata)
    model.requires_grad_(False).eval()
    base_hash = warmup.state_digest(base)
    write_json(out / "manifest.json", dict(metadata, protocol=PROTOCOL,
        stage="supervised-interface-and-toy-task-preparation", rank=model.rank,
        preparationKind="selection-of-existing-adapter-no-new-training",
        warmupSourceSha256=generator.WARMUP_WORKER_SHA256, recoverySourceSha256=file_digest(Path(__file__)),
        generatorSourceSha256=file_digest(args.generator), sources=source_hashes(),
        correctionRun=str(source_run), correctionManifestSha256=file_digest(source_run / "manifest.json"),
        failedArchiveSha256=file_digest(args.failed_notes / "archive.json"), parentRun=str(parent),
        maxCandidateSteps=[6,12,18,24], maxStudentCallsDuringSelection=20, maxTeacherCalls=4,
        reviewRequest=REVIEW_REQUEST, trainingUpdates=0, rewardUpdates=0, finalTestOpened=False,
        devUsedForCheckpointSelection=True, independentDiscovery=False,
        selectionScope="four public polynomial checks only", languagePreservationChecked=False))
    train = [tasks("train")[0], tasks("train")[3]]
    dev = [tasks("dev")[0], tasks("dev")[2]]
    deadline = time.monotonic()+args.max_seconds
    try:
        best_records = evaluate(model, train+dev, "baseline", out, deadline)
        baseline = scores(best_records)
        best_scores, best_step = dict(baseline), 0
        best_state = {k:v.clone() for k,v in model.adapter_state().items()}
        best_source, examined = parent / "interface.safetensors", []
        print("旧起点覆盖：", list(baseline.values()), flush=True)
        for step in [6,12,18,24]:
            checkpoint = source_run / f"checkpoint-{step:03d}.safetensors"
            if not checkpoint.is_file() or step > source_result.get("correctionUpdates", 0):
                continue
            state = checked_state(checkpoint, model)
            install(model, state)
            records = evaluate(model, train, f"step-{step:03d}", out, deadline)
            partial = scores(records)
            regressed = any(partial[k] < baseline[k] for k in partial)
            if not regressed:
                records += evaluate(model, dev, f"step-{step:03d}", out, deadline)
            candidate = scores(records)
            promoted = improvement(baseline, candidate, best_scores)
            entry = dict(step=step, checkpoint=str(checkpoint), checkpointSha256=file_digest(checkpoint),
                records=records, skippedDevDueToTrainingRegression=regressed, promoted=promoted)
            examined.append(entry)
            write_json(out / f"candidate-{step:03d}.json", entry)
            print(f"中途第 {step} 步：覆盖={list(candidate.values())}；"
                  + ("原本正确的训练题退步，跳过开发题" if regressed else f"满足保留规则={promoted}"), flush=True)
            if promoted:
                best_scores, best_step, best_records = candidate, step, records
                best_state = {k:v.clone() for k,v in state.items()}
                best_source = checkpoint
            if all(v == 1 for v in best_scores.values()):
                break
        install(model, best_state)
        if warmup.state_digest(base) != base_hash or any(p.grad is not None for p in base.parameters()):
            raise RuntimeError("Frozen foundation changed during checkpoint screening")
        save_file(model.adapter_state(), str(out / "interface.safetensors"))
        cumulative = parent_result.get("cumulativeSupervisedUpdates", parent_result["updates"])+best_step
        result = dict(updates=cumulative, cumulativeSupervisedUpdates=cumulative,
            recoveryTrainingUpdates=0, rewardUpdates=0, selectedCorrectionStep=best_step,
            selectedSourceCheckpoint=str(best_source), selectedSourceSha256=file_digest(best_source),
            adapterSha256=file_digest(out / "interface.safetensors"), baselineScores=baseline,
            selectedScores=best_scores, selectionImproved=best_step>0, baseWeightsUnchanged=True,
            teacherCallsDuringSelection=0, examined=examined, selectedRecords=best_records,
            devUsedForCheckpointSelection=True, finalTestOpened=False, independentDiscovery=False,
            selectionScope="four public polynomial checks only", languagePreservationChecked=False)
        write_json(out / "result.json", result)
        print(f"2/3 已保存选择结果：第 {best_step} 步；覆盖={list(best_scores.values())}。", flush=True)
        return result
    finally:
        model.close()


def run(args):
    if not os.environ.get("LAIN_TEACHER_API_KEY", "").strip():
        raise RuntimeError("请保持之前接通老师的 Notebook 会话；没有发出请求。")
    generator = load_generator(args.generator)
    result = select(args, generator)
    gc.collect()
    if not result["selectionImproved"]:
        print("3/3 检查的候选未同时保住原有覆盖并增加正确题数；保留旧起点，老师新增请求=0。", flush=True)
        print("本次检查记录：", args.out, flush=True)
        return
    # Change only the neutral review instruction. Formula and admission gates
    # remain the inspected generator's code; old requests/results stay intact.
    generator.REVIEW_REQUEST = REVIEW_REQUEST
    write_json(args.out / "note-controller.json", dict(notesRun=str(args.notes_out),
        controllerSourceSha256=file_digest(Path(__file__)), definitionReviewRequest=REVIEW_REQUEST,
        generatorSourceSha256=GENERATOR_SHA256, trainingUpdates=0, maxTeacherCalls=4))
    print("3/3 使用这个单一学生生成两份笔记；老师针对实际原文评审，最多新增4次请求……", flush=True)
    generator.run(SimpleNamespace(student_path=args.student_path, warmup_run=args.out, out=args.notes_out,
        max_new_tokens=128, max_seconds=300, teacher_base_url="https://api.inference.cscs.ch/v1",
        teacher_model="swiss-ai/Apertus-v1.5-8B",
        teacher_revision="CSCS service observed 2026-10-02; weight revision unknown"))
    archive = json.loads((args.notes_out / "archive.json").read_text())
    print("本轮生成核验汇总（无需另跑检查格）：", flush=True)
    for record in archive["records"]:
        for index, candidate in enumerate(record["candidates"]):
            check, review = candidate["verification"], candidate["teacher"]
            summary = dict(task=record["task"]["key"], phase="initial" if index==0 else "revision",
                coverage=check["score"], reason=check["reason"],
                claim=check.get("claim"), teacherStatus=review["definitionTeacherStatus"],
                critique=review.get("critique"), parseError=review.get("parseError"))
            print(json.dumps(summary, ensure_ascii=False, separators=(",", ":")), flush=True)


def cli():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["student-path", "failed-notes", "generator", "out", "notes-out"]:
        parser.add_argument("--"+name, type=Path, required=True)
    parser.add_argument("--max-seconds", type=int, choices=range(60,481), default=480)
    args = parser.parse_args()
    try:
        run(args)
    except KeyboardInterrupt:
        print("已停止；旧权重和已完成检查记录保留，无自动重启。", flush=True)
        raise SystemExit(130)
    except Exception as error:
        safe = str(error) if isinstance(error, (ValueError, RuntimeError, FileNotFoundError)) else type(error).__name__
        print("检查停止：", safe, "；已完成记录保留，无自动重试。", flush=True)
        raise SystemExit(1)


if __name__ == "__main__":
    cli()
'''

tag = uuid.uuid4().hex[:8]
script = work / ("checkpoint-recovery-worker-" + tag + ".py")
with script.open("x", encoding="utf-8") as stream:
    stream.write(worker)
out = work / ("checkpoint-selection-" + tag)
notes = work / ("zip-notes-selected-" + tag)
env = dict(os.environ)
env["PYTHONPATH"] = str(tools) + os.pathsep + env.get("PYTHONPATH", "")
env["HF_HUB_OFFLINE"] = "1"
print("检查保存的中途权重：本轮训练更新=0；最多20次学生短推理。", flush=True)
print("只有保住原有正确题并增加正确题数，才重新生成笔记；老师最多新增4次请求。", flush=True)
try:
    subprocess.run([str(python), "-u", str(script), "--student-path", str(student),
        "--failed-notes", str(failed_notes), "--generator", str(generator),
        "--out", str(out), "--notes-out", str(notes)], env=env, check=True, timeout=900)
except subprocess.TimeoutExpired:
    print("总时限已到，子进程已停止；原权重与已完成检查记录保留。", flush=True)
    raise
