"""Real adapter continuation and unchanged gates with scripted inference.

Tiny local weights only. No official model, real API call, or quality claim.
"""
from contextlib import redirect_stdout
from dataclasses import asdict
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

import torch
from safetensors.torch import save_file
from tokenizers import Tokenizer
from tokenizers.models import WordLevel
from tokenizers.pre_tokenizers import Whitespace
from transformers import ApertusConfig, ApertusForCausalLM, PreTrainedTokenizerFast

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import zip_interface_correction as correction
import zip_interface_warmup as warmup
from zip_pilot import file_digest, load_student
from zip_pilot_protocol import canonical, tasks, verify, write_json

torch.set_num_threads(2)
raw = Tokenizer(WordLevel({"[UNK]":0, "[EOS]":1, "x":2, "u":3, "change":4,
                          "system":5, "assistant":6, "user":7}, unk_token="[UNK]"))
raw.pre_tokenizer = Whitespace()
tokenizer = PreTrainedTokenizerFast(tokenizer_object=raw, unk_token="[UNK]", eos_token="[EOS]", pad_token="[EOS]")
tokenizer.chat_template = "{% for message in messages %}{{ message['role'] + ': ' + message['content'] + '\\n' }}{% endfor %}{% if add_generation_prompt %}assistant: {% endif %}"
torch.manual_seed(1337)
base = ApertusForCausalLM(ApertusConfig(vocab_size=8, hidden_size=32, intermediate_size=64,
    num_hidden_layers=2, num_attention_heads=4, num_key_value_heads=2, eos_token_id=1, bos_token_id=None,
    pad_token_id=1, tie_word_embeddings=True, max_position_embeddings=4096,
    rope_theta=500000.0, rope_scaling={"rope_type":"linear", "factor":1.0}, attn_implementation="sdpa"))
base.generation_config.eos_token_id = [1]
square, product = tasks("train")[0], tasks("train")[3]
good_square = warmup.demonstrations()[0][1]
bad_product = canonical(dict(definition="The change of order.", expression="x*v+u*v+u*v",
                            radius="0.1", scope="exact", status="asserted"))

with tempfile.TemporaryDirectory(prefix="zip-correction-") as temporary:
    root = Path(temporary)
    snapshot = root / "student"
    base.save_pretrained(snapshot, safe_serialization=True)
    tokenizer.save_pretrained(snapshot)
    loaded, tok, metadata = load_student(snapshot, "cpu")
    frozen = warmup.state_digest(loaded)
    adapter = warmup.InterfaceAdapter(loaded, tok, rank=8)
    with torch.no_grad():
        adapter.generation_adapter[-1].weight.fill_(0.01)
    parent_state = {k:v.clone() for k,v in adapter.adapter_state().items()}
    adapter.close()
    parent = root / "interface-parent"
    parent.mkdir()
    loader = "\n" + (ROOT / "tools/zip_interface_warmup.py").read_text()
    parent.with_suffix(".py").write_text(loader)
    save_file(parent_state, str(parent / "interface.safetensors"))
    parent_sha = file_digest(parent / "interface.safetensors")
    write_json(parent / "manifest.json", dict(protocol=warmup.PROTOCOL, stage=correction.STAGE,
        rank=8, snapshotSha256=metadata["snapshotSha256"], warmupSourceSha256=hashlib.sha256(loader.encode()).hexdigest()))
    write_json(parent / "result.json", dict(updates=12, baseWeightsUnchanged=True, adapterSha256=parent_sha))
    archive = dict(protocol="lain-zip-notes-v1", warmupAdapterSha256=parent_sha, records=[])
    for task, draft in [(square, good_square), (product, bad_product)]:
        archive["records"].append(dict(task=asdict(task), candidates=[dict(output=dict(raw=draft),
            verification=dict(accepted=True, score=1),  # intentionally false saved score for product
            teacher=dict(critique=dict(assessment="UNCERTAIN:", hint="Explain the change.",
                counterexample="none", scope_note="exact"), requestHash="fixture-"+task.key))]))
    archive_path = root / "old-archive.json"
    write_json(archive_path, archive)
    generator_path = root / "old-notes.py"
    generator_path.write_text("\n" + (ROOT / "tools/zip_generate_notes.py").read_text())
    generator = correction.load_generator(generator_path)
    examples = correction.correction_examples(warmup, archive, parent_sha)
    assert len(examples) == 4 and all(e["task"]["split"] == "train" for e in examples)
    assert [e["context"] for e in examples] == ["ordinary", "replayed-feedback"]*2
    product_feedback = examples[3]["messages"][-1]["content"]
    assert '"accepted":false' in product_feedback  # mathematical score recomputed
    assert all(e["targetVerification"]["score"] == 1 for e in examples)
    assert all(e["teacherOpinionTreatedAsTruth"] is False for e in examples)
    try:
        correction.correction_examples(warmup, archive, "wrong-adapter")
        raise AssertionError("Feedback from a different starting adapter must fail")
    except ValueError:
        pass
    args = SimpleNamespace(student_path=snapshot, parent_run=parent, archive=archive_path,
        generator=generator_path, out=root/"corrected", notes_out=root/"new-notes", steps=4,
        lr=0.001, max_seconds=60, max_new_tokens=128, teacher_base_url="https://api.inference.cscs.ch/v1",
        teacher_model="swiss-ai/Apertus-v1.5-8B", teacher_revision="fixture-only")
    training_calls = []
    real_loss = warmup.sft_loss
    verified_loader = generator.load_warmup_module(parent)
    def track_loss(model, messages, answer):
        if model.training:
            if not training_calls:
                assert all(torch.equal(parent_state[k], v) for k,v in model.adapter_state().items())
            training_calls.append(messages)
        return real_loss(model, messages, answer)
    def probe(actual_base, tok, messages, cap):
        return dict(raw=good_square, generatedTokens=30)
    class FakeTeacher:
        def __init__(self, *a, **kw):
            assert kw["max_calls"] == 4
            self.calls = 0
        def review(self, task, draft, checked):
            self.calls += 1
            # Deliberately praise a wrong product formula. Gate must still reject it.
            return dict(critique=dict(assessment="CLEAR: fixture", hint="none", counterexample="none",
                scope_note="exact"), raw="fixture", cacheHit=False, requestHash="fixture", usage=None)
    def regenerated(actual_base, tok, messages, cap):
        saved = json.loads((args.out / "result.json").read_text())
        hook = next(iter(actual_base.model.layers[1]._forward_hooks.values()))
        assert warmup.state_digest(actual_base) == frozen
        assert saved["adapterSha256"] != parent_sha
        from safetensors.torch import load_file
        new_state = load_file(str(args.out / "interface.safetensors"))
        assert all(torch.equal(new_state[k],v) for k,v in hook.__self__.adapter_state().items())
        assert all(not p.requires_grad for p in hook.__self__.parameters())
        return dict(raw=bad_product, generatedTokens=30)  # both objects fail unchanged certification
    console = io.StringIO()
    original_load = generator.load_warmup_module
    def load_for_training(run):
        return verified_loader if run == parent else original_load(run)
    with patch.dict(os.environ, {"LAIN_TEACHER_API_KEY":"fixture-key-never-save"}), \
         patch.object(correction, "load_generator", return_value=generator), \
         patch.object(generator, "load_warmup_module", side_effect=load_for_training), \
         patch.object(verified_loader, "sft_loss", side_effect=track_loss), \
         patch.object(correction, "base_generate", side_effect=probe), \
         patch.object(generator, "base_generate", side_effect=regenerated), \
         patch.object(generator, "Teacher", FakeTeacher), redirect_stdout(console):
        correction.run(args)
    result = json.loads((args.out / "result.json").read_text())
    assert result["correctionUpdates"] == 4 and result["cumulativeSupervisedUpdates"] == 16
    assert result["teacherCallsDuringTraining"] == result["rewardUpdates"] == 0
    assert result["fixedTrainingContextLossAfter"][0] < result["fixedTrainingContextLossBefore"][0]
    assert len(training_calls) == 4
    assert "teacherCritique" in training_calls[1][-1]["content"]
    assert len(list(args.out.glob("checkpoint-*.safetensors"))) == 4
    assert file_digest(parent / "interface.safetensors") == parent_sha
    assert args.out.with_suffix(".py").read_bytes() == parent.with_suffix(".py").read_bytes()
    new_archive = json.loads((args.notes_out / "archive.json").read_text())
    assert new_archive["warmupAdapterSha256"] == result["adapterSha256"]
    assert not new_archive["activeNotes"] and not new_archive["pendingDefinitionNotes"]
    assert new_archive["teacherNetworkCalls"] == 4 and new_archive["trainingUpdates"] == 0
    assert "fixture-key-never-save" not in console.getvalue()
    for path in root.rglob("*.json"):
        assert "fixture-key-never-save" not in path.read_text()
    generator_path.write_text("raise AssertionError('unverified source must not execute')")
    try:
        correction.load_generator(generator_path)
        raise AssertionError("Modified installed code cannot execute")
    except ValueError:
        pass
print("correction checks passed: real continuation, feedback contexts, frozen base, new-adapter regeneration and unchanged rejection gates")
