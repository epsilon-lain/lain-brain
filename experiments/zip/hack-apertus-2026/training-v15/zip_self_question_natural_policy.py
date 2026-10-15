"""Fixed sampler. Natural notes stop on actual EOS, never host punctuation."""
from zip_self_question_natural_checks import CONDITIONS, MAX_TOKENS, require
from zip_self_question_probe_policy import generate as legacy_generate


def generate(base, tokenizer, messages, condition, seed, sampled):
    require(condition in CONDITIONS, 'Unknown natural probe condition')
    if condition == 'legacy_lines':
        return legacy_generate(base, tokenizer, messages, 'table_lines', seed, sampled)
    import torch
    import torch.nn.functional as F
    from zip_generation_policy import prompt_ids
    device = next(base.parameters()).device
    prefix = prompt_ids(tokenizer, messages, device)
    rng = torch.Generator(device=device).manual_seed(seed)
    eos = base.generation_config.eos_token_id
    if eos is None:
        eos = tokenizer.eos_token_id
    stops = set(eos if isinstance(eos, list) else [eos]) - {None}
    ids, logs = [], []
    past = None
    next_input = prefix
    ended = False
    temperature = .8 if sampled else 1.
    with torch.no_grad():
        for _ in range(MAX_TOKENS):
            value = base(input_ids=next_input, past_key_values=past, use_cache=True, logits_to_keep=1)
            lp = F.log_softmax(value.logits[0, -1].float() / temperature, dim=-1)
            if not torch.isfinite(lp).all():
                raise RuntimeError('Nonfinite generation distribution')
            token = int(torch.multinomial(lp.exp(), 1, generator=rng)) if sampled else int(lp.argmax())
            ids.append(token)
            logs.append(float(lp[token]))
            past = value.past_key_values
            ended = token in stops
            if ended:
                break
            next_input = torch.tensor([[token]], device=device)
    total = 0.
    for item in logs:
        total += item
    return dict(raw=tokenizer.decode(ids, skip_special_tokens=True), promptIds=prefix[0].tolist(),
        generatedIds=ids, samplingTokenLogProbabilities=logs, generatedTokens=len(ids),
        sampled=sampled, temperature=temperature, samplingLogProbability=total,
        tokenCapReached=len(ids) == MAX_TOKENS and not ended, studentEndMarkerReached=False,
        stopReason='eos' if ended else 'token_cap', originalTextRepaired=False)
