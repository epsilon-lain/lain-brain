"""Bounded teacher-forced address learning in a separate q/v adapter.

No model is imported by this module's offline audits. Training targets are
program-authored registry addresses, not sampled student responses.
"""
import math
import signal
from contextlib import contextmanager

from zip_content_core import digest
from zip_self_question_memory_core import require,seal
from zip_self_question_tools_policy import prompt_audit,require_input
from zip_interface_training_core import TRAINING_STEPS,LEARNING_RATE,training_batches


def eos_ids(config,tokenizer):
    value=config.get('eos_token_id')
    if value is None:value=getattr(tokenizer,'eos_token_id',None)
    values=value if isinstance(value,list) else [value]
    require(values and all(type(x) is int and x>=0 for x in values),'Actual configured EOS id required')
    return values


def encode_lesson(tokenizer,lesson,limits,stops):
    audit=prompt_audit(tokenizer,lesson['prompt'],limits);require_input(audit)
    ids=tokenizer(lesson['target'],add_special_tokens=False,truncation=False)['input_ids']
    require(isinstance(ids,list) and 0<len(ids)<32 and all(type(i) is int and i>=0 for i in ids) and
        not any(i in stops for i in ids) and tokenizer.decode(ids,skip_special_tokens=False)==lesson['target'],
        'The complete literal address must tokenize without inserted special tokens')
    target=ids+[stops[0]]
    require(len(audit['promptIds'])+len(target)<=limits['usableContextTokens'],'Training context bound; no truncation')
    return seal(dict(lessonId=lesson['id'],lessonContentHash=digest(lesson),promptAudit=audit,
        targetText=lesson['target'],targetIds=target,actualConfiguredEosIds=stops,
        labelAuthor='program_exact_registry_binding',studentResponse=False,
        sampledStudentTokens=False,lossPositions='target_address_and_explicit_configured_eos_only'), 'packetHash')


def validate_packet(packet,lesson,tokenizer,limits,stops):
    require(packet==encode_lesson(tokenizer,lesson,limits,stops),'Program target packet or tokenizer binding changed')


def target_token_loss(base,packet):
    import torch
    import torch.nn.functional as F
    device=next(base.parameters()).device
    p=packet['promptAudit']['promptIds'];g=packet['targetIds']
    ids=torch.tensor([p+g],device=device);targets=torch.tensor([g],device=device)
    logits=base(input_ids=ids,use_cache=False,logits_to_keep=len(g)+1).logits[:,:-1,:].float()
    require(logits.shape[1]==len(g),'Target-only causal alignment differs from audited model interface')
    logs=F.log_softmax(logits,dim=-1).gather(-1,targets.unsqueeze(-1)).reshape(-1)
    require(torch.isfinite(logs).all().item(),'Nonfinite supervised token loss')
    return -logs.mean()


@contextmanager
def checkpoint_boundary():
    """Keep the small checkpoint/step record commit together on POSIX."""
    if not hasattr(signal,'pthread_sigmask'):
        yield;return
    previous=signal.pthread_sigmask(signal.SIG_BLOCK,{signal.SIGALRM,signal.SIGTERM})
    try:yield
    finally:signal.pthread_sigmask(signal.SIG_SETMASK,previous)


def frozen_parameters(base,old_adapters):
    params=list(base.parameters())+[p for a in old_adapters for p in a.parameters_to_train()]
    require(not base.training and all(not a.training and not a.enabled for a in old_adapters) and
        all(not p.requires_grad and p.grad is None for p in params), 'Old parameters, adapter switches or gradients changed')


def train_interface(base,interface,old_adapters,lessons,packets,remaining,old_guard,commit,
        stage=lambda *args:None,torch_api=None,loss_function=None):
    """Exactly two balanced passes; each actual optimizer step has a checkpoint.

    Dependency injection exists only for explicitly named offline tests. The
    real runner always uses torch and target_token_loss.
    """
    if torch_api is None:
        import torch as torch_api
    if loss_function is None:loss_function=target_token_loss
    batches=training_batches(lessons)
    require(len(batches)==TRAINING_STEPS and set(packets)=={r['id'] for r in lessons['examples']},'Fixed lesson schedule differs')
    for lesson in lessons['examples']:
        p=packets[lesson['id']]
        require(p['packetHash']==digest({k:v for k,v in p.items() if k!='packetHash'}) and
            p['lessonContentHash']==digest(lesson) and p['studentResponse'] is False and
            p['labelAuthor']=='program_exact_registry_binding' and p['targetText']==lesson['target'] and
            p['targetIds'][-1] in p['actualConfiguredEosIds'],'Only audited program address labels may train')
    params=interface.parameters_to_train();require(params,'Missing independent interface parameters')
    old_guard();frozen_parameters(base,old_adapters)
    require(interface.enabled and not interface.training,'Independent interface must be active with base in evaluation mode')
    for p in params:p.requires_grad_(True);p.grad=None
    optimizer=torch_api.optim.AdamW(params,lr=LEARNING_RATE,weight_decay=0.)
    records=[];initial=interface.digest()
    try:
        for step,batch in enumerate(batches,1):
            if remaining()<=0:raise TimeoutError('Deadline before interface optimizer step')
            old_guard();frozen_parameters(base,old_adapters)
            before=interface.learned_state();before_hash=interface.digest();committed=False
            optimizer.zero_grad(set_to_none=True);losses=[]
            stage(step,[r['id'] for r in batch])
            try:
                for lesson in batch:
                    if remaining()<=0:raise TimeoutError('Deadline before supervised forward')
                    loss=loss_function(base,packets[lesson['id']])
                    number=float(loss.detach().cpu().item())
                    require(math.isfinite(number),'Nonfinite target loss')
                    losses.append(number);(loss/len(batch)).backward()
                    frozen_parameters(base,old_adapters)
                old_guard()
                require(all(p.grad is None or torch_api.isfinite(p.grad).all().item() for p in params),'Nonfinite interface gradient')
                norm=float(torch_api.nn.utils.clip_grad_norm_(params,1.).item())
                require(math.isfinite(norm),'Nonfinite interface gradient norm')
                if remaining()<=0:raise TimeoutError('Deadline before optimizer mutation')
                optimizer.step()
                require(all(torch_api.isfinite(p).all().item() for p in params),'Nonfinite interface state after step')
                old_guard();frozen_parameters(base,old_adapters)
                after_hash=interface.digest()
                row=seal(dict(id='step-'+str(step),stepNumber=step,committed=True,
                    lessonHash=lessons['lessonHash'],lessonIds=[r['id'] for r in batch],
                    packetHashes=[packets[r['id']]['packetHash'] for r in batch],
                    exampleVisits=len(batch),meanTargetTokenLoss=sum(losses)/len(losses),gradientNormBeforeClip=norm,
                    learningRate=LEARNING_RATE,optimizer='AdamW',maxGradientNorm=1.,
                    adapterStateBefore=before_hash,adapterStateAfter=after_hash,
                    programSupervisedLabels=True,sampledStudentGenerations=0,oldParametersFrozen=True,
                    finiteStateVerified=True),'stepHash')
                with checkpoint_boundary():
                    commit(row,interface.learned_state());records.append(row);committed=True
            except BaseException:
                if not committed:interface.restore(before)
                raise
            finally:optimizer.zero_grad(set_to_none=True)
    finally:
        for p in params:p.grad=None;p.requires_grad_(False)
    return dict(id='completed',optimizerSteps=len(records),committedExampleVisits=sum(r['exampleVisits'] for r in records),
        lessonHash=lessons['lessonHash'],programSupervisedLabels=True,finiteStateVerified=True,
        balancedPasses=2,interfaceStateBefore=initial,interfaceStateAfter=interface.digest(),
        interfaceParametersChanged=interface.digest()!=initial,studentGenerationsDuringTraining=0)


def validate_steps(rows,lessons,packets,initial_hash,final_hash):
    require(len(rows)<=TRAINING_STEPS,'Optimizer step budget exceeded');previous=initial_hash
    for index,(row,batch) in enumerate(zip(rows,training_batches(lessons)),1):
        require(row['stepHash']==digest({k:v for k,v in row.items() if k!='stepHash'}) and
            row['stepNumber']==index and row['id']=='step-'+str(index) and row['committed'] is True and
            row['lessonHash']==lessons['lessonHash'] and row['lessonIds']==[r['id'] for r in batch] and
            row['packetHashes']==[packets[r['id']]['packetHash'] for r in batch] and
            row['exampleVisits']==len(batch) and row['adapterStateBefore']==previous and
            row['learningRate']==LEARNING_RATE and row['optimizer']=='AdamW' and row['maxGradientNorm']==1. and
            row['programSupervisedLabels'] is True and row['sampledStudentGenerations']==0 and
            row['oldParametersFrozen'] is True and row['finiteStateVerified'] is True and
            all(type(row[k]) in (int,float) and math.isfinite(row[k]) for k in ('meanTargetTokenLoss','gradientNormBeforeClip')),
            'Committed optimizer lineage, labels or finite-state claim changed')
        previous=row['adapterStateAfter']
    require(previous==final_hash,'Final interface state differs from committed step lineage')
