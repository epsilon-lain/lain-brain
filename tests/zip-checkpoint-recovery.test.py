"""Real saved-adapter restore and screening with scripted math generations.

No official weights, training or external teacher call; no quality estimate.
"""
from contextlib import redirect_stdout
from dataclasses import asdict
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

import torch
from safetensors.torch import save_file
from tokenizers import Tokenizer
from tokenizers.models import WordLevel
from tokenizers.pre_tokenizers import Whitespace
from transformers import ApertusConfig, ApertusForCausalLM, PreTrainedTokenizerFast

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import zip_checkpoint_recovery as recovery
import zip_interface_warmup as warmup
from zip_pilot import file_digest, load_student
from zip_pilot_protocol import canonical, tasks, write_json

torch.set_num_threads(2)
raw = Tokenizer(WordLevel({"[UNK]":0, "[EOS]":1, "x":2, "u":3, "change":4,
    "system":5, "assistant":6, "user":7}, unk_token="[UNK]"))
raw.pre_tokenizer = Whitespace()
tokenizer = PreTrainedTokenizerFast(tokenizer_object=raw, unk_token="[UNK]", eos_token="[EOS]", pad_token="[EOS]")
tokenizer.chat_template = "{% for message in messages %}{{ message['role'] + ': ' + message['content'] + '\\n' }}{% endfor %}{% if add_generation_prompt %}assistant: {% endif %}"
torch.manual_seed(1337)
base = ApertusForCausalLM(ApertusConfig(vocab_size=8, hidden_size=32, intermediate_size=64,
    num_hidden_layers=2, num_attention_heads=4, num_key_value_heads=2, eos_token_id=1,
    bos_token_id=None, pad_token_id=1, tie_word_embeddings=True, max_position_embeddings=4096,
    rope_theta=500000.0, rope_scaling={"rope_type":"linear", "factor":1.0}, attn_implementation="sdpa"))
base.generation_config.eos_token_id = [1]

assert not recovery.improvement({'square':1,'product':0},{'square':0,'product':1},{'square':1,'product':0})
assert not recovery.improvement({'square':1,'product':0},{'square':1},{'square':1,'product':0})
assert recovery.improvement({'square':1,'product':0},{'square':1,'product':1},{'square':1,'product':0})
assert 'order of the order' not in recovery.REVIEW_REQUEST
assert 'quote the exact words' in recovery.REVIEW_REQUEST

with tempfile.TemporaryDirectory(prefix="checkpoint-recovery-") as temporary:
    root = Path(temporary)
    snapshot = root / 'student'
    base.save_pretrained(snapshot, safe_serialization=True)
    tokenizer.save_pretrained(snapshot)
    loaded, tok, metadata = load_student(snapshot, 'cpu')
    frozen = warmup.state_digest(loaded)
    adapter = warmup.InterfaceAdapter(loaded, tok, rank=8)
    with torch.no_grad():
        adapter.generation_adapter[-1].weight.fill_(.01)
    baseline_state = {k:v.clone() for k,v in adapter.adapter_state().items()}
    adapter.close()
    parent, source, failed = [root / n for n in ['parent','correction','failed-notes']]
    for directory in [parent, source, failed]: directory.mkdir()
    parent.with_suffix('.py').write_text('\n'+(ROOT/'tools/zip_interface_warmup.py').read_text())
    parent_sha_source = file_digest(parent.with_suffix('.py'))
    save_file(baseline_state, str(parent/'interface.safetensors'))
    parent_sha = file_digest(parent/'interface.safetensors')
    write_json(parent/'manifest.json',dict(protocol=recovery.PROTOCOL,stage='supervised-interface-and-toy-task-preparation',
        rank=8,snapshotSha256=metadata['snapshotSha256'],warmupSourceSha256=parent_sha_source))
    write_json(parent/'result.json',dict(updates=12,baseWeightsUnchanged=True,adapterSha256=parent_sha))
    for step in [6,12,18,24]:
        state = {k:v.clone() for k,v in baseline_state.items()}
        state['generation_adapter.2.bias'][0] = step
        save_file(state,str(source/f'checkpoint-{step:03d}.safetensors'))
    (source/'interface.safetensors').write_bytes((source/'checkpoint-024.safetensors').read_bytes())
    source_sha=file_digest(source/'interface.safetensors')
    write_json(source/'manifest.json',dict(protocol=recovery.PROTOCOL,
        preparationKind='supervised-correction-with-replayed-training-feedback',parentRun=str(parent),
        parentAdapterSha256=parent_sha,rank=8,snapshotSha256=metadata['snapshotSha256']))
    write_json(source/'result.json',dict(baseWeightsUnchanged=True,adapterSha256=source_sha,correctionUpdates=24))
    write_json(failed/'manifest.json',dict(warmupRun=str(source),warmupAdapterSha256=source_sha))
    write_json(failed/'archive.json',dict(protocol='lain-zip-notes-v1',warmupAdapterSha256=source_sha))
    generator_path=root/'generator.py'
    generator_path.write_text('\n'+(ROOT/'tools/zip_generate_notes.py').read_text())
    generator=recovery.load_generator(generator_path)
    calls=[]
    def generate(actual_base, actual_tokenizer, messages, cap):
        hook=next(iter(actual_base.model.layers[1]._forward_hooks.values()))
        marker=int(hook.__self__.generation_adapter[-1].bias[0])
        assert warmup.state_digest(actual_base)==frozen
        assert all(not p.requires_grad and p.grad is None for p in hook.__self__.parameters())
        task=next(t for t in tasks('train')+tasks('dev') if t.public()['problem']==messages[-1]['content'])
        calls.append((marker,task.key))
        a=task.scale
        valid = ((task.family=='square' and marker==0)
            or (task.family=='product' and marker in [6,12,18])
            or (task.family=='square' and marker==12 and task.split=='train') or marker==18)
        expression=(f'{2*a}*x*u+{a}*u**2' if task.family=='square' else f'{a}*x*v+{a}*y*u+{a}*u*v') if valid else 'x'
        return dict(raw=canonical(dict(definition='The change has first-order terms and a remainder.',expression=expression,
            scope='exact',radius='0.1',status='asserted')),generatedTokens=30)
    reviews=[]
    class FakeTeacher:
        def __init__(self,*a,**kw):
            assert kw['max_calls']==4
            self.calls=0
        def review(self,task,draft,checked):
            request=checked['definitionReviewRequest']
            assert request==recovery.REVIEW_REQUEST and 'order of the order' not in request
            assert checked['accepted'] and checked['score']==1
            self.calls+=1; reviews.append((task,draft))
            return dict(raw='fixture',critique=dict(assessment='CLEAR: fixture',hint='',counterexample='',scope_note=''),
                cacheHit=False,requestHash='fixture',returnedModel='fixture')
    args=SimpleNamespace(student_path=snapshot,failed_notes=failed,generator=generator_path,
        out=root/'selected',notes_out=root/'notes',max_seconds=60)
    originals={p:p.read_bytes() for d in [parent,source,failed] for p in d.rglob('*') if p.is_file()}
    console=io.StringIO()
    with patch.dict(os.environ,{'LAIN_TEACHER_API_KEY':'fixture-secret-not-save'}), \
         patch.object(recovery,'load_generator',return_value=generator), \
         patch.object(recovery,'base_generate',side_effect=generate), \
         patch.object(generator,'base_generate',side_effect=generate), \
         patch.object(generator,'Teacher',FakeTeacher), redirect_stdout(console):
        recovery.run(args)
    result=json.loads((args.out/'result.json').read_text())
    assert result['selectedCorrectionStep']==18 and result['recoveryTrainingUpdates']==0
    assert result['cumulativeSupervisedUpdates']==30 and result['selectionImproved']
    assert all(v==1 for v in result['selectedScores'].values())
    assert not any(marker==6 and key.startswith('dev') for marker,key in calls)
    assert not any(marker==24 for marker,key in calls)  # stopped after a fully passing checkpoint
    assert len(reviews)==2
    archive=json.loads((args.notes_out/'archive.json').read_text())
    assert len(archive['activeNotes'])==2 and archive['teacherNetworkCalls']==2
    assert archive['warmupAdapterSha256']==result['adapterSha256']
    assert not archive['independentDiscovery'] and archive['trainingUpdates']==archive['rewardUpdates']==0
    assert all(p.read_bytes()==content for p,content in originals.items())
    assert 'fixture-secret-not-save' not in console.getvalue()
    for path in root.rglob('*.json'): assert 'fixture-secret-not-save' not in path.read_text()
    # When every candidate forgets a previously correct square, keep the old
    # student and make no teacher call, even though the product improves.
    for step in [6,12,18,24]:
        (source/f'checkpoint-{step:03d}.safetensors').write_bytes((source/'checkpoint-006.safetensors').read_bytes())
    args.out, args.notes_out=root/'rejected-selection',root/'unused-notes'
    calls.clear()
    with patch.dict(os.environ,{'LAIN_TEACHER_API_KEY':'fixture-secret-not-save'}), \
         patch.object(recovery,'load_generator',return_value=generator), \
         patch.object(recovery,'base_generate',side_effect=generate), \
         patch.object(generator,'Teacher') as forbidden, redirect_stdout(io.StringIO()):
        recovery.run(args)
        forbidden.assert_not_called()
    result=json.loads((args.out/'result.json').read_text())
    assert result['selectedCorrectionStep']==0 and not result['selectionImproved']
    assert not args.notes_out.exists()
print('recovery checks passed: single saved adapter, per-task non-regression, dev selection, zero training, neutral review request, no improvement means no teacher calls')
