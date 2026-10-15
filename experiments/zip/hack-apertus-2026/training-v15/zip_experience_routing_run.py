"""Four fixed frozen routing checks, followed by at most two actual observations."""
import argparse
import copy
import json
import os
from pathlib import Path
import signal
import time
import traceback
from types import SimpleNamespace
import zipfile

from draft_inspect_runtime import read,sha,snapshot
from writer_check_core import write_once
from writer_check_run import preflight
from zip_label_metacognitive_source import inspect_source
from zip_self_question_memory_source import load_evidence
from zip_experience_binding_run import write_source_zips,read_source_zip
from zip_experience_routing_core import (PROTOCOL,MAX_GENERATIONS,MAX_TOKENS,CONDITIONS,OBSERVATION_CONDITIONS,
    require,scheduled_conditions,source_root,routing_messages,selected_observation_input,validate_note,run_experiment,summarize)
from zip_self_question_tools_policy import input_limits,prompt_audit,require_input,generate
from zip_label_metacognitive_progress import StageProgress


def write_note_zip(folder,note,evidence):
    validate_note(note,evidence);require(note['eligibleForFrozenContext'],'Ineligible observation ZIP cannot be saved as eligible')
    path=folder/(note['id']+'.zip');path.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(path,'x',zipfile.ZIP_DEFLATED) as z:
        for name,value in (('root.json',note),('student-choice.json',note['studentChoice']),
            ('student-observation.json',note['studentObservation']),('source-experience.json',note['sourceZip'])):
            z.writestr(name,json.dumps(value,ensure_ascii=False,indent=2))
    return sha(path)


def read_note_zips(folder,hashes,evidence):
    require({p.name for p in folder.glob('*.zip')}==set(hashes),'Observation ZIP set changed')
    notes=[]
    for name,expected in sorted(hashes.items()):
        p=folder/name;require(sha(p)==expected,'Observation ZIP bytes changed')
        with zipfile.ZipFile(p) as z:
            require(z.namelist()==['root.json','student-choice.json','student-observation.json','source-experience.json'] and
                z.testzip() is None,'Observation ZIP entries changed')
            note=json.loads(z.read('root.json'));validate_note(note,evidence)
            require(note['eligibleForFrozenContext'] and note['id']+'.zip'==name and
                json.loads(z.read('student-choice.json'))==note['studentChoice'] and
                json.loads(z.read('student-observation.json'))==note['studentObservation'] and
                json.loads(z.read('source-experience.json'))==note['sourceZip'],'Whole note source or student original changed')
            notes.append(note)
    return notes


def next_number(work):
    numbers=[]
    for path in Path(work).glob('zip-experience-routing-*/protocol.json'):
        row=read(path)
        if row.get('protocol')==PROTOCOL:
            n=row['experimentNumber'];require(type(n) is int and 1<=n<=1000,'Invalid reserved routing number');numbers.append(n)
    value=max(numbers,default=0)+1;require(value<=1000,'Routing namespace exhausted');return value


def prepare_inputs(student,evidence,number):
    from transformers import AutoTokenizer
    tokenizer=AutoTokenizer.from_pretrained(student,local_files_only=True,trust_remote_code=False,fix_mistral_regex=False)
    limits=input_limits(read(student/'config.json'),tokenizer)
    shapes=[(name,routing_messages(evidence,name)) for name,_,_ in CONDITIONS]
    for h in evidence['training']:shapes.append(('observation_'+h['historyId'],selected_observation_input(source_root(h,evidence))))
    rows=[]
    for phase,messages in shapes:
        audit=prompt_audit(tokenizer,messages,limits)
        rows.append(dict(phase=phase,audit=audit,planningEchoReserve=0,planningFits=audit['fitsInputBudget']))
    return limits,dict(rows=rows,allPlannedPromptsFit=all(r['planningFits'] for r in rows),
        tokenizerOnly=True,modelWeightsLoaded=False,actualStudentGenerations=0,selectedSourceZipReads=0,
        placeholderStudentChoiceCreated=False,everyActualInputRechecked=True,
        actualChatTemplateUsedForSeparateConsecutiveUserTurns=True)


def run(args):
    start=time.monotonic();parent=args.source.resolve()
    resume=inspect_source(parent)
    evidence,provenance=load_evidence(resume)
    require(not args.out.resolve().is_relative_to(parent) and not parent.is_relative_to(args.out.resolve()),
        'Output must be separate from source')
    checked_args=SimpleNamespace(**vars(args));checked_args.source=Path(read(parent/'source-checkpoint.json')['baseChoiceSource']).resolve()
    checked=preflight(checked_args)
    require(checked['checkpoint']['writerStateHash']==resume['result']['mathematicalWriterStateHash'],'Math source differs')
    number=next_number(args.work);args.out.mkdir(parents=True,exist_ok=False)
    routing_kernel_sha=sha(Path(__file__).with_name('zip_experience_routing_core.py'))
    binding_kernel_sha=sha(Path(__file__).with_name('zip_experience_binding_core.py'))
    progress=StageProgress(os.environ.get('ZIP_EXPERIENCE_ROUTING_PROGRESS_FILE'))
    write_once(args.out/'protocol.json',dict(protocol=PROTOCOL,experimentNumber=number,sourceCheckpoint=str(parent),
        generationCap=6,tokensPerGeneration=96,totalSeconds=600,fixedSelectionCalls=4,
        selectionConditionOrder=[c[0] for c in scheduled_conditions(number)],selectionConditions=list(CONDITIONS),
        allChoicesBeforeObservations=True,allChoicesGreedyWithSameSeed=True,
        adapterPairsUseIdenticalPrompt=True,chatBoundaryPairsKeepAllOriginalWords=True,
        twoPredeclaredObservationConditions=list(OBSERVATION_CONDITIONS),
        maximumDependentObservationCalls=2,noMeasurementComparisonThisRun=True,
        noMetricTableOrResults=True,noForcedGrammar=True,noAdaptiveRetry=True,
        noHostHistorySelection=True,nativeControlNotProductionFallback=True,
        oldV1AndV2OriginalsAndAuditsUnchanged=True,routingKernelSha256=routing_kernel_sha,
        bindingAuditKernelSha256=binding_kernel_sha,sourceEvidenceHash=evidence['evidenceHash'],
        sourceExperienceZips=4,originalHeldoutExcludedFromSelectionAndObservation=True,
        observationMeaningAndTruthNotCertified=True,productionBankUpdated=False,
        newMathematicsObjects=0,teacherCalls=0,trainingUpdates=0))
    write_once(args.out/'source-checkpoint.json',dict(sourceHashes=resume['sourceHashes'],
        sourceResultSha256=sha(parent/'result.json'),sourceSemanticStateHash=resume['final']['semanticStateHash'],
        sourceHead=resume['final']['head'],sourceLabels=resume['final']['labels'],sourceMetaZip=resume['initialMeta']))
    write_once(args.out/'experience-evidence.json',evidence);write_once(args.out/'source-provenance.json',provenance)
    for path in Path(__file__).parent.glob('*.py'):
        target=args.out/'evaluation-code'/path.name;target.parent.mkdir(exist_ok=True);target.write_bytes(path.read_bytes())
    source_folder=args.out/'source-experience-zips';source_snapshot=write_source_zips(source_folder,evidence)
    note_folder=args.out/'student-observation-zips';note_folder.mkdir()
    note_hashes={};raw=[];scored=[];notes=[];attempt_rows=[];source_reads=[];stages=[];input_audits=[]
    base=mathematical=semantic=None;base_before=math_before=semantic_before=None
    base_after=math_after=semantic_after=None
    source_ok=protected_ok=original_tools_ok=source_zips_ok=frozen_ok=None
    limits=input_preflight=None;attempts=0;stop='completed';error=None
    deadline=time.monotonic()+max(0.,float(os.environ.get('ZIP_EXPERIENCE_ROUTING_DEADLINE',str(time.time()+600)))-time.time())
    def save(kind,row):
        key=row['recordId'] if kind in ('raw','scored') else row['id']
        folder='responses' if kind in ('raw','scored') else kind
        suffix='-'+kind if kind in ('raw','scored') else ''
        write_once(args.out/folder/(key+suffix+'.json'),row)
        target={'raw':raw,'scored':scored,'note-candidate':notes,'observation-stage':stages,'source-read':source_reads}.get(kind)
        if target is not None:target.append(copy.deepcopy(row))
        progress.mark(rawResponsesSaved=len(raw),scoredResponses=len(scored),generationAttempts=attempts,
            completedSelections=sum(r['phase']=='experience_choice' for r in scored),completedObservationStages=len(stages),studentObservationZips=len(note_hashes),selectedSourceZipReads=len(source_reads),inFlight=None)
    def install(note):
        name=note['id']+'.zip';require(name not in note_hashes,'Duplicate observation ZIP install')
        note_hashes[name]=write_note_zip(note_folder,note,evidence)
        write_once(args.out/'note-byte-manifest'/(note['id']+'.json'),dict(name=name,sha256=note_hashes[name]))
    def replay_notes():return read_note_zips(note_folder,note_hashes,evidence)
    def read_selected(identifier):return read_source_zip(source_folder,evidence,identifier,source_snapshot)
    def timeout(signum,handler):raise TimeoutError('Experience-routing ten-minute deadline reached')
    old_term=signal.signal(signal.SIGTERM,timeout);old_alarm=signal.signal(signal.SIGALRM,timeout)
    signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
    try:
        progress.mark('只加载 tokenizer；预检原提示、独立当前指令和四份可能选中经历')
        limits,input_preflight=prepare_inputs(args.student,evidence,number)
        write_once(args.out/'prompt-length-preflight.json',input_preflight)
        for row in input_preflight['rows']:
            require_input(row['audit']);require(row['planningFits'],'Input planning reserve exceeds context; no truncation')
        progress.mark('加载冻结学生；四组选择固定执行，成功的新接口才请求观察')
        from safetensors.torch import load_file
        from zip_pilot import load_student
        from zip_pilot_model import state_digest
        from math_writer_adapter import MathWriterAdapter
        base,tokenizer,metadata=load_student(args.student,'cpu')
        require(metadata['snapshotSha256']==checked['identity']['snapshotSha256'],'Student snapshot differs')
        base_before=state_digest(base);require(base_before==resume['result']['baseStateBefore'],'Base weights differ')
        mathematical=MathWriterAdapter(base,rank=8,last_layers=4,alpha=16)
        mathematical.restore(load_file(str(checked['writer'])));math_before=mathematical.digest()
        require(math_before==checked['checkpoint']['writerStateHash'],'Math writer differs')
        semantic=MathWriterAdapter(base,rank=8,last_layers=4,alpha=16)
        semantic.restore(load_file(str(parent/'checkpoints'/resume['final']['semanticFile'])));semantic_before=semantic.digest()
        require(semantic_before==resume['final']['semanticStateHash'],'Semantic writer differs')
        base.eval().requires_grad_(False);mathematical.eval();semantic.eval()
        for parameter in mathematical.parameters_to_train()+semantic.parameters_to_train():
            parameter.requires_grad_(False);parameter.grad=None
        write_once(args.out/'observed-model-identity.json',dict(snapshotSha256=metadata['snapshotSha256'],
            baseStateHash=base_before,mathematicalStateHash=math_before,semanticStateHash=semantic_before,allParametersFrozen=True))
        def frozen():
            require(snapshot(source_folder)==source_snapshot and
                sha(Path(__file__).with_name('zip_experience_routing_core.py'))==routing_kernel_sha and
                sha(Path(__file__).with_name('zip_experience_binding_core.py'))==binding_kernel_sha,
                'Routing bank/audit kernel changed')
            replay_notes()
            require(mathematical.enabled and semantic.enabled and not base.training and not mathematical.training and not semantic.training and
                all(not p.requires_grad and p.grad is None for p in list(base.parameters())+mathematical.parameters_to_train()+semantic.parameters_to_train()),
                'Frozen flags or gradients changed')
            require(state_digest(base)==base_before and mathematical.digest()==math_before and semantic.digest()==semantic_before,
                'Frozen parameter changed')
        def ask(messages,phase,seed,sampled,semantic_enabled):
            nonlocal attempts
            require(attempts<MAX_GENERATIONS,'Six-generation routing cap reached')
            audit=prompt_audit(tokenizer,messages,limits);input_audits.append(copy.deepcopy(audit))
            # Paired seeds deliberately repeat, so paths use the call index.
            write_once(args.out/'prompt-inputs'/(str(attempts+1)+'-'+phase+'.json'),
                dict(phase=phase,samplingSeed=seed,requestedSemanticAdapterEnabled=semantic_enabled,studentPrompt=messages,audit=audit,studentGenerationStarted=False))
            require_input(audit);attempts+=1
            progress.mark('经历接口 '+str(attempts)+'/6：'+phase+' | 语义适配器 '+('开' if semantic_enabled else '关'),generationAttempts=attempts,inFlight=dict(phase=phase,seed=seed,semanticAdapterEnabled=semantic_enabled))
            begin=time.monotonic();sampler_phase='experience_review'
            require(sampled is False and type(semantic_enabled) is bool,'Fixed greedy routing conditions required')
            with mathematical.active(False),semantic.active(semantic_enabled):
                require(mathematical.enabled is False and semantic.enabled is semantic_enabled,'Actual adapter switches differ before generation')
                observed_math,observed_semantic=mathematical.enabled,semantic.enabled
                value=generate(base,tokenizer,messages,sampler_phase,seed,sampled,input_audit=audit)
                require(mathematical.enabled is observed_math and semantic.enabled is observed_semantic,'Adapter switch changed during generation')
            return dict(value,mathAdapterEnabledDuringGeneration=observed_math,semanticAdapterEnabledDuringGeneration=observed_semantic,
                semanticStateHashDuringGeneration=semantic_before,generationSeconds=time.monotonic()-begin,
                promptInputAudit={k:v for k,v in audit.items() if k!='promptIds'})
        run_experiment(evidence,number,ask,save,frozen,lambda:deadline-time.monotonic(),read_selected,install,replay_notes)
        frozen();frozen_ok=True
    except Exception as exc:
        stop='time_budget' if isinstance(exc,TimeoutError) else 'error';error=type(exc).__name__+': '+str(exc)
        write_once(args.out/'error.json',dict(error=error,traceback=traceback.format_exc(),generationAttempts=attempts,
            rawResponsesSaved=len(raw),scoredResponses=len(scored),modelWeightsLoaded=base is not None))
        print('经历接口 实验停止：'+error,flush=True)
    finally:
        signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGTERM,old_term);signal.signal(signal.SIGALRM,old_alarm)
        try:
            if base is not None and base_before is not None:base_after=state_digest(base)
            if mathematical is not None:math_after=mathematical.digest()
            if semantic is not None:semantic_after=semantic.digest()
            source_ok=snapshot(parent)==resume['sourceHashes']
            protected_ok=all(sha(Path(p))==h for p,h in checked['protected'].items())
            original_tools_ok=snapshot(args.old_tools.resolve())==checked['toolFiles']
            source_zips_ok=snapshot(source_folder)==source_snapshot
            replay_notes()
            require(source_ok and protected_ok and original_tools_ok and source_zips_ok and
                (base is None or base_before is not None and base_after==base_before) and
                (mathematical is None or math_before==math_after) and (semantic is None or semantic_before==semantic_after),
                'Final source/model/tool frozen check failed')
        except Exception as exc:stop='error';error=(error+'; ' if error else '')+'Final check: '+str(exc)
        if semantic is not None:semantic.close()
        if mathematical is not None:mathematical.close()
    report=summarize(raw,scored,notes,stages,source_reads,stop,number)
    result=dict(protocol=PROTOCOL,experimentNumber=number,stopReason=stop,error=error,fixtureOnly=False,
        fixtureGenerations=0,actualStudentGenerations=len(raw),generationAttempts=attempts,
        rawResponsesSaved=len(raw),scoredResponses=len(scored),rawResponsesWithoutCompletedAudit=len(raw)-len(scored),
        modelWeightsLoaded=base is not None,inputPreflightPassed=input_preflight['allPlannedPromptsFit'] if input_preflight else False,
        inputLimits=limits,checkedActualInputTokenCounts=[a['inputTokens'] for a in input_audits],
        baseStateBefore=base_before,baseStateAfter=base_after,semanticStateBefore=semantic_before,semanticStateAfter=semantic_after,
        baseWeightsUnchanged=bool(protected_ok) if base is None else base_before is not None and base_before==base_after,
        mathematicalWriterUnchanged=bool(protected_ok) if mathematical is None else math_before==math_after,
        semanticWriterUnchanged=bool(source_ok) if semantic is None else semantic_before==semantic_after,
        sourceFilesUnchanged=source_ok,sourceExperienceZipsUnchanged=source_zips_ok,inMemoryFrozenFlagsChecked=frozen_ok,
        sourceBoundStudentHypothesisZips=len(note_hashes),actualSelectedSourceZipReads=len(source_reads),trainingUpdates=0,teacherCalls=0,featureForwardBatches=0,
        productionCheckpointOrBankUpdated=False,summary=report,elapsedSeconds=time.monotonic()-start)
    write_once(args.out/'result.json',result)
    lines=['# 经历选择接口与适配器固定对照','',
        '原提示与独立当前指令各用语义适配器开启、关闭执行一次贪心选择。四次独立调用固定执行；某组无效不会跳过另一组或触发重试。两种提示保留全部原字词，只改变用户轮次边界。','',
        '只有预先指定的新接口两组在实际选择通过后才取回原 ZIP 并生成一句观察。原生控制不会自动替换生产检查点；来源绑定的观察仍是未审阅假设。v1、v2 原文与规则保留。','',
        '这是同一经历上下文的接口诊断，不是训练，也没有测试记忆复用或数学收益。','',
        '```json',json.dumps(report,ensure_ascii=False,indent=2),'```','']
    for row in scored:
        lines+=['## '+row['recordId'],'','````text',row['studentOutput']['raw'],'````','',
            '状态：'+row['check']['status']+'；原因：'+str(row['check']['reason']),'']
    (args.out/'Lain-Zip-Experience-Routing-Review.md').write_text('\n'.join(lines),encoding='utf-8')
    archive=args.out/'Lain-Zip-Experience-Routing-Results.zip'
    with zipfile.ZipFile(archive,'x',zipfile.ZIP_DEFLATED) as z:
        for path in sorted(args.out.rglob('*')):
            if path.is_file() and path!=archive:z.write(path,path.relative_to(args.out))
    print('经历接口 配对摘要：'+json.dumps(report,ensure_ascii=False),flush=True)
    print('完整性：'+json.dumps({k:result[k] for k in ('stopReason','error','actualStudentGenerations','sourceBoundStudentHypothesisZips','actualSelectedSourceZipReads',
        'trainingUpdates','teacherCalls','baseWeightsUnchanged','mathematicalWriterUnchanged','semanticWriterUnchanged','sourceFilesUnchanged')},ensure_ascii=False),flush=True)
    print('实验结果：'+str(archive),flush=True)
    return 0 if stop=='completed' else 1


def main():
    parser=argparse.ArgumentParser()
    for name in ('source','work','student','old-tools','out'):parser.add_argument('--'+name,type=Path)
    parser.add_argument('--inspect-only',action='store_true');args=parser.parse_args()
    require(args.source is not None,'Original source required')
    if args.inspect_only:
        resume=inspect_source(args.source);evidence,provenance=load_evidence(resume)
        print(json.dumps(dict(protocol=PROTOCOL,sourceProtocol=resume['result']['protocol'],
            sourceEvidenceHash=evidence['evidenceHash'],trainingHistories=4,evaluationHistories=4,originalRoutes=24,
            originalChoicePrompt=routing_messages(evidence,'combined_semantic'),
            correctedChoicePrompt=routing_messages(evidence,'separate_semantic'),
            fixedSelectionCalls=4,maximumStudentGenerations=6,studentCalls=0,
            teacherCalls=0,trainingUpdates=0,modelNotLoaded=True,heldoutExcluded=True),ensure_ascii=False),flush=True)
        return 0
    for name in ('work','student','old_tools','out'):require(getattr(args,name) is not None,'Missing '+name)
    return run(args)


if __name__=='__main__':raise SystemExit(main())
