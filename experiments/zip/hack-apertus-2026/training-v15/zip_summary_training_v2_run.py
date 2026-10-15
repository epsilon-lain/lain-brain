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
from zip_summary_training_v2_core import (PROTOCOL, BRANCHES, EVALUATION_ARMS, TRAINING_OBJECTS,
    HELDOUT_OBJECTS, SUMMARIES_PER_BRANCH, MAX_TOKENS, MAX_GENERATIONS, MAX_FEATURE_BATCHES,
    SUMMARY_LEARNING_RATE, SUMMARY_WRITE_OBJECTS, REWARD_OBJECTS_PER_SUMMARY, require, seed_for, digest,
    candidate_cards, observation_messages, summary_messages, audit_summary, validate_summary,
    summary_credit, multi_object_credit, run_course, summarize, restore_head)
from zip_summary_training_v2_progress import StageProgress
from zip_summary_training_run import inspect_training_source as inspect_previous_source
from zip_summary_training_core import PROTOCOL as PREVIOUS_PROTOCOL


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
        reviews[branch]=dict(summaryZipId=identifier,originalSummaryHash=note['summaryHash'],
            previousAuditUnchanged=copy.deepcopy(note['audit']),currentContextAudit=current,
            retainedForNewTaskContext=current['eligibleForTrial'],oldScoresChanged=False,
            oldSampledTrajectoryNotTrainedAgain=True)
        if not current['eligibleForTrial']:banks[branch]=None
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


def inspect_training_source(folder):
    """Validate originals before any tokenizer/model import, including resumption."""
    folder = Path(folder).resolve(); result = read(folder/'result.json')
    require(result.get('fixtureOnly') is False and not result.get('fixtureGenerations') and
        not result.get('teacherCalls'), 'Fixture or teacher-backed source rejected before model import')
    if result.get('protocol') != PROTOCOL:
        return review_inherited_context(inspect_previous_source(folder))
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
    require(len(raws) == result['actualStudentGenerations'] <= MAX_GENERATIONS, 'Student original count differs')
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
            require(credit==multi_object_credit(note,credit['measurements']),'Multi-object summary credit changed')
    plan=read(folder/'zip-summary-questions.json')
    object_map={read(p)['id']:read(p) for p in (folder/'object').glob('*.json')}
    require(set(object_map)=={t['id'] for t in plan['training']+plan['heldout']},'Completed source plan changed')
    objects=[object_map[t['id']] for t in plan['training']+plan['heldout']]
    trials=[read(p) for p in (folder/'trial').glob('*.json')]
    summaries=[read(p) for p in (folder/'summary').glob('*.json')]
    updates=[read(p) for p in (folder/'update').glob('*.json')]
    penalties=[read(p) for p in (folder/'penalty').glob('*.json')]
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
    require(summarize(objects,trials,summaries,updates,penalties)==result['summary'], 'Saved summary statistics changed')
    # Replay selector updates from fixed original representations, not new model calls.
    from zip_label_grounded_checks import replay_item, guarded_head_update
    initial=read(folder/'checkpoints/initial.json'); heads={b:restore_head(initial['heads'][b]) for b in BRANCHES}
    replay={b:[] for b in BRANCHES}
    features={read(p)['id']:read(p) for p in (folder/'feature').glob('*.json')}
    require(len(features)==result['featureForwardBatches']<=MAX_FEATURE_BATCHES,'Feature count changed')
    task_order=read(folder/'zip-summary-questions.json')['training']
    for number,task in enumerate(task_order,1):
        obj=next(o for o in objects if o['id']==task['id']); outcomes=obj['routeOutcomes']
        route_rows=[read(folder/'responses'/(rid+'-scored.json')) for rid in obj['sourceMathRecordIds']]
        require(outcomes==[int(r['check']['outcomePassed']) for r in route_rows] and all(r['task']==task for r in route_rows),
            'Training route originals differ')
        for b in BRANCHES:
            f=features[obj['featureIdsByArm'][b]]
            require(f['normalizedFeatures']==normalized_features(f['candidateHiddenVectors']) and f['task']==task,
                'Frozen feature preimage changed')
            replay[b].append(replay_item(task,f['normalizedFeatures'],outcomes,f['id'],obj['sourceMathRecordIds']))
            update=next(u for u in updates if u['id']==b+'-'+str(number))
            require(guarded_head_update(heads[b],replay[b],number)==update['headUpdate'],'Saved head update cannot be replayed')
            measurement=update['summaryMeasurement']
            if measurement:
                note=inherited[measurement['sourceSummaryZipId']]
                with_id=measurement['featureIds']['withSummary'];plain_id=measurement['featureIds']['without']
                plain=features[plain_id];noted=features[with_id]
                require(plain['task']==noted['task']==task and
                    plain['sourceObservationRecordId']==noted['sourceObservationRecordId'] and
                    plain['candidateCards']==candidate_cards(bank['originalKnowledgeRoots']) and
                    noted['candidateCards']==candidate_cards(bank['originalKnowledgeRoots'],note) and
                    all(f['normalizedFeatures']==normalized_features(f['candidateHiddenVectors']) for f in (plain,noted)),
                    'Reward feature pair does not bind the same actual observation and source summary')
                # The pair was evaluated before this object's head update.
                before_head=restore_head(update['headUpdate']['beforeState'])
                from zip_label_grounded_core import expected_pass
                rebuilt=summary_credit(note,task,expected_pass(before_head,plain['normalizedFeatures'],outcomes)[0],
                    expected_pass(before_head,noted['normalizedFeatures'],outcomes)[0],measurement['featureIds'])
                rebuilt.update(rewardObjectNumber=number,rewardTaskFamily=task['family'],
                    sourceMathRecordIds=obj['sourceMathRecordIds'])
                require(rebuilt==measurement,'Reward measurement differs from original routes, features or head')
    require({b:h.state() for b,h in heads.items()}==cp['heads'],'Final head does not match actual saved updates')
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
    return review_inherited_context(dict(base=base_source, parent=folder, parentHashes=actual, initialHeads=cp['heads'],
        initialBanks=cp['banks'], summaryFiles={b:folder/'checkpoints'/cp['summaryStates'][b]['file'] for b in BRANCHES},
        summaryStateHashes={b:cp['summaryStates'][b]['stateHash'] for b in BRANCHES}, inherited=inherited))


def next_number(work):
    values = []
    for path in Path(work).glob('zip-summary-training-*/protocol.json'):
        row = read(path)
        if row.get('protocol') in (PREVIOUS_PROTOCOL,PROTOCOL):
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
            rows.append(dict(kind='summary',taskId=task['id'],audit=audit,planningReserve=8*MAX_TOKENS))
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
        summaryAdapterEnabledOnlyWhenWritingSummary=True, summaryInitialization='zero additive output or saved summary continuation',
        initialBranchHeadHashes={b:resume['initialHeads'][b]['parameterHash'] for b in BRANCHES},
        initialHeadsIdentical=resume['initialHeads'][BRANCHES[0]]==resume['initialHeads'][BRANCHES[1]],
        branchesContinueTheirOwnPriorState=True,bothPreRoundHeadsFrozenForSameNewObjects=True,
        automaticSourceBinding=True, teacherCalls=0, numericMetricTableSupplied=False,
        hostWritesStudentSummary=False, forcedSelfReflection=False, correctMathTargetsSupplied=False,
        conditionalTrainingCriticReadsSealedSummaries=True, ordinarySealedTaskDoesNotReadSummary=True,
        sameOpportunityBudgetsNotGuaranteedSameNumberOfNonzeroUpdates=True,
        knownFalseFactsAndCompletionPenaltiesSeparateFromLaterUsefulnessReward=True,
        summaryWritingTrainingPositions=list(SUMMARY_WRITE_OBJECTS),
        rewardObjectsPerEligibleNewSummary=REWARD_OBJECTS_PER_SUMMARY,
        summaryWriterFrozenUntilTwoRewardObjectsComplete=True,
        nonpositiveNetGainRestoresPreviousContext=True,
        shortSentenceIsPromptInstructionNotGrammarForcing=True,
        inheritedContextRecheckedWithoutChangingOldScores=True,heldoutTrainingUpdates=0))
    zip_hashes = {}; zip_reads = []
    for identifier, note in resume['inherited'].items(): zip_hashes[identifier] = write_summary_zip(zip_folder, note)
    write_once(args.out/'source-checkpoint.json', dict(baseChoiceSource=str(base_choice), parentSource=str(original_parent),
        baseStateHash=foundation['result']['baseStateBefore'], mathematicalWriterStateHash=checked['checkpoint']['writerStateHash'],
        foundationResultSha256=sha(foundation_path/'result.json'), originalWriterFile=str(checked['writer']),
        originalWriterFileSha256=sha(checked['writer']), parentResultSha256=sha(original_parent/'result.json')))
    deadline = time.monotonic()+max(0.,float(os.environ.get('ZIP_SUMMARY_DEADLINE',str(time.time()+1200)))-time.time())
    calls=feature_calls=0; raw=[]; scored=[]; objects=[]; updates=[]; penalties=[]; notes=[]; trials=[]; steps=[]
    base=mathematical=semantic=writer=None; base_before=math_before=semantic_before=None
    states={}; state_hashes={}; branch=BRANCHES[0]; installed=None; heldout_before=None; heldout_ok=None
    course={}; final_heads=copy.deepcopy(resume['initialHeads']); final_banks=copy.deepcopy(resume['initialBanks'])
    protected_ok=None; stop='completed'; error=None

    def save(kind,row):
        path=args.out/'responses'/(row['recordId']+'-'+kind+'.json') if kind in ('raw','scored') else args.out/kind/(row['id']+'.json')
        write_once(path,row)
        collection={'raw':raw,'scored':scored,'object':objects,'update':updates,'penalty':penalties,
            'summary':notes,'trial':trials,'summary-step':steps}.get(kind)
        if collection is not None: collection.append(copy.deepcopy(row))
        progress.mark(rawResponsesSaved=len(raw),scoredResponses=len(scored),featureForwardBatches=feature_calls,
            completeNewObjects=len(objects),summaryUpdates=len(steps),studentSummaries=len(notes),
            usableSummaryZips=sum(n['audit']['eligibleForTrial'] for n in notes),
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
    report=summarize(objects,trials,notes,updates,penalties)
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
