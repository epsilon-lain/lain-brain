"""Inventory/export explicitly selected local checkpoints, without uploading.

Run in the original training host. No unpickling, merging or PEFT conversion.
"""
import argparse,hashlib,json,zipfile
from pathlib import Path
ALLOWED={'.safetensors','.pt','.pth','.bin'}
def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(8*1024*1024),b''):h.update(chunk)
    return h.hexdigest()
def inventory(root):
    root=Path(root).resolve()
    if not root.is_dir():raise ValueError('Training directory does not exist in this environment')
    return [{'relativePath':str(p.relative_to(root)),'bytes':p.stat().st_size} for p in sorted(root.rglob('*'))
        if p.is_file() and not p.is_symlink() and p.suffix.lower() in ALLOWED]
def export(root,files,destination):
    root=Path(root).resolve();destination=Path(destination).resolve()
    if destination.exists():raise ValueError('Refuse to overwrite an existing export')
    selected=[]
    for name in files:
        original=root/name;p=original.resolve()
        if not p.is_relative_to(root) or original.is_symlink() or not p.is_file() or p.suffix.lower() not in ALLOWED:
            raise ValueError('Select checkpoint files inside the specified training directory')
        selected.append((p,{'relativePath':str(p.relative_to(root)),'bytes':p.stat().st_size,'sha256':digest(p)}))
    if not selected:raise ValueError('Select at least one actual checkpoint file')
    manifest={'purpose':'Explicit local checkpoint export, not model publication','baseModel':'swiss-ai/Apertus-v1.1-0.5B-Instruct',
        'format':'Original custom training checkpoint; PEFT compatibility not claimed','files':[m for p,m in selected],
        'tokenizerAndBaseWeightsNotBundled':True,'optimizerStateIncludedOnlyIfExplicitlySelected':True,
        'loadMethod':'Use the original version-matched training loader; export does not convert or merge weights.'}
    destination.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(destination,'x',zipfile.ZIP_STORED) as z:
        for p,m in selected:z.write(p,'checkpoints/'+m['relativePath'])
        z.writestr('checkpoint-manifest.json',json.dumps(manifest,indent=2))
    return {'archive':str(destination),'files':manifest['files'],'uploaded':False}
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--files',nargs='+');parser.add_argument('--out',type=Path)
    args=parser.parse_args()
    if args.files:
        if not args.out:parser.error('--out is required with --files')
        print(json.dumps(export(args.root,args.files,args.out),indent=2))
    else:print(json.dumps({'candidates':inventory(args.root),'weightsExported':False,
        'note':'Choose the committed final checkpoint, not an arbitrary latest filename; then use --files and --out.'},indent=2))
