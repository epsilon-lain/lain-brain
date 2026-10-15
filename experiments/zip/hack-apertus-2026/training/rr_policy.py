"""Genuine REINFORCE on the model's two-action distribution, with explicit exploration.

No gold action is teacher-forced. Both legal action names are an interface vocabulary.
Only the student's sampled choice gets its scalar TRAIN reward after it is saved.
The exact sampling mixture is replayed for its gradient, not an approximate surrogate.
"""
import math
import random
from rr_common import *

ACTIONS=('KEEP','RETRACT')


def prompt_ids(tokenizer,messages,max_output,context):
    text=tokenizer.apply_chat_template(messages,tokenize=False,add_generation_prompt=True)
    ids=tokenizer(text,add_special_tokens=False,truncation=False)['input_ids']
    require(isinstance(ids,list) and all(type(x) is int and x>=0 for x in ids),'Invalid original tokenizer prefix')
    require(0<len(ids) and len(ids)+max_output<=context,'Prompt exceeds actual context; no truncation')
    return ids


def action_tokens(tokenizer,base):
    eos=base.generation_config.eos_token_id
    if eos is None:eos=tokenizer.eos_token_id
    eos=eos[0] if isinstance(eos,list) else eos
    require(type(eos) is int,'Need native EOS')
    targets={a:tokenizer(a,add_special_tokens=False,truncation=False)['input_ids']+[eos] for a in ACTIONS}
    require(all(1<len(v)<=12 and all(type(x) is int for x in v) for v in targets.values()),'Bad action tokenization')
    require(targets['KEEP']!=targets['RETRACT'],'Identical action tokens')
    return targets


def option_log_probability(base,prefix,completion):
    import torch
    import torch.nn.functional as F
    device=next(base.parameters()).device
    ids=torch.tensor([prefix+completion],device=device)
    logits=base(input_ids=ids,use_cache=False,logits_to_keep=len(completion)+1).logits[:,:-1,:].float()
    require(logits.shape[1]==len(completion),'Action token replay alignment changed')
    target=torch.tensor([completion],device=device)
    return F.log_softmax(logits,dim=-1).gather(-1,target.unsqueeze(-1)).sum()


def scores(base,prefix,targets):
    import torch
    import torch.nn.functional as F
    # KEEP and RETRACT tokenize differently. A fixed mean-token score prevents an
    # accidental preference purely for the shorter spelling. This is the declared
    # categorical tool-choice policy, not the probability of unconstrained prose.
    # Score the two continuations together. Right padding is masked and never
    # counted in a target. The first returned logit predicts the first action token.
    longest=max(len(targets[a]) for a in ACTIONS);device=next(base.parameters()).device
    sequences=[prefix+targets[a] for a in ACTIONS];length=max(map(len,sequences))
    eos=targets[ACTIONS[0]][-1]
    ids=torch.tensor([s+[eos]*(length-len(s)) for s in sequences],device=device)
    mask=torch.tensor([[1]*len(s)+[0]*(length-len(s)) for s in sequences],device=device)
    logits=base(input_ids=ids,attention_mask=mask,use_cache=False,logits_to_keep=longest+1).logits.float()
    require(logits.shape[1]==longest+1,'Batched action alignment changed')
    lps=F.log_softmax(logits,dim=-1);result=[]
    for i,a in enumerate(ACTIONS):
        g=targets[a];target=torch.tensor(g,device=device)
        result.append(lps[i,:len(g),:].gather(-1,target.unsqueeze(-1)).mean())
    return torch.stack(result)


def distribution(values,epsilon):
    require(0<=epsilon<=1 and len(values)==2 and all(math.isfinite(x) for x in values),'Invalid action distribution')
    maximum=max(values);terms=[math.exp(x-maximum) for x in values];total=sum(terms)
    pure=[x/total for x in terms];mixed=[(1-epsilon)*x+epsilon/2 for x in pure]
    return dict(model=dict(zip(ACTIONS,pure)),sampling=dict(zip(ACTIONS,mixed)))


def select(values,seed,epsilon=0.,sampled=False):
    ps=distribution(values,epsilon)
    if sampled:
        u=random.Random(seed).random();action='KEEP' if u<ps['sampling']['KEEP'] else 'RETRACT'
    else:action=max(ACTIONS,key=lambda a:ps['model'][a])
    return action,ps


def update(base,actor,writer,old_repair,optimizer,rows,rewards,contexts,zero_reward=False):
    """One atomic update's computation; publication is handled separately by rr_store."""
    import torch
    require(len(rows)==len(rewards)==2 and all(r['caseSplit']=='training' for r in rows),'Only two genuine TRAIN choices can update')
    for r in rows:
        check_seal(r)
        require(r['fixtureOnly'] is False and r['sampled'] is True and r['reflectionHash']==actor.digest() and
            r['expectedActionSuppliedToModel'] is False,'Not an on-policy genuine saved decision')
    require(all(not p.requires_grad and p.grad is None for p in base.parameters()),'Base must be frozen')
    require(all(not p.requires_grad and p.grad is None for m in (writer,old_repair) for p in m.parameters_to_train()),
        'Old adapters must be frozen')
    require(all(r in (-1.,1.) for r in rewards),'Only bounded binary behavioral rewards are allowed')
    before=actor.digest();optimizer.zero_grad(set_to_none=True)
    if zero_reward:
        return dict(beforeReflectionHash=before,afterReflectionHash=before,parameterChanged=False,
            appliedRewards=[0.,0.],observedRewards=list(rewards),optimizerStep=False,
            zeroRewardControl=True,sourceDecisionIds=[r['recordId'] for r in rows],
            sourceDecisionHashes=[r['hash'] for r in rows])
    require(all(p.requires_grad for p in actor.parameters_to_train()),'New reflection adapter is not trainable')
    loss_value=0.;replays=[]
    try:
        with contexts():
            for row,reward in zip(rows,rewards):
                values=scores(base,row['promptIds'],row['candidateTokens'])
                require(bool(torch.isfinite(values).all()),'Nonfinite action logits')
                pure=torch.softmax(values,dim=0);epsilon=row['exploration']
                mixed=(1-epsilon)*pure+epsilon/2
                lp=torch.log(mixed[ACTIONS.index(row['action'])])
                actual=float(lp.detach())
                require(abs(actual-row['actionLogProbability'])<=.02,'Sampling/replay mixture changed; no optimizer step')
                loss=-reward*lp/len(rows)
                require(bool(torch.isfinite(loss)),'Nonfinite reflection loss')
                loss.backward();loss_value+=float(loss.detach());replays.append(actual)
        require(all(p.grad is None for p in base.parameters()) and
            all(p.grad is None for m in (writer,old_repair) for p in m.parameters_to_train()),
            'A protected parameter received gradients')
        norm=torch.nn.utils.clip_grad_norm_(actor.parameters_to_train(),1.,error_if_nonfinite=True)
        optimizer.step()
        require(all(bool(torch.isfinite(p).all()) for p in actor.parameters_to_train()),'Nonfinite new reflection weights')
        after=actor.digest()
        return dict(beforeReflectionHash=before,afterReflectionHash=after,parameterChanged=before!=after,
            appliedRewards=list(rewards),optimizerStep=True,zeroRewardControl=False,
            loss=loss_value,gradientNorm=float(norm),replayedActionLogProbabilities=replays,
            sourceDecisionIds=[r['recordId'] for r in rows],sourceDecisionHashes=[r['hash'] for r in rows],
            noTeacherCorrectActionTokens=True,frozenGradientsAbsent=True)
    finally:optimizer.zero_grad(set_to_none=True)


def generate(base,tokenizer,messages,seed,context,max_tokens=128,sampled=False):
    """Actual untouched token sequence; no regex replacement, answer filling, or early fake EOS."""
    import torch
    import torch.nn.functional as F
    require(max_tokens in (96,128,256),'Unplanned output budget')
    prefix_ids=prompt_ids(tokenizer,messages,max_tokens,context)
    device=next(base.parameters()).device;prefix=torch.tensor([prefix_ids],device=device)
    rng=torch.Generator(device=device).manual_seed(seed)
    eos=base.generation_config.eos_token_id
    if eos is None:eos=tokenizer.eos_token_id
    stops=set(eos if isinstance(eos,list) else [eos])-{None}
    ids=[];logs=[];past=None;next_input=prefix;ended=False;temperature=.8 if sampled else 1.
    with torch.no_grad():
        for _ in range(max_tokens):
            v=base(input_ids=next_input,past_key_values=past,use_cache=True,logits_to_keep=1)
            lp=F.log_softmax(v.logits[0,-1].float()/temperature,dim=-1)
            require(bool(torch.isfinite(lp).all()),'Nonfinite generation distribution')
            token=int(torch.multinomial(lp.exp(),1,generator=rng)) if sampled else int(lp.argmax())
            ids.append(token);logs.append(float(lp[token]));past=v.past_key_values;ended=token in stops
            if ended:break
            next_input=torch.tensor([[token]],device=device)
    return dict(raw=tokenizer.decode(ids,skip_special_tokens=True),promptIds=prefix_ids,
        generatedIds=ids,generatedTokens=len(ids),samplingTokenLogProbabilities=logs,
        samplingLogProbability=sum(logs),sampled=sampled,temperature=temperature,
        tokenCapReached=len(ids)==max_tokens and not ended,stopReason='eos' if ended else 'token_cap',
        originalTextRepaired=False,responseTokenLimit=max_tokens)
