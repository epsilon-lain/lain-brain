"""Student-language policy with discrete inspection actions and real zip reads.

The action vocabulary is finite. Probabilities are the student's next-token
logits normalized over one-token menu labels; replay uses that same policy.
Free note text is greedy language generation, not a separate SFT target.
"""
from __future__ import annotations

import copy
import random

import torch

from zip_discovery_protocol import note_text
from zip_pilot_model import ZipPilot, encode_prompt
from zip_pilot_protocol import canonical


class DiscoveryPilot(ZipPilot):
    def __init__(self, base, tokenizer, notes, *, rank=32):
        super().__init__(base, tokenizer, [note_text(n) for n in notes], rank=rank, mode="zip")
        # Introducing untrained memory must initially preserve the actual warmed
        # generation function. A nonzero discovery gradient learns the read path.
        torch.nn.init.zeros_(self.read_out.weight)
        self.memory_ids = []
        self.embedding_cache = {}
        self.last_read = None
        self.note_lookup = {n["id"]: n for n in notes}
        self.labels = []
        used = set()
        for label in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
            ids = tokenizer(label, add_special_tokens=False)["input_ids"]
            if (len(ids) == 1 and ids[0] not in used
                    and ids[0] != tokenizer.unk_token_id and ids[0] != tokenizer.eos_token_id):
                self.labels.append((label, ids[0]))
                used.add(ids[0])
        if len(self.labels) < 15:
            self.close()
            raise ValueError("Need at least fifteen distinct one-token choice labels; no format-training fallback")
        self.set_memory([])

    def install_generation(self, state):
        expected = self.generation_adapter.state_dict()
        state = {k.removeprefix("generation_adapter."): v for k, v in state.items()}
        if (set(state) != set(expected)
                or any(state[k].shape != expected[k].shape or not torch.isfinite(state[k]).all() for k in state)):
            raise ValueError("Saved generation adapter differs from this student")
        self.generation_adapter.load_state_dict(state, strict=True)

    def set_memory(self, ids, *, ablation="normal"):
        if ablation not in {"normal", "off", "shuffle"} or len(ids) > 2 or len(set(ids)) != len(ids):
            raise ValueError("Need zero, one or two distinct inspected zip notes")
        self.memory_ids, self.ablation = list(ids), ablation
        self.notes = [note_text(self.note_lookup[i]) for i in ids]
        pooled = []
        device = next(self.base.parameters()).device
        for identity, text in zip(ids, self.notes):
            if identity not in self.embedding_cache:
                tokens = self.tokenizer(text, add_special_tokens=False, return_tensors="pt")["input_ids"].to(device)
                if not 1 <= tokens.shape[1] <= 256:
                    raise ValueError("Inspected zip exceeds 256 tokens; no silent truncation")
                with torch.no_grad():
                    self.embedding_cache[identity] = self.base.get_input_embeddings()(tokens).float().mean(1)[0]
            pooled.append(self.embedding_cache[identity])
        self.note_embeddings = torch.stack(pooled) if pooled else torch.empty(
            0, self.base.config.hidden_size, device=device)
        self.last_read = None

    def _read(self, module, args, output):
        hidden = output[0] if isinstance(output, tuple) else output
        h = hidden.float()
        delta = self.generation_adapter(h)
        if self.memory_ids and self.ablation != "off":
            memory = self.encoder(self.note_embeddings).reshape(-1, hidden.shape[-1])
            keys = torch.nn.functional.normalize(self.k(memory), dim=-1)
            values = self.v(memory)
            if self.ablation == "shuffle":
                values = values.reshape(len(self.notes), self.slots, -1).roll(1, 0).reshape(-1, self.rank)
            queries = torch.nn.functional.normalize(self.q(h), dim=-1)
            weights = (queries @ keys.T * self.rank**.5).softmax(-1)
            delta = delta + self.read_out(weights @ values)
            self.read_calls += 1
            mass = weights[:, -1, :].detach().mean(0).reshape(len(self.notes), self.slots).sum(-1)
            self.last_read = dict(zipIds=list(self.memory_ids), attentionMass=mass.cpu().tolist(),
                ablation=self.ablation, readPathExecuted=True,
                semanticUseProved=False)  # attention/hook execution alone is not proof
        result = hidden + delta.to(hidden.dtype)
        return (result,)+output[1:] if isinstance(output, tuple) else result

    def learned_state(self):
        return {k: v.detach().cpu().contiguous() for k, v in self.state_dict().items()
                if not k.startswith("base.") and k != "note_embeddings"}

    def restore_learned(self, stored):
        expected = self.learned_state()
        if set(expected) != set(stored) or any(
                stored[k].shape != expected[k].shape or stored[k].dtype != expected[k].dtype
                or not torch.isfinite(stored[k]).all() for k in expected):
            raise ValueError("Discovery checkpoint keys/shapes/dtypes differ")
        incompatible = self.load_state_dict(stored, strict=False)
        if incompatible.unexpected_keys or any(
                not k.startswith("base.") and k != "note_embeddings" for k in incompatible.missing_keys):
            raise ValueError("Discovery checkpoint has missing learned state")


def choice_messages(question, options, labels):
    return [{"role": "system", "content":
        "Explore relationships between mathematical objects. Choose exactly one displayed letter. "
        "You may be unsure. New verified connections have value even if the current problem stays unsolved. "
        "Student labels and natural-language definitions may be imperfect; no teacher truth is implied."},
        {"role": "user", "content": question+"\n"+"\n".join(
            f"{labels[i][0]}: {option['description']}" for i, option in enumerate(options))}]


def distribution(model, action):
    model.set_memory(action["memoryIds"], ablation=action.get("ablation", "normal"))
    device = next(model.parameters()).device
    ids = torch.tensor([action["promptIds"]], device=device)
    logits = model(ids, keep=1)[0, -1].float()
    allowed = torch.tensor(action["allowedTokenIds"], device=device)
    return (logits[allowed] / action["temperature"]).log_softmax(-1)


def choose(model, question, options, *, memory_ids=(), sample=True, rng=None, temperature=1.0):
    if not 1 <= len(options) <= len(model.labels) or not .5 <= temperature <= 2:
        raise ValueError("Choice menu/temperature exceeds finite policy bounds")
    if len(set(canonical(o["value"]) for o in options)) != len(options):
        raise ValueError("Choice values must be unique")
    options = copy.deepcopy(options)
    if rng is not None:
        rng.shuffle(options)
    labels = model.labels[:len(options)]
    messages = choice_messages(question, options, labels)
    ids = encode_prompt(model, messages, max_prompt=2048)[0].tolist()
    action = dict(messages=messages, promptIds=ids, allowedTokenIds=[t for _, t in labels],
        options=options, memoryIds=list(memory_ids), temperature=temperature, ablation="normal")
    model.eval()
    with torch.no_grad():
        logps = distribution(model, action)
        index = int(torch.multinomial(logps.exp(), 1)) if sample else int(logps.argmax())
    action.update(chosenIndex=index, chosenValue=options[index]["value"], chosenLabel=labels[index][0],
        sampled=sample, samplingLogProbability=float(logps[index]),
        choiceProbabilities=logps.exp().cpu().tolist(), readTrace=copy.deepcopy(model.last_read),
        promptTokens=len(ids), actionTokens=1, policy="next-token logits restricted to displayed labels")
    return action


def update_policy(model, optimizer, actions, *, reward, past_baseline, enabled=True):
    """One replay of the exact sampled joint finite-action policy, then a step."""
    if not actions or any(not a["sampled"] for a in actions):
        raise ValueError("Policy updates require sampled student actions")
    initial = {name: p.detach().clone() for name, p in model.named_parameters() if p.requires_grad}
    model.train()
    optimizer.zero_grad(set_to_none=True)
    advantage = reward-past_baseline
    loss_number, maximum_error = 0., 0.
    for action in actions:
        logps = distribution(model, action)
        chosen = logps[action["chosenIndex"]]
        error = abs(float(chosen.detach())-action["samplingLogProbability"])
        maximum_error = max(maximum_error, error)
        if error > 2e-3:
            raise RuntimeError("Sampling and replay policies differ; not applying this update")
        loss = -(advantage if enabled else 0.)*chosen
        loss.backward()
        loss_number += float(loss.detach())
    norm = torch.nn.utils.clip_grad_norm_(model.parameters_to_train(), 1., error_if_nonfinite=True)
    optimizer.step()  # AdamW weight_decay=0 required even for the zero-reward arm.
    changed = [name for name, p in model.named_parameters() if p.requires_grad
               and not torch.equal(initial[name], p.detach())]
    model.eval()
    return dict(loss=loss_number, gradNorm=float(norm), advantage=advantage,
        pastBaseline=past_baseline, rewardEnabled=enabled, changedParameterTensors=changed,
        samplingReplayMaxLogProbabilityError=maximum_error, optimizerSteps=1,
        replayActionCount=len(actions), sftUpdates=0, klCoefficient=0., entropyCoefficient=0.)


def memory_effect(model, action):
    """Same frozen weights, prompt and note IDs; compare actual distributions."""
    observations = {}
    model.eval()
    with torch.no_grad():
        for ablation in ["normal", "off", "shuffle"]:
            tested = dict(action, ablation=ablation)
            logps = distribution(model, tested)
            observations[ablation] = dict(probabilities=logps.exp().cpu().tolist(),
                selectedValue=action["options"][int(logps.argmax())]["value"],
                readTrace=copy.deepcopy(model.last_read))
    normal = torch.tensor(observations["normal"]["probabilities"])
    differences = {kind: float((normal-torch.tensor(observations[kind]["probabilities"])).abs().max())
                   for kind in ["off", "shuffle"]}
    model.set_memory([])
    return dict(observations=observations, maxProbabilityDifference=differences,
        promptUnchanged=True, weightsUnchanged=True, semanticUnderstandingProved=False,
        note="Nonzero effects show dependence of this policy distribution, not useful understanding.")
