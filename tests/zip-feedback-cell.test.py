"""Exercise the pasted worker with controlled student/teacher outputs, offline.

This checks honest grading and records, not pretrained Apertus quality. Existing
pilot tests cover the model loader and actual local HTTP teacher transport.
"""
import ast
from contextlib import redirect_stdout
from dataclasses import asdict
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import zip_pilot as pilot
import zip_pilot_protocol as protocol

cell = (ROOT / "notebooks/Lain-First-Feedback-Loop.py").read_text()
tree = ast.parse(cell)
worker = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
              and any(isinstance(target, ast.Name) and target.id == "worker" for target in node.targets))
compile(worker, "feedback-worker", "exec")

def claim(expression, scope="exact"):
    return protocol.canonical(dict(definition="A linear part and its residual.", expression=expression,
        scope=scope, radius="0.1", status="asserted"))

for revised_raw, teacher_valid, expected_score in [
        (claim("2*x*u", "local"), True, 0.4),
        (claim("u**2"), True, 0.0),
        ("```json\n" + claim("2*x*u+u**2") + "\n```", False, 0.0)]:
    with tempfile.TemporaryDirectory() as temporary:
        out = Path(temporary) / "feedback-loop-fixture"
        out.mkdir()
        outputs = [dict(raw=claim("u**2"), generatedTokens=20),
                   dict(raw=revised_raw, generatedTokens=30)]
        seen = []
        class FakeTeacher:
            def __init__(self, url, model, revision, cache, *, max_calls):
                assert url == "https://api.inference.cscs.ch/v1"
                assert model == "swiss-ai/Apertus-v1.5-8B" and max_calls == 1
                assert "unknown" in revision
                self.calls = 0
            def review(self, task, draft, verification):
                assert task == protocol.tasks("train")[0]
                assert draft == outputs[0]["raw"] and verification["score"] == 0
                self.calls += 1
                # Teacher agreement must never turn the wrong draft into a certificate.
                critique = dict(assessment="Looks correct", hint="Check the cross term",
                                counterexample="x=1,u=1", scope_note="local") if teacher_valid else None
                return dict(raw="fixture teacher", critique=critique, usage=None, cacheHit=False)
        def generate(model, tokenizer, messages, max_tokens):
            assert max_tokens == 128
            seen.append(messages)
            return outputs[len(seen)-1]
        output = io.StringIO()
        with patch.object(pilot, "load_student", return_value=(object(), object(), {"fixture": True})) as load, \
             patch.object(pilot, "base_generate", side_effect=generate), \
             patch.object(protocol, "Teacher", FakeTeacher), \
             patch.object(sys, "argv", ["worker", str(ROOT / "tools"), "fixture-student", str(out)]), \
             patch.dict(os.environ, {"LAIN_TEACHER_API_KEY": "fixture-secret-never-record"}), \
             redirect_stdout(output):
            exec(compile(worker, "feedback-worker", "exec"), {"__name__": "__main__"})
        load.assert_called_once_with(Path("fixture-student"), "cpu")
        report = json.loads((out / "report.json").read_text())
        assert report["task"] == asdict(protocol.tasks("train")[0])
        assert report["initialTransition"]["verification"]["score"] == 0
        assert report["revisionTransition"]["verification"]["score"] == expected_score
        assert report["revisionTransition"]["gain"] == expected_score
        assert report["teacherCalls"] == 1 and report["studentCalls"] == 2
        assert report["trainingUpdates"] == 0 and report["archiveChanged"] is False
        assert report["teacherAgreementUsed"] is False
        assert report["revision"]["raw"] == revised_raw
        assert ("teacherCritique" in seen[1][-1]["content"]) is teacher_valid
        assert {p.name for p in out.iterdir()} == {"initial.json", "manifest.json", "teacher.json", "report.json"}
        assert "fixture-secret-never-record" not in output.getvalue()
        assert all("fixture-secret-never-record" not in p.read_text() for p in out.iterdir())
print("feedback cell offline checks passed: genuine partial progress, wrong claims, malformed outputs, no updates, no key in artifacts")
