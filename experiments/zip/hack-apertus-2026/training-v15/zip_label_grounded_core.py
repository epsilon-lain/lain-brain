"""Student-authored observations and ZIP metadata iterate through real feedback.

No handwritten semantic tags or correct-method labels enter the student. The
two mathematical roots remain frozen. Description revisions are untrusted
student prose, used as retrieval metadata and never claimed as new theorems.
"""
import copy
import math
import time

from choice_continue_core import make_plan
from zip_label_grounded_checks import (note_audit, semantic_credits, replay_item, guarded_head_update)
from choice_retest_core import restore_head
from object_choice_core import math_messages, exact_instance
from zip_label_feedback_audit import audit_math, diagnostic, feedback_for, PROTOCOL as SCORING_PROTOCOL
from zip_content_core import digest, verify_claim
from draft_inspect_runtime import draft_statements
from zip_semantic_generation import (LEGACY_LANGUAGE, COMPACT_LANGUAGE, NATURAL_LANGUAGE,
    NOTE_LANGUAGES, note_instruction, note_contract, framing_check)

PROTOCOL = 'lain-zip-student-label-iteration-v1'
COMPACT_PROTOCOL = 'lain-zip-student-label-iteration-v2'
NATURAL_PROTOCOL = 'lain-zip-label-grounded-feedback-v5'
TOKENS = 96
GENERATION_CAP = 80  # First round 78; continuations 76. Cold replays included.
FEATURE_BATCH_CAP = 28  # Every batch contains precisely three candidates.
TRAINING_OBJECTS = 8
HELDOUT_OBJECTS = 4
WRITER_UPDATE_CAP = 8
HEAD_UPDATE_CAP = 8
WRITER_LEARNING_RATE = 0.001
ARMS = ('learning_zip_iteration', 'frozen_before_round', 'learned_with_frozen_label_cards')


def require(value, reason):
    if not value:
        raise ValueError(reason)


def seed_for(round_number, object_number, slot):
    require(type(round_number) is int and 1 <= round_number <= 1000, 'Invalid iteration round')
    require(type(object_number) is int and 0 <= object_number <= 12, 'Invalid object number')
    require(type(slot) is int and 0 <= slot < 100, 'Invalid seed slot')
    return 2_300_000_000 + round_number * 100_000 + object_number * 100 + slot


def root_line(root):
    return root['rule']['input'] + ' = ' + root['rule']['output']


def initial_label_messages(root, language_protocol=LEGACY_LANGUAGE):
    if language_protocol in NOTE_LANGUAGES:
        return [dict(role='system', content=(
            'Describe this stored algebraic rewrite in your own words. '
            'What does it do, and what would help you recall it? '
            'Your note is provisional, not a proof. ' + note_instruction(language_protocol))),
            dict(role='user', content='Stored algebraic rewrite:\n' + root_line(root) +
                '\nScope: independent real variables; real_polynomial.')]
    require(language_protocol == LEGACY_LANGUAGE, 'Unknown language protocol')
    return [dict(role='system', content=(
        'Describe this stored ZIP in your own words. Write your observations of '
        'what it does, what might help you recall it, and anything you are unsure '
        'about. This is your provisional description, not a new proof.')),
        dict(role='user', content='Stored ZIP: ' + root['id'] + '\n' + root_line(root) +
             '\nScope: independent real variables; real_polynomial.')]


def label_text(label):
    return label.get('activeDescriptionRaw', '')


def observations_messages(task, roots, labels, language_protocol=LEGACY_LANGUAGE):
    if language_protocol in NOTE_LANGUAGES:
        parts = ['Scope: independent real variables; real_polynomial.',
            'Available stored algebraic rewrites and your provisional notes:']
        for index, root in enumerate(roots, 1):
            parts += ['Rewrite ' + str(index) + ': ' + root_line(root),
                'Your earlier note, unverified prose:\n' + label_text(labels[root['id']])]
        parts += ['The stored-rule symbols are placeholders; the actual object is below.',
                  'Current object: ' + task['expression']]
        return [dict(role='system', content=(
            'Observe the current mathematical object in your own words to help recall a method. '
            'Ground the observations in this expression and its actual symbols. '
            'Describe something concrete that distinguishes this expression, rather than only its domain. '
            'Earlier examples are not the current task. Do not solve it or invent variables. ' + note_instruction(language_protocol))),
            dict(role='user', content='\n'.join(parts))]
    require(language_protocol == LEGACY_LANGUAGE, 'Unknown language protocol')
    parts = ['Current object: ' + task['expression'],
             'Scope: independent real variables; real_polynomial.',
             'Available stored ZIPs and your provisional descriptions:']
    for root in roots:
        parts += [root['id'], root_line(root),
                  'Student-written description, unverified prose:\n' + label_text(labels[root['id']])]
    return [dict(role='system', content=(
        'Write your own observations of the current mathematical object that '
        'could help recall a method. You may refer to your previous ZIP notes. '
        'Do not solve the object. No correct method is identified for you.')),
        dict(role='user', content='\n'.join(parts))]


def revision_messages(task, root, previous, keywords, route, language_protocol=LEGACY_LANGUAGE):
    check = route['check']
    feedback = feedback_for(check)
    if language_protocol in NOTE_LANGUAGES:
        return [dict(role='system', content=(
            'Revise your note about this stored algebraic rewrite using your own observations '
            'and this actual attempt with audit feedback. What have you learned for next time? '
            'Read mathematical truth, task equivalence, completion and tool support separately. '
            'A syntax or tool failure alone does not mean the written identity is false. '
            'Write what would help recall this rewrite on another object. Do not merely repeat auditor wording. '
            'Keep unresolved facts uncertain. The note remains provisional. '
            'No corrected answer is supplied. ' + note_instruction(language_protocol))),
            dict(role='user', content='Stored algebraic rewrite:\n' + root_line(root) +
                '\nYour previous note:\n' + label_text(previous) +
                '\nYour observations:\n' + keywords['studentOutput']['raw'] +
                '\nYour actual attempt (program-scheduled route):\n' + route['studentOutput']['raw'] +
                '\nExact audit feedback: ' + str(feedback) +
                '\nCurrent object: ' + task['expression'])]
    require(language_protocol == LEGACY_LANGUAGE, 'Unknown language protocol')
    return [dict(role='system', content=(
        'Revise your description of this ZIP using your own observations and '
        'this attempted application with exact audit feedback. Write what you '
        'now understand, what could be useful next time, and what remains uncertain. '
        'The description is provisional. No corrected answer is supplied.')),
        dict(role='user', content='Stored ZIP: ' + root['id'] + '\n' + root_line(root) +
             '\nYour previous description:\n' + label_text(previous) +
             '\nCurrent object: ' + task['expression'] +
             '\nYour object observations:\n' + keywords['studentOutput']['raw'] +
             '\nYour attempted application in this host-scheduled method audit:\n' +
             route['studentOutput']['raw'] + '\nExact audit feedback: ' + str(feedback) +
                '\nCurrent object: ' + task['expression'])]


def version_label(root, row, previous=None, language_protocol=LEGACY_LANGUAGE):
    raw = row['studentOutput']['raw']
    usable = bool(raw.strip()) and not row['studentOutput']['tokenCapReached']
    require(language_protocol in (LEGACY_LANGUAGE,) + NOTE_LANGUAGES, 'Unknown language protocol')
    contract = (framing_check(raw, row['studentOutput']['tokenCapReached'], language_protocol)
        if language_protocol in NOTE_LANGUAGES else note_contract(raw, row['studentOutput']['tokenCapReached']))
    if language_protocol in NOTE_LANGUAGES: usable = contract['complete']
    assertions = note_audit(raw)
    blocked = assertions['containsDisprovedWrittenEquality']
    usable = usable and not blocked
    result = dict(id='zip-label-' + digest(dict(root=root['id'], source=row['recordId'], raw=raw))[:20],
        rootId=root['id'], rootVersion=root['version'], rootClaimHash=digest(root['rule']),
        sourceRecordId=row['recordId'], parentDescriptionId=previous['id'] if previous else None,
        studentRaw=raw, studentRawHash=digest(raw), tokenCapReached=row['studentOutput']['tokenCapReached'],
        activatedAsRetrievalMetadata=usable,
        activeDescriptionRaw=raw if usable else label_text(previous or {}),
        wholeNaturalLanguageCertified=False, mathematicalRootChanged=False,
        status=('unverified_student_retrieval_metadata' if usable else
            'inactive_disproved_written_equality' if blocked else 'inactive_incomplete_description'),
        mathematicalAssertionsAudit=assertions,
        activationPolicy='exclude any parsed disproved polynomial equality; unknown prose remains unverified',
        knownFalseEqualityBlocked=blocked, originalTextRepaired=False)
    if language_protocol in NOTE_LANGUAGES:
        result.update(languageProtocol=language_protocol, noteFramingCheck=contract,
            sourceTaskId=row.get('task', {}).get('id'), sourcePhase=row['phase'])
    return result


def cards(roots, labels, language_protocol=LEGACY_LANGUAGE):
    # Keep three candidates and their order fixed. No manual tags, keyword
    # overlap ranking, task-family gate, expected answer or object binding.
    result = [dict(id='DIRECT', kind='direct', scope='real_polynomial', tags=[],
        description='Try a complete rewrite without a stored ZIP.')]
    for root, kind in zip(roots, ('combine', 'distribute')):
        require(verify_claim(root['rule'])['reusable'], 'Existing mathematical root is not reusable')
        label = labels[root['id']]
        require(label['rootClaimHash'] == digest(root['rule']) and
                label['rootVersion'] == root['version'], 'Description changed its mathematical parent')
        result.append(dict(id=root['id'], kind=kind, scope='real_polynomial', tags=[],
            description='Student-written ZIP description (unverified prose):\n' + label_text(label),
            root=copy.deepcopy(root), sourceLabelVersion=label['id'],
            parentVersion=root['version'], parentClaimHash=digest(root['rule'])))
    if language_protocol in NOTE_LANGUAGES:
        result[0]['description'] = 'Try a complete rewrite without a stored algebraic rewrite.'
        for candidate in result[1:]:
            candidate['description'] = 'Student-written algebraic rewrite note (unverified prose):\n' + label_text(labels[candidate['id']])
    else:
        require(language_protocol == LEGACY_LANGUAGE, 'Unknown language protocol')
    return result


def needs_note_bootstrap(labels, language_protocol=COMPACT_LANGUAGE):
    return len(labels) != 2 or any(label.get('languageProtocol') != language_protocol or
        not framing_check(label_text(label), label.get('tokenCapReached', False), language_protocol)['complete']
        for label in labels.values())


def empty_label(root, language_protocol=NATURAL_LANGUAGE):
    """No host-authored semantic description when the student has none yet."""
    require(language_protocol == NATURAL_LANGUAGE, 'Empty-label fallback is a v3 convention')
    return dict(id='empty-label-' + digest(dict(root=root['id'], protocol=language_protocol))[:20],
        rootId=root['id'], rootVersion=root['version'], rootClaimHash=digest(root['rule']),
        sourceRecordId=None, parentDescriptionId=None, studentRaw='', studentRawHash=digest(''),
        tokenCapReached=False, activatedAsRetrievalMetadata=False, activeDescriptionRaw='',
        wholeNaturalLanguageCertified=False, mathematicalRootChanged=False,
        status='empty_retrieval_metadata', hostSemanticDescriptionSupplied=False,
        mathematicalAssertionsAudit=draft_statements(''), languageProtocol=language_protocol,
        noteFramingCheck=framing_check('', False, language_protocol), sourceTaskId=None, sourcePhase=None)


def bootstrap_notes(roots, previous, ask, save, round_number, language_protocol=NATURAL_LANGUAGE):
    """Retain rejected originals and keep learning with prior or empty notes.

    Bootstrap changes no weights and supplies no replacement student text.
    The resolved bank is shared by learned and frozen pre-round arms.
    """
    require(language_protocol == NATURAL_LANGUAGE, 'Tolerant bootstrap is a v3 convention')
    labels = {root['id']: copy.deepcopy(previous.get(root['id']) or empty_label(root)) for root in roots}
    for index, root in enumerate(roots, 1):
        old = labels[root['id']]
        row = ask('initial_zip_label', initial_label_messages(root, language_protocol),
            seed_for(round_number, 0, index), mode='semantic', sampled=False,
            rootId=root['id'], previousLabelVersion=(previous.get(root['id']) or {}).get('id'))
        version = version_label(root, row, old, language_protocol)
        save('scored', dict(row, check=version)); save('label-version', version)
        if version['activatedAsRetrievalMetadata']:
            labels[root['id']] = version
    return labels


def complete_generation_count(bootstrap_descriptions):
    require(bootstrap_descriptions in (0, 2), 'A complete run bootstraps zero or two descriptions')
    return 8 + bootstrap_descriptions + 8 * 6 + 4 * 5


def expected_pass(head, vectors, outcomes):
    require(len(outcomes) == 3 and all(type(x) is int and x in (0, 1) for x in outcomes),
            'Expected reward needs all three real route results')
    _, probs = head.probabilities(vectors)
    return sum(p*y for p,y in zip(probs, outcomes)), probs


def saved_choice(task, arm, vectors, candidates, head, seed, index, keyword_id, feature_id):
    policy = head.choose(vectors, seed)
    selected = candidates[policy['selectedIndex']]
    return dict(id=task['id']+'-'+arm+'-'+str(index), task=copy.deepcopy(task), arm=arm,
        seedIndex=index, policyOutput=policy, selectedCandidate=copy.deepcopy(selected),
        candidateOrder=[c['id'] for c in candidates], sourceKeywordRecordId=keyword_id,
        sourceFeatureRecordId=feature_id, savedBeforeAnyRouteOutcome=True)


def run_course(plan, roots, initial_head, initial_labels, ask, features, save,
               learn_words, select_writer, checkpoint, deadline, round_number,
               baseline_pass=.5, language_protocol=LEGACY_LANGUAGE):
    require(len(plan['training']) == 8 and len(plan['heldout']) == 4, 'Iteration split differs')
    require(math.isfinite(baseline_pass) and 0 <= baseline_pass <= 1, 'Invalid reward baseline')
    head = restore_head(copy.deepcopy(initial_head))
    control = restore_head(copy.deepcopy(initial_head))
    labels = copy.deepcopy(initial_labels)
    control_labels = copy.deepcopy(initial_labels)
    root_before = copy.deepcopy(roots)
    objects = []; updates = []; revisions = []; training_replay = []
    checkpoint('initial', head.state(), labels, baseline_pass)
    for number, task in enumerate(plan['training'], 1):
        if time.monotonic() >= deadline:
            raise TimeoutError('Iteration stage budget reached')
        select_writer('learning')
        old_labels = copy.deepcopy(labels)
        keywords = ask('training_observations', observations_messages(task, roots, old_labels, language_protocol),
            seed_for(round_number, number, 1), mode='semantic', sampled=True, task=task)
        save('scored', dict(keywords, check=dict(studentAuthoredFeatures=True,
            wholeOriginalUsed=True, naturalLanguageTruthCertified=False)))
        old_cards = cards(roots, old_labels, language_protocol)
        before_vectors, before_feature_id = features(task, keywords, old_cards)
        decision = saved_choice(task, ARMS[0], before_vectors, old_cards, head,
            seed_for(round_number, number, 10), 1, keywords['recordId'], before_feature_id)
        save('decision', decision)
        routes = []
        for candidate in old_cards:
            row = ask('training_route_math', math_messages(task, candidate, roots),
                seed_for(round_number, number, 20), mode='math', sampled=False,
                task=task, selectedCandidate=copy.deepcopy(candidate), hostSpecifiedRoute=True,
                arm='host_method_audit', autonomousToolUseClaimed=False,
                sourceKeywordRecordId=keywords['recordId'])
            row = dict(row, check=audit_math(task, row['studentOutput'], candidate))
            save('scored', row); routes.append(row)
            instance = exact_instance(row)
            if instance:
                save('instance', instance)
            if not row['check']['outcomePassed']:
                save('failure', dict(row, id=row['recordId']))
        outcomes = [int(r['check']['outcomePassed']) for r in routes]
        proposed = copy.deepcopy(old_labels); word_rows = [keywords]
        # Two revisions are based on two real, separately retained method audits.
        # Neither is described as an autonomous choice by the student.
        for index, root in enumerate(roots, 1):
            route = next(r for r in routes if r['selectedCandidate']['id'] == root['id'])
            row = ask('training_zip_label_revision', revision_messages(
                task, root, old_labels[root['id']], keywords, route, language_protocol),
                seed_for(round_number, number, 30+index), mode='semantic', sampled=True,
                task=task, rootId=root['id'], parentRootVersion=root['version'],
                sourceMathRecordId=route['recordId'],
                previousLabelVersion=old_labels[root['id']]['id'])
            version = version_label(root, row, old_labels[root['id']], language_protocol)
            save('scored', dict(row, check=version)); save('label-version', version)
            revisions.append(version); word_rows.append(row)
            if version['activatedAsRetrievalMetadata']:
                proposed[root['id']] = version
        next_cards = cards(roots, proposed, language_protocol)
        after_vectors, after_feature_id = features(task, keywords, next_cards)
        old_expected, _ = expected_pass(head, before_vectors, outcomes)
        new_expected, new_probabilities = expected_pass(head, after_vectors, outcomes)
        # Observation return is measured with prior cards. Activated revisions
        # share only the card delta, measured on the SAME observation and head.
        # Explicitly disproved written equalities receive separate negative
        # credit; incomplete inactive notes receive no outcome credit.
        credit = semantic_credits(word_rows, revisions[-2:], old_expected, new_expected, baseline_pass)
        word_update = learn_words(word_rows, credit, baseline_pass, number)
        next_baseline = .9 * baseline_pass + .1 * old_expected
        training_replay.append(replay_item(task, after_vectors, outcomes, after_feature_id,
                                          [r['recordId'] for r in routes]))
        head_update = guarded_head_update(head, training_replay, number)
        update = dict(id='label-update-'+str(number).zfill(2), taskId=task['id'],
            semanticUpdate=word_update, headUpdate=head_update,
            semanticCreditAssignment=credit, trainingReplaySize=len(training_replay),
            wordRecordIds=[r['recordId'] for r in word_rows],
            mathematicalRecordIds=[r['recordId'] for r in routes],
            featureBeforeId=before_feature_id, featureAfterId=after_feature_id,
            baselinePassBefore=baseline_pass, baselinePassAfter=next_baseline,
            expectedPassWithPreviousLabels=old_expected,
            expectedPassWithRevisedLabels=new_expected,
            labelOnlyExpectedDifferenceBeforeWeightUpdates=new_expected-old_expected,
            labelParentsBefore={k:v['id'] for k,v in old_labels.items()},
            labelParentsAfter={k:v['id'] for k,v in proposed.items()},
            correctToolLabelSupplied=False, humanFeatureTargetsSupplied=False,
            naturalLanguageTruthCertified=False, feedbackFromAllRealRoutes=True)
        save('update', update); updates.append(update)
        labels = proposed; baseline_pass = next_baseline
        checkpoint('after-'+str(number).zfill(2), head.state(), labels, baseline_pass)
        selected = next(r for r in routes if r['selectedCandidate']['id'] == decision['selectedCandidate']['id'])
        trial = dict(id=decision['id'], phase='training', arm=ARMS[0], decisionId=decision['id'],
            sourceMathRecordId=selected['recordId'], outcomePassed=selected['check']['outcomePassed'],
            legacyOutcomePassed=selected['check']['legacyOutcomePassed'],
            diagnostic=diagnostic(task, selected['studentOutput'], selected['selectedCandidate'], selected['check']),
            noExtraGenerationForPolicySample=True)
        save('trial', trial)
        obj = dict(id=task['id'], task=task, phase='training', routeOutcomes=outcomes,
            legacyRouteOutcomes=[int(r['check']['legacyOutcomePassed']) for r in routes],
            mathematicalScoringProtocol=SCORING_PROTOCOL,
            sourceMathRecordIds=[r['recordId'] for r in routes],
            expectedPassBeforeOwnFeedback=old_expected,
            expectedPassAfterDescriptionRevisionBeforeWeightsUpdate=new_expected,
            updatedLabelIds=[v['id'] for v in revisions[-2:]],
            activatedRevisionIds=[v['id'] for v in revisions[-2:] if v['activatedAsRetrievalMetadata']],
            observationLabelIdsUsed={k:v['id'] for k,v in old_labels.items()},
            selectionLabelIdsUsed={c['id']:c['sourceLabelVersion'] for c in old_cards[1:]},
            preFeedbackProbabilities=new_probabilities)
        save('object', obj); objects.append(obj)
        require(control.state() == initial_head and control_labels == initial_labels and roots == root_before,
                'Frozen control or mathematical roots changed')
    checkpoint('training-final', head.state(), labels, baseline_pass)
    final_head = copy.deepcopy(head.state())
    final_labels = copy.deepcopy(labels)
    for number, task in enumerate(plan['heldout'], 9):
        rows = {}; vectors_by_arm = {}; candidates_by_arm = {}; decisions = []
        for arm, writer_mode, use_labels in ((ARMS[0], 'learning', final_labels),
                                             (ARMS[1], 'before', control_labels)):
            select_writer(writer_mode)
            row = ask('heldout_observations', observations_messages(task, roots, use_labels, language_protocol),
                seed_for(round_number, number, 1), mode='semantic', sampled=False,
                task=task, arm=arm)
            save('scored', dict(row, check=dict(heldoutFeedbackUpdate=False,
                studentAuthoredFeatures=True, wholeOriginalUsed=True, naturalLanguageTruthCertified=False)))
            rows[arm] = row
            cand = cards(roots, use_labels, language_protocol)
            vec, feature_id = features(task, row, cand)
            candidates_by_arm[arm] = cand; vectors_by_arm[arm] = (vec, feature_id)
        # Component ablation: reuse the learned arm's same saved observation
        # text and head, changing only retrieval description cards. This does
        # not isolate earlier effects of ZIP notes on observation generation.
        arm = ARMS[2]; rows[arm] = rows[ARMS[0]]
        cand = cards(roots, control_labels, language_protocol)
        vec, feature_id = features(task, rows[arm], cand)
        candidates_by_arm[arm] = cand; vectors_by_arm[arm] = (vec, feature_id)
        for index in range(1, 4):
            seed = seed_for(round_number, number, 50+index)
            for arm in ARMS:
                vec, fid = vectors_by_arm[arm]
                h = control if arm == ARMS[1] else head
                d = saved_choice(task, arm, vec, candidates_by_arm[arm], h,
                    seed, index, rows[arm]['recordId'], fid)
                save('decision', d); decisions.append(d)
        select_writer('learning')
        # The writer does not see learned descriptions or observations here.
        # All arms share exactly these three host-scheduled route originals.
        routes = []
        for candidate in candidates_by_arm[ARMS[0]]:
            row = ask('heldout_route_math', math_messages(task, candidate, roots),
                seed_for(round_number, number, 20), mode='math', sampled=False,
                task=task, selectedCandidate=copy.deepcopy(candidate), hostSpecifiedRoute=True,
                arm='host_method_audit', autonomousToolUseClaimed=False)
            row = dict(row, check=audit_math(task, row['studentOutput'], candidate))
            save('scored', row); routes.append(row)
            instance = exact_instance(row)
            if instance:
                save('instance', instance)
            if not row['check']['outcomePassed']:
                save('failure', dict(row, id=row['recordId']))
        outcomes = [int(r['check']['outcomePassed']) for r in routes]
        expectations = {}; probabilities = {}
        for arm in ARMS:
            h = control if arm == ARMS[1] else head
            expectations[arm], probabilities[arm] = expected_pass(h, vectors_by_arm[arm][0], outcomes)
        for d in decisions:
            selected = next(r for r in routes if r['selectedCandidate']['id'] == d['selectedCandidate']['id'])
            save('trial', dict(id=d['id'], phase='heldout', arm=d['arm'], seedIndex=d['seedIndex'],
                taskId=task['id'], decisionId=d['id'], sourceMathRecordId=selected['recordId'],
                outcomePassed=selected['check']['outcomePassed'],
            legacyOutcomePassed=selected['check']['legacyOutcomePassed'],
                diagnostic=diagnostic(task, selected['studentOutput'], selected['selectedCandidate'], selected['check']),
                noExtraGenerationForPolicySample=True))
        obj = dict(id=task['id'], task=task, phase='heldout', routeOutcomes=outcomes,
            legacyRouteOutcomes=[int(r['check']['legacyOutcomePassed']) for r in routes],
            mathematicalScoringProtocol=SCORING_PROTOCOL,
            sourceMathRecordIds=[r['recordId'] for r in routes],
            expectedPassByArm=expectations, probabilitiesByArm=probabilities,
            observationTextHashByArm={a:digest(rows[a]['studentOutput']['raw']) for a in ARMS},
            expectedDifference=expectations[ARMS[0]]-expectations[ARMS[1]],
            metadataCardOnlyAblationDifference=expectations[ARMS[0]]-expectations[ARMS[2]],
            observationLabelIdsUsedByArm={a:{k:v['id'] for k,v in bank.items()} for a,bank in
                ((ARMS[0],final_labels),(ARMS[1],control_labels),(ARMS[2],final_labels))},
            selectionLabelIdsUsedByArm={a:{c['id']:c['sourceLabelVersion'] for c in cand[1:]}
                for a,cand in candidates_by_arm.items()},
            allChoicesSavedBeforeRouteAudit=True, trainingUpdates=0,
            semanticWeightHashHeldConstantPerArm=True, seedTrialsNotIndependentObjects=True)
        save('object', obj); objects.append(obj)
        require(head.state() == final_head and labels == final_labels and
                control.state() == initial_head and control_labels == initial_labels and roots == root_before,
                'Heldout weights, labels or roots changed')
    select_writer('learning')
    checkpoint('final', head.state(), labels, baseline_pass)
    return dict(objects=objects, updates=updates, labelRevisions=revisions,
                finalHead=head.state(), finalLabels=labels, baselinePass=baseline_pass)


def original_summary(objects, trials=()):
    held = [o for o in objects if o['phase'] == 'heldout']
    train = [o for o in objects if o['phase'] == 'training']
    activated = {identifier for o in train for identifier in o.get('activatedRevisionIds', [])}
    reused_observations = set(); reused_selection = set()
    for obj in objects:
        observation_ids = (obj.get('observationLabelIdsUsed', {}).values() if obj['phase'] == 'training'
            else obj.get('observationLabelIdsUsedByArm', {}).get(ARMS[0], {}).values())
        selection_ids = (obj.get('selectionLabelIdsUsed', {}).values() if obj['phase'] == 'training'
            else obj.get('selectionLabelIdsUsedByArm', {}).get(ARMS[0], {}).values())
        reused_observations.update(activated.intersection(observation_ids))
        reused_selection.update(activated.intersection(selection_ids))
    def aggregate(rows):
        if not rows:
            return dict(objects=0, expectedPassByArm=None, meanExpectedDifference=None)
        return dict(objects=len(rows), expectedPassByArm={a:sum(r['expectedPassByArm'][a]
            for r in rows)/len(rows) for a in ARMS},
            meanExpectedDifference=sum(r['expectedDifference'] for r in rows)/len(rows),
            metadataCardOnlyAblationDifference=sum(r['metadataCardOnlyAblationDifference'] for r in rows)/len(rows))
    sampled={arm:dict(trials=len([r for r in trials if r['phase']=='heldout' and r['arm']==arm]),
        passes=sum(bool(r['outcomePassed']) for r in trials if r['phase']=='heldout' and r['arm']==arm),
        perSeed={str(seed):dict(trials=len([r for r in trials if r['phase']=='heldout' and
            r['arm']==arm and r['seedIndex']==seed]),
            passes=sum(bool(r['outcomePassed']) for r in trials if r['phase']=='heldout' and
                r['arm']==arm and r['seedIndex']==seed)) for seed in (1,2,3)}) for arm in ARMS}
    return dict(primaryMetric='heldout probability mass on all actually verified successful method routes',
        primaryComparison='learned observations, learned description cards and learned selector versus pre-round frozen copy',
        heldout=aggregate(held), heldoutByFamily={f:aggregate([r for r in held if r['task']['family']==f])
            for f in ('same_factor','product_of_sum')}, trainingObjects=len(train),
        trainingLabelOnlyExpectedDifferences=[r['expectedPassAfterDescriptionRevisionBeforeWeightsUpdate']-
            r['expectedPassBeforeOwnFeedback'] for r in train],
        uniqueNewObjects=len(objects), heldoutUniqueObjects=len(held),
        sampledHeldoutOutcomesByArm=sampled,
        seedSamplesNotIndependentObjects=True, sourceTrainedHeadCount=1,
        independentTrainingReplications=0, mathematicalRootsChanged=False,
        newStandaloneMathematicalRules=0, naturalLanguageDescriptionsCertified=False,
        observationsAndZipLabelWritingReceiveTrainingFeedback=bool(train),
        activatedLabelRevisions=len(activated),
        revisionsUsedInLaterObservationPrompts=len(reused_observations),
        revisionsUsedInLaterSelectionPrompts=len(reused_selection),
        descriptionsReturnToLaterObservationAndSelectionPrompts=bool(reused_observations & reused_selection),
        probabilityMetricDoesNotDependOnLuckySampledChoice=True,
        metadataAblationKeepsLearnedObservationTextAndSelector=True,
        observationGenerationEffectNotIsolatedByMetadataCardAblation=True,
        fullAutonomousLearningProved=False, energyEfficiencyProved=False,
        statisticalSignificanceClaimed=False, structuralGeneralizationProved=False)


def summarize(objects, trials=()):
    data=original_summary(objects,trials)
    heldout=[o for o in objects if o['phase']=='heldout']
    data.update(
        heldoutObservationDistinctTextsByArm={a:len({o['observationTextHashByArm'][a] for o in heldout}) for a in ARMS},
        heldoutTopCandidateKindsByArm={a:{kind:sum(
            max(range(3),key=lambda i:o['probabilitiesByArm'][a][i])==index for o in heldout)
            for index,kind in enumerate(('direct','combine','distribute'))} for a in ARMS},
        heldoutTopRoutePassesByArm={a:sum(o['routeOutcomes'][
            max(range(3),key=lambda i:o['probabilitiesByArm'][a][i])] for o in heldout) for a in ARMS},
        diagnosticGreedyChoicesUseSharedSavedRoutes=True,
        heldoutGuardGuaranteeClaimed=False,
        currentObjectLastPromptUsedInAllArms=True,
        absoluteMetricNotComparableToPreviousPromptProtocol=True)
    legacy_objects=[]
    for obj in objects:
        if obj['phase']!='heldout':continue
        row=copy.deepcopy(obj); outcomes=row['legacyRouteOutcomes']
        row['routeOutcomes']=outcomes
        row['expectedPassByArm']={a:sum(p*y for p,y in zip(row['probabilitiesByArm'][a],outcomes)) for a in ARMS}
        row['expectedDifference']=row['expectedPassByArm'][ARMS[0]]-row['expectedPassByArm'][ARMS[1]]
        row['metadataCardOnlyAblationDifference']=row['expectedPassByArm'][ARMS[0]]-row['expectedPassByArm'][ARMS[2]]
        legacy_objects.append(row)
    legacy_trials=[dict(t,outcomePassed=t['legacyOutcomePassed']) for t in trials if t['phase']=='heldout']
    legacy=original_summary(legacy_objects,legacy_trials)
    data.update(mathematicalScoringProtocol=SCORING_PROTOCOL,
        feedbackFactsSeparated=True,oldArchiveScoresChanged=False,
        comparisonsUseSameNewProtocolWithinRound=True,
        legacyStrictScoringOnSameNewOutputs={k:legacy[k] for k in
            ('heldout','heldoutByFamily','sampledHeldoutOutcomesByArm')},
        oldSourceMetricNotAPrePostTrainingComparison=True)
    return data
