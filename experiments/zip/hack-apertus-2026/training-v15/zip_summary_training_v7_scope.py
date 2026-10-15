"""Predetermined related-task curriculum and isolated, equally trained readers.

The structural router is program assistance, not student autonomous retrieval.
It is derived from source/calibration INPUTS, never validation outcomes. A
separate related object validates each note after the reader calibration.
"""
import ast
import copy
import math

from zip_content_core import digest
from choice_retest_core import restore_head
from object_choice_core import object_key
from zip_label_grounded_checks import replay_item, guarded_head_update

SCOPE_PROTOCOL = 'lain-input-shape-scoped-reader-v7'
ROLES = ('source', 'reader_calibration', 'related_validation', 'outside_scope_guard')
READER_UPDATE_CAP = 24  # One note reader and one matched plain reader per candidate.


def require(value, message):
    if not value:raise ValueError(message)


def expression_shape(expression):
    """Abstract numbers/names, retaining operators, repetitions and nesting."""
    tree=ast.parse(expression,mode='eval');require(len(list(ast.walk(tree)))<=128,'Scope expression too large')
    names={}
    def visit(n):
        if isinstance(n,ast.Constant) and type(n.value) in (int,float):
            require(math.isfinite(n.value),'Nonfinite scope literal');return ['number']
        if isinstance(n,ast.Name):
            if n.id not in names:names[n.id]=len(names)
            return ['variable',names[n.id]]
        if isinstance(n,ast.BinOp) and isinstance(n.op,(ast.Add,ast.Sub,ast.Mult,ast.Pow)):
            return [type(n.op).__name__,visit(n.left),visit(n.right)]
        if isinstance(n,ast.UnaryOp) and isinstance(n.op,(ast.USub,ast.UAdd)):
            return [type(n.op).__name__,visit(n.operand)]
        raise ValueError('Unsupported scope expression; no implicit match')
    return digest(visit(tree.body))


def make_plan(excluded, roots, stage=1):
    require(type(stage) is int and 1<=stage<=3,'Invalid fixed curriculum stage')
    seen=set(excluded)|{object_key(r['rule']['input']) for r in roots}
    def rows(expressions,family,roles,split='training'):
        keys=[object_key(e) for e in expressions]
        if len(set(keys))!=len(keys) or any(k in seen for k in keys):return None
        seen.update(keys)
        return [dict(id='continue-object-'+digest(e)[:16],expression=e,question='Rewrite '+e+'.',
            scope='real_polynomial',semanticInputKey=k,family=family,split=split,
            curriculumStage=stage,curriculumRole=role)
            for e,k,role in zip(expressions,keys,roles)]
    def group(family,roles,split='training'):
        for n in range(1,10001):
            if family=='same_factor':
                inner=[f'{n} * v',f'{n+1} * '+('w' if stage==2 else 'v'),
                    f'{n+2} * '+('z' if stage==2 else 'v')]
                if stage==3:inner[1:]=[f'{n+1} * v + {n+3}',f'{n+2} * v + {n+4}']
                expressions=[f'1 * ({x}) + 2 * ({x})' for x in inner]
            else:
                expressions=[f'3 * (4 * v + {n})',
                    f'{4 if stage==3 else 3} * (5 * '+('w' if stage==2 else 'v')+f' + {n})',
                    f'{5 if stage==3 else 3} * (6 * '+('z' if stage==2 else 'v')+f' + {n})']
            value=rows(expressions[:len(roles)],family,roles,split)
            if value:return value
        raise ValueError('No fresh related inputs; never recycle or retry a generation')
    a=group('same_factor',ROLES[:3]);b=group('product_of_sum',ROLES[:3])
    # Each group's last object is a separate unmatching input, fixed BEFORE
    # generation. It is reported and may never cancel a related benefit by
    # silently forcing that unrelated note into the task.
    ag=group('product_of_sum',('outside_scope_guard',))[0]
    bg=group('same_factor',('outside_scope_guard',))[0]
    train=a+[ag]+b+[bg]
    held=[]
    for family in ('same_factor','product_of_sum'):
        held+=group(family,('heldout','heldout'),'heldout')
    keys=[t['semanticInputKey'] for t in train+held]
    require(len(keys)==12 and len(set(keys))==12,'Curriculum input collision')
    return dict(training=train,heldout=held,trainingObjects=8,heldoutObjects=4,
        curriculumProtocol='related-calibration-validation-and-abstention-v7',curriculumStage=stage,
        curriculumSequence=list(ROLES),curriculumIsHostScaffolding=True,
        relationChosenBeforeStudentOutputs=True,stageSchedule='constants; variable-renaming; nested-inner-or-outer-coefficient',
        hiddenFamilyLabelsNotSuppliedToStudent=True,structuralGeneralizationProved=False)


def validate_plan(plan):
    require(len(plan['training'])==8 and len(plan['heldout'])==4 and
        type(plan['curriculumStage']) is int and 1<=plan['curriculumStage']<=3,'Curriculum shape changed')
    for start in (0,4):
        tasks=plan['training'][start:start+4]
        require([t['curriculumRole'] for t in tasks]==list(ROLES) and
            all(t['split']=='training' for t in tasks),'Fixed calibration/validation split changed')
        shapes={expression_shape(t['expression']) for t in tasks[:2]}
        require(expression_shape(tasks[2]['expression']) in shapes and
            expression_shape(tasks[3]['expression']) not in shapes,'Related validation or outside guard changed')
    all_tasks=plan['training']+plan['heldout']
    require(len({t['semanticInputKey'] for t in all_tasks})==12 and
        all(t['split']=='heldout' and t['curriculumRole']=='heldout' for t in plan['heldout']) and
        all(t['curriculumStage']==plan['curriculumStage'] and t['semanticInputKey']==object_key(t['expression'])
            for t in all_tasks),'Changed input binding or heldout split')


def fit_reader(note,case,head_state):
    task=case['task']
    require(task['split']=='training' and task['curriculumRole']=='reader_calibration' and
        task['id']!=note['sourceTaskId'],'Reader uses only the predeclared calibration object')
    require(note['audit']['eligibleForTrial'],'Ineligible note cannot train a reader')
    records={};states={}
    for arm,field in (('note','withSummary'),('control','without')):
        h=restore_head(copy.deepcopy(head_state))
        item=replay_item(task,case[field],case['outcomes'],case['featureIds'][field],case['sourceMathRecordIds'])
        update=guarded_head_update(h,[item],1)
        records[arm]=update;states[arm]=copy.deepcopy(update['afterState'])
    row=dict(id=note['id']+'-reader',protocol=SCOPE_PROTOCOL,summaryZipId=note['id'],branch=note['branch'],
        sourceTaskId=note['sourceTaskId'],calibrationCase=copy.deepcopy(case),beforeState=copy.deepcopy(head_state),
        updates=records,heads=states,scopeShapes=sorted({expression_shape(note['event']['task']['expression']),
            expression_shape(task['expression'])}),equalInitialReaderHeads=True,equalReaderUpdateOpportunities=True,
        validationOutcomesEnteredReaderTraining=False,heldoutEnteredReaderTraining=False,
        teacherTargetTokensProvided=False,programStructuralScope=True,studentAutonomousRetrieval=False)
    row['readerHash']=digest(row);return row


def validate_reader(note,row):
    require(row==fit_reader(note,row['calibrationCase'],row['beforeState']),
        'Reader parameters, calibration source or scope changed')


def measure(note,case,reader,plain_head):
    validate_reader(note,reader);task=case['task'];outcomes=case['outcomes']
    require(task['split']=='training' and task['id']!=note['sourceTaskId'],'Only later TRAIN evidence may credit words')
    def probability(state,features):
        return sum(p*y for p,y in zip(restore_head(state).probabilities(features)[1],outcomes))
    ctrl=probability(reader['heads']['control'],case['without'])
    q=probability(reader['heads']['note'],case['withSummary'])
    ablation=probability(reader['heads']['note'],case['without'])
    plain=probability(plain_head,case['without'])
    matched=expression_shape(task['expression']) in reader['scopeShapes']
    without=ctrl if matched else plain;with_note=q if matched else plain
    row=dict(sourceSummaryZipId=note['id'],sourceWordRecordId=note['sourceRecordId'],sourceTaskId=note['sourceTaskId'],
        rewardTaskId=task['id'],rewardObjectSplit='training',curriculumRole=task['curriculumRole'],
        rewardTaskFamily=task['family'],rewardTaskExpression=task['expression'],case=copy.deepcopy(case),
        readerTraining=copy.deepcopy(reader),plainHead=copy.deepcopy(plain_head),
        probabilityWithoutSummary=without,probabilityWithSummary=with_note,signedFullReuseGain=with_note-without,
        sameReaderWithoutSummary=ablation,sameReaderSummaryDifference=q-ablation,
        ungatedReaderProbabilityWithSummary=q,ungatedControlProbabilityWithoutSummary=ctrl,
        ungatedReaderDifference=q-ctrl,scopeMatched=matched,contextActuallyUsedByScopedPolicy=matched,
        featureIds=copy.deepcopy(case['featureIds']),observationIds=copy.deepcopy(case['observationIds']),
        pairedObservationSeed=case['pairedObservationSeed'],sourceMathRecordIds=case['sourceMathRecordIds'],
        includesObservationGenerationAndCardContext=True,observationDecodingMode='greedy',
        calibrationExcludedFromWordReward=True,proseTruthCertified=False)
    return row
