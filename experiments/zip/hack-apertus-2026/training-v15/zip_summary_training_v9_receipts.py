"""Durable phase receipts and a review that also works after a hard kill."""
import json
import os
from pathlib import Path
import uuid
import zipfile
from zip_summary_training_v8_core import summarize, digest, require
from zip_summary_training_v8_entry import small_review_paths


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with temp.open('x', encoding='utf-8') as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)


def partial_report(folder, cause=None):
    folder = Path(folder)
    def rows(kind):
        return [json.loads(p.read_text()) for p in sorted((folder/kind).glob('*.json'))]
    objects = rows('object')
    manager = rows('management-step'); writer = rows('summary-step')
    course = dict(objects=objects, managementChoices=rows('management-choice'),
        managementFeedback=rows('management-feedback'), revisions=rows('summary'),
        revisionFeedback=rows('revision-feedback'))
    return dict(protocol='lain-zip-memory-management-save-receipt-v9',
        completeTrainingExperiment=False, integrityChecksPending=True,
        cause=cause, actualSavedRawResponses=len(list((folder/'responses').glob('*-raw.json'))),
        completedTrainingObjects=sum(o['phase']=='training' for o in objects),
        completedHeldoutObjects=sum(o['phase']=='heldout' for o in objects),
        committedManagementStepFiles=len(manager), committedSummaryStepFiles=len(writer),
        countsAreSavedEvidenceNotLearningBenefit=True, summary=summarize(course))


def publish_partial(folder, cause=None):
    row = partial_report(folder, cause)
    atomic_json(Path(folder)/'partial-result.json', row)
    return row


def phase_receipt(folder, bank, checkpoint):
    """Call at TRAIN checkpoint, after all feedback/steps, before any HELD work."""
    require(checkpoint['entriesHash']==digest(bank['entries']) and
        checkpoint['historiesHash']==digest(bank['history']) and
        checkpoint['statusesHash']==digest(bank['statuses']), 'Checkpoint and bank differ')
    atomic_json(Path(folder)/'training-bank-receipt.json', dict(bank=bank,
        checkpoint=checkpoint, trainingPhaseComplete=True, heldoutPhaseComplete=False,
        admissionRequiresOriginalAlgorithmReplay=True))
    publish_partial(folder, 'training_complete_evaluation_pending')


def review_paths(folder):
    folder=Path(folder); seen=set()
    for path in small_review_paths(folder):
        if path not in seen:seen.add(path);yield path
    for name in ('partial-result.json','training-bank-receipt.json','recovery.json','error.json',
        'management-initial.json','memory-bank.json'):
        path=folder/name
        if path.is_file() and path not in seen:seen.add(path);yield path
    for name in ('summary','summary-step','management-step','decision'):
        for path in sorted((folder/name).glob('*.json')):
            if path not in seen:seen.add(path);yield path


def harvest_review(folder, destination):
    """No vectors, weights or ancestral copies; actual raw/feedback always included."""
    folder=Path(folder); destination=Path(destination)
    destination.parent.mkdir(parents=True,exist_ok=True)
    temporary=destination.with_name(destination.name+'.'+uuid.uuid4().hex+'.tmp')
    paths=list(review_paths(folder))
    with zipfile.ZipFile(temporary,'x',zipfile.ZIP_DEFLATED) as archive:
        for path in paths:archive.write(path,str(path.relative_to(folder)))
        if not paths:archive.writestr('NO_RETURNED_STUDENT_DATA.txt',
            'No returned student data exists in this folder; this is not a completed experiment.')
    os.replace(temporary,destination)
    return dict(files=len(paths),bytes=destination.stat().st_size)
