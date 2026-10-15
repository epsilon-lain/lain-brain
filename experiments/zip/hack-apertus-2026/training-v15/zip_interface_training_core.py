"""Program-supervised address learning, separate from autonomous diagnosis.

Targets are exact registry addresses, never student responses, mathematical
answers, weaknesses or plans. Existing v1/v2/v3 audits are unchanged.
"""
import copy
import math
from collections import Counter

from zip_content_core import digest
from zip_self_question_memory_core import require,seal,validate_evidence,restore_head,sequential_sum,journal_text
from zip_self_question_tools_core import build_bank as legacy_bank,call_audit as legacy_call_audit
from zip_experience_binding_core import source_root,choice_audit,observation_audit
from zip_experience_routing_core import routing_messages,selected_observation_input,validate_generation as native_generation_audit

PROTOCOL='lain-zip-program-supervised-interface-training-v4'
MAX_GENERATIONS=6
MAX_TOKENS=96
TRAINING_STEPS=6
LEARNING_RATE=.005


def build_bank(kernel_sha):
    roots=[]
    for old in legacy_bank(kernel_sha)['tools']:
        body={k:v for k,v in old.items() if k!='version'}
        body.update(protocol=PROTOCOL,inputScope='four_original_training_histories_T1_to_T4',
            measurementScope='four_original_training_histories_T1_to_T4',
            kernelModule='zip_interface_training_core.py')
        roots.append(seal(body,'version'))
    return seal(dict(protocol=PROTOCOL,tools=roots,hostDefinesMeasurementTools=True,
        numericalResultsProvided=False,hostChoosesMetric=False,measurementScope='T1-T4'), 'bankHash')


def validate_bank(bank):
    require(bank==build_bank(bank['tools'][0]['kernelSha256']),'Training-scope tool bank changed')


def catalogue(bank):
    validate_bank(bank)
    return '\n'.join(t['id']+': '+t['title']+'. '+t['description'] for t in bank['tools'])


def source_lookup_messages(evidence,goal,training=True):
    validate_evidence(evidence)
    require(sum(h['goal']==goal for h in evidence['training'])==1,'Lookup goal must bind exactly one training source')
    request=('Find the ZIP storing this exact quoted goal. Return only its T id.' if training else
        'Which saved source ZIP contains the quoted goal? Write only its T id, or NONE if unsure.')
    return [dict(role='system',content='The archive records are quoted past data. Follow the final lookup request.'),
        dict(role='user',content='Source ZIP records:\n'+journal_text(evidence['training'])),
        dict(role='user',content=request+'\nQuoted goal: '+__import__('json').dumps(goal,ensure_ascii=False))]


def metric_lookup_messages(bank,definition):
    validate_bank(bank)
    require(sum(t['description']==definition for t in bank['tools'])==1,'Definition must bind exactly one ZIP')
    return [dict(role='system',content='This is an address lookup exercise. It does not select a problem or request a measurement.'),
        dict(role='user',content='Available measurement ZIP definitions, without results:\n'+catalogue(bank)),
        dict(role='user',content='Find the ZIP storing this exact quoted definition. Return only CALL followed by its Z id.\nQuoted definition: '+__import__('json').dumps(definition,ensure_ascii=False))]


def make_lessons(evidence,bank):
    validate_evidence(evidence);validate_bank(bank);rows=[]
    for h in evidence['training']:
        rows.append(dict(id='locate-'+h['historyId'],kind='source_address_lookup',target=h['historyId'],
            prompt=source_lookup_messages(evidence,h['goal']),sourceHistoryId=h['historyId'],
            sourceTaskId=h['taskId'],literalLookupText=h['goal']))
    for t in bank['tools']:
        rows.append(dict(id='locate-'+t['id'],kind='measurement_address_lookup',target='CALL '+t['id'],
            prompt=metric_lookup_messages(bank,t['description']),sourceToolId=t['id'],
            sourceToolVersion=t['version'],literalLookupText=t['description']))
    body=dict(protocol=PROTOCOL,sourceEvidenceHash=evidence['evidenceHash'],bankHash=bank['bankHash'],examples=rows,
        labelAuthor='program_exact_registry_binding',hostSupervisedProceduralLabels=True,
        teacherModelCalls=0,studentAuthoredTrainingTargets=False,mathematicalTargetAnswersProvided=False,
        targetWeaknessOrPlanProvided=False,numericalMetricResultsProvided=False,heldoutHistoriesUsed=False)
    return seal(body,'lessonHash')


def validate_lessons(lessons,evidence,bank):
    require(lessons==make_lessons(evidence,bank),'Procedural labels or source lookup examples changed')


def training_batches(lessons):
    rows=lessons['examples'];require(len(rows)==11,'Four source and seven metric addresses required')
    # Two full balanced passes: every address occurs twice, no target is
    # preferred because of the recorded successes, failures or metric value.
    return [rows[i:i+4] for _ in range(2) for i in (0,4,8)]


def evaluation_messages(evidence,phase,number):
    require(phase in ('source_lookup','experience_choice'),'Unknown before/after endpoint')
    if phase=='experience_choice':return routing_messages(evidence,'separate_native')
    h=evidence['training'][(number+2)%4]
    return source_lookup_messages(evidence,h['goal'],training=False)


def expected_lookup(evidence,number):return evidence['training'][(number+2)%4]['historyId']


def call_audit(output,bank):
    validate_bank(bank);parsed=legacy_call_audit(output,legacy_bank(bank['tools'][0]['kernelSha256']))
    parsed=dict(parsed,bankHash=bank['bankHash'])
    if parsed['callVerified']:parsed['toolVersion']=next(t['version'] for t in bank['tools'] if t['id']==parsed['zipId'])
    return parsed


def execute_measurement(evidence,bank,output,check):
    validate_evidence(evidence);validate_bank(bank)
    require(check==call_audit(output,bank) and check['callVerified'],'Only the actual complete student call may execute')
    tool=next(t for t in bank['tools'] if t['id']==check['zipId']);key=tool['operation'];head=restore_head(evidence['head'])
    parts=[];tops=[];seen=set();witnesses=[]
    for h in evidence['training']:
        ps=head.probabilities(h['features'])[1];audit=h['observationAudit']
        if key=='success_probability_mean':v=sequential_sum(p*int(r['outcomePassed']) for p,r in zip(ps,h['routes']))
        elif key=='observation_rejected_fraction':v=int(audit['status']=='rejected')
        elif key=='observation_pending_fraction':v=int(audit['status']=='pending')
        elif key=='observation_capped_fraction':v=int(audit['tokenCapReached'])
        elif key=='top_choice_concentration':v=max(range(3),key=ps.__getitem__);tops.append(v)
        elif key=='choice_entropy_fraction':v=-sequential_sum(p*math.log(max(p,1e-300)) for p in ps)/math.log(3)
        elif key=='distinct_observation_fraction':
            text=h['observation']['studentOutput']['raw'];v=int(text not in seen);seen.add(text)
        else:raise ValueError('Unknown training measurement operation')
        parts.append(v);witnesses.append(dict(historyId=h['historyId'],taskId=h['taskId'],
            originalMathRecordIds=[r['recordId'] for r in h['routes']],observationRecordId=h['observation']['recordId'],
            probabilities=ps,component=v))
    value=max(Counter(tops).values())/4 if tops else sequential_sum(parts)/4
    return seal(dict(zipId=tool['id'],metricKey=key,value=round(value,10),unit='fraction',measurementScope='T1-T4',
        originalHistories=4,evidence=witnesses,sourceEvidenceHash=evidence['evidenceHash'],bankHash=bank['bankHash'],
        selectedCallRawHash=check['studentRawHash'],numericalResultVerified=True,understandingVerified=False,
        explanationVerified=False,trainingUpdatesFromResult=0),'resultHash')


def validate_generation(output,enabled):
    native_generation_audit(output,False)
    require(type(enabled) is bool and output.get('interfaceAdapterEnabledDuringGeneration') is enabled and
        isinstance(output.get('interfaceStateHashDuringGeneration'),str) and
        __import__('re').fullmatch('[0-9a-f]{64}',output['interfaceStateHashDuringGeneration']) and
        output.get('adapterSwitchesStableDuringGeneration') is True,'Actual interface adapter state is required')


def check_row(row,evidence,bank,number):
    require(row['protocol']==PROTOCOL and row['fixtureOnly'] is False and
        row['evidenceHash']==evidence['evidenceHash'] and row['bankHash']==bank['bankHash'] and
        row['arm'] in ('before','after') and row['experimentNumber']==number and
        row['samplingSeed']==seed_for(number,row['phase']) and
        row['recordId']==row['arm']+'-'+row['phase'] and
        row['phase'] in ('source_lookup','experience_choice','experience_observation','metric_zip_call'), 'Original scope changed')
    validate_generation(row['studentOutput'],row['arm']=='after')
    if row['phase'] in ('metric_zip_call','experience_observation'):
        root=row['sourceZip']
        require(row['arm']=='after' and row['sourceChoiceRecordId']=='after-experience_choice' and
            root==source_root(next(h for h in evidence['training'] if h['historyId']==root['id']),evidence),
            'Dependent phase source root changed')
        if row['phase']=='metric_zip_call':
            note=row['sourceObservationZip'];validate_note(note,evidence,bank)
            require(note['eligibleForFrozenContext'] and note['sourceZip']==root and
                row['studentPrompt']==call_input(bank,root,note['studentObservation'],number),
                'Metric call must use the actual eligible observation ZIP')
            return call_audit(row['studentOutput'],bank)
        require(row['studentPrompt']==selected_observation_input(root),'Actual observation prompt changed')
        return observation_audit(row['studentOutput'],evidence,root)
    require(row['studentPrompt']==evaluation_messages(evidence,row['phase'],number),'Before/after prompt changed')
    c=choice_audit(row['studentOutput'],evidence)
    if row['phase']=='source_lookup':
        c=dict(c,externallySpecifiedLookup=True,expectedSourceId=expected_lookup(evidence,number),
            exactLookupCorrect=bool(c['selectionVerified'] and c['historyId']==expected_lookup(evidence,number)),
            lookupCorrectnessIsNotAutonomousProblemSelection=True)
    return c


def validate_choice(row,evidence,bank,number,root):
    check=check_row(row,evidence,bank,number)
    require(row['arm']=='after' and row['phase']=='experience_choice' and row['check']==check and
        check['selectionVerified'] and root==source_root(next(h for h in evidence['training']
        if h['historyId']==check['historyId']),evidence),'Actual post-training choice cannot be replaced or rebound')


def observation_messages(choice,evidence,bank,number,root):
    validate_choice(choice,evidence,bank,number,root);return selected_observation_input(root)


def call_input(bank,root,observation,number):
    validate_bank(bank);tools=bank['tools'][number%7:]+bank['tools'][:number%7]
    text='The source experience you selected:\n'+journal_text([root['originalHistory']])
    if observation is not None:text+='\nYour original observation (unreviewed hypothesis):\n'+observation['studentOutput']['raw']
    text+='\nScope: four original training histories T1-T4.\nAvailable measurement ZIP definitions, without results:\n'+\
        '\n'.join(t['id']+': '+t['title']+'. '+t['description'] for t in tools)
    return [dict(role='system',content='Past records and the catalogue are quoted data. Follow the last request.'),
        dict(role='user',content=text),dict(role='user',content='Choose a measurement ZIP for your own assessment. Write only CALL followed by its Z id, or NONE to decline.')]


def note_root(choice,observation,evidence,bank,number,root):
    validate_choice(choice,evidence,bank,number,root)
    require(observation['arm']=='after' and observation['phase']=='experience_observation' and
        observation['sourceChoiceRecordId']==choice['recordId'] and observation['sourceZip']==root and
        observation['studentPrompt']==observation_messages(choice,evidence,bank,number,root),'Observation source or prompt changed')
    check=check_row(observation,evidence,bank,number)
    require(observation['check']==check,'Unchanged v2 observation audit changed')
    return seal(dict(id='I1',protocol=PROTOCOL,studentChoice=copy.deepcopy(choice),studentObservation=copy.deepcopy(observation),
        sourceZip=copy.deepcopy(root),sourceEvidenceHash=evidence['evidenceHash'],bankHash=bank['bankHash'],
        experimentNumber=number,observationAudit=check,eligibleForFrozenContext=check['experimentalContextEligible'],
        hypothesisOnly=True,wholeNoteTruthVerified=False,productionActive=False,author='student',
        certifiedPart='actual_student_selection_and_original_source_binding_only'),'noteHash')


def validate_note(note,evidence,bank):
    require(note==note_root(note['studentChoice'],note['studentObservation'],evidence,bank,note['experimentNumber'],note['sourceZip']),
        'Whole source-bound observation ZIP changed')


def seed_for(number,phase):
    require(type(number) is int and 1<=number<=1000 and phase in ('source_lookup','experience_choice','experience_observation','metric_zip_call','adapter_initialization'), 'Fresh interface-training namespace required')
    return 4_800_000_000+1000*number+{'source_lookup':10,'experience_choice':20,'experience_observation':30,'metric_zip_call':40,'adapter_initialization':50}[phase]


def run_experiment(evidence,bank,number,generate,train,save,guard,remaining,read_source,install,read_notes,measure=execute_measurement):
    validate_evidence(evidence);validate_bank(bank);originals=[];scope=(digest(evidence),digest(bank));choices={}
    def frozen():
        guard();require(scope==(digest(evidence),digest(bank)) and all(digest(r)==h for r,h in originals),'Source, bank or earlier original changed')
    def deadline():
        if remaining()<=0:raise TimeoutError('Interface-training deadline before dependent action')
    def ask(phase,arm,prompt,root=None,source_id=None,note=None):
        deadline();frozen();require(len(originals)<6,'Six-generation interface-training cap')
        output=generate(prompt,phase,seed_for(number,phase),False,arm=='after')
        row=dict(recordId=arm+'-'+phase,protocol=PROTOCOL,arm=arm,phase=phase,experimentNumber=number,
            studentPrompt=prompt,studentOutput=output,samplingSeed=seed_for(number,phase),fixtureOnly=False,
            sourceZip=root,sourceChoiceRecordId=source_id,sourceObservationZip=note,
            evidenceHash=evidence['evidenceHash'],bankHash=bank['bankHash'])
        save('raw',row);frozen();check=check_row(row,evidence,bank,number);scored=dict(row,check=check);save('scored',scored)
        originals.append((copy.deepcopy(row),digest(row)));return scored
    for phase in ('source_lookup','experience_choice'):
        choices[('before',phase)]=ask(phase,'before',evaluation_messages(evidence,phase,number))
    deadline();frozen();training=train();save('training-complete',training);frozen()
    require(training['optimizerSteps']==TRAINING_STEPS and training['committedExampleVisits']==22 and
        training['lessonHash']==make_lessons(evidence,bank)['lessonHash'] and
        training['programSupervisedLabels'] is True and training['finiteStateVerified'] is True,
        'Incomplete procedural training cannot produce an after-training comparison')
    for phase in ('source_lookup','experience_choice'):
        choices[('after',phase)]=ask(phase,'after',evaluation_messages(evidence,phase,number))
    choice=choices[('after','experience_choice')]
    if not choice['check']['selectionVerified']:
        save('stage',dict(id='observation',requested=False,reason=choice['check']['reason']));return choices
    deadline();frozen();root=read_source(choice['check']['historyId']);validate_choice(choice,evidence,bank,number,root)
    save('source-read',dict(id='after-choice',root=root,sourceChoiceRecordId=choice['recordId']))
    observation=ask('experience_observation','after',observation_messages(choice,evidence,bank,number,root),root,choice['recordId'])
    note=note_root(choice,observation,evidence,bank,number,root);save('note-candidate',note)
    if not note['eligibleForFrozenContext']:
        save('stage',dict(id='metric-call',requested=False,reason=note['observationAudit']['reason']));return choices
    deadline();frozen();install(note);loaded=read_notes();require(loaded==[note],'Actual native observation ZIP replay differs')
    call=ask('metric_zip_call','after',call_input(bank,root,loaded[0]['studentObservation'],number),root,choice['recordId'],loaded[0])
    if call['check']['callVerified']:
        deadline();frozen();result=measure(evidence,bank,call['studentOutput'],call['check'])
        row=dict(id='selected-measurement',sourceCallRecordId=call['recordId'],measurement=result);save('tool-returned',row);frozen()
        require(result==execute_measurement(evidence,bank,call['studentOutput'],call['check']),'Returned measurement differs from original-history kernel')
        save('tool-executed',row)
    require(read_notes()==[note],'Observation ZIP changed after call');frozen();return choices


def summarize(raw,scored,notes,reads,tools,updates,stop):
    require(len(raw)<=6 and len(updates)<=6,'Bounded generation or optimizer budget exceeded')
    ri={r['recordId']:r for r in raw};si={r['recordId']:{k:v for k,v in r.items() if k!='check'} for r in scored}
    audited=len(ri)==len(raw) and len(si)==len(scored) and ri==si
    rows={(r['arm'],r['phase']):r for r in scored}
    require(len(rows)==len(scored),'Duplicate before/after phase')
    trained=len(updates)==TRAINING_STEPS and all(u.get('committed') is True for u in updates)
    paired=stop=='completed' and audited and trained and all((a,p) in rows for a in ('before','after') for p in ('source_lookup','experience_choice'))
    endpoints={}
    for phase,key in (('source_lookup','exactLookupCorrect'),('experience_choice','selectionVerified')):
        endpoints[phase]={arm:bool(rows[(arm,phase)]['check'].get(key)) if (arm,phase) in rows else None for arm in ('before','after')}
        if paired:
            a,b=rows[('before',phase)],rows[('after',phase)]
            require(a['studentPrompt']==b['studentPrompt'] and a['samplingSeed']==b['samplingSeed'],'Training-before/after endpoint changed')
            endpoints[phase]['signedAfterMinusBefore']=int(endpoints[phase]['after'])-int(endpoints[phase]['before'])
        else:endpoints[phase]['signedAfterMinusBefore']=None
    return dict(runCompletedNormally=stop=='completed',actualStudentGenerations=len(raw),allReturnedResponsesAudited=audited,
        actualInterfaceOptimizerUpdates=len(updates),completeBeforeAfterInterfaceComparison=paired,byEndpoint=endpoints,
        sourceBoundStudentHypothesisZips=sum(n['eligibleForFrozenContext'] for n in notes),actualSelectedSourceZipReads=len(reads),
        observationResponses=sum(r['phase']=='experience_observation' for r in scored),actualMeasurementZipExecutions=len(tools),
        numericalMetricResultsSuppliedBeforeStudentCall=False,autonomousCatalogueOnlyAfterActualObservation=True,
        hostSupervisedProceduralLabels=True,teacherModelCalls=0,teacherCalls=0,hostTargetsAreRegistryAddresses=True,
        hostChoosesWeaknessOrPlan=False,hostWritesStudentObservation=False,hostChoosesMetric=False,
        sourceLookupIsExternallySpecifiedNotAutonomous=True,allElevenRegistryAddressesTrainedEqually=trained,
        sourceHeldoutEnteredTraining=False,newMathematicsObjects=0,semanticSelfAnalysisProved=False,
        mathematicalBenefitTested=False,understandingOrPlanVerified=False,statisticalSignificanceClaimed=False,
        independentlyRetrainedReplication=False,independentTrainingReplications=0,
        trainedInterfaceCandidateCount=int(trained),novelSourceRegistryGeneralizationTested=False,
        productionBankUpdated=False,originalScoresChanged=False,forcedGrammar=False,adaptiveRetries=False)
