"""Run once in the ORIGINAL Notebook: export small actual adapters, no training/network.

Only named safetensors, binding metadata and selected runtime Python are copied.
No base weights, optimizer pickle, raw-response archive or account token is read.
"""
import argparse
import base64
import hashlib
import html
import json
import os
from pathlib import Path
import re
import sys
import uuid
import zipfile

DEFAULT_ROOT = Path('/mnt/workspace/lain-zip-pilot')
SELECTED = [
    'zip-math-long-362b296b/committed/step-0192/writer.safetensors',
    'zip-scale-curve-309e8004/reward-on-scale-writer-final.safetensors',
    'zip-conditional-final-a1afc8a6/committed/step-0128/meta.safetensors',
    'zip-conditional-final-a1afc8a6/committed/step-0128/editor.safetensors',
]
RUNS = ['zip-math-long-362b296b', 'zip-scale-curve-309e8004',
        'zip-conditional-final-a1afc8a6', 'zip-reflection-reward-e1828281',
        'zip-contradiction-626f2c24']
METADATA = ['source-checkpoint.json', 'deployment-model.json', 'deployment-repair.json',
            'deployment-reflection.json', 'model-identity.json', 'terminal-snapshot.json',
            'frozen-evaluation-checkpoint.json', 'student-snapshot-provenance.json']
MAX_BYTES = 24 * 1024 * 1024


def sha(data):
    return hashlib.sha256(data).hexdigest()


def inside(root, path):
    original = Path(path)
    resolved = original.resolve()
    if not resolved.is_relative_to(root) or not original.is_file():
        raise ValueError('Missing file or path outside the original workspace: ' + str(original))
    # A resolved path alone would conceal symlink components.
    relative = original.absolute().relative_to(root)
    probe = root
    for component in relative.parts:
        probe = probe / component
        if probe.is_symlink():
            raise ValueError('Refuse symlink: ' + str(probe))
    return resolved


def inspect_safetensors(path):
    with path.open('rb') as f:
        length_raw = f.read(8)
        if len(length_raw) != 8:
            raise ValueError('Truncated safetensors file: ' + str(path))
        length = int.from_bytes(length_raw, 'little')
        if not 2 <= length <= min(1024 * 1024, path.stat().st_size - 8):
            raise ValueError('Invalid safetensors header size')
        header = json.loads(f.read(length))
    tensors = {k: v for k, v in header.items() if k != '__metadata__'}
    if not tensors or any(not isinstance(v, dict) or 'shape' not in v or
                          'data_offsets' not in v for v in tensors.values()):
        raise ValueError('No tensor metadata in checkpoint')
    payload_bytes = path.stat().st_size - 8 - length
    for value in tensors.values():
        offsets = value['data_offsets']
        if len(offsets) != 2 or not 0 <= offsets[0] <= offsets[1] <= payload_bytes:
            raise ValueError('Invalid tensor payload offsets')
    return [{'name': k, 'shape': v['shape'], 'dtype': v.get('dtype')}
            for k, v in tensors.items()]


def source_checkpoint_references(value, root):
    if isinstance(value, dict):
        for child in value.values():
            yield from source_checkpoint_references(child, root)
    elif isinstance(value, list):
        for child in value:
            yield from source_checkpoint_references(child, root)
    elif isinstance(value, str) and value.endswith('.safetensors'):
        path = Path(value)
        path = path if path.is_absolute() else root / path
        if path.is_file():
            path = inside(root, path)
            relative = path.relative_to(root)
            if relative.parts[0] == 'models' or path.stat().st_size > 2 * 1024 * 1024:
                return  # Base model references are metadata, not adapter export requests.
            yield path


def export(root, output):
    root = Path(root).resolve()
    if not root.is_dir():
        raise ValueError('Run in the original training Notebook; source root is absent')
    missing = [name for name in SELECTED if not (root / name).is_file()]
    if missing:
        raise ValueError('Required original checkpoints are missing; no replacement generated:\n' + '\n'.join(missing))
    files = {inside(root, root / name) for name in SELECTED}
    for name in [
        'zip-contradiction-626f2c24/committed/step-0032/repair.safetensors',
        'zip-reflection-reward-e1828281/committed/step-0064/reflection.safetensors',
    ]:
        if (root / name).is_file():
            files.add(inside(root, root / name))
    metadata = {}
    for run in RUNS:
        for name in METADATA:
            path = root / run / name
            if path.is_file():
                path = inside(root, path)
                if path.stat().st_size > 2 * 1024 * 1024:
                    raise ValueError('Unexpectedly large binding metadata: ' + str(path))
                value = json.loads(path.read_text())
                metadata[path] = value
                files.add(path)
                files.update(source_checkpoint_references(value, root))
    # Dependencies found in source bindings are original checkpoint bytes, not inferred states.
    for path in list(root.glob('zip-math-long-tools-362b296b/*.py')):
        files.add(inside(root, path))
    total = sum(p.stat().st_size for p in files)
    if total > MAX_BYTES:
        raise ValueError(f'Selected files total {total} bytes, above small-bundle cap; nothing exported')
    records = []
    # Inspect before creating any archive. No torch import or pickle loading occurs.
    for path in sorted(files):
        if path.suffix not in ('.safetensors', '.json', '.py'):
            raise ValueError('Disallowed export type: ' + str(path))
        data = path.read_bytes()
        if path.suffix in ('.json', '.py'):
            text = data.decode('utf-8')
            if re.search(r'(?:hf_|ghp_|github_pat_|sk-)[A-Za-z0-9_\-]{24,}', text):
                raise ValueError('Potential credential in selected text; inspect locally before exporting')
        record = {'path': str(path.relative_to(root)), 'bytes': len(data), 'sha256': sha(data)}
        if path.suffix == '.safetensors':
            record['tensors'] = inspect_safetensors(path)
        records.append(record)
    manifest = {
        'format': 'lain-zip-small-model-bundle-v1',
        'baseModel': 'swiss-ai/Apertus-v1.1-0.5B-Instruct',
        'selectedOriginalCheckpoints': SELECTED,
        'files': records, 'sourceBytes': total,
        'baseWeightsIncluded': False, 'optimizerPicklesIncluded': False,
        'trainingUpdates': 0, 'studentGenerations': 0, 'networkCalls': 0,
        'editorEffectiveUpdates': 0,
        'note': 'Original custom adapters; no PEFT conversion, merging or new training. File hashes are computed from actual bytes. Dependencies are limited to directly referenced safetensors in selected binding files.'}
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    destination = output / ('Lain-ZIP-Model-Bundle-' + uuid.uuid4().hex[:8] + '.zip')
    temporary = destination.with_suffix('.zip.tmp')
    try:
        with zipfile.ZipFile(temporary, 'x', zipfile.ZIP_DEFLATED) as archive:
            for record in records:
                path = inside(root, root / record['path'])
                data = path.read_bytes()
                if sha(data) != record['sha256']:
                    raise ValueError('Source changed during export: ' + record['path'])
                archive.writestr('original/' + record['path'], data)
            archive.writestr('model-bundle-manifest.json', json.dumps(manifest, indent=2))
        with zipfile.ZipFile(temporary) as archive:
            if archive.testzip() is not None:
                raise RuntimeError('Bundle ZIP integrity failure')
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()
    print('模型小包：', destination)
    print('大小：', round(destination.stat().st_size / 1024 / 1024, 2), 'MiB；文件数：', len(records))
    print('未训练、未加载模型、未上传；editor 有效训练更新为 0，已如实标注。')
    try:
        from IPython.display import FileLink, HTML, display
        display(FileLink(str(destination)))
        if destination.stat().st_size <= 8 * 1024 * 1024:
            encoded = base64.b64encode(destination.read_bytes()).decode('ascii')
            display(HTML('<a download="' + html.escape(destination.name, quote=True) +
                         '" href="data:application/zip;base64,' + encoded + '">下载模型小包</a>'))
    except ImportError:
        pass
    return destination


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    p.add_argument('--output', type=Path, default=Path.cwd())
    args = p.parse_args([] if 'ipykernel' in Path(sys.argv[0]).name else None)
    export(args.root, args.output)


if __name__ == '__main__':
    main()
