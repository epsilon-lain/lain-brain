"""Offline synthetic regression checks, never actual student training."""
import copy
import json
import math
from pathlib import Path
import sys
import tempfile
import time
import unittest
from types import ModuleType
from unittest.mock import Mock, patch

from test_zip_summary_training_v2 import roots,response,fixture_event
from choice_continue_core import make_plan
from object_choice_core import ChoiceHead,normalized_features
from tool_loop_kernel import _combine_options,_distribution_options
from zip_label_grounded_checks import feature_messages
from draft_inspect_runtime import sha,snapshot
import zip_summary_training_v5_core as core
import zip_summary_training_v5_run as runtime
from zip_summary_training_v5_inspect import replay_saved_course,bounded_saved_equal


def event_fixture():
    old=fixture_event();rr=roots();task=old['task'];routes=[]
    for index,card in enumerate(core.candidate_cards(rr),1):
        options=list(_combine_options(task['expression'],card['root'],False)) if card['kind']=='combine' else []
        right=options[0][0] if options else task['expression']
        value=response(task['expression']+' = '+right,False)
        routes.append(dict(recordId='event-route-'+str(index),task=task,selectedCandidate=card,
            studentOutput=value,check=core.audit_math(task,value,card)))
    return core.event_record(task,old['observation'],old['decision'],routes)


def note_fixture(raw='The shared inner expression appeared in both terms.',index=1,event=None,capped=False):
    event=event or event_fixture();value=response(raw,capped=capped);value['summaryStateHashDuringGeneration']='fixture-writer'
    row=dict(recordId='fixture-note-'+str(index),phase='experience_summary',task=event['task'],branch=core.BRANCHES[0],
        eventHash=event['eventHash'],candidateIndex=index,studentPrompt=core.summary_messages(event),studentOutput=value,fixtureOnly=True)
    return core.make_summary(row,event,core.BRANCHES[0])


def measurements(note,deltas):
    rows=[]
    for i,(family,delta) in enumerate(zip(('same_factor','product_of_sum'),deltas),1):
        m=core.summary_credit(note,dict(id='later-'+str(i),split='training'),.4,.4+delta,
            dict(without='f-p-'+str(i),withSummary='f-n-'+str(i)),dict(without='o-p-'+str(i),withSummary='o-n-'+str(i)),10+i)
        m.update(rewardTaskFamily=family,rewardTaskExpression='example-'+str(i),rewardObjectNumber=i+1,sourceMathRecordIds=['r1','r2','r3'])
        rows.append(m)
    return rows


class FactualAndRankingChecks(unittest.TestCase):
    def test_actual_unsolved_sentence_is_rejected_when_selected_route_succeeded(self):
        note=note_fixture('The current task remains unsolved.')
        self.assertFalse(note['audit']['eligibleForTrial']);self.assertIn('disproved_direct_experience_outcome',note['audit']['reasons'])
        self.assertEqual(note['studentRaw'],'The current task remains unsolved.');core.validate_summary(note)

    def test_direct_route_and_chinese_outcomes_are_checked_against_original_source(self):
        for text in ('My selected route failed.','The task was unsuccessful.','当前任务未解决。'):
            self.assertFalse(note_fixture(text)['audit']['eligibleForTrial'],text)
        self.assertTrue(note_fixture('My selected route was successful.')['audit']['eligibleForTrial'])

    def test_quoted_hedged_and_unknown_explanation_are_not_false_truth_certificates(self):
        for text in ('I previously thought the task remains unsolved.', 'The phrase "The current task remains unsolved" may be mistaken.',
                'The source may suggest a lack of preparation.'):
            n=note_fixture(text);self.assertTrue(n['audit']['eligibleForTrial']);self.assertFalse(n['audit']['wholeProseTruthCertified'])

    def test_task_outcome_and_tool_binding_failure_are_distinct(self):
        event=event_fixture();event.pop('eventHash')
        event['decision']['selectedCandidate']=event['routes'][0]['selectedCandidate']
        event['selectedRouteRecordId']=event['routes'][0]['recordId'];event=core.seal(event,'eventHash')
        self.assertTrue(note_fixture('My selected route failed.',event=event)['audit']['eligibleForTrial'])
        self.assertTrue(note_fixture('The current task remains unsolved.',event=event)['audit']['eligibleForTrial'])

    def test_false_math_cap_and_registry_only_never_enter_trials(self):
        for text,cap in (('The correct result is 999*v.',False),('There are repeated terms.',True),('T1 T1',False)):
            n=note_fixture(text,capped=cap);self.assertFalse(n['audit']['eligibleForTrial']);core.validate_summary(n)

    def test_three_originals_share_event_writer_prompt_but_have_distinct_seeds_and_ids(self):
        notes=[note_fixture(index=i) for i in (1,2,3)];g=core.make_group(notes)
        self.assertEqual(len(set(g['candidateSummaryZipIds'])),3)
        self.assertTrue(all(n['studentOriginal']['studentPrompt']==notes[0]['studentOriginal']['studentPrompt'] for n in notes))
        notes[2]['studentOriginal']['studentOutput']['summaryStateHashDuringGeneration']='changed'
        with self.assertRaises(ValueError):core.make_group(notes)

    def test_best_bad_candidate_never_gets_positive_credit(self):
        notes=[note_fixture(index=i) for i in (1,2,3)]
        cr=core.group_credit(core.make_group(notes),notes,{n['id']:measurements(n,(-.01*i,-.02*i)) for i,n in enumerate(notes,1)})
        self.assertIsNone(cr['selectedSummaryZipId']);self.assertTrue(all(a<0 for a in cr['batchAdvantages']))

    def test_a_positive_mean_mixed_effect_can_win_without_claiming_universal_benefit(self):
        notes=[note_fixture(index=i) for i in (1,2,3)]
        cr=core.group_credit(core.make_group(notes),notes,{n['id']:measurements(n,ds) for n,ds in zip(notes,((.004,-.003),(-.03,-.02),(.0,.0)))})
        self.assertEqual(cr['selectedSummaryZipId'],notes[0]['id']);self.assertGreater(cr['batchAdvantages'][0],0)
        self.assertLess(cr['candidateCredits'][notes[0]['id']]['worstFullReuseGain'],0)

    def test_outcome_credit_cannot_be_created_by_score_or_references(self):
        notes=[note_fixture(index=i) for i in (1,2,3)]
        cr=core.group_credit(core.make_group(notes),notes,{n['id']:measurements(n,(0.,0.)) for n in notes})
        self.assertEqual(cr['batchAdvantages'],[0.,0.,0.]);self.assertIsNone(cr['selectedSummaryZipId'])

    def test_actual_contradiction_gets_only_its_own_negative_weight(self):
        notes=[note_fixture('The current task remains unsolved.',1),note_fixture(index=2),note_fixture(index=3)]
        cr=core.group_credit(core.make_group(notes),notes,{notes[0]['id']:[],notes[1]['id']:measurements(notes[1],(.04,.05)),notes[2]['id']:measurements(notes[2],(-.01,-.02))})
        self.assertEqual(cr['batchAdvantages'][0],core.STRUCTURE_PENALTY);self.assertGreater(cr['batchAdvantages'][1],0)
        self.assertLess(cr['batchAdvantages'][2],0);self.assertFalse(cr['usesHeldoutFeedback'])

    def test_known_false_prior_note_and_raw_self_scores_are_not_given_to_next_writer(self):
        notes=[note_fixture('The current task remains unsolved.',1),note_fixture(index=2),note_fixture(index=3)]
        credit=core.group_credit(core.make_group(notes),notes,{notes[0]['id']:[],notes[1]['id']:measurements(notes[1],(.03,.02)),notes[2]['id']:measurements(notes[2],(-.03,-.02))})
        history=core.history_evidence(notes,credit);self.assertEqual(len(history['candidateEvidence']),2)
        event=event_fixture();event['task']=dict(event['task'],id='new-current')
        # Test the literal prompt composition without inventing source linkage.
        event['priorTrialEvidence']=history;text=json.dumps(core.summary_messages(event))
        self.assertNotIn('Score:',text);self.assertNotIn('The current task remains unsolved.',text)
        self.assertIn('not this task',text);self.assertNotIn('self-blame',text)

    def test_group_window_and_heldout_admission_are_checked(self):
        note=note_fixture();rows=measurements(note,(.02,.03));rows[0]['rewardObjectSplit']='heldout'
        with self.assertRaises(ValueError):core.aggregate_credit(note,rows)
        with self.assertRaises(ValueError):core.aggregate_credit(note,rows[:1])


class CourseChecks(unittest.TestCase):
    def fixture_run(self,all_bad=False,invalid=False,all_failed=False,mixed=False,fail_at=None,deadline=None,rating_cap=False):
        rr=roots();full=make_plan(set(),rr);plan=dict(full,training=full['training'][:core.TRAINING_OBJECTS])
        initial={b:ChoiceHead([.3,-.2,.01,.01]).state() for b in core.BRANCHES}
        rows=[];saved=[];features=[];learns=[];notes={};checkpoints=[];steps=[]
        state={b:'writer-'+b+'-0' for b in core.BRANCHES};current=core.BRANCHES[0]
        def select(b):
            nonlocal current
            current=b
        def ask(phase,messages,seed,*,mode,sampled=False,**context):
            if fail_at is not None and len(rows)==fail_at:raise RuntimeError('offline fixture interruption')
            task=context['task'];text='The current expression has distinct terms.'
            if mode=='math':
                card=context['selectedCandidate'];right=task['expression']
                if not all_failed:
                    fn=_combine_options if card['kind']=='combine' else _distribution_options if card['kind']=='distribute' else None
                    options=list(fn(task['expression'],card['root'],False)) if fn else []
                    if options:right=options[0][0]
                text=task['expression']+' = '+right
            elif phase=='experience_summary':text='T1 T1' if invalid else 'A concrete detail in the current expression may help a later rewrite.'
            elif phase=='summary_quality_assessment':text='This is my assessment of the recorded note reuse. Score: 0.8.'
            elif context.get('summaryZipId'):text='The previous summary could apply to the current expression.'
            value=response(text,sampled,capped=rating_cap and phase=='summary_quality_assessment')
            value.update(summaryStateHashDuringGeneration=state[current],generationMode=mode,
                mathAdapterEnabledDuringGeneration=mode=='math',semanticAdapterEnabledDuringGeneration=False,
                summaryAdapterEnabledDuringGeneration=mode=='summary')
            row=dict(recordId='summary-call-'+str(len(rows)+1).zfill(3),phase=phase,studentPrompt=copy.deepcopy(messages),studentOutput=value,
                samplingSeed=seed,fixtureOnly=True,offlineFixtureFactory=True,**context);rows.append(row);return row
        def feature(task,row,cards):
            good=1 if task['family']=='same_factor' else 2;family=[2.,0.] if good==1 else [0.,2.]
            hidden=[[-.3,.6,*family] for _ in range(3)];hidden[good]=[.2,-.4,*family]
            if row.get('summaryZipId'):
                note=notes[row['summaryZipId']];idx=note['candidateIndex']
                harmful=all_bad or idx==3 or (mixed and task['family']=='product_of_sum')
                if harmful:hidden[good]=[-.7,.8,*family];hidden[3-good]=[.9,-1.,*family]
                elif idx==1:hidden[good]=[.9,-1.,*family]
                else:hidden[good]=[.35,-.55,*family]
            vec=normalized_features(hidden);identifier='summary-feature-'+str(len(features)+1).zfill(3)
            features.append(dict(id=identifier,task=copy.deepcopy(task),sourceObservationRecordId=row['recordId'],
                candidateCards=copy.deepcopy(cards),candidatePrompts=[feature_messages(task,row['studentOutput'],c) for c in cards],
                candidateHiddenVectors=hidden,normalizedFeatures=vec,mathematicalAdapterEnabled=False,
                semanticAdapterEnabled=False,summaryAdapterEnabled=False))
            return vec,identifier
        def save(kind,row):saved.append((kind,copy.deepcopy(row)))
        def learn(ns,cr,reason):
            self.assertEqual(reason,'candidate_group_feedback');self.assertEqual(cr['branch'],current)
            self.assertTrue(all(n['studentOriginal']['studentOutput']['summaryStateHashDuringGeneration']==state[current] for n in ns))
            learns.append(copy.deepcopy(cr));change=any(abs(a)>1e-12 for a in cr['batchAdvantages']);before=state[current]
            if change:
                state[current]=before+'x'
                policy=dict(updated=True,parameterChanged=True,advantages=cr['batchAdvantages'],constantTokenDenominator=288,
                    sampledLogProbabilities=[n['studentOriginal']['studentOutput']['samplingLogProbability'] for n in ns],
                    replayLogProbabilities=[n['studentOriginal']['studentOutput']['samplingLogProbability'] for n in ns],allSampledTokensReplayed=True)
                steps.append(dict(id='fixture-step-'+str(len(steps)+1),sourceGroupId=cr['groupId'],branch=current,credit=copy.deepcopy(cr),
                    sourceSummaryZipIds=[n['id'] for n in ns],sourceWordRecordIds=[n['sourceRecordId'] for n in ns],
                    beforeHash=before,afterHash=state[current],policyUpdate=policy))
            return dict(updated=change,parameterChanged=change,beforeHash=before,afterHash=state[current],credit=copy.deepcopy(cr),
                sourceGroupId=cr['groupId'],reason=reason)
        def store(note):notes[note['id']]=copy.deepcopy(note)
        def load(identifier):return copy.deepcopy(notes[identifier])
        def checkpoint(label,heads,banks,gates):
            checkpoints.append(dict(label=label,heads=copy.deepcopy(heads),banks=copy.deepcopy(banks),contextGates=copy.deepcopy(gates),
                contextGateHashes={b:gates[b]['gateHash'] if gates[b] else None for b in core.BRANCHES},
                summaryStates={b:dict(stateHash=state[b]) for b in core.BRANCHES}))
        try:
            course=core.run_course(plan,rr,initial,ask,feature,save,learn,select,store,load,checkpoint,
                time.monotonic()+60 if deadline is None else deadline,1)
        except Exception as exc:return dict(error=exc,rows=rows,saved=saved,learns=learns,notes=notes,features=features,checkpoints=checkpoints,plan=plan)
        return dict(course=course,rows=rows,saved=saved,learns=learns,notes=notes,features=features,checkpoints=checkpoints,plan=plan,steps=steps)

    def test_complete_grouped_course_uses_bounded_calls_and_actual_unique_originals(self):
        out=self.fixture_run();self.assertNotIn('error',out,repr(out.get('error')))
        c=out['course'];self.assertEqual(len(c['summaries']),12);self.assertEqual(len(c['groups']),4);self.assertEqual(len(out['learns']),4)
        self.assertLessEqual(len(out['rows'])+8,core.MAX_GENERATIONS);self.assertLessEqual(len(out['features']),core.MAX_FEATURE_BATCHES)
        self.assertEqual(sum(r['phase']=='route_math' for r in out['rows']),30)
        self.assertTrue(any(g['selectedSummaryZipId'] for g in c['groupResults']))
        for g in c['groups']:
            ns=[out['notes'][i] for i in g['candidateSummaryZipIds']]
            self.assertEqual(len({n['studentOriginal']['samplingSeed'] for n in ns}),3)
            self.assertEqual(len({n['studentOriginal']['studentOutput']['summaryStateHashDuringGeneration'] for n in ns}),1)

    def test_bad_candidates_never_poison_operative_replay(self):
        out=self.fixture_run(all_bad=True);self.assertNotIn('error',out,repr(out.get('error')))
        self.assertTrue(all(g['selectedSummaryZipId'] is None for g in out['course']['groupResults']))
        self.assertTrue(all(c is None for c in out['course']['finalBanks'].values()))
        for o in out['course']['objects']:
            if o['phase']=='training':self.assertEqual(o['featureIdsByArm'][core.BRANCHES[0]],o['featureIdsByArm'][core.BRANCHES[1]])
        self.assertTrue(all(a<=0 for cr in out['learns'] for a in cr['batchAdvantages']))

    def test_all_failed_routes_no_positive_word_reward_or_head_update(self):
        out=self.fixture_run(all_failed=True);self.assertNotIn('error',out)
        self.assertTrue(all(c['batchAdvantages']==[0.,0.,0.] for c in out['learns']))
        self.assertFalse(out['steps']);self.assertTrue(all(not u['headUpdate']['updated'] for u in out['course']['updates']))

    def test_changed_head_guard_does_not_abort_or_activate_a_stale_positive_winner(self):
        fit=core.fit_context_gate
        def blocked(note,cases,head):
            g=fit(note,cases,head);g.pop('gateHash');g['admitted']=False;g['trainingMeanGain']=-.01
            return core.seal(g,'gateHash')
        with patch('zip_summary_training_v5_core.fit_context_gate',side_effect=blocked):out=self.fixture_run()
        self.assertNotIn('error',out,repr(out.get('error')))
        self.assertTrue(any(g['selectedSummaryZipId'] for g in out['course']['groupResults']))
        self.assertTrue(all(g['activatedSummaryZipId'] is None for g in out['course']['groupResults']))
        self.assertTrue(all(v is None for v in out['course']['finalBanks'].values()))

    def test_three_invalid_originals_get_one_batch_penalty_without_retries(self):
        out=self.fixture_run(invalid=True);self.assertNotIn('error',out,repr(out.get('error')))
        self.assertEqual(len(out['course']['summaries']),12);self.assertEqual(len(out['learns']),4)
        self.assertTrue(all(c['batchAdvantages']==[-.2,-.2,-.2] for c in out['learns']))
        self.assertEqual(sum(r['phase']=='training_observation_with_summary' for r in out['rows']),0)
        self.assertEqual(len(out['course']['ratings']),0)

    def test_operative_context_begins_after_full_two_task_window(self):
        out=self.fixture_run();self.assertNotIn('error',out)
        rows=out['course']['objects'][:3]
        self.assertTrue(all(o['sourceSummaryIdsByArm'][core.BRANCHES[0]] is None for o in rows))
        self.assertEqual(out['course']['groupResults'][0]['firstEligibleOperativeObjectNumber'],4)
        self.assertTrue(all(o['sourceSummaryIdsByArm'][core.BRANCHES[1]] is None for o in out['course']['objects'] if o['phase']=='training'))

    def test_all_choices_and_trial_observations_precede_each_actual_math_route(self):
        out=self.fixture_run();self.assertNotIn('error',out)
        for task in out['plan']['training']+out['plan']['heldout']:
            relevant=[(i,k,r) for i,(k,r) in enumerate(out['saved']) if r.get('taskId')==task['id'] or r.get('task',{}).get('id')==task['id']]
            math=min(i for i,k,r in relevant if k=='scored' and r.get('phase')=='route_math')
            self.assertTrue(all(i<math for i,k,r in relevant if k=='decision'))

    def test_current_family_string_cannot_change_fitted_context_decision(self):
        out=self.fixture_run();self.assertNotIn('error',out)
        gate=next(g for g in out['course']['finalGates'].values() if g)
        positive=next(e for e in gate['evidence'] if e['signedGain']>0)
        task=copy.deepcopy(positive['case']['task']);vec=positive['case']['without']
        first=core.context_decision(task,vec,gate);task['family']='invented-host-label'
        self.assertEqual(core.context_decision(task,vec,gate),first);self.assertIsNotNone(first['selectedSummaryZipId'])
        self.assertFalse(first['currentOutcomeRead']);self.assertFalse(first['studentAutonomousRetrieval'])

    def test_quality_assessments_happen_after_actual_tests_and_never_gate_learning(self):
        out=self.fixture_run(rating_cap=True);self.assertNotIn('error',out)
        self.assertEqual(len(out['learns']),4);self.assertEqual(len(out['course']['ratings']),4)
        self.assertTrue(all(r['studentQualityScore'] is None for r in out['course']['ratings']))
        self.assertTrue(all(r['retrospectiveAssessment'] and not r['ratingUsedAsReward'] and not r['forecastCalibrationPerformed'] for r in out['course']['ratings']))
        self.assertTrue(all('Score:' not in json.dumps(n['studentOriginal']['studentPrompt']) for n in out['course']['summaries']))

    def test_frozen_heldout_preserves_heads_writers_banks_and_gates(self):
        out=self.fixture_run();self.assertNotIn('error',out)
        before=next(c for c in out['checkpoints'] if c['label']=='training-final');after=out['checkpoints'][-1]
        self.assertEqual({k:v for k,v in before.items() if k!='label'},{k:v for k,v in after.items() if k!='label'})
        self.assertTrue(all(n['event']['task']['split']=='training' for n in out['course']['summaries']))

    def test_partial_generation_retains_originals_without_fabricating_group(self):
        out=self.fixture_run(fail_at=6);self.assertIsInstance(out['error'],RuntimeError)
        self.assertEqual(len(out['notes']),2);self.assertFalse(out['learns']);self.assertFalse(any(k=='summary-group' for k,r in out['saved']))

    def test_deadline_before_first_action_has_no_call_or_update(self):
        out=self.fixture_run(deadline=time.monotonic()-1)
        self.assertIsInstance(out['error'],TimeoutError);self.assertFalse(out['rows']);self.assertFalse(out['learns'])

    def write_replay_fixture(self,folder):
        out=self.fixture_run();self.assertNotIn('error',out,repr(out.get('error')))
        def put(relative,row):
            p=folder/relative;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(row,ensure_ascii=False))
        put('zip-summary-questions.json',out['plan']);put('roots.json',roots())
        for r in out['rows']:put('responses/'+r['recordId']+'-raw.json',r)
        for k,r in out['saved']:
            put('responses/'+r['recordId']+'-scored.json' if k=='scored' else k+'/'+r['id']+'.json',r)
        for cp in out['checkpoints']:put('checkpoints/'+cp['label']+'.json',cp)
        trials=[r for k,r in out['saved'] if k=='trial'];c=out['course']
        report=core.summarize(c['objects'],trials,c['summaries'],c['updates'],c['groupResults'],c['ratings'],c['references'],c['retentionReviews'])
        result=dict(trainingRound=1,summary=report,fixtureOnly=True,offlineFixtureFactory=True)
        return out,result

    def test_saved_algorithm_replays_all_group_credit_context_and_report_without_models(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp);out,result=self.write_replay_fixture(p)
            course=replay_saved_course(p,result,out['notes'],out['checkpoints'][0],out['checkpoints'][-1],
                {f['id']:f for f in out['features']},{r['recordId']:r for r in out['rows']},out['steps'])
            self.assertEqual(course['finalBanks'],out['course']['finalBanks'])

    def test_rehashed_changed_group_credit_still_fails_algorithm_replay(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp);out,result=self.write_replay_fixture(p)
            path=next((p/'group-result').glob('*.json'));row=json.loads(path.read_text());row['batchAdvantages'][0]+=.1;path.write_text(json.dumps(row))
            with self.assertRaises(ValueError):replay_saved_course(p,result,out['notes'],out['checkpoints'][0],out['checkpoints'][-1],
                {f['id']:f for f in out['features']},{r['recordId']:r for r in out['rows']},out['steps'])

    def test_native_zip_reads_preserve_whole_original_and_detect_tampering(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp);n=note_fixture();h=runtime.write_summary_zip(p,n);hs={n['id']:h}
            self.assertEqual(runtime.read_summary_zip(p,n['id'],hs),n)
            path=p/(n['id']+'.zip');path.write_bytes(path.read_bytes()+b'changed')
            with self.assertRaises(ValueError):runtime.read_summary_zip(p,n['id'],hs)


class RuntimeChecks(unittest.TestCase):
    def test_v4_checkpoint_states_and_old_score_are_preserved_at_new_boundary(self):
        from test_zip_summary_training_v4 import note_fixture as old_note_fixture
        note=old_note_fixture('The current task remains unsolved.');before=copy.deepcopy(note)
        heads={b:ChoiceHead([.3,-.2]).state() for b in core.BRANCHES}
        previous=dict(initialHeads=heads,initialBanks={core.BRANCHES[0]:note['id'],core.BRANCHES[1]:None},
            inherited={note['id']:note},inheritedContextReviews={},summaryStateHashes={b:'prior-writer-'+b for b in core.BRANCHES})
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp);(p/'result.json').write_text(json.dumps(dict(protocol='lain-zip-experience-summary-training-v4',fixtureOnly=False,
                fixtureGenerations=0,teacherCalls=0,dispatcherUnitTestHeader=True)))
            with patch('zip_summary_training_v5_inspect.inspect_v4_source',return_value=previous):resumed=runtime.inspect_training_source(p)
        self.assertEqual(resumed['initialHeads'],heads);self.assertEqual(resumed['summaryStateHashes'],previous['summaryStateHashes'])
        self.assertEqual(resumed['initialBanks'],{b:None for b in core.BRANCHES});self.assertEqual(resumed['inherited'][note['id']],before)

    def test_mixed_benefit_gate_admits_positive_context_and_abstains_on_negative_context(self):
        note=note_fixture();head=ChoiceHead([1.,0.]);cases=[]
        for i in (1,2):
            sign=1. if i==1 else -1.
            base=[[0.,sign],[0.,sign],[0.,sign]];base[i]=[.2,sign*math.sqrt(.96)]
            with_note=copy.deepcopy(base);x=1. if i==1 else .1;with_note[i]=[x,sign*math.sqrt(1-x*x)]
            outcomes=[0,0,0];outcomes[i]=1
            cases.append(dict(task=dict(id='gate-task-'+str(i),split='training',family='unused'),without=base,withSummary=with_note,
                outcomes=outcomes,featureIds=dict(without='p'+str(i),withSummary='n'+str(i)),sourceMathRecordIds=['r1','r2','r3']))
        gate=core.fit_context_gate(note,cases,head);self.assertTrue(gate['admitted'])
        positive=core.context_decision(cases[0]['task'],cases[0]['without'],gate)
        negative=core.context_decision(cases[1]['task'],cases[1]['without'],gate)
        self.assertEqual(positive['selectedSummaryZipId'],note['id']);self.assertIsNone(negative['selectedSummaryZipId'])
        self.assertFalse(negative['currentOutcomeRead']);self.assertFalse(negative['manualTaskFamilyUsed'])

    def test_new_namespace_reserves_old_and_partial_v5_rounds(self):
        from zip_summary_training_v4_core import seed_for as previous_seed
        self.assertGreater(core.seed_for(1,0,0),previous_seed(1000,20,99))
        with tempfile.TemporaryDirectory() as temp:
            for version in range(1,6):
                p=Path(temp)/('zip-summary-training-fixture-'+str(version));p.mkdir()
                (p/'protocol.json').write_text(json.dumps(dict(protocol='lain-zip-experience-summary-training-v'+str(version),trainingRound=version)))
            self.assertEqual(runtime.next_number(temp),6)

    def test_fixture_source_rejected_before_model_or_output(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp);(p/'result.json').write_text(json.dumps(dict(fixtureOnly=True)))
            with self.assertRaisesRegex(ValueError,'Fixture'):runtime.inspect_training_source(p)

    def test_preflight_checks_all_shapes_before_model_and_rejects_overflow(self):
        class Tokenizer:
            model_max_length=8192
            def apply_chat_template(self,messages,*,tokenize,add_generation_prompt):return json.dumps(messages)
            def __call__(self,text,*,add_special_tokens,truncation):return dict(input_ids=[1]*(4097 if overflow[0] else len(text.split())))
        module=ModuleType('transformers');module.AutoTokenizer=Mock();module.AutoTokenizer.from_pretrained.return_value=Tokenizer()
        overflow=[False];rr=roots();plan=make_plan(set(),rr);plan['training']=plan['training'][:core.TRAINING_OBJECTS]
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp);(p/'config.json').write_text(json.dumps(dict(max_position_embeddings=8192)))
            with patch.dict(sys.modules,{'transformers':module}):
                _,_,report=runtime.prepare_inputs(p,plan,rr);self.assertEqual(len(report['rows']),92)
                overflow[0]=True
                with self.assertRaises(ValueError):runtime.prepare_inputs(p,plan,rr)

    def test_numeric_allowance_does_not_allow_changed_text_boolean_or_material_reward(self):
        self.assertTrue(bounded_saved_equal({'x':.3},{'x':.3+1e-15}))
        for a,b in (({'x':.3},{'x':.30001}),({'x':True},{'x':1}),({'raw':'a'},{'raw':'b'})):
            self.assertFalse(bounded_saved_equal(a,b))


if __name__=='__main__':unittest.main()
