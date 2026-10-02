"""Real tiny-model SFT, reload, no-memory/no-reward isolation and honest gating.

No official pretrained weights, external requests or GPU; no quality claims.
"""
from contextlib import redirect_stdout
from copy import deepcopy
from dataclasses import asdict
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

import torch
from tokenizers import Tokenizer
from tokenizers.models import WordLevel
from tokenizers.pre_tokenizers import Whitespace
from transformers import ApertusConfig, ApertusForCausalLM, PreTrainedTokenizerFast

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import zip_interface_warmup as warmup
from zip_pilot_model import state_digest, sft_loss
from zip_pilot_protocol import canonical, prompt, tasks, verify, write_json

torch.set_num_threads(2)
raw = Tokenizer(WordLevel({"[UNK]": 0, "[EOS]": 1, "user": 2, "assistant": 3,
                          "system": 4, "x": 5, "u": 6, "2": 7, "change": 8,
                          "definition": 9, "expression": 10, "radius": 11,
                          "scope": 12, "status": 13}, unk_token="[UNK]"))
raw.pre_tokenizer = Whitespace()
tokenizer = PreTrainedTokenizerFast(tokenizer_object=raw, unk_token="[UNK]", eos_token="[EOS]", pad_token="[EOS]")
tokenizer.chat_template = "{% for message in messages %}{{ message['role'] + ': ' + message['content'] + '\\n' }}{% endfor %}{% if add_generation_prompt %}assistant: {% endif %}"
torch.manual_seed(1337)
base = ApertusForCausalLM(ApertusConfig(vocab_size=14, hidden_size=32, intermediate_size=64,
    num_hidden_layers=2, num_attention_heads=4, num_key_value_heads=2, eos_token_id=1, bos_token_id=None,
    pad_token_id=1, tie_word_embeddings=True, max_position_embeddings=4096,
    rope_theta=500000.0, rope_scaling={"rope_type": "linear", "factor": 1.0}, attn_implementation="sdpa"))
base.generation_config.eos_token_id = [1]
base.eval().requires_grad_(False)
frozen = state_digest(base)
ids = torch.tensor([[2, 5, 6]])
with torch.no_grad():
    original_logits = base(input_ids=ids, use_cache=False).logits.clone()
model = warmup.InterfaceAdapter(base, tokenizer, rank=8)
with torch.no_grad():
    assert torch.equal(original_logits, model(ids))  # zero adapter is an exact initial control
examples = warmup.demonstrations()
assert len(examples) == 6 and {t.split for t, _ in examples} == {"train"}
assert all(verify(t, answer)["score"] == 1 for t, answer in examples)
initial = {k: v.clone() for k, v in model.adapter_state().items()}
logs = []
with torch.no_grad():
    before = float(sft_loss(model, prompt(examples[0][0]), examples[0][1]))
updates, stop_reason = warmup.supervised_updates(model, examples, steps=12, lr=0.001, max_seconds=60, log=logs.append)
with torch.no_grad():
    after = float(sft_loss(model, prompt(examples[0][0]), examples[0][1]))
assert updates == 12 and stop_reason == "requested-updates-complete"
assert all(r["rewardUpdates"] == r["teacherCalls"] == 0 for r in logs)
assert all(r["gradNorm"] > 0 for r in logs)
assert after < before, (before, after)  # fixed example, real forwards/gradients, not a quality assertion
assert state_digest(base) == frozen
assert all(not p.requires_grad and p.grad is None for p in base.parameters())
assert any(not torch.equal(initial[k], v) for k, v in model.adapter_state().items())
assert set(model.adapter_state()) == {"generation_adapter.0.weight", "generation_adapter.0.bias",
                                     "generation_adapter.2.weight", "generation_adapter.2.bias"}
with torch.no_grad():
    trained_logits = model(ids).clone()
assert not torch.equal(original_logits, trained_logits)

with tempfile.TemporaryDirectory(prefix="interface-warmup-test-") as temporary:
    root = Path(temporary)
    from safetensors.torch import save_file
    save_file(model.adapter_state(), str(root / "interface.safetensors"))
    metadata = dict(snapshotSha256={"fixture": "tiny-only"})
    write_json(root / "manifest.json", dict(metadata, protocol=warmup.PROTOCOL,
        stage="supervised-interface-and-toy-task-preparation", rank=8))
    write_json(root / "result.json", dict(adapterSha256=warmup.file_digest(root / "interface.safetensors")))
    restored_base = deepcopy(base)
    # deepcopy retains hooks; remove the copied live adapter callback before attaching another.
    restored_base.model.layers[model.layer_index]._forward_hooks.clear()
    restored = warmup.restore_interface(root, restored_base, tokenizer, metadata)
    try:
        with torch.no_grad():
            assert torch.equal(trained_logits, restored(ids))
        assert state_digest(restored_base) == frozen
        assert set(restored.adapter_state()) == set(model.adapter_state())
    finally:
        restored.close()
    wrong_base = deepcopy(base)
    wrong_base.model.layers[model.layer_index]._forward_hooks.clear()
    try:
        warmup.restore_interface(root, wrong_base, tokenizer, dict(snapshotSha256={"fixture": "wrong"}))
        raise AssertionError("Wrong foundation cannot restore the warmup adapter")
    except ValueError:
        pass
    bad = root / "bad"
    bad.mkdir()
    write_json(bad / "manifest.json", json.loads((root / "manifest.json").read_text()))
    write_json(bad / "result.json", dict(adapterSha256="not-the-checkpoint"))
    (bad / "interface.safetensors").write_bytes((root / "interface.safetensors").read_bytes())
    try:
        warmup.restore_interface(bad, wrong_base, tokenizer, metadata)
        raise AssertionError("Checkpoint hash mismatch cannot restore")
    except ValueError:
        pass

    args = SimpleNamespace(review=True, teacher_base_url="https://api.inference.cscs.ch/v1",
        teacher_model="swiss-ai/Apertus-v1.5-8B", teacher_revision="fixture-only", max_new_tokens=3)
    blocked = root / "blocked"
    blocked.mkdir()
    with patch.object(warmup, "Teacher") as forbidden, patch.object(warmup, "base_generate") as no_generation:
        result = warmup.feedback_after_warmup(model, dict(records=[dict(formatValid=False)]), args, blocked)
        assert result["skipped"] and result["teacherCalls"] == 0
        forbidden.assert_not_called()
        no_generation.assert_not_called()
    feedback_dir = root / "feedback"
    feedback_dir.mkdir()
    task, answer = examples[0]
    initial_item = dict(formatValid=True, output=dict(raw=answer, generatedTokens=20), verification=verify(task, answer))
    class FakeTeacher:
        calls = 1
        def __init__(self, *a, **kw):
            assert kw["max_calls"] == 1
        def review(self, reviewed, draft, check):
            assert reviewed == task and draft == answer and check["score"] == 1
            return dict(critique={"assessment": "Looks correct", "hint": "keep the residual",
                                 "counterexample": "none", "scope_note": "exact"}, raw="fixture", usage=None)
    def revision(actual_base, actual_tokenizer, messages, cap):
        assert actual_base is model.base and actual_tokenizer is tokenizer and cap == 3
        assert len(actual_base.model.layers[model.layer_index]._forward_hooks) == 1
        return dict(raw="```json\n"+answer+"\n```", generatedTokens=3)
    with patch.object(warmup, "Teacher", FakeTeacher), patch.object(warmup, "base_generate", side_effect=revision):
        result = warmup.feedback_after_warmup(model, dict(records=[initial_item]), args, feedback_dir)
        assert result["adapterUsed"] and result["teacherCalls"] == 1
        assert result["revisionTransition"]["verification"]["score"] == 0
        assert result["revisionTransition"]["after"] == 1  # a bad revision cannot erase existing evidence
        assert result["rewardUpdates"] == result["trainingUpdates"] == 0
        assert not result["teacherAnswerLeakageExcluded"]
    assert state_digest(base) == frozen
model.close()
assert len(base.model.layers[model.layer_index]._forward_hooks) == 0

# The same trained generation adapter can start the existing no-memory control.
# This verifies the saved student can be reused instead of silently discarding it.
from zip_pilot_model import ZipPilot
control = ZipPilot(deepcopy(base), tokenizer, [examples[0][1]], rank=8, mode="none")
try:
    control.generation_adapter.load_state_dict(model.generation_adapter.state_dict(), strict=True)
    with torch.no_grad():
        assert torch.equal(trained_logits, control(ids))
    assert control.read_calls == 0
finally:
    control.close()

# File-backed run: actual local model load and gradients, scripted inference
# fixtures to check reports/checkpoints without claiming pretrained quality.
with tempfile.TemporaryDirectory(prefix="interface-run-test-") as temporary:
    root = Path(temporary)
    snapshot = root / "student"
    base.save_pretrained(snapshot, safe_serialization=True)
    tokenizer.save_pretrained(snapshot)
    args = SimpleNamespace(student_path=snapshot, out=root/"run", seed=1337, rank=8,
        steps=2, lr=0.001, max_seconds=60, max_new_tokens=3, review=False)
    answer = examples[0][1]
    fixture_calls = []
    def generation_fixture(actual_base, actual_tokenizer, messages, cap):
        assert len(actual_base.model.layers[1]._forward_hooks) == 1
        fixture_calls.append(messages)
        return dict(raw=answer, generatedTokens=3)
    with patch.object(warmup, "base_generate", side_effect=generation_fixture), \
         patch.object(warmup, "Teacher") as forbidden, redirect_stdout(io.StringIO()):
        warmup.run(args)
        forbidden.assert_not_called()
    result = json.loads((args.out / "result.json").read_text())
    manifest = json.loads((args.out / "manifest.json").read_text())
    assert result["updates"] == 2 and result["baseWeightsUnchanged"]
    assert result["rewardUpdates"] == result["teacherCallsDuringTraining"] == 0
    assert result["archiveChanged"] is False and result["finalTestOpened"] is False
    assert len(fixture_calls) == 6
    assert len(list(args.out.glob("checkpoint-*.safetensors"))) == 2
    assert len(list(args.out.glob("update-*.json"))) == 2
    assert (args.out / "summary.json").is_file()
    assert not (args.out / "archive.json").exists() and not (args.out / "corpus.json").exists()
    actual_base, actual_tokenizer, actual_metadata = warmup.load_student(snapshot, "cpu")
    assert manifest["snapshotSha256"] == actual_metadata["snapshotSha256"]
    restored = warmup.restore_interface(args.out, actual_base, actual_tokenizer, actual_metadata)
    try:
        assert any(torch.count_nonzero(v) > 0 for k,v in restored.adapter_state().items() if ".2." in k)
    finally:
        restored.close()
print(f"warmup checks passed: 12 real tiny-model updates, fixed-example loss {before:.4f}->{after:.4f}, frozen base, exact checkpoint reload, honest feedback gate")
