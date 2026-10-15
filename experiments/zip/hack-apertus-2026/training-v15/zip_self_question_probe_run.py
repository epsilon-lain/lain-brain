"""Read-only real student format experiment, not a new training checkpoint."""
import argparse
import copy
import json
import os
from pathlib import Path
import signal
import time
import traceback
from types import SimpleNamespace
import zipfile

from draft_inspect_runtime import read, sha, snapshot
from writer_check_core import write_once
from writer_check_run import preflight
from zip_label_metacognitive_source import inspect_source
from zip_self_question_probe_checks import (PROTOCOL, CONDITIONS, MAX_GENERATIONS, MAX_TOKENS,
    require, validate_frame, run_probe, summary, messages)
from zip_self_question_probe_policy import generate
from zip_self_question_probe_progress import StageProgress


def next_probe(work):
    numbers = []
    for folder in Path(work).glob('zip-self-question-probe-*'):
        path = folder / 'protocol.json'
        if not path.is_file():
            continue
        value = read(path)
        if value.get('protocol') != PROTOCOL:
            continue
        n = value.get('probeNumber')
        require(type(n) is int and 1 <= n <= 1000, 'Invalid reserved probe number')
        numbers.append(n)
    result = max(numbers, default=0) + 1
    require(result <= 1000, 'Probe namespace exhausted')
    return result


def run(args):
    start = time.monotonic()
    parent = args.source.resolve()
    resume = inspect_source(parent)  # Reject incomplete/fixture sources before any model import.
    frame = copy.deepcopy(resume['sourceFrame'])
    validate_frame(frame)
    require(all(x['task']['split'] == 'training' for x in resume['anchors']), 'Heldout anchor is forbidden')
    require(not args.out.resolve().is_relative_to(parent) and not parent.is_relative_to(args.out.resolve()),
            'Output must be separate from source')
    checked_args = SimpleNamespace(**vars(args))
    checked_args.source = Path(read(parent / 'source-checkpoint.json')['baseChoiceSource']).resolve()
    checked = preflight(checked_args)
    require(resume['result']['mathematicalWriterStateHash'] == checked['checkpoint']['writerStateHash'],
            'Source mathematical writer differs')
    probe_number = next_probe(args.work)
    args.out.mkdir(parents=True, exist_ok=False)
    progress = StageProgress(os.environ.get('ZIP_SELF_QUESTION_PROGRESS_FILE'))
    write_once(args.out / 'protocol.json', dict(protocol=PROTOCOL, probeNumber=probe_number,
        conditions=list(CONDITIONS), pairedDecodingModes=['greedy', 'sampled'],
        generationCap=MAX_GENERATIONS, tokensPerGeneration=MAX_TOKENS,
        frameHash=frame['frameHash'], originalTrainingObjects=8, independentTrainingFrames=1,
        newMathematicsObjects=0, heldoutUsed=False, fullSoftmaxSampling=True,
        teacherCalls=0, trainingUpdates=0, mathematicalWriterFrozen=True, semanticWriterFrozen=True,
        sourceHeadAndLabelsFrozen=True, hostQuestionOrPlanSupplied=False, originalTextRepaired=False,
        newZipActivated=False, performanceBenefitTested=False, automaticTrainingStarted=False,
        sourceSelectedByChronology=True, partialProbeNumbersReserved=True, totalSeconds=600))
    write_once(args.out / 'source-checkpoint.json', dict(source=str(parent), sourceResultSha256=sha(parent / 'result.json'),
        sourceProtocol=resume['result']['protocol'], sourceFileHashes=resume['sourceHashes'],
        semanticCheckpointSha256=sha(parent / 'checkpoints' / resume['final']['semanticFile']),
        semanticStateHash=resume['final']['semanticStateHash'],
        originalHead=resume['final']['head'], originalLabels=resume['final']['labels'],
        originalMetaZip=resume.get('initialMeta'), continuationCheckpointCreated=False))
    write_once(args.out / 'training-metric-frame.json', frame)
    write_once(args.out / 'source-training-anchors.json', dict(rows=resume['anchors'], trainingOnly=True,
        representationsFromLastCommittedSource=True, freshModelRepresentationsNotGenerated=True))
    for anchor in resume['anchors']:
        for rid in anchor['mathRecordIds']:
            paths = list((parent / 'responses').glob(rid + '-scored.json'))
            if not paths:
                paths = list((parent / 'parent-iteration-originals').rglob(rid + '-scored.json'))
            matched = [p for p in paths if read(p).get('task') == anchor['task']]
            require(bool(matched), 'Training route evidence missing: ' + rid)
            write_once(args.out / 'source-training-routes' / (anchor['task']['id'] + '-' + rid + '.json'), read(matched[0]))
    for path in Path(__file__).resolve().parent.glob('*.py'):
        target = args.out / 'evaluation-code' / path.name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(path.read_bytes())
    deadline = time.monotonic() + max(0., float(os.environ.get('ZIP_SELF_QUESTION_DEADLINE', str(time.time() + 600))) - time.time())
    attempts = 0
    raw_rows, scored_rows = [], []
    base = mathematical = semantic = None
    base_before = math_before = semantic_before = None
    base_after = math_after = semantic_after = None
    source_ok = protected_ok = tools_ok = frozen_ok = None
    stop, error = 'completed', None

    def save(kind, row):
        target = (args.out / 'responses' / (row['recordId'] + '-' + kind + '.json') if kind in ('raw', 'scored')
                  else args.out / kind / (row['id'] + '.json'))
        write_once(target, row)
        if kind == 'raw':
            raw_rows.append(copy.deepcopy(row))
        elif kind == 'scored':
            scored_rows.append(copy.deepcopy(row))
        progress.mark(rawResponsesSaved=len(raw_rows), scoredResponses=len(scored_rows), generationAttempts=attempts,
                      inFlight=None)

    def timeout(signum, handler):
        raise TimeoutError('Frozen self-question probe deadline reached')

    old_term = signal.signal(signal.SIGTERM, timeout)
    old_alarm = signal.signal(signal.SIGALRM, timeout)
    signal.setitimer(signal.ITIMER_REAL, max(.001, deadline - time.monotonic()))
    try:
        progress.mark('加载原学生；只读语义检查点，六次格式生成，更新零次')
        from safetensors.torch import load_file
        from zip_pilot import load_student
        from zip_pilot_model import state_digest
        from math_writer_adapter import MathWriterAdapter
        base, tokenizer, metadata = load_student(args.student, 'cpu')
        require(metadata['snapshotSha256'] == checked['identity']['snapshotSha256'], 'Student snapshot differs')
        base_before = state_digest(base)
        require(base_before == resume['result']['baseStateBefore'], 'Base weights differ')
        mathematical = MathWriterAdapter(base, rank=8, last_layers=4, alpha=16)
        mathematical.restore(load_file(str(checked['writer'])))
        math_before = mathematical.digest()
        require(math_before == checked['checkpoint']['writerStateHash'], 'Math checkpoint differs')
        semantic = MathWriterAdapter(base, rank=8, last_layers=4, alpha=16)
        semantic.restore(load_file(str(parent / 'checkpoints' / resume['final']['semanticFile'])))
        semantic_before = semantic.digest()
        require(semantic_before == resume['final']['semanticStateHash'], 'Semantic checkpoint differs')
        base.eval().requires_grad_(False)
        mathematical.eval()
        semantic.eval()
        for parameter in mathematical.parameters_to_train() + semantic.parameters_to_train():
            parameter.requires_grad_(False)
            parameter.grad = None
        write_once(args.out / 'observed-model-identity.json', dict(snapshotSha256=metadata['snapshotSha256'],
            baseStateHash=base_before, mathematicalWriterStateHash=math_before, semanticStateHash=semantic_before,
            device='cpu', allParametersFrozen=True))

        def frozen():
            require(mathematical.enabled is True and semantic.enabled is True and
                not base.training and not mathematical.training and not semantic.training and
                all(not p.requires_grad and p.grad is None for p in list(base.parameters()) +
                    mathematical.parameters_to_train() + semantic.parameters_to_train()), 'Frozen state/gradient flags changed')
            require(state_digest(base) == base_before and mathematical.digest() == math_before and
                    semantic.digest() == semantic_before, 'A frozen parameter changed')

        def ask(prompt, condition, seed, sampled):
            nonlocal attempts
            require(attempts < MAX_GENERATIONS, 'Six-generation budget reached')
            attempts += 1
            progress.mark('格式对照 ' + str(attempts) + '/6：' + condition + (' sampled' if sampled else ' greedy'),
                          generationAttempts=attempts, inFlight=dict(condition=condition, seed=seed))
            begin = time.monotonic()
            with mathematical.active(False), semantic.active(True):
                value = generate(base, tokenizer, prompt, condition, seed, sampled)
            value = dict(value, mathAdapterEnabledDuringGeneration=False, semanticAdapterEnabledDuringGeneration=True,
                         semanticStateHashDuringGeneration=semantic_before, generationSeconds=time.monotonic() - begin)
            return value

        run_probe(frame, resume.get('initialMeta'), probe_number, ask, save, frozen,
                  lambda: deadline - time.monotonic())
        frozen()
        frozen_ok = True
    except Exception as exc:
        stop = 'time_budget' if isinstance(exc, TimeoutError) else 'error'
        error = type(exc).__name__ + ': ' + str(exc)
        write_once(args.out / 'error.json', dict(error=error, traceback=traceback.format_exc(),
            generationAttempts=attempts, rawResponsesSaved=len(raw_rows), scoredResponses=len(scored_rows)))
        print('诊断停止：' + error, flush=True)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGTERM, old_term)
        signal.signal(signal.SIGALRM, old_alarm)
        try:
            if base is not None and base_before is not None:
                base_after = state_digest(base)
            if mathematical is not None:
                math_after = mathematical.digest()
            if semantic is not None:
                semantic_after = semantic.digest()
            source_ok = snapshot(parent) == resume['sourceHashes']
            protected_ok = all(sha(Path(p)) == h for p, h in checked['protected'].items())
            tools_ok = snapshot(args.old_tools.resolve()) == checked['toolFiles']
            require(source_ok and protected_ok and tools_ok and base_before is not None and
                base_after == base_before and math_after == math_before and semantic_after == semantic_before,
                'Final source/model/tool frozen check failed')
        except Exception as exc:
            stop = 'error'
            error = (error + '; ' if error else '') + 'Final check: ' + str(exc)
        if semantic is not None:
            semantic.close()
        if mathematical is not None:
            mathematical.close()
    result = dict(protocol=PROTOCOL, probeNumber=probe_number, stopReason=stop, error=error,
        fixtureOnly=False, fixtureGenerations=0, teacherCalls=0, generationAttempts=attempts,
        actualStudentGenerations=len(raw_rows), rawResponsesSaved=len(raw_rows), scoredResponses=len(scored_rows),
        rawResponsesWithoutCompletedAudit=len(raw_rows) - len(scored_rows),
        completeFormatExperiment=stop == 'completed' and len(scored_rows) == MAX_GENERATIONS,
        trainingUpdates=0, semanticTrainingUpdates=0, choiceHeadTrainingUpdates=0, featureForwardBatches=0,
        newMathematicsObjects=0, heldoutObjects=0, newActivatedZipLabels=0, activeMetaZipUnchanged=True,
        baseStateBefore=base_before, baseStateAfter=base_after, baseWeightsUnchanged=base_before is not None and base_before == base_after,
        mathematicalWriterStateBefore=math_before, mathematicalWriterStateAfter=math_after,
        mathematicalWriterUnchanged=math_before is not None and math_before == math_after,
        semanticStateBefore=semantic_before, semanticStateAfter=semantic_after,
        semanticWriterUnchanged=semantic_before is not None and semantic_before == semantic_after,
        sourceFilesUnchanged=source_ok, protectedModelFilesUnchanged=protected_ok, originalToolsUnchanged=tools_ok,
        inMemoryFrozenFlagsChecked=frozen_ok, summary=summary(scored_rows), elapsedSeconds=time.monotonic() - start,
        continuationCheckpointCreated=False, mathematicalBenefitProved=False, fullMetacognitionProved=False)
    write_once(args.out / 'result.json', result)
    lines = ['# 冻结学生自我提问格式对照', '',
        '六次格式诊断，训练更新零次。数值通过核验不会认证问题或计划；未启用新 ZIP，未创建接续检查点。', '',
        '```json', json.dumps(result['summary'], ensure_ascii=False, indent=2), '```', '']
    for row in scored_rows:
        lines += ['## ' + row['recordId'], '', '原始学生文字：', '', '````text',
                  row['studentOutput']['raw'], '````', '', '状态：' + row['check']['status'] + '；原因：' + row['check']['reason'], '']
    (args.out / 'Lain-Zip-Self-Question-Probe-Review.md').write_text('\n'.join(lines), encoding='utf-8')
    archive = args.out / 'Lain-Zip-Self-Question-Probe-Results.zip'
    with zipfile.ZipFile(archive, 'x', zipfile.ZIP_DEFLATED) as z:
        for path in sorted(args.out.rglob('*')):
            if path.is_file() and path != archive:
                z.write(path, path.relative_to(args.out))
    print('格式对照摘要：' + json.dumps(result['summary'], ensure_ascii=False), flush=True)
    print('完整性：' + json.dumps({k: result[k] for k in ('stopReason', 'error', 'actualStudentGenerations',
        'trainingUpdates', 'teacherCalls', 'baseWeightsUnchanged', 'mathematicalWriterUnchanged',
        'semanticWriterUnchanged', 'sourceFilesUnchanged')}, ensure_ascii=False), flush=True)
    print('诊断结果：' + str(archive), flush=True)
    return 0 if stop == 'completed' else 1


def main():
    parser = argparse.ArgumentParser()
    for name in ('source', 'work', 'student', 'old-tools', 'out'):
        parser.add_argument('--' + name, type=Path)
    parser.add_argument('--inspect-only', action='store_true')
    args = parser.parse_args()
    require(args.source is not None, 'Original result source required')
    if args.inspect_only:
        source = inspect_source(args.source)
        frame = source['sourceFrame']
        validate_frame(frame)
        print(json.dumps(dict(sourceProtocol=source['result']['protocol'], sourceTrainingObjects=8,
            frameHash=frame['frameHash'], sourceSemanticStateHash=source['final']['semanticStateHash'],
            conditions={c:messages(frame, c, source.get('initialMeta')) for c in CONDITIONS},
            studentCalls=0, teacherCalls=0, trainingUpdates=0, modelNotLoaded=True), ensure_ascii=False))
        return 0
    require(all(getattr(args, k) is not None for k in ('work', 'student', 'old_tools', 'out')), 'Original Notebook paths required')
    return run(args)


if __name__ == '__main__':
    raise SystemExit(main())
