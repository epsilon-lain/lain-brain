"""Bounded mathematical objects and a cached Apertus critique transport.

Only polynomial claims are certified. Readable prose and teacher agreement are
not proofs. This pilot does not judge open research or learn task scheduling.
"""
from __future__ import annotations

import ast
from dataclasses import dataclass
from fractions import Fraction as F
import hashlib
import json
import os
from pathlib import Path
import re
import time
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

from research_reward_probe import add, mul, poly

PROTOCOL = "lain-zip-pilot-v1"
SCHEMA = '{"definition":"your short explanation", "expression":"expanded polynomial", "scope":"exact or local", "radius":"0.1", "status":"asserted or conjecture"}'


def canonical(data):
    return json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def fingerprint(data):
    return hashlib.sha256(canonical(data).encode()).hexdigest()


def write_json(path, data):
    with Path(path).open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n")


def strict_json(text):
    """No extracting a convenient JSON fragment, NaNs or duplicate keys."""
    if not isinstance(text, str) or len(text) > 16000:
        raise ValueError("Response must be a bounded JSON string")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate JSON key")
            result[key] = value
        return result
    def bad_constant(value):
        raise ValueError("Non-finite JSON value")
    value = json.loads(text, object_pairs_hook=pairs, parse_constant=bad_constant)
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object")
    return value


@dataclass(frozen=True)
class Task:
    key: str
    split: str
    family: str
    scale: int

    def public(self):
        a = self.scale
        if self.family == "square":
            problem = f"For f(x)={a}*x**2, model f(x+u)-f(x). Give an expanded exact polynomial, or a local approximation valid for every real x and |u|<=radius with absolute error <=1/10."
        elif self.family == "product":
            problem = f"For f(x,y)={a}*x*y, model f(x+u,y+v)-f(x,y) as an expanded exact polynomial."
        else:
            problem = f"For f(x,y)={a}*(x*y)**2, model f(x+u,y+v)-f(x,y) as an expanded exact polynomial."
        return dict(key=self.key, problem=problem)

    def target(self):
        a = poly(str(self.scale))
        expression = {"square": "(x+u)**2-x**2", "product": "(x+u)*(y+v)-x*y",
                      "composition": "((x+u)*(y+v))**2-(x*y)**2"}[self.family]
        return mul(a, poly(expression))


def tasks(split):
    """Public development benchmark. Final split is never sent to the teacher."""
    groups = {"train": (range(1, 4), ("square", "product")),
              "dev": (range(4, 6), ("square", "product")),
              "final": (range(6, 8), ("square", "product", "composition"))}
    values, families = groups[split]
    return [Task(f"{split}-{family}-{a}", split, family, a) for family in families for a in values]


def prompt(task, feedback=None, notes=None):
    messages = [{"role": "system", "content": "Model a mathematical object in your own words. Output only a JSON object using this schema: " + SCHEMA + ". Variables are x,y,u,v. No function calls. Exact formulas must be expanded sums of monomials; restating the original difference is not a model. Mark unsupported guesses as conjecture. Natural-language explanations are reviewed separately."}]
    body = task.public()["problem"]
    if notes:
        body += "\nTraining notes (their formulas have certificates; prose is not certified):\n" + "\n".join(notes)
    if feedback:
        body += "\nEarlier draft and feedback:\n" + canonical(feedback) + "\nProduce your revised model."
    messages.append({"role": "user", "content": body})
    return messages


def expanded(expression):
    """Require expanded monomials so copying the question earns no credit."""
    tree = ast.parse(expression, mode="eval")
    def term(node):
        if isinstance(node, ast.Name):
            return node.id in {"x", "y", "u", "v"}
        if isinstance(node, ast.Constant):
            return type(node.value) is int
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
            return term(node.operand)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mult):
            return term(node.left) and term(node.right)
        return (isinstance(node, ast.BinOp) and isinstance(node.op, ast.Pow)
                and isinstance(node.left, ast.Name) and node.left.id in {"x", "y", "u", "v"}
                and isinstance(node.right, ast.Constant) and type(node.right.value) is int)
    def terms(node):
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub)):
            return terms(node.left) and terms(node.right)
        return term(node)
    return terms(tree.body)


def verify(task, raw):
    result = dict(accepted=False, score=0.0, asserted=True, certificate=None,
                  teacherAgreementUsed=False, proseCertified=False)
    try:
        claim = strict_json(raw)
        if set(claim) != {"definition", "expression", "scope", "radius", "status"}:
            raise ValueError("Schema fields do not match")
        if not all(isinstance(v, str) for v in claim.values()):
            raise ValueError("All claim fields must be strings")
        if not 1 <= len(claim["definition"]) <= 1200:
            raise ValueError("Explanation length is invalid")
        if claim["status"] not in {"asserted", "conjecture"}:
            raise ValueError("Unsupported status")
        result["asserted"] = claim["status"] == "asserted"
        result["claim"] = claim
        candidate = poly(claim["expression"])
        if not expanded(claim["expression"]):
            raise ValueError("Formula must be expanded, not a restatement of the question")
        if not result["asserted"]:
            result["reason"] = "Honest conjecture: not admitted as knowledge"
            return result
        if claim["scope"] == "exact":
            valid = candidate == task.target()
            score = 1.0 if valid else 0.0
            certificate = dict(kind="exact-polynomial-coefficients", claimHash=fingerprint(candidate_repr(candidate)))
        elif claim["scope"] == "local" and task.family == "square":
            if not re.fullmatch(r"[+-]?\d{1,6}(?:\.\d{1,6}|/\d{1,6})?", claim["radius"]):
                raise ValueError("Radius must be a bounded decimal or fraction, not an exponent")
            radius = F(claim["radius"])
            residual = add(task.target(), candidate, -1)
            valid = residual == poly(f"{task.scale}*u**2") and radius > 0
            valid = valid and task.scale * radius**2 <= F(1, 10)
            score = (0.4 if radius >= F(1, 10) else 0.1 if radius >= F(1, 100) else 0.0) if valid else 0.0
            certificate = dict(kind="exact-residual-rational-bound", residual=f"{task.scale}*u**2",
                               radius=str(radius), absoluteTolerance="1/10")
        else:
            raise ValueError("Unsupported scope for this object")
        result.update(accepted=bool(valid), score=score, certificate=certificate if valid else None,
                      reason="Formula and declared scope certified" if valid else "Formula or scope disproved")
    except (ValueError, SyntaxError, TypeError, OverflowError, ZeroDivisionError) as error:
        result["reason"] = str(error)
    return result


def candidate_repr(candidate):
    return [[list(key), str(value)] for key, value in sorted(candidate.items())]


def transition(task, raw, previous, tokens):
    checked = verify(task, raw)
    after = max(previous, checked["score"])
    cost = 0.02 * tokens / 256
    penalty = 0.1 if checked["asserted"] and not checked["accepted"] else 0.0
    return dict(verification=checked, before=previous, after=after,
                gain=after - previous, cost=cost, unsupportedPenalty=penalty,
                reward=after - previous - cost - penalty)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("Teacher redirect rejected; configure the final endpoint")


class Teacher:
    """OpenAI-compatible critique endpoint. Explicit bounded requests only."""
    def __init__(self, base_url, model, revision, cache, *, key_env="LAIN_TEACHER_API_KEY", max_calls=6):
        parts = urlsplit(base_url)
        if (parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password
                or parts.query or parts.fragment or (parts.scheme != "https" and parts.hostname not in {"localhost", "127.0.0.1", "::1"})):
            raise ValueError("Teacher URL must be HTTPS or a local HTTP server, with no URL credentials")
        if "apertus" not in model.lower() or not revision or len(revision) > 128:
            raise ValueError("Declare the Apertus served model and deployment revision")
        if not 1 <= max_calls <= 12:
            raise ValueError("Teacher call budget must be between 1 and 12")
        self.url = base_url.rstrip("/") + "/chat/completions"
        self.model, self.revision = model, revision
        self.key = os.environ.get(key_env, "")
        self.cache = Path(cache)
        self.cache.mkdir(parents=True, exist_ok=True)
        self.calls, self.max_calls = 0, max_calls

    def review(self, task, draft, verification):
        if task.split != "train":
            raise ValueError("Teacher cannot see dev/final tasks")
        request = dict(model=self.model, temperature=0, max_tokens=256, messages=[
            {"role": "system", "content": 'Critique the student model. Output only JSON with four string fields: assessment, hint, counterexample, scope_note. Give one short hint, not a replacement expanded formula. Accept valid local progress even when incomplete. Program certificates check formulas only; teacher approval never certifies truth.'},
            {"role": "user", "content": canonical(dict(object=task.public(), draft=draft, programCheck=verification))}])
        key = fingerprint(dict(protocol=PROTOCOL, url=self.url, declaredRevision=self.revision, request=request))
        path = self.cache / (key + ".json")
        if path.exists():
            cached = json.loads(path.read_text())
            if cached.get("requestHash") != key or cached.get("request") != request:
                raise RuntimeError("Teacher cache mismatch")
            return dict(cached, cacheHit=True)
        if self.calls >= self.max_calls:
            raise RuntimeError("Teacher call budget exhausted")
        headers = {"Content-Type": "application/json"}
        if self.key:
            headers["Authorization"] = "Bearer " + self.key
        started = time.monotonic()
        self.calls += 1
        response = build_opener(NoRedirect()).open(Request(self.url, data=canonical(request).encode(), headers=headers), timeout=45)
        with response:
            data = response.read(262145)
        if len(data) > 262144:
            raise RuntimeError("Teacher response exceeds size bound")
        payload = strict_json(data.decode())
        try:
            content = payload["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as error:
            raise RuntimeError("Teacher did not return chat content") from error
        record = dict(requestHash=key, request=request, declaredRevision=self.revision,
                      revisionIndependentlyVerified=False, returnedModel=payload.get("model"),
                      raw=content, usage=payload.get("usage"), seconds=time.monotonic() - started,
                      cacheHit=False, hintLevel=1, critique=None)
        try:
            critique = strict_json(content)
            if set(critique) != {"assessment", "hint", "counterexample", "scope_note"} or not all(isinstance(v, str) for v in critique.values()):
                raise ValueError("Critique schema mismatch")
            record["critique"] = critique
        except (ValueError, TypeError) as error:
            record["parseError"] = str(error)
        write_json(path, record)
        return record
