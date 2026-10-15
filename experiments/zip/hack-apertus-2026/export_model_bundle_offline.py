"""Paste this entire file into the original Notebook; no network access needed."""
from pathlib import Path
import base64, hashlib, json, os, uuid, zipfile


def export_lain_model(root='/mnt/workspace/lain-zip-pilot', output='.'):
    root = Path(root).resolve()
    selected = [
        'zip-math-long-362b296b/committed/step-0192/writer.safetensors',
        'zip-scale-curve-309e8004/reward-on-scale-writer-final.safetensors',
        'zip-conditional-final-a1afc8a6/committed/step-0128/meta.safetensors',
        'zip-conditional-final-a1afc8a6/committed/step-0128/editor.safetensors',
    ]
    missing = [s for s in selected if not (root / s).is_file()]
    if missing:
        raise FileNotFoundError('请在原训练 Notebook 运行；缺少：\n' + '\n'.join(missing))
    files = {root / s for s in selected}
    runs = [s.split('/')[0] for s in selected] + [
        'zip-contradiction-626f2c24', 'zip-reflection-reward-e1828281']
    metadata = ['source-checkpoint.json', 'deployment-model.json',
                'deployment-repair.json', 'deployment-reflection.json', 'model-identity.json']
    def references(v):
        if isinstance(v, dict):
            for x in v.values(): yield from references(x)
        elif isinstance(v, list):
            for x in v: yield from references(x)
        elif isinstance(v, str) and v.endswith('.safetensors'):
            p = Path(v) if Path(v).is_absolute() else root / v
            if p.is_file() and p.resolve().is_relative_to(root):
                if p.resolve().relative_to(root).parts[0] != 'models' and p.stat().st_size <= 2*1024**2:
                    yield p
    for run in set(runs):
        for name in metadata:
            p = root / run / name
            if p.is_file():
                files.add(p)
                files.update(references(json.loads(p.read_text())))
    for s in ['zip-contradiction-626f2c24/committed/step-0032/repair.safetensors',
              'zip-reflection-reward-e1828281/committed/step-0064/reflection.safetensors']:
        if (root / s).is_file(): files.add(root / s)
    files.update((root / 'zip-math-long-tools-362b296b').glob('*.py'))
    records = []
    for p in sorted(files):
        if p.is_symlink() or not p.resolve().is_relative_to(root):
            raise ValueError('拒绝外部路径或符号链接：' + str(p))
        if p.suffix not in ('.json', '.py', '.safetensors'):
            raise ValueError('未允许的文件类型')
        records.append({'path': str(p.relative_to(root)), 'bytes': p.stat().st_size})
    if sum(r['bytes'] for r in records) > 24*1024**2:
        raise ValueError('超过 24 MiB 小包上限；尚未导出')
    dest = Path(output).resolve() / ('Lain-ZIP-Model-Bundle-' + uuid.uuid4().hex[:8] + '.zip')
    temp = dest.with_suffix('.zip.tmp')
    try:
        with zipfile.ZipFile(temp, 'x', zipfile.ZIP_DEFLATED) as z:
            for r in records:
                data = (root / r['path']).read_bytes()
                r['sha256'] = hashlib.sha256(data).hexdigest()
                z.writestr('original/' + r['path'], data)
            z.writestr('model-bundle-manifest.json', json.dumps({
                'format': 'lain-zip-small-model-bundle-v1', 'files': records,
                'baseWeightsIncluded': False, 'editorEffectiveUpdates': 0,
                'trainingUpdates': 0, 'networkCalls': 0}, indent=2))
        with zipfile.ZipFile(temp) as z:
            if z.testzip(): raise RuntimeError('ZIP 校验失败')
        os.replace(temp, dest)
    finally:
        if temp.exists(): temp.unlink()
    print('已导出：', dest, '\n大小：', round(dest.stat().st_size/1024**2, 2), 'MiB')
    try:
        from IPython.display import display, HTML, FileLink
        display(FileLink(str(dest)))
        if dest.stat().st_size <= 8*1024**2:
            data = base64.b64encode(dest.read_bytes()).decode()
            display(HTML(f'<a download="{dest.name}" href="data:application/zip;base64,{data}">下载模型小包</a>'))
    except ImportError:
        pass
    return dest


if __name__ == '__main__':
    export_lain_model()
