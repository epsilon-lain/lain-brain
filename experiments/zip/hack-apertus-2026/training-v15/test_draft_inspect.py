"""Tampering and read-only export checks using explicit non-student fixtures."""
import copy
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

import draft_inspect_runtime as d
from object_choice_core import candidates_for, keyword_messages, math_messages, memory_messages, audit_math
from zip_guided_helpers import application
from zip_content_core import digest


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')


def fixture(folder):
    roots = [dict(id=k, version='fixture-' + k, rule=dict(operation='rewrite', input=a,
        output=b, variable='', scope='real_polynomial')) for k, a, b in
        [('combine', '1*x+2*x', '3*x'), ('distribute', 'c*(a+b)', 'c*a+c*b')]]
    candidates = candidates_for(roots)
    tasks = [dict(id='fixture-task-' + str(i), split='training' if i < 8 else 'heldout',
        expression=f'1 * ({80+i} * v) + 2 * ({80+i} * v)' if i % 2 == 0 else f'3 * (5 * v + {80+i})',
        family='same_factor' if i % 2 == 0 else 'product_of_sum', scope='real_polynomial') for i in range(12)]
    for task in tasks:
        task['question'] = 'Rewrite ' + task['expression'] + '.'
    raw = []; scored = []; decisions = []; notes = []
    def save(phase, text, prompt=None, **context):
        row = dict(recordId='fixture-record-' + str(len(raw) + 1).zfill(2), phase=phase,
            studentPrompt=prompt or [], studentOutput=dict(raw=text, tokenCapReached=False,
                testDouble=True), **context)
        raw.append(copy.deepcopy(row)); scored.append(copy.deepcopy(row))
        return scored[-1]
    for _ in range(8):
        save('cold_replay', 'fixture anchor')
    for index, task in enumerate(tasks):
        keyword = save('continue_keywords', 'fixture keywords', keyword_messages(task), task=task)
        routes = []
        for candidate in candidates:
            call = application(candidate['root'], task['expression']) if candidate['kind'] != 'direct' else None
            text = task['expression'] + ' = ' + call['output_text'] if call else 'SKIP'
            row = save('continue_route_math', text, math_messages(task, candidate, roots), task=task,
                selectedCandidate=candidate, sourceKeywordRecordId=keyword['recordId'],
                hostSpecifiedRoute=True, autonomousToolUseClaimed=False)
            row['check'] = audit_math(task, row['studentOutput'], candidate); routes.append(row)
        own = routes[0] if index % 3 == 0 else next(r for r in routes if r['check']['outcomePassed'])
        for arm in ('continuing_choice', 'frozen_before_round', 'frozen_original_initial'):
            for seed in range(1, 2 if index < 8 else 4):
                decisions.append(dict(id=task['id'] + '-' + arm + '-' + str(seed), task=task, arm=arm,
                    seedIndex=seed, selectedCandidate=own['selectedCandidate'],
                    sourceKeywordRecordId=keyword['recordId'], savedBeforeAnyRouteOutcome=True))
        if index < 8:
            prompt = memory_messages(task, keyword, own); prompt[0]['content'] = d.DRAFT_SYSTEM
            text = 'Fixture 原文：尚待检查。\n1*x+2*x = 3*x\n'
            note = save('continue_zip_draft', text, prompt, task=task, sourceMathRecordId=own['recordId'])
            note['check'] = dict(automaticBankPromotion=False, naturalLanguageTruthCertified=False)
            notes.append(dict(sourceRecordId=note['recordId'], task=task, studentRaw=text,
                studentRawHash=digest(text), sourceMathRecordId=own['recordId'], tokenCapReached=False,
                status='pending_zip_semantics_and_reuse_review'))
    for row, check in zip(raw, scored):
        write(folder / 'responses' / (row['recordId'] + '-raw.json'), row)
        write(folder / 'responses' / (row['recordId'] + '-scored.json'), check)
    for decision in decisions:
        write(folder / 'decision' / (decision['id'] + '.json'), decision)
    write(folder / 'continue-questions.json', dict(training=tasks[:8], heldout=tasks[8:]))
    write(folder / 'continue-memory-bank.json', dict(zipDrafts=notes, oldBankPromotion=False,
        certifiedStandaloneNewRules=0,
        allMathOriginalRecordIds=[r['recordId'] for r in scored if r['phase'] == 'continue_route_math'],
        allFailedOriginalRecordIds=[r['recordId'] for r in scored if r['phase'] == 'continue_route_math'
                                   and not r['check']['outcomePassed']]))
    write(folder / 'result.json', dict(protocol='lain-zip-choice-continuation-v1', stopReason='completed',
        error=None, fixtureOnly=True, fixtureGenerations=64, actualStudentGenerations=64,
        actualStudentZipDrafts=8, rawResponsesSaved=64, scoredResponses=64))
    return notes, raw


class DraftInspectionChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / 'fixture-source'
        self.notes, self.raw = fixture(self.source)

    def test_complete_export_retains_all_drafts_all_routes_and_all_failure_originals(self):
        before = d.snapshot(self.source)
        report = d.inspect(self.source, fixture_test=True)
        archive = d.export(report, self.source, Path(self.temp.name) / 'review')
        self.assertEqual(d.snapshot(self.source), before)
        self.assertEqual(report['draftCount'], 8)
        self.assertEqual(report['allSavedRoutesRechecked'], 36)
        self.assertEqual(report['allFailureOriginalsRetained'], 24)
        self.assertEqual(report['inspectionStudentCalls'], 0)
        self.assertEqual(report['inspectionTrainingUpdates'], 0)
        self.assertFalse(report['newObjectReuseTested'])
        with zipfile.ZipFile(archive) as z:
            for i, note in enumerate(self.notes, 1):
                self.assertEqual(z.read(f'draft-originals/{i:02d}-student-raw.txt').decode(), note['studentRaw'])
            self.assertEqual(sum(n.endswith('-raw.json') for n in z.namelist()), 64)

    def test_fixture_results_cannot_be_mistaken_for_actual_student_results(self):
        with self.assertRaisesRegex(ValueError, '测试例'):
            d.inspect(self.source)

    def test_changed_bank_draft_is_rejected(self):
        path = self.source / 'continue-memory-bank.json'; value = d.read(path)
        value['zipDrafts'][0]['studentRaw'] += 'changed'; write(path, value)
        with self.assertRaisesRegex(ValueError, '原文、哈希'):
            d.inspect(self.source, fixture_test=True)

    def test_another_actual_route_cannot_be_substituted_as_the_draft_source(self):
        rid = self.notes[0]['sourceRecordId']
        for suffix in ('raw', 'scored'):
            path = self.source / 'responses' / (rid + '-' + suffix + '.json')
            value = d.read(path); value['sourceMathRecordId'] = 'fixture-record-11'; write(path, value)
        with self.assertRaisesRegex(ValueError, '另一条数学路线'):
            d.inspect(self.source, fixture_test=True)

    def test_changed_math_even_in_matching_raw_and_scored_is_rejected_by_exact_replay(self):
        row = next(r for r in self.raw if r['phase'] == 'continue_route_math'
                   and r['selectedCandidate']['kind'] == 'combine')
        for suffix in ('raw', 'scored'):
            path = self.source / 'responses' / (row['recordId'] + '-' + suffix + '.json')
            value = d.read(path); value['studentOutput']['raw'] = row['task']['expression'] + ' = 999*v'
            write(path, value)
        with self.assertRaisesRegex(ValueError, '无法复现'):
            d.inspect(self.source, fixture_test=True)

    def test_missing_failure_record_is_rejected(self):
        path = self.source / 'continue-memory-bank.json'; value = d.read(path)
        value['allFailedOriginalRecordIds'].pop(); write(path, value)
        with self.assertRaisesRegex(ValueError, '失败原文'):
            d.inspect(self.source, fixture_test=True)

    def test_equalities_are_checked_without_turning_prose_or_missing_sides_into_proof(self):
        false = d.draft_statements('x+x = 3*x')
        self.assertEqual(false['writtenEqualities'][0]['exactIdentityAudit']['status'], 'rejected')
        missing = d.draft_statements('= 3*x')
        self.assertEqual(missing['writtenEqualities'], [])
        prose = d.draft_statements('I discovered a universal new method.')
        self.assertFalse(prose['wholeDraftCertified'])
        self.assertFalse(prose['proseTruthCertified'])

    def test_output_cannot_overwrite_or_extend_the_source_directory(self):
        report = d.inspect(self.source, fixture_test=True)
        with self.assertRaisesRegex(ValueError, '新目录'):
            d.export(report, self.source, self.source / 'review')


def main():
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(DraftInspectionChecks))
    if not result.wasSuccessful():
        raise SystemExit(1)
    print('离线检查通过：8 项；使用显式测试例；实际学生调用＝0，实际权重更新＝0。')


if __name__ == '__main__':
    main()
