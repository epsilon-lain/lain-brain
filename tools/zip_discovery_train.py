"""Bounded student-owned notes, relation reward and a same-start frozen control.

No downloads, teacher requests, SFT targets, final tasks or local vault writes.
Student actions use a finite relation grammar. This is a mechanism experiment,
not evidence of general intelligence, cost advantage or academic discoveries.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict
import gc
import hashlib
import importlib.util
import json
from pathlib import Path
import random
import time

import torch
from safetensors.torch import load_file, save_file

from zip_discovery_model import DiscoveryPilot, choose, memory_effect, update_policy
from zip_discovery_protocol import (DISCOVERY_PROTOCOL, TAGS, RELATIONS, DiscoveryLedger,
    NoteLibrary, diagnostic_edge_ceiling, exploration_tasks, relation_description, verify_relation)
from zip_discovery_report import episode_summary, export_vault, write_report
from zip_pilot import base_generate, file_digest, load_student, new_run, source_hashes
from zip_pilot_model import state_digest
from zip_pilot_protocol import PROTOCOL, Task, canonical, prompt, tasks, verify, write_json

WARMUP_SHA256 = "b5a53ac146d89163174ea6310ad4862764d3e7f1c751e53aab4142f6a041a72f"


def learned_digest(model):
    digest = hashlib.sha256()
    for name, tensor in sorted(model.learned_state().items()):
        digest.update(name.encode())
        digest.update(str(tuple(tensor.shape)).encode())
        digest.update(tensor.reshape(-1).view(torch.uint8).numpy().tobytes())
    return digest.hexdigest()


def inspect_inputs(args):
    manifest = json.loads((args.start_run / "manifest.json").read_text())
    result = json.loads((args.start_run / "result.json").read_text())
    archive = json.loads((args.notes_run / "archive.json").read_text())
    note_manifest = json.loads((args.notes_run / "manifest.json").read_text())
    if (manifest.get("protocol") != PROTOCOL
            or manifest.get("stage") != "supervised-interface-and-toy-task-preparation"
            or manifest.get("preparationKind") != "experimental-fork-of-saved-balanced-step-no-new-training"
            or manifest.get("candidateStep") != 8 or manifest.get("promotionToDefault") is not False
            or manifest.get("warmupSourceSha256") != WARMUP_SHA256
            or not result.get("baseWeightsUnchanged")
            or archive.get("protocol") != "lain-zip-notes-v1"
            or not archive.get("baseWeightsUnchanged") or not archive.get("warmedAdapterUnchanged")
            or Path(note_manifest["warmupRun"]).resolve() != args.start_run.resolve()):
        raise ValueError("Need the recorded experimental step-8 student and its unchanged note archive")
    actual = file_digest(args.start_run / "interface.safetensors")
    if actual != result["adapterSha256"] or actual != archive["warmupAdapterSha256"] or actual != note_manifest["warmupAdapterSha256"]:
        raise ValueError("Student and note archive refer to different actual adapter weights")
    loader_path = args.start_run.with_suffix(".py")
    if file_digest(loader_path) != WARMUP_SHA256:
        raise ValueError("Saved interface loader source failed its pinned check")
    spec = importlib.util.spec_from_file_location("lain_discovery_interface_loader", loader_path)
    warmup = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(warmup)
    seeds = archive["activeNotes"]+archive["pendingDefinitionNotes"]
    library = NoteLibrary(seeds)
    if len(library.notes) < 2:
        raise ValueError("Need at least two independently certified object notes; no accuracy gate on other tasks")
    protected_paths = [args.start_run / n for n in ["manifest.json", "result.json", "interface.safetensors"]]
    protected_paths += [loader_path, args.notes_run / "manifest.json", args.notes_run / "archive.json"]
    return manifest, result, warmup, library, {p: file_digest(p) for p in protected_paths}


def options(values, describe=lambda value: str(value)):
    return [dict(value=value, description=describe(value)) for value in values]


def fixed_probe(model, library):
    product = next((n for n in library.notes.values() if n["task"]["family"] == "product"), None)
    square = next((n for n in library.notes.values() if n["task"]["family"] == "square"), None)
    if product is None or square is None:
        raise ValueError("The fixed read probe needs one certified product and square note")
    question = canonical(dict(inspection="Check a relation between these two fixed notes",
        sourceObject=product["task"]["key"], targetObject=square["task"]["key"],
        sourceZipId=product["id"], targetZipId=square["id"]))
    action = choose(model, question, options(RELATIONS, relation_description),
        memory_ids=[product["id"], square["id"]], sample=False)
    return action, product["id"], square["id"]


def probe_report(model, library, probe):
    action, source, target = probe
    effect = memory_effect(model, action)
    valid = [i for i, option in enumerate(action["options"])
             if verify_relation(library, source, target, option["value"])["accepted"]]
    effect["certifiedChoiceProbability"] = {kind: sum(
        observation["probabilities"][i] for i in valid) for kind, observation in effect["observations"].items()}
    effect["correctChoicesComputedOnlyAfterInference"] = True
    return effect


def new_note(model, task, *, inspected=()):
    model.set_memory(list(inspected))
    count = model.read_calls
    output = base_generate(model.base, model.tokenizer, prompt(task), 96)
    return dict(task=asdict(task), output=output, verification=verify(task, output["raw"]),
        memoryZipIds=list(inspected), readCalls=model.read_calls-count,
        semanticUseProved=False, sftTargetSupplied=False, teacherCalls=0)


def small_event(event):
    # Full sampling states are saved per episode. The HTML is a compact view.
    keep = ["episode", "task", "tag", "link", "noteGenerationPerformed", "draftTokenUse", "update", "seconds"]
    result = {k: event[k] for k in keep}
    result["actions"] = [{k: action[k] for k in ["chosenValue", "readTrace", "promptTokens", "actionTokens"]}
                         for action in event["actions"]]
    return result


def run_arm(base, tokenizer, seeds, generation_state, rank, args, out, *, enabled):
    name = "发现奖励训练" if enabled else "同起点零奖励对照"
    out = new_run(out)
    library, ledger = NoteLibrary(seeds), DiscoveryLedger()
    torch.manual_seed(args.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(args.seed)
    rng = random.Random(args.seed)
    model = DiscoveryPilot(base, tokenizer, library.snapshot(), rank=rank)
    model.install_generation(generation_state)
    initial_digest = learned_digest(model)
    initial = {k: v.clone() for k, v in model.learned_state().items()}
    optimizer = torch.optim.AdamW(model.parameters_to_train(), lr=args.lr, weight_decay=0.)
    probe = fixed_probe(model, library)
    before_probe = probe_report(model, library, probe)
    model.set_memory([])
    language_messages = [{"role": "user", "content": "请用两句话解释图书馆是什么。"}]
    before_language = base_generate(base, tokenizer, language_messages, 64)
    write_json(out / "manifest.json", dict(protocol=DISCOVERY_PROTOCOL, name=name,
        rewardEnabled=enabled, seed=args.seed, initialLearnedSha256=initial_digest,
        initialLibrary=library.snapshot(), episodesRequested=args.episodes,
        maxArmSeconds=args.max_arm_seconds, device=args.device, rank=rank,
        learningRate=args.lr, objective="first certified student-selected relation +1; duplicate/skip 0; false -0.1",
        taskCompletionUsedForReward=False, teacherCalls=0, sftUpdates=0,
        finiteActionVocabulary=True, freeTextNotesGreedy=True, finalTestOpened=False))
    events, drafts, baseline = [], [], 0.
    started = time.monotonic()
    schedule = exploration_tasks()
    stop_reason = "episode-budget"
    try:
        for index in range(args.episodes):
            if time.monotonic()-started >= args.max_arm_seconds:
                stop_reason = "arm-time-cap"
                break
            episode = index+1
            # Every fourth episode's generation rotates through all eight
            # exploration objects over 32 episodes, including unsolved ones.
            task = schedule[(index+index//8) % len(schedule)]
            context = dict(object=task.public(), instruction="Choose a useful label for exploring this object")
            tag_action = choose(model, canonical(context), options(TAGS), rng=rng)
            tag = tag_action["chosenValue"]
            catalog = library.catalog()
            descriptions = {item["id"]: canonical({k: v for k, v in item.items() if k != "definition"}) for item in catalog}
            anchor_action = choose(model, canonical(dict(object=task.public(), studentTag=tag,
                instruction="Choose a zip to inspect. Labels are your own provisional guesses.")),
                options(list(library.notes), lambda identity: descriptions[identity]), rng=rng)
            anchor = anchor_action["chosenValue"]
            known = [dict(source=e["sourceZipId"], target=e["targetZipId"], relation=e["relation"])
                     for e in ledger.edges.values() if anchor in [e["sourceZipId"], e["targetZipId"]]]
            related_action = choose(model, canonical(dict(object=task.public(), studentTag=tag,
                inspectedZip=anchor, knownConnections=known,
                instruction="Which other zip might connect to the inspected one? Check even without solving the current problem.")),
                options([None]+[i for i in library.notes if i != anchor],
                        lambda identity: "Do not inspect a second note" if identity is None else descriptions[identity]),
                memory_ids=[anchor], rng=rng)
            target = related_action["chosenValue"]
            inspected = [anchor]+([target] if target else [])
            relation_action = choose(model, canonical(dict(object=task.public(), studentTag=tag,
                sourceZipId=anchor, targetZipId=target,
                sourceObject=library.notes[anchor]["task"]["key"],
                targetObject=library.notes[target]["task"]["key"] if target else None,
                knownConnections=known,
                instruction="Assert one connection or skip. Select only what the inspected notes support.")),
                options(RELATIONS if target else ["skip"], relation_description), memory_ids=inspected, rng=rng)
            actions = [tag_action, anchor_action, related_action, relation_action]
            draft = new_note(model, task, inspected=inspected) if index % 4 == 0 else None
            coverage = draft["verification"]["score"] if draft else None
            link = ledger.attempt(library, anchor, target, relation_action["chosenValue"],
                episode=episode, task_key=task.key, task_coverage=coverage)
            # Memory does not grow or change note bodies between sampling and replay.
            update = update_policy(model, optimizer, actions, reward=link["discoveryReward"],
                past_baseline=baseline, enabled=enabled)
            baseline = .9*baseline+.1*link["discoveryReward"]
            # The guessed tag describes the current object. Merely inspecting
            # a different zip must not copy that tag onto the borrowed object.
            for existing in list(library.notes.values()):
                if existing["task"]["family"] == task.family and existing["task"]["scale"] == task.scale:
                    library.tag(existing["id"], tag)
            admission = None
            if draft:
                drafts.append(draft)
                note, admission = library.admit(task, draft["output"], origin="student-generated-during-relation-exploration")
                if note:
                    library.tag(note["id"], tag)
            model.note_lookup = library.notes
            event = dict(episode=episode, task=asdict(task), tag=tag, actions=actions, link=link,
                noteGenerationPerformed=draft is not None, draft=draft, noteAdmission=admission,
                draftTokenUse=dict(promptTokens=draft["output"]["promptTokens"],
                    generatedTokens=draft["output"]["generatedTokens"]) if draft else None,
                update=update, seconds=time.monotonic()-started,
                librarySize=len(library.notes), uniqueLinks=len(ledger.edges),
                teacherCalls=0, sftUpdates=0, finalTestOpened=False)
            checkpoint = out / f"checkpoint-{episode:03d}.safetensors"
            save_file(model.learned_state(), str(checkpoint))
            event["checkpointSha256"] = file_digest(checkpoint)
            write_json(out / f"episode-{episode:03d}.json", event)
            write_json(out / f"brain-{episode:03d}.json", dict(library=library.snapshot(), edges=list(ledger.edges.values())))
            events.append(event)
            if episode == 1 or episode % 2 == 0 or link["newlyDiscovered"]:
                print(f"{name} {episode}/{args.episodes}：笔记={len(library.notes)}；新联系累计={len(ledger.edges)}；"
                    f"本步发现奖励={link['discoveryReward']:.1f}；实际参数变化={bool(update['changedParameterTensors'])}；"
                    f"计时={event['seconds']:.0f}s", flush=True)
                if link["newlyDiscovered"]:
                    print("学生发现：", library.notes[anchor]["task"]["key"], "→",
                        library.notes[target]["task"]["key"], relation_action["chosenValue"], flush=True)
        after_probe = probe_report(model, library, probe)
        model.set_memory([])
        after_language = base_generate(base, tokenizer, language_messages, 64)
        changed = [k for k, v in model.learned_state().items() if not torch.equal(v, initial[k])]
        if not enabled and changed:
            raise RuntimeError("The zero-reward control unexpectedly changed parameters")
        summary = episode_summary(events)
        vault = export_vault(out, library, ledger, arm_name=name)
        result = dict(name=name, rewardEnabled=enabled, summary=summary, events=[small_event(e) for e in events],
            library=library.snapshot(), edges=list(ledger.edges.values()), drafts=drafts,
            beforeMemoryProbe=before_probe, afterMemoryProbe=after_probe,
            languageBefore=before_language, languageAfter=after_language, languageCalls=2,
            languageQualityAutomaticallyCertified=False,
            initialLearnedSha256=initial_digest, finalLearnedSha256=learned_digest(model),
            changedParameterTensors=changed, seconds=time.monotonic()-started, stopReason=stop_reason,
            grammarEdgeCeiling=diagnostic_edge_ceiling(library),
            initialGrammarEdgeCeiling=diagnostic_edge_ceiling(NoteLibrary(seeds)),
            ceilingComputedOnlyAfterRollouts=True,
            zipReadCalls=model.read_calls, teacherCalls=0, sftUpdates=0, finalTestOpened=False,
            vaultArchive=str(vault), exactOptimizerResumeSupported=False,
            semanticUnderstandingProved=False, scientificNoveltyClaim=False)
        write_json(out / "result.json", result)
        return result
    finally:
        model.close()


def run(args):
    source_manifest, source_result, warmup, initial_library, protected = inspect_inputs(args)
    out = new_run(args.out)
    base, tokenizer, metadata = load_student(args.student_path, args.device)
    if metadata["snapshotSha256"] != source_manifest["snapshotSha256"]:
        raise ValueError("Actual student snapshot differs from the prepared experimental student")
    base_hash = state_digest(base)
    interface = warmup.restore_interface(args.start_run, base, tokenizer, metadata)
    interface.requires_grad_(False).eval()
    generation_state = load_file(str(args.start_run / "interface.safetensors"))
    write_json(out / "manifest.json", dict(metadata, protocol=DISCOVERY_PROTOCOL, coreSources=source_hashes(),
        discoverySources={name: file_digest(Path(__file__).parent / name) for name in [
            "zip_discovery_protocol.py", "zip_discovery_model.py", "zip_discovery_report.py", "zip_discovery_train.py"]},
        startRun=str(args.start_run), startAdapterSha256=source_result["adapterSha256"],
        notesRun=str(args.notes_run), notesArchiveSha256=protected[args.notes_run / "archive.json"],
        seed=args.seed, arms=["discovery-reward", "zero-reward"], episodesPerArm=args.episodes,
        maxArmSeconds=args.max_arm_seconds, teacherCalls=0, sftUpdates=0,
        finalTestOpened=False, userGoal="reward finding a connection independent of solving the current problem",
        relationGrammarSuppliedByExperiment=True, tagsAreStudentChosenFromFiniteMenu=True,
        baseWeightsFrozen=True, defaultStudentPromoted=False))
    print("先复用两份已有笔记，再让同一冻结学生尝试写其余四个训练对象；失败原稿保留。", flush=True)
    existing_keys = {n["task"]["key"] for n in initial_library.notes.values()}
    seed_drafts = []
    seed_started = time.monotonic()
    try:
        for task in tasks("train"):
            if task.key in existing_keys or time.monotonic()-seed_started >= 180:
                continue
            output = base_generate(base, tokenizer, prompt(task), 96)
            note, admission = initial_library.admit(task, output, origin="student-generated-before-discovery; previous SFT objects")
            seed_drafts.append(dict(task=asdict(task), output=output, admission=admission))
            write_json(out / (task.key+"-seed.json"), seed_drafts[-1])
            print(task.key, "：已写入公式成立的实验笔记" if note else "：原稿保留，未成为有证书的笔记", flush=True)
    finally:
        interface.close()
    if state_digest(base) != base_hash:
        raise RuntimeError("Foundation changed during initial note generation")
    seeds = initial_library.snapshot()
    write_json(out / "shared-seed-notes.json", dict(notes=seeds, drafts=seed_drafts,
        formulasVerified=True, proseCertified=False, independentDiscoveries=False))
    results = []
    try:
        for enabled in [True, False]:
            print("开始", "发现奖励训练" if enabled else "同起点零奖励对照", "；每组最多", args.episodes, "轮。", flush=True)
            result = run_arm(base, tokenizer, seeds, generation_state, source_manifest["rank"], args,
                out / ("reward-on" if enabled else "reward-off"), enabled=enabled)
            results.append(result)
            gc.collect()
        if results[0]["initialLearnedSha256"] != results[1]["initialLearnedSha256"]:
            raise RuntimeError("Comparison arms did not share the same actual initialized parameters")
        if state_digest(base) != base_hash or any(p.grad is not None or p.requires_grad for p in base.parameters()):
            raise RuntimeError("Frozen foundation changed or received gradients")
        if any(file_digest(p) != value for p, value in protected.items()):
            raise RuntimeError("A previous student/archive file changed")
        common = min(r["summary"]["episodes"] for r in results)
        comparison = dict(episodes=common, arms=[dict(name=r["name"], summary=episode_summary(r["events"][:common])) for r in results],
            equalInitialWeights=True, equalInitialMemory=True, equalEpisodeCaps=True,
            equalCompletedEpisodes=results[0]["summary"]["episodes"] == results[1]["summary"]["episodes"],
            multiSeedExperiment=False, finalTestOpened=False)
        summary = dict(protocol=DISCOVERY_PROTOCOL, arms=results, commonPrefixComparison=comparison,
            baseWeightsUnchanged=True, previousFilesUnchanged=True, defaultStudentPromoted=False,
            teacherCalls=0, sftUpdates=0, finalTestOpened=False, scientificNoveltyClaim=False,
            broadCapabilityImprovementClaim=False)
        write_json(out / "result.json", summary)
        report = write_report(out, summary)
        print("完成。主要检查：", flush=True)
        for result in results:
            print(result["name"], json.dumps(result["summary"], ensure_ascii=False), flush=True)
            print("关停/置换 zip 后的最大概率变化：", result["afterMemoryProbe"]["maxProbabilityDifference"], flush=True)
            print("训练后中文（人工检查）：", result["languageAfter"]["raw"], flush=True)
        print("报告：", report, "；Obsidian 笔记：", results[0]["vaultArchive"], flush=True)
        print("这是实际机制检查；未证明广泛能力提升。原学生、旧记录保留，老师新增请求=0。", flush=True)
    finally:
        # Protect original files even on a bounded/failed experiment.
        if any(file_digest(p) != value for p, value in protected.items()):
            raise RuntimeError("Previous experiment files unexpectedly changed")


def cli():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["student-path", "start-run", "notes-run", "out"]:
        parser.add_argument("--"+name, type=Path, required=True)
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--episodes", type=int, choices=range(1, 65), default=32)
    parser.add_argument("--max-arm-seconds", type=int, choices=range(60, 1201), default=600)
    parser.add_argument("--seed", type=int, choices=[1337, 2027, 4099], default=1337)
    parser.add_argument("--lr", type=float, default=.0001)
    args = parser.parse_args()
    if not 0 < args.lr <= .0003:
        parser.error("lr must be in (0, .0003]")
    try:
        run(args)
    except KeyboardInterrupt:
        print("已停止；逐轮权重、笔记与联系记录保留，无自动重启。", flush=True)
        raise SystemExit(130)
    except Exception as error:
        safe = str(error) if isinstance(error, (ValueError, RuntimeError, FileNotFoundError)) else type(error).__name__
        print("探索停止：", safe, "；逐轮已完成记录保留，无自动重试。", flush=True)
        raise SystemExit(1)


if __name__ == "__main__":
    cli()
