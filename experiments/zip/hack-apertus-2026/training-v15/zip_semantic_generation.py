"""Short student notes; stop on a marker the student actually generated.

The marker is framing, never a supplied answer or a grammar constraint.
The original frozen mathematical generator is deliberately left untouched.
"""
import re

LEGACY_LANGUAGE = 'student-prose-v1'
COMPACT_LANGUAGE = 'short-algebra-notes-v2'
NATURAL_LANGUAGE = 'natural-sentence-algebra-notes-v3'
NOTE_LANGUAGES = (COMPACT_LANGUAGE, NATURAL_LANGUAGE)
NOTE_END = '[END_NOTE]'
NOTE_WORD_LIMIT = 40

NOTE_INSTRUCTION = (
    'Write 1 to 3 complete short English sentences, at most 40 words total. '
    'Use your own observations; if unsure, say so briefly. No headings or lists. '
    'Finish the last sentence with punctuation, then write [END_NOTE] alone '
    'on the next line and stop.')

NATURAL_NOTE_INSTRUCTION = (
    'Write one short English sentence, preferably under 25 words and at most 40 words. '
    'Use your own observations; if unsure, say so briefly. No headings or lists. '
    'Finish with sentence punctuation and stop.')


def note_instruction(language_protocol):
    if language_protocol == COMPACT_LANGUAGE:
        return NOTE_INSTRUCTION
    if language_protocol == NATURAL_LANGUAGE:
        return NATURAL_NOTE_INSTRUCTION
    raise ValueError('Unknown note language protocol')


def sentence_ended(raw):
    """Stop only after punctuation actually decoded from student tokens.

    Numeric dots and common abbreviations do not trigger an early stop. The
    entire decoded token remains the original, including any trailing text.
    This is a length/stopping convention, not a semantic or grammar check.
    """
    text = raw.rstrip()
    if not text.endswith(('.', '!', '?')):
        return False
    if re.search(r'\d\.$', text) or re.search(r'\b[A-Za-z]\.$', text) or re.search(r'\b(?:e\.g|i\.e|etc)\.$', text, re.I):
        return False
    return True


def natural_note_contract(raw, capped=False):
    body = raw.strip()
    words = len(body.split())
    sentences = len(re.findall(r'[.!?](?:\s|$)', body))
    reasons = []
    if capped: reasons.append('token_cap_reached')
    if not body: reasons.append('empty_note')
    if NOTE_END in body: reasons.append('legacy_marker_in_natural_note')
    if words > NOTE_WORD_LIMIT: reasons.append('word_budget_exceeded')
    if not body.endswith(('.', '!', '?')): reasons.append('unfinished_sentence')
    if not 1 <= sentences <= 3: reasons.append('sentence_count_outside_1_to_3')
    return dict(complete=not reasons, reasons=reasons,
        studentEndMarkerRequired=False, studentEndMarkerPresent=False,
        wordCount=words, sentenceCount=sentences, wordLimit=NOTE_WORD_LIMIT,
        framingOnly=True, semanticTruthCertified=False, originalTextRepaired=False)


def framing_check(raw, capped=False, language_protocol=COMPACT_LANGUAGE):
    if language_protocol == COMPACT_LANGUAGE:
        return note_contract(raw, capped)
    if language_protocol == NATURAL_LANGUAGE:
        return natural_note_contract(raw, capped)
    raise ValueError('Unknown note language protocol')


def note_ended(raw):
    lines = raw.rstrip().splitlines()
    return bool(lines) and lines[-1].strip() == NOTE_END


def note_contract(raw, capped=False):
    lines = raw.rstrip().splitlines()
    ended = note_ended(raw)
    body = '\n'.join(lines[:-1]).strip() if ended else raw.strip()
    words = len(body.split())
    # This validates framing only. It cannot certify meaning or grammar.
    sentences = len(re.findall(r'[.!?](?:\s|$)', body))
    reasons = []
    if capped: reasons.append('token_cap_reached')
    if not ended: reasons.append('student_end_marker_missing')
    if not body: reasons.append('empty_note')
    if NOTE_END in body: reasons.append('extra_end_marker')
    if words > NOTE_WORD_LIMIT: reasons.append('word_budget_exceeded')
    if not body.endswith(('.', '!', '?')): reasons.append('unfinished_sentence')
    if not 1 <= sentences <= 3: reasons.append('sentence_count_outside_1_to_3')
    return dict(complete=not reasons, reasons=reasons, studentEndMarkerPresent=ended,
        wordCount=words, sentenceCount=sentences, wordLimit=NOTE_WORD_LIMIT,
        framingOnly=True, semanticTruthCertified=False, originalTextRepaired=False)


def generate_note(base, tokenizer, messages, max_tokens, seed, sampled=True, temperature=.8,
                  language_protocol=COMPACT_LANGUAGE):
    # Imports occur only after the original source/fixture checks.
    import torch
    import torch.nn.functional as F
    from zip_generation_policy import prompt_ids
    if language_protocol not in NOTE_LANGUAGES:
        raise ValueError('Unknown note language protocol')
    device = next(base.parameters()).device
    prefix = prompt_ids(tokenizer, messages, device)
    rng = torch.Generator(device=device).manual_seed(seed)
    eos = base.generation_config.eos_token_id
    if eos is None: eos = tokenizer.eos_token_id
    stops = set(eos if isinstance(eos, list) else [eos]) - {None}
    ids = []; logs = []; past = None; next_input = prefix
    ended_eos = ended_note = ended_sentence = False
    with torch.no_grad():
        for _ in range(max_tokens):
            result = base(input_ids=next_input, past_key_values=past, use_cache=True, logits_to_keep=1)
            lp = F.log_softmax(result.logits[0,-1].float()/temperature, dim=-1)
            if not torch.isfinite(lp).all(): raise RuntimeError('Nonfinite generation distribution')
            token = int(torch.multinomial(lp.exp(), 1, generator=rng)) if sampled else int(lp.argmax())
            ids.append(token); logs.append(float(lp[token])); past = result.past_key_values
            ended_eos = token in stops
            decoded = tokenizer.decode(ids, skip_special_tokens=True)
            ended_note = language_protocol == COMPACT_LANGUAGE and note_ended(decoded)
            ended_sentence = language_protocol == NATURAL_LANGUAGE and sentence_ended(decoded)
            if ended_eos or ended_note or ended_sentence: break
            next_input = torch.tensor([[token]], device=device)
    raw = tokenizer.decode(ids, skip_special_tokens=True)
    capped = len(ids) == max_tokens and not (ended_eos or ended_note or ended_sentence)
    result = dict(raw=raw, promptIds=prefix[0].tolist(), generatedIds=ids,
        samplingTokenLogProbabilities=logs, generatedTokens=len(ids), sampled=sampled,
        temperature=temperature, samplingLogProbability=sum(logs), tokenCapReached=capped,
        languageProtocol=language_protocol, studentEndMarkerReached=ended_note,
        stopReason='student_end_marker' if ended_note else ('eos' if ended_eos else
            ('student_sentence_boundary' if ended_sentence else 'token_cap')),
        originalTextRepaired=False)
    if language_protocol == NATURAL_LANGUAGE:
        result.update(studentSentenceBoundaryReached=ended_sentence, studentEndMarkerRequired=False)
    return result
