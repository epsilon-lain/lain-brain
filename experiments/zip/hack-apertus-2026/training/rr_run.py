"""End-to-end genuine reward training, matched zero-reward control, frozen re-evaluation."""
import argparse
import fcntl
import os
from pathlib import Path
import signal
import time
import traceback
from rr_common import *
from rr_sources import admit
from rr_cases import make_plan,validate_plan,expected,decision_prompt
from rr_backend import Backend
from rr_policy import update
from rr_store import commits,publish,partial
from rr_evaluate import evaluate_choices,evaluate_real_memories,evaluate_student_checks,crow_controls,summarize


def replay_exact(old,new):
    keys=('raw','promptIds','generatedIds','generatedTokens','sampled','temperature',
          'tokenCapReached','mathAdapterEnabledDuringGeneration')
    return all(k in old and k in new and old[k]==new[k] for k in keys)


def run(args):
    start=time.monotonic();end=start+args.seconds;training_end=end-min(1800,args.seconds*.35);evaluation_end=end-120
    source=args.source.resolve();out=args.out.resolve();notes_source=args.notes_source.resolve()
    for folder in (source,notes_source,args.student.resolve(),args.old_tools.resolve()):
        require(not out.is_relative_to(folder) and not folder.is_relative_to(out),'Output overlaps protected input')
    if out.exists():require((out/'protocol.json').is_file() and read(out/'protocol.json')['protocol']==PROTOCOL,'Unrecognized output directory')
    backend=None;lock=None;owns_lock=False;protected={};result=None
    def interrupted(*_):
        signal.signal(signal.SIGTERM,signal.SIG_IGN);signal.signal(signal.SIGINT,signal.SIG_IGN)
        raise InterruptedError('Notebook/parent interrupted; durable steps will be reused')
    handlers={s:signal.getsignal(s) for s in (signal.SIGINT,signal.SIGTERM)}
    for s in handlers:signal.signal(s,interrupted)
    def mark(stage,steps=None):
        live=dict(pid=os.getpid(),stage=stage,elapsedSeconds=time.monotonic()-start,
            committedSteps=steps if steps is not None else len(list((out/'committed').glob('step-*'))),
            decisions=len(list((out/'decisions').glob('*.json'))),raws=len(list((out/'responses').glob('*.json'))))
        if args.live:atomic_json(args.live,live)
        print('[反思奖励阶段] '+stage,flush=True)
    try:
        mark('核验真实旧错卡、正确卡、最后数学与纠错检查点')
        admitted=admit(source,notes_source);protected=admitted['protected']
        out.mkdir(parents=True,exist_ok=True)
        lock=(out/'experiment.lock').open('a')
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);owns_lock=True
        except BlockingIOError:raise RuntimeError('Another process is already running this experiment; no duplicate training started')
        if (out/'plan.json').is_file():
            plan=read(out/'plan.json');validate_plan(plan)
            protocol=read(out/'protocol.json')
            require(protocol['payloadSha256']==args.payload and protocol['source']==str(source) and
                protocol['notesSource']==str(notes_source) and protocol['planHash']==plan['planHash'],
                'Resume source, code payload or curriculum changed')
            require(plan['recipe']['steps']==args.steps and plan['recipe']['learningRate']==args.learning_rate and
                plan['recipe']['quick']==args.quick,'Resume recipe changed')
        else:
            plan=make_plan(admitted['cards'],args.steps,args.quick,args.learning_rate)
            out.mkdir(parents=True,exist_ok=True)
            put_once(out/'plan.json',plan)
            put_once(out/'protocol.json',dict(protocol=PROTOCOL,source=str(source),notesSource=str(notes_source),
                payloadSha256=args.payload,planHash=plan['planHash'],createdAt=time.time(),
                fixtureOnly=bool(getattr(Backend,'is_fixture',False)),recipe=plan['recipe']))
        for rid,r in admitted['sourceRecords'].items():put_once(out/'source-records'/(rid+'.json'),r)
        base_binding=dict(protocol=PROTOCOL,source=str(source),notesSource=str(notes_source),
            protectedFiles=protected,baseHash=admitted['binding']['initialBaseHash'],
            oldWriterHash=admitted['deployment']['writerHash'],oldRepairHash=admitted['deployment']['repairHash'],
            payloadSha256=args.payload,planHash=plan['planHash'],fixtureOnly=bool(getattr(Backend,'is_fixture',False)))
        mark('加载一个真实学生；旧权重冻结；建立奖励与零奖励反思 LoRA')
        backend=Backend(args,admitted,plan,out,base_binding)
        binding=dict(base_binding,initialReflectionHash=backend.initial_actor_hash,
            initialControlHash=backend.initial_control_hash,initialReflectionFileHash=sha(out/'initial-reflection.safetensors'))
        backend.binding=binding;put_once(out/'source-checkpoint.json',binding)
        def check_budget():require(time.monotonic()<evaluation_end,'Compute budget reached; resume before continuing')
        backend.before_call=check_budget
        old=admitted['coldRecord'];cold_case=plan['sourceReadback'][0]
        r=backend.ask('historical_cold_replay',cold_case,old['studentPrompt'],math=True,cold=True,
            seed=old['binding']['seed'],max_tokens=96)
        require(replay_exact(old['studentOutput'],r['studentOutput']),'Historical student did not reproduce; stopped before training')
        from safetensors.torch import load_file,save_file
        import torch
        tail=commits(out,binding);count=len(tail)
        if tail:
            directory,receipt=tail[-1]
            backend.actor.restore(load_file(str(directory/'reflection.safetensors')))
            backend.control.restore(load_file(str(directory/'control.safetensors')))
            backend.optimizer.load_state_dict(torch.load(directory/'optimizer.pt',map_location='cpu',weights_only=True))
            require(backend.actor.digest()==receipt['rewarded']['afterReflectionHash'] and
                backend.control.digest()==backend.initial_control_hash,'Restored reflection/control differs')
        errors=[c for c in plan['training'] if expected(c)=='RETRACT']
        protections=[c for c in plan['training'] if expected(c)=='KEEP']
        require(errors and protections,'Both counterexamples and protection controls required')
        while count<args.steps:
            require(time.monotonic()<training_end,'Training budget reached; resume saved steps before evaluation')
            ordinal=count+1;batch=[errors[count%len(errors)],protections[count%len(protections)]]
            mark('奖励／零奖励对照 第 '+str(ordinal)+'/'+str(args.steps)+' 步',count)
            rows={};rewards={}
            for arm in ('zero_reward','rewarded'):
                selected=[];feedback=[]
                for i,c in enumerate(batch):
                    seed=230000000+ordinal*10+i
                    d=backend.choose('train_step_'+str(ordinal),c,decision_prompt(c),arm,seed,
                        sampled=True,epsilon=plan['recipe']['trainExploration'])
                    selected.append(d)
                    # The scalar reward is computed ONLY AFTER the actual choice record is saved.
                    gold=expected(c);reward=1. if d['action']==gold else -1.
                    feedback.append(dict(caseId=c['id'],decisionId=d['recordId'],expectedAction=gold,
                        observedReward=reward,appliedReward=0. if arm=='zero_reward' else reward,
                        feedbackGivenBeforeChoice=False,heldoutUsedForTraining=False))
                rows[arm]=selected;rewards[arm]=[x['observedReward'] for x in feedback]
                put_once(out/'train-feedback'/('step-'+str(ordinal).zfill(4)+'-'+arm+'.json'),sealed(dict(rows=feedback)))
            control_update=update(backend.base,backend.control,backend.writer,backend.repair,backend.control_optimizer,
                rows['zero_reward'],rewards['zero_reward'],lambda:backend.mode('zero_reward'),zero_reward=True)
            rewarded_update=update(backend.base,backend.actor,backend.writer,backend.repair,backend.optimizer,
                rows['rewarded'],rewards['rewarded'],lambda:backend.mode('rewarded'))
            feedback=sealed(dict(rewardedDecisionIds=[r['recordId'] for r in rows['rewarded']],
                zeroRewardDecisionIds=[r['recordId'] for r in rows['zero_reward']],
                trainingOnly=True,sourceResponsesUnmodified=True,teacherCorrectActionTokensProvided=False))
            def save(folder):
                save_file(backend.actor.learned_state(),str(folder/'reflection.safetensors'))
                save_file(backend.control.learned_state(),str(folder/'control.safetensors'))
                torch.save(backend.optimizer.state_dict(),folder/'optimizer.pt')
            publish(out,ordinal,binding,rewarded_update,control_update,feedback,save)
            count+=1
        terminal=dict(steps=count,reflectionHash=backend.actor.digest(),controlHash=backend.control.digest(),
            sourceBindingHash=digest(binding),chosenBeforeHeldoutScores=True)
        put_once(out/'frozen-evaluation-checkpoint.json',terminal)
        for p in backend.actor.parameters_to_train():p.requires_grad_(False);p.grad=None
        mark('冻结最后检查点；评估1道／3道反例与正确规则误撤回',count)
        evaluation=evaluate_choices(backend,plan,out,mark)
        real=evaluate_real_memories(backend,plan,out,mark)
        self_checks=evaluate_student_checks(backend,plan,out,mark)
        crow=crow_controls(backend,plan,out)
        require(backend.frozen_integrity(),'Protected parameter check failed')
        require(all(sha(path)==h for path,h in protected.items()),'Protected source files changed')
        require(backend.actor.digest()==terminal['reflectionHash'],'Weights changed during heldout evaluation')
        tail=commits(out,binding)
        put_once(out/'deployment-reflection.json',dict(protocol=PROTOCOL,reflectionHash=terminal['reflectionHash'],
            reflectionFile=str((out/'committed'/('step-'+str(count).zfill(4))/'reflection.safetensors').resolve()),
            zeroRewardFile=str((out/'committed'/('step-'+str(count).zfill(4))/'control.safetensors').resolve()),
            oldRepairHash=admitted['deployment']['repairHash'],oldRepairFile=str(admitted['repair']),
            oldRepairMustBeEnabled=True,mathWriterDisabledForReflection=True,sourceBindingHash=digest(binding)))
        candidates=[]
        for r in real:
            if r['arm']!='rewarded' or r['card']['knownExactIdentity']:continue
            baseline=next(x for x in real if x['arm']=='zero_reward' and x['caseId']==r['caseId'])
            good_original=next(x for x in real if x['arm']=='rewarded' and x['card']['family']=='correct_identity')
            candidate=(baseline['afterObservationAction']=='KEEP' and r['afterObservationAction']=='RETRACT' and
                not r['activeLookupAfter'] and good_original['afterObservationAction']=='KEEP')
            candidates.append(dict(caseId=r['caseId'],sourceKind=r['card']['provenance']['kind'],
                operationalMemoryRevisionComparedWithZeroReward=candidate,
                newObservationTriggeredActionChange=r['beforeObservationAction']=='KEEP' and r['afterObservationAction']=='RETRACT',
                retractionAlreadyChosenWithoutNewEvidence=r['beforeObservationAction']=='RETRACT',
                mathAnswersAlsoImproved=sum(x['audit']['correctChangedExpression'] for x in r['updatedMath'].values())>
                    sum(x['audit']['correctChangedExpression'] for x in r['baselineMath'].values()),
                ownReflectionSemanticReviewStillRequired=True))
        result=dict(protocol=PROTOCOL,complete=True,fixtureOnly=bool(getattr(backend,'is_fixture',False)),committedReflectionSteps=len(tail),
            rewardedParameterChanges=sum(r['rewarded']['parameterChanged'] for _,r in tail),
            zeroRewardParameterChanges=sum(r['control']['parameterChanged'] for _,r in tail),
            actualDecisionRecords=len(list((out/'decisions').glob('*.json'))),
            actualStudentGenerations=len(list((out/'responses').glob('*.json'))),
            frozenProtectedWeightsUnchanged=True,originalFilesUnchanged=True,
            oldBaseUpdates=0,oldMathWriterUpdates=0,oldRepairUpdates=0,heldoutOptimizerUpdates=0,
            summary=summarize(evaluation),realMemoryRevisions=real,studentComputedChecks=self_checks,crowControls=crow,
            operationalRevisionCandidates=candidates,
            sourceBindingHash=digest(binding),lastCheckpoint=terminal,
            constrainedMemoryActionPolicy=True,freeTextReflectionAutomaticallyCertified=False,
            externalCheckedObservationsUsedForTraining=True,teacherWrittenReplacementNotes=False,
            correctRulesProvidedAsTrainingControls=True,spontaneousAwarenessClaimed=False,
            independentTrainingReplications=1,statisticalSignificanceClaimed=False,
            elapsedSeconds=time.monotonic()-start)
        atomic_json(out/'result.json',result)
        write_read_first(out,result)
        mark('训练、记忆更新、复用、亲算检查与全部原文保存完成',count)
        return result
    except (Exception,KeyboardInterrupt) as error:
        if owns_lock and (out/'protocol.json').is_file():
            result=partial(out,type(error).__name__+': '+str(error),fixture_only=bool(getattr(backend,'is_fixture',False)))
            atomic_json(out/'error.json',dict(type=type(error).__name__,message=str(error),traceback=traceback.format_exc()))
        print('已保存可恢复结果：'+type(error).__name__+': '+str(error),flush=True)
        if isinstance(error,InterruptedError) or 'budget' in str(error).lower():return result
        raise
    finally:
        if backend is not None:backend.close()
        if lock is not None:
            if owns_lock:fcntl.flock(lock,fcntl.LOCK_UN)
            lock.close()
        for s,h in handlers.items():signal.signal(s,h)


def write_read_first(out,result):
    text='反思奖励最终测试：先读结论边界，再读学生原文\n\n'
    text+='实际训练的是 KEEP/RETRACT 记忆动作策略；自由反思另存，没有按文风打分。\n'
    text+='奖励组与零奖励组使用同一学生、同一初始LoRA、同一题库；旧数学和旧纠错均冻结。\n'
    text+='外部已核验观察训练与学生亲算观察测试分别统计。撤回错误ZIP不自动等于数学答案修好。\n\n'
    for collection,views in result['summary'].items():
        text+=collection+'\n'+json.dumps(views,ensure_ascii=False,indent=2)+'\n\n'
    for row in result['realMemoryRevisions']:
        text+=row['arm']+' '+row['card']['left']+' = '+row['card']['right']+'\n'
        text+='无观察动作：'+row['beforeObservationAction']+'；三道观察后：'+row['afterObservationAction']+'\n'
        text+='学生亲写反思：\n'+row['ownReflection']['raw']+'\n\n'
    text+='乌鸦语言对照（不是学生历史数学ZIP的证据）\n'
    for row in result['crowControls']:text+=row['arm']+' '+row['type']+'\n'+row['raw']+'\n\n'
    (Path(out)/'READ_FIRST.txt').write_text(text,encoding='utf-8')


def main():
    parser=argparse.ArgumentParser()
    for name in ('source','notes-source','out','work','student','old-tools'):parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--payload',required=True);parser.add_argument('--live',type=Path)
    parser.add_argument('--steps',type=int,default=64);parser.add_argument('--quick',action='store_true')
    parser.add_argument('--learning-rate',type=float,default=.0003);parser.add_argument('--seconds',type=float,default=7200)
    return run(parser.parse_args())


if __name__=='__main__':main()
