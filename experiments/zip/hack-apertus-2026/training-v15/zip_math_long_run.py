"""One model load; up to 24 durable math-training blocks and frozen comparisons."""
import argparse
import copy
import json
import os
from pathlib import Path
import signal
import time
import traceback
import uuid
from types import SimpleNamespace
from draft_inspect_runtime import read,sha,snapshot
from writer_check_core import exact_reproduction
from writer_check_run import preflight
from tool_loop_course import archived_inputs
from zip_management_stable_inspect import inspect_source
import zip_management_geometry_core as management
from zip_label_grounded_checks import feature_messages
from object_choice_core import normalized_features
from zip_summary_training_v6_policy import input_limits,prompt_audit,require_input,generate
from zip_summary_training_v9_progress import StageProgress
from zip_management_head_budget import state_digest
from zip_math_long_core import *
from zip_math_long_policy import update_math,validate_trajectory
from zip_math_long_receipts import atomic_json,commits,publish,partial,report,review


def previous(work,source,payload):
    matches=[]
    for p in Path(work).glob('zip-math-long-*/protocol.json'):
        v=read(p)
        if v.get('protocol')==PROTOCOL and v.get('source')==str(Path(source).resolve()) and v.get('payloadSha256')==payload:
            matches.append((v['experimentNumber'],str(p.parent),p.parent))
    return max(matches)[2] if matches else None


def run(args):
    started=time.monotonic();end=started+args.seconds
    compute_end=end-1800;eval_end=end-600
    require(args.seconds>1800,'At least 30 minutes required to reserve terminal evaluation and saving')
    progress=StageProgress(os.environ.get('ZIP_SUMMARY_PROGRESS_FILE'))
    def mark(text,**fields):progress.mark(text,**fields)
    def alarm(*unused):raise TimeoutError('Math training/evaluation phase deadline')
    def interrupted(*unused):raise InterruptedError('notebook_interrupt_or_parent_stop')
    prior_handlers={s:signal.getsignal(s) for s in (signal.SIGALRM,signal.SIGTERM,signal.SIGINT)}
    signal.signal(signal.SIGALRM,alarm);signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)
    signal.setitimer(signal.ITIMER_REAL,min(1800,args.seconds))
    source=args.source.resolve();out=args.out.resolve();base=adapter=optimizer=None
    before_base=after_base=None;source_unchanged=None;frozen_policies=None
    initial_count=len(list((out/'committed').glob('step-*/receipt.json')))
    stop='error';error=None;initial_state=None;binding=None;terminal_complete=False
    try:
        mark('核验完整管理头与全部 TRAIN 来源；尚未加载学生，生成 0')
        resume=inspect_source(source,training_only=True)
        foundation=resume['base'];fp=Path(foundation['folder'])
        base_choice=Path(read(fp/'source-checkpoint.json')['baseChoiceSource']).resolve()
        checked=preflight(SimpleNamespace(source=base_choice,student=args.student,old_tools=args.old_tools,
            out=out.with_name(out.name+'-admission-'+uuid.uuid4().hex)))
        roots=copy.deepcopy(foundation['bank']['mathematicalRoots']);bank=copy.deepcopy(resume['managementInitial'])
        notes=copy.deepcopy(resume['inherited']);guide=copy.deepcopy(resume['initial']['guide'])
        manager=copy.deepcopy(resume['continuedHead']);policy_before=digest(dict(bank=bank,notes=notes,manager=manager,guide=guide,roots=roots))
        protected_folders={str(source):resume['parentHashes'],str(fp):foundation['sourceHashes'],
            str(resume['originalTrainFolder']):resume['originalTrainHashes'],**resume.get('protectedAncestors',{})}
        binding=dict(source=str(source),sourceFiles=resume['parentHashes'],initialMathHash=checked['checkpoint']['writerStateHash'],
            initialBaseHash=foundation['result']['baseStateBefore'],frozenPoliciesHash=policy_before,
            initialWriterFile=str(checked['writer']),initialWriterFileHash=sha(checked['writer']),payloadSha256=args.payload)
        require(not out.is_relative_to(source) and not source.is_relative_to(out),'Output overlaps source')
        if out.exists():
            require(read(out/'source-checkpoint.json')==binding and read(out/'protocol.json')['protocol']==PROTOCOL,
                'Different math recovery source, weights or payload')
            plan=read(out/'plan.json');validate_plan(plan)
            atomic_json(out/'previous-attempts'/('entry-'+str(time.time_ns())+'.json'),
                dict(previousResult=read(out/'result.json') if (out/'result.json').is_file() else None,continuation=True))
        else:
            number=max([read(p)['experimentNumber'] for p in args.work.glob('zip-math-long-*/protocol.json')
                if read(p).get('protocol')==PROTOCOL],default=0)+1
            archives=[p for p in args.work.glob('zip-*') if p.is_dir()]
            excluded,_=archived_inputs(archives)
            excluded=set(excluded)
            for folder in archives:
                p=folder/'plan.json'
                if p.is_file():
                    v=read(p)
                    for split in ('training','heldout'):
                        excluded.update(t['semanticInputKey'] for t in v.get(split,[]))
                    if v.get('protocol')==PROTOCOL:
                        excluded.update(t['semanticInputKey'] for b in v['blocks'] for t in b['training'])
                        excluded.update(t['semanticInputKey'] for e in v['evaluations'] for t in e['tasks'])
                        excluded.update(t['semanticInputKey'] for t in v['terminalEvaluationTasks'])
            excluded.update(c['task']['semanticInputKey'] for c,f,fid in resume['replayCache'])
            plan=make_plan(excluded,roots,number);out.mkdir(parents=True,exist_ok=False)
            atomic_json(out/'source-checkpoint.json',binding);atomic_json(out/'plan.json',plan)
            atomic_json(out/'protocol.json',dict(protocol=PROTOCOL,source=str(source),payloadSha256=args.payload,
                experimentNumber=number,fixtureOnly=False,teacherCalls=0,createdAt=time.time(),recipe=recipe()))
        number=plan['experimentNumber'];old=commits(out,binding);initial_count=len(old)
        # Only real TRAIN originals from the fully admitted source chain.
        originals=[]
        for folder in protected_folders:
            for p in (Path(folder)/'responses').glob('*.json'):
                r=read(p)
                if r.get('mode')=='math' and r.get('task',{}).get('split')=='training':originals.append(r)
        pool=verified_rehearsal(originals,roots)
        atomic_json(out/'rehearsal-bank.json',dict(sourceRecordIds=[r['recordId'] for r in pool],
            originals=pool,heldoutIncluded=False,studentOriginalsUnmodified=True))
        mark('只加载 tokenizer；预检所有预定数学任务与原文复习输入长度')
        from transformers import AutoTokenizer
        tokenizer=AutoTokenizer.from_pretrained(args.student,local_files_only=True)
        limits=input_limits(read(args.student/'config.json'),tokenizer)
        def checked_input(messages):
            a=prompt_audit(tokenizer,messages,limits);require_input(a);return a
        task_prompts=[]
        for task in [t for b in plan['blocks'] for t in b['training']]+[t for e in plan['evaluations'] for t in e['tasks']]+plan['terminalEvaluationTasks']:
            for card in management.candidate_cards(roots):task_prompts.append(checked_input(management.math_messages(task,card,roots)))
        for a in checked['anchors']:checked_input(a['studentPrompt'])
        for a in pool:
            audit=checked_input(a['studentPrompt'])
            require(audit['promptIds']==a['studentOutput']['promptIds'] and
                tokenizer.decode(a['studentOutput']['generatedIds'],skip_special_tokens=True)==a['studentOutput']['raw'],
                'Changed tokenizer or verified original rehearsal tokens')
        atomic_json(out/'input-preflight.json',dict(promptsChecked=len(task_prompts),allFit=True,
            longestInputTokens=max(a['inputTokens'] for a in task_prompts),noSilentTruncation=True))
        mark('加载一次基础模型与原数学 LoRA；管理、总结、语义参数不挂载')
        import torch
        from safetensors.torch import load_file,save_file
        from zip_pilot import load_student
        from math_writer_adapter import MathWriterAdapter
        base,tokenizer,identity=load_student(args.student,'cpu')
        require(identity['snapshotSha256']==checked['identity']['snapshotSha256'],'Different base model snapshot')
        torch.manual_seed(15500000000+number);adapter=MathWriterAdapter(base,rank=8,last_layers=4,alpha=16)
        adapter.restore(load_file(str(checked['writer'])));adapter.eval();base.eval().requires_grad_(False)
        initial_state=adapter.learned_state();before_base=state_digest(base)
        require(before_base==binding['initialBaseHash'] and adapter.digest()==binding['initialMathHash'],
            'Different starting mathematical/base weights')
        parameters=adapter.parameters_to_train()
        for p in parameters:p.requires_grad_(True);p.grad=None
        optimizer=torch.optim.AdamW(parameters,lr=recipe()['learningRate'],weight_decay=0.)
        def restore_step(index):
            if not index:adapter.restore(initial_state);optimizer.state.clear();return
            p=out/'committed'/('step-'+str(index).zfill(4));r=read(p/'receipt.json')
            require(sha(p/'writer.safetensors')==r['writerFileHash'] and sha(p/'optimizer.pt')==r['optimizerFileHash'],
                'Changed resume weights or optimizer')
            adapter.restore(load_file(str(p/'writer.safetensors')))
            require(adapter.digest()==r['afterWriterHash'],'Resume tensor digest differs')
            optimizer.load_state_dict(torch.load(p/'optimizer.pt',map_location='cpu',weights_only=True))
        def budget(limit):
            if time.monotonic()>=limit:raise TimeoutError('Math generation/optimization budget')
        live_limit=compute_end
        def ask(phase,messages,seed,mode,writer_hash,**context):
            identifier='math-call-'+digest(dict(phase=phase,messages=messages,seed=seed,writerHash=writer_hash,context=context))[:24]
            p=out/'responses'/(identifier+'.json');audit=checked_input(messages)
            sampled=phase=='math_training';enabled=mode=='math'
            if enabled:require(adapter.digest()==writer_hash,'Different writer before actual/cached generation')
            if p.is_file():
                r=read(p);require(r['recordId']==identifier and r['phase']==phase and r['studentPrompt']==messages and
                    r['samplingSeed']==seed and r['writerHash']==writer_hash and r['mode']==mode and
                    all(r.get(k)==v for k,v in context.items()),'Changed cached math response binding')
            else:
                budget(live_limit);require(len(list((out/'responses').glob('*.json')))<808,'Math generation cap exceeded')
                mark('实际学生生成：'+phase,rawResponsesSaved=len(list((out/'responses').glob('*.json'))))
                with adapter.active(enabled):
                    # Keep the established native sampler and EOS protocol.
                    v=generate(base,tokenizer,messages,'route_math' if enabled else 'heldout_observation_without_summary',
                        seed,sampled,input_audit=audit)
                v.update(mathAdapterEnabledDuringGeneration=enabled,allOtherAdaptersEnabled=False)
                r=dict(id=identifier,recordId=identifier,phase=phase,mode=mode,writerHash=writer_hash,
                    samplingSeed=seed,studentPrompt=messages,studentOutput=v,fixtureOnly=False,**context)
                atomic_json(p,r)  # Raw first, even if a later audit rejects it.
            v=r['studentOutput'];eos=base.generation_config.eos_token_id
            if eos is None:eos=tokenizer.eos_token_id
            stops=set(eos if isinstance(eos,list) else [eos])-{None}
            require(r['fixtureOnly'] is False and v['originalTextRepaired'] is False and not v.get('testDouble') and
                v['sampled'] is sampled and v['mathAdapterEnabledDuringGeneration']==enabled and
                v['allOtherAdaptersEnabled'] is False and v['promptIds']==audit['promptIds'] and
                0<v['generatedTokens']==len(v['generatedIds'])==len(v['samplingTokenLogProbabilities'])<=96 and
                tokenizer.decode(v['generatedIds'],skip_special_tokens=True)==v['raw'] and
                abs(sum(v['samplingTokenLogProbabilities'])-v['samplingLogProbability'])<=1e-10 and
                (v['stopReason']=='eos')==(v['generatedIds'][-1] in stops),
                'Changed raw math tokens, sampler, EOS or adapter provenance')
            if enabled:require(adapter.digest()==writer_hash,'Generation mutated mathematical parameters')
            return r
        mark('先核对八条原数学冷复现；通过后才接续数学参数')
        for a in checked['anchors']:
            with adapter.active(a['requestedMathAdapterEnabled']):
                # Historical off anchors require an explicitly disabled adapter.
                mode='math' if a['requestedMathAdapterEnabled'] else 'observation'
                r=ask('cold_replay',a['studentPrompt'],a['samplingSeed'],mode,
                    binding['initialMathHash'] if mode=='math' else 'disabled',task=a['task'],sourceRecordId=a['recordId'])
            require(exact_reproduction(a['studentOutput'],r['studentOutput'])['exact'],'Cold mathematical source reproduction failed')
        restore_step(initial_count)
        # Reaudit all committed source credits without rerunning optimizer steps.
        tasks={t['mathTrainingStep']:t for b in plan['blocks'] for t in b['training']}
        for p,r in old:
            rows=[read(out/'responses'/(identifier+'.json')) for identifier in r['responseIds']]
            require(r['task']==tasks[r['ordinal']] and digest(r['feedback'])==digest(training_feedback(r['task'],rows,roots)) and
                r['responseHashes']=={x['recordId']:digest(x) for x in rows} and
                all(x['writerHash']==r['beforeWriterHash'] for x in rows),'Changed committed original math feedback')
            anchor=pool[(r['ordinal']-1)%len(pool)] if pool else None
            require(r['rehearsalOriginalHash']==(digest(anchor) if anchor else None) and
                r['rehearsalSourceRecordId']==(anchor['recordId'] if anchor else None),
                'Changed committed verified-rehearsal target binding')
        signal.setitimer(signal.ITIMER_REAL,max(.001,compute_end-time.monotonic()))
        mark('开始数学写作训练；每次优化器更新原子保存，旧更新不重做',mathUpdates=initial_count)
        def train(task):
            budget(compute_end);index=task['mathTrainingStep'];before=adapter.digest()
            rows=[]
            for ci,c in enumerate(training_cards(task,roots)):
                rows.append(ask('math_training',management.math_messages(task,c,roots),
                    15500000000+number*1000000+index*100+ci,'math',before,task=task,selectedCandidate=c))
            feedback=training_feedback(task,rows,roots)
            atomic_json(out/'feedback'/(task['id']+'.json'),feedback)
            anchor=pool[(index-1)%len(pool)] if pool else None
            try:
                with adapter.active(True):v=update_math(base,adapter,optimizer,rows,feedback,anchor)
                v.update(task=task,feedback=feedback,responseIds=[r['recordId'] for r in rows],
                    responseHashes={r['recordId']:digest(r) for r in rows},
                    rehearsalOriginalHash=digest(anchor) if anchor else None,
                    baseWeightUpdates=0,managerUpdates=0,methodHeadUpdates=0,heldoutFeedbackUsed=False)
                def save_state(writer_file,optimizer_file):
                    save_file(adapter.learned_state(),str(writer_file));torch.save(optimizer.state_dict(),optimizer_file)
                publish(out,index,binding,v,save_state)
            except BaseException:
                # A published complete transaction is adopted even if the
                # interruption occurred immediately after its directory rename.
                restore_step(len(commits(out,binding)));raise
            mark('数学更新已提交 '+str(index)+'/192',mathUpdates=index)
            if index%8==0:partial(out,'training_block_saved')
        def vectors(kind,task,prompts):
            identifier='math-feature-'+digest(dict(kind=kind,task=task,prompts=prompts))[:24]
            p=out/'feature'/(identifier+'.json');audits=[checked_input(x) for x in prompts]
            if p.is_file():
                r=read(p);require(r['featureHash']==digest({k:v for k,v in r.items() if k!='featureHash'}) and
                    r['kind']==kind and r['task']==task and r['candidatePrompts']==prompts and
                    r['baseHash']==before_base and r['allAdaptersDisabled'] is True and
                    r['normalizedFeatures']==(management.normalize(r['hiddenVectors']) if kind=='management' else normalized_features(r['hiddenVectors'])),
                    'Changed frozen evaluation features')
                return r['normalizedFeatures'],identifier
            values=[]
            with adapter.active(False),torch.no_grad():
                for a in audits:
                    budget(live_limit);t=torch.tensor([a['promptIds']],device=next(base.parameters()).device)
                    value=base(input_ids=t,output_hidden_states=True,use_cache=False,logits_to_keep=1)
                    values.append(value.hidden_states[-1][0,-1].float().cpu().tolist())
            f=management.normalize(values) if kind=='management' else normalized_features(values)
            r=dict(id=identifier,kind=kind,task=task,candidatePrompts=prompts,hiddenVectors=values,
                normalizedFeatures=f,allAdaptersDisabled=True,baseHash=before_base)
            r['featureHash']=digest(r);atomic_json(p,r);return f,identifier
        def evaluate(batch):
            nonlocal live_limit
            index=batch['afterStep'];label=str(index) if not batch.get('terminal') else 'terminal'
            current=adapter.learned_state();current_hash=adapter.digest()
            if index:
                p=out/'committed'/('step-'+str(index).zfill(4));trained=load_file(str(p/'writer.safetensors'))
                trained_hash=read(p/'receipt.json')['afterWriterHash']
            else:trained=initial_state;trained_hash=binding['initialMathHash']
            for p in parameters:p.requires_grad_(False);p.grad=None
            try:
                for ti,task in enumerate(batch['tasks'],1):
                    budget(live_limit);path=out/'object'/('eval-'+label+'-'+task['id']+'.json')
                    if path.is_file():
                        o=read(path);require(o['task']==task and o['trainedWriterHash']==trained_hash and
                            o['objectHash']==digest({k:v for k,v in o.items() if k!='objectHash'}),'Changed cached evaluation object')
                        continue
                    entry=management.nominate(task,bank['entries']);note=notes[entry['summaryZipId']] if entry else None
                    p_use=0.;management_fid=None
                    if note:
                        mp=management.management_messages(task,note,bank['history'],bank['statuses'].get(note['id'],'available'),guide)
                        f,management_fid=vectors('management',task,[management.action_messages(task,mp,guide,a) for a in management.ACTIONS])
                        p_use=management.use_probability(manager,f)
                    route_probabilities={};observation_ids={};feature_ids={}
                    for key,n in (('without',None),('withSummary',note)):
                        obs=ask('frozen_evaluation_observation',management.observation_messages(task,roots,n),
                            15600000000+number*1000000+(index+ti)*100,'observation','disabled',task=task,summaryZipId=n['id'] if n else None)
                        cards=management.candidate_cards(roots,n)
                        f,fid=vectors('method',task,[feature_messages(task,obs['studentOutput'],c) for c in cards])
                        head=management.restore_head(entry['head'] if n else bank['head'])
                        route_probabilities[key]=head.probabilities(f)[1]
                        observation_ids[key]=obs['recordId'];feature_ids[key]=fid
                    outcomes={};original_ids={}
                    for writer,state,state_hash in (('initial',initial_state,binding['initialMathHash']),('trained',trained,trained_hash)):
                        adapter.restore(state);require(adapter.digest()==state_hash,'Different frozen evaluation writer')
                        actual=[];ids=[]
                        for ci,c in enumerate(management.candidate_cards(roots)):
                            r=ask('frozen_evaluation_math',management.math_messages(task,c,roots),
                                15600000000+number*1000000+(index+ti)*100+ci+10,
                                'math',state_hash,task=task,selectedCandidate=c,writerArm=writer)
                            check=management.audit_math(task,r['studentOutput'],c)
                            atomic_json(out/'math-audit'/(r['recordId']+'.json'),dict(recordId=r['recordId'],check=check))
                            actual.append(int(check['outcomePassed']));ids.append(r['recordId'])
                        require(adapter.digest()==state_hash,'Heldout mutated math parameters')
                        outcomes[writer]=actual;original_ids[writer]=ids
                    scores={}
                    for writer in ('trained','initial'):
                        plain=sum(p*y for p,y in zip(route_probabilities['without'],outcomes[writer]))
                        use=sum(p*y for p,y in zip(route_probabilities['withSummary'],outcomes[writer]))
                        scores[writer+'_writer_managed']=management.utility(p_use,use,plain)
                        scores[writer+'_writer_without_summary']=plain
                        scores[writer+'_writer_uniform_routes']=sum(outcomes[writer])/3
                    o=dict(id='eval-'+label+'-'+task['id'],task=task,evaluationBatch=label,
                        writerCheckpointStep=index,trainedWriterHash=trained_hash,initialWriterHash=binding['initialMathHash'],
                        routeOutcomes=outcomes,sourceMathRecordIds=original_ids,expectedPassByArm=scores,
                        useProbability=p_use,summaryZipId=note['id'] if note else None,summaryCandidateUnavailable=note is None,
                        managementFeatureId=management_fid,methodFeatureIds=feature_ids,observationIds=observation_ids,
                        routeProbabilities=route_probabilities,frozenPoliciesHash=policy_before,heldoutEnteredTraining=False)
                    o['objectHash']=digest(o);atomic_json(path,o)
                    mark('冻结新题复验 '+label+'：'+str(ti)+'/4',mathUpdates=len(commits(out,binding)))
            finally:
                adapter.restore(current);require(adapter.digest()==current_hash,'Evaluation did not restore committed TRAIN writer')
                for p in parameters:p.requires_grad_(True);p.grad=None
        if not (out/'terminal-snapshot.json').is_file():
            try:stop=execute_plan(plan,initial_count,train,evaluate,compute_end,compute_end)
            except TimeoutError:stop='training_budget'
            atomic_json(out/'terminal-snapshot.json',dict(afterStep=len(commits(out,binding)),stopReason=stop,
                trainedWriterHash=adapter.digest(),chosenByTimeOrFixedSchedule=True,chosenByHeldoutScore=False))
        terminal=read(out/'terminal-snapshot.json');stop=terminal['stopReason'];live_limit=eval_end
        signal.setitimer(signal.ITIMER_REAL,max(.001,eval_end-time.monotonic()))
        mark('训练已保存；用预留新题比较最终数学写作与训练前写作；不再更新')
        evaluate(dict(afterStep=terminal['afterStep'],terminal=True,tasks=plan['terminalEvaluationTasks']))
        terminal_complete=True
    except (Exception,KeyboardInterrupt) as exc:
        stop='paused' if isinstance(exc,(InterruptedError,KeyboardInterrupt)) else 'time_budget' if isinstance(exc,TimeoutError) else 'error'
        error=type(exc).__name__+': '+str(exc)
        out.mkdir(parents=True,exist_ok=True)
        atomic_json(out/'error.json',dict(stopReason=stop,error=error,traceback=traceback.format_exc()))
        mark('已停止；保留原文与完整数学更新事务：'+error)
    finally:
        signal.setitimer(signal.ITIMER_REAL,0)
        signal.signal(signal.SIGTERM,signal.SIG_IGN);signal.signal(signal.SIGINT,signal.SIG_IGN)
        out.mkdir(parents=True,exist_ok=True);partial(out,stop);review(out,out/'Lain-Zip-Math-Long-Review.zip')
        signal.setitimer(signal.ITIMER_REAL,600)
        try:
            if before_base is not None:
                mark('原文和断点已保存；核验冻结基础权重及全部来源文件')
                after_base=state_digest(base)
                require(before_base==after_base and all(not p.requires_grad and p.grad is None for p in base.parameters()),
                    'Frozen base weights/gradients changed')
                frozen_policies=policy_before==digest(dict(bank=bank,notes=notes,manager=manager,guide=guide,roots=roots))
                require(frozen_policies,'Frozen management/method policies changed')
                source_unchanged=(all(snapshot(Path(p))==h for p,h in protected_folders.items()) and
                    all(sha(Path(p))==h for p,h in checked['protected'].items()) and snapshot(args.old_tools)==checked['toolFiles'])
                require(source_unchanged,'Protected original files changed')
                if binding:
                    rows=commits(out,binding)
                    if rows:
                        latest=rows[-1][0]
                        atomic_json(out/'deployment-model.json',dict(protocol=PROTOCOL,
                            writerFile=str(latest/'writer.safetensors'),writerHash=rows[-1][1]['afterWriterHash'],
                            baseModelFolder=str(args.student),baseHash=before_base,rank=8,lastLayers=4,alpha=16,
                            frozenPoliciesSource=str(source),frozenPoliciesHash=policy_before,
                            baseModelRetrained=False,mathematicalLoRATrained=True))
        except Exception as exc:
            stop='error';error=(error+'; ' if error else '')+type(exc).__name__+': '+str(exc)
        signal.setitimer(signal.ITIMER_REAL,0)
        if adapter:adapter.close()
        result=report(out,stop,error)
        result.update(fixtureOnly=False,newlyCommittedMathUpdates=result['committedMathOptimizerUpdates']-initial_count,
            baseWeightsUnchanged=before_base is not None and before_base==after_base,
            originalFilesUnchanged=source_unchanged,frozenManagementAndMethodPoliciesUnchanged=frozen_policies,
            terminalEvaluationComplete=terminal_complete,heldoutOptimizersRun=0,
            completeTrainingExperiment=terminal_complete and source_unchanged is True and frozen_policies is True and error is None,
            elapsedSeconds=time.monotonic()-started,numericReplayOfEveryPastTorchUpdatePerformed=False,
            resumeUsesHashBoundWeightsOptimizerAndOriginalFeedback=True)
        result['effectiveMathematicalTrainingCompleted']=bool(result['completeTrainingExperiment'] and
            result['committedMathOptimizerUpdates']>0 and result['mathematicalWriterParametersChanged'])
        atomic_json(out/'result.json',result);review(out,out/'Lain-Zip-Math-Long-Review.zip')
        for s,h in prior_handlers.items():signal.signal(s,h)
    print('数学长训实际结果：'+json.dumps({k:result[k] for k in ('stopReason','error','committedMathOptimizerUpdates',
        'newlyCommittedMathUpdates','mathematicalWriterParametersChanged','verifiedRehearsalUses',
        'freshFinalHeldoutObjects','completeTrainingExperiment','baseWeightsUnchanged','originalFilesUnchanged')},ensure_ascii=False),flush=True)
    print('最终同题数学写作对照：'+json.dumps({k:v for k,v in result['finalSnapshotSummary'].items() if k!='byObject'},ensure_ascii=False),flush=True)
    return 0 if result['completeTrainingExperiment'] else (130 if stop=='paused' else 1)


def main():
    p=argparse.ArgumentParser()
    for name in ('source','work','student','old-tools','out'):p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--payload',required=True);p.add_argument('--seconds',type=float,default=21600)
    return run(p.parse_args())


if __name__=='__main__':raise SystemExit(main())
