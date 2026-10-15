"""Fixture-only checks for full-path reward; no model-training claims."""
import copy
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
from types import ModuleType
import sys

from choice_continue_core import make_plan
from object_choice_core import ChoiceHead,normalized_features
from tool_loop_kernel import _combine_options, _distribution_options
from zip_content_core import digest
from zip_label_grounded_checks import feature_messages
from draft_inspect_runtime import snapshot,sha
from test_zip_summary_training_v2 import roots, response, fixture_event
from zip_summary_training_v3_core import (BRANCHES,EVALUATION_ARMS,TRAINING_OBJECTS,
    MAX_GENERATIONS,MAX_FEATURE_BATCHES,PROTOCOL,seed_for,candidate_cards,
    summary_messages,make_summary,validate_summary,summary_credit,multi_object_credit,
    retention_review,run_course,summarize)
from zip_summary_training_v3_run import (prepare_inputs,state_unchanged,
    review_inherited_context,write_summary_zip,read_summary_zip,next_number,inspect_training_source)


def note_fixture(raw='The attempt suggests retaining the shared inner expression when recalling a rewrite.',**options):
    event=fixture_event()
    row=dict(recordId='fixture-summary',phase='experience_summary',branch=BRANCHES[0],task=event['task'],
        studentPrompt=summary_messages(event),studentOutput=response(raw,**options),
        fixtureOnly=True,eventHash=event['eventHash'])
    return make_summary(row,event,BRANCHES[0])


class FullReuseCreditChecks(unittest.TestCase):
    def measurements(self,note,deltas=(.1,.03)):
        rows=[]
        for i,(family,delta) in enumerate(zip(('same_factor','product_of_sum'),deltas),1):
            task=dict(note['event']['task'],id='later-'+str(i),split='training',family=family)
            item=summary_credit(note,task,.4,.4+delta,
                dict(without='plain-feature-'+str(i),withSummary='note-feature-'+str(i)),
                dict(without='plain-observation-'+str(i),withSummary='note-observation-'+str(i)),99+i)
            item.update(rewardObjectNumber=i+1,rewardTaskFamily=family,sourceMathRecordIds=['m1','m2','m3'])
            rows.append(item)
        return rows

    def test_positive_mean_cannot_hide_a_loss_on_one_structure(self):
        note=note_fixture();credit=multi_object_credit(note,self.measurements(note,(.1,-.02)))
        self.assertGreater(credit['signedFullReuseGain'],0)
        self.assertAlmostEqual(credit['advantage'],-.04)
        self.assertFalse(credit['eligibleForRetention'])
        self.assertFalse(credit['noTrainingStructureRegression'])

    def test_two_nonnegative_structure_gains_can_reinforce_the_sampled_note(self):
        note=note_fixture();credit=multi_object_credit(note,self.measurements(note))
        self.assertAlmostEqual(credit['advantage'],.13)
        self.assertTrue(credit['eligibleForRetention'])
        self.assertFalse(credit['sameObservationWithinEachPair'])
        self.assertTrue(credit['includesObservationGenerationAndCardContext'])
        self.assertFalse(credit['proseTruthCertified'])

    def test_old_card_only_credit_or_changed_decoding_cannot_train_v3_words(self):
        note=note_fixture();rows=self.measurements(note)
        for key,value in (('conditionalOnSameObservation',True),('observationDecodingMode','sampled'),
            ('includesObservationGenerationAndCardContext',False),('signedFullReuseGain',.9),
            ('rewardObjectSplit','heldout'),('rewardTaskFamily','same_factor')):
            changed=copy.deepcopy(rows);changed[1][key]=value
            with self.assertRaises(ValueError):multi_object_credit(note,changed)
        with self.assertRaises(ValueError):multi_object_credit(note,rows[:1])
        with self.assertRaises(ValueError):multi_object_credit(note,[rows[0],rows[0]])

    def test_actual_full_path_loss_is_not_replaced_by_card_only_gain(self):
        note=note_fixture();task=dict(note['event']['task'],id='later',split='training')
        item=summary_credit(note,task,.4070,.3297,
            dict(without='actual-plain',withSummary='actual-full'),
            dict(without='actual-plain-observation',withSummary='actual-noted-observation'),100)
        self.assertAlmostEqual(item['signedFullReuseGain'],-.0773)
        self.assertLess(item['advantage'],0)
        self.assertNotIn('signedConditionalCardGain',item)

    def test_known_false_result_still_has_its_separate_unrepaired_original(self):
        note=note_fixture('The correct result is 999*v.')
        self.assertFalse(note['audit']['eligibleForTrial'])
        self.assertEqual(note['studentRaw'],'The correct result is 999*v.')
        self.assertIn('disproved_explicit_task_result',note['audit']['reasons'])
        validate_summary(note)

    def test_final_head_review_can_reject_a_previously_positive_representation(self):
        note=note_fixture();cases=[]
        for i,family in enumerate(('same_factor','product_of_sum'),1):
            cases.append(dict(task=dict(note['event']['task'],id='later-'+str(i),family=family),
                without=[[0.,0.],[.4,0.],[0.,0.]],withSummary=[[0.,0.],[1.,0.],[0.,0.]],
                outcomes=[0,1,0],featureIds=dict(without='p'+str(i),withSummary='n'+str(i)),
                sourceMathRecordIds=['m1','m2','m3']))
        before=retention_review(note,cases,ChoiceHead([.5,0.]))
        after=retention_review(note,cases,ChoiceHead([-.5,0.]))
        self.assertTrue(before['retainedForHeldout']);self.assertFalse(after['retainedForHeldout'])
        self.assertFalse(after['writerUpdatedAgain']);self.assertEqual(after['newStudentGenerations'],0)
        cases[1]['task']['split']='heldout'
        with self.assertRaises(ValueError):retention_review(note,cases,ChoiceHead([.5,0.]))

    def test_native_new_and_legacy_notes_keep_whole_originals(self):
        from test_zip_summary_training_v2 import fixture_note as legacy_note
        for note in (note_fixture(),legacy_note()):
            before=copy.deepcopy(note)
            with tempfile.TemporaryDirectory() as temp:
                folder=Path(temp);hashes={note['id']:write_summary_zip(folder,note)}
                self.assertEqual(read_summary_zip(folder,note['id'],hashes),before)
            self.assertEqual(note,before)

    def test_transition_archives_old_context_without_resetting_heads_or_writer_files(self):
        from test_zip_summary_training_v2 import fixture_note as legacy_note
        old=legacy_note();head=ChoiceHead([.3,.2]).state()
        resume=dict(initialBanks={BRANCHES[0]:old['id'],BRANCHES[1]:None},inherited={old['id']:old},
            initialHeads={b:copy.deepcopy(head) for b in BRANCHES},summaryFiles={b:'saved-'+b for b in BRANCHES})
        before=copy.deepcopy(resume);reviewed=review_inherited_context(resume)
        self.assertIsNone(reviewed['initialBanks'][BRANCHES[0]])
        self.assertEqual(reviewed['initialHeads'],before['initialHeads'])
        self.assertEqual(reviewed['summaryFiles'],before['summaryFiles'])
        self.assertEqual(resume,before);self.assertTrue(old['audit']['eligibleForTrial'])

    def test_fresh_seeds_and_partial_rounds_include_both_old_protocols(self):
        from zip_summary_training_v2_core import seed_for as v2_seed
        self.assertGreater(seed_for(1,0,0),v2_seed(1000,20,99))
        with tempfile.TemporaryDirectory() as temp:
            work=Path(temp)
            for i,protocol in enumerate(('lain-zip-experience-summary-training-v1',
                    'lain-zip-experience-summary-training-v2',PROTOCOL),1):
                folder=work/('zip-summary-training-fixture-'+str(i));folder.mkdir()
                (folder/'protocol.json').write_text(json.dumps(dict(protocol=protocol,trainingRound=i*3)))
            self.assertEqual(next_number(work),10)

    def test_fixture_source_cannot_reach_any_model_import_or_training(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);(folder/'result.json').write_text(json.dumps(dict(fixtureOnly=True)))
            with self.assertRaisesRegex(ValueError,'Fixture'):inspect_training_source(folder)
            self.assertEqual({p.name for p in folder.iterdir()},{'result.json'})


class FullReuseLoopChecks(unittest.TestCase):
    def fixture_run(self,all_failed=False,invalid=False,harmful=False,fail_generation=None,deadline=None,source_test=False):
        rr=roots();full=make_plan(set(),rr);plan=dict(full,training=full['training'][:TRAINING_OBJECTS])
        initial={b:ChoiceHead([.3,-.2]).state() for b in BRANCHES}
        rows=[];saved=[];learns=[];zips={};checkpoints=[];features=[]
        state={b:0 for b in BRANCHES};current=BRANCHES[0]
        def select(branch):
            nonlocal current
            current=branch
        def ask(phase,messages,seed,*,mode,sampled=False,**context):
            if fail_generation is not None and len(rows)==fail_generation:raise RuntimeError('fixture generation failure')
            task=context['task'];text='A concrete current expression can be examined.'
            if mode=='math':
                card=context['selectedCandidate'];right=task['expression']
                if not all_failed:
                    fn=_combine_options if card['kind']=='combine' else _distribution_options if card['kind']=='distribute' else None
                    options=list(fn(task['expression'],card['root'],False)) if fn else []
                    if options:right=options[0][0]
                text=task['expression']+' = '+right
            elif mode=='summary':text='T1 T1' if invalid else 'This experience suggests remembering the expression structure when choosing a stored rewrite.'
            elif context.get('summaryZipId'):text='The earlier summary has changed this observation.'
            output=response(text,sampled);output['summaryStateHashDuringGeneration']=str(state[current])
            if source_test:
                output.pop('testDouble');output.update(mathAdapterEnabledDuringGeneration=mode=='math',
                    semanticAdapterEnabledDuringGeneration=False,summaryAdapterEnabledDuringGeneration=mode=='summary')
            row=dict(recordId='fixture-call-'+str(len(rows)+1),phase=phase,studentPrompt=messages,
                studentOutput=output,samplingSeed=seed,fixtureOnly=not source_test,
                offlineFixtureFactory=True,**context)
            rows.append(row);return row
        def feature(task,row,cards):
            noted='sourceSummaryZipId' in cards[0]
            good=1 if task['family']=='same_factor' else 2
            if noted and harmful:good=3-good
            vecs=[[0.,0.],[0.,0.],[0.,0.]];vecs[good]=[1. if noted else .4,.2]
            hidden=copy.deepcopy(vecs)
            if source_test:
                hidden=[[0.,1.],[-1.,1.],[-1.,1.]]
                hidden[good]=[1.,-1.] if noted else [.4,.2]
                vecs=normalized_features(hidden)
            identifier='fixture-feature-'+str(len(features)+1)
            features.append(dict(id=identifier,row=copy.deepcopy(row),cards=copy.deepcopy(cards),vecs=vecs,hidden=hidden))
            return vecs,identifier
        def save(kind,row):saved.append((kind,copy.deepcopy(row)))
        def learn(note,credit,reason):
            self.assertEqual(note['studentOriginal']['studentOutput']['summaryStateHashDuringGeneration'],str(state[current]))
            self.assertEqual(credit['rewardObjectSplit'],'training')
            if reason=='multiple_later_training_objects':
                self.assertEqual(credit['rewardObjects'],2)
                index=next(i for i,t in enumerate(plan['training'],1) if t['id']==note['sourceTaskId'])
                self.assertEqual(credit['rewardTaskIds'],[t['id'] for t in plan['training'][index:index+2]])
            learns.append((current,copy.deepcopy(credit),reason))
            changed=abs(credit['advantage'])>1e-12;state[current]+=int(changed)
            return dict(updated=changed,parameterChanged=changed)
        def store(note):zips[note['id']]=copy.deepcopy(note)
        def read_note(identifier):return copy.deepcopy(zips[identifier])
        def checkpoint(label,heads,banks):checkpoints.append((label,copy.deepcopy(heads),copy.deepcopy(banks),copy.deepcopy(state)))
        try:
            result=run_course(plan,rr,initial,ask,feature,save,learn,select,store,read_note,checkpoint,
                time.monotonic()+30 if deadline is None else deadline,1)
        except Exception as exc:return dict(error=exc,rows=rows,saved=saved,learns=learns,features=features,checkpoints=checkpoints,zips=zips)
        return dict(result=result,rows=rows,saved=saved,learns=learns,features=features,checkpoints=checkpoints,zips=zips,plan=plan)

    def test_complete_course_pairs_the_full_path_and_matches_heldout_decoding(self):
        out=self.fixture_run();self.assertNotIn('error',out,repr(out.get('error')))
        result=out['result'];self.assertEqual(len(result['objects']),12);self.assertEqual(len(out['learns']),6)
        self.assertLessEqual(len(out['rows'])+8,MAX_GENERATIONS)
        self.assertLessEqual(len(out['features']),MAX_FEATURE_BATCHES)
        rows={r['recordId']:r for r in out['rows']};features={f['id']:f for f in out['features']}
        for branch,credit,reason in out['learns']:
            self.assertEqual(reason,'multiple_later_training_objects')
            self.assertFalse(credit['sameObservationWithinEachPair'])
            for m in credit['measurements']:
                plain=rows[m['observationIds']['without']];noted=rows[m['observationIds']['withSummary']]
                self.assertIsNone(plain['summaryZipId']);self.assertEqual(noted['summaryZipId'],m['sourceSummaryZipId'])
                self.assertEqual(plain['samplingSeed'],noted['samplingSeed'])
                self.assertFalse(plain['studentOutput']['sampled']);self.assertFalse(noted['studentOutput']['sampled'])
                self.assertEqual(features[m['featureIds']['without']]['row'],plain)
                self.assertEqual(features[m['featureIds']['withSummary']]['row'],noted)
        self.assertTrue(all(not r['studentOutput']['sampled'] for r in out['rows'] if 'observation' in r['phase']))
        for obj in result['objects']:
            decisions=[i for i,(k,r) in enumerate(out['saved']) if k=='decision' and r['task']['id']==obj['id']]
            first=min(i for i,(k,r) in enumerate(out['saved']) if k=='scored' and r.get('recordId') in obj['sourceMathRecordIds'])
            self.assertTrue(all(i<first for i in decisions))

    def test_sealed_operative_decisions_use_plain_context_despite_counterfactual_critic(self):
        out=self.fixture_run();self.assertNotIn('error',out)
        rows={r['recordId']:r for r in out['rows']}
        decisions=[r for k,r in out['saved'] if k=='decision' and r['arm']==BRANCHES[1]]
        for d in decisions:
            self.assertIsNone(rows[d['sourceKeywordRecordId']]['summaryZipId'])
            self.assertNotIn('sourceSummaryZipId',d['selectedCandidate'])
        self.assertTrue(any(r.get('counterfactualCriticOnly') for r in out['rows']))

    def test_harmful_notes_receive_negative_credit_and_exact_plain_fallback(self):
        out=self.fixture_run(harmful=True);self.assertNotIn('error',out,repr(out.get('error')))
        self.assertTrue(all(c['advantage']<0 for b,c,r in out['learns']))
        self.assertTrue(all(v is None for v in out['result']['finalBanks'].values()))
        for o in out['result']['objects']:
            if o['phase']=='heldout':
                self.assertEqual(o['expectedPassByArm'][BRANCHES[0]],o['expectedPassByArm'][EVALUATION_ARMS[2]])
                self.assertEqual(o['featureIdsByArm'][BRANCHES[0]],o['featureIdsByArm'][EVALUATION_ARMS[2]])
        self.assertEqual(len(out['zips']),6)

    def test_all_failed_routes_have_zero_word_usefulness_and_no_head_updates(self):
        out=self.fixture_run(all_failed=True);self.assertNotIn('error',out)
        self.assertTrue(all(c['advantage']==0 for b,c,r in out['learns']))
        self.assertTrue(all(not u['headUpdate']['updated'] for u in out['result']['updates']))
        self.assertTrue(all(not v for v in out['result']['finalBanks'].values()))

    def test_invalid_notes_skip_only_probes_and_still_complete_all_later_tasks(self):
        out=self.fixture_run(invalid=True);self.assertNotIn('error',out)
        self.assertEqual(len(out['result']['objects']),12)
        self.assertTrue(all(c['advantage']<0 and r=='original_rejection_penalty' for b,c,r in out['learns']))
        self.assertFalse(any(r.get('summaryZipId') for r in out['rows']))

    def test_partial_window_never_updates_or_certifies_a_note(self):
        out=self.fixture_run(fail_generation=13);self.assertIsInstance(out['error'],RuntimeError)
        self.assertFalse(out['learns'])
        measured=[r['summaryMeasurement'] for k,r in out['saved'] if k=='update' and r['summaryMeasurement']]
        self.assertEqual(len(measured),2)
        self.assertTrue(all(m['rewardObjectNumber']==2 for m in measured))

    def test_deadline_stops_before_new_generation_or_training(self):
        out=self.fixture_run(deadline=time.monotonic()-1)
        self.assertIsInstance(out['error'],TimeoutError);self.assertFalse(out['rows']);self.assertFalse(out['learns'])

    def test_final_retention_is_training_only_and_heldout_never_changes_states(self):
        out=self.fixture_run();self.assertNotIn('error',out)
        for review in out['result']['retentionReviews']:
            self.assertTrue(review['usesTrainingEvidenceOnly']);self.assertFalse(review['writerUpdatedAgain'])
            self.assertEqual(len(review['measurements']),2)
            self.assertTrue(all(m['taskId'] in {o['id'] for o in out['result']['objects'] if o['phase']=='training'} for m in review['measurements']))
        before=next(c for c in out['checkpoints'] if c[0]=='training-final');after=out['checkpoints'][-1]
        self.assertEqual(before[1:],after[1:])
        result=out['result'];report=summarize(result['objects'],[r for k,r in out['saved'] if k=='trial'],
            result['summaries'],result['updates'],[],result['retentionReviews'])
        self.assertTrue(report['summaryTrainingRewardIsFullReuseEffect'])
        self.assertFalse(report['summaryTrainingRewardIsConditionalCardEffect'])
        self.assertFalse(report['statisticalSignificanceClaimed'])

    def source_fixture(self,folder):
        """Synthetic filesystem for the inspector, never a real-run artifact."""
        out=self.fixture_run(source_test=True);self.assertNotIn('error',out,repr(out.get('error')))
        def put(relative,value):
            path=folder/relative;path.parent.mkdir(parents=True,exist_ok=True)
            path.write_text(json.dumps(value,ensure_ascii=False))
        for row in out['rows']:put('responses/'+row['recordId']+'-raw.json',row)
        for kind,row in out['saved']:
            if kind=='scored':relative='responses/'+row['recordId']+'-scored.json'
            elif kind in ('object','update','trial','summary','penalty','summary-context-review'):
                relative=kind+'/'+row['id']+'.json'
            else:continue
            put(relative,row)
        for f in out['features']:
            put('feature/'+f['id']+'.json',dict(id=f['id'],task=f['row']['task'],
                sourceObservationRecordId=f['row']['recordId'],candidateCards=f['cards'],
                candidatePrompts=[feature_messages(f['row']['task'],f['row']['studentOutput'],c) for c in f['cards']],
                candidateHiddenVectors=f['hidden'],normalizedFeatures=f['vecs'],
                mathematicalAdapterEnabled=False,semanticAdapterEnabled=False,summaryAdapterEnabled=False))
        zip_folder=folder/'summary-zips';zip_folder.mkdir()
        hashes={identifier:write_summary_zip(zip_folder,note) for identifier,note in out['zips'].items()}
        result=out['result'];put('summary-zip-bank.json',dict(zipByteHashes=hashes,
            activeByBranch=result['finalBanks'],originalKnowledgeRoots=roots()))
        for label,heads,banks,states in (out['checkpoints'][0],out['checkpoints'][-1]):
            state_rows={}
            for b in BRANCHES:
                file=label+'-'+b+'.safetensors';path=folder/'checkpoints'/file
                path.parent.mkdir(exist_ok=True);path.write_bytes(b'offline synthetic checkpoint, not model weights')
                state_rows[b]=dict(file=file,fileSha256=sha(path),stateHash=str(states[b]))
            put('checkpoints/'+label+'.json',dict(heads=heads,banks=banks,summaryStates=state_rows))
        steps=[]
        for update in result['updates']:
            if not update['summaryUpdate']['updated']:continue
            file='fixture-step-'+str(len(steps)+1)+'.safetensors';path=folder/'checkpoints'/file;path.write_bytes(b'fixture step')
            row=dict(id='fixture-step-'+str(len(steps)+1),sourceSummaryZipId=update['delayedSummaryCredit']['sourceSummaryZipId'],
                file=file,fileSha256=sha(path),policyUpdate=dict(updated=True))
            steps.append(row);put('summary-step/'+row['id']+'.json',row)
        for i in range(8):
            row=dict(recordId='fixture-cold-'+str(i),phase='cold_replay',fixtureOnly=False,
                offlineFixtureFactory=True,studentOutput=response('Original response.',False))
            row['studentOutput'].pop('testDouble');put('responses/'+row['recordId']+'-raw.json',row)
            put('responses/'+row['recordId']+'-scored.json',dict(row,check=dict(exactReproduction=dict(exact=True))))
        put('zip-summary-questions.json',out['plan'])
        put('source-checkpoint.json',dict(baseStateHash='fixture-base',mathematicalWriterStateHash='fixture-math'))
        summaries=result['summaries'];updates=result['updates'];trials=[r for k,r in out['saved'] if k=='trial']
        penalties=[r for k,r in out['saved'] if k=='penalty']
        put('result.json',dict(protocol=PROTOCOL,stopReason='completed',error=None,fixtureOnly=False,
            offlineFixtureFactory=True,fixtureGenerations=0,teacherCalls=0,completedTrainingObjects=8,completedHeldoutObjects=4,
            coldReproductions=8,heldoutLearnedStateUnchanged=True,baseWeightsUnchanged=True,mathematicalWriterUnchanged=True,
            originalSemanticWriterUnchanged=True,originalFilesUnchanged=True,finalHeads=result['finalHeads'],
            finalBanks=result['finalBanks'],actualStudentGenerations=len(out['rows'])+8,featureForwardBatches=len(out['features']),
            summaryOptimizerUpdates=len(steps),summary=summarize(result['objects'],trials,summaries,updates,penalties,result['retentionReviews'])))
        put('run-file-manifest.json',dict(files={k:v for k,v in snapshot(folder).items() if k!='result.json'}))
        return dict(result=dict(baseStateBefore='fixture-base',mathematicalWriterStateHash='fixture-math'))

    def test_complete_v3_saved_algorithm_can_resume_without_model_import(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);foundation=self.source_fixture(folder)
            with patch('zip_summary_training_v3_run.inspect_source',return_value=foundation):
                resume=inspect_training_source(folder)
            self.assertEqual(resume['initialHeads'],json.loads((folder/'result.json').read_text())['finalHeads'])

    def test_rehashed_changed_observation_seed_cannot_pass_full_path_source_audit(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);foundation=self.source_fixture(folder)
            update=next(json.loads(p.read_text()) for p in (folder/'update').glob('*.json')
                if json.loads(p.read_text())['summaryMeasurement'])
            identifier=update['summaryMeasurement']['observationIds']['withSummary']
            for suffix in ('raw','scored'):
                path=folder/'responses'/(identifier+'-'+suffix+'.json');row=json.loads(path.read_text())
                row['samplingSeed']+=1;path.write_text(json.dumps(row))
            path=folder/'run-file-manifest.json'
            path.write_text(json.dumps(dict(files={k:v for k,v in snapshot(folder).items()
                if k not in ('result.json','run-file-manifest.json')})))
            with patch('zip_summary_training_v3_run.inspect_source',return_value=foundation):
                with self.assertRaisesRegex(ValueError,'decoding, seed or adapter'):inspect_training_source(folder)


class TokenizerOnlyPreflightChecks(unittest.TestCase):
    def preflight(self,oversized=False):
        class Tokenizer:
            model_max_length=8192
            def apply_chat_template(inner,messages,*,tokenize,add_generation_prompt):
                self.assertFalse(tokenize);self.assertTrue(add_generation_prompt);return json.dumps(messages)
            def __call__(inner,text,*,add_special_tokens,truncation):
                self.assertFalse(add_special_tokens);self.assertFalse(truncation)
                return dict(input_ids=[1]*(4097 if oversized else len(text.split())))
        module=ModuleType('transformers');module.AutoTokenizer=Mock()
        module.AutoTokenizer.from_pretrained.return_value=Tokenizer();rr=roots();full=make_plan(set(),rr)
        plan=dict(full,training=full['training'][:TRAINING_OBJECTS])
        with tempfile.TemporaryDirectory() as temp:
            student=Path(temp);(student/'config.json').write_text(json.dumps(dict(max_position_embeddings=8192)))
            with patch.dict(sys.modules,{'transformers':module}):result=prepare_inputs(student,plan,rr)
        return result

    def test_real_preflight_builds_all_new_prompt_shapes_without_loading_weights(self):
        tokenizer,limits,report=self.preflight();self.assertTrue(report['allShapesFit'])
        self.assertFalse(report['modelWeightsLoaded']);self.assertEqual(len(report['rows']),104)
        self.assertTrue(all(r['audit']['noSilentTruncation'] for r in report['rows']))

    def test_long_input_rejected_before_model_load(self):
        with self.assertRaisesRegex(ValueError,'Input token budget'):self.preflight(True)

    def test_unknown_weight_state_is_not_a_reported_change(self):
        self.assertIsNone(state_unchanged(None,None));self.assertIs(state_unchanged('a','a'),True)
        self.assertIs(state_unchanged('a','b'),False)


if __name__=='__main__':unittest.main()
