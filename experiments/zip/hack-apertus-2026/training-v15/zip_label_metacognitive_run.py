"""Actual v6 student pilot. Source and fixture gates precede model imports."""
import argparse
import copy
import json
import os
from pathlib import Path
import signal
import sys
import time
import traceback
import zipfile

sys.path.insert(0,str(Path(__file__).resolve().parent))
from writer_check_run import preflight as checked_source
from writer_check_core import write_once,exact_reproduction
from draft_inspect_runtime import read,sha,snapshot
from tool_loop_course import archived_inputs
from object_choice_core import normalized_features
from choice_continue_core import make_plan
from zip_label_grounded_checks import feature_messages
from zip_semantic_generation import generate_note,NATURAL_LANGUAGE
from zip_label_metacognitive_checks import require,FACT_PROTOCOL,META_PROTOCOL,GUARD_PROTOCOL
from zip_label_metacognitive_core import (PROTOCOL,TOKENS,GENERATION_CAP,FEATURE_BATCH_CAP,run_course,summarize)
from zip_label_metacognitive_policy import update_words,generate_meta
from zip_label_metacognitive_source import inspect_source
from zip_label_metacognitive_progress import StageProgress

def next_round(work):
    numbers=[]
    for p in Path(work).glob('zip-label-metacognitive-*'):
        if not (p/'protocol.json').is_file():continue
        row=read(p/'protocol.json')
        if row.get('protocol')!=PROTOCOL:continue
        n=row.get('metacognitiveRound')
        require(type(n) is int and 1<=n<=1000,'Invalid reserved round number')
        numbers.append(n)
    n=max(numbers,default=0)+1;require(n<=1000,'v6 round limit');return n

def run(args):
    started=time.monotonic();progress=StageProgress(os.environ.get('ZIP_LABEL_META_PROGRESS_FILE'))
    previous=args.source.resolve();resume=inspect_source(previous)
    require(not args.out.resolve().is_relative_to(previous) and not previous.is_relative_to(args.out.resolve()),
        'Output cannot overlap parent source')
    args.source=Path(read(previous/'source-checkpoint.json')['baseChoiceSource']).resolve()
    checked=checked_source(args)
    roots=copy.deepcopy(resume['bank']['mathematicalRoots'])
    require(resume['result']['mathematicalWriterStateHash']==checked['checkpoint']['writerStateHash'],
        'Parent belongs to another mathematical writer')
    round_number=next_round(args.work)
    history=[p for p in args.work.glob('zip-*') if p.is_dir() and
        ((p/'result.json').is_file() or list(p.glob('*questions.json')))]
    for p in (previous,args.source,checked['writer'].parent,Path(checked['checkpoint']['choiceSource'])):
        if p not in history:history.append(p)
    excluded,freshness=archived_inputs(history);full_plan=make_plan(excluded,roots)
    plan=dict(full_plan,training=full_plan['training'][:2],trainingObjects=2,
        reservedUnusedTraining=full_plan['training'][2:],priorTrainingReplayObjects=8)
    require(not {t['semanticInputKey'] for t in plan['training']+plan['heldout']} & excluded,'Reused new input')
    args.out.mkdir(parents=True,exist_ok=False)
    for relative,expected in resume['sourceHashes'].items():
        if Path(relative).suffix=='.zip':continue
        data=(previous/relative).read_bytes();require(__import__('hashlib').sha256(data).hexdigest()==expected,'Parent changed')
        target=args.out/'parent-iteration-originals'/relative;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
    for path in Path(__file__).resolve().parent.glob('*.py'):
        target=args.out/'evaluation-code'/path.name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(path.read_bytes())
    for name in ('zip_pilot.py','zip_pilot_model.py'):
        target=args.out/'frozen-original-model-tools'/name;target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes((args.old_tools/name).read_bytes())
    head_state=copy.deepcopy(resume['final']['head']);initial_labels=copy.deepcopy(resume['final']['labels'])
    initial_meta=copy.deepcopy(resume.get('initialMeta'));baseline=resume['final']['baselinePass']
    write_once(args.out/'source-checkpoint.json',dict(baseChoiceSource=str(args.source),
        parentIterationSource=str(previous),parentIterationResultSha256=sha(previous/'result.json'),
        parentSourceFileHashes=resume['sourceHashes'],metacognitiveRound=round_number,
        originalWriterFile=str(checked['writer']),originalWriterFileSha256=sha(checked['writer'])))
    write_once(args.out/'source-training-anchors.json',dict(rows=resume['anchors'],trainingOnly=True,
        historicalRepresentationsUsedOnlyForInitialReadout=True,currentGuardRefreshesAllObjects=True))
    # Small review packages retain the exact three source routes for each old
    # training anchor, while the full package also keeps every parent original.
    for item in resume['anchors']:
        for rid in item['mathRecordIds']:
            paths=list((previous/'responses').glob(rid+'-scored.json'))
            if not paths:paths=list((previous/'parent-iteration-originals').rglob(rid+'-scored.json'))
            require(paths,'Source training route original missing: '+rid)
            matched=[p for p in paths if read(p).get('task')==item['task']]
            require(matched,'Source route task differs')
            write_once(args.out/'source-training-routes'/(item['task']['id']+'-'+rid+'.json'),read(matched[0]))
    write_once(args.out/'zip-label-questions.json',plan);write_once(args.out/'roots.json',roots)
    write_once(args.out/'protocol.json',dict(protocol=PROTOCOL,metacognitiveRound=round_number,
        factProtocol=FACT_PROTOCOL,metaProtocol=META_PROTOCOL,transactionGuardProtocol=GUARD_PROTOCOL,
        newTrainingObjects=2,heldoutObjects=4,oldTrainingReplayObjects=8,freshGuardObjects=10,
        generationCap=GENERATION_CAP,featureForwardBatchCap=FEATURE_BATCH_CAP,tokensPerGeneration=96,
        sourceSelectedByHeldout=False,teacherCalls=0,baseFrozen=True,mathematicalWriterFrozen=True,
        questionAndPlanAuthoredByStudent=True,quantitativeClaimsCheckedAgainstOriginalMetrics=True,
        positiveUnknownProseCredit=False,semanticAndMetadataGuardedTogether=True,
        fullRoutesHostScheduled=True,metaTrainingCreditCausallyIsolated=False,
        oldScoresChanged=False,newStandaloneMathematicalRules=0,heldoutUpdates=0,
        historyFreshness=freshness,newStageSeconds=900,totalSeconds=1200))
    deadline=time.monotonic()+max(0.,float(os.environ.get('ZIP_LABEL_META_DEADLINE',str(time.time()+1200)))-time.time())
    calls=feature_calls=0;raw=[];scored=[];objects=[];updates=[];versions=[];decisions=[];trials=[]
    base=mathematical=semantic=None;base_before=math_before=None
    base_after=math_after=semantic_after=None;known_semantic_hash=None;writer_mode='learning'
    before_state=learning_state=committed_state=None;semantic_before=None;word_attempts=0
    live_head_state=head_state;live_labels=initial_labels;live_meta=initial_meta;before_heldout_hash=None
    source_ok=protected_ok=tools_ok=resume_ok=None;heldout_ok=None;course={};stop='completed';error=None

    def save(kind,row):
        path=(args.out/'responses'/(row['recordId']+'-'+kind+'.json') if kind in ('raw','scored') else
            args.out/kind/(row['id']+'.json'))
        write_once(path,row)
        collection={'raw':raw,'scored':scored,'object':objects,'update':updates,
            'label-version':versions,'decision':decisions,'trial':trials}.get(kind)
        if collection is not None:collection.append(copy.deepcopy(row))
        progress.mark(rawResponsesSaved=len(raw),scoredResponses=len(scored),featureForwardBatches=feature_calls,
            completeNewObjects=len(objects),semanticUpdates=sum(bool(u.get('semanticUpdate',{}).get('parameterChanged')) for u in updates),
            choiceHeadUpdates=int(bool(course.get('transaction',{}).get('accepted'))),generationAttempts=calls,inFlight=None)

    def timeout(signum,frame):raise TimeoutError('v6 time budget reached')
    old_term=signal.signal(signal.SIGTERM,timeout);old_alarm=signal.signal(signal.SIGALRM,timeout)
    signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
    try:
        progress.mark('加载原学生；数学与基础权重冻结；自我提问只读训练指标')
        import torch
        from safetensors.torch import load_file,save_file
        from zip_pilot import load_student
        from zip_pilot_model import state_digest
        from math_writer_adapter import MathWriterAdapter
        from zip_generation_policy import generate_response
        base,tokenizer,metadata=load_student(args.student,'cpu')
        require(metadata['snapshotSha256']==checked['identity']['snapshotSha256'],'Student snapshot differs')
        base_before=state_digest(base);require(base_before==resume['result']['baseStateBefore'],'Base state differs')
        mathematical=MathWriterAdapter(base,rank=8,last_layers=4,alpha=16)
        mathematical.restore(load_file(str(checked['writer'])));math_before=mathematical.digest()
        require(math_before==checked['checkpoint']['writerStateHash'],'Math writer differs')
        semantic=MathWriterAdapter(base,rank=8,last_layers=4,alpha=16)
        semantic.restore(load_file(str(previous/'checkpoints'/resume['final']['semanticFile'])))
        require(semantic.digest()==resume['final']['semanticStateHash'],'Semantic checkpoint differs')
        base.eval().requires_grad_(False);mathematical.eval();semantic.eval()
        for p in mathematical.parameters_to_train():p.requires_grad_(False);p.grad=None
        for p in semantic.parameters_to_train():p.requires_grad_(True);p.grad=None
        before_state=semantic.learned_state();learning_state=semantic.learned_state();committed_state=semantic.learned_state()
        semantic_before=semantic.digest();known_semantic_hash=semantic_before
        optimizer=torch.optim.SGD(semantic.parameters_to_train(),lr=.001)
        write_once(args.out/'observed-model-identity.json',dict(snapshotSha256=metadata['snapshotSha256'],
            baseStateHash=base_before,mathematicalWriterStateHash=math_before,semanticInitialStateHash=semantic_before,
            modelType=getattr(base.config,'model_type',None),device='cpu'))

        def frozen():
            require(mathematical.enabled is True and semantic.enabled is True and
                mathematical.digest()==math_before and not base.training and
                not mathematical.training and not semantic.training and
                all(not p.requires_grad and p.grad is None for p in list(base.parameters())+
                    mathematical.parameters_to_train()),'Original mathematical/base state changed')
            require(semantic.digest()==known_semantic_hash,'Semantic state changed outside recorded training/load')

        def ask(phase,prompt,seed,*,mode,sampled=False,**context):
            nonlocal calls
            require(calls<GENERATION_CAP,'Text generation cap reached')
            if time.monotonic()>=deadline:raise TimeoutError('Text stage budget reached')
            frozen();calls+=1;begin=time.monotonic()
            progress.mark('文字生成 '+str(calls)+'/76：'+phase,generationAttempts=calls,
                          inFlight=dict(kind='text',number=calls,phase=phase))
            with mathematical.active(mode=='math'),semantic.active(mode in ('semantic','meta')):
                generator=generate_response if mode=='math' else generate_meta if mode=='meta' else generate_note
                value=generator(base,tokenizer,prompt,TOKENS,seed,sampled=sampled,
                    temperature=.8 if sampled else 1.,
                    **({'language_protocol':NATURAL_LANGUAGE} if mode=='semantic' else {}))
                value.update(mathAdapterEnabledDuringGeneration=mathematical.enabled,
                    semanticAdapterEnabledDuringGeneration=semantic.enabled,
                    semanticStateHashDuringGeneration=semantic.digest(),semanticWriterMode=writer_mode,
                    generationRoute='frozen_math' if mode=='math' else 'student_semantic_writer')
            row=dict(recordId='meta-call-'+str(calls).zfill(2),phase=phase,
                studentPrompt=copy.deepcopy(prompt),studentOutput=value,samplingSeed=seed,
                requestedMathAdapterEnabled=mode=='math',fixtureOnly=False,
                generationSeconds=time.monotonic()-begin,**context)
            save('raw',row);frozen()
            require(not value.get('testDouble') and 0<len(value['generatedIds'])<=TOKENS,
                    'Generation provenance or token count differs')
            return row

        def features(task,keywords,candidates):
            nonlocal feature_calls
            require(feature_calls<FEATURE_BATCH_CAP,'Feature batch cap reached')
            if time.monotonic()>=deadline:raise TimeoutError('Feature stage budget reached')
            frozen();feature_calls+=1;begin=time.monotonic()
            prompts=[feature_messages(task,keywords['studentOutput'],c) for c in candidates]
            sequences=[tokenizer(tokenizer.apply_chat_template(p,tokenize=False,add_generation_prompt=True),
                add_special_tokens=False)['input_ids'] for p in prompts]
            require(all(0<len(s)<=2048 for s in sequences),'Feature prompt too long; no truncation')
            pad=tokenizer.pad_token_id if tokenizer.pad_token_id is not None else tokenizer.eos_token_id
            require(isinstance(pad,int),'No padding token')
            length=max(map(len,sequences))
            ids=torch.tensor([s+[pad]*(length-len(s)) for s in sequences],dtype=torch.long)
            masks=torch.tensor([[1]*len(s)+[0]*(length-len(s)) for s in sequences],dtype=torch.long)
            progress.mark('冻结特征前向 '+str(feature_calls)+'/50，三个候选',
                inFlight=dict(kind='feature',number=feature_calls))
            with mathematical.active(False),semantic.active(False),torch.no_grad():
                hidden=base.model(input_ids=ids,attention_mask=masks,use_cache=False,return_dict=True).last_hidden_state
                vectors=[hidden[i,len(s)-1].detach().float().cpu().tolist() for i,s in enumerate(sequences)]
            row=dict(id='meta-feature-'+str(feature_calls).zfill(2),task=copy.deepcopy(task),
                sourceKeywordRecordId=keywords['recordId'],candidateCards=copy.deepcopy(candidates),
                candidatePrompts=prompts,promptIds=sequences,candidateOrder=[c['id'] for c in candidates],
                candidateHiddenVectors=vectors,normalizedFeatures=normalized_features(vectors),featureSeconds=time.monotonic()-begin,
                mathematicalAdapterEnabled=False,semanticAdapterEnabled=False)
            save('feature',row);frozen()
            return row['normalizedFeatures'],row['id']

        def learn_words(rows,advantages,phase):
            nonlocal word_attempts,learning_state,known_semantic_hash
            require(writer_mode=='learning' and word_attempts<2,'Word update schedule differs')
            require(all(r['studentOutput']['sampled'] is True and
                r['studentOutput']['semanticStateHashDuringGeneration']==semantic_before for r in rows),
                'Words came from another sampled policy')
            require((phase=='normal-words' and len(rows)==6 and word_attempts==0) or
                (phase=='self-question' and len(rows)==1 and word_attempts==1),'Separate credit trajectories differ')
            word_attempts+=1;before=semantic.digest()
            progress.mark('学生写作更新：'+phase+'；未知描述不给正奖励')
            with mathematical.active(False),semantic.active(True):
                update=update_words(base,semantic,optimizer,[r['studentOutput'] for r in rows],advantages,len(rows)*96)
            for p in semantic.parameters_to_train():p.grad=None
            learning_state=semantic.learned_state();known_semantic_hash=semantic.digest()
            update.update(beforeHash=before,afterHash=known_semantic_hash,sourceWordRecordIds=[r['recordId'] for r in rows],
                advantages=list(advantages),targetTokensProvided=False,phase=phase,onlySemanticAdapterUpdated=True)
            frozen();return update

        def select_writer(mode):
            nonlocal writer_mode,known_semantic_hash
            require(mode in ('learning','before'),'Unknown writer mode')
            if mode!=writer_mode:
                semantic.restore(before_state if mode=='before' else learning_state)
                writer_mode=mode;known_semantic_hash=semantic.digest()
            frozen()

        def snapshot_words():
            frozen();return semantic.learned_state()

        def restore_words(state):
            nonlocal learning_state,writer_mode,known_semantic_hash
            semantic.restore(state);learning_state=semantic.learned_state();writer_mode='learning'
            known_semantic_hash=semantic.digest();optimizer.zero_grad(set_to_none=True);frozen()

        def checkpoint(label,head,bank,reward_baseline,meta):
            nonlocal live_head_state,live_labels,live_meta,committed_state,before_heldout_hash
            require(writer_mode=='learning','Checkpoint must save learned writer');frozen()
            folder=args.out/'checkpoints';folder.mkdir(exist_ok=True);file=label+'.safetensors';path=folder/file
            require(not path.exists(),'Checkpoint would overwrite original');save_file(semantic.learned_state(),str(path))
            row=dict(protocol=PROTOCOL,label=label,head=copy.deepcopy(head),labels=copy.deepcopy(bank),metaZip=copy.deepcopy(meta),
                baselinePass=reward_baseline,semanticFile=file,semanticFileSha256=sha(path),semanticStateHash=semantic.digest(),
                mathematicalWriterStateHash=math_before,optimizer='SGD without momentum',semanticLearningRate=.001)
            write_once(folder/(label+'.json'),row)
            if label in ('initial','training-final','final'):
                live_head_state=copy.deepcopy(head);live_labels=copy.deepcopy(bank);live_meta=copy.deepcopy(meta)
                committed_state=semantic.learned_state()
            if label=='training-final':before_heldout_hash=semantic.digest()

        for number,old in enumerate(checked['anchors'],1):
            row=ask('cold_replay',old['studentPrompt'],old['samplingSeed'],mode='math',sampled=False,
                task=old['task'],coldNumber=number,sourceRecordId=old['recordId'])
            match=exact_reproduction(old['studentOutput'],row['studentOutput'])
            save('scored',dict(row,check=dict(exactReproduction=match)))
            progress.mark(coldReproductions=number if match['exact'] else number-1)
            require(match['exact'],'Old math writer did not reproduce exactly; no new training')
        deadline=min(deadline,time.monotonic()+900);signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
        course=run_course(plan,roots,head_state,initial_labels,resume['anchors'],resume['sourceFrame'],
            ask,features,save,learn_words,select_writer,snapshot_words,restore_words,checkpoint,deadline,
            round_number,baseline,initial_meta)
        heldout_ok=(semantic.digest()==before_heldout_hash and live_head_state==course['finalHead'] and
            live_labels==course['finalLabels'] and live_meta==course['finalMetaZip'])
        require(heldout_ok,'Heldout changed learned state')
    except Exception as exc:
        stop='time_budget' if isinstance(exc,TimeoutError) else 'error';error=type(exc).__name__+': '+str(exc)
        write_once(args.out/'error.json',dict(error=error,traceback=traceback.format_exc(),
            textGenerationAttempts=calls,wordUpdateAttempts=word_attempts))
        print('已停止：'+error,flush=True)
    finally:
        signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,old_alarm);signal.signal(signal.SIGTERM,old_term)
        if semantic is not None:
            try:
                # Retain interrupted candidate, then restore the last committed
                # atomic transaction. Partial candidates never become active.
                save_file(semantic.learned_state(),str(args.out/'interrupted-installed-semantic.safetensors'))
                if committed_state is not None:semantic.restore(committed_state)
                semantic_after=semantic.digest()
                save_file(semantic.learned_state(),str(args.out/'committed-semantic-final.safetensors'))
            except Exception as exc:error=(error+'; ' if error else '')+str(exc);stop='error'
        try:
            base_after=state_digest(base) if base is not None else None
            math_after=mathematical.digest() if mathematical is not None else None
            source_ok=snapshot(args.source)==checked['inspection']['sourceFileHashes']
            protected_ok=all(sha(Path(p))==h for p,h in checked['protected'].items())
            tools_ok=snapshot(args.old_tools.resolve())==checked['toolFiles']
            resume_ok=snapshot(previous)==resume['sourceHashes']
            require(source_ok and protected_ok and tools_ok and resume_ok,'Protected originals changed')
            if base_before is not None:require(base_before==base_after,'Frozen base changed')
            if math_before is not None:require(math_before==math_after,'Frozen math writer changed')
        except Exception as exc:error=(error+'; ' if error else '')+str(exc);stop='error'
        for adapter in (semantic,mathematical):
            if adapter is not None:adapter.close()
    committed=bool(course.get('transaction',{}).get('accepted'))
    final_head=course.get('finalHead',live_head_state);final_labels=course.get('finalLabels',live_labels)
    write_once(args.out/'zip-label-bank.json',dict(protocol=PROTOCOL,mathematicalRoots=roots,
        initialLabels=initial_labels,activeLabels=final_labels,activeMetacognitiveZip=course.get('finalMetaZip',live_meta),
        savedSelfReviewZip=course.get('selfReviewZip'),allDescriptionVersions=versions,newStandaloneMathematicalRules=0,
        noWholePlanOrProseTruthCertificate=True,mathematicalRootsUnchanged=True))
    result=dict(protocol=PROTOCOL,metacognitiveRound=round_number,stopReason=stop,error=error,
        fixtureOnly=False,fixtureGenerations=0,teacherCalls=0,actualStudentGenerations=len(raw),generationAttempts=calls,
        rawResponsesSaved=len(raw),scoredResponses=len(scored),rawResponsesWithoutCompletedAudit=len(raw)-len(scored),
        featureForwardBatches=feature_calls,completeNewObjects=len(objects),
        completedTrainingObjects=sum(o['phase']=='training' for o in objects),
        completedHeldoutObjects=sum(o['phase']=='heldout' for o in objects),
        coldReproductions=sum(r['phase']=='cold_replay' and r['check']['exactReproduction']['exact'] for r in scored),
        semanticUpdateAttempts=word_attempts,attemptedSemanticParameterUpdates=sum(bool(u.get('semanticUpdate',{}).get('parameterChanged')) for u in updates),
        committedSemanticParameterUpdates=sum(bool(u.get('semanticUpdate',{}).get('parameterChanged')) for u in updates) if committed else 0,
        choiceHeadTrainingUpdates=int(committed and final_head['weights']!=head_state['weights']),
        atomicTransactionAccepted=committed,rollbackRecorded=(args.out/'transaction/atomic-training-transaction.json').is_file() and not committed,
        newZipLabelRevisions=len(versions),eligibleLabelProposals=sum(v['eligibleForMeasuredTrial'] for v in versions),
        activatedLabelRevisions=sum(v.get('committedAsRetrievalMetadata',False) and v.get('sourceRecordId') in
            {r['recordId'] for r in raw} for v in final_labels.values()),
        semanticStateBefore=semantic_before,semanticStateAfter=semantic_after,
        semanticWriterParametersChanged=semantic_before is not None and semantic_after!=semantic_before,
        baseStateBefore=base_before,baseStateAfter=base_after,baseWeightsUnchanged=base_before is not None and base_before==base_after,
        mathematicalWriterStateHash=math_before,mathematicalWriterStateAfter=math_after,
        mathematicalWriterUnchanged=math_before is not None and math_before==math_after,
        originalFilesUnchanged=source_ok and protected_ok and tools_ok and resume_ok,
        heldoutLearnedStateUnchanged=heldout_ok,heldoutTrainingUpdates=0,
        finalChoiceHead=final_head,newStandaloneMathematicalRules=0,oldArchiveScoresChanged=False,
        generatedTokens=sum(r['studentOutput']['generatedTokens'] for r in raw),
        summary=summarize(objects,trials),elapsedSeconds=time.monotonic()-started,
        realStudentBenefitProved=False,metacognitionOperationalizedAsSelfMonitoringAndTestedHypotheses=True)
    write_once(args.out/'result.json',result)
    lines=['# 学生自我提问与ZIP反馈 v6','',
        '学生选择指标、提出问题和计划；程序核对数值。问题和计划仍是待检验假设。',
        '状态：'+stop+'；事务接纳：'+str(committed)+'；老师调用：0。',
        '训练：2道新题＋8道旧训练题刷新复验；4道保留题不反馈。旧评分和数学权重冻结。',
        '训练指标变化含写作、标签、选择头和自我提问的共同作用，不能单独归因给计划。','',
        '```json',json.dumps(result['summary'],ensure_ascii=False,indent=2),'```','']
    for row in raw:
        if not row['requestedMathAdapterEnabled']:
            lines+=['## '+row['recordId']+' '+row['phase'],'','```text',row['studentOutput']['raw'],'```','']
    (args.out/'Lain-Zip-Metacognitive-Review.md').write_text('\n'.join(lines),encoding='utf-8')
    full=args.out/'Lain-Zip-Metacognitive-Results.zip';small=args.out/'Lain-Zip-Metacognitive-Review.zip'
    paths=[p for p in sorted(args.out.rglob('*')) if p.is_file() and p.suffix!='.zip']
    for path,is_small in ((full,False),(small,True)):
        with zipfile.ZipFile(path,'x',zipfile.ZIP_DEFLATED) as z:
            for p in paths:
                rel=p.relative_to(args.out)
                if is_small and (rel.parts[0]=='parent-iteration-originals' or p.suffix=='.safetensors'):continue
                z.write(p,rel)
    print('冻结新题摘要：'+json.dumps(result['summary'],ensure_ascii=False),flush=True)
    print('完整性：'+json.dumps({k:result[k] for k in ('stopReason','error','actualStudentGenerations',
        'featureForwardBatches','committedSemanticParameterUpdates','choiceHeadTrainingUpdates',
        'atomicTransactionAccepted','activatedLabelRevisions','baseWeightsUnchanged','mathematicalWriterUnchanged',
        'heldoutLearnedStateUnchanged','originalFilesUnchanged','teacherCalls')},ensure_ascii=False),flush=True)
    print('完整结果：'+str(full),flush=True);print('小审阅包：'+str(small),flush=True)
    return 0 if stop=='completed' else 1

def main():
    p=argparse.ArgumentParser()
    for name in ('source','work','student','old-tools','out'):p.add_argument('--'+name,type=Path)
    p.add_argument('--inspect-only',action='store_true');args=p.parse_args()
    require(args.source is not None,'Source required')
    if args.inspect_only:
        source=inspect_source(args.source)
        print(json.dumps(dict(protocol=source['result']['protocol'],sourceTrainingAnchors=len(source['anchors']),
            sourceHeadUpdates=source['final']['head']['updates'],sourceMetricFrame=source['sourceFrame'],
            studentCalls=0,teacherCalls=0,trainingUpdates=0,modelNotLoaded=True),ensure_ascii=False));return 0
    require(all(getattr(args,k) is not None for k in ('work','student','old_tools','out')),'Original runtime paths required')
    return run(args)

if __name__=='__main__':raise SystemExit(main())
