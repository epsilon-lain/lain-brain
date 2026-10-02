"""Check the one-paste launcher, budgets, exact embedded source, and key handling.

Child execution is mocked; actual model/gradient/reload checks are separate.
"""
import ast
from contextlib import redirect_stdout
import hashlib
import io
import os
from pathlib import Path
import subprocess
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
cell = (ROOT / "notebooks/Lain-Interface-Warmup.py").read_text()
tree = ast.parse(cell)
def assigned(name):
    return next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == name for target in node.targets))
worker, expected = assigned("worker"), assigned("expected_tools")
assert worker == "\n" + (ROOT / "tools/zip_interface_warmup.py").read_text()
compile(worker, "embedded-interface-worker", "exec")
assert all(hashlib.sha256((ROOT/"tools"/name).read_bytes()).hexdigest() == checksum
           for name, checksum in expected.items())

with tempfile.TemporaryDirectory(prefix="interface-cell-test-") as temporary:
    root = Path(temporary)
    tools = root / "tools-v2"
    tools.mkdir()
    for name in expected:
        (tools/name).write_bytes((ROOT/"tools"/name).read_bytes())
    student = root/"models/Apertus-v1.1-0.5B-Instruct"
    student.mkdir(parents=True)
    (student/"model.safetensors").write_bytes(b"placeholder-not-loaded")
    python = root/"student-env/bin/python"
    python.parent.mkdir(parents=True)
    python.touch()
    class Location(ast.NodeTransformer):
        def visit_Constant(self, node):
            if node.value == "/mnt/workspace/lain-zip-pilot":
                return ast.copy_location(ast.Constant(str(root)), node)
            return node
    code = compile(ast.fix_missing_locations(Location().visit(ast.parse(cell))), "one-paste-cell", "exec")
    called = []
    def fake_run(args, *, env, check, timeout):
        assert check is True and timeout == 900
        assert args[0] == str(python) and args[1] == "-u"
        assert env["HF_HUB_OFFLINE"] == "1"
        assert env["PYTHONPATH"].startswith(str(tools)+os.pathsep)
        assert "--student-path" in args and str(student) in args
        assert Path(args[2]).read_text() == worker
        called.append((args, env))
        return subprocess.CompletedProcess(args, 0)
    console = io.StringIO()
    with patch.dict(os.environ, {"LAIN_TEACHER_API_KEY": "fixture-secret-never-save"}), \
         patch("subprocess.run", side_effect=fake_run), redirect_stdout(console):
        exec(code, {"__name__": "__main__"})
    assert len(called) == 1 and "--review" in called[0][0]
    assert called[0][1]["LAIN_TEACHER_API_KEY"] == "fixture-secret-never-save"
    assert "fixture-secret-never-save" not in console.getvalue()
    assert all("fixture-secret-never-save" not in path.read_text() for path in root.glob("*.py"))
    with patch.dict(os.environ, {"LAIN_TEACHER_API_KEY": ""}), \
         patch("subprocess.run", side_effect=fake_run), redirect_stdout(io.StringIO()):
        exec(code, {"__name__": "__main__"})
    assert len(called) == 2 and "--review" not in called[1][0]
    assert called[0][0][2] != called[1][0][2]  # unique workers/runs, no overwrite
    (tools/"zip_pilot.py").write_text("corrupted fixture")
    with patch("subprocess.run") as forbidden:
        try:
            exec(code, {"__name__": "__main__"})
            raise AssertionError("Corrupted source must stop before model/teacher work")
        except RuntimeError:
            pass
        forbidden.assert_not_called()
    assert (student/"model.safetensors").read_bytes() == b"placeholder-not-loaded"
print("interface launcher checks passed: exact embedded source, pinned v2 tools, one bounded child, conditional review, no secret in code/output")
