"""One real frozen student; fixed prior v23 + independent meta and text adapters."""
from contextlib import ExitStack,contextmanager
import math
from rr_common import *
from rr_backend import Backend as PreviousBackend
from rr_policy import prompt_ids,generate
from cf_policy import scores,probabilities
from cf_cases import SIGNS,COUNTS,ACTIONS


class Backend(PreviousBackend):
    def __init__(self,args,admitted,plan,out,binding):
        import torch
        from safetensors.torch import load_file,save_file
        from math_writer_adapter import MathWriterAdapter
        super().__init__(args,admitted,plan,out,binding)
        self.prior=MathWriterAdapter(self.base,rank=8,last_layers=4,alpha=16)
        self.prior.restore(load_file(str(admitted['priorPath'])));self.prior.eval()
        require(self.prior.digest()==admitted['priorHash'],'Reviewed prior reflection parameters changed')
        torch.manual_seed(202610141305)
        self.editor=MathWriterAdapter(self.base,rank=8,last_layers=4,alpha=16);self.editor.eval()
        self.editor_control=MathWriterAdapter(self.base,rank=8,last_layers=4,alpha=16);self.editor_control.eval()
        p=self.out/'initial-editor.safetensors'
        if p.is_file():self.editor.restore(load_file(str(p)))
        else:
            temp=p.with_name(p.name+'.'+uuid.uuid4().hex+'.tmp')
            try:
                save_file(self.editor.learned_state(),str(temp))
                with temp.open('rb') as f:os.fsync(f.fileno())
                os.replace(temp,p)
            finally:
                if temp.exists():temp.unlink()
        self.editor_control.restore(self.editor.learned_state())
        self.initial_editor_hash=self.editor.digest();self.initial_editor_control_hash=self.editor_control.digest()
        for m in (self.prior,self.editor,self.editor_control):
            for t in m.parameters_to_train():t.requires_grad_(False);t.grad=None
        self.editor_optimizer=torch.optim.AdamW(self.editor.parameters_to_train(),lr=plan['recipe']['editorLearningRate'],weight_decay=0.)
        self.editor_control_optimizer=torch.optim.AdamW(self.editor_control.parameters_to_train(),lr=plan['recipe']['editorLearningRate'],weight_decay=0.)
        eos=self.base.generation_config.eos_token_id
        if eos is None:eos=self.tokenizer.eos_token_id
        eos=eos[0] if isinstance(eos,list) else eos;require(type(eos) is int,'Need native EOS')
        self.legal={names:{a:self.tokenizer(a,add_special_tokens=False,truncation=False)['input_ids']+[eos] for a in names} for names in (SIGNS,COUNTS,ACTIONS)}
        require(all(1<len(x)<=12 for group in self.legal.values() for x in group.values()),'Unexpected legal-choice tokenization')
        provenance=args.student/'lain-snapshot.json'
        if provenance.is_file():put_once(self.out/'student-snapshot-provenance.json',read(provenance))

    def adapter(self,arm,kind):
        return (self.editor if arm=='rewarded' else self.editor_control) if kind in ('editor','reflection') else (self.actor if arm=='rewarded' else self.control)

    @contextmanager
    def mode(self,arm=None,kind='memory'):
        meta=kind in ('property','memory');edit=kind in ('editor','reflection')
        with ExitStack() as s:
            for module,enabled in [(self.writer,kind in ('editor','reflection','math','cold')),
                (self.repair,kind!='cold'),(self.prior,meta),
                (self.actor,meta and arm=='rewarded'),(self.control,meta and arm=='zero_reward'),
                (self.editor,edit and arm=='rewarded'),(self.editor_control,edit and arm=='zero_reward')]:
                s.enter_context(module.active(enabled))
            yield

    def set_phase(self,phase):
        for module,train in [(self.actor,phase=='meta'),(self.editor,phase=='editor')]:
            for p in module.parameters_to_train():p.requires_grad_(train);p.grad=None
        self.phase=phase

    def fixed_modules(self,phase):
        return (self.writer,self.repair,self.prior,self.control,self.editor_control,
            self.editor if phase=='meta' else self.actor)

    def choose(self,phase,case,messages,arm,names=ACTIONS,kind='memory'):
        import torch
        self.before_call();targets=self.legal[tuple(names)];adapter=self.adapter(arm,kind)
        prefix=prompt_ids(self.tokenizer,messages,12,self.context)
        key=dict(phase=phase,caseId=case['id'],caseSplit=case['split'],caseCardId=case['card']['id'],
            arm=arm,kind=kind,messages=messages,promptIds=prefix,candidateTokens=targets,
            adapterHash=adapter.digest(),priorHash=self.prior.digest(),sourceBindingHash=digest(self.binding))
        rid='cf-choice-'+digest(key)[:24];path=self.out/'decisions'/(rid+'.json')
        if path.is_file():r=read(path);check_seal(r);require(r['binding']==key,'Cached choice binding changed')
        else:
            require(len(list((self.out/'decisions').glob('*.json')))<self.plan['recipe']['maxDecisionRecords'],'Decision cap exceeded')
            cache_key={k:key[k] for k in ('promptIds','candidateTokens','kind','adapterHash','priorHash','sourceBindingHash')}
            # Equal frozen adapters can share scoring, but not claim independent evidence.
            cp=self.out/'score-cache'/('cf-score-'+digest(cache_key)+'.json')
            if cp.is_file():
                cache=read(cp);check_seal(cache);require(cache['binding']==cache_key,'Score cache binding changed');values=cache['values']
            else:
                with self.mode(arm,kind),torch.no_grad():values=[float(x) for x in scores(self.base,prefix,targets)]
                put_once(cp,sealed(dict(binding=cache_key,values=values)))
            ps=probabilities(values,list(targets));action=max(targets,key=lambda a:ps[a])
            r=sealed(dict(recordId=rid,binding=key,caseId=case['id'],caseSplit=case['split'],caseCardId=case['card']['id'],
                studentPrompt=messages,promptIds=prefix,candidateTokens=targets,candidateScores=values,
                action=action,probabilities=ps,adapterHash=adapter.digest(),fixtureOnly=False,
                expectedActionSuppliedToModel=False,modelSelectedMemoryAction=kind=='memory',
                candidateVocabularyProvided=True,freeTextGenerationClaimed=False,
                actionScoreNormalization='mean token log probability including native EOS'))
            put_once(path,r)
        ps=probabilities(r['candidateScores'],list(targets))
        require(r['candidateTokens']==targets and r['probabilities']==ps and r['action']==max(targets,key=lambda a:ps[a]) and
            r['adapterHash']==adapter.digest() and r['fixtureOnly'] is False,'Cached policy choice changed')
        return r

    def ask(self,phase,case,messages,arm=None,kind='math',seed=None,max_tokens=96,sampled=False):
        self.before_call();require(kind in ('math','cold','editor','reflection'),'Unexpected native generation mode')
        seed=seed if seed is not None else int(digest(dict(phase=phase,case=case['id']))[:12],16)
        prefix=prompt_ids(self.tokenizer,messages,max_tokens,self.context)
        ah=self.adapter(arm,kind).digest() if kind in ('editor','reflection') else 'disabled'
        key=dict(phase=phase,caseId=case['id'],caseSplit=case['split'],caseCardId=case['card']['id'],messages=messages,
            promptIds=prefix,arm=arm,kind=kind,seed=seed,sampled=sampled,maxTokens=max_tokens,
            adapterHash=ah,sourceBindingHash=digest(self.binding))
        rid='cf-raw-'+digest(key)[:24];path=self.out/'responses'/(rid+'.json')
        if path.is_file():r=read(path);check_seal(r);require(r['binding']==key,'Cached original binding changed')
        else:
            require(len(list((self.out/'responses').glob('*.json')))<self.plan['recipe']['maxRawGenerations'],'Raw generation cap exceeded')
            with self.mode(arm,kind):o=generate(self.base,self.tokenizer,messages,seed,self.context,max_tokens,sampled)
            o.update(mathAdapterEnabledDuringGeneration=True,oldRepairEnabledDuringGeneration=kind!='cold',
                newAdapterHash=ah,priorReflectionEnabledDuringGeneration=False)
            r=sealed(dict(recordId=rid,binding=key,caseId=case['id'],caseCardId=case['card']['id'],caseSplit=case['split'],
                phase=phase,studentPrompt=messages,studentOutput=o,fixtureOnly=False,hostCorrectnessVerdictSupplied=False))
            put_once(path,r)
        o=r['studentOutput'];eos=self.base.generation_config.eos_token_id
        if eos is None:eos=self.tokenizer.eos_token_id
        stops=set(eos if isinstance(eos,list) else [eos])-{None}
        require(not r['fixtureOnly'] and not o.get('testDouble') and o['originalTextRepaired'] is False and
            o['promptIds']==prefix and 0<o['generatedTokens']==len(o['generatedIds'])==len(o['samplingTokenLogProbabilities'])<=max_tokens and
            self.tokenizer.decode(o['generatedIds'],skip_special_tokens=True)==o['raw'] and
            abs(sum(o['samplingTokenLogProbabilities'])-o['samplingLogProbability'])<1e-10 and
            o['mathAdapterEnabledDuringGeneration'] is True and o['oldRepairEnabledDuringGeneration']==(kind!='cold') and
            o['priorReflectionEnabledDuringGeneration'] is False and
            o['newAdapterHash']==ah and o['sampled']==sampled and o['temperature']==(.8 if sampled else 1.) and
            o['responseTokenLimit']==max_tokens and (o['stopReason']=='eos')==(o['generatedIds'][-1] in stops),
            'Untouched native generation record changed')
        return r

    def frozen_integrity(self):
        super().frozen_integrity()
        require(self.prior.digest()==self.admitted['priorHash'] and self.editor_control.digest()==self.initial_editor_control_hash and
            all(p.grad is None for m in (self.prior,self.editor_control) for p in m.parameters_to_train()),'Frozen prior/editor control changed')
        return True

    def close(self):
        for m in (self.editor_control,self.editor,self.prior):m.close()
        super().close()
