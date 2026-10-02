"""Actual tiny warmed-adapter restore plus scripted generation/review decisions.

No official weights, external requests, training or quality claims.
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
import zip_generate_notes as notes
from zip_interface_warmup import InterfaceAdapter
from zip_pilot import file_digest, load_student
from zip_pilot_protocol import canonical, fingerprint, tasks, verify, write_json

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

def claim(expression, definition="The change has linear terms and a remainder."):
    return canonical(dict(definition=definition, expression=expression, scope="exact", radius="0.1", status="asserted"))

square, product = tasks("train")[0], tasks("train")[3]
good_square = claim("2*x*u+u**2")
bad_prose_square = claim("2*x*u+u**2", "The order of the order of the highest order.")
good_product = claim("x*v+y*u+u*v")
wrong_product = claim("x*y")

with tempfile.TemporaryDirectory(prefix="zip-notes-test-") as temporary:
    root = Path(temporary)
    snapshot = root / "student"
    base.save_pretrained(snapshot, safe_serialization=True)
    tokenizer.save_pretrained(snapshot)
    loaded, actual_tokenizer, metadata = load_student(snapshot, "cpu")
    adapter = InterfaceAdapter(loaded, actual_tokenizer, rank=8)
    with torch.no_grad():
        adapter.generation_adapter[-1].weight.fill_(0.01)  # distinct, nonzero prepared student
    prepared_state = adapter.adapter_state()
    adapter.close()
    preparation = root / "interface-preparation-fixture"
    preparation.mkdir()
    worker = "\n" + (ROOT / "tools/zip_interface_warmup.py").read_text()
    assert hashlib.sha256(worker.encode()).hexdigest() == notes.WARMUP_WORKER_SHA256
    preparation.with_suffix(".py").write_text(worker)
    save_file(prepared_state, str(preparation / "interface.safetensors"))
    write_json(preparation / "manifest.json", dict(protocol=notes.PROTOCOL,
        stage="supervised-interface-and-toy-task-preparation", rank=8,
        snapshotSha256=metadata["snapshotSha256"], warmupSourceSha256=notes.WARMUP_WORKER_SHA256))
    write_json(preparation / "result.json", dict(updates=12, baseWeightsUnchanged=True,
        adapterSha256=file_digest(preparation / "interface.safetensors")))
    for case, outputs, statuses, expected_active, expected_pending in [
        ("repair", [bad_prose_square, good_square, wrong_product, wrong_product],
         ["NEEDS_REVISION:", "CLEAR:", "CLEAR:", "CLEAR:"], 1, 0),
        ("pending", [bad_prose_square, bad_prose_square, good_product, good_product],
         ["NEEDS_REVISION:"]*4, 0, 2),
        ("already-clear", [good_square, good_product], ["CLEAR:"]*2, 2, 0),
        ("unparseable-status", [good_square, good_square, good_product, good_product],
         ["clear:"]*4, 0, 2),
    ]:
        args = SimpleNamespace(student_path=snapshot, warmup_run=preparation, out=root/case,
            max_new_tokens=128, max_seconds=300, teacher_base_url="https://api.inference.cscs.ch/v1",
            teacher_model="swiss-ai/Apertus-v1.5-8B", teacher_revision="fixture-only")
        calls, reviews = [], []
        class FakeTeacher:
            def __init__(self, *a, **kw):
                assert kw["max_calls"] == 4
                self.calls = 0
            def review(self, task, draft, checked):
                assert task in [square, product] and task.split == "train"
                assert "definitionReviewRequest" in checked
                assert "opinion, not a proof" in checked["definitionReviewRequest"]
                index = len(reviews)
                reviews.append((task, draft, checked))
                self.calls += 1
                critique = dict(assessment=statuses[index]+" fixture opinion", hint="Describe the input/output change.",
                                counterexample="none", scope_note="exact")
                return dict(raw=canonical(critique), critique=critique, cacheHit=False, usage=None,
                            requestHash=fingerprint(dict(task=asdict(task), raw=draft)))
        def generation(actual_base, actual_tokenizer, messages, cap):
            assert cap == 128
            hook = next(iter(actual_base.model.layers[1]._forward_hooks.values()))
            assert torch.equal(hook.__self__.generation_adapter[-1].weight.detach().cpu(),
                               prepared_state["generation_adapter.2.weight"])
            assert all(not p.requires_grad for p in hook.__self__.parameters())
            index = len(calls)
            calls.append(messages)
            return dict(raw=outputs[index], generatedTokens=30)
        console = io.StringIO()
        with patch.dict(os.environ, {"LAIN_TEACHER_API_KEY":"fixture-secret-never-save"}), \
             patch.object(notes, "Teacher", FakeTeacher), patch.object(notes, "base_generate", side_effect=generation), \
             redirect_stdout(console):
            notes.run(args)
        archive = json.loads((args.out / "archive.json").read_text())
        assert len(archive["activeNotes"]) == expected_active
        assert len(archive["pendingDefinitionNotes"]) == expected_pending
        assert archive["studentCalls"] == len(outputs) and archive["teacherNetworkCalls"] == len(statuses)
        assert archive["baseWeightsUnchanged"] and archive["warmedAdapterUnchanged"]
        assert archive["trainingUpdates"] == archive["rewardUpdates"] == 0
        assert not archive["proseCertified"] and not archive["independentDiscovery"]
        assert not archive["finalTestOpened"] and not archive["obsidianChanged"]
        assert archive["notesFingerprint"] == fingerprint(dict(active=archive["activeNotes"], pending=archive["pendingDefinitionNotes"]))
        for note in archive["activeNotes"] + archive["pendingDefinitionNotes"]:
            assert note["formulaCertified"] and not note["definitionCertified"]
            assert note["features"]["degree"] == 2 and note["features"]["learned"] is False
            assert note["trainingDemonstrationsPreviouslySeen"] and not note["independentDiscovery"]
        assert all(n["definitionTeacherStatus"] == "clear" for n in archive["activeNotes"])
        if case == "repair":
            accepted = archive["activeNotes"][0]
            assert accepted["raw"] == good_square and accepted["origin"] == "student-after-teacher-feedback"
            assert accepted["features"]["variables"] == ["x", "u"]
            assert accepted["features"]["termCount"] == 2
            assert archive["records"][1]["selectedNoteId"] is None  # teacher praise cannot admit a wrong formula
        if case == "already-clear":
            assert len(calls) == len(reviews) == 2  # don't risk/waste revision of an already adequate note
        assert "fixture-secret-never-save" not in console.getvalue()
        assert all("fixture-secret-never-save" not in path.read_text() for path in args.out.iterdir() if path.is_file())
        assert not (args.out / "corpus.json").exists()  # cannot silently feed an old raw-base trainer

    preparation.with_suffix(".py").write_text("raise RuntimeError('must never execute')")
    with patch.object(notes, "load_student") as forbidden_load, patch.object(notes, "Teacher") as forbidden_teacher:
        try:
            notes.load_warmup_module(preparation)
            raise AssertionError("Unverified loader cannot execute")
        except ValueError:
            pass
        forbidden_load.assert_not_called()
        forbidden_teacher.assert_not_called()

print("zip note checks passed: actual warmed adapter restored, prose repair/unknown status, wrong formula exclusion, bounded calls, frozen parameters, no keys in artifacts")
