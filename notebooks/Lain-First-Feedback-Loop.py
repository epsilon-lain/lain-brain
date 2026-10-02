"""Paste this entire cell into the existing ModelScope Notebook after the API check.

Uses the already downloaded student and existing v2 tools. No installation,
downloads, GPU allocation, training or Obsidian writes. The secret is inherited
through the process environment, never embedded in this cell or run artifacts.
"""
from pathlib import Path
import os, subprocess, sys, uuid

work = Path("/mnt/workspace/lain-zip-pilot")
tools = work / "tools-v2" if (work / "tools-v2").is_dir() else work / "tools"
student = work / "models/Apertus-v1.1-0.5B-Instruct"
python = work / "student-env/bin/python"
if not os.environ.get("LAIN_TEACHER_API_KEY", "").strip():
    raise RuntimeError("当前 Notebook 会话没有密钥；请保持刚才接口测试成功的会话。")
if not (student / "model.safetensors").is_file():
    raise RuntimeError("当前实例没有找到已下载的学生模型；本格不会重新下载。")
if not (tools / "zip_pilot.py").is_file():
    raise RuntimeError("当前实例没有找到已有实验脚本。")
if not python.is_file():
    raise RuntimeError("当前实例没有找到此前的 student-env 环境。")

worker = r'''
from pathlib import Path
from dataclasses import asdict
import json, sys
tools, student, out = map(Path, sys.argv[1:])
sys.path.insert(0, str(tools))
from zip_pilot import load_student, base_generate, source_hashes
from zip_pilot_protocol import PROTOCOL, Teacher, tasks, prompt, transition, write_json
if PROTOCOL != "lain-zip-pilot-v2":
    raise RuntimeError("需要此前修复过的 v2 脚本，保留旧结果，不自动改写。")
print("1/4 加载已下载的学生模型（CPU）……", flush=True)
model, tokenizer, metadata = load_student(student, "cpu")
task = tasks("train")[0]
write_json(out / "manifest.json", dict(protocol=PROTOCOL, sources=source_hashes(),
    metadata=metadata, task=asdict(task), teacherMaxCalls=1, studentMaxCalls=2,
    trainingUpdates=0, scope="single training-object feedback diagnostic; not a training corpus"))
print("2/4 学生写初稿……", flush=True)
initial = base_generate(model, tokenizer, prompt(task), 128)
first = transition(task, initial["raw"], 0, initial["generatedTokens"])
write_json(out / "initial.json", dict(output=initial, transition=first))
print("学生初稿：", initial["raw"], flush=True)
print("程序核验：", first["verification"]["reason"], flush=True)
print("3/4 老师审阅一次……", flush=True)
teacher = Teacher("https://api.inference.cscs.ch/v1", "swiss-ai/Apertus-v1.5-8B",
    "CSCS service observed 2026-10-02; weight revision unknown", out.parent / "teacher-cache",
    max_calls=1)
review = teacher.review(task, initial["raw"], first["verification"])
write_json(out / "teacher.json", review)
print("老师反馈：", review["raw"], flush=True)
feedback = dict(draft=initial["raw"], programFeedback=dict(
    accepted=first["verification"]["accepted"], reason=first["verification"]["reason"]))
if review["critique"]:
    feedback["teacherCritique"] = review["critique"]
else:
    print("老师反馈格式未通过；本轮修订只使用程序反馈。", flush=True)
print("4/4 学生修改，程序再次核验……", flush=True)
revised = base_generate(model, tokenizer, prompt(task, feedback), 128)
second = transition(task, revised["raw"], first["after"], revised["generatedTokens"])
write_json(out / "report.json", dict(protocol=PROTOCOL, metadata=metadata, task=asdict(task),
    initial=initial, initialTransition=first, teacher=review, revision=revised,
    revisionTransition=second, teacherCalls=teacher.calls, teacherCacheHit=review["cacheHit"],
    studentCalls=2, trainingUpdates=0, archiveChanged=False, teacherAgreementUsed=False,
    scope="feedback-assisted inference only; not learned ability or an independent discovery"))
print("学生修改：", revised["raw"], flush=True)
print("程序核验：", second["verification"]["reason"], flush=True)
print(f"覆盖分：{first['verification']['score']:.1f} → {second['verification']['score']:.1f}", flush=True)
print(f"新增有效覆盖：{second['gain']:.1f}；本步奖励：{second['reward']:.4f}", flush=True)
print("完成。权重更新=0。记录：", out / "report.json", flush=True)
'''
out = work / ("feedback-loop-" + uuid.uuid4().hex[:8])
out.mkdir(parents=True, exist_ok=False)
script = out / "run.py"
script.write_text(worker, encoding="utf-8")
print("开始单题闭环：学生两次输出，老师最多调用一次；无需再输入 key。", flush=True)
subprocess.run([str(python), "-u", str(script), str(tools), str(student), str(out)],
               check=True, timeout=300)
