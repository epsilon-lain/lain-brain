"""On-policy verified-reward math updates plus unchanged verified TRAIN rehearsal.
Only q/v LoRA parameters receive gradients. One optimizer step per TRAIN object.
"""
import math
from zip_math_long_core import recipe,require,TOKENS


def validate_trajectory(v,sampled):
    require((type(v.get('sampled')) is bool if sampled is None else v.get('sampled') is sampled) and v.get('originalTextRepaired') is False and
        not v.get('testDouble') and v.get('mathAdapterEnabledDuringGeneration') is True and
        v.get('allOtherAdaptersEnabled') is False and
        0<v['generatedTokens']==len(v['generatedIds'])==len(v['samplingTokenLogProbabilities'])<=TOKENS and
        all(type(t) is int and t>=0 for t in v['promptIds']+v['generatedIds']) and
        all(type(x) in (int,float) and math.isfinite(x) for x in v['samplingTokenLogProbabilities']) and
        abs(sum(v['samplingTokenLogProbabilities'])-v['samplingLogProbability'])<=1e-10,
        'Changed original math trajectory tokens/logs/provenance')
    if sampled:require(v['temperature']==.8,'Different TRAIN sampling temperature')


def token_log_probabilities(base,v,temperature):
    import torch
    import torch.nn.functional as F
    p=v['promptIds'];g=v['generatedIds'];device=next(base.parameters()).device
    ids=torch.tensor([p+g],device=device);targets=torch.tensor([g],device=device)
    logits=base(input_ids=ids,use_cache=False,logits_to_keep=len(g)+1).logits[:,:-1,:].float()/temperature
    require(logits.shape[1]==len(g),'Math replay token alignment changed')
    return F.log_softmax(logits,dim=-1).gather(-1,targets.unsqueeze(-1)).reshape(-1)


def update_math(base,adapter,optimizer,rows,feedback,anchor):
    import torch
    require(feedback['task']['split']=='training' and feedback['heldoutFeedbackUsed'] is False and
        feedback['responseIds']==[r['recordId'] for r in rows] and
        len(rows)==len(feedback['advantages'])>0,'Wrong math TRAIN feedback binding')
    require(not base.training and all(not p.requires_grad and p.grad is None for p in base.parameters()),
        'Base model must be frozen before writer optimization')
    require(all(p.requires_grad for p in adapter.parameters_to_train()),'Math optimizer cannot train a frozen adapter')
    for r in rows:validate_trajectory(r['studentOutput'],True)
    if anchor:
        require(anchor['task']['split']=='training' and not anchor['studentOutput'].get('tokenCapReached'),
            'Heldout or capped targets cannot enter rehearsal')
        # Rehearsal is supervised replay of verified student originals, not an
        # on-policy reward update; original targets may be sampled or greedy.
        validate_trajectory(anchor['studentOutput'],None)
    before=adapter.digest();optimizer.zero_grad(set_to_none=True);lps=[];loss_value=0.
    try:
        for r,a in zip(rows,feedback['advantages']):
            require(type(a) in (int,float) and a in (-.5,.5),'Wrong audited math advantage')
            v=r['studentOutput'];lp=token_log_probabilities(base,v,v['temperature']).sum()
            actual=float(lp.detach())
            require(math.isfinite(actual) and abs(actual-v['samplingLogProbability'])<=
                recipe()['replayLogProbabilityTolerancePerToken']*v['generatedTokens'],
                'Math sampling/replay differs; no optimizer step')
            loss=-a*lp/(len(rows)*TOKENS)
            require(bool(torch.isfinite(loss)),'Nonfinite math policy loss')
            loss.backward();loss_value+=float(loss.detach());lps.append(actual)
        anchor_loss=0.
        if anchor:
            lp=token_log_probabilities(base,anchor['studentOutput'],1.).sum()
            loss=-recipe()['rehearsalWeight']*lp/TOKENS
            require(bool(torch.isfinite(loss)),'Nonfinite verified-rehearsal loss')
            loss.backward();anchor_loss=float(loss.detach());loss_value+=anchor_loss
        require(all(p.grad is None for p in base.parameters()),'Frozen base received mathematical gradients')
        norm=torch.nn.utils.clip_grad_norm_(adapter.parameters_to_train(),recipe()['gradientClip'],error_if_nonfinite=True)
        optimizer.step()
        require(all(bool(torch.isfinite(p).all()) for p in adapter.parameters_to_train()),'Nonfinite updated math parameters')
        return dict(updated=True,parameterChanged=adapter.digest()!=before,beforeWriterHash=before,
            afterWriterHash=adapter.digest(),loss=loss_value,rehearsalLoss=anchor_loss,gradientNorm=float(norm),
            advantages=list(feedback['advantages']),replayedLogProbabilities=lps,
            sampledLogProbabilities=[r['studentOutput']['samplingLogProbability'] for r in rows],
            rehearsalSourceRecordId=anchor['recordId'] if anchor else None,
            rehearsalIsSupervisedStudentOriginalReplay=True,teacherCorrectedTargetTokens=False,
            originalResponsesUsedUnmodified=True,baseGradientsAbsent=True)
    finally:optimizer.zero_grad(set_to_none=True)
