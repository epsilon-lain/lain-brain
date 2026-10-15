"""Offline editable-guide and training-attribution checks, never student evidence."""
import copy
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import zipfile
from object_choice_core import normalized_features
from zip_label_feedback_audit import _combine_options,_distribution_options
from zip_label_grounded_checks import feature_messages
from test_zip_summary_training_v2 import roots,response
from test_zip_summary_training_v6 import execute_word_fixture
import test_zip_summary_training_v8 as previous
import test_zip_interface_training as procedural
import zip_weak_guidance_core as core
import zip_weak_guidance_course as course
import zip_weak_guidance_policy as policy
import zip_weak_guidance_inspect as inspector
from zip_weak_guidance_receipts import publish_partial,harvest_review
from zip_summary_training_v9_receipts import atomic_json
from draft_inspect_runtime import read,sha
from zip_weak_guidance_select import select_source

class CourseChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):previous.CourseChecks.setUpClass()

    def fixture(self,invalid_actions=False,capped_guides=False,failed_routes=False,fail_at=None):
        plan=core.make_plan(set(),roots());notes=copy.deepcopy(previous.CourseChecks.original_notes)
        initial=dict(entries=copy.deepcopy(previous.CourseChecks.entries),history=[],
            statuses={e['summaryZipId']:'available' for e in previous.CourseChecks.entries},
            head=copy.deepcopy(previous.CourseChecks.main_head),guide=core.host_guide())
        rows=[];saved=[];features=[];steps=[];warm=[];cps=[]
        states=dict(management='manager0',guide='guide0');snapshots={}
        def ask(phase,messages,seed,*,mode,sampled=False,**context):
            if fail_at is not None and len(rows)==fail_at:raise RuntimeError('offline fixed interruption')
            task=context.get('task');text='A recorded observation.'
            if phase=='interface_probe':
                text=context['probeExpectedAction'] if context['probeStage']=='after_warm' else 'A long explanation'
            elif mode=='management':
                if invalid_actions:text='A long explanation rather than an action.'
                elif context.get('guideId','').startswith('weak-guide-') and context['guideId']!='weak-guide-initial':
                    guide=guides[context['guideId']]
                    text='SUSPEND' if 'Compare' in guide['text'] and task['family']=='same_factor' else 'USE'
                else:text='USE'
            elif mode=='guide':
                text='Compare recorded evidence and pause a misleading summary.' if context['candidateIndex']==1 else 'Use every summary.'
            elif mode=='math':
                card=context['selectedCandidate']
                fn=_combine_options if card['kind']=='combine' else _distribution_options if card['kind']=='distribute' else None
                options=list(fn(task['expression'],card['root'],False)) if fn else []
                text=task['expression']+' = '+(options[0][0] if options else task['expression'])
                if failed_routes:text='v = v + 1'
            v=response(text,sampled)
            if mode=='guide' and capped_guides:v.update(stopReason='token_cap',tokenCapReached=True)
            snap=context.get('managerSnapshot','current')
            v.update(responseTokenLimit=policy.token_limit(phase),responseBudgetProtocol='native-eos-summary-v6',
                generationMode=mode,mathAdapterEnabledDuringGeneration=mode=='math',
                semanticAdapterEnabledDuringGeneration=False,summaryAdapterEnabledDuringGeneration=False,
                managementAdapterEnabledDuringGeneration=mode=='management',guideAdapterEnabledDuringGeneration=mode=='guide',
                managementStateHashDuringGeneration=states['management'] if snap=='current' else snapshots[snap],
                guideStateHashDuringGeneration=states['guide'])
            row=dict(recordId='weak-call-'+str(len(rows)+1).zfill(3),phase=phase,studentPrompt=copy.deepcopy(messages),
                studentOutput=v,samplingSeed=seed,fixtureOnly=True,offlineFixtureFactory=True,**context)
            rows.append(row);return row
        def feature(task,row,cards):
            hidden=[[-.4,.6,1.,-1.],[-.4,.6,-1.,1.],[-.4,.6,.5,-.5]]
            good=1 if task['family']=='same_factor' else 2
            if row.get('summaryZipId'):
                if task['family']=='same_factor':hidden[good]=[-.8,.9,0.,0.];hidden[3-good]=[.9,-.8,0.,0.]
                else:hidden[good]=[.95,-.9,0.,0.]
            fid='weak-feature-'+str(len(features)+1).zfill(3)
            features.append(dict(id=fid,task=copy.deepcopy(task),sourceObservationRecordId=row['recordId'],
                candidateCards=copy.deepcopy(cards),candidatePrompts=[feature_messages(task,row['studentOutput'],c) for c in cards],
                candidateHiddenVectors=hidden,normalizedFeatures=normalized_features(hidden),allAdaptersDisabled=True))
            return normalized_features(hidden),fid
        def save(kind,row):saved.append((kind,copy.deepcopy(row)))
        def warmup(lessons):
            for i,batch in enumerate(core.warm_schedule(lessons),1):
                before=states['management'];states['management']='manager-warm-'+str(i)
                warm.append(dict(id='warm-'+str(i),beforeHash=before,afterHash=states['management'],
                    lessonIds=[l['id'] for l in batch],learningRate=core.WARM_LR,parameterKind='warm_management'))
        def learn(kind,rs,advantages,evidence):
            self.assertTrue(all(r['studentOutput'][('management' if kind=='management' else 'guide')+'StateHashDuringGeneration']==states[kind] for r in rs))
            update,_=execute_word_fixture([r['studentOutput'] for r in rs],advantages,len(rs)*128,updater=policy.update_words)
            before=states[kind]
            if update['updated']:
                states[kind]+='x'
                steps.append(dict(id=kind+'-'+str(sum(s['parameterKind']==kind for s in steps)+1),
                    parameterKind=kind,sourceRecordIds=[r['recordId'] for r in rs],beforeHash=before,afterHash=states[kind],
                    advantages=list(advantages),evidence=copy.deepcopy(evidence),policyUpdate=copy.deepcopy(update),
                    optimizer='SGD without momentum',learningRate=.003))
            update.update(parameterKind=kind,beforeHash=before,afterHash=states[kind],sourceRecordIds=[r['recordId'] for r in rs])
            return update
        guides={}
        def load(i):return copy.deepcopy(notes[i])
        def store(g):guides[g['id']]=copy.deepcopy(g)
        def checkpoint(label,bank):
            cps.append(dict(label=label,bankHash=core.digest(bank),states={k:dict(stateHash=v) for k,v in states.items()}))
            if label=='initial':snapshots['pre_round']=states['management']
            if label=='after-warm':snapshots['warm']=states['management']
            if label=='proposal':snapshots['proposal']=states['management']
        try:
            result=course.run_course(plan,roots(),initial,ask,feature,save,learn,warmup,checkpoint,load,store,time.monotonic()+60,1)
        except Exception as e:return dict(error=e,rows=rows,saved=saved,steps=steps,warm=warm,features=features,cps=cps,notes=notes,initial=initial,plan=plan)
        return dict(course=result,rows=rows,saved=saved,steps=steps,warm=warm,features=features,cps=cps,notes=notes,initial=initial,plan=plan)
    def complete(self,**kw):
        out=self.fixture(**kw)
        if 'error' in out:self.fail(repr(out['error']))
        return out

    def materialize(self,p,**kw):
        out=self.complete(**kw)
        def put(name,row):
            path=p/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(row,ensure_ascii=False))
        put('weak-guidance-questions.json',out['plan']);put('roots.json',roots())
        for row in out['rows']:put('responses/'+row['recordId']+'-raw.json',row)
        for kind,row in out['saved']:put('responses/'+row['recordId']+'-scored.json' if kind=='scored' else kind+'/'+row['id']+'.json',row)
        for f in out['features']:put('feature/'+f['id']+'.json',f)
        for cp in out['cps']:put('checkpoints/'+cp['label']+'.json',cp)
        tokenizer=procedural.ProceduralTokenizer();tokenizer.eos_token_id=999
        limits=policy.input_limits(dict(max_position_embeddings=4096),tokenizer)
        packets={l['id']:policy.encode_lesson(tokenizer,l,limits,[999]) for l in core.warm_lessons()}
        put('warm-packets.json',packets)
        for row in out['warm']:
            row.update(packetHashes=[packets[i]['packetHash'] for i in row['lessonIds']],meanTargetTokenLoss=1.,
                optimizer='AdamW',labelAuthor='host_procedural_encoding_only',studentGenerations=0,targetsSpecifyEncodingNotTaskJudgment=True)
            row=core.seal(row,'warmHash');put('warm-step/'+row['id']+'.json',row)
        for row in out['steps']:put(row['parameterKind']+'-step/'+row['id']+'.json',row)
        return out

    def test_actual_advice_text_is_student_written_and_can_replace_whole_initial_guide(self):
        out=self.complete();r=core.summarize(out['course'])
        self.assertTrue(r['activatedStudentGuide'])
        self.assertFalse(out['course']['activeGuide']['hostAuthored'])
        self.assertGreater(r['activeGuideVsInitialGuideSameManager'],0)
        self.assertEqual(len(out['warm']),16)
        self.assertEqual(len(out['rows']),core.MAX_GENERATIONS-8)
        self.assertTrue(all(h['split']=='training' for h in out['course']['bank']['history']))

    def test_invalid_fallback_never_counts_as_student_suspension_or_guide_success(self):
        out=self.complete(invalid_actions=True);r=core.summarize(out['course'])
        self.assertFalse(r['activatedStudentGuide'])
        self.assertEqual(r['heldoutSuspendActionsByArm'][core.ARMS[0]],0)
        self.assertEqual(r['validHeldoutActionsByArm'][core.ARMS[0]],0)
        self.assertEqual(r['expectedPassByArm'][core.ARMS[0]],r['expectedPassByArm']['always_suspend'])

    def test_capped_guidance_is_preserved_but_never_activated_or_positive(self):
        out=self.complete(capped_guides=True)
        self.assertTrue(out['course']['activeGuide']['hostAuthored'])
        self.assertEqual([c['advantage'] for c in out['course']['guideFeedback']['credits']],[-.2,-.2])
        self.assertEqual(len(out['course']['guideCandidates']),2)

    def test_known_false_math_in_guidance_cannot_receive_positive_credit(self):
        out=self.complete();row=copy.deepcopy(out['course']['guideCandidates'][0]['studentOriginal'])
        row['studentOutput']['raw']='v = v + 1.'
        guide=core.make_guide(row,out['initial']['guide'])
        self.assertFalse(core.guide_trial_eligible(guide))
        winner,credits=core.evaluate_guides([guide],{guide['id']:[]})
        self.assertIsNone(winner);self.assertEqual(credits[0]['advantage'],-.2)

    def test_all_failed_math_never_produces_positive_usefulness_reward(self):
        out=self.complete(failed_routes=True)
        self.assertFalse(core.summarize(out['course'])['activatedStudentGuide'])
        self.assertTrue(all(f['advantage']==0 for f in out['course']['managementFeedback']))
        self.assertTrue(all(o['useExpected']==o['suspendExpected']==0 for o in out['course']['objects']))

    def test_final_guide_rewards_use_final_manager_and_two_training_objects(self):
        out=self.complete();e=out['course']['guideFeedback']
        self.assertTrue(e['rewardAndRetentionUseFinalTrainingManager'])
        for c in e['credits']:
            self.assertEqual(len(c['cases']),2)
            self.assertTrue(all(x['split']=='training' and x['managerSnapshot']=='final_training_manager' for x in c['cases']))
        final_rows=[r for r in out['rows'] if r['phase']=='guide_final_validation']
        final_state=next(cp for cp in out['cps'] if cp['label']=='after-4')['states']['management']['stateHash']
        self.assertTrue(all(r['studentOutput']['managementStateHashDuringGeneration']==final_state for r in final_rows))

    def test_formal_actions_precede_math_and_heldout_never_updates_or_changes_bank(self):
        out=self.complete()
        for task in out['plan']['training']+out['plan']['heldout']:
            selected=[r for r in out['rows'] if r.get('task',{}).get('id')==task['id']]
            formal=[r for r in selected if r['phase']=='summary_management']
            math_rows=[r for r in selected if r['phase']=='route_math']
            self.assertLess(max(out['rows'].index(r) for r in formal),min(out['rows'].index(r) for r in math_rows))
        self.assertEqual(len(out['course']['bank']['history']),4)
        self.assertEqual(len(out['course']['managementFeedback']),4)
        train_ids={t['id'] for t in out['plan']['training']}
        self.assertTrue(all(r['taskId'] in train_ids and not r['heldoutFeedback'] for r in out['course']['managementFeedback']))

    def test_saved_algorithm_replay_binds_warm_labels_guides_and_outcome_credit(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);out=self.materialize(p)
            rebuilt=inspector.replay_course(p,out['initial'],out['notes'],1)
            self.assertEqual(rebuilt,out['course'])
            step=next((p/'management-step').glob('*.json'));changed=json.loads(step.read_text())
            changed['advantages'][0]*=-1;step.write_text(json.dumps(changed))
            with self.assertRaisesRegex(ValueError,'credit attribution'):inspector.replay_course(p,out['initial'],out['notes'],1)

    def test_train_only_replay_excludes_all_heldout_history(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);out=self.materialize(p)
            rebuilt=inspector.replay_course(p,out['initial'],out['notes'],1,training_only=True)
            self.assertEqual(len(rebuilt['objects']),4)
            self.assertEqual(rebuilt['bank'],out['course']['bank'])
            self.assertEqual(rebuilt['guideFeedback'],out['course']['guideFeedback'])

    def test_completed_train_recovery_reuses_prefix_and_only_generates_absent_heldout_tail(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);out=self.materialize(p)
            kept_tasks={t['id'] for t in out['plan']['training']+out['plan']['heldout'][:2]}
            prefix=[r for r in out['rows'] if not r.get('task') or r['task']['id'] in kept_tasks]
            prefix.append(next(r for r in out['rows'] if r.get('task',{}).get('id') not in kept_tasks and r.get('task')))
            ids={r['recordId'] for r in prefix}
            remaining=[r for r in out['rows'] if r['recordId'] not in ids]
            for path in (p/'responses').glob('*.json'):
                if read(path)['recordId'] not in ids:path.unlink()
            for kind in ('feature','object','trial','decision','management-choice'):
                for path in (p/kind).glob('*.json'):
                    row=read(path)
                    if (row.get('taskId') or row.get('task',{}).get('id')) not in kept_tasks:path.unlink()
            (p/'checkpoints/final.json').unlink()
            old={str(path.relative_to(p)):sha(path) for path in p.rglob('*') if path.is_file()}
            future_features=[f for f in out['features'] if f['task']['id'] not in kept_tasks]
            new_calls=[]
            def ask(phase,messages,seed,**context):
                row=copy.deepcopy(remaining.pop(0))
                self.assertEqual(row['task']['split'],'heldout')
                self.assertEqual((row['phase'],row['studentPrompt'],row['samplingSeed']),(phase,messages,seed))
                self.assertTrue(all(row.get(k)==v for k,v in context.items() if k not in ('mode','sampled')))
                (p/'responses'/(row['recordId']+'-raw.json')).write_text(json.dumps(row));new_calls.append(row)
                return row
            def feature(task,row,cards):
                f=future_features.pop(0)
                self.assertEqual((f['task'],f['sourceObservationRecordId'],f['candidateCards']),(task,row['recordId'],cards))
                (p/'feature'/(f['id']+'.json')).write_text(json.dumps(f));return f['normalizedFeatures'],f['id']
            def save(kind,row):
                self.assertNotIn(kind,('management-step','guide-step','warm-step','guide-feedback','management-feedback'))
                path=p/'responses'/(row['recordId']+'-scored.json') if kind=='scored' else p/kind/(row['id']+'.json')
                self.assertFalse(path.exists());path.parent.mkdir(exist_ok=True);path.write_text(json.dumps(row))
            def checkpoint(label,bank):
                self.assertEqual(label,'final')
                cp=next(r for r in out['cps'] if r['label']=='final')
                self.assertEqual(cp['bankHash'],core.digest(bank))
                (p/'checkpoints/final.json').write_text(json.dumps(cp))
            rebuilt=inspector.replay_course(p,out['initial'],out['notes'],1,tail=dict(ask=ask,feature=feature,
                save=save,checkpoint=checkpoint,deadline=time.monotonic()+60))
            self.assertEqual(rebuilt,out['course'])
            self.assertTrue(new_calls)
            self.assertFalse(remaining or future_features)
            self.assertTrue(all(sha(p/name)==value for name,value in old.items()))

    def test_interruption_keeps_actual_originals_and_does_not_fabricate_objects(self):
        out=self.fixture(fail_at=5)
        self.assertIn('error',out)
        self.assertEqual(len(out['rows']),5)
        self.assertEqual(len(out['warm']),16)
        self.assertFalse(any(kind=='object' for kind,row in out['saved']))

    def test_seed_namespace_and_procedural_targets_do_not_include_task_answers(self):
        lessons=core.warm_lessons()
        self.assertEqual(sum(l['target']=='USE' for batch in core.warm_schedule(lessons) for l in batch),16)
        self.assertEqual(sum(l['target']=='SUSPEND' for batch in core.warm_schedule(lessons) for l in batch),16)
        self.assertTrue(all(not l['hostChoosesCurrentSummaryUse'] for l in lessons))
        self.assertNotEqual(core.seed_for(1,1,1),core.seed_for(2,1,1))

class WarmPolicyChecks(unittest.TestCase):
    def packets(self):
        tok=procedural.ProceduralTokenizer();tok.eos_token_id=999
        limits=policy.input_limits(dict(max_position_embeddings=4096),tok)
        return {l['id']:policy.encode_lesson(tok,l,limits,[999]) for l in core.warm_lessons()}

    def test_balanced_sixteen_commits_only_train_action_encoder_with_real_eos_labels(self):
        adapter=procedural.Adapter();packets=self.packets();commits=[]
        rows=policy.train_warm(None,adapter,core.warm_lessons(),packets,lambda:10.,lambda:None,
            lambda row,state:commits.append((copy.deepcopy(row),copy.deepcopy(state))),
            torch_api=procedural.torch_double(adapter),loss_function=lambda b,p:procedural.Scalar(1.,adapter.p))
        self.assertEqual(len(rows),len(commits));self.assertEqual(len(rows),16)
        self.assertTrue(all(p['targetIds'][-1]==999 and p['studentResponse'] is False for p in packets.values()))
        self.assertFalse(adapter.p.requires_grad);self.assertIsNone(adapter.p.grad)
        self.assertTrue(all(r['studentGenerations']==0 and r['targetsSpecifyEncodingNotTaskJudgment'] for r in rows))

    def test_changed_supervised_target_or_student_authorship_never_trains(self):
        adapter=procedural.Adapter();packets=self.packets();p=next(iter(packets.values()))
        p['studentResponse']=True
        p.update(packetHash=core.digest({k:v for k,v in p.items() if k!='packetHash'}))
        before=adapter.digest()
        with self.assertRaisesRegex(ValueError,'lesson binding'):
            policy.train_warm(None,adapter,core.warm_lessons(),packets,lambda:10.,lambda:None,lambda *a:None,
                torch_api=procedural.torch_double(adapter),loss_function=lambda b,p:procedural.Scalar(1.,adapter.p))
        self.assertEqual(adapter.digest(),before)

    def test_failed_commit_restores_uncommitted_parameter_change(self):
        adapter=procedural.Adapter();before=adapter.digest()
        with self.assertRaises(OSError):
            policy.train_warm(None,adapter,core.warm_lessons(),self.packets(),lambda:10.,lambda:None,
                lambda *a:(_ for _ in ()).throw(OSError('offline I/O failure')),
                torch_api=procedural.torch_double(adapter),loss_function=lambda b,p:procedural.Scalar(1.,adapter.p))
        self.assertEqual(adapter.digest(),before)

    def test_no_deadline_budget_means_no_update(self):
        adapter=procedural.Adapter();before=adapter.digest()
        with self.assertRaises(TimeoutError):
            policy.train_warm(None,adapter,core.warm_lessons(),self.packets(),lambda:0.,lambda:None,lambda *a:None,
                torch_api=procedural.torch_double(adapter),loss_function=lambda b,p:procedural.Scalar(1.,adapter.p))
        self.assertEqual(adapter.digest(),before)

    def test_receipt_with_no_final_result_still_contains_original_student_text(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);atomic_json(p/'responses/x-raw.json',dict(raw='actual saved text'))
            publish_partial(p,'timeout')
            harvest_review(p,p/'review.zip')
            with zipfile.ZipFile(p/'review.zip') as z:
                self.assertIn('responses/x-raw.json',z.namelist())
                self.assertFalse(json.loads(z.read('partial-result.json'))['completeTrainingExperiment'])

    def test_real_source_inspector_rejects_fixtures_before_reading_parent(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)
            atomic_json(p/'protocol.json',dict(protocol=core.PROTOCOL,teacherCalls=0))
            atomic_json(p/'responses/x-raw.json',dict(fixtureOnly=True,studentOutput=dict(testDouble=True)))
            with self.assertRaisesRegex(ValueError,'provenance'):inspector.inspect_source(p)

    def test_selector_recovers_completed_train_instead_of_repeating_its_updates(self):
        with tempfile.TemporaryDirectory() as d:
            work=Path(d);base=work/'base';folder=work/'zip-weak-guidance-interrupted'
            atomic_json(folder/'protocol.json',dict(protocol=core.PROTOCOL,experimentNumber=1))
            atomic_json(folder/'source-checkpoint.json',dict(parentSource=str(base)))
            atomic_json(folder/'checkpoints/after-4.json',dict(committed=True))
            self.assertEqual(select_source(work,base),(base,folder))
            atomic_json(folder/'result.json',dict(completeTrainingExperiment=True,stopReason='completed',error=None))
            # Result cannot become a continuation source before manifest commit.
            self.assertEqual(select_source(work,base),(base,folder))
            atomic_json(folder/'run-file-manifest.json',dict(files={}))
            self.assertEqual(select_source(work,base),(folder,None))

if __name__=='__main__':unittest.main()
