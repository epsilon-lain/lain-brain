"""Every returned original survives pause; reviews exclude weight/vector bulk."""
import json
import os
from pathlib import Path
import uuid
import zipfile
from zip_summary_training_v9_receipts import atomic_json
from zip_management_context_core import PROTOCOL, summarize, digest, require


def partial(folder,cause=None):
    folder=Path(folder)
    def rows(name):return [json.loads(p.read_text()) for p in sorted((folder/name).glob('*.json'))]
    steps=rows('head-step');objects=rows('object')
    receipt=folder/'training-receipt.json'
    value=dict(protocol=PROTOCOL,stopReason=cause,completeTrainingExperiment=False,
        integrityChecksPending=True,actualStudentGenerations=len(rows('responses')),
        actualManagementHeadUpdates=sum(s['updated'] for s in steps),
        actualGlobalControlUpdates=sum(s.get('controlUpdated',False) for s in steps),
        freshTrainingObjects=len(rows('fresh-training-case')),completedHeadOpportunities=len(steps),trainingReceiptSaved=receipt.is_file(),
        completedHeldoutObjects=len(objects),summary=summarize(objects))
    atomic_json(folder/'partial-result.json',value);return value


def review(folder,destination):
    folder=Path(folder);destination=Path(destination)
    temp=destination.with_name(destination.name+'.'+uuid.uuid4().hex+'.tmp')
    paths=[]
    for name in ('result.json','partial-result.json','protocol.json','plan.json','source-checkpoint.json',
                 'training-receipt.json','error.json','startup-error.json','launcher-status.json',
                 'child-output.log','phase-timing.json','stop-request.json','recovery.json','input-preflight.json'):
        p=folder/name
        if p.is_file():paths.append(p)
    for kind in ('responses','source-originals','training-case','guide-original','guide-measurement',
                 'management-decision','method-decision','math-audit','head-step','object',
                 'fresh-training-case','control-initial','training-diagnostic'):
        paths+=sorted((folder/kind).glob('*.json'))
    destination.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(temp,'x',zipfile.ZIP_DEFLATED) as archive:
        for path in paths:archive.write(path,str(path.relative_to(folder)))
        if not paths:archive.writestr('NO_RETURNED_STUDENT_DATA.txt','No response returned yet.')
    os.replace(temp,destination)
    return dict(files=len(paths),bytes=destination.stat().st_size)


def source_binding(source,hashes):
    return dict(source=str(Path(source).resolve()),sourceFiles=hashes,
                originalV11Complete=True,admittedPhase='complete v11 checkpoint and replayed TRAIN head ledger')
