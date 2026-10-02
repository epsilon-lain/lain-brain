"""Copy the entire file into one NEW Notebook code cell and click its left ▶."""
from pathlib import Path
import hashlib, os, subprocess, uuid

work = Path("/mnt/workspace/lain-zip-pilot")
tools = work / "tools-v2" if (work / "tools-v2").is_dir() else work / "tools"
python = work / "student-env/bin/python"
student = work / "models/Apertus-v1.1-0.5B-Instruct"
source = work / "balanced-preparation-950a4b76"
generator = work / "zip-notes-4f3785ac.py"
recovery_hash = "eaf54faa24d3c1f4553e925748d5edf9fe856e1c7c000f565ebe88e4afb458da"
if not python.is_file() or not (student / "model.safetensors").is_file() or not generator.is_file():
    raise RuntimeError("找不到现有学生、环境或生成器；本格不安装、不下载。")
if not (source / "checkpoint-008.safetensors").is_file():
    raise RuntimeError("找不到这次平衡尝试的第8步权重；没有开始训练或请求老师。")
recovery = next((p for p in sorted(work.glob("checkpoint-recovery-worker-*.py"))
    if hashlib.sha256(p.read_bytes()).hexdigest() == recovery_hash), None)
if recovery is None:
    raise RuntimeError("找不到已核验的恢复脚本；没有请求老师。")
expected_tools = {'zip_pilot.py': '72031cd0db0f2189b379f306a8f0724b03be9dc5ba231dffff03e898de7b4945', 'zip_pilot_protocol.py': 'f7c9df1574ebaff35494397b7e1726877ee019b8d0afdfc109efe44d1d18f819', 'zip_pilot_model.py': '2530e390412848344b8beb64f1f282fee326669627c201bc49f45d4c5c839c14', 'research_reward_probe.py': '4fa71099207dddb1971c2289092ec0a0543d19e0a4b7495c4a5ed823c945dec3'}
for name, expected in expected_tools.items():
    if not (tools / name).is_file() or hashlib.sha256((tools / name).read_bytes()).hexdigest() != expected:
        raise RuntimeError("已有 v2 脚本校验未通过：" + name)

worker = r'''
"""Audit a separate, imperfect saved student for a bounded zip experiment.

No training or default promotion. Four public checks remain visible; only the
two certified training objects proceed to the existing note admission gates.
This prepares material, not an evaluation of zip benefit or a new discovery.
"""
from __future__ import annotations

import argparse
import gc
import importlib.util
import json
import os
from pathlib import Path
import time
from types import SimpleNamespace

from safetensors.torch import save_file

from zip_pilot import file_digest, load_student, new_run, source_hashes
from zip_pilot_protocol import PROTOCOL, tasks, write_json

RECOVERY_SHA256 = "eaf54faa24d3c1f4553e925748d5edf9fe856e1c7c000f565ebe88e4afb458da"
BALANCED_SHA256 = "a57140293b4baa761947fbfa1e989a2215ca832a2fd990bf19bbcf02314d9b65"
STEP = 8


def load_recovery(path):
    if file_digest(path) != RECOVERY_SHA256:
        raise ValueError("Saved recovery helper failed its pinned source check")
    spec = importlib.util.spec_from_file_location("lain_experimental_recovery", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def protected_files(source, parent):
    paths = [source / name for name in ["manifest.json", "result.json", "interface.safetensors",
             "checkpoint-008.safetensors", "validation-008.json"]]
    paths += [parent / name for name in ["manifest.json", "result.json", "interface.safetensors"]]
    paths.append(parent.with_suffix(".py"))
    return {path: file_digest(path) for path in paths}


def check_unchanged(protected):
    if any(file_digest(path) != digest for path, digest in protected.items()):
        raise RuntimeError("An existing source/default file changed; stopping this experiment")


def prepare(args, recovery, generator):
    source = args.source_run
    source_manifest = json.loads((source / "manifest.json").read_text())
    source_result = json.loads((source / "result.json").read_text())
    saved_check = json.loads((source / "validation-008.json").read_text())
    if (source_manifest.get("protocol") != PROTOCOL
            or source_manifest.get("preparationKind") != "balanced-formula-weighted-SFT"
            or source_manifest.get("balancedSourceSha256") != BALANCED_SHA256
            or source_manifest.get("recoverySourceSha256") != RECOVERY_SHA256
            or source_manifest.get("examplesPerOptimizerStep") != 6
            or not source_result.get("baseWeightsUnchanged")
            or source_result.get("selectedBalancedUpdate") != 0
            or source_result.get("attemptedBalancedUpdates", 0) < STEP
            or saved_check.get("step") != STEP):
        raise ValueError("Need the recorded balanced run with its default still at step zero")
    parent = Path(source_manifest["parentRun"])
    parent_manifest = json.loads((parent / "manifest.json").read_text())
    parent_result = json.loads((parent / "result.json").read_text())
    if (source_manifest["snapshotSha256"] != parent_manifest["snapshotSha256"]
            or source_manifest["rank"] != parent_manifest["rank"]
            or not parent_result.get("baseWeightsUnchanged")
            or parent_result.get("updates", 0) < 1
            or file_digest(parent / "interface.safetensors") != parent_result["adapterSha256"]
            or source_manifest["parentAdapterSha256"] != parent_result["adapterSha256"]
            or file_digest(source / "interface.safetensors") != source_result["adapterSha256"]):
        raise ValueError("Parent, default or foundation provenance mismatch")
    protected = protected_files(source, parent)
    warmup = generator.load_warmup_module(parent)
    out = new_run(args.out)
    with out.with_suffix(".py").open("xb") as stream:
        stream.write(parent.with_suffix(".py").read_bytes())
    print("恢复第 8 步为独立实验学生；默认学生保持原起点，本轮训练更新=0……", flush=True)
    base, tokenizer, metadata = load_student(args.student_path, "cpu")
    model = warmup.restore_interface(parent, base, tokenizer, metadata)
    try:
        checkpoint = source / "checkpoint-008.safetensors"
        recovery.install(model, recovery.checked_state(checkpoint, model))
        base_hash = warmup.state_digest(base)
        adapter_hash = warmup.state_digest(model.generation_adapter)
        write_json(out / "manifest.json", dict(metadata, protocol=PROTOCOL,
            stage="supervised-interface-and-toy-task-preparation", rank=model.rank,
            preparationKind="experimental-fork-of-saved-balanced-step-no-new-training",
            warmupSourceSha256=generator.WARMUP_WORKER_SHA256, sources=source_hashes(),
            controllerSourceSha256=file_digest(Path(__file__)), recoverySourceSha256=RECOVERY_SHA256,
            sourceRun=str(source), sourceCheckpoint=str(checkpoint), sourceCheckpointSha256=file_digest(checkpoint),
            sourceValidationSha256=protected[source / "validation-008.json"],
            parentRun=str(parent), referenceDefaultRun=str(source), promotionToDefault=False,
            candidateStep=STEP, selectionUsedPublicDev=True, finalTestOpened=False,
            hypothesisTested=False, independentDiscovery=False, trainingUpdates=0, rewardUpdates=0,
            maxAuditStudentCalls=4, maxNoteStudentCalls=4, maxTeacherCalls=4,
            teacherEligibility="both audited training objects exact and asserted; dev failures retained",
            trainingTargetOrigin="previous program-supplied verified SFT demonstrations"))
        selected = [tasks("train")[0], tasks("train")[3], tasks("dev")[0], tasks("dev")[2]]
        records = recovery.evaluate(model, selected, "candidate", out, time.monotonic()+300)
        values = recovery.scores(records)
        for record in records:
            check = record["verification"]
            print(f"{record['task']['key']}：覆盖={check['score']}；{check['reason']}", flush=True)
            if not check["accepted"] or check["score"] != 1:
                print("保留失败原文：", record["output"]["raw"], flush=True)
        eligible = len(records) == 4 and all(
            r["verification"]["accepted"] and r["verification"]["score"] == 1
            and r["verification"]["claim"]["scope"] == "exact"
            and r["verification"]["claim"]["status"] == "asserted" for r in records[:2])
        if (warmup.state_digest(base) != base_hash
                or warmup.state_digest(model.generation_adapter) != adapter_hash
                or any(p.requires_grad or p.grad is not None for p in model.parameters())):
            raise RuntimeError("Frozen student changed or received gradients during audit")
        check_unchanged(protected)
        save_file(model.adapter_state(), str(out / "interface.safetensors"))
        inherited = parent_result.get("cumulativeSupervisedUpdates", parent_result["updates"])
        result = dict(updates=inherited+STEP, cumulativeSupervisedUpdates=inherited+STEP,
            inheritedBalancedUpdates=STEP, inheritedBalancedExamples=STEP*6,
            adapterSha256=file_digest(out / "interface.safetensors"), baseWeightsUnchanged=True,
            selectedScores=values, selectedRecords=records, priorPublicScores=recovery.scores(saved_check["records"]),
            teacherEligible=eligible, trainingUpdates=0, rewardUpdates=0, teacherCallsDuringAudit=0,
            promotionToDefault=False, referenceDefaultUnchanged=True, hypothesisTested=False,
            finalTestOpened=False, selectionUsedPublicDev=True, independentDiscovery=False)
        write_json(out / "result.json", result)
        return result, protected
    finally:
        model.close()


def run(args):
    recovery = load_recovery(args.recovery_source)
    generator = recovery.load_generator(args.generator)
    result, protected = prepare(args, recovery, generator)
    gc.collect()
    if not result["teacherEligible"]:
        print("两个训练对象未同时通过数学核验；老师请求=0。保存审计后停止，不追加训练。", flush=True)
        return
    if not os.environ.get("LAIN_TEACHER_API_KEY", "").strip():
        raise RuntimeError("当前 Notebook 会话没有已接通的老师密钥；审计已保存，老师请求=0。")
    generator.REVIEW_REQUEST = recovery.REVIEW_REQUEST
    write_json(args.out / "note-controller.json", dict(notesRun=str(args.notes_out),
        generatorSourceSha256=recovery.GENERATOR_SHA256, definitionReviewRequest=recovery.REVIEW_REQUEST,
        maxTeacherCalls=4, trainingUpdates=0, rewardUpdates=0, promotionToDefault=False,
        admissionRule="existing formula certification plus CLEAR teacher status; otherwise pending or rejected"))
    print("审阅两个已通过的训练对象；最多4次老师请求，每份最多修订一次……", flush=True)
    try:
        generator.run(SimpleNamespace(student_path=args.student_path, warmup_run=args.out, out=args.notes_out,
            max_new_tokens=128, max_seconds=300, teacher_base_url="https://api.inference.cscs.ch/v1",
            teacher_model="swiss-ai/Apertus-v1.5-8B",
            teacher_revision="CSCS service observed 2026-10-02; weight revision unknown"))
    finally:
        check_unchanged(protected)
    archive = json.loads((args.notes_out / "archive.json").read_text())
    for record in archive["records"]:
        for index, candidate in enumerate(record["candidates"]):
            check, review = candidate["verification"], candidate["teacher"]
            print(json.dumps(dict(task=record["task"]["key"], phase="初稿" if index==0 else "修订",
                coverage=check["score"], reason=check["reason"], claim=check.get("claim"),
                teacherStatus=review["definitionTeacherStatus"], critique=review.get("critique"),
                parseError=review.get("parseError")), ensure_ascii=False), flush=True)
    write_json(args.out / "completion.json", dict(notesRun=str(args.notes_out),
        activeNotes=len(archive["activeNotes"]), pendingNotes=len(archive["pendingDefinitionNotes"]),
        teacherNetworkCalls=archive["teacherNetworkCalls"], trainingUpdates=0, rewardUpdates=0,
        referenceDefaultUnchanged=True, promotionToDefault=False, hypothesisTested=False))
    print("实验材料准备完成，尚未测试 zip 收益；默认学生未替换。记录：", args.out, flush=True)


def cli():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["student-path", "source-run", "recovery-source", "generator", "out", "notes-out"]:
        parser.add_argument("--"+name, type=Path, required=True)
    args = parser.parse_args()
    try:
        run(args)
    except KeyboardInterrupt:
        print("已停止；默认学生及已完成记录保留，不自动重启。", flush=True)
        raise SystemExit(130)
    except Exception as error:
        safe = str(error) if isinstance(error, (ValueError, RuntimeError, FileNotFoundError)) else type(error).__name__
        print("准备停止：", safe, "；已完成记录保留，无自动重试。", flush=True)
        raise SystemExit(1)


if __name__ == "__main__":
    cli()
'''

tag = uuid.uuid4().hex[:8]
script = work / ("zip-experiment-worker-" + tag + ".py")
with script.open("x", encoding="utf-8") as stream:
    stream.write(worker)
out = work / ("zip-experiment-student-" + tag)
notes = work / ("zip-experiment-notes-" + tag)
env = dict(os.environ)
env["PYTHONPATH"] = str(tools) + os.pathsep + env.get("PYTHONPATH", "")
env["HF_HUB_OFFLINE"] = "1"
print("开始准备独立 zip 实验学生：训练更新=0，不替换默认学生。", flush=True)
print("重新核验四道公开题，保留失败；两道训练题正确才审阅，老师最多4次请求。", flush=True)
print("复用当前会话的 key；无需重新输入。最多8次学生短推理，不自动重试。", flush=True)
try:
    subprocess.run([str(python), "-u", str(script), "--student-path", str(student),
        "--source-run", str(source), "--recovery-source", str(recovery), "--generator", str(generator),
        "--out", str(out), "--notes-out", str(notes)], env=env, check=True, timeout=900)
except subprocess.TimeoutExpired:
    print("总时限已到，子进程已停止；默认学生与已完成记录保留。", flush=True)
    raise
