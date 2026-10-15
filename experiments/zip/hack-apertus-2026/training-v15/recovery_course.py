"""Single verified rule per student prompt, paired policy learning and cold tests."""
import ast
import copy
from collections import Counter
import json
import random
import time

from zip_content_core import digest, parse_expression, verify_claim
from zip_guided_helpers import match_pattern, simplified_polynomial_surface
from tool_loop_kernel import object_key, support_step, reuse_check, claim
from tool_loop_course import step_messages as failed_messages

PROTOCOL='lain-zip-single-rule-recovery-v1'
ARMS=('reward-on','reward-off')
KINDS=('combine','distribute')
CONDITIONS=('zip','no_zip','same_rule_text','mismatched_zip')
PAIRS=96
CAP=488
TOKENS=96
TRAIN_SEED=3077100
EVAL_SEED=3078100


def input_bindings(source, tool):
    """Read the problem's syntax only; never instantiate the target expression."""
    pattern=parse_expression(tool['rule']['input'])[1].body
    actual=parse_expression(source)[1].body; bindings={}
    if not match_pattern(pattern,actual,bindings): return None
    return {name:ast.unparse(node) for name,node in bindings.items()}


def messages(task, tool, hint=False, condition='zip'):
    if task['kind']=='combine':
        system=('Rewrite the whole expression once by combining its two like terms. Write one equality only: '
            'the original expression = your rewritten expression. Keep the inner expression unchanged. '
            'Use * and **. No explanation, chains or further expansion. Write SKIP if unsure.')
    else:
        system=('Rewrite the whole product once by distributing it over the sum. Write one equality only: '
            'the original expression = your rewritten expression. Keep each inner term unchanged. '
            'You may leave numeric products unevaluated. Use * and **. No explanation, chains or further steps. Write SKIP if unsure.')
    user=task['question']+'\nAll named variables are independent real numbers.'
    if condition in ('zip','same_rule_text','mismatched_zip'):
        label='Mathematical rule: ' if condition=='same_rule_text' else 'Stored rule: '
        target=tool['rule']['output'] if condition!='mismatched_zip' else '('+tool['rule']['output']+')+1'
        user+='\n'+label+tool['rule']['input']+' = '+target
    elif condition!='no_zip': raise ValueError('Unknown condition')
    if hint:
        if condition!='zip': raise ValueError('Bindings are confined to learning prompts')
        bindings=input_bindings(task['expression'],tool)
        if bindings is None: raise ValueError('Problem does not match the selected source rule')
        user+='\nMatch the input variables: '+', '.join(k+' = '+v for k,v in bindings.items())+'.'
    return [dict(role='system',content=system),dict(role='user',content=user)]


def plans(excluded, roots):
    seen=set(excluded); pools={kind:[] for kind in KINDS}
    # One-variable affine objects first; distribution additionally sees simple
    # symbolic sums, with no computed answers or target templates in the task.
    candidates={
        'combine':[(f'1*(u+{n}) + 2*(u+{n})','affine') for n in range(1,4097)],
        'distribute':[(f'{c}*(u+v)','two_variables') for c in range(2,17)] +
            [(f'{2+n%4}*(u+{n})','affine') for n in range(1,4097)]}
    for kind in KINDS:
        for expression,family in candidates[kind]:
            key=object_key(expression)
            if key in seen: continue
            seen.add(key)
            pools[kind].append(dict(id='recovery-object-'+digest(dict(kind=kind,input=expression))[:16],
                kind=kind,expression=expression,question='Rewrite '+expression+'.',family=family,
                scope='real_polynomial',conditions=[],semanticInputKey=key,
                generator='local bounded input generator; not a public benchmark'))
            if len(pools[kind])==56: break
        if len(pools[kind])!=56: raise ValueError('Insufficient fresh single-rule inputs')
    train=[]; test=[]
    for index in range(48):
        for kind in KINDS: train.append(pools[kind][index])
    for kind in KINDS: test += pools[kind][48:56]
    return train,test


def event(task,response,tool,ledger,commit=False):
    checked=support_step(task['expression'],response,tool,task['kind'])
    key=digest(dict(toolVersion=tool['version'],input=object_key(task['expression']))) if checked.get('toolSupported') else None
    fresh=bool(key and key not in ledger)
    if commit and key: ledger.add(key)
    main=1. if fresh else -.1 if checked['status']=='rejected' else 0.
    bonus=.05 if checked.get('toolSupported') and simplified_polynomial_surface(checked['right']) else 0.
    return dict(check=checked,zipReward=main,answerReward=bonus,totalReward=main+bonus,
        novelTrialApplication=fresh,applicationKey=key,newPrinciplesDiscovered=0,
        historicalNoveltyProved=False,rewardScope='first exactly verified instance in this fresh trial',
        diagnosticRewardIsSeparateFromAppliedPolicyReward=True)


def learn(rows, roots, activate, generate, update, save, checkpoint, pairs=PAIRS, seconds=1200):
    if pairs<16 or pairs>PAIRS or pairs%16: raise ValueError('Use complete alternating blocks')
    ledgers={a:set() for a in ARMS}; stages={k:0 for k in KINDS}; streak={k:0 for k in KINDS}
    blocks={k:[] for k in KINDS}; records=[]; deadline=time.monotonic()+seconds; stop='completed'
    checkpoint(0,ledgers)
    for index,task in enumerate(rows[:pairs]):
        if time.monotonic()>=deadline: stop='learning-time-budget';break
        kind=task['kind'];tool=roots[KINDS.index(kind)];pending=[]
        seed=TRAIN_SEED+index;stage='binding_hint' if stages[kind]==0 else 'rule_only'
        prompt=messages(task,tool,hint=stage=='binding_hint')
        # Obtain both actual outputs before any parameter or novelty mutation.
        for arm in ARMS:
            activate(arm,False)
            output=generate(prompt,TOKENS,seed,sampled=True,temperature=.5)
            raw=dict(task=task,phase='learning',pair=index+1,arm=arm,stage=stage,
                studentPrompt=prompt,studentOutput=output,samplingSeed=seed)
            save('learning-raw',raw)
            verified=event(task,output,tool,ledgers[arm],commit=False)
            scored=dict(raw,event=verified);save('learning-scored',scored);pending.append(scored)
        for item in pending:
            arm=item['arm'];activate(arm,False)
            item['event']=event(task,item['studentOutput'],tool,ledgers[arm],commit=True)
            item['policyUpdate']=update(arm,item['studentOutput'],item['event']['totalReward'])
            save('learning-episode',item);records.append(item)
        on=next(item for item in pending if item['arm']=='reward-on');blocks[kind].append(on)
        if len(blocks[kind])==8:
            correct=sum(r['event']['check'].get('toolSupported',False) for r in blocks[kind])
            passed=correct>=6;streak[kind]=streak[kind]+1 if passed else 0
            promoted=stages[kind]==0 and streak[kind]>=2
            if promoted: stages[kind]=1
            review=dict(kind=kind,throughPair=index+1,stage=stage,questions=8,verified=correct,
                passed=passed,consecutivePassingBlocks=streak[kind],promoted=promoted,
                nextStage='binding_hint' if stages[kind]==0 else 'rule_only')
            save('block',review);blocks[kind]=[]
            print('单规则学习进度：',json.dumps(review,ensure_ascii=False),flush=True)
        if (index+1)%16==0: checkpoint(index+1,ledgers)
    checkpoint(sum(r['arm']=='reward-on' for r in records),ledgers)
    return dict(stopReason=stop,records=records,ledgers=ledgers,stages=stages,summary=learning_summary(records))


def learning_summary(records):
    result={}
    for arm in ARMS:
        items=[r for r in records if r['arm']==arm]
        result[arm]=dict(episodes=len(items),verifiedApplications=sum(r['event']['check'].get('toolSupported',False) for r in items),
            statuses=dict(Counter(r['event']['check']['status'] for r in items)),
            positiveZipEvents=sum(r['event']['novelTrialApplication'] for r in items),
            zipRewardSum=sum(r['event']['zipReward'] for r in items),answerRewardSum=sum(r['event']['answerReward'] for r in items),
            appliedPolicyRewardSum=sum(r['policyUpdate']['appliedReward'] for r in items),
            parameterChangingUpdates=sum(r['policyUpdate'].get('parameterChanged',False) for r in items),
            byRule={kind:dict(questions=sum(r['task']['kind']==kind for r in items),
                verified=sum(r['task']['kind']==kind and r['event']['check'].get('toolSupported',False) for r in items),
                bindingHintQuestions=sum(r['task']['kind']==kind and r['stage']=='binding_hint' for r in items)) for kind in KINDS})
    return result


def root_evaluation(tasks,roots,activate,generate,save,assert_frozen,seconds=600):
    deadline=time.monotonic()+seconds;records=[];stop='completed'
    for number,task in enumerate(tasks,1):
        if time.monotonic()>=deadline: stop='root-evaluation-time-budget';break
        tool=roots[KINDS.index(task['kind'])]
        slots=[(arm,condition) for arm in ARMS for condition in CONDITIONS]
        random.Random(EVAL_SEED+number).shuffle(slots)
        for arm,condition in slots:
            activate(arm,True);assert_frozen(arm)
            prompt=messages(task,tool,condition=condition);seed=EVAL_SEED+number
            response=generate(prompt,TOKENS,seed,sampled=False,temperature=1.)
            raw=dict(task=task,phase='root_evaluation',arm=arm,condition=condition,
                studentPrompt=prompt,studentOutput=response,samplingSeed=seed)
            save('root-raw',raw);assert_frozen(arm)
            checked=support_step(task['expression'],response,tool,task['kind'])
            content=reuse_check(task,response,tool)
            record=dict(raw,check=checked,content=content);save('root-scored',record);records.append(record)
    return dict(stopReason=stop,records=records,summary=root_summary(records,tasks))


def root_summary(records,tasks):
    result={}
    for kind in KINDS:
        result[kind]={}
        for arm in ARMS:
            result[kind][arm]={}
            for condition in CONDITIONS:
                rows=[r for r in records if r['task']['kind']==kind and r['arm']==arm and r['condition']==condition]
                result[kind][arm][condition]=dict(questions=len(rows),verifiedApplications=sum(r['check'].get('toolSupported',False) for r in rows),
                    cleanChangedMathematics=sum(r['content']['cleanChangedMathematics'] for r in rows),
                    wrongEqualities=sum(r['content']['wrongWrittenEquality'] for r in rows),
                    copies=sum(r['content']['copiedOriginal'] for r in rows),skips=sum(r['content']['explicitSkip'] for r in rows),
                    pending=sum(r['check']['status']=='pending' for r in rows),untestedAccuracyIsUnavailable=not rows)
    result['completeEightConditionQuestions']=sum({(r['arm'],r['condition']) for r in records if r['task']['id']==task['id']}==
        {(a,c) for a in ARMS for c in CONDITIONS} for task in tasks)
    result['constructionGate']=dict(passed=all(result[k]['reward-on']['zip']['questions']==8 and
        result[k]['reward-on']['zip']['verifiedApplications']>=6 for k in KINDS),
        criterion='both separate rule skills at least 6/8 on fresh unhinted objects',
        gateUsesRewardOnOnly=True,declaredBeforeEvaluation=True)
    return result


def recovery_proof_messages(current,roots,kind):
    """No unrelated second rule, but the second route can apply one root twice."""
    tool=roots[0] if kind.startswith('combine') else roots[1]
    task=dict(kind='combine' if kind.startswith('combine') else 'distribute',expression=current,question='Rewrite '+current+'.')
    prompt=messages(task,tool,hint=False)
    if kind.endswith('each'):
        prompt[0]['content']=('Rewrite the whole given expression using only the stored rule at the requested positions. '
            'Write one complete equality. Preserve all other terms. Use * and **. No explanation. Write SKIP if unsure.')
    instructions=dict(combine='Apply the stored rule once to the whole repeated inner expression.',
        distribute='Apply the stored rule to remove the product brackets.',
        distribute_each='Apply the stored rule separately to both summands. Do not collect terms yet.',
        combine_each='Regroup like terms and apply the stored rule to them. Do not factor the result back into brackets.')
    prompt[1]['content']+='\n'+instructions[kind]
    # Bindings are read only from existing problem subexpressions; no target.
    if kind in ('combine','distribute'):
        bindings=input_bindings(current,tool)
        if bindings: prompt[1]['content']+='\nInput match: '+', '.join(k+' = '+v for k,v in bindings.items())+'.'
    return prompt
