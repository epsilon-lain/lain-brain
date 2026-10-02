"""A bounded, balanced SFT attempt after a two-object correction regressed.

All six public training objects contribute before each optimizer step. Formula
tokens receive more weight. Actual train/dev generations choose one checkpoint;
the reward/zip experiment and the final split remain unopened.
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
from zip_pilot_model import encode_prompt, token_logps
from zip_pilot_protocol import PROTOCOL, canonical, prompt, tasks, verify, write_json

RECOVERY_SHA256 = "eaf54faa24d3c1f4553e925748d5edf9fe856e1c7c000f565ebe88e4afb458da"


def load_recovery(path):
    if file_digest(path) != RECOVERY_SHA256:
        raise ValueError("Saved recovery helper does not match the inspected source")
    spec = importlib.util.spec_from_file_location("lain_verified_recovery_helper", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def examples():
    supplied = []
    for task in tasks("train"):
        a = task.scale
        if task.family == "square":
            expression = f"{2*a}*x*u+{a}*u**2"
            definition = "Changing x by u adds a term proportional to x*u and a remainder proportional to u**2."
        else:
            expression = f"{a}*x*v+{a}*y*u+{a}*u*v"
            definition = "Changing x by u and y by v adds their separate effects plus an interaction proportional to u*v."
        answer = canonical(dict(definition=definition, expression=expression,
                                scope="exact", radius="0.1", status="asserted"))
        checked = verify(task, answer)
        if not checked["accepted"] or checked["score"] != 1:
            raise RuntimeError("Supplied training target failed independent verification")
        supplied.append(dict(task=asdict(task), messages=prompt(task), answer=answer,
            verification=checked, origin="program-supplied SFT target", studentDiscovered=False))
    return supplied


def target_tokens(tokenizer, answer):
    if not tokenizer.is_fast:
        raise ValueError("Formula weighting requires the existing fast tokenizer offsets")
    encoded = tokenizer(answer, add_special_tokens=False, return_offsets_mapping=True)
    ids, offsets = list(encoded["input_ids"]), encoded["offset_mapping"]
    if not ids or len(ids) > 127:
        raise ValueError("Supplied target does not fit the 128-token generation check")
    expression = json.loads(answer)["expression"]
    start = answer.index('"expression":"') + len('"expression":"')
    end = start+len(expression)
    weights, formula_mask = [], []
    for left, right in offsets:
        overlap = left < end and right > start
        digits = overlap and any(c.isdigit() for c in answer[max(left,start):min(right,end)])
        weights.append(8.0 if digits else (4.0 if overlap else 1.0))
        formula_mask.append(float(overlap))
    if not sum(formula_mask):
        raise ValueError("Tokenizer offsets did not identify the supplied expression")
    if tokenizer.eos_token_id is not None:
        ids.append(tokenizer.eos_token_id)
        weights.append(1.0)
        formula_mask.append(0.0)
    return ids, weights, formula_mask


def weighted_loss(model, messages, answer):
    ids, weights, mask = target_tokens(model.tokenizer, answer)
    prefix = encode_prompt(model, messages)[0].tolist()
    logps = token_logps(model, prefix, ids)[0]
    weights = logps.new_tensor(weights)
    mask = logps.new_tensor(mask)
    loss = -(logps*weights).sum()/weights.sum()
    return loss, dict(meanTokenCE=float(-logps.detach().mean()),
        expressionTokenCE=float(-(logps.detach()*mask).sum()/mask.sum()))


def balanced_updates(model, supplied, *, steps, lr, max_seconds, log, validate):
    optimizer = torch.optim.AdamW(model.parameters_to_train(), lr=lr, weight_decay=0)
    count, training_seconds, last_checked = 0, 0.0, 0
    for index in range(steps):
        if training_seconds >= max_seconds:
            break
        started = time.monotonic()
        model.train()
        optimizer.zero_grad(set_to_none=True)
        metrics = []
        # No optimizer step between families or scales: gradients are averaged
        # across this fixed six-example batch at the same current parameters.
        for example in supplied:
            loss, detail = weighted_loss(model, example["messages"], example["answer"])
            (loss/len(supplied)).backward()
            metrics.append(dict(task=example["task"], weightedLoss=float(loss.detach()), **detail))
        norm = torch.nn.utils.clip_grad_norm_(model.parameters_to_train(), 1.0, error_if_nonfinite=True)
        optimizer.step()
        count += 1
        training_seconds += time.monotonic()-started
        log(dict(update=count, supervisedExamples=len(supplied), metrics=metrics,
            meanWeightedLoss=sum(m["weightedLoss"] for m in metrics)/len(metrics),
            gradNorm=float(norm), trainingSeconds=training_seconds, rewardUpdates=0, teacherCalls=0))
        if count % 4 == 0 or count == steps:
            last_checked = count
            if validate(count):
                return count, training_seconds, "public-four-task-check-passed"
    if count and last_checked != count:
        validate(count)
    return count, training_seconds, ("training-time-cap" if count<steps else "requested-updates-complete")


def prepare(args, recovery, generator):
    warmup = generator.load_warmup_module(args.parent_run)
    parent_result = json.loads((args.parent_run / "result.json").read_text())
    if parent_result.get("updates",0)<1 or not parent_result.get("baseWeightsUnchanged"):
        raise ValueError("Need the saved, successful original interface student")
    supplied = examples()
    out = new_run(args.out)
    with out.with_suffix(".py").open("xb") as stream:
        stream.write(args.parent_run.with_suffix(".py").read_bytes())
    torch.manual_seed(1337)
    print("1/3 恢复原来保住平方题的学生，基础权重冻结；优化器重新开始……", flush=True)
    base, tokenizer, metadata = load_student(args.student_path, "cpu")
    model = warmup.restore_interface(args.parent_run, base, tokenizer, metadata)
    base_hash = warmup.state_digest(base)
    try:
        for example in supplied:
            target_tokens(tokenizer, example["answer"])
        write_json(out / "manifest.json", dict(metadata, protocol=PROTOCOL,
            stage="supervised-interface-and-toy-task-preparation", preparationKind="balanced-formula-weighted-SFT",
            rank=model.rank, warmupSourceSha256=generator.WARMUP_WORKER_SHA256,
            balancedSourceSha256=file_digest(Path(__file__)), recoverySourceSha256=RECOVERY_SHA256,
            sources=source_hashes(), parentRun=str(args.parent_run), parentAdapterSha256=parent_result["adapterSha256"],
            learningRate=args.lr, maxTrainingSeconds=args.max_seconds, balancedUpdatesRequested=args.steps,
            examplesPerOptimizerStep=6, formulaTokenWeight=4, formulaNumericTokenWeight=8,
            optimizerStateResumed=False, trainingTargetOrigin="program-supplied verified SFT demonstrations",
            maxStudentCallsDuringChecks=17, maxTeacherCalls=4, rewardUpdates=0,
            devUsedForCheckpointSelection=True, finalTestOpened=False, independentDiscovery=False))
        write_json(out / "supervised-examples.json", dict(examples=supplied, proseCertified=False))
        check_tasks = [tasks("train")[0],tasks("train")[3],tasks("dev")[0],tasks("dev")[2]]
        baseline_records = recovery.evaluate(model, check_tasks, "baseline", out, time.monotonic()+300)
        baseline = recovery.scores(baseline_records)
        best = dict(step=0, scores=dict(baseline), state={k:v.clone() for k,v in model.adapter_state().items()},
                    records=baseline_records)
        print("旧起点覆盖：", list(baseline.values()), flush=True)
        def log(record):
            save_file(model.adapter_state(), str(out / f"checkpoint-{record['update']:03d}.safetensors"))
            write_json(out / f"update-{record['update']:03d}.json", record)
            if record["update"] % 4 == 0 or record["update"] == args.steps:
                print(f"平衡更新 {record['update']}/{args.steps}：6题共同更新，"
                      f"weighted loss={record['meanWeightedLoss']:.4f}，累计训练={record['trainingSeconds']:.1f}s", flush=True)
        def validate(step):
            model.eval()
            records = recovery.evaluate(model, check_tasks, f"balanced-{step:03d}", out, time.monotonic()+300)
            values = recovery.scores(records)
            promoted = recovery.improvement(baseline, values, best["scores"])
            write_json(out / f"validation-{step:03d}.json", dict(step=step, records=records,
                promoted=promoted, devUsedForCheckpointSelection=True, finalTestOpened=False))
            if promoted:
                best.update(step=step,scores=values,state={k:v.clone() for k,v in model.adapter_state().items()},records=records)
            print(f"第 {step} 步生成覆盖：{list(values.values())}；保留为新学生={promoted}", flush=True)
            return all(v==1 for v in best["scores"].values())
        print("2/3 最多12次平衡更新，每次学习全部6个训练对象；本段老师调用=0……", flush=True)
        attempted, seconds, reason = balanced_updates(model, supplied, steps=args.steps, lr=args.lr,
            max_seconds=args.max_seconds, log=log, validate=validate)
        if warmup.state_digest(base) != base_hash or any(p.grad is not None for p in base.parameters()):
            raise RuntimeError("Frozen foundation changed or received gradients")
        recovery.install(model, best["state"])
        save_file(model.adapter_state(), str(out / "interface.safetensors"))
        inherited = parent_result.get("cumulativeSupervisedUpdates",parent_result["updates"])
        result = dict(updates=inherited+best["step"], cumulativeSupervisedUpdates=inherited+best["step"],
            attemptedBalancedUpdates=attempted, attemptedSupervisedExamples=attempted*len(supplied),
            selectedBalancedUpdate=best["step"], selectedNewSupervisedExamples=best["step"]*len(supplied),
            trainingSeconds=seconds, stopReason=reason, adapterSha256=file_digest(out / "interface.safetensors"),
            baseWeightsUnchanged=True, baselineScores=baseline, selectedScores=best["scores"],
            selectedRecords=best["records"], publicMathChecksPassed=all(v==1 for v in best["scores"].values()),
            teacherCallsDuringTraining=0, rewardUpdates=0, independentDiscovery=False,
            devUsedForCheckpointSelection=True, finalTestOpened=False, optimizerStateSaved=False,
            languagePreservationAutomaticallyCertified=False)
        write_json(out / "result.json", result)
        language = base_generate(base,tokenizer,[dict(role="user",content="请用两句话解释图书馆是什么。")],128)
        write_json(out / "language.json", dict(output=language, automaticallyCertified=False))
        print("选中学生中文：", json.dumps(language["raw"],ensure_ascii=False), flush=True)
        print(f"选择第 {best['step']} 步；覆盖={list(best['scores'].values())}；记录：{out}", flush=True)
        for record in best["records"]:
            if record["verification"]["score"]<1:
                print("未通过：", record["task"]["key"],record["verification"]["reason"],
                      json.dumps(record["output"]["raw"],ensure_ascii=False),flush=True)
        return result
    finally:
        model.close()


def run(args):
    if not os.environ.get("LAIN_TEACHER_API_KEY", "").strip():
        raise RuntimeError("请保持之前接通老师的 Notebook 会话；没有发出请求。")
    recovery = load_recovery(args.recovery_source)
    generator = recovery.load_generator(args.generator)
    result = prepare(args,recovery,generator)
    gc.collect()
    if not result["publicMathChecksPassed"]:
        print("3/3 四道公开数学检查尚未全部通过；老师新增请求=0。本次尝试停止，不自动追加训练。",flush=True)
        return
    generator.REVIEW_REQUEST = recovery.REVIEW_REQUEST
    write_json(args.out / "note-controller.json", dict(notesRun=str(args.notes_out),
        controllerSourceSha256=file_digest(Path(__file__)), reviewRequest=recovery.REVIEW_REQUEST,
        generatorSourceSha256=recovery.GENERATOR_SHA256, maxTeacherCalls=4))
    print("3/3 四道公开数学检查通过，自动生成两份笔记；老师最多新增4次请求……",flush=True)
    generator.run(SimpleNamespace(student_path=args.student_path,warmup_run=args.out,out=args.notes_out,
        max_new_tokens=128,max_seconds=300,teacher_base_url="https://api.inference.cscs.ch/v1",
        teacher_model="swiss-ai/Apertus-v1.5-8B",
        teacher_revision="CSCS service observed 2026-10-02; weight revision unknown"))
    archive = json.loads((args.notes_out / "archive.json").read_text())
    for record in archive["records"]:
        for index,candidate in enumerate(record["candidates"]):
            review,check=candidate["teacher"],candidate["verification"]
            print(canonical(dict(task=record["task"]["key"],phase="initial" if index==0 else "revision",
                coverage=check["score"],reason=check["reason"],claim=check.get("claim"),
                teacherStatus=review["definitionTeacherStatus"],critique=review.get("critique"))),flush=True)


def cli():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["student-path","parent-run","recovery-source","generator","out","notes-out"]:
        parser.add_argument("--"+name,type=Path,required=True)
    parser.add_argument("--steps",type=int,choices=range(1,13),default=12)
    parser.add_argument("--lr",type=float,default=0.0003)
    parser.add_argument("--max-seconds",type=int,choices=range(30,181),default=180)
    args=parser.parse_args()
    if not 0<args.lr<=0.0003:
        parser.error("lr must be in (0, 0.0003]")
    try:
        run(args)
    except KeyboardInterrupt:
        print("已停止；原模型与已完成权重、检查记录保留，不自动重启。",flush=True)
        raise SystemExit(130)
    except Exception as error:
        safe=str(error) if isinstance(error,(ValueError,RuntimeError,FileNotFoundError)) else type(error).__name__
        print("本次尝试停止：",safe,"；已完成记录保留，不自动重试。",flush=True)
        raise SystemExit(1)


if __name__=="__main__":
    cli()
