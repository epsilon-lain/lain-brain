"""Explicit two-action policy; never recast a host action as student prose.

Only the new scalar policy parameters learn. Frozen pretrained representations
condition its USE/SUSPEND probabilities; verified TRAIN route utility supplies
the gradient. This is a different action interface and unconditional metric
from v10's free-text management, with a fresh uniform head as its baseline.
"""
import copy
import math
import random
from zip_summary_training_v8_core import (require, digest, seal, nominate,
    restore_head, candidate_cards, observation_messages, math_messages,
    audit_math, expected_pass, saved_choice, validate_entries)
from zip_weak_guidance_core import host_guide, validate_guide, guide_trial_eligible, management_messages

PROTOCOL = 'lain-zip-explicit-management-head-v11'
ACTIONS = ('USE', 'SUSPEND')
ARMS = ('learned_head_active_guide', 'same_head_initial_guide',
        'frozen_uniform_head_initial_guide', 'always_use', 'always_suspend')
STEPS = 48
LEARNING_RATE = 2.0
GENERATION_CAP = 28  # Eight cold originals, then at most 5 x 4 new objects.
FEATURE_CAP = 40    # Candidate batches: 2 warm cases + 3x2 validation + 2x4 heldout, and 8 math batches.


def numeric(value):
    return type(value) in (int, float) and math.isfinite(value)


def normalize(vectors):
    require(len(vectors) == 2 and len(vectors[0]) == len(vectors[1]) > 0,
            'Two nonempty equal-dimension management vectors required')
    result = []
    for vector in vectors:
        require(all(numeric(x) for x in vector), 'Nonfinite management feature')
        norm = math.sqrt(sum(x*x for x in vector))
        require(norm > 0, 'Zero management feature')
        result.append([x/norm for x in vector])
    return result


def new_head(dimension):
    require(type(dimension) is int and dimension > 0, 'Invalid management dimension')
    return dict(weights=[0.0]*dimension, bias=0.0)


def validate_head(head):
    require(set(head) == {'weights', 'bias'} and len(head['weights']) > 0 and
            all(numeric(x) for x in head['weights']) and numeric(head['bias']),
            'Invalid finite head state')


def representation(features):
    require(len(features)==2 and len(features[0])==len(features[1])>0 and
            all(numeric(x) for v in features for x in v), 'Invalid candidate representation')
    # Preserve contextual coordinates in both action-conditioned vectors.
    # Subtracting them would cancel much of the shared current-task signal.
    return list(features[0])+list(features[1])


def use_probability(head, features):
    validate_head(head)
    vector=representation(features)
    require(len(vector)==len(head['weights']), 'Feature/head mismatch')
    score = head['bias'] + sum(w*x for w,x in zip(head['weights'],vector))
    # Stable sigmoid, with no artificial probability floor or repaired action.
    return 1.0/(1.0+math.exp(-score)) if score >= 0 else math.exp(score)/(1.0+math.exp(score))


def utility(p_use, use, suspend):
    require(all(numeric(x) and 0 <= x <= 1 for x in (p_use,use,suspend)), 'Invalid route utility')
    return p_use*use+(1-p_use)*suspend


def update(head, case, features, learning_rate=LEARNING_RATE):
    require(case['task']['split'] == 'training', 'Heldout cannot train the head')
    require(numeric(learning_rate) and learning_rate > 0, 'Invalid learning rate')
    before = copy.deepcopy(head)
    p = use_probability(head, features)
    use, suspend = case['useExpected'], case['suspendExpected']
    utility(p,use,suspend)
    advantage = use-suspend
    gradient = advantage*p*(1-p)
    if abs(gradient) > 1e-12:
        head['weights'] = [w+learning_rate*gradient*x
                           for w,x in zip(head['weights'],representation(features))]
        head['bias'] += learning_rate*gradient
    return dict(beforeState=before, afterState=copy.deepcopy(head),
                updated=head != before, pUseBefore=p, pUseAfter=use_probability(head,features),
                useExpected=use, suspendExpected=suspend, signedUtilityDifference=advantage,
                expectedUtilityBefore=utility(p,use,suspend),
                expectedUtilityAfter=utility(use_probability(head,features),use,suspend),
                learningRate=learning_rate, optimizer='analytic expected-utility gradient ascent',
                currentTaskAnswersSuppliedToFeature=False, teacherCalls=0)


def action_messages(task, original_prompt, guide, action):
    """Preserve the actual pre-outcome prompt; change advice and action candidate.

    Program action names are explicit inputs to the binary head, never generated
    text. Family, split, current reward and current route checks are not inputs.
    """
    validate_guide(guide)
    require(action in ACTIONS and task['expression'] in original_prompt[-1]['content'],
            'Management source prompt is not bound to current task')
    messages = copy.deepcopy(original_prompt)
    locations = [i for i,m in enumerate(messages) if m['role']=='user' and
                 m['content'].startswith('Revisable guidance:\n')]
    require(len(locations)==1, 'Exactly one original guidance turn required')
    messages[locations[0]]['content'] = 'Revisable guidance:\n'+guide['text']
    messages.append(dict(role='user', content=(
        'Candidate executable action: '+action+'. '+
        ('Supply this summary to the current task.' if action=='USE' else
         'Keep this summary out of the current task; preserve its original for possible later use.')+
        '\nAssess this candidate action using the available past evidence.'+
        '\nCURRENT expression: '+task['expression'])))
    return messages


def head_decision(task, head, features, feature_id, guide, note_id, probabilities_override=None):
    p = use_probability(head,features) if probabilities_override is None else probabilities_override
    require(numeric(p) and 0 <= p <= 1, 'Invalid explicit action distribution')
    return seal(dict(id='management-'+digest(dict(task=task['id'],guide=guide['id'],
                     head=digest(head),p=p))[:20],taskId=task['id'],split=task['split'],
                     summaryZipId=note_id,guideId=guide['id'],managementFeatureId=feature_id,
                     probabilities={'USE':p,'SUSPEND':1-p},greedyAction='USE' if p>=.5 else 'SUSPEND',
                     parameterHash=digest(head),actionInterface='explicit learned two-action head',
                     programProvidesActionVocabulary=True,generatedStudentText=False,
                     nativeLanguageActionGeneration=False),'decisionHash')


def choose_guide(candidates, measurements, initial):
    validate_guide(initial)
    accepted=[]
    for guide in candidates:
        rows=[r for r in measurements if r['guideId']==guide['id']]
        require(len(rows)==2 and all(r['task']['split']=='training' for r in rows),
                'Guide selection requires exactly two TRAIN validation cases')
        deltas=[r['differenceFromInitialGuide'] for r in rows]
        if guide_trial_eligible(guide) and min(deltas)>=-1e-12 and sum(deltas)/2>1e-12:
            accepted.append((sum(deltas)/2,guide['id'],guide))
    return copy.deepcopy(max(accepted,key=lambda x:(x[0],x[1]))[2] if accepted else initial)


def summarize(objects):
    values={arm:sum(o['expectedPassByArm'][arm] for o in objects)/len(objects)
            if objects else None for arm in ARMS}
    def diff(a,b):return values[a]-values[b] if objects else None
    return dict(primaryMetric='unconditional verified-success route mass averaged over explicit management policy',
                oldNativeGreedyManagementMetricComparable=False,heldoutObjects=len(objects),
                expectedPassByArm=values,
                learnedVsUniformSameInitialGuide=diff(ARMS[1],ARMS[2]),
                activeVsInitialGuideSameHead=diff(ARMS[0],ARMS[1]),
                learnedVsAlwaysSuspend=diff(ARMS[0],ARMS[4]),
                learnedVsAlwaysUse=diff(ARMS[0],ARMS[3]),
                byObject=copy.deepcopy(objects),independentTrainingReplications=0,
                hostNominationOfSummary=True,autonomousRetrievalProved=False,
                semanticSelfAnalysisProved=False,statisticalSignificanceClaimed=False)


def run_course(cases, heldout, roots, bank, notes, initial_guide, candidates,
               action_feature, method_feature, ask, save, checkpoint, deadline, number):
    import time
    require(len(cases)==4 and all(c['task']['split']=='training' for c in cases),
            'Four verified source TRAIN cases required')
    require(len(heldout)==4 and all(t['split']=='heldout' for t in heldout), 'Four fresh heldout tasks required')
    require(len(candidates)==2 and all(not g['hostAuthored'] for g in candidates),
            'Use the two original student-written guidance candidates')
    validate_entries(bank['entries'],notes)
    def remaining():
        if time.monotonic()>=deadline():raise TimeoutError('Explicit-management phase deadline')
    for c in cases:save('training-case',dict(c,id=c['task']['id']))
    for g in [initial_guide]+candidates:save('guide-original',g)
    cached=[]
    for c in cases[:2]:
        remaining()
        f,fid=action_feature(c['task'],c['managementPrompt'],initial_guide)
        cached.append((f,fid))
    initial_head=new_head(len(representation(cached[0][0])));head=copy.deepcopy(initial_head)
    for i in range(STEPS):
        remaining();c=cases[i%2];f,fid=cached[i%2]
        step=update(head,c,f)
        save('head-step',seal(dict(step,id='head-step-'+str(i+1).zfill(3),
            opportunity=i+1,sourceTaskId=c['task']['id'],sourceFeatureId=fid,
            sourceCaseHash=digest(c),sourceRouteOriginals=c['sourceMathRecordIds'],
            trainingSplit='training'),'stepHash'))
    measurements=[]
    for c in cases[2:]:
        baseline=None
        for g in [initial_guide]+candidates:
            remaining();f,fid=action_feature(c['task'],c['managementPrompt'],g)
            p=use_probability(head,f);score=utility(p,c['useExpected'],c['suspendExpected'])
            if baseline is None:baseline=score
            row=seal(dict(id='guide-measure-'+digest(dict(task=c['task']['id'],guide=g['id']))[:20],
                task=c['task'],guideId=g['id'],sourceFeatureId=fid,pUse=p,
                measuredExpectedPass=score,differenceFromInitialGuide=score-baseline,
                headHash=digest(head),useExpected=c['useExpected'],suspendExpected=c['suspendExpected'],
                sourceMathRecordIds=c['sourceMathRecordIds'],heldoutFeedbackUsed=False,
                wholeGuideTruthCertified=False),'measurementHash')
            save('guide-measurement',row);measurements.append(row)
    active=choose_guide(candidates,measurements,initial_guide)
    checkpoint(head,initial_head,active,cases)
    objects=[];main=restore_head(bank['head'])
    for ordinal,task in enumerate(heldout,1):
        remaining();entry=nominate(task,bank['entries']);require(entry is not None,'Missing host-nominated source note')
        note=notes[entry['summaryZipId']];cards=candidate_cards(roots)
        old_prompt=management_messages(task,note,bank['history'],bank['statuses'].get(note['id'],'available'),initial_guide)
        guide_features={}
        for g in [initial_guide,active]:
            if g['id'] not in guide_features:
                guide_features[g['id']]=action_feature(task,old_prompt,g)
        decisions={}
        for arm,g,h,p in ((ARMS[0],active,head,None),(ARMS[1],initial_guide,head,None),
                          (ARMS[2],initial_guide,initial_head,None),(ARMS[3],initial_guide,head,1.),
                          (ARMS[4],initial_guide,head,0.)):
            f,fid=guide_features[g['id']];row=head_decision(task,h,f,fid,g,note['id'],p)
            row.pop('decisionHash')
            row=seal(dict(row,id=task['id']+'-'+arm,arm=arm),'decisionHash')
            save('management-decision',row);decisions[arm]=row
        # All management distributions precede observations and math outcomes.
        seed=11_500_000_000+number*100_000+ordinal*100
        observations={};vectors={};feature_ids={}
        for key,n in (('without',None),('withSummary',note)):
            remaining();phase='heldout_observation_'+('without_summary' if n is None else 'with_summary')
            row=ask(phase,observation_messages(task,roots,n),seed+1,mode='observation',task=task,summaryZipId=n['id'] if n else None)
            f,fid=method_feature(task,row,candidate_cards(roots,n))
            observations[key]=row;vectors[key]=f;feature_ids[key]=fid
        reader=restore_head(entry['head'])
        choices=[]
        for seed_index in range(3):
            uniform=random.Random(seed+20+seed_index).random()
            for arm in ARMS:
                use=uniform<decisions[arm]['probabilities']['USE'];key='withSummary' if use else 'without'
                choice=saved_choice(task,arm,vectors[key],candidate_cards(roots,note if use else None),
                    reader if use else main,seed+40+seed_index,seed_index+1,
                    observations[key]['recordId'],feature_ids[key])
                choice.update(managementAction='USE' if use else 'SUSPEND',managementUniform=uniform,
                    explicitHeadDecision=decisions[arm],managementGeneratedText=False)
                save('method-decision',choice);choices.append(choice)
        outcomes=[];math_ids=[]
        for index,card in enumerate(cards):
            remaining();row=ask('route_math',math_messages(task,card,roots),seed+2+index,mode='math',
                                 task=task,selectedCandidate=card)
            check=audit_math(task,row['studentOutput'],card)
            save('math-audit',dict(row, id=row['recordId'],check=check));outcomes.append(int(check['outcomePassed']))
            math_ids.append(row['recordId'])
        use=expected_pass(reader,vectors['withSummary'],outcomes)[0]
        suspend=expected_pass(main,vectors['without'],outcomes)[0]
        scores={a:utility(decisions[a]['probabilities']['USE'],use,suspend) for a in ARMS}
        sampled={a:sum(outcomes[c['policyOutput']['selectedIndex']] for c in choices if c['arm']==a) for a in ARMS}
        row=seal(dict(id=task['id'],task=task,phase='heldout',routeOutcomes=outcomes,
            sourceMathRecordIds=math_ids,summaryZipId=note['id'],activeGuideId=active['id'],
            expectedPassByArm=scores,useExpected=use,suspendExpected=suspend,
            managementProbabilities={a:decisions[a]['probabilities'] for a in ARMS},
            frozenManagementHeadHash=digest(head),initialHeadHash=digest(initial_head),
            observationIds={k:v['recordId'] for k,v in observations.items()},featureIds=feature_ids,
            sampledPassesByArm=sampled,trialsPerArm=3,
            sampledTrialsAreNotIndependentObjects=True,heldoutEnteredTraining=False),'objectHash')
        save('object',row);objects.append(row)
    return dict(head=head,initialHead=initial_head,activeGuide=active,objects=objects,
                summary=summarize(objects))
