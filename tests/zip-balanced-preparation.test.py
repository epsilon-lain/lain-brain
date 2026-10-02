"""Real six-example gradient accumulation, weighting and checkpoint gates.

Random tiny local Apertus; scripted inference/review to test control flow, not
official student quality. No external model download or teacher call.
"""
from contextlib import redirect_stdout
from copy import deepcopy
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

import torch
from safetensors.torch import load_file, save_file
from tokenizers import Tokenizer
from tokenizers.models import WordLevel
from tokenizers.pre_tokenizers import Whitespace
from transformers import ApertusConfig, ApertusForCausalLM, PreTrainedTokenizerFast

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
import zip_balanced_preparation as balanced
import zip_interface_warmup as warmup
from zip_pilot import file_digest,load_student
from zip_pilot_protocol import canonical,verify,write_json

torch.set_num_threads(2)
vocab={'[UNK]':0,'[EOS]':1,'x':2,'y':3,'u':4,'v':5,'1':6,'2':7,'3':8,'4':9,'6':10,
       'system':11,'assistant':12,'user':13}
raw=Tokenizer(WordLevel(vocab,unk_token='[UNK]'));raw.pre_tokenizer=Whitespace()
tokenizer=PreTrainedTokenizerFast(tokenizer_object=raw,unk_token='[UNK]',eos_token='[EOS]',pad_token='[EOS]')
tokenizer.chat_template="{% for message in messages %}{{ message['role'] + ': ' + message['content'] + '\\n' }}{% endfor %}{% if add_generation_prompt %}assistant: {% endif %}"
torch.manual_seed(1337)
base=ApertusForCausalLM(ApertusConfig(vocab_size=len(vocab),hidden_size=32,intermediate_size=64,
    num_hidden_layers=2,num_attention_heads=4,num_key_value_heads=2,eos_token_id=1,bos_token_id=None,
    pad_token_id=1,tie_word_embeddings=True,max_position_embeddings=4096,
    rope_theta=500000.,rope_scaling={'rope_type':'linear','factor':1.},attn_implementation='sdpa'))
base.generation_config.eos_token_id=[1]
supplied=balanced.examples()
assert len(supplied)==6 and {e['task']['scale'] for e in supplied}=={1,2,3}
assert all(e['task']['split']=='train' and e['verification']['score']==1 for e in supplied)
answer=supplied[0]['answer']
ids,weights,mask=balanced.target_tokens(tokenizer,answer)
assert len(ids)==len(weights)==len(mask)
assert 8. in weights and 4. in weights and set(weights)=={1.,4.,8.}
encoded=tokenizer(answer,add_special_tokens=False,return_offsets_mapping=True)
radius_start=answer.index('"radius":"')+len('"radius":"')
radius_end=radius_start+3
assert all(w==1 for w,(a,b) in zip(weights,encoded['offset_mapping']) if a<radius_end and b>radius_start)
model=warmup.InterfaceAdapter(base,tokenizer,rank=8)
with torch.no_grad():model.generation_adapter[-1].weight.fill_(.01)
initial={k:v.clone() for k,v in model.adapter_state().items()}
frozen=warmup.state_digest(base)
real_loss=balanced.weighted_loss
def mean_loss():
    with torch.no_grad():return sum(float(real_loss(model,e['messages'],e['answer'])[0]) for e in supplied)/6
before=mean_loss();calls=[];logs=[];validations=[]
def tracked(model_arg,messages,answer):
    # Each group of six examples sees exactly the same adapter parameters.
    calls.append(warmup.state_digest(model_arg.generation_adapter))
    return real_loss(model_arg,messages,answer)
with patch.object(balanced,'weighted_loss',side_effect=tracked):
    count,seconds,reason=balanced.balanced_updates(model,supplied,steps=2,lr=.0003,max_seconds=60,
        log=logs.append,validate=lambda count:validations.append(count) or False)
after=mean_loss()
assert count==2 and len(calls)==12 and validations==[2]
assert len(set(calls[:6]))==len(set(calls[6:]))==1 and calls[0]!=calls[6]
assert all(len(r['metrics'])==6 and r['supervisedExamples']==6 and r['gradNorm']>0 for r in logs)
assert after<before and warmup.state_digest(base)==frozen
assert all(p.grad is None and not p.requires_grad for p in base.parameters())
assert any(not torch.equal(v,initial[k]) for k,v in model.adapter_state().items())
model.close()

with tempfile.TemporaryDirectory(prefix='balanced-prepare-') as temp:
    root=Path(temp);snapshot=root/'student'
    base.save_pretrained(snapshot,safe_serialization=True);tokenizer.save_pretrained(snapshot)
    loaded,tok,metadata=load_student(snapshot,'cpu')
    adapter=warmup.InterfaceAdapter(loaded,tok,rank=8)
    adapter.generation_adapter.load_state_dict({k.removeprefix('generation_adapter.'):v for k,v in initial.items()})
    parent=root/'parent';parent.mkdir()
    parent.with_suffix('.py').write_text('\n'+(ROOT/'tools/zip_interface_warmup.py').read_text())
    save_file(adapter.adapter_state(),str(parent/'interface.safetensors'));adapter.close()
    parent_sha=file_digest(parent/'interface.safetensors')
    write_json(parent/'manifest.json',dict(protocol=warmup.PROTOCOL,stage='supervised-interface-and-toy-task-preparation',
        rank=8,snapshotSha256=metadata['snapshotSha256'],warmupSourceSha256=file_digest(parent.with_suffix('.py'))))
    write_json(parent/'result.json',dict(updates=12,baseWeightsUnchanged=True,adapterSha256=parent_sha))
    recovery_source=root/'recovery.py'
    recovery_source.write_text('\n'+(ROOT/'tools/zip_checkpoint_recovery.py').read_text())
    recovery=balanced.load_recovery(recovery_source)
    generator_source=root/'generator.py'
    generator_source.write_text('\n'+(ROOT/'tools/zip_generate_notes.py').read_text())
    generator=recovery.load_generator(generator_source)
    def claim(task,valid=True):
        a=task.scale
        expression=(f'{2*a}*x*u+{a}*u**2' if task.family=='square' else f'{a}*x*v+{a}*y*u+{a}*u*v') if valid else 'x'
        return canonical(dict(definition='Changing the input adds linear effects and a remainder.',
            expression=expression,scope='exact',radius='0.1',status='asserted'))
    for mode in ['regression','passed']:
        args=SimpleNamespace(student_path=snapshot,parent_run=parent,recovery_source=recovery_source,
            generator=generator_source,out=root/mode,notes_out=root/(mode+'-notes'),steps=2,lr=.0003,max_seconds=60)
        def evaluate(actual_model,tasks,label,out,deadline):
            records=[]
            for task in tasks:
                valid=(task.family=='square') if label=='baseline' else (mode=='passed' or task.family=='product')
                raw=claim(task,valid)
                records.append(dict(task={'key':task.key,'split':task.split,'family':task.family,'scale':task.scale},
                    output=dict(raw=raw,generatedTokens=30),verification=verify(task,raw)))
            return records
        def language(base,tok,messages,cap):return dict(raw='fixture Chinese only',generatedTokens=3)
        def generate_notes(actual_base,tok,messages,cap):
            saved=load_file(str(args.out/'interface.safetensors'))
            hook=next(iter(actual_base.model.layers[1]._forward_hooks.values()))
            assert all(torch.equal(saved[k],v) for k,v in hook.__self__.adapter_state().items())
            assert all(not p.requires_grad for p in hook.__self__.parameters())
            task=next(t for t in warmup.tasks('train') if t.public()['problem']==messages[-1]['content'])
            return dict(raw=claim(task),generatedTokens=30)
        class TeacherFixture:
            def __init__(self,*a,**kw):self.calls=0;assert kw['max_calls']==4
            def review(self,task,draft,check):
                self.calls+=1
                assert check['definitionReviewRequest']==recovery.REVIEW_REQUEST
                return dict(raw='fixture',critique=dict(assessment='CLEAR: fixture',hint='',counterexample='',scope_note=''),
                    cacheHit=False,requestHash='fixture')
        console=io.StringIO()
        with patch.dict(os.environ,{'LAIN_TEACHER_API_KEY':'fixture-secret-not-save'}), \
             patch.object(balanced,'load_recovery',return_value=recovery), \
             patch.object(recovery,'load_generator',return_value=generator), \
             patch.object(recovery,'evaluate',side_effect=evaluate), \
             patch.object(balanced,'base_generate',side_effect=language), \
             patch.object(generator,'base_generate',side_effect=generate_notes), \
             patch.object(generator,'Teacher',TeacherFixture) as teacher,redirect_stdout(console):
            balanced.run(args)
        result=json.loads((args.out/'result.json').read_text())
        assert result['attemptedBalancedUpdates']==2 and result['attemptedSupervisedExamples']==12
        assert result['baseWeightsUnchanged'] and result['rewardUpdates']==result['teacherCallsDuringTraining']==0
        assert result['finalTestOpened'] is False and result['devUsedForCheckpointSelection']
        assert len(list(args.out.glob('checkpoint-*.safetensors')))==2
        if mode=='regression':
            assert result['selectedBalancedUpdate']==0 and not result['publicMathChecksPassed']
            assert not args.notes_out.exists()
            assert all(torch.equal(v,initial[k]) for k,v in load_file(str(args.out/'interface.safetensors')).items())
        else:
            assert result['selectedBalancedUpdate']==2 and result['publicMathChecksPassed']
            archive=json.loads((args.notes_out/'archive.json').read_text())
            assert archive['warmupAdapterSha256']==result['adapterSha256']
            assert len(archive['activeNotes'])==2 and archive['teacherNetworkCalls']==2
            assert archive['trainingUpdates']==archive['rewardUpdates']==0 and not archive['independentDiscovery']
        assert 'fixture-secret-not-save' not in console.getvalue()
    assert file_digest(parent/'interface.safetensors')==parent_sha
    for path in root.rglob('*.json'):assert 'fixture-secret-not-save' not in path.read_text()
print(f'balanced checks passed: 6 targets per real optimizer step, formula weights, frozen base, fixed loss {before:.4f}->{after:.4f}, regression rollback and teacher gate')
