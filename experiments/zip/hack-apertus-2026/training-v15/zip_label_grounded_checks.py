"""Bounded v5 checks and training feedback; no models or teacher targets.

The replay guard covers saved TRAINING representations only. It neither
certifies prose nor promises unchanged performance on unseen objects.
"""
import copy
import math
import re

from draft_inspect_runtime import draft_statements
from zip_answer_audit import math_parts, equality
from zip_content_core import OutsideScope, digest
from object_choice_core import ChoiceHead

NOTE_GATE_PROTOCOL = 'written-polynomial-equality-exclusion-v1'
CREDIT_PROTOCOL = 'observation-return-and-joint-card-delta-v1'
HEAD_PROTOCOL = 'all-seen-training-replay-with-per-object-floor-v1'
FEATURE_PROTOCOL = 'candidate-first-current-object-last-v1'
HEAD_RATE = .5
HEAD_TRIALS = 12
TOLERANCE = 1e-12


def require(value, reason):
    if not value:
        raise ValueError(reason)


def note_audit(raw):
    """Audit only complete written sides; never reconstruct a missing equality.

In addition to legacy whole lines, explicitly delimited inline math and a
whole suffix after a colon are bounded presentation cases. Unknown prose,
unsupported mathematics and quotation intent are not adjudicated. Any parsed
false equality excludes the note, even if its prose describes that example.
    """
    legacy = draft_statements(raw)
    rows = copy.deepcopy(legacy['writtenEqualities'])
    seen = {(r['left'], r['right']) for r in rows}
    fragments = []
    if isinstance(raw, str) and len(raw) <= 16000 and len(raw.splitlines()) <= 80:
        for line_number, line in enumerate(raw.splitlines(), 1):
            for pattern, kind in ((r'(?<!`)`([^`\n]{1,1000})`(?!`)', 'inline_backticks'),
                                  (r'(?<!\$)\$([^$\n]{1,1000})\$(?!\$)', 'inline_dollars')):
                for match in re.finditer(pattern, line):
                    fragments.append((line_number, match[1], kind))
            if ':' in line:
                fragments.append((line_number, line.rsplit(':', 1)[1].strip(), 'whole_colon_suffix'))
        for line_number, fragment, kind in fragments[:160]:
            if '=' not in fragment:
                continue
            try:
                parts = math_parts(fragment)
            except OutsideScope:
                continue
            for left, right in zip(parts, parts[1:]):
                if (left, right) in seen:
                    continue
                seen.add((left, right))
                rows.append(dict(left=left, right=right, sourceLine=line_number,
                    sourceFragment=fragment, extractionKind=kind,
                    exactIdentityAudit=equality(left, right)))
    rejected = [i for i, row in enumerate(rows)
                if row['exactIdentityAudit']['status'] == 'rejected']
    return dict(protocol=NOTE_GATE_PROTOCOL, writtenEqualities=rows,
        rejectedEqualityIndices=rejected, containsDisprovedWrittenEquality=bool(rejected),
        legacyExtraction=legacy, proseTruthCertified=False, missingMathematicsFilled=False,
        wholeDraftCertified=False, quotationIntentInterpreted=False,
        exclusionIsNotCertificationOfOtherNotes=True)


def feature_messages(task, output, candidate):
    description = candidate['description']
    if candidate['kind'] != 'direct':
        rule = candidate['root']['rule']
        description += '\nStored rule: ' + rule['input'] + ' = ' + rule['output']
    return [dict(role='system', content=(
        'Consider whether this method can help rewrite the current object. '
        'Its applicability must be checked, not assumed from keywords. '
        'Earlier examples in a provisional note are not the current object.')),
        dict(role='user', content='Candidate method:\n' + description +
            '\nStudent-written observations (complete original):\n' + output['raw'] +
            '\nCurrent object: ' + task['expression'])]


def semantic_credits(rows, versions, old_expected, new_expected, baseline):
    require(len(rows) == 3 and len(versions) == 2, 'Three original trajectories and two revisions required')
    require(all(math.isfinite(x) and 0 <= x <= 1
                for x in (old_expected, new_expected, baseline)), 'Invalid audited probability reward')
    audits = [note_audit(row['studentOutput']['raw']) for row in rows]
    advantages = [2 * (old_expected - baseline)]
    reasons = ['observation_return_with_previous_cards_minus_running_baseline']
    if rows[0]['studentOutput']['tokenCapReached']:
        advantages[0] = 0.
        reasons[0] = 'capped_observation_receives_no_outcome_credit'
    for version in versions:
        active = version['activatedAsRetrievalMetadata']
        advantages.append(2 * (new_expected - old_expected) if active else 0.)
        reasons.append('joint_activated_card_delta_before_any_weight_update' if active
                       else 'inactive_revision_receives_no_outcome_credit')
    for index, audit in enumerate(audits):
        if audit['containsDisprovedWrittenEquality']:
            advantages[index] = -1.
            reasons[index] = 'exact_disproved_written_equality_negative_credit'
    return dict(protocol=CREDIT_PROTOCOL, sourceWordRecordIds=[r['recordId'] for r in rows],
        advantages=advantages, reasons=reasons,
        sourceAudits=audits, expectedPassWithPreviousLabels=old_expected,
        expectedPassWithRevisedLabels=new_expected, baselinePass=baseline,
        jointCardExpectedDifference=new_expected-old_expected,
        activatedRevisionIds=[v['id'] for v in versions if v['activatedAsRetrievalMetadata']],
        individualCardEffectsIsolated=False, observationCounterfactualIsolated=False,
        headUpdateIncludedInSemanticReward=False, targetTokensProvided=False,
        proseTruthCertified=False)


def replay_item(task, features, outcomes, feature_id, math_ids):
    require(task.get('split') == 'training', 'Heldout observations cannot enter replay training')
    require(len(outcomes) == 3 and all(type(y) is int and y in (0, 1) for y in outcomes),
            'Three actually audited binary route outcomes required')
    require(len(features) == 3 and features[0] and
            all(len(v) == len(features[0]) and all(math.isfinite(x) for x in v) for v in features),
            'Invalid frozen candidate representations')
    require(len(math_ids) == 3 and len(set(math_ids)) == 3, 'All three route originals required')
    return dict(taskId=task['id'], split='training', features=copy.deepcopy(features),
        routeOutcomes=list(outcomes), sourceFeatureId=feature_id, sourceMathRecordIds=list(math_ids))


def expectation(head, item):
    _, probabilities = head.probabilities(item['features'])
    return sum(p*y for p, y in zip(probabilities, item['routeOutcomes']))


def guarded_head_update(head, replay, session_step):
    require(type(session_step) is int and 1 <= session_step <= 8 and len(replay) == session_step,
            'Replay contains exactly the completed training objects from this round')
    require(len({r['taskId'] for r in replay}) == len(replay), 'Duplicate replay training object')
    for item in replay:
        require(item['split'] == 'training', 'Heldout replay is forbidden')
        replay_item(dict(id=item['taskId'], split=item['split']), item['features'],
                    item['routeOutcomes'], item['sourceFeatureId'], item['sourceMathRecordIds'])
    before = head.state()
    expected_before = [expectation(head, r) for r in replay]
    gradient = [0.] * len(head.weights)
    for item in replay:
        _, probabilities = head.probabilities(item['features'])
        rewards = [2*y-1 for y in item['routeOutcomes']]
        er = sum(p*r for p, r in zip(probabilities, rewards))
        for index in range(len(gradient)):
            gradient[index] += sum(p*(r-er)*v[index] for p, r, v in
                zip(probabilities, rewards, item['features'])) / len(replay)
    norm = math.sqrt(sum(g*g for g in gradient))
    require(math.isfinite(norm), 'Nonfinite replay gradient')
    scale = min(1., 1./max(norm, 1e-12))
    trials = []; accepted_rate = 0.
    if norm > 1e-12:
        for index in range(HEAD_TRIALS):
            rate = HEAD_RATE * .5**index
            proposed = ChoiceHead([w+rate*scale*g for w, g in zip(head.weights, gradient)])
            expected_after = [expectation(proposed, r) for r in replay]
            floor = all(a >= b-TOLERANCE for a, b in zip(expected_after, expected_before))
            gain = sum(expected_after)/len(replay)-sum(expected_before)/len(replay)
            accept = floor and gain > TOLERANCE
            trials.append(dict(learningRate=rate, expectedPassByObject=expected_after,
                               trainingObjectFloorSatisfied=floor, meanGain=gain, accepted=accept))
            if accept:
                head.weights = proposed.weights
                head.updates += 1
                accepted_rate = rate
                break
    after = head.state()
    current = replay[-1]
    _, p_before = ChoiceHead(before['weights']).probabilities(current['features'])
    _, p_after = head.probabilities(current['features'])
    expected_after = [expectation(head, r) for r in replay]
    return dict(updated=bool(accepted_rate), sessionStep=session_step,
        cumulativeParameterUpdates=head.updates, beforeHash=before['parameterHash'],
        afterHash=after['parameterHash'], beforeState=before, afterState=after,
        routeOutcomes=current['routeOutcomes'], routeRewards=[2*y-1 for y in current['routeOutcomes']],
        probabilitiesBefore=p_before, probabilitiesAfter=p_after,
        expectedPassBefore=expected_before[-1], expectedPassAfter=expected_after[-1],
        gradientNormBeforeClip=norm, learningRate=accepted_rate,
        algorithm=HEAD_PROTOCOL, replayTaskIds=[r['taskId'] for r in replay],
        replaySourceFeatureIds=[r['sourceFeatureId'] for r in replay], replayHash=digest(replay),
        replayExpectedPassBefore=expected_before, replayExpectedPassAfter=expected_after,
        lineSearchTrials=trials, maximumTrials=HEAD_TRIALS,
        reason='accepted_training_replay_step' if accepted_rate else 'no_nonregressing_replay_step',
        numericalFloorTolerance=TOLERANCE, guardUsesSavedTrainingRepresentationsOnly=True,
        heldoutRegressionPrevented=False, historicalRoundsIncludedInGuard=False,
        feedbackFromAllThreeActualStudentRoutes=True, correctToolLabelSupplied=False,
        onlyChoiceHeadUpdated=True, mathTargetTokensProvided=False)
