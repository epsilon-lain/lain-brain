"""Use the unchanged full-softmax natural EOS sampler from v2."""
from zip_self_question_focus_checks import PHASES, MAX_TOKENS, require
from zip_self_question_natural_policy import generate as unchanged_generate


def generate(base, tokenizer, messages, phase, seed, sampled):
    require(phase in PHASES and MAX_TOKENS == 96, 'Fixed two-stage sampling budget required')
    return unchanged_generate(base, tokenizer, messages, 'natural_semantic', seed, sampled)
