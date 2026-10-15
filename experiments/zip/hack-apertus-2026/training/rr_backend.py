"""One frozen real student, two new independent reflection adapters, bounded audit caches."""
from contextlib import ExitStack,contextmanager
import math
from pathlib import Path
from rr_common import *
from rr_policy import action_tokens,prompt_ids,scores,select,generate
from zip_management_head_budget import state_digest


class Backend:
    is_fixture=False
    def __init__(self,args,admitted,plan,out,binding):
        import torch
        from safetensors.torch import load_file,save_file
        from zip_pilot import load_student
        from math_writer_adapter import MathWriterAdapter
        self.args=args;self.out=Path(out);self.plan=plan;self.binding=binding;self.admitted=admitted
        self.base,self.tokenizer,identity=load_student(args.student,'cpu')
        require(identity['snapshotSha256']==admitted['identity']['identity']['snapshotSha256'] and
            read(args.student/'config.json')==admitted['identity']['configuration'],'Base/tokenizer snapshot changed')
        self.base.eval().requires_grad_(False)
        require(state_digest(self.base)==admitted['binding']['initialBaseHash'],'Base memory weights changed')
        put_once(self.out/'model-identity.json',dict(identity=identity,configuration=read(args.student/'config.json')))
        self.writer=MathWriterAdapter(self.base,rank=8,last_layers=4,alpha=16)
        self.writer.restore(load_file(str(admitted['writer'])));self.writer.eval()
        self.repair=MathWriterAdapter(self.base,rank=8,last_layers=4,alpha=16)
        self.repair.restore(load_file(str(admitted['repair'])));self.repair.eval()
        require(self.writer.digest()==admitted['deployment']['writerHash'] and
            self.repair.digest()==admitted['deployment']['repairHash'],'Old adapter parameters changed')
        torch.manual_seed(202610140123)
        self.actor=MathWriterAdapter(self.base,rank=8,last_layers=4,alpha=16);self.actor.eval()
        self.control=MathWriterAdapter(self.base,rank=8,last_layers=4,alpha=16);self.control.eval()
        initial=self.out/'initial-reflection.safetensors'
        if initial.is_file():self.actor.restore(load_file(str(initial)))
        else:
            temp=initial.with_name(initial.name+'.'+uuid.uuid4().hex+'.tmp')
            try:
                save_file(self.actor.learned_state(),str(temp))
                with temp.open('rb') as f:os.fsync(f.fileno())
                os.replace(temp,initial)
            finally:
                if temp.exists():temp.unlink()
        self.control.restore(self.actor.learned_state())
        for m in (self.writer,self.repair,self.control):
            for p in m.parameters_to_train():p.requires_grad_(False);p.grad=None
        for p in self.actor.parameters_to_train():p.requires_grad_(True);p.grad=None
        self.optimizer=torch.optim.AdamW(self.actor.parameters_to_train(),lr=plan['recipe']['learningRate'],weight_decay=0.)
        self.control_optimizer=torch.optim.AdamW(self.control.parameters_to_train(),lr=plan['recipe']['learningRate'],weight_decay=0.)
        self.initial_actor_hash=self.actor.digest();self.initial_control_hash=self.control.digest()
        require(self.initial_actor_hash==self.initial_control_hash,'Reward and control must start identically')
        self.targets=action_tokens(self.tokenizer,self.base)
        configured=read(args.student/'config.json')['max_position_embeddings']
        token_limit=getattr(self.tokenizer,'model_max_length',configured)
        self.context=min(configured,token_limit) if type(token_limit) is int and token_limit<1000000000 else configured
        self.base_hash=state_digest(self.base)
        self.before_call=lambda:None

    def hashes(self):
        return dict(base=self.base_hash,writer=self.writer.digest(),oldRepair=self.repair.digest(),
            rewardedReflection=self.actor.digest(),zeroRewardReflection=self.control.digest())

    @contextmanager
    def mode(self,arm=None,math=False,cold=False):
        # Reflection keeps the already trained old repair ON. This fixes v22's blind spot.
        with ExitStack() as stack:
            stack.enter_context(self.writer.active(math))
            stack.enter_context(self.repair.active(not cold))
            stack.enter_context(self.actor.active(arm=='rewarded' and not math and not cold))
            stack.enter_context(self.control.active(arm=='zero_reward' and not math and not cold))
            yield

    def choose(self,phase,case,messages,arm,seed,sampled=False,epsilon=0.):
        import torch
        self.before_call()
        require(arm in ('rewarded','zero_reward'),'Unknown reflection arm')
        prefix=prompt_ids(self.tokenizer,messages,12,self.context)
        actor=self.actor if arm=='rewarded' else self.control
        state=self.hashes();key=dict(phase=phase,caseId=case['id'],caseSplit=case['split'],caseCardId=case['card']['id'],
            messages=messages,promptIds=prefix,arm=arm,seed=seed,sampled=sampled,exploration=epsilon,
            reflectionHash=actor.digest(),oldRepairHash=state['oldRepair'],writerEnabled=False,
            oldRepairEnabled=True,newReflectionEnabled=True,sourceBindingHash=digest(self.binding))
        rid='choice-'+digest(key)[:24];path=self.out/'decisions'/(rid+'.json')
        if path.is_file():
            r=read(path);check_seal(r);require(r['binding']==key,'Cached action binding changed')
        else:
            require(len(list((self.out/'decisions').glob('*.json')))<self.plan['recipe']['maxDecisionRecords'],'Action cap exceeded')
            # Identical frozen states share scores, but each sampled action retains its own seed/receipt.
            cache_key=dict(promptIds=prefix,candidateTokens=self.targets,reflectionHash=actor.digest(),
                oldRepairHash=state['oldRepair'],baseHash=self.base_hash)
            cache_path=self.out/'score-cache'/('score-'+digest(cache_key)+'.json')
            if cache_path.is_file():
                cached=read(cache_path);check_seal(cached);require(cached['binding']==cache_key,'Score cache changed')
                values=cached['values']
            else:
                with self.mode(arm),torch.no_grad():
                    values=[float(x) for x in scores(self.base,prefix,self.targets).detach().cpu()]
                require(all(math.isfinite(x) for x in values),'Nonfinite candidate scores')
                put_once(cache_path,sealed(dict(binding=cache_key,values=values)))
            action,ps=select(values,seed,epsilon,sampled)
            r=sealed(dict(recordId=rid,binding=key,caseId=case['id'],caseSplit=case['split'],caseCardId=case['card']['id'],
                studentPrompt=messages,promptIds=prefix,candidateTokens=self.targets,candidateScores=values,
                action=action,probabilities=ps['model'],samplingProbabilities=ps['sampling'],
                actionLogProbability=math.log(ps['sampling'][action]),sampled=sampled,exploration=epsilon,
                reflectionHash=actor.digest(),fixtureOnly=False,expectedActionSuppliedToModel=False,
                actionScoreNormalization='mean token log probability including native EOS',
                candidateVocabularyProvided=True,freeTextGenerationClaimed=False,modelSelectedMemoryAction=True))
            put_once(path,r)
        action,ps=select(r['candidateScores'],seed,epsilon,sampled)
        require(r['action']==action and r['probabilities']==ps['model'] and r['samplingProbabilities']==ps['sampling'] and
            r['candidateTokens']==self.targets and r['promptIds']==prefix and r['fixtureOnly'] is False and
            r['reflectionHash']==actor.digest() and abs(r['actionLogProbability']-math.log(ps['sampling'][action]))<1e-10,
            'Saved action no longer matches the actual policy')
        return r

    def ask(self,phase,case,messages,arm=None,math=False,cold=False,seed=None,max_tokens=128):
        self.before_call()
        seed=seed if seed is not None else int(digest(dict(phase=phase,case=case['id']))[:12],16)
        prefix=prompt_ids(self.tokenizer,messages,max_tokens,self.context)
        reflection_hash=self.actor.digest() if arm=='rewarded' and not math else self.control.digest() if arm=='zero_reward' and not math else 'disabled'
        key=dict(phase=phase,caseId=case['id'],messages=messages,promptIds=prefix,arm=arm,math=math,cold=cold,
            seed=seed,maxTokens=max_tokens,reflectionHash=reflection_hash,oldRepairEnabled=not cold,
            writerEnabled=math,sourceBindingHash=digest(self.binding))
        rid='raw-'+digest(key)[:24];path=self.out/'responses'/(rid+'.json')
        if path.is_file():
            r=read(path);check_seal(r);require(r['binding']==key,'Cached original text binding changed')
        else:
            require(len(list((self.out/'responses').glob('*.json')))<self.plan['recipe']['maxRawGenerations'],'Raw generation cap exceeded')
            with self.mode(arm,math,cold):
                output=generate(self.base,self.tokenizer,messages,seed,self.context,max_tokens=max_tokens)
            output.update(mathAdapterEnabledDuringGeneration=math,oldRepairEnabledDuringGeneration=not cold,
                newReflectionAdapterHash=reflection_hash)
            r=sealed(dict(recordId=rid,binding=key,caseId=case['id'],phase=phase,studentPrompt=messages,
                studentOutput=output,fixtureOnly=False,hostCorrectnessVerdictSupplied=False))
            put_once(path,r)
        v=r['studentOutput'];eos=self.base.generation_config.eos_token_id
        if eos is None:eos=self.tokenizer.eos_token_id
        stops=set(eos if isinstance(eos,list) else [eos])-{None}
        require(r['fixtureOnly'] is False and not v.get('testDouble') and v['originalTextRepaired'] is False and
            v['promptIds']==prefix and 0<v['generatedTokens']==len(v['generatedIds'])==len(v['samplingTokenLogProbabilities'])<=max_tokens and
            self.tokenizer.decode(v['generatedIds'],skip_special_tokens=True)==v['raw'] and
            v['mathAdapterEnabledDuringGeneration']==math and v['oldRepairEnabledDuringGeneration']==(not cold) and
            v['newReflectionAdapterHash']==reflection_hash and v['responseTokenLimit']==max_tokens and
            abs(sum(v['samplingTokenLogProbabilities'])-v['samplingLogProbability'])<1e-10 and
            (v['stopReason']=='eos')==(v['generatedIds'][-1] in stops),'Original generation tokens, budget or adapter mode changed')
        return r

    def frozen_integrity(self):
        require(state_digest(self.base)==self.base_hash and self.writer.digest()==self.admitted['deployment']['writerHash'] and
            self.repair.digest()==self.admitted['deployment']['repairHash'] and self.control.digest()==self.initial_control_hash,
            'Protected base/old adapters/zero-reward control changed')
        require(all(p.grad is None for p in self.base.parameters()) and
            all(p.grad is None for m in (self.writer,self.repair,self.control) for p in m.parameters_to_train()),
            'Protected gradients present')
        return True

    def close(self):
        for m in (self.control,self.actor,self.repair,self.writer):m.close()
