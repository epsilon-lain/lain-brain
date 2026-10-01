"""Real GPT CPU smoke test. Supply the reviewed, separately licensed model source.

python tests/laptop-train.test.py --source /path/to/train_gpt.py
Requires torch, numpy, sentencepiece, node, and npm ci in this repository.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

import numpy as np
import sentencepiece as spm
import torch
import torch.nn.functional as F

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("laptop_train", ROOT / "tools/laptop_train.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def expect_error(fn, fragment):
    try:
        fn()
    except ValueError as error:
        assert fragment in str(error), str(error)
    else:
        raise AssertionError(f"Expected rejection: {fragment}")


def main(source):
    torch.set_num_threads(1)
    with tempfile.TemporaryDirectory(prefix="lain-gpt-test-") as folder:
        project = Path(folder)
        shutil.copyfile(source, project / "train_gpt.py")
        GPT, _ = runner.load_gpt(project / "train_gpt.py")
        corpus = project / "corpus.txt"
        corpus.write_text(("the small model learns a pattern and predicts another token\n"
                           "a different sentence gives a separate validation example\n") * 32)
        tokenizer_dir = project / "data/tokenizers"
        tokenizer_dir.mkdir(parents=True)
        prefix = tokenizer_dir / "fineweb_1024_bpe"
        spm.SentencePieceTrainer.train(input=str(corpus), model_prefix=str(prefix),
                                      vocab_size=32, model_type="bpe", minloglevel=2,
                                      hard_vocab_limit=False, num_threads=1)
        sp = spm.SentencePieceProcessor(model_file=str(prefix) + ".model")
        data = project / "data/datasets/fineweb10B_sp1024"
        data.mkdir(parents=True)
        for name, sentence in [("train", "the small model learns a pattern "),
                               ("val", "a different sentence gives another example ")]:
            tokens = np.array((sp.encode(sentence) * 40)[:512], dtype="<u2")
            header = np.zeros(256, dtype="<i4")
            header[:3] = [20240520, 1, len(tokens)]
            (data / f"fineweb_{name}_000.bin").write_bytes(header.tobytes() + tokens.tobytes())
        config = dict(vocab_size=sp.vocab_size(), num_layers=2, model_dim=16,
                      num_heads=2, num_kv_heads=1, mlp_mult=2, tie_embeddings=True,
                      tied_embed_init_std=0.005, logit_softcap=30.0,
                      rope_base=10000.0, qk_gain_init=1.5)
        torch.manual_seed(42)
        model = GPT(**config)
        checkpoint = project / "final_model.pt"
        torch.save(model.state_dict(), checkpoint)
        original = {p: runner.file_digest(p) for p in project.rglob("*") if p.is_file()}
        shape = runner.infer_shape(model.state_dict())
        assert all(config[k] == v for k, v in shape.items())
        ids = torch.randint(0, sp.vocab_size(), (1, 16))
        targets = torch.randint(0, sp.vocab_size(), (1, 16))
        native = model(ids, targets)
        scores = runner.logits(model, ids)
        derived = F.cross_entropy(scores.reshape(-1, sp.vocab_size()), targets.reshape(-1))
        torch.testing.assert_close(native, derived)
        changed = ids.clone()
        changed[:, 8:] = (changed[:, 8:] + 1) % sp.vocab_size()
        torch.testing.assert_close(scores[:, :8], runner.logits(model, changed)[:, :8])
        args = runner.parser().parse_args(["--project", str(project), "--device", "cpu",
                                          "--steps", "3", "--round-every", "2",
                                          "--seq-len", "16", "--accum", "1",
                                          "--train-tokens", "256", "--eval-tokens", "256",
                                          "--eval-windows", "2", "--max-seconds", "0"])
        args.inspect = True
        runner.run(args)
        assert not (project / "laptop_runs").exists(), "Inspect must not write results"
        args.inspect = False
        out = runner.run(args)
        records = [json.loads((out / f"round-{n:03}.json").read_text()) for n in [1, 2]]
        assert [r["measurements"]["steps"] for r in records] == [2, 3]
        assert [r["round"] for r in records] == [1, 2]
        for n, record in enumerate(records, 1):
            assert record["student"]["checkpointSha256"] == runner.file_digest(out / f"checkpoint-{n:03}.pt")
            assert record["dataset"]["trainSha256"] == runner.file_digest(out / "train.tokens.u16")
            assert record["dataset"]["evalSha256"] == runner.file_digest(out / "eval.tokens.u16")
            assert len(record["predictions"]) == 4 and record["candidates"] == []
            assert record["config"]["mode"] == "baseline"
        state, saved = runner.load_checkpoint(out / "checkpoint-002.pt")
        assert saved == config
        assert any(not torch.equal(v, state[k]) for k, v in model.state_dict().items()), "Weights must actually update"
        reloaded = GPT(**saved)
        reloaded.load_state_dict(state, strict=True)
        assert torch.isfinite(runner.logits(reloaded, ids)).all()
        assert all(runner.file_digest(p) == sha for p, sha in original.items()), "Inputs must remain unchanged"
        # Run the actual TypeScript Brain parser against the actual Python output.
        subprocess.run(["node", str(ROOT / "tests/laptop-train-import.test.mjs"), str(out)],
                       cwd=ROOT, check=True)
        corrupted = project / "bad.bin"
        corrupted.write_bytes(b"bad header")
        expect_error(lambda: runner.snapshot([corrupted], 10), "Invalid token shard header")
        args.eval_glob = str(data / "fineweb_train_000.bin")
        expect_error(lambda: runner.run(args), "files overlap")
        args.eval_glob = None
        edited = project / "train_gpt.py"
        edited.write_text(edited.read_text() + "\n# unreviewed change\n")
        expect_error(lambda: runner.load_gpt(edited), "differs from the reviewed source")
    print("PASS: actual GPT loss/causality, read-only inspection, 3 weight updates, checkpoint reload, hashes, Brain import, rejected invalid inputs")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    main(parser.parse_args().source)
