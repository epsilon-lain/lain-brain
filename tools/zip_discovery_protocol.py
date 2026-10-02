"""A finite, auditable relation-discovery experiment, not open research truth.

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
