"""Build one offline, self-contained Windows launcher; run npm build first."""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def build(target):
    sources = {"plugin/main.js": "main.js", "plugin/manifest.json": "manifest.json",
               "tools/auto_train.py": "tools/auto_train.py", "tools/object_train.py": "tools/object_train.py",
               "tools/laptop_train.py": "tools/laptop_train.py", "tools/model-source.sha256": "tools/model-source.sha256",
               "tools/README.md": "AUTO_TRAINING.md", "tools/LICENSE": "LICENSE"}
    manifest = {"schemaVersion": 1, "files": []}
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, source in sources.items():
            data = (ROOT / source).read_bytes()
            archive.writestr(name, data)
            manifest["files"].append({"path": name, "sha256": hashlib.sha256(data).hexdigest()})
        archive.writestr("payload-manifest.json", json.dumps(manifest))
    data = payload.getvalue()
    template = (ROOT / "tools/Start-LainTraining.template.ps1").read_text()
    result = template.replace("@@PAYLOAD_BASE64@@", base64.b64encode(data).decode()).replace(
        "@@PAYLOAD_SHA256@@", hashlib.sha256(data).hexdigest())
    target.write_text(result, encoding="utf-8-sig")  # Windows PowerShell 5 needs BOM for Chinese text.
    print(f"Built {target}: {target.stat().st_size} bytes; embedded {len(manifest['files'])} verified files")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path, required=True)
    build(p.parse_args().out)
