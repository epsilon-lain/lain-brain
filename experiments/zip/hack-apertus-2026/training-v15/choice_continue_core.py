"""Continue a saved selector using actual complete-route feedback only.

This module never supplies a mathematical target to the student. All three
routes are host-scheduled audits; their verified outcomes train a shared linear
head by the exact gradient of expected outcome reward. ZIP drafts are student
originals and remain pending, separately from certified local instances.
"""
import copy
import math
import random
import time

from object_choice_core import (ChoiceHead, candidates_for, keyword_messages,
    rank_candidates, math_messages, audit_math, exact_instance, memory_messages)
from choice_retest_core import diagnostic, restore_head
from tool_loop_kernel import object_key
from zip_content_core import digest

PROTOCOL = 'lain-zip-choice-continuation-v1'
ARMS = ('continuing_choice', 'frozen_before_round', 'frozen_original_initial')
TOKENS = 96
TRAINING_OBJECTS = 8
HELDOUT_OBJECTS = 4
GENERATION_CAP = 64  # 8 anchors + 12*(one keyword + three maths) + 8 ZIP drafts.
FEATURE_BATCH_CAP = 12
UPDATE_CAP = 8
LEARNING_RATE = 0.5


def make_plan(excluded, roots):
    seen = set(excluded) | {object_key(r['rule']['input']) for r in roots}
    pools = (
        ('same_factor', (f'1 * ({n} * v) + 2 * ({n} * v)' for n in range(1, 257))),
        ('product_of_sum', (f'3 * ({n} * v + {m})' for m in range(1, 257) for n in (4, 5, 6, 7))))
    selected = {}
    for family, pool in pools:
        rows = []
        for expression in pool:
            key = object_key(expression)
            if key in seen:
                continue
            seen.add(key)
            rows.append(dict(id='continue-object-' + digest(expression)[:16],
                expression=expression, question='Rewrite ' + expression + '.',
                scope='real_polynomial', semanticInputKey=key, family=family))
            if len(rows) == 6:
                break
        if len(rows) != 6:
            raise ValueError('Not enough unused objects; never silently recycle an old input')
        selected[family] = rows
    families = [p[0] for p in pools]
    return dict(training=[dict(selected[f][i], split='training') for i in range(4) for f in families],
        heldout=[dict(selected[f][i], split='heldout') for i in (4, 5) for f in families],
        trainingObjects=TRAINING_OBJECTS, heldoutObjects=HELDOUT_OBJECTS,
        freshnessLimitedToListedArchives=True, structuralGeneralizationProved=False)


def seeds_for_object(round_number, number, count=3):
    if type(round_number) is not int or not 1 <= round_number <= 1000:
        raise ValueError('Continuation round must be in 1..1000')
    if type(number) is not int or not 1 <= number <= 12 or count not in (1, 3):
        raise ValueError('Invalid object or seed count')
    return tuple(2026101000 + round_number * 100000 + number * 1000 + i for i in range(count))


def feedback_update(head, features, outcomes, session_step):
    if type(session_step) is not int or not 1 <= session_step <= UPDATE_CAP:
        raise ValueError('Per-round update budget reached')
    if len(outcomes) != 3 or any(type(y) is not int or y not in (0, 1) for y in outcomes):
        raise ValueError('Three actual audited binary route outcomes are required')
    logits, probabilities = head.probabilities(features)
    rewards = [2. * y - 1. for y in outcomes]
    expected_reward = sum(p * r for p, r in zip(probabilities, rewards))
    gradient = ([0.] * len(head.weights) if len(set(outcomes)) == 1 else
        [sum(p * (r - expected_reward) * v[i]
        for p, r, v in zip(probabilities, rewards, features)) for i in range(len(head.weights))])
    norm = math.sqrt(sum(g * g for g in gradient))
    scale = min(1., 1. / max(norm, 1e-12))
    before = head.state()
    head.weights = [w + LEARNING_RATE * scale * g for w, g in zip(head.weights, gradient)]
    changed = head.weights != before['weights']
    if changed:
        head.updates += 1
    after = head.state()
    _, after_probabilities = head.probabilities(features)
    return dict(updated=changed, sessionStep=session_step,
        cumulativeParameterUpdates=head.updates, beforeHash=before['parameterHash'],
        afterHash=after['parameterHash'], beforeState=before, afterState=after,
        routeOutcomes=list(outcomes), routeRewards=rewards,
        probabilitiesBefore=probabilities, probabilitiesAfter=after_probabilities,
        expectedPassBefore=sum(p*y for p,y in zip(probabilities,outcomes)),
        expectedPassAfter=sum(p*y for p,y in zip(after_probabilities,outcomes)),
        gradientNormBeforeClip=norm, learningRate=LEARNING_RATE,
        algorithm='exact expected audited-route reward gradient; SGD ascent; norm capped at 1',
        feedbackFromAllThreeActualStudentRoutes=True, correctToolLabelSupplied=False,
        onlyChoiceHeadUpdated=True, mathTargetTokensProvided=False)


def zip_draft_messages(task, keywords, own_math):
    messages = memory_messages(task, keywords, own_math)
    messages[0]['content'] = (
        'Write a short candidate ZIP in your own words: what you understood about '
        'this object, the method you actually tried, and what could be reused or '
        'needs checking next time. Preserve uncertainty after failure. This is a '
        'draft, not an already proved general rule. No corrected answer is supplied.')
    return messages


def run_course(plan, roots, heads, ask, features_for, save, after_raw_frozen,
               checkpoint, deadline, round_number=1):
    controls = {a:heads[a].state() for a in ARMS[1:]}
    if heads[ARMS[0]].state() != controls[ARMS[1]]:
        raise ValueError('Learning head must start exactly at the frozen pre-round checkpoint')
    checkpoint('initial', {a:h.state() for a,h in heads.items()})
    candidates = candidates_for(roots)
    objects = []; updates = []; stop = 'completed'; heldout_state = None
    tasks = plan['training'] + plan['heldout']
    for number, task in enumerate(tasks, 1):
        if time.monotonic() >= deadline:
            stop = 'new_stage_time_budget'; break
        if task['split'] == 'heldout' and heldout_state is None:
            heldout_state = heads[ARMS[0]].state()
            checkpoint('training-final', {a:h.state() for a,h in heads.items()})
        math_seed = seeds_for_object(round_number, number, 1)[0] + 300
        keywords = ask('continue_keywords', keyword_messages(task), math_seed,
            writer_enabled=False, task=task)
        save('raw', keywords); after_raw_frozen()
        ranked = rank_candidates(candidates, keywords['studentOutput'])
        save('scored', dict(keywords, check=dict(wholeStudentTextUsed=True,
            strictKeywordCommandNotRequired=True, keywordHitsNotProofOfApplicability=True,
            automaticBankPromotion=False)))
        ordered = [r['candidate'] for r in ranked]
        features = features_for(task, keywords, ordered)
        if any(len(h.weights) != len(features[0]) for h in heads.values()):
            raise ValueError('Checkpoint and frozen feature dimensions differ')
        decisions = []
        probabilities = {a:heads[a].probabilities(features)[1] for a in ARMS}
        seed_count = 1 if task['split'] == 'training' else 3
        for seed_index, seed in enumerate(seeds_for_object(round_number, number, seed_count), 1):
            for arm in ARMS:
                policy = heads[arm].choose(features, seed)
                decision = dict(id=task['id']+'-'+arm+'-'+str(seed_index), task=copy.deepcopy(task),
                    arm=arm, seedIndex=seed_index, sourceKeywordRecordId=keywords['recordId'],
                    candidateOrder=[c['id'] for c in ordered],
                    selectedCandidate=copy.deepcopy(ordered[policy['selectedIndex']]),
                    policyOutput=policy, savedBeforeAnyRouteOutcome=True)
                save('decision', decision); decisions.append(decision)
        routes = {}
        for candidate in ordered:
            if time.monotonic() >= deadline:
                stop = 'new_stage_time_budget_incomplete_object'; break
            row = ask('continue_route_math', math_messages(task,candidate,roots), math_seed,
                writer_enabled=True, task=task, selectedCandidate=candidate,
                arm='host_route_audit', sourceKeywordRecordId=keywords['recordId'],
                hostSpecifiedRoute=True, autonomousToolUseClaimed=False)
            save('raw', row); after_raw_frozen()
            check = audit_math(task,row['studentOutput'],candidate)
            checked = dict(row,check=check,
                diagnostic=diagnostic(task,row['studentOutput'],candidate,check))
            save('scored',checked); routes[candidate['id']] = checked
            instance = exact_instance(checked)
            if instance:
                instance.update(routeSpecifiedByHost=True, studentAutonomousToolUseClaimed=False)
                save('instance',instance)
        if len(routes) != 3:
            break
        outcomes = [int(routes[c['id']]['check']['outcomePassed']) for c in ordered]
        for decision in decisions:
            route = routes[decision['selectedCandidate']['id']]
            save('trial',dict(id=decision['id'],task=copy.deepcopy(task),arm=decision['arm'],
                seedIndex=decision['seedIndex'],selectedKind=decision['selectedCandidate']['kind'],
                routeRecordId=route['recordId'],outcomePassed=route['check']['outcomePassed'],
                failureCategory=route['diagnostic']['category'],additionalTextGenerations=0,
                repeatedSeedTrialNotIndependentNewObject=True))
        success_mass = {a:sum(p*y for p,y in zip(probabilities[a],outcomes)) for a in ARMS}
        obj = dict(id=task['id'],task=copy.deepcopy(task),keywordRecordId=keywords['recordId'],
            candidateOrder=[c['id'] for c in ordered],routeRecordIds=[routes[c['id']]['recordId'] for c in ordered],
            routeOutcomes=outcomes,choiceProbabilities=probabilities,expectedOutcomePass=success_mass,
            expectedDifference=success_mass[ARMS[0]]-success_mass[ARMS[1]],
            scoreUsesPreFeedbackPolicy=True,allThreeRealStudentRoutesCovered=True)
        save('object',obj); objects.append(obj)
        if task['split'] == 'training':
            if time.monotonic() >= deadline:
                stop = 'new_stage_time_budget_no_feedback_update'; break
            began = time.monotonic()
            update = feedback_update(heads[ARMS[0]],features,outcomes,len(updates)+1)
            update.update(id=task['id'],taskId=task['id'],
                sourceKeywordRecordId=keywords['recordId'],sourceMathRecordIds=obj['routeRecordIds'],
                candidateOrder=obj['candidateOrder'],updateSeconds=time.monotonic()-began)
            save('update',update); updates.append(update)
            checkpoint('after-'+str(len(updates)).zfill(2),{a:h.state() for a,h in heads.items()})
            if time.monotonic() >= deadline:
                stop = 'new_stage_time_budget_before_zip_draft'; break
            own_decision = next(d for d in decisions if d['arm']==ARMS[0])
            own_math = routes[own_decision['selectedCandidate']['id']]
            note = ask('continue_zip_draft',zip_draft_messages(task,keywords,own_math),math_seed+100,
                writer_enabled=False,task=task,sourceMathRecordId=own_math['recordId'])
            save('raw',note); after_raw_frozen()
            save('scored',dict(note,check=dict(status='pending_zip_semantics_and_reuse_review',
                originalTextPreserved=True,automaticBankPromotion=False,
                naturalLanguageTruthCertified=False,newReusableRuleProved=False)))
        if any(heads[a].state()!=controls[a] for a in controls):
            raise RuntimeError('A frozen control checkpoint changed')
        if task['split']=='heldout' and heads[ARMS[0]].state()!=heldout_state:
            raise RuntimeError('Heldout outcomes must not update the trained head')
        print(('训练' if task['split']=='training' else '保留')+'对象 '+str(number)+'/12：'+
            task['expression']+'；成功方法概率='+str({a:round(v,4) for a,v in success_mass.items()})+
            '；本轮反馈更新='+str(len(updates)),flush=True)
    checkpoint('final',{a:h.state() for a,h in heads.items()})
    return dict(stopReason=stop,objects=objects,updates=updates,
        finalHeads={a:h.state() for a,h in heads.items()},
        heldoutHeadUnchanged=(heldout_state is not None and heads[ARMS[0]].state()==heldout_state),
        frozenControlsUnchanged={a:heads[a].state()==controls[a] for a in controls})


def summarize(objects, trials, updates):
    result = {}
    for split in ('training','heldout'):
        rows = [r for r in objects if r['task']['split']==split]
        def block(subset):
            means={a:(sum(r['expectedOutcomePass'][a] for r in subset)/len(subset) if subset else None) for a in ARMS}
            return dict(objects=len(subset),expectedOutcomePassByArm=means,
                meanExpectedDifference=means[ARMS[0]]-means[ARMS[1]] if subset else None)
        result[split]=dict(block(rows),byFamily={f:block([r for r in rows if r['task']['family']==f])
            for f in ('same_factor','product_of_sum')})
    result.update(primaryMetric='heldout per-object probability mass on actual successful method routes',
        primaryComparison='continued trained head versus its frozen pre-round checkpoint',
        trainingScoresTakenBeforeEachObjectsOwnFeedback=True,
        choiceFeedbackSteps=len(updates),actualParameterUpdates=sum(u['updated'] for u in updates),
        uniqueNewObjects=len(objects),heldoutUniqueObjects=sum(r['task']['split']=='heldout' for r in objects),
        policySamples=len(trials),seedSamplesNotIndependentObjects=True,
        independentTrainingReplications=0,sourceTrainedHeadCount=1,
        onlyChoiceHeadLearns=True,keywordWriterLearns=False,mathematicalWriterLearns=False,
        routeMathHostScheduled=True,fullAutonomousLearningProved=False,
        newZipDraftsNotYetCertified=True,energyEfficiencyProved=False,statisticalSignificanceClaimed=False)
    result['sampledOutcomes']={split:{a:dict(trials=len([t for t in trials if t['task']['split']==split and t['arm']==a]),
        outcomePasses=sum(t['outcomePassed'] for t in trials if t['task']['split']==split and t['arm']==a))
        for a in ARMS} for split in ('training','heldout')}
    return result
