"""Offline checks only. No fixture is a model output or training result."""
import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

from zip_content_core import digest
from zip_label_metacognitive_checks import StableHead, metric_frame
from zip_label_metacognitive_core import measured_item
from zip_label_feedback_audit import audit_math
from test_zip_label import roots_fixture
import zip_self_question_tools_core as core
import zip_self_question_tools_policy as policy
import zip_self_question_tools_run as runtime
from draft_inspect_runtime import sha


def output(raw, sampled=False, capped=False):
    # Synthetic return object used solely inside unittest, as in prior tests.
    return dict(raw=raw, generatedTokens=3, generatedIds=[101, 102, 103], promptIds=[5, 6],
        samplingTokenLogProbabilities=[-.1, -.2, -.3], samplingLogProbability=-.6,
        sampled=sampled, tokenCapReached=capped, stopReason='token_cap' if capped else 'eos',
        mathAdapterEnabledDuringGeneration=False, semanticAdapterEnabledDuringGeneration=True)


def fixture(all_failed=False):
    anchors, routes = [], {}
    roots = roots_fixture()
    candidates = [dict(id='DIRECT', kind='direct'),
        dict(id=roots[0]['id'], kind='combine', root=roots[0]),
        dict(id=roots[1]['id'], kind='distribute', root=roots[1])]
    for number in range(1, 9):
        expr = '1*(' + str(number) + '*v)+2*(' + str(number) + '*v)'
        task = dict(id='explicit-offline-task-' + str(number), expression=expr,
            question='Rewrite ' + expr + '.', split='training', family='hidden_fixture_family')
        raw = ('v=2*v.' if number <= 4 else 'I am unsure about task ' + str(number) + '.' if number <= 7 else
            'The current object is ' + expr + '.')
        obs = dict(recordId='explicit-offline-observation-' + str(number), task=task,
            studentOutput=output(raw, capped=number == 7), fixtureOnly=False)
        ids, outcomes = [], []
        for index, candidate in enumerate(candidates):
            rid = 'explicit-offline-route-' + str(number) + '-' + str(index)
            math_raw = ('SKIP' if all_failed or index == 2 or (number % 3 == 0 and index == 0) else
                expr + '=3*(' + str(number) + '*v)')
            value = output(math_raw)
            check = audit_math(task, value, candidate)
            row = dict(recordId=rid, task=task, selectedCandidate=candidate, studentOutput=value,
                studentPrompt=[dict(role='system', content='Rewrite the given expression using this requested method.')],
                check=check, fixtureOnly=False, hostSpecifiedRoute=True)
            routes[task['id'] + '/' + rid] = row
            ids.append(rid)
            outcomes.append(int(check['outcomePassed']))
        anchors.append(measured_item(task, obs, [[0.], [number / 8], [-number / 16]],
            'explicit-offline-feature-' + str(number), outcomes, ids))
    head = StableHead([.5])
    frame = metric_frame(anchors, head, 'explicit-offline-eight-history-frame')
    bundle = core.make_bundle(anchors, head.state(), frame, routes)
    bank = core.build_bank(sha(Path(core.__file__)))
    return bundle, bank


class ToolChecks(unittest.TestCase):
    def setUp(self):
        self.bundle, self.bank = fixture()

    def test_current_request_follows_every_history_without_supplying_an_observation_or_metric(self):
        before = copy.deepcopy(self.bundle)
        journal = core.journal_text(self.bundle)
        messages = core.review_messages(self.bundle)
        text = messages[-1]['content']
        start = text.index('Past program-assigned actions')
        end = text.index('\n\nEnd of saved histories.\n')
        self.assertEqual(text[start:end], journal)
        self.assertLess(text.index('H8 goal:'), end)
        self.assertTrue(text.endswith(core.REVIEW_REQUEST))
        request = text[end:]
        self.assertIn('one short sentence', request)
        self.assertIn('your own words', request)
        for tool in self.bank['tools']:
            self.assertNotIn(tool['operation'], request)
            self.assertNotIn(tool['id'], request)
        self.assertNotIn('I notice', request)
        self.assertNotIn('Why', request)
        self.assertEqual(self.bundle, before)

    def test_assessment_sees_all_eight_original_goals_words_actions_and_successes_and_failures(self):
        prompt = json.dumps(core.review_messages(self.bundle), ensure_ascii=False)
        text = core.review_messages(self.bundle)[1]['content']
        self.assertNotIn('Metric | Value', prompt)
        self.assertNotIn('Available measurement', prompt)
        self.assertNotIn('hidden_fixture_family', prompt)
        for key in self.bundle['privateSourceFrame']['metrics']:
            self.assertNotIn(key, prompt)
        for history in self.bundle['journal']:
            self.assertIn(json.dumps(history['goal']), text)
            self.assertIn(json.dumps(history['observationStudentRaw']), text)
            for route in history['routes']:
                self.assertIn(json.dumps(route['studentRaw']), text)
        self.assertIn('Task verifier passed: true', text)
        self.assertIn('Task verifier passed: false', text)

    def test_catalogue_has_tools_and_definitions_without_results_directions_or_question_targets(self):
        original = output('I notice that my attempts have different results.')
        prompt = core.call_messages(self.bundle, self.bank, original, 1, 1)
        catalog = prompt[1]['content'].split('Available measurement ZIPs, definitions only:\n')[1].split('\nYour saved histories:')[0]
        self.assertEqual(len(catalog.splitlines()), 7)
        self.assertNotIn('Value:', catalog)
        self.assertNotIn('Why', catalog)
        self.assertIn(original['raw'], prompt[1]['content'])
        self.assertNotEqual([t['id'] for t in core.ordered_tools(self.bank, 1, 1)],
                            [t['id'] for t in core.ordered_tools(self.bank, 1, 2)])
        for tool in self.bank['tools']:
            self.assertFalse(tool['studentDiscovery'])
            self.assertFalse(tool['measuredResultsStored'])
            self.assertFalse(tool['preferredDirectionSupplied'])

    def test_actual_single_call_does_not_require_copying_a_number_and_preserves_presentation(self):
        for raw in ('CALL Z6', 'z6', 'Use Z6.', 'ZIP: Z6'):
            value = output(raw)
            before = copy.deepcopy(value)
            check = core.call_audit(value, self.bank)
            self.assertTrue(check['callVerified'])
            self.assertEqual(check['zipId'], 'Z6')
            self.assertEqual(value, before)
            self.assertFalse(check['numberCopyRequired'])

    def test_multiple_unknown_truncated_number_only_or_interface_tail_calls_stay_pending(self):
        for raw in ('CALL Z2\nCALL Z3', 'CALL Z9', 'CALL', '0.8147',
                    'CALL Z6[{"display_answers":1}]', 'Why CALL Z6?', 'Z1: good; Z2: bad'):
            self.assertFalse(core.call_audit(output(raw), self.bank)['callVerified'], raw)
        self.assertFalse(core.call_audit(output('CALL Z6', capped=True), self.bank)['callVerified'])
        value = output('CALL Z6'); value['stopReason'] = 'host_closed_text'
        self.assertFalse(core.call_audit(value, self.bank)['callVerified'])
        self.assertTrue(core.call_audit(output('NONE'), self.bank)['declined'])

    def test_each_selected_kernel_matches_independent_existing_measurement_for_all_eight_objects(self):
        for tool in self.bank['tools']:
            value = output('CALL ' + tool['id'])
            result = core.execute_tool(self.bundle, self.bank, value, core.call_audit(value, self.bank))
            expected = self.bundle['privateSourceFrame']['metrics'][tool['operation']]
            self.assertEqual(result['value'], expected)
            self.assertEqual(len(result['evidence']), 8)
            self.assertEqual(result['trainingObjects'], 8)
            self.assertFalse(result['otherMetricResultsSupplied'])
            self.assertFalse(result['heldoutIncluded'])

    def test_success_probability_uses_all_successful_routes_and_all_failed_histories_return_zero(self):
        value = output('CALL Z1')
        result = core.execute_tool(self.bundle, self.bank, value, core.call_audit(value, self.bank))
        self.assertTrue(any(sum(w['verifiedRouteOutcomes']) > 1 for w in result['evidence']))
        for witness in result['evidence']:
            self.assertAlmostEqual(witness['component'], sum(p * y for p, y in
                zip(witness['probabilities'], witness['verifiedRouteOutcomes'])))
        failed, bank = fixture(all_failed=True)
        self.assertEqual(core.execute_tool(failed, bank, value, core.call_audit(value, bank))['value'], 0.)

    def test_false_or_heldout_frames_and_rehashed_changed_journal_are_rejected(self):
        broken = copy.deepcopy(self.bundle)
        broken['privateSourceFrame']['metrics']['success_probability_mean'] = 1.
        with self.assertRaises(ValueError):core.review_messages(broken)
        broken = copy.deepcopy(self.bundle); broken['anchors'][0]['task']['split'] = 'heldout'
        broken['bundleHash'] = digest({k:v for k,v in broken.items() if k != 'bundleHash'})
        with self.assertRaises(ValueError):core.review_messages(broken)
        broken = copy.deepcopy(self.bundle); broken['journal'][0]['observationStudentRaw'] = 'Host supplied diagnosis.'
        broken['bundleHash'] = digest({k:v for k,v in broken.items() if k != 'bundleHash'})
        with self.assertRaises(ValueError):core.review_messages(broken)

    def test_changed_bank_call_certificate_result_or_wrong_task_cannot_unlock_question(self):
        call = output('CALL Z6'); check = core.call_audit(call, self.bank)
        result = core.execute_tool(self.bundle, self.bank, call, check)
        review = output('I notice different results.')
        for altered in (dict(result, value=.1), dict(result, zipId='Z1')):
            with self.assertRaises(ValueError):core.question_messages(self.bundle, self.bank, review, call, check, altered)
        with self.assertRaises(ValueError):core.execute_tool(self.bundle, self.bank, call, dict(check, zipId='Z1'))
        bank = copy.deepcopy(self.bank); bank['tools'][0]['description'] = 'Choose this weakness.'
        with self.assertRaises(ValueError):core.call_audit(call, bank)
        bundle = copy.deepcopy(self.bundle); bundle['routes'][next(iter(bundle['routes']))]['check']['outcomePassed'] = False
        bundle['bundleHash'] = digest({k:v for k,v in bundle.items() if k != 'bundleHash'})
        with self.assertRaises(ValueError):core.execute_tool(bundle, self.bank, call, check)

    def test_question_has_actual_result_and_review_without_a_number_copy_gate_or_required_keyword(self):
        review, call = output('Some attempts differ.'), output('CALL Z6')
        result = core.execute_tool(self.bundle, self.bank, call, core.call_audit(call, self.bank))
        prompt = core.question_messages(self.bundle, self.bank, review, call, core.call_audit(call, self.bank), result)
        self.assertIn(review['raw'], prompt[1]['content'])
        self.assertIn('CALL Z6', prompt[1]['content'])
        self.assertIn(json.dumps(core.measurement_presentation(result), ensure_ascii=False), prompt[1]['content'])
        for name in self.bundle['privateSourceFrame']['metrics']:
            if name != result['metricKey']:self.assertNotIn(name, prompt[1]['content'])
        check = core.note_audit(output('Why did my attempts produce different outcomes?'), 'experience_question')
        self.assertTrue(check['reviewCandidate'])
        self.assertFalse(check['questionRelevanceVerified'])
        self.assertEqual(check['trainingCredit'], 0.)

    def test_irrelevant_but_readable_questions_never_receive_semantic_success_or_activation(self):
        check = core.note_audit(output('Is Z6 made from moon cheese?'), 'experience_question')
        self.assertTrue(check['reviewCandidate'])
        self.assertFalse(check['wholeNaturalLanguageCertified'])
        self.assertFalse(check['questionRelevanceVerified'])
        self.assertFalse(check['activatedAsPromptMetadata'])
        self.assertEqual(check['trainingCredit'], 0.)

    def test_caps_missing_eos_multiple_questions_and_extra_fields_do_not_pass(self):
        for value in (output('My assessment.', capped=True), output('')):
            self.assertFalse(core.note_audit(value, 'experience_review')['readableOriginal'])
        value = output('My assessment.'); value['stopReason'] = 'host_punctuation'
        self.assertFalse(core.note_audit(value, 'experience_review')['readableOriginal'])
        for raw in ('Why this', 'Why this? What next?', 'Why this?\nPlan: change everything.'):
            self.assertFalse(core.note_audit(output(raw), 'experience_question')['reviewCandidate'])
        value = output('Why this?', capped=True)
        self.assertFalse(core.note_audit(value, 'experience_question').get('reviewCandidate', False))

    def test_reflection_can_quote_a_previous_error_without_regrading_math_or_certifying_the_claim(self):
        raw = 'v=2*v.\nI want to investigate why I wrote this wrong equation.'
        value = output(raw)
        before = copy.deepcopy(value)
        check = core.note_audit(value, 'experience_review')
        self.assertTrue(check['readableOriginal'])
        self.assertTrue(check['literalFalseEqualityPresent'])
        self.assertFalse(check['literalAssertionIntentVerified'])
        self.assertFalse(check['wholeNaturalLanguageCertified'])
        self.assertFalse(check['sourceMathematicalScoresChanged'])
        self.assertFalse(check['activatedAsPromptMetadata'])
        self.assertEqual(check['trainingCredit'], 0.)
        self.assertEqual(value, before)


class ToolLoopChecks(unittest.TestCase):
    def execute(self, call_raw='CALL Z6', review_cap=False, fail=None, expiry=None, mutate=False,
                fixture_return=False, wrong_flags=False, wrong_logs=False, bad_tool_return=False):
        bundle, bank = fixture()
        calls, saved, executions, freezes = [], [], [], []
        def generate(prompt, phase, seed, sampled):
            calls.append((prompt, phase, seed, sampled))
            if fail == len(calls):raise RuntimeError('Explicit offline generation failure')
            texts = {'experience_review':'I notice different task results.', 'metric_zip_call':call_raw,
                     'experience_question':'Why did my task attempts produce different outcomes?'}
            value = output(texts[phase], sampled, capped=review_cap and phase == 'experience_review')
            if fixture_return:value['testDouble'] = True
            if wrong_flags:value['semanticAdapterEnabledDuringGeneration'] = False
            if wrong_logs:value['samplingLogProbability'] = 1.
            return value
        def frozen():
            freezes.append(True)
            if mutate and len(freezes) == 2:raise RuntimeError('Explicit offline frozen mutation')
        def remaining():
            return 0 if expiry is not None and len(calls) >= expiry else 1
        def measure(b, k, out, check):
            executions.append(len(calls))
            value = core.execute_tool(b, k, out, check)
            return dict(value, value=.123) if bad_tool_return else value
        def save(kind, row):saved.append((kind, copy.deepcopy(row)))
        try:
            rows = core.run_probe(bundle, bank, 1, generate, save, frozen, remaining, measure)
            error = None
        except Exception as exc:
            rows, error = [r for kind,r in saved if kind == 'attempt'], exc
        return calls, saved, executions, rows, error

    def test_two_fixed_three_phase_attempts_execute_only_after_student_calls_and_save_raw_first(self):
        calls, saved, executions, rows, error = self.execute()
        self.assertIsNone(error)
        self.assertEqual([c[1] for c in calls], list(core.PHASES) * 2)
        self.assertEqual([c[3] for c in calls], [False] * 3 + [True] * 3)
        self.assertEqual(len({c[2] for c in calls}), 6)
        self.assertEqual(executions, [2, 5])
        self.assertEqual([k for k,r in saved],
            ['raw','scored','raw','scored','tool-returned','tool-executed','raw','scored','attempt','meta-zip'] * 2)
        self.assertTrue(all(not r['activatedAsPromptMetadata'] for k,r in saved if k == 'meta-zip'))
        summary = core.summary([r for k,r in saved if k == 'scored'], rows,
                               [r for k,r in saved if k == 'tool-executed'])
        self.assertEqual(summary['actualMeasurementZipExecutions'], 2)
        self.assertEqual(summary['reviewCandidates'], 2)
        self.assertEqual(summary['problemDiscoveryVerified'], 0)
        self.assertEqual(summary['semanticQuestionRelevanceVerified'], 0)

    def test_invalid_or_declined_calls_do_not_execute_a_host_fallback_or_retry(self):
        for raw in ('Z6 and Z1', 'NONE'):
            calls, saved, executions, rows, error = self.execute(call_raw=raw)
            self.assertIsNone(error)
            self.assertEqual(len(calls), 4)
            self.assertEqual(executions, [])
            self.assertTrue(all(r['questionSkipped'] for r in rows))
            self.assertFalse(any(k == 'meta-zip' for k,r in saved))

    def test_capped_assessment_skips_catalogue_tool_and_question_without_completion_repair(self):
        calls, saved, executions, rows, error = self.execute(review_cap=True)
        self.assertIsNone(error)
        self.assertEqual(len(calls), 2)
        self.assertEqual(executions, [])
        self.assertTrue(all(r['questionSkipped'] for r in rows))

    def test_failure_preserves_prior_originals_and_return_without_fabricating_completed_attempt(self):
        calls, saved, executions, rows, error = self.execute(fail=3)
        self.assertIsInstance(error, RuntimeError)
        self.assertEqual([k for k,r in saved], ['raw','scored','raw','scored','tool-returned','tool-executed'])
        self.assertEqual(rows, [])

    def test_deadline_before_review_call_tool_execution_or_question_prevents_dependent_action(self):
        for expiry, count, tools in ((0,0,0),(1,1,0),(2,2,0)):
            calls,saved,executions,rows,error = self.execute(expiry=expiry)
            self.assertIsInstance(error, TimeoutError)
            self.assertEqual(len(calls), count)
            self.assertEqual(len(executions), tools)
            self.assertEqual(rows, [])

    def test_frozen_mutation_fixtures_flags_and_log_probability_changes_save_only_raw(self):
        for kw in (dict(mutate=True), dict(fixture_return=True), dict(wrong_flags=True), dict(wrong_logs=True)):
            calls,saved,executions,rows,error = self.execute(**kw)
            self.assertIsNotNone(error)
            self.assertEqual([k for k,r in saved], ['raw'])
            self.assertEqual(rows, [])

    def test_wrong_actual_tool_return_is_retained_but_never_unlocks_question(self):
        calls,saved,executions,rows,error = self.execute(bad_tool_return=True)
        self.assertIsInstance(error, ValueError)
        self.assertEqual(len(calls), 2)
        self.assertEqual([k for k,r in saved][-1], 'tool-returned')
        self.assertFalse(any(k == 'tool-executed' for k,r in saved))
        self.assertEqual(rows, [])

    def test_fixture_source_rejected_before_model_import_or_output_creation(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            (folder/'result.json').write_text(json.dumps(dict(protocol='explicit-offline-fixture', fixtureOnly=True)))
            before = set(sys.modules)
            with self.assertRaises(ValueError):runtime.run(SimpleNamespace(source=folder, out=folder/'out',
                work=folder, student=folder, old_tools=folder))
            self.assertFalse((folder/'out').exists())
            self.assertNotIn('torch', set(sys.modules)-before)

    def test_partial_numbers_reserved_and_seed_namespace_distinct_from_prior_probes(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)/'zip-self-question-tools-partial'; folder.mkdir()
            (folder/'protocol.json').write_text(json.dumps(dict(protocol=core.PROTOCOL, probeNumber=3)))
            self.assertEqual(runtime.next_probe(tmp), 4)
        from zip_self_question_focus_checks import seed_for as prior_seed
        self.assertNotEqual(core.seed_for(1,1,'experience_review'), prior_seed(1,1,'metric_choice'))
        self.assertNotEqual(core.seed_for(1,1,'experience_review'), core.seed_for(2,1,'experience_review'))
        with self.assertRaises(ValueError):core.seed_for(1001,1,'experience_review')

    def test_all_three_phases_use_unchanged_sampler_without_forced_grammar_or_stop_marker(self):
        for phase in core.PHASES:
            with patch.object(policy, 'unchanged_generate', return_value={'raw':'explicit fixture'}) as sampler:
                policy.generate(None,None,[],phase,7,True)
                sampler.assert_called_once_with(None,None,[],'natural_semantic',7,True)

    def test_actual_native_zip_roots_and_bound_kernel_are_validated_and_tampering_is_detected(self):
        _,bank = fixture()
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)/'measurement-zips'
            manifest = runtime.write_tool_zips(folder,bank)
            self.assertEqual(len(manifest),8)
            for tool in bank['tools']:runtime.validate_tool_file(folder,bank,tool['id'])
            with zipfile.ZipFile(folder/'Z6.zip','w') as archive:
                archive.writestr('root.json',json.dumps(bank['tools'][5]))
                archive.writestr('kernel.py','Changed measurement kernel.')
                archive.writestr('README.txt','explicit tampered fixture')
            with self.assertRaises(ValueError):runtime.validate_tool_file(folder,bank,'Z6')


class CompletionReportingChecks(unittest.TestCase):
    def records(self, **kwargs):
        _, saved, _, attempts, error = ToolLoopChecks().execute(**kwargs)
        raw = [r for kind,r in saved if kind == 'raw']
        scored = [r for kind,r in saved if kind == 'scored']
        tools = [r for kind,r in saved if kind == 'tool-executed']
        return raw, scored, attempts, tools, error

    def test_two_capped_reviews_finish_runner_but_neither_three_stage_attempt(self):
        raw, scored, attempts, tools, error = self.records(review_cap=True)
        self.assertIsNone(error)
        before = copy.deepcopy((raw, scored, attempts, tools))
        status = core.completion_status('completed', raw, scored, attempts, tools)
        self.assertTrue(status['runCompletedNormally'])
        self.assertTrue(status['allScheduledAttemptsProcessed'])
        self.assertTrue(status['allReturnedResponsesAudited'])
        self.assertEqual(status['completedThreeStageAttempts'], 0)
        self.assertFalse(status['completeExperienceToolExperiment'])
        self.assertEqual(core.summary(scored, attempts, tools)['completedThreeStageAttempts'], 0)
        self.assertEqual((raw, scored, attempts, tools), before)

    def test_six_bound_complete_originals_report_pipeline_only_without_semantic_credit(self):
        raw, scored, attempts, tools, error = self.records()
        self.assertIsNone(error)
        status = core.completion_status('completed', raw, scored, attempts, tools)
        self.assertEqual(status['completedThreeStageAttempts'], 2)
        self.assertTrue(status['completeExperienceToolExperiment'])
        self.assertTrue(status['completionDoesNotCertifySemanticRelevance'])
        readout = core.summary(scored, attempts, tools)
        self.assertEqual(readout['completedThreeStageAttempts'], 2)
        for key in ('problemDiscoveryVerified', 'semanticQuestionRelevanceVerified', 'trainingUpdates'):
            self.assertEqual(readout[key], 0)

    def test_decline_and_invalid_calls_do_not_become_complete_experiments(self):
        for call in ('NONE', 'Z6 and Z1'):
            raw, scored, attempts, tools, error = self.records(call_raw=call)
            self.assertIsNone(error)
            status = core.completion_status('completed', raw, scored, attempts, tools)
            self.assertTrue(status['allScheduledAttemptsProcessed'])
            self.assertEqual(len(raw), 4)
            self.assertEqual(status['completedThreeStageAttempts'], 0)
            self.assertFalse(status['completeExperienceToolExperiment'])

    def test_failure_with_saved_call_and_result_does_not_fabricate_a_question_or_attempt(self):
        raw, scored, attempts, tools, error = self.records(fail=3)
        self.assertIsInstance(error, RuntimeError)
        status = core.completion_status('error', raw, scored, attempts, tools)
        self.assertFalse(status['runCompletedNormally'])
        self.assertFalse(status['allScheduledAttemptsProcessed'])
        self.assertEqual(len(raw), 2)
        self.assertEqual(len(tools), 1)
        self.assertEqual(status['completedThreeStageAttempts'], 0)
        self.assertFalse(status['completeExperienceToolExperiment'])

    def test_unscored_duplicate_or_changed_return_blocks_full_completion(self):
        raw, scored, attempts, tools, _ = self.records()
        variants = [raw + [copy.deepcopy(raw[0])], copy.deepcopy(raw), raw[:-1]]
        variants[1][0]['studentOutput']['raw'] += ' Changed after saving.'
        for altered in variants:
            status = core.completion_status('completed', altered, scored, attempts, tools)
            self.assertFalse(status['allReturnedResponsesAudited'])
            self.assertFalse(status['completeExperienceToolExperiment'])

    def test_missing_misbound_or_duplicate_execution_and_capped_question_remain_incomplete(self):
        raw, scored, attempts, tools, _ = self.records()
        changed = copy.deepcopy(tools)
        changed[0]['sourceToolCallRecordId'] = 'a-different-call'
        for executed in (tools[1:], changed, tools + [copy.deepcopy(tools[0])]):
            status = core.completion_status('completed', raw, scored, attempts, executed)
            self.assertEqual(status['completedThreeStageAttempts'], 1)
            self.assertFalse(status['completeExperienceToolExperiment'])
        raw, scored = copy.deepcopy(raw), copy.deepcopy(scored)
        for rows in (raw, scored):
            rows[2]['studentOutput'].update(stopReason='token_cap', tokenCapReached=True)
        status = core.completion_status('completed', raw, scored, attempts, tools)
        self.assertTrue(status['allReturnedResponsesAudited'])
        self.assertEqual(status['completedThreeStageAttempts'], 1)
        self.assertFalse(status['completeExperienceToolExperiment'])


class CounterTokenizer:
    """Explicit offline tokenizer double; never claimed to be the student tokenizer."""
    model_max_length = 8192
    eos_token_id = 0

    def __init__(self, fixed_tokens=None):
        self.fixed_tokens = fixed_tokens
        self.calls = []

    def apply_chat_template(self, messages, **kwargs):
        return '\n'.join(m['role'] + ': ' + m['content'] for m in messages) + '\nassistant:'

    def __call__(self, text, **kwargs):
        self.calls.append(kwargs)
        n = self.fixed_tokens if self.fixed_tokens is not None else max(1, len(text.encode()) // 3)
        return {'input_ids': list(range(n))}

    def decode(self, ids, **kwargs):
        return ''.join(chr(i) for i in ids if i)


def generated_checked_fixture(tokenizer, messages, phase, raw, sampled=False, eos=True, legacy=False,
                              changed_context=False):
    from contextlib import nullcontext
    from types import ModuleType
    class Prefix(list):
        def tolist(self):return list(self)
    class Distribution:
        def __init__(self, token):self.token = token
        def float(self):return self
        def __truediv__(self, value):return self
        def exp(self):return self
        def argmax(self):return self.token
        def __getitem__(self, token):return -.25
    class Logits:
        def __init__(self, token):self.token = token
        def __getitem__(self, index):return Distribution(self.token)
    class Base:
        config = SimpleNamespace(max_position_embeddings=1024 if changed_context else 8192)
        generation_config = SimpleNamespace(eos_token_id=0)
        def __init__(self):
            self.ids = iter(list(map(ord, raw)) + ([0] if eos else [ord('x')] * core.MAX_TOKENS))
            self.forward_prefixes = []
        def parameters(self):return iter([SimpleNamespace(device='cpu')])
        def __call__(self, **kwargs):
            self.forward_prefixes.append(copy.deepcopy(kwargs['input_ids']))
            return SimpleNamespace(logits=Logits(next(self.ids)), past_key_values=None)
    torch, nn, functional = ModuleType('torch'), ModuleType('torch.nn'), ModuleType('torch.nn.functional')
    torch.nn, nn.functional = nn, functional
    torch.Generator = lambda **kw: SimpleNamespace(manual_seed=lambda seed:'offline-rng')
    torch.isfinite = lambda x: SimpleNamespace(all=lambda:True)
    torch.multinomial = lambda x,n,generator:x.token
    torch.tensor = lambda rows,**kw:[Prefix(row) for row in rows]
    torch.no_grad = lambda:nullcontext()
    functional.log_softmax = lambda x,dim:x
    limits = policy.input_limits(dict(max_position_embeddings=8192), tokenizer)
    audit = policy.prompt_audit(tokenizer, messages, limits)
    old_generation = ModuleType('zip_generation_policy')
    old_generation.prompt_ids = lambda *args:[Prefix(audit['promptIds'])]
    base = Base()
    with patch.dict(sys.modules, {'torch':torch, 'torch.nn':nn, 'torch.nn.functional':functional,
                                 'zip_generation_policy':old_generation}):
        value = policy.generate(base, tokenizer, messages, phase, 7, sampled,
            input_audit=None if legacy else audit)
    return value, base.forward_prefixes, audit


class InputBudgetChecks(unittest.TestCase):
    def test_action_reference_factoring_keeps_every_original_and_exact_binding(self):
        bundle, _ = fixture()
        before = copy.deepcopy(bundle)
        presentation, text = core.history_presentation(bundle), core.journal_text(bundle)
        self.assertEqual(bundle, before)
        self.assertEqual(len(presentation['histories']), 8)
        self.assertEqual(sum(len(h['routeReferences']) for h in presentation['histories']), 24)
        for entry, ref in zip(bundle['journal'], presentation['histories']):
            self.assertEqual(ref['taskId'], entry['taskId'])
            self.assertIn(json.dumps(entry['goal']), text)
            self.assertIn(json.dumps(entry['observationStudentRaw']), text)
            for route, action in zip(entry['routes'], ref['routeReferences']):
                self.assertIn(json.dumps(route['studentRaw']), text)
                matched = next(a for a in presentation['actions'] if a['actionId'] == action['actionId'])
                self.assertEqual(matched['requestedAction'], route['requestedAction'])
                self.assertEqual(action['recordId'], route['recordId'])
        for action in presentation['actions']:
            self.assertEqual(text.count(json.dumps(action['requestedAction'])), 1)

    def test_later_phases_use_original_assessment_and_only_actual_selected_value(self):
        bundle, bank = fixture()
        review, call = output('I notice mixed results.'), output('CALL Z6')
        check = core.call_audit(call, bank)
        measured = core.execute_tool(bundle, bank, call, check)
        call_prompt = core.call_messages(bundle, bank, review, 1, 1)
        question_prompt = core.question_messages(bundle, bank, review, call, check, measured)
        for prompt in (call_prompt, question_prompt):
            text = json.dumps(prompt)
            self.assertIn(review['raw'], text)
            self.assertNotIn('My observation:', text)
            self.assertNotIn('Task verifier passed:', text)
        self.assertNotIn('evidenceBundleHash', json.dumps(question_prompt))
        self.assertIn(str(measured['value']), json.dumps(question_prompt))
        self.assertEqual(len(measured['evidence']), 8)  # Full tool originals are retained.
        self.assertEqual(core.measurement_presentation(measured)['trainingObjects'], 8)

    def test_input_ceiling_respects_local_context_tokenizer_limit_and_response_reserve(self):
        tokenizer = CounterTokenizer()
        self.assertEqual(policy.input_limits(dict(max_position_embeddings=65536), tokenizer)['maxInputTokens'], 4096)
        self.assertEqual(policy.input_limits(dict(max_position_embeddings=2048), tokenizer)['maxInputTokens'], 1952)
        tokenizer.model_max_length = 1024
        self.assertEqual(policy.input_limits(dict(max_position_embeddings=8192), tokenizer)['maxInputTokens'], 928)
        for config in ({}, {'max_position_embeddings':True}, {'max_position_embeddings':96}):
            with self.assertRaises(ValueError):policy.input_limits(config, tokenizer)

    def test_prefix_above_old_2048_guard_is_preserved_within_checked_context(self):
        tokenizer = CounterTokenizer(2500)
        messages = [dict(role='user', content='Explicit offline long-prefix case.')]
        value, forwards, audit = generated_checked_fixture(tokenizer, messages, 'experience_review', 'Own words.')
        self.assertEqual(len(forwards[0][0]), 2500)
        self.assertEqual(value['promptIds'], list(range(2500)))
        self.assertTrue(audit['fitsInputBudget'])
        self.assertTrue(all(c['truncation'] is False for c in tokenizer.calls))
        self.assertEqual(value['stopReason'], 'eos')

    def test_overlong_input_has_exact_count_and_stops_before_any_forward(self):
        tokenizer = CounterTokenizer(4097)
        limits = policy.input_limits(dict(max_position_embeddings=8192), tokenizer)
        audit = policy.prompt_audit(tokenizer, [dict(role='user',content='Offline oversized case.')], limits)
        self.assertFalse(audit['fitsInputBudget'])
        self.assertEqual(len(audit['promptIds']), 4097)
        with self.assertRaisesRegex(ValueError, 'actual=4097, allowed=4096'):
            policy.require_input(audit)
        with self.assertRaises(ValueError):
            policy.generate(None, tokenizer, [dict(role='user',content='Offline oversized case.')],
                'experience_review', 1, False, input_audit=audit)

    def test_preflight_covers_three_phases_without_tool_execution_or_student_calls(self):
        bundle, bank = fixture()
        tokenizer = CounterTokenizer()
        limits = policy.input_limits(dict(max_position_embeddings=8192), tokenizer)
        with patch.object(core, 'execute_tool', side_effect=AssertionError('No preflight measurement')):
            report = policy.preflight_prompts(bundle, bank, tokenizer, limits, 1)
        self.assertEqual({r['phase'] for r in report['rows']}, set(core.PHASES))
        self.assertEqual(len(report['rows']), 10)
        self.assertEqual(report['measurementExecutions'], 0)
        self.assertEqual(report['actualStudentGenerations'], 0)
        self.assertFalse(report['modelWeightsLoaded'])
        self.assertTrue(report['allPlannedPromptsFit'])

    def test_checked_sampler_matches_v2_tokens_logs_temperature_and_eos(self):
        messages = [dict(role='user',content='Explicit offline sampler parity.')]
        for sampled in (False, True):
            old, _, _ = generated_checked_fixture(CounterTokenizer(12), messages, 'experience_review',
                'Student sentence. More words?', sampled, legacy=True)
            new, _, _ = generated_checked_fixture(CounterTokenizer(12), messages, 'experience_review',
                'Student sentence. More words?', sampled)
            self.assertEqual(new, old)

    def test_eos_on_final_budget_token_is_kept_and_cap_never_invents_completion(self):
        messages = [dict(role='user',content='Explicit offline final-token case.')]
        ended, _, _ = generated_checked_fixture(CounterTokenizer(12), messages, 'experience_review', 'x' * 95)
        capped, _, _ = generated_checked_fixture(CounterTokenizer(12), messages, 'experience_review', 'x' * 96, eos=False)
        self.assertEqual(ended['generatedTokens'], 96)
        self.assertEqual(ended['generatedIds'][-1], 0)
        self.assertFalse(ended['tokenCapReached'])
        self.assertTrue(capped['tokenCapReached'])
        self.assertEqual(capped['stopReason'], 'token_cap')
        self.assertEqual(len(capped['samplingTokenLogProbabilities']), 96)

    def test_changed_loaded_context_or_checked_prefix_is_rejected(self):
        messages = [dict(role='user',content='Explicit offline context case.')]
        with self.assertRaises(ValueError):
            generated_checked_fixture(CounterTokenizer(12), messages, 'experience_review', 'Own words.', changed_context=True)
        tokenizer = CounterTokenizer(12)
        audit = policy.prompt_audit(tokenizer, messages, policy.input_limits(dict(max_position_embeddings=8192), tokenizer))
        audit['promptIds'][0] = 999
        with self.assertRaises(ValueError):policy.require_input(audit)
        audit = policy.prompt_audit(tokenizer, messages, policy.input_limits(dict(max_position_embeddings=8192), tokenizer))
        with self.assertRaises(ValueError):
            policy.generate(None, tokenizer, [dict(role='user',content='Changed message')],
                'experience_review', 7, False, input_audit=audit)

    def test_checked_six_call_loop_retains_originals_budget_and_student_selected_tools(self):
        bundle, bank = fixture()
        tokenizer = CounterTokenizer()
        saved, audits = [], []
        def ask(messages, phase, seed, sampled):
            texts = {'experience_review':'I notice different results.', 'metric_zip_call':'CALL Z6',
                     'experience_question':'Why did my attempts produce different results?'}
            value, _, audit = generated_checked_fixture(tokenizer, messages, phase, texts[phase], sampled)
            audits.append(audit)
            value.update(mathAdapterEnabledDuringGeneration=False, semanticAdapterEnabledDuringGeneration=True,
                promptInputAudit={k:v for k,v in audit.items() if k != 'promptIds'})
            return value
        rows = core.run_probe(bundle, bank, 1, ask, lambda kind,row:saved.append((kind,copy.deepcopy(row))),
            lambda:None, lambda:1)
        self.assertEqual(len(audits), 6)
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(a['fitsInputBudget'] for a in audits))
        self.assertEqual(sum(k == 'tool-executed' for k,r in saved), 2)
        self.assertEqual(sum(k == 'raw' for k,r in saved), 6)
        self.assertTrue(all(not r['activatedAsPromptMetadata'] for k,r in saved if k == 'meta-zip'))

    def test_runtime_length_failure_saves_count_and_never_imports_or_loads_weights(self):
        from contextlib import redirect_stdout
        from types import ModuleType
        import io
        bundle, _ = fixture()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            parent, student, tools = root/'source', root/'student', root/'old-tools'
            for p in (parent/'checkpoints', student, tools):p.mkdir(parents=True)
            (student/'config.json').write_text(json.dumps(dict(max_position_embeddings=8192)))
            (parent/'result.json').write_text('{}')
            (parent/'source-checkpoint.json').write_text(json.dumps(dict(baseChoiceSource=str(parent))))
            (parent/'checkpoints'/'semantic.safetensors').write_bytes(b'explicit offline stub, not weights')
            hashes = runtime.snapshot(parent)
            resume = dict(anchors=bundle['anchors'], sourceHashes=hashes,
                result=dict(protocol='explicit-offline-runtime-test', mathematicalWriterStateHash='offline-math', baseStateBefore='offline-base'),
                final=dict(semanticFile='semantic.safetensors', semanticStateHash='offline-semantic',
                    head=bundle['head'], labels=[]))
            checked = dict(checkpoint=dict(writerStateHash='offline-math'), identity=dict(snapshotSha256={}),
                protected={}, toolFiles={})
            transformers = ModuleType('transformers')
            transformers.AutoTokenizer = SimpleNamespace(from_pretrained=lambda *a,**kw:CounterTokenizer(4097))
            pilot = ModuleType('zip_pilot')
            pilot.load_student = lambda *a,**kw:(_ for _ in ()).throw(AssertionError('Weights must not load'))
            args = SimpleNamespace(source=parent, student=student, old_tools=tools, out=root/'out', work=root)
            before = set(sys.modules)
            with patch.object(runtime,'inspect_source',return_value=resume), \
                 patch.object(runtime,'load_bundle',return_value=(bundle,{})), \
                 patch.object(runtime,'preflight',return_value=checked), \
                 patch.dict(sys.modules,{'transformers':transformers,'zip_pilot':pilot}), redirect_stdout(io.StringIO()):
                self.assertEqual(runtime.run(args), 1)
            result = json.loads((args.out/'result.json').read_text())
            report = json.loads((args.out/'prompt-length-preflight.json').read_text())
            self.assertEqual(report['rows'][0]['audit']['inputTokens'], 4097)
            self.assertFalse(result['modelWeightsLoaded'])
            self.assertEqual(result['actualStudentGenerations'], 0)
            self.assertEqual(result['generationAttempts'], 0)
            self.assertEqual(runtime.snapshot(parent), hashes)
            self.assertNotIn('torch', set(sys.modules) - before)
            self.assertNotIn('safetensors.torch', set(sys.modules) - before)
            self.assertNotIn('Final check:', result['error'])
            self.assertFalse((args.out/'responses').exists())
            self.assertTrue((args.out/'Lain-Zip-Self-Question-Tools-Results.zip').is_file())


if __name__ == '__main__':
    unittest.main()
