"""Paired real-optimizer / real-Brain integration, with deliberate audit failures."""
import argparse
import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import compare_train as comparison


def main(source, initial, steps, destination):
    owner = tempfile.TemporaryDirectory(prefix="lain-comparison-test-") if destination is None else None
    base = Path(owner.name) if owner else destination
    base.mkdir(parents=True, exist_ok=True)
    project, vault = base / "project", base / "vault"
    project.mkdir(exist_ok=False)
    (vault / ".obsidian").mkdir(parents=True)
    shutil.copyfile(source, project / "train_gpt.py")
    args = comparison.parser().parse_args(["--project", str(project), "--vault", str(vault), "--device", "cpu",
            "--student-checkpoint", str(initial), "--steps-per-round", str(steps), "--max-seconds", "120", "--brain-timeout", "5"])
    args.inspect = True
    comparison.run(args)
    assert not (project / "laptop_runs").exists(), "Inspect must be read-only"
    args.inspect = False
    original_sha = comparison.loop.file_digest(initial)
    worker = subprocess.Popen(["node", "tests/training-sync-worker.mjs", str(vault)], cwd=ROOT, stdout=subprocess.PIPE, text=True)
    try:
        assert worker.stdout.readline().strip() == "READY"
        out = comparison.run(args)
    finally:
        worker.terminate(); worker.wait(timeout=10)
    result = json.loads((out / "comparison.json").read_text())
    assert result["status"] == "complete" and len(result["pairs"]) == 3
    assert result["plan"]["seeds"] == [1337, 2027, 4099]
    assert result["plan"]["initialCheckpointSha256"] == original_sha == comparison.loop.file_digest(initial)
    history = json.loads((vault / ".obsidian/plugins/lain-brain/training-lab.json").read_text())
    assert len(history["rounds"]) == 12
    assert {r["config"]["mode"] for r in history["rounds"]} == {"baseline", "brain_objects"}
    for r in result["arms"]:
        assert r["updates"] == 2 * steps and len(r["perFunctionAccuracy"]) == 15
        if r["policy"] == "baseline":
            assert r["replayDraws"] == 0 and r["reviewerCheckpointSha256"] is None
            folder = Path(r["path"])
            for index in [1, 2]:
                summary = json.loads((folder / f"feedback-summary-{index:03}.json").read_text())
                assert set(summary["trainingTaskPriority"].values()) == {1}
                assert json.loads((folder / f"replay-{index:03}.tasks.json").read_text()) == []
                assert json.loads((folder / f"evaluation-{index:03}.json").read_text())["reviewerPredictionsOnFixedTrainingContexts"] is None
        else:
            assert r["replayDraws"] == steps * 16, "Every later batch must consume real accepted object-derived examples"
    # A numerically close metric alone cannot establish paired initializations.
    for key in ["round1StateSha256", "initialCheckpointSha256", "dataset", "updates", "before"]:
        tampered = copy.deepcopy(result["arms"])
        tampered[0][key] = "tampered"
        try:
            comparison.paired_result(tampered)
        except ValueError:
            pass
        else:
            raise AssertionError(f"Unmatched {key} must fail closed")
    try:
        comparison.summarize(Path(result["arms"][0]["path"]), 1337, "baseline", 2 * steps + 2, 1)
    except ValueError:
        pass
    else:
        raise AssertionError("Unequal update budget must not become a comparison")
    print(f"PASS: three paired seeds, exact first-round weights, real Brain feedback, zero control replay, audit rejection. Report: {out}")
    if owner:
        owner.cleanup()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--initial", type=Path, required=True)
    parser.add_argument("--steps-per-round", type=int, default=3)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    main(args.source.resolve(), args.initial.resolve(), args.steps_per_round, args.out.resolve() if args.out else None)
