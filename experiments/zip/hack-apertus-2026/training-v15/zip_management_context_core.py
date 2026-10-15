"""One preregistered continuation: eight fresh TRAIN and eight heldout objects.

Continue the actual v11 conditional head. An equally trained bias-only head
tests whether utility gains exceed simply using summaries less frequently.
No language-model, method-head, guide, summary or heldout updates occur.
"""
import copy
import math
import random
import time
from zip_management_head_core import *
from zip_summary_training_v7_scope import make_plan as old_plan
from object_choice_core import object_key

PROTOCOL = 'lain-zip-contextual-management-continuation-v12'
ARMS = ('continued_context_head', 'frozen_before_round_context_head',
        'matched_trained_global_probability', 'frozen_uniform_policy',
        'always_use', 'always_suspend')
STEPS = 48
GENERATION_CAP = 88
FEATURE_CAP = 52


def make_fixed_plan(excluded, roots):
    first = old_plan(set(excluded), roots, 1)
    seen = set(excluded) | {t['semanticInputKey'] for t in first['training'] + first['heldout']}
    second = old_plan(seen, roots, 1)
    train = [copy.deepcopy(first['training'][i]) for i in (0, 1, 2, 7, 4, 5, 6, 3)]
    for t in train:t['curriculumRole'] = 'management_training'
    held = copy.deepcopy(first['heldout'] + second['heldout'])
    value = dict(protocol=PROTOCOL, training=train, heldout=held,
        trainingObjects=8, heldoutObjects=8, predeterminedBeforeGeneration=True,
        outcomeBasedTaskSelection=False, hostStructuralSummaryNomination=True,
        hiddenFamilyLabelsNotSuppliedToStudent=True, trainingSeedNamespace=12500000000,
        heldoutSeedNamespace=12600000000, managementStepsPerPolicy=STEPS,
        globalInitialization='mean frozen-source probability on fresh TRAIN features before updates',
        globalControlUsesHeldoutProbabilities=False, guideRevisionTraining=False)
    validate_fixed_plan(value, excluded)
    return value


def validate_fixed_plan(plan, excluded=()):
    require(plan['protocol']==PROTOCOL and len(plan['training'])==len(plan['heldout'])==8,
            'Fixed eight TRAIN/eight heldout plan required')
    all_tasks=plan['training']+plan['heldout'];keys=[];ids=[]
    for split,rows in (('training',plan['training']),('heldout',plan['heldout'])):
        require(all(t['split']==split and t['semanticInputKey']==object_key(t['expression']) for t in rows),
                'Changed plan split or semantic input')
        require(sum(t['family']=='same_factor' for t in rows)==4 and
                sum(t['family']=='product_of_sum' for t in rows)==4,'Fixed structure counts changed')
        keys += [t['semanticInputKey'] for t in rows];ids += [t['id'] for t in rows]
    require(len(set(keys))==len(set(ids))==16 and not set(keys)&set(excluded),
            'Repeated current or previously planned input')


def global_probability(control):
    require(set(control)=={'bias'} and numeric(control['bias']), 'Invalid global probability head')
    b=control['bias']
    return 1/(1+math.exp(-b)) if b>=0 else math.exp(b)/(1+math.exp(b))


def new_global(probability):
    require(numeric(probability) and 0<probability<1, 'Finite nondegenerate TRAIN initial probability required')
    return dict(bias=math.log(probability)-math.log1p(-probability))


def update_global(control,case,learning_rate=LEARNING_RATE):
    require(case['task']['split']=='training','Heldout cannot train global policy')
    require(numeric(learning_rate) and learning_rate>0,'Invalid global learning rate')
    before=copy.deepcopy(control);p=global_probability(control)
    use,suspend=case['useExpected'],case['suspendExpected'];utility(p,use,suspend)
    # The conditional score's gradient norm squared is 1 + ||concat(f)||^2 = 3.
    # Apply that same effective scalar step to the bias-only policy, so it is
    # not penalized just because it has one coordinate instead of normalized
    # candidate coordinates plus a bias. This factor is fixed before outcomes.
    multiplier=3.0
    gradient=(use-suspend)*p*(1-p)
    if abs(gradient)>1e-12:control['bias']+=learning_rate*multiplier*gradient
    after_p=global_probability(control)
    return dict(beforeState=before,afterState=copy.deepcopy(control),updated=control!=before,
        pUseBefore=p,pUseAfter=after_p,useExpected=use,suspendExpected=suspend,
        signedUtilityDifference=use-suspend,learningRate=learning_rate,
        effectiveScoreLearningRate=learning_rate*multiplier,fixedGradientNormMultiplier=multiplier,
        expectedUtilityBefore=utility(p,use,suspend),expectedUtilityAfter=utility(after_p,use,suspend),
        trainingSplit='training',optimizer='bias-only analytic expected-utility gradient ascent')


def summarize(objects):
    values={a:sum(o['expectedPassByArm'][a] for o in objects)/len(objects) if objects else None for a in ARMS}
    def diff(a,b):return values[a]-values[b] if objects else None
    groups={}
    for name in ('beneficial','harmful','neutral'):
        rows=[o for o in objects if ('beneficial' if o['useExpected']-o['suspendExpected']>1e-12 else
             'harmful' if o['useExpected']-o['suspendExpected']< -1e-12 else 'neutral')==name]
        groups[name]=dict(objects=len(rows),meanUseProbabilityByArm={a:
            sum(o['managementProbabilities'][a]['USE'] for o in rows)/len(rows) if rows else None for a in ARMS})
    return dict(primaryMetric='unconditional verified-success route mass averaged over explicit management policy',
        heldoutObjects=len(objects),expectedPassByArm=values,
        continuationVsFrozenBeforeRound=diff(ARMS[0],ARMS[1]),
        conditionalVsMatchedGlobal=diff(ARMS[0],ARMS[2]),
        conditionalVsAlwaysSuspend=diff(ARMS[0],ARMS[5]),
        conditionalVsAlwaysUse=diff(ARMS[0],ARMS[4]),
        diagnosticGroups=groups,groupLabelsDeterminedAfterFrozenEvaluation=True,
        heldoutGroupsUsedForTraining=False,byObject=copy.deepcopy(objects),
        sampledHeldoutOutcomesByArm={a:dict(trials=3*len(objects),passes=sum(o['sampledPassesByArm'][a] for o in objects)) for a in ARMS},
        sameScalarStepNormForConditionalAndGlobal=True,
        globalControlFitOnlyOnFreshTrain=True,hostNominationOfSummary=True,
        oldNativeGreedyManagementMetricComparable=False,independentTrainingReplications=0,
        autonomousRetrievalProved=False,semanticSelfAnalysisProved=False,
        zipEncodingEffectIsolated=False,statisticalSignificanceClaimed=False)


def run_course(cases,heldout,roots,bank,notes,initial_guide,candidates,
               action_feature,method_feature,ask,save,checkpoint,deadline,number,*,initial_state,plan):
    validate_fixed_plan(plan);require(heldout==plan['heldout'],'Changed heldout plan')
    require(type(number) is int and 1<=number<=1000,'Fresh seed namespace exhausted')
    validate_head(initial_state);validate_entries(bank['entries'],notes);validate_guide(initial_guide)
    initial_head=copy.deepcopy(initial_state);head=copy.deepcopy(initial_head)
    for c in cases:save('training-case',dict(c,id=c['task']['id']))
    save('guide-original',initial_guide)
    main=restore_head(bank['head'])
    def remaining():
        if time.monotonic()>=deadline():raise TimeoutError('Context management phase deadline')

    def measure(task,ordinal,policies=None,control=None):
        remaining();entry=nominate(task,bank['entries']);require(entry is not None,'Missing nominated source summary')
        note=notes[entry['summaryZipId']];reader=restore_head(entry['head']);cards=candidate_cards(roots)
        mp=management_messages(task,note,bank['history'],bank['statuses'].get(note['id'],'available'),initial_guide)
        f,fid=action_feature(task,mp,initial_guide)
        require(len(representation(f))==len(initial_head['weights']),'Source head feature dimension changed')
        # TRAIN features and all executable policy distributions are saved before
        # the corresponding object's observations, route text and outcomes.
        seed=(12500000000 if task['split']=='training' else 12600000000)+number*100000+ordinal*100
        if policies is None:
            ps={'train_pair_use':1.,'train_pair_suspend':0.}
        else:
            ps={ARMS[0]:use_probability(head,f),ARMS[1]:use_probability(initial_head,f),
                ARMS[2]:global_probability(control),ARMS[3]:.5,ARMS[4]:1.,ARMS[5]:0.}
        decisions={}
        for arm,p in ps.items():
            source_head=head if arm==ARMS[0] else initial_head
            row=head_decision(task,source_head,f,fid,initial_guide,note['id'],p)
            row.pop('decisionHash');row.update(id=task['id']+'-'+arm,arm=arm,
                globalControlHash=digest(control) if arm==ARMS[2] else None)
            row=seal(row,'decisionHash');save('management-decision',row);decisions[arm]=row
        observations={};vectors={};feature_ids={}
        for key,n in (('without',None),('withSummary',note)):
            remaining();phase=task['split']+'_observation_'+('without_summary' if n is None else 'with_summary')
            row=ask(phase,observation_messages(task,roots,n),seed+1,mode='observation',
                task=task,summaryZipId=n['id'] if n else None)
            values,identifier=method_feature(task,row,candidate_cards(roots,n))
            observations[key]=row;vectors[key]=values;feature_ids[key]=identifier
        choices=[]
        for si in range(3):
            uniform=random.Random(seed+20+si).random()
            for arm in ps:
                use=uniform<ps[arm];key='withSummary' if use else 'without'
                choice=saved_choice(task,arm,vectors[key],candidate_cards(roots,note if use else None),
                    reader if use else main,seed+40+si,si+1,observations[key]['recordId'],feature_ids[key])
                choice.update(managementAction='USE' if use else 'SUSPEND',managementUniform=uniform,
                    explicitHeadDecision=decisions[arm],managementGeneratedText=False)
                save('method-decision',choice);choices.append(choice)
        outcomes=[];math_ids=[]
        for index,card in enumerate(cards):
            remaining();row=ask('route_math',math_messages(task,card,roots),seed+2+index,mode='math',
                               task=task,selectedCandidate=card)
            check=audit_math(task,row['studentOutput'],card)
            save('math-audit',dict(row,id=row['recordId'],check=check))
            outcomes.append(int(check['outcomePassed']));math_ids.append(row['recordId'])
        use=expected_pass(reader,vectors['withSummary'],outcomes)[0]
        suspend=expected_pass(main,vectors['without'],outcomes)[0]
        if task['split']=='training':
            case=seal(dict(id=task['id'],task=task,managementPrompt=mp,summaryZipId=note['id'],
                useExpected=use,suspendExpected=suspend,routeOutcomes=outcomes,
                sourceMathRecordIds=math_ids,sourceFeatureIds=feature_ids,
                sourceObservationIds={k:r['recordId'] for k,r in observations.items()},
                managementFeatureId=fid,sourceHeadProbabilityBeforeTraining=use_probability(initial_head,f),
                currentTaskOutcomesSuppliedBeforeFeature=False),'caseHash')
            save('fresh-training-case',case);return case,f,fid
        scores={a:utility(ps[a],use,suspend) for a in ARMS}
        row=seal(dict(id=task['id'],task=task,phase='heldout',routeOutcomes=outcomes,
            sourceMathRecordIds=math_ids,summaryZipId=note['id'],activeGuideId=initial_guide['id'],
            expectedPassByArm=scores,useExpected=use,suspendExpected=suspend,
            managementProbabilities={a:decisions[a]['probabilities'] for a in ARMS},
            frozenManagementHeadHash=digest(head),initialHeadHash=digest(initial_head),
            frozenGlobalControlHash=digest(control),observationIds={k:r['recordId'] for k,r in observations.items()},
            featureIds=feature_ids,sampledPassesByArm={a:sum(outcomes[c['policyOutput']['selectedIndex']]
                for c in choices if c['arm']==a) for a in ARMS},trialsPerArm=3,
            sampledTrialsAreNotIndependentObjects=True,heldoutEnteredTraining=False),'objectHash')
        save('object',row);return row

    cached=[measure(task,i) for i,task in enumerate(plan['training'],1)]
    train=[c for c,f,fid in cached]
    q=sum(c['sourceHeadProbabilityBeforeTraining'] for c in train)/len(train)
    control=new_global(q);initial_control=copy.deepcopy(control)
    save('control-initial',seal(dict(id='global-train-initial',control=control,initialMeanUseProbability=q,
        trainingTaskIds=[c['task']['id'] for c in train],currentTaskRewardsUsedForInitialization=False,
        heldoutFeaturesUsed=False),'controlHash'))
    for i in range(STEPS):
        remaining();c,f,fid=cached[i%len(cached)]
        step=update(head,c,f);ctrl=update_global(control,c)
        save('head-step',seal(dict(step,id='head-step-'+str(i+1).zfill(3),opportunity=i+1,
            sourceTaskId=c['task']['id'],sourceFeatureId=fid,sourceCaseHash=digest(c),
            sourceRouteOriginals=c['sourceMathRecordIds'],trainingSplit='training',
            globalControlStep=ctrl,controlUpdated=ctrl['updated']),'stepHash'))
    coverage=dict(id='train-utility-coverage',positive=sum(c['useExpected']>c['suspendExpected']+1e-12 for c in train),
        negative=sum(c['useExpected']<c['suspendExpected']-1e-12 for c in train),
        neutral=sum(abs(c['useExpected']-c['suspendExpected'])<=1e-12 for c in train),
        predeterminedTasks=8,additionalOutcomeSelectedTasks=0,
        utilityDifferences=[c['useExpected']-c['suspendExpected'] for c in train])
    save('training-diagnostic',coverage)
    checkpoint(head,initial_head,initial_guide,train,control_head=control,initial_control=initial_control)
    head_hash=digest(head);control_hash=digest(control);objects=[]
    for i,task in enumerate(plan['heldout'],1):
        objects.append(measure(task,i,policies=True,control=control))
        require(digest(head)==head_hash and digest(control)==control_hash,'Heldout mutated policy parameters')
    return dict(head=head,initialHead=initial_head,globalControl=control,initialGlobalControl=initial_control,
        activeGuide=initial_guide,objects=objects,summary=summarize(objects),trainingCoverage=coverage)
