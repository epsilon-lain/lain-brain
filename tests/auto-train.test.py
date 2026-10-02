"""Real small AI review, Brain exchange and training-feedback CPU integration.

python tests/auto-train.test.py --source /reviewed/train_gpt.py --initial /affine/checkpoint.pt
The initial parameter is optional; without it a fresh student is pretrained.
"""
import argparse
import fcntl
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

import torch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
import auto_train as runner
import object_train as task


def main(source,initial):
    with tempfile.TemporaryDirectory(prefix='lain-auto-test-') as folder:
        base=Path(folder);project=base/'project';project.mkdir();vault=base/'vault';(vault/'.obsidian').mkdir(parents=True)
        shutil.copyfile(source,project/'train_gpt.py')
        if not initial:
            settings=task.parser().parse_args(['--project',str(project),'--device','cpu','--max-seconds','0'])
            trained=task.run(settings);initial=trained/'checkpoint-002.pt'
        args=runner.parser().parse_args(['--project',str(project),'--vault',str(vault),'--device','cpu',
                                       '--student-checkpoint',str(initial),'--steps-per-round','3','--brain-timeout','5'])
        original_hash=runner.file_digest(initial)
        args.inspect=True;runner.run(args)
        assert not (vault/runner.QUEUE).exists(),'Inspect must not create requests'
        args.inspect=False
        worker=subprocess.Popen(['node','tests/training-sync-worker.mjs',str(vault)],cwd=ROOT,stdout=subprocess.PIPE,text=True)
        try:
            assert worker.stdout.readline().strip()=='READY'
            out=runner.run(args)
        finally:
            worker.terminate();worker.wait(timeout=10)
        assert worker.returncode==0
        done=json.loads((out/'done.json').read_text());assert done['completedRounds']==2 and done['studentUpdates']==6
        assert done['objectReplayExamplesUsed']>0,'Real Brain objects must feed later optimizer batches'
        history=json.loads((vault/'.obsidian/plugins/lain-brain/training-lab.json').read_text())
        assert len(history['rounds'])==2 and all(r['config']['mode']=='brain_objects' for r in history['rounds'])
        first=json.loads((out/'round-001.json').read_text());second=json.loads((out/'round-002.json').read_text())
        assert first['measurements']['steps']==3 and second['measurements']['steps']==6
        assert all(c['teacher']['model'].startswith('local-affine-gpt-') for c in first['candidates'])
        manifests=json.loads((out/'manifest.json').read_text())
        assert manifests['initialCheckpointSha256']==original_hash==runner.file_digest(initial)
        assert runner.file_digest(Path(manifests['reviewerCheckpoint']))==manifests['reviewerCheckpointSha256']
        initial_state=torch.load(out/'initial.pt',weights_only=True)['model_state_dict']
        final_state=torch.load(out/'checkpoint-002.pt',weights_only=True)['model_state_dict']
        assert any(not torch.equal(v,final_state[k]) for k,v in initial_state.items())
        train=task.make_data()['train'];triples={tuple(sorted(x for x,y in r['pairs'])) for r in train}
        derived=json.loads((out/'replay-001.tasks.json').read_text())
        assert derived and all(tuple(sorted(x for x,y in r['pairs'])) in triples for r in derived)
        response=json.loads((out/'brain-feedback-001.json').read_text())
        priority,_,stats=runner.feedback(response,first,train)
        assert stats['acceptedThisRound']>0 and stats['rejectedThisRound']>0
        assert {1,4}.issubset(set(priority.values()))
        assert not any(o['reference']['split']!='train' for o in response['library']['objects'])
        # Cached AI weights are selected again, without further reviewer updates.
        cached=runner.reviewer_checkpoint(args,manifests['modelSourceSha256'],first['dataset'])
        assert str(cached)==manifests['reviewerCheckpoint']
        # Altering supplied coefficient labels does not alter model reviews.
        GPT,_=runner.load_gpt(project/'train_gpt.py');model=runner.restore(GPT,cached,runner.model_config()).eval()
        original=runner.review(first['candidates'],train,model,'cpu',manifests['reviewerCheckpointSha256'])
        changed=[{**r,'coefficients':[999,999]} for r in train]
        assert original==runner.review(first['candidates'],changed,model,'cpu',manifests['reviewerCheckpointSha256'])
        # No response and bad scope stop the process; neither becomes training data.
        disconnected=base/'disconnected';disconnected.mkdir()
        try:runner.exchange(disconnected,'timeout',0.1)
        except TimeoutError:pass
        else:raise AssertionError('Disconnected Brain must stop')
        response['library']['throughRound']=999
        try:runner.feedback(response,first,train)
        except ValueError:pass
        else:raise AssertionError('Wrong boundary must be rejected')
        # A second launcher cannot start overlapping GPU work for this project.
        with (project/'laptop_runs/auto-training.lock').open('a+') as lock:
            fcntl.flock(lock.fileno(),fcntl.LOCK_EX | fcntl.LOCK_NB)
            previous=set((project/'laptop_runs').glob('auto-object-*'))
            try:runner.run(args)
            except RuntimeError:pass
            else:raise AssertionError('Concurrent session must be stopped')
            assert previous==set((project/'laptop_runs').glob('auto-object-*'))
    print('PASS: actual AI review, shared Brain writer, two optimizer rounds, object replay, train-only boundary, cache, target-blind opinions, stopped disconnect')


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--source',type=Path,required=True);p.add_argument('--initial',type=Path)
    args=p.parse_args();main(args.source,args.initial)
