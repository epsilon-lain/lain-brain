"""Offline checks only; fixtures never become real training evidence."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
import zipfile
from types import ModuleType

from choice_continue_core import make_plan
from object_choice_core import ChoiceHead
from tool_loop_kernel import _combine_options, _distribution_options
from zip_content_core import digest
from zip_label_feedback_audit import audit_math
from zip_summary_training_core import (BRANCHES, EVALUATION_ARMS, TRAINING_OBJECTS,
    MAX_GENERATIONS, SUMMARIES_PER_BRANCH, seed_for, candidate_cards, event_record,
    summary_messages, make_summary, validate_summary, summary_credit, run_course, summarize)
from zip_summary_training_run import (write_summary_zip, read_summary_zip, inspect_training_source,
    next_number, prepare_inputs, state_unchanged)


def roots():
    values=[]
    for identifier,input_text,output_text in (('root-combine','1*x + 2*x','3*x'),
            ('root-distribute','c*(a+b)','c*a+c*b')):
        rule=dict(input=input_text,output=output_text,operation='rewrite',scope='real_polynomial',variable='')
        values.append(dict(id=identifier,rule=rule,version=digest(rule)))
    return values


def response(raw, sampled=True, capped=False):
    return dict(raw=raw,generatedIds=[1,68],generatedTokens=2,promptIds=[4,5],
        samplingTokenLogProbabilities=[-.1,-.2],samplingLogProbability=-.3,sampled=sampled,temperature=.8,
        tokenCapReached=capped,stopReason='token_cap' if capped else 'eos',testDouble=True,
        originalTextRepaired=False)


def fixture_event():
    rr=roots(); task=make_plan(set(),rr)['training'][0]
    obs=dict(recordId='fixture-obs',studentOutput=response('There are two summands.'),task=task)
    routes=[]
    for i,card in enumerate(candidate_cards(rr),1):
        value=response(task['expression']+' = '+task['expression'],False)
        row=dict(recordId='fixture-math-'+str(i),studentOutput=value,task=task,selectedCandidate=card)
        row['check']=audit_math(task,value,card);routes.append(row)
    decision=dict(selectedCandidate=candidate_cards(rr)[1],task=task,sourceKeywordRecordId=obs['recordId'])
    return event_record(task,obs,decision,routes)


def fixture_note(raw='The two terms have a common inner expression, which may help recall a stored rewrite.', **options):
    event=fixture_event()
    row=dict(recordId='fixture-summary',phase='experience_summary',branch=BRANCHES[0],task=event['task'],
        studentPrompt=summary_messages(event),studentOutput=response(raw,**options),fixtureOnly=True,eventHash=event['eventHash'])
    return make_summary(row,event,BRANCHES[0])


class TokenizerOnlyPreflightChecks(unittest.TestCase):
    def run_preflight(self, oversized=False):
        class Tokenizer:
            model_max_length=8192
            def apply_chat_template(inner, messages, *, tokenize, add_generation_prompt):
                self.assertFalse(tokenize);self.assertTrue(add_generation_prompt)
                return json.dumps(messages)
            def __call__(inner, text, *, add_special_tokens, truncation):
                self.assertFalse(add_special_tokens);self.assertFalse(truncation)
                return dict(input_ids=[1]*(4097 if oversized else len(text.split())))
        tokenizer=Tokenizer();module=ModuleType('transformers')
        module.AutoTokenizer=Mock();module.AutoTokenizer.from_pretrained.return_value=tokenizer
        rr=roots();full=make_plan(set(),rr)
        plan=dict(full,training=full['training'][:TRAINING_OBJECTS])
        with tempfile.TemporaryDirectory() as temp:
            student=Path(temp);(student/'config.json').write_text(json.dumps(dict(max_position_embeddings=8192)))
            with patch.dict(sys.modules,{'transformers':module}):
                result=prepare_inputs(student,plan,rr)
            module.AutoTokenizer.from_pretrained.assert_called_once_with(student,local_files_only=True)
        return result,plan

    def test_actual_preflight_constructs_every_math_observation_feature_and_summary_input(self):
        (tokenizer,limits,report),plan=self.run_preflight()
        self.assertTrue(report['tokenizerOnly']);self.assertFalse(report['modelWeightsLoaded'])
        self.assertTrue(report['allShapesFit'])
        counts={kind:sum(row['kind']==kind for row in report['rows'])
            for kind in ('observation','feature','math','summary')}
        self.assertEqual(counts,dict(observation=20,feature=30,math=30,summary=6))
        from object_choice_core import math_messages
        math_rows=[row for row in report['rows'] if row['kind']=='math']
        expected=[(task['id'],digest(math_messages(task,card,roots())))
            for task in plan['training']+plan['heldout'] for card in candidate_cards(roots())]
        self.assertEqual([(row['taskId'],row['audit']['messageHash']) for row in math_rows],expected)
        self.assertTrue(all(row['audit']['noSilentTruncation'] and
            row['audit']['inputTokens']+row['planningReserve']<=limits['maxInputTokens'] for row in report['rows']))

    def test_actual_preflight_rejects_overflow_before_any_weight_loader(self):
        with self.assertRaisesRegex(ValueError,'Input token budget'):
            self.run_preflight(oversized=True)

    def test_state_comparison_reports_unobserved_as_unknown_and_observed_changes_as_false(self):
        for before,after in ((None,None),(None,'hash'),('hash',None)):
            self.assertIsNone(state_unchanged(before,after))
        self.assertIs(state_unchanged('original','original'),True)
        self.assertIs(state_unchanged('original','changed'),False)


class SummaryAdmissionChecks(unittest.TestCase):
    def test_unknown_prose_gets_measured_gain_without_a_math_proof_or_number_copy(self):
        note=fixture_note();self.assertTrue(note['audit']['eligibleForTrial'])
        later=dict(note['event']['task'],id='later',split='training')
        credit=summary_credit(note,later,.2,.35,dict(without='f1',withSummary='f2'))
        self.assertAlmostEqual(credit['advantage'],.3)
        self.assertFalse(credit['proseTruthCertified'])
        self.assertFalse(note['audit']['wholeProseTruthCertified'])

    def test_negative_effect_is_negative_credit_despite_readable_true_prose(self):
        note=fixture_note();later=dict(note['event']['task'],id='later',split='training')
        self.assertAlmostEqual(summary_credit(note,later,.4,.25,{})['advantage'],-.3)

    def test_same_object_and_heldout_cannot_reward_a_summary(self):
        note=fixture_note()
        for task in (note['event']['task'],dict(note['event']['task'],id='held',split='heldout')):
            with self.assertRaises(ValueError):summary_credit(note,task,.1,.9,{})

    def test_actual_caps_empty_and_address_only_outputs_do_not_enter_reuse(self):
        for note in (fixture_note(capped=True),fixture_note(''),fixture_note('T1 T1')):
            self.assertFalse(note['audit']['eligibleForTrial'])
            self.assertFalse(note['audit']['originalTextRepaired'])

    def test_known_false_identity_is_blocked_but_exact_source_quote_remains_a_quote(self):
        self.assertFalse(fixture_note('My conclusion: 1*x + 2*x = 4*x')['audit']['eligibleForTrial'])
        event=fixture_event();bad=event['routes'][0]
        bad['studentOutput']=response('1*x + 2*x = 4*x',False)
        bad['check']=audit_math(event['task'],bad['studentOutput'],bad['selectedCandidate'])
        event=event_record(event['task'],event['observation'],event['decision'],event['routes'])
        row=dict(recordId='quote-summary',phase='experience_summary',branch=BRANCHES[0],task=event['task'],
            studentPrompt=summary_messages(event),eventHash=event['eventHash'],
            studentOutput=response('The actual attempt `1*x + 2*x = 4*x` failed; the explanation needs checking.'))
        note=make_summary(row,event,BRANCHES[0]);self.assertTrue(note['audit']['eligibleForTrial'])
        self.assertTrue(note['audit']['exactSourceQuotedRejectedIdentityIndices'])

    def test_native_zip_read_keeps_whole_original_and_detects_rehashed_root_tampering(self):
        note=fixture_note()
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);hashes={note['id']:write_summary_zip(folder,note)}
            self.assertEqual(read_summary_zip(folder,note['id'],hashes),note)
            path=folder/(note['id']+'.zip')
            with zipfile.ZipFile(path) as z:entries={name:z.read(name) for name in z.namelist()}
            bad=json.loads(entries['root.json']);bad['studentRaw']='host replacement';bad['summaryHash']=digest({k:v for k,v in bad.items() if k!='summaryHash'})
            entries['root.json']=json.dumps(bad).encode()
            with zipfile.ZipFile(path,'w') as z:
                for name,value in entries.items():z.writestr(name,value)
            from draft_inspect_runtime import sha
            hashes[note['id']]=sha(path)
            with self.assertRaises(ValueError):read_summary_zip(folder,note['id'],hashes)

    def test_source_binding_changed_then_rehashed_still_fails(self):
        note=fixture_note();note['sourceTaskId']='different'
        note['summaryHash']=digest({k:v for k,v in note.items() if k!='summaryHash'})
        with self.assertRaises(ValueError):validate_summary(note)

    def test_partial_runs_reserve_rounds_and_namespace_is_fresh(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);run=folder/'zip-summary-training-partial';run.mkdir()
            from zip_summary_training_core import PROTOCOL
            (run/'protocol.json').write_text(json.dumps(dict(protocol=PROTOCOL,trainingRound=3)))
            self.assertEqual(next_number(folder),4)
        self.assertNotEqual(seed_for(1,1,1),seed_for(2,1,1))
        self.assertGreaterEqual(seed_for(1,1,1),4_100_000_000)

    def test_fixture_source_rejected_before_torch_import_or_output_creation(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);(folder/'result.json').write_text(json.dumps(dict(fixtureOnly=True)))
            with self.assertRaises(ValueError):inspect_training_source(folder)
            code=('import sys; from pathlib import Path; from zip_summary_training_run import inspect_training_source; '
                '\ntry: inspect_training_source(Path(sys.argv[1]))\nexcept ValueError: pass\nelse: raise AssertionError("fixture accepted")'
                '\nassert "torch" not in sys.modules and "transformers" not in sys.modules')
            completed=subprocess.run([sys.executable,'-B','-c',code,str(folder)],capture_output=True,text=True)
            self.assertEqual(completed.returncode,0,completed.stderr)
            self.assertEqual({p.name for p in folder.iterdir()},{'result.json'})


class SummaryLoopChecks(unittest.TestCase):
    def fixture_run(self,all_failed=False,invalid=False,deadline=None,fail_generation=None):
        rr=roots();full=make_plan(set(),rr);plan=dict(full,training=full['training'][:TRAINING_OBJECTS])
        head=ChoiceHead([.3,-.2]).state();heads={b:copy.deepcopy(head) for b in BRANCHES}
        rows=[];saved=[];learns=[];zips={};checkpoints=[];state={b:0 for b in BRANCHES};current=BRANCHES[0]
        def select(branch):
            nonlocal current
            current=branch
        def ask(phase,messages,seed,*,mode,sampled=False,**context):
            if fail_generation is not None and len(rows)==fail_generation:raise RuntimeError('injected generator failure')
            task=context['task'];text='There are visible arithmetic operations to examine.'
            if mode=='math':
                card=context['selectedCandidate'];right=task['expression']
                if not all_failed:
                    fn=_combine_options if card['kind']=='combine' else _distribution_options if card['kind']=='distribute' else None
                    options=list(fn(task['expression'],card['root'],False)) if fn else []
                    if options:right=options[0][0]
                text=task['expression']+' = '+right
            elif mode=='summary':text='T1 T1' if invalid else 'The attempt suggests retaining the expression structure when recalling a stored rewrite.'
            output=response(text,sampled);output['summaryStateHashDuringGeneration']=str(state[current])
            row=dict(recordId='fixture-call-'+str(len(rows)+1),phase=phase,studentPrompt=messages,
                studentOutput=output,samplingSeed=seed,fixtureOnly=True,**context)
            rows.append(row);return row
        def feature(task,row,cards):
            noted='sourceSummaryZipId' in cards[0]
            # The expression-specific distinction comes from this offline fixture only.
            good=1 if task['family']=='same_factor' else 2
            vecs=[[0.,0.],[0.,0.],[0.,0.]]
            vecs[good]=[1. if noted else .4, .2]
            return vecs,'fixture-feature-'+str(len(saved))
        def save(kind,row):saved.append((kind,copy.deepcopy(row)))
        def learn(note,credit,reason):
            self.assertEqual(note['studentOriginal']['studentOutput']['summaryStateHashDuringGeneration'],str(state[current]))
            self.assertEqual(credit['rewardObjectSplit'],'training');learns.append((current,copy.deepcopy(credit),reason))
            changed=abs(credit['advantage'])>1e-12
            state[current]+=int(changed)
            return dict(updated=changed,parameterChanged=changed)
        def store(note):zips[note['id']]=copy.deepcopy(note)
        def read_note(identifier):return copy.deepcopy(zips[identifier])
        def checkpoint(label,heads,banks):checkpoints.append((label,copy.deepcopy(heads),copy.deepcopy(banks),copy.deepcopy(state)))
        try:
            result=run_course(plan,rr,heads,ask,feature,save,learn,select,store,read_note,checkpoint,
                time.monotonic()+30 if deadline is None else deadline,1)
        except Exception as exc:
            return dict(error=exc,rows=rows,saved=saved,learns=learns,checkpoints=checkpoints,zips=zips)
        return dict(result=result,rows=rows,saved=saved,learns=learns,checkpoints=checkpoints,zips=zips)

    def test_complete_real_flow_shapes_delays_rewards_and_freezes_all_four_heldout_arms(self):
        output=self.fixture_run();self.assertTrue('error' not in output,repr(output.get('error')))
        rows=output['rows'];result=output['result'];saved=output['saved']
        self.assertEqual(len(rows),MAX_GENERATIONS-8)
        self.assertEqual(len(result['summaries']),2*SUMMARIES_PER_BRANCH)
        self.assertEqual(len(result['objects']),10)
        self.assertEqual(len(output['learns']),10)
        for branch,credit,reason in output['learns']:
            self.assertNotEqual(credit['sourceTaskId'],credit['rewardTaskId'])
            self.assertEqual(reason,'later_training_object')
            self.assertTrue(credit['conditionalOnSameObservation'])
        for row in rows:
            if row['phase']=='training_observation' and row['branch']==BRANCHES[1]:
                self.assertNotIn('unverified hypothesis',row['studentPrompt'][-1]['content'])
                self.assertIsNone(row['summaryZipId'])
        held=[o for o in result['objects'] if o['phase']=='heldout']
        self.assertEqual(len(held),4)
        self.assertTrue(all(set(o['expectedPassByArm'])==set(EVALUATION_ARMS) and o['trainingUpdates']==0 for o in held))
        before=next(c for c in output['checkpoints'] if c[0]=='training-final')
        after=output['checkpoints'][-1];self.assertEqual(before[1:],after[1:])
        # Every object's decisions are persisted before its first mathematical response.
        for obj in result['objects']:
            ids=obj['sourceMathRecordIds']
            positions=[i for i,(k,r) in enumerate(saved) if k=='decision' and r['task']['id']==obj['id']]
            first=min(i for i,(k,r) in enumerate(saved) if k=='scored' and r.get('recordId') in ids)
            self.assertTrue(all(p<first for p in positions))

    def test_all_failed_routes_produce_zero_probability_and_zero_usefulness_reward(self):
        output=self.fixture_run(all_failed=True);self.assertTrue('error' not in output,repr(output.get('error')))
        self.assertTrue(all(all(v==0 for v in o['expectedPassByArm'].values()) for o in output['result']['objects']))
        self.assertTrue(all(c['advantage']==0 for b,c,r in output['learns']))
        self.assertTrue(all(not u['headUpdate']['updated'] for u in output['result']['updates']))

    def test_invalid_notes_do_not_skip_later_tasks_and_receive_only_separate_negative_feedback(self):
        output=self.fixture_run(invalid=True);self.assertTrue('error' not in output,repr(output.get('error')))
        self.assertEqual(len(output['result']['objects']),10)
        self.assertTrue(all(n is None for n in output['result']['finalBanks'].values()))
        self.assertEqual(len(output['learns']),10)
        self.assertTrue(all(c['advantage']<0 and r=='original_rejection_penalty' for b,c,r in output['learns']))

    def test_deadline_does_not_generate_or_train(self):
        output=self.fixture_run(deadline=time.monotonic()-1)
        self.assertIsInstance(output['error'],TimeoutError)
        self.assertFalse(output['rows']);self.assertFalse(output['learns'])

    def test_generation_failure_preserves_previous_objects_without_counting_partial_next_object(self):
        output=self.fixture_run(fail_generation=12)
        self.assertIsInstance(output['error'],RuntimeError)
        self.assertEqual(len(output['rows']),12)
        objects=[r for k,r in output['saved'] if k=='object']
        self.assertLess(len(objects),10)
        self.assertFalse(any(o['phase']=='heldout' for o in objects))

    def test_fresh_semantic_reward_summary_reports_actual_steps_separately_from_opportunities(self):
        output=self.fixture_run();result=output['result'];saved=output['saved']
        report=summarize(result['objects'],[r for k,r in saved if k=='trial'],result['summaries'],result['updates'],[r for k,r in saved if k=='penalty'])
        self.assertEqual(report['heldoutObjects'],4)
        self.assertTrue(report['sealedSummariesUsedByConditionalTrainingCritic'])
        self.assertFalse(report['sealedSummariesSuppliedToOrdinaryTaskWriter'])
        self.assertFalse(report['positiveCreditRequiresMathematicalProofOfProse'])
        self.assertFalse(report['statisticalSignificanceClaimed'])


if __name__=='__main__':unittest.main()
