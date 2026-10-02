"""Real tiny Apertus sampling, gradients, cached reads and an end-to-end runner.

Tiny random weights are implementation QA, not the downloaded student's result.
The file-run fixture caps raw generation to three tokens; failures remain real.
No teacher, network, model download or old-file mutation is permitted.
"""
from contextlib import redirect_stdout
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
import zip_discovery_train as train
import zip_interface_warmup as warmup
from zip_discovery_model import DiscoveryPilot, choose, distribution, memory_effect, update_policy
from zip_discovery_protocol import NoteLibrary, RELATIONS, relation_description, verify_relation
from zip_pilot import base_generate, file_digest, load_student
from zip_pilot_model import encode_prompt, state_digest
from zip_pilot_protocol import PROTOCOL, canonical, prompt, tasks, write_json

torch.set_num_threads(2)
torch.manual_seed(1337)
vocab = {word: i for i, word in enumerate(["[UNK]", "[EOS]"]+list("ABCDEFGHIJKLMNOPQRSTUVWXYZ")+
    ["x", "y", "u", "v", "1", "2", "3", "4", "square", "product", "linear", "interaction"])}
raw = Tokenizer(WordLevel(vocab, unk_token="[UNK]"))
raw.pre_tokenizer = Whitespace()
tokenizer = PreTrainedTokenizerFast(tokenizer_object=raw, unk_token="[UNK]", eos_token="[EOS]", pad_token="[EOS]")
tokenizer.chat_template = "{% for message in messages %}{{ message['role'] + ': ' + message['content'] + '\\n' }}{% endfor %}{% if add_generation_prompt %}assistant: {% endif %}"
base = ApertusForCausalLM(ApertusConfig(vocab_size=len(vocab), hidden_size=32, intermediate_size=64,
    num_hidden_layers=2, num_attention_heads=4, num_key_value_heads=2, eos_token_id=1, bos_token_id=None,
    pad_token_id=1, tie_word_embeddings=True, max_position_embeddings=4096, rope_theta=500000.,
    rope_scaling={"rope_type": "linear", "factor": 1.}, attn_implementation="sdpa"))
base.generation_config.eos_token_id = [1]
library = NoteLibrary()
for task, expression in [(tasks("train")[0], "2*x*u+u**2"), (tasks("train")[3], "x*v+y*u+u*v")]:
    library.admit(task, dict(raw=canonical(dict(definition="square linear" if task.family == "square" else "product interaction",
        expression=expression, scope="exact", radius="0.1", status="asserted"))), origin="fixture")
seeds = library.snapshot()
source, target = seeds[1]["id"], seeds[0]["id"]
frozen = state_digest(base)
interface = warmup.InterfaceAdapter(base, tokenizer, rank=8)
with torch.no_grad():
    interface.generation_adapter[-1].weight.normal_(std=.02)
generation_state = {k: v.clone() for k, v in interface.adapter_state().items()}
test_ids = torch.tensor([[vocab["x"], vocab["u"], vocab["y"]]])
with torch.no_grad():
    warmed_logits = interface(test_ids).clone()
interface.close()
torch.manual_seed(1337)
model = DiscoveryPilot(base, tokenizer, seeds, rank=8)
model.install_generation(generation_state)
model.set_memory([source, target])
with torch.no_grad():
    assert torch.equal(warmed_logits, model(test_ids))
assert model.last_read["readPathExecuted"] and not model.last_read["semanticUseProved"]
assert abs(sum(model.last_read["attentionMass"])-1) < 1e-6
initial_learned = {k: v.clone() for k, v in model.learned_state().items()}
optimizer = torch.optim.AdamW(model.parameters_to_train(), lr=.001, weight_decay=0.)
menu = train.options(RELATIONS, relation_description)
initial_action = choose(model, "Check product -> square", menu, memory_ids=[source, target], sample=True)
with torch.no_grad():
    replay = distribution(model, initial_action)
assert abs(float(replay[initial_action["chosenIndex"]])-initial_action["samplingLogProbability"]) < 1e-6
assert memory_effect(model, initial_action)["maxProbabilityDifference"]["off"] == 0
logs = []
for index in range(4):
    action = choose(model, "Check product -> square", menu, memory_ids=[source, target], sample=True)
    verification = verify_relation(library, source, target, action["chosenValue"])
    reward = 1. if verification["accepted"] else (0. if verification.get("skipped") else -.1)
    logs.append(update_policy(model, optimizer, [action], reward=reward, past_baseline=0., enabled=True))
assert any(log["changedParameterTensors"] for log in logs)
assert any(not torch.equal(v, initial_learned[k]) for k, v in model.learned_state().items())
assert any(name.startswith("read_out.") for log in logs for name in log["changedParameterTensors"])
assert any(name.startswith("encoder.") for log in logs for name in log["changedParameterTensors"])
assert memory_effect(model, initial_action)["maxProbabilityDifference"]["off"] > 0
assert state_digest(base) == frozen and all(p.grad is None and not p.requires_grad for p in base.parameters())
# Cached inference must preserve this same live zip-hook path.
model.set_memory([source, target])
cached = base_generate(base, tokenizer, prompt(tasks("train")[0]), 3)
ids = encode_prompt(model, prompt(tasks("train")[0]))
uncached = []
with torch.no_grad():
    for _ in range(3):
        chosen = int(model(ids, keep=1)[0, -1].argmax())
        uncached.append(chosen)
        ids = torch.cat([ids, torch.tensor([[chosen]])], dim=1)
        if chosen == tokenizer.eos_token_id:
            break
assert cached["generatedIds"] == uncached
trained = {k: v.clone() for k, v in model.learned_state().items()}
model.restore_learned(initial_learned)
assert all(torch.equal(v, initial_learned[k]) for k, v in model.learned_state().items())
model.restore_learned(trained)
model.close()

torch.manual_seed(1337)
control = DiscoveryPilot(base, tokenizer, seeds, rank=8)
control.install_generation(generation_state)
assert all(torch.equal(v, initial_learned[k]) for k, v in control.learned_state().items())
optimizer = torch.optim.AdamW(control.parameters_to_train(), lr=.001, weight_decay=0.)
for _ in range(2):
    action = choose(control, "Check product -> square", menu, memory_ids=[source, target], sample=True)
    log = update_policy(control, optimizer, [action], reward=1., past_baseline=.2, enabled=False)
    assert log["gradNorm"] == 0 and not log["changedParameterTensors"]
assert all(torch.equal(v, initial_learned[k]) for k, v in control.learned_state().items())
assert state_digest(base) == frozen
control.close()

with tempfile.TemporaryDirectory(prefix="discovery-training-") as temp:
    root = Path(temp)
    snapshot = root / "student"
    base.save_pretrained(snapshot, safe_serialization=True)
    tokenizer.save_pretrained(snapshot)
    loaded, tok, metadata = load_student(snapshot, "cpu")
    prepared = warmup.InterfaceAdapter(loaded, tok, rank=8)
    prepared.generation_adapter.load_state_dict({k.removeprefix("generation_adapter."): v for k, v in generation_state.items()})
    start = root / "start"
    start.mkdir()
    start.with_suffix(".py").write_text("\n"+(ROOT / "tools/zip_interface_warmup.py").read_text())
    save_file(prepared.adapter_state(), str(start / "interface.safetensors"))
    prepared.close()
    digest = file_digest(start / "interface.safetensors")
    write_json(start / "manifest.json", dict(protocol=PROTOCOL, stage="supervised-interface-and-toy-task-preparation",
        preparationKind="experimental-fork-of-saved-balanced-step-no-new-training", candidateStep=8,
        promotionToDefault=False, rank=8, warmupSourceSha256=file_digest(start.with_suffix(".py")),
        snapshotSha256=metadata["snapshotSha256"]))
    write_json(start / "result.json", dict(updates=20, baseWeightsUnchanged=True, adapterSha256=digest))
    notes = root / "notes"
    notes.mkdir()
    write_json(notes / "manifest.json", dict(warmupRun=str(start), warmupAdapterSha256=digest))
    write_json(notes / "archive.json", dict(protocol="lain-zip-notes-v1", activeNotes=[], pendingDefinitionNotes=seeds,
        baseWeightsUnchanged=True, warmedAdapterUnchanged=True, warmupAdapterSha256=digest))
    protected = {p: file_digest(p) for p in [start / "interface.safetensors", notes / "archive.json"]}
    args = SimpleNamespace(student_path=snapshot, start_run=start, notes_run=notes, out=root / "run",
        device="cpu", episodes=2, max_arm_seconds=60, seed=1337, lr=.0001)
    def capped(base, tok, messages, maximum):
        return base_generate(base, tok, messages, min(maximum, 3))
    def capped_note(model, task, *, inspected=()):
        model.set_memory(list(inspected))
        before = model.read_calls
        output = base_generate(model.base, model.tokenizer, prompt(task), 3)
        from zip_pilot_protocol import verify
        return dict(task={"key": task.key, "split": task.split, "family": task.family, "scale": task.scale},
            output=output, verification=verify(task, output["raw"]), memoryZipIds=list(inspected),
            readCalls=model.read_calls-before, semanticUseProved=False, sftTargetSupplied=False, teacherCalls=0)
    console = io.StringIO()
    with patch.dict(os.environ, {"LAIN_TEACHER_API_KEY": "fixture-secret-not-save"}), \
         patch.object(train, "base_generate", side_effect=capped), \
         patch.object(train, "new_note", side_effect=capped_note), \
         patch("zip_pilot_protocol.Teacher", side_effect=AssertionError("No teacher")), \
         patch("socket.socket.connect", side_effect=AssertionError("No network")), redirect_stdout(console):
        train.run(args)
    result = json.loads((args.out / "result.json").read_text())
    assert result["baseWeightsUnchanged"] and result["previousFilesUnchanged"]
    assert result["teacherCalls"] == result["sftUpdates"] == 0 and not result["finalTestOpened"]
    assert result["commonPrefixComparison"]["episodes"] == 2
    assert result["commonPrefixComparison"]["equalInitialWeights"]
    on, off = result["arms"]
    assert on["initialGrammarEdgeCeiling"] == off["initialGrammarEdgeCeiling"] == 1
    assert all(not n["studentTags"] for arm in [on, off] for n in arm["library"] if n["task"]["family"] == "product")
    assert on["summary"]["optimizerSteps"] == off["summary"]["optimizerSteps"] == 2
    assert on["summary"]["replayForwardBackwardActions"] == off["summary"]["replayForwardBackwardActions"] == 8
    assert off["summary"]["parameterChangingUpdates"] == 0 and not off["changedParameterTensors"]
    assert not on["drafts"][0]["verification"]["accepted"]  # a failed task never gates exploration
    assert all(file_digest(p) == value for p, value in protected.items())
    assert (args.out / "report.html").is_file()
    assert len(list((args.out / "reward-on").glob("checkpoint-*.safetensors"))) == 2
    assert len(list((args.out / "reward-off").glob("brain-*.json"))) == 2
    assert "fixture-secret-not-save" not in console.getvalue()
    for path in args.out.rglob("*.json"):
        assert "fixture-secret-not-save" not in path.read_text()
print("discovery training passed: real categorical sampling/replay, neural read gradients, cached parity, zero-update control, shared weights, checkpoint restore, failed-task exploration and untouched source")
