"""Offline math-long tests; substitute models only within isolated unit tests."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from contextlib import nullcontext,ExitStack
import sys
import zip_math_long_core as core
import zip_math_long_run as runner
import zip_math_long_receipts as receipts
import zip_math_long_policy as policy
from draft_inspect_runtime import read,snapshot
from test_zip_summary_training_v2 import roots,response
from zip_label_feedback_audit import _combine_options,_distribution_options


class PlanChecks(unittest.TestCase):
    def test_fixed_192_train_28_heldout_and_fresh_inputs_against_all_prior_plans(self):
        first=core.make_plan(set(),roots(),1)
        train=[t for b in first['blocks'] for t in b['training']]
        held=[t for e in first['evaluations'] for t in e['tasks']]+first['terminalEvaluationTasks']
        self.assertEqual(len(train),192);self.assertEqual(len(held),28)
        seen={t['semanticInputKey'] for t in train+held}
        second=core.make_plan(seen,roots(),2);core.validate_plan(second,seen)
        self.assertFalse(second['outcomeBasedTaskSelection'])
        self.assertEqual([b['stage'] for b in first['blocks']],[1]*8+[2]*8+[3]*8)

    def test_input_only_train_route_scheduler_never_rewards_inapplicable_tool(self):
        plan=core.make_plan(set(),roots(),1)
        for t in plan['blocks'][0]['training']:
            cards=core.training_cards(t,roots())
            self.assertEqual(cards[0]['kind'],'direct')
            self.assertEqual(len(cards),2)
            expected='combine' if t['family']=='same_factor' else 'distribute'
            self.assertEqual(cards[1]['kind'],expected)
        with self.assertRaisesRegex(ValueError,'Heldout'):core.training_cards(plan['terminalEvaluationTasks'][0],roots())

    def test_feedback_separately_rewards_exact_student_success_and_penalizes_false_math(self):
        t=core.make_plan(set(),roots(),1)['blocks'][0]['training'][0];rows=[]
        for i,c in enumerate(core.training_cards(t,roots())):
            fn=_combine_options if c['kind']=='combine' else _distribution_options if c['kind']=='distribute' else None
            text=t['expression']+' = '+list(fn(t['expression'],c['root'],False))[0][0] if fn else 'v = v + 1'
            v=response(text,False);v['sampled']=True
            rows.append(dict(recordId='sample-'+str(i),mode='math',task=t,selectedCandidate=c,studentOutput=v))
        fb=core.training_feedback(t,rows,roots())
        self.assertEqual(fb['advantages'],[-.5,.5]);self.assertFalse(fb['teacherCorrectedTargets'])
        with self.assertRaises(ValueError):core.training_feedback(dict(t,split='heldout'),rows,roots())

    def test_rehearsal_keeps_unchanged_verified_train_only_and_excludes_heldout(self):
        t=core.make_plan(set(),roots(),1)['blocks'][0]['training'][0];c=core.training_cards(t,roots())[1]
        text=t['expression']+' = '+list(_combine_options(t['expression'],c['root'],False))[0][0]
        v=response(text,False);v.update(stopReason='eos',originalTextRepaired=False,generatedIds=[1,2],generatedTokens=2,
            testDouble=False,mathAdapterEnabledDuringGeneration=True)
        r=dict(recordId='verified-student-original',mode='math',task=t,selectedCandidate=c,studentOutput=v,fixtureOnly=False)
        self.assertEqual(core.verified_rehearsal([r,dict(r,task=dict(t,split='heldout'))],roots()),[r])
        changed=copy.deepcopy(r);changed['studentOutput']['raw']='v = v + 1'
        self.assertEqual(core.verified_rehearsal([changed],roots()),[])
        cold=dict(r,phase='cold_replay');cold.pop('selectedCandidate')
        self.assertEqual(core.verified_rehearsal([cold],roots()),[])

    def test_resume_skips_committed_steps_and_evaluates_pending_batch_before_more_training(self):
        p=core.make_plan(set(),roots(),1);seen=[];clock=[0.]
        def train(t):seen.append(('train',t['mathTrainingStep']))
        def evaluate(b):seen.append(('eval',b['afterStep']));clock[0]=100.
        status=core.execute_plan(p,33,train,evaluate,10.,10.,now=lambda:clock[0])
        self.assertEqual(seen,[('eval',32)]);self.assertEqual(status,'training_budget')
        seen.clear();status=core.execute_plan(p,192,train,lambda b:seen.append(b['afterStep']),10.,10.,now=lambda:0.)
        self.assertEqual(status,'completed');self.assertEqual(seen,[32,64,96,128,160,192])


class TransactionChecks(unittest.TestCase):
    def test_complete_directory_publication_is_only_committed_unit_and_detects_changed_optimizer(self):
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d);binding=dict(initialMathHash='w0')
            def save(w,o):w.write_bytes(b'weights');o.write_bytes(b'optimizer')
            row=dict(beforeWriterHash='w0',afterWriterHash='w1',updated=True,parameterChanged=True,advantages=[.5])
            receipts.publish(folder,1,binding,row,save)
            self.assertEqual(len(receipts.commits(folder,binding)),1)
            with self.assertRaisesRegex(ValueError,'duplicate'):receipts.publish(folder,1,binding,row,save)
            (folder/'committed/.preparing-abandoned').mkdir()
            self.assertEqual(len(receipts.commits(folder,binding)),1)
            (folder/'committed/step-0001/optimizer.pt').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'Changed committed'):receipts.commits(folder,binding)

    def test_interrupt_before_publish_leaves_no_half_weight_optimizer_commit(self):
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d)
            def fail(w,o):w.write_bytes(b'weights');raise KeyboardInterrupt
            with self.assertRaises(KeyboardInterrupt):receipts.publish(folder,1,{'initialMathHash':'w0'},
                dict(beforeWriterHash='w0',afterWriterHash='w1'),fail)
            self.assertEqual(receipts.commits(folder,{'initialMathHash':'w0'}),[])

    def test_review_keeps_raw_errors_receipts_and_omits_tensor_bulk(self):
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d)/'run';receipts.atomic_json(folder/'responses/first.json',dict(raw='original'))
            receipts.atomic_json(folder/'error.json',dict(error='exact error'))
            receipts.atomic_json(folder/'committed/step-0001/receipt.json',dict(updated=True))
            p=folder/'committed/step-0001/writer.safetensors';p.write_bytes(b'weights')
            import zipfile
            dest=Path(d)/'review.zip';receipts.review(folder,dest)
            with zipfile.ZipFile(dest) as z:
                self.assertIn('responses/first.json',z.namelist());self.assertIn('error.json',z.namelist())
                self.assertIn('committed/step-0001/receipt.json',z.namelist())
                self.assertFalse(any(n.endswith('.safetensors') for n in z.namelist()));self.assertIsNone(z.testzip())


@unittest.skipUnless(importlib.util.find_spec('torch'),'Torch gradient test runs in original student environment')
class TorchPolicyChecks(unittest.TestCase):
    def fixture(self):
        import torch
        from torch import nn
        class Tiny(nn.Module):
            def __init__(self):
                super().__init__();self.e=nn.Embedding(7,4);self.p=nn.Linear(4,7,bias=False)
                self.delta=nn.Parameter(torch.zeros(7));self.delta.requires_grad_(False)
            def forward(self,input_ids,use_cache=False,logits_to_keep=None):
                h=self.p(self.e(input_ids))+self.delta
                return SimpleNamespace(logits=h[:,-logits_to_keep:,:] if logits_to_keep else h)
        # A separate scalar/vector adapter parameter isolates the actual
        # gradient/update test from large pretrained-model dependencies.
        base=Tiny().eval().requires_grad_(False)
        delta=base.delta;base._parameters.pop('delta');object.__setattr__(base,'delta',delta)
        delta.requires_grad_(True)
        class Adapter:
            def parameters_to_train(self):return [delta]
            def digest(self):return core.digest(delta.detach().tolist())
        adapter=Adapter();optimizer=torch.optim.AdamW([delta],lr=.01,weight_decay=0.)
        v=dict(promptIds=[1,2],generatedIds=[3,4],generatedTokens=2,sampled=True,temperature=.8,
            originalTextRepaired=False,mathAdapterEnabledDuringGeneration=True,allOtherAdaptersEnabled=False,
            tokenCapReached=False)
        with torch.no_grad():logs=policy.token_log_probabilities(base,v,.8).tolist()
        v.update(samplingTokenLogProbabilities=logs,samplingLogProbability=sum(logs))
        row=dict(recordId='on-policy',studentOutput=v);fb=dict(task={'split':'training'},heldoutFeedbackUsed=False,
            responseIds=['on-policy'],advantages=[.5])
        return torch,base,adapter,optimizer,row,fb

    def test_real_backward_changes_adapter_only_and_drift_stops_before_optimizer(self):
        torch,base,adapter,opt,r,fb=self.fixture()
        frozen={k:v.clone() for k,v in base.state_dict().items()}
        result=policy.update_math(base,adapter,opt,[r],fb,None)
        self.assertTrue(result['parameterChanged']);self.assertTrue(result['baseGradientsAbsent'])
        self.assertTrue(all(torch.equal(v,base.state_dict()[k]) for k,v in frozen.items()))
        before=adapter.digest();changed=copy.deepcopy(r)
        changed['studentOutput']['samplingTokenLogProbabilities']=[-100.,-100.]
        changed['studentOutput']['samplingLogProbability']=-200.
        with self.assertRaisesRegex(ValueError,'sampling/replay'):policy.update_math(base,adapter,opt,[changed],fb,None)
        self.assertEqual(adapter.digest(),before)

    def test_heldout_anchor_and_unsampled_policy_trajectory_rejected(self):
        torch,base,adapter,opt,r,fb=self.fixture()
        a=copy.deepcopy(r);a['task']={'split':'heldout'}
        with self.assertRaisesRegex(ValueError,'Heldout'):policy.update_math(base,adapter,opt,[r],fb,a)
        bad=copy.deepcopy(r);bad['studentOutput']['sampled']=False
        with self.assertRaises(ValueError):policy.update_math(base,adapter,opt,[bad],fb,None)


class HostChecks(unittest.TestCase):
    def test_new_host_commits_real_update_requests_pauses_and_recovers_without_duplicate_steps(self):
        self.host_fixture(False)

    def test_time_budget_terminal_pause_resumes_same_snapshot_without_more_training(self):
        self.host_fixture(True)

    def host_fixture(self,terminal):
        import test_zip_summary_training_v8 as old_fixture
        from test_zip_weak_guidance import CourseChecks as SourceFixture
        old_fixture.CourseChecks.setUpClass();sf=SourceFixture().fixture()
        class Parameter:
            requires_grad=False;grad=None;device='cpu'
            def requires_grad_(self,x):self.requires_grad=x;return self
        class Hidden:
            def __init__(self,n):self.n=n
            def __getitem__(self,k):return self
            def float(self):return self
            def cpu(self):return self
            def tolist(self):
                import math
                return [1.,math.sin(self.n),math.cos(self.n),math.sin(self.n*.3)]
        class Base:
            training=False;generation_config=SimpleNamespace(eos_token_id=2)
            def eval(self):return self
            def requires_grad_(self,x):return self
            def parameters(self):return iter([Parameter()])
            def __call__(self,**kw):return SimpleNamespace(hidden_states=[Hidden(kw['input_ids'][0][0])])
        class Adapter:
            def __init__(self,*a,**kw):self.w=0.;self.p=Parameter()
            def eval(self):return self
            def parameters_to_train(self):return [self.p]
            def restore(self,s):self.w=s['w']
            def learned_state(self):return {'w':self.w}
            def digest(self):return 'math-fixture-hash' if self.w==0 else core.digest(self.w)
            def active(self,x):return nullcontext()
            def close(self):pass
        class Optimizer:
            def __init__(self,*a,**kw):self.state={'count':0}
            def state_dict(self):return self.state.copy()
            def load_state_dict(self,s):self.state=s.copy()
        class Tokenizer:
            eos_token_id=2
            def decode(self,*a,**kw):return 'v = v + 1'
        tok=Tokenizer();base=Base();new_calls=[];stop=[13 if terminal else 14];update_requests=[]
        def audit(tokenizer,messages,limits):
            return dict(promptIds=[int(core.digest(messages)[:4],16)],auditHash=core.digest(messages),inputTokens=1)
        def output(sampled=False):
            return dict(raw='v = v + 1',promptIds=[42],generatedIds=[1,2],generatedTokens=2,
                samplingTokenLogProbabilities=[-.3,-.7],samplingLogProbability=-1.,sampled=sampled,
                temperature=.8 if sampled else 1.,originalTextRepaired=False,stopReason='eos',tokenCapReached=False)
        def generate(*a,**kw):
            if stop[0] is not None and len(new_calls)==stop[0]:raise KeyboardInterrupt
            new_calls.append(True);return dict(output(a[5]),promptIds=kw['input_audit']['promptIds'])
        def update(base,adapter,opt,rows,fb,anchor):
            self.assertTrue(all(r['task']['split']=='training' for r in rows));self.assertTrue(adapter.p.requires_grad)
            before=adapter.digest();adapter.w+=1.;opt.state['count']=opt.state.get('count',0)+1;update_requests.append(fb['task']['mathTrainingStep'])
            return dict(updated=True,parameterChanged=True,beforeWriterHash=before,afterWriterHash=adapter.digest(),
                advantages=fb['advantages'],rehearsalSourceRecordId=None)
        def save_tensor(s,p):Path(p).write_text(json.dumps(s))
        modules={'transformers':SimpleNamespace(AutoTokenizer=SimpleNamespace(from_pretrained=lambda *a,**k:tok)),
            'torch':SimpleNamespace(manual_seed=lambda *a:None,tensor=lambda ids,**kw:ids,no_grad=nullcontext,
                optim=SimpleNamespace(AdamW=Optimizer),save=save_tensor,load=lambda p,**kw:read(p)),
            'safetensors.torch':SimpleNamespace(load_file=lambda p:read(p),save_file=save_tensor),
            'zip_pilot':SimpleNamespace(load_student=lambda *a:(base,tok,{'snapshotSha256':'fake-identity'})),
            'math_writer_adapter':SimpleNamespace(MathWriterAdapter=Adapter)}
        with tempfile.TemporaryDirectory() as d:
            work=Path(d);source=work/'source';fp=work/'foundation';student=work/'student';tools=work/'tools'
            fp.mkdir();tools.mkdir();student.mkdir();writer=work/'initial-math.safetensors';save_tensor({'w':0.},writer)
            receipts.atomic_json(student/'config.json',{})
            receipts.atomic_json(fp/'source-checkpoint.json',dict(baseChoiceSource=str(work/'choice')))
            receipts.atomic_json(source/'protocol.json',dict(offlineFixture=True))
            bank={k:sf['course']['bank'][k] for k in ('entries','history','statuses','head')}
            foundation=dict(folder=fp,bank={'mathematicalRoots':roots()},result={'baseStateBefore':'base-fixture-hash'},sourceHashes=snapshot(fp))
            resume=dict(base=foundation,managementInitial=bank,inherited=sf['notes'],parentHashes=snapshot(source),
                originalTrainFolder=str(source),originalTrainHashes=snapshot(source),
                initial=sf['initial'],continuedHead={'weights':[0.]*8,'bias':-1.7},replayCache=[])
            anchors=[dict(recordId='anchor-'+str(i),studentPrompt=[dict(role='user',content='cold '+str(i))],
                samplingSeed=100+i,task=sf['plan']['training'][i%4],requestedMathAdapterEnabled=i%2==0,
                studentOutput=dict(output(),mathAdapterEnabledDuringGeneration=i%2==0)) for i in range(8)]
            for a in anchors:a['studentOutput']['promptIds']=audit(tok,a['studentPrompt'],{})['promptIds']
            checked=dict(identity={'snapshotSha256':'fake-identity'},writer=writer,checkpoint={'writerStateHash':'math-fixture-hash'},
                protected={},toolFiles={},anchors=anchors)
            out=work/'zip-math-long-test';args=SimpleNamespace(source=source,out=out,work=work,student=student,old_tools=tools,payload='offline',seconds=21600)
            with ExitStack() as stack:
                stack.enter_context(patch.dict(sys.modules,modules))
                for name,value in (('inspect_source',resume),('preflight',checked),('input_limits',{})):
                    stack.enter_context(patch.object(runner,name,return_value=value))
                stack.enter_context(patch.object(runner,'prompt_audit',side_effect=audit))
                stack.enter_context(patch.object(runner,'require_input',return_value=None))
                stack.enter_context(patch.object(runner,'generate',side_effect=generate))
                stack.enter_context(patch.object(runner,'update_math',side_effect=update))
                stack.enter_context(patch.object(runner,'state_digest',return_value='base-fixture-hash'))
                if terminal:
                    def limited(plan,committed,train,evaluate,*deadlines):
                        self.assertEqual(committed,0);train(plan['blocks'][0]['training'][0]);return 'training_budget'
                    stack.enter_context(patch.object(runner,'execute_plan',side_effect=limited))
                self.assertEqual(runner.run(args),130)
                first=read(out/'result.json');self.assertEqual(first['committedMathOptimizerUpdates'],1 if terminal else 3)
                old_receipts={str(p.relative_to(out)):p.read_bytes() for p in (out/'committed').rglob('*') if p.is_file()}
                stop[0]=None;self.assertEqual(runner.run(args),0)
                result=read(out/'result.json')
                self.assertEqual(result['committedMathOptimizerUpdates'],1 if terminal else 192)
                self.assertEqual(result['newlyCommittedMathUpdates'],0 if terminal else 189)
                self.assertEqual(update_requests,[1] if terminal else list(range(1,193)))
                self.assertEqual(result['freshFinalHeldoutObjects'],4);self.assertTrue(result['baseWeightsUnchanged'])
                self.assertTrue(result['frozenManagementAndMethodPoliciesUnchanged'])
                for name,data in old_receipts.items():self.assertEqual((out/name).read_bytes(),data)
                self.assertEqual(result['allPeriodicEvaluationSummary']['heldoutObjects'],0 if terminal else 24)
                if terminal:self.assertEqual(result['stopReason'],'training_budget')
                self.assertTrue((out/'deployment-model.json').is_file())


if __name__=='__main__':unittest.main()
