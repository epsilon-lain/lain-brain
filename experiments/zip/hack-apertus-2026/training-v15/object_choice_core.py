"""Learn a small choice policy from outcomes, without supplying math targets.

The frozen language model supplies candidate-conditioned object representations.
Only this new scalar linear head is trained. Its analytic categorical-policy
gradient is implemented with ordinary Python; this is not a change to the writer.
"""
import copy
import math
import random
import re
import time

from zip_content_core import digest, verify_claim
from tool_loop_kernel import object_key, single_equality, support_step
from scale_course import messages as familiar_messages

PROTOCOL = 'lain-zip-object-choice-training-v1'
TOKENS = 96
GENERATION_CAP = 48
FEATURE_BATCH_CAP = 10
UPDATE_CAP = 8
ARMS = ('learning_choice', 'frozen_initial_choice')
SEED = 2026100911
LEARNING_RATE = 0.5


def tasks_for(excluded, roots):
    """Inputs only. No expected answers or applicable-tool labels enter the policy."""
    seen = set(excluded) | {object_key(r['rule']['input']) for r in roots}
    pools = {
        'same_factor': [f'1 * ({n} * v) + 2 * ({n} * v)' for n in range(1, 257)],
        'product_of_sum': [f'3 * ({n} * v + {m})' for m in range(1, 257) for n in (4, 5, 6, 7)]}
    selected = {}
    for family, pool in pools.items():
        rows = []
        for expression in pool:
            key = object_key(expression)
            if key in seen:
                continue
            seen.add(key)
            rows.append(dict(id='choice-object-' + digest(expression)[:16], expression=expression,
                question='Rewrite ' + expression + '.', scope='real_polynomial',
                semanticInputKey=key, family=family))
            if len(rows) == 5:
                break
        if len(rows) != 5:
            raise ValueError('Insufficient archived-object-disjoint inputs in the declared pool')
        selected[family] = rows
    training = [dict(selected[f][i], split='training')
        for i in range(4) for f in pools]
    heldout = [dict(selected[f][4], split='heldout') for f in pools]
    return dict(training=training, heldout=heldout, trainingObjects=8, heldoutObjects=2,
        freshnessLimitedToListedArchives=True, structuralGeneralizationProved=False)


def candidates_for(roots):
    if len(roots) != 2:
        raise ValueError('Exactly the two existing certified roots are required')
    result = [dict(id='DIRECT', scope='real_polynomial', kind='direct',
        description='Try a complete rewrite using your own existing mathematical ability; no stored rule is provided.',
        tags=['direct', 'polynomial'])]
    for root, kind, description, tags in zip(roots, ('combine', 'distribute'),
        ('Collect two terms with the same complete factor; keep the fixed numeric coefficients in the stored rule.',
         'Distribute a multiplier over an addition; keep all literal numbers in the stored rule fixed.'),
        (['combine', 'collect', 'like', 'terms', 'matching', 'factor', 'coefficient'],
         ['distribute', 'distribution', 'multiply', 'brackets', 'sum', 'product'])):
        if not verify_claim(root['rule'])['reusable']:
            raise ValueError('An existing root is not reusable')
        result.append(dict(id=root['id'], scope='real_polynomial', kind=kind,
            description=description, tags=tags, root=copy.deepcopy(root),
            parentVersion=root['version'], parentClaimHash=digest(root['rule'])))
    if len({c['id'] for c in result}) != 3:
        raise ValueError('Candidate identifiers are not distinct')
    return result


def keyword_messages(task):
    return [dict(role='system', content='Describe a few features or keywords of the mathematical object that could help you recall a useful method. A short natural phrase is enough. Do not solve it.'),
        dict(role='user', content=task['expression'] + '\nScope: real_polynomial.')]


def rank_candidates(candidates, keyword_output):
    """Whole student text ranks metadata; zero overlaps are explicitly not hits.

    This small pilot offers all two scoped roots plus DIRECT even after an empty
    keyword lookup. The host neither hides a root using a task-family label nor
    chooses an applicable tool. A head still has to choose between the options.
    """
    words = set(re.findall(r'[A-Za-z]+|[\u4e00-\u9fff]+', keyword_output['raw'].lower()))
    rows = []
    for candidate in candidates:
        if candidate['scope'] != 'real_polynomial':
            raise ValueError('A candidate is outside the only allowed scope')
        matched = sorted(words & set(candidate['tags']))
        rows.append(dict(candidate=copy.deepcopy(candidate), matchedKeywords=matched,
            keywordScore=len(matched), keywordHit=bool(matched), applicabilityAssumed=False))
    rows.sort(key=lambda row: (-row['keywordScore'], row['candidate']['id']))
    return rows


def feature_messages(task, keyword_output, candidate):
    # No family, training split, certificate replay, answer or correctness label.
    description = candidate['description']
    if candidate['kind'] != 'direct':
        rule = candidate['root']['rule']
        description += '\nStored rule: ' + rule['input'] + ' = ' + rule['output']
    return [dict(role='system', content='Consider whether this method can help rewrite the current object. Its applicability must be checked, not assumed from keywords.'),
        dict(role='user', content='Current object: ' + task['expression'] +
            '\nStudent-written keywords (complete text):\n' + keyword_output['raw'] +
            '\nCandidate method:\n' + description)]


def normalized_features(vectors):
    if len(vectors) != 3 or not vectors[0] or any(len(v) != len(vectors[0]) for v in vectors):
        raise ValueError('Exactly three equal-size candidate representations are required')
    if any(not math.isfinite(x) for v in vectors for x in v):
        raise ValueError('Nonfinite frozen representation')
    average = [sum(v[i] for v in vectors) / 3. for i in range(len(vectors[0]))]
    centered = [[x - average[i] for i, x in enumerate(v)] for v in vectors]
    norms = [math.sqrt(sum(x*x for x in v)) for v in centered]
    if max(norms) < 1e-10:
        raise ValueError('Candidate representations are indistinguishable; do not claim learning')
    return [[x / max(n, 1e-10) for x in v] for v, n in zip(centered, norms)]


class ChoiceHead:
    def __init__(self, weights):
        self.weights = [float(x) for x in weights]
        if not self.weights or any(not math.isfinite(x) for x in self.weights):
            raise ValueError('Invalid choice-head parameters')
        self.updates = 0

    @classmethod
    def initial(cls, size):
        # Both arms start with the exact uniform policy. Sampling avoids a fixed
        # tie-breaking preference for DIRECT or for the first listed tool.
        return cls([0.] * size)

    def state(self):
        return dict(weights=list(self.weights), updates=self.updates,
            parameterHash=digest(self.weights), kind='shared_scalar_linear_choice_head')

    def probabilities(self, features):
        if any(len(v) != len(self.weights) for v in features):
            raise ValueError('Choice head and frozen features differ in size')
        logits = [sum(w*x for w, x in zip(self.weights, v)) for v in features]
        values = [math.exp(x - max(logits)) for x in logits]
        total = sum(values)
        return logits, [x / total for x in values]

    def choose(self, features, seed):
        logits, probabilities = self.probabilities(features)
        uniform = random.Random(seed).random()
        cumulative = 0.; selected = len(probabilities) - 1
        for index, probability in enumerate(probabilities):
            cumulative += probability
            if uniform < cumulative:
                selected = index; break
        return dict(selectedIndex=selected, logits=logits, probabilities=probabilities,
            sharedUniformSample=uniform, choiceSeed=seed, parameterHash=digest(self.weights))

    def update(self, features, choice, reward):
        if reward not in (-1., 1.) or self.updates >= UPDATE_CAP:
            raise ValueError('Invalid feedback or choice-head update budget reached')
        logits, probabilities = self.probabilities(features)
        if (choice['parameterHash'] != digest(self.weights) or logits != choice['logits']
                or probabilities != choice['probabilities']):
            raise ValueError('An old or mismatched policy sample cannot be used for learning')
        index = choice['selectedIndex']
        expected = [sum(p*v[i] for p, v in zip(probabilities, features))
            for i in range(len(self.weights))]
        # Analytic REINFORCE ascent: r * grad log p(action | object, keywords).
        gradient = [reward * (x - mean) for x, mean in zip(features[index], expected)]
        norm = math.sqrt(sum(x*x for x in gradient)); scale = min(1., 1. / max(norm, 1e-12))
        before = self.state()
        self.weights = [w + LEARNING_RATE * scale * g for w, g in zip(self.weights, gradient)]
        changed = self.weights != before['weights']
        if changed:
            self.updates += 1
        after = self.state(); _, after_probabilities = self.probabilities(features)
        return dict(updated=changed, updateNumber=self.updates, reward=reward,
            algorithm='analytic categorical REINFORCE; SGD ascent; gradient norm capped at 1',
            learningRate=LEARNING_RATE, gradientNormBeforeClip=norm,
            beforeHash=before['parameterHash'], afterHash=after['parameterHash'],
            selectedProbabilityBefore=probabilities[index], selectedProbabilityAfter=after_probabilities[index],
            onlyNewChoiceHeadUpdated=True, mathTargetTokensProvided=False)


def math_messages(task, candidate, roots):
    if candidate['kind'] == 'direct':
        return [dict(role='system', content='Rewrite the whole expression once. Write exactly one complete equality: the given expression = your rewritten expression. Use * and **. No prose, chains, JSON or labels. Write SKIP if unsure.'),
            dict(role='user', content=task['question'] + '\nAll named variables are independent real numbers.')]
    chosen_task = dict(task, kind=candidate['kind'])
    return familiar_messages(chosen_task, roots, condition='zip')


def audit_math(task, output, candidate):
    parsed = single_equality(task['expression'], output)
    truth = bool(parsed.get('parsed') and parsed.get('sourceMatchesTask') and
        not parsed.get('outsideTaskVariables') and not output.get('tokenCapReached') and
        parsed.get('exactAudit', {}).get('accepted'))
    replay = None
    if candidate['kind'] != 'direct':
        replay = support_step(task['expression'], output, candidate['root'], candidate['kind'])
    passed = parsed['status'] == 'verified' and (replay is None or replay.get('toolSupported') is True)
    return dict(completeEqualityCheck=parsed, mathematicallyCorrectWrittenEquality=truth,
        changedCurrentMathematics=parsed['status'] == 'verified', selectedToolReplay=replay,
        outcomePassed=bool(passed), reward=1. if passed else -1.,
        rewardForMerelySelectingZip=0., hostFilledMathematics=False)


def memory_messages(task, keyword_row, math_row):
    check = math_row['check']
    feedback = dict(passed=check['outcomePassed'],
        reason=check['completeEqualityCheck']['reason'],
        selectedToolSupported=(check['selectedToolReplay'] or {}).get('toolSupported'))
    return [dict(role='system', content='Write a short memory note in your own words: useful object features, method tried, and what to remember or question next time. A failed attempt may stay unresolved. No corrected answer is supplied.'),
        dict(role='user', content='Object: ' + task['expression'] + '\nYour keywords:\n' +
            keyword_row['studentOutput']['raw'] + '\nYour attempted equality:\n' +
            math_row['studentOutput']['raw'] + '\nAudit feedback: ' + str(feedback))]


def exact_instance(row):
    check = row['check']; parsed = check['completeEqualityCheck']
    if not check['mathematicallyCorrectWrittenEquality'] or not check['changedCurrentMathematics']:
        return None
    replay = check['selectedToolReplay']
    parent = (dict(id=replay['toolId'], version=replay['toolVersion'],
        claimHash=replay['sourceClaimHash'], replay=replay['replay'],
        rootCertificate=replay['rootCertificate']) if replay and replay.get('toolSupported') else None)
    return dict(id='choice-instance-' + digest(row['recordId'])[:16], task=copy.deepcopy(row['task']),
        sourceRecordId=row['recordId'], arm=row['arm'], studentRaw=row['studentOutput']['raw'],
        studentRawHash=digest(row['studentOutput']['raw']), claim=copy.deepcopy(parsed['claim']),
        exactCertificate=copy.deepcopy(parsed['exactAudit']), existingParentSupport=parent,
        classification='existing_rule_application' if parent else 'unlinked_true_local_instance',
        standaloneNewRule=False, oldBankAdmission=False)


def run_course(plan, roots, ask, features_for, save, after_raw_frozen, checkpoint, deadline):
    candidates = candidates_for(roots); heads = None; frozen_hash = None
    pairs = []; updates = []; stop = 'completed'
    for number, task in enumerate(plan['training'] + plan['heldout'], 1):
        if time.monotonic() >= deadline:
            stop = 'new_stage_time_budget'; break
        seed = SEED + number
        keywords = ask('object_keywords', keyword_messages(task), seed, writer_enabled=False, task=task)
        save('raw', keywords); after_raw_frozen()
        lookup = rank_candidates(candidates, keywords['studentOutput'])
        save('scored', dict(keywords, check=dict(wholeStudentTextUsed=True,
            strictKeywordCommandNotRequired=True, tokenCapReached=bool(keywords['studentOutput'].get('tokenCapReached')),
            hits=[dict(id=r['candidate']['id'], matchedKeywords=r['matchedKeywords']) for r in lookup if r['keywordHit']],
            scopeOnlyCandidatesAlsoOffered=True, lookupDoesNotCertifyApplicability=True)))
        ordered = [r['candidate'] for r in lookup]
        features = features_for(task, keywords, ordered)
        if heads is None:
            heads = {arm:ChoiceHead.initial(len(features[0])) for arm in ARMS}
            frozen_hash = heads[ARMS[1]].state()['parameterHash']
            checkpoint('initial', {arm:h.state() for arm, h in heads.items()})
        pair = dict(task=copy.deepcopy(task), keywordRecordId=keywords['recordId'], rows={})
        arm_order = ARMS if number % 2 else tuple(reversed(ARMS))
        for arm in arm_order:
            choice = heads[arm].choose(features, seed + 1000)
            candidate = ordered[choice['selectedIndex']]
            decision = dict(id=task['id'] + '-' + arm, arm=arm, task=copy.deepcopy(task),
                keywordRecordId=keywords['recordId'], candidateOrder=[c['id'] for c in ordered],
                selectedCandidate=copy.deepcopy(candidate), policyOutput=choice,
                modelSelectedChoice=True, candidateListAndCallOrderArrangedByHost=True)
            save('decision', decision)  # Policy output durable before any math call or audit.
            row = ask('choice_math', math_messages(task, candidate, roots), seed + 2000,
                writer_enabled=True, task=task, arm=arm, selectedCandidate=candidate,
                choiceRecordId=decision['id'], keywordRecordId=keywords['recordId'])
            save('raw', row); after_raw_frozen()
            checked = dict(row, check=audit_math(task, row['studentOutput'], candidate))
            save('scored', checked); pair['rows'][arm] = checked
            instance = exact_instance(checked)
            if instance:
                save('instance', instance)
        # Both arms have actual outputs before feedback is applied to learning arm.
        if task['split'] == 'training':
            own = pair['rows'][ARMS[0]]
            if time.monotonic() >= deadline:
                stop = 'new_stage_time_budget_pair_saved_without_update'
            else:
                choice = heads[ARMS[0]].choose(features, seed + 1000)
                update_started = time.monotonic()
                update = heads[ARMS[0]].update(features, choice, own['check']['reward'])
                update.update(id=task['id'], taskId=task['id'], sourceMathRecordId=own['recordId'],
                    sourceKeywordRecordId=keywords['recordId'], feedbackFromActualMathOnly=True,
                    updateSeconds=time.monotonic()-update_started)
                save('update', update); updates.append(update)
                checkpoint('after-' + str(len(updates)).zfill(2), {arm:h.state() for arm, h in heads.items()})
        if heads[ARMS[1]].state()['parameterHash'] != frozen_hash:
            raise RuntimeError('Frozen initial choice head changed')
        # Every learning-arm attempt is remembered, including unsuccessful ones.
        if time.monotonic() < deadline:
            note = ask('attempt_memory', memory_messages(task, keywords, pair['rows'][ARMS[0]]),
                seed + 3000, writer_enabled=False, task=task,
                sourceMathRecordId=pair['rows'][ARMS[0]]['recordId'])
            save('raw', note); after_raw_frozen()
            save('scored', dict(note, check=dict(status='pending_prose_review',
                originalTextPreserved=True, naturalLanguageTruthCertified=False,
                automaticBankPromotion=False)))
        pairs.append(pair); save('pair', dict(id=task['id'], **pair))
        print(('训练' if task['split'] == 'training' else '保留题') + ' ' + str(number) + '/10：' +
            '; '.join(arm + '→' + pair['rows'][arm]['selectedCandidate']['kind'] +
                '，核验=' + str(pair['rows'][arm]['check']['outcomePassed']) for arm in ARMS) +
            '；选择层更新=' + str(heads[ARMS[0]].updates), flush=True)
        if stop != 'completed':
            break
    return dict(stopReason=stop, heads={arm:h.state() for arm,h in heads.items()} if heads else {},
        pairs=pairs, updates=updates, frozenInitialChoiceUnchanged=(heads is not None and
            heads[ARMS[1]].state()['parameterHash'] == frozen_hash))


def summarize(math_rows, updates):
    result = {}
    for split in ('training', 'heldout'):
        result[split] = {}
        for arm in ARMS:
            rows = [r for r in math_rows if r['arm'] == arm and r['task']['split'] == split]
            result[split][arm] = dict(attempted=len(rows),
                correctChangedEqualities=sum(r['check']['changedCurrentMathematics'] for r in rows),
                mathematicallyCorrectWrittenEqualities=sum(r['check']['mathematicallyCorrectWrittenEquality'] for r in rows),
                outcomePasses=sum(r['check']['outcomePassed'] for r in rows),
                directChoices=sum(r['selectedCandidate']['kind']=='direct' for r in rows),
                zipChoices=sum(r['selectedCandidate']['kind']!='direct' for r in rows),
                verifiedChosenZipUses=sum(bool((r['check']['selectedToolReplay'] or {}).get('toolSupported')) for r in rows))
    result.update(choiceHeadUpdates=sum(u['updated'] for u in updates),
        positiveFeedbackUpdates=sum(u['updated'] and u['reward'] > 0 for u in updates),
        negativeFeedbackUpdates=sum(u['updated'] and u['reward'] < 0 for u in updates),
        onlyChoiceHeadLearns=True, keywordWriterLearns=False, mathematicalWriterLearns=False,
        keywordAndCandidateInterfacesArrangedByHost=True, archiveDisjointObjectsNotProofOfUnseenPretraining=True,
        newNotesSavedButNotUsedAsCertifiedToolsDuringThisPilot=True,
        fullAutonomousLearningProved=False, newMathematicalPrinciples=0,
        energyEfficiencyProved=False, descriptiveSmallPilot=True)
    return result
