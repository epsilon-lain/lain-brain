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
import zip_management_geometry_core as core
import zip_management_geometry_run as runner
import zip_management_geometry_inspect as admission
from zip_management_geometry_receipts import atomic_json,partial,review
from test_zip_summary_training_v2 import roots,response
from zip_weak_guidance_core import host_guide
from zip_label_feedback_audit import _combine_options,_distribution_options
from object_choice_core import normalized_features
import test_zip_summary_training_v8 as old_fixture
from test_zip_management_head import RuntimeSmokeChecks as OldSmoke,HeadChecks
from zip_management_geometry import (fit_transform,transformed_features,reparameterize,
    export_raw_head,update_conditioned,geometry_diagnostic)


class GeometryChecks(unittest.TestCase):
    def rows(self):
        return [dict(task=dict(id='train-'+str(i),split='training'),featureId='f-'+str(i),
            features=core.normalize([[1.,x],[1.,-x]])) for i,x in enumerate((-.02,-.01,.01,.02))]

    def test_initial_probability_equivalence_on_train_and_unseen_inputs(self):
        transform=fit_transform(self.rows());head=dict(weights=[.4,-.3,.2,.7],bias=-3.2)
        mapped=reparameterize(head,transform)
        for f in [r['features'] for r in self.rows()]+[core.normalize([[1.,.035],[1.,-.017]])]:
            self.assertAlmostEqual(core.use_probability(head,f),
                core.use_probability(mapped,transformed_features(f,transform)),places=12)
        mapped['weights'][1]+=.04;raw=export_raw_head(mapped,transform)
        f=core.normalize([[1.,.035],[1.,-.017]])
        self.assertAlmostEqual(core.use_probability(raw,f),
            core.use_probability(mapped,transformed_features(f,transform)),places=12)

    def test_training_features_only_and_no_reward_or_family_effect_on_transform(self):
        rows=self.rows();a=fit_transform(rows)
        for i,r in enumerate(rows):r['reward']=999*i;r['task']['family']='unrelated';r['task']['outcome']='wrong'
        self.assertEqual(a,fit_transform(rows))
        rows[0]['task']['split']='heldout'
        with self.assertRaisesRegex(ValueError,'Heldout'):fit_transform(rows)

    def test_average_norm_is_matched_and_shared_direction_removed(self):
        rows=self.rows();t=fit_transform(rows)
        norms=[sum(x*x for x in core.representation(transformed_features(r['features'],t))) for r in rows]
        self.assertAlmostEqual(sum(norms)/len(norms),2.,places=12)
        report=geometry_diagnostic(rows,t)
        self.assertGreater(report['rawPairCosines']['minimum'],.99)
        self.assertLess(report['conditionedPairCosines']['minimum'],0.)

    def test_constant_inputs_do_not_invent_context_or_divide_by_zero(self):
        rows=[dict(task=dict(id=str(i),split='training'),features=[[1.,0.],[0.,1.]],featureId=str(i)) for i in range(3)]
        t=fit_transform(rows);f=transformed_features(rows[0]['features'],t)
        self.assertEqual(f,[[0.,0.],[0.,0.]])
        self.assertEqual(t['trainAverageTransformedNormSquared'],0.)

    def test_coordinate_conditioning_matches_current_example_logit_step(self):
        f=[[3.,0.],[0.,2.]];head=core.new_head(4)
        c=dict(task=dict(split='training'),useExpected=.8,suspendExpected=.2)
        changed=update_conditioned(head,c,f)
        g=core.new_global(.5);control=core.update_global(g,c)
        self.assertAlmostEqual(changed['pUseAfter'],control['pUseAfter'],places=12)

    def test_tampered_transform_and_heldout_update_rejected(self):
        t=fit_transform(self.rows());t['mean'][0]+=.01
        with self.assertRaisesRegex(ValueError,'Changed'):transformed_features([[1.,0.],[0.,1.]],t)
        h=core.new_head(4)
        with self.assertRaisesRegex(ValueError,'Heldout'):
            update_conditioned(h,dict(task=dict(split='heldout'),useExpected=1.,suspendExpected=0.),[[1.,0.],[0.,1.]])


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
        old_plan=core.make_fixed_plan({t['semanticInputKey'] for t in plan['training']+plan['heldout']},roots())
        replay_cache=[]
        for i,t in enumerate(old_plan['training']):
            f=core.normalize([[1.,0.],[-1.,0.]] if t['family']=='same_factor' else [[0.,1.],[0.,-1.]])
            c=dict(task=t,useExpected=0. if failed_math else .7 if i%2 else .2,
                suspendExpected=0. if failed_math else .2 if i%2 else .7,
                sourceMathRecordIds=['replay-'+str(i)+'-'+str(j) for j in range(3)])
            replay_cache.append((c,f,'replay-feature-'+str(i)))
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
                initial_state=initial,plan=plan,replay_cache=replay_cache)
        except Exception as exc:result=dict(error=exc)
        return dict(result=result,calls=calls,saved=saved,checkpoints=checkpoints,plan=plan,initial=initial,bank=bank)

    def test_complete_continuation_and_matched_control_all_decisions_before_math(self):
        out=self.fixture();self.assertNotIn('error',out['result'])
        self.assertEqual(len(out['calls']),80);self.assertEqual(len(out['result']['objects']),8)
        self.assertEqual(out['result']['initialHead'],out['initial'])
        steps=[r for k,r in out['saved'] if k=='head-step'];self.assertEqual(len(steps),96)
        counts={s['sourceTaskId']:0 for s in steps}
        for step in steps:counts[step['sourceTaskId']]+=1;self.assertIn('globalControlStep',step)
        self.assertEqual(len(counts),16);self.assertEqual(set(counts.values()),{6})
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
        self.assertEqual(len(row['trainingTaskIds']),16);self.assertTrue({t['id'] for t in out['plan']['training']}<=set(row['trainingTaskIds']))
        self.assertFalse(row['heldoutFeaturesUsed']);self.assertFalse(row['currentTaskRewardsUsedForInitialization'])

    def test_all_failed_routes_zero_credit_and_no_fabricated_updates(self):
        out=self.fixture(failed_math=True);self.assertNotIn('error',out['result'])
        self.assertEqual(set(out['result']['summary']['expectedPassByArm'].values()),{0.})
        for k,r in out['saved']:
            if k=='head-step':self.assertFalse(r['updated']);self.assertFalse(r['controlUpdated'])
        self.assertEqual(out['result']['trainingCoverage']['neutral'],16)

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
        self.assertEqual(len([r for k,r in out['saved'] if k=='head-step']),96)

    def test_deadline_before_any_feature_or_generation(self):
        out=self.fixture(deadline=lambda:0.)
        self.assertIsInstance(out['result']['error'],TimeoutError);self.assertEqual(out['calls'],[])

    def test_heldout_diagnostic_groups_do_not_select_training_tasks(self):
        out=self.fixture();s=out['result']['summary']
        self.assertEqual(sum(g['objects'] for g in s['diagnosticGroups'].values()),8)
        self.assertFalse(s['heldoutGroupsUsedForTraining'])
        self.assertTrue(s['globalControlFitOnlyOnFreshAndReplayedTrain'])


class HostRecoveryChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):old_fixture.CourseChecks.setUpClass()


class SourceAdmissionChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):old_fixture.CourseChecks.setUpClass()

    def test_fixture_source_rejected_before_reading_model(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);atomic_json(p/'protocol.json',dict(protocol=admission.prior.PROTOCOL,fixtureOnly=True,teacherCalls=0))
            with patch.object(admission,'inspect_v11',side_effect=AssertionError('No model import')):
                with self.assertRaisesRegex(ValueError,'Fixture'):admission.inspect_source(p)

    def test_complete_v12_train_reaudit_and_changed_reward_rejected(self):
        import zip_management_context_core as prior
        from test_zip_management_context import FlowChecks as PriorFlow
        PriorFlow.setUpClass();out=PriorFlow().fixture();self.assertNotIn('error',out['result'])
        with tempfile.TemporaryDirectory() as d:
            work=Path(d);folder=work/'v12';parent=work/'v11'
            atomic_json(parent/'marker.json',dict(offlineFixture=True))
            frozen={'base':'fixture-base','math':'fixture-math'}
            bank=out['bank'];notes=old_fixture.CourseChecks.original_notes
            resume=dict(base={'bank':{'mathematicalRoots':roots()}},managementInitial=bank,inherited=notes,
                initial={'guide':host_guide()},continuedHead=out['initial'],continuedFeatureFrozenWeights=frozen)
            for r in out['calls']:
                r=copy.deepcopy(r);r['fixtureOnly']=False
                r['mode']='math' if r['phase']=='route_math' else 'observation'
                r['studentOutput'].update(sampled=False,originalTextRepaired=False,allOtherAdaptersEnabled=False,testDouble=False,
                    mathAdapterEnabledDuringGeneration=r['mode']=='math',generatedTokens=2,generatedIds=[1,2],
                    samplingTokenLogProbabilities=[-.3,-.7],samplingLogProbability=-1.)
                atomic_json(folder/'responses'/(r['recordId']+'.json'),r)
            cases=[r for k,r in out['saved'] if k=='fresh-training-case']
            original_by_id={r['recordId']:r for r in out['calls']}
            for c in cases:
                atomic_json(folder/'fresh-training-case'/(c['task']['id']+'.json'),c)
                task=c['task'];f=prior.normalize([[1.,0.],[-1.,0.]] if task['family']=='same_factor' else [[0.,1.],[0.,-1.]])
                row=prior.seal(dict(id=c['managementFeatureId'],kind='management',task=task,
                    candidatePrompts=[prior.action_messages(task,c['managementPrompt'],host_guide(),a) for a in prior.ACTIONS],
                    hiddenVectors=f,normalizedFeatures=f,allAdaptersDisabled=True,frozenWeights=frozen),'featureHash')
                atomic_json(folder/'feature'/(row['id']+'.json'),row)
                note=notes[c['summaryZipId']]
                for key,n in (('without',None),('withSummary',note)):
                    r=original_by_id[c['sourceObservationIds'][key]];sign=1. if n else -1.
                    v=[[sign,0.,0.,0.],[0.,1.,0.,0.],[-sign,0.,0.,0.]]
                    row=prior.seal(dict(id=c['sourceFeatureIds'][key],kind='method',task=task,
                        candidatePrompts=[admission.feature_messages(task,r['studentOutput'],card) for card in prior.candidate_cards(roots(),n)],
                        hiddenVectors=v,normalizedFeatures=normalized_features(v),allAdaptersDisabled=True,frozenWeights=frozen),'featureHash')
                    atomic_json(folder/'feature'/(row['id']+'.json'),row)
            for k,r in out['saved']:
                if k=='head-step':atomic_json(folder/k/(r['id']+'.json'),r)
            course=out['result'];checkpoint=out['checkpoints'][0]
            head=course['head'];control=course['globalControl']
            receipt=dict(protocol=prior.PROTOCOL,head=head,globalControl=control,initialHead=out['initial'],
                initialGlobalControl=checkpoint['initial_control'],trainingCaseHashes=[prior.digest(c) for c in cases],
                headHash=prior.digest(head),globalControlHash=prior.digest(control),
                policiesHash=prior.digest(dict(head=head,control=control)),activeGuide=host_guide(),
                heldoutFeedbackUsed=False,trainingPhaseComplete=True)
            atomic_json(folder/'training-receipt.json',receipt)
            objects=sorted(course['objects'],key=lambda o:o['id'])
            for o in objects:atomic_json(folder/'object'/(o['id']+'.json'),o)
            result=dict(protocol=prior.PROTOCOL,fixtureOnly=False,teacherCalls=0,stopReason='completed',error=None,
                completeTrainingExperiment=True,oldBaseAndMathematicalWeightsUnchanged=True,
                originalFilesUnchanged=True,heldoutLearnedStateUnchanged=True,oldMethodHeadsUnchanged=True,
                actualManagementHeadUpdates=48,summary=prior.summarize(objects))
            atomic_json(folder/'result.json',result)
            atomic_json(folder/'protocol.json',dict(protocol=prior.PROTOCOL,fixtureOnly=False,teacherCalls=0))
            atomic_json(folder/'plan.json',out['plan'])
            atomic_json(folder/'source-checkpoint.json',dict(source=str(parent.resolve()),sourceFiles=runner.snapshot(parent)))
            def manifest():
                atomic_json(folder/'run-file-manifest.json',dict(files={k:v for k,v in runner.snapshot(folder).items()
                    if k not in ('result.json','run-file-manifest.json')}))
            manifest()
            # Fake originals cannot pass the real parent admission. This patch
            # is confined to a temporary-directory offline serialization test.
            with patch.object(admission,'inspect_v11',return_value=resume):
                admitted=admission.inspect_source(folder)
                self.assertEqual(admitted['continuedHead'],head);self.assertEqual(len(admitted['replayCache']),8)
                self.assertTrue(all(c['task']['split']=='training' for c,f,fid in admitted['replayCache']))
                changed=copy.deepcopy(cases[0]);changed['useExpected']+=.01;changed.pop('caseHash')
                changed=prior.seal(changed,'caseHash')
                atomic_json(folder/'fresh-training-case'/(changed['task']['id']+'.json'),changed);manifest()
                with self.assertRaisesRegex(ValueError,'verified rewards'):admission.inspect_source(folder)


# Reuse the verified fake-host scaffolding, with explicit v12 changes. These
# injected in-memory models are confined to this offline unittest.
_smoke=textwrap.dedent(inspect.getsource(OldSmoke.test_host_runner_pause_and_exact_prefix_recovery_commit_no_duplicate_updates))
_smoke=_smoke.replace('limit=[15]','limit=[55]')
_smoke=_smoke.replace("            anchors=[", "            anchors=[")
_line="anchors=[dict(recordId='anchor-'"
_smoke=_smoke.replace(_line,"resume.update(originalTrainFolder=str(source),originalTrainHashes=runner.snapshot(source),\n            continuedHead=dict(weights=[0.]*8,bias=-1.7),\n            continuedResult={'actualManagementHeadUpdates':48},\n            continuedFeatureFrozenWeights={'base':'base-fixture-hash','math':'math-fixture-hash'},\n            sourceReplayOriginals=[],replayCache=[])\n        for ri,rt in enumerate(core.make_fixed_plan(set(),roots())['training']):\n            resume['replayCache'].append((dict(task=rt,useExpected=0.,suspendExpected=0.,sourceMathRecordIds=['replay-m-'+str(ri)]*3),\n                [[1.,0.,0.,0.],[0.,1.,0.,0.]],'replay-'+str(ri)))\n        "+_line)
_smoke=_smoke.replace("self.assertEqual(one['actualStudentGenerations'],15)","self.assertEqual(one['actualStudentGenerations'],55)")
_smoke=_smoke.replace("self.assertEqual(two['freshHeldoutObjects'],4)","self.assertEqual(two['freshHeldoutObjects'],8)")
_smoke=_smoke.replace("self.assertEqual(two['actualStudentGenerations'],28)","self.assertEqual(two['actualStudentGenerations'],88)")
_smoke=_smoke.replace("self.assertEqual(two['newlyGeneratedStudentResponses'],13)","self.assertEqual(two['newlyGeneratedStudentResponses'],33)")
_smoke=_smoke.replace("self.assertEqual(len(new_calls),28)","self.assertEqual(len(new_calls),88)")
_smoke=_smoke.replace("self.assertEqual(two['replayedHeadOpportunities'],96)","self.assertEqual(two['replayedHeadOpportunities'],96);self.assertEqual(two['newlyCommittedGlobalUpdates'],0)")
_smoke=_smoke.replace("self.assertEqual(one['headOpportunityCount'],48)","self.assertEqual(one['headOpportunityCount'],96)")
_smoke=_smoke.replace("self.assertEqual(two['replayedHeadOpportunities'],48)","self.assertEqual(two['replayedHeadOpportunities'],96)")
_smoke=_smoke.replace("dict(task=rt,useExpected=0.",
    "dict(task=rt,managementPrompt=core.management_messages(rt,source_fixture['notes'][core.nominate(rt,initial['entries'])['summaryZipId']],initial['history'],'available',host_guide()),useExpected=0.")
exec(compile(_smoke,'v12-host-smoke-fixture','exec'),globals())
HostRecoveryChecks.test_host_runner_pause_and_exact_prefix_recovery_commit_no_duplicate_updates=globals()['test_host_runner_pause_and_exact_prefix_recovery_commit_no_duplicate_updates']


if __name__=='__main__':unittest.main()
