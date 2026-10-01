"""Build a standalone inference diagnostic launcher; no plugin installation."""
import argparse
import base64
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def build(out):
    payload = []
    for name in ("gpt_probe.py", "laptop_train.py", "model-source.sha256"):
        data = (ROOT / "tools" / name).read_bytes()
        payload.append({"name": name, "sha256": hashlib.sha256(data).hexdigest(),
                        "base64": base64.b64encode(data).decode()})
    template = (ROOT / "tools/Probe-LainGPT.template.ps1").read_text()
    result = template.replace("@@PAYLOAD_JSON@@", json.dumps(payload))
    out.write_text(result, encoding="utf-8-sig")
    print(f"Built {out}: {out.stat().st_size} bytes; 3 embedded files; no training or plugin changes")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path, required=True)
    build(p.parse_args().out)
