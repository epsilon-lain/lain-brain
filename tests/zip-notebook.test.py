"""Execute default notebook offline; exercise download with a local test double."""
import ast
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
notebook = json.loads((ROOT / "notebooks/Lain-Apertus-Mini-Pilot.ipynb").read_text())
codes = ["".join(c["source"]) for c in notebook["cells"] if c["cell_type"] == "code"]
for source in codes:
    ast.parse(source)
with tempfile.TemporaryDirectory(prefix="zip-notebook-test-") as temporary:
    before = Path.cwd()
    os.chdir(temporary)
    namespace = {}
    real_run = subprocess.run
    calls = []
    def offline_run(command, **kwargs):
        assert command[3] in {"prepare", "preflight"}, command
        calls.append(command[3])
        return real_run(command, **kwargs)
    try:
        with patch("subprocess.run", side_effect=offline_run):
            for source in codes:
                exec(source, namespace)
        assert calls == ["prepare", "preflight"]
        assert not any(namespace[name] for name in
                       ["RUN_DOWNLOAD", "RUN_BASELINE", "RUN_COLLECT", "RUN_TRAIN", "RUN_FINAL"])
        for name, record in namespace["PAYLOAD"].items():
            embedded = base64.b64decode(record["base64"])
            assert embedded == (ROOT / "tools" / name).read_bytes()
            assert hashlib.sha256(embedded).hexdigest() == record["sha256"]
        # Explicit download uses exact revision and an allowlist; no weights or
        # network are requested in this test. Simulate interruption/resumption.
        download_cell = next(s for s in codes if "download_code =" in s)
        namespace["RUN_DOWNLOAD"] = True
        with patch("subprocess.run") as intercepted:
            exec(download_cell, namespace)
        command = intercepted.call_args.args[0]
        assert command[1] == "-c"
        ast.parse(command[2])
        expected = dict(repo_id="swiss-ai/Apertus-v1.1-0.5B-Instruct",
                        revision="a140fd61fb57422c36a26301caea17edee799874")
        for _ in range(2):
            with patch("sys.argv", ["download"] + command[3:]), patch("huggingface_hub.snapshot_download") as download:
                exec(command[2], {})
                options = download.call_args.kwargs
                assert all(options[k] == v for k, v in expected.items())
                assert options["token"] is False and options["max_workers"] == 2
                assert "model.safetensors" in options["allow_patterns"]
                assert not any("*" in name or name.endswith(".py") for name in options["allow_patterns"])
        marker = namespace["STUDENT_PATH"] / "lain-snapshot.json"
        marker.write_text(json.dumps(dict(modelId="other", revision="other")))
        with patch("sys.argv", ["download"] + command[3:]), patch("huggingface_hub.snapshot_download") as download:
            try:
                exec(command[2], {})
                raise AssertionError("Different snapshot must not be mixed in")
            except ValueError:
                pass
            download.assert_not_called()
    finally:
        os.chdir(before)
print("PASS: notebook default is offline/zero inference/zero teacher/zero updates, embedded source hashes match; explicit pinned download/resume tested with a local test double.")
