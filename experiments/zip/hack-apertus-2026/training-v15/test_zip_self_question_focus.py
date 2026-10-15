"""Offline v3 fixtures: they never become actual student result evidence."""
import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from zip_content_core import digest
from test_zip_self_question_probe import frame_fixture
import zip_self_question_focus_checks as checks
import zip_self_question_focus_policy as policy
import zip_self_question_focus_run as runtime


def output(raw, sampled=False, capped=False):
    return dict(raw=raw, generatedTokens=2, generatedIds=[42, 43], promptIds=[1, 2],
        samplingTokenLogProbabilities=[-.2, -.3], samplingLogProbability=-.5,
        sampled=sampled, temperature=.8 if sampled else 1., tokenCapReached=capped,
        stopReason='token_cap' if capped else 'eos', originalTextRepaired=False,
        mathAdapterEnabledDuringGeneration=False, semanticAdapterEnabledDuringGeneration=True)


def choice(raw=None, sampled=False, capped=False):
    return output(raw or 'Metric: choice_entropy_fraction\nValue: 0.5', sampled, capped)


class FocusChecks(unittest.TestCase):
    def setUp(self):
        self.frame = frame_fixture()
        self.choice = choice()
        self.choice_check = checks.choice_audit(self.choice, self.frame)

    def question(self, raw, capped=False):
        return checks.question_audit(output(raw, capped=capped), self.frame, self.choice, self.choice_check)

    def test_student_selects_metric_host_does_not_supply_weakness_question_or_plan(self):
        prompt = checks.choice_messages(self.frame)
        text = json.dumps(prompt)
        for token in ('fixture-training-', 'same_factor', 'product_of_sum', 'Why is this low?', 'Improve entropy'):
            self.assertNotIn(token, text)
        for name in checks.METRICS:
            self.assertIn(name + ' | 0.5000', prompt[-1]['content'])
        self.assertNotIn('Measurement definition', text)

    def test_question_stage_uses_actual_verified_choice_and_only_its_definition(self):
        prompt = checks.question_messages(self.frame, self.choice, self.choice_check)
        self.assertIn(self.choice['raw'], prompt[-1]['content'])
        self.assertIn(checks.MEASUREMENT_DEFINITIONS['choice_entropy_fraction'], prompt[-1]['content'])
        self.assertNotIn('Metric | Value', prompt[-1]['content'])
        self.assertNotIn(checks.MEASUREMENT_DEFINITIONS['success_probability_mean'], prompt[-1]['content'])
        self.assertNotIn('Why is choice_entropy_fraction low?', json.dumps(prompt))

    def test_labelled_json_and_actual_closed_json_fence_preserve_student_original(self):
        originals = ('Metric: choice_entropy_fraction\n\nVALUE : 0.5',
            '{"metric":"choice_entropy_fraction","value":0.5}',
            '```json\n{\n  "metric": "choice_entropy_fraction",\n  "value": 0.5\n}\n```')
        for raw in originals:
            value = choice(raw)
            before = copy.deepcopy(value)
            audit = checks.choice_audit(value, self.frame)
            self.assertTrue(audit['selectionVerified'])
            self.assertFalse(audit['originalTextRepaired'])
            self.assertEqual(value, before)
            self.assertEqual(audit['studentRawHash'], digest(raw))

    def test_wrong_number_unknown_metric_bool_nan_duplicate_extra_and_missing_fields_do_not_select(self):
        bad = ('Metric: choice_entropy_fraction\nValue: 0.6',
            'Metric: made_up\nValue: 0.5', 'Metric: choice_entropy_fraction\nValue: true',
            'Metric: choice_entropy_fraction\nValue: NaN', 'Metric: choice_entropy_fraction\nValue: "0.5"',
            '{"metric":"choice_entropy_fraction","value":0.5,"Value":0.5}',
            '{"metric":"choice_entropy_fraction","metric":"success_probability_mean","value":0.5}',
            '{"metric":"choice_entropy_fraction","value":0.5,"question":"Why?"}',
            'Metric: choice_entropy_fraction', 'Metric: choice_entropy_fraction\nValue:',
            '```json\n{"metric":"choice_entropy_fraction","value":0.5}',
            'Metric: choice_entropy_fraction\nValue: 0.5\nExplanation: x')
        for raw in bad:
            self.assertFalse(checks.choice_audit(choice(raw), self.frame)['selectionVerified'], raw)

    def test_capped_or_non_eos_choice_never_unlocks_question_even_with_closed_json(self):
        for value in (choice(capped=True), dict(choice(), stopReason='student_json_closure')):
            audit = checks.choice_audit(value, self.frame)
            self.assertFalse(audit['selectionVerified'])
            with self.assertRaises(ValueError):
                checks.question_messages(self.frame, value, audit)

    def test_changed_choice_certificate_cannot_select_another_metric(self):
        changed = copy.deepcopy(self.choice_check)
        changed['claim']['metric'] = 'success_probability_mean'
        with self.assertRaises(ValueError):
            checks.question_messages(self.frame, self.choice, changed)
        altered = choice('Metric: success_probability_mean\nValue: 0.5')
        with self.assertRaises(ValueError):
            checks.question_messages(self.frame, altered, self.choice_check)

    def test_false_or_heldout_training_frame_stops_before_generation(self):
        for key, val in (('heldoutIncluded', True), ('trainingObjects', 7), ('questionsOrPlansSupplied', True)):
            frame = copy.deepcopy(self.frame)
            frame[key] = val
            frame['frameHash'] = digest({k: v for k, v in frame.items() if k != 'frameHash'})
            with self.assertRaises(ValueError):
                checks.choice_messages(frame)
        frame = copy.deepcopy(self.frame)
        frame['metrics']['choice_entropy_fraction'] = .6
        with self.assertRaises(ValueError):
            checks.choice_audit(self.choice, frame)

    def test_readable_question_has_binding_only_never_semantic_certificate_credit_or_activation(self):
        raw = 'Question: Why is choice_entropy_fraction at this measured value?'
        audit = self.question(raw)
        self.assertTrue(audit['reviewCandidate'])
        self.assertTrue(audit['explicitlyNamesSelectedMetric'])
        self.assertFalse(audit['questionRelevanceVerified'])
        self.assertEqual(audit['semanticRelevanceStatus'], 'requires_human_review')
        self.assertFalse(audit['wholeNaturalLanguageCertified'])
        self.assertFalse(audit['metricUnderstandingVerified'])
        self.assertFalse(audit['activatedAsPromptMetadata'])
        self.assertEqual(audit['trainingCredit'], 0.)
        self.assertEqual(audit['studentRawHash'], digest(raw))

    def test_metric_keyword_in_irrelevant_question_is_not_misreported_as_semantic_success(self):
        audit = self.question('Does choice_entropy_fraction make the Moon turn into cheese?')
        self.assertTrue(audit['explicitlyNamesSelectedMetric'])
        self.assertTrue(audit['reviewCandidate'])
        self.assertFalse(audit['questionRelevanceVerified'])
        self.assertFalse(audit['metricUnderstandingVerified'])
        self.assertEqual(audit['trainingCredit'], 0.)

    def test_capped_missing_metric_multi_question_extra_fields_or_unfinished_text_stay_pending(self):
        for raw in ('Why is this low?', 'What is choice_entropy_fraction',
                    'Why choice_entropy_fraction? What next?',
                    'Metric: choice_entropy_fraction\nQuestion: Why?',
                    'Why choice_entropy_fraction?\nPlan: Change it.',
                    '```text\nWhy choice_entropy_fraction?\n```'):
            self.assertFalse(self.question(raw)['reviewCandidate'], raw)
        self.assertFalse(self.question('Why choice_entropy_fraction?', capped=True)['reviewCandidate'])
        value = output('Why choice_entropy_fraction?')
        value['stopReason'] = 'host_punctuation'
        self.assertFalse(checks.question_audit(value, self.frame, self.choice, self.choice_check)['reviewCandidate'])

    def test_known_false_literal_math_remains_rejected_without_repair(self):
        raw = 'v=2*v.\nWhy is choice_entropy_fraction at this value?'
        audit = self.question(raw)
        self.assertEqual(audit['status'], 'rejected')
        self.assertTrue(audit['boundedLiteralFalseEqualityDetected'])
        self.assertFalse(audit['originalTextRepaired'])

    def test_actual_d834_heading_copy_is_not_a_student_metric_selection(self):
        audit = checks.choice_audit(choice('Measured training record, eight objects.'), self.frame)
        self.assertFalse(audit['selectionVerified'])
        with self.assertRaises(ValueError):
            checks.question_messages(self.frame, choice('Measured training record, eight objects.'), audit)


class FocusLoopChecks(unittest.TestCase):
    def execute(self, bad_choice=False, fail=None, mutation=False, expired=False,
                expire_question=False, fixture=False, wrong_flags=False, wrong_logs=False):
        calls, saved, freezes = [], [], []
        def generate(prompt, phase, seed, sampled):
            calls.append((prompt, phase, seed, sampled))
            if fail == len(calls):
                raise RuntimeError('Explicit offline generator failure')
            value = (choice('Metric: invented\nValue: 0.5' if bad_choice else None, sampled)
                     if phase == 'metric_choice' else output('Why is choice_entropy_fraction at this value?', sampled))
            if fixture:
                value['testDouble'] = True
            if wrong_flags:
                value['semanticAdapterEnabledDuringGeneration'] = False
            if wrong_logs:
                value['samplingLogProbability'] = -.6
            return value
        def frozen():
            freezes.append(True)
            if mutation and len(freezes) == 2:
                raise RuntimeError('Explicit offline frozen mutation')
        def remaining():
            return 0 if expired or (expire_question and len(calls) == 1) else 1
        def save(kind, row):
            saved.append((kind, copy.deepcopy(row)))
        try:
            rows = checks.run_probe(frame_fixture(), 1, generate, save, frozen, remaining)
            error = None
        except Exception as exc:
            rows = [row for kind, row in saved if kind == 'attempt']
            error = exc
        return calls, saved, rows, error

    def test_fixed_three_attempts_two_phases_fresh_seeds_mode_schedule_and_raw_first(self):
        calls, saved, rows, error = self.execute()
        self.assertIsNone(error)
        self.assertEqual([r[1] for r in calls], list(checks.PHASES) * 3)
        self.assertEqual([r[3] for r in calls], [False, False, True, True, True, True])
        self.assertEqual(len({r[2] for r in calls}), 6)
        self.assertEqual([kind for kind, row in saved], ['raw', 'scored', 'raw', 'scored', 'attempt', 'meta-zip'] * 3)
        self.assertTrue(all(row['sourceChoiceRecordId'] for kind, row in saved
                            if kind == 'raw' and row['phase'] == 'metric_question'))
        self.assertTrue(all(not row['activatedAsPromptMetadata'] and row['trainingCredit'] == 0.
                            for kind, row in saved if kind == 'meta-zip'))
        summary = checks.summary([r for kind, r in saved if kind == 'scored'], rows)
        self.assertEqual(summary['reviewCandidates'], 3)
        self.assertEqual(summary['semanticRelevanceVerified'], 0)
        self.assertEqual(summary['distinctStudentChosenMetrics'], ['choice_entropy_fraction'])

    def test_invalid_selection_skips_only_question_no_host_fallback_and_only_three_calls(self):
        calls, saved, rows, error = self.execute(bad_choice=True)
        self.assertIsNone(error)
        self.assertEqual(len(calls), 3)
        self.assertTrue(all(c[1] == 'metric_choice' for c in calls))
        self.assertTrue(all(r['questionSkipped'] for r in rows))
        self.assertFalse(any(kind == 'meta-zip' for kind, row in saved))
        summary = checks.summary([r for kind, r in saved if kind == 'scored'], rows)
        self.assertEqual(summary['processedAttempts'], 3)
        self.assertEqual(summary['questionResponses'], 0)

    def test_question_failure_keeps_choice_without_fabricating_completed_attempt(self):
        calls, saved, rows, error = self.execute(fail=2)
        self.assertIsInstance(error, RuntimeError)
        self.assertEqual([kind for kind, row in saved], ['raw', 'scored'])
        self.assertEqual(rows, [])

    def test_deadline_before_choice_or_question_prevents_dependent_model_call(self):
        for kw, kinds in ((dict(expired=True), []), (dict(expire_question=True), ['raw', 'scored'])):
            calls, saved, rows, error = self.execute(**kw)
            self.assertIsInstance(error, TimeoutError)
            self.assertEqual([kind for kind, row in saved], kinds)
            self.assertEqual(rows, [])

    def test_frozen_mutation_fixture_wrong_adapter_and_changed_log_sum_keep_returned_raw_only(self):
        for kw in (dict(mutation=True), dict(fixture=True), dict(wrong_flags=True), dict(wrong_logs=True)):
            calls, saved, rows, error = self.execute(**kw)
            self.assertIsNotNone(error)
            self.assertEqual([kind for kind, row in saved], ['raw'])
            self.assertEqual(rows, [])

    def test_partial_focus_number_reserved_and_namespace_does_not_reuse_old_seeds(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / 'zip-self-question-focus-partial'
            folder.mkdir()
            (folder / 'protocol.json').write_text(json.dumps(dict(protocol=checks.PROTOCOL, probeNumber=3)))
            self.assertEqual(runtime.next_probe(tmp), 4)
        from zip_self_question_natural_checks import seed_for as old_seed
        self.assertNotEqual(checks.seed_for(1, 1, 'metric_choice'), old_seed(1, 1))
        self.assertNotEqual(checks.seed_for(1, 1, 'metric_choice'), checks.seed_for(2, 1, 'metric_choice'))
        with self.assertRaises(ValueError):
            checks.seed_for(1001, 1, 'metric_question')

    def test_fixture_source_rejected_before_model_import_and_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            (folder / 'result.json').write_text(json.dumps(dict(protocol='explicit-fixture', fixtureOnly=True)))
            args = SimpleNamespace(source=folder, out=folder / 'out', work=folder, student=folder, old_tools=folder)
            before = set(sys.modules)
            with self.assertRaises(ValueError):
                runtime.run(args)
            self.assertNotIn('torch', set(sys.modules) - before)
            self.assertFalse(args.out.exists())

    def test_both_phases_use_unchanged_eos_sampler_without_grammar_forcing(self):
        for phase in checks.PHASES:
            with patch.object(policy, 'unchanged_generate', return_value={'raw': 'offline fixture'}) as sampler:
                policy.generate(None, None, [], phase, 7, True)
                sampler.assert_called_once_with(None, None, [], 'natural_semantic', 7, True)


if __name__ == '__main__':
    unittest.main()
