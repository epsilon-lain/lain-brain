"""Trial new summaries separately before their representations enter task replay.

Student ratings and literal references are observations, not correctness labels.
Usage logs distinguish scheduled critic probes, operative context, and actual
student references. Citation volume cannot create a positive writing reward.
"""
import copy
import math
import re
import time

from zip_summary_training_v3_core import (
    BRANCHES, EVALUATION_ARMS, TRAINING_OBJECTS, HELDOUT_OBJECTS,
    SUMMARY_WRITE_OBJECTS, SUMMARIES_PER_BRANCH, REWARD_OBJECTS_PER_SUMMARY,
    MAX_TOKENS, SUMMARY_LEARNING_RATE, STRUCTURE_PENALTY,
    REGRESSION_TOLERANCE, require, seal, digest, restore_head, candidate_cards,
    observation_messages, audit_summary, expected_pass, saved_choice,
    math_messages, audit_math, replay_item, guarded_head_update,
    retention_review, validate_summary as validate_previous_summary,
    summary_messages as previous_summary_messages,
    event_record as previous_event_record, summarize as previous_summarize)

PROTOCOL = 'lain-zip-experience-summary-training-v4'
MAX_GENERATIONS = 96  # 8 cold + 36 maths + <=32 train observations + 6 notes + 6 ratings + 8 heldout.
MAX_FEATURE_BATCHES = 40  # <=4 distinct contexts per TRAIN object, <=2 per heldout object.


def seed_for(round_number, number, slot):
    require(type(round_number) is int and 1 <= round_number <= 1000 and
        type(number) is int and 0 <= number <= 20 and type(slot) is int and 0 <= slot < 100,
        'Invalid summary training seed')
    return 4_700_000_000 + round_number * 100_000 + number * 100 + slot


def event_record(task, observation, decision, routes, prior_feedback=None):
    event = previous_event_record(task, observation, decision, routes)
    event.pop('eventHash')
    if prior_feedback is not None:
        credit = prior_feedback['credit']
        require(credit['rewardObjectSplit'] == 'training' and
            credit['sourceTaskId'] != task['id'] and credit['rewardObjects'] == 2 and
            prior_feedback['note']['id'] == credit['sourceSummaryZipId'],
            'Summary history must come from a completed earlier TRAIN window')
        validate_summary(prior_feedback['note'])
        event['priorZipFeedback'] = copy.deepcopy(prior_feedback)
    return seal(event, 'eventHash')


def summary_messages(event):
    messages = previous_summary_messages(event)
    previous = event.get('priorZipFeedback')
    if previous:
        note, credit, rating = previous['note'], previous['credit'], previous.get('rating')
        parts = ['Earlier student-written ZIP: ' + note['id'],
            'Whole earlier summary (a hypothesis):', note['studentRaw']]
        if rating and rating.get('studentRaw'):
            parts += ['Your earlier quality assessment (a prediction):', rating['studentRaw']]
        usage=previous['usage']
        parts += ['Recorded use of that ZIP before this summary, on TRAIN tasks only:',
            'Program-scheduled trial contexts: ' + str(usage['scheduledTrialCount']),
            'Ordinary supplied task contexts: ' + str(usage['operativeContextCount']),
            'Student literal references in supplied contexts: ' + str(usage['studentReferenceCount']),
            'These counts do not establish autonomous retrieval or understanding.']
        parts += ['Actual later TRAIN tests of that ZIP, including its observation and card effects:']
        for item in credit['measurements']:
            parts += ['Object: ' + item['rewardTaskExpression'],
                'Verified-success route probability without ZIP: ' + str(item['probabilityWithoutSummary']),
                'With that ZIP: ' + str(item['probabilityWithSummary'])]
        parts += ['These are recorded tests, not a certificate of the explanation.',
            'Current object: ' + event['task']['expression']]
        messages.insert(-1, dict(role='user', content='\n'.join(parts)))
    return messages


def make_summary(row, event, branch):
    require(branch in BRANCHES and row['task'] == event['task'] and row['branch'] == branch and
        row['eventHash'] == event['eventHash'] and row['phase'] == 'experience_summary' and
        row['studentPrompt'] == summary_messages(event), 'Summary original or experience binding changed')
    return seal(dict(summaryProtocol=PROTOCOL,
        id='summary-zip-' + digest(dict(source=row['recordId'], event=event['eventHash']))[:20],
        branch=branch, sourceRecordId=row['recordId'], sourceTaskId=event['task']['id'],
        studentRaw=row['studentOutput']['raw'], studentRawHash=digest(row['studentOutput']['raw']),
        studentOriginal=copy.deepcopy(row), event=copy.deepcopy(event),
        audit=audit_summary(row['studentOutput'], event), hypothesisOnly=True,
        mathematicalRule=False, hostAuthoredStudentSummary=False,
        programSourceBinding=True, autonomousRetrievalProved=False), 'summaryHash')


def validate_summary(note):
    if note.get('summaryProtocol') != PROTOCOL:
        return validate_previous_summary(note)
    require(note['summaryHash'] == digest({k:v for k,v in note.items() if k != 'summaryHash'}), 'Summary hash changed')
    event = note['event']
    require(event['eventHash'] == digest({k:v for k,v in event.items() if k != 'eventHash'}), 'Event hash changed')
    rebuilt = event_record(event['task'], event['observation'], event['decision'], event['routes'],
        event.get('priorZipFeedback'))
    require(rebuilt == event and make_summary(note['studentOriginal'], event, note['branch']) == note,
        'Summary provenance, audit or original changed')


def rating_prompt(task, student_raw, selected_outcome):
    return [dict(role='system', content=(
        'Assess whether your new experience summary is likely to help later tasks. '
        'Write one brief sentence in your own words; uncertainty is allowed. '
        'You may optionally add Score: followed by a number from 0 to 1, '
        'predicting the chance that it helps two later tasks without hurting either. '
        'A missing number is allowed. This is your prediction, not an established result. '
        'Do not solve a new task.')),
        dict(role='user', content='Source task: ' + task['expression'] +
            '\nActual audited outcome of the selected route: ' +
            ('success' if selected_outcome else 'failure') +
            '\nWhole student-written ZIP summary:\n' + student_raw)]


def summary_rating_messages(note):
    validate_summary(note)
    event = note['event']
    selected = next(r for r in event['routes'] if r['recordId'] == event['selectedRouteRecordId'])
    return rating_prompt(event['task'],note['studentRaw'],selected['check']['outcomePassed'])


def make_rating(note, row=None):
    validate_summary(note)
    if row is not None:
        require(row['phase'] == 'summary_quality_estimate' and row['task'] == note['event']['task'] and
            row['branch'] == note['branch'] and row['summaryZipId'] == note['id'] and
            row['studentPrompt'] == summary_rating_messages(note), 'Rating has another source or prompt')
    raw = row['studentOutput']['raw'] if row else ''
    completed = bool(row and row['studentOutput'].get('stopReason') == 'eos' and
        not row['studentOutput'].get('tokenCapReached'))
    matches = list(re.finditer(r'(?im)(?:^|[.;\n])\s*(?:usefulness\s+)?score\s*:\s*([^\s,;]+)', raw))
    score, span = None, None
    if completed and len(matches) == 1:
        literal = matches[0][1].rstrip('.')
        if re.fullmatch(r'(?:0(?:\.\d+)?|1(?:\.0+)?)', literal):
            score = float(literal)
            start = matches[0].start(1); span = [start, start + len(literal)]
    return dict(id=note['id'], branch=note['branch'], sourceSummaryZipId=note['id'],
        summaryHash=note['summaryHash'], sourceRatingRecordId=row['recordId'] if row else None,
        studentRaw=raw, studentRawHash=digest(raw), literalScoreSpan=span,
        studentPredictedUsefulness=score, readableAssessment=completed and bool(raw.strip()),
        status='literal_prediction_available' if score is not None else
            'assessment_without_numeric_prediction' if completed and raw.strip() else
            'rating_not_available',
        numericalPredictionRequiredForTrial=False, ratingUsedAsReward=False,
        studentRatingCertifiesQuality=False, separateRatingOptimizerUpdates=0,
        originalTextRepaired=False)


def literal_references(note, row, role):
    """A student reference in supplied context is not autonomous retrieval."""
    require(row.get('summaryZipId')==note['id'] and
        role in ('operative_context','candidate_trial','accepted_context_review'),
        'Reference must bind the actually supplied ZIP and its real role')
    raw = row['studentOutput']['raw']; spans = []
    pattern = re.escape(note['id']) + r'|\b(?:earlier|previous|this)\s+(?:summary|ZIP)\b'
    for match in re.finditer(pattern, raw, re.I):
        spans.append(dict(start=match.start(), end=match.end(), literal=match.group(0)))
    return dict(id=row['recordId']+'-'+role, summaryZipId=note['id'],
        sourceObservationRecordId=row['recordId'], taskId=row['task']['id'],
        branch=note['branch'], phase=row['task']['split'], useRole=role,
        scheduledCriticProbe=role == 'candidate_trial',
        operativeContextUse=role == 'operative_context', studentReferenceSpans=spans,
        studentExplicitReference=bool(spans), programSuppliedContext=True,
        autonomousZipSelection=False, semanticUseOrUnderstandingCertified=False,
        citationCountUsedAsWritingReward=False)


def summary_credit(note, task, without, with_note, feature_ids, observation_ids, observation_seed):
    validate_summary(note)
    # The previous function's validator accepts its own v3 or older notes only.
    require(task['split'] == 'training' and task['id'] != note['sourceTaskId'], 'Later TRAIN object required')
    require(all(type(v) in (int,float) and math.isfinite(v) and 0 <= v <= 1 for v in (without,with_note)),
        'Invalid full-path reward')
    require(set(feature_ids) == set(observation_ids) == {'without','withSummary'} and
        all(isinstance(v,str) and v for v in list(feature_ids.values())+list(observation_ids.values())) and
        type(observation_seed) is int, 'Full-path reward needs both observations and features')
    return dict(sourceSummaryZipId=note['id'], sourceWordRecordId=note['sourceRecordId'],
        sourceTaskId=note['sourceTaskId'], rewardTaskId=task['id'],
        probabilityWithoutSummary=without, probabilityWithSummary=with_note,
        signedFullReuseGain=with_note-without,
        advantage=max(-1.,min(1.,2*(with_note-without))) if note['audit']['eligibleForTrial'] else 0.,
        conditionalOnSameObservation=False, sameHeadBeforeUpdates=True,
        includesObservationGenerationAndCardContext=True, observationGenerationEffectIsolated=False,
        observationDecodingMode='greedy', pairedObservationSeed=observation_seed,
        rewardObjectSplit='training', featureIds=copy.deepcopy(feature_ids),
        observationIds=copy.deepcopy(observation_ids), correctedTextTargetsSupplied=False, proseTruthCertified=False)


def multi_object_credit(note, measurements):
    # Same v3 numerical rule, with a v4 provenance validation and exact shape.
    validate_summary(note)
    require(len(measurements) == 2 and len({m['rewardTaskId'] for m in measurements}) == 2 and
        len({m['rewardTaskFamily'] for m in measurements}) == 2, 'Two distinct TRAIN structures required')
    for m in measurements:
        rebuilt = summary_credit(note, dict(id=m['rewardTaskId'], split=m['rewardObjectSplit']),
            m['probabilityWithoutSummary'], m['probabilityWithSummary'],
            m['featureIds'], m['observationIds'], m['pairedObservationSeed'])
        require(all(m.get(k) == v for k,v in rebuilt.items()), 'Changed or unpaired feedback')
    mean = sum(m['signedFullReuseGain'] for m in measurements) / 2
    worst = min(m['signedFullReuseGain'] for m in measurements)
    floor = worst >= -REGRESSION_TOLERANCE; gain = mean if floor else worst
    return dict(sourceSummaryZipId=note['id'], sourceWordRecordId=note['sourceRecordId'],
        sourceTaskId=note['sourceTaskId'], rewardTaskId=measurements[-1]['rewardTaskId'],
        rewardTaskIds=[m['rewardTaskId'] for m in measurements], rewardObjectSplit='training',
        measurements=copy.deepcopy(measurements), rewardObjects=2, signedFullReuseGain=mean,
        worstFullReuseGain=worst, noTrainingStructureRegression=floor,
        regressionTolerance=REGRESSION_TOLERANCE, eligibleForRetention=floor and mean>REGRESSION_TOLERANCE,
        learningGain=gain, advantage=max(-1.,min(1.,2*gain)) if note['audit']['eligibleForTrial'] else 0.,
        aggregation='equal mean if neither structure regresses; otherwise negative worst-structure gain',
        sameHeadBeforeEachPair=True, sameObservationWithinEachPair=False,
        includesObservationGenerationAndCardContext=True, observationDecodingMode='greedy',
        writerFrozenUntilAllMeasurements=True, observationGenerationEffectIsolated=False,
        correctedTextTargetsSupplied=False, proseTruthCertified=False,
        candidateWasIsolatedFromOperativeReplay=True,
        positiveRewardFromCitationVolume=False, positiveRewardFromSelfRating=False)


def calibration_record(note, rating, credit):
    score = rating['studentPredictedUsefulness']
    target = int(credit['eligibleForRetention'])
    return dict(id=note['id'], sourceSummaryZipId=note['id'],
        sourceRatingRecordId=rating['sourceRatingRecordId'], prediction=score,
        observedTwoTaskRetentionTarget=target, squaredPredictionError=(score-target)**2 if score is not None else None,
        sourceTrainingTaskIds=list(credit['rewardTaskIds']),
        summaryWordAdvantage=credit['advantage'], usesHeldoutFeedback=False,
        ratingIsPredictionNotTruth=True, separateRatingOptimizerUpdates=0)


def usage_summary(note, references):
    rows=[r for r in references if r['summaryZipId']==note['id'] and r['phase']=='training']
    return dict(summaryZipId=note['id'],usesTrainingEvidenceOnly=True,
        referenceRecordIds=sorted(r['id'] for r in rows),
        scheduledTrialCount=sum(r['scheduledCriticProbe'] for r in rows),
        operativeContextCount=sum(r['operativeContextUse'] for r in rows),
        studentReferenceCount=len({r['sourceObservationRecordId'] for r in rows if r['studentExplicitReference']}),
        autonomousZipSelections=0,citationVolumeIsNotProofOfQuality=True)


def run_course(plan, roots, initial_heads, ask, feature, save, learn_summary, select_branch,
        store_summary, read_summary, checkpoint, deadline, round_number, initial_banks=None):
    require(len(plan['training']) == 8 and len(plan['heldout']) == 4 and
        all(t['split']=='training' for t in plan['training']) and all(t['split']=='heldout' for t in plan['heldout']),
        'Summary training split differs')
    require(all(len({plan['training'][n+i]['family'] for i in range(2)}) == 2 for n in SUMMARY_WRITE_OBJECTS),
        'Reward windows must contain two scheduled different structures')
    heads = {b:restore_head(copy.deepcopy(initial_heads[b])) for b in BRANCHES}
    banks = copy.deepcopy(initial_banks or {b:None for b in BRANCHES})
    replay = {b:[] for b in BRANCHES}; pending = {b:None for b in BRANCHES}
    objects, updates, summaries, ratings, references, calibrations, activations = [], [], [], [], [], [], []
    retention_cases, retention_reviews, feedback = {}, [], {b:None for b in BRANCHES}
    original_roots = copy.deepcopy(roots)
    checkpoint('initial', {b:h.state() for b,h in heads.items()}, banks)

    def remaining():
        if time.monotonic() >= deadline:raise TimeoutError('Summary deadline before next action')

    def load_note(branch):
        return read_summary(banks[branch]) if banks[branch] else None

    def routes_for(task, number):
        routes = []
        for card in candidate_cards(roots):
            remaining()
            row = ask('route_math', math_messages(task,card,roots), seed_for(round_number,number,20),
                mode='math', sampled=False, task=task, selectedCandidate=copy.deepcopy(card),
                hostSpecifiedRoute=True, autonomousToolUseClaimed=False)
            row = dict(row,check=audit_math(task,row['studentOutput'],card));save('scored',row);routes.append(row)
            if not row['check']['outcomePassed']:save('failure',dict(row,id=row['recordId']))
        return routes

    for number,task in enumerate(plan['training'],1):
        remaining(); select_branch(BRANCHES[0]); cache={}; observations={}; vectors={}; feature_ids={}; decisions=[]
        active = {b:load_note(b) for b in BRANCHES}  # Fixed before any current outcome.
        plain_row = ask('training_observation_without_summary', observation_messages(task,roots),
            seed_for(round_number,number,1), mode='observation',sampled=False,task=task,
            branch='shared_without_summary',summaryZipId=None)
        save('scored',dict(plain_row,check=dict(originalPreserved=True,explanationCertified=False,
            sharedNoSummaryBaseline=True,observationDecodingMode='greedy')))
        plain,plain_id = feature(task,plain_row,candidate_cards(roots))

        def probe(note, branch, role):
            if not note:return plain,plain_id,plain_row
            if note['id'] not in cache:
                select_branch(branch);remaining()
                stored = read_summary(note['id'])
                require(stored == note,'Candidate ZIP differs from its preserved original')
                row = ask('training_observation_with_summary', observation_messages(task,roots,note),
                    seed_for(round_number,number,1),mode='observation',sampled=False,task=task,
                    branch=branch,summaryZipId=note['id'],counterfactualCriticOnly=role!='operative_context',
                    contextRoleAtGeneration=role)
                save('scored',dict(row,check=dict(originalPreserved=True,explanationCertified=False,
                    observationDecodingMode='greedy',counterfactualCriticOnly=role!='operative_context')))
                vec,identifier = feature(task,row,candidate_cards(roots,note));cache[note['id']] = (vec,identifier,row)
            vec,identifier,row = cache[note['id']]
            ref = literal_references(note,row,role);save('zip-reference',ref);references.append(ref)
            return vec,identifier,row

        # Accepted context and candidate tests are disjoint. Only accepted
        # context can supply this object's task choice and subsequent replay.
        for b in BRANCHES:
            context = active[b] if b == BRANCHES[0] else None
            vec,identifier,row = probe(context,b,'operative_context')
            observations[b],vectors[b],feature_ids[b] = row,vec,identifier
            decision = saved_choice(task,b,vec,candidate_cards(roots,context),heads[b],
                seed_for(round_number,number,10),1,row['recordId'],identifier)
            save('decision',decision);decisions.append(decision)
        critic_notes = {b:pending[b]['note'] if pending[b] else active[b] for b in BRANCHES}
        probes = {b:probe(critic_notes[b],b,'candidate_trial' if pending[b] else 'accepted_context_review') for b in BRANCHES}
        routes = routes_for(task,number); outcomes = [int(r['check']['outcomePassed']) for r in routes]
        math_ids = [r['recordId'] for r in routes]
        obj = dict(id=task['id'],task=copy.deepcopy(task),phase='training',routeOutcomes=outcomes,
            sourceMathRecordIds=math_ids,expectedPassByArm={b:expected_pass(heads[b],vectors[b],outcomes)[0] for b in BRANCHES},
            featureIdsByArm=copy.deepcopy(feature_ids),observationRecordIdsByArm={b:observations[b]['recordId'] for b in BRANCHES},
            allChoicesSavedBeforeRoutes=True,sourceSummaryIdsByArm={b:active[b]['id'] if b==BRANCHES[0] and active[b] else None for b in BRANCHES},
            candidateSummaryIdsByBranch={b:pending[b]['note']['id'] if pending[b] else None for b in BRANCHES},
            candidateTrialIsolatedFromOperativeReplay=True)
        save('object',obj);objects.append(obj)
        for b,decision in zip(BRANCHES,decisions):
            remaining();select_branch(b);previous=pending[b];note=critic_notes[b]
            noted,noted_id,noted_row = probes[b]
            if note:
                retention_cases.setdefault(note['id'],[]).append(dict(task=copy.deepcopy(task),
                    without=copy.deepcopy(plain),withSummary=copy.deepcopy(noted),outcomes=list(outcomes),
                    featureIds=dict(without=plain_id,withSummary=noted_id),sourceMathRecordIds=math_ids))
            credit,measurement = None,None
            word_update = dict(updated=False,parameterChanged=False,reason='no_completed_candidate_trial')
            if previous:
                measurement = summary_credit(previous['note'],task,
                    expected_pass(heads[b],plain,outcomes)[0],expected_pass(heads[b],noted,outcomes)[0],
                    dict(without=plain_id,withSummary=noted_id),
                    dict(without=plain_row['recordId'],withSummary=noted_row['recordId']),seed_for(round_number,number,1))
                measurement.update(rewardObjectNumber=number,rewardTaskFamily=task['family'],
                    rewardTaskExpression=task['expression'],sourceMathRecordIds=math_ids)
                previous['measurements'].append(measurement)
                if len(previous['measurements']) == 2:
                    credit = multi_object_credit(previous['note'],previous['measurements'])
                    word_update = learn_summary(previous['note'],credit,'multiple_later_training_objects')
                    if credit['eligibleForRetention']:banks[b]=previous['note']['id']
                    activation = dict(id=previous['note']['id'],branch=b,summaryZipId=previous['note']['id'],
                        decidedAfterTrainingTaskId=task['id'],firstEligibleOperativeObjectNumber=number+1,
                        activatedAfterTwoTrainingTests=credit['eligibleForRetention'],
                        priorAcceptedSummaryZipId=active[b]['id'] if active[b] else None,
                        activeAfterDecision=banks[b],currentObjectDecisionUnchanged=True,
                        candidateFeatureEnteredOperativeReplay=False,usesHeldoutFeedback=False)
                    save('summary-activation',activation);activations.append(activation)
                    rating=previous['rating'];cal=calibration_record(previous['note'],rating,credit)
                    save('rating-calibration',cal);calibrations.append(cal)
                    feedback[b]=dict(note=copy.deepcopy(previous['note']),credit=copy.deepcopy(credit),rating=copy.deepcopy(rating))
                    pending[b]=None
            replay[b].append(replay_item(task,vectors[b],outcomes,feature_ids[b],math_ids))
            head_update = guarded_head_update(heads[b],replay[b],number)
            update = dict(id=b+'-'+str(number),taskId=task['id'],branch=b,
                delayedSummaryCredit=credit,summaryUpdate=word_update,headUpdate=head_update,
                summaryMeasurement=measurement,pendingRewardMeasurements=len(pending[b]['measurements']) if pending[b] else 0,
                retainedAfterNetFeedback=bool(credit and credit['eligibleForRetention']),
                operativeSummaryZipId=obj['sourceSummaryIdsByArm'][b],candidateWasIsolatedFromOperativeReplay=True)
            save('update',update);updates.append(update)
            chosen = next(r for r in routes if r['selectedCandidate']['id'] == decision['selectedCandidate']['id'])
            save('trial',dict(id=decision['id'],taskId=task['id'],phase='training',arm=b,
                decisionId=decision['id'],sourceMathRecordId=chosen['recordId'],outcomePassed=chosen['check']['outcomePassed']))
            if number in SUMMARY_WRITE_OBJECTS:
                require(pending[b] is None,'Cannot replace an unevaluated policy-bound summary');remaining()
                # This object's routes and any completed trial window have
                # already been audited. No future or heldout result is given.
                history=dict(feedback[b],usage=usage_summary(feedback[b]['note'],references)) if feedback[b] else None
                event = event_record(task,observations[b],decision,routes,history)
                row = ask('experience_summary',summary_messages(event),seed_for(round_number,number,30),
                    mode='summary',sampled=True,task=task,branch=b,eventHash=event['eventHash'])
                new_note = make_summary(row,event,b);save('scored',dict(row,check=copy.deepcopy(new_note['audit'])))
                store_summary(new_note);save('summary',new_note);summaries.append(new_note)
                rating_row = None
                if new_note['audit']['eligibleForTrial']:
                    remaining()
                    rating_row = ask('summary_quality_estimate',summary_rating_messages(new_note),seed_for(round_number,number,31),
                        mode='summary',sampled=False,task=task,branch=b,summaryZipId=new_note['id'])
                rating = make_rating(new_note,rating_row);save('summary-rating',rating);ratings.append(rating)
                if rating_row:save('scored',dict(rating_row,check=copy.deepcopy(rating)))
                if new_note['audit']['eligibleForTrial']:
                    pending[b] = dict(note=new_note,measurements=[],rating=rating)
                    # Do not assign the candidate to the operative bank here.
                else:
                    penalty = dict(sourceSummaryZipId=new_note['id'],sourceWordRecordId=new_note['sourceRecordId'],
                        sourceTaskId=task['id'],rewardTaskId=task['id'],advantage=STRUCTURE_PENALTY,
                        signedFullReuseGain=None,reason='separate_completion_or_disproved_fact_penalty',
                        audit=new_note['audit'],rewardObjectSplit='training',correctedTextTargetsSupplied=False)
                    result = learn_summary(new_note,penalty,'original_rejection_penalty')
                    save('penalty',dict(id=new_note['id'],branch=b,summaryCredit=penalty,summaryUpdate=result))
            checkpoint('after-'+str(number)+'-'+b,{b:h.state() for b,h in heads.items()},banks)
        require(roots == original_roots,'Original mathematical roots changed')
    require(all(p is None for p in pending.values()),'A candidate never received its full scheduled TRAIN window')
    for b in BRANCHES:
        note=load_note(b)
        if not note:continue
        chosen=[]
        for case in reversed(retention_cases.get(note['id'],[])):
            if not any(c['task']['family']==case['task']['family'] for c in chosen):chosen.append(case)
            if len(chosen)==2:break
        if len(chosen)==2:review=retention_review(note,list(reversed(chosen)),heads[b])
        else:review=dict(id=note['id'],branch=b,summaryZipId=note['id'],finalHeadHash=heads[b].state()['parameterHash'],
            measurements=[],retainedForHeldout=False,reason='insufficient_two_structure_evidence_under_current_head',
            usesTrainingEvidenceOnly=True,newStudentGenerations=0,writerUpdatedAgain=False,oldScoresChanged=False)
        save('summary-context-review',review);retention_reviews.append(review)
        if not review['retainedForHeldout']:banks[b]=None
    checkpoint('training-final',{b:h.state() for b,h in heads.items()},banks)
    frozen_heads={b:h.state() for b,h in heads.items()};frozen_banks=copy.deepcopy(banks)
    prior_a,prior_b = restore_head(initial_heads[BRANCHES[0]]),restore_head(initial_heads[BRANCHES[1]])
    for number,task in enumerate(plan['heldout'],9):
        remaining();select_branch(BRANCHES[0]);note=load_note(BRANCHES[0])
        plain_row=ask('heldout_observation_without_summary',observation_messages(task,roots),seed_for(round_number,number,1),
            mode='observation',sampled=False,task=task,summaryZipId=None)
        save('scored',dict(plain_row,check=dict(originalPreserved=True,sharedNoSummaryBaseline=True,heldoutTrainingUpdates=0)))
        plain,plain_id=feature(task,plain_row,candidate_cards(roots))
        if note:
            with_row=ask('heldout_observation_with_summary',observation_messages(task,roots,note),seed_for(round_number,number,1),
                mode='observation',sampled=False,task=task,summaryZipId=note['id'])
            save('scored',dict(with_row,check=dict(originalPreserved=True,heldoutTrainingUpdates=0)))
            noted,noted_id=feature(task,with_row,candidate_cards(roots,note))
            ref=literal_references(note,with_row,'operative_context');save('zip-reference',ref);references.append(ref)
        else:with_row=plain_row;noted,noted_id=plain,plain_id
        vectors={a:noted if a==BRANCHES[0] else plain for a in EVALUATION_ARMS}
        h_by_arm={BRANCHES[0]:heads[BRANCHES[0]],BRANCHES[1]:heads[BRANCHES[1]],
            EVALUATION_ARMS[2]:heads[BRANCHES[0]],EVALUATION_ARMS[3]:prior_a,EVALUATION_ARMS[4]:prior_b}
        decisions=[]
        for index in (1,2,3):
            for arm in EVALUATION_ARMS:
                row=with_row if arm==BRANCHES[0] else plain_row
                decision=saved_choice(task,arm,vectors[arm],candidate_cards(roots,note if arm==BRANCHES[0] else None),h_by_arm[arm],
                    seed_for(round_number,number,50+index),index,row['recordId'],noted_id if arm==BRANCHES[0] else plain_id)
                save('decision',decision);decisions.append(decision)
        routes=routes_for(task,number);outcomes=[int(r['check']['outcomePassed']) for r in routes]
        probabilities={a:expected_pass(h_by_arm[a],vectors[a],outcomes)[1] for a in EVALUATION_ARMS}
        expected={a:sum(p*y for p,y in zip(probabilities[a],outcomes)) for a in EVALUATION_ARMS}
        obj=dict(id=task['id'],task=copy.deepcopy(task),phase='heldout',routeOutcomes=outcomes,
            sourceMathRecordIds=[r['recordId'] for r in routes],expectedPassByArm=expected,probabilitiesByArm=probabilities,
            primaryPairedDifference=expected[BRANCHES[0]]-expected[BRANCHES[1]],
            sameHeadSummaryAblationDifference=expected[BRANCHES[0]]-expected[EVALUATION_ARMS[2]],
            featureIdsByArm={a:noted_id if a==BRANCHES[0] else plain_id for a in EVALUATION_ARMS},
            observationRecordIdsByArm={a:with_row['recordId'] if a==BRANCHES[0] else plain_row['recordId'] for a in EVALUATION_ARMS},
            summaryZipId=note['id'] if note else None,allChoicesSavedBeforeRoutes=True,trainingUpdates=0)
        save('object',obj);objects.append(obj)
        for decision in decisions:
            route=next(r for r in routes if r['selectedCandidate']['id']==decision['selectedCandidate']['id'])
            save('trial',dict(id=decision['id'],taskId=task['id'],phase='heldout',arm=decision['arm'],seedIndex=decision['seedIndex'],
                decisionId=decision['id'],sourceMathRecordId=route['recordId'],outcomePassed=route['check']['outcomePassed'],
                noExtraGenerationForSeedTrial=True))
        require({b:h.state() for b,h in heads.items()}==frozen_heads and banks==frozen_banks and roots==original_roots,
            'Frozen heldout learned state changed')
    checkpoint('final',{b:h.state() for b,h in heads.items()},banks)
    return dict(finalHeads={b:h.state() for b,h in heads.items()},finalBanks=banks,objects=objects,
        updates=updates,summaries=summaries,ratings=ratings,references=references,calibrations=calibrations,
        activations=activations,retentionReviews=retention_reviews,heldoutStateUnchanged=True)


def summarize(objects,trials,summaries,updates,penalties,retention_reviews=(),ratings=(),references=(),calibrations=(),activations=()):
    report=previous_summarize(objects,trials,summaries,updates,penalties,retention_reviews)
    rejected=report['summariesWithdrawnAfterTrainingGuard']
    # v4 candidates were never active, so rejection is not a context withdrawal.
    report['summariesWithdrawnAfterTrainingGuard']=0
    report.update(candidateTrialsIsolatedFromOperativeReplay=True,
        candidatesRejectedAfterTrial=rejected,
        summaryQualityAssessmentsReturned=sum(r['sourceRatingRecordId'] is not None for r in ratings),
        readableStudentQualityAssessments=sum(r['readableAssessment'] for r in ratings),
        literalStudentUsefulnessPredictions=sum(r['studentPredictedUsefulness'] is not None for r in ratings),
        candidateTrials=sum(r['scheduledCriticProbe'] for r in references),
        operativeSummaryContextUses=sum(r['operativeContextUse'] for r in references),
        studentExplicitReferences=len({r['sourceObservationRecordId'] for r in references if r['studentExplicitReference']}),
        autonomousZipSelections=0,referenceCountsAreNotAutonomousRetrievalCounts=True,
        selfRatingsArePredictionsNotQualityCertificates=True,citationVolumeUsedAsPositiveReward=False,
        selfRatingUsedAsPositiveReward=False,separateRatingOptimizerUpdates=0,
        candidatesActivatedAfterTwoTrainingTests=sum(r['activatedAfterTwoTrainingTests'] for r in activations),
        bySummary=[dict(summaryZipId=n['id'],branch=n['branch'],
            rating=next((r['studentPredictedUsefulness'] for r in ratings if r['sourceSummaryZipId']==n['id']),None),
            qualityAssessment=next((r['studentRaw'] for r in ratings if r['sourceSummaryZipId']==n['id']),None),
            scheduledTrialCount=sum(r['scheduledCriticProbe'] and r['summaryZipId']==n['id'] for r in references),
            operativeContextCount=sum(r['operativeContextUse'] and r['summaryZipId']==n['id'] for r in references),
            studentReferenceCount=len({r['sourceObservationRecordId'] for r in references
                if r['studentExplicitReference'] and r['summaryZipId']==n['id']}),
            calibration=next((c for c in calibrations if c['sourceSummaryZipId']==n['id']),None)) for n in summaries])
    return report
