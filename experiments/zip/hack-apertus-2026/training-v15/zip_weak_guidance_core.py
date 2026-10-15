"""Editable text scaffolds; immutable action execution and mathematical audit."""
import copy
import math
import time
from zip_summary_training_v8_core import (require,seal,digest,A,BRANCHES,nominate,validate_entries,
    validate_history,history_record,management_credit,parse_action,candidate_cards,observation_messages,
    math_messages,audit_math,expected_pass,saved_choice,restore_head)
from zip_summary_training_v7_scope import make_plan as old_plan
from zip_label_grounded_checks import note_audit

PROTOCOL='lain-zip-editable-weak-guidance-training-v10'
ARMS=('learned_manager_active_guide','same_manager_initial_guide','warm_only_initial_guide',
    'frozen_before_round_initial_guide','always_use','always_suspend')
WARM_STEPS=16
WARM_LR=.002
MAX_GENERATIONS=86
MAX_FEATURE_BATCHES=16
INITIAL_TEXT=(
    'Review the current task before deciding. Treat experience summaries as hypotheses. '
    'Consult relevant recorded evidence; distinguish observed outcomes from explanations. '
    'Use a summary when your analysis supports using it; otherwise pause it for this task. '
    'A pause is reversible when context or evidence changes. '
    'After feedback, reconsider this guidance and propose a better version if useful.')

def seed_for(number,task_number,slot):
    require(type(number) is int and 1<=number<=1000 and 0<=task_number<=12 and 0<=slot<100,'Weak-guide seed bounds')
    return 9_700_000_000+number*100_000+task_number*100+slot

def host_guide():
    return seal(dict(id='weak-guide-initial',text=INITIAL_TEXT,parentId=None,hostAuthored=True,
        hypothesisOnly=True,studentOriginal=None),'guideHash')

def validate_guide(guide):
    require(guide['guideHash']==digest({k:v for k,v in guide.items() if k!='guideHash'}) and
        type(guide['text']) is str and guide['text'].strip() and guide['hypothesisOnly'] is True,'Changed guide original')
    if not guide['hostAuthored']:
        row=guide['studentOriginal'];value=row['studentOutput']
        require(row['phase']=='guidance_revision' and row['split']=='training' and
            value['raw']==guide['text'] and row['parentGuideId']==guide['parentId'] and
            value['sampled'] is True and value['originalTextRepaired'] is False,'Changed student guide binding')

def guide_trial_eligible(guide):
    validate_guide(guide)
    if guide['hostAuthored']:return True
    value=guide['studentOriginal']['studentOutput']
    return (value['stopReason']=='eos' and not value.get('tokenCapReached') and
        1<=len(guide['text'].split())<=80 and not note_audit(guide['text'])['containsDisprovedWrittenEquality'])

def make_guide(row,parent):
    return seal(dict(id='weak-guide-'+digest(row)[:20],text=row['studentOutput']['raw'],parentId=parent['id'],
        hostAuthored=False,hypothesisOnly=True,studentOriginal=copy.deepcopy(row)),'guideHash')

def make_plan(excluded,roots):
    old=old_plan(excluded,roots,1)
    return dict(training=[old['training'][i] for i in (0,4,1,5)],heldout=old['heldout'],
        protocol=PROTOCOL,guideProposalAfterTrainingObject=2,guideValidationPositions=[3,4])

def validate_plan(plan):
    train=plan['training'];held=plan['heldout']
    require(len(train)==len(held)==4 and len({t['semanticInputKey'] for t in train+held})==8 and
        all(t['split']=='training' for t in train) and all(t['split']=='heldout' for t in held), 'Weak-guide split changed')

def history_text(history,identifier):
    validate_history(history);parts=[]
    for h in [h for h in history if h['summaryZipId']==identifier][-3:]:
        selected=h.get('selectedRoute')
        parts.append('TRAIN task: '+h['expression']+'\nRecorded action: '+str(h['action'])+
            '\nVerified route outcomes: '+str(h['routeOutcomes'])+
            '\nWith-summary / without-summary successful-route probability: '+str(h['useExpected'])+' / '+str(h['suspendExpected'])+
            ('\nActual selected student response: '+selected['wholeStudentResponse'] if selected else ''))
    return '\n\n'.join(parts) or 'No matching recorded TRAIN history.'

def management_messages(task,note,history,status,guide):
    validate_guide(guide)
    return [dict(role='system',content=(
        'Select an actual summary-management action for the current task. '
        'USE puts this summary into the task context. SUSPEND keeps it out for this task and can be reversed. '
        'The guidance below is revisable advice, not a certified rule. '
        'Recorded probabilities concern actually verified successful method routes, not forecasts. '
        'No current outcome is available. Your answer is the action, not a mathematical solution.')),
        dict(role='user',content='Revisable guidance:\n'+guide['text']),
        dict(role='user',content='Experience summary (hypothesis):\n'+note['studentRaw']+
            '\nPrevious status: '+status+'\nRecorded TRAIN evidence:\n'+history_text(history,note['id'])),
        dict(role='user',content='CURRENT task: '+task['expression']+'\nChoose for this task. Return only USE or SUSPEND, then stop.')]

def procedural_prompt(command):
    return [dict(role='system',content=(
        'Encode the action already specified by an external caller. '
        'USE means include a summary. SUSPEND means keep it out for this task. '
        'This exercise teaches action spelling and stopping, not whether a real summary is useful.')),
        dict(role='user',content=command+'\nReturn only the corresponding action word, then stop.')]

def warm_lessons():
    forms=[('The caller selected USE.','The caller selected SUSPEND.'),
        ('Encode the specified action USE.','Encode the specified action SUSPEND.'),
        ('The requested operation includes the summary.','The requested operation keeps the summary out.'),
        ('Represent the supplied command USE.','Represent the supplied command SUSPEND.')]
    return [dict(id='procedure-'+str(i)+'-'+a,prompt=procedural_prompt(text),target=a,
        split='procedural_training',labelAuthor='host_procedural_encoding_only',hostChoosesCurrentSummaryUse=False)
        for i,pair in enumerate(forms,1) for a,text in zip(('USE','SUSPEND'),pair)]

def warm_schedule(lessons):
    require(lessons==warm_lessons(),'Changed balanced procedural lesson recipe')
    return [[lessons[(i%4)*2],lessons[(i%4)*2+1]] for i in range(WARM_STEPS)]

def interface_probes():
    return [('USE',procedural_prompt('Translate the supplied operation: include the summary in the context.')),
        ('SUSPEND',procedural_prompt('Translate the supplied operation: leave the summary outside the context.'))]

def revision_prompt(guide,objects,history):
    require(len(objects)==2 and all(o['phase']=='training' for o in objects),'Guide proposal sees TRAIN only')
    facts=[dict(task=o['task']['expression'],action=o['actions'][ARMS[0]],
        withSummary=o['useExpected'],withoutSummary=o['suspendExpected'],verifiedOutcomes=o['routeOutcomes']) for o in objects]
    return [dict(role='system',content=(
        'You may replace the entire advice below with your own better guidance for later summary management. '
        'Write one short paragraph, preferably under 40 words. Do not copy the history or solve mathematics. '
        'This is a hypothesis; later TRAIN tasks will test it. The executable actions remain USE and SUSPEND.')),
        dict(role='user',content='Current revisable advice:\n'+guide['text']+'\nActual TRAIN feedback:\n'+__import__('json').dumps(facts)),
        dict(role='user',content='Write your replacement guidance now and stop.')]

def evaluate_guides(candidates,cases):
    rows=[];eligible=[]
    for index,guide in enumerate(candidates):
        data=cases[guide['id']];valid=guide_trial_eligible(guide)
        require((not valid and not data) or (valid and len(data)==2 and all(c['split']=='training' for c in data)),
            'Guide reward requires two later TRAIN tests')
        if not valid:adv=-.2;gain=None;retain=False
        else:
            gain=sum(c['candidateExpected']-c['baselineExpected'] for c in data)/2
            retain=all(c['candidateAction'] is not None and
                c['candidateExpected']>=c['baselineExpected']-1e-12 for c in data) and gain>1e-6
            adv=max(-1.,min(0.,gain))
            if all(c['candidateAction'] is None for c in data):adv=min(adv,-.1)
            if retain:eligible.append((gain,-index,guide))
        rows.append(dict(guideId=guide['id'],advantage=adv,meanGain=gain,retained=retain,cases=copy.deepcopy(data)))
    winner=max(eligible,key=lambda item:(item[0],item[1]))[2] if eligible else None
    if winner:next(r for r in rows if r['guideId']==winner['id'])['advantage']=min(1.,max(e[0] for e in eligible))
    return winner,rows

def summarize(course):
    held=[o for o in course.get('objects',[]) if o['phase']=='heldout'];n=len(held)
    means={arm:sum(o['expectedPassByArm'][arm] for o in held)/n if n else None for arm in ARMS}
    actions={arm:[o['actions'][arm] for o in held] for arm in ARMS[:4]}
    def diff(a,b):return means[a]-means[b] if n else None
    return dict(primaryMetric='verified-success route mass conditional on actual greedy management action',heldoutObjects=n,
        expectedPassByArm=means,activeGuideVsInitialGuideSameManager=diff(ARMS[0],ARMS[1]),
        outcomeTrainingVsWarmOnlySameInitialGuide=diff(ARMS[1],ARMS[2]),
        warmOnlyVsFrozenBeforeRoundSameInitialGuide=diff(ARMS[2],ARMS[3]),
        learnedManagementVsAlwaysUse=diff(ARMS[0],ARMS[4]),learnedManagementVsAlwaysSuspend=diff(ARMS[0],ARMS[5]),
        validHeldoutActionsByArm={a:sum(x is not None for x in values) for a,values in actions.items()},
        heldoutUseActionsByArm={a:sum(x=='USE' for x in values) for a,values in actions.items()},
        heldoutSuspendActionsByArm={a:sum(x=='SUSPEND' for x in values) for a,values in actions.items()},
        invalidResponseFallbackIsNotStudentSuspension=True,guideCandidates=len(course.get('guideCandidates',[])),
        activatedStudentGuide=course.get('activeGuide',{}).get('hostAuthored') is False,
        guidanceWholeProseTruthCertified=False,heldoutUsedForGuideSelection=False,
        hostSupervisedProceduralEncoding=True,hostChoosesRealTaskManagementAction=False,
        programNominatesAvailableZip=True,autonomousAllBankRetrievalProved=False,
        independentTrainingReplications=0,statisticalSignificanceClaimed=False,byObject=held)
