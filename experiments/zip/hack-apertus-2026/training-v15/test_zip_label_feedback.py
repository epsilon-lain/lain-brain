"""Offline regressions for scoring and feedback; explicit synthetic fixtures."""
import copy
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

import zip_label_feedback_audit as audit
import zip_label_feedback_core as core
import zip_label_feedback_run as runtime
import test_zip_label as legacy_tests
from test_zip_label import roots_fixture, response


class FeedbackFixChecks(unittest.TestCase):
    def setUp(self):
        self.roots=roots_fixture()
        self.combine=dict(kind='combine',id='combine',root=self.roots[0])
        self.distribute=dict(kind='distribute',id='distribute',root=self.roots[1])
        self.direct=dict(kind='direct',id='DIRECT')
        self.task=dict(id='fixture-task',expression='1*(104*v)+2*(104*v)',scope='real_polynomial')

    def check(self,text,candidate=None,task=None,capped=False):
        return audit.audit_math(task or self.task,response(text,capped=capped),candidate or self.combine)

    def test_four_actual_omitted_unit_cases_gain_exact_task_and_rule_certificates(self):
        for n in (104,106,107,108):
            with self.subTest(n=n):
                text=f'{n} * v + 2 * {n} * v = 3 * {n} * v'
                task=dict(self.task,expression=f'1 * ({n} * v) + 2 * ({n} * v)')
                output=response(text);old=copy.deepcopy(output)
                checked=audit.audit_math(task,output,self.combine)
                self.assertFalse(checked['legacyOutcomePassed'])
                self.assertTrue(checked['outcomePassed'])
                self.assertTrue(checked['completeEqualityCheck']['taskEquivalenceAudit']['accepted'])
                self.assertTrue(checked['selectedToolReplay']['replaySourceIsOriginalTask'])
                self.assertTrue(checked['auditFacts']['selectedToolSupported'])
                self.assertFalse(checked['auditFacts']['originalLeftSyntaxPreserved'])
                self.assertEqual(output,old)
                self.assertFalse(checked['hostFilledMathematics'])

    def test_false_written_identity_stays_false_despite_equivalent_source(self):
        c=self.check('104*v+2*104*v=4*104*v')
        self.assertFalse(c['outcomePassed'])
        self.assertFalse(c['auditFacts']['writtenEqualityTrue'])
        self.assertTrue(c['auditFacts']['writtenLeftEquivalentToTask'])
        self.assertIn('written_mathematical_identity_false',c['failureReasons'])

    def test_true_identity_from_a_different_task_cannot_receive_reward(self):
        c=self.check('105*v+2*105*v=3*105*v')
        self.assertFalse(c['outcomePassed'])
        self.assertTrue(c['auditFacts']['writtenEqualityTrue'])
        self.assertFalse(c['auditFacts']['writtenLeftEquivalentToTask'])
        self.assertIn('different_task_input',c['failureReasons'])

    def test_cancelled_outside_variable_still_violates_task_contract(self):
        c=self.check('104*v+2*104*v+z-z=3*104*v')
        self.assertFalse(c['outcomePassed'])
        self.assertTrue(c['auditFacts']['writtenEqualityTrue'])
        self.assertTrue(c['auditFacts']['writtenLeftEquivalentToTask'])
        self.assertFalse(c['auditFacts']['onlyTaskVariablesUsed'])

    def test_true_grounded_equality_without_selected_tool_replay_is_not_rewarded(self):
        task=dict(self.task,expression='3*(4*v+12)')
        c=self.check('3*(4*v+12)=3*4*v+3*12',self.combine,task)
        self.assertFalse(c['outcomePassed'])
        self.assertTrue(c['auditFacts']['writtenEqualityTrue'])
        self.assertTrue(c['auditFacts']['writtenLeftEquivalentToTask'])
        self.assertFalse(c['auditFacts']['selectedToolSupported'])
        self.assertEqual(c['failureReasons'],['selected_tool_did_not_support_this_step'])
        self.assertTrue(self.check('3*(4*v+12)=3*4*v+3*12',self.distribute,task)['outcomePassed'])

    def test_frozen_numeric_rule_is_not_generalized_to_other_coefficients(self):
        task=dict(self.task,expression='1*(104*v)+3*(104*v)')
        c=self.check('104*v+3*104*v=4*104*v',self.combine,task)
        self.assertTrue(c['auditFacts']['writtenEqualityTrue'])
        self.assertTrue(c['auditFacts']['writtenLeftEquivalentToTask'])
        self.assertFalse(c['outcomePassed'])
        self.assertFalse(c['auditFacts']['selectedToolSupported'])

    def test_capping_chains_missing_equalities_and_abstention_remain_unrewarded(self):
        cases=[('104*v+2*104*v=3*104*v',True),('104*v+2*104*v=312*v=3*104*v',False),
            ('3*104*v',False),('SKIP',False),('v=__import__("os")',False)]
        for text,capped in cases:
            with self.subTest(text=text):
                c=self.check(text,capped=capped)
                self.assertFalse(c['outcomePassed'])
                if not c['completeEqualityCheck']['parsed']:
                    self.assertIsNone(c['auditFacts']['writtenEqualityTrue'])

    def test_units_copying_and_reversing_to_the_unmodified_task_do_not_count_as_progress(self):
        cases=['1*(104*v)+2*(104*v)=104*v+208*v',
            '312*v=312*v','3*104*v=1*(104*v)+2*(104*v)']
        for text in cases:
            with self.subTest(text=text):
                c=self.check(text,self.direct)
                self.assertFalse(c['outcomePassed'])
                self.assertEqual(c['completeEqualityCheck']['status'],'no_progress')

    def test_feedback_contains_only_separate_facts_and_no_corrected_math_or_binding(self):
        c=self.check('104*v+2*104*v=3*104*v')
        feedback=audit.feedback_for(c)
        self.assertTrue(feedback['facts']['writtenEqualityTrue'])
        self.assertFalse(feedback['facts']['originalLeftSyntaxPreserved'])
        self.assertTrue(feedback['facts']['outcomePassed'])
        self.assertEqual(feedback['failureReasons'],[])
        text=json.dumps(feedback)
        for forbidden in ('binding','residual','104','family','expectedAnswer','correctTool'):
            self.assertNotIn(forbidden,text)
        task=dict(self.task,expression='3*(4*v+12)')
        wrong=self.check('3*(4*v+12)=3*4*v+3*12',self.combine,task)
        facts=audit.feedback_for(wrong)['facts']
        self.assertTrue(facts['writtenEqualityTrue'])
        self.assertFalse(facts['selectedToolSupported'])

    def test_complete_loop_rewards_fixed_routes_preserves_legacy_scores_and_freezes_heldout(self):
        original_response=legacy_tests.response
        def fixture_response(text,*args,**kwargs):
            # Synthetic analogue of the four actual false-negative originals.
            text=re.sub(r'1\s*\*\s*\((\d+)\s*\*\s*v\)\s*\+\s*2\s*\*\s*\((\d+)\s*\*\s*v\)',
                r'\1*v+2*\2*v',text)
            return original_response(text,*args,**kwargs)
        witness=legacy_tests.LabelIterationChecks('test_full_loop_writes_features_and_labels_and_keeps_all_originals')
        with patch.object(legacy_tests,'core',core),patch.object(legacy_tests,'response',fixture_response):
            witness.setUp()
            e=witness.exercise(language_protocol=core.NATURAL_LANGUAGE)
        saved=e['saved'];summary=core.summarize(saved['object'],saved['trial'])
        self.assertEqual(len(saved['raw']),68)
        self.assertEqual(len(saved['feature']),28)
        self.assertEqual(len(saved['update']),8)
        self.assertEqual(len(saved['label-version']),16)
        self.assertEqual(len(saved['object']),12)
        self.assertEqual(e['checkpoints']['initial']['head'],e['initial'])
        self.assertEqual(e['checkpoints']['final'],e['checkpoints']['training-final'])
        for obj in saved['object']:
            self.assertEqual(sum(obj['routeOutcomes']),1)
            if obj['task']['family']=='same_factor':
                self.assertEqual(obj['routeOutcomes'],[0,1,0])
                self.assertEqual(obj['legacyRouteOutcomes'],[0,0,0])
        for row in saved['raw']:
            if row['phase']=='training_zip_label_revision':
                self.assertIn('writtenEqualityTrue',row['studentPrompt'][1]['content'])
                self.assertIn('selectedToolSupported',row['studentPrompt'][1]['content'])
        self.assertFalse(summary['oldArchiveScoresChanged'])
        self.assertGreater(summary['heldoutByFamily']['same_factor']['expectedPassByArm'][core.ARMS[0]],0)
        self.assertEqual(summary['legacyStrictScoringOnSameNewOutputs']['heldoutByFamily']['same_factor']['expectedPassByArm'][core.ARMS[0]],0)

    def test_partial_rounds_reserve_new_seeds_without_matching_old_namespaces(self):
        with tempfile.TemporaryDirectory() as tmp:
            work=Path(tmp);out=work/'zip-label-feedback-fix-partial';out.mkdir()
            (out/'protocol.json').write_text(json.dumps(dict(protocol=core.NATURAL_PROTOCOL,iterationRound=4)))
            self.assertEqual(runtime.next_round(work,2),5)
            self.assertEqual(runtime.next_round(work,6),7)
        self.assertNotEqual(core.seed_for(3,1,51),legacy_tests.core.seed_for(3,1,51))
        self.assertGreater(core.seed_for(3,1,51),1_900_000_000)

    def test_unreviewed_legacy_and_fixture_sources_rejected_before_model_import(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp)
            for row in [dict(protocol=legacy_tests.core.NATURAL_PROTOCOL),
                        dict(protocol=core.NATURAL_PROTOCOL,fixtureOnly=True,stopReason='completed')]:
                (folder/'result.json').write_text(json.dumps(row))
                with self.assertRaises(ValueError):runtime.inspect_iteration(folder)
        self.assertNotIn('torch',sys.modules)
        self.assertFalse(any(n.startswith('transformers') for n in sys.modules))


    def test_resume_accepts_actual_float_reduction_noise_but_rejects_changed_results(self):
        # The real bab0e1a2 result and offline reduction differ by one binary ULP.
        saved=dict(objects=4, frozen=True, probability=0.4729283751011303)
        replay=dict(saved,probability=0.4729283751011302)
        self.assertTrue(runtime.summaries_match(replay,saved))
        for changed in (dict(saved,objects=5),dict(saved,frozen=False),
                        dict(saved,probability=saved['probability']+1e-8),
                        dict(saved,probability=float('nan')),
                        dict(saved,objects=4.0),dict(saved,extra=None)):
            self.assertFalse(runtime.summaries_match(changed,saved))
        self.assertTrue(runtime.summaries_match([replay],[saved]))
        self.assertFalse(runtime.summaries_match([replay,replay],[saved]))


if __name__=='__main__':unittest.main()
