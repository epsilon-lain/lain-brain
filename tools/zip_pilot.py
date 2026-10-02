"""Prepare, collect Apertus critiques, or run a short zip interface pilot.

No automatic GPU allocation, model download, endless loop or Obsidian mutation.
Collection and training are separate. Training/evaluation never call a teacher.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict
import hashlib
from importlib.metadata import version
import json
from pathlib import Path
import platform
import sys
import time

from zip_pilot_protocol import PROTOCOL, Teacher, canonical, fingerprint, prompt, tasks, transition, verify, write_json


def file_digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def source_hashes():
    root = Path(__file__).parent
    return {name: file_digest(root / name) for name in
            ["zip_pilot.py", "zip_pilot_protocol.py", "zip_pilot_model.py", "research_reward_probe.py"]}


def new_run(path):
    path = Path(path)
    path.mkdir(parents=True, exist_ok=False)
    return path


def prepare(args):
    out = new_run(args.out)
    sets = {split: [asdict(t) | t.public() for t in tasks(split)] for split in ["train", "dev", "final"]}
    write_json(out / "plan.json", dict(protocol=PROTOCOL, datasets=sets, sources=source_hashes(),
        trainingUpdates=0, teacherCalls=0, networkRequests=0,
        scope="interface pilot; public development tasks, not a sealed research benchmark",
        next="preflight -> student baseline -> collect only train -> inspect corpus -> train -> separate final evaluation",
        limits=dict(trainObjects=6, baselineStudentCalls=4, teacherCalls=6, studentCallsPerObject=2, teacherOutputTokens=256,
                    studentOutputTokens=128, warmupSteps=4, policyEpisodes=2, stepsPerEpisode=2),
        requires=["usable pretrained Apertus-v1.1-0.5B-Instruct student snapshot", "Apertus endpoint and declared deployment identity",
                  "GPU identity/VRAM inspection before selecting a cloud deployment"],
        noAutomationOf=["cloud allocation", "credential setup", "teacher model deployment", "model download"]))
    print(f"Prepared offline: {out / 'plan.json'}. GPU allocations=0, teacher calls=0, updates=0.")


def preflight(args):
    import torch
    report = dict(python=platform.python_version(), torch=str(torch.__version__),
                  transformers=version("transformers"), cudaAvailable=torch.cuda.is_available(), sources=source_hashes(),
                  teacherCalls=0, trainingUpdates=0, networkRequests=0)
    if torch.cuda.is_available():
        free, total = torch.cuda.mem_get_info()
        report.update(gpu=torch.cuda.get_device_name(0), freeGiB=free/1024**3, totalGiB=total/1024**3,
                      bf16=torch.cuda.is_bf16_supported())
    if args.student_path:
        report["studentPathExists"] = args.student_path.is_dir()
        report["configExists"] = (args.student_path / "config.json").is_file()
    print(json.dumps(report, indent=2))


def load_student(path, device):
    import torch
    from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer
    if not path.is_dir():
        raise ValueError("Need an existing local student snapshot; this runner never downloads models")
    config = AutoConfig.from_pretrained(path, local_files_only=True, trust_remote_code=False)
    if config.model_type not in {"apertus", "qwen2"}:
        raise ValueError("Pilot supports Apertus and Qwen2 only")
    # Reject large family members before allocating weights on CPU or GPU.
    if not (1 <= config.num_hidden_layers <= 32 and 1 <= config.hidden_size <= 1536
            and 1 <= config.intermediate_size <= 8192 and 1 <= config.vocab_size <= 160000):
        raise ValueError("Student configuration exceeds the small-model pilot bounds")
    if device == "cuda":
        if not torch.cuda.is_available():
            raise ValueError("CUDA unavailable")
        free, _ = torch.cuda.mem_get_info()
        if free < 4 * 1024**3:
            raise ValueError("Less than 4 GiB free; stopping before model load (this is not a guarantee that training fits)")
        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float32
        torch.cuda.reset_peak_memory_stats()
    else:
        dtype = torch.float32
        torch.set_num_threads(2)
    hashes = {p.name: file_digest(p) for p in path.iterdir() if p.is_file() and p.suffix in {".json", ".safetensors", ".txt", ".jinja"}}
    if not any(name.endswith(".safetensors") for name in hashes):
        raise ValueError("Only local safetensors student checkpoints are supported")
    # 4.57.6 misdetects local non-Mistral configs saved by >4.57.2 as Mistral.
    # Neither supported architecture is Mistral: preserve the snapshot's regex.
    tokenizer = AutoTokenizer.from_pretrained(path, local_files_only=True, trust_remote_code=False,
                                              fix_mistral_regex=False)
    model = AutoModelForCausalLM.from_pretrained(path, local_files_only=True, trust_remote_code=False,
        use_safetensors=True, dtype=dtype, attn_implementation="sdpa").to(device).eval().requires_grad_(False)
    if sum(p.numel() for p in model.parameters()) > 600_000_000:
        raise ValueError("Pilot supports students up to 600M unique parameters only")
    metadata = dict(studentPath=str(path), snapshotSha256=hashes, architecture=model.config.model_type,
                    studentParameters=sum(p.numel() for p in model.parameters()), dtype=str(dtype),
                    torch=str(torch.__version__), transformers=version("transformers"), device=device, attention="sdpa",
                    tokenizerRegexPolicy="preserve-local-snapshot")
    return model, tokenizer, metadata


def base_generate(model, tokenizer, messages, max_tokens):
    import torch
    text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = tokenizer(text, add_special_tokens=False, return_tensors="pt", return_token_type_ids=False).to(model.device)
    if inputs.input_ids.shape[1] > 1024:
        raise ValueError("Collection prompt exceeds 1024 tokens; no silent truncation")
    with torch.no_grad():
        generated = model.generate(**inputs, do_sample=False, max_new_tokens=max_tokens, use_cache=True,
                                   pad_token_id=tokenizer.eos_token_id)
    ids = generated[0, inputs.input_ids.shape[1]:].tolist()
    return dict(raw=tokenizer.decode(ids, skip_special_tokens=True), generatedTokens=len(ids),
                promptTokens=inputs.input_ids.shape[1], generatedIds=ids)


def baseline(args):
    out = new_run(args.out)
    base, tokenizer, metadata = load_student(args.student_path, args.device)
    records = []
    for language, question in [("zh", "请用两句话解释图书馆是什么。"),
                               ("en", "Explain in two short sentences what a library is.")]:
        records.append(dict(kind="language-"+language, output=base_generate(
            base, tokenizer, [{"role": "user", "content": question}], args.max_new_tokens)))
    for task in [tasks("train")[0], tasks("train")[3]]:
        output = base_generate(base, tokenizer, prompt(task), args.max_new_tokens)
        records.append(dict(kind="object-format", task=asdict(task), output=output,
                            verification=verify(task, output["raw"])))
    ready = any("claim" in r["verification"] for r in records if r["kind"] == "object-format")
    result = dict(metadata=metadata, protocol=PROTOCOL, sources=source_hashes(), records=records,
                  teacherCalls=0, trainingUpdates=0, formatReady=ready,
                  languageAbilityAutomaticallyCertified=False,
                  scope="development baseline; inspect raw language outputs; format gate is not a competence verdict")
    write_json(out / "baseline.json", result)
    print(f"Baseline: {out / 'baseline.json'}; teacher calls=0, updates=0; JSON format seen={ready}")
    for item in records:
        print(item["kind"] + ": " + json.dumps(item["output"]["raw"], ensure_ascii=False), flush=True)


def collect(args):
    baseline_report = json.loads(args.baseline.read_text())
    if baseline_report.get("protocol") != PROTOCOL or not baseline_report.get("formatReady"):
        raise ValueError("Student format baseline not ready; inspect raw outputs before spending teacher calls")
    out = new_run(args.out)
    started = time.monotonic()
    model, tokenizer, metadata = load_student(args.student_path, args.device)
    if baseline_report["metadata"]["snapshotSha256"] != metadata["snapshotSha256"]:
        raise ValueError("Student differs from the inspected baseline snapshot")
    teacher = Teacher(args.teacher_base_url, args.teacher_model, args.teacher_revision,
                      args.teacher_cache, key_env=args.teacher_key_env, max_calls=args.max_teacher_calls)
    write_json(out / "manifest.json", dict(metadata, protocol=PROTOCOL, sources=source_hashes(),
              teacherModel=args.teacher_model, teacherRevisionDeclared=args.teacher_revision,
              teacherRevisionVerified=False, teacherMaxCalls=args.max_teacher_calls,
              baselineSha256=file_digest(args.baseline), trainingUpdates=0))
    records, notes, examples, used = [], [], [], set()
    for task in tasks("train"):
        if time.monotonic() - started > args.max_seconds:
            raise RuntimeError("Collection wall-clock budget reached; partial records retained")
        initial = base_generate(model, tokenizer, prompt(task), args.max_new_tokens)
        check = verify(task, initial["raw"])
        write_json(out / f"{task.key}-initial.json", dict(task=asdict(task), output=initial, verification=check))
        review = teacher.review(task, initial["raw"], check)
        # Malformed critique provides no student hint. It is still counted/cached.
        feedback = dict(draft=initial["raw"], programFeedback=dict(accepted=check["accepted"], reason=check["reason"]))
        if review["critique"]:
            feedback["teacherCritique"] = review["critique"]
        revised = base_generate(model, tokenizer, prompt(task, feedback), args.max_new_tokens)
        revised_check = verify(task, revised["raw"])
        record = dict(task=asdict(task), initial=initial, initialCheck=check, teacher=review,
                      revision=revised, revisionCheck=revised_check)
        records.append(record)
        write_json(out / f"{task.key}-reviewed.json", record)
        candidates = [(check, initial, "student-independent"), (revised_check, revised, "student-after-feedback")]
        checked, chosen, origin = max(candidates, key=lambda item: item[0]["score"])
        if checked["accepted"] and checked["score"] > 0:
            note = dict(task=asdict(task), raw=chosen["raw"], verification=checked, origin=origin,
                        text=canonical(dict(object=task.public(), studentClaim=checked["claim"],
                                            certificate=checked["certificate"], proseCertified=False)))
            identity = fingerprint(dict(task=asdict(task), claim=checked["claim"]))
            if identity not in used:
                used.add(identity)
                notes.append(note)
                examples.append(dict(task=asdict(task), answer=chosen["raw"], origin=origin))
        print(f"Collected {task.key}: initial={check['score']:.1f}, revised={revised_check['score']:.1f}; admitted={len(notes)}", flush=True)
    corpus = dict(protocol=PROTOCOL, metadata=metadata, notes=notes, examples=examples,
                  records=records, teacherNetworkCalls=teacher.calls, teacherCacheHits=sum(r["teacher"]["cacheHit"] for r in records),
                  trainingUpdates=0, studentCalls=len(records)*2, maxNewTokens=args.max_new_tokens,
                  proseCertified=False, academicNoveltyClaim=False)
    write_json(out / "corpus.json", corpus)
    print(f"DONE: {out / 'corpus.json'}; accepted notes={len(notes)}, teacher network calls={teacher.calls}; updates=0")
    if not notes:
        print("No certified notes. Inspect language/format/task capability before any training; do not relax verifier.")


def read_corpus(path):
    from zip_pilot_protocol import Task
    corpus = json.loads(path.read_text())
    if corpus.get("protocol") != PROTOCOL or not 1 <= len(corpus.get("notes", [])) <= 12:
        raise ValueError("Need a nonempty bounded corpus from collect")
    allowed = {t.key: t for t in tasks("train")}
    notes, examples = [], []
    for note in corpus["notes"]:
        task = Task(**note["task"])
        if allowed.get(task.key) != task:
            raise ValueError("Only registered train objects may create notes")
        checked = verify(task, note["raw"])
        if not checked["accepted"] or checked["score"] <= 0:
            raise ValueError("Corpus claim failed independent re-verification")
        # Rebuild all text from the certified claim, never trust a stored text field.
        text = canonical(dict(object=dict(family=task.family, scale=task.scale), studentClaim=checked["claim"],
                              certificate=checked["certificate"], proseCertified=False))
        notes.append(text)
        examples.append((task, note["raw"]))
    return corpus, notes, examples


def evaluate(model, split, max_tokens, out, tag):
    from zip_pilot_model import generate
    records = []
    for task in tasks(split):
        messages = prompt(task, notes=model.notes if model.mode == "text" else None)
        output = generate(model, messages, max_new_tokens=max_tokens, sample=False)
        records.append(dict(task=asdict(task), output=output, verification=verify(task, output["raw"])))
    result = dict(split=split, tag=tag, teacherCalls=0, parameterUpdates=0, records=records,
                  meanCoverage=sum(r["verification"]["score"] for r in records)/len(records),
                  truncated=sum(r["output"]["truncated"] for r in records))
    write_json(out / (tag + ".json"), result)
    return result


def pilot_updates(model, examples, *, warmup_steps, pg_episodes, max_tokens, lr, max_seconds, log):
    """One on-policy update per two-action trajectory, no teacher or live archive."""
    import torch
    from zip_pilot_model import generate, sft_loss, token_logps
    optimizer = torch.optim.AdamW(model.parameters_to_train(), lr=lr, weight_decay=0)
    started = time.monotonic()
    updates = 0
    baseline = 0.0  # trajectory-independent past-return baseline, not a learned critic
    for step in range(warmup_steps):
        if time.monotonic() - started > max_seconds:
            raise RuntimeError("Training update time budget reached")
        task, answer = examples[step % len(examples)]
        optimizer.zero_grad(set_to_none=True)
        loss = sft_loss(model, prompt(task, notes=model.notes if model.mode == "text" else None), answer)
        loss.backward()
        norm = torch.nn.utils.clip_grad_norm_(model.parameters_to_train(), 1.0, error_if_nonfinite=True)
        optimizer.step()
        updates += 1
        record = dict(stage="interface-warmup-SFT", update=updates, task=task.key, loss=float(loss.detach()), gradNorm=float(norm))
        log(record)
    for episode in range(pg_episodes):
        if time.monotonic() - started > max_seconds:
            raise RuntimeError("Training update time budget reached")
        task, _ = examples[episode % len(examples)]
        trajectory, coverage = [], 0.0
        feedback = None
        model.eval()
        # Both actions are sampled before any parameter update.
        for action in range(2):
            messages = prompt(task, feedback, model.notes if model.mode == "text" else None)
            generated = generate(model, messages, max_new_tokens=max_tokens, sample=True)
            result = transition(task, generated["raw"], coverage, generated["generatedTokens"])
            coverage = result["after"]
            trajectory.append(dict(action=action, output=generated, feedback=result))
            feedback = dict(draft=generated["raw"], programFeedback=dict(
                accepted=result["verification"]["accepted"], reason=result["verification"]["reason"]))
        returns = [sum(t["feedback"]["reward"] for t in trajectory[i:]) for i in range(2)]
        optimizer.zero_grad(set_to_none=True)
        loss_number = 0.0
        for action, total in zip(trajectory, returns):
            output = action["output"]
            logps = token_logps(model, output["promptIds"], output["generatedIds"])
            # Sum is the probability of the whole sampled action; do not silently
            # normalize by answer length and change the policy objective.
            loss = -(total - baseline) * logps.sum()
            loss.backward()
            loss_number += float(loss.detach())
        norm = torch.nn.utils.clip_grad_norm_(model.parameters_to_train(), 1.0, error_if_nonfinite=True)
        optimizer.step()
        updates += 1
        log(dict(stage="on-policy-progress", episode=episode, update=updates, task=task.key,
                 trajectory=trajectory, returns=returns, pastReturnBaseline=baseline,
                 loss=loss_number, gradNorm=float(norm), klCoefficient=0.0,
                 teacherCalls=0, archiveChanged=False))
        baseline = 0.9 * baseline + 0.1 * returns[0]
    return updates


def train(args):
    import torch
    from safetensors.torch import save_file
    from zip_pilot_model import ZipPilot, state_digest
    corpus, notes, examples = read_corpus(args.corpus)
    out = new_run(args.out)
    torch.manual_seed(args.seed)
    base, tokenizer, metadata = load_student(args.student_path, args.device)
    if corpus.get("metadata", {}).get("snapshotSha256") and corpus["metadata"]["snapshotSha256"] != metadata["snapshotSha256"]:
        raise ValueError("Student snapshot differs from the corpus collection student")
    base_hash = state_digest(base)
    model = ZipPilot(base, tokenizer, notes, rank=args.rank, mode=args.mode)
    initial = {name: p.detach().cpu().clone() for name, p in model.named_parameters() if p.requires_grad}
    write_json(out / "manifest.json", dict(metadata, protocol=PROTOCOL, sources=source_hashes(),
        corpusSha256=file_digest(args.corpus), archiveFingerprint=fingerprint(notes), mode=args.mode,
        seed=args.seed, warmupSteps=args.warmup_steps, policyEpisodes=args.pg_episodes,
        maxNewTokens=args.max_new_tokens, learningRate=args.lr, rank=args.rank, slots=2,
        adapterLayer=model.layer_index, addedParameters=sum(p.numel() for p in model.parameters_to_train()),
        maxTrainingPromptTokens=2304, maxTokensPerNote=256,
        teacherCalls=0, learnedController=False, learnedTaskScheduler=False, trainedCritic=False,
        klCoefficient=0.0, scope="short implementation pilot; not evidence of effect/cost/semantic-compression superiority"))
    try:
        before = evaluate(model, "dev", args.max_new_tokens, out, "before-dev")
        def log(record):
            write_json(out / f"update-{record['update']:03d}.json", record)
            print(f"Update {record['update']}: {record['stage']}; loss={record['loss']:.4f}", flush=True)
        updates = pilot_updates(model, examples, warmup_steps=args.warmup_steps, pg_episodes=args.pg_episodes,
                                max_tokens=args.max_new_tokens, lr=args.lr, max_seconds=args.max_seconds, log=log)
        after = evaluate(model, "dev", args.max_new_tokens, out, "after-dev")
        ablations = {}
        if args.mode == "zip":
            for ablation in ["off", "shuffle"]:
                model.ablation = ablation
                ablations[ablation] = evaluate(model, "dev", args.max_new_tokens, out, "after-dev-" + ablation)["meanCoverage"]
            model.ablation = "normal"
        if state_digest(base) != base_hash or any(p.grad is not None for p in base.parameters()):
            raise RuntimeError("Frozen base student changed or received gradients")
        changed = [name for name, p in model.named_parameters() if p.requires_grad and not torch.equal(initial[name], p.detach().cpu())]
        if updates and not changed:
            raise RuntimeError("No added parameters changed")
        save_file(model.adapter_state(), str(out / "adapters.safetensors"))
        write_json(out / "archive.json", dict(notes=notes, fingerprint=fingerprint(notes)))
        result = dict(updates=updates, addedParameterTensorsChanged=changed, baseWeightsUnchanged=True,
                      teacherCalls=0, beforeDev=before["meanCoverage"], afterDev=after["meanCoverage"],
                      devAblations=ablations, zipReadCalls=model.read_calls, seed=args.seed,
                      finalTestOpened=False, academicNoveltyClaim=False, controllerImplemented=False)
        result["adaptersSha256"] = file_digest(out / "adapters.safetensors")
        if args.device == "cuda":
            result.update(peakAllocatedMiB=torch.cuda.max_memory_allocated()/1024**2,
                          peakReservedMiB=torch.cuda.max_memory_reserved()/1024**2)
        write_json(out / "result.json", result)
        print(f"DONE. Real adapter updates={updates}; frozen base unchanged; teacher calls=0. {out / 'result.json'}")
    finally:
        model.close()


def final_eval(args):
    import torch
    from safetensors.torch import load_file
    from zip_pilot_model import ZipPilot
    manifest = json.loads((args.run / "manifest.json").read_text())
    archive = json.loads((args.run / "archive.json").read_text())
    result = json.loads((args.run / "result.json").read_text())
    if file_digest(args.run / "adapters.safetensors") != result["adaptersSha256"]:
        raise ValueError("Adapter checkpoint hash mismatch")
    if fingerprint(archive["notes"]) != manifest["archiveFingerprint"]:
        raise ValueError("Frozen archive mismatch")
    torch.manual_seed(manifest["seed"])
    base, tokenizer, metadata = load_student(args.student_path, args.device)
    if metadata["snapshotSha256"] != manifest["snapshotSha256"]:
        raise ValueError("Student snapshot differs from the training start")
    model = ZipPilot(base, tokenizer, archive["notes"], rank=manifest["rank"], mode=manifest["mode"])
    try:
        expected = set(model.adapter_state())
        stored = load_file(str(args.run / "adapters.safetensors"))
        if set(stored) != expected:
            raise ValueError("Adapter checkpoint schema mismatch")
        model.load_state_dict(stored, strict=False)
        model.requires_grad_(False).eval()
        out = new_run(args.out)
        evaluate(model, "final", args.max_new_tokens, out, "final")
        print(f"Frozen final evaluation: {out / 'final.json'}; teacher calls=0, updates=0")
    finally:
        model.close()


def cli():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)
    a = sub.add_parser("prepare")
    a.add_argument("--out", type=Path, required=True)
    a.set_defaults(function=prepare)
    a = sub.add_parser("preflight")
    a.add_argument("--student-path", type=Path)
    a.set_defaults(function=preflight)
    for command, function in [("baseline", baseline), ("collect", collect), ("train", train), ("final-eval", final_eval)]:
        a = sub.add_parser(command)
        a.add_argument("--student-path", type=Path, required=True)
        a.add_argument("--out", type=Path, required=True)
        a.add_argument("--device", choices=["cpu", "cuda"], default="cuda")
        a.add_argument("--max-new-tokens", type=int, choices=range(1, 129), default=128)
        a.add_argument("--max-seconds", type=int, choices=range(30, 1801), default=600,
                       help="update/collection bound checked between operations; not a hard process timeout")
        if command == "collect":
            a.add_argument("--baseline", type=Path, required=True)
            a.add_argument("--teacher-base-url", required=True, help="API prefix, e.g. https://host/v1")
            a.add_argument("--teacher-model", required=True)
            a.add_argument("--teacher-revision", required=True, help="Declared deployment identity; not automatically verified")
            a.add_argument("--teacher-key-env", default="LAIN_TEACHER_API_KEY")
            a.add_argument("--teacher-cache", required=True, type=Path)
            a.add_argument("--max-teacher-calls", type=int, choices=range(1, 13), default=6)
        elif command == "train":
            a.add_argument("--corpus", type=Path, required=True)
            a.add_argument("--mode", choices=["none", "text", "zip"], default="zip")
            a.add_argument("--seed", type=int, choices=[1337, 2027, 4099], default=1337)
            a.add_argument("--rank", type=int, choices=[8, 16, 32], default=32)
            a.add_argument("--warmup-steps", type=int, choices=range(0, 33), default=4)
            a.add_argument("--pg-episodes", type=int, choices=range(0, 9), default=2)
            a.add_argument("--lr", type=float, default=0.0001)
        elif command == "final-eval":
            a.add_argument("--run", type=Path, required=True)
        a.set_defaults(function=function)
    args = p.parse_args()
    if hasattr(args, "lr") and not 0 < args.lr <= 0.001:
        p.error("lr must be in (0, 0.001]")
    try:
        args.function(args)
    except KeyboardInterrupt:
        print("Stopped. Completed records retained; no automatic restart.", file=sys.stderr)
        raise SystemExit(130)
    except Exception as error:
        # API errors can contain credential-bearing URLs. Only safe generic
        # exception types are printed; HTTP response bodies/headers are not.
        safe = str(error) if isinstance(error, (ValueError, RuntimeError, FileNotFoundError)) else type(error).__name__
        print(f"Pilot stopped: {safe}. Completed records retained; no automatic retry.", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    cli()
