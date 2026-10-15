"""Admit a complete v11 head by replaying its actual TRAIN ledger.

Recheck the original v10 TRAIN source and all original provenance. Old heldout
answers never become current training cases or representation prompts.
"""
import copy
from pathlib import Path
from draft_inspect_runtime import read,snapshot
from zip_weak_guidance_inspect import inspect_source as inspect_v10
from zip_management_head_run import source_cases
from zip_management_head_core import (PROTOCOL,STEPS,LEARNING_RATE,normalize,representation,
    new_head,update,digest,require,action_messages,validate_head,summarize)


def inspect_source(folder,training_only=True):
    folder=Path(folder).resolve();protocol=read(folder/'protocol.json');result=read(folder/'result.json')
    require(protocol.get('protocol')==PROTOCOL and not protocol.get('fixtureOnly') and
        result.get('protocol')==PROTOCOL and result.get('fixtureOnly') is False and
        protocol.get('teacherCalls')==result.get('teacherCalls')==0,'Wrong or Fixture management source')
    require(result.get('completeTrainingExperiment') is True and result.get('stopReason')=='completed' and
        result.get('error') is None and result.get('oldBaseAndMathematicalWeightsUnchanged') is True and
        result.get('originalFilesUnchanged') is True and result.get('heldoutLearnedStateUnchanged') is True,
        'Require the complete verified frozen v11 checkpoint')
    hashes=snapshot(folder);manifest=read(folder/'run-file-manifest.json')['files']
    require(all(hashes.get(k)==v for k,v in manifest.items()),'Changed v11 source evidence bytes')
    binding=read(folder/'source-checkpoint.json');original=Path(binding['source']).resolve()
    require(original!=folder and snapshot(original)==binding['sourceFiles'],'Changed v10 parent bytes')
    resume=inspect_v10(original,training_only=True)
    cases=source_cases(original,resume);guide=resume['initial']['guide']
    receipt=read(folder/'training-receipt.json')
    require(receipt['protocol']==PROTOCOL and receipt['trainingPhaseComplete'] is True and
        receipt['heldoutFeedbackUsed'] is False and receipt['oldAdaptersUpdated']==0 and
        receipt['trainingCaseHashes']==[digest(c) for c in cases] and receipt['activeGuide']==guide,
        'Different v11 source TRAIN receipt or active guide')
    steps=[read(p) for p in sorted((folder/'head-step').glob('*.json'))]
    require(len(steps)==STEPS,'Incomplete v11 TRAIN ledger')
    first_feature=read(folder/'feature'/(steps[0]['sourceFeatureId']+'.json'))
    expected_weights=first_feature['frozenWeights']
    require(expected_weights['base']==resume['base']['result']['baseStateBefore'],
            'Different frozen base feature provenance')
    cached=[]
    for i,c in enumerate(cases[:2]):
        fid=steps[i]['sourceFeatureId'];require(Path(fid).name==fid,'Invalid source feature identity')
        feature=read(folder/'feature'/(fid+'.json'))
        require(feature['featureHash']==digest({k:v for k,v in feature.items() if k!='featureHash'}) and
            feature['kind']=='management' and feature['task']==c['task'] and feature['allAdaptersDisabled'] is True and
            feature['candidatePrompts']==[action_messages(c['task'],c['managementPrompt'],guide,a) for a in ('USE','SUSPEND')] and
            feature['normalizedFeatures']==normalize(feature['hiddenVectors']) and
            feature['frozenWeights']==expected_weights,
            'Changed source management features or pre-outcome prompts')
        cached.append((feature['normalizedFeatures'],fid))
    head=new_head(len(representation(cached[0][0])))
    require(receipt['initialHead']==head,'Changed initial v11 uniform head')
    for i,s in enumerate(steps):
        c=cases[i%2];f,fid=cached[i%2];expected=update(head,c,f,LEARNING_RATE)
        expected.update(id='head-step-'+str(i+1).zfill(3),opportunity=i+1,sourceTaskId=c['task']['id'],
            sourceFeatureId=fid,sourceCaseHash=digest(c),sourceRouteOriginals=c['sourceMathRecordIds'],trainingSplit='training')
        require(s['stepHash']==digest({k:v for k,v in s.items() if k!='stepHash'}) and
            {k:v for k,v in s.items() if k!='stepHash'}==expected,'Changed v11 TRAIN numeric update')
    validate_head(head)
    require(head==receipt['head'] and digest(head)==receipt['headHash'],'Changed committed v11 head')
    objects=[read(p) for p in sorted((folder/'object').glob('*.json'))]
    require(len(objects)==4 and result['summary']==summarize(objects) and
        all(o['heldoutEnteredTraining'] is False and o['frozenManagementHeadHash']==digest(head) for o in objects),
        'Incomplete or changed old frozen report')
    # Return the audited old components plus the NEW immutable continuation binding.
    resume=copy.deepcopy(resume);resume['originalTrainFolder']=str(original)
    resume['originalTrainHashes']=snapshot(original);resume['parentHashes']=hashes
    resume['continuedHead']=head;resume['continuedReceipt']=receipt
    resume['continuedResult']=result;resume['continuedSourceProtocol']=PROTOCOL
    resume['continuedFeatureFrozenWeights']=expected_weights
    return resume
