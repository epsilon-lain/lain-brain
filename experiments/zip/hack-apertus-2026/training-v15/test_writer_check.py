"""Contract tests use explicit fixtures, never count as student generations."""
import copy
from contextlib import contextmanager
import json
from pathlib import Path
import sys
import tempfile
import unittest

from frozen_zip_route import invoke_adapter_route
import writer_check_core as core
from writer_check_progress import StageProgress


def output(text, enabled, tokens=None):
    tokens = tokens or [1, 2]
    return dict(raw=text, promptIds=[5, 6], generatedIds=tokens,
                generatedTokens=len(tokens), sampled=False, temperature=1.,
                tokenCapReached=False, mathAdapterEnabledDuringGeneration=enabled,
                testDouble=True)


def course():
    anchors = [dict(recordId='fixture-cold-' + str(i), studentPrompt=[dict(role='user', content=str(i))],
                   samplingSeed=i, studentOutput=output('old-' + str(i), True)) for i in range(8)]
    contexts = []
    for rid, passed, expr in zip(core.CASE_IDS, (True, False),
                                ('1*(72*v)+2*(72*v)', '3*(5*v+5)')):
        old = dict(recordId=rid, studentPrompt=[dict(role='user', content=expr)],
                   samplingSeed=91 if passed else 92, studentOutput=output('old-' + expr, False))
        contexts.append(dict(draftRecordId=rid, draftOriginal=old,
                             task=dict(id=rid, expression=expr),
                             actualChosenRoute=dict(recordId=rid+'-math', check=dict(outcomePassed=passed),
                                                    studentOutput=dict(raw=expr+' = 0'))))
    return anchors, contexts


class WriterPairChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.out = Path(self.temp.name) / 'result'
        self.anchors, self.contexts = course()
        self.calls = []

    def generate(self, prompt, tokens, seed, enabled):
        self.calls.append((copy.deepcopy(prompt), tokens, seed, enabled))
        if seed < 8:
            return output('old-' + str(seed), True)
        expr = prompt[0]['content']
        return output(('old-' if not enabled else 'new-') + expr, enabled)

    def engine(self, generate=None, **kwargs):
        return core.PairEngine(self.out, generate or self.generate, lambda: None,
                               fixture_only=True, **kwargs)

    def test_twelve_calls_share_prompt_seed_and_keep_all_four_before_content_audit(self):
        seen = []
        def audit(context, value):
            saved = list((self.out/'responses').glob('*-raw.json'))
            self.assertEqual(len(saved), 12)
            self.assertEqual(sum(json.loads(p.read_text())['phase'] != 'cold_replay' for p in saved), 4)
            seen.append(value['raw'])
            return core.partial_draft_audit(context, value)
        e = self.engine(audit=audit)
        pairs = e.run(self.anchors, self.contexts)
        self.assertEqual((e.attempts, e.cold_ok, e.off_ok, len(pairs)), (12, 8, 2, 2))
        self.assertEqual(len(e.raw), 12)
        self.assertEqual(len(e.scored), 12)
        self.assertEqual(len(seen), 4)
        self.assertEqual(self.calls[8][:3], self.calls[10][:3])
        self.assertEqual(self.calls[9][:3], self.calls[11][:3])
        self.assertEqual([c[3] for c in self.calls], [True]*8+[False]*2+[True]*2)
        self.assertTrue(all(p['outputTextChanged'] for p in pairs))
        self.assertFalse(any(p['wholeDraftImprovementEstablished'] for p in pairs))

    def test_cold_failure_is_kept_and_stops_before_any_draft(self):
        def wrong(prompt, tokens, seed, enabled):
            return output('wrong original', enabled)
        e = self.engine(wrong)
        with self.assertRaisesRegex(ValueError, '旧数学输出'):
            e.run(self.anchors, self.contexts)
        self.assertEqual((e.attempts, len(e.raw), len(e.scored)), (1, 1, 1))
        self.assertEqual(e.raw[0]['studentOutput']['raw'], 'wrong original')

    def test_off_failure_is_kept_and_stops_before_any_on(self):
        def wrong(prompt, tokens, seed, enabled):
            value = self.generate(prompt, tokens, seed, enabled)
            if seed == 91:
                value['raw'] = 'changed old draft'
            return value
        e = self.engine(wrong)
        with self.assertRaisesRegex(ValueError, '原 adapter-OFF'):
            e.run(self.anchors, self.contexts)
        self.assertEqual((e.attempts, e.cold_ok, len(e.raw), len(e.scored)), (9, 8, 9, 9))
        self.assertFalse(any(r['phase'] == 'adapter_on_draft' for r in e.raw))

    def test_same_text_with_changed_prompt_token_ids_fails_exact_identity(self):
        old = output('same', True)
        new = dict(old, promptIds=[9, 9])
        check = core.exact_reproduction(old, new)
        self.assertFalse(check['exact'])
        self.assertFalse(check['fields']['promptIds'])

    def test_misrouted_response_is_saved_before_rejection(self):
        e = self.engine(lambda *args: output('incorrect route', False))
        with self.assertRaisesRegex(ValueError, '适配器开关'):
            e.run(self.anchors, self.contexts)
        self.assertTrue((self.out/'responses'/'writer-check-call-01-raw.json').is_file())
        self.assertEqual(len(e.scored), 0)

    def test_model_fixture_rejected_in_real_mode_after_raw_preservation(self):
        e = core.PairEngine(self.out, self.generate, lambda: None)
        with self.assertRaisesRegex(ValueError, '测试替身'):
            e.run(self.anchors, self.contexts)
        self.assertEqual(len(e.raw), 1)

    def test_adapter_switch_restores_after_success_and_exception(self):
        class Adapter:
            enabled = True
            @contextmanager
            def active(self, enabled):
                old = self.enabled
                self.enabled = enabled
                try:
                    yield
                finally:
                    self.enabled = old
        adapter = Adapter()
        def success():
            self.assertFalse(adapter.enabled)
            return dict(raw='fixture')
        value = invoke_adapter_route(adapter, success, False)
        self.assertFalse(value['mathAdapterEnabledDuringGeneration'])
        self.assertTrue(adapter.enabled)
        def fail():
            self.assertFalse(adapter.enabled)
            raise RuntimeError('fixture failure')
        with self.assertRaisesRegex(RuntimeError, 'fixture failure'):
            invoke_adapter_route(adapter, fail, False)
        self.assertTrue(adapter.enabled)

    def test_partial_math_finds_rejection_but_never_certifies_prose_or_repairs_sides(self):
        value = output('The object is a polynomial of degree 2.\n1*(72*v)+2*(72*v) = 144\nUnparsed explanation.', True)
        audit = core.partial_draft_audit(self.contexts[0], value)
        self.assertEqual(audit['writtenEqualities'][0]['exactAudit']['status'], 'rejected')
        self.assertFalse(audit['explicitObjectDegreeClaims'][0]['matches'])
        self.assertEqual(audit['explicitObjectDegreeClaims'][0]['actualObjectDegree'], 1)
        self.assertFalse(audit['missingMathSidesFilled'])
        self.assertFalse(audit['naturalLanguageTruthCertified'])
        self.assertFalse(audit['wholeDraftCertified'])
        plain = core.partial_draft_audit(self.contexts[0], output('The answer is 144.', True))
        self.assertEqual(plain['writtenEqualities'], [])

    def test_generation_cap_and_deadline_stop_before_generation(self):
        e = self.engine(clock=lambda: 100., deadline=99.)
        with self.assertRaises(TimeoutError):
            e.run(self.anchors, self.contexts)
        self.assertEqual(self.calls, [])
        e = self.engine()
        e.attempts = 12
        with self.assertRaisesRegex(ValueError, '12 次'):
            e.ask('cold_replay', self.anchors[0], True)

    def test_content_audit_failure_keeps_all_returned_originals(self):
        def fail(*args):
            raise RuntimeError('fixture audit failure')
        e = self.engine(audit=fail)
        with self.assertRaisesRegex(RuntimeError, 'audit failure'):
            e.run(self.anchors, self.contexts)
        self.assertEqual(len(e.raw), 12)
        self.assertEqual(sum(r['phase'] == 'adapter_on_draft' for r in e.raw), 2)

    def test_source_fixture_rejected_before_model_import(self):
        import writer_check_run as run
        source = Path(self.temp.name)/'fake'
        source.mkdir()
        core.write_once(source/'result.json', dict(fixtureOnly=True, stopReason='completed'))
        before = set(sys.modules)
        with self.assertRaisesRegex(ValueError, 'ce4ac969'):
            run.source_cases(source)
        self.assertFalse({'torch', 'transformers', 'safetensors'} & (set(sys.modules)-before))

    def test_raw_record_cannot_be_overwritten_and_progress_reflects_saved_counts(self):
        path = self.out/'test.json'
        core.write_once(path, {'raw':'first'})
        with self.assertRaises(FileExistsError):
            core.write_once(path, {'raw':'second'})
        self.assertEqual(json.loads(path.read_text())['raw'], 'first')
        progress_path = Path(self.temp.name)/'progress.json'
        p = StageProgress(progress_path)
        p.mark('fixture', rawResponsesSaved=1)
        self.assertEqual(json.loads(progress_path.read_text())['rawResponsesSaved'], 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
