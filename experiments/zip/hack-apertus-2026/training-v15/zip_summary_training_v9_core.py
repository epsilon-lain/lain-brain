"""Original v8 algorithm, with a TRAIN-only audit boundary."""
from zip_summary_training_v8_core import *

def run_course(plan,roots,initial,ask,feature,save,learn,load,store,checkpoint,deadline,round_number,training_only=False):
    validate_plan(plan);entries=copy.deepcopy(initial['entries']);history=copy.deepcopy(initial['history'])
    status=copy.deepcopy(initial['statuses']);notes={e['summaryZipId']:load(e['summaryZipId']) for e in entries}
    validate_entries(entries,notes);validate_history(history)
    main=restore_head(initial['head']);pending=None;objects=[];decisions=[];revisions=[];management=[];revision_results=[]
    def remaining():
        if time.monotonic()>=(deadline() if callable(deadline) else deadline):raise TimeoutError('Deadline before management dependent action')
    def cp(label):checkpoint(label,entries,history,status)
    cp('initial')
    for number,task in enumerate(plan['training'] if training_only else plan['training']+plan['heldout'],1):
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
    cp('training-final' if training_only else 'final')
    return dict(entries=entries,history=history,statuses=status,objects=objects,managementChoices=decisions,
        managementFeedback=management,revisions=revisions,revisionFeedback=revision_results,heldoutStateUnchanged=True)

