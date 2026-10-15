"""Small durable receipts; actual originals are harvested even without a result."""
import json
import os
from pathlib import Path
import zipfile
import uuid
from zip_summary_training_v9_receipts import atomic_json
from zip_weak_guidance_core import summarize,digest,require

def partial_report(folder,cause=None):
    folder=Path(folder)
    def rows(kind):return [json.loads(p.read_text()) for p in sorted((folder/kind).glob('*.json'))]
    objects=rows('object');guides=rows('guide')
    return dict(protocol='lain-zip-weak-guidance-receipt-v10',completeTrainingExperiment=False,
        integrityChecksPending=True,cause=cause,actualSavedRawResponses=len(list((folder/'responses').glob('*-raw.json'))),
        committedWarmSteps=len(rows('warm-step')),committedManagementSteps=len(rows('management-step')),
        committedGuideSteps=len(rows('guide-step')),completedTrainingObjects=sum(o['phase']=='training' for o in objects),
        completedHeldoutObjects=sum(o['phase']=='heldout' for o in objects),
        summary=summarize(dict(objects=objects,guideCandidates=guides)))

def publish_partial(folder,cause=None):
    value=partial_report(folder,cause);atomic_json(Path(folder)/'partial-result.json',value);return value

def harvest_review(folder,destination):
    folder=Path(folder);destination=Path(destination);temp=destination.with_name(destination.name+'.'+uuid.uuid4().hex+'.tmp')
    paths=[]
    for name in ('result.json','partial-result.json','protocol.json','source-checkpoint.json','weak-guidance-questions.json',
        'initial-bank.json','memory-bank.json','training-bank-receipt.json','warm-lessons.json','error.json'):
        path=folder/name
        if path.is_file():paths.append(path)
    for kind in ('responses','guide','guide-feedback','guide-measurement','guide-final-measurement','management-choice','management-feedback',
        'reuse-history','object','trial','interface-probe','warm-step','management-step','guide-step'):
        for path in sorted((folder/kind).glob('*.json')):
            if kind=='responses' and not path.name.endswith('-raw.json'):continue
            paths.append(path)
    destination.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(temp,'x',zipfile.ZIP_DEFLATED) as archive:
        for path in paths:archive.write(path,str(path.relative_to(folder)))
        if not paths:archive.writestr('NO_STUDENT_DATA.txt','No student responses have been returned.')
    os.replace(temp,destination);return dict(files=len(paths),bytes=destination.stat().st_size)

def training_receipt(folder,bank,checkpoint):
    require(checkpoint['bankHash']==digest(bank),'Different completed TRAIN bank')
    atomic_json(Path(folder)/'training-bank-receipt.json',dict(bank=bank,checkpoint=checkpoint,
        trainingPhaseComplete=True,heldoutPhaseComplete=False,admissionRequiresSavedAlgorithmReplay=True))
    publish_partial(folder,'training_complete_evaluation_pending')
