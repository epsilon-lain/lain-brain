"""Same-object frozen comparison of two reviewed v5 branches; no learning."""
import copy
import time

from choice_continue_core import make_plan
from choice_retest_core import restore_head
from object_choice_core import math_messages, exact_instance
from zip_label_grounded_core import require, cards, observations_messages, saved_choice, expected_pass
from zip_label_feedback_audit import audit_math, diagnostic
from zip_semantic_generation import NATURAL_LANGUAGE

PROTOCOL = 'lain-zip-label-frozen-branch-comparison-v1'
SOURCE_PINS = {
    'branch_a': 'f0d8f5cdec60b3062eae26a477e317e7f8ddac89073f4d02e1df012bc3c6c291',
    'branch_b': 'bc89f2208e2f1606108d3865e6c30dbd97468c6f08824d9dcb74134e1acc8dd2',
}
ARMS = ('checkpoint_47624235', 'checkpoint_9024865b', 'common_before_training',
        '47624235_with_old_cards', '9024865b_with_old_cards')
OBJECTS, TOKENS, GENERATION_CAP, FEATURE_BATCH_CAP = 8, 96, 56, 40
COMPARISONS = {
    '9024865b_minus_47624235': (ARMS[1], ARMS[0]),
    '47624235_minus_before': (ARMS[0], ARMS[2]),
    '9024865b_minus_before': (ARMS[1], ARMS[2]),
    '47624235_new_cards_minus_old': (ARMS[0], ARMS[3]),
    '9024865b_new_cards_minus_old': (ARMS[1], ARMS[4]),
}


def seed_for_comparison(number, object_number, slot):
    require(type(number) is int and 1 <= number <= 1000, 'Invalid comparison number')
    require(type(object_number) is int and 1 <= object_number <= OBJECTS and
            type(slot) is int and 0 <= slot < 100, 'Invalid comparison seed slot')
    return 2_700_000_000 + number * 100_000 + object_number * 100 + slot


def fresh_tasks(excluded, roots):
    plan = make_plan(excluded, roots)
    tasks = [dict(t, id=t['id'].replace('continue-object-', 'branch-compare-object-'),
                  split='heldout') for t in plan['training']]
    require(len(tasks) == OBJECTS and len({t['semanticInputKey'] for t in tasks}) == OBJECTS and
            all(sum(t['family'] == f for t in tasks) == 4 for f in ('same_factor', 'product_of_sum')) and
            not set(excluded).intersection(t['semanticInputKey'] for t in tasks), 'Fresh balanced tasks required')
    return tasks


def run_comparison(tasks, roots, before, branch_a, branch_b, ask, features, save,
                   select_writer, frozen, deadline, number):
    require(len(tasks) == OBJECTS and len({t['id'] for t in tasks}) == OBJECTS and
            all(t['split'] == 'heldout' for t in tasks), 'Eight distinct heldout objects required')
    snapshots = copy.deepcopy((roots, before, branch_a, branch_b))
    states = (branch_a, branch_b, before, branch_a, branch_b)
    heads = {a: restore_head(s['head']) for a, s in zip(ARMS, states)}
    objects = []
    for index, task in enumerate(tasks, 1):
        if time.monotonic() >= deadline:
            raise TimeoutError('Frozen comparison deadline reached')
        rows, vectors, candidates, feature_ids = {}, {}, {}, {}
        # All arms use identical prompt builders, greedy semantic decoding and
        # seed. Their frozen semantic state and earlier notes are the variables.
        for arm, mode, state in zip(ARMS[:3], ('branch_a', 'branch_b', 'before'), states[:3]):
            select_writer(mode)
            row = ask('comparison_observations', observations_messages(task, roots, state['labels'], NATURAL_LANGUAGE),
                seed_for_comparison(number, index, 1), mode='semantic', sampled=False, task=task, arm=arm)
            save('scored', dict(row, check=dict(studentAuthoredFeatures=True, wholeOriginalUsed=True,
                naturalLanguageTruthCertified=False, trainingUpdates=0)))
            rows[arm] = row
            candidates[arm] = cards(roots, state['labels'], NATURAL_LANGUAGE)
            vectors[arm], feature_ids[arm] = features(task, row, candidates[arm])
        for arm, origin in ((ARMS[3], ARMS[0]), (ARMS[4], ARMS[1])):
            rows[arm] = rows[origin]
            candidates[arm] = cards(roots, before['labels'], NATURAL_LANGUAGE)
            vectors[arm], feature_ids[arm] = features(task, rows[arm], candidates[arm])
        decisions = []
        for seed_index in (1, 2, 3):
            seed = seed_for_comparison(number, index, 50 + seed_index)
            for arm in ARMS:
                decision = saved_choice(task, arm, vectors[arm], candidates[arm], heads[arm], seed,
                    seed_index, rows[arm]['recordId'], feature_ids[arm])
                save('decision', decision)
                decisions.append(decision)
        # All fifteen choices are durable before any of the three math calls.
        # Candidate prose never modifies math_messages or the frozen roots.
        select_writer('branch_a')
        routes = []
        for candidate in candidates[ARMS[2]]:
            row = ask('comparison_route_math', math_messages(task, candidate, roots),
                seed_for_comparison(number, index, 20), mode='math', sampled=False,
                task=task, selectedCandidate=copy.deepcopy(candidate), arm='host_method_audit',
                hostSpecifiedRoute=True, autonomousToolUseClaimed=False)
            audited = dict(row, check=audit_math(task, row['studentOutput'], candidate))
            save('scored', audited)
            routes.append(audited)
            instance = exact_instance(audited)
            if instance: save('instance', instance)
            if not audited['check']['outcomePassed']:
                save('failure', dict(audited, id=audited['recordId']))
        outcomes = [int(r['check']['outcomePassed']) for r in routes]
        expectations, probabilities = {}, {}
        for arm in ARMS:
            expectations[arm], probabilities[arm] = expected_pass(heads[arm], vectors[arm], outcomes)
        for decision in decisions:
            selected = next(r for r in routes if r['selectedCandidate']['id'] == decision['selectedCandidate']['id'])
            save('trial', dict(id=decision['id'], phase='heldout', arm=decision['arm'],
                taskId=task['id'], seedIndex=decision['seedIndex'], decisionId=decision['id'],
                sourceMathRecordId=selected['recordId'], outcomePassed=selected['check']['outcomePassed'],
                legacyOutcomePassed=selected['check']['legacyOutcomePassed'],
                diagnostic=diagnostic(task, selected['studentOutput'], selected['selectedCandidate'], selected['check']),
                noExtraGenerationForPolicySample=True))
        obj = dict(id=task['id'], task=copy.deepcopy(task), phase='heldout', routeOutcomes=outcomes,
            legacyRouteOutcomes=[int(r['check']['legacyOutcomePassed']) for r in routes],
            sourceMathRecordIds=[r['recordId'] for r in routes], expectedPassByArm=expectations,
            probabilitiesByArm=probabilities, pairedDifferences={k: expectations[a]-expectations[b]
                for k, (a,b) in COMPARISONS.items()}, observationRecordIdsByArm={a:r['recordId'] for a,r in rows.items()},
            observationLabelIdsUsedByArm={a:{k:v['id'] for k,v in s['labels'].items()}
                for a,s in zip(ARMS, states)},
            selectionLabelIdsUsedByArm={a:{c['id']:c['sourceLabelVersion'] for c in cs[1:]}
                for a,cs in candidates.items()}, allChoicesSavedBeforeRouteAudit=True,
            trainingUpdates=0, newLabelRevisions=0, seedTrialsNotIndependentObjects=True)
        frozen()
        require((roots, before, branch_a, branch_b) == snapshots and
                all(heads[a].state() == s['head'] for a,s in zip(ARMS, states)), 'Frozen comparison state changed')
        save('object', obj)
        objects.append(obj)
    select_writer('branch_a')
    frozen()
    return objects


def comparison_summary(objects, trials, *, legacy=False):
    complete_ids={o['id'] for o in objects}
    def grouped(rows):
        count = len(rows)
        probabilities = {a:(sum(sum(p*y for p,y in zip(o['probabilitiesByArm'][a], o['legacyRouteOutcomes']))
            if legacy else o['expectedPassByArm'][a] for o in rows)/count if count else None) for a in ARMS}
        return dict(objects=count, expectedPassByArm=probabilities,
            meanPairedDifferences={k:(probabilities[a]-probabilities[b] if count else None)
                for k,(a,b) in COMPARISONS.items()},
            perObjectPairedDifferences=[dict(taskId=o['id'], differences={k:
                ((sum(p*y for p,y in zip(o['probabilitiesByArm'][a],o['legacyRouteOutcomes'])) -
                  sum(p*y for p,y in zip(o['probabilitiesByArm'][b],o['legacyRouteOutcomes'])))
                 if legacy else o['pairedDifferences'][k]) for k,(a,b) in COMPARISONS.items()}) for o in rows])
    result = dict(primaryMetric='probability mass on all actually verified successful shared method routes',
        primaryComparison='frozen 9024865b versus frozen 47624235 on the same new objects',
        sourceResultPins=SOURCE_PINS, heldout=grouped(objects),
        heldoutByFamily={f:grouped([o for o in objects if o['task']['family']==f])
            for f in ('same_factor','product_of_sum')}, uniqueNewObjects=len(objects),
        sampledHeldoutOutcomesByArm={}, heldoutTopCandidateKindsByArm={}, heldoutTopRoutePassesByArm={},
        trainingUpdates=0, teacherCalls=0, newLabelRevisions=0, frozenRetest=True,
        seedSamplesNotIndependentObjects=True, checkpointsSelectedByHeldout=False,
        metadataAblationKeepsLearnedObservationTextAndSelector=True,
        observationGenerationEffectNotIsolatedByMetadataCardAblation=True,
        naturalLanguageDescriptionsCertified=False, structuralGeneralizationProved=False,
        independentlyRetrainedReplication=False, statisticalSignificanceClaimed=False,
        fullAutonomousLearningProved=False, energyEfficiencyProved=False)
    for arm in ARMS:
        rows=[t for t in trials if t['arm']==arm and t['taskId'] in complete_ids]
        field='legacyOutcomePassed' if legacy else 'outcomePassed'
        result['sampledHeldoutOutcomesByArm'][arm]=dict(trials=len(rows),passes=sum(t[field] for t in rows),
            perSeed={str(i):dict(trials=sum(t['seedIndex']==i for t in rows),
                passes=sum(t[field] for t in rows if t['seedIndex']==i)) for i in (1,2,3)})
        top=[(max(range(3),key=o['probabilitiesByArm'][arm].__getitem__),o) for o in objects]
        result['heldoutTopCandidateKindsByArm'][arm]={k:sum(i==j for i,_ in top)
            for j,k in enumerate(('direct','combine','distribute'))}
        result['heldoutTopRoutePassesByArm'][arm]=sum(o['legacyRouteOutcomes' if legacy else 'routeOutcomes'][i]
            for i,o in top)
    return result
