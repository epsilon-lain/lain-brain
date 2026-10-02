"""Self-contained launcher parity, inherited-key removal and child cancellation."""
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
source = (ROOT / "notebooks/Lain-Discover-And-Learn.py").read_text()
tree = ast.parse(source)
def literal(name):
    return ast.literal_eval(next(n.value for n in tree.body if isinstance(n, ast.Assign)
        and any(isinstance(t, ast.Name) and t.id == name for t in n.targets)))
files, hashes, core_hashes = literal("files"), literal("expected_new"), literal("expected_core")
assert len(files) == 4
for name, content in files.items():
    assert content == (ROOT / "tools" / name).read_text()
    assert hashlib.sha256(content.encode()).hexdigest() == hashes[name]
    compile(content, name, "exec")
for name, digest in core_hashes.items():
    assert hashlib.sha256((ROOT / "tools" / name).read_bytes()).hexdigest() == digest
assert not any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "input" for n in ast.walk(tree))

with tempfile.TemporaryDirectory(prefix="discovery-cell-") as temp:
    root = Path(temp)
    (root / "student-env/bin").mkdir(parents=True)
    (root / "student-env/bin/python").touch()
    (root / "models/Apertus-v1.1-0.5B-Instruct").mkdir(parents=True)
    (root / "models/Apertus-v1.1-0.5B-Instruct/model.safetensors").touch()
    start = root / "zip-experiment-student-0573f301"
    start.mkdir()
    (start / "interface.safetensors").touch()
    (start / "result.json").write_text("{}")
    notes = root / "zip-experiment-notes-0573f301"
    notes.mkdir()
    (notes / "archive.json").write_text("{}")
    core = root / "tools-v2"
    core.mkdir()
    for name in core_hashes:
        (core / name).write_bytes((ROOT / "tools" / name).read_bytes())
    class SubstituteWork(ast.NodeTransformer):
        def visit_Assign(self, node):
            if any(isinstance(t, ast.Name) and t.id == "work" for t in node.targets):
                node.value = ast.Call(func=ast.Name(id="Path", ctx=ast.Load()), args=[ast.Constant(str(root))], keywords=[])
            return node
    code = compile(ast.fix_missing_locations(SubstituteWork().visit(ast.parse(source))), "cell", "exec")
    instances = []
    class ProcessFixture:
        mode = "success"
        def __init__(self, command, *, env):
            self.command, self.env, self.calls, self.terminated, self.killed = command, env, [], False, False
            instances.append(self)
        def wait(self, *, timeout):
            self.calls.append(timeout)
            if len(self.calls) == 1:
                if self.mode == "interrupt": raise KeyboardInterrupt()
                if self.mode == "timeout": raise subprocess.TimeoutExpired(self.command, timeout)
            return 0
        def terminate(self): self.terminated = True
        def kill(self): self.killed = True
    for mode in ["success", "interrupt", "timeout"]:
        ProcessFixture.mode = mode
        console = io.StringIO()
        try:
            with patch.dict(os.environ, {"LAIN_TEACHER_API_KEY": "fixture-secret-not-save"}), \
                 patch("subprocess.Popen", ProcessFixture), redirect_stdout(console):
                exec(code, {"__name__": "notebook"})
            assert mode == "success"
        except (KeyboardInterrupt, subprocess.TimeoutExpired):
            assert mode != "success"
        process = instances[-1]
        assert "LAIN_TEACHER_API_KEY" not in process.env and process.env["HF_HUB_OFFLINE"] == "1"
        assert process.command[process.command.index("--episodes")+1] == "32"
        assert process.command[process.command.index("--max-arm-seconds")+1] == "600"
        assert process.calls[0] == 1800
        assert process.terminated == (mode != "success")
        assert "fixture-secret-not-save" not in console.getvalue()
    assert len(list(root.glob("discovery-tools-*"))) == 3
    for folder in root.glob("discovery-tools-*"):
        assert {p.name for p in folder.iterdir()} == set(files)
        for path in folder.iterdir(): assert path.read_text() == files[path.name]
    (core / "zip_pilot.py").write_text("changed")
    before = len(instances)
    with patch("subprocess.Popen", ProcessFixture):
        try:
            exec(code, {"__name__": "notebook"})
            raise AssertionError("Changed core must block child creation")
        except RuntimeError as error:
            assert "校验未通过" in str(error)
    assert len(instances) == before
print("discovery cell passed: exact embedded sources/pins, no install/key prompt, child key removed, bounded budget, cancelled/timed-out child terminated, changed core blocks launch")
