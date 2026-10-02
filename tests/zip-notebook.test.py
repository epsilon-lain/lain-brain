"""Execute default notebook offline; exercise download with a local test double."""
import ast
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
from unittest.mock import patch
from contextlib import redirect_stdout

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
        assert command[1:3] == ["-u", "-c"]
        ast.parse(command[3])
        expected = dict(repo_id="swiss-ai/Apertus-v1.1-0.5B-Instruct",
                        revision="a140fd61fb57422c36a26301caea17edee799874")
        destination = namespace["STUDENT_PATH"]
        arguments = ["download"] + command[4:]

        # A successful helper return with only a pre-created identity marker
        # reproduced the real offline fallback: it must not report completion.
        output = io.StringIO()
        with patch("sys.argv", arguments), patch("huggingface_hub.snapshot_download", return_value=str(destination)), redirect_stdout(output):
            try:
                exec(command[3], {})
                raise AssertionError("An empty cached directory must not be accepted")
            except ValueError as error:
                assert "缺少文件" in str(error)
        assert "Verified" not in output.getvalue()
        assert (destination / "lain-snapshot.json").is_file()

        tree = ast.parse(command[3])
        manifest_node = next(node for node in tree.body if isinstance(node, ast.Assign)
                             and any(isinstance(target, ast.Name) and target.id == "EXPECTED_FILES"
                                     for target in node.targets))
        official = ast.literal_eval(manifest_node.value)
        assert len(official) == 7 and all(record["size"] > 0 for record in official.values())
        assert official["model.safetensors"] == dict(size=1145165288,
            sha256="b7fda2f3e6a47bc00de20f88f38ab52fb2d1df68bf9b4c0016a99dd4d2aa8b3d")
        # Exercise the same verification code with small hashed fixtures rather
        # than allocating a real 1.15 GB checkpoint or mocking away verification.
        fixtures = {name: ("fixture:" + name).encode() for name in official}
        fixture_manifest = {}
        for name, data in fixtures.items():
            if "sha256" in official[name]:
                record = dict(size=len(data), sha256=hashlib.sha256(data).hexdigest())
            else:
                blob = ("blob " + str(len(data))).encode() + bytes([0]) + data
                record = dict(size=len(data), gitSha1=hashlib.sha1(blob).hexdigest())
            fixture_manifest[name] = record
        manifest_node.value = ast.parse(repr(fixture_manifest), mode="eval").body
        fixture_code = compile(ast.fix_missing_locations(tree), "download-fixture", "exec")

        def populate(**options):
            for name, data in fixtures.items():
                (destination / name).write_bytes(data)
            return str(destination)

        for iteration in range(2):
            effect = populate if iteration == 0 else None
            with patch("sys.argv", arguments), patch("huggingface_hub.snapshot_download", side_effect=effect,
                                                       return_value=str(destination)) as download:
                exec(fixture_code, {})
                options = download.call_args.kwargs
                assert all(options[k] == v for k, v in expected.items())
                assert options["token"] is False and options["max_workers"] == 2
                assert options["endpoint"] == "https://huggingface.co"
                assert "model.safetensors" in options["allow_patterns"]
                assert not any("*" in name or name.endswith(".py") for name in options["allow_patterns"])

        # Existing nonempty but truncated, missing, and same-size corrupted
        # files are all rejected even when snapshot_download returns normally.
        for name, replacement, message in [("model.safetensors", b"version https://git-lfs.github.com/spec/v1", "大小"),
                                           ("config.json", b"X" * len(fixtures["config.json"]), "哈希"),
                                           ("chat_template.jinja", None, "缺少文件")]:
            populate()
            if replacement is None:
                (destination / name).unlink()
            else:
                (destination / name).write_bytes(replacement)
            output = io.StringIO()
            with patch("sys.argv", arguments), patch("huggingface_hub.snapshot_download", return_value=str(destination)), redirect_stdout(output):
                try:
                    exec(fixture_code, {})
                    raise AssertionError("Incomplete or corrupt cache must not be accepted")
                except ValueError as error:
                    assert message in str(error)
            assert "Verified" not in output.getvalue()
        populate()
        mirror_arguments = arguments[:-1] + ["https://hf-mirror.com"]
        with patch("sys.argv", mirror_arguments), patch("huggingface_hub.snapshot_download", return_value=str(destination)) as download:
            exec(fixture_code, {})
            assert download.call_args.kwargs["endpoint"] == "https://hf-mirror.com"
            assert download.call_args.kwargs["token"] is False
        namespace["DOWNLOAD_ENDPOINT"] = "https://hf-mirror.com"
        namespace["PY"] = "/fixture/student-env/bin/python"
        with patch("subprocess.run") as intercepted:
            exec(download_cell, namespace)
        assert intercepted.call_args.args[0][0] == namespace["PY"]
        assert intercepted.call_args.kwargs["env"]["HF_HUB_DISABLE_IMPLICIT_TOKEN"] == "1"
        assert intercepted.call_args.kwargs["env"]["HF_HUB_DISABLE_XET"] == "1"
        marker = namespace["STUDENT_PATH"] / "lain-snapshot.json"
        marker.write_text(json.dumps(dict(modelId="other", revision="other")))
        with patch("sys.argv", arguments), patch("huggingface_hub.snapshot_download") as download:
            try:
                exec(command[3], {})
                raise AssertionError("Different snapshot must not be mixed in")
            except ValueError:
                pass
            download.assert_not_called()
    finally:
        os.chdir(before)
print("PASS: notebook default is offline/zero inference/zero teacher/zero updates; pinned download rejects empty/partial/corrupt cache and verifies complete fixtures before reporting success.")
