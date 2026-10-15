"""Expected categorical return, then on-policy free-proposal REINFORCE.

The former uses ALL legal choices with explicit program reward supervision;
it is not free-form discovery or reward-free learning. Neither stage supplies
a correct replacement expression. The second replays the untouched sample.
"""
import math
from rr_common import *


def scores(base,prefix,targets):
    import torch
    import torch.nn.functional as F
    names=list(targets);require(len(names) in (2,3),'Two or three legal choices required')
    longest=max(map(len,targets.values()));device=next(base.parameters()).device
    sequences=[prefix+targets[a] for a in names];length=len(prefix)+longest
    pad=targets[names[0]][-1]
    ids=torch.tensor([s+[pad]*(length-len(s)) for s in sequences],device=device)
    mask=torch.tensor([[1]*len(s)+[0]*(length-len(s)) for s in sequences],device=device)
    logits=base(input_ids=ids,attention_mask=mask,use_cache=False,logits_to_keep=longest+1).logits.float()
    require(logits.shape[1]==longest+1,'Categorical replay alignment changed')
    lp=F.log_softmax(logits,dim=-1)
    return torch.stack([lp[i,:len(targets[a])].gather(-1,torch.tensor(targets[a],device=device).unsqueeze(-1)).mean() for i,a in enumerate(names)])


def probabilities(values,names):
    require(len(values)==len(names) and all(math.isfinite(x) for x in values),'Invalid option scores')
    m=max(values);v=[math.exp(x-m) for x in values];total=sum(v)
    return dict(zip(names,[x/total for x in v]))


def protected_gradients(base,protected):
    require(all(not p.requires_grad and p.grad is None for p in base.parameters()),'Base must be frozen')
    require(all(not p.requires_grad and p.grad is None for m in protected for p in m.parameters_to_train()),'Protected adapters must be frozen')


def expected_update(base,actor,optimizer,rows,tables,contexts,protected,zero=False):
    import torch
    before=actor.digest();require(len(rows)==len(tables)>0,'Missing training reward tables')
    protected_gradients(base,protected)
    for r,t in zip(rows,tables):
        check_seal(r)
        require(r['fixtureOnly'] is False and r['caseSplit']=='training' and r['adapterHash']==before and
            r['expectedActionSuppliedToModel'] is False and set(t)==set(r['candidateTokens']) and
            all(x in (-1.,0.,1.) for x in t.values()),'Not genuine on-policy TRAIN categorical feedback')
    receipt=dict(beforeHash=before,afterHash=before,parameterChanged=False,optimizerStep=False,
        zeroRewardControl=zero,sourceIds=[r['recordId'] for r in rows],sourceHashes=[r['hash'] for r in rows],
        returnTables=tables,objective='exact_expected_categorical_return',correctTokenTeacherForced=False)
    optimizer.zero_grad(set_to_none=True)
    if zero:return receipt
    require(all(p.requires_grad for p in actor.parameters_to_train()),'Meta adapter is not trainable')
    loss_sum=0.
    try:
        with contexts():
            for r,t in zip(rows,tables):
                names=list(r['candidateTokens']);p=torch.softmax(scores(base,r['promptIds'],r['candidateTokens']),dim=0)
                require(bool(torch.isfinite(p).all()) and all(abs(float(p[i].detach())-r['probabilities'][a])<=.002 for i,a in enumerate(names)),
                    'On-policy categorical distribution changed; no optimizer step')
                feedback=torch.tensor([t[a] for a in names],device=p.device)
                loss=-(p*feedback).sum()/len(rows);loss.backward();loss_sum+=float(loss.detach())
        protected_gradients(base,protected)
        norm=torch.nn.utils.clip_grad_norm_(actor.parameters_to_train(),1.)
        require(bool(torch.isfinite(norm)),'Nonfinite meta gradient')
        optimizer.step();after=actor.digest()
        receipt.update(afterHash=after,parameterChanged=after!=before,optimizerStep=True,
            loss=loss_sum,gradientNorm=float(norm),frozenGradientsAbsent=True)
        return receipt
    finally:optimizer.zero_grad(set_to_none=True)


def sequence_log_probability(base,prefix,generated,temperature):
    import torch
    import torch.nn.functional as F
    require(generated and temperature>0,'No sampled sequence')
    device=next(base.parameters()).device;ids=torch.tensor([prefix+generated],device=device)
    logits=base(input_ids=ids,use_cache=False,logits_to_keep=len(generated)+1).logits[:,:-1,:].float()/temperature
    require(logits.shape[1]==len(generated),'Sequence replay alignment changed')
    return F.log_softmax(logits,dim=-1).gather(-1,torch.tensor([generated],device=device).unsqueeze(-1)).sum()


def editor_update(base,actor,optimizer,rows,rewards,contexts,protected,zero=False):
    import torch
    before=actor.digest();protected_gradients(base,protected)
    require(len(rows)==len(rewards) and len(rows) in (0,2),'Two genuine samples or one ineligible episode required')
    for r,v in zip(rows,rewards):
        check_seal(r);o=r['studentOutput']
        require(r['fixtureOnly'] is False and r['caseSplit']=='training' and r['binding']['adapterHash']==before and
            o['sampled'] is True and o['originalTextRepaired'] is False and
            v in (-1.,-.2,0.,1.),'Not untouched on-policy TRAIN proposal')
    receipt=dict(beforeHash=before,afterHash=before,parameterChanged=False,optimizerStep=False,
        zeroRewardControl=zero,sourceIds=[r['recordId'] for r in rows],sourceHashes=[r['hash'] for r in rows],
        observedRewards=rewards,appliedRewards=[0.]*len(rows) if zero else rewards,
        objective='sequence_REINFORCE',teacherReplacementSupplied=False)
    optimizer.zero_grad(set_to_none=True)
    if zero or not any(rewards):return receipt
    require(all(p.requires_grad for p in actor.parameters_to_train()),'Editor is not trainable')
    loss_sum=0.;replayed=[]
    try:
        with contexts():
            for r,v in zip(rows,rewards):
                if v==0.:continue
                o=r['studentOutput'];lp=sequence_log_probability(base,o['promptIds'],o['generatedIds'],o['temperature'])
                require(bool(torch.isfinite(lp)) and abs(float(lp.detach())-o['samplingLogProbability'])<=.15,
                    'Sampled sequence replay changed; no optimizer step')
                loss=-v*lp/len(rows);loss.backward();loss_sum+=float(loss.detach());replayed.append(float(lp.detach()))
        protected_gradients(base,protected);norm=torch.nn.utils.clip_grad_norm_(actor.parameters_to_train(),1.)
        require(bool(torch.isfinite(norm)),'Nonfinite editor gradient');optimizer.step();after=actor.digest()
        receipt.update(afterHash=after,parameterChanged=before!=after,optimizerStep=True,loss=loss_sum,
            gradientNorm=float(norm),replayedLogProbabilities=replayed,frozenGradientsAbsent=True)
        return receipt
    finally:optimizer.zero_grad(set_to_none=True)
