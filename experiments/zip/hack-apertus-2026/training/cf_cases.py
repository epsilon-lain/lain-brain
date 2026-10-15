"""Predeclared, easy sign contradictions and causal evidence controls.

No numerical result or corrected expression enters the student's prompt. Sign
and factor choices are constrained tool decisions, NOT free arithmetic prose.
"""
import ast
import copy
from fractions import Fraction
import re
from rr_common import *
from rr_sources import equal
from rr_cases import semantic_key

PROTOCOL='lain-zip-self-conditioned-counterexample-v24'
SIGNS=('ZERO','POSITIVE','NEGATIVE')
COUNTS=('NONE','ONCE','TWICE')
ACTIONS=('KEEP','RETRACT')
ROLES=('left_sign','right_sign','coefficient_count','variable_count')


def scalar(expression,variable,point):
    def visit(n):
        if isinstance(n,ast.Constant) and type(n.value) is int:return Fraction(n.value)
        if isinstance(n,ast.Name) and n.id==variable:return Fraction(point)
        if isinstance(n,ast.UnaryOp) and isinstance(n.op,(ast.UAdd,ast.USub)):
            x=visit(n.operand);return x if isinstance(n.op,ast.UAdd) else -x
        if isinstance(n,ast.BinOp):
            a=visit(n.left);b=visit(n.right)
            if isinstance(n.op,ast.Add):return a+b
            if isinstance(n.op,ast.Sub):return a-b
            if isinstance(n.op,ast.Mult):return a*b
            if isinstance(n.op,ast.Div):return a/b
            if isinstance(n.op,ast.Pow) and b.denominator==1 and 0<=b<=8:return a**int(b)
        raise ValueError('Outside fixed rational witness scope')
    return visit(ast.parse(expression.replace('^','**'),mode='eval').body)


def sign(expression,variable,point):
    x=scalar(expression,variable,point)
    return 'ZERO' if x==0 else 'POSITIVE' if x>0 else 'NEGATIVE'


def factor_count(expression,variable,coefficient,kind):
    def count(n):
        if isinstance(n,ast.BinOp) and isinstance(n.op,ast.Mult):return count(n.left)+count(n.right)
        if isinstance(n,ast.BinOp) and isinstance(n.op,ast.Pow) and isinstance(n.right,ast.Constant) and type(n.right.value) is int:
            return count(n.left)*n.right.value
        if isinstance(n,ast.UnaryOp):return count(n.operand)
        if kind=='variable':return int(isinstance(n,ast.Name) and n.id==variable)
        return int(isinstance(n,ast.Constant) and type(n.value) is int and n.value==coefficient)
    n=count(ast.parse(expression.replace('^','**'),mode='eval').body)
    require(n in (0,1,2),'Factor task exceeds fixed vocabulary');return COUNTS[n]


def make_case(card,kind,split,lpoint=0,rpoint=0,coefficient=None):
    c=dict(card=copy.deepcopy(card),kind=kind,split=split,leftPoint=lpoint,rightPoint=rpoint,
        coefficient=coefficient if coefficient is not None else (315 if card['knownExactIdentity'] else 435))
    c['id']='cf-case-'+digest(c)[:20];return c


def variant(a,v,form,parent):
    left,right,truth={
        'false':(f'{a} * {v} * {v}',f'{a}**2',False),
        'quadratic':(f'{a} * {v} * {v}',f'{a} * {v}**2',True),
        'linear':(f'{a} * {v}',f'{a} * {v}',True),
        'constant':(str(a),str(a),True),
        'double_coefficient':(f'{a} * {a} * {v} * {v}',f'{a}**2 * {v}**2',True)}[form]
    c=dict(family='drop_variable' if not truth else 'correct_identity',left=left,right=right,
        variable=v,knownExactIdentity=truth,provenance=dict(kind='designed_variant',
            sourceRecordId=parent['provenance']['recordId'],studentAuthoredVariant=False))
    require(equal(left,right)==truth,'Template truth changed');c['id']='cf-rule-'+digest(c)[:20];return c


def property_truth(c,role):
    d=c['card'];v=d['variable']
    if role.endswith('_sign'):
        side=role.split('_')[0];return sign(d[side],v,c[side+'Point'])
    return factor_count(d['left'],v,c['coefficient'],role.split('_')[0])


def ideal_action(c):
    return 'RETRACT' if c['leftPoint']==c['rightPoint'] and property_truth(c,'left_sign')!=property_truth(c,'right_sign') else 'KEEP'


def make_plan(cards,old_plan,meta_steps=96,editor_steps=32,quick=False,meta_lr=.0005,editor_lr=.0001):
    require(1<=meta_steps<=192 and 0<=editor_steps<=64,'Bounded phase lengths required')
    require(0<meta_lr<=.001 and 0<editor_lr<=.001,'Bounded learning rates required')
    wrong=next(c for c in cards if c['family']=='drop_variable')
    correct=next(c for c in cards if c['family']=='correct_identity')
    train=[];held=[]
    for split,constants,rows in [('training',(4,9,16) if quick else (4,9,16,25,36,100),train),
                                ('heldout',(49,64) if quick else (49,64,81,121,169,196),held)]:
        for i,a in enumerate(constants):
            v=('p','q','r')[i%3] if split=='training' else ('m','n','r','s','t','u')[i]
            false=variant(a,v,'false',wrong)
            rows.extend([make_case(false,'counterexample',split,0,0,a),
                make_case(false,'inconclusive_same_sign',split,1,1,a),
                make_case(false,'different_inputs',split,0,1,a),
                make_case(variant(a,v,'quadratic',correct),'correct_rule',split,0,0,a)])
            if split=='training':
                rows.extend([make_case(variant(a,v,'linear',correct),'correct_negative',split,-1,-1,a),
                    make_case(variant(a,v,'constant',correct),'correct_constant',split,0,0,a),
                    make_case(variant(a,v,'double_coefficient',correct),'correct_double_coefficient',split,0,0,a)])
    readback=[make_case(wrong,'counterexample','source_readback',0,0,435),
        make_case(wrong,'inconclusive_same_sign','source_readback',1,1,435),
        make_case(wrong,'different_inputs','source_readback',0,1,435),
        make_case(correct,'correct_source_rule','source_readback',0,0,315)]
    for c in readback:
        d=copy.deepcopy(c);d.pop('id');d['split']='training';d['id']='cf-case-'+digest(d)[:20];train.append(d)
    recipe=dict(metaSteps=meta_steps,editorSteps=editor_steps,learningRate=meta_lr,editorLearningRate=editor_lr,
        quick=quick,rank=8,lastLayers=4,alpha=16,gradientClip=1.,maxRawGenerations=480,maxDecisionRecords=8192,
        metaObjective='exact expected TRAIN return on all legal categorical choices',
        editorObjective='REINFORCE on untouched sampled student proposal',editorSamplesPerStep=2,
        signVocabulary=list(SIGNS),factorVocabulary=list(COUNTS),actionVocabulary=list(ACTIONS),
        propertyChoicesConstrained=True,correctNumericalAnswersSupplied=False,teacherReplacementFormulaSupplied=False,
        oldBaseFrozen=True,oldMathWriterFrozen=True,oldRepairFrozen=True,priorReflectionFrozen=True,
        target435ExplicitlyTraining=True,targetMetaEvery=3,targetEditorEvery=2,
        focusSchedule='target every N; remaining cases round robin without index starvation',
        mathTokenBudget=96,proseTokenBudget=128,proposalTemperature=.8,
        copyOrUncollectedReward=0.,correctCollectedProposalReward=1.,wrongProposalReward=-1.,
        emptyOrIncompleteReward=-.2,zeroRewardNeverOptimizerSteps=True,
        checkpointSelection='last committed planned step; never selected by heldout scores',
        freshMeaning='excluded from v23 TRAIN/heldout and v24 TRAIN up to alpha renaming',
        unseenPretrainingClaimed=False,spontaneousSearchClaimed=False,statisticalSignificanceClaimed=False)
    oldkeys=sorted({semantic_key(c['card']) for c in old_plan['training']+old_plan['heldout']})
    p=dict(protocol=PROTOCOL,training=train,heldout=held,sourceReadback=readback,
        previousSeenRuleKeys=oldkeys,recipe=recipe);p['planHash']=digest(p);validate_plan(p);return p


def validate_plan(p):
    require(p['protocol']==PROTOCOL and p['planHash']==digest({k:v for k,v in p.items() if k!='planHash'}),'Curriculum hash changed')
    train={semantic_key(c['card']) for c in p['training']};held={semantic_key(c['card']) for c in p['heldout']}
    require(not held&(train|set(p['previousSeenRuleKeys'])),'Fresh rule contamination')
    for split,rows in [('training',p['training']),('heldout',p['heldout']),('source_readback',p['sourceReadback'])]:
        for c in rows:
            require(c['split']==split and equal(c['card']['left'],c['card']['right'])==c['card']['knownExactIdentity'],'Invalid rule or split')
            require(all(property_truth(c,r) in SIGNS+COUNTS for r in ROLES),'Invalid property truth')
            require((ideal_action(c)=='RETRACT')==(c['kind']=='counterexample'),'Witness is not decisive as declared')
    require({ideal_action(c) for c in p['training']}==set(ACTIONS),'Need both withdrawal and protection')


def focused_case(n,cases,target,every):
    require(target in cases and every>=2,'Invalid focus schedule')
    if n%every==0:return target
    rest=[c for c in cases if c['id']!=target['id']]
    cursor=n-(n+every-1)//every
    return rest[cursor%len(rest)] if rest else target


def property_prompt(c,role):
    d=c['card'];v=d['variable']
    if role.endswith('_sign'):
        side=role.split('_')[0]
        expr=re.sub(r'\b'+re.escape(v)+r'\b','('+str(c[side+'Point'])+')',d[side])
        return [dict(role='system',content='Classify the sign of ONE expression. Choose ZERO, POSITIVE, or NEGATIVE. No saved rule is supplied.'),dict(role='user',content=expr)]
    item=str(c['coefficient']) if role=='coefficient_count' else v
    return [dict(role='system',content='Count factors of the specified item in the given product. A square counts TWICE. Choose NONE, ONCE, or TWICE.'),
        dict(role='user',content='Product: '+d['left']+'\nItem to count: '+item)]


def memory_prompt(c,props=None):
    d=c['card'];text='Candidate saved ZIP, for every real '+d['variable']+':\n'+d['left']+' = '+d['right']
    if props is None:text+='\nNo checks have been recorded in this episode.'
    else:text+='\nYour own recorded checks:\nLeft at '+str(c['leftPoint'])+': '+props['left_sign']+'\nRight at '+str(c['rightPoint'])+': '+props['right_sign']
    system=('Use this evidence-commit interface. KEEP means retain this unverified candidate for now, not certify it. '
        'Without recorded evidence KEEP. After checks, RETRACT if opposite sign classes at the SAME input refute universality. '
        'Different inputs do not refute a rule. Equal signs do not prove equality. Choose KEEP or RETRACT.')
    return [dict(role='system',content=system),dict(role='user',content=text)]


def grounded(c,props):
    return c['leftPoint']==c['rightPoint'] and props['left_sign']!=props['right_sign'] and all(props[r]==property_truth(c,r) for r in ROLES[:2])


def return_table(c,role,props=None):
    if role in ROLES:
        choices=SIGNS if role.endswith('_sign') else COUNTS
        return {a:1. if a==property_truth(c,role) else -1. for a in choices}
    if role=='before':return {'KEEP':1.,'RETRACT':-1.}
    if grounded(c,props):return {'KEEP':-1.,'RETRACT':1.}
    if ideal_action(c)=='RETRACT':return {'KEEP':0.,'RETRACT':-1.}
    return {'KEEP':1.,'RETRACT':-1.}


def repair_prompt(c,props,action):
    require(action=='RETRACT','Replacement only after actual student withdrawal')
    text=memory_prompt(c,props)[1]['content']+'\nYour chosen action: '+action
    text+='\nYour own factor counts in the original left product:\nSpecified coefficient: '+props['coefficient_count']+'\nVariable: '+props['variable_count']
    text+='\nOriginal expression to collect: '+c['card']['left']
    return [dict(role='system',content='Write ONE collected algebraic expression for the original product, or ONE equality ending with that expression. Use * and **. Do not replace a variable with a constant. If unsure write SKIP. No correct replacement is supplied.'),dict(role='user',content=text)]


def prose_prompt(c,props,action,proposal=None):
    text=memory_prompt(c,props)[1]['content']+'\nYour actual memory action: '+action
    if proposal is not None:text+='\nYour own replacement proposal (not yet assumed correct):\n'+proposal
    return [dict(role='system',content='Write your own short revised ZIP note. Explain whether the recorded checks refute the old universal claim, and what you would retain or withdraw. Do not treat finite agreement as proof.'),dict(role='user',content=text)]
