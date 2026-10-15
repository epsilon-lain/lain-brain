"""CPU Notebook runner. No free-language management loops or old weight updates."""
import argparse
import copy
import json
import math
import os
from pathlib import Path
import shutil
import signal
import time
import traceback
from types import SimpleNamespace
from contextlib import ExitStack
from draft_inspect_runtime import read, sha, snapshot
from writer_check_core import exact_reproduction
from writer_check_run import preflight
from tool_loop_course import archived_inputs
from object_choice_core import normalized_features
from zip_label_grounded_checks import feature_messages
from zip_summary_training_v6_policy import input_limits, prompt_audit, require_input, generate
from zip_summary_training_v7_scope import make_plan
from zip_summary_training_v8_core import A
from zip_summary_training_v9_progress import StageProgress
from zip_management_stable_inspect import inspect_source
from zip_management_geometry_core import *
from zip_management_geometry_receipts import atomic_json, partial, review
from zip_management_stable_series import source_binding
from zip_management_head_budget import PhaseBudget,state_digest


def source_cases(folder,resume):
    """All outcomes/weights replayed by the v10 source inspector first."""
    folder=Path(folder);course=resume['replayedCourse'];objects={o['task']['id']:o for o in course['objects']}
    rows=[read(p) for p in (folder/'responses').glob('*-raw.json')]
    plan=read(folder/'weak-guidance-questions.json')
    result=[]
    for task in plan['training']:
        obj=objects[task['id']]
        managers=[r for r in rows if r['phase']=='summary_management' and r.get('task',{}).get('id')==task['id']]
        require(len(managers)==1 and obj['phase']=='training','Missing single actual pre-outcome TRAIN management prompt')
        result.append(dict(task=task,managementPrompt=managers[0]['studentPrompt'],
            sourceManagerRecordId=managers[0]['recordId'],summaryZipId=obj['summaryZipId'],
            useExpected=obj['useExpected'],suspendExpected=obj['suspendExpected'],
            routeOutcomes=obj['routeOutcomes'],sourceMathRecordIds=obj['sourceMathRecordIds'],
            sourceFeatureIds=obj['featureIds'],sourceObservationIds=obj['observationIds'],
            sourceFolder=str(folder.resolve()),sourceObjectHash=digest(obj),
            sameSourceReaderAndPlainHeadAsV10=True))
    return result


def stop_cause(folder):
    path=Path(folder)/'stop-request.json'
    return read(path).get('reason','external_interrupt') if path.is_file() else 'external_interrupt'


def classify_stop(exc,folder):
    if isinstance(exc,KeyboardInterrupt):return 'paused', '外部中断；已保存实际返回原文与提交步骤'
    if isinstance(exc,InterruptedError):return 'paused', stop_cause(folder)
    if isinstance(exc,TimeoutError):return 'time_budget', str(exc)
    return 'error', type(exc).__name__+': '+str(exc)


def recover_copy(previous,out):
    previous=Path(previous);out=Path(out)
    require(not out.exists() and not out.resolve().is_relative_to(previous.resolve()), 'Recovery output overlaps source')
    protocol=read(previous/'protocol.json')
    require(protocol['protocol']==PROTOCOL and not protocol.get('fixtureOnly') and protocol['teacherCalls']==0,
            'Wrong or fixture head recovery')
    if (previous/'run-file-manifest.json').is_file():
        manifest=read(previous/'run-file-manifest.json')['files'];actual=snapshot(previous)
        require(all(actual.get(k)==v for k,v in manifest.items()), 'Changed recovery evidence bytes')
    shutil.copytree(previous,out)
    for name in ('result.json','partial-result.json','error.json','run-file-manifest.json','stop-request.json',
                 'Lain-Zip-Management-Head-Review.zip','recovery.json','phase-timing.json'):
        p=out/name
        if p.is_file():
            target=out/'previous-run-metadata'/name;target.parent.mkdir(exist_ok=True);shutil.move(str(p),str(target))
    atomic_json(out/'recovery.json',dict(previousFolder=str(previous.resolve()),
        previousSnapshot=snapshot(previous),replaySavedHeadStepsWithoutCommittingAgain=True,
        reusedStudentOriginals=len(list((out/'responses').glob('*.json')))))


def run(args):
    started=time.monotonic();source=args.source.resolve()
    progress=StageProgress(os.environ.get('ZIP_SUMMARY_PROGRESS_FILE'))
    clock=PhaseBudget(setup=float(os.environ.get('ZIP_HEAD_SETUP_SECONDS','1800')),
        training=float(os.environ.get('ZIP_HEAD_TRAIN_SECONDS','3000')),
        heldout=float(os.environ.get('ZIP_HEAD_EVAL_SECONDS','1200')),
        saving=float(os.environ.get('ZIP_HEAD_SAVE_SECONDS','600')))
    def stage(name,message):
        clock.mark(name)
        progress.mark(message+'；当前阶段 '+clock.phase+'，训练更新不包含准备耗时')
        if args.out.is_dir():atomic_json(args.out/'phase-timing.json',clock.report())
        clock.check()
    progress.mark('只读重放完整接续检查点与八份旧 TRAIN 反馈；尚未加载学生，生成 0')
    resume=inspect_source(source,training_only=True)
    stage('foundation_source_preflight','旧 TRAIN 通过；核验基础模型文件、数学写作来源和八条冷复现记录')
    require('replayedCourse' in resume and len(resume['replayedCourse']['guideCandidates'])==2,
            'Require the complete v10 TRAIN phase and two actual student guides')
    foundation=resume['base'];fp=Path(foundation['folder'])
    base_choice=Path(read(fp/'source-checkpoint.json')['baseChoiceSource']).resolve()
    checked=preflight(SimpleNamespace(source=base_choice,student=args.student,old_tools=args.old_tools,out=args.out))
    stage('source_cases_and_plan','来源通过；恢复原计划和已存步骤，训练仍未开始')
    original_train=Path(resume['originalTrainFolder']);cases=source_cases(original_train,resume);bank=copy.deepcopy(resume['managementInitial']);notes=copy.deepcopy(resume['inherited'])
    roots=copy.deepcopy(foundation['bank']['mathematicalRoots'])
    initial_guide=copy.deepcopy(resume['initial']['guide']);candidates=copy.deepcopy(resume['replayedCourse']['guideCandidates'])
    validate_entries(bank['entries'],notes)
    require(not args.out.resolve().is_relative_to(source) and not source.is_relative_to(args.out.resolve()), 'Output overlaps original')
    if args.recover:
        recover_copy(args.recover,args.out)
        binding=read(args.out/'source-checkpoint.json')
        require(binding==source_binding(source,resume['parentHashes']), 'Different recovery source or source bytes')
        plan=read(args.out/'plan.json');number=read(args.out/'protocol.json')['experimentNumber']
    else:
        args.out.mkdir(parents=True,exist_ok=False)
        numbers=[]
        for p in args.work.glob('zip-management-geometry-*/protocol.json'):
            v=read(p)
            if v.get('protocol')==PROTOCOL:numbers.append(v['experimentNumber'])
        number=max(numbers,default=0)+1;require(number<=1000,'Seed namespace exhausted')
        archives=[p for p in args.work.glob('zip-*') if p.is_dir() and
                  ((p/'result.json').is_file() or list(p.glob('*questions.json')) or (p/'plan.json').is_file())]
        excluded,freshness=archived_inputs(archives+[source,fp,base_choice])
        # Generic archive scanner predates v11's plan.json. Include all its planned inputs explicitly.
        excluded=set(excluded)
        for folder in archives:
            path=folder/'plan.json'
            if path.is_file():
                for split in ('training','heldout'):
                    for t in read(path).get(split,[]):excluded.add(t['semanticInputKey'])
        for c in cases:excluded.add(c['task']['semanticInputKey'])
        for c,f,fid in resume['replayCache']:excluded.add(c['task']['semanticInputKey'])
        plan=make_fixed_plan(excluded,roots)
        plan.update(sourceTrainingTaskIds=[c['task']['id'] for c in cases],freshness=freshness,
            continuedSourceHeadHash=digest(resume['continuedHead']),
            sourceOldHeldoutUsedAsNewTraining=False,globalScoreStepNormMultiplier=3.0,
            sourceReplayTrainingIds=[c['task']['id'] for c,f,fid in resume['replayCache']],
            transformRidgeRatio=.1,sourceReplayObjects=8,
            actualOldSummaryAndReaderStatesUnchanged=True)
        atomic_json(args.out/'plan.json',plan)
        atomic_json(args.out/'source-checkpoint.json',source_binding(source,resume['parentHashes']))
        atomic_json(args.out/'protocol.json',dict(protocol=PROTOCOL,experimentNumber=number,teacherCalls=0,
            fixtureOnly=False,headOpportunities=STEPS,learningRate=LEARNING_RATE,maximumGenerations=GENERATION_CAP,
            maximumFeatureBatches=FEATURE_CAP,explicitBinaryActionInterface=True,
            nativeLanguageActionLearningClaimed=False,oldMetricComparable=False,
            hostCurrentUseLabelsSupplied=False,hostActionVocabularySupplied=True,
            studentGuideRevisionsReusedFromTRAIN=False,oldTwentyOneUpdatesPreservedInSource=True,
            currentSourceHeadContinued=True,globalControlUpdates=STEPS,globalScoreStepNormMultiplier=3.0))
    validate_fixed_plan(plan)
    require(plan['sourceReplayTrainingIds']==[c['task']['id'] for c,f,fid in resume['replayCache']],
        'Different audited replay dataset')
    require(plan['continuedSourceHeadHash']==digest(resume['continuedHead']),'Different continuation head')
    atomic_json(args.out/'phase-timing.json',clock.report())
    cached_count=len(list((args.out/'responses').glob('*.json')));old_steps=len(list((args.out/'head-step').glob('*.json')))
    base=math_adapter=None;before=after=None;head_result={};stop='completed';error=None
    protected=None;held_frozen=None;training_hash=None;new_calls=0;new_updates=0;feature_batches=0
    deadline=clock.deadline
    phase='setup';live_head=None
    def durable(kind,row):
        nonlocal new_updates
        require(type(row.get('id')) is str and Path(row['id']).name==row['id'],'Invalid record identity')
        path=args.out/kind/(row['id']+'.json')
        if path.is_file():require(read(path)==row, 'Saved '+kind+' differs from exact algorithm replay')
        else:
            atomic_json(path,row)
            if kind=='head-step' and row['updated']:new_updates+=1
        if kind in ('head-step','object'):
            progress.mark(headOpportunities=len(list((args.out/'head-step').glob('*.json'))),
                headUpdates=sum(read(p)['updated'] for p in (args.out/'head-step').glob('*.json')),
                completeNewObjects=len(list((args.out/'object').glob('*.json'))))
    def alarm(*unused):raise TimeoutError('Management-head '+phase+' deadline')
    def interrupt(*unused):raise InterruptedError(stop_cause(args.out))
    old_term=signal.signal(signal.SIGTERM,interrupt);old_int=signal.signal(signal.SIGINT,interrupt)
    old_alarm=signal.signal(signal.SIGALRM,alarm)
    signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
    try:
        from transformers import AutoTokenizer
        stage('tokenizer_preflight','先加载 tokenizer；核对原经历、候选动作与全部新题输入长度')
        tokenizer=AutoTokenizer.from_pretrained(args.student,local_files_only=True)
        limits=input_limits(read(args.student/'config.json'),tokenizer);audits=[]
        def check_input(messages):
            a=prompt_audit(tokenizer,messages,limits);require_input(a);return a
        for c in cases:
            for g in [initial_guide]+candidates:
                for action in ACTIONS:audits.append(check_input(action_messages(c['task'],c['managementPrompt'],g,action)))
        for task in plan['training']+plan['heldout']:
            entry=nominate(task,bank['entries']);require(entry is not None,'No source summary for new input')
            note=notes[entry['summaryZipId']]
            mp=management_messages(task,note,bank['history'],bank['statuses'].get(note['id'],'available'),initial_guide)
            for g in [initial_guide]+candidates:
                for action in ACTIONS:audits.append(check_input(action_messages(task,mp,g,action)))
            for n in (None,note):audits.append(check_input(observation_messages(task,roots,n)))
            for c in candidate_cards(roots):audits.append(check_input(math_messages(task,c,roots)))
        for old in checked['anchors']:audits.append(check_input(old['studentPrompt']))
        for c,f,fid in resume['replayCache']:
            for action in ACTIONS:audits.append(check_input(action_messages(c['task'],c['managementPrompt'],initial_guide,action)))
        # Keep the compact preflight, not dozens of duplicate full token arrays.
        preflight_row=dict(tokenizerOnly=True,checkedInputs=len(audits),maximumActualInputTokens=max(a['inputTokens'] for a in audits),
            maxInputTokens=limits['maxInputTokens'],noSilentTruncation=True)
        if not (args.out/'input-preflight.json').is_file():atomic_json(args.out/'input-preflight.json',preflight_row)
        else:require(read(args.out/'input-preflight.json')==preflight_row,'Changed resumed tokenizer/preflight')
        import torch
        from safetensors.torch import load_file
        from zip_pilot import load_student
        from math_writer_adapter import MathWriterAdapter
        stage('model_load','加载冻结学生；旧管理、语义、总结参数不挂载')
        base,tokenizer,identity=load_student(args.student,'cpu')
        require(identity['snapshotSha256']==checked['identity']['snapshotSha256'],'Different student snapshot')
        stage('math_adapter_restore','基础模型已加载；安装并校验原数学写作参数')
        torch.manual_seed(11_500_000_000+number*100_000)
        math_adapter=MathWriterAdapter(base,rank=8,last_layers=4,alpha=16)
        math_adapter.restore(load_file(str(checked['writer'])));math_adapter.eval()
        for p in math_adapter.parameters_to_train():p.requires_grad_(False);p.grad=None
        base.eval().requires_grad_(False)
        stage('starting_weight_digest','模型与数学参数已准备；分块校验原始权重字节，尚未计入训练预算')
        before=dict(base=state_digest(base),math=math_adapter.digest())
        require(before==resume['continuedFeatureFrozenWeights'],'Different source frozen feature model')
        require(before==dict(base=foundation['result']['baseStateBefore'],math=checked['checkpoint']['writerStateHash']),
            'Original frozen weight identity changed')
        clock.check()
        phase='training';deadline=clock.enter('training')
        signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
        stage('cold_replay','来源、模型与起始权重通过；现在开始独立训练预算：冷复现／新题测量／几何调试训练预算')
        def frozen():
            require(not base.training and not math_adapter.training and
                all(not p.requires_grad and p.grad is None for p in list(base.parameters())+math_adapter.parameters_to_train()),
                'Frozen source entered head gradients')
        def remaining():
            if time.monotonic()>=deadline:raise TimeoutError('Deadline before generation/forward')
        def ask(phase_name,messages,seed,*,mode,**context):
            nonlocal new_calls
            identifier='head-call-'+digest(dict(phase=phase_name,messages=messages,seed=seed,context=context))[:24]
            path=args.out/'responses'/(identifier+'.json');audit=check_input(messages)
            if path.is_file():
                row=read(path)
                require(row['recordId']==identifier and row['phase']==phase_name and row['studentPrompt']==messages
                    and row['samplingSeed']==seed and row['mode']==mode and
                    all(row.get(k)==v for k,v in context.items()),'Changed cached actual generation context')
            else:
                remaining();frozen()
                require(len(list((args.out/'responses').glob('*.json')))<GENERATION_CAP,'Actual generation budget exceeded')
                progress.mark('学生实际生成 '+str(cached_count+new_calls+1)+'/88：'+phase_name)
                enabled=bool(context.get('coldMathEnabled',True)) if mode=='math' else False
                with math_adapter.active(enabled):
                    output=generate(base,tokenizer,messages,phase_name,seed,False,input_audit=audit)
                output.update(mathAdapterEnabledDuringGeneration=enabled,allOtherAdaptersEnabled=False)
                row=dict(id=identifier,recordId=identifier,phase=phase_name,studentPrompt=messages,
                    studentOutput=output,samplingSeed=seed,fixtureOnly=False,mode=mode,**context)
                # Save every returned original BEFORE token, EOS or frozen checks.
                atomic_json(path,row);new_calls+=1;progress.mark(rawResponsesSaved=cached_count+new_calls)
            v=row['studentOutput'];ids=v['generatedIds'];logs=v['samplingTokenLogProbabilities']
            eos=base.generation_config.eos_token_id
            if eos is None:eos=tokenizer.eos_token_id
            stops=set(eos if isinstance(eos,list) else [eos])-{None}
            require(row['fixtureOnly'] is False and not v.get('testDouble') and v['originalTextRepaired'] is False and
                v['sampled'] is False and v['promptIds']==audit['promptIds'] and
                tokenizer.decode(ids,skip_special_tokens=True)==v['raw'] and
                0<v['generatedTokens']==len(ids)==len(logs)<=96 and
                all(type(x) is int and x>=0 for x in ids) and all(numeric(x) for x in logs) and
                abs(sum(logs)-v['samplingLogProbability'])<=1e-10 and
                (v['stopReason']=='eos')==(ids[-1] in stops) and
                v['mathAdapterEnabledDuringGeneration']==(bool(context.get('coldMathEnabled',True)) if mode=='math' else False)
                and v['allOtherAdaptersEnabled'] is False,'Changed actual raw/token/EOS provenance')
            frozen();return row
        def vectors(identifier,kind,task,prompts,metadata):
            nonlocal feature_batches
            audits=[check_input(p) for p in prompts];path=args.out/'feature'/(identifier+'.json')
            if path.is_file():
                row=read(path)
                require(row['id']==identifier and row['kind']==kind and row['task']==task and
                    row['candidatePrompts']==prompts and row['metadata']==metadata and
                    row['frozenWeights']==before and row['featureHash']==digest({k:v for k,v in row.items() if k!='featureHash'}),
                    'Changed recovered frozen feature provenance')
                require(row['inputAuditHashes']==[a['auditHash'] for a in audits],'Changed cached input tokens')
                values=row['hiddenVectors']
                require(row['allAdaptersDisabled'] is True and row['normalizedFeatures']==(normalize(values) if kind=='management' else normalized_features(values)),
                    'Changed cached feature normalization')
            else:
                remaining();frozen();require(len(list((args.out/'feature').glob('*.json')))<FEATURE_CAP,'Feature cap')
                values=[]
                with math_adapter.active(False),torch.no_grad():
                    for audit in audits:
                        remaining()
                        tensor=torch.tensor([audit['promptIds']],device=next(base.parameters()).device)
                        value=base(input_ids=tensor,output_hidden_states=True,use_cache=False,logits_to_keep=1)
                        values.append(value.hidden_states[-1][0,-1].float().cpu().tolist())
                row=seal(dict(id=identifier,kind=kind,task=copy.deepcopy(task),metadata=metadata,
                    candidatePrompts=prompts,inputAuditHashes=[a['auditHash'] for a in audits],
                    hiddenVectors=values,normalizedFeatures=normalize(values) if kind=='management' else normalized_features(values),
                    frozenWeights=before,allAdaptersDisabled=True),'featureHash')
                atomic_json(path,row);feature_batches+=1
            frozen();return row['normalizedFeatures'],identifier
        def action_feature(task,original,guide):
            prompts=[action_messages(task,original,guide,a) for a in ACTIONS]
            identifier='management-feature-'+digest(prompts)[:24]
            return vectors(identifier,'management',task,prompts,dict(guideId=guide['id'],
                actionVocabulary=list(ACTIONS),currentTaskOutcomesInInput=False))
        def method_feature(task,row,cards):
            prompts=[feature_messages(task,row['studentOutput'],c) for c in cards]
            identifier='method-feature-'+digest(dict(prompts=prompts,recordId=row['recordId']))[:24]
            return vectors(identifier,'method',task,prompts,dict(observationRecordId=row['recordId'],candidateCards=cards))
        def checkpoint(head,initial_head,active,training_cases,*,control_head,initial_control,
                       raw_control,feature_transform,exported_raw_head):
            nonlocal deadline,phase,training_hash,live_head
            live_head=copy.deepcopy(head);training_hash=digest(dict(head=head,control=control_head,
                raw=raw_control,transform=feature_transform))
            receipt=dict(protocol=PROTOCOL,trainingPhaseComplete=True,head=head,initialHead=initial_head,
                activeGuide=active,trainingCaseHashes=[digest(c) for c in training_cases],globalControl=copy.deepcopy(control_head),
                initialGlobalControl=copy.deepcopy(initial_control),globalControlHash=digest(control_head),
                rawControl=copy.deepcopy(raw_control),rawControlHash=digest(raw_control),
                featureTransform=copy.deepcopy(feature_transform),exportedRawHead=copy.deepcopy(exported_raw_head),
                transformFitUsesHeldoutFeatures=False,languageModelTraining=False,
                continuedSourceHeadHash=digest(resume['continuedHead']),
                globalInitializationUsesFreshTrainFeaturesOnly=True,globalControlOpportunities=STEPS,
                headOpportunityCount=STEPS,oldAdaptersUpdated=0,guideWriterUpdates=0,
                heldoutFeedbackUsed=False,headHash=digest(head),policiesHash=training_hash)
            durable('checkpoint',dict(receipt,id='training-final'))
            if (args.out/'training-receipt.json').is_file():require(read(args.out/'training-receipt.json')==receipt,'Changed TRAIN receipt')
            else:atomic_json(args.out/'training-receipt.json',receipt)
            partial(args.out,'training_saved_evaluation_pending');review(args.out,args.out/'Lain-Zip-Management-Head-Review.zip')
            phase='heldout';deadline=clock.enter('heldout')
            signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
            stage('frozen_heldout','管理头训练已保存；独立复验预算冻结八道全新题，训练更新零次')
        # Eight exact cold checks bind frozen math writer and native sampler.
        for anchor in checked['anchors']:
            row=ask('cold_replay',anchor['studentPrompt'],anchor['samplingSeed'],mode='math',
                task=anchor['task'],sourceRecordId=anchor['recordId'],coldMathEnabled=anchor['requestedMathAdapterEnabled'])
            reproduction=exact_reproduction(anchor['studentOutput'],row['studentOutput'])
            durable('cold-audit',dict(id=row['recordId'],sourceRecordId=anchor['recordId'],exactReproduction=reproduction))
            require(reproduction['exact'],'Cold source math reproduction failed')
        stage('source_originals_archive','八条冷复现通过；保留旧 TRAIN 回答；新保留结果不进入更新')
        # Archive only actual used TRAIN originals; never import old heldout answers.
        raw_source={r['recordId']:r for r in [read(p) for p in (original_train/'responses').glob('*-raw.json')]}
        for c in cases:
            ids=c['sourceMathRecordIds']+[c['sourceManagerRecordId']]+list(c['sourceObservationIds'].values())
            for identifier in ids:durable('source-originals',dict(raw_source[identifier],id=identifier,
                reusedOriginal=True,sourceFolder=str(original_train),countsAsNewStudentGeneration=False))
        for raw in resume['sourceReplayOriginals']:
            durable('source-replay-originals',dict(raw,id=raw['recordId'],reusedOriginal=True,
                sourceFolder=str(source),countsAsNewStudentGeneration=False))
        for g in candidates:durable('source-originals',dict(g['studentOriginal'],id=g['studentOriginal']['recordId'],
            reusedOriginal=True,sourceFolder=str(original_train),countsAsNewStudentGeneration=False))
        stage('management_features_and_training','八道固定新题加八份旧 TRAIN；训练表征调理头、原表征头和全局概率头')
        head_result=run_course(cases,plan['heldout'],roots,bank,notes,initial_guide,candidates,
            action_feature,method_feature,ask,durable,checkpoint,lambda:deadline,number,
            initial_state=resume['continuedHead'],plan=plan,replay_cache=resume['replayCache'])
        held_frozen=digest(dict(head=head_result['head'],control=head_result['globalControl'],
            raw=head_result['rawControl'],transform=head_result['featureTransform']))==training_hash
        require(held_frozen,'Heldout mutated the learned head')
    except (Exception,KeyboardInterrupt) as exc:
        stop,error=classify_stop(exc,args.out)
        atomic_json(args.out/'error.json',dict(stopReason=stop,error=error,traceback=traceback.format_exc()))
        print('已保留实际返回原文和已提交更新；'+error,flush=True)
    finally:
        # Lightweight evidence first. Signal handlers cannot interrupt the saving phase.
        signal.setitimer(signal.ITIMER_REAL,0)
        signal.signal(signal.SIGTERM,signal.SIG_IGN);signal.signal(signal.SIGINT,signal.SIG_IGN)
        partial(args.out,error or 'final_integrity_pending');review(args.out,args.out/'Lain-Zip-Management-Head-Review.zip')
        phase='saving';deadline=clock.enter('saving')
        signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
        try:
            stage('final_source_snapshot','断点和审阅包已保存；独立保存预算内核对原文件')
            protected=(snapshot(source)==resume['parentHashes'] and snapshot(original_train)==resume['originalTrainHashes'] and
                snapshot(fp)==foundation['sourceHashes'] and
                all(snapshot(Path(p))==h for p,h in resume.get('protectedAncestors',{}).items()) and
                all(sha(Path(p))==h for p,h in checked['protected'].items()) and snapshot(args.old_tools)==checked['toolFiles'])
            require(protected,'Protected originals changed')
            if base is not None and math_adapter is not None:
                stage('final_weight_digest','原文件核验通过；分块核对最终冻结权重')
                after=dict(base=state_digest(base),math=math_adapter.digest())
                if before is not None:require(before==after,'Frozen math/base weights changed')
        except Exception as exc:
            stop='error';error=(error+'; ' if error else '')+str(exc)
        signal.setitimer(signal.ITIMER_REAL,0)
        if math_adapter is not None:math_adapter.close()
    phase_timing=clock.finish();atomic_json(args.out/'phase-timing.json',phase_timing)
    objects=[read(p) for p in sorted((args.out/'object').glob('*.json'))]
    steps=[read(p) for p in sorted((args.out/'head-step').glob('*.json'))]
    result=dict(protocol=PROTOCOL,experimentNumber=number,fixtureOnly=False,teacherCalls=0,
        stopReason=stop,error=error,completeTrainingExperiment=stop=='completed' and len(objects)==8 and held_frozen is True,
        actualStudentGenerations=len(list((args.out/'responses').glob('*.json'))),newlyGeneratedStudentResponses=new_calls,
        reusedStudentResponses=cached_count,actualManagementHeadUpdates=sum(s['updated'] for s in steps),
        newlyCommittedHeadUpdates=new_updates,replayedHeadOpportunities=old_steps,
        headOpportunityCount=len(steps),sourceOldTrainingUpdatesPreserved=sum(
            len(list((original_train/kind).glob('*.json'))) for kind in ('warm-step','management-step','guide-step')),
        featureForwardBatches=len(list((args.out/'feature').glob('*.json'))),newFeatureForwardBatches=feature_batches,
        oldWeightOptimizerUpdates=0,naturalLanguageManagementGenerationTested=False,
        oldBaseAndMathematicalWeightsUnchanged=True if before is not None and before==after else None,
        oldSemanticSummaryManagerGuideWeightsNotLoaded=True,oldMethodHeadsUnchanged=True,
        originalFilesUnchanged=protected,heldoutLearnedStateUnchanged=held_frozen,
        reusedVerifiedTrainObjects=4,freshHeldoutObjects=len(objects),guideCandidatesWrittenThisRun=0,
        sourceTrainingUseMinusSuspend=[c['useExpected']-c['suspendExpected'] for c in cases],
        actualStudentGuidanceOriginalsArchived=2,guideWriterUpdates=0,
        currentGuideChanged=False,sourceManagementHeadUpdatesPreserved=resume['continuedResult']['actualManagementHeadUpdates'],
        freshTrainingObjects=len(list((args.out/'fresh-training-case').glob('*.json'))),
        actualGlobalControlUpdates=sum(s['controlUpdated'] for s in steps),
        actualRawControlUpdates=sum(s['rawControlUpdated'] for s in steps),
        newlyCommittedRawControlUpdates=sum(s['rawControlUpdated'] for s in steps[old_steps:]),
        sourceTrainReplayObjects=8,trainingDatasetObjects=16,
        oldHeldoutEnteredTraining=False,languageModelTraining=False,
        featureConditioningUsesTrainingDataOnly=True,
        newlyCommittedGlobalUpdates=sum(s['controlUpdated'] for s in steps[old_steps:]),
        globalControlUpdatesAreSeparateFromConditionalUpdates=True,
        trainingUtilityCoverage=head_result.get('trainingCoverage'),
        fixedTrainGlobalScoreNormMultiplier=3.0,
        activeGuideId=read(args.out/'training-receipt.json')['activeGuide']['id'] if (args.out/'training-receipt.json').is_file() else None,
        summary=summarize(objects),elapsedSeconds=time.monotonic()-started,phaseTiming=phase_timing,
        exactStartingAndFinalWeightHashUsesBoundedByteViews=True)
    atomic_json(args.out/'result.json',result)
    atomic_json(args.out/'run-file-manifest.json',dict(files={k:v for k,v in snapshot(args.out).items()
        if k not in ('result.json','run-file-manifest.json','Lain-Zip-Management-Head-Review.zip',
                     'child-output.log','launcher-status.json')}))
    review(args.out,args.out/'Lain-Zip-Management-Head-Review.zip')
    summary={k:v for k,v in result['summary'].items() if k!='byObject'}
    print('显式管理头实验摘要：'+json.dumps(summary,ensure_ascii=False),flush=True)
    print('完整性：'+json.dumps({k:result[k] for k in ('stopReason','error','actualStudentGenerations',
        'actualManagementHeadUpdates','newlyCommittedHeadUpdates','freshHeldoutObjects',
        'oldBaseAndMathematicalWeightsUnchanged','originalFilesUnchanged','heldoutLearnedStateUnchanged',
        'completeTrainingExperiment')},ensure_ascii=False),flush=True)
    signal.signal(signal.SIGTERM,old_term);signal.signal(signal.SIGINT,old_int);signal.signal(signal.SIGALRM,old_alarm)
    return 0 if result['completeTrainingExperiment'] else (130 if stop=='paused' else 1)


def main():
    p=argparse.ArgumentParser()
    for name in ('source','work','student','old-tools','out'):p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--recover',type=Path)
    args=p.parse_args()
    old_setup_alarm=signal.getsignal(signal.SIGALRM)
    def setup_timeout(*unused):raise TimeoutError('Source/model setup phase deadline; training has not started')
    signal.signal(signal.SIGALRM,setup_timeout)
    signal.setitimer(signal.ITIMER_REAL,float(os.environ.get('ZIP_HEAD_SETUP_SECONDS','1800')))
    try:return run(args)
    except (Exception,KeyboardInterrupt) as exc:
        # Source admission happens before run() creates its output folder or
        # enters its model-compute guard. Preserve that exact startup error too.
        existed=args.out.is_dir()
        args.out.mkdir(parents=True,exist_ok=True)
        stop,error=classify_stop(exc,args.out)
        receipt=dict(stopReason=stop,error=error,traceback=traceback.format_exc(),
            failedBeforeOutputCreated=not existed,modelWeightsLoaded=False if not existed else None,
            savedReturnedStudentOriginals=len(list((args.out/'responses').glob('*.json'))),
            savedHeadSteps=len(list((args.out/'head-step').glob('*.json'))),
            countsAreSavedEvidenceOnly=True,completeTrainingExperiment=False)
        atomic_json(args.out/'startup-error.json',receipt)
        partial(args.out,error);review(args.out,args.out/'Lain-Zip-Management-Head-Review.zip')
        print('入口或来源检查停止：'+error+'；完整错误已保存，原训练来源未改动。',flush=True)
        return 130 if stop=='paused' else 1
    finally:
        signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,old_setup_alarm)


if __name__=='__main__':raise SystemExit(main())
