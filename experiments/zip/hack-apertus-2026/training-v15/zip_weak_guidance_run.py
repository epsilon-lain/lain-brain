"""Original CPU Notebook: train procedural actions and editable advice."""
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
from draft_inspect_runtime import read,sha,snapshot
from writer_check_core import write_once,exact_reproduction
from writer_check_run import preflight
from tool_loop_course import archived_inputs
from object_choice_core import normalized_features
from zip_label_grounded_checks import feature_messages
from zip_weak_guidance_core import *
from zip_weak_guidance_course import run_course
from zip_weak_guidance_policy import input_limits,prompt_audit,require_input,generate,token_limit,encode_lesson,train_warm,eos_ids,checkpoint_boundary,update_words
from zip_weak_guidance_receipts import atomic_json,publish_partial,harvest_review,training_receipt
from zip_summary_training_v9_progress import StageProgress
from zip_summary_training_v7_run import state_unchanged
from zip_summary_training_v8_run import read_summary_zip

def next_number(work):
    values=[]
    for p in Path(work).glob('zip-weak-guidance-*/protocol.json'):
        row=read(p)
        if row.get('protocol')==PROTOCOL:values.append(row['experimentNumber'])
    return max(values,default=0)+1

def write_guide_zip(folder,guide):
    validate_guide(guide);path=folder/(guide['id']+'.zip')
    with zipfile.ZipFile(path,'x',zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('root.json',json.dumps(guide,ensure_ascii=False))
        archive.writestr('guidance.txt',guide['text'])
    return sha(path)

def read_guide_zip(folder,guide,expected):
    validate_guide(guide);path=folder/(guide['id']+'.zip')
    require(sha(path)==expected,'Changed native guidance ZIP')
    with zipfile.ZipFile(path) as archive:
        require(archive.namelist()==['root.json','guidance.txt'] and archive.testzip() is None and
            json.loads(archive.read('root.json'))==guide and archive.read('guidance.txt').decode()==guide['text'],
            'Changed whole guidance original')

def prepare_inputs(student,plan,roots,initial,notes):
    from transformers import AutoTokenizer
    tokenizer=AutoTokenizer.from_pretrained(student,local_files_only=True)
    limits=input_limits(read(Path(student)/'config.json'),tokenizer)
    configuration=read(Path(student)/'generation_config.json') if (Path(student)/'generation_config.json').is_file() else read(Path(student)/'config.json')
    stops=eos_ids(configuration,tokenizer)
    lessons=warm_lessons();packets={l['id']:encode_lesson(tokenizer,l,limits,stops) for l in lessons}
    audits=[]
    for task in plan['training']+plan['heldout']:
        entry=nominate(task,initial['entries']);require(entry is not None,'Source note coverage')
        note=notes[entry['summaryZipId']]
        prompts=[observation_messages(task,roots),observation_messages(task,roots,note),
            management_messages(task,note,initial['history'],initial['statuses'].get(note['id'],'available'),initial['guide']),
            *(math_messages(task,c,roots) for c in candidate_cards(roots))]
        for prompt in prompts:
            audit=prompt_audit(tokenizer,prompt,limits);require_input(audit)
            require(audit['inputTokens']+1024<=limits['maxInputTokens'],'No input room for future history/advice; no truncation')
            audits.append(dict(taskId=task['id'],audit=audit))
    for _,prompt in interface_probes():require_input(prompt_audit(tokenizer,prompt,limits))
    return tokenizer,limits,stops,packets,dict(tokenizerOnly=True,modelWeightsLoaded=False,rows=audits,
        futureHistoryAndGuideReserve=1024,everyActualInputChecked=True,supervisedPackets=len(packets))

def run(args):
    from zip_weak_guidance_inspect import inspect_source
    started=time.monotonic()
    recovery=inspect_source(args.recover,training_only=True) if args.recover else None
    resume=recovery['parentResume'] if recovery else inspect_source(args.source)
    foundation=resume['base'];fp=Path(foundation['folder'])
    parent=args.source.resolve()
    require(not args.out.resolve().is_relative_to(parent) and not parent.is_relative_to(args.out.resolve()),'Output overlaps source')
    base_choice=Path(read(fp/'source-checkpoint.json')['baseChoiceSource']).resolve()
    checked=preflight(SimpleNamespace(source=base_choice,student=args.student,old_tools=args.old_tools,out=args.out))
    if recovery:
        from zip_summary_training_v9_recovery import clone_evidence
        require(parent==recovery['parentResume']['parent'],'Wrong original recovery parent')
        clone_evidence(args.recover,args.out)
        roots=read(args.out/'roots.json');plan=read(args.out/'weak-guidance-questions.json')
        number=recovery['experimentNumber'];initial=copy.deepcopy(recovery['initial']);notes=copy.deepcopy(resume['inherited'])
        cpf=args.out/'checkpoints';gf=args.out/'weak-guidance-zips'
        progress=StageProgress(os.environ.get('ZIP_SUMMARY_PROGRESS_FILE'))
        guide_hashes={p.stem:sha(p) for p in gf.glob('*.zip')}
        atomic_json(args.out/'recovery.json',dict(originalFolder=str(args.recover.resolve()),trainingRepeated=False,
            completedTrainingObjects=4,remainingHeldoutOnly=True,originalFileHashes=recovery['parentHashes']))
        training_receipt(args.out,recovery['replayedCourse']['bank'],recovery['trainingCheckpoint'])
    else:
        roots=copy.deepcopy(foundation['bank']['mathematicalRoots']);number=next_number(args.work)
        archives=[p for p in args.work.glob('zip-*') if p.is_dir() and ((p/'result.json').is_file() or list(p.glob('*questions.json')))]
        excluded,freshness=archived_inputs(archives+[parent,fp,base_choice]);plan=make_plan(excluded,roots);validate_plan(plan)
        initial=copy.deepcopy(resume['managementInitial']);initial['guide']=copy.deepcopy(resume.get('activeGuide',host_guide()))
        notes=copy.deepcopy(resume['inherited']);validate_entries(initial['entries'],notes)
        args.out.mkdir(parents=True,exist_ok=False);cpf=args.out/'checkpoints';cpf.mkdir();gf=args.out/'weak-guidance-zips';gf.mkdir()
        progress=StageProgress(os.environ.get('ZIP_SUMMARY_PROGRESS_FILE'))
        write_once(args.out/'protocol.json',dict(protocol=PROTOCOL,experimentNumber=number,trainingObjects=4,heldoutObjects=4,
            maximumGenerations=MAX_GENERATIONS,maximumFeatureBatches=MAX_FEATURE_BATCHES,warmSteps=WARM_STEPS,
            maximumManagementSteps=4,maximumGuideSteps=1,hostSupervisedProceduralLabels=True,
            hostChoosesRealManagementAction=False,teacherCalls=0,noForcedGrammar=True,
            adviceChangeAllowed=True,executableActionAndMathAuditChanged=False,historyFreshness=freshness))
        write_once(args.out/'weak-guidance-questions.json',plan);write_once(args.out/'roots.json',roots)
        write_once(args.out/'initial-bank.json',initial);write_once(args.out/'warm-lessons.json',warm_lessons())
        write_once(args.out/'source-checkpoint.json',dict(parentSource=str(parent),parentResultSha256=sha(parent/'result.json'),
            baseChoiceSource=str(base_choice),initialManagerHash=resume['managementHash'],
            initialSummaryHash=resume['summaryStateHashes'][A],foundationFolder=str(fp),
            sourceSnapshotsAreReadOnly=True))
        for p in Path(__file__).resolve().parent.glob('*.py'):
            dst=args.out/'evaluation-code'/p.name;dst.parent.mkdir(exist_ok=True);dst.write_bytes(p.read_bytes())
        guide_hashes={initial['guide']['id']:write_guide_zip(gf,initial['guide'])}
    deadline=time.monotonic()+max(0.,float(os.environ.get('ZIP_SUMMARY_DEADLINE',str(time.time()+1200)))-time.time())
    calls=features_count=0;raws=[];scored=[];saved={};steps={'management':[],'guide':[]};warm_steps=[];course={}
    if recovery:
        raws=[read(p) for p in sorted((args.out/'responses').glob('*-raw.json'))];calls=len(raws)
        scored=[read(p) for p in (args.out/'responses').glob('*-scored.json')]
        features_count=len(list((args.out/'feature').glob('*.json')))
        for kind in ('object','guide','interface-probe','management-feedback','management-choice'):
            saved[kind]=[read(p) for p in (args.out/kind).glob('*.json')]
        warm_steps=[read(p) for p in (args.out/'warm-step').glob('*.json')]
        steps={k:[read(p) for p in (args.out/(k+'-step')).glob('*.json')] for k in ('management','guide')}
    reused_raw_count=len(raws)
    base=math_adapter=semantic=summary=manager=guide_writer=None
    before={};after={};installed={};frozen_held=None;snapshots={};bank=copy.deepcopy(initial)
    stop='completed';error=None;protected=None;held_ok=None;attempts_at_start=0
    def save(kind,row):
        path=args.out/'responses'/(row['recordId']+'-'+kind+'.json') if kind in ('raw','scored') else args.out/kind/(row['id']+'.json')
        write_once(path,row);saved.setdefault(kind,[]).append(copy.deepcopy(row))
        if kind=='raw':raws.append(copy.deepcopy(row))
        if kind=='scored':scored.append(copy.deepcopy(row))
        progress.mark(rawResponsesSaved=len(raws),completeNewObjects=len(saved.get('object',[])),
            warmUpdates=len(warm_steps),managementUpdates=len(steps['management']),guideUpdates=len(steps['guide']))
    def load(identifier):
        note=notes[identifier]
        # The parent inspector validates actual native files, and the selected
        # root is bound to the exact parent original.
        validate_entries([e for e in initial['entries'] if e['summaryZipId']==identifier],notes)
        return copy.deepcopy(note)
    def store(guide):guide_hashes[guide['id']]=write_guide_zip(gf,guide)
    def timeout(*args):raise TimeoutError('Weak-guidance compute phase deadline')
    old_term=signal.signal(signal.SIGTERM,timeout);old_alarm=signal.signal(signal.SIGALRM,timeout)
    signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
    try:
        progress.mark('只加载 tokenizer；预检所有动作课例、真实任务与输入预算')
        tokenizer,limits,stops,packets,inputs=prepare_inputs(args.student,plan,roots,initial,notes)
        write_once(args.out/('input-preflight-'+args.out.name+'.json'),inputs)
        if recovery:require(packets==read(args.out/'warm-packets.json'),'Changed actual recovery tokenizer packets')
        else:write_once(args.out/'warm-packets.json',packets)
        import torch
        from safetensors.torch import load_file,save_file
        from zip_pilot import load_student
        from zip_pilot_model import state_digest
        from math_writer_adapter import MathWriterAdapter
        progress.mark('加载原冻结学生、已有管理参数与独立引导写作参数')
        base,tokenizer,identity=load_student(args.student,'cpu')
        require(identity['snapshotSha256']==checked['identity']['snapshotSha256'],'Student identity changed')
        def adapter(file=None,seed_slot=0):
            torch.manual_seed(seed_for(number,0,seed_slot));a=MathWriterAdapter(base,rank=8,last_layers=4,alpha=16)
            if file:a.restore(load_file(str(file)))
            a.eval()
            for p in a.parameters_to_train():p.requires_grad_(False);p.grad=None
            return a
        math_adapter=adapter(checked['writer'],40)
        semantic=adapter(fp/'checkpoints'/foundation['final']['semanticFile'],41)
        summary=adapter(resume['summaryFiles'][A],42)
        manager=adapter(recovery['managementFile'] if recovery else resume['managementFile'],43)
        guide_writer=adapter(recovery['guideFile'] if recovery else resume.get('guideFile'),44)
        base.eval().requires_grad_(False)
        before=dict(base=state_digest(base),math=math_adapter.digest(),semantic=semantic.digest(),summary=summary.digest())
        require(before['base']==foundation['result']['baseStateBefore'] and
            before['math']==checked['checkpoint']['writerStateHash'] and
            before['semantic']==foundation['final']['semanticStateHash'] and
            before['summary']==resume['summaryStateHashes'][A] and
            manager.digest()==(recovery['managementHash'] if recovery else resume['managementHash']),
            'Original frozen source weights differ')
        installed=dict(management=manager.digest(),guide=guide_writer.digest())
        if recovery:
            frozen_held=copy.deepcopy(installed);bank=copy.deepcopy(recovery['replayedCourse']['bank'])
            for label,key in (('initial','pre_round'),('after-warm','warm'),('proposal','proposal')):
                state=read(cpf/(label+'.json'))['states']['management']
                values=load_file(str(cpf/state['file']))
                old=manager.learned_state();manager.restore(values)
                require(manager.digest()==state['stateHash'],'Changed frozen control snapshot')
                snapshots[key]=manager.learned_state();manager.restore(old)
        def frozen(target=None):
            require(not base.training and all(not a.training and a.enabled for a in (math_adapter,semantic,summary,manager,guide_writer)) and
                all(not p.requires_grad and p.grad is None for p in list(base.parameters())+
                    math_adapter.parameters_to_train()+semantic.parameters_to_train()+summary.parameters_to_train()+
                    ([] if target=='management' else manager.parameters_to_train())+
                    ([] if target=='guide' else guide_writer.parameters_to_train())),'Frozen mode or gradient changed')
            require(math_adapter.digest()==before['math'] and semantic.digest()==before['semantic'] and summary.digest()==before['summary'],
                'Frozen original adapter changed')
            if target!='management':require(manager.digest()==installed['management'],'Unrecorded manager change')
            if target!='guide':require(guide_writer.digest()==installed['guide'],'Unrecorded guide writer change')
        def ask(phase,messages,seed,*,mode,sampled=False,**context):
            nonlocal calls
            if time.monotonic()>=deadline:raise TimeoutError('Deadline before actual generation')
            require(calls<MAX_GENERATIONS and mode in ('math','observation','management','guide'),'Generation cap/mode')
            frozen();audit=prompt_audit(tokenizer,messages,limits);require_input(audit)
            calls+=1;progress.mark('自由生成 '+str(calls)+'/86：'+phase)
            write_once(args.out/'prompt-inputs'/args.out.name/(str(calls)+'.json'),dict(phase=phase,audit=audit,studentPrompt=messages))
            snap=context.get('managerSnapshot','current');previous=None
            if mode=='management' and snap!='current':
                previous=manager.learned_state();manager.restore(snapshots[snap]);installed['management']=manager.digest()
            try:
                math_enabled=bool(context.get('coldMathEnabled',True)) if mode=='math' else False
                with math_adapter.active(math_enabled),semantic.active(False),summary.active(False),manager.active(mode=='management'),guide_writer.active(mode=='guide'):
                    value=generate(base,tokenizer,messages,phase,seed,sampled,input_audit=audit)
                    value.update(generationMode=mode,mathAdapterEnabledDuringGeneration=math_enabled,
                        semanticAdapterEnabledDuringGeneration=False,summaryAdapterEnabledDuringGeneration=False,
                        managementAdapterEnabledDuringGeneration=mode=='management',guideAdapterEnabledDuringGeneration=mode=='guide',
                        managementStateHashDuringGeneration=manager.digest(),guideStateHashDuringGeneration=guide_writer.digest())
            finally:
                if previous is not None:manager.restore(previous);installed['management']=manager.digest()
            row=dict(recordId='weak-call-'+str(calls).zfill(3),phase=phase,studentPrompt=copy.deepcopy(messages),
                studentOutput=value,samplingSeed=seed,fixtureOnly=False,**context)
            save('raw',row);frozen()
            ids=value['generatedIds'];logs=value['samplingTokenLogProbabilities'];actual_eos=base.generation_config.eos_token_id
            if actual_eos is None:actual_eos=tokenizer.eos_token_id
            stop_ids=set(actual_eos if isinstance(actual_eos,list) else [actual_eos])-{None}
            require(not value.get('testDouble') and value['originalTextRepaired'] is False and value['sampled'] is sampled and
                value['promptIds']==audit['promptIds'] and tokenizer.decode(ids,skip_special_tokens=True)==value['raw'] and
                0<value['generatedTokens']==len(ids)==len(logs)<=token_limit(phase)==value['responseTokenLimit'] and
                all(type(i) is int and i>=0 for i in ids) and all(math.isfinite(x) for x in logs) and
                abs(sum(logs)-value['samplingLogProbability'])<=1e-10 and (value['stopReason']=='eos')==(ids[-1] in stop_ids),
                'Changed raw generation, EOS, tokens or policy logs')
            return row
        def feature(task,row,cards):
            nonlocal features_count
            if time.monotonic()>=deadline:raise TimeoutError('Deadline before frozen features')
            frozen();require(features_count<MAX_FEATURE_BATCHES,'Feature batch cap')
            prompts=[feature_messages(task,row['studentOutput'],c) for c in cards]
            audits=[prompt_audit(tokenizer,m,limits) for m in prompts]
            for a in audits:require_input(a)
            vectors=[]
            with math_adapter.active(False),semantic.active(False),summary.active(False),manager.active(False),guide_writer.active(False),torch.no_grad():
                for au in audits:
                    ids=torch.tensor([au['promptIds']],device=next(base.parameters()).device)
                    value=base(input_ids=ids,output_hidden_states=True,use_cache=False,logits_to_keep=1)
                    vectors.append(value.hidden_states[-1][0,-1].float().cpu().tolist())
            features_count+=1;fid='weak-feature-'+str(features_count).zfill(3)
            save('feature',dict(id=fid,task=copy.deepcopy(task),sourceObservationRecordId=row['recordId'],
                candidateCards=copy.deepcopy(cards),candidatePrompts=prompts,candidateHiddenVectors=vectors,
                normalizedFeatures=normalized_features(vectors),allAdaptersDisabled=True))
            frozen();return normalized_features(vectors),fid
        def warmup(lessons):
            def commit(row,state):
                file=row['id']+'.safetensors';save_file(state,str(cpf/file))
                save('warm-step',dict(row,stateFile=file,stateFileSha256=sha(cpf/file)))
                installed['management']=manager.digest();warm_steps.append(copy.deepcopy(row))
            progress.mark('平衡程序监督：只教动作编码及 EOS，不给真实任务的使用答案')
            with math_adapter.active(False),semantic.active(False),summary.active(False),manager.active(True),guide_writer.active(False):
                # This guard checks old flags/gradients while their hooks are off.
                def guard():
                    require(not base.training and all(not p.requires_grad and p.grad is None for p in list(base.parameters())+
                        math_adapter.parameters_to_train()+semantic.parameters_to_train()+summary.parameters_to_train()+guide_writer.parameters_to_train()),
                        'Old parameter entered procedural training')
                    require(math_adapter.digest()==before['math'] and semantic.digest()==before['semantic'] and summary.digest()==before['summary'],
                        'Old weights changed during procedure lesson')
                train_warm(base,manager,lessons,packets,lambda:deadline-time.monotonic(),guard,commit,
                    stage=lambda i:progress.mark('动作编码实际更新 '+str(i)+'/16',warmUpdates=i))
            frozen()
        optimizers={kind:torch.optim.SGD(a.parameters_to_train(),lr=.003) for kind,a in (('management',manager),('guide',guide_writer))}
        def learn(kind,rows,advantages,evidence):
            require(not recovery and frozen_held is None and kind in ('management','guide') and not evidence.get('heldoutFeedback') and
                all(r.get('split',r.get('task',{}).get('split'))=='training' for r in rows),'Heldout feedback cannot train')
            a=manager if kind=='management' else guide_writer;records=steps[kind]
            require(len(records)<(4 if kind=='management' else 1) and
                all(r['studentOutput']['sampled'] is True and r['studentOutput'][('management' if kind=='management' else 'guide')+
                    'StateHashDuringGeneration']==installed[kind] for r in rows),'Changed trajectory or optimizer cap')
            frozen();old=a.learned_state();prior=installed[kind];optimizer=optimizers[kind];committed=False
            try:
                for p in a.parameters_to_train():p.requires_grad_(True);p.grad=None
                with math_adapter.active(False),semantic.active(False),summary.active(False),manager.active(kind=='management'),guide_writer.active(kind=='guide'):
                    update=update_words(base,a,optimizer,[r['studentOutput'] for r in rows],advantages,len(rows)*128)
                installed[kind]=a.digest()
                if update['updated']:
                    step=dict(id=kind+'-'+str(len(records)+1),parameterKind=kind,sourceRecordIds=[r['recordId'] for r in rows],
                        beforeHash=prior,afterHash=installed[kind],advantages=list(advantages),evidence=copy.deepcopy(evidence),
                        policyUpdate=copy.deepcopy(update),optimizer='SGD without momentum',learningRate=.003)
                    file=step['id']+'.safetensors'
                    with checkpoint_boundary():
                        save_file(a.learned_state(),str(cpf/file));save(kind+'-step',dict(step,stateFile=file,stateFileSha256=sha(cpf/file)))
                        records.append(step)
                        committed=True
                update.update(parameterKind=kind,beforeHash=prior,afterHash=installed[kind],sourceRecordIds=[r['recordId'] for r in rows])
            except BaseException:
                if not committed:a.restore(old);installed[kind]=prior
                raise
            finally:
                optimizer.zero_grad(set_to_none=True)
                for p in a.parameters_to_train():p.requires_grad_(False);p.grad=None
            frozen();return update
        def checkpoint(label,current_bank):
            nonlocal bank,frozen_held,deadline
            frozen();states={}
            with checkpoint_boundary():
                for kind,a in (('management',manager),('guide',guide_writer)):
                    file=label+'-'+kind+'.safetensors';save_file(a.learned_state(),str(cpf/file))
                    states[kind]=dict(file=file,fileSha256=sha(cpf/file),stateHash=a.digest())
                cp=dict(protocol=PROTOCOL,label=label,states=states,bankHash=digest(current_bank),frozenOriginalHashes=copy.deepcopy(before))
                write_once(cpf/(label+'.json'),cp);bank=copy.deepcopy(current_bank)
                if label=='initial':snapshots['pre_round']=manager.learned_state()
                if label=='after-warm':snapshots['warm']=manager.learned_state()
                if label=='proposal':snapshots['proposal']=manager.learned_state()
                if label in ('after-4','training-final'):
                    training_receipt(args.out,bank,cp);harvest_review(args.out,args.out/'Lain-Zip-Weak-Guidance-Review.zip')
                if label=='training-final':
                    frozen_held=copy.deepcopy(installed);deadline=time.monotonic()+float(os.environ.get('ZIP_SUMMARY_EVAL_SECONDS','600'))
                    signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
                    progress.mark('训练断点已保存；四道新题冻结复验，更新零次')
        if recovery:
            # Verify the eight saved cold originals against the same source.
            cold=sorted((r for r in raws if r['phase']=='cold_replay'),key=lambda r:int(r['recordId'].rsplit('-',1)[1]))
            require(len(cold)==len(checked['anchors'])==8,'Missing original cold checks')
            for row,anchor in zip(cold,checked['anchors']):
                require(row['studentPrompt']==anchor['studentPrompt'] and row['samplingSeed']==anchor['samplingSeed'] and
                    row['sourceRecordId']==anchor['recordId'] and row['coldMathEnabled']==anchor['requestedMathAdapterEnabled'] and
                    exact_reproduction(anchor['studentOutput'],row['studentOutput'])['exact'],'Changed original cold binding')
            deadline=time.monotonic()+float(os.environ.get('ZIP_SUMMARY_EVAL_SECONDS','600'))
            signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
            progress.mark('恢复完整 TRAIN 原文与参数；只补缺失冻结复验，训练更新零次')
            from zip_weak_guidance_inspect import replay_course
            course=replay_course(args.out,initial,notes,number,tail=dict(ask=ask,feature=feature,save=save,
                checkpoint=checkpoint,deadline=lambda:deadline))
        else:
            for index,old in enumerate(checked['anchors'],1):
                cold_enabled=old['requestedMathAdapterEnabled']
                row=ask('cold_replay',old['studentPrompt'],old['samplingSeed'],mode='math',sampled=False,
                    task=old['task'],sourceRecordId=old['recordId'],coldMathEnabled=cold_enabled)
                exact=exact_reproduction(old['studentOutput'],row['studentOutput']);save('scored',dict(row,check=dict(exactReproduction=exact)))
                require(exact['exact'],'Cold source math reproduction failed')
            course=run_course(plan,roots,initial,ask,feature,save,learn,warmup,checkpoint,load,store,lambda:deadline,number)
        held_ok=installed==frozen_held;require(held_ok,'Heldout changed learned parameters')
    except Exception as exc:
        stop='time_budget' if isinstance(exc,TimeoutError) else 'error';error=type(exc).__name__+': '+str(exc)
        atomic_json(args.out/'error.json',dict(error=error,traceback=traceback.format_exc(),generationAttempts=calls))
        print('已保存完成步骤；停止原因：'+error,flush=True)
    finally:
        signal.setitimer(signal.ITIMER_REAL,0)
        publish_partial(args.out,error or 'integrity_checks_pending');harvest_review(args.out,args.out/'Lain-Zip-Weak-Guidance-Review.zip')
        signal.setitimer(signal.ITIMER_REAL,float(os.environ.get('ZIP_SUMMARY_SAVE_SECONDS','180')))
        progress.mark('原文与训练收据已保存；核验冻结权重及来源文件')
        try:
            protected=snapshot(parent)==resume['parentHashes'] and snapshot(fp)==foundation['sourceHashes'] and \
                all(sha(Path(p))==h for p,h in checked['protected'].items()) and snapshot(args.old_tools)==checked['toolFiles'] and \
                (not recovery or snapshot(args.recover)==recovery['parentHashes'])
            require(protected,'Protected source originals changed')
            if base is not None:
                after=dict(base=state_digest(base),math=math_adapter.digest(),semantic=semantic.digest(),summary=summary.digest())
                require(before==after,'Original frozen weights changed')
        except Exception as exc:stop='error';error=(error+'; ' if error else '')+str(exc)
        signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGTERM,old_term);signal.signal(signal.SIGALRM,old_alarm)
        for a in (guide_writer,manager,summary,semantic,math_adapter):
            if a is not None:a.close()
    atomic_json(args.out/'memory-bank.json',bank)
    if not course:
        course=dict(objects=saved.get('object',[]),guideCandidates=saved.get('guide',[]),activeGuide=bank['guide'],
            interfaceProbes=saved.get('interface-probe',[]),managementFeedback=saved.get('management-feedback',[]))
    report=summarize(course)
    probes=course['interfaceProbes']
    report['interfaceProbeCorrectByStage']={stage:sum(p['correct'] for p in probes if p['stage']==stage) for stage in ('before_warm','after_warm')}
    report['trainingValidActions']=sum(f['action'] is not None for f in course.get('managementFeedback',[]))
    result=dict(protocol=PROTOCOL,experimentNumber=number,stopReason=stop,error=error,fixtureOnly=False,teacherCalls=0,
        actualStudentGenerations=len(raws),featureForwardBatches=features_count,warmOptimizerUpdates=len(warm_steps),
        managementOptimizerUpdates=len(steps['management']),guideOptimizerUpdates=len(steps['guide']),
        trainingUpdates=len(warm_steps)+len(steps['management'])+len(steps['guide']),summaryOptimizerUpdates=0,choiceHeadTrainingUpdates=0,
        completedTrainingObjects=sum(o['phase']=='training' for o in course['objects']),
        completedHeldoutObjects=sum(o['phase']=='heldout' for o in course['objects']),coldReproductions=sum(
            r['phase']=='cold_replay' and r['check']['exactReproduction']['exact'] for r in scored),
        baseWeightsUnchanged=state_unchanged(before.get('base'),after.get('base')),
        mathematicalWriterUnchanged=state_unchanged(before.get('math'),after.get('math')),
        originalSemanticWriterUnchanged=state_unchanged(before.get('semantic'),after.get('semantic')),
        originalSummaryWriterUnchanged=state_unchanged(before.get('summary'),after.get('summary')),
        methodHeadsUnchanged=initial['head']==bank['head'] and initial['entries']==bank['entries'],
        originalFilesUnchanged=protected,heldoutLearnedStateUnchanged=held_ok,
        completeTrainingExperiment=stop=='completed' and len(course['objects'])==8 and len(warm_steps)==16,
        guideZipByteHashes=guide_hashes,summary=report,elapsedSeconds=time.monotonic()-started,
        recoveredTrainingPhase=bool(recovery),reusedStudentOriginals=reused_raw_count,
        newlyGeneratedStudentResponses=len(raws)-reused_raw_count,
        newlyCommittedOptimizerUpdates=0 if recovery else len(warm_steps)+len(steps['management'])+len(steps['guide']))
    atomic_json(args.out/'run-file-manifest.json',dict(files={k:v for k,v in snapshot(args.out).items()
        if k not in ('result.json','Lain-Zip-Weak-Guidance-Review.zip')}))
    atomic_json(args.out/'result.json',result);harvest_review(args.out,args.out/'Lain-Zip-Weak-Guidance-Review.zip')
    print('可修订弱引导训练摘要：'+json.dumps(report,ensure_ascii=False),flush=True)
    print('完整性：'+json.dumps({k:result[k] for k in ('stopReason','error','actualStudentGenerations','trainingUpdates',
        'warmOptimizerUpdates','managementOptimizerUpdates','guideOptimizerUpdates','completeTrainingExperiment')},ensure_ascii=False),flush=True)
    return 0 if stop=='completed' else 1

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--recover',type=Path)
    for name in ('source','work','student','old-tools','out'):parser.add_argument('--'+name,type=Path,required=True)
    return run(parser.parse_args())
if __name__=='__main__':raise SystemExit(main())
