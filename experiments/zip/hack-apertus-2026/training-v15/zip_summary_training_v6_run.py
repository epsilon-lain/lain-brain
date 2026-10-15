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
from zip_summary_training_v6_policy import input_limits, prompt_audit, require_input, generate, token_limit, update_summary_words as update_words
from zip_interface_training_policy import checkpoint_boundary
from zip_summary_training_v6_core import *
from zip_summary_training_v6_inspect import inspect_training_source
from zip_summary_training_v6_progress import StageProgress
import zip_summary_training_v3_core as v3_core
from zip_summary_training_v2_core import PROTOCOL as PREVIOUS_PROTOCOL
from zip_summary_training_v4_run import state_unchanged


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


def next_number(work):
    values = []
    for path in Path(work).glob('zip-summary-training-*/protocol.json'):
        row = read(path)
        if row.get('protocol') in (PREVIOUS_PROTOCOL,PROTOCOL,v3_core.PROTOCOL,'lain-zip-experience-summary-training-v1','lain-zip-experience-summary-training-v4','lain-zip-experience-summary-training-v5'):
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
            prompt=rating_messages(dict(event=shape,studentRaw='[student summary not yet generated]'),dict(measurements=[]))
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
        maximumGenerations=MAX_GENERATIONS, maximumTokens=MAX_TOKENS, maximumSummaryTokens=MAX_SUMMARY_TOKENS, maximumFeatureBatches=MAX_FEATURE_BATCHES,
        newTrainingObjects=TRAINING_OBJECTS, newHeldoutObjects=HELDOUT_OBJECTS,
        summaryWriteOpportunitiesPerBranch=SUMMARIES_PER_BRANCH, summaryOptimizerStepCapPerBranch=GROUPS_PER_BRANCH,summaryGroupOpportunitiesPerBranch=GROUPS_PER_BRANCH,
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
        acceptedContextChangesOnlyAfterTwoTrainingTests=True,candidatesPerEvent=CANDIDATES_PER_EVENT,
        optionalRatingsAfterMeasuredTests=True,studentScoresSuppliedToSummaryWriter=False,
        contextualReuseUsesFrozenTrainingRepresentations=True,manualFamilyUsedForContextGate=False,
        studentQualityAssessmentsOptionalNumericScore=True,qualityAssessmentIsRetrospective=True,
        positiveWordRewardFromCitationCount=False,positiveWordRewardFromSelfRating=False,
        programContextUsesSeparatedFromStudentReferences=True,autonomousZipRetrievalTested=False,
        candidateRegressionLeavesPreviouslyAcceptedContextUnchanged=True,
        positiveCreditRequiresPositiveUngatedMean=True,bestOfBadCandidatesCannotReceivePositiveCredit=True,
        finalRetentionUsesTrainingEvidenceUnderFinalHead=True,
        shortSentenceIsPromptInstructionNotGrammarForcing=True,
        summaryPromptContainsOnlySelectedAction=True,summaryMaximumWords=MAX_SUMMARY_WORDS,
        allOtherOriginalsArchivedWithoutEnteringSummaryPrompt=True,
        summarySamplerUsesActualEosOnly=True,summaryAuditProtocol="selected-experience-literal-audit-v6",
        inheritedContextRecheckedWithoutChangingOldScores=True,heldoutTrainingUpdates=0))
    zip_hashes = {}; zip_reads = []
    for identifier, note in resume['inherited'].items(): zip_hashes[identifier] = write_summary_zip(zip_folder, note)
    write_once(args.out/'source-checkpoint.json', dict(baseChoiceSource=str(base_choice), parentSource=str(original_parent),
        baseStateHash=foundation['result']['baseStateBefore'], mathematicalWriterStateHash=checked['checkpoint']['writerStateHash'],
        foundationResultSha256=sha(foundation_path/'result.json'), originalWriterFile=str(checked['writer']),
        originalWriterFileSha256=sha(checked['writer']), parentResultSha256=sha(original_parent/'result.json')))
    deadline = time.monotonic()+max(0.,float(os.environ.get('ZIP_SUMMARY_DEADLINE',str(time.time()+1200)))-time.time())
    calls=feature_calls=0; raw=[]; scored=[]; objects=[]; updates=[]; penalties=[]; notes=[]; trials=[]; steps=[];retention_reviews=[]
    ratings=[];references=[];groups=[];group_results=[]
    base=mathematical=semantic=writer=None; base_before=math_before=semantic_before=None
    states={}; state_hashes={}; branch=BRANCHES[0]; installed=None; heldout_before=None; heldout_ok=None
    course={}; final_heads=copy.deepcopy(resume['initialHeads']); final_banks=copy.deepcopy(resume['initialBanks']);final_gates=copy.deepcopy(resume['initialGates'])
    protected_ok=None; stop='completed'; error=None

    def save(kind,row):
        path=args.out/'responses'/(row['recordId']+'-'+kind+'.json') if kind in ('raw','scored') else args.out/kind/(row['id']+'.json')
        write_once(path,row)
        collection={'raw':raw,'scored':scored,'object':objects,'update':updates,'penalty':penalties,
            'summary':notes,'trial':trials,'summary-step':steps,'summary-context-review':retention_reviews,
            'summary-rating':ratings,'zip-reference':references,'summary-group':groups,'group-result':group_results}.get(kind)
        if collection is not None: collection.append(copy.deepcopy(row))
        progress.mark(rawResponsesSaved=len(raw),scoredResponses=len(scored),featureForwardBatches=feature_calls,
            completeNewObjects=len(objects),summaryUpdates=len(steps),studentSummaries=len(notes),
            usableSummaryZips=sum(n['audit']['eligibleForTrial'] for n in notes),
            qualityAssessments=sum(r['sourceRatingRecordId'] is not None for r in ratings),
            candidateActivations=sum(r['activatedSummaryZipId'] is not None for r in group_results),
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
                value=generate(base,tokenizer,messages,phase,seed,sampled,input_audit=audit)
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
            require(not value.get('testDouble') and value['responseTokenLimit']==token_limit(phase) and
                0<value['generatedTokens']==len(ids)==len(logs)<=token_limit(phase) and
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

        def learn(group_notes,credit,reason):
            nonlocal installed
            require(heldout_before is None and credit['branch']==branch and
                all(n['branch']==branch and n['event']['task']['split']=='training' for n in group_notes) and
                credit['rewardObjectSplit']=='training' and len([s for s in steps if s['branch']==branch])<GROUPS_PER_BRANCH,
                'Heldout, wrong branch or writing group step cap')
            require(reason=='candidate_group_feedback' and credit==group_credit(make_group(group_notes),group_notes,
                {n['id']:credit['candidateCredits'][n['id']]['measurements'] for n in group_notes}),
                'Writing update requires actual candidate group evidence')
            for note in group_notes:validate_summary(note)
            values=[n['studentOriginal']['studentOutput'] for n in group_notes];frozen()
            require(all(v['sampled'] is True and v['summaryAdapterEnabledDuringGeneration'] is True and
                v['mathAdapterEnabledDuringGeneration'] is False and v['semanticAdapterEnabledDuringGeneration'] is False and
                v['summaryStateHashDuringGeneration']==installed for v in values),
                'Candidate originals came from another writer; no update')
            before=writer.learned_state();before_hash=installed
            try:
                for p in writer.parameters_to_train():p.requires_grad_(True)
                with mathematical.active(False),semantic.active(False),writer.active(True):
                    update=update_words(base,writer,optimizer,values,credit['batchAdvantages'],CANDIDATES_PER_EVENT*MAX_SUMMARY_TOKENS)
                require(all(torch.isfinite(p).all().item() for p in writer.parameters_to_train()),'Nonfinite summary state')
                after_hash=writer.digest()
                if update['updated']:
                    row=dict(id=branch+'-'+str(len(steps)+1).zfill(3),branch=branch,sourceGroupId=credit['groupId'],
                        sourceSummaryZipIds=[n['id'] for n in group_notes],sourceWordRecordIds=[n['sourceRecordId'] for n in group_notes],
                        credit=copy.deepcopy(credit),reason=reason,beforeHash=before_hash,afterHash=after_hash,
                        optimizer='SGD without momentum',learningRate=SUMMARY_LEARNING_RATE,
                        parameterChanged=after_hash!=before_hash,policyUpdate=copy.deepcopy(update))
                    file=row['id']+'.safetensors'
                    with checkpoint_boundary():
                        save_file(writer.learned_state(),str(checkpoint_folder/file))
                        row.update(file=file,fileSha256=sha(checkpoint_folder/file));save('summary-step',row)
                        states[branch]=writer.learned_state();state_hashes[branch]=installed=after_hash
                update.update(beforeHash=before_hash,afterHash=after_hash,credit=copy.deepcopy(credit),
                    sourceGroupId=credit['groupId'],reason=reason)
            except BaseException:
                writer.restore(before);installed=before_hash;raise
            finally:
                optimizer.zero_grad(set_to_none=True)
                for p in writer.parameters_to_train():p.grad=None;p.requires_grad_(False)
            frozen();return update

        def checkpoint(label,heads,banks,gates):
            nonlocal final_heads,final_banks,final_gates,heldout_before
            frozen();state_rows={}
            with checkpoint_boundary():
                for b in BRANCHES:
                    file=label+'-'+b+'.safetensors';save_file(states[b],str(checkpoint_folder/file))
                    state_rows[b]=dict(file=file,fileSha256=sha(checkpoint_folder/file),stateHash=state_hashes[b])
                row=dict(protocol=PROTOCOL,label=label,heads=copy.deepcopy(heads),banks=copy.deepcopy(banks),
                    summaryStates=state_rows,baseStateHash=base_before,mathematicalWriterStateHash=math_before,
                    contextGateHashes={b:gates[b]['gateHash'] if gates[b] else None for b in BRANCHES})
                if label in ('initial','training-final','final'):row['contextGates']=copy.deepcopy(gates)
                write_once(checkpoint_folder/(label+'.json'),row)
                final_heads=copy.deepcopy(heads);final_banks=copy.deepcopy(banks);final_gates=copy.deepcopy(gates)
                if label=='training-final':heldout_before=copy.deepcopy(state_hashes)

        for n,old in enumerate(checked['anchors'],1):
            row=ask('cold_replay',old['studentPrompt'],old['samplingSeed'],mode='math',sampled=False,
                task=old['task'],coldNumber=n,sourceRecordId=old['recordId'],coldMathEnabled=old['requestedMathAdapterEnabled'])
            match=exact_reproduction(old['studentOutput'],row['studentOutput'])
            save('scored',dict(row,check=dict(exactReproduction=match)))
            require(match['exact'],'Original math writer failed exact reproduction; no new training')
            progress.mark(coldReproductions=n)
        course=run_course(plan,roots,resume['initialHeads'],ask,feature,save,learn,select,store,read_note,checkpoint,
            deadline,number,resume['initialBanks'],resume['initialGates'])
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
    write_once(args.out/'summary-zip-bank.json',dict(protocol=PROTOCOL,activeByBranch=final_banks,contextGates=final_gates,zipByteHashes=zip_hashes,
        allNewStudentSummaries=[n['id'] for n in notes],nativeZipReads=len(zip_reads),originalKnowledgeRoots=roots,
        explanationsRemainHypotheses=True,oldProductionBankUnchanged=True))
    report=summarize(objects,trials,notes,updates,group_results,ratings,references,retention_reviews)
    result=dict(protocol=PROTOCOL,trainingRound=number,stopReason=stop,error=error,fixtureOnly=False,fixtureGenerations=0,
        teacherCalls=0,actualStudentGenerations=len(raw),generationAttempts=calls,rawResponsesSaved=len(raw),scoredResponses=len(scored),
        featureForwardBatches=feature_calls,completedTrainingObjects=sum(o['phase']=='training' for o in objects),
        completedHeldoutObjects=sum(o['phase']=='heldout' for o in objects),
        coldReproductions=sum(r['phase']=='cold_replay' and r['check']['exactReproduction']['exact'] for r in scored),
        trainingUpdates=len(steps)+sum(u['headUpdate']['updated'] for u in updates),summaryOptimizerUpdates=len(steps),
        summaryParametersChangedByBranch={b:any(s['parameterChanged'] for s in steps if s['branch']==b) for b in BRANCHES},
        finalHeads=final_heads,finalBanks=final_banks,finalGates=final_gates,studentWrittenSummaryZips=len(notes),
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
