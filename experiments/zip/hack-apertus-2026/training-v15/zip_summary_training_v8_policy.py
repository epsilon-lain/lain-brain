"""Reuse the validated native EOS sampler/updater; independent manager adapter."""
from zip_summary_training_v6_policy import (input_limits,prompt_audit,require_input,
    generate as previous_generate,token_limit as previous_limit,update_summary_words)

def token_limit(phase):
    return 128 if phase=='summary_management' else previous_limit(phase)

def generate(base,tokenizer,messages,phase,seed,sampled,input_audit):
    # Both manager and writer keep every actual sampled token and native EOS.
    return previous_generate(base,tokenizer,messages,'experience_summary' if phase=='summary_management' else phase,
        seed,sampled,input_audit)

update_words=update_summary_words
