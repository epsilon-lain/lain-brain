"""Admit complete v12 by replaying eight actual TRAIN cases and both heads.

The previous eight heldout inputs are reserved, never added to replay data.
"""
import copy
from pathlib import Path
from draft_inspect_runtime import read,snapshot
import zip_management_context_core as prior
from zip_management_context_inspect import inspect_source as inspect_v11
from zip_label_grounded_checks import feature_messages
from object_choice_core import normalized_features


def inspect_source(folder,training_only=True):
    folder=Path(folder).resolve();protocol=read(folder/'protocol.json')
    prior.require(protocol.get('protocol')==prior.PROTOCOL and protocol.get('fixtureOnly') is False and
        protocol.get('teacherCalls')==0,'Wrong or Fixture v12 source')
    result=read(folder/'result.json')
    prior.require(result.get('protocol')==prior.PROTOCOL and result.get('fixtureOnly') is False and
        result.get('teacherCalls')==0 and result.get('completeTrainingExperiment') is True and
        result.get('stopReason')=='completed' and result.get('error') is None and
        all(result.get(k) is True for k in ('oldBaseAndMathematicalWeightsUnchanged','originalFilesUnchanged',
            'heldoutLearnedStateUnchanged','oldMethodHeadsUnchanged')),'Incomplete verified v12 source')
    hashes=snapshot(folder);manifest=read(folder/'run-file-manifest.json')['files']
    prior.require(all(hashes.get(k)==v for k,v in manifest.items()),'Changed v12 evidence bytes')
    binding=read(folder/'source-checkpoint.json');parent=Path(binding['source']).resolve()
    prior.require(parent!=folder and snapshot(parent)==binding['sourceFiles'],'Changed v11 parent bytes')
    resume=inspect_v11(parent,training_only=True);plan=read(folder/'plan.json');prior.validate_fixed_plan(plan)
    roots=resume['base']['bank']['mathematicalRoots'];bank=resume['managementInitial'];notes=resume['inherited']
    guide=resume['initial']['guide'];expected_weights=resume['continuedFeatureFrozenWeights']
    def feature(identifier,kind,task,prompts):
        prior.require(type(identifier) is str and Path(identifier).name==identifier,'Invalid feature address')
        f=read(folder/'feature'/(identifier+'.json'))
        normalize=prior.normalize if kind=='management' else normalized_features
        prior.require(f['featureHash']==prior.digest({k:v for k,v in f.items() if k!='featureHash'}) and
            f['kind']==kind and f['task']==task and f['candidatePrompts']==prompts and
            f['allAdaptersDisabled'] is True and f['frozenWeights']==expected_weights and
            f['normalizedFeatures']==normalize(f['hiddenVectors']),'Changed source TRAIN feature')
        return f['normalizedFeatures']
    def original(identifier,mode,task):
        prior.require(type(identifier) is str and Path(identifier).name==identifier,'Invalid original address')
        row=read(folder/'responses'/(identifier+'.json'));v=row['studentOutput']
        prior.require(row['recordId']==identifier and row['task']==task and row['fixtureOnly'] is False and
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
        prior.require(c['task']==task and c['caseHash']==prior.digest({k:v for k,v in c.items() if k!='caseHash'}) and
            c['currentTaskOutcomesSuppliedBeforeFeature'] is False,'Changed source TRAIN case')
        entry=prior.nominate(task,bank['entries']);note=notes[entry['summaryZipId']]
        prior.require(c['summaryZipId']==note['id'],'Different source summary binding')
        mp=prior.management_messages(task,note,bank['history'],bank['statuses'].get(note['id'],'available'),guide)
        prior.require(mp==c['managementPrompt'],'Source TRAIN prompt now contains different history')
        f=feature(c['managementFeatureId'],'management',task,[prior.action_messages(task,mp,guide,a) for a in prior.ACTIONS])
        prior.require(abs(prior.use_probability(resume['continuedHead'],f)-c['sourceHeadProbabilityBeforeTraining'])<=1e-12,
            'Different source starting policy')
        vectors={}
        for key,n in (('without',None),('withSummary',note)):
            r=original(c['sourceObservationIds'][key],'observation',task)
            prior.require(r['studentPrompt']==prior.observation_messages(task,roots,n) and
                r['summaryZipId']==(n['id'] if n else None),'Changed source observation context')
            cards=prior.candidate_cards(roots,n)
            vectors[key]=feature(c['sourceFeatureIds'][key],'method',task,
                [feature_messages(task,r['studentOutput'],card) for card in cards])
        prior.require(len(c['sourceMathRecordIds'])==3 and len(set(c['sourceMathRecordIds']))==3,
            'Exactly three actual source routes required')
        outcomes=[]
        for identifier,card in zip(c['sourceMathRecordIds'],prior.candidate_cards(roots)):
            r=original(identifier,'math',task)
            prior.require(r['studentPrompt']==prior.math_messages(task,card,roots) and r['selectedCandidate']==card,
                'Changed source mathematical route')
            outcomes.append(int(prior.audit_math(task,r['studentOutput'],card)['outcomePassed']))
        use=prior.expected_pass(prior.restore_head(entry['head']),vectors['withSummary'],outcomes)[0]
        suspend=prior.expected_pass(prior.restore_head(bank['head']),vectors['without'],outcomes)[0]
        prior.require(outcomes==c['routeOutcomes'] and abs(use-c['useExpected'])<=1e-12 and
            abs(suspend-c['suspendExpected'])<=1e-12,'Changed source TRAIN verified rewards')
        cached.append((c,f,c['managementFeatureId']))
    prior.require(len(cached)==8,'Eight complete replay TRAIN objects required')
    receipt=read(folder/'training-receipt.json');head=copy.deepcopy(resume['continuedHead'])
    q=sum(c['sourceHeadProbabilityBeforeTraining'] for c,f,fid in cached)/8
    control=prior.new_global(q);initial_control=copy.deepcopy(control)
    steps=[read(p) for p in sorted((folder/'head-step').glob('*.json'))]
    prior.require(len(steps)==prior.STEPS,'Incomplete v12 update ledger')
    for i,s in enumerate(steps):
        c,f,fid=cached[i%8];step=prior.update(head,c,f);ctrl=prior.update_global(control,c)
        step.update(id='head-step-'+str(i+1).zfill(3),opportunity=i+1,sourceTaskId=c['task']['id'],
            sourceFeatureId=fid,sourceCaseHash=prior.digest(c),sourceRouteOriginals=c['sourceMathRecordIds'],
            trainingSplit='training',globalControlStep=ctrl,controlUpdated=ctrl['updated'])
        prior.require(s['stepHash']==prior.digest({k:v for k,v in s.items() if k!='stepHash'}) and
            {k:v for k,v in s.items() if k!='stepHash'}==step,'Changed v12 numerical TRAIN update')
    prior.require(receipt['protocol']==prior.PROTOCOL and receipt['head']==head and receipt['globalControl']==control and
        receipt['initialHead']==resume['continuedHead'] and receipt['initialGlobalControl']==initial_control and
        receipt['trainingCaseHashes']==[prior.digest(c) for c,f,fid in cached] and
        receipt['headHash']==prior.digest(head) and receipt['globalControlHash']==prior.digest(control) and
        receipt['policiesHash']==prior.digest(dict(head=head,control=control)) and
        receipt['activeGuide']==guide and receipt['heldoutFeedbackUsed'] is False and
        receipt['trainingPhaseComplete'] is True,'Changed v12 TRAIN receipt')
    objects=[read(p) for p in sorted((folder/'object').glob('*.json'))]
    prior.require(len(objects)==8 and result['summary']==prior.summarize(objects) and
        all(o['heldoutEnteredTraining'] is False and o['frozenManagementHeadHash']==prior.digest(head) and
            o['frozenGlobalControlHash']==prior.digest(control) for o in objects),'Changed old frozen report')
    replay_prompt_records=[]
    for c,f,fid in cached:
        ids=c['sourceMathRecordIds']+list(c['sourceObservationIds'].values())
        replay_prompt_records += [read(folder/'responses'/(identifier+'.json')) for identifier in ids]
    resume=copy.deepcopy(resume)
    resume['protectedAncestors']={str(parent):snapshot(parent)};resume['parentHashes']=hashes
    resume['continuedHead']=head;resume['continuedResult']=result;resume['continuedReceipt']=receipt
    resume['replayCache']=cached;resume['sourceReplayOriginals']=replay_prompt_records
    resume['continuedSourceProtocol']=prior.PROTOCOL
    return resume
