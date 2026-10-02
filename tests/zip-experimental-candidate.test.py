"""Real adapter restoration with scripted outputs; no hosted quality claim."""
import ast
from contextlib import redirect_stdout
from dataclasses import asdict
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

import torch
from safetensors.torch import load_file, save_file
from tokenizers import Tokenizer
from tokenizers.models import WordLevel
from tokenizers.pre_tokenizers import Whitespace
from transformers import ApertusConfig, ApertusForCausalLM, PreTrainedTokenizerFast

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import zip_prepare_experimental_candidate as candidate
import zip_interface_warmup as warmup
from zip_pilot import file_digest, load_student
from zip_pilot_protocol import canonical, tasks, verify, write_json

torch.set_num_threads(2)
torch.manual_seed(1337)
raw = Tokenizer(WordLevel({"[UNK]": 0, "[EOS]": 1, "x": 2, "u": 3}, unk_token="[UNK]"))
raw.pre_tokenizer = Whitespace()
tokenizer = PreTrainedTokenizerFast(tokenizer_object=raw, unk_token="[UNK]", eos_token="[EOS]", pad_token="[EOS]")
tokenizer.chat_template = "{% for message in messages %}{{ message['role'] + ': ' + message['content'] }}{% endfor %}"
base = ApertusForCausalLM(ApertusConfig(vocab_size=4, hidden_size=32, intermediate_size=64,
    num_hidden_layers=2, num_attention_heads=4, num_key_value_heads=2, eos_token_id=1, bos_token_id=None,
    pad_token_id=1, tie_word_embeddings=True, max_position_embeddings=4096,
    rope_theta=500000., rope_scaling={"rope_type": "linear", "factor": 1.}, attn_implementation="sdpa"))


def claim(task, valid=True):
    a = task.scale
    expression = (f"{2*a}*x*u+{a}*u**2" if task.family == "square"
                  else f"{a}*x*v+{a}*y*u+{a}*u*v") if valid else "x"
    return canonical(dict(definition="The change adds separate effects and an interaction.",
        expression=expression, scope="exact", radius="0.1", status="asserted"))


with tempfile.TemporaryDirectory(prefix="zip-candidate-") as temp:
    root = Path(temp)
    snapshot = root / "student"
    base.save_pretrained(snapshot, safe_serialization=True)
    tokenizer.save_pretrained(snapshot)
    loaded, tok, metadata = load_student(snapshot, "cpu")
    adapter = warmup.InterfaceAdapter(loaded, tok, rank=8)
    parent = root / "parent"
    parent.mkdir()
    parent.with_suffix(".py").write_text("\n"+(ROOT / "tools/zip_interface_warmup.py").read_text())
    save_file(adapter.adapter_state(), str(parent / "interface.safetensors"))
    with torch.no_grad():
        adapter.generation_adapter[-1].weight.normal_(std=.03)
    state = {k: v.clone() for k, v in adapter.adapter_state().items()}
    adapter.close()
    parent_sha = file_digest(parent / "interface.safetensors")
    write_json(parent / "manifest.json", dict(protocol=warmup.PROTOCOL,
        stage="supervised-interface-and-toy-task-preparation", rank=8,
        snapshotSha256=metadata["snapshotSha256"], warmupSourceSha256=file_digest(parent.with_suffix(".py"))))
    write_json(parent / "result.json", dict(updates=12, baseWeightsUnchanged=True, adapterSha256=parent_sha))
    source = root / "balanced"
    source.mkdir()
    save_file(load_file(str(parent / "interface.safetensors")), str(source / "interface.safetensors"))
    save_file(state, str(source / "checkpoint-008.safetensors"))
    write_json(source / "manifest.json", dict(protocol=warmup.PROTOCOL, rank=8,
        preparationKind="balanced-formula-weighted-SFT", balancedSourceSha256=candidate.BALANCED_SHA256,
        recoverySourceSha256=candidate.RECOVERY_SHA256, examplesPerOptimizerStep=6,
        snapshotSha256=metadata["snapshotSha256"], parentRun=str(parent), parentAdapterSha256=parent_sha))
    write_json(source / "result.json", dict(baseWeightsUnchanged=True, selectedBalancedUpdate=0,
        attemptedBalancedUpdates=12, adapterSha256=file_digest(source / "interface.safetensors")))
    four = [tasks("train")[0], tasks("train")[3], tasks("dev")[0], tasks("dev")[2]]
    previous = [dict(task=asdict(t), verification=verify(t, claim(t, t.key != "dev-square-4"))) for t in four]
    write_json(source / "validation-008.json", dict(step=8, records=previous, promoted=False))
    recovery_path = root / "recovery.py"
    recovery_path.write_text("\n"+(ROOT / "tools/zip_checkpoint_recovery.py").read_text())
    recovery = candidate.load_recovery(recovery_path)
    generator_path = root / "generator.py"
    generator_path.write_text("\n"+(ROOT / "tools/zip_generate_notes.py").read_text())
    generator = recovery.load_generator(generator_path)
    protected = candidate.protected_files(source, parent)
    assert any(not torch.equal(v, load_file(str(parent / "interface.safetensors"))[k]) for k, v in state.items())
    for mode in ["clear", "pending-bad-revision", "bad-audit"]:
        args = SimpleNamespace(student_path=snapshot, source_run=source, recovery_source=recovery_path,
            generator=generator_path, out=root / mode, notes_out=root / (mode+"-notes"))
        calls = []
        def generate(actual_base, actual_tok, messages, cap, *, audit):
            hook = next(iter(actual_base.model.layers[1]._forward_hooks.values()))
            actual_model = hook.__self__
            assert all(torch.equal(v, state[k]) for k, v in actual_model.adapter_state().items())
            assert all(not p.requires_grad and p.grad is None for p in actual_model.parameters())
            with torch.no_grad():
                assert torch.isfinite(actual_base(torch.tensor([[2, 3]]), use_cache=False).logits).all()
            task = next(t for t in four if t.public()["problem"] in messages[-1]["content"])
            valid = task.key != "dev-square-4"
            if mode == "bad-audit" and task.key == "train-product-1":
                valid = False
            if not audit and mode == "pending-bad-revision" and len([c for c in calls if c == task.key]) == 1:
                valid = False
            return dict(raw=claim(task, valid), generatedTokens=30)
        class TeacherFixture:
            def __init__(self, *a, **kw):
                self.calls = 0
                assert kw["max_calls"] == 4
            def review(self, task, draft, check):
                assert task.split == "train"
                assert check["definitionReviewRequest"] == recovery.REVIEW_REQUEST
                calls.append(task.key)
                self.calls += 1
                # Deliberately praise wrong revisions: math admission must still reject them.
                status = "CLEAR:" if mode == "clear" or not check["accepted"] else "UNCERTAIN:"
                return dict(raw="fixture", critique=dict(assessment=status, hint="Describe the input change.",
                    counterexample="", scope_note=""), cacheHit=False, requestHash="fixture")
        console = io.StringIO()
        with patch.dict(os.environ, {"LAIN_TEACHER_API_KEY": "fixture-secret-not-save"}), \
             patch.object(candidate, "load_recovery", return_value=recovery), \
             patch.object(recovery, "load_generator", return_value=generator), \
             patch.object(recovery, "base_generate", side_effect=lambda *a: generate(*a, audit=True)), \
             patch.object(generator, "base_generate", side_effect=lambda *a: generate(*a, audit=False)), \
             patch.object(generator, "Teacher", TeacherFixture), redirect_stdout(console):
            candidate.run(args)
        result = json.loads((args.out / "result.json").read_text())
        assert result["updates"] == 20 and result["inheritedBalancedExamples"] == 48
        assert result["trainingUpdates"] == result["rewardUpdates"] == result["teacherCallsDuringAudit"] == 0
        assert not result["promotionToDefault"] and not result["hypothesisTested"] and not result["finalTestOpened"]
        assert result["selectedScores"]["dev-square-4"] == 0
        assert all(torch.equal(v, state[k]) for k, v in load_file(str(args.out / "interface.safetensors")).items())
        candidate.check_unchanged(protected)
        if mode == "bad-audit":
            assert not result["teacherEligible"] and not calls and not args.notes_out.exists()
        else:
            assert result["teacherEligible"]
            archive = json.loads((args.notes_out / "archive.json").read_text())
            assert archive["warmupAdapterSha256"] == result["adapterSha256"]
            assert archive["trainingUpdates"] == archive["rewardUpdates"] == 0
            assert all(n["formulaCertified"] for n in archive["activeNotes"]+archive["pendingDefinitionNotes"])
            if mode == "clear":
                assert len(archive["activeNotes"]) == 2 and len(calls) == 2
            else:
                assert not archive["activeNotes"] and len(archive["pendingDefinitionNotes"]) == 2 and len(calls) == 4
        assert "fixture-secret-not-save" not in console.getvalue()
    for path in root.rglob("*.json"):
        assert "fixture-secret-not-save" not in path.read_text()

cell = ast.parse((ROOT / "notebooks/Lain-Prepare-Zip-Experiment.py").read_text())
embedded = next(n.value.value for n in cell.body if isinstance(n, ast.Assign)
    and any(isinstance(t, ast.Name) and t.id == "worker" for t in n.targets))
assert embedded == "\n"+(ROOT / "tools/zip_prepare_experimental_candidate.py").read_text()
assert not any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "input" for n in ast.walk(cell))
print("candidate checks passed: actual frozen step-8 restore, visible dev failure, unchanged default, train-only bounded teacher, bad-formula rejection and pending prose")
