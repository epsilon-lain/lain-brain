"""Offline regression and orchestration simulations; never real student training."""
import copy
import json
import math
from pathlib import Path
import sys
import tempfile
import time
import unittest
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

from object_choice_core import ChoiceHead
from choice_continue_core import make_plan
from zip_label_feedback_audit import _combine_options, _distribution_options
from object_choice_core import normalized_features
from zip_label_grounded_checks import feature_messages
from test_zip_summary_training_v2 import roots, response
import test_zip_summary_training_v5 as previous
import test_zip_self_question_tools as old_policy_tests
import zip_summary_training_v6_core as core
import zip_summary_training_v6_run as runtime
import zip_summary_training_v6_policy as policy
import zip_summary_training_v6_series as series
from zip_summary_training_v6_audit import audit_summary, inline_equalities, presentation_view
from zip_summary_training_v6_inspect import replay_saved_course


def note_fixture(text='A shared inner expression appeared in both terms.', index=1, event=None, capped=False):
    with patch.object(previous,'core',core):
        return previous.note_fixture(text,index,event,capped)


def execute_word_fixture(responses,advantages,denominator=None,drift=0.,frozen_base_gradient=False,updater=None):
    """Exact scalar autodiff through the production updater and optimizer call.

    This is deliberately a tiny test double, never a student/model experiment.
    It exercises the updater guard, replay, loss, backward, clipping and step.
    """
    state=dict(weight=1.,gradient=None,steps=0)
    class Scalar:
        def __init__(self,value,gradient=0.):self.value=value;self.gradient=gradient
        def __add__(self,other):
            other=other if isinstance(other,Scalar) else Scalar(other)
            return Scalar(self.value+other.value,self.gradient+other.gradient)
        __radd__=__add__
        def __mul__(self,value):return Scalar(self.value*value,self.gradient*value)
        __rmul__=__mul__
        def __neg__(self):return self*-1
        def __truediv__(self,value):return self*(1/value)
        def detach(self):return self.value
        def __float__(self):return self.value
        def backward(self):state['gradient']=self.gradient
    torch=ModuleType('torch');torch.isfinite=lambda x:math.isfinite(float(x))
    torch.nn=SimpleNamespace(utils=SimpleNamespace(clip_grad_norm_=lambda *a,**kw:abs(state['gradient'])))
    replay=ModuleType('zip_generation_policy')
    positions={id(r):i+1 for i,r in enumerate(responses)}
    replay.response_log_probability=lambda base,r:Scalar(r['samplingLogProbability']+drift,float(positions[id(r)]))
    adapter=SimpleNamespace(digest=lambda:core.digest(state['weight']),parameters_to_train=lambda:[])
    def step():state['weight']-=.001*state['gradient'];state['steps']+=1
    optimizer=SimpleNamespace(zero_grad=lambda **kw:state.update(gradient=None),step=step)
    base=SimpleNamespace(parameters=lambda:[SimpleNamespace(grad=1. if frozen_base_gradient else None)])
    with patch.dict(sys.modules,{'torch':torch,'zip_generation_policy':replay}):
        result=(updater or runtime.update_words)(base,adapter,optimizer,responses,advantages,
            len(responses)*128 if denominator is None else denominator)
    return result,state


def word_response_fixture(count):
    logs=[-.01]*count
    return dict(raw='fixture note',generatedTokens=count,generatedIds=[1]*(count-1)+[0],
        promptIds=[2,3],samplingTokenLogProbabilities=logs,samplingLogProbability=sum(logs),
        sampled=True,temperature=.8,originalTextRepaired=False,responseTokenLimit=128,
        responseBudgetProtocol='native-eos-summary-v6',stopReason='eos',tokenCapReached=False,testDouble=True)


class SummaryOptimizerChecks(unittest.TestCase):
    def test_actual_runtime_entry_accepts_128_budget_and_steps_once(self):
        responses=[word_response_fixture(n) for n in (128,32,30)]
        self.assertIs(runtime.update_words,policy.update_summary_words)
        result,state=execute_word_fixture(responses,[.6,0.,-.1],384)
        self.assertTrue(result['updated']);self.assertTrue(result['parameterChanged'])
        self.assertEqual(result['constantTokenDenominator'],384);self.assertEqual(state['steps'],1)
        self.assertAlmostEqual(state['gradient'],-(.6*1-.1*3)/384)
        self.assertEqual(result['sampledLogProbabilities'],[r['samplingLogProbability'] for r in responses])

    def test_this_failure_reproduces_in_the_unchanged_legacy_updater(self):
        from zip_label_metacognitive_policy import update_words as legacy
        responses=[word_response_fixture(n) for n in (128,32,30)]
        with self.assertRaisesRegex(ValueError,'Fixed 96-token denominator'):
            execute_word_fixture(responses,[-.2,-.2,-.2],384,updater=legacy)

    def test_short_notes_do_not_shrink_the_denominator_and_wrong_budgets_fail(self):
        responses=[word_response_fixture(n) for n in (3,4,5)]
        result,_=execute_word_fixture(responses,[-.2,-.1,0.],384)
        self.assertEqual(result['constantTokenDenominator'],384)
        for budget in (288,12,True):
            with self.assertRaisesRegex(ValueError,'128-token denominator'):
                execute_word_fixture(responses,[-.2,-.1,0.],budget)
        responses[0]['responseTokenLimit']=96
        with self.assertRaisesRegex(ValueError,'response budget'):
            execute_word_fixture(responses,[-.2,-.1,0.],384)

    def test_zero_credit_drift_and_frozen_base_gradient_never_step(self):
        responses=[word_response_fixture(n) for n in (3,4,5)]
        result,state=execute_word_fixture(responses,[0.,0.,0.])
        self.assertFalse(result['updated']);self.assertEqual(state['steps'],0)
        with self.assertRaisesRegex(RuntimeError,'no optimizer step'):
            execute_word_fixture(responses,[.2,-.1,0.],drift=1.)
        with self.assertRaisesRegex(RuntimeError,'Frozen base'):
            execute_word_fixture(responses,[.2,-.1,0.],frozen_base_gradient=True)

    def test_changed_original_token_logs_are_rejected_even_without_credit(self):
        responses=[word_response_fixture(n) for n in (3,4,5)]
        responses[0]['samplingTokenLogProbabilities'][0]-=1.
        with self.assertRaisesRegex(ValueError,'tokens, logs'):
            execute_word_fixture(responses,[0.,0.,0.])


class LiteralAuditChecks(unittest.TestCase):
    def test_parenthetic_false_rule_and_inline_false_task_equality_are_rejected(self):
        for text in ('This suggests a rule (c * a = c * a + c * b).',
                     'The rewrite was: v = v + 1.', 'Consider the equality `v = v + 1`.'):
            n = note_fixture(text)
            self.assertFalse(n['audit']['eligibleForTrial'],text)
            self.assertIn('disproved_inline_literal_identity',n['audit']['reasons'],text)
            self.assertEqual(n['studentRaw'],text)

    def test_actual_unicode_chain_stays_pending_instead_of_disappearing(self):
        text = ('Completing the rewrite: 193 * (193 * v) + 2 * (193 * v) = '
            '193 * (193 * vários) = 3 * (193 * vários) * vários '
            '(Multiple Mistake, Opportunity to Use Distributive Property)')
        n = note_fixture(text)
        self.assertFalse(n['audit']['eligibleForTrial'])
        self.assertIn('pending_unparsed_inline_mathematics',n['audit']['reasons'])
        self.assertEqual(n['studentRaw'],text)
        self.assertTrue(all(not m.get('explicitlyDisproved') for m in n['audit']['inlineLiteralEqualities']))

    def test_true_inline_math_and_power_notation_are_preserved(self):
        for text in ('The identity (v * v = v**2) retains the same polynomial.',
                     'A useful equality: 3 * (v + 2) = 3 * v + 6.'):
            n = note_fixture(text)
            self.assertTrue(n['audit']['eligibleForTrial'],n['audit'])
            self.assertTrue(any(m['status']=='verified' for m in n['audit']['inlineLiteralEqualities']))
            self.assertIn('v**2',presentation_view(text)) if '**2' in text else None
            self.assertFalse(n['audit']['wholeProseTruthCertified'])

    def test_missing_operator_tail_is_never_certified_by_extracting_a_prefix(self):
        for text in ('A rewrite: v = v + 1 *', 'A rewrite: 2 v = v.', 'A rewrite: v = 1..2'):
            n = note_fixture(text)
            self.assertFalse(n['audit']['eligibleForTrial'],text)
            self.assertIn('pending_unparsed_inline_mathematics',n['audit']['reasons'],text)

    def test_bold_selected_route_outcome_is_checked_with_original_offsets(self):
        n = note_fixture('The **SELECTED ROUTE** was **failed**.')
        self.assertFalse(n['audit']['eligibleForTrial'])
        claim = n['audit']['directExperienceOutcomeClaims'][0]
        a,b = claim['span']
        self.assertEqual(n['studentRaw'][a:b],claim['literal'])
        self.assertIn('**failed**',claim['literal'])

    def test_exact_bad_source_quote_is_a_quote_and_unknown_prose_is_not_certified(self):
        e = previous.event_fixture()
        bad = next(r for r in e['routes'] if not r['check']['outcomePassed'])
        text = 'The source wrote `'+bad['studentOutput']['raw']+'`.'
        n = note_fixture(text,event=e)
        self.assertTrue(n['audit']['eligibleForTrial'],n['audit'])
        self.assertFalse(n['audit']['wholeProseTruthCertified'])
        self.assertTrue(any(m['status']=='source_quote' for m in n['audit']['inlineLiteralEqualities']))
        for text in ('The phrase "The task failed" might be mistaken.', 'The source may suggest a different method.'):
            n = note_fixture(text);self.assertTrue(n['audit']['eligibleForTrial'])

    def test_actual_stored_rule_none_claim_is_compared_to_selected_tool(self):
        e = previous.event_fixture()
        good = next(r for r in e['routes'] if r['check']['auditFacts']['selectedToolSupported'] is True)
        e = copy.deepcopy(e);e.pop('eventHash');e['decision']['selectedCandidate'] = good['selectedCandidate']
        e['selectedRouteRecordId'] = good['recordId'];e = core.seal(e,'eventHash')
        n = note_fixture('Successful rewrite using stored rules. Stored rule supports: None',event=e)
        self.assertFalse(n['audit']['eligibleForTrial'])
        self.assertIn('disproved_selected_rule_support',n['audit']['reasons'])
        self.assertTrue(note_fixture('Stored rule supports: True',event=e)['audit']['eligibleForTrial'])

    def test_caps_and_excess_words_stay_ineligible_without_repair(self):
        capped = note_fixture('A complete-looking short note.',capped=True)
        self.assertFalse(capped['audit']['actualEos']);self.assertFalse(capped['audit']['eligibleForTrial'])
        n = note_fixture(' '.join(['detail']*41)+'.')
        self.assertIn('summary_word_budget_exceeded',n['audit']['reasons'])
        self.assertEqual(n['audit']['summaryWordCount'],41)

    def test_selected_failed_action_is_distinct_from_an_unchosen_success(self):
        e = previous.event_fixture();e.pop('eventHash')
        bad = next(r for r in e['routes'] if not r['check']['outcomePassed'])
        e['decision']['selectedCandidate']=bad['selectedCandidate'];e['selectedRouteRecordId']=bad['recordId'];e=core.seal(e,'eventHash')
        self.assertTrue(note_fixture('The selected route failed.',event=e)['audit']['eligibleForTrial'])
        self.assertFalse(note_fixture('Successful rewrite from the current task.',event=e)['audit']['eligibleForTrial'])

    def test_writing_input_uses_one_actual_action_but_archive_keeps_all_originals(self):
        e = previous.event_fixture();before = copy.deepcopy(e)
        selected = next(r for r in e['routes'] if r['recordId']==e['selectedRouteRecordId'])
        text = json.dumps(core.summary_messages(e))
        self.assertIn(selected['studentOutput']['raw'],text)
        for r in e['routes']:
            if r is not selected:self.assertNotIn(r['studentOutput']['raw'],text)
        self.assertNotIn('family',text);self.assertIn('20 words',text)
        self.assertEqual(e,before);self.assertEqual(len(e['routes']),3)
        e['priorTrialEvidence'] = dict(studentSelfScore='SHOULD_NOT_ENTER',candidateEvidence=[dict(studentRaw='OLD_WRONG_NOTE')])
        text = json.dumps(core.summary_messages(e))
        self.assertNotIn('SHOULD_NOT_ENTER',text);self.assertNotIn('OLD_WRONG_NOTE',text)


class SamplerChecks(unittest.TestCase):
    def sampled_fixture(self,phase,text,eos=True):
        tokenizer = old_policy_tests.CounterTokenizer()
        with patch.object(old_policy_tests,'policy',policy):
            return old_policy_tests.generated_checked_fixture(tokenizer,[dict(role='user',content='fixture prompt')],
                phase,text,sampled=True,eos=eos)

    def test_actual_eos_at_last_summary_token_preserves_every_token_and_log(self):
        value,_,_ = self.sampled_fixture('experience_summary','x'*127)
        self.assertEqual(value['generatedTokens'],128);self.assertEqual(value['generatedIds'][-1],0)
        self.assertEqual(len(value['samplingTokenLogProbabilities']),128)
        self.assertEqual(value['raw'],'x'*127);self.assertFalse(value['tokenCapReached'])

    def test_complete_sentence_does_not_stop_generation_and_cap_does_not_invent_eos(self):
        value,_,_ = self.sampled_fixture('experience_summary','Done. More original words.')
        self.assertEqual(value['raw'],'Done. More original words.')
        value,_,_ = self.sampled_fixture('experience_summary','x'*128)
        self.assertTrue(value['tokenCapReached']);self.assertEqual(value['stopReason'],'token_cap')
        self.assertEqual(value['raw'],'x'*128);self.assertNotIn(0,value['generatedIds'])

    def test_task_sampling_remains_the_unchanged_96_token_policy(self):
        tokenizer = old_policy_tests.CounterTokenizer();messages=[dict(role='user',content='same fixture prompt')]
        before,_,_ = old_policy_tests.generated_checked_fixture(tokenizer,messages,'experience_review','x'*96,eos=False)
        with patch.object(old_policy_tests,'policy',policy):
            after,_,_ = old_policy_tests.generated_checked_fixture(tokenizer,messages,'route_math','x'*96,eos=False)
        for key in ('raw','generatedIds','samplingTokenLogProbabilities','samplingLogProbability','stopReason'):
            self.assertEqual(before[key],after[key])
        self.assertEqual(after['responseTokenLimit'],96)

    def test_checked_budget_tampering_is_rejected_before_sampling(self):
        tokenizer=old_policy_tests.CounterTokenizer();messages=[dict(role='user',content='fixture')]
        audit=policy.prompt_audit(tokenizer,messages,policy.input_limits(dict(max_position_embeddings=8192),tokenizer))
        audit['responseTokenReserve']=96
        with self.assertRaises(ValueError):policy.require_input(audit)
        self.assertEqual(policy.token_limit('experience_summary'),128)
        with self.assertRaises(ValueError):policy.token_limit('unknown')


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
            value.update(responseTokenLimit=128 if phase=='experience_summary' else 96,
                responseBudgetProtocol='native-eos-summary-v6',
                summaryStateHashDuringGeneration=state[current],generationMode=mode,
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
            learns.append(copy.deepcopy(cr));before=state[current]
            policy,optimizer_state=execute_word_fixture([n['studentOriginal']['studentOutput'] for n in ns],cr['batchAdvantages'])
            change=policy['updated']
            self.assertEqual(optimizer_state['steps'],int(change))
            if change:
                state[current]=before+'x'
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

    def write_replay_fixture(self,folder):
        with patch.object(previous,'core',core),patch.object(previous,'runtime',runtime):
            return previous.CourseChecks.write_replay_fixture(self,folder)

    def test_full_course_keeps_candidate_group_credit_budgets_and_frozen_heldout(self):
        out=self.fixture_run();self.assertNotIn('error',out,repr(out.get('error')))
        c=out['course'];self.assertEqual(len(c['summaries']),12);self.assertEqual(len(out['learns']),4)
        self.assertLessEqual(len(out['rows'])+8,core.MAX_GENERATIONS)
        self.assertTrue(c['heldoutStateUnchanged'])
        self.assertTrue(all(s['policyUpdate']['constantTokenDenominator']==384 for s in out['steps']))
        for g in c['groups']:
            ns=[out['notes'][i] for i in g['candidateSummaryZipIds']]
            self.assertEqual(len({n['studentOriginal']['samplingSeed'] for n in ns}),3)

    def test_bad_candidates_stay_outside_head_replay_and_get_no_positive_credit(self):
        out=self.fixture_run(all_bad=True);self.assertNotIn('error',out)
        self.assertTrue(all(g['selectedSummaryZipId'] is None for g in out['course']['groupResults']))
        self.assertTrue(all(a<=0 for cr in out['learns'] for a in cr['batchAdvantages']))
        self.assertTrue(all(v is None for v in out['course']['finalBanks'].values()))

    def test_saved_course_replay_derives_new_audits_credits_and_gate_from_originals(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp);out,result=self.write_replay_fixture(p)
            rebuilt=replay_saved_course(p,result,out['notes'],out['checkpoints'][0],out['checkpoints'][-1],
                {f['id']:f for f in out['features']},{r['recordId']:r for r in out['rows']},out['steps'])
            self.assertEqual(rebuilt['finalBanks'],out['course']['finalBanks'])
            path=next((p/'group-result').glob('*.json'));row=json.loads(path.read_text())
            row['batchAdvantages'][0]+=.1;path.write_text(json.dumps(row))
            with self.assertRaises(ValueError):replay_saved_course(p,result,out['notes'],out['checkpoints'][0],out['checkpoints'][-1],
                {f['id']:f for f in out['features']},{r['recordId']:r for r in out['rows']},out['steps'])

    def test_native_zip_keeps_full_original_and_detects_byte_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);n=note_fixture();h=runtime.write_summary_zip(folder,n)
            self.assertEqual(runtime.read_summary_zip(folder,n['id'],{n['id']:h}),n)
            path=folder/(n['id']+'.zip');path.write_bytes(path.read_bytes()+b'changed')
            with self.assertRaises(ValueError):runtime.read_summary_zip(folder,n['id'],{n['id']:h})

    def test_previous_v5_writer_and_scores_are_preserved_without_retraining_old_tokens(self):
        n=previous.note_fixture();old=copy.deepcopy(n)
        heads={b:ChoiceHead([.3,-.2]).state() for b in core.BRANCHES}
        prior=dict(initialHeads=heads,initialBanks={b:n['id'] if i==0 else None for i,b in enumerate(core.BRANCHES)},
            inherited={n['id']:n},inheritedContextReviews={},summaryStateHashes={b:'old-writer-'+b for b in core.BRANCHES})
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp);(p/'result.json').write_text(json.dumps(dict(protocol='lain-zip-experience-summary-training-v5',
                fixtureOnly=False,fixtureGenerations=0,teacherCalls=0)))
            with patch('zip_summary_training_v6_inspect.inspect_previous_source',return_value=prior):resumed=runtime.inspect_training_source(p)
        self.assertEqual(resumed['initialHeads'],heads);self.assertEqual(resumed['inherited'][n['id']],old)
        self.assertEqual(resumed['initialBanks'],{b:None for b in core.BRANCHES})
        self.assertEqual(resumed['summaryStateHashes'],prior['summaryStateHashes'])

    def test_partial_round_namespaces_and_fixture_sources_are_safe(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)
            for version in range(1,7):
                out=p/('zip-summary-training-fixture-'+str(version));out.mkdir()
                (out/'protocol.json').write_text(json.dumps(dict(protocol='lain-zip-experience-summary-training-v'+str(version),trainingRound=version)))
            self.assertEqual(runtime.next_number(p),7)
            self.assertGreater(core.seed_for(1,0,0),previous.core.seed_for(1000,20,99))
            (p/'result.json').write_text(json.dumps(dict(fixtureOnly=True)))
            before=set(sys.modules)
            with self.assertRaisesRegex(ValueError,'Fixture'):runtime.inspect_training_source(p)
            self.assertNotIn('torch',set(sys.modules)-before)

    def test_tokenizer_only_preflight_checks_new_shapes_and_rejects_overflow(self):
        class Tokenizer:
            model_max_length=8192
            def apply_chat_template(self,messages,**kwargs):return json.dumps(messages)
            def __call__(self,text,**kwargs):return dict(input_ids=[1]*(4097 if overflow[0] else len(text.split())))
        module=ModuleType('transformers');module.AutoTokenizer=Mock();module.AutoTokenizer.from_pretrained.return_value=Tokenizer()
        overflow=[False];rr=roots();plan=make_plan(set(),rr);plan['training']=plan['training'][:6]
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp);(p/'config.json').write_text(json.dumps(dict(max_position_embeddings=8192)))
            with patch.dict(sys.modules,{'transformers':module}):
                _,limits,report=runtime.prepare_inputs(p,plan,rr)
                self.assertEqual(limits['responseTokenReserve'],128);self.assertEqual(len(report['rows']),92)
                overflow[0]=True
                with self.assertRaises(ValueError):runtime.prepare_inputs(p,plan,rr)


class SeriesChecks(unittest.TestCase):
    def metadata_fixture(self, folder):
        # Temporary simulated metadata for admission/aggregation checks ONLY.
        # There are no raw generations or weight files; this can never pass
        # the full inspect_training_source check required before model loading.
        folder.mkdir()
        source = folder.parent/'simulated-parent'
        fixed = series.recipe('synthetic-payload',3)
        means = {a:.4 for a in core.EVALUATION_ARMS}
        result = dict(protocol=core.PROTOCOL,fixtureOnly=False,fixtureGenerations=0,teacherCalls=0,
            stopReason='completed',error=None,completeTrainingExperiment=True,
            completedTrainingObjects=6,completedHeldoutObjects=4,coldReproductions=8,
            actualStudentGenerations=64,studentWrittenSummaryZips=12,summaryOptimizerUpdates=4,
            trainingUpdates=10,summary=dict(expectedPassByArm=means),
            **{k:True for k in ('baseWeightsUnchanged','mathematicalWriterUnchanged',
                'originalSemanticWriterUnchanged','originalFilesUnchanged','heldoutLearnedStateUnchanged')})
        protocol = dict(protocol=core.PROTOCOL,maximumSummaryTokens=128,summaryMaximumWords=40,
            summaryAuditProtocol='selected-experience-literal-audit-v6',summaryPromptContainsOnlySelectedAction=True)
        plan = {phase:[dict(id=phase+'-'+str(i),semanticInputKey='synthetic-'+phase+'-'+str(i),split=phase)
            for i in range(n)] for phase,n in (('training',6),('heldout',4))}
        for name,value in (('result.json',result),('protocol.json',protocol),('zip-summary-questions.json',plan),
                           ('source-checkpoint.json',dict(parentSource=str(source)))):
            (folder/name).write_text(json.dumps(value))
        (folder/'object').mkdir()
        for task in plan['heldout']:
            obj = dict(id=task['id'],phase='heldout',trainingUpdates=0,allChoicesSavedBeforeRoutes=True,
                routeOutcomes=[0,1,0],probabilitiesByArm={a:[.3,.4,.3] for a in core.EVALUATION_ARMS},
                expectedPassByArm=means)
            (folder/'object'/(task['id']+'.json')).write_text(json.dumps(obj))
        return source,fixed

    def test_course_metadata_field_names_and_paired_means_validate(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp)/'metadata';source,fixed=self.metadata_fixture(folder);seen=set()
            result,objects,_=series.validate_round(folder,source,fixed,seen)
            self.assertEqual(len(objects),4);self.assertEqual(len(seen),10)
            self.assertEqual(result['summary']['expectedPassByArm'][core.BRANCHES[0]],.4)
            with self.assertRaisesRegex(ValueError,'reused'):series.validate_round(folder,source,fixed,seen)

    def test_different_parent_or_changed_fixed_recipe_cannot_continue(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp)/'metadata';source,fixed=self.metadata_fixture(folder)
            with self.assertRaisesRegex(ValueError,'checkpoint'):
                series.validate_round(folder,source.parent/'different',fixed,set())
            protocol=json.loads((folder/'protocol.json').read_text());protocol['maximumSummaryTokens']=96
            (folder/'protocol.json').write_text(json.dumps(protocol))
            with self.assertRaisesRegex(ValueError,'recipe'):series.validate_round(folder,source,fixed,set())

    def test_unpaired_probability_or_report_changes_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp)/'metadata';source,fixed=self.metadata_fixture(folder)
            path=next((folder/'object').glob('*.json'));obj=json.loads(path.read_text())
            obj['expectedPassByArm'][core.BRANCHES[0]]=.9;path.write_text(json.dumps(obj))
            with self.assertRaisesRegex(ValueError,'probability'):series.validate_round(folder,source,fixed,set())
            obj['expectedPassByArm'][core.BRANCHES[0]]=.4;path.write_text(json.dumps(obj))
            result=json.loads((folder/'result.json').read_text())
            result['summary']['expectedPassByArm'][core.BRANCHES[0]]=.9
            (folder/'result.json').write_text(json.dumps(result))
            with self.assertRaisesRegex(ValueError,'report'):series.validate_round(folder,source,fixed,set())

    def run_simulation(self,folder,fail_at=None,duplicate_score=False,deadline=None):
        calls=[];counter=[0]
        def execute(source,out,ordinal,until):
            calls.append((str(source),str(out),ordinal,until));out.mkdir()
            # This is deliberately labelled synthetic; validate_round is mocked
            # only for orchestration tests, never for production admission.
            report=dict(uniqueSummarySourceTasks=2,measuredPositiveCandidateCredits=0,
                measuredNegativeCandidateCredits=7,cappedSummaries=5,overlongSummaries=2,
                pendingInlineMathematicsSummaries=2,summariesWithKnownContradictions=1,operativeSummaryContextUses=0)
            result=dict(fixtureOnly=True,trainingRound=ordinal,actualStudentGenerations=0,trainingUpdates=0,
                summaryOptimizerUpdates=0,studentWrittenSummaryZips=0,
                completedTrainingObjects=3 if fail_at==ordinal else 6,summary=report,
                error='ValueError: Fixed 96-token denominator per trajectory' if fail_at==ordinal else None)
            (out/'result.json').write_text(json.dumps(result))
            return dict(exitCode=1 if fail_at==ordinal else 0)
        def validated(out,parent,fixed,seen):
            counter[0]+=1
            result=json.loads((out/'result.json').read_text())
            value=.9 if counter[0]==1 else .1
            obj=dict(id='synthetic-held-'+str(counter[0]),expectedPassByArm={a:value for a in core.EVALUATION_ARMS})
            return result,[obj],dict(baseStateHash='synthetic-base',mathematicalWriterStateHash='synthetic-math')
        with patch('zip_summary_training_v6_series.validate_round',side_effect=validated):
            outcome=series.run_series(folder/'source',folder,folder/'series',series.recipe('synthetic-payload',3),execute,
                time.monotonic()+60 if deadline is None else deadline)
        return outcome,calls

    def test_three_courses_resume_in_order_even_when_later_scores_are_lower(self):
        with tempfile.TemporaryDirectory() as temp:
            out,calls=self.run_simulation(Path(temp))
            self.assertEqual(len(calls),3)
            self.assertEqual(calls[1][0],calls[0][1]);self.assertEqual(calls[2][0],calls[1][1])
            self.assertEqual(out['report']['completedRounds'],3)
            self.assertEqual(len(out['report']['byRound']),3)
            self.assertFalse(out['report']['nextSourceChosenByHeldoutScore'])
            self.assertTrue(out['report']['roundsAreNotIndependentTrainingReplications'])
            self.assertEqual(out['report']['actualStudentGenerations'],0)

    def test_failed_course_stops_dependency_and_preserves_previous_report(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp);out,calls=self.run_simulation(p,fail_at=2)
            self.assertEqual(len(calls),2);self.assertEqual(out['report']['completedRounds'],1)
            self.assertFalse(out['report']['completeFixedSeries'])
            self.assertEqual(out['report']['lastCompleteCheckpoint'],calls[0][1])
            self.assertEqual(out['report']['completedTrainingObjects'],9)
            self.assertEqual(out['report']['completeCourseTrainingObjects'],6)
            self.assertEqual(out['report']['partialCourseTrainingObjects'],3)
            self.assertTrue((p/'series/result.json').is_file())

    def test_first_partial_course_keeps_its_actual_diagnostics_and_error(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp);out,calls=self.run_simulation(p,fail_at=1);r=out['report']
            self.assertEqual(len(calls),1);self.assertEqual(r['completedRounds'],0)
            self.assertIn('Fixed 96-token denominator',r['error'])
            self.assertEqual(r['completedTrainingObjects'],3);self.assertEqual(r['completeCourseTrainingObjects'],0)
            self.assertEqual(r['overlongSummaries'],2);self.assertEqual(r['pendingMathematicsSummaries'],2)
            self.assertIsNone(r['sameHeadSummaryEffectAcrossAllHeldoutObjects'])
            self.assertEqual(r['resumeSourceForNextAttempt'],str(p/'source'))

    def test_expired_deadline_makes_no_calls_and_keeps_zero_counts(self):
        with tempfile.TemporaryDirectory() as temp:
            out,calls=self.run_simulation(Path(temp),deadline=time.monotonic()-1)
            self.assertEqual(calls,[]);self.assertEqual(out['report']['completedRounds'],0)
            self.assertIsNone(out['report']['sameHeadSummaryEffectAcrossAllHeldoutObjects'])

    def test_real_series_admission_rejects_a_fixture_before_any_other_file(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp);(p/'result.json').write_text(json.dumps(dict(protocol=core.PROTOCOL,fixtureOnly=True)))
            with self.assertRaisesRegex(ValueError,'fixture'):series.validate_round(p,p,series.recipe('test',3),set())

    def test_round_count_is_fixed_bounded_and_not_a_best_score_request(self):
        for value in (0,11,True,1.5):
            with self.assertRaises(ValueError):series.recipe('fixture',value)
        self.assertEqual(series.recipe('fixture',3)['summaryCandidatesPerRound'],12)
        self.assertFalse(series.recipe('fixture',3)['adaptiveRetries'])


if __name__=='__main__':unittest.main()
