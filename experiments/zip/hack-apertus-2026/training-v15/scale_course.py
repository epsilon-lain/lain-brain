"""Predeclared balanced mixture; unchanged prompts, decoding and heldout inputs."""
import ast
import copy
from collections import Counter
import random
import time

from distribution_course import messages as distribution_messages
from recovery_course import messages as combine_messages,event
from tool_loop_kernel import object_key,support_step,reuse_check
from zip_content_core import digest

PROTOCOL='lain-zip-fixed-course-scale-v1'
ARMS=('reward-on','reward-off')
FAMILIES=('combine_affine','distribute_affine','distribute_scaled_affine','distribute_nested_affine')
POINTS=(0,64,128,256,512)
PAIRS=512
TOKENS=96
CAP=1832
SEED=6077100
TEMPERATURE=.3


def composition_objects(original):
    result=[]
    for item in original:
        tree=ast.parse(item['expression'],mode='eval')
        if {node.id for node in ast.walk(tree) if isinstance(node,ast.Name)}!={'x'}:
            raise ValueError('Expected the four prior one-variable affine construction anchors')
        class Rename(ast.NodeTransformer):
            def visit_Name(self,node): return ast.copy_location(ast.Name(id='u',ctx=ast.Load()),node)
        expression=ast.unparse(Rename().visit(tree).body)
        result.append(dict(id='scale-compose-'+digest(item['id'])[:16],expression=expression,question='Rewrite '+expression+'.',
            family='one_variable_affine',scope='real_polynomial',conditions=[],semanticInputKey=object_key(expression),
            originalObject=copy.deepcopy(item),historicalSemanticObject=True,
            variableDisplayOnlyRenamed=True,notFreshGeneralization=True))
    if len(result)!=4: raise ValueError('Four fixed composition anchors required')
    return result


def plans(excluded,construction):
    seen=set(excluded)
    for item in construction:
        # Exclude their given input and original variable-bearing parts too.
        for node in ast.walk(ast.parse(item['expression'],mode='eval')):
            if isinstance(node,ast.expr) and any(isinstance(child,ast.Name) for child in ast.walk(node)):
                seen.add(object_key(ast.unparse(node)))
    training={};heldout=[];preflight=[]
    for fi,family in enumerate(FAMILIES):
        if family=='combine_affine':
            values=[f'1*(u+{n}) + 2*(u+{n})' for n in range(1,1025)]
        elif family=='distribute_affine': values=[f'{c}*(u+{n})' for n in range(1,1025) for c in (2,3,4)]
        elif family=='distribute_scaled_affine': values=[f'{c}*(2*u+{n})' for n in range(1,1025) for c in (2,3)]
        else: values=[f'{c}*(u+(v+{n}))' for n in range(1,1025) for c in (2,3)]
        random.Random(SEED+fi).shuffle(values);rows=[]
        for expression in values:
            key=object_key(expression)
            if key in seen: continue
            seen.add(key);rows.append(dict(id='scale-input-'+digest(expression)[:16],expression=expression,
                question='Rewrite '+expression+'.',family=family,kind='combine' if family.startswith('combine') else 'distribute',
                scope='real_polynomial',conditions=[],semanticInputKey=key,generator='bounded local algebra inputs, not a public benchmark'))
            if len(rows)==134: break
        if len(rows)!=134: raise ValueError('Insufficient disjoint inputs inside fixed 1..1024 range')
        preflight+=rows[:2];heldout+=rows[2:6];training[family]=rows[6:]
    lessons=[training[family][index] for index in range(128) for family in FAMILIES]
    return lessons,heldout,preflight


def messages(task,roots,condition='zip'):
    root=roots[0 if task['kind']=='combine' else 1]
    return (combine_messages if task['kind']=='combine' else distribution_messages)(task,root,condition=condition)


def summary(records):
    result={}
    for arm in ARMS:
        rows=[r for r in records if r['arm']==arm]
        result[arm]=dict(episodes=len(rows),verified=sum(r['event']['check'].get('toolSupported',False) for r in rows),
            statuses=dict(Counter(r['event']['check']['status'] for r in rows)),positiveEvents=sum(r['event']['novelTrialApplication'] for r in rows),
            zipRewardSum=sum(r['event']['zipReward'] for r in rows),answerRewardSum=sum(r['event']['answerReward'] for r in rows),
            appliedRewardSum=sum(r['policyUpdate']['appliedReward'] for r in rows),
            updates=sum(r['policyUpdate'].get('updated',False) for r in rows),
            positiveRewardUpdates=sum(r['policyUpdate'].get('updated',False) and r['event']['totalReward']>0 for r in rows),
            negativeRewardUpdates=sum(r['policyUpdate'].get('updated',False) and r['event']['totalReward']<0 for r in rows),
            zeroRewardEpisodes=sum(abs(r['event']['totalReward'])<1e-12 for r in rows),
            byFamily={family:dict(questions=sum(r['task']['family']==family for r in rows),
                verified=sum(r['task']['family']==family and r['event']['check'].get('toolSupported',False) for r in rows)) for family in FAMILIES})
    return result


def learn(lessons,roots,activate,generate,update,save,checkpoint,seconds=5400,pairs=PAIRS,
    start=0,initial_records=None,initial_ledgers=None,learning_seconds_before=0.):
    if pairs not in POINTS[1:]: raise ValueError('Use a predeclared completed milestone')
    if not 0<=start<=pairs: raise ValueError('Invalid resume position')
    records=list(initial_records or []);ledgers={a:set((initial_ledgers or {}).get(a,())) for a in ARMS}
    if any({r['pair'] for r in records if r['arm']==a}!=set(range(1,start+1)) for a in ARMS):
        raise ValueError('Resume requires a complete contiguous paired prefix')
    learning_seconds=float(learning_seconds_before);stop='completed'
    checkpoint(start,ledgers,records,evaluate=start in POINTS)
    for number in range(start+1,pairs+1):
        task=lessons[number-1]
        if learning_seconds>=seconds: stop='learning-time-budget';break
        pair_started=time.monotonic()
        prepared={};preview={a:set(ledgers[a]) for a in ARMS};prompt=messages(task,roots)
        for arm in ARMS if number%2 else tuple(reversed(ARMS)):
            activate(arm,False)
            response=generate(prompt,TOKENS,SEED+number,sampled=True,temperature=TEMPERATURE)
            raw=dict(task=task,phase='learning',pair=number,arm=arm,studentPrompt=prompt,studentOutput=response,samplingSeed=SEED+number)
            save('learning-raw',raw)
            checked=event(task,response,roots[0 if task['kind']=='combine' else 1],preview[arm],True)
            row=dict(raw,event=checked);save('learning-scored',row);prepared[arm]=row
        if learning_seconds+time.monotonic()-pair_started>=seconds:
            stop='time-budget-pair-saved-not-updated';break
        for arm in ARMS:
            activate(arm,False);row=prepared[arm]
            policy=update(arm,row['studentOutput'],row['event']['totalReward'])
            ledgers[arm]=preview[arm];row=dict(row,policyUpdate=policy);save('learning-episode',row);records.append(row)
        learning_seconds+=time.monotonic()-pair_started
        if number%16==0:
            import json
            print('固定课程进度：',json.dumps(dict(completedPairs=number,learningSeconds=round(learning_seconds,1),
                arms=summary(records)),ensure_ascii=False),flush=True)
        if number in POINTS or number%16==0: checkpoint(number,ledgers,records,evaluate=number in POINTS)
    completed=sum(r['arm']=='reward-on' for r in records)
    if completed not in POINTS: checkpoint(completed,ledgers,records,evaluate=False)
    return dict(stopReason=stop,records=records,ledgers=ledgers,completed=completed,learningSeconds=learning_seconds)


def evaluate(point,objects,roots,activate,generate,save,assert_frozen,conditions=('zip','no_zip'),seconds=300):
    records=[];deadline=time.monotonic()+seconds
    for number,task in enumerate(objects,1):
        if time.monotonic()>=deadline: break
        order=[(a,c) for a in ARMS for c in conditions];random.Random(SEED+point+number).shuffle(order)
        for arm,condition in order:
            activate(arm,True);prompt=messages(task,roots,condition)
            output=generate(prompt,TOKENS,SEED+9000+number,sampled=False,temperature=1.)
            row=dict(task=task,phase='frozen',point=point,arm=arm,condition=condition,
                studentPrompt=prompt,studentOutput=output,samplingSeed=SEED+9000+number)
            save('frozen-raw',row);assert_frozen(arm)
            root=roots[0 if task['kind']=='combine' else 1];checked=support_step(task['expression'],output,root,task['kind'])
            content=reuse_check(task,output,root);row=dict(row,check=checked,content=content);save('frozen-scored',row);records.append(row)
    return records


def frozen_summary(records,conditions=('zip','no_zip')):
    result={}
    for arm in ARMS:
        result[arm]={}
        for condition in conditions:
            rows=[r for r in records if (r['arm'],r['condition'])==(arm,condition)]
            result[arm][condition]=dict(questions=len(rows),verified=sum(r['check'].get('toolSupported',False) for r in rows),
                wrongEqualities=sum(r['check']['status']=='rejected' for r in rows),copies=sum(r['content']['copiedOriginal'] for r in rows),
                pending=sum(r['check']['status']=='pending' for r in rows),untestedAccuracyIsUnavailable=not rows,
                byFamily={f:dict(questions=sum(r['task']['family']==f for r in rows),
                    verified=sum(r['task']['family']==f and r['check'].get('toolSupported',False) for r in rows)) for f in FAMILIES})
    return result
