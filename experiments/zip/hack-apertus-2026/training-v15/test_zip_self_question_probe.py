"""Offline fixtures only; they never constitute real student results."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import time
from contextlib import nullcontext
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

from zip_content_core import digest
from zip_label_metacognitive_checks import meta_messages
import zip_self_question_probe_checks as checks
import zip_self_question_probe_policy as policy
import zip_self_question_probe_run as runtime


def frame_fixture():
    body = dict(id='explicit-offline-training-frame', trainingObjects=8,
        metrics={name: .5 for name in checks.METRICS}, evidence=[dict(taskId='fixture-training-' + str(i),
            observationRecordId='fixture-observation-' + str(i), featureId='fixture-feature-' + str(i),
            mathRecordIds=['fixture-route-' + str(i) + '-' + str(j) for j in range(3)]) for i in range(8)],
        headHash='explicit-offline-head', heldoutIncluded=False, countsNotMultipliedBySeeds=True,
        questionsOrPlansSupplied=False)
    return dict(body, frameHash=digest(body))


def claim_fixture():
    return dict(metric='success_probability_mean', value=.5,
                question='Why is this score low?', plan='Inspect my recorded choices.')


def raw_lines(claim=None):
    claim = claim or claim_fixture()
    return '\n'.join(k + ': ' + (json.dumps(claim[k]) if k == 'value' else claim[k])
                     for k in checks.FIELDS) + '\n' + checks.END_MARKER


def output_fixture(raw, sampled=False, capped=False):
    return dict(raw=raw, generatedIds=[42, 43], generatedTokens=2, samplingTokenLogProbabilities=[-.2, -.3],
        samplingLogProbability=-.5, promptIds=[1, 2], sampled=sampled, temperature=.8 if sampled else 1.,
        tokenCapReached=capped, originalTextRepaired=False)


class ProbeChecks(unittest.TestCase):
    def setUp(self):
        self.frame = frame_fixture()

    def test_control_prompt_is_exact_original_and_all_tables_use_same_metrics(self):
        self.assertEqual(checks.messages(self.frame, 'original_json'), meta_messages(self.frame))
        for condition in checks.CONDITIONS[1:]:
            prompt = checks.messages(self.frame, condition)
            user = prompt[-1]['content']
            for name in checks.METRICS:
                self.assertIn(name + ' | 0.5000', user)
            combined = json.dumps(prompt)
            for forbidden in ('fixture-training-', 'same_factor', 'product_of_sum', 'Why is this score low?',
                              'Inspect my recorded choices.', 'fixture-route-'):
                self.assertNotIn(forbidden, combined)

    def test_preexisting_student_hypothesis_is_shared_by_every_condition(self):
        prior = dict(studentRaw='Explicit earlier student original.', id='fixture-meta')
        for condition in checks.CONDITIONS:
            self.assertIn(prior['studentRaw'], checks.messages(self.frame, condition, prior)[-1]['content'])

    def test_changed_or_heldout_frame_rejected_before_prompt_generation(self):
        for field, value in [('heldoutIncluded', True), ('questionsOrPlansSupplied', True), ('trainingObjects', 7)]:
            bad = copy.deepcopy(self.frame)
            bad[field] = value
            bad['frameHash'] = digest({k: v for k, v in bad.items() if k != 'frameHash'})
            with self.assertRaises(ValueError):
                checks.messages(bad, 'table_json')
        bad = copy.deepcopy(self.frame)
        bad['metrics']['success_probability_mean'] = .6
        with self.assertRaisesRegex(ValueError, 'hash'):
            checks.validate_frame(bad)

    def test_actual_copied_capped_input_stays_unparsed_without_repair(self):
        raw = ('{"frameId": "parent-training-readout", "metrics": {"choice_entropy_fraction": '
               '0.7686461351, "distinct_observation_fraction": 1.0, "observation_capped_fraction": 0.0, '
               '"observation_pending_fraction": 1.0, "observation_rejected_fraction": 0.0, "success_probability_mean": 0')
        original = output_fixture(raw, capped=True)
        before = copy.deepcopy(original)
        audit = checks.audit(original, self.frame, 'original_json')
        self.assertEqual(audit['reason'], 'capped_original')
        self.assertFalse(audit['accepted'])
        self.assertEqual(original, before)
        self.assertFalse(audit['originalTextRepaired'])

    def test_complete_json_and_actual_four_line_marker_preserve_student_words(self):
        for condition in checks.CONDITIONS:
            raw = raw_lines() if condition == 'table_lines' else json.dumps(claim_fixture())
            output = output_fixture(raw)
            original = copy.deepcopy(output)
            audit = checks.audit(output, self.frame, condition)
            self.assertTrue(audit['accepted'])
            self.assertEqual(audit['claim'], claim_fixture())
            self.assertEqual(audit['studentRawHash'], digest(raw))
            self.assertFalse(audit['wholeNaturalLanguageCertified'])
            self.assertTrue(audit['questionAndPlanRemainUntestedHypotheses'])
            self.assertFalse(audit['activatedAsPromptMetadata'])
            self.assertEqual(output, original)

    def test_false_number_boolean_nan_and_literal_false_plan_never_pass(self):
        for value, status in ((.6, 'rejected'), (True, 'pending'), (float('nan'), 'pending')):
            claim = dict(claim_fixture(), value=value)
            for condition in checks.CONDITIONS:
                raw = raw_lines(claim) if condition == 'table_lines' else json.dumps(claim)
                audit = checks.audit(output_fixture(raw), self.frame, condition)
                self.assertEqual(audit['status'], status)
                self.assertFalse(audit['accepted'])
        claim = dict(claim_fixture(), plan='v=2*v.')
        self.assertEqual(checks.audit(output_fixture(raw_lines(claim)), self.frame, 'table_lines')['status'], 'rejected')

    def test_extra_duplicate_missing_keys_prose_fences_and_unfinished_marker_stay_pending(self):
        originals = [raw_lines().replace(checks.END_MARKER, ''), raw_lines() + '\nextra',
                     raw_lines().replace('value: 0.5', 'value: 0.5\nvalue: 0.5'),
                     raw_lines().replace('plan: Inspect my recorded choices.', 'plan:'),
                     '```text\n' + raw_lines() + '\n```', raw_lines().replace(checks.END_MARKER, '[END_SELF_NOT')]
        for raw in originals:
            self.assertFalse(checks.audit(output_fixture(raw), self.frame, 'table_lines')['accepted'])
        for raw in [json.dumps(dict(claim_fixture(), extra='x')),
                    json.dumps(claim_fixture())[:-1], '{"metric":"a","metric":"b"}',
                    '```json\n' + json.dumps(claim_fixture()) + '\n```']:
            self.assertFalse(checks.audit(output_fixture(raw), self.frame, 'table_json')['accepted'])

    def test_word_and_question_boundaries_do_not_certify_unfinished_questions(self):
        for field, text in [('question', 'Unfinished statement'), ('question', 'word ' * 13 + '?'), ('plan', 'word ' * 17)]:
            claim = dict(claim_fixture(), **{field: text})
            self.assertFalse(checks.audit(output_fixture(raw_lines(claim)), self.frame, 'table_lines')['accepted'])


class ProbeLoopChecks(unittest.TestCase):
    def execute(self, fail=None, bad_original=False, expired=False, mutation=False):
        calls, saved, freezes = [], [], []
        def generate(prompt, condition, seed, sampled):
            calls.append((condition, seed, sampled))
            if fail is not None and len(calls) == fail:
                raise RuntimeError('Explicit fixture generation failure')
            raw = raw_lines() if condition == 'table_lines' else json.dumps(claim_fixture())
            value = output_fixture(raw, sampled=sampled)
            if bad_original:
                value['testDouble'] = True
            return value
        def frozen():
            freezes.append(True)
            if mutation and len(freezes) == 2:
                raise RuntimeError('Explicit fixture frozen state changed')
        def save(kind, row):
            saved.append((kind, copy.deepcopy(row)))
        try:
            rows = checks.run_probe(frame_fixture(), None, 1, generate, save, frozen, lambda: 0 if expired else 1)
            error = None
        except Exception as exc:
            rows = [r for kind, r in saved if kind == 'scored']
            error = exc
        return calls, saved, rows, error

    def test_six_predetermined_paired_calls_no_adaptive_retries_and_no_updates(self):
        calls, saved, rows, error = self.execute()
        self.assertIsNone(error)
        self.assertEqual(len(calls), 6)
        self.assertEqual([x[0] for x in calls[:3]], list(checks.CONDITIONS))
        self.assertEqual([x[0] for x in calls[3:]], list(reversed(checks.CONDITIONS)))
        self.assertEqual(len({x[1] for x in calls[:3]}), 1)
        self.assertEqual(len({x[1] for x in calls[3:]}), 1)
        self.assertNotEqual(calls[0][1], calls[-1][1])
        self.assertEqual([kind for kind, _ in saved], ['raw', 'scored', 'meta-zip'] * 6)
        summary = checks.summary(rows)
        self.assertEqual(summary['interfaceCandidatesForFurtherTesting'], list(checks.CONDITIONS[1:]))
        self.assertFalse(summary['automaticTrainingStarted'])
        self.assertFalse(any(r['activatedAsPromptMetadata'] for kind, r in saved if kind == 'meta-zip'))

    def test_generation_failure_preserves_first_three_and_no_complete_pairs_fabricated(self):
        calls, saved, rows, error = self.execute(fail=4)
        self.assertIsInstance(error, RuntimeError)
        self.assertEqual(len(calls), 4)
        self.assertEqual(len(rows), 3)
        summary = checks.summary(rows)
        self.assertEqual(summary['interfaceCandidatesForFurtherTesting'], [])
        self.assertTrue(all(not x['completePair'] and x['byDecodingMode']['sampled'] is None
                            for x in summary['byCondition'].values()))

    def test_deadline_prevents_generation_and_fixture_original_never_scores(self):
        calls, saved, rows, error = self.execute(expired=True)
        self.assertIsInstance(error, TimeoutError)
        self.assertEqual(calls, [])
        self.assertEqual(saved, [])
        calls, saved, rows, error = self.execute(bad_original=True)
        self.assertIsInstance(error, ValueError)
        self.assertEqual([kind for kind, _ in saved], ['raw'])
        self.assertEqual(rows, [])

    def test_returned_raw_saved_before_frozen_state_error(self):
        calls, saved, rows, error = self.execute(mutation=True)
        self.assertIsInstance(error, RuntimeError)
        self.assertEqual([kind for kind, _ in saved], ['raw'])
        self.assertEqual(rows, [])

    def test_partial_probe_number_reserved_and_namespaces_distinct(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / 'zip-self-question-probe-partial'
            folder.mkdir()
            (folder / 'protocol.json').write_text(json.dumps(dict(protocol=checks.PROTOCOL, probeNumber=3)))
            self.assertEqual(runtime.next_probe(tmp), 4)
        self.assertGreater(checks.seed_for(1, 1), 4_000_000_000)
        self.assertNotEqual(checks.seed_for(1, 1), checks.seed_for(2, 1))
        with self.assertRaises(ValueError):
            checks.seed_for(1001, 1)

    def test_source_fixture_rejected_before_any_model_import(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            (folder / 'result.json').write_text(json.dumps(dict(protocol='explicit-fixture', fixtureOnly=True)))
            args = SimpleNamespace(source=folder, out=folder / 'out', work=folder, student=folder, old_tools=folder)
            before = set(sys.modules)
            with self.assertRaises(ValueError):
                runtime.run(args)
            self.assertNotIn('torch', set(sys.modules) - before)
            self.assertFalse(args.out.exists())


def generated_lines_fixture(raw, cap, eos=False, sampled=False):
    class Prefix(list):
        def tolist(self):
            return list(self)
    class Distribution:
        def __init__(self, token):
            self.token = token
        def float(self):
            return self
        def __truediv__(self, x):
            return self
        def exp(self):
            return self
        def argmax(self):
            return self.token
        def __getitem__(self, token):
            return -.25
    class Logits:
        def __init__(self, token):
            self.token = token
        def __getitem__(self, index):
            return Distribution(self.token)
    class Base:
        generation_config = SimpleNamespace(eos_token_id=0)
        def parameters(self):
            return iter([SimpleNamespace(device='cpu')])
        def __init__(self):
            self.ids = iter(list(map(ord, raw)) + ([0] if eos else [ord('x')] * cap))
        def __call__(self, **kwargs):
            return SimpleNamespace(logits=Logits(next(self.ids)), past_key_values=None)
    torch, nn, functional = ModuleType('torch'), ModuleType('torch.nn'), ModuleType('torch.nn.functional')
    torch.nn = nn
    nn.functional = functional
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
        return policy.generate(Base(), tokenizer, [], 'table_lines', 7, sampled)


class ProbePolicyChecks(unittest.TestCase):
    def test_actual_marker_at_last_token_complete_all_log_probs_and_no_text_inserted(self):
        raw = 'metric: m\nvalue: 0\nquestion: Own?\nplan: Own.\n' + checks.END_MARKER
        output = generated_lines_fixture(raw + 'EXTRA', len(raw), sampled=True)
        self.assertEqual(output['raw'], raw)
        self.assertEqual(output['generatedIds'], list(map(ord, raw)))
        self.assertEqual(output['samplingTokenLogProbabilities'], [-.25] * len(raw))
        self.assertFalse(output['tokenCapReached'])
        self.assertTrue(output['studentEndMarkerReached'])
        self.assertFalse(output['originalTextRepaired'])

    def test_question_sentence_does_not_end_note_and_missing_marker_eos_stays_incomplete(self):
        raw = 'metric: m\nvalue: 0\nquestion: Own?\nplan: Own.'
        eos = generated_lines_fixture(raw, len(raw) + 1, eos=True)
        self.assertEqual(eos['raw'], raw)
        self.assertEqual(eos['generatedIds'][-1], 0)
        self.assertFalse(eos['studentEndMarkerReached'])
        self.assertEqual(eos['stopReason'], 'eos')
        self.assertFalse(eos['tokenCapReached'])
        capped = generated_lines_fixture(raw, len(raw))
        self.assertTrue(capped['tokenCapReached'])
        self.assertFalse(capped['studentEndMarkerReached'])

    def test_json_conditions_delegate_to_unchanged_v6_sampler(self):
        for condition in checks.CONDITIONS[:2]:
            with patch.object(policy, 'generate_meta', return_value={'raw': 'explicit fixture'}) as generator:
                policy.generate(None, None, [], condition, 7, False)
                generator.assert_called_once_with(None, None, [], 96, 7, sampled=False, temperature=1.)


if __name__ == '__main__':
    unittest.main()
