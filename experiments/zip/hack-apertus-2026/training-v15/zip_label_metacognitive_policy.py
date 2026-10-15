"""Replay variable-size sampled originals with separate factual credits."""
import math

def update_words(base,adapter,optimizer,responses,advantages,max_tokens):
    if not 1<=len(responses)<=6 or len(responses)!=len(advantages) or any(
        not math.isfinite(a) or abs(a)>1 for a in advantages):raise ValueError('Bounded separate word credits required')
    if type(max_tokens) is not int or max_tokens!=len(responses)*96:raise ValueError('Fixed 96-token denominator per trajectory')
    if not any(abs(a)>1e-12 for a in advantages):return dict(updated=False,parameterChanged=False,reason='zero_eligible_credit')
    import torch
    from zip_generation_policy import response_log_probability
    before=adapter.digest();optimizer.zero_grad(set_to_none=True)
    lps=[response_log_probability(base,r) for r in responses]
    actual=[float(lp.detach()) for lp in lps]
    for lp,r in zip(actual,responses):
        if not math.isfinite(lp) or abs(lp-r['samplingLogProbability'])>.08*r['generatedTokens']:
            raise RuntimeError('Sampled original differs from policy replay; no step')
    loss=-sum(a*lp for a,lp in zip(advantages,lps))/max_tokens
    if not torch.isfinite(loss):raise RuntimeError('Nonfinite weighted loss')
    loss.backward()
    if any(p.grad is not None for p in base.parameters()):raise RuntimeError('Frozen base received gradients')
    norm=torch.nn.utils.clip_grad_norm_(adapter.parameters_to_train(),1.,error_if_nonfinite=True)
    optimizer.step()
    return dict(updated=True,parameterChanged=adapter.digest()!=before,loss=float(loss.detach()),gradientNorm=float(norm),
        replayLogProbabilities=actual,sampledLogProbabilities=[r['samplingLogProbability'] for r in responses],
        advantages=list(advantages),constantTokenDenominator=max_tokens,allSampledTokensReplayed=True)

def generate_meta(base,tokenizer,messages,max_tokens,seed,sampled=True,temperature=.8):
    import torch
    import torch.nn.functional as F
    from zip_generation_policy import prompt_ids
    from zip_label_metacognitive_checks import strict_json
    device=next(base.parameters()).device;prefix=prompt_ids(tokenizer,messages,device)
    rng=torch.Generator(device=device).manual_seed(seed);eos=base.generation_config.eos_token_id
    if eos is None:eos=tokenizer.eos_token_id
    stops=set(eos if isinstance(eos,list) else [eos])-{None}
    ids=[];logs=[];past=None;next_input=prefix;ended=False;complete=False
    with torch.no_grad():
        for _ in range(max_tokens):
            value=base(input_ids=next_input,past_key_values=past,use_cache=True,logits_to_keep=1)
            lp=F.log_softmax(value.logits[0,-1].float()/temperature,dim=-1)
            if not torch.isfinite(lp).all():raise RuntimeError('Nonfinite generation distribution')
            token=int(torch.multinomial(lp.exp(),1,generator=rng)) if sampled else int(lp.argmax())
            ids.append(token);logs.append(float(lp[token]));past=value.past_key_values
            ended=token in stops
            try:strict_json(tokenizer.decode(ids,skip_special_tokens=True));complete=True
            except (ValueError,TypeError):pass
            if ended or complete:break
            next_input=torch.tensor([[token]],device=device)
    return dict(raw=tokenizer.decode(ids,skip_special_tokens=True),promptIds=prefix[0].tolist(),generatedIds=ids,
        samplingTokenLogProbabilities=logs,generatedTokens=len(ids),sampled=sampled,temperature=temperature,
        samplingLogProbability=sum(logs),tokenCapReached=len(ids)==max_tokens and not(ended or complete),
        studentJSONClosureReached=complete,stopReason='student_json_closure' if complete else 'eos' if ended else 'token_cap',
        originalTextRepaired=False)
