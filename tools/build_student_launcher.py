"""Build the standalone pretrained student inference launcher."""
import argparse
import base64
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def build(out):
    data = (ROOT / "student_probe.py").read_bytes()
    payload = dict(name="student_probe.py", sha256=hashlib.sha256(data).hexdigest(),
                   base64=base64.b64encode(data).decode())
    template = (ROOT / "Probe-LainStudent.template.ps1").read_text()
    out.write_text(template.replace("@@PAYLOAD_JSON@@", json.dumps(payload)), encoding="utf-8-sig")
    print(f"Built {out}: {out.stat().st_size} bytes")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", required=True, type=Path)
    build(p.parse_args().out)
