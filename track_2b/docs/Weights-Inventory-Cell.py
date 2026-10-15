"""Copy this entire cell into the ORIGINAL training Notebook.

Read-only inventory. It never changes a model, trains, or uploads anything.
"""
from pathlib import Path
import json
training_root=Path('/mnt/workspace/lain-zip-pilot/zip-conditional-final-a1afc8a6')
if not training_root.is_dir():
    print('Original training folder not found. Open the original training Notebook or set training_root to its actual output directory.')
else:
    candidates=[]
    for checkpoint_path in sorted(training_root.rglob('*')):
        if checkpoint_path.is_file() and not checkpoint_path.is_symlink() and checkpoint_path.suffix.lower() in {'.safetensors','.pt','.pth','.bin'}:
            candidates.append({'relativePath':str(checkpoint_path.relative_to(training_root)),'MiB':round(checkpoint_path.stat().st_size/1024**2,3)})
    print(json.dumps({'trainingDirectory':str(training_root),'checkpointCandidates':candidates,'filesModified':0,'uploaded':False},indent=2))
