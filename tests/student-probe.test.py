"""Actual tiny Qwen2 loader/generation test; no model download or quality claim."""
import argparse
import importlib.util
import json
from pathlib import Path
import tempfile
from unittest.mock import patch

import torch
from tokenizers import Tokenizer
from tokenizers.models import WordLevel
from tokenizers.pre_tokenizers import Whitespace
from transformers import AutoModelForCausalLM, AutoTokenizer, PreTrainedTokenizerFast, Qwen2Config, Qwen2ForCausalLM

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("student_probe", ROOT / "tools/student_probe.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


with tempfile.TemporaryDirectory(prefix="student-probe-test-") as temporary:
    root = Path(temporary)
    snapshot = root / "snapshot"
    snapshot.mkdir()
    project = root / "project"
    project.mkdir()
    old = project / "final_model.pt"
    old.write_bytes(b"existing checkpoint must remain unchanged")
    raw = Tokenizer(WordLevel({"[UNK]": 0, "[EOS]": 1, "user": 2, "assistant": 3,
                               "Explain": 4, "library": 5, "is": 6, "a": 7}, unk_token="[UNK]"))
    raw.pre_tokenizer = Whitespace()
    tokenizer = PreTrainedTokenizerFast(tokenizer_object=raw, unk_token="[UNK]", eos_token="[EOS]", pad_token="[EOS]")
    tokenizer.chat_template = "{% for message in messages %}{{ message['role'] + ': ' + message['content'] + '\n' }}{% endfor %}{% if add_generation_prompt %}assistant: {% endif %}"
    tokenizer.save_pretrained(snapshot)
    torch.manual_seed(1)
    model = Qwen2ForCausalLM(Qwen2Config(vocab_size=8, hidden_size=16, intermediate_size=32,
                                        num_hidden_layers=2, num_attention_heads=2,
                                        num_key_value_heads=1, bos_token_id=None, eos_token_id=1))
    model.save_pretrained(snapshot, safe_serialization=True)
    for name in ["merges.txt", "vocab.json", "LICENSE"]:
        (snapshot / name).write_text("fixture file; not real pretrained model", encoding="utf-8")
    hashes = {p.name: probe.digest(p) for p in snapshot.iterdir()}
    old_hash = probe.digest(old)
    args = argparse.Namespace(project=project, cache=root / "cache", device="cpu", offline=True,
                              install_deps=False, max_new_tokens=3)
    with patch("huggingface_hub.snapshot_download", return_value=str(snapshot)) as fetch:
        probe.run(args)
        assert fetch.call_args.args == (probe.MODEL_ID,)
        assert fetch.call_args.kwargs["revision"] == probe.REVISION
        assert fetch.call_args.kwargs["token"] is False
        assert fetch.call_args.kwargs["local_files_only"] is True
        assert fetch.call_args.kwargs["allow_patterns"] == probe.FILES
    reports = list((project / "student_runs").glob("*/report.json"))
    assert len(reports) == 1
    report = json.loads(reports[0].read_text())
    assert report["trainingUpdates"] == report["teacherCalls"] == 0
    assert not report["zipImplemented"]
    assert len(report["outputs"]) == 6
    assert all(0 < item["generatedTokens"] <= 3 for item in report["outputs"])
    assert {p.name: probe.digest(p) for p in snapshot.iterdir()} == hashes
    assert probe.digest(old) == old_hash
    assert reports[0].with_suffix(".md").is_file()
    direct = AutoModelForCausalLM.from_pretrained(snapshot, local_files_only=True, use_safetensors=True,
                                                 attn_implementation="eager")
    loaded_tokenizer = AutoTokenizer.from_pretrained(snapshot, local_files_only=True)
    original = {name: value.clone() for name, value in direct.state_dict().items()}
    out = root / "direct"
    out.mkdir()
    probe.probe(direct, loaded_tokenizer, out, dict(modelId="tiny-test", revision="fixture", dtype="float32"), "cpu", 2)
    assert all(torch.equal(value, original[name]) for name, value in direct.state_dict().items())
    assert all(not p.requires_grad and p.grad is None for p in direct.parameters())
print("PASS: tiny Qwen2 actual loader/chat/generation; reports; zero updates; unchanged weights/files; anonymous pinned download request")
