"""A frozen Apertus or Qwen2 with a bounded zip read path and adapter.

The pilot attends to a small frozen text archive. It has no discrete calling
controller or learned research scheduler. Only added modules are optimized.
"""
from __future__ import annotations

import hashlib
import torch
from torch import nn


def state_digest(module):
    digest = hashlib.sha256()
    for name, value in sorted(module.state_dict().items()):
        digest.update(name.encode())
        value = value.detach().cpu().contiguous()
        digest.update(str(value.dtype).encode())
        digest.update(str(tuple(value.shape)).encode())
        digest.update(value.reshape(-1).view(torch.uint8).numpy().tobytes())
    return digest.hexdigest()


class ZipPilot(nn.Module):
    def __init__(self, base, tokenizer, notes, *, rank=32, slots=2, mode="zip"):
        super().__init__()
        if base.config.model_type not in {"apertus", "qwen2"} or not 1 <= len(notes) <= 12:
            raise ValueError("Need an Apertus/Qwen2 student and 1..12 certified training notes")
        if mode not in {"zip", "text", "none"}:
            raise ValueError("Unknown memory mode")
        self.base, self.tokenizer, self.notes, self.mode = base, tokenizer, list(notes), mode
        self.base.eval().requires_grad_(False)
        self.base.config.use_cache = False
        self.base.gradient_checkpointing_disable()
        d = base.config.hidden_size
        device = next(base.parameters()).device
        self.rank, self.slots = rank, slots
        with torch.no_grad():
            pooled = []
            for note in notes:
                ids = tokenizer(note, add_special_tokens=False, return_tensors="pt")["input_ids"].to(device)
                if ids.shape[1] > 256:
                    raise ValueError("Training note exceeds 256 tokens; no silent truncation")
                pooled.append(base.get_input_embeddings()(ids).float().mean(1)[0])
        self.register_buffer("note_embeddings", torch.stack(pooled))
        self.encoder = nn.Sequential(nn.Linear(d, rank), nn.SiLU(), nn.Linear(rank, slots * d))
        self.q = nn.Linear(d, rank, bias=False)
        self.k = nn.Linear(d, rank, bias=False)
        self.v = nn.Linear(d, rank, bias=False)
        self.read_out = nn.Linear(rank, d, bias=False)
        self.generation_adapter = nn.Sequential(nn.Linear(d, rank), nn.SiLU(), nn.Linear(rank, d))
        nn.init.normal_(self.read_out.weight, std=0.001)
        nn.init.normal_(self.generation_adapter[-1].weight, std=0.001)
        nn.init.zeros_(self.generation_adapter[-1].bias)
        self.to(device)
        self.ablation = "normal"
        self.read_calls = 0
        self.layer_index = len(base.model.layers) // 2
        self._hook = base.model.layers[self.layer_index].register_forward_hook(self._read)

    def train(self, mode=True):
        super().train(mode)
        self.base.eval()  # no dropout discrepancy between sampling and rescoring
        return self

    def _read(self, module, args, output):
        hidden = output[0] if isinstance(output, tuple) else output
        h = hidden.float()
        delta = self.generation_adapter(h)
        if self.mode == "zip" and self.ablation != "off":
            memory = self.encoder(self.note_embeddings).reshape(-1, hidden.shape[-1])
            keys, values = torch.nn.functional.normalize(self.k(memory), dim=-1), self.v(memory)
            if self.ablation == "shuffle":
                # Content mismatch: preserve keys, permute values across objects.
                values = values.reshape(len(self.notes), self.slots, -1).roll(1, 0).reshape(-1, self.rank)
            queries = torch.nn.functional.normalize(self.q(h), dim=-1)
            weights = (queries @ keys.T * self.rank**0.5).softmax(-1)
            delta = delta + self.read_out(weights @ values)
            self.read_calls += 1
        result = hidden + delta.to(hidden.dtype)
        return (result,) + output[1:] if isinstance(output, tuple) else result

    def parameters_to_train(self):
        return [p for p in self.parameters() if p.requires_grad]

    def adapter_state(self):
        return {k: v.detach().cpu().contiguous() for k, v in self.state_dict().items() if not k.startswith("base.")}

    def forward(self, ids, keep=0):
        return self.base(input_ids=ids, use_cache=False, logits_to_keep=keep).logits

    def close(self):
        self._hook.remove()


def encode_prompt(model, messages, max_prompt=2304):
    text = model.tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    ids = model.tokenizer(text, add_special_tokens=False, return_tensors="pt", return_token_type_ids=False)["input_ids"].to(next(model.parameters()).device)
    if ids.shape[1] > max_prompt:
        raise ValueError(f"Prompt exceeds bounded context ({ids.shape[1]} > {max_prompt}); no silent truncation")
    return ids


def eos_ids(model):
    value = model.base.generation_config.eos_token_id
    return set(value if isinstance(value, list) else [value])


def generate(model, messages, *, max_new_tokens=128, sample=False):
    ids = encode_prompt(model, messages)
    prefix = ids.shape[1]
    with torch.no_grad():
        for _ in range(max_new_tokens):
            logits = model(ids, keep=1)[:, -1].float()
            chosen = torch.multinomial(logits.softmax(-1), 1) if sample else logits.argmax(-1, keepdim=True)
            ids = torch.cat((ids, chosen), 1)
            if chosen.item() in eos_ids(model):
                break
    generated = ids[0, prefix:]
    return dict(promptIds=ids[0, :prefix].tolist(), generatedIds=generated.tolist(),
                raw=model.tokenizer.decode(generated, skip_special_tokens=True),
                generatedTokens=len(generated), truncated=generated[-1].item() not in eos_ids(model))


def token_logps(model, prompt_ids, answer_ids):
    device = next(model.parameters()).device
    joined = torch.tensor([prompt_ids + answer_ids], device=device)
    logits = model(joined, keep=len(answer_ids)+1)[:, :-1].float()
    targets = torch.tensor([answer_ids], device=device)
    return logits.log_softmax(-1).gather(-1, targets.unsqueeze(-1)).squeeze(-1)


def sft_loss(model, messages, answer):
    prompt_ids = encode_prompt(model, messages)[0].tolist()
    target = model.tokenizer(answer, add_special_tokens=False)["input_ids"]
    if len(target) > 256 or not target:
        raise ValueError("SFT answer exceeds 256 tokens")
    eos = model.tokenizer.eos_token_id
    if eos is not None:
        target.append(eos)
    return -token_logps(model, prompt_ids, target).mean()
