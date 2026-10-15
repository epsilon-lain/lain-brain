"""Real CPU student training. No fixture/model fallback or teacher completions."""
import argparse
import copy
import json
import math
import os
from pathlib import Path
import signal
import time
import traceback
import zipfile
from types import SimpleNamespace
from draft_inspect_runtime import read,sha,snapshot
from writer_check_core import write_once,exact_reproduction
from writer_check_run import preflight
from tool_loop_course import archived_inputs
from object_choice_core import normalized_features
from zip_label_grounded_checks import feature_messages
from zip_interface_training_policy import checkpoint_boundary
from zip_summary_training_v8_core import *
from zip_summary_training_v9_core import run_course
from zip_summary_training_v8_policy import input_limits,prompt_audit,require_input,generate,token_limit,update_words
from zip_summary_training_v9_progress import StageProgress
from zip_summary_training_v9_receipts import publish_partial, phase_receipt, harvest_review, atomic_json
from zip_summary_training_v9_recovery import inspect_interrupted_course, replay_saved_course, clone_evidence
from zip_summary_training_v7_run import state_unchanged


def write_summary_zip(folder,note):
    validate_summary(note);path=folder/(note['id']+'.zip')
    with zipfile.ZipFile(path,'x',zipfile.ZIP_DEFLATED) as z:
        z.writestr('root.json',json.dumps(note,ensure_ascii=False))
        z.writestr('student-original.json',json.dumps(note['studentOriginal'],ensure_ascii=False))
        z.writestr('source-event.json',json.dumps(note['event'],ensure_ascii=False))
        z.writestr('summary.txt',note['studentRaw'])
    return sha(path)


def read_summary_zip(folder,identifier,hashes):
    require(type(identifier) is str and Path(identifier).name==identifier and identifier in hashes,'Unregistered memory')
    path=folder/(identifier+'.zip');require(sha(path)==hashes[identifier],'Changed ZIP bytes')
    with zipfile.ZipFile(path) as z:
        require(z.namelist()==['root.json','student-original.json','source-event.json','summary.txt'] and z.testzip() is None,'Changed ZIP entries')
        n=json.loads(z.read('root.json'));validate_summary(n)
        require(n['id']==identifier and json.loads(z.read('student-original.json'))==n['studentOriginal'] and
            json.loads(z.read('source-event.json'))==n['event'] and z.read('summary.txt').decode()==n['studentRaw'],'Changed original')
    return n


def next_number(work):
    values=[]
    for path in Path(work).glob('zip-summary-training-*/protocol.json'):
        row=read(path)
        if row.get('protocol','').startswith(('lain-zip-experience-summary-training-v','lain-zip-memory-management-training-v')):
            require(type(row.get('trainingRound')) is int,'Malformed reserved round');values.append(row['trainingRound'])
    return max(values,default=0)+1


def prepare_inputs(student,plan,roots,initial,notes):
    from transformers import AutoTokenizer
    tokenizer=AutoTokenizer.from_pretrained(student,local_files_only=True)
    limits=input_limits(read(Path(student)/'config.json'),tokenizer);audits=[]
    for task in plan['training']+plan['heldout']:
        entry=nominate(task,initial['entries']);note=notes[entry['summaryZipId']] if entry else None
        prompts=[observation_messages(task,roots),*(math_messages(task,c,roots) for c in candidate_cards(roots))]
        if note:
            prompts += [observation_messages(task,roots,note),management_messages(task,note,initial['history'],initial['statuses'].get(note['id'],'available'))]
            for card in candidate_cards(roots,note):
                prompts.append(feature_messages(task,dict(raw='[future student observation]'),card))
            if task['split']=='training':
                selected=dict(recordId='future-selected-route',selectedCandidate=candidate_cards(roots)[0],
                    studentOutput=dict(raw='[future student equality]'),check=dict(outcomePassed=False,
                        mathematicallyCorrectWrittenEquality=False,auditFacts=dict(selectedToolSupported=None),failureReasons=[]))
                shape=dict(task=task,selectedRouteRecordId=selected['recordId'],routes=[selected])
                prompts.append(revision_messages(shape,note,initial['history']))
        for prompt in prompts:
            audit=prompt_audit(tokenizer,prompt,limits);require_input(audit)
            # Reserve bounded future history/revised wording; every real input
            # is separately checked, with no silent truncation.
            require(audit['inputTokens']+768<=limits['maxInputTokens'],'Future history reserve exceeds input limit')
            audits.append(dict(taskId=task['id'],audit=audit))
    return tokenizer,limits,dict(tokenizerOnly=True,modelWeightsLoaded=False,rows=audits,
        futureHistoryTokenReserve=768,planningPlaceholderNotStudentText=True)


def run(args):
    from zip_summary_training_v8_inspect import inspect_training_source
    started=time.monotonic();progress=StageProgress(os.environ.get('ZIP_SUMMARY_PROGRESS_FILE'))
    recovery=inspect_interrupted_course(args.recover) if args.recover else None
    resume=recovery['parentResume'] if recovery else inspect_training_source(args.source)
    foundation=resume['base'];fp=Path(foundation['folder'])
    parent=args.source.resolve();require(not args.out.resolve().is_relative_to(parent) and not parent.is_relative_to(args.out.resolve()),'Output overlaps source')
    base_choice=Path(read(fp/'source-checkpoint.json')['baseChoiceSource']).resolve()
    checked=preflight(SimpleNamespace(source=base_choice,student=args.student,old_tools=args.old_tools,out=args.out))
    if recovery:
        require(parent==recovery['parent'],'Wrong recovery parent argument')
        cold=sorted((r for r in recovery['raws'].values() if r['phase']=='cold_replay'),
            key=lambda r:r['coldNumber'])
        require(len(cold)==len(checked['anchors'])==8,'Missing original cold checks')
        for row,anchor in zip(cold,checked['anchors']):
            require(row['sourceRecordId']==anchor['recordId'] and row['studentPrompt']==anchor['studentPrompt'] and
                row['samplingSeed']==anchor['samplingSeed'] and row['task']==anchor['task'] and
                row['coldMathEnabled']==anchor['requestedMathAdapterEnabled'] and
                exact_reproduction(anchor['studentOutput'],row['studentOutput'])['exact'] and
                read(args.recover/'responses'/(row['recordId']+'-scored.json'))['check']['exactReproduction']['exact'],
                'Changed original cold-reproduction binding')
    if recovery:
        clone_evidence(args.recover,args.out)
        roots=read(args.out/'roots.json');plan=read(args.out/'zip-summary-questions.json')
        number=recovery['trainingRound'];initial=copy.deepcopy(recovery['initial']);notes=copy.deepcopy(recovery['notes'])
        cpf=args.out/'checkpoints';zf=args.out/'summary-zips'
        atomic_json(args.out/'recovery.json',dict(originalFolder=str(args.recover.resolve()),
            auditedTrainingObjects=8,managementUpdatesAlreadyCommitted=len(recovery['managementSteps']),
            summaryUpdatesAlreadyCommitted=len(recovery['summarySteps']),trainingRepeated=False,
            existingHeldoutPrefixReused=True,remainingHeldoutOnly=True,
            originalFileHashes=recovery['originalHashes']))
        phase_receipt(args.out,recovery['bank'],recovery['trainingCheckpoint'])
    else:
        roots=copy.deepcopy(foundation['bank']['mathematicalRoots']);number=next_number(args.work)
        archives=[p for p in args.work.glob('zip-*') if p.is_dir() and ((p/'result.json').is_file() or list(p.glob('*questions.json')))]
        excluded,freshness=archived_inputs(archives+[parent,fp,base_choice]);plan=make_plan(excluded,roots);validate_plan(plan)
        initial=copy.deepcopy(resume['managementInitial']);notes=copy.deepcopy(resume['inherited']);validate_entries(initial['entries'],notes)
        require(all(nominate(t,initial['entries']) is not None for t in plan['training']+plan['heldout']),
            'Completed source needs actual qualified summaries covering both fixed task structures')
        args.out.mkdir(parents=True,exist_ok=False);cpf=args.out/'checkpoints';cpf.mkdir();zf=args.out/'summary-zips';zf.mkdir()
        for relative,expected in foundation['sourceHashes'].items():
            if Path(relative).suffix=='.zip':continue
            source=fp/relative;require(sha(source)==expected,'Foundation changed during export')
            target=args.out/'foundation-originals'/relative;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(source.read_bytes())
        for path in Path(__file__).resolve().parent.glob('*.py'):
            target=args.out/'evaluation-code'/path.name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(path.read_bytes())
        write_once(args.out/'zip-summary-questions.json',plan);write_once(args.out/'roots.json',roots)
        write_once(args.out/'management-initial.json',initial)
        write_once(args.out/'protocol.json',dict(protocol=PROTOCOL,trainingRound=number,maximumGenerations=MAX_GENERATIONS,
            maximumFeatureBatches=MAX_FEATURE_BATCHES,maximumSummaryTokens=128,managementStepCap=8,summaryStepCap=2,
            sourceChosenByHeldoutScore=False,teacherCalls=0,baseAndMathAndMethodHeadsFrozen=True,
            managementParametersIndependent=True,managementResponseUsesActualEos=True,forcedGrammar=False,
            historiesTrainingOnly=True,hostWritesStudentRevision=False,hostChoosesManagementAction=False,
            managementControlsActualContext=True,allOriginalsRetained=True,historyFreshness=freshness))
        write_once(args.out/'source-checkpoint.json',dict(parentSource=str(parent),parentResultSha256=sha(parent/'result.json'),
            baseChoiceSource=str(base_choice),baseStateHash=foundation['result']['baseStateBefore'],
            mathematicalWriterStateHash=checked['checkpoint']['writerStateHash']))
    hashes={i:(sha(zf/(i+'.zip')) if recovery else write_summary_zip(zf,n)) for i,n in notes.items()};zip_reads=[]
    calls=feature_calls=0;raws=[];scored=[];saved={};steps=[];management_steps=[];course={}
    if recovery:
        calls=len(recovery['raws']);feature_calls=len(recovery['features'])
        raws=list(copy.deepcopy(recovery['raws']).values())
        scored=[read(p) for p in (args.out/'responses').glob('*-scored.json')]
        for kind in ('object','management-choice','management-feedback','summary','revision-feedback'):
            saved[kind]=[read(p) for p in (args.out/kind).glob('*.json')]
        steps=copy.deepcopy(recovery['summarySteps']);management_steps=copy.deepcopy(recovery['managementSteps'])
    reused_raw_count=len(raws)
    base=mathematical=semantic=writer=manager=None;before={};after={};frozen_held=None;protected=None
    installed={};heldout_ok=None;stop='completed';error=None
    final_initial=copy.deepcopy(initial);summary_states={};manager_state=None;seal_file=None
    deadline=time.monotonic()+max(0.,float(os.environ.get('ZIP_SUMMARY_DEADLINE',str(time.time()+1200)))-time.time())
    def save(kind,row):
        path=args.out/'responses'/(row['recordId']+'-'+kind+'.json') if kind in ('raw','scored') else args.out/kind/(row['id']+'.json')
        write_once(path,row);saved.setdefault(kind,[]).append(copy.deepcopy(row))
        if kind=='raw':raws.append(copy.deepcopy(row))
        if kind=='scored':scored.append(copy.deepcopy(row))
        progress.mark(rawResponsesSaved=len(raws),completeNewObjects=len(saved.get('object',[])),
            managementUpdates=len(management_steps),summaryUpdates=len(steps),revisions=len(saved.get('summary',[])),
            validManagementActions=sum(r['validStudentAction'] for r in saved.get('management-choice',[])),inFlight=None)
    def load(identifier):
        n=read_summary_zip(zf,identifier,hashes);zip_reads.append(identifier);return n
    def store(n):hashes[n['id']]=write_summary_zip(zf,n)
    def timeout(signum,frame):raise TimeoutError('Phase compute deadline; saved training can be recovered')
    old_term=signal.signal(signal.SIGTERM,timeout);old_alarm=signal.signal(signal.SIGALRM,timeout)
    signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
    try:
        progress.mark('只加载 tokenizer；检查真实管理提示、已有总结与后续历史的输入预算')
        _,limits,inputs=prepare_inputs(args.student,plan,roots,initial,notes)
        write_once(args.out/(('recovery-prompt-length-preflight-'+args.out.name+'.json') if recovery else 'prompt-length-preflight.json'),inputs)
        progress.mark('加载冻结数学学生、原总结写作参数及独立管理参数')
        import torch
        from safetensors.torch import load_file,save_file
        from zip_pilot import load_student
        from zip_pilot_model import state_digest
        from math_writer_adapter import MathWriterAdapter
        base,tokenizer,identity=load_student(args.student,'cpu')
        require(identity['snapshotSha256']==checked['identity']['snapshotSha256'],'Different student snapshot')
        mathematical=MathWriterAdapter(base,rank=8,last_layers=4,alpha=16);mathematical.restore(load_file(str(checked['writer'])))
        semantic=MathWriterAdapter(base,rank=8,last_layers=4,alpha=16)
        semantic.restore(load_file(str(fp/'checkpoints'/foundation['final']['semanticFile'])))
        torch.manual_seed(seed_for(number,0,1));writer=MathWriterAdapter(base,rank=8,last_layers=4,alpha=16)
        writer.restore(load_file(str(recovery['summaryFile'] if recovery else resume['summaryFiles'][A])))
        torch.manual_seed(seed_for(number,0,2));manager=MathWriterAdapter(base,rank=8,last_layers=4,alpha=16)
        if recovery or resume.get('managementFile'):
            manager.restore(load_file(str(recovery['managementFile'] if recovery else resume['managementFile'])))
            require(manager.digest()==(recovery['managementHash'] if recovery else resume['managementHash']),'Management checkpoint changed')
        else:require(all(torch.count_nonzero(v).item()==0 for k,v in manager.learned_state().items() if k.endswith('b.weight')),'Fresh manager output is not zero')
        base.eval().requires_grad_(False)
        for adapter in (mathematical,semantic,writer,manager):
            adapter.eval()
            for p in adapter.parameters_to_train():p.requires_grad_(False);p.grad=None
        before=dict(base=state_digest(base),math=mathematical.digest(),semantic=semantic.digest())
        require(before['base']==foundation['result']['baseStateBefore'] and before['math']==checked['checkpoint']['writerStateHash'] and
            before['semantic']==foundation['final']['semanticStateHash'],'Original frozen weights differ')
        installed.update(summary=writer.digest(),management=manager.digest())
        require(installed['summary']==(recovery['summaryHash'] if recovery else resume['summaryStateHashes'][A]),'Summary checkpoint changed')
        optimizers={k:torch.optim.SGD(a.parameters_to_train(),lr=SUMMARY_LEARNING_RATE) for k,a in (('summary',writer),('management',manager))}
        current_manager=manager.learned_state()
        if recovery:manager.restore(load_file(str(recovery['initialManagementFile'])))
        initial_manager=manager.learned_state();initial_manager_hash=manager.digest()
        if recovery:
            require(initial_manager_hash==recovery['initialCheckpoint']['managementState']['stateHash'],
                'Initial manager control weights differ')
            if recovery['parentWasFreshManager']:
                require(all(torch.count_nonzero(v).item()==0 for k,v in initial_manager.items() if k.endswith('b.weight')),
                    'Original fresh manager was not zero-initialized')
        if recovery:manager.restore(current_manager)
        if recovery:
            frozen_held=copy.deepcopy(installed);final_initial=copy.deepcopy(recovery['bank'])
        seal_file='frozen-seal.safetensors';(cpf/seal_file).write_bytes(Path(resume['summaryFiles'][BRANCHES[1]]).read_bytes()) if not recovery else None
        summary_states[BRANCHES[1]]=dict(file=seal_file,fileSha256=sha(cpf/seal_file),stateHash=resume['summaryStateHashes'][BRANCHES[1]])
        def frozen():
            require(not base.training and all(not a.training and a.enabled for a in (mathematical,semantic,writer,manager)) and
                all(not p.requires_grad and p.grad is None for p in list(base.parameters())+
                    mathematical.parameters_to_train()+semantic.parameters_to_train()+writer.parameters_to_train()+manager.parameters_to_train()),'Frozen flags/gradients changed')
            require(mathematical.digest()==before['math'] and semantic.digest()==before['semantic'] and
                writer.digest()==installed['summary'] and manager.digest()==installed['management'],'Unrecorded adapter change')
        def ask(phase,messages,seed,*,mode,sampled=False,**context):
            nonlocal calls
            if time.monotonic()>=deadline:raise TimeoutError('Deadline before generation')
            require(calls<MAX_GENERATIONS and mode in ('math','observation','summary','management'),'Generation/mode budget')
            frozen();audit=prompt_audit(tokenizer,messages,limits);require_input(audit)
            write_once(args.out/'new-prompt-inputs'/args.out.name/(str(calls+1)+'-'+phase+'.json'),dict(phase=phase,audit=audit,studentPrompt=messages,samplingSeed=seed))
            calls+=1;progress.mark('学生生成 '+str(calls)+'/102：'+phase)
            restore_frozen=mode=='management' and context.get('frozenInitialManagement',False)
            latest=None
            if restore_frozen:
                latest=manager.learned_state();manager.restore(initial_manager);installed['management']=manager.digest()
            try:
                math_enabled=bool(context.get('coldMathEnabled',True)) if mode=='math' else False
                with mathematical.active(math_enabled),semantic.active(False),writer.active(mode=='summary'),manager.active(mode=='management'):
                    value=generate(base,tokenizer,messages,phase,seed,sampled,input_audit=audit)
                    value.update(mathAdapterEnabledDuringGeneration=math_enabled,semanticAdapterEnabledDuringGeneration=False,
                        summaryAdapterEnabledDuringGeneration=mode=='summary',managementAdapterEnabledDuringGeneration=mode=='management',
                        summaryStateHashDuringGeneration=writer.digest(),managementStateHashDuringGeneration=manager.digest(),generationMode=mode)
            finally:
                if latest is not None:manager.restore(latest);installed['management']=manager.digest()
            row=dict(recordId='management-call-'+str(calls).zfill(3),phase=phase,studentPrompt=copy.deepcopy(messages),
                studentOutput=value,samplingSeed=seed,fixtureOnly=False,**context);save('raw',row);frozen()
            ids=value['generatedIds'];logs=value['samplingTokenLogProbabilities'];eos=base.generation_config.eos_token_id
            if eos is None:eos=tokenizer.eos_token_id
            stops=set(eos if isinstance(eos,list) else [eos])-{None}
            require(not value.get('testDouble') and value['originalTextRepaired'] is False and value['sampled'] is sampled and
                value['promptIds']==audit['promptIds'] and tokenizer.decode(ids,skip_special_tokens=True)==value['raw'] and
                0<value['generatedTokens']==len(ids)==len(logs)<=token_limit(phase)==value['responseTokenLimit'] and
                all(type(i) is int and i>=0 for i in ids) and all(math.isfinite(x) for x in logs) and
                abs(sum(logs)-value['samplingLogProbability'])<=1e-10 and (value['stopReason']=='eos')==(ids[-1] in stops),'Actual original/token logs/provenance changed')
            return row
        def feature(task,row,cards):
            nonlocal feature_calls
            if time.monotonic()>=deadline:raise TimeoutError('Deadline before feature batch')
            frozen();require(feature_calls<MAX_FEATURE_BATCHES,'Feature budget')
            prompts=[feature_messages(task,row['studentOutput'],c) for c in cards]
            audits=[prompt_audit(tokenizer,m,limits) for m in prompts]
            for au in audits:require_input(au)
            feature_calls+=1;vectors=[]
            with mathematical.active(False),semantic.active(False),writer.active(False),manager.active(False),torch.no_grad():
                for au in audits:
                    ids=torch.tensor([au['promptIds']],device=next(base.parameters()).device)
                    value=base(input_ids=ids,output_hidden_states=True,use_cache=False,logits_to_keep=1)
                    vectors.append(value.hidden_states[-1][0,-1].float().cpu().tolist())
            fid='management-feature-'+str(feature_calls).zfill(3)
            save('feature',dict(id=fid,task=copy.deepcopy(task),sourceObservationRecordId=row['recordId'],candidateCards=copy.deepcopy(cards),
                candidatePrompts=prompts,candidateHiddenVectors=vectors,normalizedFeatures=normalized_features(vectors),
                mathematicalAdapterEnabled=False,semanticAdapterEnabled=False,summaryAdapterEnabled=False,managementAdapterEnabled=False))
            frozen();return normalized_features(vectors),fid
        def learn(kind,rows,advantages,evidence):
            require(not recovery and frozen_held is None and kind in ('summary','management') and
                all(r['task']['split']=='training' for r in rows) and not evidence.get('heldoutFeedback',False),'Heldout/wrong parameter update')
            target=writer if kind=='summary' else manager;records=steps if kind=='summary' else management_steps
            cap=WRITING_STEP_CAP if kind=='summary' else MANAGEMENT_STEP_CAP
            require(len(records)<cap and all(r['studentOutput']['sampled'] is True and
                r['studentOutput'][kind+'StateHashDuringGeneration']==installed[kind] for r in rows),'Changed sampled trajectory or update cap')
            frozen();old=target.learned_state();before_hash=installed[kind];optimizer=optimizers[kind]
            try:
                for p in target.parameters_to_train():p.requires_grad_(True)
                with mathematical.active(False),semantic.active(False),writer.active(kind=='summary'),manager.active(kind=='management'):
                    update=update_words(base,target,optimizer,[r['studentOutput'] for r in rows],advantages,len(rows)*128)
                require(all(torch.isfinite(p).all().item() for p in target.parameters_to_train()),'Nonfinite adapter')
                installed[kind]=target.digest()
                if update['updated']:
                    step=dict(id=kind+'-'+str(len(records)+1),parameterKind=kind,sourceRecordIds=[r['recordId'] for r in rows],
                        beforeHash=before_hash,afterHash=installed[kind],advantages=list(advantages),evidence=copy.deepcopy(evidence),
                        policyUpdate=copy.deepcopy(update),optimizer='SGD without momentum',learningRate=SUMMARY_LEARNING_RATE)
                    file=step['id']+'.safetensors'
                    with checkpoint_boundary():
                        save_file(target.learned_state(),str(cpf/file));step.update(file=file,fileSha256=sha(cpf/file));save(kind+'-step',step)
                    records.append(step)
                update.update(beforeHash=before_hash,afterHash=installed[kind],sourceRecordIds=[r['recordId'] for r in rows],parameterKind=kind)
            except BaseException:target.restore(old);installed[kind]=before_hash;raise
            finally:
                optimizer.zero_grad(set_to_none=True)
                for p in target.parameters_to_train():p.grad=None;p.requires_grad_(False)
            frozen();return update
        def checkpoint(label,entries,history,statuses):
            nonlocal final_initial,frozen_held,manager_state,deadline
            frozen();rows={}
            with checkpoint_boundary():
                for kind,adapter in (('summary',writer),('management',manager)):
                    file=label+'-'+kind+'.safetensors';save_file(adapter.learned_state(),str(cpf/file))
                    rows[kind]=dict(file=file,fileSha256=sha(cpf/file),stateHash=adapter.digest())
                row=dict(protocol=PROTOCOL,label=label,summaryState=rows['summary'],managementState=rows['management'],
                    frozenSealState=summary_states[BRANCHES[1]],head=copy.deepcopy(initial['head']),
                    historiesHash=digest(history),statusesHash=digest(statuses),entriesHash=digest(entries),
                    baseStateHash=before['base'],mathematicalWriterStateHash=before['math'],originalSemanticStateHash=before['semantic'])
                write_once(cpf/(label+'.json'),row)
                final_initial=dict(entries=copy.deepcopy(entries),history=copy.deepcopy(history),statuses=copy.deepcopy(statuses),head=copy.deepcopy(initial['head']))
                if label in ('after-8','training-final'):
                    phase_receipt(args.out,final_initial,row)
                    harvest_review(args.out,args.out/'Lain-Zip-Memory-Management-Review.zip')
                if label=='training-final':
                    frozen_held=copy.deepcopy(installed)
                    progress.mark('训练断点已保存；进入零更新冻结复验')
                    deadline=time.monotonic()+float(os.environ.get('ZIP_SUMMARY_EVAL_SECONDS','600'))
                    signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
        if recovery:
            progress.mark('恢复已完成训练及已返回复验原文；不再次训练')
            deadline=time.monotonic()+float(os.environ.get('ZIP_SUMMARY_EVAL_SECONDS','600'))
            signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
            # Saved TRAIN replay verifies credit/state chains. Only the absent
            # tail calls reach the real sampler. All old files are immutable.
            course=replay_saved_course(args.out,dict(trainingRound=number),notes,initial,
                recovery['initialCheckpoint'],recovery['features'],recovery['raws'],
                steps+management_steps,tail=dict(ask=ask,feature=feature,save=save,
                    checkpoint=checkpoint,deadline=lambda:deadline))
        else:
            for n,old in enumerate(checked['anchors'],1):
                row=ask('cold_replay',old['studentPrompt'],old['samplingSeed'],mode='math',sampled=False,
                    task=old['task'],coldNumber=n,sourceRecordId=old['recordId'],coldMathEnabled=old['requestedMathAdapterEnabled'])
                exact=exact_reproduction(old['studentOutput'],row['studentOutput']);save('scored',dict(row,check=dict(exactReproduction=exact)))
                require(exact['exact'],'Cold math reproduction failed before new training')
            course=run_course(plan,roots,initial,ask,feature,save,learn,load,store,checkpoint,lambda:deadline,number)
        heldout_ok=installed==frozen_held;require(heldout_ok,'Heldout changed summary/management weights')
    except Exception as exc:
        stop='time_budget' if isinstance(exc,TimeoutError) else 'error';error=type(exc).__name__+': '+str(exc)
        atomic_json(args.out/'error.json',dict(error=error,traceback=traceback.format_exc(),generationAttempts=calls))
        print('保留实际完成步骤；停止原因：'+error,flush=True)
    finally:
        signal.setitimer(signal.ITIMER_REAL,0)
        # Persist evidence FIRST. Full source hashing/model digests may be slow.
        progress.mark('先保存原文与阶段结果，再核验冻结和源文件')
        publish_partial(args.out,error or 'final_integrity_checks_pending')
        harvest_review(args.out,args.out/'Lain-Zip-Memory-Management-Review.zip')
        signal.setitimer(signal.ITIMER_REAL,float(os.environ.get('ZIP_SUMMARY_SAVE_SECONDS','180')))
        try:
            protected=(snapshot(fp)==foundation['sourceHashes'] and snapshot(parent)==resume['parentHashes'] and
                all(sha(Path(p))==h for p,h in checked['protected'].items()) and snapshot(args.old_tools)==checked['toolFiles'] and
                (not recovery or snapshot(args.recover)==recovery['originalHashes']))
            require(protected,'Protected originals changed')
            if base is not None:
                after=dict(base=state_digest(base),math=mathematical.digest(),semantic=semantic.digest())
                require(before==after,'Original frozen weights changed')
        except Exception as exc:stop='error';error=(error+'; ' if error else '')+str(exc)
        signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGTERM,old_term);signal.signal(signal.SIGALRM,old_alarm)
        for adapter in (manager,writer,semantic,mathematical):
            if adapter is not None:adapter.close()
    atomic_json(args.out/'memory-bank.json',dict(protocol=PROTOCOL,entries=final_initial['entries'],history=final_initial['history'],
        statuses=final_initial['statuses'],head=initial['head'],zipByteHashes=hashes,allOriginalsRetained=True))
    if not course:
        course=dict(objects=saved.get('object',[]),managementChoices=saved.get('management-choice',[]),
            managementFeedback=saved.get('management-feedback',[]),revisions=saved.get('summary',[]),revisionFeedback=saved.get('revision-feedback',[]))
    report=summarize(course)
    result=dict(protocol=PROTOCOL,trainingRound=number,stopReason=stop,error=error,fixtureOnly=False,fixtureGenerations=0,teacherCalls=0,
        actualStudentGenerations=len(raws),featureForwardBatches=feature_calls,managementOptimizerUpdates=len(management_steps),
        summaryOptimizerUpdates=len(steps),trainingUpdates=len(steps)+len(management_steps),choiceHeadTrainingUpdates=0,
        studentWrittenSummaryZips=len(saved.get('summary',[])),completedTrainingObjects=sum(o['phase']=='training' for o in course['objects']),
        completedHeldoutObjects=sum(o['phase']=='heldout' for o in course['objects']),
        coldReproductions=sum(r['phase']=='cold_replay' and r['check']['exactReproduction']['exact'] for r in scored),
        baseWeightsUnchanged=state_unchanged(before.get('base'),after.get('base')),
        mathematicalWriterUnchanged=state_unchanged(before.get('math'),after.get('math')),
        originalSemanticWriterUnchanged=state_unchanged(before.get('semantic'),after.get('semantic')),
        originalFilesUnchanged=protected,heldoutLearnedStateUnchanged=heldout_ok,
        methodHeadsUnchanged=(initial['head']==final_initial['head'] and all(any(
            e['originEntryHash']==old['originEntryHash'] and e['head']==old['head']
            for old in initial['entries']) for e in final_initial['entries'])),
        completeTrainingExperiment=stop=='completed' and len(course['objects'])==12,
        recoveredTrainingPhase=bool(recovery),recoveryOriginalFolder=str(args.recover.resolve()) if recovery else None,
        newlyGeneratedStudentResponses=len(raws)-reused_raw_count,reusedStudentOriginals=reused_raw_count,
        newlyCommittedOptimizerUpdates=0 if recovery else len(steps)+len(management_steps),
        continuationOfSameCourseNotIndependentReplication=bool(recovery),
        modelWeightsLoaded=base is not None,actualNativeSummaryZipReads=len(zip_reads),summary=report,elapsedSeconds=time.monotonic()-started)
    atomic_json(args.out/'run-file-manifest.json',dict(files={k:v for k,v in snapshot(args.out).items()
        if k not in ('result.json','Lain-Zip-Memory-Management-Review.zip')}))
    # A complete result is published only after the file manifest commits.
    atomic_json(args.out/'result.json',result)
    # Light review contains actual raw generations and compact decisions/history.
    # Full vectors, ancestral notes, weights and replay inputs stay in the run.
    harvest_review(args.out,args.out/'Lain-Zip-Memory-Management-Review.zip')
    print('总结管理训练汇总：'+json.dumps(report,ensure_ascii=False),flush=True)
    print('完整性：'+json.dumps({k:result[k] for k in ('stopReason','error','actualStudentGenerations','trainingUpdates',
        'managementOptimizerUpdates','summaryOptimizerUpdates','baseWeightsUnchanged','mathematicalWriterUnchanged',
        'originalSemanticWriterUnchanged','methodHeadsUnchanged','heldoutLearnedStateUnchanged','originalFilesUnchanged')},ensure_ascii=False),flush=True)
    print('完整检查点：'+str(args.out),flush=True)
    return 0 if stop=='completed' else 1


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--recover',type=Path)
    for name in ('work','student','old-tools','out'):parser.add_argument('--'+name,type=Path)
    parser.add_argument('--inspect-only',action='store_true')
    args=parser.parse_args()
    if args.inspect_only:
        from zip_summary_training_v8_inspect import inspect_training_source
        source=inspect_training_source(args.source)
        print(json.dumps(dict(sourceProtocol=source['base']['result']['protocol'],
            managementHistoryRecords=len(source['managementInitial']['history']),realStudentGenerations=0)))
        return 0
    require(all(getattr(args,n) is not None for n in ('work','student','old_tools','out')),'Real training requires original environment paths')
    return run(args)

if __name__=='__main__':raise SystemExit(main())
