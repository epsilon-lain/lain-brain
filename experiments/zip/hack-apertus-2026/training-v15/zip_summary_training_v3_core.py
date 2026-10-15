"""Full summary reuse is paired against no-summary reuse on later TRAIN tasks.

The critic includes each note's effect on the observation and candidate cards.
Both sides use greedy observation generation, matching frozen evaluation. A
loss on either scheduled training structure cannot earn positive word credit.
The sealed branch's counterfactual critic remains separate from its task path.
"""
import copy
import math
import re
import time

from zip_content_core import digest, verify_claim, parse_expression, OutsideScope
from choice_retest_core import restore_head
from zip_label_grounded_core import expected_pass, saved_choice, math_messages
from zip_label_grounded_checks import note_audit, replay_item, guarded_head_update
from zip_label_feedback_audit import audit_math, feedback_for
from zip_summary_training_v2_core import validate_summary as validate_legacy_summary

PROTOCOL = 'lain-zip-experience-summary-training-v3'
BRANCHES = ('reuse_summary_zip', 'seal_summary_zip')
EVALUATION_ARMS = BRANCHES + ('reuse_branch_without_summary',
    'frozen_before_round_reuse_without_summary','frozen_before_round_seal_without_summary')
TRAINING_OBJECTS = 8
HELDOUT_OBJECTS = 4
SUMMARY_WRITE_OBJECTS = (1, 4, 6)
SUMMARIES_PER_BRANCH = len(SUMMARY_WRITE_OBJECTS)
REWARD_OBJECTS_PER_SUMMARY = 2
MAX_TOKENS = 96
MAX_GENERATIONS = 82  # 8 cold + 36 maths + <=24 train observations + 6 summaries + 8 heldout observations.
MAX_FEATURE_BATCHES = 32  # <=24 training and 8 heldout; no extra card-only probes.
SUMMARY_LEARNING_RATE = .003
STRUCTURE_PENALTY = -.2
REGRESSION_TOLERANCE = 1e-12


def require(value, reason):
    if not value:
        raise ValueError(reason)


def seal(value, field):
    return dict(value, **{field: digest(value)})


def seed_for(round_number, number, slot):
    require(type(round_number) is int and 1 <= round_number <= 1000 and
        type(number) is int and 0 <= number <= 20 and type(slot) is int and 0 <= slot < 100,
        'Invalid summary training seed')
    return 4_500_000_000 + round_number * 100_000 + number * 100 + slot


def candidate_cards(roots, note=None):
    """Same complete summary on every card; no host assignment to a method."""
    require(len(roots) == 2, 'Exactly two original mathematical roots required')
    result = [dict(id='DIRECT', kind='direct', scope='real_polynomial', tags=[],
        description='Try a complete rewrite without a stored algebraic rewrite.')]
    for root, kind in zip(roots, ('combine', 'distribute')):
        require(verify_claim(root['rule'])['reusable'], 'Original mathematical root failed verification')
        result.append(dict(id=root['id'], kind=kind, scope='real_polynomial', tags=[],
            description='Available stored algebraic rewrite.', root=copy.deepcopy(root),
            sourceLabelVersion=None, parentVersion=root['version'], parentClaimHash=digest(root['rule'])))
    if note:
        require(note['audit']['eligibleForTrial'], 'An inactive summary cannot enter candidate cards')
        for card in result:
            card['description'] += '\nYour earlier experience summary, unverified explanation:\n' + note['studentRaw']
            card['sourceSummaryZipId'] = note['id']
    return result


def observation_messages(task, roots, note=None):
    text = ['Available stored algebraic rewrites:']
    text += [r['rule']['input'] + ' = ' + r['rule']['output'] for r in roots]
    if note:
        require(note['audit']['eligibleForTrial'], 'Inactive summary supplied to task writer')
        text += ['Your earlier experience summary, an unverified hypothesis:', note['studentRaw']]
    text += ['Current object: ' + task['expression']]
    return [dict(role='system', content=(
        'Observe this current expression in your own words to help choose a rewrite method. '
        'Earlier examples are not the current object. Your earlier summary may be useful or mistaken. '
        'Write a brief concrete observation. Do not solve the expression.')),
        dict(role='user', content='\n'.join(text))]


def event_record(task, observation, decision, routes):
    require(task['split'] == 'training', 'Heldout history cannot enter summary writing')
    require(observation['task']==task and decision['task']==task and
        decision['sourceKeywordRecordId']==observation['recordId'], 'Observation or decision belongs to another experience')
    require(len(routes) == 3 and len({r['recordId'] for r in routes}) == 3 and
        all(r['task'] == task and r['check'] == audit_math(task, r['studentOutput'], r['selectedCandidate']) for r in routes),
        'Summary event must bind all three actually audited originals')
    chosen = decision['selectedCandidate']['id']
    return seal(dict(task=copy.deepcopy(task), observation=copy.deepcopy(observation),
        decision=copy.deepcopy(decision), routes=copy.deepcopy(routes),
        selectedRouteRecordId=next(r['recordId'] for r in routes if r['selectedCandidate']['id'] == chosen),
        hostScheduledRouteAudit=True, selectedRouteReusedActualOriginal=True,
        autonomousMathToolInvocationClaimed=False), 'eventHash')


def summary_messages(event):
    task = event['task']
    require(task['split'] == 'training', 'No heldout summary prompt')
    parts = ['Task goal: ' + task['question'], 'Your original observation (student words, not certified facts):',
        event['observation']['studentOutput']['raw']]
    for i, route in enumerate(event['routes'], 1):
        parts += ['Actual audited attempt ' + str(i) +
            (' (the route your selector chose)' if route['recordId'] == event['selectedRouteRecordId'] else
             ' (another program-scheduled audit)'),
            'Stored rewrite: ' + ('direct attempt' if route['selectedCandidate']['kind'] == 'direct' else
                route['selectedCandidate']['root']['rule']['input'] + ' = ' +
                route['selectedCandidate']['root']['rule']['output']),
            'Original student response: ' + route['studentOutput']['raw'],
            'Actual completion: ' + ('token budget reached' if route['studentOutput']['tokenCapReached'] else
                                    'returned original response'),
            'Actual audited outcome: ' + ('success' if route['check']['outcomePassed'] else 'failure'),
            'Separate exact audit facts: ' + str(feedback_for(route['check']))]
    parts += ['Current object: ' + task['expression']]
    return [dict(role='system', content=(
        'Write ONE short sentence, at most 30 words, about what this actual experience '
        'suggests retaining for a later task. Retain a concrete detail rather than only a success or failure label. '
        'Use the audit facts when describing outcomes. '
        'An observation about the task, input or tools is enough; uncertainty is allowed. '
        'No self-blame, metric, address or plan is required. Stop after the sentence.')),
        dict(role='user', content='\n'.join(parts)),
        dict(role='user', content='In your own words, write one short sentence about this experience now.')]


def task_result_claims(raw, event):
    """Compare only explicitly asserted result expressions, without rewriting prose.

The result expression span is copied literally. Its comparison with the task
is a separate audit, never an invented student equality or a corrected target.
Hedged, negated, quoted or unsupported prose remains outside this bounded check.
"""
    pattern = (r'(?:^|[.!?\n])\s*(?:Therefore,\s*)?(?:the\s+)?'
        r'(?:correct\s+(?:formula|result|answer|rewrite|simplification)|final\s+(?:result|answer))'
        r'\s*(?:is|:)\s*')
    claims=[]
    for match in re.finditer(pattern, raw, re.I):
        start=match.end(); end=start
        if start < len(raw) and raw[start] == '`':
            start+=1;end=raw.find('`',start)
            if end<0:continue
        else:
            tail=re.match(r'(?:(?:\.(?=\d))|[^,;.!?\n]){1,500}',raw[start:])
            if not tail:continue
            end=start+tail.end()
        literal=raw[start:end];expr=literal.strip()
        try:
            _,_,names=parse_expression(expr)
            _,_,allowed=parse_expression(event['task']['expression'])
        except OutsideScope:continue
        exact=verify_claim(dict(input=event['task']['expression'],output=expr,
            operation='rewrite',variable='',scope='real_polynomial'))
        outside=sorted(set(names)-set(allowed))
        claims.append(dict(expressionSpan=[start,end],literalExpression=literal,
            originalClaimSpan=[match.start(),end],taskExpression=event['task']['expression'],
            exactTaskResultAudit=exact,outsideTaskVariables=outside,
            explicitlyDisproved=exact['status']=='rejected' or bool(outside),
            studentEqualityInvented=False,studentTextRepaired=False,
            taskComparisonIsSeparateAudit=True,wholeProseTruthCertified=False))
    return claims


def audit_summary(output, event):
    """Bounded syntax and literal facts are distinct from empirical usefulness.

No sentence template, JSON fields, metric keyword or mathematical proof is a
positive-credit prerequisite. Unknown prose remains an unverified hypothesis.
Exactly delimited quotes of an actual source response are recorded as quotes,
not promoted to a new identity. Arbitrary quotation intent is not inferred.
"""
    raw = output['raw']; literals = note_audit(raw)
    ended = output.get('stopReason') == 'eos' and not output.get('tokenCapReached')
    reasons = []
    if not ended: reasons.append('no_actual_eos_or_capped')
    if not raw.strip(): reasons.append('empty_original')
    if len(raw) > 3000: reasons.append('overlong_original')
    if re.fullmatch(r'(?:\s*(?:T\d+|Z\d+|CALL\s+Z\d+)\s*)+', raw, re.I):
        reasons.append('registry_addresses_only')
    quotes = re.findall(r'(?<!`)`([^`\n]+)`(?!`)', raw)
    source_quotes = {r['studentOutput']['raw'].strip() for r in event['routes']}
    quoted = []
    disproved = []
    for i in literals['rejectedEqualityIndices']:
        claim = literals['writtenEqualities'][i]
        fragment = claim.get('sourceFragment')
        if fragment and fragment in quotes and fragment.strip() in source_quotes:
            quoted.append(i)
        else:
            disproved.append(i)
    if disproved: reasons.append('disproved_new_literal_identity')
    # Only explicit, separately labelled route outcomes are adjudicated here.
    outcome_conflicts = []
    for match in re.finditer(r'\b(?:attempt|route)\s+([123])\s+(passed|failed)\b', raw, re.I):
        index = int(match[1]) - 1
        if (match[2].lower() == 'passed') != event['routes'][index]['check']['outcomePassed']:
            outcome_conflicts.append(match.group(0))
    if outcome_conflicts: reasons.append('explicit_route_outcome_conflict')
    result_claims=task_result_claims(raw,event)
    if any(c['explicitlyDisproved'] for c in result_claims):
        reasons.append('disproved_explicit_task_result')
    eligible = not reasons
    return dict(eligibleForTrial=eligible, actualEos=ended, reasons=reasons,
        literalAudit=literals, disprovedNewIdentityIndices=disproved,
        exactSourceQuotedRejectedIdentityIndices=quoted, explicitOutcomeConflicts=outcome_conflicts,
        explicitTaskResultClaims=result_claims,taskResultAuditCoverage='bounded_explicit_result_phrases_only',
        sourceBindingVerified=True, wholeProseTruthCertified=False, relevanceCertified=False,
        explanationCertified=False, usefulnessVerified=False, originalTextRepaired=False,
        provisionalProseMayReceiveMeasuredUsefulnessCredit=True)


def make_summary(row, event, branch):
    require(branch in BRANCHES and row['task'] == event['task'] and row['branch'] == branch and
        row['eventHash']==event['eventHash'] and
        row['phase'] == 'experience_summary' and row['studentPrompt'] == summary_messages(event),
        'Student summary does not bind its actual event and prompt')
    body = dict(summaryProtocol=PROTOCOL,id='summary-zip-' + digest(dict(source=row['recordId'], event=event['eventHash']))[:20],
        branch=branch, sourceRecordId=row['recordId'], sourceTaskId=event['task']['id'],
        studentRaw=row['studentOutput']['raw'], studentRawHash=digest(row['studentOutput']['raw']),
        studentOriginal=copy.deepcopy(row), event=copy.deepcopy(event), audit=audit_summary(row['studentOutput'], event),
        hypothesisOnly=True, mathematicalRule=False, hostAuthoredStudentSummary=False,
        programSourceBinding=True, autonomousRetrievalProved=False)
    return seal(body, 'summaryHash')


def validate_summary(note):
    if note.get('summaryProtocol') != PROTOCOL:
        return validate_legacy_summary(note)
    require(note['summaryHash'] == digest({k:v for k,v in note.items() if k != 'summaryHash'}), 'Summary hash changed')
    event = note['event']
    require(event['eventHash'] == digest({k:v for k,v in event.items() if k != 'eventHash'}), 'Event hash changed')
    rebuilt = event_record(event['task'], event['observation'], event['decision'], event['routes'])
    require(rebuilt == event and make_summary(note['studentOriginal'], event, note['branch']) == note,
        'Summary provenance, audit or whole student original changed')


def summary_credit(note, reward_task, without, with_note, feature_ids, observation_ids, observation_seed):
    validate_summary(note)
    require(reward_task['split'] == 'training' and reward_task['id'] != note['sourceTaskId'],
        'Summary reward requires a later distinct training object')
    require(all(math.isfinite(x) and 0 <= x <= 1 for x in (without, with_note)), 'Invalid full-path reward')
    require(set(feature_ids)==set(observation_ids)=={'without','withSummary'} and
        all(isinstance(v,str) and v for v in list(feature_ids.values())+list(observation_ids.values())) and
        type(observation_seed) is int, 'Full-path reward needs both actual observations and features')
    advantage = max(-1., min(1., 2 * (with_note - without))) if note['audit']['eligibleForTrial'] else 0.
    return dict(sourceSummaryZipId=note['id'], sourceWordRecordId=note['sourceRecordId'],
        sourceTaskId=note['sourceTaskId'], rewardTaskId=reward_task['id'],
        probabilityWithoutSummary=without, probabilityWithSummary=with_note,
        signedFullReuseGain=with_note - without, advantage=advantage,
        conditionalOnSameObservation=False, sameHeadBeforeUpdates=True,
        includesObservationGenerationAndCardContext=True, observationGenerationEffectIsolated=False,
        observationDecodingMode='greedy', pairedObservationSeed=observation_seed,
        rewardObjectSplit='training', featureIds=copy.deepcopy(feature_ids),
        observationIds=copy.deepcopy(observation_ids), correctedTextTargetsSupplied=False, proseTruthCertified=False)


def multi_object_credit(note, measurements):
    validate_summary(note)
    require(len(measurements)==REWARD_OBJECTS_PER_SUMMARY and
        len({m['rewardTaskId'] for m in measurements})==REWARD_OBJECTS_PER_SUMMARY,
        'Two distinct later training objects required before a word update')
    for item in measurements:
        require(item['sourceSummaryZipId']==note['id'] and item['sourceTaskId']==note['sourceTaskId'] and
            item['rewardTaskId']!=note['sourceTaskId'] and item['rewardObjectSplit']=='training' and
            item['sameHeadBeforeUpdates'] is True and item['conditionalOnSameObservation'] is False and
            item['includesObservationGenerationAndCardContext'] is True and item['observationDecodingMode']=='greedy' and
            type(item['pairedObservationSeed']) is int and
            set(item['featureIds'])==set(item['observationIds'])=={'without','withSummary'} and
            all(math.isfinite(item[k]) and 0<=item[k]<=1 for k in ('probabilityWithoutSummary','probabilityWithSummary')) and
            abs(item['signedFullReuseGain']-(item['probabilityWithSummary']-item['probabilityWithoutSummary']))<=1e-12,
            'Changed, heldout or unpaired multi-object feedback')
    require(len({m['rewardTaskFamily'] for m in measurements})==2,
        'Reward window must include two different planned expression structures')
    gain=sum(m['signedFullReuseGain'] for m in measurements)/len(measurements)
    worst=min(m['signedFullReuseGain'] for m in measurements)
    no_regression=worst>=-REGRESSION_TOLERANCE
    learning_gain=gain if no_regression else worst
    return dict(sourceSummaryZipId=note['id'],sourceWordRecordId=note['sourceRecordId'],
        sourceTaskId=note['sourceTaskId'],rewardTaskId=measurements[-1]['rewardTaskId'],
        rewardTaskIds=[m['rewardTaskId'] for m in measurements],rewardObjectSplit='training',
        measurements=copy.deepcopy(measurements),rewardObjects=len(measurements),
        signedFullReuseGain=gain, worstFullReuseGain=worst,
        noTrainingStructureRegression=no_regression, regressionTolerance=REGRESSION_TOLERANCE,
        eligibleForRetention=no_regression and gain>REGRESSION_TOLERANCE,
        learningGain=learning_gain,
        advantage=max(-1.,min(1.,2*learning_gain)) if note['audit']['eligibleForTrial'] else 0.,
        aggregation='equal mean if neither structure regresses; otherwise negative worst-structure gain',
        sameHeadBeforeEachPair=True,sameObservationWithinEachPair=False,
        includesObservationGenerationAndCardContext=True,observationDecodingMode='greedy',
        writerFrozenUntilAllMeasurements=True,observationGenerationEffectIsolated=False,
        correctedTextTargetsSupplied=False,proseTruthCertified=False)


def retention_review(note, cases, head):
    """Recheck TRAIN representations under the final head without new generation."""
    require(len(cases)==REWARD_OBJECTS_PER_SUMMARY and
        len({c['task']['family'] for c in cases})==2 and
        all(c['task']['split']=='training' and c['task']['id']!=note['sourceTaskId'] for c in cases),
        'Retention guard requires the same two later training cases')
    measurements=[]
    for case in cases:
        plain=expected_pass(head,case['without'],case['outcomes'])[0]
        noted=expected_pass(head,case['withSummary'],case['outcomes'])[0]
        measurements.append(dict(taskId=case['task']['id'],family=case['task']['family'],
            featureIds=copy.deepcopy(case['featureIds']),routeOutcomes=list(case['outcomes']),
            sourceMathRecordIds=list(case['sourceMathRecordIds']),
            probabilityWithoutSummary=plain,probabilityWithSummary=noted,signedFullReuseGain=noted-plain))
    gains=[m['signedFullReuseGain'] for m in measurements]
    mean=sum(gains)/len(gains);worst=min(gains)
    return dict(id=note['id'],branch=note['branch'],summaryZipId=note['id'],
        finalHeadHash=head.state()['parameterHash'],measurements=measurements,
        meanFullReuseGain=mean,worstFullReuseGain=worst,
        retainedForHeldout=worst>=-REGRESSION_TOLERANCE and mean>REGRESSION_TOLERANCE,
        usesTrainingEvidenceOnly=True,newStudentGenerations=0,writerUpdatedAgain=False,oldScoresChanged=False)


def run_course(plan, roots, initial_heads, ask, feature, save, learn_summary, select_branch,
        store_summary, read_summary, checkpoint, deadline, round_number, initial_banks=None):
    require(len(plan['training']) == TRAINING_OBJECTS and len(plan['heldout']) == HELDOUT_OBJECTS,
        'Summary training split differs')
    require(all(t['split'] == 'training' for t in plan['training']) and
        all(t['split'] == 'heldout' for t in plan['heldout']), 'Training/heldout split changed')
    require(all(len({plan['training'][n+i]['family'] for i in range(REWARD_OBJECTS_PER_SUMMARY)})==2
        for n in SUMMARY_WRITE_OBJECTS),'Prescheduled reward windows are not structurally balanced')
    heads = {b: restore_head(copy.deepcopy(initial_heads[b])) for b in BRANCHES}
    banks = copy.deepcopy(initial_banks or {b: None for b in BRANCHES})
    replay = {b: [] for b in BRANCHES}; objects = []; updates = []; summaries = []
    original_roots = copy.deepcopy(roots)
    pending = {b: None for b in BRANCHES}  # One policy-bound proposal per branch.
    retention_cases={};retention_reviews=[]
    checkpoint('initial', {b:h.state() for b,h in heads.items()}, banks)

    def remaining():
        if time.monotonic() >= deadline: raise TimeoutError('Summary training deadline before next action')

    def load_note(branch):
        return read_summary(banks[branch]) if banks[branch] else None

    def routes_for(task, number, cards):
        routes = []
        for candidate in cards:
            remaining()
            row = ask('route_math', math_messages(task, candidate, roots), seed_for(round_number, number, 20),
                mode='math', sampled=False, task=task, selectedCandidate=copy.deepcopy(candidate),
                hostSpecifiedRoute=True, autonomousToolUseClaimed=False)
            row = dict(row, check=audit_math(task, row['studentOutput'], candidate))
            save('scored', row); routes.append(row)
            if not row['check']['outcomePassed']: save('failure', dict(row, id=row['recordId']))
        return routes

    for number, task in enumerate(plan['training'], 1):
        remaining(); observations = {}; vectors = {}; feature_ids = {}; probes = {}; decisions = []
        select_branch(BRANCHES[0])
        plain_row=ask('training_observation_without_summary',observation_messages(task,roots),
            seed_for(round_number,number,1),mode='observation',sampled=False,task=task,
            branch='shared_without_summary',summaryZipId=None)
        save('scored',dict(plain_row,check=dict(originalPreserved=True,explanationCertified=False,
            sharedNoSummaryBaseline=True,observationDecodingMode='greedy')))
        plain,plain_id=feature(task,plain_row,candidate_cards(roots))
        for branch in BRANCHES:
            select_branch(branch); note = load_note(branch)
            context_note = note if branch == BRANCHES[0] else None
            if note:
                row=ask('training_observation_with_summary',observation_messages(task,roots,note),
                    seed_for(round_number,number,1),mode='observation',sampled=False,task=task,
                    branch=branch,summaryZipId=note['id'],counterfactualCriticOnly=branch==BRANCHES[1])
                save('scored',dict(row,check=dict(originalPreserved=True,explanationCertified=False,
                    observationDecodingMode='greedy',counterfactualCriticOnly=branch==BRANCHES[1])))
                noted,noted_id=feature(task,row,candidate_cards(roots,note))
            else:row=plain_row;noted,noted_id=plain,plain_id
            # The operative sealed path uses the plain baseline. Its note's full
            # counterfactual observation and cards are read only by its critic.
            observations[branch] = row if context_note else plain_row
            probes[branch] = (plain,plain_id,noted,noted_id,row)
            use_note = branch == BRANCHES[0] and note is not None
            vectors[branch], feature_ids[branch] = (noted, noted_id) if use_note else (plain, plain_id)
            decision = saved_choice(task, branch, vectors[branch], candidate_cards(roots, context_note), heads[branch],
                seed_for(round_number, number, 10), 1, observations[branch]['recordId'], feature_ids[branch])
            save('decision', decision); decisions.append(decision)
        routes = routes_for(task, number, candidate_cards(roots))
        outcomes = [int(r['check']['outcomePassed']) for r in routes]
        expected = {b:expected_pass(heads[b], vectors[b], outcomes)[0] for b in BRANCHES}
        obj = dict(id=task['id'], task=copy.deepcopy(task), phase='training', routeOutcomes=outcomes,
            sourceMathRecordIds=[r['recordId'] for r in routes], expectedPassByArm=expected,
            featureIdsByArm=feature_ids,observationRecordIdsByArm={b:observations[b]['recordId'] for b in BRANCHES},
            allChoicesSavedBeforeRoutes=True,
            sourceSummaryIdsByArm={b:(load_note(b)['id'] if b == BRANCHES[0] and banks[b] else None) for b in BRANCHES})
        save('object', obj); objects.append(obj)
        for branch, decision in zip(BRANCHES, decisions):
            remaining(); select_branch(branch)
            previous = pending[branch]
            word_update = dict(updated=False, parameterChanged=False, reason='no_pending_sampled_summary')
            credit = None
            plain,plain_id,noted,noted_id,noted_row=probes[branch]
            current_note=load_note(branch)
            if current_note:
                retention_cases.setdefault(current_note['id'],[]).append(dict(task=copy.deepcopy(task),
                    without=copy.deepcopy(plain),withSummary=copy.deepcopy(noted),outcomes=list(outcomes),
                    featureIds=dict(without=plain_id,withSummary=noted_id),
                    sourceMathRecordIds=[r['recordId'] for r in routes]))
            if previous:
                item = summary_credit(previous['note'], task, expected_pass(heads[branch], plain, outcomes)[0],
                    expected_pass(heads[branch], noted, outcomes)[0], dict(without=plain_id, withSummary=noted_id),
                    dict(without=plain_row['recordId'],withSummary=noted_row['recordId']),seed_for(round_number,number,1))
                item.update(rewardObjectNumber=number,rewardTaskFamily=task['family'],
                    sourceMathRecordIds=[r['recordId'] for r in routes])
                previous['measurements'].append(item)
                if len(previous['measurements'])==REWARD_OBJECTS_PER_SUMMARY:
                    credit=multi_object_credit(previous['note'],previous['measurements'])
                    word_update=learn_summary(previous['note'],credit,'multiple_later_training_objects')
                    if not credit['eligibleForRetention']:
                        banks[branch]=previous['fallback']
                    pending[branch]=None
            replay[branch].append(replay_item(task, vectors[branch], outcomes, feature_ids[branch], [r['recordId'] for r in routes]))
            head_update = guarded_head_update(heads[branch], replay[branch], number)
            update = dict(id=branch+'-'+str(number), taskId=task['id'], branch=branch,
                delayedSummaryCredit=credit, summaryUpdate=word_update, headUpdate=head_update,
                summaryMeasurement=item if previous else None,
                pendingRewardMeasurements=len(pending[branch]['measurements']) if pending[branch] else 0,
                retainedAfterNetFeedback=bool(credit and credit['eligibleForRetention']))
            save('update', update); updates.append(update)
            chosen = next(r for r in routes if r['selectedCandidate']['id'] == decision['selectedCandidate']['id'])
            save('trial', dict(id=decision['id'], taskId=task['id'], phase='training', arm=branch,
                decisionId=decision['id'], sourceMathRecordId=chosen['recordId'], outcomePassed=chosen['check']['outcomePassed']))
            if number in SUMMARY_WRITE_OBJECTS:
                require(pending[branch] is None,'Cannot replace an unevaluated policy-bound summary')
                remaining()
                event = event_record(task, observations[branch], decision, routes)
                row = ask('experience_summary', summary_messages(event), seed_for(round_number, number, 30),
                    mode='summary', sampled=True, task=task, branch=branch, eventHash=event['eventHash'])
                note = make_summary(row, event, branch)
                save('scored', dict(row, check=copy.deepcopy(note['audit'])))
                store_summary(note); save('summary', note); summaries.append(note)
                if note['audit']['eligibleForTrial']:
                    pending[branch]=dict(note=note,measurements=[],fallback=banks[branch])
                    banks[branch] = note['id']
                else:
                    penalty = dict(sourceSummaryZipId=note['id'], sourceWordRecordId=note['sourceRecordId'],
                        sourceTaskId=task['id'], rewardTaskId=task['id'], advantage=STRUCTURE_PENALTY,
                        signedFullReuseGain=None, reason='separate_completion_or_disproved_fact_penalty',
                        audit=note['audit'], rewardObjectSplit='training', correctedTextTargetsSupplied=False)
                    word_update = learn_summary(note, penalty, 'original_rejection_penalty')
                    save('penalty', dict(id=note['id'], branch=branch, summaryCredit=penalty, summaryUpdate=word_update))
            checkpoint('after-'+str(number)+'-'+branch, {b:h.state() for b,h in heads.items()}, banks)
        require(roots == original_roots, 'Mathematical roots changed')
    require(all(p is None for p in pending.values()), 'Last new summary never received its scheduled later feedback')
    # A head update after a positive word reward can change the note's utility.
    # Guard current task context once more on TRAIN evidence, before any heldout.
    for branch in BRANCHES:
        note=load_note(branch)
        if not note:continue
        all_cases=retention_cases.get(note['id'],[]);chosen=[]
        for case in reversed(all_cases):
            if not any(c['task']['family']==case['task']['family'] for c in chosen):chosen.append(case)
            if len(chosen)==REWARD_OBJECTS_PER_SUMMARY:break
        if len(chosen)==REWARD_OBJECTS_PER_SUMMARY:
            review=retention_review(note,list(reversed(chosen)),heads[branch])
        else:
            review=dict(id=note['id'],branch=branch,summaryZipId=note['id'],
                finalHeadHash=heads[branch].state()['parameterHash'],measurements=[],
                retainedForHeldout=False,reason='insufficient_two_structure_evidence_under_current_head',
                usesTrainingEvidenceOnly=True,newStudentGenerations=0,writerUpdatedAgain=False,oldScoresChanged=False)
        save('summary-context-review',review);retention_reviews.append(review)
        if not review['retainedForHeldout']:banks[branch]=None
    checkpoint('training-final', {b:h.state() for b,h in heads.items()}, banks)
    heldout_heads = {b:h.state() for b,h in heads.items()}; heldout_banks = copy.deepcopy(banks)
    frozen_initial = restore_head(copy.deepcopy(initial_heads[BRANCHES[0]]))
    frozen_initial_seal = restore_head(copy.deepcopy(initial_heads[BRANCHES[1]]))
    for number, task in enumerate(plan['heldout'], TRAINING_OBJECTS+1):
        remaining(); select_branch(BRANCHES[0]); note = load_note(BRANCHES[0])
        plain_row = ask('heldout_observation_without_summary', observation_messages(task, roots),
            seed_for(round_number, number, 1), mode='observation', sampled=False, task=task, summaryZipId=None)
        save('scored', dict(plain_row, check=dict(originalPreserved=True, sharedNoSummaryBaseline=True, heldoutTrainingUpdates=0)))
        plain_vec, plain_id = feature(task, plain_row, candidate_cards(roots))
        if note:
            with_row = ask('heldout_observation_with_summary', observation_messages(task, roots, note),
                seed_for(round_number, number, 1), mode='observation', sampled=False, task=task,summaryZipId=note['id'])
            save('scored', dict(with_row, check=dict(originalPreserved=True, heldoutTrainingUpdates=0)))
            with_vec, with_id = feature(task, with_row, candidate_cards(roots, note))
        else:with_row=plain_row;with_vec,with_id=plain_vec,plain_id
        vectors = {a:(with_vec if a == BRANCHES[0] else plain_vec) for a in EVALUATION_ARMS}
        head_by_arm = {BRANCHES[0]:heads[BRANCHES[0]], BRANCHES[1]:heads[BRANCHES[1]],
            EVALUATION_ARMS[2]:heads[BRANCHES[0]], EVALUATION_ARMS[3]:frozen_initial,
            EVALUATION_ARMS[4]:frozen_initial_seal}
        decisions = []
        for index in (1, 2, 3):
            for arm in EVALUATION_ARMS:
                row = with_row if arm == BRANCHES[0] else plain_row
                decision = saved_choice(task, arm, vectors[arm], candidate_cards(roots, note if arm == BRANCHES[0] else None),
                    head_by_arm[arm], seed_for(round_number, number, 50+index), index,
                    row['recordId'], with_id if arm == BRANCHES[0] else plain_id)
                save('decision', decision); decisions.append(decision)
        routes = routes_for(task, number, candidate_cards(roots))
        outcomes = [int(r['check']['outcomePassed']) for r in routes]
        probabilities = {a:expected_pass(head_by_arm[a], vectors[a], outcomes)[1] for a in EVALUATION_ARMS}
        expected = {a:sum(p*y for p,y in zip(probabilities[a], outcomes)) for a in EVALUATION_ARMS}
        obj = dict(id=task['id'], task=copy.deepcopy(task), phase='heldout', routeOutcomes=outcomes,
            sourceMathRecordIds=[r['recordId'] for r in routes], expectedPassByArm=expected, probabilitiesByArm=probabilities,
            primaryPairedDifference=expected[BRANCHES[0]]-expected[BRANCHES[1]],
            sameHeadSummaryAblationDifference=expected[BRANCHES[0]]-expected[EVALUATION_ARMS[2]],
            featureIdsByArm={a:with_id if a == BRANCHES[0] else plain_id for a in EVALUATION_ARMS},
            observationRecordIdsByArm={a:with_row['recordId'] if a == BRANCHES[0] else plain_row['recordId'] for a in EVALUATION_ARMS},
            summaryZipId=note['id'] if note else None, allChoicesSavedBeforeRoutes=True, trainingUpdates=0)
        save('object', obj); objects.append(obj)
        for decision in decisions:
            route = next(r for r in routes if r['selectedCandidate']['id'] == decision['selectedCandidate']['id'])
            save('trial', dict(id=decision['id'], taskId=task['id'], phase='heldout', arm=decision['arm'],
                seedIndex=decision['seedIndex'], decisionId=decision['id'], sourceMathRecordId=route['recordId'],
                outcomePassed=route['check']['outcomePassed'], noExtraGenerationForSeedTrial=True))
        require({b:h.state() for b,h in heads.items()} == heldout_heads and banks == heldout_banks and roots == original_roots,
            'Frozen heldout state changed')
    checkpoint('final', {b:h.state() for b,h in heads.items()}, banks)
    return dict(finalHeads={b:h.state() for b,h in heads.items()}, finalBanks=banks,
        objects=objects, updates=updates, summaries=summaries,retentionReviews=retention_reviews,heldoutStateUnchanged=True)


def summarize(objects, trials, summaries, updates, penalties, retention_reviews=()):
    held = [o for o in objects if o['phase'] == 'heldout']
    means = {a:sum(o['expectedPassByArm'][a] for o in held)/len(held) if held else None for a in EVALUATION_ARMS}
    return dict(primaryMetric='probability mass on all actually verified successful method routes',
        heldoutObjects=len(held), expectedPassByArm=means,
        reuseMinusSeal=means[BRANCHES[0]]-means[BRANCHES[1]] if held else None,
        sameHeadWithMinusWithoutSummary=means[BRANCHES[0]]-means[EVALUATION_ARMS[2]] if held else None,
        preRoundHeadGapWithoutSummaries=means[EVALUATION_ARMS[3]]-means[EVALUATION_ARMS[4]] if held else None,
        branchGapChangeFromFrozenPreRoundHeads=(means[BRANCHES[0]]-means[BRANCHES[1]])-
            (means[EVALUATION_ARMS[3]]-means[EVALUATION_ARMS[4]]) if held else None,
        reuseHeadChangeWithSummaryRemoved=means[EVALUATION_ARMS[2]]-means[EVALUATION_ARMS[3]] if held else None,
        sealHeadChangeWithoutSummary=means[BRANCHES[1]]-means[EVALUATION_ARMS[4]] if held else None,
        byObject=[dict(taskId=o['id'],expression=o['task']['expression'],routeOutcomes=o['routeOutcomes'],
            primaryPairedDifference=o['primaryPairedDifference'],sameHeadSummaryAblationDifference=o['sameHeadSummaryAblationDifference'],
            summaryZipId=o['summaryZipId']) for o in held],
        heldoutByFamily={family:dict(objects=len(rows),
            expectedPassByArm={a:sum(o['expectedPassByArm'][a] for o in rows)/len(rows) for a in EVALUATION_ARMS},
            reuseMinusSeal=sum(o['primaryPairedDifference'] for o in rows)/len(rows),
            sameHeadWithMinusWithoutSummary=sum(o['sameHeadSummaryAblationDifference'] for o in rows)/len(rows))
            for family in sorted({o['task']['family'] for o in held})
            for rows in [[o for o in held if o['task']['family']==family]]},
        studentWrittenSummaries=len(summaries), eligibleHypothesisZips=sum(n['audit']['eligibleForTrial'] for n in summaries),
        delayedSummaryFeedbackRecords=sum(u['delayedSummaryCredit'] is not None for u in updates),
        pairedTrainingRewardMeasurements=sum(u.get('summaryMeasurement') is not None for u in updates),
        rewardObjectsPerNewEligibleSummary=REWARD_OBJECTS_PER_SUMMARY,
        completionOrFactPenaltyUpdates=sum(bool(p['summaryUpdate'].get('updated')) for p in penalties),
        measuredUsefulnessUpdates=sum(bool(u['summaryUpdate'].get('updated')) for u in updates),
        measuredPositiveUpdates=sum(bool(u['summaryUpdate'].get('updated')) and u['delayedSummaryCredit']['advantage']>0 for u in updates),
        measuredNegativeUpdates=sum(bool(u['summaryUpdate'].get('updated')) and u['delayedSummaryCredit']['advantage']<0 for u in updates),
        summariesWithdrawnAfterTrainingGuard=sum(u['delayedSummaryCredit'] is not None and
            not u['delayedSummaryCredit']['eligibleForRetention'] for u in updates),
        summariesWithTrainingStructureRegression=sum(u['delayedSummaryCredit'] is not None and
            not u['delayedSummaryCredit']['noTrainingStructureRegression'] for u in updates),
        finalHeadContextReviews=len(retention_reviews),
        summariesWithdrawnAtFinalTrainingHead=sum(not r['retainedForHeldout'] for r in retention_reviews),
        cappedSummaries=sum(n['studentOriginal']['studentOutput']['tokenCapReached'] for n in summaries),
        summariesWithDisprovedTaskResult=sum('disproved_explicit_task_result' in n['audit']['reasons'] for n in summaries),
        eligibleUniqueStudentTexts=len({n['studentRaw'] for n in summaries if n['audit']['eligibleForTrial']}),
        actualSummaryOptimizerUpdatesByBranch={b:sum(bool(u['summaryUpdate'].get('updated')) for u in updates if u['branch']==b)+
            sum(bool(p['summaryUpdate'].get('updated')) for p in penalties if p['branch']==b) for b in BRANCHES},
        choiceHeadUpdatesByBranch={b:sum(u['headUpdate']['updated'] for u in updates if u['branch']==b) for b in BRANCHES},
        sampledHeldoutOutcomesByArm={a:dict(trials=sum(t['phase']=='heldout' and t['arm']==a for t in trials),
            passes=sum(t['phase']=='heldout' and t['arm']==a and t['outcomePassed'] for t in trials)) for a in EVALUATION_ARMS},
        seedSamplesNotIndependentObjects=True, independentTrainingReplications=0,
        matchedTrainingOpportunityBudgets=True, actualUpdateCountsMayDiffer=True,
        continuedBranchStatesMayDifferAtRoundStart=True,branchGapIncludesCumulativeHistory=True,
        frozenPreRoundHeadsShareCurrentNoSummaryObservationsAndActualRouteOriginals=True,
        sealedSummariesUsedByFullReuseTrainingCritic=True, sealedSummariesSuppliedToOrdinaryTaskWriter=False,
        positiveCreditRequiresMathematicalProofOfProse=False, wholeProseTruthCertified=False,
        summaryTrainingRewardIsConditionalCardEffect=False,summaryTrainingRewardIsFullReuseEffect=True,
        trainingAndHeldoutObservationDecodingMode='greedy',
        positiveCreditRequiresNoLossOnEitherScheduledTrainingStructure=True,
        finalRetentionUsesTrainingEvidenceUnderFinalHead=True,observationGenerationRewardEffectIsolated=False,
        frozenSummaryAblationIncludesObservationAndCardContext=True, uniqueZipEncodingEffectIsolated=False,
        autonomousRetrievalProved=False, structuralGeneralizationProved=False,
        newStandaloneMathematicalRules=0, oldScoresChanged=False, statisticalSignificanceClaimed=False)
