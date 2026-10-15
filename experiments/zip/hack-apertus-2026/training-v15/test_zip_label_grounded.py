"""Explicit offline fixtures; no student, teacher, or real training calls."""
import copy
import json
import math
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import ModuleType, SimpleNamespace

import zip_label_grounded_checks as checks
import zip_label_grounded_core as core
import zip_label_grounded_run as runtime
import test_zip_label as legacy_tests
from test_zip_label import roots_fixture, response
from object_choice_core import ChoiceHead, normalized_features
from choice_continue_core import feedback_update
from zip_content_core import digest


def original(text, number=1, capped=False):
    return dict(recordId='explicit-fixture-'+str(number), phase='training_zip_label_revision',
        studentOutput=response(text, sampled=True, capped=capped), fixtureOnly=True)


class GroundedFeedbackChecks(unittest.TestCase):
    def setUp(self):
        self.roots=roots_fixture()
        self.previous={r['id']:core.version_label(r,original('Earlier student note.', i),
            language_protocol=core.NATURAL_LANGUAGE) for i,r in enumerate(self.roots,10)}

    def test_actual_ce37_disproved_equality_is_not_activated_or_repaired(self):
        text=('Stored algebra:\n1 * (118 * v) + 2 * (118 * v) = v + 216v\n'
              'Auditor challenges residual tool support.')
        row=original(text);before=copy.deepcopy(row)
        version=core.version_label(self.roots[0],row,self.previous['combine'],core.NATURAL_LANGUAGE)
        self.assertTrue(version['noteFramingCheck']['complete'])
        self.assertFalse(version['activatedAsRetrievalMetadata'])
        self.assertTrue(version['knownFalseEqualityBlocked'])
        self.assertEqual(version['activeDescriptionRaw'],'Earlier student note.')
        self.assertEqual(version['studentRaw'],text)
        self.assertEqual(row,before)
        self.assertFalse(version['wholeNaturalLanguageCertified'])
        self.assertFalse(version['originalTextRepaired'])

    def test_inline_bab_false_equation_is_audited_as_written(self):
        for text in ('Example: `v * 3 * 7 + 12 = 9v + 36`.',
                     'Example: $v * 3 * 7 + 12 = 9v + 36$.',
                     'Example: v * 3 * 7 + 12 = 9v + 36.'):
            with self.subTest(text=text):
                audit=checks.note_audit(text)
                self.assertTrue(audit['containsDisprovedWrittenEquality'])
                self.assertEqual(len(audit['writtenEqualities']),1)
                self.assertFalse(audit['missingMathematicsFilled'])
                self.assertFalse(audit['proseTruthCertified'])

    def test_true_equalities_and_unsupported_prose_are_never_certified_as_notes(self):
        for text in ('1*x+2*x=3*x.', 'A provisional observation about what I saw.',
                     'Unsupported identity: sin(v)=v.', 'An unfinished equation: v =.'):
            with self.subTest(text=text):
                audit=checks.note_audit(text)
                self.assertFalse(audit['containsDisprovedWrittenEquality'])
                self.assertFalse(audit['wholeDraftCertified'])
        self.assertEqual(checks.note_audit('An unfinished equation: v =.')['writtenEqualities'],[])

    def credits(self, texts=None, old=.7, new=.75, baseline=.4, capped=False):
        texts=texts or ['Concrete observation.', 'First revised note.', 'Second revised note.']
        rows=[original(t, n+1,capped=capped and n==1) for n,t in enumerate(texts)]
        rows[0]['phase']='training_observations'
        versions=[core.version_label(root,row,self.previous[root['id']],core.NATURAL_LANGUAGE)
                  for root,row in zip(self.roots,rows[1:])]
        return rows,versions,checks.semantic_credits(rows,versions,old,new,baseline)

    def test_labels_receive_joint_card_delta_instead_of_whole_observation_gain(self):
        rows,versions,credit=self.credits()
        self.assertAlmostEqual(credit['advantages'][0],.6)
        self.assertAlmostEqual(credit['advantages'][1],.1)
        self.assertAlmostEqual(credit['advantages'][2],.1)
        self.assertFalse(credit['individualCardEffectsIsolated'])
        self.assertFalse(credit['observationCounterfactualIsolated'])
        self.assertFalse(credit['headUpdateIncludedInSemanticReward'])
        _,_,zero=self.credits(old=.7,new=.7)
        self.assertEqual(zero['advantages'][1:],[0.,0.])

    def test_disproved_observation_or_label_never_receives_positive_credit(self):
        _,versions,credit=self.credits(['v=2*v.', 'Example: `v=2*v`.', 'Revised note.'])
        self.assertEqual(credit['advantages'][:2],[-1.,-1.])
        self.assertFalse(versions[0]['activatedAsRetrievalMetadata'])
        self.assertGreater(credit['advantages'][2],0)
        _,versions,capped=self.credits(capped=True)
        self.assertFalse(versions[0]['activatedAsRetrievalMetadata'])
        self.assertEqual(capped['advantages'][1],0.)

    def test_negative_card_effect_is_negative_credit_even_when_task_succeeds(self):
        _,_,credit=self.credits(old=.8,new=.6,baseline=.3)
        self.assertGreater(credit['advantages'][0],0)
        self.assertTrue(all(x<0 for x in credit['advantages'][1:]))

    def test_capped_observation_gets_no_positive_outcome_credit(self):
        rows,versions,_=self.credits()
        rows[0]['studentOutput']['tokenCapReached']=True
        credit=checks.semantic_credits(rows,versions,.7,.75,.4)
        self.assertEqual(credit['advantages'][0],0.)

    def item(self,n,features,outcomes):
        return checks.replay_item(dict(id='training-fixture-'+str(n),split='training'),
            features,outcomes,'fixture-feature-'+str(n),['fixture-math-'+str(n)+'-'+str(i) for i in range(3)])

    def test_same_representation_conflict_does_not_erase_previous_success(self):
        features=[[0.],[1.],[-1.]]
        head=ChoiceHead([1.5]);replay=[self.item(1,features,[0,1,0])]
        self.assertTrue(checks.guarded_head_update(head,replay,1)['updated'])
        before=head.state();old=checks.expectation(head,replay[0])
        legacy=ChoiceHead(head.weights)
        feedback_update(legacy,features,[0,0,1],2)
        self.assertLess(checks.expectation(legacy,replay[0]),old)
        replay.append(self.item(2,features,[0,0,1]))
        update=checks.guarded_head_update(head,replay,2)
        self.assertFalse(update['updated'])
        self.assertEqual(head.state(),before)
        self.assertEqual(len(update['lineSearchTrials']),checks.HEAD_TRIALS)
        self.assertFalse(update['heldoutRegressionPrevented'])

    def test_distinguishable_features_can_improve_both_routes_under_replay(self):
        head=ChoiceHead([0.,0.]);replay=[self.item(1,[[0.,0.],[1.,0.],[-1.,0.]],[0,1,0])]
        checks.guarded_head_update(head,replay,1)
        replay.append(self.item(2,[[0.,0.],[0.,-1.],[0.,1.]],[0,0,1]))
        update=checks.guarded_head_update(head,replay,2)
        self.assertTrue(update['updated'])
        self.assertTrue(all(a>b for a,b in zip(update['replayExpectedPassAfter'],update['replayExpectedPassBefore'])))
        self.assertEqual(update['replayHash'],digest(replay))

    def test_all_failed_routes_noop_and_heldout_never_enters_buffer(self):
        head=ChoiceHead([.3]);before=head.state()
        update=checks.guarded_head_update(head,[self.item(1,[[0.],[1.],[-1.]],[0,0,0])],1)
        self.assertFalse(update['updated']);self.assertEqual(head.state(),before)
        with self.assertRaisesRegex(ValueError,'Heldout'):
            checks.replay_item(dict(id='heldout-fixture',split='heldout'),[[0.],[1.],[-1.]],
                               [0,1,0],'x',['a','b','c'])

    def test_current_object_is_last_in_all_semantic_and_feature_prompts(self):
        task=dict(id='fixture',expression='3*(7*v+14)',family='DO_NOT_TEACH_FAMILY',scope='real_polynomial')
        observed=original('Complete student observation.')
        route=dict(studentOutput=response('3*(7*v+14)=3*7*v+3*14'),
            check=core.audit_math(task,response('3*(7*v+14)=3*7*v+3*14'),
                                  dict(kind='distribute',id='distribute',root=self.roots[1])))
        prompts=[core.observations_messages(task,self.roots,self.previous,core.NATURAL_LANGUAGE),
                 core.revision_messages(task,self.roots[1],self.previous['distribute'],observed,route,core.NATURAL_LANGUAGE)]
        prompts += [checks.feature_messages(task,observed['studentOutput'],c)
                    for c in core.cards(self.roots,self.previous,core.NATURAL_LANGUAGE)]
        for prompt in prompts:
            self.assertTrue(prompt[-1]['content'].endswith('Current object: '+task['expression']))
            self.assertNotIn(task['family'],json.dumps(prompt))
        self.assertIn(observed['studentOutput']['raw'],prompts[-1][1]['content'])

    def exercise(self, zero=False, capped=False):
        witness=legacy_tests.LabelIterationChecks('test_full_loop_writes_features_and_labels_and_keeps_all_originals')
        with patch.object(legacy_tests,'core',core),patch.object(legacy_tests,'feature_messages',checks.feature_messages):
            witness.setUp()
            return witness.exercise(language_protocol=core.NATURAL_LANGUAGE,
                                    zero_outcomes=zero,capped_revisions=capped)

    def test_complete_synthetic_loop_keeps_budgets_originals_and_frozen_controls(self):
        e=self.exercise();saved=e['saved']
        self.assertEqual([len(saved[k]) for k in ('raw','feature','object','update','label-version','decision')],
                         [68,28,12,8,16,44])
        self.assertTrue(all(r['fixtureOnly'] for r in saved['raw']))
        self.assertEqual(e['checkpoints']['final'],e['checkpoints']['training-final'])
        for number,update in enumerate(saved['update'],1):
            credit=update['semanticCreditAssignment']
            self.assertEqual(update['trainingReplaySize'],number)
            self.assertEqual(len(update['headUpdate']['replayTaskIds']),number)
            self.assertTrue(all(a>=b-checks.TOLERANCE for a,b in zip(
                update['headUpdate']['replayExpectedPassAfter'],update['headUpdate']['replayExpectedPassBefore'])))
            self.assertEqual(e['wordUpdates'][number-1]['reward'],credit)
            self.assertAlmostEqual(update['baselinePassAfter'],
                .9*update['baselinePassBefore']+.1*update['expectedPassWithPreviousLabels'])
            self.assertFalse(update['humanFeatureTargetsSupplied'])
        for obj in saved['object'][8:]:
            self.assertEqual(obj['trainingUpdates'],0)
            decisions=[d for d in saved['decision'] if d['task']['id']==obj['id']]
            self.assertEqual(len(decisions),9)
            self.assertEqual(len(obj['sourceMathRecordIds']),3)

    def test_capped_inactive_revisions_preserve_previous_cards_and_get_zero_credit(self):
        e=self.exercise(capped=True)
        self.assertFalse(any(v['activatedAsRetrievalMetadata'] for v in e['saved']['label-version']))
        self.assertTrue(all(u['semanticCreditAssignment']['advantages'][1:]==[0.,0.] for u in e['saved']['update']))
        self.assertEqual(e['checkpoints']['final']['labels'],e['checkpoints']['initial']['labels'])

    def test_new_namespace_and_partial_rounds_reserve_fresh_seeds(self):
        import zip_label_feedback_core as v4
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp)/'zip-label-grounded-feedback-partial';folder.mkdir()
            (folder/'protocol.json').write_text(json.dumps(dict(protocol=core.NATURAL_PROTOCOL,iterationRound=7)))
            self.assertEqual(runtime.next_round(Path(tmp),4),8)
        for round_number in (1,5,1000):
            new=core.seed_for(round_number,1,51)
            self.assertGreater(new,v4.seed_for(1000,12,99))
            self.assertNotEqual(new,legacy_tests.core.seed_for(round_number,1,51))

    def test_fixture_and_unreviewed_source_rejected_without_model_import(self):
        before=set(sys.modules)
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp)
            (folder/'result.json').write_text(json.dumps(dict(protocol=core.NATURAL_PROTOCOL,fixtureOnly=True)))
            with self.assertRaises(ValueError):runtime.inspect_iteration(folder)
            (folder/'result.json').write_text(json.dumps(dict(protocol=runtime.feedback_runtime.NATURAL_PROTOCOL)))
            with self.assertRaisesRegex(ValueError,'reviewed ce3a8917'):runtime.inspect_iteration(folder)
        self.assertNotIn('torch',set(sys.modules)-before)
        self.assertNotIn('transformers',set(sys.modules)-before)

    def test_sequential_normalization_compatibility_preserves_original_and_numerical_bounds(self):
        vectors=[[.1,.7,.4],[1.,-.3,.6],[-.6,.9,-.2]]
        before=copy.deepcopy(vectors)
        sequential=runtime.sequential_normalized_features(vectors)
        current=normalized_features(vectors)
        self.assertEqual(vectors,before)
        self.assertTrue(all(abs(a-b)<1e-12 for x,y in zip(current,sequential) for a,b in zip(x,y)))
        for row in sequential:self.assertAlmostEqual(sum(x*x for x in row),1.)
        with self.assertRaises(ValueError):runtime.sequential_normalized_features([[math.nan],[1.],[2.]])

    def test_hash_compatibility_accepts_only_the_two_reconstructed_preimages(self):
        current=[self.item(1,[[0.],[1.],[-1.]],[0,1,0])]
        sequential=copy.deepcopy(current)
        sequential[0]['features'][0][0]=1e-16
        self.assertTrue(runtime.replay_hash_matches(current,sequential,digest(current)))
        self.assertTrue(runtime.replay_hash_matches(current,sequential,digest(sequential)))
        altered=copy.deepcopy(sequential);altered[0]['routeOutcomes']=[0,0,1]
        self.assertFalse(runtime.replay_hash_matches(current,sequential,digest(altered)))
        self.assertFalse(runtime.replay_hash_matches(current,sequential,'0'*64))


class WeightedPolicyChecks(unittest.TestCase):
    def execute(self, advantages, drift=False):
        """Small exact scalar autodiff fixture, no tensor library or model needed."""
        from zip_label_grounded_policy import update_weighted_generation
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
        module=ModuleType('torch')
        module.isfinite=lambda x:math.isfinite(float(x))
        module.nn=SimpleNamespace(utils=SimpleNamespace(clip_grad_norm_=lambda *a,**kw:abs(state['gradient'])))
        policy=ModuleType('zip_generation_policy')
        policy.response_log_probability=lambda base,r:Scalar(r['samplingLogProbability']+(1 if drift else 0),r['fixtureGradient'])
        adapter=SimpleNamespace(digest=lambda:digest(state['weight']),parameters_to_train=lambda:[])
        def step():state['weight']-=.001*state['gradient'];state['steps']+=1
        optimizer=SimpleNamespace(zero_grad=lambda **kw:state.update(gradient=None),step=step)
        base=SimpleNamespace(parameters=lambda:[])
        responses=[dict(sampled=True,generatedTokens=3,samplingLogProbability=-1.*(i+1),
                        fixtureGradient=float(i+1)) for i in range(3)]
        with patch.dict(sys.modules,{'torch':module,'zip_generation_policy':policy}):
            result=update_weighted_generation(base,adapter,optimizer,responses,advantages,288)
        return result,state

    def test_separate_advantages_weight_only_their_own_sampled_trajectory(self):
        result,state=self.execute([.6,0.,-.2])
        self.assertAlmostEqual(state['gradient'],-(.6*1+0*2-.2*3)/288)
        self.assertEqual(result['replayLogProbabilities'],[-1.,-2.,-3.])
        self.assertEqual(state['steps'],1)
        self.assertEqual(result['constantTokenDenominator'],288)
        self.assertTrue(result['zeroCreditRowsReceiveNoGradient'])

    def test_zero_credit_noop_and_policy_drift_stops_before_optimizer_step(self):
        result,state=self.execute([0.,0.,0.])
        self.assertFalse(result['updated']);self.assertEqual(state['steps'],0)
        with self.assertRaisesRegex(RuntimeError,'no optimizer step'):
            self.execute([.2,.1,0.],drift=True)


if __name__=='__main__':unittest.main()
