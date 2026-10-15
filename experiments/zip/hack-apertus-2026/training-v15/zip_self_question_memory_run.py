"""Frozen experience-memory acquisition and replay; no optimizer or teacher."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import signal
import time
import traceback
from types import SimpleNamespace
import zipfile

from draft_inspect_runtime import read, sha, snapshot
from writer_check_core import write_once
from writer_check_run import preflight
from zip_label_metacognitive_source import inspect_source
from zip_self_question_memory_source import load_evidence
from zip_self_question_memory_core import (PROTOCOL, ARMS, MAX_GENERATIONS, MAX_TOKENS, require,
    build_bank, validate_bank, validate_memory, memory_messages, review_messages, call_messages,
    execute_measurement, run_experiment, summarize)
from zip_self_question_tools_policy import input_limits, prompt_audit, require_input, generate
from zip_label_metacognitive_progress import StageProgress


def write_memory_zip(folder, memory, evidence):
    validate_memory(memory,evidence)
    require(memory['eligible'], 'Only source-bound complete student memories are replayable')
    path=folder/(memory['id']+'.zip');path.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(path,'x',zipfile.ZIP_DEFLATED) as z:
        z.writestr('root.json',json.dumps(memory,ensure_ascii=False,indent=2))
        z.writestr('student-original.json',json.dumps(memory['studentOriginal'],ensure_ascii=False,indent=2))
        h=next(h for h in evidence['training'] if h['historyId']==memory['claimAudit']['selectedHistoryId'])
        z.writestr('source-experience.json',json.dumps(h,ensure_ascii=False,indent=2))
    return sha(path)


def read_memory_zips(folder, hashes, evidence):
    require({p.name for p in folder.glob('*.zip')}==set(hashes), 'Memory ZIP set changed')
    memories=[]
    for name,expected in sorted(hashes.items()):
        path=folder/name
        require(sha(path)==expected,'Memory ZIP bytes changed')
        with zipfile.ZipFile(path) as z:
            require(z.namelist()==['root.json','student-original.json','source-experience.json'] and
                z.testzip() is None,'Memory ZIP contents changed')
            memory=json.loads(z.read('root.json'));validate_memory(memory,evidence)
            history=next(h for h in evidence['training'] if h['historyId']==memory['claimAudit']['selectedHistoryId'])
            require(memory['eligible'] and memory['id']+'.zip'==name and
                json.loads(z.read('student-original.json'))==memory['studentOriginal'] and
                json.loads(z.read('source-experience.json'))==history,'Memory source or student original differs')
            memories.append(memory)
    return memories


def write_measurement_zips(folder,bank):
    validate_bank(bank);folder.mkdir(parents=True,exist_ok=False)
    kernel=Path(__file__).with_name('zip_self_question_memory_core.py').read_bytes()
    require(hashlib.sha256(kernel).hexdigest()==bank['tools'][0]['kernelSha256'],'Kernel identity differs')
    for root in bank['tools']:
        with zipfile.ZipFile(folder/(root['id']+'.zip'),'x',zipfile.ZIP_DEFLATED) as z:
            z.writestr('root.json',json.dumps(root,ensure_ascii=False,indent=2));z.writestr('kernel.py',kernel)
    write_once(folder/'bank.json',bank)
    return snapshot(folder)


def validate_measurement_zip(folder,bank,identifier):
    root=next(t for t in bank['tools'] if t['id']==identifier)
    with zipfile.ZipFile(folder/(identifier+'.zip')) as z:
        require(z.namelist()==['root.json','kernel.py'] and z.testzip() is None and
            json.loads(z.read('root.json'))==root and
            hashlib.sha256(z.read('kernel.py')).hexdigest()==root['kernelSha256'],'Selected measurement ZIP changed')


def next_number(work):
    numbers=[]
    for path in Path(work).glob('zip-experience-memory-*/protocol.json'):
        row=read(path)
        if row.get('protocol')==PROTOCOL:
            n=row['experimentNumber'];require(type(n) is int and 1<=n<=1000,'Invalid reserved memory experiment number')
            numbers.append(n)
    value=max(numbers,default=0)+1
    require(value<=1000,'Memory experiment namespace exhausted')
    return value


def prepare_inputs(student,evidence,bank,number):
    from transformers import AutoTokenizer
    tokenizer=AutoTokenizer.from_pretrained(student,local_files_only=True,trust_remote_code=False,fix_mistral_regex=False)
    limits=input_limits(read(student/'config.json'),tokenizer)
    # Prefix shapes only: these placeholders are never student generations,
    # claimed measurements, memory candidates or scores.
    placeholder=dict(raw='[student assessment not generated yet]',stopReason='eos',tokenCapReached=False)
    shapes=[('memory_write',memory_messages(evidence),0),
        ('evaluation_review',review_messages(evidence,[],ARMS[0]),6*MAX_TOKENS),
        ('metric_zip_call',call_messages(placeholder,bank,number),4*MAX_TOKENS)]
    rows=[]
    for phase,messages,reserve in shapes:
        audit=prompt_audit(tokenizer,messages,limits)
        rows.append(dict(phase=phase,audit=audit,planningEchoReserve=reserve,
            planningFits=audit['fitsInputBudget'] and audit['inputTokens']+reserve<=limits['maxInputTokens']))
    return limits,dict(rows=rows,allPlannedPromptsFit=all(r['planningFits'] for r in rows),
        tokenizerOnly=True,modelWeightsLoaded=False,actualStudentGenerations=0,
        selectedMeasurementsExecuted=0,actualMemoryAndReviewEchoesRechecked=True)


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
    kernel_sha=sha(Path(__file__).with_name('zip_self_question_memory_core.py'));bank=build_bank(kernel_sha)
    progress=StageProgress(os.environ.get('ZIP_EXPERIENCE_MEMORY_PROGRESS_FILE'))
    write_once(args.out/'protocol.json',dict(protocol=PROTOCOL,experimentNumber=number,
        sourceCheckpoint=str(parent),generationCap=6,tokensPerGeneration=96,totalSeconds=600,
        studentWritesMemory=True,sourceBoundOutcomeOnlyCertified=True,studentExplanationsRemainHypotheses=True,
        trainingHistoriesForMemory=4,sourceHeldoutHistoriesForEvaluation=4,originalHeldoutExcludedFromMemoryWriting=True,
        pairedArms=list(ARMS),pairedReviewSeedAndMode=True,pairedCallSeedAndMode=True,
        sharedEvidenceAndCatalogue=True,sharedTrainingReferenceHistories=True,
        currentRequestsAfterRecordsAndCatalogue=True,oneComparisonContext=True,
        memoryAcquisitionCalls=2,maximumPairedReplayCalls=4,memoryGenerationSchedule=['greedy','sampled'],
        noAdaptiveRetry=True,noHostMetricSelection=True,noMetricTableBeforeSelection=True,
        noReusableMemorySkipsPairedReplay=True,
        localInputLimitsAndOriginalTokenizerCheckedBeforeWeights=True,everyActualInputRechecked=True,
        sourceEvidenceHash=evidence['evidenceHash'],bankHash=bank['bankHash'],
        sourceHeldoutHistoriesPreviouslyGenerated=True,newMathematicsObjects=0,teacherCalls=0,
        trainingUpdates=0,productionSourceBankUnchanged=True,originalScoresUnchanged=True,
        autonomousMemoryRetrievalTested=False,uniqueZipEncodingEffectIsolated=False,
        diagnosisUsefulnessAndMathematicalBenefitNotCertified=True))
    write_once(args.out/'source-checkpoint.json',dict(sourceHashes=resume['sourceHashes'],
        sourceResultSha256=sha(parent/'result.json'),sourceSemanticStateHash=resume['final']['semanticStateHash'],
        sourceHead=resume['final']['head'],sourceLabels=resume['final']['labels'],sourceMetaZip=resume['initialMeta']))
    write_once(args.out/'experience-evidence.json',evidence);write_once(args.out/'source-provenance.json',provenance)
    for path in Path(__file__).parent.glob('*.py'):
        target=args.out/'evaluation-code'/path.name;target.parent.mkdir(exist_ok=True);target.write_bytes(path.read_bytes())
    tool_folder=args.out/'measurement-zips';tool_snapshot=write_measurement_zips(tool_folder,bank)
    memory_folder=args.out/'experience-zips';memory_folder.mkdir()
    memory_hashes={};raw=[];scored=[];memories=[];arms=[];tools=[];input_audits=[]
    base=mathematical=semantic=None;base_before=math_before=semantic_before=None
    base_after=math_after=semantic_after=None
    source_ok=protected_ok=original_tools_ok=bank_ok=frozen_ok=None
    limits=input_preflight=None;attempts=0;stop='completed';error=None
    deadline=time.monotonic()+max(0.,float(os.environ.get('ZIP_EXPERIENCE_MEMORY_DEADLINE',str(time.time()+600)))-time.time())
    def save(kind,row):
        key=row['recordId'] if kind in ('raw','scored') else row['id']
        folder='responses' if kind in ('raw','scored') else kind
        suffix='-'+kind if kind in ('raw','scored') else ''
        write_once(args.out/folder/(key+suffix+'.json'),row)
        target={'raw':raw,'scored':scored,'memory-candidate':memories,'arm':arms,'tool-executed':tools}.get(kind)
        if target is not None:target.append(copy.deepcopy(row))
        progress.mark(rawResponsesSaved=len(raw),scoredResponses=len(scored),generationAttempts=attempts,
            completedAttempts=len(arms),studentMemoryZips=len(memory_hashes),inFlight=None)
    def install(memory):
        name=memory['id']+'.zip';require(name not in memory_hashes,'Duplicate memory install')
        memory_hashes[name]=write_memory_zip(memory_folder,memory,evidence)
        write_once(args.out/'memory-byte-manifest'/(memory['id']+'.json'),dict(name=name,sha256=memory_hashes[name]))
    def replay_memories():return read_memory_zips(memory_folder,memory_hashes,evidence)
    def timeout(signum,handler):raise TimeoutError('Experience-memory ten-minute deadline reached')
    old_term=signal.signal(signal.SIGTERM,timeout);old_alarm=signal.signal(signal.SIGALRM,timeout)
    signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
    try:
        progress.mark('只加载 tokenizer；先核验记忆写作与配对复用的真实输入长度')
        limits,input_preflight=prepare_inputs(args.student,evidence,bank,number)
        write_once(args.out/'prompt-length-preflight.json',input_preflight)
        for row in input_preflight['rows']:
            require_input(row['audit']);require(row['planningFits'],'Input planning reserve exceeds context; no truncation')
        progress.mark('加载同一个冻结学生；写两份经历记忆，再做有／无记忆配对复用')
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
            require(snapshot(tool_folder)==tool_snapshot and sha(Path(__file__).with_name('zip_self_question_memory_core.py'))==kernel_sha,
                'Measurement bank/kernel changed')
            replay_memories()
            require(mathematical.enabled and semantic.enabled and not base.training and not mathematical.training and not semantic.training and
                all(not p.requires_grad and p.grad is None for p in list(base.parameters())+mathematical.parameters_to_train()+semantic.parameters_to_train()),
                'Frozen flags or gradients changed')
            require(state_digest(base)==base_before and mathematical.digest()==math_before and semantic.digest()==semantic_before,
                'Frozen parameter changed')
        def ask(messages,phase,seed,sampled):
            nonlocal attempts
            require(attempts<MAX_GENERATIONS,'Six-generation cap reached')
            audit=prompt_audit(tokenizer,messages,limits);input_audits.append(copy.deepcopy(audit))
            # Paired seeds deliberately repeat, so paths use the call index.
            write_once(args.out/'prompt-inputs'/(str(attempts+1)+'-'+phase+'.json'),
                dict(phase=phase,samplingSeed=seed,studentPrompt=messages,audit=audit,studentGenerationStarted=False))
            require_input(audit);attempts+=1
            progress.mark('经历 ZIP '+str(attempts)+'/6：'+phase,generationAttempts=attempts,inFlight=dict(phase=phase,seed=seed))
            begin=time.monotonic();sampler_phase='metric_zip_call' if phase=='metric_zip_call' else 'experience_review'
            with mathematical.active(False),semantic.active(True):
                value=generate(base,tokenizer,messages,sampler_phase,seed,sampled,input_audit=audit)
            return dict(value,mathAdapterEnabledDuringGeneration=False,semanticAdapterEnabledDuringGeneration=True,
                semanticStateHashDuringGeneration=semantic_before,generationSeconds=time.monotonic()-begin,
                promptInputAudit={k:v for k,v in audit.items() if k!='promptIds'})
        def measure(source,tool_bank,output,check):
            validate_measurement_zip(tool_folder,tool_bank,check['zipId'])
            return execute_measurement(source,tool_bank,output,check)
        run_experiment(evidence,bank,number,ask,save,frozen,lambda:deadline-time.monotonic(),install,replay_memories,measure)
        frozen();frozen_ok=True
    except Exception as exc:
        stop='time_budget' if isinstance(exc,TimeoutError) else 'error';error=type(exc).__name__+': '+str(exc)
        write_once(args.out/'error.json',dict(error=error,traceback=traceback.format_exc(),generationAttempts=attempts,
            rawResponsesSaved=len(raw),scoredResponses=len(scored),modelWeightsLoaded=base is not None))
        print('经历 ZIP 实验停止：'+error,flush=True)
    finally:
        signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGTERM,old_term);signal.signal(signal.SIGALRM,old_alarm)
        try:
            if base is not None and base_before is not None:base_after=state_digest(base)
            if mathematical is not None:math_after=mathematical.digest()
            if semantic is not None:semantic_after=semantic.digest()
            source_ok=snapshot(parent)==resume['sourceHashes']
            protected_ok=all(sha(Path(p))==h for p,h in checked['protected'].items())
            original_tools_ok=snapshot(args.old_tools.resolve())==checked['toolFiles']
            bank_ok=snapshot(tool_folder)==tool_snapshot
            replay_memories()
            require(source_ok and protected_ok and original_tools_ok and bank_ok and
                (base is None or base_before is not None and base_after==base_before) and
                (mathematical is None or math_before==math_after) and (semantic is None or semantic_before==semantic_after),
                'Final source/model/tool frozen check failed')
        except Exception as exc:stop='error';error=(error+'; ' if error else '')+'Final check: '+str(exc)
        if semantic is not None:semantic.close()
        if mathematical is not None:mathematical.close()
    report=summarize(raw,scored,memories,arms,tools,stop)
    result=dict(protocol=PROTOCOL,experimentNumber=number,stopReason=stop,error=error,fixtureOnly=False,
        fixtureGenerations=0,actualStudentGenerations=len(raw),generationAttempts=attempts,
        rawResponsesSaved=len(raw),scoredResponses=len(scored),rawResponsesWithoutCompletedAudit=len(raw)-len(scored),
        modelWeightsLoaded=base is not None,inputPreflightPassed=input_preflight['allPlannedPromptsFit'] if input_preflight else False,
        inputLimits=limits,checkedActualInputTokenCounts=[a['inputTokens'] for a in input_audits],
        baseStateBefore=base_before,baseStateAfter=base_after,semanticStateBefore=semantic_before,semanticStateAfter=semantic_after,
        baseWeightsUnchanged=bool(protected_ok) if base is None else base_before is not None and base_before==base_after,
        mathematicalWriterUnchanged=bool(protected_ok) if mathematical is None else math_before==math_after,
        semanticWriterUnchanged=bool(source_ok) if semantic is None else semantic_before==semantic_after,
        sourceFilesUnchanged=source_ok,measurementToolsUnchanged=bank_ok,inMemoryFrozenFlagsChecked=frozen_ok,
        studentWrittenExperienceZips=len(memory_hashes),trainingUpdates=0,teacherCalls=0,featureForwardBatches=0,
        productionCheckpointOrBankUpdated=False,summary=report,elapsedSeconds=time.monotonic()-start)
    write_once(args.out/'result.json',result)
    lines=['# 学生经历 ZIP 与冻结配对复用','',
        '两次学生记忆写作；同一冻结学生、同一保留经历集合、相同种子和解码模式，比较有／无新增记忆。两边均保留相同原始训练参考经历。记忆只核验学生明确引用的一条成败事实；其余解释、原因和计划保留为假设。学生指标调用实际通过后才执行工具。','',
        '这四份保留经历来自已核验原来源，未用于本次记忆写作；并非本次新生成、此前从未见过的新数学题。每组只有一次评估生成，属于一个配对上下文。事实复述、格式通过、读得通都不能证明理解；此实验未检验数学收益、独立重训练复现或 ZIP 编码本身的独特优势。','',
        '```json',json.dumps(report,ensure_ascii=False,indent=2),'```','']
    for row in scored:
        lines+=['## '+row['recordId'],'','````text',row['studentOutput']['raw'],'````','',
            '状态：'+row['check']['status']+'；原因：'+str(row['check']['reason']),'']
    (args.out/'Lain-Zip-Experience-Memory-Review.md').write_text('\n'.join(lines),encoding='utf-8')
    archive=args.out/'Lain-Zip-Experience-Memory-Results.zip'
    with zipfile.ZipFile(archive,'x',zipfile.ZIP_DEFLATED) as z:
        for path in sorted(args.out.rglob('*')):
            if path.is_file() and path!=archive:z.write(path,path.relative_to(args.out))
    print('经历 ZIP 配对摘要：'+json.dumps(report,ensure_ascii=False),flush=True)
    print('完整性：'+json.dumps({k:result[k] for k in ('stopReason','error','actualStudentGenerations','studentWrittenExperienceZips',
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
        print(json.dumps(dict(sourceProtocol=resume['result']['protocol'],evidenceHash=evidence['evidenceHash'],
            memoryTrainingHistories=4,evaluationHeldoutHistories=4,originalRouteCount=24,
            firstMemoryPrompt=memory_messages(evidence),maximumStudentGenerations=6,
            studentCalls=0,teacherCalls=0,trainingUpdates=0,modelNotLoaded=True,
            heldoutExcludedFromMemoryWriting=True),ensure_ascii=False),flush=True);return 0
    for name in ('work','student','old_tools','out'):require(getattr(args,name) is not None,'Missing '+name)
    return run(args)


if __name__=='__main__':raise SystemExit(main())
