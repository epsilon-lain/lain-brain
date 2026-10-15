"""Read-only binding to the audited 2e1bbab4 source; heldout never writes memory."""
import copy
from pathlib import Path

from draft_inspect_runtime import read, sha
from object_choice_core import normalized_features
from zip_label_feedback_audit import audit_math
from zip_label_metacognitive_checks import require, fact_audit, restore_head, sequential_sum
from zip_self_question_tools_source import load_bundle
from zip_self_question_memory_core import PROTOCOL, seal, validate_evidence


def history(task, observation, features, feature_id, originals, label):
    return dict(historyId=label, taskId=task['id'], task=copy.deepcopy(task),
        goal=task.get('question','Rewrite ' + task['expression'] + '.'),
        observation=copy.deepcopy(observation), observationAudit=fact_audit(observation['studentOutput'],task),
        features=copy.deepcopy(features),featureId=feature_id,
        routes=[dict(actionId='A' + str(i + 1),recordId=r['recordId'],
            requestedAction=r['studentPrompt'][0]['content'], original=copy.deepcopy(r),
            outcomePassed=r['check']['outcomePassed']) for i,r in enumerate(originals)])


def load_evidence(resume):
    bundle, provenance = load_bundle(resume)
    training=[]
    # Fixed original source continuation order, never selected by outcomes.
    for i,anchor in enumerate(bundle['anchors'][:4]):
        originals=[bundle['routes'][anchor['task']['id'] + '/' + rid] for rid in anchor['mathRecordIds']]
        training.append(history(anchor['task'],anchor['observation'],anchor['features'],anchor['featureId'],
            originals,'T' + str(i + 1)))
    parent=Path(resume['folder'])
    objects=sorted((read(p) for p in (parent/'object').glob('*.json') if read(p)['phase']=='heldout'),
        key=lambda r:int(r['sourceMathRecordIds'][0].rsplit('-',1)[1]))
    require(len(objects)==4 and resume['result']['heldoutLearnedStateUnchanged'] is True,
        'Four complete original heldout histories required')
    evaluation=[]; source_links=[]; expected=[]
    for i,obj in enumerate(objects):
        task=obj['task']
        require(task['split']=='heldout' and obj['trainingUpdates']==0,'Heldout history updated training')
        fid=obj['featureIdsByArm']['metacognitive_learning']
        fpath=parent/'feature'/(fid+'.json'); feature=read(fpath)
        opath=parent/'responses'/(feature['sourceKeywordRecordId']+'-raw.json');obs=read(opath)
        require(feature['task']==obs['task']==task and obs['phase']=='heldout_observations' and
            feature['mathematicalAdapterEnabled'] is False and feature['semanticAdapterEnabled'] is False,
            'Heldout observation or original representation differs')
        originals=[]
        for rid in obj['sourceMathRecordIds']:
            path=parent/'responses'/(rid+'-scored.json');row=read(path)
            raw=read(path.with_name(rid+'-raw.json'))
            require(all(row.get(k)==v for k,v in raw.items()) and row['task']==task and
                row['check']==audit_math(task,row['studentOutput'],row['selectedCandidate']),
                'Heldout original or factual outcome cannot be reproduced')
            originals.append(row)
        require([int(r['check']['outcomePassed']) for r in originals]==obj['routeOutcomes'],
            'Heldout route outcome vector changed')
        features=normalized_features(feature['candidateHiddenVectors'])
        ps=restore_head(resume['final']['head']).probabilities(features)[1]
        success=sequential_sum(p*y for p,y in zip(ps,obj['routeOutcomes']))
        require(abs(success-obj['expectedPassByArm']['metacognitive_learning'])<=1e-12,
            'Heldout selector readout differs from independently replayed source')
        expected.append(success)
        evaluation.append(history(task,obs,features,fid,originals,'E' + str(i + 1)))
        for path in [fpath,opath]+[parent/'responses'/(rid+'-scored.json') for rid in obj['sourceMathRecordIds']]:
            relative=str(path.relative_to(parent))
            require(resume['sourceHashes'][relative]==sha(path),'Heldout original outside audited manifest')
            source_links.append(dict(sourceRelativePath=relative,sourceSha256=sha(path)))
    evidence=seal(dict(protocol=PROTOCOL, training=training, evaluation=evaluation,
        head=copy.deepcopy(resume['final']['head']),sourceTrainingBundleHash=bundle['bundleHash'],
        independentExpectedPassMean=sequential_sum(expected)/4,
        heldoutUsedOnlyForFrozenEvaluation=True,originalTrainingAnchorCount=8,
        trainingHistorySelectionByScores=False,newMathematicsObjects=0), 'evidenceHash')
    validate_evidence(evidence)
    return evidence,dict(trainingOriginalProvenance=provenance,heldoutOriginalProvenance=source_links,
        allSourcesReadOnly=True,existingHeldoutHistoriesNotFreshModelUnseenTasks=True)
