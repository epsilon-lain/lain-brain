"""Student use/suspend actions, TRAIN-only memory histories and revised notes.

Addressing by input shape is still host assistance. The sampled student action
controls actual context use; later verified TRAIN outcomes credit that action.
Math, representations and all inherited method-selection heads remain frozen.
"""
import copy
import re
import time
from zip_summary_training_v7_core import (BRANCHES, require, seal, digest, restore_head,
    candidate_cards, observation_messages, math_messages, audit_math, expected_pass,
    saved_choice, validate_summary as validate_previous_summary, event_record, _route_text)
from zip_summary_training_v7_scope import expression_shape, make_plan as previous_plan
from zip_summary_training_v6_audit import audit_summary

PROTOCOL='lain-zip-memory-management-training-v8'
TRAINING_OBJECTS=8
HELDOUT_OBJECTS=4
MAX_GENERATIONS=102
MAX_FEATURE_BATCHES=36
MAX_SUMMARY_TOKENS=128
SUMMARY_LEARNING_RATE=.003
MANAGEMENT_STEP_CAP=8
WRITING_STEP_CAP=2
REVISION_POSITIONS=(2,6)
ARMS=('learned_management','frozen_initial_management','always_use','always_suspend')
A=BRANCHES[0]


def seed_for(round_number,number,slot):
    require(type(round_number) is int and 1<=round_number<=1000 and type(number) is int and
        0<=number<=20 and type(slot) is int and 0<=slot<100,'Invalid fresh management seed')
    return 8_500_000_000+round_number*100_000+number*100+slot


def make_plan(excluded,roots):
    old=previous_plan(excluded,roots,1)
    training=[old['training'][i] for i in (0,1,2,7,4,5,6,3)]
    for i,t in enumerate(training,1):
        t['curriculumRole']='revision_source' if i in REVISION_POSITIONS else 'management_training'
    return dict(training=training,heldout=old['heldout'],curriculumStage=1,
        curriculumProtocol='fixed_related_training_management_and_revision-v8',
        currentOutcomesSuppliedBeforeManagement=False,managementAndWritingUseHeldoutFeedback=False)


def validate_plan(plan):
    require(len(plan['training'])==8 and len(plan['heldout'])==4 and
        len({t['semanticInputKey'] for t in plan['training']+plan['heldout']})==12 and
        all(t['split']=='training' for t in plan['training']) and
        all(t['split']=='heldout' for t in plan['heldout']), 'Fresh split or plan changed')
    for start in (0,4):
        require(len({expression_shape(t['expression']) for t in plan['training'][start:start+4]})==1,
            'Revision requires fixed related TRAIN inputs')


def validate_entries(entries,notes):
    require(len({e['summaryZipId'] for e in entries})==len(entries),'Duplicate available memory')
    for e in entries:
        require(e['entryHash']==digest({k:v for k,v in e.items() if k!='entryHash'}) and
            e['summaryZipId'] in notes and e['scopeShapes'] and e['branch']==A,
            'Memory entry binding or scope changed')
        validate_summary(notes[e['summaryZipId']]);restore_head(e['head'])


def nominate(task,entries):
    candidates=[e for e in entries if expression_shape(task['expression']) in e['scopeShapes']]
    return max(candidates,key=lambda e:(e['generation'],e['trainingGain'],e['summaryZipId'])) if candidates else None


def validate_history(rows):
    require(len({r['id'] for r in rows})==len(rows),'Duplicate reuse history')
    for r in rows:
        require(r['split']=='training' and r['historyHash']==digest({k:v for k,v in r.items() if k!='historyHash'}) and
            len(r['routeOutcomes'])==3 and all(type(v) is int and v in (0,1) for v in r['routeOutcomes']) and
            abs(r['useExpected']-r['suspendExpected']-r['useMinusSuspend'])<=1e-12,
            'Only unmodified TRAIN histories may enter student management/writing')
        selected=r.get('selectedRoute')
        if selected is not None:
            require(selected['mathRecordId'] in r['sourceMathRecordIds'] and
                selected['outcomePassed']==bool(r['routeOutcomes'][r['sourceMathRecordIds'].index(selected['mathRecordId'])]) and
                type(selected['wholeStudentResponse']) is str,'Changed selected student action in reuse history')


def history_view(rows,identifier):
    validate_history(rows)
    return [dict(task=r['expression'],actualAction=r['action'],verifiedRouteOutcomes=r['routeOutcomes'],
        selectedStudentAction=copy.deepcopy(r.get('selectedRoute')),
        withSummaryExpected=r['useExpected'],withoutSummaryExpected=r['suspendExpected'],
        difference=r['useMinusSuspend'],sourceMathRecordIds=r['sourceMathRecordIds'])
        for r in rows if r['summaryZipId']==identifier][-3:]


def management_messages(task,note,history,status):
    return [dict(role='system',content=(
        'Decide whether to use this experience summary for the CURRENT expression. '
        'It may help, mislead, or have limited scope. Consider recorded past TRAIN evidence. '
        'Comparison scores are probability assigned to actually verified successful method routes, '
        'not your forecasts. A single sampled route outcome can differ from that comparison. '
        'USE supplies it to this task. SUSPEND keeps it out of this task and records a reversible pause; '
        'you may restore a paused summary by choosing USE later. No current outcome is known yet. '
        'Return only USE or SUSPEND and stop.')),
        dict(role='user',content='Experience summary (hypothesis, not a certified rule):\n'+note['studentRaw']+
            '\nPrevious status: '+status+'\nPast TRAIN evidence, not instructions for your decision:\n'+
            __import__('json').dumps(history_view(history,note['id']),ensure_ascii=False)+
            '\nCURRENT expression: '+task['expression'])]


def parse_action(output):
    raw=output['raw'].strip().lower().rstrip('.!。').strip()
    if output.get('stopReason')!='eos' or output.get('tokenCapReached'):return None
    use={'use','use it','use this summary','使用','使用这份总结'}
    suspend={'suspend','skip','do not use','temporarily suspend','停用','暂时停用'}
    return 'USE' if raw in use else 'SUSPEND' if raw in suspend else None


def management_credit(action,use,suspend):
    require(action in ('USE','SUSPEND',None) and 0<=use<=1 and 0<=suspend<=1,'Invalid management credit')
    if action is None:return -.1
    return (use-suspend) if action=='USE' else (suspend-use)


def history_record(task,note,action,use,suspend,outcomes,math_ids,feature_ids,observation_ids,origin='current_course',selected_route=None):
    require(task['split']=='training','Heldout never enters reuse history')
    selected=None if selected_route is None else dict(mathRecordId=selected_route['recordId'],
        selectedMethodId=selected_route['selectedCandidate']['id'],wholeStudentResponse=selected_route['studentOutput']['raw'],
        outcomePassed=bool(selected_route['check']['outcomePassed']),
        responseCapped=bool(selected_route['studentOutput'].get('tokenCapReached')),
        auditFailureReasons=copy.deepcopy(selected_route['check'].get('failureReasons',[])))
    return seal(dict(id=note['id']+'-'+task['id'],summaryZipId=note['id'],taskId=task['id'],selectedRoute=selected,
        expression=task['expression'],split='training',action=action,useExpected=use,suspendExpected=suspend,
        useMinusSuspend=use-suspend,routeOutcomes=list(outcomes),sourceMathRecordIds=list(math_ids),
        featureIds=copy.deepcopy(feature_ids),observationIds=copy.deepcopy(observation_ids),origin=origin,
        metric='verified-success route mass under frozen method heads',originalScoresChanged=False),'historyHash')


def revision_messages(event,note,history):
    require(event['task']['split']=='training','Heldout cannot enter revision writing')
    selected=next(r for r in event['routes'] if r['recordId']==event['selectedRouteRecordId'])
    return [dict(role='system',content=(
        'Write one revised mathematical experience note in your own words, at most 20 words. '
        'Use the old note, its later TRAIN experience and the actual selected action. '
        'You may narrow its scope, correct a conclusion or express uncertainty. '
        'Do not claim an unsupported success. Return your revised note directly and stop.')),
        dict(role='user',content='Old note:\n'+note['studentRaw']+'\nIts later TRAIN evidence:\n'+
            __import__('json').dumps(history_view(history,note['id']),ensure_ascii=False)+
            '\nActual latest selected action:\n'+_route_text(selected)+
            '\nCurrent source expression: '+event['task']['expression'])]


def make_summary(row,event,previous,history):
    require(row['studentPrompt']==revision_messages(event,previous,history) and row['task']==event['task'] and
        row['phase']=='experience_summary' and row['branch']==A and row['eventHash']==event['eventHash'] and
        row['revisionOf']==previous['id'] and 1<=row['candidateIndex']<=3,'Revision binding changed')
    return seal(dict(summaryProtocol=PROTOCOL,id='summary-zip-'+digest(dict(source=row['recordId'],event=event['eventHash']))[:20],
        branch=A,candidateIndex=row['candidateIndex'],sourceRecordId=row['recordId'],sourceTaskId=event['task']['id'],
        studentRaw=row['studentOutput']['raw'],studentRawHash=digest(row['studentOutput']['raw']),
        studentOriginal=copy.deepcopy(row),event=copy.deepcopy(event),audit=audit_summary(row['studentOutput'],event),
        revisionOf=previous['id'],priorSummaryOriginal=copy.deepcopy(previous),reuseHistory=copy.deepcopy(history),
        hypothesisOnly=True,mathematicalRule=False,hostAuthoredStudentSummary=False),'summaryHash')


def validate_summary(note):
    if note.get('summaryProtocol')!=PROTOCOL:return validate_previous_summary(note)
    require(note['summaryHash']==digest({k:v for k,v in note.items() if k!='summaryHash'}),'Revision hash changed')
    validate_history(note['reuseHistory']);validate_summary(note['priorSummaryOriginal'])
    e=note['event']
    require(e==event_record(e['task'],e['observation'],e['decision'],e['routes']) and
        note==make_summary(note['studentOriginal'],e,note['priorSummaryOriginal'],note['reuseHistory']),
        'Revision original, history, audit or source changed')


def run_course(plan,roots,initial,ask,feature,save,learn,load,store,checkpoint,deadline,round_number):
    validate_plan(plan);entries=copy.deepcopy(initial['entries']);history=copy.deepcopy(initial['history'])
    status=copy.deepcopy(initial['statuses']);notes={e['summaryZipId']:load(e['summaryZipId']) for e in entries}
    validate_entries(entries,notes);validate_history(history)
    main=restore_head(initial['head']);pending=None;objects=[];decisions=[];revisions=[];management=[];revision_results=[]
    def remaining():
        if time.monotonic()>=deadline:raise TimeoutError('Deadline before management dependent action')
    def cp(label):checkpoint(label,entries,history,status)
    cp('initial')
    for number,task in enumerate(plan['training']+plan['heldout'],1):
        remaining();held=task['split']=='heldout'
        if held and number==9:cp('training-final')
        frozen=copy.deepcopy((entries,history,status)) if held else None
        entry=nominate(task,entries);note=load(entry['summaryZipId']) if entry else None
        cards=candidate_cards(roots)
        plain_row=ask(('heldout' if held else 'training')+'_observation_without_summary',observation_messages(task,roots),
            seed_for(round_number,number,1),mode='observation',sampled=False,task=task)
        save('scored',dict(plain_row,check=dict(originalPreserved=True)))
        plain,pfid=feature(task,plain_row,cards);cache={}
        def probe(n):
            if n['id'] not in cache:
                remaining();require(load(n['id'])==n,'Native ZIP original changed')
                row=ask(('heldout' if held else 'training')+'_observation_with_summary',observation_messages(task,roots,n),
                    seed_for(round_number,number,1),mode='observation',sampled=False,task=task,summaryZipId=n['id'])
                save('scored',dict(row,check=dict(originalPreserved=True)))
                vec,fid=feature(task,row,candidate_cards(roots,n));cache[n['id']]=(vec,fid,row)
            return cache[n['id']]
        noted,nfid,nrow=probe(note) if note else (plain,pfid,plain_row)
        actions={};raw_choices={}
        if note:
            prompt=management_messages(task,note,history,status.get(note['id'],'available'))
            for arm in (ARMS[:2] if held else ARMS[:1]):
                row=ask('summary_management',prompt,seed_for(round_number,number,10),mode='management',sampled=not held,
                    task=task,summaryZipId=note['id'],branch=A,frozenInitialManagement=arm==ARMS[1])
                action=parse_action(row['studentOutput']);actions[arm]=action;raw_choices[arm]=row
                d=dict(id=row['recordId'],taskId=task['id'],summaryZipId=note['id'],arm=arm,action=action,
                    validStudentAction=action is not None,invalidActionFallback='without_summary' if action is None else None,
                    studentActionControlsActualContext=True,hostRepairsStudentOutput=False,currentOutcomesKnown=False)
                save('management-choice',d);save('scored',dict(row,check=d));decisions.append(d)
        else:actions={a:None for a in ARMS[:2]}
        actions.update(always_use='USE' if note else None,always_suspend='SUSPEND')
        arms=ARMS if held else ARMS[:1]
        selections=[]
        for arm in arms:
            use=actions[arm]=='USE' and note is not None
            h=restore_head(entry['head']) if use else main;vec=noted if use else plain
            d=saved_choice(task,arm,vec,candidate_cards(roots,note if use else None),h,seed_for(round_number,number,11),1,
                nrow['recordId'] if use else plain_row['recordId'],nfid if use else pfid)
            save('decision',d);selections.append(d)
        trial_notes=[n for n in pending['notes'] if n['audit']['eligibleForTrial']] if pending and not held else []
        for n in trial_notes:probe(n)
        routes=[]
        for card in cards:
            remaining();row=ask('route_math',math_messages(task,card,roots),seed_for(round_number,number,20),
                mode='math',sampled=False,task=task,selectedCandidate=copy.deepcopy(card),hostSpecifiedRoute=True)
            row=dict(row,check=audit_math(task,row['studentOutput'],card));save('scored',row);routes.append(row)
        outcomes=[int(r['check']['outcomePassed']) for r in routes];mids=[r['recordId'] for r in routes]
        use_expected=expected_pass(restore_head(entry['head']),noted,outcomes)[0] if note else expected_pass(main,plain,outcomes)[0]
        skip_expected=expected_pass(main,plain,outcomes)[0]
        expected={a:use_expected if actions[a]=='USE' and note else skip_expected for a in arms}
        obj=dict(id=task['id'],task=copy.deepcopy(task),phase='heldout' if held else 'training',routeOutcomes=outcomes,
            sourceMathRecordIds=mids,summaryZipId=note['id'] if note else None,managementActions=actions,
            expectedPassByArm=expected,useExpected=use_expected,suspendExpected=skip_expected,
            allManagementAndMethodChoicesPrecedeRoutes=True,trainingUpdates=0 if held else None,
            contextUsed=bool(note and actions[ARMS[0]]=='USE'),
            featureIds=dict(without=pfid,withSummary=nfid),observationIds=dict(without=plain_row['recordId'],withSummary=nrow['recordId']))
        save('object',obj);objects.append(obj)
        for d in selections:
            chosen=next(r for r in routes if r['selectedCandidate']['id']==d['selectedCandidate']['id'])
            save('trial',dict(id=d['id'],taskId=task['id'],phase=obj['phase'],arm=d['arm'],
                outcomePassed=chosen['check']['outcomePassed'],sourceMathRecordId=chosen['recordId']))
        if not held and note:
            selected=next(r for r in routes if r['selectedCandidate']['id']==selections[0]['selectedCandidate']['id'])
            hr=history_record(task,note,actions[ARMS[0]],use_expected,skip_expected,outcomes,mids,obj['featureIds'],obj['observationIds'],selected_route=selected)
            save('reuse-history',hr);history.append(hr)
            action=actions[ARMS[0]]
            credit=management_credit(action,use_expected,skip_expected)
            feedback=dict(id=raw_choices[ARMS[0]]['recordId'],taskId=task['id'],summaryZipId=note['id'],action=action,
                advantage=credit,useExpected=use_expected,suspendExpected=skip_expected,historyRecordId=hr['id'],
                sourceManagementRecordId=raw_choices[ARMS[0]]['recordId'],sourceMathRecordIds=mids,
                criterion='measured TRAIN advantage of the actual sampled use/suspend action',heldoutFeedback=False)
            update=learn('management',[raw_choices[ARMS[0]]],[credit],feedback)
            feedback['policyUpdate']=update;save('management-feedback',feedback);management.append(feedback)
            status[note['id']]='active' if action=='USE' else 'suspended' if action=='SUSPEND' else status.get(note['id'],'available')
        if not held and pending:
            for n in trial_notes:
                vec,fid,row=cache[n['id']];value=expected_pass(restore_head(pending['entry']['head']),vec,outcomes)[0]
                baseline=use_expected if note and note['id']==pending['previous']['id'] else expected_pass(restore_head(pending['entry']['head']),probe(pending['previous'])[0],outcomes)[0]
                case=dict(id=n['id']+'-'+task['id'],summaryZipId=n['id'],task=copy.deepcopy(task),newExpected=value,
                    previousExpected=baseline,withoutExpected=skip_expected,gain=value-baseline,
                    featureId=fid,sourceMathRecordIds=mids,sourceWordRecordId=n['sourceRecordId'])
                pending['cases'][n['id']].append(case);save('revision-measurement',case)
            pending['seen'].append(task['id'])
            if len(pending['seen'])==2:
                credits=[];eligible=[]
                for n in pending['notes']:
                    cases=pending['cases'][n['id']]
                    if not n['audit']['eligibleForTrial']:adv=-.2;gain=None;retain=False
                    else:
                        gain=sum(c['gain'] for c in cases)/2
                        retain=all(c['gain']>1e-6 and c['newExpected']-c['withoutExpected']>1e-6 for c in cases)
                        adv=max(-1.,min(1.,gain)) if gain<0 else 0.
                        if retain:eligible.append((gain,-n['candidateIndex'],n))
                    credits.append(dict(summaryZipId=n['id'],advantage=adv,meanGain=gain,retained=retain,cases=copy.deepcopy(cases)))
                winner=max(eligible,key=lambda x:(x[0],x[1]))[2] if eligible else None
                if winner:next(c for c in credits if c['summaryZipId']==winner['id'])['advantage']=min(1.,max(x[0] for x in eligible))
                evidence=dict(id=pending['notes'][0]['id']+'-group',sourceTaskId=pending['notes'][0]['sourceTaskId'],
                    sourceSummaryZipIds=[n['id'] for n in pending['notes']],previousSummaryZipId=pending['previous']['id'],
                    credits=credits,selectedSummaryZipId=winner['id'] if winner else None,usesHeldoutFeedback=False)
                update=learn('summary',[n['studentOriginal'] for n in pending['notes']],[c['advantage'] for c in credits],evidence)
                evidence['policyUpdate']=update;save('revision-feedback',evidence);revision_results.append(evidence)
                if winner:
                    e=copy.deepcopy(pending['entry']);e.pop('entryHash');e.update(summaryZipId=winner['id'],
                        generation=e['generation']+1,trainingGain=next(c['meanGain'] for c in credits if c['summaryZipId']==winner['id']),
                        previousSummaryZipId=pending['previous']['id'],validationTaskIds=list(pending['seen']))
                    entries.append(seal(e,'entryHash'));status[winner['id']]='available'
                pending=None
        if not held and number in REVISION_POSITIONS and note:
            require(pending is None,'An earlier revision still awaits feedback')
            d=selections[0];obs=nrow if actions[ARMS[0]]=='USE' else plain_row
            event=event_record(task,obs,d,routes);new=[]
            for index in (1,2,3):
                row=ask('experience_summary',revision_messages(event,note,history),seed_for(round_number,number,30+index),
                    mode='summary',sampled=True,task=task,branch=A,eventHash=event['eventHash'],revisionOf=note['id'],candidateIndex=index)
                n=make_summary(row,event,note,history);store(n);notes[n['id']]=n
                save('summary',n);save('scored',dict(row,check=n['audit']));new.append(n);revisions.append(n)
            pending=dict(notes=new,entry=copy.deepcopy(entry),previous=note,cases={n['id']:[] for n in new},seen=[])
        if held:require((entries,history,status)==frozen,'Heldout altered histories, statuses or revised notes')
        else:cp('after-'+str(number))
    require(pending is None,'Incomplete revision feedback window')
    cp('final')
    return dict(entries=entries,history=history,statuses=status,objects=objects,managementChoices=decisions,
        managementFeedback=management,revisions=revisions,revisionFeedback=revision_results,heldoutStateUnchanged=True)


def summarize(course):
    held=[o for o in course.get('objects',[]) if o['phase']=='heldout'];count=len(held)
    means={a:sum(o['expectedPassByArm'][a] for o in held)/count if count else None for a in ARMS}
    def diff(a,b):return means[a]-means[b] if count else None
    feedback=course.get('managementFeedback',[]);choices=course.get('managementChoices',[])
    return dict(primaryMetric='verified-success method mass conditional on actual greedy management action',
        heldoutObjects=count,expectedPassByArm=means,managementVsFrozenInitial=diff(ARMS[0],ARMS[1]),
        managementVsAlwaysUse=diff(ARMS[0],ARMS[2]),managementVsAlwaysSuspend=diff(ARMS[0],ARMS[3]),
        managementTrainingResponses=len(feedback),verifiedTrainingManagementActions=sum(f['action'] is not None for f in feedback),
        validUseActions=sum(f['action']=='USE' for f in feedback),validSuspendActions=sum(f['action']=='SUSPEND' for f in feedback),
        invalidManagementResponses=sum(not c['validStudentAction'] for c in choices),
        managementPositiveCredits=sum(f['advantage']>1e-12 for f in feedback),managementNegativeCredits=sum(f['advantage']<-1e-12 for f in feedback),
        harmfulNotesSuspendedOnTraining=sum(f['action']=='SUSPEND' and f['useExpected']<f['suspendExpected']-1e-12 for f in feedback),
        usefulNotesSuspendedOnTraining=sum(f['action']=='SUSPEND' and f['useExpected']>f['suspendExpected']+1e-12 for f in feedback),
        heldoutContextUses=sum(o['contextUsed'] for o in held),studentWrittenRevisions=len(course.get('revisions',[])),
        activatedRevisions=sum(r['selectedSummaryZipId'] is not None for r in course.get('revisionFeedback',[])),
        sameFrozenMethodHeadsAndSharedActualMathRoutes=True,managementAdapterIndependentOfSummaryWriter=True,
        programNominatesAvailableZip=True,studentControlsUseAndReversiblePause=True,
        autonomousAllBankRetrievalProved=False,wholeProseTruthCertified=False,
        historiesContainTrainingOnly=True,heldoutFeedbackUsedForTraining=False,
        independentTrainingReplications=0,statisticalSignificanceClaimed=False,
        byObject=[dict(taskId=o['id'],expression=o['task']['expression'],summaryZipId=o['summaryZipId'],
            routeOutcomes=o['routeOutcomes'],actions=o['managementActions'],expectedPassByArm=o['expectedPassByArm']) for o in held])
