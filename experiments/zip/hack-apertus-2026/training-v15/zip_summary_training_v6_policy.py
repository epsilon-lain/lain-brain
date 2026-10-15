"""Native EOS: 128 tokens for note writing; old 96-token task sampler intact."""
import math

from zip_content_core import digest
from zip_summary_training_v6_audit import MAX_SUMMARY_TOKENS
from zip_self_question_tools_policy import (MAX_INPUT_TOKENS, input_limits as old_limits,
    prompt_audit as old_prompt_audit, generate as old_generate)
from zip_summary_training_v4_core import require

TASK_TOKENS = 96
PHASES = ('cold_replay','route_math','experience_summary','summary_quality_assessment',
    'training_observation_without_summary','training_observation_with_summary',
    'heldout_observation_without_summary','heldout_observation_with_summary')


def token_limit(phase):
    require(phase in PHASES, 'Unknown summary generation phase')
    return MAX_SUMMARY_TOKENS if phase=='experience_summary' else TASK_TOKENS


def input_limits(config, tokenizer):
    row = old_limits(config,tokenizer)
    row['maxInputTokens'] = min(MAX_INPUT_TOKENS,row['usableContextTokens']-MAX_SUMMARY_TOKENS)
    require(row['maxInputTokens']>0,'No input budget after reserving actual response tokens')
    row['responseTokenReserve'] = MAX_SUMMARY_TOKENS
    return row


def prompt_audit(tokenizer,messages,limits):
    keys = ('configuredModelContextTokens','usableContextTokens','maxInputTokens',
        'responseTokenReserve','resourceInputCeiling')
    text = tokenizer.apply_chat_template(messages,tokenize=False,add_generation_prompt=True)
    ids = tokenizer(text,add_special_tokens=False,truncation=False)['input_ids']
    require(isinstance(ids,list) and all(type(v) is int and v>=0 for v in ids),'Invalid original tokenizer prefix')
    row = dict({k:limits[k] for k in keys},inputTokens=len(ids),messageHash=digest(messages),
        promptIds=ids,promptIdsHash=digest(ids),noSilentTruncation=True,
        fitsInputBudget=0<len(ids)<=limits['maxInputTokens'] and
            len(ids)+MAX_SUMMARY_TOKENS<=limits['usableContextTokens'])
    return dict(row,auditHash=digest(row))


def require_input(audit):
    require(audit['auditHash']==digest({k:v for k,v in audit.items() if k!='auditHash'}) and
        audit['responseTokenReserve']==MAX_SUMMARY_TOKENS and
        0<audit['maxInputTokens']<=MAX_INPUT_TOKENS and
        audit['maxInputTokens']+MAX_SUMMARY_TOKENS<=audit['usableContextTokens']<=audit['configuredModelContextTokens'] and
        audit['noSilentTruncation'] is True,'Input budget certificate changed')
    require(audit['fitsInputBudget'] is True and
        0<audit['inputTokens']==len(audit['promptIds'])<=audit['maxInputTokens'] and
        audit['promptIdsHash']==digest(audit['promptIds']),'Actual prompt too long; no silent truncation')


def generate(base,tokenizer,messages,phase,seed,sampled,input_audit):
    budget = token_limit(phase)
    require_input(input_audit)
    require(input_audit==prompt_audit(tokenizer,messages,input_audit),'Checked tokenizer or messages changed')
    require(base.config.max_position_embeddings==input_audit['configuredModelContextTokens'],'Model context differs')
    if phase!='experience_summary':
        checked = old_prompt_audit(tokenizer,messages,old_limits(
            dict(max_position_embeddings=base.config.max_position_embeddings),tokenizer))
        require(checked['promptIds']==input_audit['promptIds'],'Historical task prefix differs')
        value = old_generate(base,tokenizer,messages,'experience_review',seed,sampled,input_audit=checked)
        return dict(value,responseTokenLimit=budget,responseBudgetProtocol='native-eos-summary-v6')
    import torch
    import torch.nn.functional as F
    device = next(base.parameters()).device
    prefix = torch.tensor([input_audit['promptIds']],device=device)
    rng = torch.Generator(device=device).manual_seed(seed)
    eos = base.generation_config.eos_token_id
    if eos is None:eos = tokenizer.eos_token_id
    stops = set(eos if isinstance(eos,list) else [eos])-{None}
    ids,logs,past,next_input,ended = [],[],None,prefix,False
    temperature = .8 if sampled else 1.
    with torch.no_grad():
        for _ in range(budget):
            value = base(input_ids=next_input,past_key_values=past,use_cache=True,logits_to_keep=1)
            lp = F.log_softmax(value.logits[0,-1].float()/temperature,dim=-1)
            if not torch.isfinite(lp).all():raise RuntimeError('Nonfinite generation distribution')
            token = int(torch.multinomial(lp.exp(),1,generator=rng)) if sampled else int(lp.argmax())
            ids.append(token);logs.append(float(lp[token]));past = value.past_key_values
            ended = token in stops
            if ended:break
            next_input = torch.tensor([[token]],device=device)
    return dict(raw=tokenizer.decode(ids,skip_special_tokens=True),promptIds=prefix[0].tolist(),
        generatedIds=ids,samplingTokenLogProbabilities=logs,generatedTokens=len(ids),
        sampled=sampled,temperature=temperature,samplingLogProbability=sum(logs),
        tokenCapReached=len(ids)==budget and not ended,studentEndMarkerReached=False,
        stopReason='eos' if ended else 'token_cap',originalTextRepaired=False,
        responseTokenLimit=budget,responseBudgetProtocol='native-eos-summary-v6')


def update_summary_words(base,adapter,optimizer,responses,advantages,max_tokens):
    """Replay original note trajectories with the SAME 128-token budget.

    The legacy 96-token updater stays unchanged. This entry is bound explicitly
    by v6_run; its normalization is 128 per scheduled trajectory, including
    negative admission feedback, independently of each response's actual length.
    """
    require(1<=len(responses)<=6 and len(responses)==len(advantages) and
        all(type(a) in (int,float) and math.isfinite(a) and abs(a)<=1 for a in advantages),
        'Bounded separate summary word credits required')
    require(type(max_tokens) is int and max_tokens==len(responses)*MAX_SUMMARY_TOKENS,
        'Fixed 128-token denominator per summary trajectory')
    for response in responses:
        ids=response['generatedIds'];logs=response['samplingTokenLogProbabilities']
        require(response.get('responseTokenLimit')==MAX_SUMMARY_TOKENS and
            response.get('responseBudgetProtocol')=='native-eos-summary-v6' and
            response.get('sampled') is True and response.get('originalTextRepaired') is False and
            type(response['generatedTokens']) is int and
            0<response['generatedTokens']==len(ids)==len(logs)<=MAX_SUMMARY_TOKENS and
            all(type(v) is int and v>=0 for v in ids) and
            all(type(v) in (int,float) and math.isfinite(v) for v in logs) and
            type(response['samplingLogProbability']) in (int,float) and
            math.isfinite(response['samplingLogProbability']) and
            abs(sum(logs)-response['samplingLogProbability'])<=1e-10,
            'Summary sampled tokens, logs or 128-token response budget changed')
    if not any(abs(a)>1e-12 for a in advantages):
        return dict(updated=False,parameterChanged=False,reason='zero_eligible_credit')
    import torch
    from zip_generation_policy import response_log_probability
    before=adapter.digest();optimizer.zero_grad(set_to_none=True)
    lps=[response_log_probability(base,r) for r in responses]
    actual=[float(lp.detach()) for lp in lps]
    for lp,response in zip(actual,responses):
        if not math.isfinite(lp) or abs(lp-response['samplingLogProbability'])>.08*response['generatedTokens']:
            raise RuntimeError('Sampled summary differs from policy replay; no optimizer step')
    loss=-sum(a*lp for a,lp in zip(advantages,lps))/max_tokens
    if not torch.isfinite(loss):raise RuntimeError('Nonfinite weighted summary loss')
    loss.backward()
    if any(p.grad is not None for p in base.parameters()):raise RuntimeError('Frozen base received gradients')
    norm=torch.nn.utils.clip_grad_norm_(adapter.parameters_to_train(),1.,error_if_nonfinite=True)
    optimizer.step()
    return dict(updated=True,parameterChanged=adapter.digest()!=before,loss=float(loss.detach()),gradientNorm=float(norm),
        replayLogProbabilities=actual,sampledLogProbabilities=[r['samplingLogProbability'] for r in responses],
        advantages=list(advantages),constantTokenDenominator=max_tokens,allSampledTokensReplayed=True)
