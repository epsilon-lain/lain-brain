"""Offline fixtures only: continuation, causal controls and prefix recovery."""
import copy
import importlib.util
import io
import inspect
import json
import math
from pathlib import Path
import tempfile
import textwrap
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import sys
from contextlib import nullcontext,ExitStack
import zip_management_context_core as core
import zip_management_context_run as runner
import zip_management_context_inspect as admission
from zip_management_context_receipts import atomic_json,partial,review
from test_zip_summary_training_v2 import roots,response
from zip_weak_guidance_core import host_guide
from zip_label_feedback_audit import _combine_options,_distribution_options
from object_choice_core import normalized_features
import test_zip_summary_training_v8 as old_fixture
from test_zip_management_head import RuntimeSmokeChecks as OldSmoke,HeadChecks


class NumericalChecks(HeadChecks):
    def test_global_control_same_effective_scalar_step_as_conditional(self):
        f=core.normalize([[1.,0.],[1.,0.]])
        h=core.new_head(4);g=core.new_global(.5)
        c=dict(task=dict(split='training'),useExpected=.2,suspendExpected=.8)
        for _ in range(8):
            a=core.update(h,c,f);b=core.update_global(g,c)
            self.assertAlmostEqual(a['pUseAfter'],b['pUseAfter'],places=12)
            self.assertEqual(b['fixedGradientNormMultiplier'],3.)

    def test_global_neutral_and_heldout_no_update(self):
        g=core.new_global(.1);before=copy.deepcopy(g)
        row=core.update_global(g,dict(task=dict(split='training'),useExpected=.4,suspendExpected=.4))
        self.assertFalse(row['updated']);self.assertEqual(g,before)
        with self.assertRaisesRegex(ValueError,'Heldout'):
            core.update_global(g,dict(task=dict(split='heldout'),useExpected=.8,suspendExpected=.1))
        self.assertEqual(g,before)

    def test_plan_reserves_all_sixteen_inputs_and_namespaces(self):
        p=core.make_fixed_plan(set(),roots());seen={t['semanticInputKey'] for t in p['training']+p['heldout']}
        q=core.make_fixed_plan(seen,roots())
        self.assertFalse(seen & {t['semanticInputKey'] for t in q['training']+q['heldout']})
        for item in p['training']:self.assertEqual(item['split'],'training')
        for item in p['heldout']:self.assertEqual(item['split'],'heldout')
        p['heldout'][0]['split']='training'
        with self.assertRaises(ValueError):core.validate_fixed_plan(p)

    def test_partial_review_contains_fresh_training_and_control_updates(self):
        import zipfile
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'partial'
            atomic_json(p/'head-step/001.json',dict(updated=True,controlUpdated=True))
            atomic_json(p/'fresh-training-case/case.json',dict(task=dict(split='training')))
            row=partial(p,'paused');self.assertEqual(row['freshTrainingObjects'],1)
            self.assertEqual(row['actualGlobalControlUpdates'],1)
            dest=Path(d)/'review.zip';review(p,dest)
            with zipfile.ZipFile(dest) as z:self.assertIn('fresh-training-case/case.json',z.namelist())


class FlowChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):old_fixture.CourseChecks.setUpClass()

    def fixture(self,fail_at=None,failed_math=False,deadline=None):
        plan=core.make_fixed_plan(set(),roots());notes=copy.deepcopy(old_fixture.CourseChecks.original_notes)
        bank=dict(entries=copy.deepcopy(old_fixture.CourseChecks.entries),history=[],statuses={},
            head=copy.deepcopy(old_fixture.CourseChecks.main_head))
        initial=core.new_head(4);initial['bias']=-1.7;calls=[];saved=[];checkpoints=[];features=[]
        def action_feature(task,mp,g):
            self.assertNotIn('useExpected',json.dumps(mp));self.assertNotIn(task['family'],json.dumps(mp))
            prompts=[core.action_messages(task,mp,g,a) for a in core.ACTIONS]
            self.assertTrue(all(p[-1]['content'].endswith(task['expression']) for p in prompts))
            features.append(task['id'])
            return core.normalize([[1.,0.],[-1.,0.]] if task['family']=='same_factor' else [[0.,1.],[0.,-1.]]),'f-'+task['id']
        def method_feature(task,row,cards):
            # Fixtures distinguish effect of summary context, without pretending
            # these synthetic features are language-model evidence.
            with_note=row.get('summaryZipId') is not None
            sign=1. if with_note else -1.
            return normalized_features([[sign,0.,0.,0.],[0.,1.,0.,0.],[-sign,0.,0.,0.]]),'m-'+row['recordId']
        def ask(phase,messages,seed,*,mode,**context):
            if fail_at is not None and len(calls)==fail_at:raise RuntimeError('offline fixed interruption')
            text='A frozen observation.'
            if mode=='math':
                t=context['task'];c=context['selectedCandidate']
                fn=_combine_options if c['kind']=='combine' else _distribution_options if c['kind']=='distribute' else None
                options=list(fn(t['expression'],c['root'],False)) if fn else []
                text=t['expression']+' = '+(options[0][0] if options else t['expression'])
                if failed_math:text='v = v + 1'
            row=dict(recordId='fixture-call-'+str(len(calls)+1),phase=phase,studentPrompt=messages,
                studentOutput=response(text,False),samplingSeed=seed,fixtureOnly=True,**context)
            calls.append(row);saved.append(('raw',copy.deepcopy(row)));return row
        def save(kind,row):saved.append((kind,copy.deepcopy(row)))
        def checkpoint(h,old,g,cs,**kw):checkpoints.append(copy.deepcopy(dict(head=h,initial=old,cases=cs,**kw)))
        try:
            result=core.run_course([],plan['heldout'],roots(),bank,notes,host_guide(),[],action_feature,
                method_feature,ask,save,checkpoint,deadline or (lambda:time.monotonic()+60),1,
                initial_state=initial,plan=plan)
        except Exception as exc:result=dict(error=exc)
        return dict(result=result,calls=calls,saved=saved,checkpoints=checkpoints,plan=plan,initial=initial,bank=bank)

    def test_complete_continuation_and_matched_control_all_decisions_before_math(self):
        out=self.fixture();self.assertNotIn('error',out['result'])
        self.assertEqual(len(out['calls']),80);self.assertEqual(len(out['result']['objects']),8)
        self.assertEqual(out['result']['initialHead'],out['initial'])
        steps=[r for k,r in out['saved'] if k=='head-step'];self.assertEqual(len(steps),48)
        counts={t['id']:0 for t in out['plan']['training']}
        for step in steps:counts[step['sourceTaskId']]+=1;self.assertIn('globalControlStep',step)
        self.assertEqual(set(counts.values()),{6})
        self.assertEqual(out['checkpoints'][0]['head'],out['result']['head'])
        self.assertEqual(out['checkpoints'][0]['control_head'],out['result']['globalControl'])
        for t in out['plan']['heldout']:
            rows=[(k,r) for k,r in out['saved'] if r.get('taskId',r.get('task',{}).get('id'))==t['id']]
            managers=[i for i,(k,r) in enumerate(rows) if k=='management-decision']
            choices=[i for i,(k,r) in enumerate(rows) if k=='method-decision']
            maths=[i for i,(k,r) in enumerate(rows) if k=='raw' and r['phase']=='route_math']
            self.assertEqual(len(managers),6);self.assertEqual(len(choices),18);self.assertEqual(len(maths),3)
            self.assertLess(max(managers+choices),min(maths))
        self.assertEqual(out['bank']['history'],[])

    def test_global_initialization_uses_training_features_and_no_heldout(self):
        out=self.fixture();row=next(r for k,r in out['saved'] if k=='control-initial')
        self.assertAlmostEqual(row['initialMeanUseProbability'],1/(1+math.exp(1.7)))
        self.assertEqual(set(row['trainingTaskIds']),{t['id'] for t in out['plan']['training']})
        self.assertFalse(row['heldoutFeaturesUsed']);self.assertFalse(row['currentTaskRewardsUsedForInitialization'])

    def test_all_failed_routes_zero_credit_and_no_fabricated_updates(self):
        out=self.fixture(failed_math=True);self.assertNotIn('error',out['result'])
        self.assertEqual(set(out['result']['summary']['expectedPassByArm'].values()),{0.})
        for k,r in out['saved']:
            if k=='head-step':self.assertFalse(r['updated']);self.assertFalse(r['controlUpdated'])
        self.assertEqual(out['result']['trainingCoverage']['neutral'],8)

    def test_training_interruption_never_fabricates_receipt_or_heldout(self):
        out=self.fixture(fail_at=12)
        self.assertIn('error',out['result']);self.assertEqual(out['checkpoints'],[])
        self.assertEqual(len([r for k,r in out['saved'] if k=='fresh-training-case']),2)
        self.assertEqual(len([r for k,r in out['saved'] if k=='head-step']),0)
        self.assertEqual(len(out['calls']),12)

    def test_heldout_interruption_preserves_committed_training_and_only_completed_objects(self):
        out=self.fixture(fail_at=47)
        self.assertIn('error',out['result']);self.assertEqual(len(out['checkpoints']),1)
        self.assertEqual(len([r for k,r in out['saved'] if k=='object']),1)
        self.assertEqual(len([r for k,r in out['saved'] if k=='head-step']),48)

    def test_deadline_before_any_feature_or_generation(self):
        out=self.fixture(deadline=lambda:0.)
        self.assertIsInstance(out['result']['error'],TimeoutError);self.assertEqual(out['calls'],[])

    def test_heldout_diagnostic_groups_do_not_select_training_tasks(self):
        out=self.fixture();s=out['result']['summary']
        self.assertEqual(sum(g['objects'] for g in s['diagnosticGroups'].values()),8)
        self.assertFalse(s['heldoutGroupsUsedForTraining'])
        self.assertTrue(s['globalControlFitOnlyOnFreshTrain'])


class AdmissionChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):old_fixture.CourseChecks.setUpClass()

    def test_complete_source_replay_and_rehashed_numeric_tampering_rejected(self):
        import zip_management_head_core as prior
        from test_zip_weak_guidance import CourseChecks as SourceFixture
        source_fixture=SourceFixture().fixture()
        self.assertNotIn('error',source_fixture)
        with tempfile.TemporaryDirectory() as d:
            work=Path(d);old=work/'original-v10';folder=work/'v11'
            for row in source_fixture['rows']:
                atomic_json(old/'responses'/(row['recordId']+'-raw.json'),row)
            atomic_json(old/'weak-guidance-questions.json',source_fixture['plan'])
            initial={k:source_fixture['course']['bank'][k] for k in ('entries','history','statuses','head')}
            resume=dict(base={'folder':work/'foundation','result':{'baseStateBefore':'fixture-base'}},
                managementInitial=initial,inherited=source_fixture['notes'],initial=source_fixture['initial'],
                replayedCourse=source_fixture['course'])
            cases=runner.source_cases(old,resume);guide=resume['initial']['guide'];cached=[]
            frozen={'base':'fixture-base','math':'fixture-math'}
            for i,c in enumerate(cases[:2]):
                values=[[1.,0.],[0.,1.]] if i==0 else [[0.,1.],[1.,0.]]
                fid='source-feature-'+str(i)
                f=prior.seal(dict(id=fid,kind='management',task=c['task'],allAdaptersDisabled=True,
                    candidatePrompts=[prior.action_messages(c['task'],c['managementPrompt'],guide,a) for a in prior.ACTIONS],
                    frozenWeights=frozen,hiddenVectors=values,normalizedFeatures=prior.normalize(values)),'featureHash')
                atomic_json(folder/'feature'/(fid+'.json'),f);cached.append((f['normalizedFeatures'],fid))
            head=prior.new_head(4);original=copy.deepcopy(head)
            for i in range(prior.STEPS):
                c=cases[i%2];f,fid=cached[i%2];r=prior.update(head,c,f)
                r.update(id='head-step-'+str(i+1).zfill(3),opportunity=i+1,sourceTaskId=c['task']['id'],
                    sourceFeatureId=fid,sourceCaseHash=prior.digest(c),sourceRouteOriginals=c['sourceMathRecordIds'],trainingSplit='training')
                atomic_json(folder/'head-step'/(r['id']+'.json'),prior.seal(r,'stepHash'))
            receipt=dict(protocol=prior.PROTOCOL,trainingPhaseComplete=True,heldoutFeedbackUsed=False,
                oldAdaptersUpdated=0,trainingCaseHashes=[prior.digest(c) for c in cases],activeGuide=guide,
                initialHead=original,head=head,headHash=prior.digest(head))
            atomic_json(folder/'training-receipt.json',receipt)
            objects=[]
            for i in range(4):
                o=dict(id='held-'+str(i),heldoutEnteredTraining=False,frozenManagementHeadHash=prior.digest(head),
                    expectedPassByArm={a:0. for a in prior.ARMS})
                atomic_json(folder/'object'/(o['id']+'.json'),o);objects.append(o)
            result=dict(protocol=prior.PROTOCOL,fixtureOnly=False,teacherCalls=0,completeTrainingExperiment=True,
                stopReason='completed',error=None,oldBaseAndMathematicalWeightsUnchanged=True,
                originalFilesUnchanged=True,heldoutLearnedStateUnchanged=True,summary=prior.summarize(objects))
            atomic_json(folder/'result.json',result)
            atomic_json(folder/'protocol.json',dict(protocol=prior.PROTOCOL,fixtureOnly=False,teacherCalls=0))
            atomic_json(folder/'source-checkpoint.json',dict(source=str(old.resolve()),sourceFiles=runner.snapshot(old)))
            def manifest():
                atomic_json(folder/'run-file-manifest.json',dict(files={k:v for k,v in runner.snapshot(folder).items()
                    if k not in ('result.json','run-file-manifest.json')}))
            manifest()
            # This artificial source is confined to the unittest substitution
            # for real v10 admission; it is never real student evidence.
            with patch.object(admission,'inspect_v10',return_value=resume):
                admitted=admission.inspect_source(folder)
                self.assertEqual(admitted['continuedHead'],head)
                self.assertEqual(admitted['continuedFeatureFrozenWeights'],frozen)
                path=folder/'head-step/head-step-001.json';bad=json.loads(path.read_text())
                bad['signedUtilityDifference']+=.01;bad.pop('stepHash');bad=prior.seal(bad,'stepHash')
                atomic_json(path,bad);manifest()
                with self.assertRaisesRegex(ValueError,'numeric update'):admission.inspect_source(folder)

    def test_fixture_source_rejected_before_model_import(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);atomic_json(p/'protocol.json',dict(protocol=admission.PROTOCOL,fixtureOnly=True,teacherCalls=0))
            atomic_json(p/'result.json',dict(protocol=admission.PROTOCOL,fixtureOnly=True,teacherCalls=0))
            with patch.object(admission,'inspect_v10',side_effect=AssertionError('Do not read older model')):
                with self.assertRaisesRegex(ValueError,'Fixture'):admission.inspect_source(p)


class HostRecoveryChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):old_fixture.CourseChecks.setUpClass()


# Reuse the verified fake-host scaffolding, with explicit v12 changes. These
# injected in-memory models are confined to this offline unittest.
_smoke=textwrap.dedent(inspect.getsource(OldSmoke.test_host_runner_pause_and_exact_prefix_recovery_commit_no_duplicate_updates))
_smoke=_smoke.replace('limit=[15]','limit=[55]')
_smoke=_smoke.replace("            anchors=[", "            anchors=[")
_line="anchors=[dict(recordId='anchor-'"
_smoke=_smoke.replace(_line,"resume.update(originalTrainFolder=str(source),originalTrainHashes=runner.snapshot(source),\n            continuedHead=dict(weights=[0.]*8,bias=-1.7),\n            continuedResult={'actualManagementHeadUpdates':48},\n            continuedFeatureFrozenWeights={'base':'base-fixture-hash','math':'math-fixture-hash'})\n        "+_line)
_smoke=_smoke.replace("self.assertEqual(one['actualStudentGenerations'],15)","self.assertEqual(one['actualStudentGenerations'],55)")
_smoke=_smoke.replace("self.assertEqual(two['freshHeldoutObjects'],4)","self.assertEqual(two['freshHeldoutObjects'],8)")
_smoke=_smoke.replace("self.assertEqual(two['actualStudentGenerations'],28)","self.assertEqual(two['actualStudentGenerations'],88)")
_smoke=_smoke.replace("self.assertEqual(two['newlyGeneratedStudentResponses'],13)","self.assertEqual(two['newlyGeneratedStudentResponses'],33)")
_smoke=_smoke.replace("self.assertEqual(len(new_calls),28)","self.assertEqual(len(new_calls),88)")
_smoke=_smoke.replace("self.assertEqual(two['replayedHeadOpportunities'],48)","self.assertEqual(two['replayedHeadOpportunities'],48);self.assertEqual(two['newlyCommittedGlobalUpdates'],0)")
exec(compile(_smoke,'v12-host-smoke-fixture','exec'),globals())
HostRecoveryChecks.test_host_runner_pause_and_exact_prefix_recovery_commit_no_duplicate_updates=globals()['test_host_runner_pause_and_exact_prefix_recovery_commit_no_duplicate_updates']


if __name__=='__main__':unittest.main()
