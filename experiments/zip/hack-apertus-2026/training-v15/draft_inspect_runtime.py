"""Inspect saved continuation drafts. No student, teacher, or training calls."""
import argparse
import collections
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import uuid
import zipfile

# The launcher supplies only its verified, private pure-Python modules.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from object_choice_core import audit_math, memory_messages, math_messages, keyword_messages
from zip_answer_audit import extract, equality
from zip_content_core import digest, verify_claim

PROTOCOL = 'lain-zip-draft-readonly-inspection-v1'
DEFAULT_SOURCE = '/mnt/workspace/lain-zip-pilot/zip-choice-continue-ce4ac969'
DRAFT_SYSTEM = ('Write a short candidate ZIP in your own words: what you understood about '
    'this object, the method you actually tried, and what could be reused or '
    'needs checking next time. Preserve uncertainty after failure. This is a '
    'draft, not an already proved general rule. No corrected answer is supplied.')


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def snapshot(folder):
    result = {}
    for path in sorted(folder.rglob('*')):
        if path.is_symlink():
            raise ValueError('来源中存在符号链接，停止检查：' + str(path))
        if path.is_file():
            result[str(path.relative_to(folder))] = sha(path)
    return result


def require(condition, message):
    if not condition:
        raise ValueError(message)


def draft_statements(raw):
    # Only already-written sides are audited. Prose is left for actual reading.
    extracted = extract(raw)
    rows = []
    for statement in extracted['statements']:
        for left, right in zip(statement['parts'], statement['parts'][1:]):
            rows.append(dict(left=left, right=right, sourceLine=statement.get('line'),
                             exactIdentityAudit=equality(left, right)))
    return dict(writtenEqualities=rows,
                uninterpretedLines=extracted.get('uninterpretedLines', []),
                extractionComplete=extracted.get('extractionComplete', False),
                proseTruthCertified=False, missingMathematicsFilled=False,
                wholeDraftCertified=False, reuseOnNewObjectTested=False)


def inspect(source, *, fixture_test=False):
    source = Path(source).resolve()
    require(source.is_dir(), '没有找到本轮结果目录：' + str(source) +
            '\n请在刚才运行接续训练的 Notebook 中执行本脚本。')
    before = snapshot(source)
    result = read(source / 'result.json')
    require(result.get('protocol') == 'lain-zip-choice-continuation-v1'
            and result.get('stopReason') == 'completed' and result.get('error') is None,
            '本轮不是完整的接续训练结果')
    if not fixture_test:
        require(result.get('fixtureOnly') is False and result.get('fixtureGenerations') == 0,
                '拒绝把测试例作为真实学生结果')
    require(result.get('actualStudentGenerations') == 64 and result.get('actualStudentZipDrafts') == 8
            and result.get('rawResponsesSaved') == 64 and result.get('scoredResponses') == 64,
            '本轮生成或草稿数量不完整')
    bank = read(source / 'continue-memory-bank.json')
    require(bank.get('oldBankPromotion') is False and bank.get('certifiedStandaloneNewRules') == 0,
            '草稿状态或旧库准入记录改变')
    plan = read(source / 'continue-questions.json')
    training = plan['training']; tasks = training + plan['heldout']
    require(len(training) == 8 and len(tasks) == 12 and len({t['id'] for t in tasks}) == 12,
            '题目计划缺失或重复')
    raws = {}; scored = {}; paths = {}
    for path in sorted((source / 'responses').rglob('*-raw.json')):
        raw = read(path)
        rid = raw['recordId']
        require(rid not in raws, '原文编号重复：' + rid)
        checked_path = path.with_name(path.name[:-len('-raw.json')] + '-scored.json')
        checked = read(checked_path)
        require(all(checked.get(k) == v for k, v in raw.items()), '原文与核验记录不一致：' + rid)
        if not fixture_test:
            require(not raw['studentOutput'].get('testDouble'), '原文含测试替身：' + rid)
        raws[rid] = raw; scored[rid] = checked
        paths[rid] = dict(raw=str(path.relative_to(source)),
                          scored=str(checked_path.relative_to(source)))
    require(len(raws) == 64, '必须保留完整 64 条原文及核验记录')
    counts = collections.Counter(r['phase'] for r in raws.values())
    require(dict(counts) == dict(cold_replay=8, continue_keywords=12,
                                continue_route_math=36, continue_zip_draft=8),
            '原文阶段计数不符合本轮协议')
    bank_notes = bank['zipDrafts']
    require(len(bank_notes) == 8 and len({n['sourceRecordId'] for n in bank_notes}) == 8,
            '草稿库必须有八份独立来源')
    notes_by_id = {n['sourceRecordId']: n for n in bank_notes}
    draft_ids = {r['recordId'] for r in raws.values() if r['phase'] == 'continue_zip_draft'}
    require(set(notes_by_id) == draft_ids, '草稿库与原文记录不是同一组草稿')
    decisions = [read(p) for p in sorted((source / 'decision').glob('*.json'))]
    require(len(decisions) == 60 and len({d['id'] for d in decisions}) == 60,
            '必须保留全部 60 条选择记录')
    checked_routes = {}; all_failures = []; root_versions = {}; roots_by_kind = {}
    contexts = []
    for task in tasks:
        routes = [r for r in scored.values() if r['phase'] == 'continue_route_math' and r['task'] == task]
        require(len(routes) == 3 and {r['selectedCandidate']['kind'] for r in routes}
                == {'direct', 'combine', 'distribute'}, '三条路线不完整：' + task['id'])
        keywords = [r for r in scored.values() if r['phase'] == 'continue_keywords' and r['task'] == task]
        require(len(keywords) == 1, '关键词原文不完整：' + task['id'])
        keyword = keywords[0]
        require(keyword['studentPrompt'] == keyword_messages(task), '关键词提示改变：' + task['id'])
        for route in routes:
            candidate = route['selectedCandidate']
            require(route.get('sourceKeywordRecordId') == keyword['recordId'], '数学路线关键词来源改变')
            require(route.get('hostSpecifiedRoute') is True and route.get('autonomousToolUseClaimed') is False,
                    '路线调度来源标记改变')
            if candidate['kind'] != 'direct':
                root = candidate['root']; key = (root['id'], root['version'])
                root_check = verify_claim(root['rule'])
                require(root_check['accepted'] and root_check['reusable']
                        and candidate['parentVersion'] == root['version']
                        and candidate['parentClaimHash'] == digest(root['rule']), '旧工具版本或规则失败')
                require(key not in root_versions or root_versions[key] == root, '同版本旧工具内容改变')
                require(candidate['kind'] not in roots_by_kind or roots_by_kind[candidate['kind']] == root,
                        '本轮旧工具不一致')
                root_versions[key] = copy.deepcopy(root); roots_by_kind[candidate['kind']] = root
            checked = audit_math(task, route['studentOutput'], candidate)
            require(checked == route['check'], '数学路线原核验无法复现：' + route['recordId'])
            checked_routes[route['recordId']] = checked
            if not checked['outcomePassed']:
                all_failures.append(route['recordId'])
        roots = [roots_by_kind['combine'], roots_by_kind['distribute']]
        for route in routes:
            require(route['studentPrompt'] == math_messages(task, route['selectedCandidate'], roots),
                    '学生数学提示改变：' + route['recordId'])
        if task not in training:
            continue
        notes = [r for r in scored.values() if r['phase'] == 'continue_zip_draft' and r['task'] == task]
        require(len(notes) == 1, '训练对象草稿缺失或重复：' + task['id'])
        note = notes[0]; bank_note = notes_by_id[note['recordId']]
        own_choices = [d for d in decisions if d['task'] == task
                       and d['arm'] == 'continuing_choice' and d['seedIndex'] == 1]
        require(len(own_choices) == 1, '学习选择头实际选择缺失或重复')
        decision = own_choices[0]
        chosen = [r for r in routes if r['selectedCandidate'] == decision['selectedCandidate']]
        require(len(chosen) == 1, '草稿来源方法与实际选择不同')
        own = chosen[0]
        require(decision.get('savedBeforeAnyRouteOutcome') is True
                and decision['sourceKeywordRecordId'] == keyword['recordId'], '选择来源标记改变')
        require(note['sourceMathRecordId'] == own['recordId'], '草稿引用了另一条数学路线')
        expected_prompt = memory_messages(task, keyword, own)
        expected_prompt[0]['content'] = DRAFT_SYSTEM
        require(note['studentPrompt'] == expected_prompt, '草稿提示与实际尝试/反馈不一致')
        text = note['studentOutput']['raw']
        require(bank_note['studentRaw'] == text and bank_note['studentRawHash'] == digest(text)
                and bank_note['sourceMathRecordId'] == own['recordId'] and bank_note['task'] == task
                and bank_note['tokenCapReached'] == bool(note['studentOutput'].get('tokenCapReached')),
                '草稿库原文、哈希或绑定与原始记录不同')
        require(bank_note['status'] == 'pending_zip_semantics_and_reuse_review'
                and note['check'].get('automaticBankPromotion') is False
                and note['check'].get('naturalLanguageTruthCertified') is False,
                '草稿被提前标成已认证')
        contexts.append(dict(number=len(contexts) + 1, task=task, draftRaw=text,
            draftRecordId=note['recordId'], draftTokenCapReached=bank_note['tokenCapReached'],
            draftOriginal=raws[note['recordId']], draftSavedCheck=note['check'],
            draftSourcePaths=paths[note['recordId']], keywordOriginal=raws[keyword['recordId']],
            actualChoice=decision, actualChosenRoute=own, allThreeRouteOriginals=routes,
            writtenMathAudit=draft_statements(text),
            semanticReviewStatus='pending_reading_of_complete_draft',
            newObjectReuseStatus='not_tested'))
    require(set(bank['allMathOriginalRecordIds']) == set(checked_routes)
            and len(bank['allMathOriginalRecordIds']) == 36, '数学路线原文列表改变')
    require(set(bank['allFailedOriginalRecordIds']) == set(all_failures)
            and len(bank['allFailedOriginalRecordIds']) == len(all_failures), '失败原文列表遗漏或改变')
    require(snapshot(source) == before, '检查期间来源目录发生变化')
    require(not any(n.split('.')[0] in {'torch', 'transformers', 'safetensors', 'zip_pilot'}
                    for n in sys.modules), '检查进程不应加载学生运行库')
    return dict(protocol=PROTOCOL, fixtureOnly=fixture_test, sourceDirectory=str(source),
        sourceResult=result, sourceFileHashes=before, originalFilesUnchanged=True,
        inspectionStudentCalls=0, inspectionTeacherCalls=0, inspectionTrainingUpdates=0,
        inspectionFeatureForwards=0, draftCount=len(contexts), uniqueTrainingObjects=8,
        allSavedRoutesRechecked=len(checked_routes), allFailureOriginalsRetained=len(all_failures),
        observationsDoNotCertifyNaturalLanguage=True, newObjectReuseTested=False,
        oldBankChanged=False, drafts=contexts)


def markdown(report):
    lines = ['# 本轮 ZIP 草稿只读检查', '',
             '学生调用＝0；老师调用＝0；权重更新＝0。', '',
             '以下保留全部八份草稿。数学核验仅覆盖原文已写出的等式；草稿理解与新对象复用仍待逐份审阅。', '']
    for item in report['drafts']:
        own = item['actualChosenRoute']
        lines += [f"## 草稿 {item['number']}/8", '', '原题：' + item['task']['expression'], '',
                  '实际选择：' + own['selectedCandidate']['kind'] +
                  '；该路线原核验：' + ('通过' if own['check']['outcomePassed'] else '失败'), '',
                  '草稿到达 token 上限：' + str(item['draftTokenCapReached']), '', '草稿完整原文：', '',
                  '````text', item['draftRaw'], '````', '', '同题三条路线原文与核验：', '']
        for route in item['allThreeRouteOriginals']:
            lines += [route['selectedCandidate']['kind'] + '：' +
                      ('通过' if route['check']['outcomePassed'] else '失败'), '',
                      '````text', route['studentOutput']['raw'], '````', '']
        rows = item['writtenMathAudit']['writtenEqualities']
        lines += ['草稿内可完整解析的等式：' + str(len(rows)) + ' 条。', '']
        for row in rows:
            lines += [row['left'] + ' = ' + row['right'] + '；等式恒等核验：' +
                      str(row['exactIdentityAudit']['status']), '']
        lines += ['待审阅：理解是否对应实际反馈；适用条件是否写清；是具体实例、已有规则说明，还是提出了新的规则；新对象上能否实际复用。', '']
    return '\n'.join(lines)


def export(report, source, out):
    out = Path(out).resolve(); source = Path(source).resolve()
    require(not out.exists() and not out.is_relative_to(source) and not source.is_relative_to(out),
            '检查输出必须是来源目录之外的新目录')
    out.mkdir(parents=True)
    # Copy the frozen bytes before writing any conclusions, retaining all failures.
    for relative, expected in report['sourceFileHashes'].items():
        if Path(relative).suffix == '.zip':
            continue
        data = (source / relative).read_bytes()
        require(hashlib.sha256(data).hexdigest() == expected, '导出期间来源文件改变：' + relative)
        target = out / 'source-originals' / relative
        target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
    for item in report['drafts']:
        target = out / 'draft-originals' / (str(item['number']).zfill(2) + '-student-raw.txt')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(item['draftRaw'], encoding='utf-8')
    require(snapshot(source) == report['sourceFileHashes'], '导出期间来源目录发生变化')
    (out / 'inspection.json').write_text(json.dumps(report, ensure_ascii=False, indent=2,
                                                  allow_nan=False) + '\n', encoding='utf-8')
    (out / 'Lain-Zip-Draft-Inspection.md').write_text(markdown(report), encoding='utf-8')
    archive = out / 'Lain-Zip-Draft-Review-Bundle.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
        for path in sorted(out.rglob('*')):
            if path.is_file() and path != archive:
                z.write(path, path.relative_to(out))
    return archive


def main(argv=None):
    p = argparse.ArgumentParser(description='读取已保存的 ZIP 草稿与数学原文；无需学生模型。')
    p.add_argument('--source', type=Path, default=Path(DEFAULT_SOURCE))
    p.add_argument('--out', type=Path)
    p.add_argument('--self-test', action='store_true')
    args = p.parse_args(argv)
    if args.self_test:
        from test_draft_inspect import main as tests
        return tests()
    print('开始检查本轮草稿；学生调用＝0，训练更新＝0。', flush=True)
    report = inspect(args.source)
    out = args.out or args.source.resolve().parent / ('zip-draft-inspect-' + uuid.uuid4().hex[:8])
    archive = export(report, args.source, out)
    for item in report['drafts']:
        own = item['actualChosenRoute']
        print('\n草稿 ' + str(item['number']) + '/8 | ' + item['task']['expression'] +
              ' | 实际方法=' + own['selectedCandidate']['kind'] +
              ' | 实际路线核验=' + ('通过' if own['check']['outcomePassed'] else '失败'), flush=True)
        print(item['draftRaw'], flush=True)
    print('\n来源、八份草稿与三条路线对应核对通过；原文保持不变。', flush=True)
    print('这些草稿的语义判断与新对象复用尚未完成，请将检查包发回本对话。', flush=True)
    print('检查包：' + str(archive), flush=True)
    print('逐份原文报告：' + str(out / 'Lain-Zip-Draft-Inspection.md'), flush=True)
    receipt = os.environ.get('LAIN_ZIP_DRAFT_RECEIPT')
    if receipt:
        Path(receipt).write_text(json.dumps(dict(archive=str(archive),
            report=str(out / 'Lain-Zip-Draft-Inspection.md')), ensure_ascii=False), encoding='utf-8')
    return str(archive)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError) as error:
        print('检查停止：' + str(error), file=sys.stderr, flush=True)
        sys.exit(1)
