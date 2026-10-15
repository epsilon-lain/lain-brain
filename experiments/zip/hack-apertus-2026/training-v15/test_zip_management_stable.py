"""Offline only: two complete numerical courses, exact admission and pause recovery."""
import copy
import json
import math
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import zip_management_geometry_core as core
import zip_management_stable_inspect as admission
import zip_management_stable_series as series
import zip_management_stable_run as runner
import test_zip_management_geometry as old
from draft_inspect_runtime import snapshot,read
from zip_management_geometry_receipts import atomic_json
from test_zip_summary_training_v2 import roots,response
from zip_weak_guidance_core import host_guide
from zip_label_feedback_audit import _combine_options,_distribution_options
from object_choice_core import normalized_features
from zip_label_grounded_checks import feature_messages


def baseline(folder):
    old.FlowChecks.setUpClass()
    proto=admission.inspect_v12.__globals__['prior'].PROTOCOL
    plan=core.make_fixed_plan(set(),roots())
    atomic_json(folder/'protocol.json',dict(protocol=proto,fixtureOnly=True))
    atomic_json(folder/'plan.json',plan)
    bank=dict(entries=copy.deepcopy(old.old_fixture.CourseChecks.entries),history=[],statuses={},
        head=copy.deepcopy(old.old_fixture.CourseChecks.main_head))
    notes=copy.deepcopy(old.old_fixture.CourseChecks.original_notes)
    cached=[]
    for i,t in enumerate(plan['training']):
        f=core.normalize([[1.,0.],[-1.,0.]] if t['family']=='same_factor' else [[0.,1.],[0.,-1.]])
        cached.append((dict(task=t,useExpected=.7 if i%2 else .2,suspendExpected=.2 if i%2 else .7,
            sourceMathRecordIds=['parent-m-'+str(i)+'-'+str(j) for j in range(3)]),f,'parent-f-'+str(i)))
    return dict(base={'bank':{'mathematicalRoots':roots()}},managementInitial=bank,inherited=notes,
        initial={'guide':host_guide()},continuedHead=dict(weights=[0.]*4,bias=-1.7),replayCache=cached,
        continuedFeatureFrozenWeights={'base':'offline-base','math':'offline-math'})


def simulate_course(folder,parent,resume,plan,number):
    """Synthetic responses are confined to a temporary-directory unittest.

    The genuine parent inspector is mocked only by that test's context. This
    mock checkpoint cannot pass real foundation or model admission.
    """
    bank=resume['managementInitial'];notes=resume['inherited'];guide=resume['initial']['guide']
    frozen=resume['continuedFeatureFrozenWeights'];count=[0]
    def save(kind,row):atomic_json(folder/kind/(row['id']+'.json'),copy.deepcopy(row))
    def action_feature(task,mp,g):
        f=core.normalize([[1.,0.],[-1.,0.]] if task['family']=='same_factor' else [[0.,1.],[0.,-1.]])
        fid='f-'+task['id']
        row=core.seal(dict(id=fid,kind='management',task=task,
            candidatePrompts=[core.action_messages(task,mp,g,a) for a in core.ACTIONS],
            hiddenVectors=f,normalizedFeatures=f,allAdaptersDisabled=True,frozenWeights=frozen),'featureHash')
        save('feature',row);return f,fid
    def method_feature(task,row,cards):
        sign=1. if row.get('summaryZipId') else -1.
        v=[[sign,0.,0.,0.],[0.,1.,0.,0.],[-sign,0.,0.,0.]];f=normalized_features(v)
        fid='m-'+row['recordId']
        save('feature',core.seal(dict(id=fid,kind='method',task=task,
            candidatePrompts=[feature_messages(task,row['studentOutput'],card) for card in cards],
            hiddenVectors=v,normalizedFeatures=f,allAdaptersDisabled=True,frozenWeights=frozen),'featureHash'))
        return f,fid
    def ask(phase,messages,seed,*,mode,**context):
        count[0]+=1;text='A frozen observation.'
        if mode=='math':
            task=context['task'];card=context['selectedCandidate']
            fn=_combine_options if card['kind']=='combine' else _distribution_options if card['kind']=='distribute' else None
            options=list(fn(task['expression'],card['root'],False)) if fn else []
            text=task['expression']+' = '+(options[0][0] if options else task['expression'])
        v=response(text,False)
        v.update(sampled=False,originalTextRepaired=False,allOtherAdaptersEnabled=False,testDouble=False,
            mathAdapterEnabledDuringGeneration=mode=='math',generatedTokens=2,generatedIds=[1,2],
            samplingTokenLogProbabilities=[-.3,-.7],samplingLogProbability=-1.)
        row=dict(recordId='offline-'+str(number)+'-'+str(count[0]),phase=phase,studentPrompt=messages,
            studentOutput=v,samplingSeed=seed,fixtureOnly=False,mode=mode,**context)
        atomic_json(folder/'responses'/(row['recordId']+'.json'),row);return row
    def checkpoint(h,initial,g,cs,**kw):
        ctrl=kw['control_head'];raw=kw['raw_control'];t=kw['feature_transform']
        receipt=dict(protocol=core.PROTOCOL,trainingPhaseComplete=True,head=h,initialHead=initial,
            activeGuide=g,trainingCaseHashes=[core.digest(c) for c in cs],globalControl=ctrl,
            initialGlobalControl=kw['initial_control'],globalControlHash=core.digest(ctrl),rawControl=raw,
            rawControlHash=core.digest(raw),featureTransform=t,exportedRawHead=kw['exported_raw_head'],
            transformFitUsesHeldoutFeatures=False,languageModelTraining=False,continuedSourceHeadHash=core.digest(initial),
            heldoutFeedbackUsed=False,headHash=core.digest(h),policiesHash=core.digest(dict(head=h,control=ctrl,raw=raw,transform=t)))
        atomic_json(folder/'training-receipt.json',receipt)
    plan=copy.deepcopy(plan);plan.update(continuedSourceHeadHash=core.digest(resume['continuedHead']),
        sourceReplayTrainingIds=[c['task']['id'] for c,f,fid in resume['replayCache']])
    course=core.run_course([],plan['heldout'],roots(),bank,notes,guide,[],action_feature,method_feature,
        ask,save,checkpoint,lambda:time.monotonic()+60,number,
        initial_state=resume['continuedHead'],plan=plan,replay_cache=resume['replayCache'])
    steps=[read(p) for p in (folder/'head-step').glob('*.json')]
    objects=sorted(course['objects'],key=lambda o:o['id'])
    result=dict(protocol=core.PROTOCOL,fixtureOnly=False,teacherCalls=0,stopReason='completed',error=None,
        completeTrainingExperiment=True,oldBaseAndMathematicalWeightsUnchanged=True,originalFilesUnchanged=True,
        heldoutLearnedStateUnchanged=True,oldMethodHeadsUnchanged=True,headOpportunityCount=96,
        freshTrainingObjects=8,freshHeldoutObjects=8,oldHeldoutEnteredTraining=False,languageModelTraining=False,
        oldWeightOptimizerUpdates=0,actualStudentGenerations=count[0],
        actualManagementHeadUpdates=sum(s['updated'] for s in steps),
        actualRawControlUpdates=sum(s['rawControlUpdated'] for s in steps),
        actualGlobalControlUpdates=sum(s['controlUpdated'] for s in steps),summary=core.summarize(objects))
    atomic_json(folder/'protocol.json',dict(protocol=core.PROTOCOL,fixtureOnly=False,teacherCalls=0,experimentNumber=number))
    atomic_json(folder/'plan.json',plan);atomic_json(folder/'result.json',result)
    atomic_json(folder/'source-checkpoint.json',series.source_binding(parent,snapshot(parent)))
    remanifest(folder);return result


def remanifest(folder):
    atomic_json(folder/'run-file-manifest.json',dict(files={k:v for k,v in snapshot(folder).items()
        if k not in ('result.json','run-file-manifest.json')}))


class AdmissionChecks(unittest.TestCase):
    def test_full_two_course_train_reaudit_continues_equivalent_export_and_reserves_heldout(self):
        with tempfile.TemporaryDirectory() as d:
            work=Path(d);source=work/'v12';resume=baseline(source);first=work/'v13a';second=work/'v13b'
            keys={t['semanticInputKey'] for split in ('training','heldout') for t in read(source/'plan.json')[split]}
            with patch.object(admission,'inspect_v12',return_value=resume):
                simulate_course(first,source,resume,core.make_fixed_plan(keys,roots()),1)
                checked=admission.inspect_source(first)
                self.assertEqual(checked['continuedHead'],read(first/'training-receipt.json')['exportedRawHead'])
                self.assertNotEqual(checked['continuedHead'],read(first/'training-receipt.json')['head'])
                self.assertEqual({c['task']['id'] for c,f,fid in checked['replayCache']},
                    {t['id'] for t in read(first/'plan.json')['training']})
                self.assertTrue(all(c['task']['split']=='training' for c,f,fid in checked['replayCache']))
                keys.update(t['semanticInputKey'] for split in ('training','heldout') for t in read(first/'plan.json')[split])
                simulate_course(second,first,checked,core.make_fixed_plan(keys,roots()),2)
                final=admission.inspect_source(second)
                self.assertEqual(final['continuedHead'],read(second/'training-receipt.json')['exportedRawHead'])
                self.assertIn(str(first.resolve()),final['protectedAncestors'])
                self.assertIn(str(source.resolve()),final['protectedAncestors'])

    def test_changed_reward_transform_export_or_update_rejected_even_after_rehash(self):
        for corruption in ('reward','transform','export','ledger'):
            with self.subTest(corruption=corruption),tempfile.TemporaryDirectory() as d:
                work=Path(d);source=work/'v12';resume=baseline(source);folder=work/'v13'
                keys={t['semanticInputKey'] for s in ('training','heldout') for t in read(source/'plan.json')[s]}
                with patch.object(admission,'inspect_v12',return_value=resume):
                    simulate_course(folder,source,resume,core.make_fixed_plan(keys,roots()),1)
                    if corruption=='reward':
                        p=next((folder/'fresh-training-case').glob('*.json'));v=read(p);v['useExpected']+=.01
                        v=core.seal({k:x for k,x in v.items() if k!='caseHash'},'caseHash')
                    elif corruption=='transform':
                        p=folder/'feature-transform/train-geometry.json';v=read(p);v['transform']['mean'][0]+=.01
                        v['transform']['transformHash']=core.digest({k:x for k,x in v['transform'].items() if k!='transformHash'})
                    elif corruption=='export':
                        p=folder/'training-receipt.json';v=read(p);v['exportedRawHead']['bias']+=.01
                    else:
                        p=folder/'head-step/head-step-001.json';v=read(p);v['learningRate']+=.01
                        v=core.seal({k:x for k,x in v.items() if k!='stepHash'},'stepHash')
                    atomic_json(p,v);remanifest(folder)
                    with self.assertRaises(ValueError):admission.inspect_source(folder)

    def test_fixture_rejected_before_parent_or_model(self):
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d);atomic_json(folder/'protocol.json',dict(protocol=core.PROTOCOL,fixtureOnly=True,teacherCalls=0))
            with patch.object(admission,'inspect_v12',side_effect=AssertionError('parent should not be read')):
                with self.assertRaisesRegex(ValueError,'Fixture'):admission.inspect_source(folder)


class SeriesChecks(unittest.TestCase):
    def fixture(self,work,fail_second=False):
        source=work/'source';resume=baseline(source);calls=[]
        fixed=series.recipe('offline-payload');series_folder=work/'series'
        def execute(parent,out,ordinal,recover,deadline):
            calls.append((parent,out,ordinal,recover));self.assertLess(time.monotonic(),deadline)
            checked=admission.inspect_source(parent) if parent!=source else resume
            keys=set()
            for p in work.glob('*/plan.json'):
                for s in ('training','heldout'):keys.update(t['semanticInputKey'] for t in read(p)[s])
            if fail_second and ordinal==2:
                atomic_json(out/'protocol.json',dict(protocol=core.PROTOCOL,fixtureOnly=False,teacherCalls=0))
                atomic_json(out/'plan.json',core.make_fixed_plan(keys,roots()))
                atomic_json(out/'source-checkpoint.json',series.source_binding(parent,snapshot(parent)))
                atomic_json(out/'responses/one.json',dict(raw='saved actual-shaped original',offlineFixture=True))
                return dict(exitCode=130,paused=True)
            simulate_course(out,parent,checked,core.make_fixed_plan(keys,roots()),ordinal)
            return dict(exitCode=0,paused=False)
        return source,resume,calls,fixed,series_folder,execute

    def test_two_rounds_same_recipe_all_rounds_reported_and_repeat_is_idempotent(self):
        with tempfile.TemporaryDirectory() as d:
            work=Path(d);source,resume,calls,fixed,folder,execute=self.fixture(work)
            with patch.object(admission,'inspect_v12',return_value=resume):
                r=series.run_series(source,work,folder,fixed,execute,time.monotonic()+60)
                self.assertEqual(r['completedRounds'],2);self.assertEqual(r['completedFrozenObjects'],16)
                self.assertEqual(len(calls),2);self.assertEqual(calls[1][0],calls[0][1])
                self.assertFalse(r['nextSourceChosenByHeldoutScore']);self.assertFalse(r['mathematicalWriterUpdated'])
                again=series.run_series(source,work,folder,fixed,execute,time.monotonic()+60)
                self.assertEqual(len(calls),2);self.assertEqual(again['actualStudentGenerations'],160)
                before={str(p):snapshot(p) for p in (calls[0][1],calls[1][1])}
                series.write_review(folder,work/'review.zip')
                self.assertEqual(before,{str(p):snapshot(p) for p in (calls[0][1],calls[1][1])})
                import zipfile
                with zipfile.ZipFile(work/'review.zip') as z:
                    self.assertIsNone(z.testzip());self.assertIn('round-2/training-receipt.json',z.namelist())
                    self.assertFalse(any('/feature/' in n for n in z.namelist()))

    def test_partial_second_round_keeps_complete_first_and_uses_recovery_address(self):
        with tempfile.TemporaryDirectory() as d:
            work=Path(d);source,resume,calls,fixed,folder,execute=self.fixture(work,True)
            with patch.object(admission,'inspect_v12',return_value=resume):
                one=series.run_series(source,work,folder,fixed,execute,time.monotonic()+60)
                self.assertEqual(one['completedRounds'],1);self.assertEqual(one['actualStudentGenerations'],81)
                previous=calls[1][1];first_snapshot=snapshot(calls[0][1])
                def resume_second(parent,out,ordinal,recover,deadline):
                    self.assertEqual(ordinal,2);self.assertEqual(recover,previous)
                    # Full prefix recovery is exercised separately by the host
                    # smoke test; this checks the series' recovery routing.
                    checked=admission.inspect_source(parent)
                    plan=read(previous/'plan.json')
                    simulate_course(out,parent,checked,plan,2)
                    return dict(exitCode=0,paused=False)
                two=series.run_series(source,work,folder,fixed,resume_second,time.monotonic()+60)
                self.assertEqual(two['completedRounds'],2);self.assertEqual(two['actualStudentGenerations'],160)
                self.assertEqual(snapshot(calls[0][1]),first_snapshot)
                self.assertEqual(len(two['byRound'][1]['attempts']),1)

    def test_first_round_failure_never_launches_second_and_budget_prevents_calls(self):
        with tempfile.TemporaryDirectory() as d:
            work=Path(d);source,resume,calls,fixed,folder,execute=self.fixture(work)
            def failed(*args):calls.append(args);return dict(exitCode=1,paused=False,error='offline failure')
            r=series.run_series(source,work,folder,fixed,failed,time.monotonic()+60)
            self.assertEqual(len(calls),1);self.assertEqual(r['completedRounds'],0)
            self.assertEqual(r['lastCompleteCheckpoint'],str(source.resolve()))
            other=work/'no-time';calls.clear()
            r=series.run_series(source,work,other,fixed,failed,0.)
            self.assertEqual(calls,[]);self.assertEqual(r['attemptedRounds'],0)

    def test_changed_recipe_or_unbound_saved_original_is_never_silently_restarted(self):
        with tempfile.TemporaryDirectory() as d:
            work=Path(d);source,resume,calls,fixed,folder,execute=self.fixture(work)
            series.run_series(source,work,folder,fixed,execute,0.)
            wrong=copy.deepcopy(fixed);wrong['rounds']=3
            with self.assertRaisesRegex(ValueError,'recipe'):series.run_series(source,work,folder,wrong,execute,0.)
            partial=work/'partial';atomic_json(partial/'responses/one.json',dict(raw='retained'))
            with self.assertRaisesRegex(ValueError,'Unbound saved'):series.can_recover(partial,source)


class HostRecoveryChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):old.old_fixture.CourseChecks.setUpClass()


# Exercise the new production runner, not merely the old runner's tests.
namespace=dict(vars(old));namespace['runner']=runner
exec(compile(old._smoke,'stable-host-offline-smoke','exec'),namespace)
HostRecoveryChecks.test_new_runner_pause_and_exact_recovery=namespace['test_host_runner_pause_and_exact_prefix_recovery_commit_no_duplicate_updates']


if __name__=='__main__':unittest.main()
