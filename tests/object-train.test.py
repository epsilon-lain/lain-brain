"""Actual GPT updates, definition decoding, split integrity and Brain integration.

python tests/object-train.test.py --source /path/to/reviewed/train_gpt.py
Requires torch, node, npm ci; no network, teacher or GPU required.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import object_train as runner


def main(source):
    data = runner.make_data()
    assert data == runner.make_data(), 'Dataset independent of model randomness'
    assert (len(data['train']), len(data['eval'])) == (2160, 990)
    triples = lambda rows: {tuple(sorted(x for x, y in r['pairs'])) for r in rows}
    assert triples(data['train']).isdisjoint(triples(data['eval'])), 'No permutation leakage'
    assert {tuple(r['coefficients']) for r in data['train']} == {tuple(r['coefficients']) for r in data['eval']}
    for rows in data.values():
        for r in rows:
            a, b = r['coefficients']
            assert len({x for x, y in r['pairs']}) == 3
            assert all(a * x + b == y for x, y in r['pairs'])
            assert all(0 <= token < runner.VOCAB_SIZE for token in runner.prompt(r))

    # Guard the autoregressive metric against teacher-forced second tokens.
    captured = []
    original = runner.logits
    def fake_logits(model, ids):
        captured.append(ids.clone())
        scores = torch.zeros((*ids.shape, runner.VOCAB_SIZE))
        scores[:, -1, runner.number_token(-2 if len(captured) == 1 else 1)] = 100
        return scores
    runner.logits = fake_logits
    x, _ = runner.tensors(data['eval'][:2], 'cpu')
    assert runner.predict(None, x).tolist() == [[-2, 1], [-2, 1]]
    assert captured[1][:, -1].tolist() == [runner.number_token(-2)] * 2
    runner.logits = original

    # Wrong model output remains wrong; the renderer does not solve or repair it.
    wrong = [[a + 1 if a < 2 else a - 1, b] for a, b in [r['coefficients'] for r in data['train']]]
    proposals = runner.propose(data['train'], wrong, 1)
    assert len(proposals) == 15
    assert proposals[0]['definition'] == runner.definition(*wrong[0])
    assert proposals[0]['definition'] != runner.definition(*data['train'][0]['coefficients'])

    with tempfile.TemporaryDirectory(prefix='lain-object-test-') as folder:
        project = Path(folder)
        shutil.copyfile(source, project / 'train_gpt.py')
        source_hash = runner.file_digest(project / 'train_gpt.py')
        args = runner.parser().parse_args(['--project', str(project), '--device', 'cpu',
                                          '--steps', '3', '--round-every', '2', '--max-seconds', '0'])
        args.inspect = True
        runner.run(args)
        assert not (project / 'laptop_runs').exists()
        args.inspect = False
        out = runner.run(args)
        initial = torch.load(out / 'initial.pt', weights_only=True)
        final = torch.load(out / 'checkpoint-002.pt', weights_only=True)
        assert any(not torch.equal(v, final['model_state_dict'][k]) for k, v in initial['model_state_dict'].items())
        GPT, _ = runner.load_gpt(project / 'train_gpt.py')
        model = GPT(**final['model_config'])
        model.load_state_dict(final['model_state_dict'], strict=True)
        x, y = runner.tensors(data['eval'][:8], 'cpu')
        normal, predicted = runner.evaluate(model, x, y)
        changed, still_predicted = runner.evaluate(model, x, torch.flip(y, dims=[0]))
        assert predicted == still_predicted, 'Evaluation answers cannot affect decoded definitions'
        assert torch.isfinite(runner.loss(model, x, y))
        for n, steps in [(1, 2), (2, 3)]:
            record = json.loads((out / f'round-{n:03}.json').read_text())
            assert record['measurements']['steps'] == steps
            assert record['student']['checkpointSha256'] == runner.file_digest(out / f'checkpoint-{n:03}.pt')
            for split in ['train', 'eval']:
                assert record['dataset'][f'{split}Sha256'] == runner.file_digest(out / f'{split}.tasks.json')
            assert all(c['reference']['split'] == 'train' for c in record['candidates'])
        assert runner.file_digest(project / 'train_gpt.py') == source_hash
        subprocess.run(['node', str(ROOT / 'tests/object-train-import.test.mjs'), str(out)], cwd=ROOT, check=True)
    print('PASS: disjoint context groups, autoregressive decoding, unmodified wrong proposals, real updates, reload, hashes, Brain acceptance/export')


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', type=Path, required=True)
    main(p.parse_args().source)
