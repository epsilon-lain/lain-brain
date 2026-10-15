"""Precommitted curriculum and exact rational counterexamples, NEVER outcome-selected."""
import copy
import re
from rr_common import *
from rr_sources import equal
from zip_content_core import parse_expression,value_at

FAMILIES=('drop_variable','outer_coefficient','swapped_distribution')
POINTS=(0,1,2,-1)


def value(expression,variable,point):
    poly,_,names=parse_expression(expression)
    require(set(names)<=set([variable]),'Unexpected variable in the designed question')
    return str(value_at(poly,{variable:point}))


def semantic_key(card):
    # Alpha-renaming is not counted as a fresh mathematical rule.
    normalize=lambda s:re.sub(r'\b'+re.escape(card['variable'])+r'\b','X',s)
    return digest(dict(left=normalize(card['left']),right=normalize(card['right'])))


def variant(family,a,var,valid,split,parent):
    if family=='drop_variable':left=f'{a} * {var} * {var}';right=f'{a} * {var}**2' if valid else f'{a}**2'
    elif family=='outer_coefficient':
        term=f'({a} * {var} + 1)';left=f'1 * {term} + 2 * {term}'
        right=f'3 * {term}' if valid else f'{a} * {term} + 2 * {term}'
    else:
        left=f'3 * ({a} * {var} + 2)'
        right=f'{3*a} * {var} + 6' if valid else f'{3*a} * ({a} + {var})'
    card=dict(family=family,left=left,right=right,variable=var,split=split,
        provenance=dict(kind='designed_variant' if not valid else 'designed_correct_control',
            sourceRecordId=parent['provenance']['recordId'],studentAuthoredVariant=False),
        knownExactIdentity=valid)
    require(equal(left,right)==valid,'Template did not produce its declared mathematical status')
    card['id']='rule-'+digest(card)[:20];return card


def make_case(card,split,mispaired=False):
    observations=[]
    for point in POINTS:
        right_point=point+1 if mispaired else point
        o=dict(leftAssignment={card['variable']:point},rightAssignment={card['variable']:right_point},
            leftValue=value(card['left'],card['variable'],point),
            rightValue=value(card['right'],card['variable'],right_point),
            source='exact_rational_polynomial_observation')
        if not card['knownExactIdentity'] and not mispaired and o['leftValue']==o['rightValue']:continue
        observations.append(o)
        if len(observations)==3:break
    require(len(observations)==3,'Need three distinct relevant checks, chosen before model output')
    c=dict(card=copy.deepcopy(card),observations=observations,split=split,
           evidenceKind='different_inputs_control' if mispaired else 'matched_input_checks')
    c['id']='case-'+digest(c)[:20]
    return c


def expected(case,count=3):
    # A finite agreement does not prove a universal rule. KEEP means retain for now.
    # RETRACT means stop using the universal claim after a valid counterexample.
    return 'RETRACT' if any(o['leftAssignment']==o['rightAssignment'] and
        o['leftValue']!=o['rightValue'] for o in case['observations'][:count]) else 'KEEP'


def make_plan(sources,steps=64,quick=False,learning_rate=.0003):
    require(type(steps) is int and 1<=steps<=128,'Training step cap is 128')
    require(0<learning_rate<=.001,'Bounded reflection learning rate required')
    parents={c['family']:c for c in sources}
    train=[];held=[]
    train_constants=(2,3) if quick else (2,3,5,6,7,8)
    held_constants=(11,) if quick else (11,13)
    for split,constants,target in [('training',train_constants,train),('heldout',held_constants,held)]:
        for i,a in enumerate(constants):
            var=('p','q','r')[i%3] if split=='training' else ('s','t')[i%2]
            for family in FAMILIES:
                for valid in (False,True):target.append(make_case(variant(family,a,var,valid,split,parents[family]),split))
        guard_constants=constants[:1] if quick or split=='heldout' else constants[:2]
        for a in guard_constants:
            for family in FAMILIES:
                target.append(make_case(variant(family,a,'m',True,split,parents[family]),split,mispaired=True))
    readback=[make_case(c,'source_readback') for c in sources]
    plan=dict(protocol=PROTOCOL,training=train,heldout=held,sourceReadback=readback,
        recipe=dict(steps=steps,learningRate=learning_rate,quick=quick,rank=8,lastLayers=4,alpha=16,
            trainExploration=.5,evalExploration=0.,gradientClip=1.,batchCasesPerStep=2,
            candidateActions=['KEEP','RETRACT'],candidateTemperature=1.,rewardCorrect=1.,rewardWrong=-1.,
            rewardTargets='actual KEEP/RETRACT memory actions, not nice-sounding prose',
            oldRepairEnabledForAllReflection=True,oldMathWriterEnabledForReflection=False,
            oldBaseFrozen=True,oldMathWriterFrozen=True,oldRepairFrozen=True,
            newRewardedReflectionAdapterTrainable=True,zeroRewardAdapterUnchanged=True,
            mathWriterFrozenForFollowups=True,modelChoiceIsConstrainedNotFreeText=True,
            observationsProvidedByProgram=True,correctRulesAppearAsSeparateControls=True,
            wrongCardPromptsContainTeacherReplacement=False,teacherWrittenReplacementNote=False,
            actionScoreNormalization='mean token log probability including native EOS',
            actionScoringImplementation='two continuations batched; masked right padding',
            sourceReadbackIsPriorTRAINNotFreshHeldout=True,maxRawGenerations=96,maxDecisionRecords=768,
            checkpointSelection='last committed step; no heldout-score selection',
            statisticalSignificanceClaimed=False))
    plan['planHash']=digest(plan);validate_plan(plan);return plan


def validate_plan(plan):
    require(plan['protocol']==PROTOCOL and plan['planHash']==digest({k:v for k,v in plan.items() if k!='planHash'}),'Changed curriculum')
    train_keys=set();held_keys=set()
    for split,rows in [('training',plan['training']),('heldout',plan['heldout']),('source_readback',plan['sourceReadback'])]:
        for c in rows:
            require(c['split']==split and equal(c['card']['left'],c['card']['right'])==c['card']['knownExactIdentity'],
                'Case status/split changed')
            require(len(c['observations'])==3,'Exactly three precommitted exercises required')
            for o in c['observations']:
                var=c['card']['variable']
                require(o['leftValue']==value(c['card']['left'],var,o['leftAssignment'][var]) and
                    o['rightValue']==value(c['card']['right'],var,o['rightAssignment'][var]),'Incorrect witness facts')
            if split=='training':train_keys.add(semantic_key(c['card']))
            elif split=='heldout':held_keys.add(semantic_key(c['card']))
    require(not train_keys&held_keys,'Training and fresh rule identities overlap')
    require({expected(c) for c in plan['training']}=={'KEEP','RETRACT'},'Reward must protect correct rules too')


def card_view(card):
    return 'ZIP '+card['id']+' claims, for every real '+card['variable']+':\n'+card['left']+' = '+card['right']


def decision_prompt(case,count=3,self_computations=None):
    system=('Decide what to do with ONE saved universal ZIP. KEEP means retain it for now; '
        'agreement at finitely many inputs is not a proof. RETRACT means stop treating it '
        'as universally valid after a counterexample at the SAME input. Checks at DIFFERENT '
        'inputs do not refute an identity. Choose KEEP or RETRACT. No replacement formula is requested.')
    text=card_view(case['card'])+'\n\n'
    if self_computations is None:
        text+='Checked observations:\n'
        for i,o in enumerate(case['observations'][:count],1):
            text+=f"Check {i}: left at {o['leftAssignment']} = {o['leftValue']}; right at {o['rightAssignment']} = {o['rightValue']}.\n"
    else:
        text+='Your own independent computations, without an external verdict:\n'
        for i,row in enumerate(self_computations,1):
            text+=f"Check {i}, assignments {row['assignment']}:\nLeft computation:\n{row['leftRaw']}\nRight computation:\n{row['rightRaw']}\n"
    return [dict(role='system',content=system),dict(role='user',content=text)]


def reflection_prompt(case,action,count=3):
    p=decision_prompt(case,count)
    return [dict(role='system',content='Write a short revised ZIP in your own words, at most three sentences. '
        'Explain your chosen action, which claim you keep or withdraw as universal, and what remains uncertain. '
        'A replacement algebraic formula is optional. No reward or external decision is supplied.'),
        dict(role='user',content=p[1]['content']+'\nYour chosen memory action: '+action)]


def numerical_prompt(case,o,side):
    card=case['card'];assignment=o['leftAssignment'] if side=='left' else o['rightAssignment']
    expression=re.sub(r'\b'+re.escape(card['variable'])+r'\b','('+str(assignment[card['variable']])+')',card[side])
    return [dict(role='system',content='Calculate this ONE numerical expression. Finish with its value. '
        'A short equality chain is allowed. Do not use a saved rewriting note.'),dict(role='user',content=expression)]
