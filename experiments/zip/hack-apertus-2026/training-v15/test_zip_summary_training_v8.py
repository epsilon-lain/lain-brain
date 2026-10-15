"""Offline simulations and exact scalar optimizer checks, never real training."""
import copy
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
from types import ModuleType
import sys
from object_choice_core import normalized_features
from zip_label_feedback_audit import _combine_options,_distribution_options
from zip_label_grounded_checks import feature_messages
from test_zip_summary_training_v2 import roots,response
from test_zip_summary_training_v6 import execute_word_fixture
import test_zip_summary_training_v7 as prior_fixture
import zip_summary_training_v8_core as core
import zip_summary_training_v8_run as runtime
import zip_summary_training_v8_inspect as inspector
import zip_summary_training_v8_policy as policy


class CourseChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        prior=prior_fixture.CourseChecks().complete()
        cls.original_notes=prior['notes']
        cls.entries=[core.seal(dict(summaryZipId=e['summaryZipId'],branch=core.A,head=copy.deepcopy(e['readerTraining']['heads']['note']),
            scopeShapes=copy.deepcopy(e['readerTraining']['scopeShapes']),sourceTaskId=prior['notes'][e['summaryZipId']]['sourceTaskId'],
            generation=0,trainingGain=e['trainingMeanGain'],originEntryHash=e['gateHash'],originReaderHash=e['readerTraining']['readerHash']),'entryHash')
            for e in prior['course']['finalGates'][core.A]['entries']]
        cls.main_head=prior['course']['finalHeads'][core.A]
    def fixture(self,action='SUSPEND',harmful=True,invalid_revision=False,improve_revision=False,fail_at=None,deadline=None):
        rr=roots();plan=core.make_plan(set(),rr)
        initial=dict(entries=copy.deepcopy(self.entries),history=[],statuses={e['summaryZipId']:'available' for e in self.entries},head=copy.deepcopy(self.main_head))
        notes=copy.deepcopy(self.original_notes);rows=[];saved=[];features=[];steps=[];cps=[]
        states=dict(summary='writer0',management='manager0');initial_management=states['management']
        def ask(phase,messages,seed,*,mode,sampled=False,**context):
            if fail_at is not None and len(rows)==fail_at:raise RuntimeError('offline interruption')
            text='The expression contains repeated inner terms.';task=context['task']
            if mode=='management':text='USE' if context.get('frozenInitialManagement') else (action(task) if callable(action) else action)
            elif mode=='summary':text='v = v + 1.' if invalid_revision else 'Check whether the repeated expression matches the stored rewrite.'
            elif mode=='math':
                card=context['selectedCandidate'];options=[]
                fn=_combine_options if card['kind']=='combine' else _distribution_options if card['kind']=='distribute' else None
                if fn:options=list(fn(task['expression'],card['root'],False))
                text=task['expression']+' = '+(options[0][0] if options else task['expression'])
            elif context.get('summaryZipId'):text='This earlier note could affect the rewrite choice.'
            out=response(text,sampled)
            out.update(responseTokenLimit=128 if mode in ('summary','management') else 96,
                responseBudgetProtocol='native-eos-summary-v6',generationMode=mode,
                summaryStateHashDuringGeneration=states['summary'],
                managementStateHashDuringGeneration=initial_management if context.get('frozenInitialManagement') else states['management'],
                mathAdapterEnabledDuringGeneration=mode=='math',semanticAdapterEnabledDuringGeneration=False,
                summaryAdapterEnabledDuringGeneration=mode=='summary',managementAdapterEnabledDuringGeneration=mode=='management')
            r=dict(recordId='management-call-'+str(len(rows)+1).zfill(3),phase=phase,studentPrompt=copy.deepcopy(messages),
                studentOutput=out,samplingSeed=seed,fixtureOnly=True,offlineFixtureFactory=True,**context)
            rows.append(r);return r
        def feature(task,row,cards):
            good=1 if task['family']=='same_factor' else 2
            # Distinct plain fixture representations vary on nearly irrelevant
            # coordinates. A note can improve/harm frozen method selection.
            hidden=[[-.4,.6,1.,-1.],[-.4,.6,-1.,1.],[-.4,.6,.5,-.5]]
            if row.get('summaryZipId'):
                if improve_revision and notes[row['summaryZipId']].get('summaryProtocol')==core.PROTOCOL:hidden[good]=[.95,-.9,0.,0.]
                elif harmful:hidden[good]=[-.8,.9,0.,0.];hidden[3-good]=[.9,-.8,0.,0.]
                else:hidden[good]=[.95,-.9,0.,0.]
            fid='management-feature-'+str(len(features)+1).zfill(3)
            features.append(dict(id=fid,task=copy.deepcopy(task),sourceObservationRecordId=row['recordId'],candidateCards=copy.deepcopy(cards),
                candidatePrompts=[feature_messages(task,row['studentOutput'],c) for c in cards],candidateHiddenVectors=hidden,
                normalizedFeatures=normalized_features(hidden),mathematicalAdapterEnabled=False,semanticAdapterEnabled=False,
                summaryAdapterEnabled=False,managementAdapterEnabled=False))
            return normalized_features(hidden),fid
        def save(kind,row):saved.append((kind,copy.deepcopy(row)))
        def learn(kind,rs,advantages,evidence):
            self.assertTrue(all(r['studentOutput'][kind+'StateHashDuringGeneration']==states[kind] for r in rs))
            result,scalar=execute_word_fixture([r['studentOutput'] for r in rs],advantages,len(rs)*128,updater=policy.update_words)
            before=states[kind]
            if result['updated']:
                states[kind]+='x'
                steps.append(dict(id=kind+'-'+str(sum(s['parameterKind']==kind for s in steps)+1),parameterKind=kind,
                    sourceRecordIds=[r['recordId'] for r in rs],beforeHash=before,afterHash=states[kind],advantages=list(advantages),
                    evidence=copy.deepcopy(evidence),policyUpdate=copy.deepcopy(result)))
            result.update(beforeHash=before,afterHash=states[kind],sourceRecordIds=[r['recordId'] for r in rs],parameterKind=kind)
            return result
        def load(i):return copy.deepcopy(notes[i])
        def store(n):notes[n['id']]=copy.deepcopy(n)
        def checkpoint(label,entries,history,statuses):
            cps.append(dict(label=label,summaryState=dict(stateHash=states['summary']),managementState=dict(stateHash=states['management']),
                head=copy.deepcopy(initial['head']),historiesHash=core.digest(history),statusesHash=core.digest(statuses),entriesHash=core.digest(entries)))
        try:
            course=core.run_course(plan,rr,initial,ask,feature,save,learn,load,store,checkpoint,
                time.monotonic()+60 if deadline is None else deadline,1)
        except Exception as e:return dict(error=e,rows=rows,saved=saved,features=features,steps=steps,notes=notes,initial=initial,checkpoints=cps)
        return dict(course=course,rows=rows,saved=saved,features=features,steps=steps,notes=notes,initial=initial,checkpoints=cps,plan=plan)
    def complete(self,**kw):
        out=self.fixture(**kw)
        if 'error' in out:self.fail(repr(out['error']))
        return out
    def write_replay(self,p):
        out=self.complete()
        def put(name,row):
            path=p/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(row,ensure_ascii=False))
        put('zip-summary-questions.json',out['plan']);put('roots.json',roots())
        for kind,row in out['saved']:put('responses/'+row['recordId']+'-scored.json' if kind=='scored' else kind+'/'+row['id']+'.json',row)
        for r in out['rows']:put('responses/'+r['recordId']+'-raw.json',r)
        for cp in out['checkpoints']:put('checkpoints/'+cp['label']+'.json',cp)
        result=dict(trainingRound=1,summary=core.summarize(out['course']))
        return out,result
    def replay(self,p,out,result):
        return inspector.replay_saved_course(p,result,out['notes'],out['initial'],out['checkpoints'][0],
            {f['id']:f for f in out['features']},{r['recordId']:r for r in out['rows']},out['steps'])

    def test_actual_student_action_controls_context_and_rewards_harmful_pause(self):
        out=self.complete();report=core.summarize(out['course'])
        self.assertGreater(report['harmfulNotesSuspendedOnTraining'],0)
        self.assertEqual(report['validSuspendActions'],8)
        self.assertGreater(report['managementVsAlwaysUse'],0)
        self.assertEqual(report['managementVsAlwaysSuspend'],0)
        for obj in out['course']['objects']:self.assertFalse(obj['contextUsed'])
        self.assertTrue(all(f['advantage']>0 for f in out['course']['managementFeedback']))

    def test_wrong_use_and_wrong_suspend_receive_negative_credit(self):
        for kw in (dict(action='USE',harmful=True),dict(action='SUSPEND',harmful=False)):
            out=self.complete(**kw)
            initial_feedback=[f for f in out['course']['managementFeedback'] if
                out['notes'][f['summaryZipId']].get('summaryProtocol')!=core.PROTOCOL]
            self.assertTrue(initial_feedback)
            self.assertTrue(all(f['advantage']<0 for f in initial_feedback))
        out=self.complete(action='USE',harmful=False)
        self.assertTrue(all(o['contextUsed'] for o in out['course']['objects']))

    def test_writer_reads_real_later_history_and_original_note_without_host_correction(self):
        out=self.complete();notes=out['course']['revisions'];self.assertEqual(len(notes),6)
        for n in notes:
            core.validate_summary(n)
            prompt=json.dumps(n['studentOriginal']['studentPrompt'])
            self.assertIn(n['priorSummaryOriginal']['studentRaw'],prompt)
            self.assertIn('later TRAIN evidence',prompt)
            self.assertGreaterEqual(len(core.history_view(n['reuseHistory'],n['revisionOf'])),2)
            self.assertTrue(all(r['split']=='training' for r in n['reuseHistory']))

    def test_invalid_management_is_saved_and_no_student_action_is_invented(self):
        out=self.complete(action='I might use it, or not.')
        self.assertTrue(all(f['action'] is None and f['advantage']==-.1 for f in out['course']['managementFeedback']))
        self.assertTrue(all(not o['contextUsed'] for o in out['course']['objects']))
        self.assertTrue(all(c['invalidActionFallback']=='without_summary' for c in out['course']['managementChoices'] if not c['validStudentAction']))

    def test_student_can_restore_a_paused_note_and_actual_context_changes(self):
        plan=core.make_plan(set(),roots());second=plan['training'][1]['id']
        out=self.complete(action=lambda task:'USE' if task['id']==second else 'SUSPEND')
        first_obj,second_obj=out['course']['objects'][:2]
        self.assertFalse(first_obj['contextUsed']);self.assertTrue(second_obj['contextUsed'])
        self.assertEqual(first_obj['summaryZipId'],second_obj['summaryZipId'])
        row=next(r for r in out['rows'] if r['phase']=='summary_management' and r['task']['id']==second)
        self.assertIn('Previous status: suspended',json.dumps(row['studentPrompt']))
        self.assertEqual(row['studentOutput']['raw'],'USE')
        self.assertIn(first_obj['summaryZipId'],out['notes'])

    def test_invalid_revisions_never_activate_and_receive_separate_penalty(self):
        out=self.complete(invalid_revision=True)
        self.assertTrue(all(r['selectedSummaryZipId'] is None for r in out['course']['revisionFeedback']))
        self.assertTrue(all(c['advantage']==-.2 for r in out['course']['revisionFeedback'] for c in r['credits']))

    def test_improved_revisions_wait_for_two_fresh_training_tests_then_activate(self):
        out=self.complete(improve_revision=True)
        self.assertEqual(sum(r['selectedSummaryZipId'] is not None for r in out['course']['revisionFeedback']),2)
        self.assertEqual(sum(s['parameterKind']=='summary' for s in out['steps']),2)
        for r in out['course']['revisionFeedback']:
            selected=next(c for c in r['credits'] if c['summaryZipId']==r['selectedSummaryZipId'])
            self.assertEqual(len(selected['cases']),2)
            self.assertTrue(all(c['task']['split']=='training' and c['gain']>0 for c in selected['cases']))
            self.assertGreater(selected['advantage'],0)
        # Revision changes availability, not the frozen original method heads.
        self.assertEqual(out['checkpoints'][0]['head'],out['checkpoints'][-1]['head'])

    def test_budgets_independent_optimizer_denominators_and_frozen_heldout(self):
        out=self.complete();self.assertLessEqual(len(out['rows'])+8,core.MAX_GENERATIONS)
        self.assertLessEqual(len(out['features']),core.MAX_FEATURE_BATCHES)
        self.assertEqual(len(out['course']['managementFeedback']),8)
        self.assertEqual(len(out['course']['revisionFeedback']),2)
        for s in out['steps']:
            expected=128 if s['parameterKind']=='management' else 384
            self.assertEqual(s['policyUpdate']['constantTokenDenominator'],expected)
        self.assertEqual(len(out['course']['history']),8)
        self.assertTrue(out['course']['heldoutStateUnchanged'])
        for cp in out['checkpoints']:self.assertEqual(cp['head'],out['initial']['head'])
        for kind,row in out['saved']:
            if kind=='object' and row['phase']=='heldout':self.assertEqual(row['trainingUpdates'],0)

    def test_all_management_and_method_choices_are_saved_before_actual_math(self):
        out=self.complete()
        for obj in out['course']['objects']:
            choices=[i for i,(k,r) in enumerate(out['saved']) if k in ('decision','management-choice') and
                (r['task']['id'] if k=='decision' else r['taskId'])==obj['id']]
            math=[i for i,(k,r) in enumerate(out['saved']) if k=='scored' and r['phase']=='route_math' and r['task']['id']==obj['id']]
            self.assertLess(max(choices),min(math))

    def test_saved_real_algorithm_replay_binds_management_credit_and_histories(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp);out,result=self.write_replay(p);c=self.replay(p,out,result)
            self.assertEqual(c['history'],out['course']['history'])
            path=next((p/'management-feedback').glob('*.json'));row=json.loads(path.read_text());row['advantage']+=.01
            path.write_text(json.dumps(row))
            with self.assertRaises(ValueError):self.replay(p,out,result)

    def test_changed_action_and_revision_feedback_are_detected(self):
        for kind,key in (('management-choice','action'),('revision-feedback','selectedSummaryZipId')):
            with tempfile.TemporaryDirectory() as temp:
                p=Path(temp);out,result=self.write_replay(p);path=next((p/kind).glob('*.json'));row=json.loads(path.read_text())
                row[key]='made-up';path.write_text(json.dumps(row))
                with self.assertRaises(ValueError):self.replay(p,out,result)

    def test_native_zip_preserves_old_original_and_revised_words(self):
        n=self.complete()['course']['revisions'][0]
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp);hashes={n['id']:runtime.write_summary_zip(p,n)}
            self.assertEqual(runtime.read_summary_zip(p,n['id'],hashes),n)
            path=p/(n['id']+'.zip');path.write_bytes(path.read_bytes()+b'changed')
            with self.assertRaises(ValueError):runtime.read_summary_zip(p,n['id'],hashes)

    def test_deadline_and_failure_do_not_fabricate_management_or_writer_updates(self):
        out=self.fixture(deadline=time.monotonic()-1);self.assertIsInstance(out['error'],TimeoutError);self.assertEqual(out['rows'],[])
        out=self.fixture(fail_at=1);self.assertIsInstance(out['error'],RuntimeError);self.assertEqual(len(out['rows']),1);self.assertEqual(out['steps'],[])

    def test_management_prompt_rejects_heldout_and_changed_history(self):
        out=self.complete();history=copy.deepcopy(out['course']['history']);note=out['notes'][history[0]['summaryZipId']]
        for mode in ('heldout','changed'):
            bad=copy.deepcopy(history)
            if mode=='heldout':bad[0]['split']='heldout';bad[0].pop('historyHash');bad[0]=core.seal(bad[0],'historyHash')
            else:bad[0]['useExpected']+=.1
            with self.assertRaises(ValueError):core.management_messages(out['plan']['training'][0],note,bad,'available')

    def test_tokenizer_only_preflight_checks_manager_revision_and_feature_inputs(self):
        from unittest.mock import Mock
        class Tokenizer:
            model_max_length=8192
            def apply_chat_template(self,messages,*,tokenize,add_generation_prompt):return json.dumps(messages)
            def __call__(self,text,*,add_special_tokens,truncation):return dict(input_ids=[1]*(4097 if overflow[0] else len(text.split())))
        out=self.complete();overflow=[False];module=ModuleType('transformers')
        module.AutoTokenizer=Mock();module.AutoTokenizer.from_pretrained.return_value=Tokenizer()
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp);(p/'config.json').write_text(json.dumps(dict(max_position_embeddings=8192)))
            with patch.dict(sys.modules,{'transformers':module}):
                _,_,report=runtime.prepare_inputs(p,out['plan'],roots(),out['initial'],out['notes'])
                self.assertTrue(report['tokenizerOnly']);self.assertFalse(report['modelWeightsLoaded'])
                self.assertTrue(report['planningPlaceholderNotStudentText'])
                self.assertGreater(len(report['rows']),70)
                overflow[0]=True
                with self.assertRaises(ValueError):runtime.prepare_inputs(p,out['plan'],roots(),out['initial'],out['notes'])

    def test_migration_uses_only_parent_training_observations_and_preserves_old_scores(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp);prior,result=prior_fixture.CourseChecks().write_replay(p)
            (p/'feature').mkdir()
            for f in prior['features']:(p/'feature'/(f['id']+'.json')).write_text(json.dumps(f))
            previous=dict(initialGates=prior['course']['finalGates'],initialHeads=prior['course']['finalHeads'],inherited=prior['notes'])
            before=copy.deepcopy(previous);initial=inspector.migrate(previous,p)
            self.assertEqual(previous,before);self.assertTrue(initial['history'])
            held={t['id'] for t in prior['plan']['heldout']}
            self.assertFalse({r['taskId'] for r in initial['history']} & held)
            self.assertTrue(all(r['split']=='training' and r['originalScoresChanged'] is False for r in initial['history']))
            core.validate_history(initial['history'])

    def test_preflight_and_wrong_source_fail_before_model_loading(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp);(p/'result.json').write_text(json.dumps(dict(fixtureOnly=True)))
            with self.assertRaisesRegex(ValueError,'Fixture'):inspector.inspect_training_source(p)


class PolicyChecks(unittest.TestCase):
    def test_action_completion_and_aliases_never_repair_capped_or_ambiguous_originals(self):
        for raw,expected in (('USE.','USE'),('temporarily suspend','SUSPEND'),('暂时停用','SUSPEND'),('use and suspend',None)):
            out=response(raw,False);self.assertEqual(core.parse_action(out),expected)
        out=response('USE',True,capped=True);self.assertIsNone(core.parse_action(out))
        self.assertEqual(out['raw'],'USE')

    def test_manager_and_summary_use_separate_128_token_trajectories(self):
        self.assertEqual(policy.token_limit('summary_management'),128)
        self.assertEqual(policy.token_limit('experience_summary'),128)
        self.assertEqual(policy.token_limit('route_math'),96)
        self.assertAlmostEqual(core.management_credit('SUSPEND',.2,.6),.4)
        self.assertAlmostEqual(core.management_credit('USE',.2,.6),-.4)

    def test_new_namespace_and_partial_courses_reserved(self):
        from zip_summary_training_v7_core import seed_for
        self.assertGreater(core.seed_for(1,0,0),seed_for(1000,20,99))
        with tempfile.TemporaryDirectory() as temp:
            for version,number in (('lain-zip-experience-summary-training-v7',13),('lain-zip-memory-management-training-v8',14)):
                p=Path(temp)/('zip-summary-training-'+str(number));p.mkdir();(p/'protocol.json').write_text(json.dumps(dict(protocol=version,trainingRound=number)))
            self.assertEqual(runtime.next_number(temp),15)


class EntryChecks(unittest.TestCase):
    def test_duplicate_entry_returns_saved_result_and_never_repeats_training(self):
        from zip_summary_training_v8_entry import main_once
        namespace={};calls=[]
        def run():calls.append(1);return ('saved-folder',{'completed':True})
        first=main_once(namespace,'same-cell',run);second=main_once(namespace,'same-cell',run)
        self.assertEqual(first,second);self.assertEqual(len(calls),1)
        main_once(namespace,'another-cell',run);self.assertEqual(len(calls),2)

    def test_light_review_omits_heavy_features_weights_and_ancestral_notes(self):
        from zip_summary_training_v8_entry import small_review_paths
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)
            for rel in ('result.json','responses/one-raw.json','responses/one-scored.json','feature/huge.json',
                        'summary-zips/ancestor.zip','checkpoints/weights.safetensors','reuse-history/record.json'):
                path=p/rel;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('{}')
            selected={str(x.relative_to(p)) for x in small_review_paths(p)}
            self.assertEqual(selected,{'result.json','responses/one-raw.json','reuse-history/record.json'})

    def test_complete_receipt_rejects_missing_freezes_or_fabricated_update_counts(self):
        from zip_summary_training_v8_entry import validate_completed
        row=dict(protocol=core.PROTOCOL,fixtureOnly=False,fixtureGenerations=0,teacherCalls=0,
            stopReason='completed',error=None,completeTrainingExperiment=True,completedTrainingObjects=8,
            completedHeldoutObjects=4,coldReproductions=8,studentWrittenSummaryZips=6,actualStudentGenerations=102,
            managementOptimizerUpdates=8,summaryOptimizerUpdates=2,trainingUpdates=10,choiceHeadTrainingUpdates=0,
            **{k:True for k in ('baseWeightsUnchanged','mathematicalWriterUnchanged','originalSemanticWriterUnchanged',
                               'methodHeadsUnchanged','originalFilesUnchanged','heldoutLearnedStateUnchanged')})
        validate_completed(row)
        for key,value in (('fixtureOnly',True),('heldoutLearnedStateUnchanged',False),('trainingUpdates',9),('actualStudentGenerations',103)):
            changed=copy.deepcopy(row);changed[key]=value
            with self.assertRaises(ValueError):validate_completed(changed)

if __name__=='__main__':unittest.main()
