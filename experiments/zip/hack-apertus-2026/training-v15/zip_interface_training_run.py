"""Train one experimental interface adapter; leave every source state intact."""
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
from zip_self_question_tools_policy import input_limits,prompt_audit,require_input,generate
from zip_label_metacognitive_progress import StageProgress
from zip_interface_training_core import (PROTOCOL,MAX_GENERATIONS,MAX_TOKENS,TRAINING_STEPS,
    require,build_bank,validate_bank,make_lessons,validate_lessons,evaluation_messages,source_root,
    selected_observation_input,call_input,validate_note,seed_for,run_experiment,summarize,execute_measurement)
from zip_interface_training_policy import eos_ids,encode_lesson,validate_packet,train_interface,validate_steps


def write_note_zip(folder,note,evidence,bank):
    validate_note(note,evidence,bank);require(note['eligibleForFrozenContext'],'Ineligible hypothesis ZIP')
    path=folder/(note['id']+'.zip')
    with zipfile.ZipFile(path,'x',zipfile.ZIP_DEFLATED) as z:
        for name,value in (('root.json',note),('student-choice.json',note['studentChoice']),
                ('student-observation.json',note['studentObservation']),('source-experience.json',note['sourceZip'])):
            z.writestr(name,json.dumps(value,ensure_ascii=False,indent=2))
    return sha(path)


def read_note_zips(folder,hashes,evidence,bank):
    require({p.name for p in folder.glob('*.zip')}==set(hashes),'Observation ZIP set changed');notes=[]
    for name,expected in sorted(hashes.items()):
        path=folder/name;require(sha(path)==expected,'Observation ZIP bytes changed')
        with zipfile.ZipFile(path) as z:
            require(z.namelist()==['root.json','student-choice.json','student-observation.json','source-experience.json'] and z.testzip() is None,'Observation ZIP entries changed')
            note=json.loads(z.read('root.json'));validate_note(note,evidence,bank)
            require(note['eligibleForFrozenContext'] and note['id']+'.zip'==name and
                json.loads(z.read('student-choice.json'))==note['studentChoice'] and
                json.loads(z.read('student-observation.json'))==note['studentObservation'] and
                json.loads(z.read('source-experience.json'))==note['sourceZip'],'Whole student original changed')
            notes.append(note)
    return notes


def write_measurement_zips(folder,bank,kernel):
    validate_bank(bank);folder.mkdir();data=kernel.read_bytes()
    require(sha(kernel)==bank['tools'][0]['kernelSha256'],'Actual measurement kernel differs')
    for root in bank['tools']:
        with zipfile.ZipFile(folder/(root['id']+'.zip'),'x',zipfile.ZIP_DEFLATED) as z:
            z.writestr('root.json',json.dumps(root,ensure_ascii=False,indent=2))
            z.writestr('zip_interface_training_core.py',data)
    return snapshot(folder)


def validate_measurement_zip(folder,bank,identifier,expected,kernel):
    validate_bank(bank);require(snapshot(folder)==expected,'Native measurement bank changed')
    root=next(t for t in bank['tools'] if t['id']==identifier)
    with zipfile.ZipFile(folder/(identifier+'.zip')) as z:
        require(z.namelist()==['root.json','zip_interface_training_core.py'] and z.testzip() is None and
            json.loads(z.read('root.json'))==root and z.read('zip_interface_training_core.py')==kernel.read_bytes(),
            'Selected native measurement ZIP does not bind its root and executable kernel')


def next_number(work):
    numbers=[]
    for path in Path(work).glob('zip-interface-training-*/protocol.json'):
        row=read(path)
        if row.get('protocol')==PROTOCOL:
            n=row['experimentNumber'];require(type(n) is int and 1<=n<=1000,'Invalid reserved interface-training number');numbers.append(n)
    value=max(numbers,default=0)+1;require(value<=1000,'Interface-training seed namespace exhausted');return value


def prepare_inputs(student,evidence,bank,lessons,number):
    from transformers import AutoTokenizer
    tokenizer=AutoTokenizer.from_pretrained(student,local_files_only=True,trust_remote_code=False,fix_mistral_regex=False)
    limits=input_limits(read(student/'config.json'),tokenizer)
    generation_config=read(student/'generation_config.json') if (student/'generation_config.json').is_file() else read(student/'config.json')
    stops=eos_ids(generation_config,tokenizer)
    packets={r['id']:encode_lesson(tokenizer,r,limits,stops) for r in lessons['examples']}
    shapes=[(p,evaluation_messages(evidence,p,number),0) for p in ('source_lookup','experience_choice')]
    for h in evidence['training']:
        root=source_root(h,evidence)
        shapes.append(('observation-'+h['historyId'],selected_observation_input(root),0))
        # None is a tokenizer-only shape, never a fabricated student note.
        shapes.append(('call-'+h['historyId'],call_input(bank,root,None,number),2*MAX_TOKENS))
    rows=[]
    for name,messages,reserve in shapes:
        audit=prompt_audit(tokenizer,messages,limits)
        rows.append(dict(phase=name,audit=audit,planningEchoReserve=reserve,studentResponse=False,
            planningFits=audit['fitsInputBudget'] and audit['inputTokens']+reserve<=limits['maxInputTokens']))
    report=dict(rows=rows,trainingExamples=len(packets),trainingPacketsAllChecked=True,
        allPlannedPromptsFit=all(r['planningFits'] for r in rows),tokenizerOnly=True,
        modelWeightsLoaded=False,actualStudentGenerations=0,optimizerSteps=0,
        placeholderStudentChoiceCreated=False,placeholderStudentObservationCreated=False,
        everyActualInputRechecked=True,configuredEosIds=stops)
    return limits,packets,report


def run(args):
    start=time.monotonic();parent=args.source.resolve();resume=inspect_source(parent)
    evidence,provenance=load_evidence(resume)
    require(not args.out.resolve().is_relative_to(parent) and not parent.is_relative_to(args.out.resolve()),'Output must be separate from original source')
    checked_args=SimpleNamespace(**vars(args));checked_args.source=Path(read(parent/'source-checkpoint.json')['baseChoiceSource']).resolve()
    checked=preflight(checked_args)
    require(checked['checkpoint']['writerStateHash']==resume['result']['mathematicalWriterStateHash'],'Mathematical source differs')
    number=next_number(args.work);args.out.mkdir(parents=True,exist_ok=False)
    kernel=Path(__file__).with_name('zip_interface_training_core.py');bank=build_bank(sha(kernel));lessons=make_lessons(evidence,bank)
    def runtime_codes():return {p.name:sha(p) for p in Path(__file__).parent.glob('*.py')}
    code_snapshot=runtime_codes()
    progress=StageProgress(os.environ.get('ZIP_INTERFACE_TRAINING_PROGRESS_FILE'));progress.mark(interfaceUpdates=0)
    write_once(args.out/'protocol.json',dict(protocol=PROTOCOL,experimentNumber=number,sourceCheckpoint=str(parent),
        generationCap=6,tokensPerGeneration=96,optimizerStepCap=6,totalSecondsIncludingStartup=600,
        fixedBeforeAfterEndpoints=['source_lookup','experience_choice'],baselineOldAdaptersDisabled=True,
        candidateOldAdaptersDisabled=True,independentInterfaceAdapter=True,productionCheckpointOrBankUpdated=False,
        teacherCalls=0,programSupervisedProceduralLabels=True,teacherForcedExamplesPerFullRun=22,
        hostChoosesWeaknessOrPlan=False,hostChoosesMetric=False,hostWritesStudentObservation=False,
        noNumericalMetricResultsBeforeStudentCall=True,noForcedGrammar=True,noAdaptiveRetry=True,
        sourceEvidenceHash=evidence['evidenceHash'],bankHash=bank['bankHash'],lessonHash=lessons['lessonHash'],
        heldoutExcludedFromTrainingAndAssessment=True,mathematicalBenefitTested=False,originalScoresChanged=False))
    write_once(args.out/'experience-evidence.json',evidence);write_once(args.out/'source-provenance.json',provenance)
    write_once(args.out/'measurement-bank.json',bank);write_once(args.out/'program-training-lessons.json',lessons)
    write_once(args.out/'source-checkpoint.json',dict(sourceHashes=resume['sourceHashes'],
        sourceResultSha256=sha(parent/'result.json'),sourceSemanticStateHash=resume['final']['semanticStateHash'],
        sourceHead=resume['final']['head'],sourceLabels=resume['final']['labels'],sourceMetaZip=resume['initialMeta']))
    for path in Path(__file__).parent.glob('*.py'):
        target=args.out/'evaluation-code'/path.name;target.parent.mkdir(exist_ok=True);target.write_bytes(path.read_bytes())
    source_folder=args.out/'source-experience-zips';source_snapshot=write_source_zips(source_folder,evidence)
    measure_folder=args.out/'measurement-zips';measure_snapshot=write_measurement_zips(measure_folder,bank,kernel)
    note_folder=args.out/'student-observation-zips';note_folder.mkdir();checkpoint_folder=args.out/'interface-checkpoints';checkpoint_folder.mkdir()
    note_hashes={};checkpoint_hashes={};raw=[];scored=[];notes=[];source_reads=[];tools=[];steps=[];input_audits=[]
    base=mathematical=semantic=interface=None;base_before=math_before=semantic_before=interface_before=expected_interface=None
    base_after=math_after=semantic_after=interface_after=None
    limits=packets=input_preflight=None;packet_digest=None;attempts=0;stop='completed';error=None;frozen_ok=None
    source_ok=protected_ok=original_tools_ok=source_zips_ok=None
    deadline=time.monotonic()+max(0.,float(os.environ.get('ZIP_INTERFACE_TRAINING_DEADLINE',str(time.time()+600)))-time.time())
    def save(kind,row):
        key=row['recordId'] if kind in ('raw','scored') else row['id']
        folder='responses' if kind in ('raw','scored') else kind;suffix='-'+kind if kind in ('raw','scored') else ''
        write_once(args.out/folder/(key+suffix+'.json'),row)
        target={'raw':raw,'scored':scored,'note-candidate':notes,'source-read':source_reads,'tool-executed':tools}.get(kind)
        if target is not None:target.append(copy.deepcopy(row))
        progress.mark(rawResponsesSaved=len(raw),scoredResponses=len(scored),generationAttempts=attempts,
            interfaceUpdates=len(steps),studentObservationZips=len(note_hashes),inFlight=None)
    def install(note):
        name=note['id']+'.zip';require(name not in note_hashes,'Duplicate hypothesis ZIP')
        note_hashes[name]=write_note_zip(note_folder,note,evidence,bank)
        write_once(args.out/'note-byte-manifest'/(note['id']+'.json'),dict(name=name,sha256=note_hashes[name]))
    def replay_notes():return read_note_zips(note_folder,note_hashes,evidence,bank)
    def read_selected(identifier):return read_source_zip(source_folder,evidence,identifier,source_snapshot)
    def measure(*values):
        validate_measurement_zip(measure_folder,bank,values[-1]['zipId'],measure_snapshot,kernel)
        return execute_measurement(*values)
    def timeout(signum,handler):raise TimeoutError('Interface-training ten-minute deadline reached')
    old_term=signal.signal(signal.SIGTERM,timeout);old_alarm=signal.signal(signal.SIGALRM,timeout)
    signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
    try:
        progress.mark('只加载 tokenizer；预检全部程序标签、训练前后提示和可能的依赖输入')
        limits,packets,input_preflight=prepare_inputs(args.student,evidence,bank,lessons,number)
        from zip_content_core import digest
        packet_digest=digest(packets)
        write_once(args.out/'prompt-length-preflight.json',input_preflight)
        write_once(args.out/'program-target-packets.json',packets)
        for row in input_preflight['rows']:
            require_input(row['audit']);require(row['planningFits'],'Input planning reserve exceeds context; no truncation')
        progress.mark('加载原学生并保护旧参数；创建独立接口适配器，先执行两次基线')
        import torch
        from safetensors.torch import load_file,save_file
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
        torch.manual_seed(seed_for(number,'adapter_initialization'))
        interface=MathWriterAdapter(base,rank=8,last_layers=4,alpha=16)
        base.eval().requires_grad_(False);mathematical.eval();semantic.eval();interface.eval()
        for p in mathematical.parameters_to_train()+semantic.parameters_to_train()+interface.parameters_to_train():p.requires_grad_(False);p.grad=None
        initial_state=interface.learned_state();b_values=[v for k,v in initial_state.items() if k.endswith('b.weight')]
        require(b_values and all(torch.count_nonzero(v).item()==0 for v in b_values),
            'New interface must start with exactly zero additive output')
        interface_before=expected_interface=interface.digest()
        save_file(interface.learned_state(),str(checkpoint_folder/'initial.safetensors'))
        checkpoint_hashes['initial.safetensors']=sha(checkpoint_folder/'initial.safetensors')
        model_stops=eos_ids(dict(eos_token_id=base.generation_config.eos_token_id),tokenizer)
        require(model_stops==input_preflight['configuredEosIds'],'Loaded model EOS differs from audited training target')
        for lesson in lessons['examples']:validate_packet(packets[lesson['id']],lesson,tokenizer,limits,model_stops)
        write_once(args.out/'observed-model-identity.json',dict(snapshotSha256=metadata['snapshotSha256'],baseStateHash=base_before,
            mathematicalStateHash=math_before,semanticStateHash=semantic_before,initialInterfaceStateHash=interface_before,
            newAdapterRank=8,lastLayers=4,alpha=16,initialInterfaceAdditiveOutputExactlyZero=True,
            oldParametersFrozen=True,originalAdaptersDisabledInAllExperimentalForwards=True))
        def artifacts_guard():
            require(runtime_codes()==code_snapshot and digest(packets)==packet_digest and snapshot(source_folder)==source_snapshot and
                snapshot(measure_folder)==measure_snapshot and
                all(sha(checkpoint_folder/name)==h for name,h in checkpoint_hashes.items()),'Runtime, source ZIP, tool or checkpoint bytes changed')
            validate_lessons(lessons,evidence,bank);replay_notes()
        def old_guard():
            artifacts_guard()
            require(not base.training and not mathematical.training and not semantic.training and not interface.training and
                all(not p.requires_grad and p.grad is None for p in list(base.parameters())+mathematical.parameters_to_train()+semantic.parameters_to_train()),
                'Old parameter flags or gradients changed')
            require(state_digest(base)==base_before and mathematical.digest()==math_before and semantic.digest()==semantic_before,
                'Old parameter changed')
        def frozen():
            old_guard()
            require(mathematical.enabled and semantic.enabled and interface.enabled and interface.digest()==expected_interface and
                all(not p.requires_grad and p.grad is None for p in interface.parameters_to_train()),'Interface state drift outside committed training')
        def ask(messages,phase,seed,sampled,enabled):
            nonlocal attempts
            require(attempts<MAX_GENERATIONS and sampled is False and type(enabled) is bool,'Fixed free-generation budget and decoding required')
            audit=prompt_audit(tokenizer,messages,limits);input_audits.append(copy.deepcopy(audit))
            write_once(args.out/'prompt-inputs'/(str(attempts+1)+'-'+phase+'.json'),dict(phase=phase,samplingSeed=seed,
                requestedInterfaceAdapterEnabled=enabled,studentPrompt=messages,audit=audit,studentGenerationStarted=False))
            require_input(audit);attempts+=1
            progress.mark('自由生成 '+str(attempts)+'/6：'+phase+' | 独立接口 '+('训练后开启' if enabled else '基线关闭'),
                generationAttempts=attempts,inFlight=dict(phase=phase,seed=seed,interfaceAdapterEnabled=enabled))
            begin=time.monotonic();sampler_phase='metric_zip_call' if phase=='metric_zip_call' else 'experience_review'
            with mathematical.active(False),semantic.active(False),interface.active(enabled):
                flags=(mathematical.enabled,semantic.enabled,interface.enabled);state=interface.digest()
                value=generate(base,tokenizer,messages,sampler_phase,seed,False,input_audit=audit)
                stable=flags==(mathematical.enabled,semantic.enabled,interface.enabled)
            return dict(value,mathAdapterEnabledDuringGeneration=flags[0],semanticAdapterEnabledDuringGeneration=flags[1],
                interfaceAdapterEnabledDuringGeneration=flags[2],interfaceStateHashDuringGeneration=state,
                semanticStateHashDuringGeneration=semantic_before,adapterSwitchesStableDuringGeneration=stable,
                generationSeconds=time.monotonic()-begin,promptInputAudit={k:v for k,v in audit.items() if k!='promptIds'})
        def commit(row,state):
            nonlocal expected_interface
            name='step-'+str(row['stepNumber'])+'.safetensors';path=checkpoint_folder/name
            require(not path.exists(),'Duplicate interface checkpoint');save_file(state,str(path))
            write_once(args.out/'training-steps'/(row['id']+'.json'),row)
            checkpoint_hashes[name]=sha(path);steps.append(copy.deepcopy(row));expected_interface=row['adapterStateAfter']
            progress.mark('已提交实际接口更新 '+str(len(steps))+'/6',interfaceUpdates=len(steps),inFlight=None)
        def train():
            with mathematical.active(False),semantic.active(False),interface.active(True):
                return train_interface(base,interface,[mathematical,semantic],lessons,packets,
                    lambda:deadline-time.monotonic(),old_guard,commit,
                    lambda n,ids:progress.mark('程序监督接口训练 '+str(n)+'/6；本批 '+', '.join(ids),interfaceUpdates=len(steps)))
        run_experiment(evidence,bank,number,ask,train,save,frozen,lambda:deadline-time.monotonic(),read_selected,install,replay_notes,measure)
        frozen();frozen_ok=True
    except Exception as exc:
        stop='time_budget' if isinstance(exc,TimeoutError) else 'error';error=type(exc).__name__+': '+str(exc)
        write_once(args.out/'error.json',dict(error=error,traceback=traceback.format_exc(),generationAttempts=attempts,
            rawResponsesSaved=len(raw),actualOptimizerUpdates=len(steps),modelWeightsLoaded=base is not None))
        print('接口训练停止：'+error,flush=True)
    finally:
        signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGTERM,old_term);signal.signal(signal.SIGALRM,old_alarm)
        try:
            if base is not None and base_before is not None:base_after=state_digest(base)
            if mathematical is not None:math_after=mathematical.digest()
            if semantic is not None:semantic_after=semantic.digest()
            if interface is not None:
                for p in interface.parameters_to_train():p.grad=None;p.requires_grad_(False)
                interface_after=interface.digest();validate_steps(steps,lessons,packets,interface_before,interface_after)
                final_path=checkpoint_folder/'candidate.safetensors';save_file(interface.learned_state(),str(final_path))
                checkpoint_hashes[final_path.name]=sha(final_path)
            source_ok=snapshot(parent)==resume['sourceHashes'];protected_ok=all(sha(Path(p))==h for p,h in checked['protected'].items())
            original_tools_ok=snapshot(args.old_tools.resolve())==checked['toolFiles'];source_zips_ok=snapshot(source_folder)==source_snapshot
            replay_notes()
            require(source_ok and protected_ok and original_tools_ok and source_zips_ok and snapshot(measure_folder)==measure_snapshot and
                runtime_codes()==code_snapshot and all(sha(checkpoint_folder/name)==h for name,h in checkpoint_hashes.items()) and
                (base is None or base_before is not None and base_before==base_after) and
                (mathematical is None or math_before==math_after) and (semantic is None or semantic_before==semantic_after),
                'Final source/model/tool preservation check failed')
        except Exception as exc:stop='error';error=(error+'; ' if error else '')+'Final check: '+str(exc)
        for adapter in (interface,semantic,mathematical):
            if adapter is not None:adapter.close()
    report=summarize(raw,scored,notes,source_reads,tools,steps,stop)
    result=dict(protocol=PROTOCOL,experimentNumber=number,stopReason=stop,error=error,fixtureOnly=False,fixtureGenerations=0,
        actualStudentGenerations=len(raw),generationAttempts=attempts,trainingUpdates=len(steps),actualInterfaceOptimizerUpdates=len(steps),
        teacherCalls=0,hostSupervisedProceduralLabels=True,rawResponsesSaved=len(raw),scoredResponses=len(scored),
        rawResponsesWithoutCompletedAudit=len(raw)-len(scored),modelWeightsLoaded=base is not None,
        inputPreflightPassed=input_preflight['allPlannedPromptsFit'] if input_preflight else False,inputLimits=limits,
        checkedActualInputTokenCounts=[a['inputTokens'] for a in input_audits],
        baseStateBefore=base_before,baseStateAfter=base_after,mathematicalStateBefore=math_before,mathematicalStateAfter=math_after,
        semanticStateBefore=semantic_before,semanticStateAfter=semantic_after,interfaceStateBefore=interface_before,interfaceStateAfter=interface_after,
        interfaceParametersChanged=interface_before is not None and interface_before!=interface_after,
        baseWeightsUnchanged=bool(protected_ok) if base is None else base_before is not None and base_before==base_after,
        mathematicalWriterUnchanged=bool(protected_ok) if mathematical is None else math_before==math_after,
        semanticWriterUnchanged=bool(source_ok) if semantic is None else semantic_before==semantic_after,
        sourceFilesUnchanged=source_ok,sourceExperienceZipsUnchanged=source_zips_ok,inMemoryFrozenFlagsChecked=frozen_ok,
        sourceBoundStudentHypothesisZips=len(note_hashes),actualSelectedSourceZipReads=len(source_reads),actualMeasurementZipExecutions=len(tools),
        productionCheckpointOrBankUpdated=False,interfaceCheckpointFiles=checkpoint_hashes,summary=report,elapsedSeconds=time.monotonic()-start)
    write_once(args.out/'interface-checkpoint-manifest.json',checkpoint_hashes);write_once(args.out/'result.json',result)
    lines=['# 独立接口训练与训练前后复验','',
        '程序根据完全匹配的原记录与工具定义，监督 11 个地址，每个两次、共 6 次优化器更新。目标是 T 地址或 CALL Z 地址及配置中的 EOS。它们是程序训练标签，不是学生原文，不是数学答案、诊断或自主学习证据。','',
        '训练前后固定使用相同原生学生、相同提示、贪心解码和种子。原数学与语义适配器均关闭；只开启训练后的独立接口适配器。原参数、ZIP 银行和生产检查点均保留。','',
        '指定目标查找是熟悉记录上的程序任务。自主选择、未审阅观察和真实工具调用分别报告；这些步骤不证明问题发现、理解或数学收益。','',
        '```json',json.dumps(report,ensure_ascii=False,indent=2),'```','']
    for row in raw:lines+=['## '+row['recordId'],'','````text',row['studentOutput']['raw'],'````','']
    (args.out/'Lain-Zip-Interface-Training-Review.md').write_text('\n'.join(lines),encoding='utf-8')
    archive=args.out/'Lain-Zip-Interface-Training-Results.zip'
    with zipfile.ZipFile(archive,'x',zipfile.ZIP_DEFLATED) as z:
        for path in sorted(args.out.rglob('*')):
            if path.is_file() and path!=archive:z.write(path,path.relative_to(args.out))
    print('接口训练与复验摘要：'+json.dumps(report,ensure_ascii=False),flush=True)
    print('完整性：'+json.dumps({k:result[k] for k in ('stopReason','error','actualStudentGenerations','trainingUpdates','interfaceParametersChanged',
        'teacherCalls','baseWeightsUnchanged','mathematicalWriterUnchanged','semanticWriterUnchanged','sourceFilesUnchanged')},ensure_ascii=False),flush=True)
    print('实验结果：'+str(archive),flush=True)
    return 0 if stop=='completed' else 1


def main():
    parser=argparse.ArgumentParser()
    for name in ('source','work','student','old-tools','out'):parser.add_argument('--'+name,type=Path)
    parser.add_argument('--inspect-only',action='store_true');args=parser.parse_args();require(args.source is not None,'Original source required')
    if args.inspect_only:
        resume=inspect_source(args.source);evidence,_=load_evidence(resume)
        bank=build_bank(sha(Path(__file__).with_name('zip_interface_training_core.py')));lessons=make_lessons(evidence,bank)
        print(json.dumps(dict(protocol=PROTOCOL,sourceProtocol=resume['result']['protocol'],sourceEvidenceHash=evidence['evidenceHash'],
            trainingHistories=4,evaluationHistoriesExcluded=4,originalRoutes=24,programAddressLessons=len(lessons['examples']),
            plannedOptimizerSteps=6,studentCalls=0,teacherCalls=0,trainingUpdates=0,modelNotLoaded=True,hostSupervisedLabels=True,
            lessonHash=lessons['lessonHash'],labels={r['id']:r['target'] for r in lessons['examples']}),ensure_ascii=False),flush=True);return 0
    for name in ('work','student','old_tools','out'):require(getattr(args,name) is not None,'Missing '+name)
    return run(args)


if __name__=='__main__':raise SystemExit(main())
