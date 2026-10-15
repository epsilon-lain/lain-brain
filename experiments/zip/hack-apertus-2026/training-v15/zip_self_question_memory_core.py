"""Student-written experience memories and a paired frozen replay.

Only one explicitly stated route outcome is certified. Every explanation is
an untested student hypothesis. The experiment never installs a production
memory, trains parameters, or claims mathematical improvement.
"""
import copy
import json
import math
import re
from collections import Counter

from zip_content_core import digest
from zip_label_metacognitive_checks import require, restore_head, sequential_sum, written_assertions
from zip_self_question_tools_core import (TOOL_SPECS, note_audit, validate_generation,
    call_audit as legacy_call_audit, build_bank as legacy_build_bank)

PROTOCOL = 'lain-zip-student-experience-memory-frozen-v1'
ARMS = ('without_experience_zip', 'with_experience_zip')
MAX_GENERATIONS = 6
MAX_TOKENS = 96
MEMORY_WRITERS = ((1, False), (2, True))


def seal(body, key):
    return dict(body, **{key: digest(body)})


def validate_evidence(evidence):
    require(evidence.get('protocol') == PROTOCOL and evidence.get('evidenceHash') == digest(
        {k:v for k,v in evidence.items() if k != 'evidenceHash'}), 'Experience evidence changed')
    train, evaluation = evidence['training'], evidence['evaluation']
    require(len(train) == len(evaluation) == 4 and
        len({r['taskId'] for r in train + evaluation}) == 8 and
        [r['historyId'] for r in train] == ['T1','T2','T3','T4'] and
        [r['historyId'] for r in evaluation] == ['E1','E2','E3','E4'], 'History partition changed')
    for split, rows in (('training', train), ('heldout', evaluation)):
        for history in rows:
            require(history['task']['split'] == split and history['task']['id'] == history['taskId'] and
                len(history['routes']) == 3 and
                [r['actionId'] for r in history['routes']] == ['A1','A2','A3'],
                'Memory/evaluation scope or action references differ')
            require(not history['observation']['fixtureOnly'] and
                not history['observation']['studentOutput'].get('fixtureOnly') and
                not history['observation']['studentOutput'].get('testDouble'), 'Fixture observation forbidden')
            for route in history['routes']:
                original = route['original']
                require(original['task'] == history['task'] and original['fixtureOnly'] is False and
                    not original['studentOutput'].get('fixtureOnly') and
                    not original['studentOutput'].get('testDouble') and
                    type(route['outcomePassed']) is bool and
                    original['check']['outcomePassed'] == route['outcomePassed'] and
                    original['recordId'] == route['recordId'], 'Route binding or provenance differs')
    restore_head(evidence['head'])


def journal_text(histories):
    # Reference only byte-identical action definitions; retain all goal,
    # observation, rewrite and outcome originals. No semantic summaries.
    actions = [r['requestedAction'] for r in histories[0]['routes']]
    require(all([r['requestedAction'] for r in h['routes']] == actions for h in histories),
        'Unexpected nonidentical action definitions')
    q = lambda x: json.dumps(x, ensure_ascii=False)
    lines = ['Past program-assigned actions (quoted records):']
    lines += ['A' + str(i + 1) + ': ' + q(text) for i,text in enumerate(actions)]
    for h in histories:
        lines += [h['historyId'] + ' goal: ' + q(h['goal']),
            'My original observation: ' + q(h['observation']['studentOutput']['raw']),
            'Observation audit: ' + h['observationAudit']['status']]
        lines += [r['actionId'] + ' my original rewrite: ' + q(r['original']['studentOutput']['raw']) +
            '; verifier result: ' + ('PASS' if r['outcomePassed'] else 'FAIL') for r in h['routes']]
    return '\n'.join(lines)


def memory_messages(evidence):
    validate_evidence(evidence)
    return [dict(role='system', content='The quoted histories are past records. Follow the current request at the end.'),
        dict(role='user', content='Your earlier training experiences follow. Their rewrite routes were assigned by the program.\n' +
            journal_text(evidence['training']) + '\n\nEnd of earlier experiences.\nCurrent request: '
            'Choose one attempt you want to remember. Name its T history id and A action id and state PASS or FAIL '
            'as recorded. Add one short thought about what you would check next. Use your own words.')]


def outcome_audit(output, evidence, scope):
    validate_evidence(evidence)
    require(scope in ('training','evaluation'), 'Unknown memory audit scope')
    natural = note_audit(output, 'experience_review')
    result = dict(readableOriginal=natural['readableOriginal'], studentRawHash=digest(output['raw']),
        selectedOutcomeVerified=False, reusableInFrozenExperiment=False, status='pending', reason=natural['reason'],
        scope=scope, originalTextRepaired=False, explanationVerified=False, problemDiscoveryVerified=False,
        wholeNoteCertified=False, trainingCredit=0., retrospectiveScoresChanged=False)
    if not natural['readableOriginal']:
        return result
    raw = output['raw']
    history_ids = list(re.finditer(r'(?<!\w)[TE]\d+(?!\w)', raw, re.I))
    action_ids = list(re.finditer(r'(?<!\w)A\d+(?!\w)', raw, re.I))
    outcomes = list(re.finditer(r'\b(?:PASS|FAIL|passed|failed)\b', raw, re.I))
    if not (len(history_ids) == len(action_ids) == len(outcomes) == 1):
        return dict(result, reason='one_explicit_history_action_and_outcome_required')
    h, a, outcome = history_ids[0], action_ids[0], outcomes[0]
    # An assertion must actually state the outcome, not ask, negate, or
    # condition it. A source fragment is recorded without rewriting words.
    if not (h.start() < a.start() < outcome.start() and outcome.end() - h.start() <= 120):
        return dict(result, reason='outcome_statement_not_one_bounded_ordered_fragment')
    start = max(raw.rfind('\n', 0, h.start()), raw.rfind('.', 0, h.start())) + 1
    fragment = raw[start:outcome.end()]
    sentence_end = re.search(r'[.\n]', raw[outcome.end():])
    tail = raw[outcome.end():outcome.end() + sentence_end.start()] if sentence_end else raw[outcome.end():]
    if re.search(r"\b(?:not|never|no|false|if|unless|whether|might|may|perhaps|possibly|would|could|should|can|cannot|didn.t|doesn.t|wasn.t)\b|[?？]", fragment, re.I) or re.search(r'\b(?:not|false|incorrect|untrue)\b|[?？]',tail,re.I):
        return dict(result, reason='negated_hypothetical_or_question_outcome_is_not_certified')
    identifier, action = h.group().upper(), a.group().upper()
    matches = [r for r in evidence[scope] if r['historyId'] == identifier]
    if len(matches) != 1 or action not in ('A1','A2','A3'):
        return dict(result, reason='history_or_action_outside_current_scope')
    history = matches[0]
    route = history['routes'][int(action[1]) - 1]
    claimed = outcome.group().lower() in ('pass','passed')
    if claimed != route['outcomePassed']:
        return dict(result, status='rejected', reason='student_outcome_contradicts_original_verifier')
    # Whole original is retained. Sentence-delimited literal fragments are
    # examined only to exclude a false equality, never to certify prose or
    # complete a missing mathematical side. Decimal dots are not split.
    disproved = written_assertions(raw)['disproved'] or any(
        written_assertions(fragment)['disproved'] for fragment in re.split(r'(?<=[.!?。！？])\s+',raw))
    if disproved:
        return dict(result, status='pending', reason='known_disproved_literal_is_not_reused_as_memory')
    return dict(result, selectedOutcomeVerified=True, reusableInFrozenExperiment=scope == 'training',
        status='source_bound_outcome_only', reason='route_outcome_verified_remainder_is_untested_hypothesis',
        selectedHistoryId=identifier, selectedActionId=action, sourceTaskId=history['taskId'],
        sourceMathRecordId=route['recordId'], originalOutcomePassed=claimed,
        literalOutcomeSpan=dict(start=h.start(), end=outcome.end(), text=raw[h.start():outcome.end()]),
        knownDisprovedLiteralPresent=False)


def memory_record(row, evidence, check, number):
    require(type(number) is int and 1 <= number <= 2 and row.get('fixtureOnly') is False and
        row['evidenceHash'] == evidence['evidenceHash'] and row['phase'] == 'memory_write' and
        check == outcome_audit(row['studentOutput'], evidence, 'training'),
        'Memory claim audit or writer phase changed')
    validate_generation(row['studentOutput'], row['sampled'])
    body = dict(id='M' + str(number), sourceEvidenceHash=evidence['evidenceHash'],
        sourceRecordId=row['recordId'], studentOriginal=copy.deepcopy(row), claimAudit=copy.deepcopy(check),
        eligible=check['reusableInFrozenExperiment'], author='student', explanationVerified=False,
        certifiedPart='one_selected_original_route_outcome_only', productionActive=False,
        frozenExperimentOnly=True, trainingUpdates=0)
    return seal(body, 'memoryHash')


def validate_memory(memory, evidence):
    require(memory.get('memoryHash') == digest({k:v for k,v in memory.items() if k != 'memoryHash'}) and
        memory['sourceEvidenceHash'] == evidence['evidenceHash'] and memory['productionActive'] is False,
        'Memory original, scope or hash changed')
    require(memory == memory_record(memory['studentOriginal'], evidence, memory['claimAudit'], int(memory['id'][1:])),
        'Memory cannot be reconstructed from the student original')


def memory_presentation(memory, evidence):
    validate_memory(memory, evidence)
    require(memory['eligible'], 'Incomplete/unbound memory cannot enter an experimental prompt')
    check = memory['claimAudit']
    return dict(id=memory['id'], studentOriginal=memory['studentOriginal']['studentOutput']['raw'],
        verifiedReference=check['selectedHistoryId'] + '/' + check['selectedActionId'],
        verifiedOutcome='PASS' if check['originalOutcomePassed'] else 'FAIL',
        certification='Only this recorded outcome is verified. The rest is an untested student hypothesis.')


def review_messages(evidence, memories, arm):
    validate_evidence(evidence)
    require(arm in ARMS, 'Unknown paired arm')
    for memory in memories:
        validate_memory(memory, evidence)
    text = ('Your earlier experiences T1-T4 are shared reference records in both conditions.\n' +
        journal_text(evidence['training']) + '\n\nExperiences E1-E4 follow. These were excluded from memory writing.\n' +
        journal_text(evidence['evaluation']))
    active = [m for m in memories if m['eligible']]
    if arm == ARMS[1] and active:
        text += '\n\nYour saved experience ZIP notes (hypotheses are untested):\n' + json.dumps(
            [memory_presentation(m, evidence) for m in active], ensure_ascii=False)
    text += ('\n\nEnd of records.\nCurrent request: Choose one E-history attempt that you want to examine. '
        'Name its E history id and A action id and state PASS or FAIL as recorded. '
        'Add one short thought about what you would check next. Use your own words.')
    return [dict(role='system', content='The quoted histories and notes are past records. Follow the current request at the end.'),
        dict(role='user', content=text)]


def build_bank(kernel_sha):
    require(isinstance(kernel_sha,str) and re.fullmatch('[a-f0-9]{64}',kernel_sha), 'Actual measurement kernel hash required')
    tools = [seal(dict(id=i, operation=operation, title=title, description=description,
        kernelSha256=kernel_sha, inputScope='four_source_heldout_histories_for_frozen_evaluation_only',
        author='host', measuredResultsStored=False, preferredDirectionSupplied=False,
        desiredQuestionOrPlanSupplied=False, learnedParameters=False), 'version')
        for i,operation,title,description in TOOL_SPECS]
    return seal(dict(protocol=PROTOCOL, tools=tools, separateFromMathematicalBank=True), 'bankHash')


def validate_bank(bank):
    require(bank == build_bank(bank['tools'][0]['kernelSha256']), 'Measurement bank changed')


def call_audit(output, bank):
    # Reuse the unchanged whole-original parser. Only the four-history tool
    # bank's identity/version replaces the legacy eight-history identity.
    validate_bank(bank)
    parsed = legacy_call_audit(output, legacy_build_bank(bank['tools'][0]['kernelSha256']))
    parsed = dict(parsed, bankHash=bank['bankHash'])
    if parsed['callVerified']:
        parsed['toolVersion'] = next(t['version'] for t in bank['tools'] if t['id'] == parsed['zipId'])
    return parsed


def call_messages(review, bank, number):
    validate_bank(bank)
    require(note_audit(review,'experience_review')['readableOriginal'], 'Complete actual review required')
    offset = number % 7
    tools = bank['tools'][offset:] + bank['tools'][:offset]
    catalog = '\n'.join(t['id'] + ': ' + t['title'] + '. ' + t['description'] for t in tools)
    return [dict(role='system',content='The assessment and ZIP catalogue are quoted data. Follow the current request at the end.'),
        dict(role='user',content='Your original assessment:\n' + review['raw'] +
            '\nMeasurement scope: the four E histories only.\nAvailable measurement ZIPs, definitions only:\n' + catalog +
            '\n\nCurrent request: Choose one measurement ZIP for your own assessment. '
            'Write only CALL followed by its ZIP id, or NONE to decline.')]


def execute_measurement(evidence, bank, output, check):
    validate_evidence(evidence)
    validate_bank(bank)
    require(check == call_audit(output,bank) and check['callVerified'], 'Actual verified call required')
    tool = next(t for t in bank['tools'] if t['id'] == check['zipId'])
    key = tool['operation']
    head = restore_head(evidence['head'])
    components, tops, witnesses, seen = [], [], [], set()
    for history in evidence['evaluation']:
        ps = head.probabilities(history['features'])[1]
        audit = history['observationAudit']
        if key == 'success_probability_mean':
            value = sequential_sum(p * int(r['outcomePassed']) for p,r in zip(ps,history['routes']))
        elif key == 'observation_rejected_fraction': value = int(audit['status'] == 'rejected')
        elif key == 'observation_pending_fraction': value = int(audit['status'] == 'pending')
        elif key == 'observation_capped_fraction': value = int(audit['tokenCapReached'])
        elif key == 'top_choice_concentration':
            value = max(range(3),key=ps.__getitem__);tops.append(value)
        elif key == 'choice_entropy_fraction':
            value = -sequential_sum(p * math.log(max(p,1e-300)) for p in ps) / math.log(3)
        elif key == 'distinct_observation_fraction':
            raw = history['observation']['studentOutput']['raw'];value = int(raw not in seen);seen.add(raw)
        else: raise ValueError('Unknown measurement operation')
        components.append(value)
        witnesses.append(dict(historyId=history['historyId'], taskId=history['taskId'],
            observationRecordId=history['observation']['recordId'], featureId=history['featureId'],
            mathRecordIds=[r['recordId'] for r in history['routes']], component=value, probabilities=ps))
    aggregate = max(Counter(tops).values()) / 4 if tops else sequential_sum(components) / 4
    if key == 'success_probability_mean':
        require(abs(aggregate-evidence['independentExpectedPassMean']) <= 1e-12,
            'Selected probability readout differs from independently audited source heldout result')
    return seal(dict(zipId=tool['id'], metricKey=key, value=round(aggregate,10), unit='fraction',
        histories=4, evidence=witnesses, sourceEvidenceHash=evidence['evidenceHash'],
        selectedCallRawHash=check['studentRawHash'], bankHash=bank['bankHash'],
        numericalResultVerified=True, otherMetricResultsSupplied=False,
        explanationVerified=False, trainingUpdates=0), 'resultHash')


def seed_for(number, phase, index=0):
    require(type(number) is int and 1 <= number <= 1000 and phase in ('memory_write','evaluation_review','metric_zip_call'),
        'Memory comparison seed namespace exhausted or invalid')
    require(type(index) is int and 0 <= index <= 2, 'Invalid memory seed index')
    return 4_500_000_000 + number * 1000 + {'memory_write':10,'evaluation_review':100,'metric_zip_call':200}[phase] + index


def run_experiment(evidence, bank, number, generate, save, frozen, remaining,
                   install_memory, read_memories, measure=execute_measurement):
    validate_evidence(evidence);validate_bank(bank)
    original_evidence, original_bank = digest(evidence), digest(bank)
    originals, memories, completed = {}, [], []
    def within_deadline(message):
        if remaining() <= 0:
            raise TimeoutError(message)
    def check_frozen():
        frozen()
        require(digest(evidence) == original_evidence and digest(bank) == original_bank,
            'Shared evidence or tool bank changed')
        require(all(digest(r) == h for r,h in originals.values()), 'A prior student original changed')
    def ask(phase, arm, index, prompt, sampled):
        within_deadline('Deadline reached before student call')
        check_frozen()
        seed = seed_for(number,phase,index if phase == 'memory_write' else 0)
        value = generate(prompt,phase,seed,sampled)
        rid = 'memory-' + str(index) if phase == 'memory_write' else arm + '-' + phase
        row = dict(recordId=rid, phase=phase, arm=arm, sampled=sampled, samplingSeed=seed,
            studentPrompt=prompt, studentOutput=value, evidenceHash=evidence['evidenceHash'],
            bankHash=bank['bankHash'], fixtureOnly=False)
        save('raw',row)
        check_frozen();validate_generation(value,sampled)
        check = call_audit(value,bank) if phase == 'metric_zip_call' else outcome_audit(value,evidence,
            'training' if phase == 'memory_write' else 'evaluation')
        save('scored',dict(row,check=check))
        originals[rid] = (copy.deepcopy(row),digest(row))
        return row,check
    for index,sampled in MEMORY_WRITERS:
        row,check = ask('memory_write','memory_writer',index,memory_messages(evidence),sampled)
        memory = memory_record(row,evidence,check,index)
        save('memory-candidate',memory)
        if memory['eligible']:
            within_deadline('Deadline reached before writing verified memory ZIP')
            install_memory(memory)
            memories.append(copy.deepcopy(memory))
    loaded = read_memories()
    require(loaded == memories, 'Actual memory ZIP replay differs from saved student originals')
    # This preregistered stopping rule avoids spending four more generations
    # on a contrast that has no reusable memory on either side.
    if not loaded:
        return []
    loaded_hash = digest(loaded)
    # Counterbalance condition order by pre-reserved experiment number.
    order = ARMS if number % 2 else tuple(reversed(ARMS))
    for arm in order:
        check_frozen()
        require(read_memories() == loaded and digest(loaded) == loaded_hash, 'Memory ZIP changed before paired replay')
        row,check = ask('evaluation_review',arm,0,review_messages(evidence,loaded,arm),False)
        called = executed = False
        call_id = None
        if check['readableOriginal']:
            call,call_check = ask('metric_zip_call',arm,0,call_messages(row['studentOutput'],bank,number),False)
            call_id = call['recordId']
            called = call_check['callVerified']
            if called:
                within_deadline('Deadline reached before selected measurement execution')
                check_frozen()
                result = measure(evidence,bank,call['studentOutput'],call_check)
                tool = dict(id=arm,arm=arm,sourceReviewRecordId=row['recordId'],sourceCallRecordId=call_id,
                    selectedStudentCallRaw=call['studentOutput']['raw'],measurement=result)
                save('tool-returned',tool)
                check_frozen()
                require(result == execute_measurement(evidence,bank,call['studentOutput'],call_check),
                    'Actual selected tool return changed')
                save('tool-executed',tool);executed=True
        require(read_memories() == loaded, 'Memory ZIP changed after paired replay')
        done = dict(id=arm,arm=arm,reviewRecordId=row['recordId'],callRecordId=call_id,
            outcomeVerified=check['selectedOutcomeVerified'],actualToolExecuted=executed,
            verifiedStudentCall=called,memoryCount=len(loaded) if arm == ARMS[1] else 0,
            diagnosisRelevanceVerified=False,explanationVerified=False,trainingUpdates=0)
        save('arm',done);completed.append(done)
    return completed


def summarize(raw, scored, memories, arms, tools, stop):
    require(len(raw) <= MAX_GENERATIONS, 'Memory experiment exceeded its six-call budget')
    reviews = {r['arm']:r for r in scored if r['phase'] == 'evaluation_review'}
    calls = {r['arm']:r for r in scored if r['phase'] == 'metric_zip_call'}
    completed = {r['arm']:r for r in arms}
    usable = [m for m in memories if m['eligible']]
    paired = len(completed) == len(reviews) == 2 and set(completed) == set(reviews) == set(ARMS)
    if paired:
        a,b = (reviews[arm] for arm in ARMS)
        require(a['samplingSeed'] == b['samplingSeed'] and a['sampled'] == b['sampled'] is False,
            'Paired review seed or decoding mode differs')
        if len(calls) == 2:
            require(calls[ARMS[0]]['samplingSeed'] == calls[ARMS[1]]['samplingSeed'], 'Paired call seeds differ')
    rows = {arm:dict(reviewReturned=arm in reviews,
        readableReview=bool(reviews.get(arm,{}).get('check',{}).get('readableOriginal')),
        sourceOutcomeVerified=bool(reviews.get(arm,{}).get('check',{}).get('selectedOutcomeVerified')),
        callReturned=arm in calls,studentCallVerified=bool(calls.get(arm,{}).get('check',{}).get('callVerified')),
        actualToolExecuted=any(t['arm'] == arm for t in tools),
        diagnosisRelevanceVerified=False,explanationVerified=False) for arm in ARMS}
    raw_index={r['recordId']:r for r in raw}
    audited={r['recordId']:{k:v for k,v in r.items() if k!='check'} for r in scored}
    all_audited = len(raw_index)==len(raw) and len(audited)==len(scored) and raw_index==audited
    valid_contrast = stop == 'completed' and paired and all_audited and bool(usable)
    difference = (int(reviews[ARMS[1]]['check']['selectedOutcomeVerified']) -
                  int(reviews[ARMS[0]]['check']['selectedOutcomeVerified'])) if valid_contrast else None
    complete_replay = valid_contrast and all(rows[arm]['readableReview'] and
        rows[arm]['callReturned'] for arm in ARMS)
    return dict(runCompletedNormally=stop == 'completed', actualStudentGenerations=len(raw),
        allReturnedResponsesAudited=all_audited,memoryCandidates=len(memories),
        studentWrittenReusableMemoryZips=len(usable),memoryWriteResponses=sum(r['phase']=='memory_write' for r in scored),
        completedComparisonArms=len(completed),completePairedReplay=complete_replay,
        completeMemoryMeasurementExperiment=complete_replay and all(rows[arm]['sourceOutcomeVerified'] and
            rows[arm]['actualToolExecuted'] for arm in ARMS),
        memoryContrastAvailable=valid_contrast,
        sourceBoundOutcomeDifferenceWithMinusWithout=difference,byArm=rows,
        actualMeasurementZipExecutions=len(tools),cappedResponses=sum(bool(r['studentOutput'].get('tokenCapReached')) for r in raw),
        originalTrainingHistoriesUsedForMemory=4,originalHeldoutHistoriesAvailableForEvaluation=4,
        scheduledEvaluationGenerationsPerArm=1,scheduledComparisonContexts=1,
        independentComparisonContexts=int(valid_contrast),independentTrainingReplications=0,
        heldoutEnteredMemoryWriting=False,heldoutTrainingUpdates=0,newMathematicsObjects=0,
        comparisonIsCombinedMemoryContextEffect=True,uniqueZipEncodingEffectIsolated=False,
        autonomousMemoryRetrievalTested=False,questionGenerationTested=False,
        outcomeCopyingDoesNotCertifyUnderstanding=True,explanationOrPlanVerified=False,
        mathematicalBenefitTested=False,statisticalSignificanceClaimed=False,trainingUpdates=0,
        teacherCalls=0,productionBankUnchanged=True,oldScoresChanged=False)
