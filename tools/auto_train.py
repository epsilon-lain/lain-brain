"""Bounded local loop: student -> independent small GPT review -> Brain -> replay.

Requires the running Obsidian TrainingLabSync service in the supplied test vault.
No providers/downloads. Never writes the plugin's history file directly.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from fractions import Fraction
import json
import math
import os
from pathlib import Path
import sys
import time
import uuid

import object_train as task
from laptop_train import file_digest, json_write, load_checkpoint, load_gpt

QUEUE = "Lain Brain Training Queue"
RESPONSE_LIMIT = 2 * 1024 * 1024


def atomic_json(path, value):
    if path.exists():
        raise ValueError(f"Output already exists: {path}")
    temporary = path.with_name(path.name + ".pending")
    json_write(temporary, value)
    temporary.replace(path)


def exchange(vault, request_id, timeout, record=None):
    queue = vault / QUEUE
    queue.mkdir(exist_ok=True)
    request = {"schemaVersion": 1, "kind": "lain-brain-training-request", "requestId": request_id,
               "operation": "import" if record else "probe"}
    if record:
        request["roundJson"] = json.dumps(record, ensure_ascii=False, allow_nan=False)
    atomic_json(queue / f"request-{request_id}.json", request)
    reply = queue / f"response-{request_id}.json"
    started, last_message = time.monotonic(), -5.0
    while not reply.exists():
        elapsed = time.monotonic() - started
        if elapsed >= timeout:
            raise TimeoutError("Brain did not respond. Open the test vault and reload the updated Lain Brain plugin. "
                               "Training is paused/stopped; saved outputs are preserved.")
        if elapsed - last_message >= 5:
            print("Waiting for Brain. Keep the test vault open; on first install reload Lain Brain.", flush=True)
            last_message = elapsed
        time.sleep(0.25)
    if reply.stat().st_size > RESPONSE_LIMIT:
        raise ValueError("Brain response exceeds size limit")
    response = json.loads(reply.read_text(encoding="utf-8"))
    if (response.get("schemaVersion"), response.get("kind"), response.get("requestId")) != (
            1, "lain-brain-training-response", request_id):
        raise ValueError("Brain response identity mismatch")
    if response.get("status") != "ok":
        raise ValueError(f"Brain rejected the request: {response.get('message', 'unknown error')}")
    if record is None:
        if response.get("protocol") != "training-sync-v1":
            raise ValueError("Brain sync protocol mismatch")
    else:
        if (response.get("runId"), response.get("round"), response.get("checkpointSha256"), response.get("dataset")) != (
                record["runId"], record["round"], record["student"]["checkpointSha256"], record["dataset"]):
            raise ValueError("Brain feedback does not match the exact submitted round")
    return response


def affine(expr, library, depth=0):
    if depth > 24:
        raise ValueError("Library definition depth exceeded")
    op = expr["op"]
    child = lambda e: affine(e, library, depth + 1)
    if op == "x":
        return Fraction(1), Fraction(0)
    if op == "const":
        return Fraction(0), Fraction(expr["value"])
    if op == "scale":
        factor = Fraction(expr["factor"])
        return tuple(factor * v for v in child(expr["body"]))
    if op == "add":
        return tuple(l + r for l, r in zip(child(expr["left"]), child(expr["right"])))
    if op == "call":
        outer = child(library[expr["objectId"]]["definition"])
        inner = child(expr["argument"])
        return outer[0] * inner[0], outer[0] * inner[1] + outer[1]
    raise ValueError("Unsupported library operation")


def feedback(response, record, train):
    library = response["library"]
    if (library.get("schemaVersion"), library.get("kind"), library.get("sourceKind"), library.get("domain"),
        library.get("runId"), library.get("throughRound"), library.get("dataset")) != (
            1, "lain-brain-training-objects", "training", "rational-affine-v1",
            record["runId"], record["round"], record["dataset"]):
        raise ValueError("Brain library boundary/scope mismatch")
    verdicts = response["verifications"]
    ids = [c["id"] for c in record["candidates"]]
    if len(verdicts) != len(ids) or {v["candidateId"] for v in verdicts} != set(ids):
        raise ValueError("Incomplete or duplicated Brain candidate feedback")
    accepted = {v["candidateId"] for v in verdicts if v["acceptance"] == "accepted"}
    objects = {o["id"]: o for o in library["objects"]}
    if len(objects) != len(library["objects"]) or not accepted.issubset(objects):
        raise ValueError("Accepted objects missing or duplicated in library")
    known = {r["taskId"]: r["coefficients"] for r in train}
    by_task = {}
    for obj in objects.values():
        ref = obj["reference"]
        if obj["runId"] != record["runId"] or not 1 <= obj["round"] <= record["round"] or ref["split"] != "train":
            raise ValueError("Non-training or out-of-boundary library object")
        a, b = affine(obj["definition"], objects)
        if (str(a), str(b)) != (obj["canonical"]["slope"], obj["canonical"]["intercept"]):
            raise ValueError("Library canonical form disagrees with executable definition")
        if ref["taskId"] not in known or (a, b) != tuple(known[ref["taskId"]]):
            raise ValueError("Library object disagrees with frozen training task")
        if not obj.get("teacher") or obj["teacher"]["decision"] != "approve":
            raise ValueError("Object missing the model review required by this loop")
        by_task[ref["taskId"]] = obj
    rejected_tasks = {c["reference"]["taskId"] for c in record["candidates"] if c["id"] not in accepted}
    priority = {task_id: 4 if task_id in rejected_tasks else 1 for task_id in known}
    derived, executions = [], 0
    for r in train:
        obj = by_task.get(r["taskId"])
        if not obj:
            continue
        a, b = affine(obj["definition"], objects)
        pairs = []
        for x, _ in r["pairs"]:
            value = a * x + b
            if value.denominator != 1:
                raise ValueError("Object output outside integer task domain")
            pairs.append([x, int(value)])
            executions += 1
        derived.append({"taskId": r["taskId"], "pairs": pairs, "coefficients": [int(a), int(b)]})
    return priority, derived, {"acceptedThisRound": len(accepted), "rejectedThisRound": len(ids) - len(accepted),
                               "libraryObjects": len(objects), "uniqueFunctions": len(by_task),
                               "objectExecutions": executions, "derivedTrainingContexts": len(derived)}


def review(candidates, train, reviewer, device, reviewer_sha):
    import torch
    first = {}
    for r in train:
        first.setdefault(r["taskId"], r)
    records = [first[c["reference"]["taskId"]] for c in candidates]
    # Only prompts enter the model; no reference coefficients or evaluation data.
    inputs = torch.tensor([task.prompt(r) for r in records], device=device)
    with torch.no_grad():
        predicted = task.predict(reviewer, inputs).cpu().tolist()
    for candidate, (a, b) in zip(candidates, predicted):
        proposal = affine(candidate["definition"], {})
        agrees = proposal == (a, b)
        candidate["teacher"] = {
            "model": f"local-affine-gpt-{reviewer_sha}",
            "decision": "approve" if agrees else "uncertain",
            "rationale": f"Independent frozen small GPT predicts a={a}, b={b} from the three training pairs. "
                         f"Proposal {'agrees' if agrees else 'disagrees'}. Model opinion only; exact Brain verification is required."}
    return predicted


def model_config():
    return dict(vocab_size=task.VOCAB_SIZE, model_dim=64, num_layers=2,
                num_heads=4, num_kv_heads=2, mlp_mult=2, tie_embeddings=True,
                tied_embed_init_std=0.005, logit_softcap=30.0, rope_base=10000.0, qk_gain_init=1.5)


def restore(GPT, checkpoint, config):
    import torch
    if checkpoint.stat().st_size > 4 * 1024 * 1024:
        raise ValueError("Affine checkpoint exceeds expected size")
    state, saved = load_checkpoint(checkpoint)
    if saved != config or not all(torch.isfinite(v).all() for v in state.values()):
        raise ValueError("Affine checkpoint config/values mismatch")
    model = GPT(**config)
    model.load_state_dict(state, strict=True)
    return model


def reviewer_checkpoint(args, source_sha, dataset):
    models = args.project / "training_models"
    models.mkdir(exist_ok=True)
    key = {"sourceSha256": source_sha, "dataset": dataset, "seed": args.reviewer_seed,
           "requestedSteps": args.reviewer_steps, "runnerSha256": file_digest(Path(task.__file__))}
    for ready in sorted(models.glob("reviewer-*/ready.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        info = json.loads(ready.read_text())
        if info["key"] != key:
            continue
        checkpoint = ready.parent / info["checkpoint"]
        if file_digest(checkpoint) != info["checkpointSha256"]:
            raise ValueError("Cached reviewer checkpoint hash mismatch")
        print("Reusing the previously trained local alignment GPT.", flush=True)
        return checkpoint
    print("Training an independent small alignment GPT on training data; no paid API.", flush=True)
    settings = task.parser().parse_args(["--project", str(args.project), "--device", args.device])
    settings.steps = settings.round_every = args.reviewer_steps
    settings.seed = args.reviewer_seed
    settings.max_seconds = args.max_seconds
    settings.out = models / ("reviewer-" + uuid.uuid4().hex[:12])
    out = task.run(settings)
    checkpoint = sorted(out.glob("checkpoint-*.pt"))[-1]
    manifest = json.loads((out / "manifest.json").read_text())
    if manifest["dataset"] != dataset or manifest["modelSourceSha256"] != source_sha:
        raise ValueError("Reviewer data/source mismatch")
    json_write(out / "ready.json", {"key": key, "checkpoint": checkpoint.name,
                                   "checkpointSha256": file_digest(checkpoint)})
    return checkpoint


def validate(args):
    if args.random and args.student_checkpoint:
        raise ValueError("Choose either a checkpoint or random initialization")
    if not 1 <= args.rounds <= 8 or not 1 <= args.steps_per_round <= 1000 or not 1 <= args.reviewer_steps <= 2000:
        raise ValueError("Invalid bounded round/step budget")
    if not 0 <= args.seed < 2**31 or not 0 <= args.reviewer_seed < 2**31 or args.seed == args.reviewer_seed:
        raise ValueError("Student/reviewer seeds must be valid and different")
    if not 1 <= args.batch_size <= 128 or not math.isfinite(args.lr) or not 0 < args.lr <= 0.01:
        raise ValueError("Invalid learning settings")
    if not math.isfinite(args.max_seconds) or not 0 < args.max_seconds <= 600 or not 1 <= args.brain_timeout <= 600:
        raise ValueError("Invalid finite time budget")
    args.project, args.vault = args.project.resolve(), args.vault.resolve()
    if not (args.vault / ".obsidian").is_dir():
        raise ValueError("Test vault .obsidian directory is missing")


def _run(args):
    import torch
    torch.set_num_threads(1)
    GPT, source_sha = load_gpt(args.project / "train_gpt.py")
    data = task.make_data()
    config = model_config()
    torch.manual_seed(args.seed)
    initial = args.student_checkpoint
    if not initial and not args.random:
        options = list((args.project / "laptop_runs").glob("object-laptop-*/checkpoint-*.pt"))
        options += list((args.project / "laptop_runs").glob("auto-object-*/checkpoint-*.pt"))
        initial = max(options, key=lambda p: p.stat().st_mtime) if options else None
    model = restore(GPT, initial, config) if initial else GPT(**config)
    print(f"Student: {initial if initial else 'new random affine GPT'}; optimizer starts fresh.", flush=True)
    if args.inspect:
        print("Preflight OK. No files written, no GPU training, no Brain request.", flush=True)
        return None
    if args.device == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA unavailable; select --device cpu explicitly")
    run_id = "auto-object-" + uuid.uuid4().hex[:12]
    out = args.project / "laptop_runs" / run_id
    out.mkdir(parents=True, exist_ok=False)
    for split in ["train", "eval"]:
        json_write(out / f"{split}.tasks.json", data[split])
    dataset = {f"{split}Sha256": file_digest(out / f"{split}.tasks.json") for split in ["train", "eval"]}
    # Handshake before training the reviewer or updating student weights.
    exchange(args.vault, run_id + "-probe", args.brain_timeout)
    print("Brain connected. Automatic import and feedback are ready.", flush=True)
    checkpoint = reviewer_checkpoint(args, source_sha, dataset)
    reviewer_sha = file_digest(checkpoint)
    device = torch.device(args.device)
    reviewer = restore(GPT, checkpoint, config).to(device).eval()
    reviewer.requires_grad_(False)
    model.to(device)
    if device.type == "cuda":
        torch.cuda.reset_peak_memory_stats()
    train_x, train_y = task.tensors(data["train"], device)
    eval_x, eval_y = task.tensors(data["eval"], device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    generator = torch.Generator().manual_seed(args.seed + 1)
    manifest = {"runId": run_id, "modelConfig": config, "modelSourceSha256": source_sha,
                "runnerSha256": file_digest(Path(__file__)), "helperSha256": file_digest(Path(task.__file__)),
                "dataset": dataset, "reviewerCheckpointSha256": reviewer_sha,
                "reviewerCheckpoint": str(checkpoint), "initialCheckpoint": str(initial) if initial else None,
                "initialCheckpointSha256": file_digest(initial) if initial else None,
                "torchVersion": str(torch.__version__), "optimizer": "fresh AdamW; weights-only resume",
                "settings": {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()},
                "scope": "Supervised affine task. Independent model agreement + exact Brain gate; "
                         "training-only priority replay and executable-object rehearsal. No learned composition, "
                         "unseen-function test, live language teacher or autonomous self-improvement claim."}
    json_write(out / "manifest.json", manifest)
    torch.save({"model_state_dict": model.state_dict(), "model_config": config}, out / "initial.pt")
    before, _ = task.evaluate(model, eval_x, eval_y)
    json_write(out / "before.json", before)
    print(f"Before: held-out exact accuracy={before['exactDefinitionAccuracy']:.4f}", flush=True)
    weights = torch.ones(len(train_x), device="cpu")
    derived_x = derived_y = None
    seconds, total_loss, finished, completed, replay_used = 0.0, 0.0, 0, 0, 0
    for n in range(1, args.rounds + 1):
        if (out / "STOP").exists() or seconds >= args.max_seconds:
            break
        this_round_steps, start_replay = 0, replay_used
        for _ in range(args.steps_per_round):
            if (out / "STOP").exists() or seconds >= args.max_seconds:
                break
            if device.type == "cuda":
                torch.cuda.synchronize()
            started = time.perf_counter()
            indices = torch.multinomial(weights, args.batch_size, replacement=True, generator=generator).to(device)
            x, y = train_x[indices].clone(), train_y[indices].clone()
            if derived_x is not None and len(derived_x):
                count = max(1, args.batch_size // 4)
                chosen = torch.randint(len(derived_x), (count,), generator=generator).to(device)
                x[:count], y[:count] = derived_x[chosen], derived_y[chosen]
                replay_used += count
            optimizer.zero_grad(set_to_none=True)
            value = task.loss(model, x, y)
            if not torch.isfinite(value):
                raise ValueError("Nonfinite student loss")
            value.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0, error_if_nonfinite=True)
            optimizer.step()
            if device.type == "cuda":
                torch.cuda.synchronize()
            seconds += time.perf_counter() - started
            total_loss += value.item()
            finished += 1
            this_round_steps += 1
        if not this_round_steps:
            break
        student_checkpoint = out / f"checkpoint-{n:03}.pt"
        torch.save({"model_state_dict": model.state_dict(), "model_config": config, "steps": finished}, student_checkpoint)
        evaluation, eval_predictions = task.evaluate(model, eval_x, eval_y)
        training, train_predictions = task.evaluate(model, train_x, train_y)
        candidates = task.propose(data["train"], train_predictions, n)
        reviewer_predictions = review(candidates, data["train"], reviewer, device, reviewer_sha)
        json_write(out / f"evaluation-{n:03}.json", {"eval": evaluation, "train": training,
                  "reviewerPredictionsOnFixedTrainingContexts": reviewer_predictions,
                  "objectReplayExamplesUsedThisRound": replay_used - start_replay})
        measurements = {"steps": finished, "trainLoss": total_loss / finished, "trainSeconds": seconds,
                        "evalAccuracy": evaluation["exactDefinitionAccuracy"]}
        if device.type == "cuda":
            measurements["peakVramMb"] = torch.cuda.max_memory_allocated() / (1024**2)
        probes = []
        for split, predicted in [("train", train_predictions), ("eval", eval_predictions)]:
            r = data[split][0]
            probes.append({"input": f"pairs={r['pairs']}; predict (a,b)", "target": str(r["coefficients"]),
                           "prediction": str(predicted[0]), "split": split})
        record = {"schemaVersion": 1, "kind": "training", "runId": run_id, "round": n,
                  "recordedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                  "student": {"model": "parameter-golf-affine-auto-v1", "parameterCount": sum(p.numel() for p in model.parameters()),
                              "checkpointSha256": file_digest(student_checkpoint)},
                  "dataset": dataset, "config": {"mode": "brain_objects", "device": str(device), "seed": args.seed},
                  "measurements": measurements, "predictions": probes, "candidates": candidates}
        json_write(out / f"round-{n:03}.json", record)
        response = exchange(args.vault, run_id + f"-r{n:03}", args.brain_timeout, record)
        json_write(out / f"brain-feedback-{n:03}.json", response)
        priority, derived, stats = feedback(response, record, data["train"])
        json_write(out / f"replay-{n:03}.tasks.json", derived)
        json_write(out / f"feedback-summary-{n:03}.json", {**stats, "trainingTaskPriority": priority,
                  "objectReplayExamplesUsedThisRound": replay_used - start_replay,
                  "libraryBoundaryUsedForThisRound": n - 1 if n > 1 else None})
        weights = torch.tensor([priority[r["taskId"]] for r in data["train"]], dtype=torch.float32)
        if derived:
            derived_x, derived_y = task.tensors(derived, device)
        completed = n
        print(f"Round {n}/{args.rounds}: Brain accepted {stats['acceptedThisRound']}/15; "
              f"held-out accuracy={evaluation['exactDefinitionAccuracy']:.4f}; "
              f"object-derived examples used={replay_used - start_replay}. Feedback saved automatically.", flush=True)
    if file_digest(checkpoint) != reviewer_sha:
        raise ValueError("Frozen reviewer checkpoint changed during the run")
    json_write(out / "done.json", {"completedRounds": completed, "studentUpdates": finished,
               "objectReplayExamplesUsed": replay_used, "status": "bounded_run_finished"})
    print(f"DONE. Automatic loop stopped. Outputs: {out}", flush=True)
    return out


def run(args):
    validate(args)
    if args.inspect:
        return _run(args)
    # The configured runtime is Linux/WSL. Kernel locks release on exit/Ctrl+C;
    # an old lock filename never blocks the next session after a process dies.
    import fcntl
    folder = args.project / "laptop_runs"
    folder.mkdir(exist_ok=True)
    with (folder / "auto-training.lock").open("a+") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("An automatic training session is already running for this project") from None
        lock.seek(0)
        lock.truncate()
        lock.write(str(os.getpid()))
        lock.flush()
        return _run(args)


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--project", type=Path, required=True)
    p.add_argument("--vault", type=Path, required=True)
    p.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
    p.add_argument("--student-checkpoint", type=Path)
    p.add_argument("--random", action="store_true")
    p.add_argument("--inspect", action="store_true")
    p.add_argument("--rounds", type=int, default=2)
    p.add_argument("--steps-per-round", type=int, default=300)
    p.add_argument("--reviewer-steps", type=int, default=600)
    p.add_argument("--reviewer-seed", type=int, default=7331)
    p.add_argument("--seed", type=int, default=1337)
    p.add_argument("--batch-size", type=int, default=64)
    p.add_argument("--lr", type=float, default=0.001)
    p.add_argument("--max-seconds", type=float, default=60)
    p.add_argument("--brain-timeout", type=float, default=180)
    return p


if __name__ == "__main__":
    try:
        run(parser().parse_args())
    except Exception as exc:
        print(f"STOPPED: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
