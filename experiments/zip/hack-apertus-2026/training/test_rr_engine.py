"""Explicit non-student fixtures test orchestration. They must never count as real results."""
import contextlib
import copy
import fcntl
import io
import json
from pathlib import Path
import tempfile
from types import ModuleType,SimpleNamespace
import unittest
from unittest.mock import patch
import sys
from rr_common import *
from rr_cases import *
from rr_backend import Backend
from rr_store import publish,commits
from rr_test_fixtures import fixture_cards
import rr_run


class Switch:
    def __init__(self):self.enabled=True
    @contextlib.contextmanager
    def active(self,value):
        old=self.enabled;self.enabled=value
        try:yield
        finally:self.enabled=old


class ModeTests(unittest.TestCase):
    def test_trained_reflection_is_actually_on_and_old_repair_is_not_silently_off(self):
        b=Backend.__new__(Backend)
        b.writer=Switch();b.repair=Switch();b.actor=Switch();b.control=Switch()
        for arm,math,cold,expected_flags in [('rewarded',False,False,(False,True,True,False)),
            ('zero_reward',False,False,(False,True,False,True)),
            ('rewarded',True,False,(True,True,False,False)),
            (None,True,True,(True,False,False,False))]:
            with b.mode(arm,math,cold):self.assertEqual(tuple(m.enabled for m in (b.writer,b.repair,b.actor,b.control)),expected_flags)
            self.assertTrue(all(m.enabled for m in (b.writer,b.repair,b.actor,b.control)))


class FakeActor:
    def __init__(self):self.ordinal=0
    def digest(self):return 'fixture-reflection-'+str(self.ordinal)
    def learned_state(self):return dict(ordinal=self.ordinal)
    def restore(self,v):self.ordinal=v['ordinal']
    def parameters_to_train(self):return []


class FakeOptimizer:
    def state_dict(self):return dict(fixture=True)
    def load_state_dict(self,v):pass


class FakeBackend:
    is_fixture=True
    pause_step=None
    def __init__(self,args,admitted,plan,out,binding):
        self.out=Path(out);self.plan=plan;self.binding=binding;self.admitted=admitted
        self.actor=FakeActor();self.control=FakeActor();self.writer=FakeActor();self.repair=FakeActor();self.base=object()
        self.initial_actor_hash=self.actor.digest();self.initial_control_hash=self.control.digest()
        self.optimizer=FakeOptimizer();self.control_optimizer=FakeOptimizer();self.before_call=lambda:None
        p=self.out/'initial-reflection.safetensors'
        if not p.exists():p.write_text(json.dumps(self.actor.learned_state()))
    @contextlib.contextmanager
    def mode(self,*a,**kw):yield
    def frozen_integrity(self):return True
    def close(self):pass
    def choose(self,phase,case,messages,arm,seed,sampled=False,epsilon=0.):
        self.before_call()
        if self.pause_step and phase=='train_step_'+str(self.pause_step):raise InterruptedError('fixture interruption')
        actor=self.actor if arm=='rewarded' else self.control
        binding=dict(phase=phase,caseId=case['id'],arm=arm,reflectionHash=actor.digest(),
            sourceBindingHash=digest(self.binding),messages=messages,seed=seed)
        rid='fixture-choice-'+digest(binding)[:24];path=self.out/'decisions'/(rid+'.json')
        if path.is_file():return check_seal(read(path))
        # Deliberately scripted test-only policy; NOT an empirical learning result.
        action=expected(case) if actor.ordinal else 'KEEP'
        ps=dict(KEEP=.8 if action=='KEEP' else .2,RETRACT=.8 if action=='RETRACT' else .2)
        r=sealed(dict(recordId=rid,binding=binding,caseId=case['id'],caseSplit=case['split'],caseCardId=case['card']['id'],
            action=action,probabilities=ps,reflectionHash=actor.digest(),expectedActionSuppliedToModel=False,
            sampled=sampled,exploration=epsilon,fixtureOnly=True,testDouble=True))
        put_once(path,r);return r
    def ask(self,phase,case,messages,arm=None,math=False,cold=False,seed=None,max_tokens=128):
        self.before_call();binding=dict(phase=phase,caseId=case['id'],messages=messages,arm=arm,math=math,cold=cold)
        rid='fixture-raw-'+digest(binding)[:24];path=self.out/'responses'/(rid+'.json')
        if path.is_file():return check_seal(read(path))
        if cold:output=copy.deepcopy(self.admitted['coldRecord']['studentOutput'])
        else:
            text='SKIP' if math else 'Fixture text: this is NOT a real student reflection.'
            output=dict(raw=text,tokenCapReached=False,originalTextRepaired=False,testDouble=True)
        r=sealed(dict(recordId=rid,binding=binding,caseId=case['id'],phase=phase,
            studentPrompt=messages,studentOutput=output,fixtureOnly=True,testDouble=True))
        put_once(path,r);return r


def fake_update(base,actor,writer,repair,optimizer,rows,rewards,contexts,zero_reward=False):
    before=actor.digest()
    if not zero_reward:actor.ordinal+=1
    return dict(beforeReflectionHash=before,afterReflectionHash=actor.digest(),parameterChanged=not zero_reward,
        appliedRewards=[0.,0.] if zero_reward else rewards,sourceDecisionIds=[r['recordId'] for r in rows],
        sourceDecisionHashes=[r['hash'] for r in rows],
        optimizerStep=not zero_reward,zeroRewardControl=zero_reward,fixtureOnly=True)


class RuntimeFixtureTests(unittest.TestCase):
    def setup_run(self,root,steps=3):
        root=Path(root);source=root/'source';source.mkdir();notes=root/'notes';notes.mkdir()
        cold=dict(recordId='fixture-old',studentPrompt=[dict(role='user',content='Fixture replay')],binding=dict(seed=1),
            studentOutput=dict(raw='fixture',promptIds=[1],generatedIds=[2],generatedTokens=1,sampled=False,
                temperature=1.,tokenCapReached=False,mathAdapterEnabledDuringGeneration=True))
        admitted=dict(cards=fixture_cards(),protected={},sourceRecords={'fixture-old':cold},coldRecord=cold,
            binding=dict(initialBaseHash='fixture-base'),deployment=dict(writerHash='fixture-writer',repairHash='fixture-repair'),
            writer=root/'writer',repair=root/'repair')
        args=SimpleNamespace(source=source,notes_source=notes,out=root/'run',work=root,
            student=root/'student',old_tools=root/'old-tools',steps=steps,learning_rate=.0003,
            quick=True,payload='fixture-payload',seconds=600,live=None)
        modules={n:ModuleType(n) for n in ['torch','safetensors','safetensors.torch']}
        modules['torch'].save=lambda value,path:Path(path).write_text(json.dumps(value))
        modules['torch'].load=lambda path,**kw:read(path)
        modules['safetensors.torch'].save_file=lambda value,path:Path(path).write_text(json.dumps(value))
        modules['safetensors.torch'].load_file=lambda path:read(path)
        return args,admitted,modules
    @contextlib.contextmanager
    def patched(self,admitted,modules):
        with patch.object(rr_run,'admit',return_value=admitted),patch.object(rr_run,'Backend',FakeBackend),\
            patch.object(rr_run,'update',side_effect=fake_update),patch.dict(sys.modules,modules),\
            contextlib.redirect_stdout(io.StringIO()):yield

    def test_pause_after_committed_updates_then_resume_without_duplicate_commits(self):
        with tempfile.TemporaryDirectory() as folder:
            args,a,modules=self.setup_run(folder)
            FakeBackend.pause_step=3
            with self.patched(a,modules):first=rr_run.run(args)
            self.assertFalse(first['complete']);self.assertEqual(first['committedReflectionSteps'],2)
            self.assertTrue(first['fixtureOnly'])
            old_receipts={p.name:(p/'receipt.json').read_bytes() for p in (args.out/'committed').glob('step-*')}
            FakeBackend.pause_step=None
            with self.patched(a,modules):done=rr_run.run(args)
            self.assertTrue(done['complete']);self.assertTrue(done['fixtureOnly'])
            self.assertEqual(done['committedReflectionSteps'],3);self.assertEqual(done['zeroRewardParameterChanges'],0)
            for p in (args.out/'committed').glob('step-*'):
                if p.name in old_receipts:self.assertEqual((p/'receipt.json').read_bytes(),old_receipts[p.name])
            self.assertTrue(all(r['memoryReloadedFromDiskBeforeReuse'] for r in done['realMemoryRevisions']))

    def test_complete_structural_trace_cannot_be_reported_as_real_student_evidence(self):
        with tempfile.TemporaryDirectory() as folder:
            args,a,modules=self.setup_run(folder,steps=1);FakeBackend.pause_step=None
            with self.patched(a,modules):done=rr_run.run(args)
            self.assertTrue(done['fixtureOnly'])
            self.assertTrue(all(r['ownReflection']['semanticTruthAutomaticallyCertified'] is False for r in done['realMemoryRevisions']))
            self.assertTrue(all(not x['audit']['correct'] for r in done['realMemoryRevisions'] for x in r['updatedMath'].values()))
            self.assertTrue(any(r['operationalMemoryRevisionComparedWithZeroReward'] for r in done['operationalRevisionCandidates']))

    def test_changed_committed_weight_bytes_are_rejected_on_resume(self):
        with tempfile.TemporaryDirectory() as folder:
            args,a,modules=self.setup_run(folder,steps=2);FakeBackend.pause_step=2
            with self.patched(a,modules):rr_run.run(args)
            path=args.out/'committed/step-0001/reflection.safetensors';path.write_text('tampered')
            FakeBackend.pause_step=None
            with self.patched(a,modules):
                with self.assertRaisesRegex(ValueError,'Committed file changed'):rr_run.run(args)

    def test_duplicate_commit_is_rejected_even_when_the_files_look_complete(self):
        with tempfile.TemporaryDirectory() as folder:
            args,a,modules=self.setup_run(folder,steps=1);FakeBackend.pause_step=None
            with self.patched(a,modules):rr_run.run(args)
            b=read(args.out/'source-checkpoint.json');r=read(args.out/'committed/step-0001/receipt.json')
            with self.assertRaisesRegex(ValueError,'duplicate'):
                publish(args.out,1,b,r['rewarded'],r['control'],r['feedback'],lambda p:None)

    def test_busy_experiment_is_not_trained_or_overwritten_by_a_second_process(self):
        with tempfile.TemporaryDirectory() as folder:
            args,a,modules=self.setup_run(folder,steps=1);FakeBackend.pause_step=None
            with self.patched(a,modules):rr_run.run(args)
            result_before=(args.out/'result.json').read_bytes()
            with (args.out/'experiment.lock').open('a') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                with self.patched(a,modules):
                    with self.assertRaisesRegex(RuntimeError,'already running'):rr_run.run(args)
            self.assertEqual(result_before,(args.out/'result.json').read_bytes())
            self.assertFalse((args.out/'partial-result.json').exists());self.assertFalse((args.out/'error.json').exists())

    def test_resealed_changed_decision_cannot_break_a_committed_reward_receipt(self):
        with tempfile.TemporaryDirectory() as folder:
            args,a,modules=self.setup_run(folder,steps=1);FakeBackend.pause_step=None
            with self.patched(a,modules):rr_run.run(args)
            receipt=read(args.out/'committed/step-0001/receipt.json');rid=receipt['rewarded']['sourceDecisionIds'][0]
            path=args.out/'decisions'/(rid+'.json');r=read(path);r.pop('hash')
            r['action']='KEEP' if r['action']=='RETRACT' else 'RETRACT';atomic_json(path,sealed(r))
            with self.patched(a,modules):
                with self.assertRaisesRegex(ValueError,'decision provenance'):rr_run.run(args)


if __name__=='__main__':unittest.main()
