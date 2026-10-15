"""Literal record diagnostics; numbers are checked, hypotheses stay untested.

This is a new prospective protocol. It never replaces the historical v1 score.
Field-label case and blank separators are presentation only; no student words,
numbers, punctuation, missing fields or ending tokens are invented.
"""
import copy
import json
import math
import re

from zip_content_core import digest
from zip_self_question_probe_checks import (validate_frame, messages as old_messages,
    audit as old_audit, FIELDS, END_MARKER, METRICS, require)
from zip_label_metacognitive_checks import written_assertions

PROTOCOL = 'lain-zip-frozen-self-question-natural-probe-v2'
CONDITIONS = ('legacy_lines', 'natural_semantic', 'natural_base')
MAX_GENERATIONS = 6
MAX_TOKENS = 96


def semantic_enabled(condition):
    require(condition in CONDITIONS, 'Unknown natural probe condition')
    return condition != 'natural_base'


def messages(frame, condition, previous=None):
    validate_frame(frame)
    require(condition in CONDITIONS, 'Unknown natural probe condition')
    if condition == 'legacy_lines':
        return old_messages(frame, 'table_lines', previous)
    table = 'Measured training record, eight objects.\nMetric | Value\n' + '\n'.join(
        name + ' | ' + format(frame['metrics'][name], '.4f') for name in sorted(METRICS))
    if previous:
        table += '\nEarlier student hypothesis, still untested:\n' + previous['studentRaw']
    instructions = (
        'Read your measured training table. Choose ONE metric yourself. Write a short question '
        'about it and your own action to test. Your question and plan remain hypotheses. '
        'Write four labelled fields, one field per line, in this order: '
        'Metric: the chosen metric name; Value: its table number; '
        'Question: your own complete question ending in a question mark; '
        'Plan: your own complete action sentence ending in a period. '
        'Use at most thirty-two words for each question and plan. '
        'No JSON, code fences, table copy, mathematics exercise or special end marker. '
        'Finish your Plan sentence and then stop naturally.')
    return [dict(role='system', content=instructions),
            dict(role='user', content=table + '\nNow write your own four-field note only.')]


def parse_literal_lines(raw):
    """Read labelled spans verbatim; the only ignored characters are spacing.

    Returns the actual marker flag separately. Case-insensitive field labels
    cannot merge duplicate fields or supply missing question/plan prose.
    """
    require(isinstance(raw, str) and 0 < len(raw) <= 4096, 'Bounded original text required')
    lines = [line for line in raw.splitlines() if line.strip()]
    marker = bool(lines and lines[-1].strip() == END_MARKER)
    if marker:
        lines = lines[:-1]
    require(len(lines) == 4, 'Four actual nonempty fields required')
    claim, spans = {}, {}
    for expected, line in zip(FIELDS, lines):
        match = re.fullmatch(r'\s*([A-Za-z]+)\s*:\s*(.*?)\s*', line)
        require(match is not None and match.group(1).casefold() == expected,
                'Unknown, duplicate, missing or out-of-order field')
        text = match.group(2)
        require(bool(text), 'Empty student field')
        spans[expected] = text
        if expected == 'value':
            text = json.loads(text, parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
        claim[expected] = text
    return claim, spans, marker


def audit(output, frame):
    validate_frame(frame)
    raw = output['raw']
    result = dict(protocol=PROTOCOL, reviewCandidate=False, status='pending', reason=None,
        literalFourFieldsPresent=False, naturalSentencesComplete=False,
        sourceNumberVerified=False, boundedLiteralFalseEqualityDetected=False,
        actualEndMarkerPresent=False, stopReason=output.get('stopReason'),
        frameHash=frame['frameHash'], studentRawHash=digest(raw), originalTextRepaired=False,
        questionAndPlanRemainUntestedHypotheses=True, metricUnderstandingVerified=False,
        questionRelevanceVerified=False, planUsefulnessVerified=False,
        wholeNaturalLanguageCertified=False, hostQuestionOrPlanSupplied=False,
        heldoutMetricsUsed=False, activatedAsPromptMetadata=False, trainingCredit=0.)
    try:
        claim, spans, marker = parse_literal_lines(raw)
        result.update(literalFourFieldsPresent=True, claim=claim, literalFieldSpans=spans,
                      actualEndMarkerPresent=marker)
        require(isinstance(claim['metric'], str) and claim['metric'] in METRICS,
                'Unknown student metric')
        require(type(claim['value']) in (int, float) and math.isfinite(claim['value']),
                'Finite actual student number required')
        error = claim['value'] - frame['metrics'][claim['metric']]
        result.update(numericError=error, sourceNumberVerified=abs(error) <= 5e-5 + 1e-12)
        if not result['sourceNumberVerified']:
            return dict(result, status='rejected', reason='numeric_claim_disagrees_with_source_metrics')
        words = {key: len(claim[key].split()) for key in ('question', 'plan')}
        sentences = (claim['question'].endswith(('?', '？')) and
                     claim['plan'].endswith(('.', '!', '。', '！')))
        bounded = all(0 < len(claim[key]) <= 512 and words[key] <= 32 for key in words)
        result.update(naturalSentencesComplete=sentences, wordCounts=words,
                      boundedQuestionAndPlan=bounded)
        false_math = written_assertions(claim['question'] + '\n' + claim['plan'])['disproved']
        result['boundedLiteralFalseEqualityDetected'] = false_math
        if false_math:
            return dict(result, status='rejected', reason='literal_false_equality_in_question_or_plan')
        # EOS alone does not certify missing prose. Full fields and sentence
        # endings are required as well; a token cap never receives completion.
        if output.get('tokenCapReached'):
            return dict(result, reason='capped_original')
        actual_stop = (output.get('stopReason') == 'eos' or
            (marker and output.get('studentEndMarkerReached') is True and
             output.get('stopReason') == 'student_record_closure'))
        if not actual_stop:
            return dict(result, reason='no_actual_eos_or_student_marker')
        if not sentences or not bounded:
            return dict(result, reason='unfinished_or_overlong_question_or_plan')
        return dict(result, reviewCandidate=True, status='readable_numeric_record_hypotheses_only',
                    reason='number_verified_content_requires_independent_review')
    except (ValueError, TypeError, KeyError):
        return dict(result, reason='invalid_or_incomplete_literal_record')


def seed_for(probe_number, slot):
    require(type(probe_number) is int and 1 <= probe_number <= 1000 and slot in (1, 2),
            'Invalid natural probe number/slot')
    return 4_200_000_000 + probe_number * 100 + slot


def run_probe(frame, previous, probe_number, generate, save, frozen, remaining):
    """Fixed six calls: legacy interface, natural interface, semantic ablation."""
    validate_frame(frame)
    rows = []
    for slot, sampled in ((1, False), (2, True)):
        order = CONDITIONS if slot == 1 else tuple(reversed(CONDITIONS))
        for condition in order:
            if remaining() <= 0:
                raise TimeoutError('Natural self-question probe deadline reached before generation')
            frozen()
            prompt = messages(frame, condition, previous)
            enabled = semantic_enabled(condition)
            value = generate(prompt, condition, seed_for(probe_number, slot), sampled)
            row = dict(recordId='self-question-natural-' + str(slot) + '-' + condition,
                condition=condition, decodingMode='sampled' if sampled else 'greedy',
                samplingSeed=seed_for(probe_number, slot), studentPrompt=prompt, studentOutput=value,
                frameHash=frame['frameHash'], requestedMathAdapterEnabled=False,
                requestedSemanticAdapterEnabled=enabled, fixtureOnly=False)
            save('raw', row)
            frozen()
            require(not value.get('testDouble') and not value.get('fixtureOnly') and
                type(value.get('generatedTokens')) is int and 0 < value['generatedTokens'] <= MAX_TOKENS and
                len(value['generatedIds']) == len(value['samplingTokenLogProbabilities']) == value['generatedTokens'] and
                all(type(x) in (int, float) and math.isfinite(x) for x in value['samplingTokenLogProbabilities']),
                'Actual student tokens and all finite log probabilities required')
            require(type(value.get('sampled')) is bool and value['sampled'] == sampled and
                value.get('mathAdapterEnabledDuringGeneration') is False and
                type(value.get('semanticAdapterEnabledDuringGeneration')) is bool and
                value['semanticAdapterEnabledDuringGeneration'] == enabled,
                'Actual decoding/adapter condition differs from requested condition')
            check = audit(value, frame)
            complete = dict(row, check=check, legacyV1Check=(
                old_audit(value, frame, 'table_lines') if condition == 'legacy_lines' else None))
            save('scored', complete)
            save('meta-zip', dict(id=row['recordId'], sourceRecordId=row['recordId'],
                studentRaw=value['raw'], audit=check, parsedStudentClaim=copy.deepcopy(check.get('claim')),
                trainingOnly=True, activatedAsPromptMetadata=False, originalTextRepaired=False,
                mathematicalRule=False, questionAndPlanRemainUntestedHypotheses=True))
            rows.append(complete)
    return rows


def summary(rows):
    result = {}
    for condition in CONDITIONS:
        group = [row for row in rows if row['condition'] == condition]
        modes = {}
        for mode in ('greedy', 'sampled'):
            selected = [r for r in group if r['decodingMode'] == mode]
            require(len(selected) <= 1, 'Duplicate condition/decoding original')
            modes[mode] = (dict(recordId=selected[0]['recordId'],
                reviewCandidate=selected[0]['check']['reviewCandidate'],
                status=selected[0]['check']['status'], reason=selected[0]['check']['reason'],
                sourceNumberVerified=selected[0]['check']['sourceNumberVerified'],
                generatedTokens=selected[0]['studentOutput']['generatedTokens'],
                legacyV1Accepted=(selected[0]['legacyV1Check']['accepted']
                    if selected[0]['legacyV1Check'] is not None else None)) if selected else None)
        result[condition] = dict(completedResponses=len(group), completePair=len(group) == 2,
            literalFourFieldRecords=sum(r['check']['literalFourFieldsPresent'] for r in group),
            numericClaimsVerified=sum(r['check']['sourceNumberVerified'] for r in group),
            reviewCandidates=sum(r['check']['reviewCandidate'] for r in group),
            capped=sum(bool(r['studentOutput'].get('tokenCapReached')) for r in group),
            semanticAdapterEnabled=semantic_enabled(condition), byDecodingMode=modes)
    return dict(byCondition=result,
        comparisons=dict(interface=['legacy_lines', 'natural_semantic'],
            frozenSemanticAdapter=['natural_semantic', 'natural_base'],
            adapterComparisonUsesIdenticalPromptsSamplerBudgetsAndPairedSeeds=True,
            commonLiteralAuditUsedForAllConditions=True,
            legacyV1ScoresRetainedSeparately=True),
        independentTrainingFrames=1, independentTrainingReplications=0, newMathematicsObjects=0,
        quantitativeClaimDoesNotCertifyMetricUnderstanding=True,
        questionRelevanceAndPlanUsefulnessTested=False,
        causalPerformanceBenefitTested=False, automaticTrainingStarted=False,
        automaticCandidateActivation=False, retrospectiveV1ScoresChanged=False)
