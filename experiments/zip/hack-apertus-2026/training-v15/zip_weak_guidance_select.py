"""Choose source by fixed chronological protocol; never choose by heldout score."""
import json
from pathlib import Path
PROTOCOL='lain-zip-editable-weak-guidance-training-v10'

def select_source(work,default,source_override=None,recover_override=None):
    if recover_override:return Path(json.loads((recover_override/'source-checkpoint.json').read_text())['parentSource']),recover_override
    if source_override:return source_override,None
    completed=[];partial=[]
    for path in Path(work).glob('zip-weak-guidance-*/protocol.json'):
        row=json.loads(path.read_text())
        if row.get('protocol')!=PROTOCOL:continue
        number=row['experimentNumber'];folder=path.parent
        r=json.loads((folder/'result.json').read_text()) if (folder/'result.json').is_file() else {}
        if r.get('completeTrainingExperiment') is True and r.get('stopReason')=='completed' and r.get('error') is None and (folder/'run-file-manifest.json').is_file():
            completed.append((number,folder))
        elif (folder/'checkpoints/after-4.json').is_file():
            partial.append((number,len(list((folder/'responses').glob('*-raw.json'))),folder))
    last=max((number for number,folder in completed),default=0)
    partial=[v for v in partial if v[0]>last]
    if partial:
        partial.sort(key=lambda v:(v[0],v[1]));folder=partial[-1][2]
        return Path(json.loads((folder/'source-checkpoint.json').read_text())['parentSource']),folder
    if completed:
        completed.sort(key=lambda v:v[0])
        if len(completed)>1 and completed[-1][0]==completed[-2][0]:raise ValueError('Duplicate complete course numbers')
        return completed[-1][1],None
    return default,None
