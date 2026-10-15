"""Explicit fixtures test recovery only. No fixture is student evidence."""
import contextlib
import copy
import fcntl
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import test_rr_engine as old_fixture
import cf_run
from rr_common import *
from rr_cases import make_plan as old_plan
from rr_test_fixtures import fixture_cards
from cf_cases import *
from cf_store import FILES,commits
from cf_backend import Backend


class FakeBackend:
    is_fixture=True
    pause_phase=None
    def __init__(self,args,admitted,plan,out,binding):
        self.out=Path(out);self.admitted=admitted;self.plan=plan;self.binding=binding;self.before_call=lambda:None
        for n in ('actor','control','editor','editor_control'):setattr(self,n,old_fixture.FakeActor())
        self.base=object();self.optimizer=self.control_optimizer=self.editor_optimizer=self.editor_control_optimizer=old_fixture.FakeOptimizer()
        for name in ('initial-reflection.safetensors','initial-editor.safetensors'):
            if not (self.out/name).exists():(self.out/name).write_text(json.dumps(self.actor.learned_state()))
    def set_phase(self,p):self.phase=p
    def fixed_modules(self,p):return ()
    @contextlib.contextmanager
    def mode(self,*a,**kw):yield
    def frozen_integrity(self):return True
    def close(self):pass
    def choose(self,phase,c,messages,arm,names=ACTIONS,kind='memory'):
        if self.pause_phase and phase.startswith(self.pause_phase):raise InterruptedError('explicit fixture pause')
        actor=self.actor if arm=='rewarded' else self.control
        binding=dict(phase=phase,caseId=c['id'],arm=arm,adapterHash=actor.digest(),sourceBindingHash=digest(self.binding),messages=messages)
        rid='fixture-choice-'+digest(binding)[:24];path=self.out/'decisions'/(rid+'.json')
        if path.is_file():return check_seal(read(path))
        # Scripted fixture truth is solely for testing the evidence pipeline.
        role=next((r for r in ROLES if phase.endswith('_'+r)),None)
        action=property_truth(c,role) if role else 'RETRACT' if phase.endswith('_after') and actor.ordinal and ideal_action(c)=='RETRACT' else 'KEEP'
        ps={a:.8 if a==action else .2/(len(names)-1) for a in names}
        r=sealed(dict(recordId=rid,binding=binding,caseId=c['id'],caseSplit=c['split'],caseCardId=c['card']['id'],
            action=action,probabilities=ps,adapterHash=actor.digest(),candidateTokens={a:[1] for a in names},
            expectedActionSuppliedToModel=False,fixtureOnly=True,testDouble=True))
        put_once(path,r);return r
    def ask(self,phase,c,messages,arm=None,kind='math',**kw):
        adapter=self.editor if arm=='rewarded' else self.editor_control
        binding=dict(phase=phase,caseId=c['id'],caseSplit=c['split'],arm=arm,adapterHash=adapter.digest() if kind in ('editor','reflection') else 'disabled',sourceBindingHash=digest(self.binding),messages=messages)
        rid='fixture-raw-'+digest(binding)[:24];path=self.out/'responses'/(rid+'.json')
        if path.is_file():return check_seal(read(path))
        output=copy.deepcopy(self.admitted['coldRecord']['studentOutput']) if kind=='cold' else dict(raw='SKIP',tokenCapReached=False,originalTextRepaired=False,testDouble=True)
        r=sealed(dict(recordId=rid,binding=binding,caseId=c['id'],caseSplit=c['split'],caseCardId=c['card']['id'],
            studentPrompt=messages,studentOutput=output,fixtureOnly=True,testDouble=True))
        put_once(path,r);return r


def fake_update(base,actor,optimizer,rows,values,contexts,protected,zero=False):
    before=actor.digest()
    if not zero:actor.ordinal+=1
    return dict(beforeHash=before,afterHash=actor.digest(),parameterChanged=not zero,optimizerStep=not zero,
        zeroRewardControl=zero,sourceIds=[r['recordId'] for r in rows],sourceHashes=[r['hash'] for r in rows],returnTables=values,fixtureOnly=True)


def fake_editor(*args,**kw):
    actor=args[1];rows=args[3];values=args[4];zero=kw.get('zero',False)
    return dict(beforeHash=actor.digest(),afterHash=actor.digest(),parameterChanged=False,optimizerStep=False,
        zeroRewardControl=zero,sourceIds=[r['recordId'] for r in rows],sourceHashes=[r['hash'] for r in rows],observedRewards=values,fixtureOnly=True)


def fake_save(b,p):
    for filename,module in [('meta.safetensors',b.actor),('meta-control.safetensors',b.control),('editor.safetensors',b.editor),('editor-control.safetensors',b.editor_control)]:
        (p/filename).write_text(json.dumps(module.learned_state()))
    for n in ('meta-optimizer.pt','editor-optimizer.pt'):(p/n).write_text('{"fixtureOnly":true}')


def fake_restore(b,p):
    for filename,module in [('meta.safetensors',b.actor),('meta-control.safetensors',b.control),('editor.safetensors',b.editor),('editor-control.safetensors',b.editor_control)]:module.restore(read(p/filename))


class EngineTests(unittest.TestCase):
    def setup_run(self,root):
        root=Path(root);source=root/'source';source.mkdir()
        cold=dict(recordId='fixture-old',studentPrompt=[dict(role='user',content='fixture')],binding=dict(seed=1),studentOutput=dict(raw='fixture',promptIds=[1],generatedIds=[2],generatedTokens=1,sampled=False,temperature=1.,tokenCapReached=False,mathAdapterEnabledDuringGeneration=True))
        admitted=dict(cards=fixture_cards(),protected={},sourceRecords={'fixture-old':cold},coldRecord=cold,
            previousPlan=old_plan(fixture_cards()),priorHash='fixture-prior',
            binding=dict(initialBaseHash='fixture-base'),deployment=dict(writerHash='fixture-writer',repairHash='fixture-repair'))
        args=SimpleNamespace(source=source,out=root/'run',student=root/'student',old_tools=root/'tools',work=root,
            payload='fixture-payload',meta_steps=2,editor_steps=2,meta_lr=.0005,editor_lr=.0001,quick=True,seconds=600,live=None)
        return args,admitted
    def run_fixture(self,args,admitted,pause=None):
        with patch.object(cf_run,'admit',return_value=admitted),patch.object(cf_run,'Backend',FakeBackend),\
            patch.object(FakeBackend,'pause_phase',pause),patch.object(cf_run,'expected_update',fake_update),\
            patch.object(cf_run,'editor_update',fake_editor),patch.object(cf_run,'checkpoint_save',fake_save),\
            patch.object(cf_run,'checkpoint_restore',fake_restore),contextlib.redirect_stdout(io.StringIO()):return cf_run.run(args)
    def test_two_phase_fixture_is_explicitly_not_student_evidence(self):
        with tempfile.TemporaryDirectory() as root:
            a,s=self.setup_run(root);r=self.run_fixture(a,s)
            self.assertTrue(r['complete']);self.assertTrue(r['fixtureOnly']);self.assertEqual(r['metaCommitted'],2);self.assertEqual(r['editorCommitted'],2)
            self.assertTrue(all(not x['fullLoopCandidate'] for x in r['rows']))
    def test_meta_pause_resume_preserves_initial_audit_and_committed_updates(self):
        with tempfile.TemporaryDirectory() as root:
            a,s=self.setup_run(root);r=self.run_fixture(a,s,'meta_train_2');self.assertFalse(r['complete']);self.assertEqual(r['metaCommitted'],1)
            original=(a.out/'initial-source-audit.json').read_bytes();r=self.run_fixture(a,s)
            self.assertTrue(r['complete']);self.assertEqual(r['metaParameterChanges'],2);self.assertEqual(original,(a.out/'initial-source-audit.json').read_bytes())
    def test_editor_pause_resume_does_not_repeat_meta_updates(self):
        with tempfile.TemporaryDirectory() as root:
            a,s=self.setup_run(root);r=self.run_fixture(a,s,'editor_anchor_2');self.assertEqual(r['metaCommitted'],2);self.assertEqual(r['editorCommitted'],1)
            first=sha(a.out/'committed/step-0001/receipt.json');r=self.run_fixture(a,s)
            self.assertTrue(r['complete']);self.assertEqual(first,sha(a.out/'committed/step-0001/receipt.json'))
    def test_tampered_editor_checkpoint_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            a,s=self.setup_run(root);self.run_fixture(a,s,'editor_anchor_2')
            (a.out/'committed/step-0003/editor.safetensors').write_text('tampered')
            with self.assertRaises(ValueError):self.run_fixture(a,s)
    def test_busy_experiment_does_not_overwrite_partial_result(self):
        with tempfile.TemporaryDirectory() as root:
            a,s=self.setup_run(root);self.run_fixture(a,s,'meta_train_2');original=(a.out/'partial-result.json').read_bytes()
            with (a.out/'experiment.lock').open('a') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                with self.assertRaises(RuntimeError):self.run_fixture(a,s)
            self.assertEqual(original,(a.out/'partial-result.json').read_bytes())
    def test_all_generation_and_learning_modes_use_the_declared_adapters(self):
        b=Backend.__new__(Backend)
        names=('writer','repair','prior','actor','control','editor','editor_control')
        for n in names:setattr(b,n,old_fixture.Switch())
        specs=[('rewarded','memory',(False,True,True,True,False,False,False)),
            ('rewarded','property',(False,True,True,True,False,False,False)),
            ('rewarded','editor',(True,True,False,False,False,True,False)),
            ('rewarded','reflection',(True,True,False,False,False,True,False)),
            (None,'math',(True,True,False,False,False,False,False)),
            (None,'cold',(True,False,False,False,False,False,False))]
        for arm,kind,flags in specs:
            with b.mode(arm,kind):self.assertEqual(tuple(getattr(b,n).enabled for n in names),flags)


if __name__=='__main__':unittest.main()
