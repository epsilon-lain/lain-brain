"""Real summary training with saved sampled trajectories and native ZIP reads."""
import argparse
import copy
import json
import math
import os
from pathlib import Path
import signal
import time
import traceback
from types import SimpleNamespace
import zipfile

from draft_inspect_runtime import read, sha, snapshot
from writer_check_core import write_once, exact_reproduction
from writer_check_run import preflight
from tool_loop_course import archived_inputs
from choice_continue_core import make_plan
from object_choice_core import normalized_features, math_messages
from zip_label_grounded_checks import feature_messages
from zip_label_metacognitive_source import inspect_source
from zip_self_question_tools_policy import input_limits, prompt_audit, require_input, generate
from zip_label_metacognitive_policy import update_words
from zip_interface_training_policy import checkpoint_boundary
from zip_summary_training_v4_core import (PROTOCOL, BRANCHES, EVALUATION_ARMS, TRAINING_OBJECTS,
    HELDOUT_OBJECTS, SUMMARIES_PER_BRANCH, MAX_TOKENS, MAX_GENERATIONS, MAX_FEATURE_BATCHES,
    SUMMARY_LEARNING_RATE, SUMMARY_WRITE_OBJECTS, REWARD_OBJECTS_PER_SUMMARY, require, seed_for, digest,
    candidate_cards, observation_messages, summary_messages, audit_summary, validate_summary,
    summary_credit, multi_object_credit, retention_review, run_course, summarize, restore_head,
    summary_rating_messages, rating_prompt, make_rating, literal_references, calibration_record,usage_summary)
from zip_summary_training_v4_progress import StageProgress
from zip_summary_training_v2_run import inspect_training_source as inspect_previous_source
from zip_summary_training_v2_core import PROTOCOL as PREVIOUS_PROTOCOL
import zip_summary_training_v3_core as v3_core


def numeric_same(actual, expected):
    """Only finite float reductions have an absolute 1e-12 allowance.

Text, identifiers, integers, booleans, provenance and collection shape remain
exact. This never changes saved values or turns a failed guard into a pass.
"""
    if type(actual) is not type(expected):return False
    if type(actual) is float:
        return math.isfinite(actual) and math.isfinite(expected) and abs(actual-expected)<=1e-12
    if isinstance(actual,dict):
        return set(actual)==set(expected) and all(numeric_same(actual[k],expected[k]) for k in actual)
    if isinstance(actual,(list,tuple)):
        return len(actual)==len(expected) and all(numeric_same(a,b) for a,b in zip(actual,expected))
    return actual==expected


def replay_update_matches(rebuilt, saved):
    # Both saved states must verify their exact parameter-hash preimages.
    restore_head(saved['beforeState']);restore_head(saved['afterState'])
    if not numeric_same(rebuilt['afterState']['weights'],saved['afterState']['weights']):return False
    adjusted=copy.deepcopy(rebuilt)
    adjusted['afterState']['parameterHash']=saved['afterState']['parameterHash']
    adjusted['afterHash']=saved['afterHash']
    return numeric_same(adjusted,saved)


def state_unchanged(before, after):
    """Unknown hashes cannot establish either equality or a weight change."""
    return None if before is None or after is None else before == after


def review_inherited_context(resume):
    reviews={};banks=copy.deepcopy(resume['initialBanks'])
    for branch,identifier in banks.items():
        if not identifier:continue
        note=resume['inherited'][identifier]
        require(note['branch']==branch,'Inherited active summary belongs to another branch')
        current=audit_summary(note['studentOriginal']['studentOutput'],note['event'])
        full_path_reviewed=note.get('summaryProtocol') in (PROTOCOL,v3_core.PROTOCOL)
        retained=current['eligibleForTrial'] and full_path_reviewed
        reviews[branch]=dict(summaryZipId=identifier,originalSummaryHash=note['summaryHash'],
            previousAuditUnchanged=copy.deepcopy(note['audit']),currentContextAudit=current,
            retainedForNewTaskContext=retained,oldScoresChanged=False,
            priorFullPathTrainingGuardRequired=True,
            reason='retained_full_path_training_guarded_context' if retained else
                'prior_protocol_did_not_test_full_path_structure_guard' if not full_path_reviewed else
                'known_fact_or_completion_failure',oldSampledTrajectoryNotTrainedAgain=True)
        if not retained:banks[branch]=None
    return dict(resume,initialBanks=banks,inheritedContextReviews=reviews)


def write_summary_zip(folder, note):
    validate_summary(note)
    path = folder/(note['id']+'.zip')
    with zipfile.ZipFile(path, 'x', zipfile.ZIP_DEFLATED) as z:
        z.writestr('root.json', json.dumps(note, ensure_ascii=False, indent=2))
        z.writestr('student-original.json', json.dumps(note['studentOriginal'], ensure_ascii=False, indent=2))
        z.writestr('source-event.json', json.dumps(note['event'], ensure_ascii=False, indent=2))
        z.writestr('summary.txt', note['studentRaw'])
    return sha(path)


def read_summary_zip(folder, identifier, hashes):
    require(type(identifier) is str and Path(identifier).name == identifier and identifier in hashes,
        'Unregistered summary ZIP')
    path = folder/(identifier+'.zip')
    require(sha(path) == hashes[identifier], 'Summary ZIP bytes changed')
    with zipfile.ZipFile(path) as z:
        require(z.namelist() == ['root.json', 'student-original.json', 'source-event.json', 'summary.txt'] and
            z.testzip() is None, 'Summary ZIP entries or CRC changed')
        note = json.loads(z.read('root.json')); validate_summary(note)
        require(note['id'] == identifier and json.loads(z.read('student-original.json')) == note['studentOriginal'] and
            json.loads(z.read('source-event.json')) == note['event'] and z.read('summary.txt').decode() == note['studentRaw'],
            'Summary ZIP does not retain the whole original and source')
    return note


def inspect_v4_context_flow(plan,objects,updates,summaries,ratings,references,calibrations,activations,
        raws,features,initial,final,bank,retention_reviews,inherited,round_number):
    """Replay candidate admission and metadata independently of selector math."""
    note_by_source={(n['sourceTaskId'],n['branch']):n for n in summaries}
    require(len(note_by_source)==len(summaries)==6,'Summary writing slots changed')
    rating_map={r['sourceSummaryZipId']:r for r in ratings}
    activation_map={r['summaryZipId']:r for r in activations}
    calibration_map={r['sourceSummaryZipId']:r for r in calibrations}
    reference_map={r['id']:r for r in references}
    require(len(rating_map)==len(ratings)==6 and set(rating_map)=={n['id'] for n in summaries},
        'Each actual summary must retain its own rating record')
    require(len(reference_map)==len(references) and len(activation_map)==len(activations) and
        len(calibration_map)==len(calibrations),'Duplicate reference, rating or activation record')
    for note in summaries:
        rating=rating_map[note['id']];row=raws.get(rating['sourceRatingRecordId'])
        if note['audit']['eligibleForTrial']:
            require(row is not None,'Eligible summary lacks its scheduled real quality assessment')
            number=next(i for i,t in enumerate(plan['training'],1) if t['id']==note['sourceTaskId'])
            require(row['samplingSeed']==seed_for(round_number,number,31) and
                row['studentOutput']['sampled'] is False and
                row['studentOutput']['summaryAdapterEnabledDuringGeneration'] is True and
                row['studentOutput']['semanticAdapterEnabledDuringGeneration'] is False and
                row['studentOutput']['mathAdapterEnabledDuringGeneration'] is False and
                row['studentOutput']['summaryStateHashDuringGeneration']==
                    note['studentOriginal']['studentOutput']['summaryStateHashDuringGeneration'],
                'Rating seed, policy or adapter route changed')
        else:require(row is None,'Invalid summary should not spend an additional rating generation')
        require(make_rating(note,row)==rating,'Student rating text, score, span or source changed')
    expected_references={};seen_activations=set();seen_calibrations=set()
    active=copy.deepcopy(initial['banks']);pending={b:None for b in BRANCHES};feedback={b:None for b in BRANCHES}
    object_map={o['id']:o for o in objects}
    update_map={u['id']:u for u in updates}
    roots=bank['originalKnowledgeRoots']

    def reference_for(note,task,role,identifier=None):
        if not note:return
        matching=[r for r in raws.values() if r.get('task')==task and r.get('summaryZipId')==note['id'] and
            'observation' in r['phase']]
        require(len(matching)==1,'Missing or duplicate actual ZIP observation')
        row=matching[0]
        require(identifier is None or identifier==row['recordId'],'Operative ZIP observation binding changed')
        require(row['studentPrompt']==observation_messages(task,roots,note) and
            row['samplingSeed']==seed_for(round_number,next(i for i,t in enumerate(plan['training']+plan['heldout'],1)
                if t['id']==task['id']),1) and row['studentOutput']['sampled'] is False,
            'ZIP reference uses another prompt, task or decoding mode')
        ref=literal_references(note,row,role);expected_references[ref['id']]=ref

    for number,task in enumerate(plan['training'],1):
        obj=object_map[task['id']]
        starting=copy.deepcopy(active)
        require(obj['sourceSummaryIdsByArm']=={BRANCHES[0]:starting[BRANCHES[0]],BRANCHES[1]:None} and
            obj['candidateSummaryIdsByBranch']=={b:pending[b] for b in BRANCHES} and
            obj['candidateTrialIsolatedFromOperativeReplay'] is True,
            'Pending candidate entered an operative context or source state changed')
        for b in BRANCHES:
            context=inherited[starting[b]] if b==BRANCHES[0] and starting[b] else None
            f=features[obj['featureIdsByArm'][b]]
            require(f['candidateCards']==candidate_cards(roots,context) and
                f['sourceObservationRecordId']==obj['observationRecordIdsByArm'][b],
                'Operative replay feature includes an unaccepted candidate')
            if context:reference_for(context,task,'operative_context',f['sourceObservationRecordId'])
            else:require(raws[f['sourceObservationRecordId']]['summaryZipId'] is None,
                'Plain operative path uses a candidate observation')
            critic_id=pending[b] or starting[b]
            critic=inherited[critic_id] if critic_id else None
            reference_for(critic,task,'candidate_trial' if pending[b] else 'accepted_context_review')
            update=update_map[b+'-'+str(number)];credit=update['delayedSummaryCredit']
            require(update['operativeSummaryZipId']==obj['sourceSummaryIdsByArm'][b] and
                update['candidateWasIsolatedFromOperativeReplay'] is True,'Operative update provenance changed')
            if credit:
                require(pending[b]==credit['sourceSummaryZipId'],'Credit belongs to an unplanned candidate')
                note=inherited[pending[b]]
                if credit['eligibleForRetention']:active[b]=note['id']
                expected=dict(id=note['id'],branch=b,summaryZipId=note['id'],decidedAfterTrainingTaskId=task['id'],
                    firstEligibleOperativeObjectNumber=number+1,activatedAfterTwoTrainingTests=credit['eligibleForRetention'],
                    priorAcceptedSummaryZipId=starting[b],activeAfterDecision=active[b],currentObjectDecisionUnchanged=True,
                    candidateFeatureEnteredOperativeReplay=False,usesHeldoutFeedback=False)
                require(activation_map.get(note['id'])==expected,'Candidate activation timing or previous context changed')
                expected_calibration=calibration_record(note,rating_map[note['id']],credit)
                require(numeric_same(calibration_map.get(note['id']),expected_calibration),
                    'Rating calibration entered heldout or changed its actual outcome')
                seen_activations.add(note['id']);seen_calibrations.add(note['id'])
                feedback[b]=dict(note=note,credit=credit,rating=rating_map[note['id']]);pending[b]=None
            if number in SUMMARY_WRITE_OBJECTS:
                note=note_by_source.get((task['id'],b));require(note is not None,'Missing scheduled original summary')
                history=dict(feedback[b],usage=usage_summary(feedback[b]['note'],list(expected_references.values()))) if feedback[b] else None
                require(note['event'].get('priorZipFeedback')==history,
                    'Summary writer received changed or future ZIP feedback')
                if note['audit']['eligibleForTrial']:pending[b]=note['id']
            require(update['pendingRewardMeasurements']==(1 if pending[b] and number not in SUMMARY_WRITE_OBJECTS else 0),
                'Saved pending measurement count changed')
    require(all(v is None for v in pending.values()),'Candidate test window incomplete')
    require(seen_activations==set(activation_map) and seen_calibrations==set(calibration_map),
        'Unbound or missing activation/calibration record')
    for review in retention_reviews:
        require(active[review['branch']]==review['summaryZipId'],'Final review belongs to a different active context')
        if not review['retainedForHeldout']:active[review['branch']]=None
    require(active==final['banks'],'Final accepted context changed')
    for task in plan['heldout']:
        obj=object_map[task['id']];identifier=final['banks'][BRANCHES[0]]
        require(obj['summaryZipId']==identifier,'Heldout ZIP context changed')
        reference_for(inherited[identifier] if identifier else None,task,'operative_context',
            obj['observationRecordIdsByArm'][BRANCHES[0]] if identifier else None)
    require(reference_map==expected_references,'Reference counts or source spans differ from actual student originals')


def inspect_training_source(folder):
    """Validate originals before any tokenizer/model import, including resumption."""
    folder = Path(folder).resolve(); result = read(folder/'result.json')
    require(result.get('fixtureOnly') is False and not result.get('fixtureGenerations') and
        not result.get('teacherCalls'), 'Fixture or teacher-backed source rejected before model import')
    protocol=result.get('protocol')
    if protocol not in (PROTOCOL,v3_core.PROTOCOL):
        return review_inherited_context(inspect_previous_source(folder))
    is_v4=protocol==PROTOCOL
    source_multi=multi_object_credit if is_v4 else v3_core.multi_object_credit
    source_credit=summary_credit if is_v4 else v3_core.summary_credit
    source_summarize=summarize if is_v4 else v3_core.summarize
    generation_cap=MAX_GENERATIONS if is_v4 else v3_core.MAX_GENERATIONS
    feature_cap=MAX_FEATURE_BATCHES if is_v4 else v3_core.MAX_FEATURE_BATCHES
    require(result['stopReason'] == 'completed' and result['error'] is None and
        result['completedTrainingObjects'] == TRAINING_OBJECTS and result['completedHeldoutObjects'] == HELDOUT_OBJECTS and
        result['coldReproductions'] == 8 and result['heldoutLearnedStateUnchanged'] is True and
        result['baseWeightsUnchanged'] is True and result['mathematicalWriterUnchanged'] is True and
        result['originalSemanticWriterUnchanged'] is True and result['originalFilesUnchanged'] is True,
        'Only a complete real frozen-checked summary run may resume')
    manifest = read(folder/'run-file-manifest.json')['files']
    actual = snapshot(folder)
    require(all(actual.get(name) == value for name,value in manifest.items()), 'Saved summary run file changed')
    require(set(actual)-set(manifest) <= {'run-file-manifest.json','result.json',
        'Lain-Zip-Summary-Training-Results.zip','Lain-Zip-Summary-Training-Review.zip'}, 'Untracked source file')
    base_source = inspect_source(folder/'foundation-originals')
    source_cp = read(folder/'source-checkpoint.json')
    require(source_cp['baseStateHash'] == base_source['result']['baseStateBefore'] and
        source_cp['mathematicalWriterStateHash'] == base_source['result']['mathematicalWriterStateHash'],
        'Continuation belongs to another base or mathematical checkpoint')
    bank = read(folder/'summary-zip-bank.json'); inherited = {}
    for identifier, expected in bank['zipByteHashes'].items():
        note = read_summary_zip(folder/'summary-zips', identifier, bank['zipByteHashes'])
        inherited[identifier] = note
    cp = read(folder/'checkpoints/final.json')
    require(cp['heads'] == result['finalHeads'] and cp['banks'] == bank['activeByBranch'] == result['finalBanks'],
        'Continuation bank or heads differ from final checkpoint')
    for branch in BRANCHES:
        restore_head(cp['heads'][branch])
        state = cp['summaryStates'][branch]
        require(Path(state['file']).name == state['file'] and sha(folder/'checkpoints'/state['file']) == state['fileSha256'],
            'Summary checkpoint file changed')
        if cp['banks'][branch]: require(cp['banks'][branch] in inherited, 'Active summary missing from bank')
    raws = {read(p)['recordId']:read(p) for p in (folder/'responses').glob('*-raw.json')}
    require(len(raws) == result['actualStudentGenerations'] <= generation_cap, 'Student original count differs')
    for row in raws.values():
        scored = read(folder/'responses'/(row['recordId']+'-scored.json')); value = row['studentOutput']
        require(row['fixtureOnly'] is False and not value.get('testDouble') and all(scored.get(k)==v for k,v in row.items()) and
            0 < value['generatedTokens'] == len(value['generatedIds']) == len(value['samplingTokenLogProbabilities']) <= MAX_TOKENS,
            'Original, provenance or token logs changed')
        if row['phase'] == 'route_math':
            from zip_label_feedback_audit import audit_math
            require(scored['check'] == audit_math(row['task'], value, row['selectedCandidate']), 'Original mathematics score changed')
    for path in (folder/'update').glob('*.json'):
        update = read(path); credit = update['delayedSummaryCredit']
        if credit:
            note = inherited[credit['sourceSummaryZipId']]
            require(numeric_same(credit,source_multi(note,credit['measurements'])),'Multi-object summary credit changed')
    plan=read(folder/'zip-summary-questions.json')
    object_map={read(p)['id']:read(p) for p in (folder/'object').glob('*.json')}
    require(set(object_map)=={t['id'] for t in plan['training']+plan['heldout']},'Completed source plan changed')
    objects=[object_map[t['id']] for t in plan['training']+plan['heldout']]
    trials=[read(p) for p in (folder/'trial').glob('*.json')]
    summaries=[read(p) for p in (folder/'summary').glob('*.json')]
    updates=[read(p) for p in (folder/'update').glob('*.json')]
    penalties=[read(p) for p in (folder/'penalty').glob('*.json')]
    retention_reviews=[read(p) for p in (folder/'summary-context-review').glob('*.json')]
    ratings=[read(p) for p in (folder/'summary-rating').glob('*.json')]
    references=[read(p) for p in (folder/'zip-reference').glob('*.json')]
    calibrations=[read(p) for p in (folder/'rating-calibration').glob('*.json')]
    activations=[read(p) for p in (folder/'summary-activation').glob('*.json')]
    for update in updates:
        credit=update['delayedSummaryCredit']
        if not credit:continue
        index=next(i for i,t in enumerate(plan['training'],1) if t['id']==credit['sourceTaskId'])
        require(index in SUMMARY_WRITE_OBJECTS and credit['rewardTaskIds']==
            [plan['training'][index+i]['id'] for i in range(REWARD_OBJECTS_PER_SUMMARY)],
            'Summary feedback does not use its prescheduled two later objects')
        measured=[u['summaryMeasurement'] for u in updates if u['branch']==update['branch'] and
            u['summaryMeasurement'] and u['summaryMeasurement']['sourceSummaryZipId']==credit['sourceSummaryZipId']]
        measured.sort(key=lambda m:m['rewardObjectNumber'])
        require(credit['measurements']==measured,'Combined feedback differs from the saved two measurements')
    require(len(objects)==TRAINING_OBJECTS+HELDOUT_OBJECTS and len(summaries)==2*SUMMARIES_PER_BRANCH and
        all(inherited[n['id']]==n for n in summaries), 'Completed object or original summary count changed')
    report=source_summarize(objects,trials,summaries,updates,penalties,retention_reviews,
        ratings,references,calibrations,activations) if is_v4 else source_summarize(objects,trials,summaries,updates,penalties,retention_reviews)
    # Ordering of bySummary is meaningful; filesystem glob order is not.
    if is_v4:
        order={n['summaryZipId']:i for i,n in enumerate(result['summary']['bySummary'])}
        report['bySummary'].sort(key=lambda n:order.get(n['summaryZipId'],-1))
    require(numeric_same(report,result['summary']), 'Saved summary statistics changed')
    # Replay selector updates from fixed original representations, not new model calls.
    from zip_label_grounded_checks import replay_item, guarded_head_update
    initial=read(folder/'checkpoints/initial.json'); heads={b:restore_head(initial['heads'][b]) for b in BRANCHES}
    replay={b:[] for b in BRANCHES}
    features={read(p)['id']:read(p) for p in (folder/'feature').glob('*.json')}
    require(len(features)==result['featureForwardBatches']<=feature_cap,'Feature count changed')
    for f in features.values():
        row=raws[f['sourceObservationRecordId']]
        require(f['task']==row['task'] and numeric_same(f['normalizedFeatures'],normalized_features(f['candidateHiddenVectors'])) and
            f['candidatePrompts']==[feature_messages(f['task'],row['studentOutput'],c) for c in f['candidateCards']] and
            all(f[k] is False for k in ('mathematicalAdapterEnabled','semanticAdapterEnabled','summaryAdapterEnabled')),
            'Saved feature prompt, source observation or normalized preimage changed')
    task_order=read(folder/'zip-summary-questions.json')['training']
    for number,task in enumerate(task_order,1):
        obj=next(o for o in objects if o['id']==task['id']); outcomes=obj['routeOutcomes']
        route_rows=[read(folder/'responses'/(rid+'-scored.json')) for rid in obj['sourceMathRecordIds']]
        require(outcomes==[int(r['check']['outcomePassed']) for r in route_rows] and all(r['task']==task for r in route_rows),
            'Training route originals differ')
        for b in BRANCHES:
            f=features[obj['featureIdsByArm'][b]]
            require(numeric_same(f['normalizedFeatures'],normalized_features(f['candidateHiddenVectors'])) and f['task']==task,
                'Frozen feature preimage changed')
            replay[b].append(replay_item(task,f['normalizedFeatures'],outcomes,f['id'],obj['sourceMathRecordIds']))
            update=next(u for u in updates if u['id']==b+'-'+str(number))
            require(heads[b].state()==update['headUpdate']['beforeState'],'Head before-state does not follow previous committed step')
            rebuilt_update=guarded_head_update(heads[b],replay[b],number)
            require(replay_update_matches(rebuilt_update,update['headUpdate']),'Saved head update cannot be replayed')
            heads[b]=restore_head(update['headUpdate']['afterState'])
            measurement=update['summaryMeasurement']
            if measurement:
                note=inherited[measurement['sourceSummaryZipId']]
                with_id=measurement['featureIds']['withSummary'];plain_id=measurement['featureIds']['without']
                plain=features[plain_id];noted=features[with_id]
                require(plain['task']==noted['task']==task and
                    plain['sourceObservationRecordId']==measurement['observationIds']['without'] and
                    noted['sourceObservationRecordId']==measurement['observationIds']['withSummary'] and
                    plain['candidateCards']==candidate_cards(bank['originalKnowledgeRoots']) and
                    noted['candidateCards']==candidate_cards(bank['originalKnowledgeRoots'],note) and
                    all(numeric_same(f['normalizedFeatures'],normalized_features(f['candidateHiddenVectors'])) for f in (plain,noted)),
                    'Reward feature pair does not bind both actual observations and the source summary')
                for context,identifier in measurement['observationIds'].items():
                    row=raws[identifier];note_context=note if context=='withSummary' else None
                    require(row['task']==task and row['samplingSeed']==measurement['pairedObservationSeed'] and
                        row['studentPrompt']==observation_messages(task,bank['originalKnowledgeRoots'],note_context) and
                        row['summaryZipId']==(note['id'] if note_context else None) and
                        row['studentOutput']['sampled'] is False and
                        row['studentOutput']['summaryAdapterEnabledDuringGeneration'] is False and
                        row['studentOutput']['semanticAdapterEnabledDuringGeneration'] is False and
                        row['studentOutput']['mathAdapterEnabledDuringGeneration'] is False,
                        'Full reuse pair changed its actual prompt, decoding, seed or adapter route')
                # The pair was evaluated before this object's head update.
                before_head=restore_head(update['headUpdate']['beforeState'])
                from zip_label_grounded_core import expected_pass
                rebuilt=source_credit(note,task,expected_pass(before_head,plain['normalizedFeatures'],outcomes)[0],
                    expected_pass(before_head,noted['normalizedFeatures'],outcomes)[0],measurement['featureIds'],
                    measurement['observationIds'],measurement['pairedObservationSeed'])
                rebuilt.update(rewardObjectNumber=number,rewardTaskFamily=task['family'],
                    sourceMathRecordIds=obj['sourceMathRecordIds'])
                if is_v4:rebuilt['rewardTaskExpression']=task['expression']
                require(numeric_same(rebuilt,measurement),'Reward measurement differs from original routes, features or head')
    require({b:h.state() for b,h in heads.items()}==cp['heads'],'Final head does not match actual saved updates')
    for review in retention_reviews:
        require(review['usesTrainingEvidenceOnly'] is True and review['writerUpdatedAgain'] is False,
            'Final context review entered heldout or wrote a second word update')
        if review['measurements']:
            cases=[]
            for m in review['measurements']:
                obj=object_map[m['taskId']];require(obj['phase']=='training','Heldout context selection rejected')
                plain=features[m['featureIds']['without']];noted=features[m['featureIds']['withSummary']]
                note=inherited[review['summaryZipId']]
                require(plain['task']==noted['task']==obj['task'] and
                    plain['candidateCards']==candidate_cards(bank['originalKnowledgeRoots']) and
                    noted['candidateCards']==candidate_cards(bank['originalKnowledgeRoots'],note),
                    'Final context guard representation belongs to another note or task')
                cases.append(dict(task=obj['task'],without=plain['normalizedFeatures'],
                    withSummary=noted['normalizedFeatures'],outcomes=obj['routeOutcomes'],
                    featureIds=m['featureIds'],sourceMathRecordIds=obj['sourceMathRecordIds']))
            require(numeric_same(review,retention_review(note,cases,heads[review['branch']])),'Final training context guard changed')
        else:require(review['retainedForHeldout'] is False,'Missing guard evidence cannot retain a summary')
    for b,identifier in cp['banks'].items():
        if identifier:
            require(any(r['branch']==b and r['summaryZipId']==identifier and r['retainedForHeldout']
                for r in retention_reviews),'Active summary lacks a final TRAIN-only full-path guard')
    steps=[read(p) for p in (folder/'summary-step').glob('*.json')]
    require(len(steps)==result['summaryOptimizerUpdates']<=2*SUMMARIES_PER_BRANCH,'Summary optimizer count changed')
    for row in steps:
        require(Path(row['file']).name==row['file'] and sha(folder/'checkpoints'/row['file'])==row['fileSha256'] and
            row['policyUpdate']['updated'] is True and row['sourceSummaryZipId'] in inherited,
            'Committed summary step file or source changed')
    for obj in (o for o in objects if o['phase']=='heldout'):
        outcomes=obj['routeOutcomes']
        actual_routes=[read(folder/'responses'/(rid+'-scored.json')) for rid in obj['sourceMathRecordIds']]
        require(outcomes==[int(r['check']['outcomePassed']) for r in actual_routes] and
            all(r['task']==obj['task'] for r in actual_routes),'Heldout route original changed')
        for arm in EVALUATION_ARMS:
            f=features[obj['featureIdsByArm'][arm]]
            h=(heads[arm] if arm in BRANCHES else heads[BRANCHES[0]] if arm==EVALUATION_ARMS[2] else
                restore_head(initial['heads'][BRANCHES[0] if arm==EVALUATION_ARMS[3] else BRANCHES[1]]))
            from zip_label_grounded_core import expected_pass
            computed=expected_pass(h,normalized_features(f['candidateHiddenVectors']),outcomes)[0]
            require(abs(computed-obj['expectedPassByArm'][arm])<=1e-12,'Heldout successful-route probability changed')
    if is_v4:inspect_v4_context_flow(plan,objects,updates,summaries,ratings,references,calibrations,activations,
        raws,features,initial,cp,bank,retention_reviews,inherited,result['trainingRound'])
    return review_inherited_context(dict(base=base_source, parent=folder, parentHashes=actual, initialHeads=cp['heads'],
        initialBanks=cp['banks'], summaryFiles={b:folder/'checkpoints'/cp['summaryStates'][b]['file'] for b in BRANCHES},
        summaryStateHashes={b:cp['summaryStates'][b]['stateHash'] for b in BRANCHES}, inherited=inherited))


def next_number(work):
    values = []
    for path in Path(work).glob('zip-summary-training-*/protocol.json'):
        row = read(path)
        if row.get('protocol') in (PREVIOUS_PROTOCOL,PROTOCOL,v3_core.PROTOCOL,'lain-zip-experience-summary-training-v1'):
            n = row['trainingRound']; require(type(n) is int and 1 <= n <= 1000, 'Invalid reserved summary round')
            values.append(n)
    value = max(values, default=0)+1
    require(value <= 1000, 'Summary seed namespace exhausted')
    return value


def prepare_inputs(student, plan, roots):
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(student, local_files_only=True)
    limits = input_limits(read(Path(student)/'config.json'), tokenizer); rows = []
    placeholder = dict(id='[not yet generated]', studentRaw='[not yet generated]', audit=dict(eligibleForTrial=True))
    for task in plan['training'] + plan['heldout']:
        for note in (None, placeholder):
            audit = prompt_audit(tokenizer, observation_messages(task, roots, note), limits)
            rows.append(dict(kind='observation', taskId=task['id'], audit=audit,
                planningReserve=4*MAX_TOKENS if note else 0))
        for candidate in candidate_cards(roots, placeholder):
            prompt = feature_messages(task, dict(raw='[not yet generated]'), candidate)
            audit = prompt_audit(tokenizer, prompt, limits)
            rows.append(dict(kind='feature', taskId=task['id'], audit=audit, planningReserve=8*MAX_TOKENS))
        for candidate in candidate_cards(roots):
            audit = prompt_audit(tokenizer, math_messages(task, candidate, roots), limits)
            rows.append(dict(kind='math', taskId=task['id'], audit=audit, planningReserve=0))
        if task['split'] == 'training':
            from zip_label_feedback_audit import audit_math
            route_shapes=[]
            for index,candidate in enumerate(candidate_cards(roots),1):
                output=dict(raw='[student original not yet generated]',tokenCapReached=False)
                route_shapes.append(dict(recordId='shape-route-'+str(index),studentOutput=output,
                    selectedCandidate=candidate,check=audit_math(task,output,candidate)))
            shape=dict(task=task,observation=dict(studentOutput=dict(raw='[student observation not yet generated]')),
                routes=route_shapes,selectedRouteRecordId='shape-route-1')
            audit=prompt_audit(tokenizer,summary_messages(shape),limits)
            rows.append(dict(kind='summary',taskId=task['id'],audit=audit,planningReserve=16*MAX_TOKENS))
            prompt=rating_prompt(task,'[student summary not yet generated]',False)
            rows.append(dict(kind='quality-assessment',taskId=task['id'],
                audit=prompt_audit(tokenizer,prompt,limits),planningReserve=8*MAX_TOKENS))
    for row in rows:
        require_input(row['audit'])
        require(row['audit']['inputTokens'] + row['planningReserve'] <= limits['maxInputTokens'],
            'Planned summary context exceeds limit; no silent truncation')
    return tokenizer, limits, dict(tokenizerOnly=True, modelWeightsLoaded=False, rows=rows,
        allShapesFit=True, everyActualInputRechecked=True, planningPlaceholderNotStudentText=True)


def run(args):
    started = time.monotonic(); progress = StageProgress(os.environ.get('ZIP_SUMMARY_PROGRESS_FILE'))
    resume = inspect_training_source(args.source); foundation = resume['base']; foundation_path = Path(foundation['folder'])
    original_parent = args.source.resolve()
    require(not args.out.resolve().is_relative_to(original_parent) and not original_parent.is_relative_to(args.out.resolve()),
        'Output overlaps source')
    base_choice = Path(read(foundation_path/'source-checkpoint.json')['baseChoiceSource']).resolve()
    checked = preflight(SimpleNamespace(source=base_choice, student=args.student, old_tools=args.old_tools, out=args.out))
    require(foundation['result']['mathematicalWriterStateHash'] == checked['checkpoint']['writerStateHash'], 'Math source differs')
    roots = copy.deepcopy(foundation['bank']['mathematicalRoots']); number = next_number(args.work)
    archives = [p for p in args.work.glob('zip-*') if p.is_dir() and
        ((p/'result.json').is_file() or list(p.glob('*questions.json')))]
    for path in (original_parent, foundation_path, base_choice):
        if path not in archives: archives.append(path)
    excluded, freshness = archived_inputs(archives); full_plan = make_plan(excluded, roots)
    plan = dict(full_plan, training=full_plan['training'][:TRAINING_OBJECTS], trainingObjects=TRAINING_OBJECTS,
        reservedUnusedTraining=full_plan['training'][TRAINING_OBJECTS:])
    args.out.mkdir(parents=True, exist_ok=False); checkpoint_folder=args.out/'checkpoints'; checkpoint_folder.mkdir()
    zip_folder=args.out/'summary-zips'; zip_folder.mkdir()
    for relative, expected in foundation['sourceHashes'].items():
        if Path(relative).suffix == '.zip': continue
        source=foundation_path/relative; require(sha(source)==expected, 'Foundation changed while exporting')
        target=args.out/'foundation-originals'/relative; target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())
    for path in Path(__file__).resolve().parent.glob('*.py'):
        target=args.out/'evaluation-code'/path.name; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(path.read_bytes())
    write_once(args.out/'zip-summary-questions.json', plan)
    write_once(args.out/'roots.json', roots)
    write_once(args.out/'inherited-summary-context-review.json',resume['inheritedContextReviews'])
    write_once(args.out/'protocol.json', dict(protocol=PROTOCOL, trainingRound=number, foundationSource=str(foundation_path),
        maximumGenerations=MAX_GENERATIONS, maximumTokens=MAX_TOKENS, maximumFeatureBatches=MAX_FEATURE_BATCHES,
        newTrainingObjects=TRAINING_OBJECTS, newHeldoutObjects=HELDOUT_OBJECTS,
        summaryWriteOpportunitiesPerBranch=SUMMARIES_PER_BRANCH, summaryOptimizerStepCapPerBranch=SUMMARIES_PER_BRANCH,
        headStepOpportunitiesPerBranch=TRAINING_OBJECTS, maximumTotalSeconds=1200, historyFreshness=freshness,
        originalLabelsUsedInNewPrompts=False, originalSemanticAndInterfaceDisabled=True,
        summaryAdapterEnabledOnlyForSummaryWritingAndQualityAssessment=True,
        summaryInitialization='zero additive output or saved summary continuation',
        initialBranchHeadHashes={b:resume['initialHeads'][b]['parameterHash'] for b in BRANCHES},
        initialHeadsIdentical=resume['initialHeads'][BRANCHES[0]]==resume['initialHeads'][BRANCHES[1]],
        branchesContinueTheirOwnPriorState=True,bothPreRoundHeadsFrozenForSameNewObjects=True,
        automaticSourceBinding=True, teacherCalls=0, numericMetricTableSupplied=False,
        hostWritesStudentSummary=False, forcedSelfReflection=False, correctMathTargetsSupplied=False,
        fullReuseTrainingCriticReadsSealedSummaries=True, ordinarySealedTaskDoesNotReadSummary=True,
        trainingAndHeldoutObservationDecodingMode='greedy',
        pairedRewardIncludesObservationGenerationAndCards=True,
        sharedNoSummaryObservationAndFeatureBaseline=True,
        sameOpportunityBudgetsNotGuaranteedSameNumberOfNonzeroUpdates=True,
        knownFalseFactsAndCompletionPenaltiesSeparateFromLaterUsefulnessReward=True,
        summaryWritingTrainingPositions=list(SUMMARY_WRITE_OBJECTS),
        rewardObjectsPerEligibleNewSummary=REWARD_OBJECTS_PER_SUMMARY,
        summaryWriterFrozenUntilTwoRewardObjectsComplete=True,
        candidateTrialIsolatedFromOperativeTaskAndReplay=True,
        acceptedContextChangesOnlyAfterTwoTrainingTests=True,
        studentQualityAssessmentsOptionalNumericScore=True,
        positiveWordRewardFromCitationCount=False,positiveWordRewardFromSelfRating=False,
        programContextUsesSeparatedFromStudentReferences=True,autonomousZipRetrievalTested=False,
        candidateRegressionLeavesPreviouslyAcceptedContextUnchanged=True,
        positiveCreditRequiresNoLossOnEitherScheduledStructure=True,
        finalRetentionUsesTrainingEvidenceUnderFinalHead=True,
        shortSentenceIsPromptInstructionNotGrammarForcing=True,
        inheritedContextRecheckedWithoutChangingOldScores=True,heldoutTrainingUpdates=0))
    zip_hashes = {}; zip_reads = []
    for identifier, note in resume['inherited'].items(): zip_hashes[identifier] = write_summary_zip(zip_folder, note)
    write_once(args.out/'source-checkpoint.json', dict(baseChoiceSource=str(base_choice), parentSource=str(original_parent),
        baseStateHash=foundation['result']['baseStateBefore'], mathematicalWriterStateHash=checked['checkpoint']['writerStateHash'],
        foundationResultSha256=sha(foundation_path/'result.json'), originalWriterFile=str(checked['writer']),
        originalWriterFileSha256=sha(checked['writer']), parentResultSha256=sha(original_parent/'result.json')))
    deadline = time.monotonic()+max(0.,float(os.environ.get('ZIP_SUMMARY_DEADLINE',str(time.time()+1200)))-time.time())
    calls=feature_calls=0; raw=[]; scored=[]; objects=[]; updates=[]; penalties=[]; notes=[]; trials=[]; steps=[];retention_reviews=[]
    ratings=[];references=[];calibrations=[];activations=[]
    base=mathematical=semantic=writer=None; base_before=math_before=semantic_before=None
    states={}; state_hashes={}; branch=BRANCHES[0]; installed=None; heldout_before=None; heldout_ok=None
    course={}; final_heads=copy.deepcopy(resume['initialHeads']); final_banks=copy.deepcopy(resume['initialBanks'])
    protected_ok=None; stop='completed'; error=None

    def save(kind,row):
        path=args.out/'responses'/(row['recordId']+'-'+kind+'.json') if kind in ('raw','scored') else args.out/kind/(row['id']+'.json')
        write_once(path,row)
        collection={'raw':raw,'scored':scored,'object':objects,'update':updates,'penalty':penalties,
            'summary':notes,'trial':trials,'summary-step':steps,'summary-context-review':retention_reviews,
            'summary-rating':ratings,'zip-reference':references,'rating-calibration':calibrations,
            'summary-activation':activations}.get(kind)
        if collection is not None: collection.append(copy.deepcopy(row))
        progress.mark(rawResponsesSaved=len(raw),scoredResponses=len(scored),featureForwardBatches=feature_calls,
            completeNewObjects=len(objects),summaryUpdates=len(steps),studentSummaries=len(notes),
            usableSummaryZips=sum(n['audit']['eligibleForTrial'] for n in notes),
            qualityAssessments=sum(r['sourceRatingRecordId'] is not None for r in ratings),
            candidateActivations=sum(r['activatedAfterTwoTrainingTests'] for r in activations),
            choiceHeadUpdates=sum(u['headUpdate']['updated'] for u in updates),generationAttempts=calls,inFlight=None)

    def store(note):
        zip_hashes[note['id']]=write_summary_zip(zip_folder,note)
        write_once(args.out/'zip-byte-manifest'/(note['id']+'.json'),dict(id=note['id'],sha256=zip_hashes[note['id']]))

    def read_note(identifier):
        note=read_summary_zip(zip_folder,identifier,zip_hashes)
        row=dict(id='zip-read-'+str(len(zip_reads)+1).zfill(3),summaryZipId=identifier,zipSha256=zip_hashes[identifier],
            branch=note['branch'],installedSummaryWriterBranch=branch,
            phase='heldout' if heldout_before is not None else 'training',nativeZipActuallyRead=True,
            readingAloneDoesNotCertifyOperativeUse=True)
        zip_reads.append(row);write_once(args.out/'zip-read'/ (row['id']+'.json'),row)
        return note

    def timeout(signum,frame): raise TimeoutError('Summary-training twenty-minute total deadline')
    old_term=signal.signal(signal.SIGTERM,timeout);old_alarm=signal.signal(signal.SIGALRM,timeout)
    signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
    try:
        progress.mark('只加载 tokenizer；预检新题、总结上下文及候选特征长度')
        _, limits, inputs=prepare_inputs(args.student,plan,roots);write_once(args.out/'prompt-length-preflight.json',inputs)
        progress.mark('加载冻结原数学学生；接续各分支的独立总结写作状态')
        import torch
        from safetensors.torch import load_file,save_file
        from zip_pilot import load_student
        from zip_pilot_model import state_digest
        from math_writer_adapter import MathWriterAdapter
        base,tokenizer,metadata=load_student(args.student,'cpu')
        require(metadata['snapshotSha256']==checked['identity']['snapshotSha256'],'Student snapshot differs')
        base_before=state_digest(base);require(base_before==foundation['result']['baseStateBefore'],'Base weights differ')
        mathematical=MathWriterAdapter(base,rank=8,last_layers=4,alpha=16)
        mathematical.restore(load_file(str(checked['writer'])));math_before=mathematical.digest()
        require(math_before==checked['checkpoint']['writerStateHash'],'Original math writer differs')
        semantic=MathWriterAdapter(base,rank=8,last_layers=4,alpha=16)
        semantic.restore(load_file(str(foundation_path/'checkpoints'/foundation['final']['semanticFile'])))
        semantic_before=semantic.digest();require(semantic_before==foundation['final']['semanticStateHash'],'Original semantic state differs')
        torch.manual_seed(seed_for(number,0,1));writer=MathWriterAdapter(base,rank=8,last_layers=4,alpha=16)
        base.eval().requires_grad_(False);mathematical.eval();semantic.eval();writer.eval()
        for adapter in (mathematical,semantic,writer):
            for p in adapter.parameters_to_train():p.requires_grad_(False);p.grad=None
        zero=writer.learned_state();require(all(torch.count_nonzero(v).item()==0 for k,v in zero.items() if k.endswith('b.weight')),
            'Fresh summary adapter is not an exact zero addition')
        for b in BRANCHES:
            if resume['summaryFiles'][b]:
                writer.restore(load_file(str(resume['summaryFiles'][b])))
                require(writer.digest()==resume['summaryStateHashes'][b],'Resumed summary state differs')
            else: writer.restore(zero)
            states[b]=writer.learned_state();state_hashes[b]=writer.digest()
        writer.restore(states[branch]);installed=writer.digest()
        optimizer=torch.optim.SGD(writer.parameters_to_train(),lr=SUMMARY_LEARNING_RATE)
        write_once(args.out/'observed-model-identity.json',dict(snapshotSha256=metadata['snapshotSha256'],baseStateHash=base_before,
            mathematicalWriterStateHash=math_before,originalSemanticStateHash=semantic_before,initialSummaryStates=state_hashes,
            summaryAdapterRank=8,lastLayers=4,alpha=16,initialSummaryAdditiveOutputZero=resume['parent'] is None,
            summaryLearningRate=SUMMARY_LEARNING_RATE,optimizer='SGD without momentum',device='cpu'))

        def frozen():
            require(not base.training and all(not a.training and a.enabled for a in (mathematical,semantic,writer)) and
                all(not p.requires_grad and p.grad is None for p in list(base.parameters())+
                    mathematical.parameters_to_train()+semantic.parameters_to_train()+writer.parameters_to_train()),
                'Frozen flags or leaked gradients changed')
            require(mathematical.digest()==math_before and semantic.digest()==semantic_before and writer.digest()==installed,
                'Adapter state changed outside a recorded transition')

        def select(b):
            nonlocal branch,installed
            frozen();require(b in BRANCHES,'Unknown summary branch')
            if b != branch:
                writer.restore(states[b]);branch=b;installed=writer.digest()
            require(installed==state_hashes[b],'Installed branch state differs');frozen()

        def ask(phase,messages,seed,*,mode,sampled=False,**context):
            nonlocal calls
            require(calls<MAX_GENERATIONS and mode in ('math','summary','observation'),'Generation budget or mode differs')
            if time.monotonic()>=deadline:raise TimeoutError('Deadline before generation')
            frozen();audit=prompt_audit(tokenizer,messages,limits)
            write_once(args.out/'prompt-inputs'/(str(calls+1)+'-'+phase+'.json'),dict(phase=phase,
                studentPrompt=messages,samplingSeed=seed,audit=audit,modelForwardStarted=False))
            require_input(audit);calls+=1;begin=time.monotonic()
            progress.mark('学生生成 '+str(calls)+'/'+str(MAX_GENERATIONS)+'：'+phase+' | '+branch,generationAttempts=calls,
                inFlight=dict(phase=phase,branch=branch))
            math_enabled=bool(context.get('coldMathEnabled',True)) if mode=='math' else False
            with mathematical.active(math_enabled),semantic.active(False),writer.active(mode=='summary'):
                value=generate(base,tokenizer,messages,'experience_review',seed,sampled,input_audit=audit)
                value.update(mathAdapterEnabledDuringGeneration=mathematical.enabled,
                    semanticAdapterEnabledDuringGeneration=semantic.enabled,summaryAdapterEnabledDuringGeneration=writer.enabled,
                    summaryStateHashDuringGeneration=writer.digest(),generationMode=mode)
            row=dict(recordId='summary-call-'+str(calls).zfill(3),phase=phase,studentPrompt=copy.deepcopy(messages),
                studentOutput=value,samplingSeed=seed,fixtureOnly=False,generationSeconds=time.monotonic()-begin,**context)
            save('raw',row);frozen()
            ids=value['generatedIds'];logs=value['samplingTokenLogProbabilities']
            eos=base.generation_config.eos_token_id
            if eos is None:eos=tokenizer.eos_token_id
            stops=set(eos if isinstance(eos,list) else [eos])-{None}
            require(not value.get('testDouble') and 0<value['generatedTokens']==len(ids)==len(logs)<=MAX_TOKENS and
                value['promptIds']==audit['promptIds'] and tokenizer.decode(ids,skip_special_tokens=True)==value['raw'] and
                all(type(i) is int and i>=0 for i in ids) and all(math.isfinite(x) for x in logs) and
                abs(sum(logs)-value['samplingLogProbability'])<=1e-10 and
                value['sampled'] is sampled and (value['stopReason']=='eos')==(ids[-1] in stops) and
                value['mathAdapterEnabledDuringGeneration']==math_enabled and
                value['semanticAdapterEnabledDuringGeneration'] is False and
                value['summaryAdapterEnabledDuringGeneration']==(mode=='summary') and
                value['summaryStateHashDuringGeneration']==installed,
                'Raw student provenance, actual stops, token logs or adapter route differs')
            return row

        def feature(task,observation,cards):
            nonlocal feature_calls
            require(feature_calls<MAX_FEATURE_BATCHES,'Feature budget exceeded')
            if time.monotonic()>=deadline:raise TimeoutError('Deadline before feature forward')
            frozen();feature_calls+=1
            prompts=[feature_messages(task,observation['studentOutput'],c) for c in cards]
            audits=[prompt_audit(tokenizer,p,limits) for p in prompts]
            for audit in audits:require_input(audit)
            sequences=[a['promptIds'] for a in audits]
            pad=tokenizer.pad_token_id if tokenizer.pad_token_id is not None else tokenizer.eos_token_id
            require(type(pad) is int,'No actual padding token')
            length=max(map(len,sequences));device=next(base.parameters()).device
            ids=torch.tensor([s+[pad]*(length-len(s)) for s in sequences],device=device)
            masks=torch.tensor([[1]*len(s)+[0]*(length-len(s)) for s in sequences],device=device)
            progress.mark('冻结特征批 '+str(feature_calls)+'/'+str(MAX_FEATURE_BATCHES)+'：'+task['expression'])
            with mathematical.active(False),semantic.active(False),writer.active(False),torch.no_grad():
                hidden=base.model(input_ids=ids,attention_mask=masks,use_cache=False,return_dict=True).last_hidden_state
                vectors=[hidden[i,len(s)-1].detach().float().cpu().tolist() for i,s in enumerate(sequences)]
            row=dict(id='summary-feature-'+str(feature_calls).zfill(3),task=copy.deepcopy(task),
                sourceObservationRecordId=observation['recordId'],candidateCards=copy.deepcopy(cards),candidatePrompts=prompts,
                promptIds=sequences,candidateHiddenVectors=vectors,normalizedFeatures=normalized_features(vectors),
                mathematicalAdapterEnabled=False,semanticAdapterEnabled=False,summaryAdapterEnabled=False)
            save('feature',row);frozen();return row['normalizedFeatures'],row['id']

        def learn(note,credit,reason):
            nonlocal installed
            require(heldout_before is None and note['branch']==branch and note['event']['task']['split']=='training' and
                credit['rewardObjectSplit']=='training' and len([s for s in steps if s['branch']==branch])<SUMMARIES_PER_BRANCH,
                'Heldout, wrong branch or summary update cap')
            require(reason=='original_rejection_penalty' or
                (reason=='multiple_later_training_objects' and credit==multi_object_credit(note,credit['measurements'])),
                'Word update requires the full two-object feedback window or a separate factual/completion penalty')
            validate_summary(note);value=note['studentOriginal']['studentOutput'];frozen()
            require(value['sampled'] is True and value['summaryAdapterEnabledDuringGeneration'] is True and
                value['mathAdapterEnabledDuringGeneration'] is False and value['semanticAdapterEnabledDuringGeneration'] is False and
                value['summaryStateHashDuringGeneration']==installed,'Sampled summary came from another policy; no update')
            before=writer.learned_state();before_hash=installed
            try:
                for p in writer.parameters_to_train():p.requires_grad_(True)
                with mathematical.active(False),semantic.active(False),writer.active(True):
                    update=update_words(base,writer,optimizer,[value],[credit['advantage']],MAX_TOKENS)
                require(all(torch.isfinite(p).all().item() for p in writer.parameters_to_train()),'Nonfinite summary state')
                after_hash=writer.digest()
                if update['updated']:
                    row=dict(id=branch+'-'+str(len(steps)+1).zfill(3),branch=branch,sourceSummaryZipId=note['id'],
                        sourceWordRecordId=note['sourceRecordId'],credit=copy.deepcopy(credit),reason=reason,
                        beforeHash=before_hash,afterHash=after_hash,optimizer='SGD without momentum',
                        learningRate=SUMMARY_LEARNING_RATE,parameterChanged=after_hash!=before_hash,policyUpdate=update)
                    file=row['id']+'.safetensors'
                    with checkpoint_boundary():
                        save_file(writer.learned_state(),str(checkpoint_folder/file))
                        row.update(file=file,fileSha256=sha(checkpoint_folder/file));save('summary-step',row)
                        states[branch]=writer.learned_state();state_hashes[branch]=installed=after_hash
                update.update(beforeHash=before_hash,afterHash=after_hash,credit=credit,sourceSummaryZipId=note['id'],reason=reason)
            except BaseException:
                writer.restore(before);installed=before_hash;raise
            finally:
                optimizer.zero_grad(set_to_none=True)
                for p in writer.parameters_to_train():p.grad=None;p.requires_grad_(False)
            frozen();return update

        def checkpoint(label,heads,banks):
            nonlocal final_heads,final_banks,heldout_before
            frozen();state_rows={}
            with checkpoint_boundary():
                for b in BRANCHES:
                    file=label+'-'+b+'.safetensors';save_file(states[b],str(checkpoint_folder/file))
                    state_rows[b]=dict(file=file,fileSha256=sha(checkpoint_folder/file),stateHash=state_hashes[b])
                row=dict(protocol=PROTOCOL,label=label,heads=copy.deepcopy(heads),banks=copy.deepcopy(banks),
                    summaryStates=state_rows,baseStateHash=base_before,mathematicalWriterStateHash=math_before)
                write_once(checkpoint_folder/(label+'.json'),row)
                final_heads=copy.deepcopy(heads);final_banks=copy.deepcopy(banks)
                if label=='training-final':heldout_before=copy.deepcopy(state_hashes)

        for n,old in enumerate(checked['anchors'],1):
            row=ask('cold_replay',old['studentPrompt'],old['samplingSeed'],mode='math',sampled=False,
                task=old['task'],coldNumber=n,sourceRecordId=old['recordId'],coldMathEnabled=old['requestedMathAdapterEnabled'])
            match=exact_reproduction(old['studentOutput'],row['studentOutput'])
            save('scored',dict(row,check=dict(exactReproduction=match)))
            require(match['exact'],'Original math writer failed exact reproduction; no new training')
            progress.mark(coldReproductions=n)
        course=run_course(plan,roots,resume['initialHeads'],ask,feature,save,learn,select,store,read_note,checkpoint,
            deadline,number,resume['initialBanks'])
        heldout_ok=state_hashes==heldout_before
        require(heldout_ok,'Heldout changed summary parameters')
    except Exception as exc:
        stop='time_budget' if isinstance(exc,TimeoutError) else 'error';error=type(exc).__name__+': '+str(exc)
        write_once(args.out/'error.json',dict(error=error,traceback=traceback.format_exc(),generationAttempts=calls))
        print('保留已完成训练与原文；停止：'+error,flush=True)
    finally:
        signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,old_alarm);signal.signal(signal.SIGTERM,old_term)
        base_after=math_after=semantic_after=None
        try:
            protected_ok=(snapshot(foundation_path)==foundation['sourceHashes'] and
                (resume['parentHashes'] is None or snapshot(original_parent)==resume['parentHashes']) and
                snapshot(base_choice)==checked['inspection']['sourceFileHashes'] and
                all(sha(Path(p))==h for p,h in checked['protected'].items()) and snapshot(args.old_tools)==checked['toolFiles'])
            require(protected_ok,'Protected original files changed')
            base_after=state_digest(base) if base is not None else None
            math_after=mathematical.digest() if mathematical is not None else None
            semantic_after=semantic.digest() if semantic is not None else None
            if base_before is not None:require(base_before==base_after and math_before==math_after and semantic_before==semantic_after,
                'Frozen original model state changed')
        except Exception as exc:
            stop='error';error=(error+'; ' if error else '')+str(exc)
        for adapter in (writer,semantic,mathematical):
            if adapter is not None:adapter.close()
    write_once(args.out/'summary-zip-bank.json',dict(protocol=PROTOCOL,activeByBranch=final_banks,zipByteHashes=zip_hashes,
        allNewStudentSummaries=[n['id'] for n in notes],nativeZipReads=len(zip_reads),originalKnowledgeRoots=roots,
        explanationsRemainHypotheses=True,oldProductionBankUnchanged=True))
    report=summarize(objects,trials,notes,updates,penalties,retention_reviews,ratings,references,calibrations,activations)
    result=dict(protocol=PROTOCOL,trainingRound=number,stopReason=stop,error=error,fixtureOnly=False,fixtureGenerations=0,
        teacherCalls=0,actualStudentGenerations=len(raw),generationAttempts=calls,rawResponsesSaved=len(raw),scoredResponses=len(scored),
        featureForwardBatches=feature_calls,completedTrainingObjects=sum(o['phase']=='training' for o in objects),
        completedHeldoutObjects=sum(o['phase']=='heldout' for o in objects),
        coldReproductions=sum(r['phase']=='cold_replay' and r['check']['exactReproduction']['exact'] for r in scored),
        trainingUpdates=len(steps)+sum(u['headUpdate']['updated'] for u in updates),summaryOptimizerUpdates=len(steps),
        summaryParametersChangedByBranch={b:any(s['parameterChanged'] for s in steps if s['branch']==b) for b in BRANCHES},
        finalHeads=final_heads,finalBanks=final_banks,studentWrittenSummaryZips=len(notes),
        usableSummaryZips=sum(n['audit']['eligibleForTrial'] for n in notes),actualNativeSummaryZipReads=len(zip_reads),
        retainedActiveSummaryZips=sum(bool(n) for n in final_banks.values()),
        inheritedSummariesExcludedFromNewContext=sum(not r['retainedForNewTaskContext']
            for r in resume['inheritedContextReviews'].values()),
        modelWeightsLoaded=base is not None,
        baseWeightsUnchanged=state_unchanged(base_before,base_after),
        mathematicalWriterUnchanged=state_unchanged(math_before,math_after),
        originalSemanticWriterUnchanged=state_unchanged(semantic_before,semantic_after),
        originalFilesUnchanged=protected_ok,heldoutLearnedStateUnchanged=heldout_ok,heldoutTrainingUpdates=0,
        completeTrainingExperiment=stop=='completed' and len(objects)==TRAINING_OBJECTS+HELDOUT_OBJECTS,
        summary=report,elapsedSeconds=time.monotonic()-started,fullAutonomousLearningProved=False)
    write_once(args.out/'result.json',result)
    write_once(args.out/'run-file-manifest.json',dict(files={k:v for k,v in snapshot(args.out).items() if k!='result.json'}))
    for name,small in (('Lain-Zip-Summary-Training-Results.zip',False),('Lain-Zip-Summary-Training-Review.zip',True)):
        with zipfile.ZipFile(args.out/name,'x',zipfile.ZIP_DEFLATED) as z:
            for path in sorted(args.out.rglob('*')):
                if not path.is_file() or path.name.startswith('Lain-Zip-Summary-Training-'):continue
                rel=path.relative_to(args.out)
                if small and (rel.parts[0]=='foundation-originals' or path.suffix=='.safetensors'):continue
                z.write(path,rel)
    print('总结 ZIP 训练摘要：'+json.dumps(report,ensure_ascii=False),flush=True)
    print('完整性：'+json.dumps({k:result[k] for k in ('stopReason','error','actualStudentGenerations','trainingUpdates',
        'summaryOptimizerUpdates','studentWrittenSummaryZips','usableSummaryZips','actualNativeSummaryZipReads','modelWeightsLoaded',
        'baseWeightsUnchanged','mathematicalWriterUnchanged','originalSemanticWriterUnchanged','heldoutLearnedStateUnchanged','originalFilesUnchanged')},ensure_ascii=False),flush=True)
    print('完整结果：'+str(args.out/'Lain-Zip-Summary-Training-Results.zip'),flush=True)
    return 0 if stop=='completed' else 1


def main():
    parser=argparse.ArgumentParser()
    for name in ('source','work','student','old-tools','out'):parser.add_argument('--'+name,type=Path)
    parser.add_argument('--inspect-only',action='store_true');args=parser.parse_args()
    require(args.source is not None,'Source required')
    if args.inspect_only:
        resume=inspect_training_source(args.source)
        print(json.dumps(dict(sourceProtocol=resume['base']['result']['protocol'],resumeSummaryTraining=resume['parent'] is not None,
            independentBranches=list(BRANCHES),originalRoots=len(resume['base']['bank']['mathematicalRoots']),
            studentGenerations=0,trainingUpdates=0,modelNotLoaded=True),ensure_ascii=False));return 0
    require(all(getattr(args,n) is not None for n in ('work','student','old_tools','out')),'Original Notebook paths required')
    return run(args)


if __name__=='__main__':raise SystemExit(main())
