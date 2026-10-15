"""Distribution only: two actual attempts, explicit placeholders, gradual hints."""
import ast
import copy
from collections import Counter
import json
import random
import time

from recovery_course import messages as original_messages, input_bindings, event
from tool_loop_kernel import object_key, support_step, reuse_check
from zip_content_core import digest, parse_expression, verify_claim

PROTOCOL='lain-zip-distribution-focus-v1'
ARMS=('reward-on','reward-off')
CONDITIONS=('zip','no_zip','same_rule_text','mismatched_zip')
PAIRS=64
ATTEMPTS=2
TOKENS=96
CAP=440
TRAIN_SEED=4077100
EVAL_SEED=4078100
STAGES=('binding_hint_basic','rule_only_basic','rule_only_affine')


def displayed_rule(tool):
    """Rename the stored template only; do not instantiate a question's target."""
    renaming={'c':'r','a':'p','b':'q'}
    class Rename(ast.NodeTransformer):
        def visit_Name(self,node): return ast.copy_location(ast.Name(id=renaming[node.id],ctx=ast.Load()),node)
    rule=copy.deepcopy(tool['rule'])
    for field in ('input','output'):
        tree=parse_expression(rule[field])[1].body
        rule[field]=ast.unparse(Rename().visit(copy.deepcopy(tree)))
    if not verify_claim(rule)['accepted']: raise ValueError('Renamed display rule fails exact verification')
    return rule


def messages(task,tool,hint=False,condition='zip'):
    rule=displayed_rule(tool)
    system=('Distribute the multiplier over the two whole summands. Write exactly one complete equality: '
        'the original expression = your rewritten expression. Leave numerical products unevaluated. '
        'Keep the internal expression of each summand unchanged. Use * and **. No explanation, JSON, '
        'chains, factoring or extra steps. Write SKIP if unsure.')
    user=task['question']+'\nAll task variables are independent real numbers.'
    if condition in ('zip','same_rule_text','mismatched_zip'):
        header='Mathematical rule: ' if condition=='same_rule_text' else 'Stored rule: '
        target=rule['output'] if condition!='mismatched_zip' else '('+rule['output']+')+1'
        user+='\n'+header+rule['input']+' = '+target
        user+='\nr, p and q are placeholders for whole subexpressions, rather than names of task variables.'
    elif condition!='no_zip': raise ValueError('Unknown condition')
    if hint:
        if condition!='zip': raise ValueError('Bindings belong only to learning')
        bindings=input_bindings(task['expression'],tool)
        if bindings is None: raise ValueError('Input does not match the stored template')
        user+='\nInput match: '+', '.join({'c':'r','a':'p','b':'q'}[key]+' = '+value for key,value in bindings.items())+'.'
    return [dict(role='system',content=system),dict(role='user',content=user)]


def plans(excluded):
    seen=set(excluded);pools={};tests=[]
    pairs=(('u','v'),('u','w'),('v','w'),('w','z'),('u','z'),('m','n'))
    easy=((1,1),(2,1),(1,2),(2,2),(3,1),(1,3),(3,2),(2,3))
    scales=easy+tuple((a,b) for a in range(1,13) for b in range(1,13) if (a,b) not in easy)
    basic=[(f'{c}*({a}*{u}+{b}*{v})','basic') for a,b in scales for c in (2,3,4) for u,v in pairs]
    affine=[(f'{c}*({u}+{n})','affine') for n in range(1,4097) for c in (2,3,4) for u in ('u','v','w')]
    for family,candidates in (('basic',basic),('affine',affine)):
        rows=[]
        for expression,_ in candidates:
            key=object_key(expression)
            if key in seen: continue
            seen.add(key)
            rows.append(dict(id='distribution-object-'+digest(expression)[:16],kind='distribute',family=family,
                expression=expression,question='Rewrite '+expression+'.',scope='real_polynomial',conditions=[],
                semanticInputKey=key,generator='bounded local input generator; not a public benchmark'))
            if len(rows)==PAIRS+8: break
        if len(rows)!=PAIRS+8: raise ValueError('Insufficient fresh inputs for '+family)
        # Reserve the test objects before learning; never use them to advance stages.
        random.Random(EVAL_SEED+(family=='affine')).shuffle(rows)
        tests += rows[:8];pools[family]=rows[8:]
    return pools,tests


def learn(pools,tool,activate,generate,update,save,checkpoint,seconds=1800):
    ledgers={a:set() for a in ARMS};positions={k:0 for k in pools};records=[];stage=0;streak=0;block=[]
    deadline=time.monotonic()+seconds;stop='completed';checkpoint(0,ledgers)
    for number in range(1,PAIRS+1):
        if time.monotonic()>=deadline: stop='learning-time-budget';break
        family='affine' if stage==2 else 'basic';task=pools[family][positions[family]];positions[family]+=1
        label=STAGES[stage];prompt=messages(task,tool,hint=stage==0)
        prepared={};preview={a:set(ledgers[a]) for a in ARMS}
        # Every sampled trajectory in both arms is generated and saved before
        # either writer changes. The second candidate gets a different seed.
        for arm in ARMS if number%2 else tuple(reversed(ARMS)):
            activate(arm,False);prepared[arm]=[]
            for attempt in range(1,ATTEMPTS+1):
                seed=TRAIN_SEED+number*ATTEMPTS+attempt
                response=generate(prompt,TOKENS,seed,sampled=True,temperature=.5)
                raw=dict(task=task,phase='learning',pair=number,attempt=attempt,arm=arm,stage=label,
                    studentPrompt=prompt,studentOutput=response,samplingSeed=seed)
                save('learning-raw',raw)
                reward=event(task,response,tool,preview[arm],commit=True)
                record=dict(raw,event=reward);save('learning-scored',record);prepared[arm].append(record)
        for arm in ARMS:
            activate(arm,False)
            batch=prepared[arm];policy=update(arm,[r['studentOutput'] for r in batch],[r['event']['totalReward'] for r in batch])
            ledgers[arm]=preview[arm]
            for row in batch:
                row['appliedPolicyReward']=row['event']['totalReward'] if arm=='reward-on' else 0.
                row['batchPolicyUpdate']=policy;save('learning-episode',row);records.append(row)
        first=prepared['reward-on'][0]
        block.append(first)
        if len(block)==8:
            correct=sum(r['event']['check'].get('toolSupported',False) for r in block)
            passed=correct>=6;streak=streak+1 if passed else 0;promoted=stage<2 and streak>=2
            if promoted: stage+=1;streak=0
            review=dict(throughPair=number,stage=label,firstAttemptVerified=correct,questions=8,passed=passed,
                promoted=promoted,nextStage=STAGES[stage],secondAttemptNeverUsedForAdvancement=True)
            save('block',review);block=[]
            print('分配专项课程：',json.dumps(review,ensure_ascii=False),flush=True)
            checkpoint(number,ledgers)
    checkpoint(len(records)//(2*ATTEMPTS),ledgers)
    return dict(stopReason=stop,records=records,ledgers=ledgers,finalStage=STAGES[stage])


def learning_summary(records):
    result={}
    for arm in ARMS:
        rows=[r for r in records if r['arm']==arm];first=[r for r in rows if r['attempt']==1]
        second=[r for r in rows if r['attempt']==2]
        pair_ids={r['pair'] for r in rows}
        result[arm]=dict(episodes=len(pair_ids),attempts=len(rows),
            firstAttemptVerified=sum(r['event']['check'].get('toolSupported',False) for r in first),
            secondAttemptVerified=sum(r['event']['check'].get('toolSupported',False) for r in second),
            pairsWithAtLeastOneVerified=sum(any(r['pair']==p and r['event']['check'].get('toolSupported',False) for r in rows) for p in pair_ids),
            positiveNovelInstanceEvents=sum(r['event']['novelTrialApplication'] for r in rows),
            statuses=dict(Counter(r['event']['check']['status'] for r in rows)),
            zipRewardSum=sum(r['event']['zipReward'] for r in rows),answerRewardSum=sum(r['event']['answerReward'] for r in rows),
            appliedPolicyRewardSum=sum(r['appliedPolicyReward'] for r in rows),
            byStage={stage:dict(questions=sum(r['stage']==stage for r in first),
                firstVerified=sum(r['stage']==stage and r['event']['check'].get('toolSupported',False) for r in first)) for stage in STAGES})
    return result


def frozen(tasks,tool,activate,generate,save,assert_frozen,seconds=600):
    deadline=time.monotonic()+seconds;records=[];stop='completed'
    for number,task in enumerate(tasks,1):
        if time.monotonic()>=deadline: stop='distribution-evaluation-time-budget';break
        order=[(a,c) for a in ARMS for c in CONDITIONS];random.Random(EVAL_SEED+number).shuffle(order)
        for arm,condition in order:
            activate(arm,True);prompt=messages(task,tool,condition=condition);seed=EVAL_SEED+number
            output=generate(prompt,TOKENS,seed,sampled=False,temperature=1.)
            raw=dict(task=task,phase='distribution_frozen',arm=arm,condition=condition,
                studentPrompt=prompt,studentOutput=output,samplingSeed=seed)
            save('frozen-raw',raw);assert_frozen(arm)
            check=support_step(task['expression'],output,tool,'distribute');content=reuse_check(task,output,tool)
            row=dict(raw,check=check,content=content);save('frozen-scored',row);records.append(row)
    return dict(stopReason=stop,records=records,summary=frozen_summary(records,tasks))


def frozen_summary(records,tasks):
    groups={}
    for family in ('basic','affine'):
        groups[family]={}
        for arm in ARMS:
            groups[family][arm]={}
            for condition in CONDITIONS:
                rows=[r for r in records if (r['task']['family'],r['arm'],r['condition'])==(family,arm,condition)]
                groups[family][arm][condition]=dict(questions=len(rows),verified=sum(r['check'].get('toolSupported',False) for r in rows),
                    wrongEqualities=sum(r['content']['wrongWrittenEquality'] for r in rows),
                    copies=sum(r['content']['copiedOriginal'] for r in rows),skips=sum(r['content']['explicitSkip'] for r in rows),
                    pending=sum(r['check']['status']=='pending' for r in rows),untestedAccuracyIsUnavailable=not rows)
    groups['completeEightConditionQuestions']=sum({(r['arm'],r['condition']) for r in records if r['task']['id']==t['id']}==
        {(a,c) for a in ARMS for c in CONDITIONS} for t in tasks)
    groups['distributionGate']=dict(passed=all(groups[f]['reward-on']['zip']['questions']==8 and
        groups[f]['reward-on']['zip']['verified']>=6 for f in ('basic','affine')),
        criterion='at least 6/8 first frozen answers in both basic and affine families',declaredBeforeEvaluation=True)
    return groups


def retention(anchors,tool,activate,generate,save,assert_frozen,seconds=300):
    records=[];deadline=time.monotonic()+seconds;stop='completed'
    for number,old in enumerate(anchors,1):
        if time.monotonic()>=deadline: stop='retention-time-budget';break
        task=old['task'];task=dict(task,kind='combine')
        for arm in ARMS:
            for condition in ('zip','same_rule_text'):
                activate(arm,True);prompt=original_messages(task,tool,condition=condition);seed=old['samplingSeed']
                output=generate(prompt,TOKENS,seed,sampled=False,temperature=1.)
                raw=dict(task=task,phase='combine_retention',arm=arm,condition=condition,
                    studentPrompt=prompt,studentOutput=output,samplingSeed=seed)
                save('retention-raw',raw);assert_frozen(arm)
                check=support_step(task['expression'],output,tool,'combine')
                row=dict(raw,check=check);save('retention-scored',row);records.append(row)
    return dict(records=records,stopReason=stop)


def retention_summary(records,baseline):
    result={}
    for arm in ARMS:
        result[arm]={}
        for condition in ('zip','same_rule_text'):
            rows=[r for r in records if (r['arm'],r['condition'])==(arm,condition)]
            previous=baseline['combine']['reward-on'][condition]
            correct=sum(r['check'].get('toolSupported',False) for r in rows)
            result[arm][condition]=dict(questions=len(rows),verified=correct,baselineQuestions=previous['questions'],
                baselineVerified=previous['verifiedApplications'],change=correct-previous['verifiedApplications'],
                noMeasuredRegression=len(rows)==previous['questions'] and correct>=previous['verifiedApplications'])
    result['retentionGatePassed']=all(result['reward-on'][c]['noMeasuredRegression'] for c in ('zip','same_rule_text'))
    result['historicalAnchorsAreRetentionTestsNotFreshGeneralization']=True
    return result
