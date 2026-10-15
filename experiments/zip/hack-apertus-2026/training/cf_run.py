"""Frozen protocol, two learning phases, transactional resume and once-only fresh audit."""
import argparse
import fcntl
import signal
import time
import traceback
from rr_common import *
from rr_run import replay_exact
from cf_cases import *
from cf_sources import admit
from cf_backend import Backend
from cf_policy import expected_update,editor_update
from cf_store import commits,publish,partial
from cf_episodes import episode,training_rows,evaluate,summarize
from cf_memory import proposal_audit


def hashes(b):
    return dict(meta=b.actor.digest(),meta_control=b.control.digest(),editor=b.editor.digest(),editor_control=b.editor_control.digest())


def checkpoint_save(b,folder):
    import torch
    from safetensors.torch import save_file
    for name,module in [('meta',b.actor),('meta-control',b.control),('editor',b.editor),('editor-control',b.editor_control)]:
        save_file(module.learned_state(),str(folder/(name+'.safetensors')))
    torch.save(b.optimizer.state_dict(),folder/'meta-optimizer.pt')
    torch.save(b.editor_optimizer.state_dict(),folder/'editor-optimizer.pt')


def checkpoint_restore(b,folder):
    import torch
    from safetensors.torch import load_file
    for name,module in [('meta',b.actor),('meta-control',b.control),('editor',b.editor),('editor-control',b.editor_control)]:
        module.restore(load_file(str(folder/(name+'.safetensors'))))
    b.optimizer.load_state_dict(torch.load(folder/'meta-optimizer.pt',map_location='cpu',weights_only=True))
    b.editor_optimizer.load_state_dict(torch.load(folder/'editor-optimizer.pt',map_location='cpu',weights_only=True))


def write_read_first(out,result):
    text='v24 条件化反例学习：先看闭环，最后检查自由反思原文\n\n'
    text+='这是受约束符号工具选择 + 学生自由写新公式。不是无提示、自发寻找反例。\n'
    text+='真实435旧错卡明确进入TRAIN；它的改善是定向学习证据。全新规则排除v23与v24已见规则，不能声称预训练从未见过。\n'
    text+='KEEP表示本接口未提交撤回，不代表学生不知道错误；同号不等于相等。\n'
    text+='新版正式规则只接收学生单次写出的正确简式；自由反思保留原文，不自动认证语义。\n\n'
    text+=json.dumps(result['summary'],ensure_ascii=False,indent=2)+'\n\n'
    for r in result['rows']:
        if r['collection']=='sourceReadback' and r['arm']=='rewarded':
            text+=r['card']['left']+' = '+r['card']['right']+'\n'+json.dumps(r['props'],ensure_ascii=False)+'\n'
            text+='动作：'+r['beforeAction']+' → '+r['afterAction']+'；候选闭环：'+str(r['fullLoopCandidate'])+'\n'
            text+='新公式原文：'+r.get('proposal',{}).get('raw','未写')+'\n'
            text+='自由反思原文：\n'+r.get('ownReflection',{}).get('raw','该控制仅测动作')+'\n\n'
    (Path(out)/'READ_FIRST.txt').write_text(text,encoding='utf-8')


def run(args):
    start=time.monotonic();end=start+args.seconds;training_end=end-min(1800,args.seconds*.35)
    source=args.source.resolve();out=args.out.resolve();backend=None;lock=None;owns=False;protected={}
    require(60<=args.seconds<=10800,'Bounded compute time 60..10800 seconds')
    for path in (source,args.student.resolve(),args.old_tools.resolve()):
        require(not out.is_relative_to(path) and not path.is_relative_to(out),'Output overlaps protected input')
    if out.exists():require((out/'protocol.json').is_file() and read(out/'protocol.json')['protocol']==PROTOCOL,'Unrecognized output directory')
    def interrupt(*_):raise InterruptedError('Notebook interrupted; already committed steps will be reused')
    handlers={s:signal.getsignal(s) for s in (signal.SIGINT,signal.SIGTERM)}
    for s in handlers:signal.signal(s,interrupt)
    def mark(stage):
        live=dict(pid=os.getpid(),stage=stage,elapsedSeconds=time.monotonic()-start,
            committedSteps=len(list((out/'committed').glob('step-*'))),
            decisions=len(list((out/'decisions').glob('*.json'))),raws=len(list((out/'responses').glob('*.json'))))
        if args.live:atomic_json(args.live,live)
        print('[条件学习阶段] '+stage,flush=True)
    try:
        mark('核验e1828281真实最后反思检查点与旧笔记原文')
        admitted=admit(source);protected=admitted['protected']
        out.mkdir(parents=True,exist_ok=True);lock=(out/'experiment.lock').open('a')
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);owns=True
        except BlockingIOError:raise RuntimeError('Another process is already running this experiment; no duplicate update started')
        if (out/'plan.json').is_file():
            p=read(out/'plan.json');validate_plan(p);protocol=read(out/'protocol.json')
            require(protocol['payloadSha256']==args.payload and protocol['source']==str(source) and protocol['planHash']==p['planHash'],'Resume source or code changed')
            recipe=p['recipe'];require(recipe['metaSteps']==args.meta_steps and recipe['editorSteps']==args.editor_steps and
                recipe['learningRate']==args.meta_lr and recipe['editorLearningRate']==args.editor_lr and recipe['quick']==args.quick,'Resume recipe changed')
        else:
            p=make_plan(admitted['cards'],admitted['previousPlan'],args.meta_steps,args.editor_steps,args.quick,args.meta_lr,args.editor_lr)
            put_once(out/'plan.json',p)
            put_once(out/'protocol.json',dict(protocol=PROTOCOL,source=str(source),payloadSha256=args.payload,
                planHash=p['planHash'],recipe=p['recipe'],createdAt=time.time(),fixtureOnly=bool(getattr(Backend,'is_fixture',False))))
        for rid,r in admitted['sourceRecords'].items():put_once(out/'source-records'/(rid+'.json'),r)
        base_binding=dict(protocol=PROTOCOL,source=str(source),payloadSha256=args.payload,planHash=p['planHash'],
            protectedFiles=protected,priorReflectionHash=admitted['priorHash'],baseHash=admitted['binding']['initialBaseHash'],
            oldWriterHash=admitted['deployment']['writerHash'],oldRepairHash=admitted['deployment']['repairHash'],
            fixtureOnly=bool(getattr(Backend,'is_fixture',False)))
        mark('加载一个学生；冻结旧数学、旧纠错及64步反思；建立两组独立参数')
        backend=Backend(args,admitted,p,out,base_binding);backend.set_phase('evaluation')
        binding=dict(base_binding,initialHashes=hashes(backend),
            initialMetaFileHash=sha(out/'initial-reflection.safetensors'),initialEditorFileHash=sha(out/'initial-editor.safetensors'))
        backend.binding=binding;put_once(out/'source-checkpoint.json',binding)
        def budget():require(time.monotonic()<end-90,'Compute budget reached; resume durable state')
        backend.before_call=budget
        cold=admitted['coldRecord']
        r=backend.ask('historical_cold_replay',p['sourceReadback'][0],cold['studentPrompt'],kind='cold',
            seed=cold['binding']['seed'],max_tokens=96)
        require(replay_exact(cold['studentOutput'],r['studentOutput']),'Historical raw cold replay changed; stopped before new training')
        tail=commits(out,binding);count=len(tail)
        if tail:
            checkpoint_restore(backend,tail[-1][0]);require(hashes(backend)==tail[-1][1]['afterHashes'],'Restored checkpoint hashes differ')
        initial_path=out/'initial-source-audit.json'
        if initial_path.is_file():check_seal(read(initial_path))
        else:
            require(count==0,'Missing initial audit cannot be retroactively created after training')
            initial=evaluate(backend,p,out,'initial',collections=('sourceReadback',),mark=mark)
            put_once(initial_path,sealed(dict(rows=initial,summary=summarize(initial),chosenBeforeNewUpdates=True,
                fixtureOnly=binding['fixtureOnly'])))
        errors=[c for c in p['training'] if ideal_action(c)=='RETRACT']
        protects=[c for c in p['training'] if ideal_action(c)=='KEEP']
        target=next(c for c in errors if c['card']['provenance']['kind']=='student_saved_zip')
        while count<args.meta_steps:
            require(time.monotonic()<training_end,'Training budget reached; resume before final audit')
            backend.set_phase('meta');ordinal=count+1;before=hashes(backend)
            batch=[focused_case(count,errors,target,p['recipe']['targetMetaEvery']),protects[count%len(protects)]]
            mark('亲算符号和条件化撤回奖励 '+str(ordinal)+'/'+str(args.meta_steps))
            rows={};tables={};contexts={}
            for arm in ('zero_reward','rewarded'):
                rows[arm]=[];tables[arm]=[];contexts[arm]=[]
                for c in batch:
                    e=episode(backend,c,'meta_train_'+str(ordinal),arm)
                    rs,ts,cs=training_rows(c,e);rows[arm]+=rs;tables[arm]+=ts;contexts[arm]+=cs
            feedback=sealed(dict(contexts=contexts,phase='meta',trainingOnly=True,observationsAreStudentChoices=True,
                goldResultsEnteredPrompts=False,fullLegalActionReturnsAreProgramSupervision=True))
            put_once(out/'train-feedback'/('step-'+str(ordinal).zfill(4)+'.json'),feedback)
            cu=expected_update(backend.base,backend.control,backend.control_optimizer,rows['zero_reward'],tables['zero_reward'],
                lambda:backend.mode('zero_reward'),backend.fixed_modules('meta'),zero=True)
            ru=expected_update(backend.base,backend.actor,backend.optimizer,rows['rewarded'],tables['rewarded'],
                lambda:backend.mode('rewarded'),backend.fixed_modules('meta'))
            publish(out,ordinal,binding,'meta',before,hashes(backend),ru,cu,feedback,lambda folder:checkpoint_save(backend,folder));count+=1
        while count<args.meta_steps+args.editor_steps:
            require(time.monotonic()<training_end,'Training budget reached; resume before final audit')
            backend.set_phase('editor');step=count-args.meta_steps;ordinal=count+1;before=hashes(backend)
            c=focused_case(step,errors,target,p['recipe']['targetEditorEvery'])
            mark('实际新公式奖励 '+str(step+1)+'/'+str(args.editor_steps))
            anchor=episode(backend,c,'editor_anchor_'+str(step+1),'rewarded')
            eligible=grounded(c,anchor['props']) and anchor['after']['action']=='RETRACT'
            rows={};rewards={};audits={}
            for arm in ('zero_reward','rewarded'):
                rows[arm]=[];rewards[arm]=[];audits[arm]=[]
                if eligible:
                    for j in range(2):
                        r=backend.ask('editor_train_'+str(step+1)+'_'+str(j),c,
                            repair_prompt(c,anchor['props'],anchor['after']['action']),arm,kind='editor',
                            seed=240000000+(step+1)*10+j,sampled=True)
                        a=proposal_audit(c,r);rows[arm].append(r);rewards[arm].append(a['reward']);audits[arm].append(a)
            feedback=sealed(dict(phase='editor',trainingOnly=True,caseId=c['id'],eligible=eligible,
                actualAnchorDecisionId=anchor['after']['recordId'],actualAnchorProps=anchor['props'],
                sameActualRewardedMetaAnchorGivenToBothEditors=True,zeroMetaOwnWithdrawalNotClaimed=True,
                audits=audits,teacherReplacementSupplied=False))
            put_once(out/'train-feedback'/('step-'+str(ordinal).zfill(4)+'.json'),feedback)
            cu=editor_update(backend.base,backend.editor_control,backend.editor_control_optimizer,rows['zero_reward'],rewards['zero_reward'],
                lambda:backend.mode('zero_reward','editor'),backend.fixed_modules('editor'),zero=True)
            ru=editor_update(backend.base,backend.editor,backend.editor_optimizer,rows['rewarded'],rewards['rewarded'],
                lambda:backend.mode('rewarded','editor'),backend.fixed_modules('editor'))
            publish(out,ordinal,binding,'editor',before,hashes(backend),ru,cu,feedback,lambda folder:checkpoint_save(backend,folder));count+=1
        backend.set_phase('evaluation');terminal=dict(hashes=hashes(backend),steps=count,chosenBeforeFreshScores=True,sourceBindingHash=digest(binding))
        put_once(out/'frozen-evaluation-checkpoint.json',terminal)
        rows=evaluate(backend,p,out,mark=mark)
        require(backend.frozen_integrity() and hashes(backend)==terminal['hashes'],'Evaluation mutated weights')
        require(all(sha(path)==h for path,h in protected.items()),'Protected source changed')
        tail=commits(out,binding)
        candidates=[]
        for r in rows:
            if r['arm']!='rewarded' or r['kind']!='counterexample':continue
            zero=next(x for x in rows if x['arm']=='zero_reward' and x['caseId']==r['caseId'])
            candidates.append(dict(caseId=r['caseId'],sourceKind=r['card']['provenance']['kind'],
                collection=r['collection'],fullLoopCandidate=r['fullLoopCandidate'],
                rewardSpecificClosedLoop=r['fullLoopCandidate'] and not zero['fullLoopCandidate'],
                memoryBenefitLoopCandidate=r.get('memoryBenefitLoopCandidate',False),
                oldWrongToNewCorrect=r['oldWrongToNewCorrect'],newNoteGainOverNoNote=r['newNoteGainOverNoNote'],
                nearTransferCorrect=r['nearTransfer']['audit']['correctChangedExpression'],
                ownProseSemanticReviewStillRequired=True))
        result=dict(protocol=PROTOCOL,complete=True,fixtureOnly=binding['fixtureOnly'],
            metaCommitted=sum(r['phase']=='meta' for _,r in tail),editorCommitted=sum(r['phase']=='editor' for _,r in tail),
            metaParameterChanges=sum(r['phase']=='meta' and r['rewarded']['parameterChanged'] for _,r in tail),
            editorParameterChanges=sum(r['phase']=='editor' and r['rewarded']['parameterChanged'] for _,r in tail),
            eligibleEditorEpisodes=sum(r['phase']=='editor' and r['feedback']['eligible'] for _,r in tail),
            zeroRewardParameterChanges=sum(r['control']['parameterChanged'] for _,r in tail),
            actualStudentGenerations=len(list((out/'responses').glob('*.json'))),actualDecisionRecords=len(list((out/'decisions').glob('*.json'))),
            summary=summarize(rows),rows=rows,closedLoopCandidates=candidates,lastCheckpoint=terminal,
            oldBaseUpdates=0,oldMathWriterUpdates=0,oldRepairUpdates=0,priorReflectionUpdates=0,heldoutOptimizerUpdates=0,
            target435ExplicitlyTraining=True,propertyToolChoicesConstrained=True,proposalIsStudentFreeText=True,
            correctedNumericalResultsEnteredPrompts=False,teacherReplacementSupplied=False,
            programRewardSupervision=True,formalProposalCheckedExternally=True,freeProseAutomaticallyCertified=False,
            initialAuditUsedToChooseCurriculumOrHyperparameters=False,allPredeclaredCasesReported=True,
            existingPretrainingExposureNotAudited=True,independentTrainingReplications=1,
            spontaneousSearchClaimed=False,generalRobustnessClaimed=False,statisticalSignificanceClaimed=False,
            elapsedSeconds=time.monotonic()-start)
        atomic_json(out/'result.json',result);write_read_first(out,result);mark('两阶段训练、冻结新题复验、原文和全部笔记版本保存完成');return result
    except (Exception,KeyboardInterrupt) as error:
        result=None
        if owns and (out/'protocol.json').is_file():
            result=partial(out,type(error).__name__+': '+str(error),bool(getattr(Backend,'is_fixture',False)))
            atomic_json(out/'error.json',dict(type=type(error).__name__,message=str(error),traceback=traceback.format_exc()))
        if isinstance(error,(InterruptedError,KeyboardInterrupt)) or 'budget' in str(error).lower():return result
        raise
    finally:
        if backend is not None:backend.close()
        if lock is not None:
            if owns:fcntl.flock(lock,fcntl.LOCK_UN)
            lock.close()
        for s,h in handlers.items():signal.signal(s,h)


def main():
    p=argparse.ArgumentParser()
    for name in ('source','out','work','student','old-tools'):p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--payload',required=True);p.add_argument('--live',type=Path);p.add_argument('--quick',action='store_true')
    p.add_argument('--meta-steps',type=int,default=96);p.add_argument('--editor-steps',type=int,default=32)
    p.add_argument('--meta-lr',type=float,default=.0005);p.add_argument('--editor-lr',type=float,default=.0001)
    p.add_argument('--seconds',type=float,default=10800);return run(p.parse_args())


if __name__=='__main__':main()
