"""Discovery rewards survive failed task completion; graph edges need evidence."""
import json
from pathlib import Path
import re
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from zip_discovery_protocol import DiscoveryLedger, NoteLibrary, diagnostic_edge_ceiling, exploration_tasks, verify_relation
from zip_discovery_report import export_vault, quote_definition, write_report
from zip_pilot_protocol import Task, canonical, tasks

library = NoteLibrary()
def admit(task, expression, definition="Student explanation pending", origin="test-fixture"):
    return library.admit(task, dict(raw=canonical(dict(definition=definition, expression=expression,
        scope="exact", radius="0.1", status="asserted"))), origin=origin)

square, square_admission = admit(tasks("train")[0], "2*x*u+u**2", definition="[[unverified]] <script>bad</script>")
product, product_admission = admit(tasks("train")[3], "x*v+y*u+u*v")
double, double_admission = admit(tasks("train")[1], "4*x*u+2*u**2")
assert all(e["new"] for e in [square_admission, product_admission, double_admission])
assert square["definitionTeacherStatus"] == "unknown" and not square["definitionCertified"]
assert admit(tasks("train")[0], "2*x*u+u*u", definition="Different wording")[1]["new"] is False
alias = Task("renamed-same-square", "train", "square", 1)
assert admit(alias, "2*x*u+u**2")[1]["new"] is False
assert admit(tasks("train")[0], "x*u+u**2")[0] is None
assert len(library.notes) == 3
assert all(t.split == "train" for t in exploration_tasks())
assert all(t.scale not in [4, 5, 6, 7] for t in exploration_tasks())
try:
    admit(tasks("dev")[0], "8*x*u+4*u**2")
    raise AssertionError("Dev objects must never enter exploration")
except ValueError:
    pass

ledger = DiscoveryLedger()
first = ledger.attempt(library, product["id"], square["id"], "diagonal:1",
    episode=1, task_key="unsolved-composition", task_coverage=0)
assert first["discoveryReward"] == 1 and first["newlyDiscovered"]
assert first["currentTaskCoverage"] == 0 and not first["taskScoreUsedForReward"]
again = ledger.attempt(library, product["id"], square["id"], "diagonal:1",
    episode=2, task_key="solved", task_coverage=1)
assert again["discoveryReward"] == 0 and not again["newlyDiscovered"]
scaled = ledger.attempt(library, square["id"], double["id"], "scale:2",
    episode=3, task_key="unsolved", task_coverage=0)
inverse = ledger.attempt(library, double["id"], square["id"], "scale:1/2",
    episode=4, task_key="unsolved", task_coverage=0)
assert scaled["discoveryReward"] == 1 and inverse["discoveryReward"] == 0
wrong = ledger.attempt(library, square["id"], product["id"], "diagonal:1",
    episode=5, task_key="solved", task_coverage=1)
assert wrong["discoveryReward"] == -.1 and not wrong["verification"]["accepted"]
assert not verify_relation(library, square["id"], square["id"], "scale:1")["accepted"]
assert not verify_relation(library, "invented", square["id"], "scale:1")["accepted"]
assert not verify_relation(library, product["id"], square["id"], "scale:1")["accepted"]
assert len(ledger.edges) == 2
assert diagnostic_edge_ceiling(library) == 3 and len(ledger.edges) == 2  # analysis never adds edges
original = product["claim"]["expression"]
product["claim"]["expression"] = "2*x*v+2*y*u+2*u*v"
assert not verify_relation(library, product["id"], double["id"], "diagonal:1")["accepted"]
product["claim"]["expression"] = original
snapshot = library.snapshot()
library.tag(square["id"], "interaction of changes")
assert not snapshot[0]["studentTags"]
assert "[[unverified]]" not in quote_definition(square["claim"]["definition"])

with tempfile.TemporaryDirectory(prefix="discovery-protocol-") as temp:
    root = Path(temp)
    archive = export_vault(root, library, ledger, arm_name="fixture")
    texts = [p.read_text() for p in (root / "obsidian-notes").glob("*.md")]
    links = re.findall(r"\[\[([^\]]+)\]\]", "\n".join(texts))
    assert set(links) == set(library.notes) and "unverified" not in links
    assert all("definition_certified: false" in p.read_text()
        for p in (root / "obsidian-notes").glob("zip-*.md"))
    with zipfile.ZipFile(archive) as contents:
        assert len(contents.namelist()) == 4
        assert all(not name.startswith("/") and ".." not in name for name in contents.namelist())
    data = dict(arms=[], commonPrefixComparison=dict(episodes=0, arms=[]),
        hostile="</script><script>unsafe</script>")
    report = write_report(root, data)
    source = report.read_text()
    payload = re.search(r'<script id="data" type="application/json">(.*?)</script>', source, re.S).group(1)
    assert json.loads(payload) == data and "</script>" not in payload
print("discovery protocol passed: failed-task +1, new-edge-only reward, inverse/wording dedup, exact typed transforms, pending prose, no injected graph links")
