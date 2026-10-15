"""Explicit procedural supervision plus native free generation, with separate credit."""
import math
from zip_weak_guidance_core import require,seal,digest,warm_schedule,WARM_LR,WARM_STEPS
from zip_summary_training_v8_policy import input_limits,prompt_audit,require_input,update_words
from zip_summary_training_v6_policy import generate as old_generate
from zip_interface_training_policy import eos_ids,target_token_loss,checkpoint_boundary

def token_limit(phase):
    return 128 if phase in ('summary_management','guide_validation','guide_final_validation','guidance_revision','interface_probe') else 96

def generate(base,tokenizer,messages,phase,seed,sampled,input_audit):
    # No constrained grammar, appended action, artificial stop or posthoc fix.
    return old_generate(base,tokenizer,messages,
        'experience_summary' if token_limit(phase)==128 else 'route_math',seed,sampled,input_audit)

def encode_lesson(tokenizer,lesson,limits,stops):
    audit=prompt_audit(tokenizer,lesson['prompt'],limits);require_input(audit)
    ids=tokenizer(lesson['target'],add_special_tokens=False,truncation=False)['input_ids']
    require(lesson['target'] in ('USE','SUSPEND') and 0<len(ids)<32 and
        all(type(i) is int and i>=0 and i not in stops for i in ids) and
        tokenizer.decode(ids,skip_special_tokens=False)==lesson['target'],'Changed procedural literal target')
    return seal(dict(lessonId=lesson['id'],lessonContentHash=digest(lesson),promptAudit=audit,
        targetText=lesson['target'],targetIds=ids+[stops[0]],actualConfiguredEosIds=stops,
        labelAuthor='host_procedural_encoding_only',studentResponse=False,
        lossPositions='specified_action_tokens_and_actual_eos_only'),'packetHash')

def train_warm(base,manager,lessons,packets,remaining,guard,commit,stage=lambda *args:None,
        torch_api=None,loss_function=None):
    if torch_api is None:
        import torch as torch_api
    if loss_function is None:loss_function=target_token_loss
    batches=warm_schedule(lessons);require(len(batches)==WARM_STEPS,'Warm step budget')
    for lesson in lessons:
        packet=packets[lesson['id']]
        require(packet['packetHash']==digest({k:v for k,v in packet.items() if k!='packetHash'}) and
            packet['lessonContentHash']==digest(lesson) and packet['targetText']==lesson['target'] and
            packet['labelAuthor']=='host_procedural_encoding_only' and packet['studentResponse'] is False and
            packet['targetIds'][-1] in packet['actualConfiguredEosIds'],'Changed supervised lesson binding')
    parameters=manager.parameters_to_train();optimizer=torch_api.optim.AdamW(parameters,lr=WARM_LR,weight_decay=0.)
    records=[]
    try:
        for index,batch in enumerate(batches,1):
            if remaining()<=0:raise TimeoutError('Deadline before procedural step')
            guard();previous=manager.learned_state();before=manager.digest();committed=False;losses=[]
            for p in parameters:p.requires_grad_(True);p.grad=None
            optimizer.zero_grad(set_to_none=True)
            try:
                for lesson in batch:
                    if remaining()<=0:raise TimeoutError('Deadline before procedural forward')
                    loss=loss_function(base,packets[lesson['id']]);value=float(loss.detach().cpu().item())
                    require(math.isfinite(value),'Nonfinite procedural loss');losses.append(value)
                    (loss/len(batch)).backward()
                require(all(p.grad is None or torch_api.isfinite(p.grad).all().item() for p in parameters),'Nonfinite procedural gradient')
                norm=float(torch_api.nn.utils.clip_grad_norm_(parameters,1.).item())
                require(math.isfinite(norm),'Nonfinite clipped norm')
                if remaining()<=0:raise TimeoutError('Deadline before procedural optimizer mutation')
                optimizer.step();require(all(torch_api.isfinite(p).all().item() for p in parameters),'Nonfinite procedural weights')
                row=seal(dict(id='warm-'+str(index),parameterKind='warm_management',beforeHash=before,afterHash=manager.digest(),
                    lessonIds=[l['id'] for l in batch],packetHashes=[packets[l['id']]['packetHash'] for l in batch],
                    meanTargetTokenLoss=sum(losses)/len(losses),learningRate=WARM_LR,optimizer='AdamW',
                    labelAuthor='host_procedural_encoding_only',studentGenerations=0,
                    targetsSpecifyEncodingNotTaskJudgment=True),'warmHash')
                with checkpoint_boundary():commit(row,manager.learned_state());records.append(row);committed=True
                stage(index)
            except BaseException:
                if not committed:manager.restore(previous)
                raise
            finally:
                optimizer.zero_grad(set_to_none=True)
                for p in parameters:p.requires_grad_(False);p.grad=None
    finally:
        for p in parameters:p.requires_grad_(False);p.grad=None
    guard();return records
