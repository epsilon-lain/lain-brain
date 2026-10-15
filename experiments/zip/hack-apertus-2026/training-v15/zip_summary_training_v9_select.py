"""Deterministic latest committed phase selection; no metric-based selection."""
import json
from pathlib import Path

def select_source(work,source_default,recover_default,source_override=None,recover_override=None,new_course=False):
    SOURCE=source_default;RECOVER=recover_default
    if recover_override:
        return Path(json.loads((recover_override/'source-checkpoint.json').read_text())['parentSource']),recover_override
    if source_override:return source_override,None
    values=[];recovered=False
    for path in work.glob('zip-summary-training-*/result.json'):
        row=json.loads(path.read_text())
        if (row.get('protocol')=='lain-zip-memory-management-training-v8' and row.get('stopReason')=='completed' and
            row.get('error') is None and row.get('completeTrainingExperiment') is True and
            (path.parent/'run-file-manifest.json').is_file()):
            values.append((row['trainingRound'],path.parent))
            if row.get('recoveryOriginalFolder')==str(RECOVER.resolve()):recovered=True
    latest_complete=max((v[0] for v in values),default=-1)
    if not new_course:
        partial=[]
        for path in work.glob('zip-summary-training-*/protocol.json'):
            row=json.loads(path.read_text())
            if (row.get('protocol')=='lain-zip-memory-management-training-v8' and
                row.get('trainingRound',-1)>latest_complete and
                (path.parent/'checkpoints/after-8.json').is_file()):
                partial.append((row['trainingRound'],len(list((path.parent/'responses').glob('*-raw.json'))),path.parent))
        if partial:
            partial.sort(key=lambda row:(row[0],row[1]))
            target=partial[-1][2]
            return Path(json.loads((target/'source-checkpoint.json').read_text())['parentSource']),target
    if not new_course and not recovered and RECOVER.is_dir() and not values:
        # A previous failed recovery may have returned more HELD originals.
        # Prefer that saved prefix, never its measured score.
        recoverable=[RECOVER]
        for path in work.glob('zip-summary-training-*/recovery.json'):
            row=json.loads(path.read_text())
            if row.get('originalFolder')==str(RECOVER.resolve()) and (path.parent/'checkpoints/after-8.json').is_file():
                recoverable.append(path.parent)
        target=max(recoverable,key=lambda p:len(list((p/'responses').glob('*-raw.json'))))
        return Path(json.loads((target/'source-checkpoint.json').read_text())['parentSource']),target
    if not values:return SOURCE,None
    values.sort(key=lambda x:x[0])
    if len(values)>1 and values[-1][0]==values[-2][0]:
        raise RuntimeError('Duplicate complete round numbers; use --source to choose a checkpoint')
    return values[-1][1],None
