"""Real tiny Apertus and Qwen2 forwards/updates plus exact verifier and local HTTP teacher.

No official pretrained weights, GPU or real Apertus calls. Not a quality test.
"""
from dataclasses import asdict
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch

import torch
from tokenizers import Tokenizer
from tokenizers.models import WordLevel
from tokenizers.pre_tokenizers import Whitespace
from transformers import PreTrainedTokenizerFast, Qwen2Config, Qwen2ForCausalLM, ApertusConfig, ApertusForCausalLM

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from zip_pilot_protocol import Teacher, canonical, fingerprint, prompt, strict_json, tasks, transition, verify, write_json
from zip_pilot_model import ZipPilot, encode_prompt, generate, state_digest, token_logps
import zip_pilot as pilot

torch.set_num_threads(2)


def claim(expression="2*x*u+u**2", scope="exact", radius="0.1", status="asserted"):
    return canonical(dict(definition="The change separates the linear part and the residual.",
                          expression=expression, scope=scope, radius=radius, status=status))


square = tasks("train")[0]
assert verify(square, claim())["score"] == 1
assert verify(square, claim("2*x*u", "local"))["score"] == 0.4
assert verify(square, claim("2*x*u", "local", "0.2"))["score"] == 0.4
assert verify(square, claim("2*x*u", "local", "0.4"))["score"] == 0
assert verify(square, claim("2*x*u", "local", "1e99999999999999"))["score"] == 0
assert verify(square, claim("(x+u)**2-x**2"))["score"] == 0  # copying the question
assert verify(square, claim("u**2"))["score"] == 0
assert not verify(square, claim("__import__('os').getcwd()"))["accepted"]
assert not verify(square, claim("u**8"))["accepted"]
assert not verify(square, claim(status="conjecture"))["asserted"]
assert not verify(square, '{"definition":"x","definition":"y"}')["accepted"]
assert not verify(square, "```json\n" + claim() + "\n```")["accepted"]
first = transition(square, claim("2*x*u", "local"), 0, 10)
second = transition(square, claim(), first["after"], 10)
repeat = transition(square, claim(), second["after"], 10)
assert abs(first["reward"] + second["reward"] - (1 - 0.02*20/256)) < 1e-8
assert repeat["gain"] == 0 and repeat["reward"] < 0
assert not verify(square, claim())["proseCertified"]
assert not verify(square, claim())["teacherAgreementUsed"]
assert {t.key for t in tasks("train")}.isdisjoint({t.key for t in tasks("dev")+tasks("final")})
assert "composition" not in {t.family for t in tasks("train")}


class Handler(BaseHTTPRequestHandler):
    count = 0
    def do_POST(self):
        Handler.count += 1
        assert self.path == "/v1/chat/completions"
        assert self.headers.get("Authorization") == "Bearer fixture-secret"
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        assert payload["max_tokens"] == 256 and payload["temperature"] == 0
        assert "response_format" not in payload
        body = json.dumps(dict(model="fixture-apertus", usage=dict(prompt_tokens=10, completion_tokens=5),
                              choices=[dict(message=dict(content=canonical(dict(
                                  assessment="The expression is wrong.", hint="Check the cross term.",
                                  counterexample="x=1,u=1", scope_note="Only a local model might work."))))])).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass


with tempfile.TemporaryDirectory(prefix="zip-pilot-test-") as temporary:
    root = Path(temporary)
    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with patch.dict(os.environ, {"LAIN_TEACHER_API_KEY": "fixture-secret"}):
            teacher = Teacher(f"http://127.0.0.1:{server.server_port}/v1", "fixture-apertus", "fixture-only", root / "cache", max_calls=1)
            first_review = teacher.review(square, claim("u**2"), verify(square, claim("u**2")))
            cached = teacher.review(square, claim("u**2"), verify(square, claim("u**2")))
            assert teacher.calls == Handler.count == 1 and cached["cacheHit"]
            try:
                teacher.review(square, claim(), verify(square, claim()))
                raise AssertionError("Budget must stop a second network request")
            except RuntimeError:
                pass
            try:
                teacher.review(tasks("dev")[0], claim(), {})
                raise AssertionError("Teacher must not receive development tasks")
            except ValueError:
                pass
        assert "fixture-secret" not in "".join(p.read_text() for p in (root / "cache").glob("*.json"))
        assert first_review["revisionIndependentlyVerified"] is False
    finally:
        server.shutdown()
        server.server_close()
        thread.join(2)

    for architecture, config_class, model_class in [("apertus", ApertusConfig, ApertusForCausalLM), ("qwen2", Qwen2Config, Qwen2ForCausalLM)]:
        root = Path(temporary) / architecture
        root.mkdir()
        raw = Tokenizer(WordLevel({"[UNK]": 0, "[EOS]": 1, "user": 2, "assistant": 3, "x": 4,
                                  "change": 5, "u": 6, "2": 7, "square": 8, "product": 9,
                                  "linear": 10, "residual": 11}, unk_token="[UNK]"))
        raw.pre_tokenizer = Whitespace()
        tokenizer = PreTrainedTokenizerFast(tokenizer_object=raw, unk_token="[UNK]", eos_token="[EOS]", pad_token="[EOS]")
        tokenizer.chat_template = "{% for message in messages %}{{ message['role'] + ': ' + message['content'] + '\n' }}{% endfor %}{% if add_generation_prompt %}assistant: {% endif %}"
        torch.manual_seed(1337)
        base = model_class(config_class(vocab_size=12, hidden_size=32, intermediate_size=64,
            num_hidden_layers=2, num_attention_heads=4, num_key_value_heads=2, eos_token_id=1, bos_token_id=None,
            pad_token_id=1, tie_word_embeddings=True, max_position_embeddings=4096,
            rope_theta=500000.0, rope_scaling={"rope_type":"linear", "factor":1.0}, attn_implementation="sdpa"))
        base.generation_config.eos_token_id = [1]  # Apertus official list form
        assert base.get_input_embeddings().weight is base.get_output_embeddings().weight
        original_base = state_digest(base)
        model = ZipPilot(base, tokenizer, ["square x linear u", "product change residual"], rank=8)
        before = {name: p.detach().clone() for name, p in model.named_parameters() if p.requires_grad}
        ids = encode_prompt(model, prompt(square))
        with torch.no_grad():
            normal = model(ids, keep=1).clone()
            model.ablation = "off"
            off = model(ids, keep=1).clone()
            model.ablation = "shuffle"
            shuffled = model(ids, keep=1).clone()
            model.ablation = "normal"
            assert (normal-off).abs().max() > 1e-8
            assert (normal-shuffled).abs().max() > 1e-10
            a = generate(model, prompt(square), max_new_tokens=3, sample=False)
            full_ids = torch.tensor([a["promptIds"]+a["generatedIds"]])
            full = model(full_ids)
            targets = torch.tensor([a["generatedIds"]])
            direct = full[:, len(a["promptIds"])-1:-1].log_softmax(-1).gather(-1, targets.unsqueeze(-1)).squeeze(-1)
            assert torch.allclose(direct, token_logps(model, a["promptIds"], a["generatedIds"]), atol=1e-6)
        logs = []
        updates = pilot.pilot_updates(model, [(square, claim())], warmup_steps=2, pg_episodes=2,
                                      max_tokens=3, lr=0.001, max_seconds=60, log=logs.append)
        assert updates == 4 and len(logs) == 4
        changed = [name for name, p in model.named_parameters() if p.requires_grad and not torch.equal(before[name], p)]
        for prefix in ["encoder.", "q.", "k.", "v.", "read_out.", "generation_adapter."]:
            assert any(name.startswith(prefix) for name in changed), prefix
        assert state_digest(base) == original_base
        assert all(not p.requires_grad and p.grad is None for p in base.parameters())
        assert all(r["teacherCalls"] == 0 and len(r["trajectory"]) == 2 for r in logs if r["stage"] == "on-policy-progress")
        assert model.read_calls > 0
        model.close()
        # Alternative controls retain their adapter but never invoke zip reading.
        for control in ["none", "text"]:
            other = ZipPilot(deepcopy(base), tokenizer, ["square x linear u", "product change residual"], rank=8, mode=control)
            control_logs = []
            pilot.pilot_updates(other, [(square, claim())], warmup_steps=1, pg_episodes=0,
                                max_tokens=2, lr=0.001, max_seconds=60, log=control_logs.append)
            assert other.read_calls == 0 and len(control_logs) == 1
            assert other.generation_adapter[-1].weight.grad is not None
            assert all(p.grad is None for p in other.encoder.parameters())
            assert state_digest(other.base) == original_base
            other.close()
        # Large or unsupported snapshots stop before loading weight files.
        for config in [ApertusConfig(), dict(model_type="gpt2")]:
            rejected = root / ("large" if isinstance(config, ApertusConfig) else "unsupported")
            rejected.mkdir()
            if isinstance(config, ApertusConfig):
                config.save_pretrained(rejected)
            else:
                write_json(rejected/"config.json", config)
            with patch("transformers.AutoModelForCausalLM.from_pretrained") as forbidden:
                try:
                    pilot.load_student(rejected, "cpu")
                    raise AssertionError("Invalid snapshot cannot allocate weights")
                except ValueError:
                    pass
                forbidden.assert_not_called()
        # Same actual sampled token actions, opposite reward fixture: gradients must
        # reverse. This isolates reward -> parameters without claiming task learning.
        reward_deltas, sampled = [], []
        real_transition = pilot.transition
        for sign in [1, -1]:
            torch.manual_seed(1337)
            paired = ZipPilot(deepcopy(base), tokenizer, ["square x linear u", "product change residual"], rank=8)
            original = {name: p.detach().clone() for name, p in paired.named_parameters() if p.requires_grad}
            reward_logs = []
            def signed_feedback(*args, **kwargs):
                checked = real_transition(*args, **kwargs)
                return dict(checked, reward=float(sign))
            torch.manual_seed(2027)
            with patch.object(pilot, "transition", side_effect=signed_feedback):
                pilot.pilot_updates(paired, [(square, claim())], warmup_steps=0, pg_episodes=1,
                                    max_tokens=2, lr=0.001, max_seconds=60, log=reward_logs.append)
            sampled.append([a["output"]["generatedIds"] for a in reward_logs[0]["trajectory"]])
            reward_deltas.append(torch.cat([(p.detach()-original[name]).flatten() for name,p in paired.named_parameters() if p.requires_grad]))
            assert state_digest(paired.base) == original_base
            paired.close()
        assert sampled[0] == sampled[1]
        assert torch.nn.functional.cosine_similarity(reward_deltas[0], reward_deltas[1], dim=0) < -0.99
        # Full file-backed CLI training, adapter save/reload and frozen final eval.
        snapshot = root / "student"
        base.save_pretrained(snapshot, safe_serialization=True)
        tokenizer.save_pretrained(snapshot)
        corpus_file = root / "corpus.json"
        write_json(corpus_file, dict(protocol="lain-zip-pilot-v1", notes=[dict(task=asdict(square), raw=claim())]))
        args = type("Args", (), dict(corpus=corpus_file, out=root/"run", seed=1337, student_path=snapshot,
            device="cpu", rank=8, mode="zip", warmup_steps=1, pg_episodes=1, max_new_tokens=3, lr=0.001, max_seconds=60))()
        pilot.train(args)
        result = json.loads((args.out/"result.json").read_text())
        assert result["updates"] == 2 and result["baseWeightsUnchanged"] and not result["finalTestOpened"]
        args.run, args.out = args.out, root/"final"
        pilot.final_eval(args)
        final = json.loads((args.out/"final.json").read_text())
        assert len(final["records"]) == 6 and final["teacherCalls"] == final["parameterUpdates"] == 0
        args.out = root/"baseline"
        pilot.baseline(args)
        baseline = json.loads((args.out/"baseline.json").read_text())
        assert baseline["teacherCalls"] == baseline["trainingUpdates"] == 0
        assert len(baseline["records"]) == 4 and not baseline["languageAbilityAutomaticallyCertified"]
        # Teacher-free collection path uses an explicit test double, never disguises
        # hand fixtures as student-generated research results.
        collect_args = type("Args", (), dict(out=root/"collect", student_path=snapshot, device="cpu",
            teacher_base_url="http://localhost/v1", teacher_model="fixture-apertus", teacher_revision="fixture",
            teacher_cache=root/"teacher-cache", teacher_key_env="unused", max_teacher_calls=6,
            max_seconds=60, max_new_tokens=3))()
        collect_args.baseline = root/"fixture-baseline.json"
        write_json(collect_args.baseline, dict(protocol="lain-zip-pilot-v1", formatReady=True,
                   metadata=baseline["metadata"]))
        blocked = root/"failed-baseline.json"
        write_json(blocked, dict(protocol="lain-zip-pilot-v1", formatReady=False))
        collect_args.baseline = blocked
        with patch.object(pilot, "Teacher") as forbidden:
            try:
                pilot.collect(collect_args)
                raise AssertionError("Failed baseline cannot spend teacher calls")
            except ValueError:
                pass
            forbidden.assert_not_called()
        collect_args.baseline = root/"fixture-baseline.json"
        from unittest.mock import MagicMock
        teacher_mock = MagicMock()
        teacher_mock.calls = 0
        teacher_mock.review.return_value = dict(critique=None, cacheHit=True, raw="fixture", usage=None)
        def fixture_output(base, tok, messages, maximum):
            # Valid formula chosen from visible task text for *transport* QA only.
            body = messages[1]["content"]
            a = next(a for a in range(1,4) if f"={a}*" in body)
            expression = f"{2*a}*x*u+{a}*u**2" if "f(x)=" in body else f"{a}*x*v+{a}*y*u+{a}*u*v"
            return dict(raw=claim(expression), generatedTokens=3, generatedIds=[0,0,0], promptTokens=5)
        with patch.object(pilot, "Teacher", return_value=teacher_mock), patch.object(pilot, "base_generate", side_effect=fixture_output):
            pilot.collect(collect_args)
        corpus, notes, examples = pilot.read_corpus(collect_args.out/"corpus.json")
        assert len(notes) == len(examples) == 6 and corpus["trainingUpdates"] == 0
        assert teacher_mock.review.call_count == 6
        bad_corpus = dict(corpus, notes=[dict(task=asdict(tasks("dev")[0]), raw=claim())])
        bad = root/"bad-corpus.json"
        write_json(bad, bad_corpus)
        try:
            pilot.read_corpus(bad)
            raise AssertionError("dev cannot create memory")
        except ValueError:
            pass

print("PASS: exact/local certificates, no repeated gain, teacher cache/budget/split isolation, actual Apertus and Qwen2 zip forwards and all added module gradients, opposite rewards reverse parameter updates, frozen base, two-action policy updates, file-backed reload/final evaluation. Tiny random weights; fixtures are not discoveries.")
