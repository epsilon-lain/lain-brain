"""Complete v13 continuation: audit TRAIN provenance, geometry and all three ledgers.
Old heldout inputs remain reserved and never become replay training cases.
"""
import copy
from pathlib import Path
from draft_inspect_runtime import read,snapshot
import zip_management_geometry_core as core
from zip_management_geometry_inspect import inspect_source as inspect_v12
from zip_label_grounded_checks import feature_messages
from object_choice_core import normalized_features


def fresh_cases(folder,plan,resume):
    roots=resume['base']['bank']['mathematicalRoots'];bank=resume['managementInitial'];notes=resume['inherited']
    guide=resume['initial']['guide'];expected_weights=resume['continuedFeatureFrozenWeights']
    def feature(identifier,kind,task,prompts):
        core.require(type(identifier) is str and Path(identifier).name==identifier,'Invalid feature address')
        f=read(folder/'feature'/(identifier+'.json'))
        normalize=core.normalize if kind=='management' else normalized_features
        core.require(f['featureHash']==core.digest({k:v for k,v in f.items() if k!='featureHash'}) and
            f['kind']==kind and f['task']==task and f['candidatePrompts']==prompts and
            f['allAdaptersDisabled'] is True and f['frozenWeights']==expected_weights and
            f['normalizedFeatures']==normalize(f['hiddenVectors']),'Changed source TRAIN feature')
        return f['normalizedFeatures']
    def original(identifier,mode,task):
        core.require(type(identifier) is str and Path(identifier).name==identifier,'Invalid original address')
        row=read(folder/'responses'/(identifier+'.json'));v=row['studentOutput']
        core.require(row['recordId']==identifier and row['task']==task and row['fixtureOnly'] is False and
            row['mode']==mode and not v.get('testDouble') and v['originalTextRepaired'] is False and
            v['sampled'] is False and v['allOtherAdaptersEnabled'] is False and
            v['mathAdapterEnabledDuringGeneration']==(mode=='math') and
            0<v['generatedTokens']==len(v['generatedIds'])==len(v['samplingTokenLogProbabilities'])<=96 and
            abs(sum(v['samplingTokenLogProbabilities'])-v['samplingLogProbability'])<=1e-10,
            'Changed source student original provenance')
        return row
    cached=[]
    for task in plan['training']:
        c=read(folder/'fresh-training-case'/(task['id']+'.json'))
        core.require(c['task']==task and c['caseHash']==core.digest({k:v for k,v in c.items() if k!='caseHash'}) and
            c['currentTaskOutcomesSuppliedBeforeFeature'] is False,'Changed source TRAIN case')
        entry=core.nominate(task,bank['entries']);note=notes[entry['summaryZipId']]
        core.require(c['summaryZipId']==note['id'],'Different source summary binding')
        mp=core.management_messages(task,note,bank['history'],bank['statuses'].get(note['id'],'available'),guide)
        core.require(mp==c['managementPrompt'],'Source TRAIN prompt now contains different history')
        f=feature(c['managementFeatureId'],'management',task,[core.action_messages(task,mp,guide,a) for a in core.ACTIONS])
        core.require(abs(core.use_probability(resume['continuedHead'],f)-c['sourceHeadProbabilityBeforeTraining'])<=1e-12,
            'Different source starting policy')
        vectors={}
        for key,n in (('without',None),('withSummary',note)):
            r=original(c['sourceObservationIds'][key],'observation',task)
            core.require(r['studentPrompt']==core.observation_messages(task,roots,n) and
                r['summaryZipId']==(n['id'] if n else None),'Changed source observation context')
            cards=core.candidate_cards(roots,n)
            vectors[key]=feature(c['sourceFeatureIds'][key],'method',task,
                [feature_messages(task,r['studentOutput'],card) for card in cards])
        core.require(len(c['sourceMathRecordIds'])==3 and len(set(c['sourceMathRecordIds']))==3,
            'Exactly three actual source routes required')
        outcomes=[]
        for identifier,card in zip(c['sourceMathRecordIds'],core.candidate_cards(roots)):
            r=original(identifier,'math',task)
            core.require(r['studentPrompt']==core.math_messages(task,card,roots) and r['selectedCandidate']==card,
                'Changed source mathematical route')
            outcomes.append(int(core.audit_math(task,r['studentOutput'],card)['outcomePassed']))
        use=core.expected_pass(core.restore_head(entry['head']),vectors['withSummary'],outcomes)[0]
        suspend=core.expected_pass(core.restore_head(bank['head']),vectors['without'],outcomes)[0]
        core.require(outcomes==c['routeOutcomes'] and abs(use-c['useExpected'])<=1e-12 and
            abs(suspend-c['suspendExpected'])<=1e-12,'Changed source TRAIN verified rewards')
        cached.append((c,f,c['managementFeatureId']))
    core.require(len(cached)==8,'Eight complete replay TRAIN objects required')
    originals=[]
    for c,f,fid in cached:
        for identifier in c['sourceMathRecordIds']+list(c['sourceObservationIds'].values()):
            originals.append(read(folder/'responses'/(identifier+'.json')))
    return cached,originals


def inspect_source(folder,training_only=True,_visited=()):
    folder=Path(folder).resolve()
    core.require(str(folder) not in _visited,'Cyclic source chain')
    protocol=read(folder/'protocol.json')
    if protocol.get('protocol')!=core.PROTOCOL:
        return inspect_v12(folder,training_only=True)
    core.require(protocol.get('fixtureOnly') is False and protocol.get('teacherCalls')==0,
        'Wrong or Fixture v13 source')
    result=read(folder/'result.json')
    core.require(result.get('protocol')==core.PROTOCOL and result.get('fixtureOnly') is False and
        result.get('teacherCalls')==0 and result.get('completeTrainingExperiment') is True and
        result.get('stopReason')=='completed' and result.get('error') is None and
        all(result.get(k) is True for k in ('oldBaseAndMathematicalWeightsUnchanged','originalFilesUnchanged',
            'heldoutLearnedStateUnchanged','oldMethodHeadsUnchanged')),'Incomplete verified v13 source')
    hashes=snapshot(folder);manifest=read(folder/'run-file-manifest.json')['files']
    core.require(all(hashes.get(k)==v for k,v in manifest.items()),'Changed v13 evidence bytes')
    binding=read(folder/'source-checkpoint.json');parent=Path(binding['source']).resolve()
    core.require(parent!=folder and snapshot(parent)==binding['sourceFiles'],'Changed parent bytes')
    resume=inspect_source(parent,training_only=True,_visited=(*_visited,str(folder)))
    plan=read(folder/'plan.json');core.validate_fixed_plan(plan)
    parent_plan=read(parent/'plan.json')
    reserved={t['semanticInputKey'] for split in ('training','heldout') for t in parent_plan[split]}
    core.validate_fixed_plan(plan,reserved)
    core.require(plan['continuedSourceHeadHash']==core.digest(resume['continuedHead']) and
        plan['sourceReplayTrainingIds']==[c['task']['id'] for c,f,fid in resume['replayCache']],
        'Changed continued policy or replay TRAIN binding')
    fresh,originals=fresh_cases(folder,plan,resume)
    cached=[]
    for old,new in zip(resume['replayCache'],fresh):cached.extend((old,new))
    core.require(len(cached)==16 and all(c['task']['split']=='training' for c,f,fid in cached),
        'Sixteen audited TRAIN cases required')
    feature_rows=[dict(task=c['task'],features=f,featureId=fid) for c,f,fid in cached]
    transform=core.fit_transform(feature_rows)
    core.require(read(folder/'feature-transform/train-geometry.json')['transform']==transform,
        'Changed TRAIN-only feature transform')
    head=core.reparameterize(resume['continuedHead'],transform);raw=copy.deepcopy(resume['continuedHead'])
    q=sum(core.use_probability(raw,f) for c,f,fid in cached)/16
    control=core.new_global(q);initial_control=copy.deepcopy(control)
    steps=[read(p) for p in sorted((folder/'head-step').glob('*.json'))]
    core.require(len(steps)==core.STEPS,'Incomplete v13 update ledger')
    for i,s in enumerate(steps):
        c,f,fid=cached[i%16]
        row=core.update_conditioned(head,c,core.transformed_features(f,transform))
        raw_step=core.update(raw,c,f);ctrl=core.update_global(control,c)
        row.update(id='head-step-'+str(i+1).zfill(3),opportunity=i+1,sourceTaskId=c['task']['id'],
            sourceFeatureId=fid,sourceCaseHash=core.digest(c),sourceRouteOriginals=c['sourceMathRecordIds'],
            trainingSplit='training',globalControlStep=ctrl,controlUpdated=ctrl['updated'],
            rawControlStep=raw_step,rawControlUpdated=raw_step['updated'],
            featureTransformHash=transform['transformHash'])
        core.require(s['stepHash']==core.digest({k:v for k,v in s.items() if k!='stepHash'}) and
            {k:v for k,v in s.items() if k!='stepHash'}==row,'Changed v13 numerical TRAIN update')
    exported=core.export_raw_head(head,transform);receipt=read(folder/'training-receipt.json')
    policies_hash=core.digest(dict(head=head,control=control,raw=raw,transform=transform))
    core.require(receipt['protocol']==core.PROTOCOL and receipt['head']==head and
        receipt['initialHead']==resume['continuedHead'] and receipt['globalControl']==control and
        receipt['initialGlobalControl']==initial_control and receipt['rawControl']==raw and
        receipt['featureTransform']==transform and receipt['exportedRawHead']==exported and
        receipt['trainingCaseHashes']==[core.digest(c) for c,f,fid in cached] and
        receipt['headHash']==core.digest(head) and receipt['globalControlHash']==core.digest(control) and
        receipt['rawControlHash']==core.digest(raw) and receipt['policiesHash']==policies_hash and
        receipt['activeGuide']==resume['initial']['guide'] and receipt['heldoutFeedbackUsed'] is False and
        receipt['transformFitUsesHeldoutFeatures'] is False and receipt['languageModelTraining'] is False and
        receipt['trainingPhaseComplete'] is True,'Changed v13 TRAIN receipt or raw export')
    deployed=read(folder/'deployment-model/trained-experience-manager.json')
    core.require(deployed['rawFeatureHead']==exported and deployed['conditionedHead']==head and
        deployed['featureTransform']==transform and deployed['baseModelFrozen'] is True and
        deployed['baseLanguageModelRetrained'] is False,'Changed equivalent deployment policy')
    objects=[read(p) for p in sorted((folder/'object').glob('*.json'))]
    core.require(len(objects)==8 and {o['task']['id'] for o in objects}=={t['id'] for t in plan['heldout']} and
        result['summary']==core.summarize(objects) and
        all(o['objectHash']==core.digest({k:v for k,v in o.items() if k!='objectHash'}) and
            o['heldoutEnteredTraining'] is False and o['frozenManagementHeadHash']==core.digest(head) and
            o['initialHeadHash']==core.digest(resume['continuedHead']) and
            o['frozenGlobalControlHash']==core.digest(control) and o['frozenRawControlHash']==core.digest(raw) and
            o['featureTransformHash']==transform['transformHash'] for o in objects),'Changed old frozen report')
    core.require(result['headOpportunityCount']==96 and result['freshTrainingObjects']==8 and
        result['freshHeldoutObjects']==8 and result['oldHeldoutEnteredTraining'] is False and
        result['languageModelTraining'] is False and
        result['actualManagementHeadUpdates']==sum(s['updated'] for s in steps) and
        result['actualRawControlUpdates']==sum(s['rawControlUpdated'] for s in steps) and
        result['actualGlobalControlUpdates']==sum(s['controlUpdated'] for s in steps),
        'Changed actual TRAIN counts')
    ancestors=dict(resume.get('protectedAncestors',{}));ancestors[str(parent)]=binding['sourceFiles']
    resume=copy.deepcopy(resume)
    resume.update(protectedAncestors=ancestors,parentHashes=hashes,continuedHead=exported,
        continuedResult=result,continuedReceipt=receipt,replayCache=fresh,sourceReplayOriginals=originals,
        continuedSourceProtocol=core.PROTOCOL)
    core.require(snapshot(folder)==hashes,'Source changed during admission')
    return resume
