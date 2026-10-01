"""Meaningful CPU integration checks with real GPT weights and SentencePiece."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import gpt_probe as probe
import laptop_train as base


def main(source):
    import torch
    import sentencepiece as spm
    import numpy as np
    torch.set_num_threads(2)
    with tempfile.TemporaryDirectory(prefix="lain-probe-test-") as tmp:
        project = Path(tmp)
        shutil.copyfile(source, project / "train_gpt.py")
        data = project / "data"
        data.mkdir()
        corpus = data / "corpus.txt"
        corpus.write_text(("A library has books. Water is liquid. The rule is y = 2*x + 1. "
                           "Explain double then add one. 0 1 2 3 4 5 6 7 8 9.\n") * 100)
        tokenizers = data / "tokenizers"
        tokenizers.mkdir()
        spm.SentencePieceTrainer.train(input=str(corpus), model_prefix=str(tokenizers / "fineweb_1024_bpe"),
                                      vocab_size=64, model_type="bpe", minloglevel=2)
        sp = spm.SentencePieceProcessor(model_file=str(tokenizers / "fineweb_1024_bpe.model"))
        GPT, _ = base.load_gpt(project / "train_gpt.py")
        config = dict(vocab_size=64, num_layers=2, model_dim=32, num_heads=4,
                      num_kv_heads=2, mlp_mult=2, tie_embeddings=True, **probe.DEFAULTS)
        torch.manual_seed(3)
        model = GPT(**config).eval()
        final = project / "final_model.pt"
        torch.save(model.state_dict(), final)
        run = project / "laptop_runs/gpt-laptop-test"
        run.mkdir(parents=True)
        with torch.no_grad():
            model.tok_emb.weight[0, 0] += 0.01
        checkpoint = run / "checkpoint-002.pt"
        torch.save({"model_state_dict": model.state_dict(), "model_config": config}, checkpoint)
        wrong = project / "laptop_runs/gpt-laptop-wrong"
        wrong.mkdir()
        wrong_config = dict(config, vocab_size=19)
        torch.save(GPT(**wrong_config).state_dict(), wrong / "checkpoint-002.pt")
        ignored = project / "laptop_runs/auto-object-ignore"
        ignored.mkdir()
        torch.save(GPT(**wrong_config).state_dict(), ignored / "checkpoint-002.pt")
        tokens = sp.encode(corpus.read_text(), out_type=int)[:1025]
        header = np.zeros(256, dtype="<i4")
        header[:3] = [20240520, 1, len(tokens)]
        shard = data / "fineweb_val_000.bin"
        shard.write_bytes(header.tobytes() + np.asarray(tokens, dtype="<u2").tobytes())

        # A complete execution may write reports, but cannot alter any supplied input.
        before = {str(p): base.file_digest(p) for p in project.rglob("*") if p.is_file()}
        cmd = [sys.executable, str(ROOT / "tools/gpt_probe.py"), "--project", str(project), "--device", "cpu", "--new-tokens", "3"]
        inspected = subprocess.run(cmd + ["--inspect"], capture_output=True, text=True, check=True)
        assert "probe_preflight_ok" in inspected.stdout
        assert not list((project / "laptop_runs").glob("gpt-probe-*"))
        executed = subprocess.run(cmd, capture_output=True, text=True, check=True)
        assert "DONE. Diagnostic only" in executed.stdout
        out = next((project / "laptop_runs").glob("gpt-probe-*"))
        report = json.loads((out / "report.json").read_text())
        assert report["trainingUpdates"] == report["teacherCalls"] == 0
        assert len(report["models"]) == 2
        assert len(report["rejected"]) == 1 and "Vocabulary 19" in report["rejected"][0]["reason"]
        assert all("auto-object" not in r["path"] for r in report["inventory"] + report["rejected"])
        for item in report["models"]:
            assert len(item["generations"]) == 6 and len(item["choices"]) == 4
            assert item["languageEvaluation"]["evaluatedTokens"] == 1024
            assert 0 <= item["choicesCorrect"] <= 4
        assert before == {p: base.file_digest(Path(p)) for p in before}

        # The diagnostic logits match the uploaded GPT's actual CE forward path.
        ids = torch.tensor([tokens[:17]])
        scores = base.logits(model, ids[:, :-1])
        expected_loss = model(ids[:, :-1], ids[:, 1:])
        observed_loss = torch.nn.functional.cross_entropy(scores.reshape(-1, 64), ids[:, 1:].reshape(-1))
        assert torch.allclose(expected_loss, observed_loss)
        model.requires_grad_(False)
        state_before = {k: v.detach().clone() for k, v in model.state_dict().items()}
        prompt = "The rule is y = 2*x + 1. When x = 3, y ="
        scored = probe.score_choice(model, sp, prompt, [" 7", " 6"], 0, torch.device("cpu"))
        prefix, suffix = probe.encode(sp, prompt), probe.encode(sp, " 7")
        # Compare the summed candidate likelihood to successive one-token predictions.
        context, independent = list(prefix), 0.0
        with torch.no_grad():
            for token in suffix:
                lp = torch.log_softmax(base.logits(model, torch.tensor([context]))[0, -1].float(), dim=0)
                independent += float(lp[token])
                context.append(token)
        assert abs(independent - scored["suffixLogLikelihoods"][0]) < 1e-5
        probe.generate(model, sp, prompt, torch.device("cpu"), 3)
        assert all(p.grad is None for p in model.parameters())
        assert all(torch.equal(v, state_before[k]) for k, v in model.state_dict().items())

        # Explicitly requested incompatible files fail, rather than switching checkpoints.
        failed = subprocess.run(cmd + ["--checkpoint", str(wrong / "checkpoint-002.pt")], capture_output=True, text=True)
        assert failed.returncode == 1 and "Vocabulary 19" in failed.stderr
        (project / "train_gpt.py").write_text("raise RuntimeError('should never execute')\n")
        failed = subprocess.run(cmd, capture_output=True, text=True)
        assert failed.returncode == 1 and "differs from the reviewed source" in failed.stderr
        assert "should never execute" not in failed.stderr
        print("PASS: real inference, loader/forward consistency, diagnostic scoring, frozen weights, inventory exclusion, inspect, fail-closed source/checkpoints")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--source", type=Path, required=True)
    main(p.parse_args().source)
