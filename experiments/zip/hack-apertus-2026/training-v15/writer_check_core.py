"""Small frozen ON/OFF diagnosis. This module has no model imports or updates."""
import copy
import json
import re
import time
from pathlib import Path

from zip_answer_audit import extract, equality
from zip_content_core import parse_expression

PROTOCOL = 'lain-zip-draft-adapter-pair-check-v1'
MAX_GENERATIONS = 12
MAX_TOKENS = 96
CASE_IDS = ('continue-call-23', 'continue-call-18')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def write_once(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8') as output:
        json.dump(value, output, ensure_ascii=False, indent=2, allow_nan=False)
        output.write('\n')
        output.flush()


def exact_reproduction(old, new):
    # Probability arithmetic can differ by runtime. Identity uses actual text/IDs,
    # not approximate equality of scores or a repaired mathematical expression.
    keys = ('raw', 'promptIds', 'generatedIds', 'generatedTokens', 'sampled',
            'temperature', 'tokenCapReached', 'mathAdapterEnabledDuringGeneration')
    fields = {key: key in old and key in new and old[key] == new[key] for key in keys}
    return dict(exact=all(fields.values()), fields=fields,
                probabilityScoresUsedForIdentity=False)


def partial_draft_audit(context, output):
    """Audit only already written, fully parsed math; leave prose pending."""
    parsed = extract(output['raw'])
    equations = []
    for statement in parsed['statements']:
        for left, right in zip(statement['parts'], statement['parts'][1:]):
            equations.append(dict(left=left, right=right, sourceLine=statement.get('line'),
                                  exactAudit=equality(left, right)))
    poly = parse_expression(context['task']['expression'])[0]
    degree = max((sum(power for _, power in monomial) for monomial in poly), default=0)
    # Only an explicit sentence about THIS object is handled, not every mention
    # of a subexpression's degree. Do not infer a semantic pass from its absence.
    claims = []
    pattern = r'\b(?:the|this)\s+(?:object|expression)\s+is\s+(?:a\s+)?(?:real\s+)?polynomial\s+of\s+degree\s+(\d+)\b'
    for match in re.finditer(pattern, output['raw'], re.I):
        claims.append(dict(verbatim=match[0], statedDegree=int(match[1]),
                           actualObjectDegree=degree, matches=int(match[1]) == degree))
    return dict(writtenEqualities=equations, explicitObjectDegreeClaims=claims,
                uninterpretedLines=parsed.get('uninterpretedLines', []),
                extractionComplete=parsed.get('extractionComplete', False),
                tokenCapReached=output['tokenCapReached'],
                sourceAttemptPassed=context['actualChosenRoute']['check']['outcomePassed'],
                missingMathSidesFilled=False, correctedAnswerSuppliedToStudent=False,
                naturalLanguageTruthCertified=False, wholeDraftCertified=False,
                semanticReviewStatus='pending_reading_of_complete_originals',
                newObjectReuseTested=False, automaticBankPromotion=False)


class PairEngine:
    """Save before any audit, stop before ON if a historical identity fails."""
    def __init__(self, out, generate, frozen, progress=None, *, fixture_only=False,
                 deadline=None, clock=time.monotonic, audit=partial_draft_audit):
        self.out = Path(out)
        self.generate = generate
        self.frozen = frozen
        self.progress = progress or (lambda *args, **kwargs: None)
        self.fixture_only = fixture_only
        self.deadline = deadline if deadline is not None else clock() + 1200
        self.clock = clock
        self.audit = audit
        self.attempts = 0
        self.raw = []
        self.scored = []
        self.cold_ok = 0
        self.off_ok = 0
        self.pairs = []

    def ask(self, phase, old, enabled, case_id=None, stage_deadline=None):
        require(self.attempts < MAX_GENERATIONS, '12 次文字生成预算已到')
        if self.clock() >= min(self.deadline, stage_deadline or self.deadline):
            raise TimeoutError('配对检查时间预算已到')
        self.frozen()
        self.attempts += 1
        self.progress('生成 ' + str(self.attempts) + '/12：' + phase,
                      generationAttempts=self.attempts,
                      inFlight=dict(number=self.attempts, phase=phase, case=case_id,
                                    mathAdapterEnabled=enabled))
        start = self.clock()
        prompt = copy.deepcopy(old['studentPrompt'])
        value = self.generate(prompt, MAX_TOKENS, old['samplingSeed'], enabled)
        row = dict(recordId='writer-check-call-' + str(self.attempts).zfill(2),
                   phase=phase, sourceRecordId=old['recordId'], caseId=case_id,
                   studentPrompt=prompt, samplingSeed=old['samplingSeed'],
                   requestedMathAdapterEnabled=enabled, studentOutput=copy.deepcopy(value),
                   generationSeconds=self.clock() - start, fixtureOnly=self.fixture_only)
        # Even a misrouted/invalid returned response is kept before rejection.
        write_once(self.out / 'responses' / (row['recordId'] + '-raw.json'), row)
        self.raw.append(copy.deepcopy(row))
        self.progress('原文已保存，等待核验', rawResponsesSaved=len(self.raw), inFlight=None)
        self.frozen()
        require(isinstance(value.get('raw'), str), '返回值缺少学生原文')
        require(not value.get('testDouble') or self.fixture_only, '真实运行拒绝测试替身')
        require(value.get('mathAdapterEnabledDuringGeneration') is enabled, '生成时适配器开关不符')
        require(value.get('sampled') is False and value.get('temperature') == 1., '必须沿用贪心生成')
        require(type(value.get('generatedTokens')) is int and
                0 < value['generatedTokens'] <= MAX_TOKENS and
                len(value.get('generatedIds', [])) == value['generatedTokens'], '生成 token 计数不符')
        require(isinstance(value.get('promptIds'), list) and value['promptIds'] and
                type(value.get('tokenCapReached')) is bool, '缺少完整 token 原文记录')
        return row

    def score(self, row, check):
        saved = dict(copy.deepcopy(row), check=check)
        write_once(self.out / 'responses' / (row['recordId'] + '-scored.json'), saved)
        self.scored.append(saved)
        self.progress('核验已保存', scoredResponses=len(self.scored),
                      coldReproductions=self.cold_ok, oldDraftReproductions=self.off_ok,
                      completePairs=len(self.pairs))

    def run(self, anchors, contexts):
        require(len(anchors) == 8 and len(contexts) == 2, '需要八条旧复现和两个预定实例')
        require([c['draftRecordId'] for c in contexts] == list(CASE_IDS), '不得按新输出更换检查实例')
        for old in anchors:
            row = self.ask('cold_replay', old, True)
            check = exact_reproduction(old['studentOutput'], row['studentOutput'])
            if check['exact']:
                self.cold_ok += 1
            self.score(row, dict(coldReproduction=check))
            require(check['exact'], '旧数学输出未精确复现；停止，不生成新草稿')
        draft_deadline = min(self.deadline, self.clock() + 600)
        off = []
        for context in contexts:
            old = context['draftOriginal']
            row = self.ask('adapter_off_draft', old, False, old['recordId'], draft_deadline)
            check = exact_reproduction(old['studentOutput'], row['studentOutput'])
            if check['exact']:
                self.off_ok += 1
            self.score(row, dict(originalDraftReproduction=check))
            require(check['exact'], '原 adapter-OFF 草稿未精确复现；停止，不进入 ON 比较')
            off.append(row)
        on = [self.ask('adapter_on_draft', c['draftOriginal'], True,
                       c['draftRecordId'], draft_deadline) for c in contexts]
        # All four condition texts now exist before partial content checks.
        for context, left, right in zip(contexts, off, on):
            require(left['studentPrompt'] == right['studentPrompt'] and
                    left['samplingSeed'] == right['samplingSeed'] and
                    left['studentOutput']['promptIds'] == right['studentOutput']['promptIds'],
                    '两边提示、种子或 token 输入不相同')
            left_audit = self.audit(context, left['studentOutput'])
            right_audit = self.audit(context, right['studentOutput'])
            self.score(right, dict(partialDraftAudit=right_audit))
            pair = dict(id=context['draftRecordId'], task=context['task'],
                        sourceMathRecordId=context['actualChosenRoute']['recordId'],
                        sourceAttemptPassed=context['actualChosenRoute']['check']['outcomePassed'],
                        offRecordId=left['recordId'], onRecordId=right['recordId'],
                        samePromptAndSeed=True, samePromptTokenIds=True,
                        outputTextChanged=left['studentOutput']['raw'] != right['studentOutput']['raw'],
                        generatedTokenIdsChanged=left['studentOutput']['generatedIds'] != right['studentOutput']['generatedIds'],
                        offPartialAudit=left_audit, onPartialAudit=right_audit,
                        wholeDraftImprovementEstablished=False,
                        semanticReviewStatus='pending_reading_of_complete_originals')
            write_once(self.out / 'pairs' / (pair['id'] + '.json'), pair)
            self.pairs.append(pair)
            self.progress('配对结果保存', completePairs=len(self.pairs))
        return self.pairs


def markdown(contexts, engine, result):
    lines = ['# ZIP 草稿数学适配器开启／关闭检查', '',
             '状态：' + result['stopReason'] + '；生成尝试 ' + str(engine.attempts) +
             '，已保存原文 ' + str(len(engine.raw)) + '；权重更新＝0，老师调用＝0。', '',
             '固定两个历史对象，复用原来的完整提示与关键词，只切换数学适配器。',
             '这不是新对象泛化检验；两个不同题型的例子不能证明稳定的总体收益。',
             '输出变化不等于理解改善。自动检查只核验原文中已完整写出的数学及少数明确次数陈述；其余解释待阅读。', '',
             '逐份审阅：是否忠实承认实际成败；是否保留变量与对象结构；失败解释是否正确；复用条件与待核验内容是否明确。', '']
    if result.get('error'):
        lines += ['运行错误：' + result['error'], '']
    for c in contexts:
        rid = c['draftRecordId']
        own = c['actualChosenRoute']
        lines += ['## ' + rid, '', '原题：' + c['task']['expression'], '',
                  '实际旧尝试核验：' + ('成功' if own['check']['outcomePassed'] else '失败'), '',
                  '旧数学完整原文：', '', '````text', own['studentOutput']['raw'], '````', '',
                  '两边共用的完整提示：', '', '````text',
                  json.dumps(c['draftOriginal']['studentPrompt'], ensure_ascii=False, indent=2),
                  '````', '']
        for phase, label in [('adapter_off_draft', '数学适配器关闭（原草稿复现）'),
                             ('adapter_on_draft', '数学适配器开启')]:
            rows = [r for r in engine.raw if r['phase'] == phase and r['caseId'] == rid]
            lines += ['### ' + label, '']
            if rows:
                row = rows[0]
                lines += ['完整学生原文：', '', '````text', row['studentOutput']['raw'], '````', '',
                          '到达 token 上限：' + str(row['studentOutput']['tokenCapReached']) +
                          '（此标志本身不证明语句被截断）。', '']
                pairs = [p for p in engine.pairs if p['id'] == rid]
                if pairs:
                    audit = pairs[0]['offPartialAudit' if phase == 'adapter_off_draft' else 'onPartialAudit']
                    lines += ['有限自动检查（不认证整份草稿）：', '', '````json',
                              json.dumps(audit, ensure_ascii=False, indent=2), '````', '']
            else:
                lines += ['该条件尚未生成／保存。', '']
    lines += ['完整语义审阅：待完成。新对象复用：本次未测。草稿入库：无。', '']
    return '\n'.join(lines)
