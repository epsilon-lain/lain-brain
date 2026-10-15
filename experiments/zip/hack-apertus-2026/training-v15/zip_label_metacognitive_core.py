"""Small v6 student-question pilot with atomic fresh-representation guards."""
import copy
import time
from collections import Counter

from zip_content_core import digest
from zip_label_grounded_core import (cards, observations_messages, revision_messages, version_label,
    expected_pass, saved_choice, math_messages, exact_instance, diagnostic)
from zip_label_feedback_audit import audit_math, PROTOCOL as SCORING_PROTOCOL
from zip_semantic_generation import NATURAL_LANGUAGE
from zip_label_metacognitive_checks import (require, fact_audit, word_credit, metric_frame,
    meta_messages, meta_audit, meta_gain, fresh_head_proposal, guard_still_holds, restore_head)

PROTOCOL='lain-zip-student-metacognitive-feedback-v6'
TOKENS=96
GENERATION_CAP=76
FEATURE_BATCH_CAP=50
ARMS=('metacognitive_learning','frozen_before_round','learned_with_old_cards','learned_without_meta_zip')

def seed_for(round_number,number,slot):
    require(type(round_number) is int and 1<=round_number<=1000 and
        type(number) is int and 0<=number<=100 and type(slot) is int and 0<=slot<100,'Invalid v6 seed slot')
    return 3_100_000_000+round_number*100_000+number*100+slot

def question_zip(row,audit,previous=None):
    return dict(id='meta-zip-'+digest(dict(source=row['recordId'],raw=row['studentOutput']['raw']))[:20],
        sourceRecordId=row['recordId'],studentRaw=row['studentOutput']['raw'],audit=copy.deepcopy(audit),
        parentZipId=previous['id'] if previous else None,mathematicalRule=False,
        questionAndPlanRemainHypotheses=True,quantitativeClaimVerified=audit['quantitativeClaimVerified'],
        eligibleForMeasuredTrial=audit['accepted'],committedAsPromptMetadata=False,
        originalTextRepaired=False,hostQuestionOrActionSupplied=False)

def observation_prompt(task,roots,labels,meta=None):
    prompt=observations_messages(task,roots,labels,NATURAL_LANGUAGE)
    if meta:
        require(meta['audit']['accepted'],'Only a verified numeric self-question ZIP can be trialed')
        # Insert before the current object, preserving the complete raw ZIP.
        current='\nCurrent object: '+task['expression']
        require(prompt[-1]['content'].endswith(current),'Current object must remain last')
        prompt[-1]['content']=prompt[-1]['content'][:-len(current)]+(
            '\nYour self-question ZIP (question and plan are hypotheses; use or question them):\n'+
            meta['studentRaw'])+current
    return prompt

def label_proposal(root,row,previous):
    version=version_label(root,row,previous,NATURAL_LANGUAGE)
    audit=fact_audit(row['studentOutput'],row['task'],root)
    eligible=version['noteFramingCheck']['complete'] and audit['positiveCreditEligible']
    version.update(boundedFactAudit=audit,eligibleForMeasuredTrial=eligible,
        activatedAsRetrievalMetadata=False,committedAsRetrievalMetadata=False,
        activeDescriptionRaw=row['studentOutput']['raw'] if eligible else previous['activeDescriptionRaw'],
        activationPolicy='complete bounded grounded assertions; unknown prose receives no positive credit',
        status='candidate_grounded_assertions' if eligible else 'inactive_'+audit['status'])
    return version

def measured_item(task,observation,vectors,fid,outcomes,math_ids):
    require(task['split']=='training' and len(outcomes)==3 and all(type(y) is int and y in (0,1) for y in outcomes),
        'Only three real training route outcomes can enter the buffer')
    return dict(task=copy.deepcopy(task),observation=copy.deepcopy(observation),features=copy.deepcopy(vectors),
        featureId=fid,outcomes=list(outcomes),mathRecordIds=list(math_ids),
        observationAudit=fact_audit(observation['studentOutput'],task))

def run_course(plan,roots,initial_head,initial_labels,anchors,source_frame,ask,features,save,
        learn_words,select_writer,snapshot_words,restore_words,checkpoint,deadline,round_number,
        baseline_pass=.5,initial_meta=None):
    if time.monotonic()>=deadline:raise TimeoutError('v6 deadline before student generation')
    require(len(plan['training'])==2 and len(plan['heldout'])==4 and len(anchors)==8,'v6 pilot split differs')
    require(all(r['task']['split']=='training' for r in anchors),'Source heldout cannot become replay or metrics')
    require(len({r['task']['id'] for r in anchors})==8,'Distinct source training anchors required')
    head=restore_head(copy.deepcopy(initial_head));control=restore_head(copy.deepcopy(initial_head))
    labels=copy.deepcopy(initial_labels);old_labels=copy.deepcopy(labels);root_before=copy.deepcopy(roots)
    old_meta=copy.deepcopy(initial_meta);meta=copy.deepcopy(old_meta)
    word_rows=[];audits=[];gains=[];new_items=[];revisions=[];objects=[]
    before_snapshot=snapshot_words();checkpoint('initial',head.state(),labels,baseline_pass,meta)
    save('metric',source_frame)
    self_row=ask('self_question_zip',meta_messages(source_frame,old_meta),seed_for(round_number,0,1),mode='meta',sampled=True)
    self_audit=meta_audit(self_row['studentOutput'],source_frame)
    proposed_meta=question_zip(self_row,self_audit,old_meta)
    save('scored',dict(self_row,check=self_audit));save('meta-zip',proposed_meta)
    if self_audit['accepted']:meta=proposed_meta
    # All seven sampled originals come from the same restored semantic policy.
    # Normal word credit and self-question credit remain separate trajectories.
    for number,task in enumerate(plan['training'],1):
        if time.monotonic()>=deadline:raise TimeoutError('v6 new training deadline')
        obs=ask('training_observations',observation_prompt(task,roots,old_labels,meta),
            seed_for(round_number,number,1),mode='semantic',sampled=True,task=task,metaZipId=meta['id'] if meta else None)
        oa=fact_audit(obs['studentOutput'],task);save('scored',dict(obs,check=oa))
        old_cards=cards(roots,old_labels,NATURAL_LANGUAGE)
        old_v,old_f=features(task,obs,old_cards)
        decision=saved_choice(task,ARMS[0],old_v,old_cards,head,seed_for(round_number,number,10),1,obs['recordId'],old_f)
        save('decision',decision)
        routes=[]
        for candidate in old_cards:
            row=ask('training_route_math',math_messages(task,candidate,roots),seed_for(round_number,number,20),
                mode='math',sampled=False,task=task,selectedCandidate=copy.deepcopy(candidate),
                hostSpecifiedRoute=True,arm='host_method_audit',autonomousToolUseClaimed=False)
            row=dict(row,check=audit_math(task,row['studentOutput'],candidate));save('scored',row);routes.append(row)
            instance=exact_instance(row)
            if instance:save('instance',instance)
            if not row['check']['outcomePassed']:save('failure',dict(row,id=row['recordId']))
        outcomes=[int(r['check']['outcomePassed']) for r in routes]
        word_rows.append(obs);audits.append(oa)
        old_expected=expected_pass(head,old_v,outcomes)[0];gains.append(old_expected-baseline_pass)
        versions=[];revision_rows=[];local_labels=copy.deepcopy(old_labels)
        # Both new objects propose independently from the same old label bank.
        # Last eligible proposal per root is the declared joint candidate bank.
        for j,root in enumerate(roots,1):
            route=next(r for r in routes if r['selectedCandidate']['id']==root['id'])
            row=ask('training_zip_label_revision',revision_messages(task,root,old_labels[root['id']],obs,route,NATURAL_LANGUAGE),
                seed_for(round_number,number,30+j),mode='semantic',sampled=True,task=task,rootId=root['id'],
                sourceMathRecordId=route['recordId'],previousLabelVersion=old_labels[root['id']]['id'])
            version=label_proposal(root,row,old_labels[root['id']]);versions.append(version);revision_rows.append(row)
            save('scored',dict(row,check=version));save('label-version',version);revisions.append(version)
            if version['eligibleForMeasuredTrial']:
                local_labels[root['id']]=version;labels[root['id']]=version
        candidate_v,candidate_f=features(task,obs,cards(roots,local_labels,NATURAL_LANGUAGE))
        delta=expected_pass(head,candidate_v,outcomes)[0]-old_expected
        word_rows+=revision_rows;audits +=[v['boundedFactAudit'] for v in versions];gains +=[delta,delta]
        item=measured_item(task,obs,old_v,old_f,outcomes,[r['recordId'] for r in routes]);new_items.append(item)
        selected=next(r for r in routes if r['selectedCandidate']['id']==decision['selectedCandidate']['id'])
        save('trial',dict(id=decision['id'],phase='training',arm=ARMS[0],taskId=task['id'],decisionId=decision['id'],
            sourceMathRecordId=selected['recordId'],outcomePassed=selected['check']['outcomePassed'],
            noExtraGenerationForPolicySample=True))
        obj=dict(id=task['id'],task=task,phase='training',sourceMathRecordIds=item['mathRecordIds'],
            routeOutcomes=outcomes,legacyRouteOutcomes=[int(r['check']['legacyOutcomePassed']) for r in routes],
            expectedPassBeforeOwnFeedback=old_expected,jointCardDelta=delta,
            observationRecordId=obs['recordId'],wordRecordIds=[obs['recordId']]+[r['recordId'] for r in revision_rows],
            oldFeatureId=old_f,candidateFeatureId=candidate_f,
            individualCardEffectsIsolated=False,mathematicalScoringProtocol=SCORING_PROTOCOL)
        save('object',obj);objects.append(obj)
    buffer=anchors+new_items
    require(len({r['task']['id'] for r in buffer})==10,'Training anchor/new-object overlap')
    def refresh(stage,bank,zip_note):
        result=[]
        for i,item in enumerate(buffer,1):
            task=item['task'];row=ask('guard_'+stage+'_observations',observation_prompt(task,roots,bank,zip_note),
                seed_for(round_number,20+i,1),mode='semantic',sampled=False,task=task,guardStage=stage,
                metaZipId=zip_note['id'] if zip_note else None)
            audit=fact_audit(row['studentOutput'],task);save('scored',dict(row,check=audit))
            vec,fid=features(task,row,cards(roots,bank,NATURAL_LANGUAGE))
            result.append(measured_item(task,row,vec,fid,item['outcomes'],item['mathRecordIds']))
        save('guard-buffer',dict(id=stage,rows=result,trainingOnly=True,freshAllObservations=True,
            originalMathematicalResponsesReused=True))
        return result
    select_writer('before');before=refresh('before',old_labels,old_meta)
    before_frame=metric_frame(before,control,'fresh-training-before');save('metric',before_frame)
    select_writer('learning')
    eligible_revisions={v['sourceRecordId'] for v in revisions if v['eligibleForMeasuredTrial']}
    advantages=[0. if r['phase']=='training_zip_label_revision' and
        r['recordId'] not in eligible_revisions and a['status']!='rejected' else word_credit(r,a,g)
        for r,a,g in zip(word_rows,audits,gains)]
    normal_update=learn_words(word_rows,advantages,'normal-words')
    save('update',dict(id='normal-words',sourceWordRecordIds=[r['recordId'] for r in word_rows],
        advantages=advantages,audits=audits,gains=gains,semanticUpdate=normal_update,
        observationCounterfactualIsolated=False,jointCardsOnlyCredit=True,
        unknownProseGetsNoPositiveCredit=True,heldoutIncluded=False))
    candidate=refresh('candidate',labels,meta)
    guard=fresh_head_proposal(head,before,candidate);save('guard',dict(id='candidate',**guard))
    candidate_head=restore_head(guard['afterState']);candidate_frame=metric_frame(candidate,candidate_head,'fresh-training-candidate')
    save('metric',candidate_frame);checkpoint('candidate',candidate_head.state(),labels,baseline_pass,meta)
    accepted=guard['accepted'];final_items=candidate;final_check=None;meta_update=None
    credit=meta_gain(self_audit,before_frame,candidate_frame) if accepted else 0.
    # This is transaction-associated metric feedback, not a causal isolation of
    # the plan from the simultaneous writer/cards/head changes.
    if accepted and abs(credit)>1e-12:
        meta_update=learn_words([self_row],[credit],'self-question')
        if meta_update.get('parameterChanged'):
            final_items=refresh('after-meta-update',labels,meta)
            final_check=guard_still_holds(control,candidate_head,before,final_items)
            save('guard',dict(id='after-meta-update',**final_check));accepted=final_check['accepted']
    save('update',dict(id='self-question',sourceWordRecordIds=[self_row['recordId']],advantage=credit,
        semanticUpdate=meta_update or dict(updated=False,parameterChanged=False,reason='zero_or_guard_rejected'),
        numericClaimAudit=self_audit,beforeMetricFrame=before_frame['id'],candidateMetricFrame=candidate_frame['id'],
        planEffectCausallyIsolated=False,feedbackFromSameTrainingObjects=True,heldoutIncluded=False))
    if accepted:
        head=candidate_head
        labels=copy.deepcopy(labels)
        for v in labels.values():
            if v.get('eligibleForMeasuredTrial'):
                v['committedAsRetrievalMetadata']=True;v['activatedAsRetrievalMetadata']=True
        if meta:meta=dict(meta,committedAsPromptMetadata=True)
    else:
        restore_words(before_snapshot);labels=copy.deepcopy(old_labels);meta=copy.deepcopy(old_meta);head=control
        final_items=before
    final_frame=metric_frame(final_items,head,'committed-training-final');save('metric',final_frame)
    transaction=dict(id='atomic-training-transaction',accepted=accepted,rolledBack=not accepted,
        rollbackCoversSemanticWriterLabelsMetaAndHead=True,sourceTaskIds=[r['task']['id'] for r in buffer],
        originalHead=initial_head,finalHead=head.state(),finalLabelIds={k:v['id'] for k,v in labels.items()},
        finalMetaZipId=meta['id'] if meta else None,freshFinalGuard=final_check,
        headProposal=guard,normalUpdateAttempted=bool(normal_update.get('updated')),
        metaUpdateAttempted=bool(meta_update and meta_update.get('updated')),
        trainingMetricBefore=before_frame,trainingMetricFinal=final_frame,
        metaEffectIsolated=False,unseenPerformanceGuaranteed=False)
    save('transaction',transaction)
    # Self-review reads committed training evidence only; future hypothesis is
    # saved for review, and does not become an untested current prompt.
    review=ask('self_review_zip',meta_messages(final_frame,meta),seed_for(round_number,0,2),mode='meta',sampled=False)
    review_audit=meta_audit(review['studentOutput'],final_frame);review_zip=question_zip(review,review_audit,meta)
    save('scored',dict(review,check=review_audit));save('meta-zip',review_zip)
    checkpoint('training-final',head.state(),labels,baseline_pass,meta)
    committed=head.state(),copy.deepcopy(labels),copy.deepcopy(meta)
    for n,task in enumerate(plan['heldout'],61):
        if time.monotonic()>=deadline:raise TimeoutError('v6 heldout deadline')
        rows={};vectors={};fids={}
        for arm,mode,bank,zip_note in ((ARMS[0],'learning',labels,meta),(ARMS[1],'before',old_labels,old_meta),
                (ARMS[3],'learning',labels,None)):
            select_writer(mode)
            row=ask('heldout_observations',observation_prompt(task,roots,bank,zip_note),seed_for(round_number,n,1),
                mode='semantic',sampled=False,task=task,arm=arm,metaZipId=zip_note['id'] if zip_note else None)
            save('scored',dict(row,check=fact_audit(row['studentOutput'],task)));rows[arm]=row
            vectors[arm],fids[arm]=features(task,row,cards(roots,bank,NATURAL_LANGUAGE))
        rows[ARMS[2]]=rows[ARMS[0]]
        vectors[ARMS[2]],fids[ARMS[2]]=features(task,rows[ARMS[0]],cards(roots,old_labels,NATURAL_LANGUAGE))
        cand={a:cards(roots,old_labels if a in (ARMS[1],ARMS[2]) else labels,NATURAL_LANGUAGE) for a in ARMS}
        decisions=[]
        for index in (1,2,3):
            for arm in ARMS:
                h=control if arm==ARMS[1] else head
                d=saved_choice(task,arm,vectors[arm],cand[arm],h,seed_for(round_number,n,50+index),index,
                    rows[arm]['recordId'],fids[arm]);save('decision',d);decisions.append(d)
        select_writer('learning');routes=[]
        for c in cand[ARMS[0]]:
            row=ask('heldout_route_math',math_messages(task,c,roots),seed_for(round_number,n,20),mode='math',sampled=False,
                task=task,selectedCandidate=copy.deepcopy(c),hostSpecifiedRoute=True,autonomousToolUseClaimed=False,
                arm='host_method_audit')
            row=dict(row,check=audit_math(task,row['studentOutput'],c));save('scored',row);routes.append(row)
            instance=exact_instance(row)
            if instance:save('instance',instance)
            if not row['check']['outcomePassed']:save('failure',dict(row,id=row['recordId']))
        outcomes=[int(r['check']['outcomePassed']) for r in routes];expectations={};probs={}
        for arm in ARMS:
            expectations[arm],probs[arm]=expected_pass(control if arm==ARMS[1] else head,vectors[arm],outcomes)
        for d in decisions:
            r=next(r for r in routes if r['selectedCandidate']['id']==d['selectedCandidate']['id'])
            save('trial',dict(id=d['id'],phase='heldout',arm=d['arm'],taskId=task['id'],seedIndex=d['seedIndex'],
                decisionId=d['id'],sourceMathRecordId=r['recordId'],outcomePassed=r['check']['outcomePassed'],
                noExtraGenerationForPolicySample=True))
        obj=dict(id=task['id'],task=task,phase='heldout',routeOutcomes=outcomes,
            legacyRouteOutcomes=[int(r['check']['legacyOutcomePassed']) for r in routes],
            sourceMathRecordIds=[r['recordId'] for r in routes],expectedPassByArm=expectations,probabilitiesByArm=probs,
            featureIdsByArm=fids,observationRecordIdsByArm={a:r['recordId'] for a,r in rows.items()},
            observationTextByArm={a:r['studentOutput']['raw'] for a,r in rows.items()},
            expectedDifference=expectations[ARMS[0]]-expectations[ARMS[1]],
            cardOnlyAblationDifference=expectations[ARMS[0]]-expectations[ARMS[2]],
            metaConditionedObservationDifference=expectations[ARMS[0]]-expectations[ARMS[3]],
            allChoicesSavedBeforeRoutes=True,seedTrialsNotIndependentObjects=True,trainingUpdates=0)
        save('object',obj);objects.append(obj)
        require((head.state(),labels,meta)==committed and roots==root_before,'Heldout learned state changed')
    select_writer('learning');checkpoint('final',head.state(),labels,baseline_pass,meta)
    return dict(finalHead=head.state(),finalLabels=labels,finalMetaZip=meta,selfReviewZip=review_zip,
        transaction=transaction,objects=objects,finalTrainingFrame=final_frame,
        semanticUpdateAttempts=int(bool(normal_update.get('updated')))+int(bool(meta_update and meta_update.get('updated'))))

def summarize(objects,trials):
    held=[r for r in objects if r['phase']=='heldout']
    def group(rows):
        n=len(rows)
        means={a:sum(r['expectedPassByArm'][a] for r in rows)/n if n else None for a in ARMS}
        return dict(objects=n,expectedPassByArm=means,
            meanExpectedDifference=means[ARMS[0]]-means[ARMS[1]] if n else None,
            cardOnlyAblationDifference=means[ARMS[0]]-means[ARMS[2]] if n else None,
            metaConditionedObservationDifference=means[ARMS[0]]-means[ARMS[3]] if n else None)
    return dict(primaryMetric='probability mass on all actually verified successful method routes',heldout=group(held),
        heldoutByFamily={f:group([r for r in held if r['task']['family']==f]) for f in ('same_factor','product_of_sum')},
        sampledHeldoutOutcomesByArm={a:dict(trials=sum(t['phase']=='heldout' and t['arm']==a for t in trials),
            passes=sum(t['phase']=='heldout' and t['arm']==a and t['outcomePassed'] for t in trials)) for a in ARMS},
        heldoutTopChoiceKindsByArm={a:dict(Counter(('direct','combine','distribute')[
            max(range(3),key=r['probabilitiesByArm'][a].__getitem__)] for r in held)) for a in ARMS},
        seedSamplesNotIndependentObjects=True,independentTrainingReplications=0,
        quantitativeSelfReportValidationIsNotWholePlanCertification=True,planEffectCausallyIsolatedDuringTraining=False,
        unseenPerformanceGuaranteed=False,statisticalSignificanceClaimed=False,fullMetacognitiveAbilityProved=False)
