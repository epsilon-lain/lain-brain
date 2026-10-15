"""Natural EOS sampling, with a config-bounded input budget for v4 only.

The 63 historical modules, including their 2048-token guard, are untouched.
Token sampling is the same full-softmax loop as v2; only prefix validation
uses the explicitly checked local context and a 4096-token resource ceiling.
"""
from zip_content_core import digest
from zip_self_question_tools_core import (PHASES, MAX_TOKENS, require, review_messages,
    call_messages, question_text_messages)
from zip_self_question_natural_policy import generate as unchanged_generate

MAX_INPUT_TOKENS = 4096
ECHO_PLANNING_RESERVE = 4 * MAX_TOKENS


def input_limits(config, tokenizer):
    context = config.get('max_position_embeddings')
    require(type(context) is int and context > MAX_TOKENS, 'Local model context limit is missing or too small')
    tokenizer_context = getattr(tokenizer, 'model_max_length', None)
    usable_context = context
    if type(tokenizer_context) is int and 0 < tokenizer_context < 1_000_000_000:
        usable_context = min(usable_context, tokenizer_context)
    limit = min(MAX_INPUT_TOKENS, usable_context - MAX_TOKENS)
    require(limit > 0, 'No input budget after reserving response tokens')
    return dict(configuredModelContextTokens=context, usableContextTokens=usable_context,
        maxInputTokens=limit, responseTokenReserve=MAX_TOKENS, resourceInputCeiling=MAX_INPUT_TOKENS)


def prompt_audit(tokenizer, messages, limits):
    limits = {key: limits[key] for key in ('configuredModelContextTokens', 'usableContextTokens',
        'maxInputTokens', 'responseTokenReserve', 'resourceInputCeiling')}
    text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    ids = tokenizer(text, add_special_tokens=False, truncation=False)['input_ids']
    require(isinstance(ids, list) and all(type(x) is int and x >= 0 for x in ids), 'Invalid tokenizer prefix')
    n = len(ids)
    body = dict(limits, inputTokens=n, messageHash=digest(messages), promptIds=ids,
        promptIdsHash=digest(ids), noSilentTruncation=True,
        fitsInputBudget=0 < n <= limits['maxInputTokens'] and
            n + MAX_TOKENS <= limits['usableContextTokens'])
    return dict(body, auditHash=digest(body))


def require_input(audit):
    require(audit['auditHash'] == digest({k:v for k,v in audit.items() if k != 'auditHash'}) and
        audit['responseTokenReserve'] == MAX_TOKENS and
        0 < audit['maxInputTokens'] <= MAX_INPUT_TOKENS and
        audit['maxInputTokens'] + MAX_TOKENS <= audit['usableContextTokens'] <=
            audit['configuredModelContextTokens'] and audit['noSilentTruncation'] is True,
        'Input budget certificate changed')
    require(audit['fitsInputBudget'] is True and 0 < audit['inputTokens'] <= audit['maxInputTokens'] and
        audit['inputTokens'] == len(audit['promptIds']) and
        audit['promptIdsHash'] == digest(audit['promptIds']),
        'Input token budget: actual=' + str(audit['inputTokens']) +
        ', allowed=' + str(audit['maxInputTokens']) + '; stopped before model forward; no truncation')


def preflight_prompts(bundle, bank, tokenizer, limits, probe_number):
    # Shapes only. Never execute a tool, select a metric for the student,
    # generate a response or manufacture a measured result during preflight.
    placeholder = dict(raw='[student assessment not yet generated]', stopReason='eos', tokenCapReached=False)
    rows = []
    def add(phase, label, messages, reserve):
        audit = prompt_audit(tokenizer, messages, limits)
        rows.append(dict(phase=phase, shape=label, planningEchoReserve=reserve,
            plannedTokens=audit['inputTokens'] + reserve,
            planningFits=audit['fitsInputBudget'] and audit['inputTokens'] + reserve <= limits['maxInputTokens'],
            studentResponse=False, measurementExecuted=False, audit=audit))
    add('experience_review', 'all_eight_original_histories', review_messages(bundle), 0)
    for attempt in (1, 2):
        add('metric_zip_call', 'catalogue_attempt_' + str(attempt),
            call_messages(bundle, bank, placeholder, probe_number, attempt), ECHO_PLANNING_RESERVE)
    for tool in bank['tools']:
        shape = dict(zipId=tool['id'], title=tool['title'], definition=tool['description'],
            metricKey=tool['operation'], value='[tool value returned after student call]', unit='fraction', trainingObjects=8)
        add('experience_question', 'possible_result_shape_' + tool['id'],
            question_text_messages(placeholder['raw'], '[student ZIP call not yet generated]', shape),
            ECHO_PLANNING_RESERVE)
    return dict(limits=limits, rows=rows, allPlannedPromptsFit=all(r['planningFits'] for r in rows),
        tokenizerOnly=True, modelWeightsLoaded=False, actualStudentGenerations=0,
        measurementExecutions=0, planningReserveIsNotAContentCertificate=True,
        exactInputRecheckedBeforeEveryActualGeneration=True)


def generate(base, tokenizer, messages, phase, seed, sampled, input_audit=None):
    require(phase in PHASES and MAX_TOKENS == 96, 'Fixed experience-tool sampling budget required')
    if input_audit is None:  # Historical short-prefix callers remain unchanged.
        return unchanged_generate(base, tokenizer, messages, 'natural_semantic', seed, sampled)
    require_input(input_audit)
    require(input_audit == prompt_audit(tokenizer, messages, input_audit), 'Tokenizer or checked messages changed')
    require(getattr(base.config, 'max_position_embeddings', None) == input_audit['configuredModelContextTokens'],
        'Loaded model context differs from checked local config')
    import torch
    import torch.nn.functional as F
    device = next(base.parameters()).device
    prefix = torch.tensor([input_audit['promptIds']], device=device)
    rng = torch.Generator(device=device).manual_seed(seed)
    eos = base.generation_config.eos_token_id
    if eos is None:
        eos = tokenizer.eos_token_id
    stops = set(eos if isinstance(eos, list) else [eos]) - {None}
    ids, logs, past, next_input, ended = [], [], None, prefix, False
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
