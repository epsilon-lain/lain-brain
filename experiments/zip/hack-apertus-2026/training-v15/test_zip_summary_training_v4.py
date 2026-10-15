"""Offline synthetic checks. No model generations or training are performed."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from types import ModuleType
from unittest.mock import Mock,patch

from test_zip_summary_training_v2 import roots,response,fixture_event
from object_choice_core import ChoiceHead,normalized_features
from tool_loop_kernel import _combine_options,_distribution_options
from choice_continue_core import make_plan
from draft_inspect_runtime import snapshot,sha
from zip_label_grounded_checks import feature_messages,replay_item,guarded_head_update
import zip_summary_training_v4_core as core
import zip_summary_training_v4_run as runtime


def note_fixture(raw='Retaining a concrete expression detail may help choose a later rewrite.',**options):
    event=core.event_record(**{k:fixture_event()[k] for k in ('task','observation','decision','routes')})
    row=dict(recordId='fixture-note',phase='experience_summary',task=event['task'],branch=core.BRANCHES[0],
        studentPrompt=core.summary_messages(event),eventHash=event['eventHash'],
        studentOutput=response(raw,**options),fixtureOnly=True)
    return core.make_summary(row,event,core.BRANCHES[0])


def rating_fixture(note,raw='This ZIP might help later tasks. Score: 0.75.',**options):
    return dict(recordId='fixture-rating',phase='summary_quality_estimate',task=note['event']['task'],
        branch=note['branch'],summaryZipId=note['id'],studentPrompt=core.summary_rating_messages(note),
        studentOutput=response(raw,False,**options),fixtureOnly=True)


class RatingAndCreditChecks(unittest.TestCase):
    def test_literal_rating_preserves_raw_span_and_is_never_an_admission_gate(self):
        note=note_fixture();row=rating_fixture(note);before=copy.deepcopy(row)
        rating=core.make_rating(note,row)
        self.assertEqual(rating['studentPredictedUsefulness'],.75)
        start,end=rating['literalScoreSpan'];self.assertEqual(row['studentOutput']['raw'][start:end],'0.75')
        self.assertFalse(rating['ratingUsedAsReward']);self.assertFalse(rating['studentRatingCertifiesQuality'])
        self.assertEqual(row,before);self.assertTrue(note['audit']['eligibleForTrial'])

    def test_unknown_duplicate_out_of_range_nonfinite_or_capped_rating_does_not_repair_or_block_note(self):
        note=note_fixture()
        for text,options in (('I am uncertain.',{}),('Score: true',{}),('Score: nan',{}),('Score: 1.2',{}),
                ('Score: 0.9\nScore: 0.7',{}),('Score: 0.8',dict(capped=True))):
            row=rating_fixture(note,text,**options);rating=core.make_rating(note,row)
            self.assertIsNone(rating['studentPredictedUsefulness'])
            self.assertEqual(rating['studentRaw'],text);self.assertFalse(rating['numericalPredictionRequiredForTrial'])
            self.assertTrue(note['audit']['eligibleForTrial'])

    def test_another_zip_cannot_receive_the_students_rating(self):
        note=note_fixture();row=rating_fixture(note);row['summaryZipId']='another'
        with self.assertRaisesRegex(ValueError,'another source'):core.make_rating(note,row)

    def test_reference_volume_given_to_writer_excludes_heldout_and_duplicate_mentions(self):
        note=note_fixture()
        row=dict(recordId='obs',task=note['event']['task'],summaryZipId=note['id'],
            studentOutput=response('The previous summary and this ZIP could help.',False))
        refs=[core.literal_references(note,row,role) for role in ('operative_context','accepted_context_review')]
        row2=copy.deepcopy(row);row2['recordId']='heldout';row2['task']['split']='heldout'
        refs.append(core.literal_references(note,row2,'operative_context'))
        usage=core.usage_summary(note,refs)
        self.assertEqual(usage['studentReferenceCount'],1);self.assertEqual(usage['operativeContextCount'],1)
        self.assertEqual(len(usage['referenceRecordIds']),2);self.assertEqual(usage['autonomousZipSelections'],0)

    def test_student_reference_is_a_literal_reference_in_supplied_context(self):
        note=note_fixture();raw='The previous summary may help, but I am unsure.'
        row=dict(recordId='obs',task=note['event']['task'],summaryZipId=note['id'],studentOutput=response(raw,False))
        ref=core.literal_references(note,row,'operative_context')
        self.assertTrue(ref['studentExplicitReference']);self.assertTrue(ref['operativeContextUse'])
        self.assertFalse(ref['autonomousZipSelection']);self.assertFalse(ref['semanticUseOrUnderstandingCertified'])
        s=ref['studentReferenceSpans'][0];self.assertEqual(raw[s['start']:s['end']],s['literal'])

    def test_rating_and_reference_count_cannot_turn_a_harmful_zip_into_positive_credit(self):
        note=note_fixture();rating=core.make_rating(note,rating_fixture(note,'Score: 1.0'))
        rows=[]
        for i,(family,delta) in enumerate((('same_factor',.1),('product_of_sum',-.02)),1):
            task=dict(note['event']['task'],id='later-'+str(i),family=family)
            m=core.summary_credit(note,task,.4,.4+delta,dict(without='p'+str(i),withSummary='n'+str(i)),
                dict(without='o'+str(i),withSummary='w'+str(i)),9+i)
            m['rewardTaskFamily']=family;rows.append(m)
        credit=core.multi_object_credit(note,rows)
        self.assertLess(credit['advantage'],0);self.assertFalse(credit['eligibleForRetention'])
        self.assertFalse(credit['positiveRewardFromCitationVolume'])
        self.assertFalse(credit['positiveRewardFromSelfRating'])
        cal=core.calibration_record(note,rating,credit);self.assertEqual(cal['squaredPredictionError'],1.)
        self.assertFalse(cal['usesHeldoutFeedback'])

    def test_whole_original_known_false_result_is_not_repaired(self):
        note=note_fixture('The correct result is 999*v.')
        self.assertFalse(note['audit']['eligibleForTrial']);self.assertEqual(note['studentRaw'],'The correct result is 999*v.')
        core.validate_summary(note)

    def test_float_noise_allowance_keeps_types_structure_and_changes_exact(self):
        self.assertTrue(runtime.numeric_same({'p':.3},{'p':.3+1e-15}))
        for a,b in ((.3,.300001),(True,1),(1,1.),('id','other'),([.3],[.3,.3]),(float('nan'),float('nan'))):
            self.assertFalse(runtime.numeric_same(a,b))

    def test_all_prior_partial_rounds_are_reserved_and_seed_namespace_is_new(self):
        from zip_summary_training_v3_core import seed_for as old_seed
        self.assertGreater(core.seed_for(1,0,0),old_seed(1000,20,99))
        with tempfile.TemporaryDirectory() as temp:
            for i in range(1,5):
                folder=Path(temp)/('zip-summary-training-fixture-'+str(i));folder.mkdir()
                (folder/'protocol.json').write_text(json.dumps(dict(protocol='lain-zip-experience-summary-training-v'+str(i),trainingRound=2*i)))
            self.assertEqual(runtime.next_number(temp),9)


class IsolatedTrialChecks(unittest.TestCase):
    def fixture_run(self,harmful=False,invalid=False,all_failed=False,fail_generation=None,deadline=None,
            later_harmful=False,source_test=False,rating_capped=False):
        rr=roots();full=make_plan(set(),rr);plan=dict(full,training=full['training'][:8])
        initial={b:ChoiceHead([.3,-.2]).state() for b in core.BRANCHES}
        rows=[];saved=[];learns=[];zips={};checkpoints=[];features=[];reads=[]
        state={b:0 for b in core.BRANCHES};current=core.BRANCHES[0]
        def select(b):
            nonlocal current
            current=b
        def ask(phase,messages,seed,*,mode,sampled=False,**context):
            if fail_generation is not None and len(rows)==fail_generation:raise RuntimeError('offline fixture interruption')
            task=context['task'];text='A concrete current expression can be examined.'
            if mode=='math':
                card=context['selectedCandidate'];right=task['expression']
                if not all_failed:
                    fn=_combine_options if card['kind']=='combine' else _distribution_options if card['kind']=='distribute' else None
                    options=list(fn(task['expression'],card['root'],False)) if fn else []
                    if options:right=options[0][0]
                text=task['expression']+' = '+right
            elif phase=='summary_quality_estimate':text='It might help later tasks. Score: 0.75.'
            elif mode=='summary':text='T1 T1' if invalid else 'Retaining the shared expression structure may help later tasks.'
            elif context.get('summaryZipId'):text='The previous summary suggests considering the current expression.'
            value=response(text,sampled,capped=rating_capped and phase=='summary_quality_estimate')
            value['summaryStateHashDuringGeneration']=str(state[current])
            if source_test:
                value.pop('testDouble');value.update(mathAdapterEnabledDuringGeneration=mode=='math',
                    semanticAdapterEnabledDuringGeneration=False,summaryAdapterEnabledDuringGeneration=mode=='summary')
            row=dict(recordId='fixture-call-'+str(len(rows)+1),phase=phase,studentPrompt=messages,
                studentOutput=value,samplingSeed=seed,fixtureOnly=not source_test,offlineFixtureFactory=True,**context)
            rows.append(row);return row
        def feature(task,row,cards):
            noted=bool(row.get('summaryZipId'));good=1 if task['family']=='same_factor' else 2
            bad=harmful or (later_harmful and noted and zips[row['summaryZipId']]['sourceTaskId']!=plan['training'][0]['id'])
            if noted and bad:good=3-good
            vecs=[[0.,0.],[0.,0.],[0.,0.]];vecs[good]=[1. if noted else .4,.2]
            hidden=copy.deepcopy(vecs)
            if source_test:
                hidden=[[0.,1.],[-1.,1.],[-1.,1.]];hidden[good]=[1.,-1.] if noted else [.4,.2]
                vecs=normalized_features(hidden)
            identifier='fixture-feature-'+str(len(features)+1)
            features.append(dict(id=identifier,row=copy.deepcopy(row),cards=copy.deepcopy(cards),vecs=vecs,hidden=hidden))
            return vecs,identifier
        def save(kind,row):saved.append((kind,copy.deepcopy(row)))
        def learn(note,credit,reason):
            self.assertEqual(note['studentOriginal']['studentOutput']['summaryStateHashDuringGeneration'],str(state[current]))
            self.assertEqual(credit['rewardObjectSplit'],'training')
            if reason=='multiple_later_training_objects':self.assertEqual(len(credit['measurements']),2)
            learns.append((current,copy.deepcopy(credit),reason));changed=abs(credit['advantage'])>1e-12
            state[current]+=int(changed);return dict(updated=changed,parameterChanged=changed)
        def store(note):zips[note['id']]=copy.deepcopy(note)
        def read_note(identifier):reads.append(identifier);return copy.deepcopy(zips[identifier])
        def checkpoint(label,heads,banks):checkpoints.append((label,copy.deepcopy(heads),copy.deepcopy(banks),copy.deepcopy(state)))
        try:
            result=core.run_course(plan,rr,initial,ask,feature,save,learn,select,store,read_note,checkpoint,
                time.monotonic()+60 if deadline is None else deadline,1)
        except Exception as exc:return dict(error=exc,rows=rows,saved=saved,learns=learns,zips=zips,features=features,checkpoints=checkpoints,plan=plan)
        return dict(result=result,rows=rows,saved=saved,learns=learns,zips=zips,features=features,checkpoints=checkpoints,plan=plan,reads=reads)

    def test_failed_candidates_never_enter_any_operative_replay_or_reduce_task_training(self):
        out=self.fixture_run(harmful=True);self.assertNotIn('error',out,repr(out.get('error')))
        result=out['result'];self.assertEqual(len(out['learns']),6)
        self.assertTrue(all(c['advantage']<0 for b,c,r in out['learns']))
        features={f['id']:f for f in out['features']}
        for obj in result['objects']:
            if obj['phase']!='training':continue
            self.assertEqual(obj['featureIdsByArm'][core.BRANCHES[0]],obj['featureIdsByArm'][core.BRANCHES[1]])
            self.assertTrue(all(v is None for v in obj['sourceSummaryIdsByArm'].values()))
            for b in core.BRANCHES:self.assertFalse(features[obj['featureIdsByArm'][b]]['row'].get('summaryZipId'))
        self.assertEqual(result['finalHeads'][core.BRANCHES[0]],result['finalHeads'][core.BRANCHES[1]])
        for b in core.BRANCHES:
            h=ChoiceHead([.3,-.2]);replay=[]
            for number,obj in enumerate(result['objects'][:8],1):
                f=features[obj['featureIdsByArm'][b]]
                replay.append(replay_item(obj['task'],f['vecs'],obj['routeOutcomes'],f['id'],obj['sourceMathRecordIds']))
                guarded_head_update(h,replay,number)
            self.assertEqual(h.state(),result['finalHeads'][b])

    def test_positive_candidate_starts_only_on_the_task_after_its_two_tests(self):
        out=self.fixture_run();self.assertNotIn('error',out,repr(out.get('error')))
        result=out['result'];activations={a['summaryZipId']:a for a in result['activations']}
        number_by_task={t['id']:i for i,t in enumerate(out['plan']['training'],1)}
        self.assertTrue(any(a['activatedAfterTwoTrainingTests'] for a in activations.values()))
        for obj in result['objects'][:8]:
            identifier=obj['sourceSummaryIdsByArm'][core.BRANCHES[0]]
            if identifier:self.assertGreaterEqual(number_by_task[obj['id']],activations[identifier]['firstEligibleOperativeObjectNumber'])
            self.assertIsNone(obj['sourceSummaryIdsByArm'][core.BRANCHES[1]])
        self.assertTrue(all(n['id'] in out['reads'] for n in result['summaries']))

    def test_rejected_replacement_preserves_the_previous_accepted_context(self):
        out=self.fixture_run(later_harmful=True);self.assertNotIn('error',out,repr(out.get('error')))
        result=out['result'];acts=result['activations'];later=[a for a in acts if a['priorAcceptedSummaryZipId']]
        self.assertTrue(later)
        for a in later:
            if not a['activatedAfterTwoTrainingTests']:self.assertEqual(a['activeAfterDecision'],a['priorAcceptedSummaryZipId'])

    def test_six_ratings_do_not_add_optimizer_steps_and_budget_is_explicit(self):
        out=self.fixture_run();self.assertNotIn('error',out)
        result=out['result'];self.assertEqual(len(result['ratings']),6);self.assertEqual(len(out['learns']),6)
        self.assertTrue(all(r['studentPredictedUsefulness']==.75 for r in result['ratings']))
        self.assertLessEqual(len(out['rows'])+8,core.MAX_GENERATIONS);self.assertLessEqual(len(out['features']),core.MAX_FEATURE_BATCHES)
        for r in result['references']:self.assertFalse(r['autonomousZipSelection'])
        for obj in result['objects']:
            decisions=[i for i,(k,r) in enumerate(out['saved']) if k=='decision' and r['task']['id']==obj['id']]
            first=min(i for i,(k,r) in enumerate(out['saved']) if k=='scored' and r.get('recordId') in obj['sourceMathRecordIds'])
            self.assertTrue(all(i<first for i in decisions))

    def test_capped_rating_keeps_the_note_trial_and_signed_word_feedback(self):
        out=self.fixture_run(rating_capped=True);self.assertNotIn('error',out)
        self.assertEqual(len(out['learns']),6)
        self.assertTrue(all(r['studentPredictedUsefulness'] is None for r in out['result']['ratings']))

    def test_invalid_summaries_save_originals_skip_rating_only_and_continue_tasks(self):
        out=self.fixture_run(invalid=True);self.assertNotIn('error',out)
        self.assertEqual(len(out['result']['objects']),12);self.assertEqual(len(out['learns']),6)
        self.assertTrue(all(r=='original_rejection_penalty' for b,c,r in out['learns']))
        self.assertFalse(any(r['phase']=='summary_quality_estimate' for r in out['rows']))

    def test_partial_trial_keeps_first_measurement_without_word_update_or_activation(self):
        complete=self.fixture_run();third_task=complete['plan']['training'][2]['id']
        stop=next(i for i,r in enumerate(complete['rows']) if r['task']['id']==third_task)
        out=self.fixture_run(fail_generation=stop)
        self.assertIsInstance(out['error'],RuntimeError);self.assertFalse(out['learns'])
        self.assertFalse(any(k=='summary-activation' for k,r in out['saved']))

    def test_all_failed_math_routes_do_not_gain_credit_from_ratings_or_mentions(self):
        out=self.fixture_run(all_failed=True);self.assertNotIn('error',out)
        self.assertTrue(all(c['advantage']==0 for b,c,r in out['learns']))
        self.assertTrue(all(not u['headUpdate']['updated'] for u in out['result']['updates']))
        self.assertTrue(all(not v for v in out['result']['finalBanks'].values()))

    def test_final_guard_and_heldout_leave_both_heads_writer_states_and_banks_frozen(self):
        out=self.fixture_run();self.assertNotIn('error',out)
        before=next(c for c in out['checkpoints'] if c[0]=='training-final');after=out['checkpoints'][-1]
        self.assertEqual(before[1:],after[1:])
        self.assertTrue(all(not a['usesHeldoutFeedback'] for a in out['result']['activations']))
        self.assertTrue(all(not c['usesHeldoutFeedback'] for c in out['result']['calibrations']))
        self.assertFalse(any('heldout' in str(n['event'].get('priorZipFeedback',{})) for n in out['result']['summaries']))

    def test_deadline_before_first_action_has_no_generation_training_or_rating(self):
        out=self.fixture_run(deadline=time.monotonic()-1)
        self.assertIsInstance(out['error'],TimeoutError);self.assertFalse(out['rows']);self.assertFalse(out['learns'])

    def source_fixture(self,folder):
        """Populate a temporary fake filesystem, never a delivered result."""
        out=self.fixture_run(source_test=True);self.assertNotIn('error',out,repr(out.get('error')))
        def put(relative,value):
            path=folder/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value,ensure_ascii=False))
        for row in out['rows']:put('responses/'+row['recordId']+'-raw.json',row)
        for kind,row in out['saved']:
            if kind=='scored':relative='responses/'+row['recordId']+'-scored.json'
            elif kind in ('object','update','trial','summary','penalty','summary-context-review','summary-rating',
                    'summary-activation','zip-reference','rating-calibration'):relative=kind+'/'+row['id']+'.json'
            else:continue
            put(relative,row)
        for f in out['features']:
            put('feature/'+f['id']+'.json',dict(id=f['id'],task=f['row']['task'],sourceObservationRecordId=f['row']['recordId'],
                candidateCards=f['cards'],candidatePrompts=[feature_messages(f['row']['task'],f['row']['studentOutput'],c) for c in f['cards']],
                candidateHiddenVectors=f['hidden'],normalizedFeatures=f['vecs'],
                mathematicalAdapterEnabled=False,semanticAdapterEnabled=False,summaryAdapterEnabled=False))
        zip_folder=folder/'summary-zips';zip_folder.mkdir()
        hashes={i:runtime.write_summary_zip(zip_folder,n) for i,n in out['zips'].items()}
        result=out['result'];put('summary-zip-bank.json',dict(zipByteHashes=hashes,activeByBranch=result['finalBanks'],originalKnowledgeRoots=roots()))
        for label,heads,banks,states in (out['checkpoints'][0],out['checkpoints'][-1]):
            state_rows={}
            for b in core.BRANCHES:
                file=label+'-'+b+'.safetensors';path=folder/'checkpoints'/file;path.parent.mkdir(exist_ok=True)
                path.write_bytes(b'offline synthetic checkpoint, not real weights')
                state_rows[b]=dict(file=file,fileSha256=sha(path),stateHash=str(states[b]))
            put('checkpoints/'+label+'.json',dict(heads=heads,banks=banks,summaryStates=state_rows))
        steps=[]
        for u in result['updates']:
            if not u['summaryUpdate']['updated']:continue
            file='fixture-step-'+str(len(steps)+1)+'.safetensors';path=folder/'checkpoints'/file;path.write_bytes(b'fixture step')
            row=dict(id='fixture-step-'+str(len(steps)+1),sourceSummaryZipId=u['delayedSummaryCredit']['sourceSummaryZipId'],
                file=file,fileSha256=sha(path),policyUpdate=dict(updated=True))
            steps.append(row);put('summary-step/'+row['id']+'.json',row)
        for i in range(8):
            row=dict(recordId='fixture-cold-'+str(i),phase='cold_replay',fixtureOnly=False,offlineFixtureFactory=True,
                studentOutput=response('Original response.',False));row['studentOutput'].pop('testDouble')
            put('responses/'+row['recordId']+'-raw.json',row)
            put('responses/'+row['recordId']+'-scored.json',dict(row,check=dict(exactReproduction=dict(exact=True))))
        put('zip-summary-questions.json',out['plan']);put('source-checkpoint.json',dict(baseStateHash='fixture-base',mathematicalWriterStateHash='fixture-math'))
        get=lambda kind:[r for k,r in out['saved'] if k==kind]
        report=core.summarize(result['objects'],get('trial'),result['summaries'],result['updates'],get('penalty'),
            result['retentionReviews'],result['ratings'],result['references'],result['calibrations'],result['activations'])
        put('result.json',dict(protocol=core.PROTOCOL,trainingRound=1,stopReason='completed',error=None,fixtureOnly=False,
            offlineFixtureFactory=True,fixtureGenerations=0,teacherCalls=0,completedTrainingObjects=8,completedHeldoutObjects=4,
            coldReproductions=8,heldoutLearnedStateUnchanged=True,baseWeightsUnchanged=True,mathematicalWriterUnchanged=True,
            originalSemanticWriterUnchanged=True,originalFilesUnchanged=True,finalHeads=result['finalHeads'],finalBanks=result['finalBanks'],
            actualStudentGenerations=len(out['rows'])+8,featureForwardBatches=len(out['features']),summaryOptimizerUpdates=len(steps),summary=report))
        put('run-file-manifest.json',dict(files={k:v for k,v in snapshot(folder).items() if k!='result.json'}))
        return dict(result=dict(baseStateBefore='fixture-base',mathematicalWriterStateHash='fixture-math'))

    def test_complete_v4_algorithm_and_metadata_can_be_replayed_before_model_import(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);foundation=self.source_fixture(folder)
            with patch('zip_summary_training_v4_run.inspect_source',return_value=foundation):resume=runtime.inspect_training_source(folder)
            self.assertEqual(resume['initialHeads'],json.loads((folder/'result.json').read_text())['finalHeads'])

    def test_changed_rating_prediction_is_detected_even_with_new_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);foundation=self.source_fixture(folder)
            path=next((folder/'summary-rating').glob('*.json'));row=json.loads(path.read_text())
            row['studentPredictedUsefulness']=.99;path.write_text(json.dumps(row))
            (folder/'run-file-manifest.json').write_text(json.dumps(dict(files={k:v for k,v in snapshot(folder).items()
                if k not in ('result.json','run-file-manifest.json')})))
            with patch('zip_summary_training_v4_run.inspect_source',return_value=foundation):
                with self.assertRaises(ValueError):runtime.inspect_training_source(folder)

    def test_v3_source_still_resumes_with_original_scores_and_new_boundary(self):
        from test_zip_summary_training_v3 import FullReuseLoopChecks
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);foundation=FullReuseLoopChecks().source_fixture(folder)
            before=snapshot(folder)
            with patch('zip_summary_training_v4_run.inspect_source',return_value=foundation):resume=runtime.inspect_training_source(folder)
            self.assertEqual(snapshot(folder),before);self.assertEqual(resume['initialHeads'],json.loads((folder/'result.json').read_text())['finalHeads'])

    def test_fixture_source_is_rejected_before_any_model_import(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp);(p/'result.json').write_text(json.dumps(dict(fixtureOnly=True)))
            with self.assertRaisesRegex(ValueError,'Fixture'):runtime.inspect_training_source(p)


class TokenizerPreflightChecks(unittest.TestCase):
    def preflight(self,oversized=False):
        class Tokenizer:
            model_max_length=8192
            def apply_chat_template(inner,messages,*,tokenize,add_generation_prompt):return json.dumps(messages)
            def __call__(inner,text,*,add_special_tokens,truncation):
                self.assertFalse(truncation);return dict(input_ids=[1]*(4097 if oversized else len(text.split())))
        module=ModuleType('transformers');module.AutoTokenizer=Mock();module.AutoTokenizer.from_pretrained.return_value=Tokenizer()
        rr=roots();full=make_plan(set(),rr);plan=dict(full,training=full['training'][:8])
        with tempfile.TemporaryDirectory() as temp:
            student=Path(temp);(student/'config.json').write_text(json.dumps(dict(max_position_embeddings=8192)))
            with patch.dict(sys.modules,{'transformers':module}):return runtime.prepare_inputs(student,plan,rr)

    def test_all_112_prompt_shapes_including_ratings_are_checked_before_weights(self):
        tokenizer,limits,report=self.preflight();self.assertTrue(report['allShapesFit'])
        self.assertEqual(len(report['rows']),112);self.assertFalse(report['modelWeightsLoaded'])

    def test_overflow_is_rejected_before_weights(self):
        with self.assertRaisesRegex(ValueError,'Input token budget'):self.preflight(True)


if __name__=='__main__':unittest.main()
