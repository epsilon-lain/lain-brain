"""Copy the whole file into ONE new code cell in the current Notebook, then ▶."""
from pathlib import Path
import hashlib, json, os, subprocess, uuid

work = Path("/mnt/workspace/lain-zip-pilot")
core = work / "tools-v2" if (work / "tools-v2").is_dir() else work / "tools"
python = work / "student-env/bin/python"
student = work / "models/Apertus-v1.1-0.5B-Instruct"
start = work / "zip-experiment-student-0573f301"
notes = work / "zip-experiment-notes-0573f301"
if not python.is_file() or not (student / "model.safetensors").is_file():
    raise RuntimeError("找不到已下载学生或现有环境；本格不安装、不下载。")
for required in [start / "interface.safetensors", start / "result.json", notes / "archive.json"]:
    if not required.is_file():
        raise RuntimeError("找不到刚才的实验学生或笔记：" + str(required))
expected_core = {'zip_pilot.py': '72031cd0db0f2189b379f306a8f0724b03be9dc5ba231dffff03e898de7b4945', 'zip_pilot_protocol.py': 'f7c9df1574ebaff35494397b7e1726877ee019b8d0afdfc109efe44d1d18f819', 'zip_pilot_model.py': '2530e390412848344b8beb64f1f282fee326669627c201bc49f45d4c5c839c14', 'research_reward_probe.py': '4fa71099207dddb1971c2289092ec0a0543d19e0a4b7495c4a5ed823c945dec3'}
for name, expected in expected_core.items():
    if not (core / name).is_file() or hashlib.sha256((core / name).read_bytes()).hexdigest() != expected:
        raise RuntimeError("已有 v2 脚本校验未通过：" + name)

files = {
'zip_discovery_protocol.py': r'''"""A finite, auditable relation-discovery experiment, not open research truth.

The student chooses a pair and an algebraic transform. This module checks that
chosen assertion; it never chooses a correct relation or auto-populates edges.
Discovery reward is independent of current-task completion and teacher prose.
"""
from __future__ import annotations

from dataclasses import asdict
from fractions import Fraction

from research_reward_probe import VARS, poly
from zip_pilot_protocol import Task, canonical, fingerprint, tasks, verify

DISCOVERY_PROTOCOL = "lain-zip-discovery-v1"
TAGS = ["one changing input", "two changing inputs", "interaction of changes",
        "rescaling", "unsure"]
FACTORS = ["1", "2", "3", "1/2", "1/3", "2/3", "3/2"]
# A finite action vocabulary supplied by the experiment, not generated truths.
RELATIONS = ["skip"] + [f"scale:{factor}" for factor in FACTORS] + [
    f"diagonal:{factor}" for factor in FACTORS]


def exploration_tasks():
    # These additional composition objects are declared training exploration.
    # No dev/final task, answer or teacher feedback enters this schedule.
    return tasks("train") + [Task(f"explore-composition-{a}", "train", "composition", a) for a in [1, 2]]


def polynomial_record(expression):
    return [[list(powers), str(coefficient)] for powers, coefficient in sorted(poly(expression).items())]


def diagonal(polynomial):
    """The typed substitution y=x, v=u; exact rational coefficients."""
    result = {}
    for (x, y, u, v), coefficient in polynomial.items():
        powers = (x+y, 0, u+v, 0)
        result[powers] = result.get(powers, Fraction(0)) + coefficient
    return {powers: coefficient for powers, coefficient in result.items() if coefficient}


def note_text(note):
    # Keep the student's actual definition. Pending prose is never represented
    # as teacher-certified meaning; no replacement caption or formula is added.
    return canonical(dict(object=note["task"]["key"], definition=note["claim"]["definition"],
        expression=note["claim"]["expression"], scope=note["claim"]["scope"],
        proseStatus=note["definitionTeacherStatus"]))


class NoteLibrary:
    def __init__(self, notes=()):
        self.notes = {}
        self.versions = []
        for note in notes:
            task = Task(**note["task"])
            installed, _ = self.admit(task, dict(raw=canonical(note["claim"])),
                origin=note["origin"], teacher_status=note.get("definitionTeacherStatus", "unknown"))
            if installed is None:
                raise ValueError("A seed note failed independent exact-formula verification")

    def admit(self, task, output, *, origin, teacher_status="unknown"):
        if task.split != "train":
            raise ValueError("Only declared training objects can enter exploration memory")
        check = verify(task, output["raw"])
        if not (check["accepted"] and check["score"] == 1 and check["claim"]["scope"] == "exact"):
            return None, dict(new=False, verification=check)
        identity = "zip-" + fingerprint(dict(object=dict(split=task.split, family=task.family, scale=task.scale),
            polynomial=polynomial_record(check["claim"]["expression"])))[:16]
        version = dict(id=identity, task=asdict(task), output=output, verification=check,
            origin=origin, definitionTeacherStatus=teacher_status)
        self.versions.append(version)
        if identity in self.notes:
            # Wording changes cannot manufacture a new object or discovery.
            return self.notes[identity], dict(new=False, verification=check)
        if len(self.notes) >= 12:
            return None, dict(new=False, verification=check, reason="bounded library full; draft retained")
        note = dict(id=identity, task=asdict(task), claim=check["claim"], verification=check,
            formulaCertified=True, definitionCertified=False, definitionTeacherStatus=teacher_status,
            origin=origin, studentTags=[], independentDiscovery=False,
            status="formula-certified-exploration; prose pending" if teacher_status != "clear"
                else "teacher-reviewed-experimental")
        self.notes[identity] = note
        return note, dict(new=True, verification=check)

    def catalog(self):
        # Catalogue metadata is not the full note content. The selected note is
        # subsequently read through the neural memory interface.
        return [dict(id=n["id"], object=n["task"]["key"], definition=n["claim"]["definition"],
                     studentTags=n["studentTags"], proseStatus=n["definitionTeacherStatus"])
                for n in self.notes.values()]

    def tag(self, note_id, tag):
        if tag not in TAGS or note_id not in self.notes:
            raise ValueError("Unknown student-selected note or tag")
        if tag not in self.notes[note_id]["studentTags"]:
            self.notes[note_id]["studentTags"].append(tag)

    def snapshot(self):
        # Deep detached JSON snapshot; later growth cannot alter policy state.
        import json
        return json.loads(canonical(list(self.notes.values())))


def verify_relation(library, source_id, target_id, relation):
    result = dict(accepted=False, reason="", certificate=None, edgeKey=None,
                  teacherAgreementUsed=False, usefulnessUsed=False)
    if relation == "skip" or source_id is None or target_id is None:
        return dict(result, reason="Student chose not to assert a connection", skipped=True)
    try:
        if source_id == target_id:
            raise ValueError("Self links are not a new object connection")
        if source_id not in library.notes or target_id not in library.notes or relation not in RELATIONS:
            raise ValueError("Unknown endpoint or relation action")
        source, target = library.notes[source_id], library.notes[target_id]
        for note in [source, target]:
            endpoint = verify(Task(**note["task"]), canonical(note["claim"]))
            if not endpoint["accepted"] or endpoint["score"] != 1 or endpoint["claim"]["scope"] != "exact":
                raise ValueError("An endpoint no longer has an exact object certificate")
        kind, factor_string = relation.split(":")
        factor = Fraction(factor_string)
        source_poly = poly(source["claim"]["expression"])
        target_poly = poly(target["claim"]["expression"])
        if kind == "diagonal":
            if source["task"]["family"] != "product" or target["task"]["family"] != "square":
                raise ValueError("Diagonal action is typed product -> square")
            transformed = diagonal(source_poly)
            key = fingerprint(dict(kind=kind, source=source_id, target=target_id))
            substitution = {"y": "x", "v": "u"}
        else:
            transformed = source_poly
            # Inverse directions/factor spellings cannot earn credit twice.
            key = fingerprint(dict(kind="proportional", pair=sorted([source_id, target_id])))
            substitution = {}
        expected = {powers: coefficient*factor for powers, coefficient in transformed.items()}
        if expected != target_poly:
            raise ValueError("Selected algebraic transformation is false")
        certificate = dict(kind="exact-rational-polynomial-transformation", variableOrder=list(VARS),
            source=source_id, target=target_id, substitution=substitution, factor=str(factor),
            sourceClaimHash=fingerprint(polynomial_record(source["claim"]["expression"])),
            targetClaimHash=fingerprint(polynomial_record(target["claim"]["expression"])),
            equalityCheckedForAllRealInputs=True)
        return dict(result, accepted=True, reason="Chosen transformation certified", certificate=certificate, edgeKey=key)
    except (ValueError, KeyError, TypeError) as error:
        return dict(result, reason=str(error), skipped=False)


class DiscoveryLedger:
    def __init__(self):
        self.edges = {}

    def attempt(self, library, source_id, target_id, relation, *, episode, task_key, task_coverage):
        checked = verify_relation(library, source_id, target_id, relation)
        fresh = checked["accepted"] and checked["edgeKey"] not in self.edges
        # No task score, task time or teacher agreement appears in this reward.
        reward = 1.0 if fresh else (0.0 if checked["accepted"] or checked.get("skipped") else -0.1)
        event = dict(sourceZipId=source_id, targetZipId=target_id, relation=relation, verification=checked,
            newlyDiscovered=fresh, discoveryReward=reward, episode=episode,
            currentTask=task_key, currentTaskCoverage=task_coverage, taskScoreUsedForReward=False)
        if fresh:
            self.edges[checked["edgeKey"]] = dict(event, id="link-"+checked["edgeKey"][:16],
                scientificNoveltyClaim=False, noveltyScope="first verified assertion in this run's ledger")
        return event


def relation_description(relation):
    if relation == "skip":
        return "Do not assert a connection"
    kind, factor = relation.split(":")
    prefix = "source change polynomial" if kind == "scale" else "source after y=x and v=u (product -> square only)"
    return f"target change polynomial = {factor} * ({prefix})"


def diagnostic_edge_ceiling(library):
    """Analyst-only count after rollouts; never supplied to actor or ledger."""
    keys = set()
    for source in library.notes:
        for target in library.notes:
            if source != target:
                for relation in RELATIONS[1:]:
                    checked = verify_relation(library, source, target, relation)
                    if checked["accepted"]:
                        keys.add(checked["edgeKey"])
    return len(keys)
''',
'zip_discovery_model.py': r'''"""Student-language policy with discrete inspection actions and real zip reads.

The action vocabulary is finite. Probabilities are the student's next-token
logits normalized over one-token menu labels; replay uses that same policy.
Free note text is greedy language generation, not a separate SFT target.
"""
from __future__ import annotations

import copy
import random

import torch

from zip_discovery_protocol import note_text
from zip_pilot_model import ZipPilot, encode_prompt
from zip_pilot_protocol import canonical


class DiscoveryPilot(ZipPilot):
    def __init__(self, base, tokenizer, notes, *, rank=32):
        super().__init__(base, tokenizer, [note_text(n) for n in notes], rank=rank, mode="zip")
        # Introducing untrained memory must initially preserve the actual warmed
        # generation function. A nonzero discovery gradient learns the read path.
        torch.nn.init.zeros_(self.read_out.weight)
        self.memory_ids = []
        self.embedding_cache = {}
        self.last_read = None
        self.note_lookup = {n["id"]: n for n in notes}
        self.labels = []
        used = set()
        for label in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
            ids = tokenizer(label, add_special_tokens=False)["input_ids"]
            if (len(ids) == 1 and ids[0] not in used
                    and ids[0] != tokenizer.unk_token_id and ids[0] != tokenizer.eos_token_id):
                self.labels.append((label, ids[0]))
                used.add(ids[0])
        if len(self.labels) < 15:
            self.close()
            raise ValueError("Need at least fifteen distinct one-token choice labels; no format-training fallback")
        self.set_memory([])

    def install_generation(self, state):
        expected = self.generation_adapter.state_dict()
        state = {k.removeprefix("generation_adapter."): v for k, v in state.items()}
        if (set(state) != set(expected)
                or any(state[k].shape != expected[k].shape or not torch.isfinite(state[k]).all() for k in state)):
            raise ValueError("Saved generation adapter differs from this student")
        self.generation_adapter.load_state_dict(state, strict=True)

    def set_memory(self, ids, *, ablation="normal"):
        if ablation not in {"normal", "off", "shuffle"} or len(ids) > 2 or len(set(ids)) != len(ids):
            raise ValueError("Need zero, one or two distinct inspected zip notes")
        self.memory_ids, self.ablation = list(ids), ablation
        self.notes = [note_text(self.note_lookup[i]) for i in ids]
        pooled = []
        device = next(self.base.parameters()).device
        for identity, text in zip(ids, self.notes):
            if identity not in self.embedding_cache:
                tokens = self.tokenizer(text, add_special_tokens=False, return_tensors="pt")["input_ids"].to(device)
                if not 1 <= tokens.shape[1] <= 256:
                    raise ValueError("Inspected zip exceeds 256 tokens; no silent truncation")
                with torch.no_grad():
                    self.embedding_cache[identity] = self.base.get_input_embeddings()(tokens).float().mean(1)[0]
            pooled.append(self.embedding_cache[identity])
        self.note_embeddings = torch.stack(pooled) if pooled else torch.empty(
            0, self.base.config.hidden_size, device=device)
        self.last_read = None

    def _read(self, module, args, output):
        hidden = output[0] if isinstance(output, tuple) else output
        h = hidden.float()
        delta = self.generation_adapter(h)
        if self.memory_ids and self.ablation != "off":
            memory = self.encoder(self.note_embeddings).reshape(-1, hidden.shape[-1])
            keys = torch.nn.functional.normalize(self.k(memory), dim=-1)
            values = self.v(memory)
            if self.ablation == "shuffle":
                values = values.reshape(len(self.notes), self.slots, -1).roll(1, 0).reshape(-1, self.rank)
            queries = torch.nn.functional.normalize(self.q(h), dim=-1)
            weights = (queries @ keys.T * self.rank**.5).softmax(-1)
            delta = delta + self.read_out(weights @ values)
            self.read_calls += 1
            mass = weights[:, -1, :].detach().mean(0).reshape(len(self.notes), self.slots).sum(-1)
            self.last_read = dict(zipIds=list(self.memory_ids), attentionMass=mass.cpu().tolist(),
                ablation=self.ablation, readPathExecuted=True,
                semanticUseProved=False)  # attention/hook execution alone is not proof
        result = hidden + delta.to(hidden.dtype)
        return (result,)+output[1:] if isinstance(output, tuple) else result

    def learned_state(self):
        return {k: v.detach().cpu().contiguous() for k, v in self.state_dict().items()
                if not k.startswith("base.") and k != "note_embeddings"}

    def restore_learned(self, stored):
        expected = self.learned_state()
        if set(expected) != set(stored) or any(
                stored[k].shape != expected[k].shape or stored[k].dtype != expected[k].dtype
                or not torch.isfinite(stored[k]).all() for k in expected):
            raise ValueError("Discovery checkpoint keys/shapes/dtypes differ")
        incompatible = self.load_state_dict(stored, strict=False)
        if incompatible.unexpected_keys or any(
                not k.startswith("base.") and k != "note_embeddings" for k in incompatible.missing_keys):
            raise ValueError("Discovery checkpoint has missing learned state")


def choice_messages(question, options, labels):
    return [{"role": "system", "content":
        "Explore relationships between mathematical objects. Choose exactly one displayed letter. "
        "You may be unsure. New verified connections have value even if the current problem stays unsolved. "
        "Student labels and natural-language definitions may be imperfect; no teacher truth is implied."},
        {"role": "user", "content": question+"\n"+"\n".join(
            f"{labels[i][0]}: {option['description']}" for i, option in enumerate(options))}]


def distribution(model, action):
    model.set_memory(action["memoryIds"], ablation=action.get("ablation", "normal"))
    device = next(model.parameters()).device
    ids = torch.tensor([action["promptIds"]], device=device)
    logits = model(ids, keep=1)[0, -1].float()
    allowed = torch.tensor(action["allowedTokenIds"], device=device)
    return (logits[allowed] / action["temperature"]).log_softmax(-1)


def choose(model, question, options, *, memory_ids=(), sample=True, rng=None, temperature=1.0):
    if not 1 <= len(options) <= len(model.labels) or not .5 <= temperature <= 2:
        raise ValueError("Choice menu/temperature exceeds finite policy bounds")
    if len(set(canonical(o["value"]) for o in options)) != len(options):
        raise ValueError("Choice values must be unique")
    options = copy.deepcopy(options)
    if rng is not None:
        rng.shuffle(options)
    labels = model.labels[:len(options)]
    messages = choice_messages(question, options, labels)
    ids = encode_prompt(model, messages, max_prompt=2048)[0].tolist()
    action = dict(messages=messages, promptIds=ids, allowedTokenIds=[t for _, t in labels],
        options=options, memoryIds=list(memory_ids), temperature=temperature, ablation="normal")
    model.eval()
    with torch.no_grad():
        logps = distribution(model, action)
        index = int(torch.multinomial(logps.exp(), 1)) if sample else int(logps.argmax())
    action.update(chosenIndex=index, chosenValue=options[index]["value"], chosenLabel=labels[index][0],
        sampled=sample, samplingLogProbability=float(logps[index]),
        choiceProbabilities=logps.exp().cpu().tolist(), readTrace=copy.deepcopy(model.last_read),
        promptTokens=len(ids), actionTokens=1, policy="next-token logits restricted to displayed labels")
    return action


def update_policy(model, optimizer, actions, *, reward, past_baseline, enabled=True):
    """One replay of the exact sampled joint finite-action policy, then a step."""
    if not actions or any(not a["sampled"] for a in actions):
        raise ValueError("Policy updates require sampled student actions")
    initial = {name: p.detach().clone() for name, p in model.named_parameters() if p.requires_grad}
    model.train()
    optimizer.zero_grad(set_to_none=True)
    advantage = reward-past_baseline
    loss_number, maximum_error = 0., 0.
    for action in actions:
        logps = distribution(model, action)
        chosen = logps[action["chosenIndex"]]
        error = abs(float(chosen.detach())-action["samplingLogProbability"])
        maximum_error = max(maximum_error, error)
        if error > 2e-3:
            raise RuntimeError("Sampling and replay policies differ; not applying this update")
        loss = -(advantage if enabled else 0.)*chosen
        loss.backward()
        loss_number += float(loss.detach())
    norm = torch.nn.utils.clip_grad_norm_(model.parameters_to_train(), 1., error_if_nonfinite=True)
    optimizer.step()  # AdamW weight_decay=0 required even for the zero-reward arm.
    changed = [name for name, p in model.named_parameters() if p.requires_grad
               and not torch.equal(initial[name], p.detach())]
    model.eval()
    return dict(loss=loss_number, gradNorm=float(norm), advantage=advantage,
        pastBaseline=past_baseline, rewardEnabled=enabled, changedParameterTensors=changed,
        samplingReplayMaxLogProbabilityError=maximum_error, optimizerSteps=1,
        replayActionCount=len(actions), sftUpdates=0, klCoefficient=0., entropyCoefficient=0.)


def memory_effect(model, action):
    """Same frozen weights, prompt and note IDs; compare actual distributions."""
    observations = {}
    model.eval()
    with torch.no_grad():
        for ablation in ["normal", "off", "shuffle"]:
            tested = dict(action, ablation=ablation)
            logps = distribution(model, tested)
            observations[ablation] = dict(probabilities=logps.exp().cpu().tolist(),
                selectedValue=action["options"][int(logps.argmax())]["value"],
                readTrace=copy.deepcopy(model.last_read))
    normal = torch.tensor(observations["normal"]["probabilities"])
    differences = {kind: float((normal-torch.tensor(observations[kind]["probabilities"])).abs().max())
                   for kind in ["off", "shuffle"]}
    model.set_memory([])
    return dict(observations=observations, maxProbabilityDifference=differences,
        promptUnchanged=True, weightsUnchanged=True, semanticUnderstandingProved=False,
        note="Nonzero effects show dependence of this policy distribution, not useful understanding.")
''',
'zip_discovery_report.py': r'''"""Export real ledger links as ordinary Obsidian notes and a local report."""
from __future__ import annotations

import html
import json
from pathlib import Path
import zipfile


def quote_definition(text):
    # Model prose must not inject unverified wikilinks into the graph export.
    text = html.escape(text, quote=False).replace("[", "&#91;").replace("]", "&#93;")
    return "\n".join("> "+line for line in text.splitlines())


def export_vault(out, library, ledger, *, arm_name):
    vault = Path(out) / "obsidian-notes"
    vault.mkdir(exist_ok=False)
    for note in library.notes.values():
        tags = [t.replace(" ", "-") for t in note["studentTags"]]
        text = ("---\nexperiment: zip-discovery\nformula_certified: true\n"
            "definition_certified: false\nstudent_proposed_tags: "+json.dumps(tags)+"\n---\n\n"
            f"# {note['task']['key']}\n\n学生自己的定义：\n\n"
            +quote_definition(note["claim"]["definition"])+"\n\n"
            f"公式： `{note['claim']['expression']}`\n\n"
            f"解释审阅状态：{note['definitionTeacherStatus']}；公式有程序证书，解释没有真值证书。\n\n"
            "已核验的对象联系：\n\n")
        connected = 0
        for edge in ledger.edges.values():
            if note["id"] not in [edge["sourceZipId"], edge["targetZipId"]]:
                continue
            other = edge["targetZipId"] if note["id"] == edge["sourceZipId"] else edge["sourceZipId"]
            proof = edge["verification"]["certificate"]
            text += (f"- [[{other}]] — {edge['relation']}；方向：{edge['sourceZipId']} → {edge['targetZipId']}。"
                f"第 {edge['episode']} 轮提出；新联系奖励 {edge['discoveryReward']}；"
                f"当时题目覆盖 {edge['currentTaskCoverage']}（不参与该奖励）。\n"
                f"  证书：factor={proof['factor']}，substitution={json.dumps(proof['substitution'])}。\n")
            connected += 1
        if not connected:
            text += "尚无学生提出且通过核验的联系；未自动填充关系。\n"
        text += "\n这里只导出实验对象和联系；这些数学关系不声称为学术新发现。\n"
        (vault / (note["id"]+".md")).write_text(text, encoding="utf-8")
    # No index -> every-note wikilinks: those would inflate the apparent graph.
    (vault / "README.md").write_text(
        f"# Lain Brain 对象联系实验：{arm_name}\n\n"
        "这是普通 Markdown 笔记文件夹。放进 Obsidian 仓库后，笔记中已有的内部链接"
        "可供 Graph view 显示。未改动任何现有仓库或插件。\n\n"
        "笔记保留学生自己的定义与公式；待对齐解释明确标记。图上的笔记间连接仅来自"
        "学生选择后通过代数核验的关系，没有规则自动补边。\n\n"
        "图谱存在不等于学生已经理解；训练报告另列调用记录和关停/置换记忆实验。\n",
        encoding="utf-8")
    destination = Path(out) / "Brain-Discovery-Notes.zip"
    with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(vault.glob("*.md")):
            archive.write(path, "LainBrainDiscovery/"+path.name)
    return destination


def episode_summary(events):
    return dict(episodes=len(events), newLinks=sum(e["link"]["newlyDiscovered"] for e in events),
        correctAssertions=sum(e["link"]["verification"]["accepted"] for e in events),
        repeatedAssertions=sum(e["link"]["verification"]["accepted"] and not e["link"]["newlyDiscovered"] for e in events),
        falseAssertions=sum(not e["link"]["verification"]["accepted"]
            and not e["link"]["verification"].get("skipped", False) for e in events),
        discoveryRewardSum=sum(e["link"]["discoveryReward"] for e in events),
        newLinksDespiteFailedCurrentGeneration=sum(e["link"]["newlyDiscovered"]
            and e["noteGenerationPerformed"] and e["link"]["currentTaskCoverage"] == 0 for e in events),
        generationCalls=sum(e["noteGenerationPerformed"] for e in events),
        notePromptTokens=sum((e.get("draftTokenUse") or {}).get("promptTokens", 0) for e in events),
        noteGeneratedTokens=sum((e.get("draftTokenUse") or {}).get("generatedTokens", 0) for e in events),
        noteReadsDuringChoices=sum(a["readTrace"] is not None for e in events for a in e["actions"]),
        optimizerSteps=sum(e["update"]["optimizerSteps"] for e in events),
        parameterChangingUpdates=sum(bool(e["update"]["changedParameterTensors"]) for e in events),
        replayForwardBackwardActions=sum(e["update"]["replayActionCount"] for e in events),
        categoricalActionPromptTokens=sum(a["promptTokens"] for e in events for a in e["actions"]),
        categoricalSampledTokens=sum(len(e["actions"]) for e in events))


def write_report(out, results):
    data = json.dumps(results, ensure_ascii=False, allow_nan=False).replace("<", "\\u003c")
    page = r"""<!doctype html><html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lain Brain · 联系探索</title><style>
body{font:15px/1.6 system-ui,sans-serif;background:#101923;color:#e3ecee;margin:0;padding:24px}
main{max-width:1150px;margin:auto}h1{font-size:26px}p{max-width:950px;color:#bed0d3}
button{background:#203844;color:#e3ecee;border:1px solid #56898f;border-radius:8px;padding:9px 15px;cursor:pointer;margin:0 8px 12px 0}
.layout{display:grid;grid-template-columns:1fr 1fr;gap:18px}.card{background:#172731;padding:18px;border-radius:12px;min-width:0}
svg{width:100%;height:380px}text{fill:#e3ecee;font:12px system-ui}circle{cursor:pointer;stroke:#a7d7d2;stroke-width:2;fill:#355d63}
line{stroke:#a7d7d2;stroke-width:2;opacity:.7}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}
table{width:100%;border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid #35515b;text-align:left}
.muted{font-size:13px;color:#9fb8bf}@media(max-width:800px){.layout{grid-template-columns:1fr}body{padding:12px}}
</style><main><h1>Lain Brain · 写笔记与发现联系</h1>
<p>联系由学生选择、代数核验。新联系本身获得奖励，题目是否解决另行记录。
这是一轮有限数学动作实验；待对齐解释没有真值证书，图谱和注意力不证明理解能力。</p>
<div id="tabs"></div><div class="layout"><section class="card"><div id="counts"></div>
<svg id="graph" viewBox="0 0 500 400"></svg><p class="muted">点笔记查看原始定义和已核验关系。没有关系时保留孤立笔记。</p></section>
<section class="card"><pre id="detail">点左侧笔记。</pre>
<details><summary>训练前后中文（人工检查）</summary><pre id="language"></pre></details></section></div>
<section class="card" style="margin-top:18px"><h2>同一起点的对照</h2><div id="comparison"></div>
<p class="muted">若两组因时限完成轮数不同，下表只比较共同前缀；没有多种子或隐藏泛化结论。</p></section>
<section class="card" style="margin-top:18px"><h2>实际探索记录</h2><div id="events"></div></section></main>
<script id="data" type="application/json">__DATA__</script><script>
const data=JSON.parse(document.getElementById('data').textContent);
const $=id=>document.getElementById(id),ns='http://www.w3.org/2000/svg';
function cell(row,value,tag='td'){const el=document.createElement(tag);el.textContent=String(value);row.appendChild(el)}
function table(rows,headers){const t=document.createElement('table'),h=document.createElement('tr');headers.forEach(x=>cell(h,x,'th'));t.appendChild(h);rows.forEach(r=>{const tr=document.createElement('tr');r.forEach(x=>cell(tr,x));t.appendChild(tr)});return t}
function select(arm){$('graph').replaceChildren();$('detail').textContent='点左侧笔记。';
 $('language').textContent=JSON.stringify({before:arm.languageBefore?.raw,after:arm.languageAfter?.raw,automaticallyCertified:false},null,2);
 $('counts').textContent=`${arm.name}：${arm.summary.episodes} 轮；${arm.library.length} 份有公式证书的笔记；${arm.summary.newLinks} 条新联系（当前语法和笔记库最多 ${arm.grammarEdgeCeiling} 条）；${arm.summary.parameterChangingUpdates} 次实际参数变化`;
 const pos=new Map(arm.library.map((n,i)=>[n.id,[250+150*Math.cos(2*Math.PI*i/arm.library.length),195+150*Math.sin(2*Math.PI*i/arm.library.length)]]));
 arm.edges.forEach(e=>{const [x1,y1]=pos.get(e.sourceZipId),[x2,y2]=pos.get(e.targetZipId);const l=document.createElementNS(ns,'line');Object.entries({x1,y1,x2,y2}).forEach(([k,v])=>l.setAttribute(k,v));$('graph').appendChild(l)});
 arm.library.forEach(n=>{const [cx,cy]=pos.get(n.id),c=document.createElementNS(ns,'circle');Object.entries({cx,cy,r:13}).forEach(([k,v])=>c.setAttribute(k,v));c.addEventListener('click',()=>{$('detail').textContent=JSON.stringify({object:n.task.key,studentDefinition:n.claim.definition,expression:n.claim.expression,studentTags:n.studentTags,definitionTeacherStatus:n.definitionTeacherStatus,definitionCertified:false,connections:arm.edges.filter(e=>e.sourceZipId===n.id||e.targetZipId===n.id)},null,2)});$('graph').appendChild(c);const label=document.createElementNS(ns,'text');label.setAttribute('x',cx);label.setAttribute('y',cy+29);label.setAttribute('text-anchor','middle');label.textContent=n.task.key;$('graph').appendChild(label)});
 $('events').replaceChildren(table(arm.events.map(e=>[e.episode,e.task.key,e.tag,e.link.relation,e.link.newlyDiscovered?'新联系':e.link.verification.reason,e.link.discoveryReward,e.link.currentTaskCoverage??'未生成',e.actions.filter(a=>a.readTrace).map(a=>a.readTrace.zipIds.join(',')).join(';')]),['轮','当前对象','学生标签','联系提案','核验','发现奖励','题目覆盖','实际读取 zip']));}
data.arms.forEach(arm=>{const b=document.createElement('button');b.textContent=arm.name;b.addEventListener('click',()=>select(arm));$('tabs').appendChild(b)});
const c=data.commonPrefixComparison;$('comparison').appendChild(table(c.arms.map(a=>[a.name,c.episodes,a.summary.newLinks,a.summary.repeatedAssertions,a.summary.falseAssertions,a.summary.noteReadsDuringChoices,a.summary.parameterChangingUpdates]),['组','共同轮数','新联系','重复','错误联系','读取记录','参数变化']));
if(data.arms.length)select(data.arms[0]);
</script></html>"""
    path = Path(out) / "report.html"
    path.write_text(page.replace("__DATA__", data), encoding="utf-8")
    return path
''',
'zip_discovery_train.py': r'''"""Bounded student-owned notes, relation reward and a same-start frozen control.

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
''',
}
expected_new = {'zip_discovery_protocol.py': '8cd855051df6d034d3ec54d174f2583ea5dc5e8c717839c2b67e0d79671f44d4', 'zip_discovery_model.py': 'df71ff8b5cb9b147d7d0088b21021cebd441b79f45f3435e6943b37d7ae26374', 'zip_discovery_report.py': '8e3ba05adb8fef872bd56a81b3d96cb6e69378928ad156001e4884847577ffaf', 'zip_discovery_train.py': 'f43561177ba02fa3a25d507c95f49f30190c40a3dc40f234851fb407bc8210f5'}
tag = uuid.uuid4().hex[:8]
folder = work / ("discovery-tools-" + tag)
folder.mkdir(exist_ok=False)
for name, content in files.items():
    path = folder / name
    with path.open("x", encoding="utf-8") as stream:
        stream.write(content)
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected_new[name]:
        raise RuntimeError("新探索代码校验失败：" + name)
out = work / ("zip-discovery-" + tag)
env = dict(os.environ)
env.pop("LAIN_TEACHER_API_KEY", None)
env["PYTHONPATH"] = str(folder) + os.pathsep + str(core) + os.pathsep + env.get("PYTHONPATH", "")
env["HF_HUB_OFFLINE"] = "1"
print("开始联系发现实验：最多32轮奖励训练 + 32轮同起点零奖励对照。", flush=True)
print("新核验联系 +1；重复/跳过 0；错误断言 -0.1。题目覆盖不进入这个奖励。", flush=True)
print("每组操作间计时上限600秒；总进程最多30分钟。CPU；每轮保存，不自动重试。", flush=True)
print("复用已下载学生；监督更新=0，老师新增请求=0，无需 key。", flush=True)
command = [str(python), "-u", str(folder / "zip_discovery_train.py"),
        "--student-path", str(student), "--start-run", str(start), "--notes-run", str(notes),
        "--out", str(out), "--device", "cpu", "--episodes", "32", "--max-arm-seconds", "600"]
process = subprocess.Popen(command, env=env)
try:
    code = process.wait(timeout=1800)
    if code:
        raise subprocess.CalledProcessError(code, command)
except (subprocess.TimeoutExpired, KeyboardInterrupt):
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)
    print("子进程已停止；已完成的逐轮权重与 brain 记录保留，无自动重启。", flush=True)
    raise
print("结果文件夹：", out, flush=True)
try:
    from IPython.display import FileLink, display
    for path in [out / "report.html", out / "result.json", out / "reward-on/Brain-Discovery-Notes.zip"]:
        if path.is_file():
            display(FileLink(os.path.relpath(path, Path.cwd())))
except ImportError:
    print("报告：", out / "report.html", "；笔记：", out / "reward-on/Brain-Discovery-Notes.zip", flush=True)
