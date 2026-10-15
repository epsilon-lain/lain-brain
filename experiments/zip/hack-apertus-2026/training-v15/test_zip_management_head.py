"""Offline mathematical/control-flow tests. Fixtures are never student evidence."""
import copy
import importlib.util
import io
import json
import math
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import zipfile
import sys
from contextlib import nullcontext, ExitStack
import zip_management_head_core as core
import zip_management_head_run as runner
import zip_management_head_progress as progress
from zip_management_head_receipts import atomic_json, partial, review
from test_zip_summary_training_v2 import roots,response
from zip_weak_guidance_core import make_guide, host_guide, make_plan, management_messages
from zip_label_feedback_audit import _combine_options,_distribution_options
from object_choice_core import normalized_features
import test_zip_summary_training_v8 as old_fixture


def student_guide(text,index=1):
    row=dict(recordId='fixture-guide-'+str(index),phase='guidance_revision',split='training',
        parentGuideId=host_guide()['id'],studentOutput=response(text,True),fixtureOnly=True)
    return make_guide(row,host_guide())


class HeadChecks(unittest.TestCase):
    def test_real_utility_moves_use_and_suspend_in_correct_directions(self):
        f=core.normalize([[1.,0.],[0.,1.]])
        for use,suspend,direction in ((.8,.2,1),(.2,.8,-1)):
            h=core.new_head(4);c=dict(task=dict(split='training'),useExpected=use,suspendExpected=suspend)
            row=core.update(h,c,f)
            self.assertGreater(direction*(row['pUseAfter']-.5),0)
            self.assertGreater(row['expectedUtilityAfter'],row['expectedUtilityBefore'])

    def test_all_failed_or_equal_utility_never_changes_head(self):
        h=core.new_head(4);before=copy.deepcopy(h)
        for x in (0.,.4,1.):
            r=core.update(h,dict(task=dict(split='training'),useExpected=x,suspendExpected=x),[[1.,0.],[0.,1.]])
            self.assertFalse(r['updated']);self.assertEqual(h,before)

    def test_heldout_never_enters_gradient(self):
        h=core.new_head(4);old=copy.deepcopy(h)
        with self.assertRaisesRegex(ValueError,'Heldout'):
            core.update(h,dict(task=dict(split='heldout'),useExpected=1.,suspendExpected=0.),[[1.,0.],[0.,1.]])
        self.assertEqual(h,old)

    def test_distinct_representations_learn_opposite_actions(self):
        h=core.new_head(4)
        a=([[1.,0.],[-1.,0.]],.8,.2)
        b=([[0.,1.],[0.,-1.]],.2,.8)
        for i in range(core.STEPS):
            f,u,s=(a,b)[i%2];core.update(h,dict(task=dict(split='training'),useExpected=u,suspendExpected=s),f)
        self.assertGreater(core.use_probability(h,a[0]),.9)
        self.assertLess(core.use_probability(h,b[0]),.1)

    def test_unconditional_metric_includes_both_management_actions(self):
        self.assertAlmostEqual(core.utility(.25,.8,.2),.35)
        self.assertEqual(core.utility(0.,.8,.2),.2)
        self.assertEqual(core.utility(1.,.8,.2),.8)

    def test_nonfinite_boolean_or_bad_feature_inputs_rejected(self):
        for value in (True,float('nan'),float('inf')):
            with self.assertRaises(ValueError):core.normalize([[value,0.],[0.,1.]])
        with self.assertRaises(ValueError):core.normalize([[0.,0.],[0.,1.]])
        with self.assertRaises(ValueError):core.use_probability(core.new_head(3),[[1.,0.],[0.,1.]])
        with self.assertRaises(ValueError):core.utility(True,.8,.2)

    def test_sigmoid_is_stable_for_extreme_scores(self):
        h=core.new_head(2);h['bias']=10000.;self.assertEqual(core.use_probability(h,[[1.],[-1.]]),1.)
        h['bias']=-10000.;self.assertEqual(core.use_probability(h,[[1.],[-1.]]),0.)

    def test_program_action_vocabulary_not_claimed_as_student_generated_text(self):
        task=dict(id='fixture',split='training');g=host_guide();h=core.new_head(4)
        d=core.head_decision(task,h,[[1.,0.],[0.,1.]],'f',g,'note')
        self.assertEqual(d['probabilities'],{'USE':.5,'SUSPEND':.5})
        self.assertTrue(d['programProvidesActionVocabulary']);self.assertFalse(d['generatedStudentText'])
        self.assertNotIn('studentOutput',d)

    def test_advice_acceptance_needs_two_training_gains_and_no_structure_loss(self):
        guides=[student_guide('Compare past results.',1),student_guide('Pause when evidence is poor.',2)]
        def rows(ds):return [dict(guideId=g['id'],task=dict(split='training'),differenceFromInitialGuide=d)
                             for g,pair in zip(guides,ds) for d in pair]
        self.assertEqual(core.choose_guide(guides,rows(((.2,-.01),(.01,.02))),host_guide()),guides[1])
        self.assertEqual(core.choose_guide(guides,rows(((0.,0.),(-.1,-.2))),host_guide()),host_guide())
        bad=rows(((.1,.1),(.2,.2)));bad[0]['task']['split']='heldout'
        with self.assertRaisesRegex(ValueError,'TRAIN'):core.choose_guide(guides,bad,host_guide())

    def test_disproved_guide_cannot_be_promoted_despite_positive_numbers(self):
        guides=[student_guide('v = v + 1.',1),student_guide('Compare past results.',2)]
        rows=[dict(guideId=g['id'],task=dict(split='training'),differenceFromInitialGuide=d)
              for g,d in zip(guides,(.1,0.)) for _ in range(2)]
        self.assertEqual(core.choose_guide(guides,rows,host_guide()),host_guide())


class CourseChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):old_fixture.CourseChecks.setUpClass()

    def fixture(self,fail_at=None,failed_math=False,deadline=None):
        plan=make_plan(set(),roots());notes=copy.deepcopy(old_fixture.CourseChecks.original_notes)
        bank=dict(entries=copy.deepcopy(old_fixture.CourseChecks.entries),history=[],statuses={},
                  head=copy.deepcopy(old_fixture.CourseChecks.main_head))
        cases=[]
        for i,t in enumerate(plan['training']):
            n=notes[core.nominate(t,bank['entries'])['summaryZipId']]
            cases.append(dict(task=t,managementPrompt=management_messages(t,n,[],'available',host_guide()),
                summaryZipId=n['id'],useExpected=.8 if i%2==0 else .2,suspendExpected=.2 if i%2==0 else .8,
                sourceMathRecordIds=['m'+str(i)+'-'+str(k) for k in range(3)]))
        candidates=[student_guide('Compare recorded outcomes.',1),student_guide('Pause when evidence is poor.',2)]
        calls=[];features=[];saved=[];checkpoints=[]
        def action_feature(task,mp,g):
            prompts=[core.action_messages(task,mp,g,a) for a in core.ACTIONS]
            features.append(dict(task=task,prompts=prompts))
            v=[[1.,0.],[-1.,0.]] if task['family']=='same_factor' else [[0.,1.],[0.,-1.]]
            return v,'f'+str(len(features))
        def method_feature(task,row,cards):return normalized_features([[1.,0.,0.,0.],[0.,1.,0.,0.],[-1.,0.,0.,0.]]),'mathf'+row['recordId']
        def ask(phase,messages,seed,*,mode,**context):
            if fail_at is not None and len(calls)==fail_at:raise RuntimeError('fixed offline interruption')
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
        def checkpoint(h,initial,g,cs):checkpoints.append(copy.deepcopy(h))
        try:
            result=core.run_course(cases,plan['heldout'],roots(),bank,notes,host_guide(),candidates,
                action_feature,method_feature,ask,save,checkpoint,
                deadline or (lambda:time.monotonic()+60),1)
        except Exception as exc:result=dict(error=exc)
        return dict(result=result,calls=calls,features=features,saved=saved,checkpoints=checkpoints,
                    bank=bank,cases=cases,plan=plan,candidates=candidates)

    def test_complete_budget_shared_three_routes_and_decisions_precede_math(self):
        out=self.fixture();self.assertNotIn('error',out['result'])
        self.assertEqual(len(out['calls']),20);self.assertEqual(len(out['result']['objects']),4)
        steps=[r for k,r in out['saved'] if k=='head-step'];self.assertEqual(len(steps),48)
        self.assertTrue(all(r['sourceTaskId'] in {c['task']['id'] for c in out['cases'][:2]} for r in steps))
        self.assertEqual(out['checkpoints'][0],out['result']['head'])
        for t in out['plan']['heldout']:
            records=[(k,r) for k,r in out['saved'] if r.get('taskId',r.get('task',{}).get('id'))==t['id']]
            mgmt=[i for i,(k,r) in enumerate(records) if k=='management-decision'];self.assertEqual(len(mgmt),5)
            for i in mgmt:
                r=records[i][1]
                self.assertEqual(r['decisionHash'],core.digest({k:v for k,v in r.items() if k!='decisionHash'}))
            maths=[i for i,(k,r) in enumerate(records) if k=='raw' and r['phase']=='route_math']
            choices=[i for i,(k,r) in enumerate(records) if k=='method-decision'];self.assertEqual(len(choices),15)
            self.assertLess(max(mgmt+choices),min(maths))
        self.assertFalse(out['result']['summary']['oldNativeGreedyManagementMetricComparable'])

    def test_current_object_last_and_hidden_family_not_supplied(self):
        out=self.fixture()
        for row in out['features']:
            for p in row['prompts']:
                self.assertTrue(p[-1]['content'].endswith(row['task']['expression']))
                self.assertNotIn(row['task']['family'],json.dumps(p))
        self.assertEqual(out['bank']['history'],[])

    def test_all_failed_math_routes_make_all_primary_scores_zero(self):
        out=self.fixture(failed_math=True)
        self.assertEqual(set(out['result']['summary']['expectedPassByArm'].values()),{0.})
        self.assertTrue(all(o['routeOutcomes']==[0,0,0] for o in out['result']['objects']))

    def test_interruption_keeps_training_checkpoint_and_only_complete_objects(self):
        out=self.fixture(fail_at=7)
        self.assertIn('error',out['result']);self.assertEqual(len(out['checkpoints']),1)
        self.assertEqual(len(out['calls']),7)
        self.assertEqual(len([r for k,r in out['saved'] if k=='object']),1)
        self.assertEqual(len([r for k,r in out['saved'] if k=='head-step']),48)

    def test_deadline_stops_before_feature_and_student_generation(self):
        out=self.fixture(deadline=lambda:0.)
        self.assertIsInstance(out['result']['error'],TimeoutError)
        self.assertEqual(out['calls'],[]);self.assertEqual(out['features'],[])


class RecoveryChecks(unittest.TestCase):
    def test_pause_vs_deadline_classification_is_explicit(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(runner.classify_stop(KeyboardInterrupt(),d)[0],'paused')
            self.assertEqual(runner.classify_stop(TimeoutError('budget'),d),('time_budget','budget'))
            progress.request_stop(d,'notebook_interrupt')
            self.assertEqual(runner.classify_stop(InterruptedError(),d),('paused','notebook_interrupt'))

    def test_parent_keyboard_interrupt_returns_pause_without_red_exception(self):
        class Child:
            pid=987;returncode=None
            stdout=io.StringIO('')
            def poll(self):return self.returncode
            def terminate(self):self.returncode=-15
            def wait(self,timeout=None):return self.returncode
            def kill(self):self.returncode=-9
        child=Child();monitor=progress.LaunchMonitor();monitor.deadline=time.monotonic()+60
        # Reader reaches EOF; the still-running child is then interrupted while polling.
        original_get=progress.queue.Queue.get;tripped=[]
        def get_once(q,*args,**kwargs):
            if not tripped and kwargs.get('timeout')==.2:
                tripped.append(True);raise KeyboardInterrupt
            return original_get(q,*args,**kwargs)
        with tempfile.TemporaryDirectory() as d,patch.object(progress.subprocess,'Popen',return_value=child),\
             patch.object(progress.queue.Queue,'get',new=get_once):
            status=progress.run_child(['fixture'],{},monitor,out=d)
            self.assertTrue(status['paused']);self.assertEqual(child.returncode,-15)
            self.assertEqual(json.loads((Path(d)/'stop-request.json').read_text())['reason'],'notebook_interrupt')

    def test_partial_review_contains_real_returned_prefix_even_without_result(self):
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d)/'partial';atomic_json(folder/'responses/returned.json',dict(raw='actual returned prefix'))
            atomic_json(folder/'head-step/one.json',dict(updated=True))
            row=partial(folder,'paused');self.assertEqual(row['actualStudentGenerations'],1)
            self.assertEqual(row['actualManagementHeadUpdates'],1)
            atomic_json(folder/'feature/exclude-vector-bulk.json',dict(vectors=[123]))
            archive=Path(d)/'review.zip';review(folder,archive)
            with zipfile.ZipFile(archive) as z:
                self.assertIn('responses/returned.json',z.namelist())
                self.assertNotIn('feature/exclude-vector-bulk.json',z.namelist())
                self.assertIsNone(z.testzip())

    def test_recovery_uses_independent_copy_and_does_not_overwrite_previous(self):
        with tempfile.TemporaryDirectory() as d:
            old=Path(d)/'old';new=Path(d)/'new'
            atomic_json(old/'protocol.json',dict(protocol=core.PROTOCOL,teacherCalls=0))
            atomic_json(old/'responses/one.json',dict(raw='kept'))
            atomic_json(old/'result.json',dict(stopReason='paused'))
            runner.recover_copy(old,new)
            atomic_json(new/'responses/one.json',dict(raw='copy modified'))
            self.assertEqual(json.loads((old/'responses/one.json').read_text())['raw'],'kept')
            self.assertTrue((new/'previous-run-metadata/result.json').is_file())

    def test_changed_recovery_evidence_is_rejected_before_copy(self):
        with tempfile.TemporaryDirectory() as d:
            old=Path(d)/'old';new=Path(d)/'new'
            atomic_json(old/'protocol.json',dict(protocol=core.PROTOCOL,teacherCalls=0))
            atomic_json(old/'responses/one.json',dict(raw='kept'))
            atomic_json(old/'run-file-manifest.json',dict(files={'responses/one.json':'incorrect-hash'}))
            with self.assertRaisesRegex(ValueError,'Changed recovery'):runner.recover_copy(old,new)
            self.assertFalse(new.exists())

    def test_fixture_source_rejected_before_model_import_or_output_creation(self):
        with tempfile.TemporaryDirectory() as d:
            source=Path(d)/'source';out=Path(d)/'out'
            atomic_json(source/'protocol.json',dict(protocol='lain-zip-editable-weak-guidance-training-v10',teacherCalls=0,fixtureOnly=True))
            atomic_json(source/'result.json',dict(fixtureOnly=True))
            with patch.object(runner,'preflight',side_effect=AssertionError('Model path must not be reached')):
                with self.assertRaisesRegex(ValueError,'Fixture'):runner.run(SimpleNamespace(source=source,out=out,recover=None))
            self.assertFalse(out.exists())


class RuntimeSmokeChecks(unittest.TestCase):
    """Execute the complete host runner with explicit in-memory model substitutes.

    Source inspection is mocked ONLY within this temporary-directory unittest.
    No fixture checkpoint can pass the separately tested real source inspector.
    """
    @classmethod
    def setUpClass(cls):old_fixture.CourseChecks.setUpClass()

    def test_host_runner_pause_and_exact_prefix_recovery_commit_no_duplicate_updates(self):
        import zip_weak_guidance_core as old
        from test_zip_weak_guidance import CourseChecks as SourceFixture
        source_fixture=SourceFixture().fixture()
        self.assertNotIn('error',source_fixture)
        class Parameter:
            requires_grad=False;grad=None;device='cpu'
            def requires_grad_(self,value):self.requires_grad=value;return self
        class Hidden:
            def __init__(self,n):self.n=n
            def __getitem__(self,key):return self
            def float(self):return self
            def cpu(self):return self
            def tolist(self):return [1.,math.sin(self.n),math.cos(self.n),math.sin(self.n*.3)]
        class Base:
            training=False;generation_config=SimpleNamespace(eos_token_id=2)
            def eval(self):return self
            def requires_grad_(self,value):return self
            def parameters(self):return iter([Parameter()])
            def __call__(self,**kwargs):return SimpleNamespace(hidden_states=[Hidden(kwargs['input_ids'][0][0])])
        class Adapter:
            training=False
            def __init__(self,*args,**kw):pass
            def restore(self,value):pass
            def eval(self):return self
            def parameters_to_train(self):return [Parameter()]
            def digest(self):return 'math-fixture-hash'
            def active(self,value):return nullcontext()
            def close(self):pass
        class Tokenizer:
            eos_token_id=2
            def decode(self,ids,skip_special_tokens=True):return 'v = v + 1'
        tok=Tokenizer();base=Base();new_calls=[];limit=[15]
        def audit(tokenizer,messages,limits):
            return dict(promptIds=[int(core.digest(messages)[:4],16)],auditHash=core.digest(messages),inputTokens=1,maxInputTokens=999)
        def output():
            return dict(raw='v = v + 1',promptIds=[42],generatedIds=[1,2],generatedTokens=2,
                samplingTokenLogProbabilities=[-.3,-.7],samplingLogProbability=-1.,sampled=False,
                temperature=1.,originalTextRepaired=False,stopReason='eos',tokenCapReached=False,responseTokenLimit=96)
        def generate(*args,**kw):
            if limit[0] is not None and len(new_calls)==limit[0]:raise KeyboardInterrupt
            new_calls.append(True);return dict(output(),promptIds=kw['input_audit']['promptIds'])
        modules={
            'transformers':SimpleNamespace(AutoTokenizer=SimpleNamespace(from_pretrained=lambda *a,**k:tok)),
            'torch':SimpleNamespace(manual_seed=lambda *a:None,tensor=lambda ids,**k:ids,no_grad=nullcontext),
            'safetensors.torch':SimpleNamespace(load_file=lambda *a:{}),
            'zip_pilot':SimpleNamespace(load_student=lambda *a:(base,tok,{'snapshotSha256':'identity-fixture'})),
            'zip_pilot_model':SimpleNamespace(state_digest=lambda b:'base-fixture-hash'),
            'math_writer_adapter':SimpleNamespace(MathWriterAdapter=Adapter)}
        with tempfile.TemporaryDirectory() as d:
            work=Path(d);source=work/'source';fp=work/'foundation';student=work/'student';tools=work/'tools'
            fp.mkdir();tools.mkdir();student.mkdir();atomic_json(student/'config.json',{})
            atomic_json(fp/'source-checkpoint.json',dict(baseChoiceSource=str(work/'choice')))
            for row in source_fixture['rows']:atomic_json(source/'responses'/(row['recordId']+'-raw.json'),row)
            atomic_json(source/'weak-guidance-questions.json',source_fixture['plan'])
            for obj in source_fixture['course']['objects']:atomic_json(source/'object'/(obj['id']+'.json'),obj)
            initial={k:source_fixture['course']['bank'][k] for k in ('entries','history','statuses','head')}
            foundation=dict(folder=fp,bank={'mathematicalRoots':roots()},
                result={'baseStateBefore':'base-fixture-hash'},sourceHashes=runner.snapshot(fp))
            resume=dict(base=foundation,managementInitial=initial,inherited=source_fixture['notes'],
                parentHashes=runner.snapshot(source),initial=source_fixture['initial'],replayedCourse=source_fixture['course'])
            anchors=[dict(recordId='anchor-'+str(i),studentPrompt=[dict(role='user',content='cold '+str(i))],
                samplingSeed=100+i,task=source_fixture['plan']['training'][i%4],
                requestedMathAdapterEnabled=i%2==0,studentOutput=dict(output(),mathAdapterEnabledDuringGeneration=i%2==0)) for i in range(8)]
            for anchor in anchors:anchor['studentOutput']['promptIds']=audit(tok,anchor['studentPrompt'],{})['promptIds']
            checked=dict(identity={'snapshotSha256':'identity-fixture'},writer=work/'fake-math-file',
                checkpoint={'writerStateHash':'math-fixture-hash'},protected={},toolFiles={},anchors=anchors)
            with ExitStack() as stack:
                stack.enter_context(patch.dict(sys.modules,modules))
                stack.enter_context(patch.object(runner,'inspect_source',return_value=resume))
                stack.enter_context(patch.object(runner,'preflight',return_value=checked))
                stack.enter_context(patch.object(runner,'input_limits',return_value={'maxInputTokens':999}))
                stack.enter_context(patch.object(runner,'prompt_audit',side_effect=audit))
                stack.enter_context(patch.object(runner,'require_input',return_value=None))
                stack.enter_context(patch.object(runner,'generate',side_effect=generate))
                stack.enter_context(patch.object(runner,'state_digest',return_value='base-fixture-hash'))
                first=work/'zip-management-head-first'
                args=SimpleNamespace(source=source,out=first,work=work,student=student,old_tools=tools,recover=None)
                code=runner.run(args);self.assertEqual(code,130)
                one=json.loads((first/'result.json').read_text());receipt=json.loads((first/'training-receipt.json').read_text())
                self.assertEqual(one['stopReason'],'paused');self.assertEqual(one['freshHeldoutObjects'],1)
                self.assertEqual(one['actualStudentGenerations'],15);self.assertTrue(one['originalFilesUnchanged'])
                self.assertEqual(one['headOpportunityCount'],48)
                limit[0]=None;second=work/'zip-management-head-second';args.out=second;args.recover=first
                code=runner.run(args);self.assertEqual(code,0)
                two=json.loads((second/'result.json').read_text())
                self.assertTrue(two['completeTrainingExperiment']);self.assertEqual(two['freshHeldoutObjects'],4)
                self.assertEqual(two['actualStudentGenerations'],28);self.assertEqual(two['newlyGeneratedStudentResponses'],13)
                self.assertEqual(two['newlyCommittedHeadUpdates'],0);self.assertEqual(two['replayedHeadOpportunities'],48)
                self.assertEqual(json.loads((second/'training-receipt.json').read_text()),receipt)
                self.assertTrue(two['oldBaseAndMathematicalWeightsUnchanged'])
                self.assertEqual(len(new_calls),28)


if __name__=='__main__':unittest.main()
