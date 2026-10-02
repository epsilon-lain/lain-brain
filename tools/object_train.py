"""Supervised affine-definition prediction with the reviewed Parameter Golf GPT.

Three (x,y) examples -> two autoregressive coefficient tokens -> bounded AST.
This is a new random model, not a continuation of the language checkpoint.
No teacher, Brain feedback, learned composition, or autonomous improvement.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import itertools
import json
import math
from pathlib import Path
import random
import sys
import time
import uuid

from laptop_train import file_digest, json_write, load_gpt, logits

# Fixed task/grammar, independent of training seed. No downloaded dataset.
DATA_SEED = 20261001
BOS, DEFINE, NUMBER_OFFSET, VOCAB_SIZE = 0, 1, 10, 19
SLOPES, INTERCEPTS = list(range(-2, 3)), list(range(-1, 2))


def number_token(n):
    if not -8 <= n <= 8:
        raise ValueError("Number outside the task vocabulary")
    return NUMBER_OFFSET + n


def make_data():
    groups = list(itertools.combinations(range(-3, 4), 3))
    random.Random(DATA_SEED).shuffle(groups)
    splits = {}
    for split, combos in [("train", groups[:24]), ("eval", groups[24:])]:
        records = []
        for index, (a, b) in enumerate(itertools.product(SLOPES, INTERCEPTS), 1):
            for group in combos:
                for xs in itertools.permutations(group):
                    records.append({"taskId": f"affine-{index:03}",
                                    "pairs": [[x, a * x + b] for x in xs],
                                    "coefficients": [a, b]})
        splits[split] = records
    return splits


def prompt(record):
    return [BOS] + [number_token(n) for pair in record["pairs"] for n in pair] + [DEFINE]


def tensors(records, device):
    import torch
    return (torch.tensor([prompt(r) for r in records], dtype=torch.long, device=device),
            torch.tensor([r["coefficients"] for r in records], dtype=torch.long, device=device))


def definition(a, b):
    return {"op": "add", "left": {"op": "scale", "factor": str(a), "body": {"op": "x"}},
            "right": {"op": "const", "value": str(b)}}


def reference(a, b):
    # A different, programmer-specified representation: a*(x+1) + (b-a).
    # Representation style is not discovered by the model.
    return {"op": "add", "left": {"op": "scale", "factor": str(a),
                                    "body": {"op": "add", "left": {"op": "x"},
                                             "right": {"op": "const", "value": "1"}}},
            "right": {"op": "const", "value": str(b - a)}}


def loss(model, inputs, targets):
    import torch
    import torch.nn.functional as F
    # Teacher forcing is used only for the training / conditional-loss metric.
    sequence = torch.cat([inputs, (targets[:, :1] + NUMBER_OFFSET)], dim=1)
    scores = logits(model, sequence).float()
    a_loss = F.cross_entropy(scores[:, -2, NUMBER_OFFSET - 2:NUMBER_OFFSET + 3], targets[:, 0] + 2)
    b_loss = F.cross_entropy(scores[:, -1, NUMBER_OFFSET - 1:NUMBER_OFFSET + 2], targets[:, 1] + 1)
    return (a_loss + b_loss) / 2


def predict(model, inputs):
    import torch
    scores = logits(model, inputs)
    a = scores[:, -1, NUMBER_OFFSET - 2:NUMBER_OFFSET + 3].argmax(-1) - 2
    # Use the model's own first coefficient, never the evaluation target.
    sequence = torch.cat([inputs, (a[:, None] + NUMBER_OFFSET)], dim=1)
    scores = logits(model, sequence)
    b = scores[:, -1, NUMBER_OFFSET - 1:NUMBER_OFFSET + 2].argmax(-1) - 1
    return torch.stack([a, b], dim=1)


def evaluate(model, inputs, targets):
    import torch
    values, total_loss = [], 0.0
    model.eval()
    # Ordinary no_grad keeps RoPE caches reusable for later autograd steps.
    with torch.no_grad():
        for start in range(0, len(inputs), 64):
            x, y = inputs[start:start + 64], targets[start:start + 64]
            total_loss += loss(model, x, y).item() * len(x)
            values.append(predict(model, x).cpu())
    model.train()
    predicted = torch.cat(values)
    correct = (predicted == targets.cpu()).all(dim=1)
    result = {"conditionalCoefficientLoss": total_loss / len(inputs),
              "exactDefinitionAccuracy": correct.float().mean().item(),
              "evaluatedTasks": len(inputs), "decoding": "autoregressive, grammar-constrained"}
    if not math.isfinite(result["conditionalCoefficientLoss"]):
        raise ValueError("Nonfinite evaluation loss")
    return result, predicted.tolist()


def propose(records, predictions, round_number):
    # First fixed training context per function. Never select by correctness,
    # never use held-out answers, never repair wrong predictions with a solver.
    seen, candidates = set(), []
    for r, predicted in zip(records, predictions):
        if r["taskId"] in seen:
            continue
        seen.add(r["taskId"])
        a, b = predicted
        expected_a, expected_b = r["coefficients"]
        candidates.append({"id": f"r{round_number:03}-{r['taskId']}",
                           "label": f"predicted {a}x + ({b}) for {r['taskId']}",
                           "definition": definition(a, b),
                           "reference": {"taskId": r["taskId"], "split": "train",
                                         "definition": reference(expected_a, expected_b)}})
    return candidates


def validate(args):
    if not 1 <= args.steps <= 2000 or not 1 <= args.round_every <= 2000:
        raise ValueError("steps and round-every must be in 1..2000")
    if not 1 <= args.batch_size <= 128 or not 0 <= args.seed <= 2**31 - 1:
        raise ValueError("Invalid batch size or seed")
    if not math.isfinite(args.lr) or not 0 < args.lr <= 0.01:
        raise ValueError("lr must be finite and in (0, 0.01]")
    if not math.isfinite(args.max_seconds) or args.max_seconds < 0:
        raise ValueError("max-seconds must be finite and nonnegative")


def run(args):
    import torch
    validate(args)
    torch.set_num_threads(1)
    GPT, source_sha = load_gpt(args.project.resolve() / "train_gpt.py")
    data = make_data()
    torch.manual_seed(args.seed)
    config = dict(vocab_size=VOCAB_SIZE, model_dim=64, num_layers=2,
                  num_heads=4, num_kv_heads=2, mlp_mult=2, tie_embeddings=True,
                  tied_embed_init_std=0.005, logit_softcap=30.0,
                  rope_base=10000.0, qk_gain_init=1.5)
    model = GPT(**config)
    count = sum(p.numel() for p in model.parameters())
    preflight = {"status": "preflight_ok", "parameters": count, "initialization": "random",
                 "trainTasks": len(data["train"]), "evalTasks": len(data["eval"]),
                 "cudaAvailable": torch.cuda.is_available(),
                 "task": "three examples -> bounded affine coefficients; held-out input combinations"}
    print(json.dumps(preflight, indent=2), flush=True)
    if args.inspect:
        return None
    if args.device == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA is unavailable; no automatic CPU fallback")
    device = torch.device(args.device)
    model.to(device)
    if device.type == "cuda":
        torch.cuda.reset_peak_memory_stats()
    train_x, train_y = tensors(data["train"], device)
    eval_x, eval_y = tensors(data["eval"], device)
    run_id = "object-laptop-" + uuid.uuid4().hex[:12]
    out = (args.out or args.project.resolve() / "laptop_runs" / run_id).resolve()
    out.mkdir(parents=True, exist_ok=False)
    for split in ["train", "eval"]:
        json_write(out / f"{split}.tasks.json", data[split])
    dataset = {f"{split}Sha256": file_digest(out / f"{split}.tasks.json") for split in ["train", "eval"]}
    manifest = {"runId": run_id, "modelConfig": config, "parameterCount": count,
                "modelSourceSha256": source_sha, "runnerSha256": file_digest(Path(__file__)),
                "helperSha256": file_digest(Path(__file__).with_name("laptop_train.py")),
                "dataset": dataset, "dataSeed": DATA_SEED, "torchVersion": str(torch.__version__),
                "settings": {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()},
                "scope": "Supervised bounded-definition prediction. Same 15 functions in both splits; "
                         "unordered x triples are disjoint. Not unseen-function or composition generalization. "
                         "No teacher or Brain-to-trainer feedback. Candidate AST renderer is fixed code.",
                "optimizer": "fresh AdamW, FP32; weights-only snapshots, not exact resume",
                "budget": "max-seconds bounds cumulative update compute, excluding evaluation and I/O"}
    json_write(out / "manifest.json", manifest)
    torch.save({"model_state_dict": model.state_dict(), "model_config": config}, out / "initial.pt")
    before, _ = evaluate(model, eval_x, eval_y)
    json_write(out / "before.json", before)
    print(f"Before: exact definition accuracy={before['exactDefinitionAccuracy']:.4f}, "
          f"conditional loss={before['conditionalCoefficientLoss']:.4f}", flush=True)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    generator = torch.Generator().manual_seed(args.seed + 1)
    seconds, loss_sum, finished, round_number = 0.0, 0.0, 0, 0

    def emit(step):
        nonlocal round_number
        round_number += 1
        checkpoint = out / f"checkpoint-{round_number:03}.pt"
        torch.save({"model_state_dict": model.state_dict(), "model_config": config,
                    "steps": step}, checkpoint)
        evaluation, eval_predictions = evaluate(model, eval_x, eval_y)
        training, train_predictions = evaluate(model, train_x, train_y)
        candidates = propose(data["train"], train_predictions, round_number)
        known = {r["taskId"]: r["coefficients"] for r in data["train"]}
        exact = sum(c["definition"] == definition(*known[c["reference"]["taskId"]])
                    for c in candidates)
        json_write(out / f"evaluation-{round_number:03}.json",
                   {"eval": evaluation, "train": training,
                    "proposedDefinitions": len(candidates), "correctTrainingProposals": exact})
        probes = []
        for split, predicted in [("train", train_predictions), ("eval", eval_predictions)]:
            # Three fixed tasks, not best/worst-case selection.
            for index in [0, len(predicted) // 2, len(predicted) - 1]:
                r = data[split][index]
                probes.append({"input": f"pairs={r['pairs']}; predict (a,b) for f(x)=a*x+b",
                               "target": str(r["coefficients"]), "prediction": str(predicted[index]),
                               "split": split})
        measurements = {"steps": step, "trainLoss": loss_sum / step,
                        "trainSeconds": seconds, "evalAccuracy": evaluation["exactDefinitionAccuracy"]}
        if device.type == "cuda":
            measurements["peakVramMb"] = torch.cuda.max_memory_allocated() / (1024**2)
        record = {"schemaVersion": 1, "kind": "training", "runId": run_id,
                  "round": round_number,
                  "recordedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                  "student": {"model": "parameter-golf-affine-coefficients-v1", "parameterCount": count,
                              "checkpointSha256": file_digest(checkpoint)}, "dataset": dataset,
                  "config": {"mode": "teacher_free", "device": str(device), "seed": args.seed},
                  "measurements": measurements, "predictions": probes, "candidates": candidates}
        json_write(out / f"round-{round_number:03}.json", record)
        print(f"Saved round {round_number}: held-out exact accuracy={evaluation['exactDefinitionAccuracy']:.4f}; "
              f"training proposals correct={exact}/15; cumulative update time={seconds:.1f}s", flush=True)

    for step in range(1, args.steps + 1):
        if finished and args.max_seconds and seconds >= args.max_seconds:
            print("Update compute time cap reached; saving completed updates.", flush=True)
            break
        if device.type == "cuda":
            torch.cuda.synchronize()
        started = time.perf_counter()
        indices = torch.randint(len(train_x), (args.batch_size,), generator=generator).to(device)
        optimizer.zero_grad(set_to_none=True)
        value = loss(model, train_x[indices], train_y[indices])
        if not torch.isfinite(value):
            raise ValueError("Nonfinite training loss")
        value.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0, error_if_nonfinite=True)
        optimizer.step()
        if device.type == "cuda":
            torch.cuda.synchronize()
        seconds += time.perf_counter() - started
        loss_sum += value.item()
        finished = step
        if step == 1 or step % 50 == 0:
            print(f"step {step}/{args.steps}: coefficient loss={value.item():.4f}", flush=True)
        if step % args.round_every == 0:
            emit(step)
    if finished % args.round_every:
        emit(finished)
    print(f"DONE. Output directory: {out}", flush=True)
    return out


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--project", type=Path, required=True)
    p.add_argument("--inspect", action="store_true")
    p.add_argument("--device", choices=["cpu", "cuda"], default="cuda")
    p.add_argument("--out", type=Path)
    p.add_argument("--steps", type=int, default=600)
    p.add_argument("--round-every", type=int, default=300)
    p.add_argument("--batch-size", type=int, default=64)
    p.add_argument("--lr", type=float, default=0.001)
    p.add_argument("--seed", type=int, default=1337)
    p.add_argument("--max-seconds", type=float, default=60)
    return p


if __name__ == "__main__":
    try:
        run(parser().parse_args())
    except Exception as exc:
        print(f"STOPPED: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
