"""Offline edge cases and captured originals; never real student runs."""
import copy
import json
from pathlib import Path
import sys
import tempfile
from contextlib import nullcontext
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

from zip_content_core import digest
from test_zip_self_question_probe import frame_fixture, claim_fixture, output_fixture
from zip_self_question_probe_checks import messages as old_messages, audit as old_audit, END_MARKER
import zip_self_question_natural_checks as checks
import zip_self_question_natural_policy as policy
import zip_self_question_natural_run as runtime

ACTUAL_GREEDY = (
    'Metric: choice_entropy_fraction\nValue: 0.8147\n'
    'Question: What is the probability that a randomly chosen object is chosen by the top choice?\n\n'
    'Plan: Use a statistical software to calculate the probability of the top choice occurring.')
ACTUAL_SAMPLED = (
    'Metric: choice_entropy_fraction\nValue: 0.8147\n'
    'Question: What mathematical term or concept is used to describe the probability of a single '
    'observation being chosen from the options Thur, Ai, or the others?\n\n'
    'Plan: Analyze and measure the choice_entropy_fraction using computational tools to verify '
    'Thur, Ai, and the others are indeed correct.')


def raw_lines(claim=None):
    claim = claim or claim_fixture()
    return '\n'.join(k.capitalize() + ': ' + (json.dumps(claim[k]) if k == 'value' else claim[k])
                     for k in checks.FIELDS)


def output(raw=None, condition='natural_semantic', sampled=False, capped=False):
    value = output_fixture(raw or raw_lines(), sampled=sampled, capped=capped)
    value.update(stopReason='token_cap' if capped else 'eos', studentEndMarkerReached=False,
        mathAdapterEnabledDuringGeneration=False,
        semanticAdapterEnabledDuringGeneration=checks.semantic_enabled(condition))
    return value


class NaturalRecordChecks(unittest.TestCase):
    def setUp(self):
        self.frame = frame_fixture()

    def test_actual_two_eos_originals_are_readable_but_no_content_certificate_or_old_score_change(self):
        frame = copy.deepcopy(self.frame)
        frame['metrics']['choice_entropy_fraction'] = .8147421204
        frame['frameHash'] = digest({k: v for k, v in frame.items() if k != 'frameHash'})
        for raw in (ACTUAL_GREEDY, ACTUAL_SAMPLED):
            value = output(raw)
            before = copy.deepcopy(value)
            audit = checks.audit(value, frame)
            self.assertTrue(audit['reviewCandidate'])
            self.assertTrue(audit['sourceNumberVerified'])
            self.assertFalse(old_audit(value, frame, 'table_lines')['accepted'])
            for key in ('metricUnderstandingVerified', 'questionRelevanceVerified', 'planUsefulnessVerified',
                        'wholeNaturalLanguageCertified', 'activatedAsPromptMetadata', 'originalTextRepaired'):
                self.assertFalse(audit[key], key)
            self.assertEqual(audit['trainingCredit'], 0)
            self.assertEqual(value, before)
            self.assertEqual(audit['studentRawHash'], digest(raw))
            self.assertEqual(audit['literalFieldSpans']['question'], audit['claim']['question'])

    def test_natural_adapter_conditions_have_identical_prompt_and_legacy_exact_control(self):
        for previous in (None, dict(studentRaw='Earlier literal student hypothesis.')):
            self.assertEqual(checks.messages(self.frame, 'natural_semantic', previous),
                             checks.messages(self.frame, 'natural_base', previous))
            self.assertEqual(checks.messages(self.frame, 'legacy_lines', previous),
                             old_messages(self.frame, 'table_lines', previous))
        text = json.dumps(checks.messages(self.frame, 'natural_semantic'))
        for target in (claim_fixture()['question'], claim_fixture()['plan'], 'fixture-training-',
                       'same_factor', 'product_of_sum', 'Thur', 'Ai', 'semantic_adapter'):
            self.assertNotIn(target, text)

    def test_heldout_or_changed_frame_stops_before_any_prompt(self):
        for key, val in (('heldoutIncluded', True), ('questionsOrPlansSupplied', True), ('trainingObjects', 7)):
            frame = copy.deepcopy(self.frame)
            frame[key] = val
            frame['frameHash'] = digest({k: v for k, v in frame.items() if k != 'frameHash'})
            with self.assertRaises(ValueError):
                checks.messages(frame, 'natural_semantic')
        frame = copy.deepcopy(self.frame)
        frame['metrics']['success_probability_mean'] = .6
        with self.assertRaises(ValueError):
            checks.audit(output(), frame)

    def test_case_and_blank_spacing_are_allowed_without_rewriting_field_spans(self):
        raw = '\n  mEtRiC: success_probability_mean\n\nValue : 0.5000\n' + (
            'Question: Why is this score low?\n\n PLAN: Inspect my recorded choices.\n')
        value = output(raw)
        audit = checks.audit(value, self.frame)
        self.assertTrue(audit['reviewCandidate'])
        self.assertEqual(audit['literalFieldSpans']['value'], '0.5000')
        self.assertEqual(value['raw'], raw)

    def test_false_numeric_and_non_numeric_claims_stay_unusable(self):
        for val in (.6, True, float('nan'), float('inf'), '0.5', None):
            audit = checks.audit(output(raw_lines(dict(claim_fixture(), value=val))), self.frame)
            self.assertFalse(audit['reviewCandidate'])
            self.assertFalse(audit['sourceNumberVerified'])
        audit = checks.audit(output(raw_lines(dict(claim_fixture(), metric='invented_metric'))), self.frame)
        self.assertFalse(audit['reviewCandidate'])

    def test_complete_fields_with_token_cap_never_gain_completion_or_credit(self):
        value = output(capped=True)
        audit = checks.audit(value, self.frame)
        self.assertTrue(audit['sourceNumberVerified'])
        self.assertFalse(audit['reviewCandidate'])
        self.assertEqual(audit['reason'], 'capped_original')
        self.assertEqual(audit['trainingCredit'], 0.)

    def test_eos_and_punctuation_never_supply_missing_or_unfinished_prose(self):
        for raw in (raw_lines().split('\nPlan:')[0], raw_lines().replace('Plan: Inspect my recorded choices.', 'Plan:'),
                    raw_lines(dict(claim_fixture(), plan='Inspect my recorded')),
                    raw_lines(dict(claim_fixture(), question='Why is this score low'))):
            self.assertFalse(checks.audit(output(raw), self.frame)['reviewCandidate'])
        value = output()
        value['stopReason'] = 'host_punctuation'
        self.assertFalse(checks.audit(value, self.frame)['reviewCandidate'])

    def test_extra_duplicate_fenced_and_reordered_fields_never_parse(self):
        raw = raw_lines()
        bad = (raw + '\nExtra: x', raw.replace('Value: 0.5', 'Value: 0.5\nvalue: 0.5'),
               '```text\n' + raw + '\n```', raw.replace('Metric:', 'Unknown:'),
               raw.replace('Question:', 'Plan:').replace('Plan: Inspect', 'Question: Inspect'),
               raw + '\n' + END_MARKER + '\ntrailing prose')
        for text in bad:
            self.assertFalse(checks.audit(output(text), self.frame)['reviewCandidate'])

    def test_unknown_and_overlong_prose_get_no_usefulness_certificate(self):
        audit = checks.audit(output(raw_lines(dict(claim_fixture(), plan='Inspect Thur and Ai.'))), self.frame)
        self.assertTrue(audit['reviewCandidate'])
        self.assertFalse(audit['planUsefulnessVerified'])
        too_long = dict(claim_fixture(), question='word ' * 33 + '?')
        self.assertFalse(checks.audit(output(raw_lines(too_long)), self.frame)['reviewCandidate'])

    def test_known_false_literal_math_stays_rejected(self):
        audit = checks.audit(output(raw_lines(dict(claim_fixture(), plan='v=2*v.'))), self.frame)
        self.assertEqual(audit['status'], 'rejected')
        self.assertTrue(audit['boundedLiteralFalseEqualityDetected'])
        self.assertFalse(audit['reviewCandidate'])

    def test_actual_student_marker_is_separate_from_natural_eos(self):
        value = output(raw_lines() + '\n' + END_MARKER)
        value.update(stopReason='student_record_closure', studentEndMarkerReached=True)
        audit = checks.audit(value, self.frame)
        self.assertTrue(audit['reviewCandidate'])
        self.assertTrue(audit['actualEndMarkerPresent'])
        value['studentEndMarkerReached'] = False
        self.assertFalse(checks.audit(value, self.frame)['reviewCandidate'])


class NaturalLoopChecks(unittest.TestCase):
    def execute(self, fail=None, flag_error=False, mutation=False, expired=False, fixture=False):
        calls, saved, freezes = [], [], []
        def generate(prompt, condition, seed, sampled):
            calls.append((prompt, condition, seed, sampled))
            if fail == len(calls):
                raise RuntimeError('Explicit offline generator failure')
            value = output(condition=condition, sampled=sampled)
            if fixture:
                value['testDouble'] = True
            if flag_error:
                value['semanticAdapterEnabledDuringGeneration'] = not checks.semantic_enabled(condition)
            return value
        def frozen():
            freezes.append(True)
            if mutation and len(freezes) == 2:
                raise RuntimeError('Explicit offline frozen mutation')
        def save(kind, row):
            saved.append((kind, copy.deepcopy(row)))
        try:
            rows = checks.run_probe(frame_fixture(), None, 1, generate, save, frozen, lambda: 0 if expired else 1)
            error = None
        except Exception as exc:
            rows = [row for kind, row in saved if kind == 'scored']
            error = exc
        return calls, saved, rows, error

    def test_six_fixed_calls_native_adapter_pair_same_prompt_seed_and_no_activation(self):
        calls, saved, rows, error = self.execute()
        self.assertIsNone(error)
        self.assertEqual(len(calls), 6)
        self.assertEqual([r[1] for r in calls[:3]], list(checks.CONDITIONS))
        self.assertEqual([r[1] for r in calls[3:]], list(reversed(checks.CONDITIONS)))
        for slot in (calls[:3], calls[3:]):
            native = [x for x in slot if x[1] == 'natural_base'][0]
            adapted = [x for x in slot if x[1] == 'natural_semantic'][0]
            self.assertEqual(native[0], adapted[0])
            self.assertEqual(native[2:], adapted[2:])
        self.assertEqual([kind for kind, row in saved], ['raw', 'scored', 'meta-zip'] * 6)
        self.assertTrue(all(row['audit']['trainingCredit'] == 0 and not row['activatedAsPromptMetadata']
                            for kind, row in saved if kind == 'meta-zip'))
        self.assertTrue(all(row['legacyV1Check'] is not None for row in rows if row['condition'] == 'legacy_lines'))
        summary = checks.summary(rows)
        self.assertFalse(summary['automaticCandidateActivation'])
        self.assertFalse(summary['retrospectiveV1ScoresChanged'])

    def test_failure_keeps_three_real_returned_originals_no_completed_pairs(self):
        calls, saved, rows, error = self.execute(fail=4)
        self.assertIsInstance(error, RuntimeError)
        self.assertEqual(len(rows), 3)
        self.assertTrue(all(not x['completePair'] for x in checks.summary(rows)['byCondition'].values()))
        self.assertEqual(len([r for kind, r in saved if kind == 'raw']), 3)

    def test_wrong_actual_adapter_flag_and_fixture_save_raw_before_rejection(self):
        for kwargs in ({'flag_error': True}, {'fixture': True}):
            calls, saved, rows, error = self.execute(**kwargs)
            self.assertIsInstance(error, ValueError)
            self.assertEqual([kind for kind, row in saved], ['raw'])
            self.assertEqual(rows, [])

    def test_mutation_after_return_saves_original_but_never_scores(self):
        calls, saved, rows, error = self.execute(mutation=True)
        self.assertIsInstance(error, RuntimeError)
        self.assertEqual([kind for kind, row in saved], ['raw'])

    def test_deadline_prevents_generation(self):
        calls, saved, rows, error = self.execute(expired=True)
        self.assertIsInstance(error, TimeoutError)
        self.assertEqual(calls, [])
        self.assertEqual(saved, [])

    def test_partial_run_reserves_new_number_and_seed_namespace(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / 'zip-self-question-natural-partial'
            folder.mkdir()
            (folder / 'protocol.json').write_text(json.dumps(dict(protocol=checks.PROTOCOL, probeNumber=3)))
            self.assertEqual(runtime.next_probe(tmp), 4)
        from zip_self_question_probe_checks import seed_for as old_seed
        self.assertNotEqual(checks.seed_for(1, 1), old_seed(1, 1))
        self.assertNotEqual(checks.seed_for(1, 1), checks.seed_for(2, 1))
        with self.assertRaises(ValueError):
            checks.seed_for(1001, 1)

    def test_fixture_source_rejected_before_torch_import_or_output_creation(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            (folder / 'result.json').write_text(json.dumps(dict(protocol='explicit-fixture', fixtureOnly=True)))
            args = SimpleNamespace(source=folder, out=folder / 'out', work=folder, student=folder, old_tools=folder)
            before = set(sys.modules)
            with self.assertRaises(ValueError):
                runtime.run(args)
            self.assertNotIn('torch', set(sys.modules) - before)
            self.assertFalse(args.out.exists())


def generated_natural_fixture(raw, cap, eos=False, sampled=False):
    class Prefix(list):
        def tolist(self):
            return list(self)
    class Distribution:
        def __init__(self, token): self.token = token
        def float(self): return self
        def __truediv__(self, x): return self
        def exp(self): return self
        def argmax(self): return self.token
        def __getitem__(self, token): return -.25
    class Logits:
        def __init__(self, token): self.token = token
        def __getitem__(self, index): return Distribution(self.token)
    class Base:
        generation_config = SimpleNamespace(eos_token_id=0)
        def parameters(self): return iter([SimpleNamespace(device='cpu')])
        def __init__(self): self.ids = iter(list(map(ord, raw)) + ([0] if eos else [ord('x')] * cap))
        def __call__(self, **kwargs):
            return SimpleNamespace(logits=Logits(next(self.ids)), past_key_values=None)
    torch, nn, functional = ModuleType('torch'), ModuleType('torch.nn'), ModuleType('torch.nn.functional')
    torch.nn, nn.functional = nn, functional
    torch.Generator = lambda **kw: SimpleNamespace(manual_seed=lambda n: 'fixture-rng')
    torch.isfinite = lambda x: SimpleNamespace(all=lambda: True)
    torch.multinomial = lambda x, n, generator: x.token
    torch.tensor = lambda x, **kw: x
    torch.no_grad = lambda: nullcontext()
    functional.log_softmax = lambda x, dim: x
    generation = ModuleType('zip_generation_policy')
    generation.prompt_ids = lambda *args: [Prefix([1, 2])]
    tokenizer = SimpleNamespace(eos_token_id=0, decode=lambda ids, **kw: ''.join(chr(i) for i in ids if i))
    with patch.dict(sys.modules, {'torch': torch, 'torch.nn': nn, 'torch.nn.functional': functional,
                                 'zip_generation_policy': generation}), patch.object(policy, 'MAX_TOKENS', cap):
        return policy.generate(Base(), tokenizer, [], 'natural_semantic', 7, sampled)


class NaturalPolicyChecks(unittest.TestCase):
    def test_actual_eos_last_token_is_kept_with_all_logs_and_original_words(self):
        raw = 'Question: Own?\nPlan: Own.'
        value = generated_natural_fixture(raw, len(raw) + 1, eos=True, sampled=True)
        self.assertEqual(value['raw'], raw)
        self.assertEqual(value['generatedIds'], list(map(ord, raw)) + [0])
        self.assertEqual(value['samplingTokenLogProbabilities'], [-.25] * (len(raw) + 1))
        self.assertEqual(value['stopReason'], 'eos')
        self.assertFalse(value['tokenCapReached'])
        self.assertFalse(value['originalTextRepaired'])
        self.assertFalse(value['studentEndMarkerReached'])

    def test_sentence_period_does_not_stop_before_actual_eos_and_cap_never_invents_marker(self):
        raw = 'Question: Own?\nPlan: Own. More student words.'
        eos = generated_natural_fixture(raw, len(raw) + 1, eos=True)
        self.assertEqual(eos['raw'], raw)
        capped = generated_natural_fixture(raw, len(raw))
        self.assertTrue(capped['tokenCapReached'])
        self.assertNotIn(END_MARKER, capped['raw'])

    def test_legacy_control_delegates_to_unchanged_original_sampler(self):
        with patch.object(policy, 'legacy_generate', return_value={'raw': 'offline fixture'}) as generator:
            policy.generate(None, None, [], 'legacy_lines', 7, False)
            generator.assert_called_once_with(None, None, [], 'table_lines', 7, False)


if __name__ == '__main__':
    unittest.main()
