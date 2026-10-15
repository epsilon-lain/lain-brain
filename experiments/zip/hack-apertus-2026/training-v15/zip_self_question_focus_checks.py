"""v3: student metric selection followed by one question; no plan or reward.

Numerical grounding and a literal metric reference are machine-checkable.
Semantic relevance is explicitly left to review, never inferred from keywords.
"""
import copy
import json
import math
import re

from zip_content_core import digest
from zip_self_question_probe_checks import validate_frame, METRICS, require
from zip_label_metacognitive_checks import strict_json, written_assertions

PROTOCOL = 'lain-zip-frozen-student-metric-question-focus-v3'
PHASES = ('metric_choice', 'metric_question')
MAX_ATTEMPTS = 3
MAX_GENERATIONS = 6
MAX_TOKENS = 96
SCHEDULE = ((1, False), (2, True), (3, True))

# Host-authored descriptions of the EXISTING metric_frame computation, not
# student discoveries, target questions, desired weaknesses or training goals.
MEASUREMENT_DEFINITIONS = {
    'success_probability_mean': 'Average total selector probability assigned to actually verified successful routes, over the eight recorded training objects.',
    'observation_rejected_fraction': 'Fraction of the eight training observations marked rejected by their saved factual audits.',
    'observation_pending_fraction': 'Fraction of the eight training observations marked pending by their saved factual audits.',
    'observation_capped_fraction': 'Fraction of the eight training observations whose original generation reached its token cap.',
    'top_choice_concentration': 'Largest fraction of the eight objects sharing the same highest-probability route. This counts route preferences across objects.',
    'choice_entropy_fraction': 'Mean uncertainty of the three route-choice probability distributions, normalized from zero to one. This is not the probability of one chosen route.',
    'distinct_observation_fraction': 'Number of distinct raw training observation texts divided by the eight original training observations.'}
require(set(MEASUREMENT_DEFINITIONS) == set(METRICS), 'Metric definition coverage changed')


def choice_messages(frame):
    validate_frame(frame)
    table = 'Measured training record, eight objects.\nMetric | Value\n' + '\n'.join(
        name + ' | ' + format(frame['metrics'][name], '.4f') for name in sorted(METRICS))
    return [dict(role='system', content=(
        'Read the measured table. Choose ONE metric yourself and report its table value. '
        'Write only two lines: Metric: your chosen metric name; Value: its number. '
        'Do not write a question, explanation or plan. Finish the two lines yourself.')),
        dict(role='user', content=table + '\nNow write your own metric choice and number only.')]


def parse_choice(raw):
    require(isinstance(raw, str) and 0 < len(raw) <= 2048, 'Bounded actual choice text required')
    span = raw.strip()
    presentation = 'literal_json'
    if span.startswith('```'):
        fence = re.fullmatch(r'```(?:json)?[ \t]*\r?\n(?P<body>[\s\S]+?)\r?\n```', span)
        require(fence is not None, 'A complete student-written fence is required')
        span = fence.group('body')
        presentation = 'student_fenced_json'
    if span.lstrip().startswith('{'):
        original = strict_json(span)
        require(all(isinstance(k, str) for k in original), 'Actual field labels required')
        keys = [k.casefold() for k in original]
        require(len(keys) == len(set(keys)) and set(keys) == {'metric', 'value'},
                'Exactly two distinct choice fields required')
        claim = {k.casefold(): v for k, v in original.items()}
    else:
        require(presentation != 'student_fenced_json', 'Fenced non-JSON choice is unsupported')
        lines = [line for line in span.splitlines() if line.strip()]
        require(len(lines) == 2, 'Two actual labelled choice fields required')
        claim = {}
        for expected, line in zip(('metric', 'value'), lines):
            match = re.fullmatch(r'\s*([A-Za-z]+)\s*:\s*(.*?)\s*', line)
            require(match is not None and match.group(1).casefold() == expected and bool(match.group(2)),
                    'Missing, duplicate, unknown or unfinished choice field')
            value = match.group(2)
            if expected == 'value':
                value = json.loads(value, parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
            claim[expected] = value
        presentation = 'labelled_lines'
    return claim, presentation


def choice_audit(output, frame):
    validate_frame(frame)
    result = dict(protocol=PROTOCOL, phase='metric_choice', selectionVerified=False,
        sourceNumberVerified=False, status='pending', reason=None, frameHash=frame['frameHash'],
        studentRawHash=digest(output['raw']), originalTextRepaired=False, hostChoosesMetric=False,
        hostQuestionTargetSupplied=False, heldoutMetricsUsed=False, trainingCredit=0.)
    if output.get('tokenCapReached'):
        return dict(result, reason='capped_choice_original')
    if output.get('stopReason') != 'eos':
        return dict(result, reason='no_actual_choice_eos')
    try:
        claim, presentation = parse_choice(output['raw'])
        require(isinstance(claim['metric'], str) and claim['metric'] in METRICS,
                'One exact source metric name required')
        require(type(claim['value']) in (int, float) and math.isfinite(claim['value']),
                'One finite actual student number required')
        delta = claim['value'] - frame['metrics'][claim['metric']]
        result.update(claim=claim, presentation=presentation, numericError=delta)
        if abs(delta) > 5e-5 + 1e-12:
            return dict(result, status='rejected', reason='student_number_disagrees_with_source')
        return dict(result, sourceNumberVerified=True, selectionVerified=True,
            status='verified_student_metric_and_number', reason='ready_for_question_stage')
    except (ValueError, TypeError, KeyError):
        return dict(result, reason='invalid_or_incomplete_student_choice')


def question_messages(frame, choice_output, choice_check):
    validate_frame(frame)
    require(choice_audit(choice_output, frame) == choice_check and choice_check['selectionVerified'],
            'Question stage requires the actual verified student choice')
    metric = choice_check['claim']['metric']
    return [dict(role='system', content=(
        'Ask ONE short question about the training metric YOU selected. '
        'Use its exact metric name in your question. End with a question mark. '
        'Write only the question, at most thirty-two words. '
        'Do not copy the table, answer your question, give an action plan or solve a mathematics exercise.')),
        dict(role='user', content=(
            'Your own saved metric choice:\n' + choice_output['raw'] +
            '\nMeasurement definition from the program, supplied by the host:\n' +
            MEASUREMENT_DEFINITIONS[metric] + '\nNow write your own single question.'))]


def question_audit(output, frame, choice_output, choice_check):
    # Revalidate the literal source choice. A changed metric/hash or invented
    # selection certificate must not redirect the second model call.
    question_messages(frame, choice_output, choice_check)
    raw = output['raw']
    metric = choice_check['claim']['metric']
    result = dict(protocol=PROTOCOL, phase='metric_question', reviewCandidate=False,
        status='pending', reason=None, selectedMetric=metric, frameHash=frame['frameHash'],
        studentRawHash=digest(raw), selectedChoiceRawHash=choice_check['studentRawHash'],
        questionBoundaryPresent=False, explicitlyNamesSelectedMetric=False,
        questionRelevanceVerified=False, semanticRelevanceStatus='requires_human_review',
        metricUnderstandingVerified=False, wholeNaturalLanguageCertified=False,
        hostChoosesMetric=False, hostQuestionTargetSupplied=False,
        hostProvidedMeasurementDefinition=True, originalTextRepaired=False,
        activatedAsPromptMetadata=False, heldoutMetricsUsed=False, trainingCredit=0.)
    if output.get('tokenCapReached'):
        return dict(result, reason='capped_question_original')
    if output.get('stopReason') != 'eos':
        return dict(result, reason='no_actual_question_eos')
    if not isinstance(raw, str) or not 0 < len(raw) <= 1024:
        return dict(result, reason='empty_or_overlong_question_original')
    text = raw.strip()
    prefix = re.match(r'(?i)^question\s*:\s*', text)
    if prefix:
        text = text[prefix.end():]
    result['literalQuestionSpan'] = text
    if ('```' in text or len(text) > 512 or len(text.split()) > 32 or
        any(re.match(r'\s*[A-Za-z_][A-Za-z_ ]*\s*:', line) for line in text.splitlines())):
        return dict(result, reason='extra_fields_or_overlong_question')
    result['questionBoundaryPresent'] = text.endswith(('?', '？')) and text.count('?') + text.count('？') == 1
    result['explicitlyNamesSelectedMetric'] = bool(re.search(
        r'(?<![A-Za-z0-9_])' + re.escape(metric) + r'(?![A-Za-z0-9_])', text))
    literal = written_assertions(text)
    result['boundedLiteralFalseEqualityDetected'] = literal['disproved']
    if literal['disproved']:
        return dict(result, status='rejected', reason='known_false_literal_equality_in_question')
    if not result['questionBoundaryPresent']:
        return dict(result, reason='missing_single_question_boundary')
    if not result['explicitlyNamesSelectedMetric']:
        return dict(result, reason='chosen_metric_not_explicitly_named')
    return dict(result, reviewCandidate=True, status='bound_student_question_requires_semantic_review',
                reason='literal_binding_verified_relevance_remains_unverified')


def seed_for(probe_number, attempt, phase):
    require(type(probe_number) is int and 1 <= probe_number <= 1000 and
        type(attempt) is int and 1 <= attempt <= MAX_ATTEMPTS and phase in PHASES,
        'Invalid focus probe number/attempt/phase')
    return 4_300_000_000 + probe_number * 100 + attempt * 10 + PHASES.index(phase) + 1


def run_probe(frame, probe_number, generate, save, frozen, remaining):
    validate_frame(frame)
    completed = []
    for attempt, sampled in SCHEDULE:
        choice_output = choice_check = None
        record_ids = {}
        checks = {}
        for phase in PHASES:
            if phase == 'metric_question' and not choice_check['selectionVerified']:
                break  # No host selection, repaired number, fallback or retry.
            if remaining() <= 0:
                raise TimeoutError('Metric-question focus deadline reached before generation')
            frozen()
            prompt = (choice_messages(frame) if phase == 'metric_choice' else
                      question_messages(frame, choice_output, choice_check))
            value = generate(prompt, phase, seed_for(probe_number, attempt, phase), sampled)
            rid = 'self-question-focus-' + str(attempt) + '-' + phase
            row = dict(recordId=rid, phase=phase, attemptNumber=attempt,
                decodingMode='sampled' if sampled else 'greedy', sampled=sampled,
                samplingSeed=seed_for(probe_number, attempt, phase), studentPrompt=prompt,
                studentOutput=value, frameHash=frame['frameHash'], fixtureOnly=False,
                requestedMathAdapterEnabled=False, requestedSemanticAdapterEnabled=True,
                sourceChoiceRecordId=record_ids.get('metric_choice') if phase == 'metric_question' else None)
            save('raw', row)
            frozen()
            require(not value.get('testDouble') and not value.get('fixtureOnly') and
                type(value.get('generatedTokens')) is int and 0 < value['generatedTokens'] <= MAX_TOKENS and
                len(value['generatedIds']) == len(value['samplingTokenLogProbabilities']) == value['generatedTokens'] and
                all(type(x) in (int, float) and math.isfinite(x) for x in value['samplingTokenLogProbabilities']),
                'Actual original tokens and finite log probabilities required')
            require(type(value.get('sampled')) is bool and value['sampled'] == sampled and
                value.get('mathAdapterEnabledDuringGeneration') is False and
                value.get('semanticAdapterEnabledDuringGeneration') is True,
                'Actual generation conditions differ')
            total = 0.
            for lp in value['samplingTokenLogProbabilities']:
                total += lp
            require(type(value.get('samplingLogProbability')) in (int, float) and
                math.isfinite(value['samplingLogProbability']) and
                abs(total - value['samplingLogProbability']) <= 1e-10,
                'All saved original token log probabilities required')
            check = (choice_audit(value, frame) if phase == 'metric_choice' else
                     question_audit(value, frame, choice_output, choice_check))
            save('scored', dict(row, check=check))
            record_ids[phase] = rid
            checks[phase] = check
            if phase == 'metric_choice':
                choice_output, choice_check = copy.deepcopy(value), copy.deepcopy(check)
        done = dict(id='focus-attempt-' + str(attempt), attemptNumber=attempt,
            decodingMode='sampled' if sampled else 'greedy', recordIds=record_ids, checks=checks,
            selectionVerified=choice_check['selectionVerified'],
            questionSkipped=not choice_check['selectionVerified'],
            reviewCandidate=checks.get('metric_question', {}).get('reviewCandidate', False),
            questionRelevanceVerified=False, trainingCredit=0.)
        save('attempt', done)
        if 'metric_question' in record_ids:
            save('meta-zip', dict(id=done['id'], sourceChoiceRecordId=record_ids['metric_choice'],
                sourceQuestionRecordId=record_ids['metric_question'], selectedMetric=choice_check['claim']['metric'],
                choiceStudentRaw=choice_output['raw'], questionStudentRaw=value['raw'],
                audit=checks['metric_question'], reviewCandidate=done['reviewCandidate'],
                hostProvidedMeasurementDefinition=True, trainingOnly=True, trainingCredit=0.,
                questionRelevanceVerified=False, activatedAsPromptMetadata=False, originalTextRepaired=False))
        completed.append(done)
    return completed


def summary(scored_rows, completed):
    require(len(completed) <= MAX_ATTEMPTS and len({r['attemptNumber'] for r in completed}) == len(completed),
            'Duplicate completed focus attempt')
    choices = [r for r in scored_rows if r['phase'] == 'metric_choice']
    questions = [r for r in scored_rows if r['phase'] == 'metric_question']
    return dict(processedAttempts=len(completed), scheduledAttempts=MAX_ATTEMPTS,
        choiceResponses=len(choices), verifiedStudentChoices=sum(r['check']['selectionVerified'] for r in choices),
        questionResponses=len(questions), questionStagesSkipped=sum(r['questionSkipped'] for r in completed),
        questionsExplicitlyNamingChosenMetric=sum(r['check']['explicitlyNamesSelectedMetric'] for r in questions),
        reviewCandidates=sum(r['check']['reviewCandidate'] for r in questions),
        semanticRelevanceVerified=0, semanticRelevanceRequiresOriginalTextReview=True,
        distinctStudentChosenMetrics=sorted({r['check']['claim']['metric'] for r in choices
                                            if r['check']['selectionVerified']}),
        cappedResponses=sum(bool(r['studentOutput'].get('tokenCapReached')) for r in scored_rows),
        byAttempt=[dict(attemptNumber=r['attemptNumber'], decodingMode=r['decodingMode'],
            selectionVerified=r['selectionVerified'], questionSkipped=r['questionSkipped'],
            reviewCandidate=r['reviewCandidate'], recordIds=r['recordIds']) for r in completed],
        independentTrainingFrames=1, independentTrainingReplications=0,
        hostChoosesMetric=False, hostProvidesMeasurementDefinitions=True,
        hostProvidesTargetQuestionOrPlan=False, questionAndPlanTrainingStarted=False,
        mathematicalBenefitTested=False, automaticCandidateActivation=False,
        retrospectiveScoresChanged=False)
