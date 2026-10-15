"""Frozen paired policy evaluation with new objects and explicit seed repeats."""
import copy
import time
from collections import Counter

from object_choice_core import (ChoiceHead, tasks_for, candidates_for, keyword_messages,
    rank_candidates, math_messages, audit_math, exact_instance)
from zip_content_core import digest
from zip_guided_helpers import application

PROTOCOL = 'lain-zip-choice-frozen-retest-v1'
ARMS = ('trained_frozen_choice', 'initial_frozen_choice')
CHOICE_SEEDS = (2026100917, 2026100918, 2026100919)
TOKENS = 96
GENERATION_CAP = 40
FEATURE_BATCH_CAP = 8


def seeds_for_round(round_number):
    if type(round_number) is not int or not 1 <= round_number <= 1000:
        raise ValueError('Retest round must be an integer in 1..1000')
    return tuple(seed + (round_number-1)*10000 for seed in CHOICE_SEEDS)


def retest_tasks(excluded, roots):
    plan = tasks_for(excluded, roots)
    return [dict(t, id='choice-retest-' + digest(t['expression'])[:16], split='retest')
        for t in plan['training']]


def restore_head(state):
    if state.get('parameterHash') != digest(state['weights']):
        raise ValueError('Saved choice-head parameters differ from their hash')
    head = ChoiceHead(state['weights']); head.updates = state['updates']
    if head.state() != state:
        raise ValueError('Saved choice-head structure differs')
    return head


def diagnostic(task, output, candidate, check):
    matched = None
    if candidate['kind'] != 'direct':
        matched = application(candidate['root'], task['expression']) is not None
    if check['outcomePassed']:
        category = 'verified_outcome'
    elif candidate['kind'] == 'direct':
        category = 'direct_math_failed'
    elif not matched:
        category = 'selected_root_does_not_match_whole_object'
    elif check['mathematicallyCorrectWrittenEquality']:
        category = 'true_math_without_selected_root_replay'
    else:
        category = 'matching_root_but_written_math_failed'
    return dict(category=category, rootMatchesWholeInput=matched,
        applicabilityInspectedOnlyAfterStudentRawSaved=True,
        programCorrectedAnswerOrBindingsSupplied=False,
        reason=check['completeEqualityCheck']['reason'])


def run_retest(tasks, roots, heads, ask, features_for, save, after_raw_frozen, deadline,
    choice_seeds=CHOICE_SEEDS):
    before = {arm:head.state() for arm,head in heads.items()}
    candidates = candidates_for(roots); objects = []; stop = 'completed'
    for number, task in enumerate(tasks, 1):
        if time.monotonic() >= deadline:
            stop = 'new_stage_time_budget'; break
        math_seed = 2026100920 + number
        keywords = ask('retest_keywords', keyword_messages(task), math_seed,
            writer_enabled=False, task=task)
        save('raw', keywords); after_raw_frozen()
        ranked = rank_candidates(candidates, keywords['studentOutput'])
        save('scored', dict(keywords, check=dict(wholeStudentTextUsed=True,
            keywordCommandNotRequired=True,
            hits=[dict(id=r['candidate']['id'], matchedKeywords=r['matchedKeywords']) for r in ranked if r['keywordHit']],
            scopedZeroHitCandidatesAlsoOffered=True, applicabilityNotAssumed=True)))
        ordered = [r['candidate'] for r in ranked]
        features = features_for(task, keywords, ordered)
        if any(len(h.weights) != len(features[0]) for h in heads.values()):
            raise ValueError('Saved heads and actual frozen model representations differ in size')
        decisions = []
        # Persist every choice BEFORE inspecting any of this object's outcomes.
        for seed_index, seed_base in enumerate(choice_seeds, 1):
            seed = seed_base + number*1000
            for arm in ARMS:
                policy = heads[arm].choose(features, seed)
                candidate = ordered[policy['selectedIndex']]
                row = dict(id=task['id']+'-'+arm+'-'+str(seed_index), task=copy.deepcopy(task),
                    arm=arm, seedIndex=seed_index, sourceKeywordRecordId=keywords['recordId'],
                    candidateOrder=[c['id'] for c in ordered], selectedCandidate=copy.deepcopy(candidate),
                    policyOutput=policy, frozenPolicySample=True,
                    noMathOutcomeInPolicyInput=True)
                save('decision', row); decisions.append(row)
        routes = {}
        # All three real writer routes are tested once, including unselected ones.
        # This is a HOST-arranged audit. It is not 48 independent text generations.
        for index, candidate in enumerate(ordered):
            if time.monotonic() >= deadline:
                stop = 'new_stage_time_budget_incomplete_object'; break
            row = ask('retest_route_math', math_messages(task, candidate, roots), math_seed,
                writer_enabled=True, task=task, selectedCandidate=candidate,
                arm='host_route_audit', sourceKeywordRecordId=keywords['recordId'],
                hostSpecifiedRoute=True, selectedByAnySavedPolicy=any(
                    d['selectedCandidate']['id']==candidate['id'] for d in decisions))
            save('raw', row); after_raw_frozen()
            check = audit_math(task,row['studentOutput'],candidate)
            checked = dict(row, check=check,
                diagnostic=diagnostic(task,row['studentOutput'],candidate,check))
            save('scored', checked); routes[candidate['id']] = checked
            instance = exact_instance(checked)
            if instance:
                instance.update(routeSpecifiedByHost=True, studentAutonomousToolUseClaimed=False)
                save('instance',instance)
        if len(routes) != 3:
            break
        audits = []
        for decision in decisions:
            route = routes[decision['selectedCandidate']['id']]
            trial = dict(id=decision['id'], task=copy.deepcopy(task), arm=decision['arm'],
                seedIndex=decision['seedIndex'], policyOutput=decision['policyOutput'],
                selectedCandidateId=decision['selectedCandidate']['id'],
                selectedKind=decision['selectedCandidate']['kind'],
                routeRecordId=route['recordId'], outcomePassed=route['check']['outcomePassed'],
                mathematicallyCorrect=route['check']['mathematicallyCorrectWrittenEquality'],
                failureCategory=route['diagnostic']['category'],
                repeatedSeedTrialNotIndependentNewObject=True,
                mathResponseReusedFromSameObjectMethodAndGreedyWriter=True,
                additionalTextGenerations=0)
            save('trial',trial); audits.append(trial)
        # Both policies see the same ordered features and actual route outcomes.
        outcomes = [int(routes[c['id']]['check']['outcomePassed']) for c in ordered]
        probabilities = {arm:heads[arm].probabilities(features)[1] for arm in ARMS}
        success_mass = {arm:sum(p*y for p,y in zip(probabilities[arm],outcomes)) for arm in ARMS}
        obj = dict(id=task['id'], task=copy.deepcopy(task), keywordRecordId=keywords['recordId'],
            candidateOrder=[c['id'] for c in ordered], routeRecordIds=[routes[c['id']]['recordId'] for c in ordered],
            routeOutcomes=outcomes, choiceProbabilities=probabilities, expectedOutcomePass=success_mass,
            expectedDifference=success_mass[ARMS[0]]-success_mass[ARMS[1]],
            trials=audits, allThreeRealStudentRoutesCovered=True,
            expectationConditionalOnThisOneGreedyResponsePerMethod=True,
            numericalExpectationNotAdditionalStudentSolving=True)
        save('object',obj); objects.append(obj)
        if any(heads[arm].state()!=before[arm] for arm in ARMS):
            raise RuntimeError('A frozen evaluation choice head changed')
        print('复验对象 '+str(number)+'/8：'+task['expression']+'；正确方法概率='+
            str({a:round(success_mass[a],4) for a in ARMS}),flush=True)
    return dict(stopReason=stop,objects=objects,
        choiceHeadsUnchanged={a:heads[a].state()==before[a] for a in ARMS})


def summarize(objects, trials, choice_seeds=CHOICE_SEEDS):
    means = {arm:(sum(o['expectedOutcomePass'][arm] for o in objects)/len(objects)
        if objects else None) for arm in ARMS}
    eps = 1e-12
    result = dict(completeNewObjects=len(objects), maximumNewObjects=8,
        independentObjectCountNotMultipliedBySeeds=True, choiceSeedsPerObject=len(choice_seeds),
        pairedFrozenPolicySeedTrials=len(trials)//2,
        expectedOutcomePassByArm=means,
        meanExpectedDifference=(means[ARMS[0]]-means[ARMS[1]]) if objects else None,
        objectsWithHigherTrainedSuccessProbability=sum(o['expectedDifference']>eps for o in objects),
        objectsWithLowerTrainedSuccessProbability=sum(o['expectedDifference']<-eps for o in objects),
        objectsWithTiedSuccessProbability=sum(abs(o['expectedDifference'])<=eps for o in objects),
        primaryMetric='per-object probability mass on actual verified successful method routes',
        primaryMetricDoesNotDependOnSamplingALuckyChoiceSeed=True,
        mathematicalWriterIsGreedyAndFrozen=True,
        allMethodRoutesSpecifiedByHostAndAuditedOnce=True,
        unselectedMethodAuditsNotStudentAutonomousChoices=True,
        seedTrialsReuseSavedSameObjectMethodResponses=True,
        textGenerationsAndUniqueObjectsAndPolicySamplesReportedSeparately=True,
        independentTrainingReplications=0, sourceTrainedHeadCount=1,
        observationsDoNotProveReliableEffectAcrossIndependentlyTrainedHeads=True,
        sourceHeadNotRefitOnRetestObjects=True, fullAutonomousLearningProved=False,
        energyEfficiencyProved=False, statisticalSignificanceClaimed=False)
    result['sampledPolicyOutcomes'] = {}
    for arm in ARMS:
        rows = [r for r in trials if r['arm']==arm]
        result['sampledPolicyOutcomes'][arm] = dict(trials=len(rows),
            outcomePasses=sum(r['outcomePassed'] for r in rows),
            directChoices=sum(r['selectedKind']=='direct' for r in rows),
            zipChoices=sum(r['selectedKind']!='direct' for r in rows),
            failures=dict(Counter(r['failureCategory'] for r in rows if not r['outcomePassed'])),
            perSeed={str(seed):dict(trials=sum(r['seedIndex']==seed for r in rows),
                outcomePasses=sum(r['seedIndex']==seed and r['outcomePassed'] for r in rows))
                for seed in range(1,len(choice_seeds)+1)})
    result['objects'] = [dict(expression=o['task']['expression'],
        routeOutcomes=o['routeOutcomes'],candidateOrder=o['candidateOrder'],
        expectedOutcomePass=o['expectedOutcomePass'],expectedDifference=o['expectedDifference']) for o in objects]
    return result
