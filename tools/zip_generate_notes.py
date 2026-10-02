"""Generate the first two experimental notes from the saved warmed student.

Formula certification and teacher opinion on prose are separate. No model
updates, no new demonstrations, no dev/final tasks, no Obsidian mutation.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict
import importlib.util
import json
import os
from pathlib import Path
import time

from zip_pilot import base_generate, file_digest, load_student, new_run, source_hashes
from zip_pilot_protocol import PROTOCOL, Teacher, canonical, fingerprint, prompt, tasks, verify, write_json
from research_reward_probe import VARS, poly

NOTES_PROTOCOL = "lain-zip-notes-v1"
WARMUP_WORKER_SHA256 = "b5a53ac146d89163174ea6310ad4862764d3e7f1c751e53aab4142f6a041a72f"
REVIEW_REQUEST = (
    "Also review the student's natural-language definition, not just the formula. "
    "Start assessment with exactly CLEAR:, NEEDS_REVISION:, or UNCERTAIN:. "
    "CLEAR means the definition is understandable and accurately describes the input/output change "
    "and the declared scope. Repetition about 'order of the order' is not clear. "
    "If revision is needed, use hint to ask the student to describe the change in one concrete sentence. "
    "Do not supply a replacement definition or expanded formula. Critique text is an opinion, not a proof."
)


def load_warmup_module(run):
    manifest = json.loads((run / "manifest.json").read_text())
    if (manifest.get("protocol") != PROTOCOL
            or manifest.get("stage") != "supervised-interface-and-toy-task-preparation"
            or manifest.get("warmupSourceSha256") != WARMUP_WORKER_SHA256):
        raise ValueError("Warmup source/protocol differs from the inspected preparation run")
    source = run.with_suffix(".py")
    if file_digest(source) != WARMUP_WORKER_SHA256:
        raise ValueError("Saved warmup loader source failed its pinned hash check")
    spec = importlib.util.spec_from_file_location("lain_verified_interface_loader", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def review_definition(teacher, task, output, checked):
    review = teacher.review(task, output["raw"], dict(checked, definitionReviewRequest=REVIEW_REQUEST))
    assessment = (review.get("critique") or {}).get("assessment", "")
    status = "unknown"
    for prefix, value in [("CLEAR:", "clear"), ("NEEDS_REVISION:", "needs_revision"), ("UNCERTAIN:", "unknown")]:
        if assessment.startswith(prefix):
            status = value
            break
    return dict(review, definitionTeacherStatus=status, definitionCertified=False)


def features(checked):
    if not checked["accepted"] or checked["score"] <= 0:
        raise ValueError("Features require a program-certified mathematical candidate")
    terms = poly(checked["claim"]["expression"])
    return dict(origin="deterministic extraction from certified polynomial", learned=False,
        variableOrder=list(VARS), variables=[v for i,v in enumerate(VARS) if any(k[i] for k in terms)],
        degree=max((sum(k) for k in terms), default=0), termCount=len(terms),
        terms=[dict(coefficient=str(value), powers=dict(zip(VARS, key))) for key,value in sorted(terms.items())],
        scope=checked["claim"]["scope"], certificate=checked["certificate"])


def note_from_candidate(task, candidate, warmup_sha):
    checked, review = candidate["verification"], candidate["teacher"]
    claim = checked["claim"]
    return dict(id=fingerprint(dict(task=asdict(task), claim=claim)), task=asdict(task),
        raw=candidate["output"]["raw"], claim=claim, formulaCertified=True,
        verification=checked, definitionTeacherStatus=review["definitionTeacherStatus"],
        definitionCertified=False, teacherRequestHash=review["requestHash"], origin=candidate["origin"],
        warmupAdapterSha256=warmup_sha, independentDiscovery=False,
        trainingDemonstrationsPreviouslySeen=True, features=features(checked),
        status="teacher-reviewed-experimental" if review["definitionTeacherStatus"] == "clear" else "formula-only-pending-definition")


def choose_candidate(task, candidates, warmup_sha):
    mathematical = [c for c in candidates if c["verification"]["accepted"] and c["verification"]["score"] > 0]
    if not mathematical:
        return None
    clear = [c for c in mathematical if c["teacher"]["definitionTeacherStatus"] == "clear"]
    # Prefer clear, mathematically valid notes, then their certified coverage.
    # A wrong revision cannot overwrite an already valid initial model.
    selected = max(clear or mathematical, key=lambda c: c["verification"]["score"])
    return note_from_candidate(task, selected, warmup_sha)


def markdown(note):
    title = "平方变化" if note["task"]["family"] == "square" else "乘积变化"
    quote = "\n".join("> " + line for line in note["claim"]["definition"].splitlines())
    return (f"# {title}\n\n状态：{note['status']}\n\n学生自己的定义：\n\n{quote}\n\n"
        f"公式：\n\n```python\n{note['claim']['expression']}\n```\n\n"
        f"范围：{note['claim']['scope']}；半径字段：{note['claim']['radius']}\n\n"
        "公式有程序证书；自然语言只有老师意见，没有自动真值证书。\n\n"
        "本对象已出现在监督热身示例中，不记为新的数学发现。\n")


def run(args):
    if PROTOCOL != "lain-zip-pilot-v2":
        raise RuntimeError("Need the existing verified v2 pilot tools")
    if not os.environ.get("LAIN_TEACHER_API_KEY", "").strip():
        raise RuntimeError("当前会话没有之前的老师密钥；没有发出任何请求。")
    warmup = load_warmup_module(args.warmup_run)
    result_before = json.loads((args.warmup_run / "result.json").read_text())
    if result_before.get("updates", 0) < 1 or not result_before.get("baseWeightsUnchanged"):
        raise ValueError("Need the successfully trained, frozen-foundation interface run")
    out = new_run(args.out)
    print("1/3 恢复已训练的学生适配器（CPU），本轮权重更新=0……", flush=True)
    base, tokenizer, metadata = load_student(args.student_path, "cpu")
    model = warmup.restore_interface(args.warmup_run, base, tokenizer, metadata)
    model.requires_grad_(False).eval()
    base_hash = warmup.state_digest(base)
    adapter_hash = warmup.state_digest(model.generation_adapter)
    write_json(out / "manifest.json", dict(protocol=NOTES_PROTOCOL, underlyingProtocol=PROTOCOL,
        metadata=metadata, sources=source_hashes(), generatorSourceSha256=file_digest(Path(__file__)),
        warmupRun=str(args.warmup_run), warmupAdapterSha256=result_before["adapterSha256"],
        objects=2, maxStudentCalls=4, maxTeacherCalls=4, maxNewTokens=args.max_new_tokens,
        teacherModel=args.teacher_model, teacherRevisionDeclared=args.teacher_revision,
        teacherRevisionVerified=False, trainingUpdates=0, rewardUpdates=0,
        proseCertified=False, finalTestOpened=False, obsidianChanged=False))
    teacher = Teacher(args.teacher_base_url, args.teacher_model, args.teacher_revision,
                      out.parent / "teacher-cache", max_calls=4)
    started = time.monotonic()
    records, notes = [], []
    student_calls = 0
    try:
        for task in [tasks("train")[0], tasks("train")[3]]:
            if time.monotonic()-started >= args.max_seconds:
                raise RuntimeError("生成计时达到上限；已完成的逐项记录保留。")
            print("2/3 生成并对齐：", "平方变化" if task.family == "square" else "乘积变化", flush=True)
            initial = base_generate(base, tokenizer, prompt(task), args.max_new_tokens)
            student_calls += 1
            check = verify(task, initial["raw"])
            write_json(out / (task.key + "-initial.json"), dict(task=asdict(task), output=initial, verification=check))
            reviewed = review_definition(teacher, task, initial, check)
            candidates = [dict(output=initial, verification=check, teacher=reviewed,
                               origin="student-after-supervised-preparation")]
            write_json(out / (task.key + "-initial-reviewed.json"), dict(task=asdict(task), candidate=candidates[0]))
            if not (check["accepted"] and check["score"] > 0 and reviewed["definitionTeacherStatus"] == "clear"):
                feedback = dict(draft=initial["raw"], programFeedback=dict(accepted=check["accepted"], reason=check["reason"]),
                    definitionInstruction="Give one short concrete sentence about the modeled input/output change. Keep any certified formula and scope unless you find an error. Avoid repetitive descriptions of polynomial order.")
                if reviewed.get("critique"):
                    feedback["teacherCritique"] = reviewed["critique"]
                revised = base_generate(base, tokenizer, prompt(task, feedback), args.max_new_tokens)
                student_calls += 1
                revised_check = verify(task, revised["raw"])
                write_json(out / (task.key + "-revision.json"), dict(output=revised, verification=revised_check))
                revised_review = review_definition(teacher, task, revised, revised_check)
                candidates.append(dict(output=revised, verification=revised_check, teacher=revised_review,
                                       origin="student-after-teacher-feedback"))
            note = choose_candidate(task, candidates, result_before["adapterSha256"])
            records.append(dict(task=asdict(task), candidates=candidates, selectedNoteId=note["id"] if note else None))
            write_json(out / (task.key + "-complete.json"), records[-1])
            if note:
                notes.append(note)
                write_json(out / (task.key + "-note.json"), note)
                with (out / (task.key + ".md")).open("x", encoding="utf-8") as stream:
                    stream.write(markdown(note))
                print(f"公式覆盖={note['verification']['score']:.1f}；定义老师意见={note['definitionTeacherStatus']}", flush=True)
                print("学生定义：", note["claim"]["definition"], flush=True)
                print("公式：", note["claim"]["expression"], flush=True)
            else:
                print("没有可核验公式；保留原稿与反馈，未纳入笔记。", flush=True)
        if warmup.state_digest(base) != base_hash or warmup.state_digest(model.generation_adapter) != adapter_hash:
            raise RuntimeError("生成期间基础权重或已训练适配器发生变化")
        active = [n for n in notes if n["definitionTeacherStatus"] == "clear"]
        pending = [n for n in notes if n["definitionTeacherStatus"] != "clear"]
        archive = dict(protocol=NOTES_PROTOCOL, warmupAdapterSha256=result_before["adapterSha256"],
            activeNotes=active, pendingDefinitionNotes=pending, records=records,
            teacherNetworkCalls=teacher.calls, teacherCacheHits=sum(c["teacher"]["cacheHit"] for r in records for c in r["candidates"]),
            studentCalls=student_calls, trainingUpdates=0, rewardUpdates=0,
            baseWeightsUnchanged=True, warmedAdapterUnchanged=True, proseCertified=False,
            independentDiscovery=False, finalTestOpened=False, obsidianChanged=False)
        archive["notesFingerprint"] = fingerprint(dict(active=active, pending=pending))
        write_json(out / "archive.json", archive)
        print(f"3/3 保存完成：实验笔记={len(active)}；公式已核验、定义待对齐={len(pending)}。", flush=True)
        print(f"本轮老师新增请求={teacher.calls}；权重更新=0。记录：{out / 'archive.json'}", flush=True)
    finally:
        model.close()


def cli():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--student-path", type=Path, required=True)
    p.add_argument("--warmup-run", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--max-new-tokens", type=int, choices=range(1,129), default=128)
    p.add_argument("--max-seconds", type=int, choices=range(60,601), default=300)
    p.add_argument("--teacher-base-url", default="https://api.inference.cscs.ch/v1")
    p.add_argument("--teacher-model", default="swiss-ai/Apertus-v1.5-8B")
    p.add_argument("--teacher-revision", default="CSCS service observed 2026-10-02; weight revision unknown")
    args = p.parse_args()
    try:
        run(args)
    except KeyboardInterrupt:
        print("已停止；原稿和已完成笔记保留，不自动重启。", flush=True)
        raise SystemExit(130)
    except Exception as error:
        safe = str(error) if isinstance(error, (ValueError, RuntimeError, FileNotFoundError)) else type(error).__name__
        print("生成停止：", safe, "；已完成的记录保留，无自动重试。", flush=True)
        raise SystemExit(1)


if __name__ == "__main__":
    cli()
