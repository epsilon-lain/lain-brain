"""Atomically publish a complete weight/optimizer/receipt transaction directory."""
import json
import os
from pathlib import Path
import shutil
import uuid
import zipfile
from draft_inspect_runtime import read,sha
from zip_management_geometry_receipts import atomic_json
from zip_math_long_core import PROTOCOL,digest,require,summarize


def commits(folder,binding):
    found=[];previous=binding['initialMathHash']
    for i,p in enumerate(sorted((Path(folder)/'committed').glob('step-*')),1):
        require(p.is_dir() and p.name=='step-'+str(i).zfill(4),'Missing or duplicate math transaction')
        v=read(p/'receipt.json')
        require(v['receiptHash']==digest({k:x for k,x in v.items() if k!='receiptHash'}) and
            v['protocol']==PROTOCOL and v['ordinal']==i and v['sourceBindingHash']==digest(binding) and
            v['beforeWriterHash']==previous and
            sha(p/'writer.safetensors')==v['writerFileHash'] and sha(p/'optimizer.pt')==v['optimizerFileHash'],
            'Changed committed math weights, optimizer or receipt chain')
        previous=v['afterWriterHash'];found.append((p,v))
    return found


def publish(folder,ordinal,binding,row,save_state):
    root=Path(folder)/'committed';root.mkdir(exist_ok=True)
    target=root/('step-'+str(ordinal).zfill(4));require(not target.exists(),'Refuse duplicate math update publication')
    temporary=root/('.preparing-'+uuid.uuid4().hex);temporary.mkdir()
    try:
        save_state(temporary/'writer.safetensors',temporary/'optimizer.pt')
        value=dict(row,protocol=PROTOCOL,ordinal=ordinal,sourceBindingHash=digest(binding),
            writerFileHash=sha(temporary/'writer.safetensors'),optimizerFileHash=sha(temporary/'optimizer.pt'))
        value['receiptHash']=digest(value);atomic_json(temporary/'receipt.json',value)
        for p in temporary.iterdir():
            with p.open('rb') as handle:os.fsync(handle.fileno())
        os.replace(temporary,target)
        fd=os.open(root,os.O_RDONLY)
        try:os.fsync(fd)
        finally:os.close(fd)
        return value
    finally:
        if temporary.exists():shutil.rmtree(temporary)


def report(folder,stop='in_progress',error=None):
    folder=Path(folder);rows=[read(p) for p in sorted((folder/'committed').glob('step-*/receipt.json'))]
    objects=[read(p) for p in sorted((folder/'object').glob('*.json'))]
    final=[o for o in objects if o['evaluationBatch']=='terminal']
    return dict(protocol=PROTOCOL,stopReason=stop,error=error,completeTrainingExperiment=False,
        completeFixedCurriculum=len(rows)==192,committedMathOptimizerUpdates=len(rows),
        mathematicalWriterParametersChanged=any(r['parameterChanged'] for r in rows),
        newlyCommittedMathUpdates=0,actualStudentGenerations=len(list((folder/'responses').glob('*.json'))),
        verifiedRehearsalUses=sum(r.get('rehearsalSourceRecordId') is not None for r in rows),
        positiveOnPolicyTrajectories=sum(sum(a>0 for a in r['advantages']) for r in rows),
        negativeOnPolicyTrajectories=sum(sum(a<0 for a in r['advantages']) for r in rows),
        finalCheckpoint=str(folder/'committed'/('step-'+str(len(rows)).zfill(4))) if rows else None,
        freshFinalHeldoutObjects=len(final),finalSnapshotSummary=summarize(final),
        allPeriodicEvaluationSummary=summarize([o for o in objects if o['evaluationBatch']!='terminal']),
        countsAreCommittedTransactionsOnly=True,teacherCalls=0,baseWeightOptimizerUpdates=0,
        managerUpdates=0,methodHeadUpdates=0,summaryWriterUpdates=0,
        oldScoresChanged=False,heldoutFeedbackUsedForOptimization=False)


def partial(folder,cause):
    v=report(folder,cause);atomic_json(Path(folder)/'partial-result.json',v);return v


def review(folder,destination):
    folder=Path(folder);destination=Path(destination);destination.parent.mkdir(parents=True,exist_ok=True)
    temp=destination.with_name(destination.name+'.'+uuid.uuid4().hex+'.tmp')
    with zipfile.ZipFile(temp,'x',zipfile.ZIP_DEFLATED) as z:
        for p in sorted(folder.rglob('*')):
            if (p.is_file() and p.suffix in ('.json','.log','.txt') and
                '.preparing-' not in str(p.relative_to(folder)) and
                not any(part in ('feature','evaluation-code','previous-attempts') for part in p.relative_to(folder).parts)):
                z.write(p,str(p.relative_to(folder)))
    os.replace(temp,destination);return destination
