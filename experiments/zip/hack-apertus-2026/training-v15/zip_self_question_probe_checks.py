"""Frozen format diagnosis. Student questions/plans stay untested hypotheses."""
import copy
import json
import math

from zip_content_core import digest
from zip_label_metacognitive_checks import (METRICS, require, strict_json,
    written_assertions, meta_messages)

PROTOCOL = 'lain-zip-frozen-self-question-format-probe-v1'
CONDITIONS = ('original_json', 'table_json', 'table_lines')
FIELDS = ('metric', 'value', 'question', 'plan')
END_MARKER = '[END_SELF_NOTE]'
MAX_GENERATIONS = 6
MAX_TOKENS = 96


def validate_frame(frame):
    require(frame.get('heldoutIncluded') is False and frame.get('questionsOrPlansSupplied') is False,
            'Only the original training-only numeric frame is permitted')
    require(type(frame.get('trainingObjects')) is int and frame['trainingObjects'] == 8 and
            len(frame.get('evidence', [])) == 8 and
            len({r['taskId'] for r in frame['evidence']}) == 8, 'Eight distinct source training objects required')
    require(set(frame.get('metrics', {})) == set(METRICS) and all(
        type(v) in (int, float) and math.isfinite(v) and 0 <= v <= 1
        for v in frame['metrics'].values()), 'Original finite training metrics required')
    body = {k: v for k, v in frame.items() if k != 'frameHash'}
    require(digest(body) == frame['frameHash'], 'Training metric frame hash changed')


def messages(frame, condition, previous=None):
    validate_frame(frame)
    require(condition in CONDITIONS, 'Unknown format condition')
    if condition == 'original_json':
        return meta_messages(frame, previous)
    table = 'Measured training record, eight objects.\nMetric | Value\n' + '\n'.join(
        name + ' | ' + format(frame['metrics'][name], '.4f') for name in sorted(METRICS))
    if previous:
        table += '\nEarlier student hypothesis, still untested:\n' + previous['studentRaw']
    common = ('Read the measured table. Choose ONE metric yourself. Ask your own short question '
              'about that metric and propose your own short action to test. Report its table value. '
              'Your question and plan are hypotheses. Use at most twelve words for question and '
              'sixteen words for plan. Do not copy the table or solve a mathematics exercise. ')
    if condition == 'table_json':
        instructions = ('Write one JSON object with exactly metric, value, question, plan. '
                        'Value is a number. No headings or code fences. Close the object yourself.')
        ending = '\nNow write your own four-field JSON note only.'
    else:
        instructions = ('Write exactly four lines in this order: metric: your chosen metric name; '
                        'value: its number; question: your own question; plan: your own action. '
                        'Then write ' + END_MARKER + ' on its own line. No other lines or code fences.')
        ending = '\nNow write your own four-line note and its end marker only.'
    return [dict(role='system', content=common + instructions), dict(role='user', content=table + ending)]


def parse_lines(raw):
    require(isinstance(raw, str), 'Student note must be text')
    lines = raw.strip().splitlines()
    require(len(lines) == 5 and lines[-1] == END_MARKER, 'Actual student end marker and four lines required')
    claim = {}
    for key, line in zip(FIELDS, lines[:-1]):
        prefix = key + ':'
        require(line.startswith(prefix), 'Four exact ordered student fields required')
        text = line[len(prefix):].strip()
        require(bool(text), 'Student field is unfinished')
        if key == 'value':
            text = json.loads(text, parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
        claim[key] = text
    return claim


def closure_reached(raw, condition):
    try:
        if condition == 'table_lines':
            parse_lines(raw)
        else:
            strict_json(raw)
        return True
    except (ValueError, TypeError, KeyError):
        return False


def audit(output, frame, condition):
    validate_frame(frame)
    require(condition in CONDITIONS, 'Unknown format condition')
    raw = output['raw']
    result = dict(protocol=PROTOCOL, condition=condition, accepted=False, status='pending',
        parsedCompleteRecord=False, quantitativeClaimVerified=False, metric=None,
        frameHash=frame['frameHash'], studentRawHash=digest(raw), originalTextRepaired=False,
        questionAndPlanRemainUntestedHypotheses=True, wholeNaturalLanguageCertified=False,
        hostQuestionOrPlanSupplied=False, heldoutMetricsUsed=False, activatedAsPromptMetadata=False)
    if output.get('tokenCapReached'):
        return dict(result, reason='capped_original')
    try:
        claim = parse_lines(raw) if condition == 'table_lines' else strict_json(raw)
        result['parsedCompleteRecord'] = True
        require(set(claim) == set(FIELDS), 'Four exact fields required')
        require(isinstance(claim['metric'], str) and claim['metric'] in METRICS, 'Unknown student metric')
        require(type(claim['value']) in (int, float) and math.isfinite(claim['value']), 'Finite student number required')
        for key, length, words in (('question', 180, 12), ('plan', 240, 16)):
            require(isinstance(claim[key], str) and 0 < len(claim[key]) <= length and
                    len(claim[key].split()) <= words, 'Student question/plan is empty or too long')
        require(claim['question'].rstrip().endswith('?'), 'A complete student question is required')
        result.update(metric=claim['metric'], claim=claim)
        if abs(claim['value'] - frame['metrics'][claim['metric']]) > 5e-5 + 1e-12:
            return dict(result, status='rejected', reason='numeric_claim_disagrees_with_source_metrics')
        if written_assertions(claim['question'] + '\n' + claim['plan'])['disproved']:
            return dict(result, status='rejected', reason='literal_false_equality_in_student_question_or_plan')
        return dict(result, accepted=True, status='verified_numeric_claim_and_format',
                    quantitativeClaimVerified=True, reason='question_and_plan_remain_hypotheses')
    except (ValueError, TypeError, KeyError):
        return dict(result, reason='invalid_or_incomplete_student_record')


def seed_for(probe_number, slot):
    require(type(probe_number) is int and 1 <= probe_number <= 1000 and slot in (1, 2), 'Invalid probe number/slot')
    return 4_100_000_000 + probe_number * 100 + slot


def run_probe(frame, previous, probe_number, generate, save, frozen, remaining):
    """Six predetermined paired calls; no adaptive retries, rewards or updates."""
    validate_frame(frame)
    saved = []
    for slot, sampled in ((1, False), (2, True)):
        # Fixed reverse order for the second decoding mode, never score-driven.
        order = CONDITIONS if slot == 1 else tuple(reversed(CONDITIONS))
        for condition in order:
            if remaining() <= 0:
                raise TimeoutError('Self-question probe deadline reached before generation')
            frozen()
            prompt = messages(frame, condition, previous)
            value = generate(prompt, condition, seed_for(probe_number, slot), sampled)
            row = dict(recordId='self-question-probe-' + str(slot) + '-' + condition,
                condition=condition, decodingMode='sampled' if sampled else 'greedy',
                samplingSeed=seed_for(probe_number, slot), studentPrompt=prompt, studentOutput=value,
                frameHash=frame['frameHash'], requestedMathAdapterEnabled=False,
                requestedSemanticAdapterEnabled=True, fixtureOnly=False)
            save('raw', row)  # Preserve returned original even if a frozen check/audit fails.
            frozen()
            require(not value.get('testDouble') and not value.get('fixtureOnly') and
                type(value.get('generatedTokens')) is int and 0 < value['generatedTokens'] <= MAX_TOKENS and
                len(value['generatedIds']) == len(value['samplingTokenLogProbabilities']) == value['generatedTokens'],
                'Actual sampled original and all token log probabilities required')
            require(type(value.get('sampled')) is bool and value['sampled'] == sampled,
                    'Decoding condition differs from original')
            check = audit(value, frame, condition)
            complete = dict(row, check=check)
            save('scored', complete)
            save('meta-zip', dict(id=row['recordId'], sourceRecordId=row['recordId'],
                studentRaw=value['raw'], audit=check, parsedStudentClaim=copy.deepcopy(check.get('claim')),
                trainingOnly=True, activatedAsPromptMetadata=False, originalTextRepaired=False,
                mathematicalRule=False, questionAndPlanRemainUntestedHypotheses=True))
            saved.append(complete)
    return saved


def summary(rows):
    records = list(rows)
    result = {}
    for condition in CONDITIONS:
        group = [r for r in records if r['condition'] == condition]
        modes = {}
        for mode in ('greedy', 'sampled'):
            selected = [r for r in group if r['decodingMode'] == mode]
            require(len(selected) <= 1, 'Duplicate condition/decoding original')
            modes[mode] = (dict(recordId=selected[0]['recordId'], accepted=selected[0]['check']['accepted'],
                status=selected[0]['check']['status'], reason=selected[0]['check']['reason'],
                generatedTokens=selected[0]['studentOutput']['generatedTokens']) if selected else None)
        result[condition] = dict(completedResponses=len(group),
            accepted=sum(r['check']['accepted'] for r in group),
            capped=sum(bool(r['studentOutput'].get('tokenCapReached')) for r in group),
            completePair=len(group) == 2, byDecodingMode=modes)
    return dict(byCondition=result, interfaceCandidatesForFurtherTesting=[c for c in CONDITIONS[1:]
        if result[c]['completePair'] and result[c]['accepted'] == 2],
        independentTrainingFrames=1, independentTrainingReplications=0, newMathematicsObjects=0,
        formattingIsNotMetacognitiveAbilityProof=True, numericCertificateDoesNotCertifyQuestionOrPlan=True,
        causalPerformanceBenefitTested=False, automaticTrainingStarted=False)
