"""Fixed six-hour math-writer curriculum; no heldout-driven source selection."""
import copy
import math
from pathlib import Path
from zip_management_geometry_core import (digest,require,candidate_cards,audit_math)
from zip_summary_training_v7_scope import make_plan as scope_plan
from object_choice_core import object_key

PROTOCOL='lain-zip-verified-math-writer-long-training-v15'
BLOCKS=24
TRAIN_PER_BLOCK=8
EVAL_INTERVAL=4
TOKENS=96
ARMS=('trained_writer_managed','initial_writer_managed','trained_writer_without_summary',
      'initial_writer_without_summary','trained_writer_uniform_routes','initial_writer_uniform_routes')


def recipe():
    return dict(protocol=PROTOCOL,totalBudgetSeconds=21600,blocks=BLOCKS,trainingTasksPerBlock=8,
        evaluationEveryBlocks=4,freshEvaluationTasksPerBatch=4,maximumMathOptimizerUpdates=192,
        maxResponseTokens=96,learningRate=.0001,weightDecay=0.,gradientClip=1.,
        rewardBaseline=.5,rehearsalWeight=.25,replayLogProbabilityTolerancePerToken=.08,
        trainingTemperature=.8,evaluationTemperature=1.,evaluationSampling='greedy',
        fixedStageSequence=[1]*8+[2]*8+[3]*8,trainRouteScheduling='direct and structurally applicable stored rules',
        positiveTargets='unaltered verified student TRAIN originals only',teacherModelCalls=0,
        baseWeightUpdates=0,managementHeadUpdates=0,methodHeadUpdates=0,summaryWriterUpdates=0,
        checkpointEveryMathUpdate=True,allEvaluationBatchesReported=True,
        trainingDoesNotUseAnyHeldoutFeedback=True,sourceChosenByHeldoutScore=False)


def make_plan(excluded,roots,experiment):
    require(type(experiment) is int and 1<=experiment<=1000,'Math seed namespace exhausted')
    seen=set(excluded);blocks=[];evaluations=[]
    for index,stage in enumerate(recipe()['fixedStageSequence'],1):
        p=scope_plan(seen,roots,stage)
        # Reserve even unscheduled heldout shapes: never reuse a previously
        # considered input as a later TRAIN object.
        seen.update(t['semanticInputKey'] for s in ('training','heldout') for t in p[s])
        training=copy.deepcopy(p['training'])
        for j,t in enumerate(training,1):
            t.update(mathTrainingStep=(index-1)*8+j,mathTrainingBlock=index)
        blocks.append(dict(index=index,stage=stage,training=training))
        if index%EVAL_INTERVAL==0:
            evaluations.append(dict(afterBlock=index,afterStep=index*8,stage=stage,tasks=copy.deepcopy(p['heldout'])))
    final=scope_plan(seen,roots,1)['heldout']
    p=dict(protocol=PROTOCOL,experimentNumber=experiment,recipe=recipe(),blocks=blocks,evaluations=evaluations,
        terminalEvaluationTasks=final,trainingTaskCount=192,scheduledHeldoutTaskCount=28,predeterminedBeforeStudentGeneration=True,
        outcomeBasedTaskSelection=False,trainingSeedNamespace=15500000000,heldoutSeedNamespace=15600000000,
        hostStructuralRouteScheduling=True,mathematicalAnswersSuppliedByHost=False)
    p['planHash']=digest(p);validate_plan(p,excluded);return p


def validate_plan(p,excluded=()):
    require(p['protocol']==PROTOCOL and p['recipe']==recipe() and
        p['planHash']==digest({k:v for k,v in p.items() if k!='planHash'}),'Changed fixed math recipe/plan')
    require(len(p['blocks'])==24 and [b['index'] for b in p['blocks']]==list(range(1,25)) and
        [b['stage'] for b in p['blocks']]==recipe()['fixedStageSequence'],'Changed math block schedule')
    require([e['afterStep'] for e in p['evaluations']]==[32,64,96,128,160,192],
        'Changed fixed evaluation schedule')
    train=[t for b in p['blocks'] for t in b['training']]
    held=[t for e in p['evaluations'] for t in e['tasks']]+p['terminalEvaluationTasks']
    require(len(train)==192 and len(held)==28 and len(p['terminalEvaluationTasks'])==4 and all(len(b['training'])==8 for b in p['blocks']) and
        all(len(e['tasks'])==4 and e['afterBlock']*8==e['afterStep'] for e in p['evaluations']),
        'Changed planned task counts')
    require([t['mathTrainingStep'] for t in train]==list(range(1,193)) and
        all(t['split']=='training' for t in train) and all(t['split']=='heldout' for t in held),
        'Heldout cannot become training')
    keys=[t['semanticInputKey'] for t in train+held]
    require(len(set(keys))==220 and not set(keys)&set(excluded) and
        all(t['semanticInputKey']==object_key(t['expression']) for t in train+held),
        'Repeated or changed TRAIN/heldout inputs')


def training_cards(task,roots):
    """Input-only routing; do not return or insert any constructed answer."""
    require(task['split']=='training','Heldout cannot schedule writer training')
    import ast
    from zip_content_core import parse_expression,verify_claim
    from zip_guided_helpers import match_pattern
    actual=parse_expression(task['expression'])[1].body
    result=[]
    for c in candidate_cards(roots):
        if c['kind']=='direct':result.append(c);continue
        rule=c['root']['rule'];require(verify_claim(rule)['accepted'],'Invalid frozen math root')
        pattern=parse_expression(rule['input'])[1].body
        nodes=[actual] if c['kind']=='combine' else ast.walk(actual)
        # Match only the input AST. Do not instantiate the rule output or
        # construct a mathematical answer before the student responds.
        if any(match_pattern(pattern,n,{}) for n in nodes):result.append(c)
    require(result and result[0]['kind']=='direct','Missing direct training route')
    return result


def training_feedback(task,rows,roots):
    require(task['split']=='training','Heldout cannot produce training credit')
    expected=training_cards(task,roots)
    require([r['selectedCandidate'] for r in rows]==expected and
        all(r['task']==task and r['mode']=='math' and r['studentOutput']['sampled'] is True for r in rows),
        'Changed original TRAIN route/trajectory binding')
    checks=[audit_math(task,r['studentOutput'],r['selectedCandidate']) for r in rows]
    return dict(task=task,responseIds=[r['recordId'] for r in rows],checks=checks,
        rewards=[float(c['outcomePassed']) for c in checks],
        advantages=[float(c['outcomePassed'])-.5 for c in checks],
        proofAuditAsWritten=True,teacherCorrectedTargets=False,heldoutFeedbackUsed=False)


def verified_rehearsal(rows,roots):
    result=[];seen=set()
    for r in rows:
        if r.get('mode')!='math' or r.get('task',{}).get('split')!='training':continue
        # Cold checks can refer to a TRAIN task but have no selected route and
        # sometimes intentionally disable math LoRA. They are not targets.
        if (r.get('phase')=='cold_replay' or not r.get('selectedCandidate') or
                r['studentOutput'].get('mathAdapterEnabledDuringGeneration') is not True):continue
        require(r.get('fixtureOnly') is False and not r['studentOutput'].get('testDouble'),
            'Fixture cannot enter mathematical rehearsal')
        c=r['selectedCandidate'];v=r['studentOutput']
        if not audit_math(r['task'],v,c)['outcomePassed']:continue
        require(v.get('originalTextRepaired') is False and v.get('stopReason')=='eos' and
            not v.get('tokenCapReached') and 0<v['generatedTokens']==len(v['generatedIds'])<=96,
            'Only complete unchanged student originals may become rehearsal targets')
        key=digest(dict(task=r['task']['semanticInputKey'],card=c,ids=v['generatedIds']))
        if key not in seen:result.append(copy.deepcopy(r));seen.add(key)
    return sorted(result,key=lambda r:(r['task']['semanticInputKey'],r['recordId']))


def summarize(objects):
    values={a:sum(o['expectedPassByArm'][a] for o in objects)/len(objects) if objects else None for a in ARMS}
    def delta(a,b):return values[a]-values[b] if objects else None
    return dict(primaryMetric='verified-success route mass under the SAME frozen management and method policies',
        heldoutObjects=len(objects),expectedPassByArm=values,
        mathematicalWriterGain=delta(ARMS[0],ARMS[1]),
        mathematicalWriterGainWithoutSummary=delta(ARMS[2],ARMS[3]),
        mathematicalWriterUniformRouteGain=delta(ARMS[4],ARMS[5]),
        summaryContextEffectWithTrainedWriter=delta(ARMS[0],ARMS[2]),
        summaryContextEffectWithInitialWriter=delta(ARMS[1],ARMS[3]),
        failedAllRoutesByWriter={w:sum(not any(o['routeOutcomes'][w]) for o in objects) for w in ('trained','initial')},
        managementAndMethodParametersIdenticalAcrossWriterArms=True,mathematicalRouteOriginalsDifferAcrossWriters=True,
        differentEvaluationInputsAcrossBatches=True,rawBatchMeansAreNotLearningCurve=True,
        pairedWithinTaskComparisons=True,byObject=copy.deepcopy(objects),independentTrainingReplications=0,
        autonomousRetrievalProved=False,newMathematicalRuleDiscoveryProved=False,
        semanticSelfAnalysisProved=False,statisticalSignificanceClaimed=False)


def execute_plan(plan,committed,train,evaluate,training_deadline,hard_deadline,now=None):
    """Skip every committed optimizer transaction; resume an unfinished eval first."""
    import time
    now=now or time.monotonic;validate_plan(plan)
    require(type(committed) is int and 0<=committed<=192,'Invalid committed math-step count')
    for b in plan['blocks']:
        for t in b['training']:
            if t['mathTrainingStep']<=committed:continue
            if now()>=training_deadline:return 'training_budget'
            train(t);committed+=1
        batch=next((e for e in plan['evaluations'] if e['afterBlock']==b['index']),None)
        if batch:
            if now()>=hard_deadline:return 'evaluation_budget'
            evaluate(batch)  # Its frozen checkpoint is afterStep, even on resume.
    return 'completed'
