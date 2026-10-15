"""Compare two pinned v5 branches; all source checks precede model imports."""
import argparse
import copy
import json
import os
from pathlib import Path
import signal
import sys
import time
import traceback
from types import SimpleNamespace
from unittest.mock import patch
import zipfile

sys.path.insert(0,str(Path(__file__).resolve().parent))
from draft_inspect_runtime import read, sha, snapshot
from writer_check_run import preflight
from writer_check_core import write_once, exact_reproduction
import zip_label_grounded_run as source_runtime
from zip_label_grounded_core import NATURAL_PROTOCOL, require
from zip_label_grounded_checks import feature_messages, FEATURE_PROTOCOL
from zip_label_feedback_audit import PROTOCOL as SCORING_PROTOCOL
from zip_semantic_generation import NATURAL_LANGUAGE, generate_note
from object_choice_core import normalized_features
from tool_loop_course import archived_inputs
from zip_label_compare_core import (PROTOCOL, SOURCE_PINS, ARMS, GENERATION_CAP,
    FEATURE_BATCH_CAP, TOKENS, fresh_tasks, run_comparison, comparison_summary)
from zip_label_compare_progress import StageProgress


def checked_pair(source_a,source_b):
    sources={'branch_a':Path(source_a).resolve(),'branch_b':Path(source_b).resolve()}
    require(sources['branch_a']!=sources['branch_b'],'Two distinct pinned sources required')
    # Reject an unreviewed/fixture archive before importing a model or optimizer.
    for mode,folder in sources.items():
        require(sha(folder/'result.json')==SOURCE_PINS[mode],
            'Frozen comparison is pinned to reviewed 47624235 and 9024865b, in that order')
    inspected={}
    for mode,folder in sources.items():
        parent=read(folder/'source-checkpoint.json')
        original=Path(parent['parentIterationSource'])
        # An exported archive carries exact parent originals. Use those copies
        # only when the original Notebook parent directory is unavailable.
        # Every copied parent file is checked against the source's saved hash.
        copies=folder/'parent-iteration-originals'
        for relative,expected in parent['parentSourceFileHashes'].items():
            if Path(relative).suffix=='.zip':continue
            require(sha(copies/relative)==expected,'Exported parent changed: '+relative)
        reader,hasher=source_runtime.read,source_runtime.sha
        def remap(path):
            path=Path(path)
            return copies/path.relative_to(original) if not original.exists() and path.is_relative_to(original) else path
        with patch.object(source_runtime,'read',lambda p:reader(remap(p))), \
             patch.object(source_runtime,'sha',lambda p:hasher(remap(p))):
            inspected[mode]=source_runtime.inspect_iteration(folder)
    a,b=inspected['branch_a'],inspected['branch_b']
    require(all(s['result']['protocol']==NATURAL_PROTOCOL and
        s['result']['mathematicalScoringProtocol']==SCORING_PROTOCOL and
        s['result']['featurePromptProtocol']==FEATURE_PROTOCOL for s in inspected.values()),
        'Source prompt or scoring protocol differs')
    require(all(a['initial'][k]==b['initial'][k] for k in ('head','labels','baselinePass',
        'semanticStateHash','semanticFileSha256','mathematicalWriterStateHash')) and
        a['bank']['mathematicalRoots']==b['bank']['mathematicalRoots'] and
        a['result']['baseStateBefore']==b['result']['baseStateBefore'] and
        a['result']['mathematicalWriterStateHash']==b['result']['mathematicalWriterStateHash'],
        'Branches do not share the same frozen pre-round control, base or mathematical roots')
    require(read(sources['branch_a']/'source-checkpoint.json')['baseChoiceSource']==
        read(sources['branch_b']/'source-checkpoint.json')['baseChoiceSource'], 'Base choice source differs')
    return inspected


def retest_number(work):
    numbers=[]
    for folder in Path(work).glob('zip-label-frozen-compare-*'):
        if not (folder/'protocol.json').is_file():continue
        row=read(folder/'protocol.json')
        if row.get('protocol')!=PROTOCOL:continue
        number=row.get('comparisonNumber')
        require(type(number) is int and 1<=number<=1000,'Invalid reserved comparison number')
        numbers.append(number)
    number=max(numbers,default=0)+1
    require(number<=1000,'Comparison number bound reached')
    return number


def run(args):
    started=time.monotonic();progress=StageProgress(os.environ.get('ZIP_LABEL_COMPARE_PROGRESS_FILE'))
    progress.mark('只读复验两份完整 v5 原文、更新链和共同训练前状态')
    pair=checked_pair(args.source_a,args.source_b)
    iteration=pair['branch_a'];sources={'branch_a':args.source_a.resolve(),'branch_b':args.source_b.resolve()}
    parent=read(sources['branch_a']/'source-checkpoint.json');base_source=Path(parent['baseChoiceSource'])
    checked=preflight(SimpleNamespace(source=base_source,student=args.student,old_tools=args.old_tools,out=args.out))
    roots=copy.deepcopy(iteration['bank']['mathematicalRoots'])
    original_roots={r['selectedCandidate']['kind']:r['selectedCandidate']['root']
        for r in checked['contexts'][0]['allThreeRouteOriginals'] if r['selectedCandidate']['kind']!='direct'}
    require(roots==[original_roots[k] for k in ('combine','distribute')] and
        iteration['result']['mathematicalWriterStateHash']==checked['checkpoint']['writerStateHash'],
        'Original mathematical writer or roots differ')
    for protected in (*sources.values(),args.student.resolve(),args.old_tools.resolve(),base_source.resolve()):
        require(not args.out.resolve().is_relative_to(protected) and
            not protected.is_relative_to(args.out.resolve()),'Comparison output overlaps protected source')
    number=retest_number(args.work)
    history=[p for p in args.work.glob('zip-*') if p.is_dir() and
        ((p/'result.json').is_file() or list(p.glob('*questions.json')))]
    for p in (*sources.values(),base_source,checked['writer'].parent,Path(checked['checkpoint']['choiceSource'])):
        if p not in history:history.append(p)
    excluded,freshness=archived_inputs(history);tasks=fresh_tasks(excluded,roots)
    args.out.mkdir(parents=True,exist_ok=False)
    for mode,folder in sources.items():
        for relative,expected in pair[mode]['sourceHashes'].items():
            if Path(relative).suffix=='.zip':continue
            data=(folder/relative).read_bytes()
            require(__import__('hashlib').sha256(data).hexdigest()==expected,'Pinned source changed during copy')
            target=args.out/'source-originals'/mode/relative
            target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
    for path in Path(__file__).resolve().parent.glob('*.py'):
        target=args.out/'evaluation-code'/path.name;target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(path.read_bytes())
    for name in ('zip_pilot.py','zip_pilot_model.py'):
        target=args.out/'frozen-original-model-tools'/name;target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes((args.old_tools/name).read_bytes())
    before=copy.deepcopy(iteration['initial']);branch_a=copy.deepcopy(iteration['final'])
    branch_b=copy.deepcopy(pair['branch_b']['final'])
    frozen_checkpoints=copy.deepcopy((before,branch_a,branch_b,roots))
    write_once(args.out/'comparison-questions.json',dict(heldout=tasks,training=[],heldoutObjects=8,
        trainingObjects=0,historyFreshness=freshness))
    write_once(args.out/'source-checkpoint.json',dict(sourceDirectories={k:str(p) for k,p in sources.items()},
        sourceResultPins=SOURCE_PINS,sourceFileHashes={k:s['sourceHashes'] for k,s in pair.items()},
        before=before,branch_a=branch_a,branch_b=branch_b,mathematicalRoots=roots))
    write_once(args.out/'checkpoints/initial.json',dict(before=before,branch_a=branch_a,branch_b=branch_b,roots=roots))
    write_once(args.out/'protocol.json',dict(protocol=PROTOCOL,comparisonNumber=number,sourceResultPins=SOURCE_PINS,
        languageProtocol=NATURAL_LANGUAGE,featurePromptProtocol=FEATURE_PROTOCOL,mathematicalScoringProtocol=SCORING_PROTOCOL,
        newObjects=8,objectsPerFamily=4,coldReplays=8,textGenerationCap=GENERATION_CAP,tokensPerGeneration=TOKENS,
        featureForwardBatchCap=FEATURE_BATCH_CAP,threeCandidatesPerBatch=True,pairedChoiceSeedsPerObject=3,
        arms=list(ARMS),allWeightsFrozen=True,labelsFrozen=True,teacherCalls=0,trainingUpdates=0,
        optimizerConstructed=False,noHostWrittenFeaturesOrDescriptionTargets=True,mathematicalScoringUnchanged=True,
        fullRoutesHostScheduled=True,unselectedRoutesNotAutonomousToolCalls=True,
        rawSavedBeforeAudit=True,newStageSeconds=900,totalSeconds=1200,checkpointsSelectedByHeldout=False))
    deadline=time.monotonic()+max(0.,float(os.environ.get('ZIP_LABEL_COMPARE_DEADLINE',str(time.time()+1200)))-time.time())
    raw=[];scored=[];features_saved=[];objects=[];decisions=[];trials=[]
    calls=feature_calls=0;base=mathematical=semantic=None
    base_before=base_after=math_before=math_after=None
    states={};state_hashes={};writer_mode='branch_a';semantic_after=None
    source_ok=protected_ok=tools_ok=None;verified_states={};stop='completed';error=None

    def save(kind, row):
        path = (args.out/'responses'/(row['recordId']+'-'+kind+'.json') if kind in ('raw','scored')
            else args.out/kind/(row['id']+'.json'))
        write_once(path, row)
        collection = {'raw':raw, 'scored':scored, 'feature':features_saved,
            'object':objects, 'decision':decisions, 'trial':trials}.get(kind)
        if collection is not None: collection.append(copy.deepcopy(row))
        progress.mark(rawResponsesSaved=len(raw), scoredResponses=len(scored),
            featureForwardBatches=feature_calls, completeNewObjects=len(objects),
            coldReproductions=sum(r['phase']=='cold_replay' and r['check']['exactReproduction']['exact'] for r in scored),
            generationAttempts=calls, inFlight=None)

    def timeout(signum, frame): raise TimeoutError('Frozen retest stage or total budget reached')
    signal.signal(signal.SIGTERM, timeout)
    previous_alarm = signal.signal(signal.SIGALRM, timeout)
    signal.setitimer(signal.ITIMER_REAL, max(.001, deadline-time.monotonic()))
    try:
        progress.mark('加载原学生及三份冻结语义状态；不创建优化器')
        import torch
        from safetensors.torch import load_file
        from zip_pilot import load_student
        from zip_pilot_model import state_digest
        from math_writer_adapter import MathWriterAdapter
        from zip_generation_policy import generate_response
        base, tokenizer, identity = load_student(args.student, 'cpu')
        require(identity['snapshotSha256'] == checked['identity']['snapshotSha256'], 'Loaded model snapshot differs')
        base_before = state_digest(base)
        require(base_before == iteration['result']['baseStateBefore'], 'Frozen base state differs')
        mathematical = MathWriterAdapter(base, rank=8, last_layers=4, alpha=16)
        mathematical.restore(load_file(str(checked['writer'])))
        math_before = mathematical.digest()
        require(math_before == checked['checkpoint']['writerStateHash'], 'Frozen mathematical state differs')
        semantic = MathWriterAdapter(base, rank=8, last_layers=4, alpha=16)
        for mode,checkpoint,folder in (('before',before,sources['branch_a']), ('branch_b',branch_b,sources['branch_b']), ('branch_a',branch_a,sources['branch_a'])):
            states[mode] = load_file(str(folder/'checkpoints'/checkpoint['semanticFile']))
            semantic.restore(states[mode]); state_hashes[mode] = semantic.digest()
            require(state_hashes[mode] == checkpoint['semanticStateHash'], 'Loaded semantic checkpoint differs')
        base.eval().requires_grad_(False); mathematical.eval(); semantic.eval()
        for p in mathematical.parameters_to_train() + semantic.parameters_to_train():
            p.requires_grad_(False); p.grad = None
        write_once(args.out / 'observed-model-identity.json', dict(snapshotSha256=identity['snapshotSha256'],
            modelType=getattr(base.config, 'model_type', None), modelParameters=sum(p.numel() for p in base.parameters()),
            baseStateHash=base_before, mathematicalStateHash=math_before,
            semanticStateHashes=state_hashes, device='cpu', optimizerConstructed=False))

        def frozen():
            require(mathematical.enabled is True and semantic.enabled is True and
                mathematical.digest() == math_before and semantic.digest() == state_hashes[writer_mode] and
                not base.training and not mathematical.training and not semantic.training and
                all(not p.requires_grad and p.grad is None for p in list(base.parameters())+
                    mathematical.parameters_to_train()+semantic.parameters_to_train()), 'Frozen weights or gradients changed')
            require((before, branch_a, branch_b, roots) == frozen_checkpoints, 'Frozen head/label checkpoint dictionaries changed')

        def select_writer(mode):
            nonlocal writer_mode
            require(mode in states, 'Unknown frozen writer mode')
            if mode != writer_mode:
                semantic.restore(states[mode]); writer_mode = mode
            frozen()

        def ask(phase, prompt, seed, *, mode, sampled=False, **context):
            nonlocal calls
            require(not sampled and calls < GENERATION_CAP, 'Frozen sampling or generation budget differs')
            if time.monotonic() >= deadline: raise TimeoutError('Frozen text stage budget reached')
            frozen(); calls += 1; begin = time.monotonic()
            progress.mark('冻结文字生成 '+str(calls)+'/56：'+phase, generationAttempts=calls,
                inFlight=dict(kind='text', number=calls, phase=phase))
            with mathematical.active(mode=='math'), semantic.active(mode=='semantic'):
                generator = generate_response if mode=='math' else generate_note
                value = generator(base, tokenizer, prompt, TOKENS, seed, sampled=False, temperature=1.,
                    **({'language_protocol':NATURAL_LANGUAGE} if mode=='semantic' else {}))
                value.update(mathAdapterEnabledDuringGeneration=mathematical.enabled,
                    semanticAdapterEnabledDuringGeneration=semantic.enabled,
                    semanticStateHashDuringGeneration=semantic.digest(), semanticWriterMode=writer_mode,
                    generationRoute='frozen_math' if mode=='math' else 'frozen_semantic_writer')
            row = dict(recordId='branch-compare-call-'+str(calls).zfill(2), phase=phase,
                studentPrompt=copy.deepcopy(prompt), studentOutput=value, samplingSeed=seed,
                requestedMathAdapterEnabled=mode=='math', fixtureOnly=False,
                generationSeconds=time.monotonic()-begin, **context)
            save('raw', row); frozen()
            require(not value.get('testDouble') and 0 < len(value['generatedIds']) <= TOKENS, 'Generation provenance differs')
            return row

        def features(task, keywords, candidates):
            nonlocal feature_calls
            require(feature_calls < FEATURE_BATCH_CAP, 'Frozen feature budget reached')
            if time.monotonic() >= deadline: raise TimeoutError('Frozen feature stage budget reached')
            frozen(); feature_calls += 1
            prompts = [feature_messages(task, keywords['studentOutput'], c) for c in candidates]
            sequences = [tokenizer(tokenizer.apply_chat_template(p, tokenize=False, add_generation_prompt=True),
                add_special_tokens=False)['input_ids'] for p in prompts]
            require(all(0 < len(s) <= 2048 for s in sequences), 'Feature prompt length bound; no truncation')
            pad = tokenizer.pad_token_id if tokenizer.pad_token_id is not None else tokenizer.eos_token_id
            require(isinstance(pad, int), 'No padding token')
            length = max(map(len, sequences))
            ids = torch.tensor([s+[pad]*(length-len(s)) for s in sequences], dtype=torch.long)
            masks = torch.tensor([[1]*len(s)+[0]*(length-len(s)) for s in sequences], dtype=torch.long)
            progress.mark('冻结特征前向 '+str(feature_calls)+'/40', inFlight=dict(kind='feature', number=feature_calls))
            with mathematical.active(False), semantic.active(False), torch.no_grad():
                hidden = base.model(input_ids=ids, attention_mask=masks, use_cache=False, return_dict=True).last_hidden_state
                vectors = [hidden[i,len(s)-1].detach().float().cpu().tolist() for i,s in enumerate(sequences)]
            row = dict(id='branch-compare-feature-'+str(feature_calls).zfill(2), task=copy.deepcopy(task),
                sourceKeywordRecordId=keywords['recordId'], candidateCards=copy.deepcopy(candidates),
                candidatePrompts=prompts, promptIds=sequences, candidateOrder=[c['id'] for c in candidates],
                candidateHiddenVectors=vectors, mathematicalAdapterEnabled=False, semanticAdapterEnabled=False)
            save('feature', row); frozen()
            return normalized_features(vectors), row['id']

        for number_cold, old in enumerate(checked['anchors'], 1):
            row = ask('cold_replay', old['studentPrompt'], old['samplingSeed'], mode='math',
                task=old['task'], coldNumber=number_cold, sourceRecordId=old['recordId'])
            match = exact_reproduction(old['studentOutput'], row['studentOutput'])
            save('scored', dict(row, check=dict(exactReproduction=match)))
            require(match['exact'], 'Historical math output differs; no new-object retest started')
        deadline = min(deadline, time.monotonic()+900.)
        signal.setitimer(signal.ITIMER_REAL, max(.001, deadline-time.monotonic()))
        run_comparison(tasks,roots,before,branch_a,branch_b,ask,features,save,select_writer,frozen,deadline,number)
        require(len(raw)==GENERATION_CAP and feature_calls==FEATURE_BATCH_CAP and len(objects)==8,
            'Completed frozen retest record count differs')
    except Exception as exc:
        stop = 'time_budget' if isinstance(exc, TimeoutError) else 'error'
        error = type(exc).__name__+': '+str(exc)
        write_once(args.out / 'error.json', dict(error=error, traceback=traceback.format_exc(), generationAttempts=calls))
        print('已停止：'+error, flush=True)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0); signal.signal(signal.SIGALRM, previous_alarm)
        try:
            if base is not None: base_after = state_digest(base)
            if mathematical is not None: math_after = mathematical.digest()
            if semantic is not None:
                require(semantic.digest()==state_hashes.get(writer_mode),'Live semantic state changed')
                for mode in states:
                    semantic.restore(states[mode]);writer_mode=mode
                    verified_states[mode]=semantic.digest()==state_hashes[mode]
                    require(verified_states[mode],'Final semantic checkpoint changed')
                semantic_after=semantic.digest()
            source_ok = all(snapshot(folder)==pair[mode]['sourceHashes'] for mode,folder in sources.items())
            protected_ok = (all(sha(Path(p)) == h for p,h in checked['protected'].items()) and
                snapshot(base_source.resolve()) == checked['inspection']['sourceFileHashes'])
            tools_ok = snapshot(args.old_tools.resolve()) == checked['toolFiles']
            require(source_ok and protected_ok and tools_ok, 'Original protected files changed')
            if base_before is not None: require(base_before == base_after, 'Base state changed')
            if math_before is not None: require(math_before == math_after, 'Math state changed')
        except Exception as exc:
            stop='error'; error=(error+'; ' if error else '')+'Frozen final audit: '+str(exc)
        for adapter in (semantic, mathematical):
            if adapter is not None: adapter.close()
    write_once(args.out/'checkpoints/final.json',dict(before=before,branch_a=branch_a,branch_b=branch_b,roots=roots))
    summary=comparison_summary(objects,trials)
    summary['legacyStrictScoringOnSameNewOutputs']=comparison_summary(objects,trials,legacy=True)
    summary['heldoutObservationDistinctTextsByArm']={a:len({r['studentOutput']['raw'] for r in raw
        if r['phase']=='comparison_observations' and r['arm']==a}) for a in ARMS[:3]}
    result=dict(protocol=PROTOCOL,sourceResultPins=SOURCE_PINS,comparisonNumber=number,stopReason=stop,error=error,
        fixtureOnly=False,fixtureGenerations=0,actualStudentGenerations=len(raw),generationAttempts=calls,
        rawResponsesSaved=len(raw),scoredResponses=len(scored),rawResponsesWithoutCompletedAudit=len(raw)-len(scored),
        featureForwardBatches=feature_calls,completeNewObjects=len(objects),coldReproductions=sum(
            r['phase']=='cold_replay' and r['check']['exactReproduction']['exact'] for r in scored),
        newLabelRevisions=0,teacherCalls=0,trainingUpdates=0,optimizerConstructed=False,
        policySamples=len(decisions),threeSeedsNotIndependentObjects=True,
        baseWeightsUnchanged=base_before is not None and base_before==base_after,
        mathematicalWriterUnchanged=math_before is not None and math_before==math_after,
        allSemanticStatesUnchanged=len(verified_states)==3 and all(verified_states.values()),
        labelsAndHeadsUnchanged=(before,branch_a,branch_b,roots)==frozen_checkpoints,
        originalFilesUnchanged=source_ok,protectedFilesUnchanged=protected_ok,oldToolsUnchanged=tools_ok,
        baseStateBefore=base_before,baseStateAfter=base_after,mathStateBefore=math_before,mathStateAfter=math_after,
        semanticStateHashes=state_hashes,finalLoadedSemanticStateHash=semantic_after,
        oldMathematicalScoringUnchanged=True,summary=summary,elapsedSeconds=time.monotonic()-started)
    write_once(args.out/'result.json',result)
    lines=['# ZIP 两分支冻结比较','','状态：'+stop+'；训练更新 0；老师调用 0。','',
        '```json',json.dumps(summary,ensure_ascii=False,indent=2),'```','']
    for row in raw:
        lines+=['## '+row['recordId']+' · '+row['phase'],'','```text',row['studentOutput']['raw'],'```','']
    (args.out/'Lain-Zip-Label-Frozen-Comparison.md').write_text('\n'.join(lines),encoding='utf-8')
    archive=args.out/'Lain-Zip-Label-Frozen-Comparison-Results.zip'
    with zipfile.ZipFile(archive,'x',zipfile.ZIP_DEFLATED) as z:
        for path in sorted(args.out.rglob('*')):
            if path.is_file() and path!=archive:z.write(path,path.relative_to(args.out))
    print('冻结比较摘要：'+json.dumps(summary,ensure_ascii=False),flush=True)
    print('完整性：'+json.dumps({k:result[k] for k in ('stopReason','error','actualStudentGenerations',
        'featureForwardBatches','completeNewObjects','coldReproductions','trainingUpdates','teacherCalls',
        'baseWeightsUnchanged','mathematicalWriterUnchanged','allSemanticStatesUnchanged','labelsAndHeadsUnchanged',
        'originalFilesUnchanged')},ensure_ascii=False),flush=True)
    return 0 if stop=='completed' else 1


def main():
    parser=argparse.ArgumentParser()
    for name in ('source-a','source-b','work','student','old-tools','out'):
        parser.add_argument('--'+name,type=Path)
    parser.add_argument('--inspect-only',action='store_true');args=parser.parse_args()
    require(args.source_a is not None and args.source_b is not None,'Two frozen sources required')
    if args.inspect_only:
        checked=checked_pair(args.source_a,args.source_b)
        print(json.dumps(dict(sourceResultPins=SOURCE_PINS,sourceRounds={k:v['result']['iterationRound']
            for k,v in checked.items()},commonBeforeStateVerified=True,studentCalls=0,teacherCalls=0,
            trainingUpdates=0,modelNotLoaded=True),ensure_ascii=False))
        return 0
    require(all(getattr(args,k) is not None for k in ('work','student','old_tools','out')),'Original runtime paths required')
    return run(args)


if __name__=='__main__':raise SystemExit(main())
