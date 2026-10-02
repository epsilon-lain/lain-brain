"""Hand-written, exact reward/scheduling dry run. No student or neural training.

Run with Python's standard library. All claims below are fixtures, not discoveries.
"""
from __future__ import annotations

import argparse
import ast
from dataclasses import dataclass, field
from fractions import Fraction as F
import hashlib
import json
from pathlib import Path

VARS = ("x", "y", "u", "v")
ZERO = (0, 0, 0, 0)


def clean(p):
    return {k: v for k, v in p.items() if v}


def add(a, b, sign=1):
    c = dict(a)
    for key, value in b.items():
        c[key] = c.get(key, F(0)) + sign * value
    return clean(c)


def mul(a, b):
    c = {}
    for ka, va in a.items():
        for kb, vb in b.items():
            k = tuple(i + j for i, j in zip(ka, kb))
            if sum(k) > 8:
                raise ValueError("Polynomial degree exceeds dry-run bound")
            c[k] = c.get(k, F(0)) + va * vb
    return clean(c)


def poly(text):
    if not isinstance(text, str) or len(text) > 256:
        raise ValueError("Expression must be a short string")
    tree = ast.parse(text, mode="eval")
    if sum(1 for _ in ast.walk(tree)) > 100:
        raise ValueError("Expression exceeds dry-run bound")

    def parse(node):
        if isinstance(node, ast.Name) and node.id in VARS:
            key = tuple(int(name == node.id) for name in VARS)
            return {key: F(1)}
        if isinstance(node, ast.Constant) and type(node.value) is int and abs(node.value) <= 100:
            return clean({ZERO: F(node.value)})
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
            sign = -1 if isinstance(node.op, ast.USub) else 1
            return {k: sign * v for k, v in parse(node.operand).items()}
        if isinstance(node, ast.BinOp):
            if isinstance(node.op, (ast.Add, ast.Sub)):
                return add(parse(node.left), parse(node.right), -1 if isinstance(node.op, ast.Sub) else 1)
            if isinstance(node.op, ast.Mult):
                return mul(parse(node.left), parse(node.right))
            if (isinstance(node.op, ast.Pow) and isinstance(node.right, ast.Constant)
                    and type(node.right.value) is int and 0 <= node.right.value <= 4):
                result = {ZERO: F(1)}
                base = parse(node.left)
                for _ in range(node.right.value):
                    result = mul(result, base)
                return result
        raise ValueError("Only bounded rational polynomials are supported; no code execution")

    return parse(tree.body)


TARGETS = {
    "square_exact": poly("(x+u)**2-x**2"),
    "product_exact": poly("(x+u)*(y+v)-x*y"),
    "composition": poly("((x+u)*(y+v))**2-(x*y)**2"),
}
WEIGHTS = {"local": F(3, 10), "square_exact": F(1, 5),
           "product_exact": F(1, 5), "composition": F(3, 10)}


@dataclass
class Ledger:
    credit: dict = field(default_factory=dict)
    evidence: dict = field(default_factory=dict)

    def score(self):
        return sum(self.credit.values(), F(0))

    def attempt(self, kind, expression, *, radius=None, tolerance=None,
                status="asserted", teacher_agrees=False, cost=F(1, 50)):
        before = self.score()
        prior_credit = self.credit.get(kind, F(0))
        accepted, reason = False, ""
        if status == "conjecture":
            reason = "Conjecture retained outside verified ledger; no truth credit"
        elif status != "asserted":
            raise ValueError("Unsupported claim status")
        else:
            candidate = poly(expression)
            if kind == "local":
                radius, tolerance = F(radius), F(tolerance)
                residual = add(TARGETS["square_exact"], candidate, -1)
                accepted = (residual == poly("u**2") and radius > 0
                            and tolerance == F(1, 100) and radius**2 <= tolerance)
                if accepted:
                    # Fixed scope bands; tiny scope cannot claim full coverage.
                    amount = F(3, 10) if radius >= F(1, 10) else F(1, 10) if radius >= F(1, 100) else F(0)
                    self.credit[kind] = max(self.credit.get(kind, F(0)), amount)
                    reason = "Exact residual u^2; rational interval bound proves declared absolute tolerance"
                else:
                    reason = "Residual certificate or fixed-tolerance scope is invalid"
            elif kind in TARGETS:
                dependencies_ready = kind != "composition" or {"square_exact", "product_exact"}.issubset(self.evidence)
                accepted = candidate == TARGETS[kind] and dependencies_ready
                if accepted:
                    self.credit[kind] = WEIGHTS[kind]
                    reason = "Exact polynomial identity; declared composition dependencies available"
                else:
                    reason = "Identity false or composition dependencies missing"
            else:
                raise ValueError("Unknown fixed modeling obligation")
            if accepted and (kind not in self.evidence or self.credit.get(kind, F(0)) > prior_credit):
                self.evidence[kind] = {"expression": expression, "verification": reason}
                if kind == "local":
                    self.evidence[kind].update(radius=str(radius), absoluteTolerance=str(tolerance))
        penalty = F(1, 10) if status == "asserted" and not accepted else F(0)
        after = self.score()
        reward = after - before - cost - penalty
        return dict(kind=kind, expression=expression, status=status, teacherAgrees=teacher_agrees,
                    teacherAgreementUsedAsEvidence=False, accepted=accepted, reason=reason,
                    before=float(before), after=float(after), verifiedGain=float(after - before),
                    cost=float(cost), unsupportedAssertionPenalty=float(penalty), reward=float(reward))


@dataclass
class Route:
    expected_rate: F = F(0)
    missing: set = field(default_factory=set)
    probe_versions: set = field(default_factory=set)
    paused: bool = False

    def feedback(self, verified_gain, cost):
        self.expected_rate = (self.expected_rate + verified_gain / cost) / 2

    def new_tools(self, tools):
        # tools maps verified dependencies to their content/evidence fingerprints.
        version = tuple(sorted((name, tools.get(name)) for name in self.missing))
        if self.paused and self.missing.issubset(tools) and version not in self.probe_versions:
            self.probe_versions.add(version)
            return 1  # One bounded trial; no permanent value increase.
        return 0


def run():
    ledger = Ledger()
    steps = []
    steps.append(ledger.attempt("square_exact", "2*x*u", teacher_agrees=True))
    assert not steps[-1]["accepted"] and steps[-1]["reward"] < 0
    steps.append(ledger.attempt("local", "2*x*u", radius="1/100", tolerance="1/100"))
    assert steps[-1]["accepted"] and steps[-1]["after"] == .1
    steps.append(ledger.attempt("local", "u*x+x*u", radius="1/100", tolerance="1/100"))
    assert steps[-1]["accepted"] and steps[-1]["verifiedGain"] == 0
    steps.append(ledger.attempt("local", "2*x*u", radius="1/10", tolerance="1/100"))
    assert steps[-1]["accepted"] and steps[-1]["verifiedGain"] == .2
    steps.append(ledger.attempt("local", "2*x*u", radius="1/5", tolerance="1/100"))
    assert not steps[-1]["accepted"] and steps[-1]["verifiedGain"] == 0
    steps.append(ledger.attempt("square_exact", "2*x*u+u**2"))
    steps.append(ledger.attempt("product_exact", "x*v+y*u+u*v"))
    composite = "2*x*y*(x*v+y*u+u*v)+(x*v+y*u+u*v)**2"
    steps.append(ledger.attempt("composition", composite))
    assert steps[-1]["accepted"] and steps[-1]["verifiedGain"] == .3
    assert ledger.score() == 1
    blocked = Ledger().attempt("composition", composite)
    assert not blocked["accepted"]
    honest = Ledger().attempt("square_exact", "2*x*u", status="conjecture")
    assert honest["unsupportedAssertionPenalty"] == 0 and honest["verifiedGain"] == 0
    direct = Ledger().attempt("square_exact", "2*x*u+u**2")
    correction = Ledger()
    wrong = correction.attempt("square_exact", "2*x*u")
    fixed = correction.attempt("square_exact", "2*x*u+u**2")
    assert wrong["reward"] + fixed["reward"] < direct["reward"]
    # U differences telescope; deleting then restoring cannot farm net reward.
    farm = Ledger()
    farm.attempt("square_exact", "2*x*u+u**2")
    initial = farm.score()
    farm.credit.pop("square_exact")
    deletion_reward = farm.score() - initial - F(1, 50)
    restored = farm.attempt("square_exact", "2*x*u+u**2")
    assert float(deletion_reward) + restored["reward"] < 0
    # Exact identities checked for all reals; these values are independent smoke examples.
    def evaluate(p, values):
        return sum(c * values[0]**k[0] * values[1]**k[1] * values[2]**k[2] * values[3]**k[3] for k, c in p.items())
    assert evaluate(TARGETS["square_exact"], (1, 0, 1, 0)) == 3
    assert evaluate(poly("2*x*u"), (1, 0, 1, 0)) == 2
    assert evaluate(TARGETS["composition"], (2, 3, 1, -1)) == 0
    route = Route(missing={"product_exact"})
    route.feedback(F(1, 10), F(1, 50))
    rates = [float(route.expected_rate)]
    for _ in range(4):
        route.feedback(F(0), F(1, 50))
        rates.append(float(route.expected_rate))
    assert rates[-1] < rates[0]
    saved_evidence = json.dumps(ledger.evidence, sort_keys=True)
    route.paused = True
    assert saved_evidence == json.dumps(ledger.evidence, sort_keys=True)
    assert route.new_tools({"square_exact": "square-v1"}) == 0
    assert route.new_tools({"square_exact": "square-v1", "product_exact": "product-v1"}) == 1
    assert route.new_tools({"square_exact": "square-v1", "product_exact": "product-v1"}) == 0
    assert route.new_tools({"unrelated": "unrelated-v2", "product_exact": "product-v1"}) == 0
    assert route.new_tools({"product_exact": "product-v2"}) == 1
    # A later narrow valid restatement must not discard the wider range's certificate.
    retained_local = dict(ledger.evidence["local"])
    narrow = ledger.attempt("local", "2*x*u", radius="1/100", tolerance="1/100")
    assert narrow["verifiedGain"] == 0 and ledger.evidence["local"] == retained_local
    # Parser does not execute calls or accept arbitrary names.
    for unsafe in ["f(x)", "x.__class__", "z+x", "x**99"]:
        try:
            poly(unsafe)
        except ValueError:
            pass
        else:
            raise AssertionError("Unsupported expression was accepted")
    return dict(status="dry_run_checks_passed", runnerSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                neuralTrainingUpdates=0, teacherCalls=0,
                studentGeneratedClaims=False, noveltyClaim=False,
                scope="hand-written fixtures; exact finite-domain reward and scheduling checks, not efficacy evidence",
                scoreWeights={k: float(v) for k, v in WEIGHTS.items()}, steps=steps,
                finalVerifiedCoverage=float(ledger.score()), stalledRouteRates=rates,
                checks=["teacher agreement cannot certify a false identity", "valid local model receives partial credit",
                        "equivalent rewording receives zero new truth credit", "wider valid scope increases coverage",
                        "invalid scope enlargement rejected", "verified composition adds a new obligation",
                        "composition without dependencies rejected", "honest conjecture has no false-assertion penalty",
                        "intentional error then repair scores below correct first attempt",
                        "delete/re-add has no positive net reward", "stalling reduces priority without deleting knowledge",
                        "new relevant dependency permits one bounded revisit per evidence fingerprint",
                        "narrow restatement cannot discard broader coverage certificate", "unsupported syntax rejected"])


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path)
    args = p.parse_args()
    result = run()
    if args.out:
        with args.out.open("x", encoding="utf-8") as stream:
            json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
    print(json.dumps({k: result[k] for k in ["status", "neuralTrainingUpdates", "teacherCalls", "studentGeneratedClaims"]}))
    print(f"Checks passed: {len(result['checks'])}. No student-learning result is claimed.")
