"""Verify published adapter bytes and tensor-state identities without Torch."""
import hashlib
import json
import math
from pathlib import Path
import struct


def inspect(data):
    if len(data) < 10:
        raise ValueError('Truncated safetensors')
    n = int.from_bytes(data[:8], 'little')
    if not 2 <= n <= min(1024 * 1024, len(data) - 8):
        raise ValueError('Invalid header length')
    header = json.loads(data[8:8+n])
    tensors = {k: v for k, v in header.items() if k != '__metadata__'}
    if len(tensors) != 16:
        raise ValueError('Expected 16 rank-8 q/v adapter tensors')
    state = hashlib.sha256()
    ranges = []
    for name, value in sorted(tensors.items()):
        shape = value['shape']
        lo, hi = value['data_offsets']
        if value['dtype'] != 'F32' or len(shape) != 2 or 8 not in shape:
            raise ValueError('Unexpected tensor dtype or adapter rank')
        if not 0 <= lo <= hi <= len(data)-8-n or hi-lo != math.prod(shape)*4:
            raise ValueError('Invalid tensor payload')
        raw = data[8+n+lo:8+n+hi]
        if not all(math.isfinite(x[0]) for x in struct.iter_unpack('<f', raw)):
            raise ValueError('Nonfinite tensor')
        state.update(name.encode())
        state.update(b'torch.float32')
        state.update(str(tuple(shape)).encode())
        state.update(raw)
        ranges.append((lo, hi))
    cursor = 0
    for lo, hi in sorted(ranges):
        if lo != cursor:
            raise ValueError('Overlapping or unaccounted tensor payload')
        cursor = hi
    if cursor != len(data)-8-n:
        raise ValueError('Unaccounted bytes at end of checkpoint')
    return state.hexdigest()


def main():
    root = Path(__file__).resolve().parent
    manifest = json.loads((root/'checkpoint-manifest.json').read_text())
    checked = {}
    for record in manifest['files']:
        path = (root/record['publishedPath']).resolve()
        if not path.is_relative_to(root):
            raise ValueError('Manifest path outside release')
        data = path.read_bytes()
        if len(data) != record['bytes'] or hashlib.sha256(data).hexdigest() != record['sha256']:
            raise ValueError('File hash/size mismatch: '+record['publishedPath'])
        state = inspect(data)
        if state != record['tensorStateSha256']:
            raise ValueError('Tensor-state mismatch: '+record['publishedPath'])
        checked[record['publishedPath']] = state
        print('PASS', record['publishedPath'])
    deployment = json.loads((root/'provenance/zip-math-long-362b296b/deployment-model.json').read_text())
    binding = json.loads((root/'provenance/zip-conditional-final-a1afc8a6/source-checkpoint.json').read_text())
    for name, expected in [
        ('math-writer-v15', deployment['writerHash']),
        ('math-writer-v15', binding['oldWriterHash']),
        ('repair-v19', binding['oldRepairHash']),
        ('reflection-v23', binding['priorReflectionHash']),
    ]:
        if checked['models/'+name+'.safetensors'] != expected:
            raise ValueError('Original deployment/source binding mismatch')
    editor = (root/'models/conditional-editor-initial-v24.safetensors').read_bytes()
    if hashlib.sha256(editor).hexdigest() != binding['initialEditorFileHash']:
        raise ValueError('Editor differs from original initial bytes')
    print(f'{len(checked)} adapter files and original bindings verified; base inference not run.')


if __name__ == '__main__':
    main()
