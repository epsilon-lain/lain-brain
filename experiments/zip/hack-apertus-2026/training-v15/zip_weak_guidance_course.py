"""Fixed procedural warmup, genuine outcome learning, editable advice and frozen test."""
import copy
import time
from zip_weak_guidance_core import *

def run_course(plan,roots,initial,ask,feature,save,learn,warmup,checkpoint,load,store,deadline,number,training_only=False):
    validate_plan(plan);entries=copy.deepcopy(initial['entries']);history=copy.deepcopy(initial['history'])
    statuses=copy.deepcopy(initial['statuses']);active=copy.deepcopy(initial['guide']);original=copy.deepcopy(active)
    validate_guide(active);validate_history(history)
    main=restore_head(initial['head']);notes={e['summaryZipId']:load(e['summaryZipId']) for e in entries}
    validate_entries(entries,notes)
    objects=[];choices=[];feedback=[];probes=[];guides=[];guide_cases={};guide_result=None;guide_prompt_cache={}
    def remaining():
        if time.monotonic()>=(deadline() if callable(deadline) else deadline):raise TimeoutError('Weak-guide phase deadline')
    def cp(label):checkpoint(label,dict(entries=entries,history=history,statuses=statuses,head=initial['head'],guide=active))
    cp('initial')
    for stage in ('before_warm','after_warm'):
        for index,(expected,prompt) in enumerate(interface_probes(),1):
            remaining();row=ask('interface_probe',prompt,seed_for(number,0,index),mode='management',sampled=False,
                split='procedural_evaluation',probeStage=stage,probeExpectedAction=expected,managerSnapshot='current')
            action=parse_action(row['studentOutput']);check=dict(id=row['recordId'],stage=stage,expected=expected,
                action=action,valid=action is not None,correct=action==expected)
            save('scored',dict(row,check=check));save('interface-probe',check);probes.append(check)
        if stage=='before_warm':
            warmup(warm_lessons());cp('after-warm')
    for index,task in enumerate(plan['training'] if training_only else plan['training']+plan['heldout'],1):
        remaining();held=task['split']=='heldout'
        if held and index==5:cp('training-final')
        before=copy.deepcopy((entries,history,statuses,active)) if held else None
        entry=nominate(task,entries);require(entry is not None,'No source-qualified note for current task')
        note=load(entry['summaryZipId']);cards=candidate_cards(roots)
        rows={};vectors={};feature_ids={}
        for with_note in (False,True):
            key='withSummary' if with_note else 'without'
            row=ask(('heldout' if held else 'training')+'_observation_'+key,
                observation_messages(task,roots,note if with_note else None),seed_for(number,index,1),
                mode='observation',sampled=False,task=task,summaryZipId=note['id'] if with_note else None)
            save('scored',dict(row,check=dict(originalPreserved=True)))
            vec,fid=feature(task,row,candidate_cards(roots,note if with_note else None))
            rows[key]=row;vectors[key]=vec;feature_ids[key]=fid
        actions={};raw_choices={};trial_actions={}
        selected_arms=ARMS[:4] if held else ARMS[:1]
        for arm in selected_arms:
            guide=active if arm==ARMS[0] else original
            snap='warm' if arm==ARMS[2] else 'pre_round' if arm==ARMS[3] else 'current'
            prompt=management_messages(task,note,history,statuses.get(note['id'],'available'),guide)
            row=ask('summary_management',prompt,seed_for(number,index,10),mode='management',sampled=not held,
                task=task,summaryZipId=note['id'],guideId=guide['id'],arm=arm,managerSnapshot=snap)
            action=parse_action(row['studentOutput']);actions[arm]=action;raw_choices[arm]=row
            record=dict(id=row['recordId'],taskId=task['id'],arm=arm,guideId=guide['id'],action=action,
                validStudentAction=action is not None,invalidActionFallback='without_summary' if action is None else None)
            save('management-choice',record);save('scored',dict(row,check=record));choices.append(record)
        if not held and index in (3,4):
            # Advice candidates and their original-guide control share the
            # SAME frozen post-object-2 manager on both validation tasks.
            for guide in [original]+[g for g in guides if guide_trial_eligible(g)]:
                prompt=management_messages(task,note,history,statuses.get(note['id'],'available'),guide)
                row=ask('guide_validation',prompt,seed_for(number,index,12),mode='management',sampled=False,
                    task=task,summaryZipId=note['id'],guideId=guide['id'],managerSnapshot='proposal')
                action=parse_action(row['studentOutput']);trial_actions[guide['id']]=(action,row)
                guide_prompt_cache.setdefault(task['id'],{})[guide['id']]=copy.deepcopy(prompt)
                save('scored',dict(row,check=dict(action=action,validStudentAction=action is not None,
                    trainingOnlyAdviceTrial=True,currentOutcomesKnownBeforeChoice=False)))
        actions.update(always_use='USE',always_suspend='SUSPEND')
        decisions=[]
        for arm in (ARMS if held else ARMS[:1]):
            use=actions[arm]=='USE';key='withSummary' if use else 'without'
            head=restore_head(entry['head']) if use else main
            decision=saved_choice(task,arm,vectors[key],candidate_cards(roots,note if use else None),head,
                seed_for(number,index,11),1,rows[key]['recordId'],feature_ids[key])
            save('decision',decision);decisions.append(decision)
        routes=[]
        for card in cards:
            remaining();row=ask('route_math',math_messages(task,card,roots),seed_for(number,index,20),
                mode='math',sampled=False,task=task,selectedCandidate=copy.deepcopy(card),hostSpecifiedRoute=True)
            row=dict(row,check=audit_math(task,row['studentOutput'],card));save('scored',row);routes.append(row)
        outcomes=[int(r['check']['outcomePassed']) for r in routes];mids=[r['recordId'] for r in routes]
        use=expected_pass(restore_head(entry['head']),vectors['withSummary'],outcomes)[0]
        suspend=expected_pass(main,vectors['without'],outcomes)[0]
        obj=dict(id=task['id'],task=copy.deepcopy(task),phase='heldout' if held else 'training',
            routeOutcomes=outcomes,sourceMathRecordIds=mids,summaryZipId=note['id'],guideId=active['id'],
            actions=copy.deepcopy(actions),expectedPassByArm={a:use if actions[a]=='USE' else suspend
                for a in (ARMS if held else ARMS[:1])},useExpected=use,suspendExpected=suspend,
            featureIds=feature_ids,observationIds={k:r['recordId'] for k,r in rows.items()},
            allManagementChoicesPrecedeActualMath=True)
        save('object',obj);objects.append(obj)
        for decision in decisions:
            chosen=next(r for r in routes if r['selectedCandidate']['id']==decision['selectedCandidate']['id'])
            save('trial',dict(id=decision['id'],taskId=task['id'],phase=obj['phase'],arm=decision['arm'],
                outcomePassed=chosen['check']['outcomePassed'],sourceMathRecordId=chosen['recordId']))
        if not held:
            selected=next(r for r in routes if r['selectedCandidate']['id']==decisions[0]['selectedCandidate']['id'])
            action=actions[ARMS[0]]
            hr=history_record(task,note,action,use,suspend,outcomes,mids,feature_ids,obj['observationIds'],selected_route=selected)
            save('reuse-history',hr);history.append(hr)
            credit=management_credit(action,use,suspend)
            evidence=dict(id=raw_choices[ARMS[0]]['recordId'],taskId=task['id'],action=action,advantage=credit,
                useExpected=use,suspendExpected=suspend,historyRecordId=hr['id'],
                criterion='actual sampled TRAIN management-action gain; invalid response receives -0.1',heldoutFeedback=False)
            update=learn('management',[raw_choices[ARMS[0]]],[credit],evidence)
            save('management-feedback',dict(evidence,policyUpdate=update));feedback.append(evidence)
            if action is not None:statuses[note['id']]='active' if action=='USE' else 'suspended'
            if index==2:
                cp('proposal')
                for candidate in (1,2):
                    prompt=revision_prompt(active,objects,history)
                    row=ask('guidance_revision',prompt,seed_for(number,index,30+candidate),mode='guide',sampled=True,
                        split='training',sourceTaskIds=[o['id'] for o in objects],parentGuideId=active['id'],candidateIndex=candidate)
                    guide=make_guide(row,active);store(guide);save('guide',guide);guides.append(guide);guide_cases[guide['id']]=[]
                    save('scored',dict(row,check=dict(eligibleForTrainingTrial=guide_trial_eligible(guide),wholeProseTruthCertified=False)))
            if index in (3,4):
                baseline_action,baseline_row=trial_actions[original['id']]
                for guide in guides:
                    if not guide_trial_eligible(guide):continue
                    action,candidate_row=trial_actions[guide['id']]
                    case=dict(id=guide['id']+'-'+task['id'],guideId=guide['id'],taskId=task['id'],split='training',
                        candidateAction=action,baselineAction=baseline_action,
                        candidateExpected=use if action=='USE' else suspend,baselineExpected=use if baseline_action=='USE' else suspend,
                        candidateRecordId=candidate_row['recordId'],baselineRecordId=baseline_row['recordId'],
                        sourceMathRecordIds=mids,sourceFeatureIds=feature_ids,managerSnapshot='proposal')
                    guide_cases[guide['id']].append(case);save('guide-measurement',case)
            if index==4:
                # Revisit the SAME saved TRAIN prompts under the FINAL manager.
                # No new optimization, heldout feedback or observation repair.
                final_cases={g['id']:[] for g in guides}
                for old_task in plan['training'][2:]:
                    old_object=next(o for o in objects if o['id']==old_task['id'])
                    answers={}
                    for guide in [original]+[g for g in guides if guide_trial_eligible(g)]:
                        row=ask('guide_final_validation',guide_prompt_cache[old_task['id']][guide['id']],
                            seed_for(number,plan['training'].index(old_task)+1,13),mode='management',sampled=False,
                            task=old_task,guideId=guide['id'],managerSnapshot='current',finalTrainingDiagnostic=True)
                        action=parse_action(row['studentOutput']);answers[guide['id']]=(action,row)
                        save('scored',dict(row,check=dict(action=action,validStudentAction=action is not None,
                            savedTrainingPromptRevisited=True,heldoutFeedback=False)))
                    ba,br=answers[original['id']]
                    for guide in guides:
                        if not guide_trial_eligible(guide):continue
                        action,row=answers[guide['id']]
                        case=dict(id=guide['id']+'-'+old_task['id']+'-final',guideId=guide['id'],taskId=old_task['id'],split='training',
                            candidateAction=action,baselineAction=ba,
                            candidateExpected=old_object['useExpected'] if action=='USE' else old_object['suspendExpected'],
                            baselineExpected=old_object['useExpected'] if ba=='USE' else old_object['suspendExpected'],
                            candidateRecordId=row['recordId'],baselineRecordId=br['recordId'],
                            sourceMathRecordIds=old_object['sourceMathRecordIds'],sourceFeatureIds=old_object['featureIds'],
                            managerSnapshot='final_training_manager')
                        final_cases[guide['id']].append(case);save('guide-final-measurement',case)
                winner,credits=evaluate_guides(guides,final_cases)
                evidence=dict(id='guide-feedback',credits=credits,selectedGuideId=winner['id'] if winner else None,
                    validationTaskIds=[t['id'] for t in plan['training'][2:]],
                    rewardAndRetentionUseFinalTrainingManager=True,proposalTestsAreDiagnosticOnly=True,heldoutFeedback=False)
                update=learn('guide',[g['studentOriginal'] for g in guides],[c['advantage'] for c in credits],evidence)
                guide_result=dict(evidence,policyUpdate=update);save('guide-feedback',guide_result)
                if winner:active=copy.deepcopy(winner)
            cp('after-'+str(index))
        else:require((entries,history,statuses,active)==before,'Heldout changed a guide or learned bank')
    cp('training-final' if training_only else 'final')
    return dict(objects=objects,managementChoices=choices,managementFeedback=feedback,interfaceProbes=probes,
        guideCandidates=guides,guideFeedback=guide_result,activeGuide=active,initialGuide=original,
        bank=dict(entries=entries,history=history,statuses=statuses,head=initial['head'],guide=active))
