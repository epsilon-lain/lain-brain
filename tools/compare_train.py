"""Paired fixed-step control: uniform training versus the complete Brain replay policy.

Same frozen checkpoint, split, optimizer, batch size and paired student seeds.
An actual running Brain is required; no simulated verifier is used here.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import statistics
import sys
import time
import uuid

import auto_train as loop


def state_digest(checkpoint):
    """Hash tensor values; torch archive bytes also contain packaging metadata."""
    import hashlib
    state, _ = loop.load_checkpoint(checkpoint)
    digest = hashlib.sha256()
    for name, tensor in sorted(state.items()):
        digest.update(json.dumps([name, str(tensor.dtype), list(tensor.shape)]).encode())
        digest.update(tensor.detach().cpu().contiguous().numpy().tobytes())
    return digest.hexdigest()


def validate(args):
    if len(args.seeds) != len(set(args.seeds)) or not 1 <= len(args.seeds) <= 5:
        raise ValueError("Supply 1..5 distinct, preselected student seeds")
    if args.rounds != 2:
        raise ValueError("This comparison fixes two rounds: shared warmup then feedback")
    base = loop.parser().parse_args(["--project", str(args.project), "--vault", str(args.vault),
                                    "--device", args.device])
    for key in ["steps_per_round", "max_seconds", "brain_timeout", "reviewer_steps", "reviewer_seed", "batch_size", "lr"]:
        setattr(base, key, getattr(args, key))
    for seed in args.seeds:
        base.seed = seed
        loop.validate(base)
    args.project, args.vault = base.project, base.vault
    initial = args.student_checkpoint
    if initial is None:
        # Deliberately exclude already-feedback-trained auto runs. Resolve once,
        # before any arm starts, so newest-checkpoint selection cannot drift.
        options = list((args.project / "laptop_runs").glob("object-laptop-*/checkpoint-*.pt"))
        if not options:
            raise ValueError("No original affine checkpoint. Supply --student-checkpoint explicitly")
        initial = max(options, key=lambda p: p.stat().st_mtime)
    initial = initial.resolve()
    GPT, _ = loop.load_gpt(args.project / "train_gpt.py")
    loop.restore(GPT, initial, loop.model_config())
    return base, initial


def summarize(out, seed, policy, expected_steps, wall_seconds):
    manifest = json.loads((out / "manifest.json").read_text())
    done = json.loads((out / "done.json").read_text())
    if done["studentUpdates"] != expected_steps or done["completedRounds"] != 2:
        raise ValueError("An arm stopped early. No matched-budget result can be reported; outputs preserved")
    rounds = [json.loads((out / f"round-{i:03}.json").read_text()) for i in [1, 2]]
    if [r["measurements"]["steps"] for r in rounds] != [expected_steps // 2, expected_steps]:
        raise ValueError("Round update budgets differ")
    replay = done["objectReplayExamplesUsed"]
    if policy == "baseline" and replay != 0:
        raise ValueError("Control consumed object-derived examples")
    result = {"seed": seed, "policy": policy, "path": str(out), "updates": done["studentUpdates"],
              "before": json.loads((out / "before.json").read_text())["exactDefinitionAccuracy"],
              "round1": rounds[0]["measurements"]["evalAccuracy"],
              "final": rounds[1]["measurements"]["evalAccuracy"], "replayDraws": replay,
              "updateSeconds": rounds[1]["measurements"]["trainSeconds"], "wallSeconds": wall_seconds,
              "reviewerSetupSeconds": manifest["reviewerSetupSeconds"],
              "reviewerCheckpointSha256": manifest["reviewerCheckpointSha256"],
              "initialCheckpointSha256": manifest["initialCheckpointSha256"],
              "initialStateSha256": state_digest(out / "initial.pt"),
              "round1StateSha256": state_digest(out / "checkpoint-001.pt"), "dataset": manifest["dataset"]}
    # Keep every held-out prediction and group by function. The six orders of
    # each input triple are correlated; 990 contexts are not 990 independent tests.
    predictions = json.loads((out / "evaluation-002.json").read_text())["heldOutPredictions"]
    records = loop.task.make_data()["eval"]
    if len(predictions) != len(records):
        raise ValueError("Incomplete held-out predictions")
    counts = {}
    for record, prediction in zip(records, predictions):
        values = counts.setdefault(record["taskId"], [0, 0])
        values[0] += prediction == record["coefficients"]
        values[1] += 1
    result["perFunctionAccuracy"] = {k: n / total for k, (n, total) in counts.items()}
    return result


def paired_result(arms):
    pairs = []
    for seed in sorted({r["seed"] for r in arms}):
        pair = {r["policy"]: r for r in arms if r["seed"] == seed}
        if set(pair) != {"baseline", "brain_objects"}:
            raise ValueError("Incomplete paired arms")
        control, brain = pair["baseline"], pair["brain_objects"]
        for key in ["updates", "before", "initialCheckpointSha256", "initialStateSha256", "dataset",
                    "round1", "round1StateSha256"]:
            if control[key] != brain[key]:
                raise ValueError(f"Unmatched pair at seed {seed}: {key}. No comparison claim; outputs preserved")
        pairs.append({"seed": seed, "baselineAccuracy": control["final"], "brainAccuracy": brain["final"],
                      "differencePercentagePoints": 100 * (brain["final"] - control["final"])})
    return {"pairs": pairs, "meanDifferencePercentagePoints": statistics.mean(p["differencePercentagePoints"] for p in pairs),
            "sampleStdDifferencePercentagePoints": statistics.stdev(p["differencePercentagePoints"] for p in pairs) if len(pairs) > 1 else None,
            "baselineMeanAccuracy": statistics.mean(p["baselineAccuracy"] for p in pairs),
            "brainMeanAccuracy": statistics.mean(p["brainAccuracy"] for p in pairs),
            "winsTiesLosses": [sum(p["differencePercentagePoints"] > 0 for p in pairs),
                                sum(p["differencePercentagePoints"] == 0 for p in pairs),
                                sum(p["differencePercentagePoints"] < 0 for p in pairs)]}


def write_report(out, arms, result):
    lines = ["# Lain Brain：同起点、同训练步数对照", "",
             "两组都从同一份冻结权重、全新的 AdamW 状态开始。验证集、学习率、批量和每组更新次数相同。",
             "第一轮参数逐位一致检查通过；第二轮比较完整 Brain 策略（错误任务优先抽样 + 接纳定义生成样本）与均匀抽样。", "",
             "| 种子 | 普通训练 | Brain 反馈 | 差值（百分点） |", "|---:|---:|---:|---:|"]
    for p in result["pairs"]:
        lines.append(f"| {p['seed']} | {p['baselineAccuracy']:.2%} | {p['brainAccuracy']:.2%} | {p['differencePercentagePoints']:+.2f} |")
    lines += ["", f"平均差值：{result['meanDifferencePercentagePoints']:+.2f} 个百分点。",
              f"Brain 胜 / 平 / 负：{result['winsTiesLosses']}。", "",
              "## 实际成本", "", "| 种子 | 组 | 更新秒数 | 总耗时秒数 | 审阅模型准备秒数 | 对象样本抽样次数 |",
              "|---:|---|---:|---:|---:|---:|"]
    for r in arms:
        lines.append(f"| {r['seed']} | {r['policy']} | {r['updateSeconds']:.2f} | {r['wallSeconds']:.2f} | {r['reviewerSetupSeconds']:.2f} | {r['replayDraws']} |")
    lines += ["", "## 解释边界", "",
              "这是固定起点的少量种子重复，不是多个独立预训练模型。验证的是同一组 15 个函数在未训练输入组合上的预测，不能说明未见函数或组合推理能力。",
              "990 个验证上下文含同一三元组的六种排列，彼此相关；本报告不把它们当作独立样本计算显著性。此前已查看过该验证集，结论属于探索性结果。",
              "对象生成样本在这个小任务上与对应原训练样本相同，因此本实验检验整个反馈抽样策略，不能单独证明符号表示带来收益。",
              "训练步数相等，不代表总算力相等。审阅模型准备、评估、验证与文件交换都计入每组总耗时；缓存审阅模型的历史训练成本不包含在本次耗时内。",
              "为检查配对，使用确定性算法和 math attention；与之前自动训练的运行设置不同。没有挑选表现最好的种子，正负结果都保留。", ""]
    (out / "comparison.md").write_text("\n".join(lines), encoding="utf-8")


def run(args):
    os.environ["CUBLAS_WORKSPACE_CONFIG"] = ":4096:8"
    import torch
    torch.set_num_threads(1)
    base, initial = validate(args)
    if args.inspect:
        print(f"Preflight OK: checkpoint={initial}; seeds={args.seeds}; each arm={2 * args.steps_per_round} updates. No files written.")
        return None
    if args.device == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA unavailable; choose --device cpu explicitly")
    torch.use_deterministic_algorithms(True)
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    torch.backends.cuda.enable_flash_sdp(False)
    torch.backends.cuda.enable_mem_efficient_sdp(False)
    torch.backends.cuda.enable_math_sdp(True)
    torch.backends.cuda.enable_cudnn_sdp(False)
    import fcntl
    folder = args.project / "laptop_runs"
    folder.mkdir(exist_ok=True)
    with (folder / "auto-training.lock").open("a+") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("A training or comparison session is already running for this project") from None
        lock.seek(0); lock.truncate(); lock.write(str(os.getpid())); lock.flush()
        out = folder / ("comparison-" + uuid.uuid4().hex[:12])
        out.mkdir(exist_ok=False)
        frozen = out / "initial.pt"
        source_hash = loop.file_digest(initial)
        shutil.copyfile(initial, frozen)
        if loop.file_digest(frozen) != source_hash:
            raise ValueError("Checkpoint changed while freezing the experiment")
        base.student_checkpoint = frozen
        plan = {"schemaVersion": 1, "initialSource": str(initial), "initialCheckpointSha256": source_hash,
                "seeds": args.seeds, "stepsPerArm": 2 * args.steps_per_round, "batchSize": args.batch_size,
                "lr": args.lr, "policies": ["baseline", "brain_objects"], "device": args.device,
                "comparisonRunnerSha256": loop.file_digest(Path(__file__)),
                "pairing": "identical first-round tensor digest required; fresh optimizer each arm; separate replay RNG",
                "attention": "deterministic math SDP; TF32 disabled", "status": "started"}
        loop.json_write(out / "plan.json", plan)
        # Check the real plugin before starting any student/reviewer training.
        loop.exchange(args.vault, out.name + "-probe", args.brain_timeout)
        arms = []
        for index, seed in enumerate(args.seeds):
            order = ["baseline", "brain_objects"] if index % 2 == 0 else ["brain_objects", "baseline"]
            for policy in order:
                if (out / "STOP").exists():
                    raise RuntimeError("Comparison STOP file found; partial outputs preserved")
                base.seed, base.policy = seed, policy
                print(f"\nCOMPARE seed={seed} policy={policy}; frozen initial SHA256={source_hash}", flush=True)
                started = time.perf_counter()
                arm_out = loop._run(base)
                arms.append(summarize(arm_out, seed, policy, 2 * args.steps_per_round, time.perf_counter() - started))
                loop.json_write(out / f"arms-{len(arms):03}.json", arms)
            paired_result(arms)  # Reject mismatch immediately, not after all seeds.
        result = paired_result(arms)
        reviewer_shas = {r["reviewerCheckpointSha256"] for r in arms if r["policy"] == "brain_objects"}
        if len(reviewer_shas) != 1:
            raise ValueError("Reviewer changed between seed pairs")
        loop.json_write(out / "comparison.json", {"schemaVersion": 1, "plan": plan, "arms": arms, **result, "status": "complete"})
        write_report(out, arms, result)
        for pair in result["pairs"]:
            print(f"seed {pair['seed']}: baseline={pair['baselineAccuracy']:.4f}; Brain={pair['brainAccuracy']:.4f}; difference={pair['differencePercentagePoints']:+.2f} pp", flush=True)
        print(f"Mean difference: {result['meanDifferencePercentagePoints']:+.2f} percentage points. Results: {out}", flush=True)
        return out


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--project", type=Path, required=True)
    p.add_argument("--vault", type=Path, required=True)
    p.add_argument("--student-checkpoint", type=Path)
    p.add_argument("--device", choices=["cpu", "cuda"], default="cuda")
    p.add_argument("--seeds", nargs="+", type=int, default=[1337, 2027, 4099])
    p.add_argument("--rounds", type=int, default=2)
    p.add_argument("--steps-per-round", type=int, default=300)
    p.add_argument("--reviewer-steps", type=int, default=600)
    p.add_argument("--reviewer-seed", type=int, default=7331)
    p.add_argument("--batch-size", type=int, default=64)
    p.add_argument("--lr", type=float, default=0.001)
    p.add_argument("--max-seconds", type=float, default=60)
    p.add_argument("--brain-timeout", type=float, default=180)
    p.add_argument("--inspect", action="store_true")
    return p


if __name__ == "__main__":
    try:
        run(parser().parse_args())
    except Exception as error:
        print(f"STOPPED: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
