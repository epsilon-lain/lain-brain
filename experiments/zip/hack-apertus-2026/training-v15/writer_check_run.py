"""Actual frozen model runner. Validate saved source before model imports."""
import argparse
import copy
import json
import os
from pathlib import Path
import signal
import sys
import time
import traceback
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from draft_inspect_runtime import inspect, read, sha, snapshot
from writer_check_core import (PROTOCOL, CASE_IDS, MAX_GENERATIONS, MAX_TOKENS,
                               PairEngine, markdown, require, write_once)
from writer_check_pins import SOURCE_RESULT_SHA256, RAW_SHA256, SOURCE_FILES_SHA256
from writer_check_progress import StageProgress


def source_cases(source):
    source = Path(source).resolve()
    require((source / 'result.json').is_file(),
            '找不到 ce4ac969 原结果；请在原训练 Notebook 运行：' + str(source))
    require(sha(source / 'result.json') == SOURCE_RESULT_SHA256, '原接续结果与审阅过的 ce4ac969 不同')
    for rid, expected in RAW_SHA256.items():
        require(sha(source / 'responses' / (rid + '-raw.json')) == expected,
                '固定旧复现／草稿原文改变：' + rid)
    for relative, expected in SOURCE_FILES_SHA256.items():
        require(sha(source / relative) == expected, '已审阅的原结果文件改变：' + relative)
    inspection = inspect(source)
    require(inspection['sourceResult']['coldReproductions'] == 8 and
            inspection['sourceResult']['baseWeightsUnchanged'] is True and
            inspection['sourceResult']['writerWeightsUnchanged'] is True,
            '旧复现或固定数学权重来源不完整')
    by_id = {c['draftRecordId']: c for c in inspection['drafts']}
    contexts = [by_id[rid] for rid in CASE_IDS]
    require(contexts[0]['actualChosenRoute']['check']['outcomePassed'] is True and
            contexts[1]['actualChosenRoute']['check']['outcomePassed'] is False,
            '固定成功／失败实例与旧实际核验不一致')
    anchors = sorted((read(p) for p in (source / 'responses').glob('*-raw.json')
                      if read(p)['phase'] == 'cold_replay'), key=lambda r: r['coldNumber'])
    require([a['coldNumber'] for a in anchors] == list(range(1, 9)), '旧复现编号不完整')
    for old in anchors + [c['draftOriginal'] for c in contexts]:
        output = old['studentOutput']
        require(output.get('sampled') is False and output.get('temperature') == 1. and
                type(old.get('samplingSeed')) is int and
                output.get('mathAdapterEnabledDuringGeneration') is old['requestedMathAdapterEnabled'],
                '原运行不满足冻结贪心配对条件')
    return inspection, anchors, contexts


def preflight(args):
    inspection, anchors, contexts = source_cases(args.source)
    source = args.source.resolve()
    checkpoint = read(source / 'source-checkpoint.json')
    writer = Path(checkpoint['writerFile']).resolve()
    choice = Path(checkpoint['choiceSource']).resolve()
    writer_result = writer.parent / 'result.json'
    require(sha(writer) == checkpoint['writerFileSha256'] and
            sha(writer_result) == checkpoint['sourceResultSha256'] and
            sha(choice / 'result.json') == checkpoint['choiceResultSha256'],
            '原数学权重或原选择头来源改变')
    identity = read(source / 'observed-model-identity.json')
    require(identity['modelType'] == 'apertus', '原学生模型类型不同')
    model_files = identity['snapshotSha256']
    require(isinstance(model_files, dict) and 'model.safetensors' in model_files and
            'config.json' in model_files and 'tokenizer.json' in model_files,
            '缺少原模型快照清单')
    protected = {}
    for name, expected in model_files.items():
        require(Path(name).name == name, '模型清单路径越界')
        path = args.student.resolve() / name
        require(sha(path) == expected, '原基础模型文件改变：' + name)
        protected[str(path)] = expected
    for path in (writer, writer_result, choice / 'result.json'):
        protected[str(path)] = sha(path)
    for name in ('zip_pilot.py', 'zip_pilot_model.py'):
        require((args.old_tools / name).is_file(), '原模型工具缺失：' + name)
    tool_files = snapshot(args.old_tools.resolve())
    require(not args.out.exists(), '输出必须为独立新目录')
    for old in (source, args.student.resolve(), args.old_tools.resolve(), writer.parent, choice):
        require(not args.out.resolve().is_relative_to(old) and
                not old.is_relative_to(args.out.resolve()), '输出不能与原资料目录重叠')
    return dict(inspection=inspection, anchors=anchors, contexts=contexts,
                checkpoint=checkpoint, identity=identity, writer=writer,
                protected=protected, toolFiles=tool_files)


def archive(out):
    path = out / 'Lain-Zip-Writer-Check-Results.zip'
    with zipfile.ZipFile(path, 'x', zipfile.ZIP_DEFLATED) as z:
        for item in sorted(out.rglob('*')):
            if item.is_file() and item != path:
                z.write(item, item.relative_to(out))
    return path


def run(args):
    start = time.monotonic()
    progress = StageProgress(os.environ.get('ZIP_WRITER_CHECK_PROGRESS_FILE'))
    progress.mark('只读核对64条旧原文、8份草稿和两份固定实例')
    checked = preflight(args)  # NO model imports until this returns.
    args.out.mkdir(parents=True, exist_ok=False)
    for relative, expected in checked['inspection']['sourceFileHashes'].items():
        if Path(relative).suffix == '.zip':
            continue
        data = (args.source / relative).read_bytes()
        require(__import__('hashlib').sha256(data).hexdigest() == expected, '导出时旧文件改变')
        target = args.out / 'source-originals' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    require(snapshot(args.source.resolve()) == checked['inspection']['sourceFileHashes'], '导出时来源改变')
    write_once(args.out / 'source-inspection.json', checked['inspection'])
    write_once(args.out / 'protocol.json', dict(protocol=PROTOCOL, caseIds=list(CASE_IDS),
        pairedHistoricalObjects=2, coldHistoricalObjects=8,
        totalHistoricalObjectsIncludingReplays=10, newObjects=0, adapterConditions=[False, True],
        maximumTextGenerations=MAX_GENERATIONS, maximumNewTokensPerGeneration=MAX_TOKENS,
        mathematicalReproductions=8, pairedDraftGenerations=4, teacherCalls=0,
        trainingUpdates=0, featureForwardBatches=0, selectorCalls=0,
        promptsAndKeywordsAndAttemptAndFeedbackUnchanged=True,
        noCorrectedAnswerSupplied=True, allRawSavedBeforeAudit=True,
        original8DraftsAndAll64ResponsesRetained=True, independentTrainingReplications=0,
        totalSeconds=1200, draftStageSeconds=600, reuseOnNewObjectsTested=False,
        oldBankPromotion=False, wholeDraftCertified=False))
    total_deadline = float(os.environ.get('ZIP_WRITER_CHECK_DEADLINE', str(time.time() + 1200)))
    deadline = time.monotonic() + max(0., total_deadline - time.time())
    engine = PairEngine(args.out, None, None, progress.mark, deadline=deadline)
    base = adapter = None
    state_digest = None
    before_base = before_writer = None
    after_base = after_writer = None
    frozen_final = None
    source_unchanged = protected_unchanged = tools_unchanged = None
    stop, error = 'completed', None

    def timeout(signum, frame):
        raise TimeoutError('到达阶段／总时间上限，保留已完成原文')

    signal.signal(signal.SIGTERM, timeout)
    previous_handler = signal.signal(signal.SIGALRM, timeout)
    signal.setitimer(signal.ITIMER_REAL, max(.001, deadline - time.monotonic()))
    try:
        progress.mark('加载原学生和数学适配器（CPU，离线，权重冻结）')
        import torch
        from safetensors.torch import load_file
        from zip_pilot import load_student
        from zip_pilot_model import state_digest
        from math_writer_adapter import MathWriterAdapter
        from zip_generation_policy import generate_response
        from frozen_zip_route import invoke_adapter_route
        base, tokenizer, metadata = load_student(args.student, 'cpu')
        require(metadata['snapshotSha256'] == checked['identity']['snapshotSha256'], '加载的基础模型不是原快照')
        before_base = state_digest(base)
        adapter = MathWriterAdapter(base, rank=8, last_layers=4, alpha=16)
        adapter.restore(load_file(str(checked['writer'])))
        before_writer = adapter.digest()
        require(before_writer == checked['checkpoint']['writerStateHash'], '加载的数学适配器不是原末态')
        base.eval().requires_grad_(False)
        adapter.eval()
        for p in adapter.parameters_to_train():
            p.grad = None
            p.requires_grad_(False)
        write_once(args.out / 'observed-model-identity.json', dict(
            snapshotSha256=metadata['snapshotSha256'], baseStateHash=before_base,
            writerStateHash=before_writer, device='cpu', sampled=False, temperature=1.,
            maximumTokens=MAX_TOKENS))

        def frozen():
            require(adapter.enabled is True and adapter.digest() == before_writer and
                    not base.training and not adapter.training and
                    all(not p.requires_grad and p.grad is None for p in
                        list(base.parameters()) + adapter.parameters_to_train()),
                    '冻结权重／梯度／适配器恢复状态改变')

        def generate(prompt, tokens, seed, enabled):
            remaining = deadline - time.monotonic()
            if engine.cold_ok == 8:
                # Hard wall clock for the four drafts, including frozen audits.
                remaining = min(remaining, 600 - (time.monotonic() - draft_started[0]))
            if remaining <= 0:
                raise TimeoutError('阶段预算已到')
            signal.setitimer(signal.ITIMER_REAL, remaining)
            return invoke_adapter_route(adapter, lambda: generate_response(
                base, tokenizer, prompt, tokens, seed, sampled=False, temperature=1.), enabled)

        draft_started = [None]
        def mark(stage=None, **fields):
            if engine.cold_ok == 8 and draft_started[0] is None:
                draft_started[0] = time.monotonic()
            progress.mark(stage, **fields)
        engine.generate = generate
        engine.frozen = frozen
        engine.progress = mark
        engine.run(checked['anchors'], checked['contexts'])
    except Exception as exc:
        stop = 'time_budget' if isinstance(exc, TimeoutError) else 'error'
        error = type(exc).__name__ + ': ' + str(exc)
        write_once(args.out / 'error.json', dict(error=error, traceback=traceback.format_exc(),
                                               generationAttempts=engine.attempts))
        print('已停止：' + error, flush=True)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        # This is verification, never a weight restoration or optimizer step.
        if base is not None and before_base is not None:
            try:
                after_base = state_digest(base)
                if adapter is not None and before_writer is not None:
                    after_writer = adapter.digest()
                    frozen_final = adapter.enabled is True and not base.training and not adapter.training and all(
                        not p.requires_grad and p.grad is None for p in
                        list(base.parameters()) + adapter.parameters_to_train())
            except Exception as exc:
                error = (error + '; ' if error else '') + '末态核验失败：' + str(exc)
                stop = 'error'
        if adapter is not None:
            adapter.close()
        try:
            source_unchanged = snapshot(args.source.resolve()) == checked['inspection']['sourceFileHashes']
            protected_unchanged = all(sha(Path(p)) == h for p, h in checked['protected'].items())
            tools_unchanged = snapshot(args.old_tools.resolve()) == checked['toolFiles']
            if source_unchanged is not True or protected_unchanged is not True or tools_unchanged is not True:
                raise ValueError('原资料／模型文件／旧工具发生变化')
            if before_base is not None and (after_base != before_base or
                   before_writer is not None and (after_writer != before_writer or frozen_final is not True)):
                raise ValueError('冻结末态不符')
        except Exception as exc:
            error = (error + '; ' if error else '') + str(exc)
            stop = 'error'
    result = dict(protocol=PROTOCOL, stopReason=stop, error=error,
        fixtureOnly=False, fixtureGenerations=0, generationAttempts=engine.attempts,
        actualStudentGenerations=len(engine.raw), rawResponsesSaved=len(engine.raw),
        scoredResponses=len(engine.scored), rawResponsesWithoutCompletedAudit=len(engine.raw) - len(engine.scored),
        coldReproductions=engine.cold_ok, originalOffDraftReproductions=engine.off_ok,
        pairedHistoricalObjects=2, coldHistoricalObjects=8,
        totalHistoricalObjectsIncludingReplays=len({r['task']['id'] for r in checked['anchors']} |
            {c['task']['id'] for c in checked['contexts']}),
        newObjects=0, completePairs=len(engine.pairs),
        actualDraftGenerations=sum(r['phase'] != 'cold_replay' for r in engine.raw),
        generatedTokens=sum(r['studentOutput'].get('generatedTokens', 0) for r in engine.raw),
        textGenerationsSeparateFromObjectCount=True, teacherCalls=0, trainingUpdates=0,
        baseTrainingUpdates=0, writerTrainingUpdates=0, choiceHeadTrainingUpdates=0,
        featureForwardBatches=0, selectorCalls=0, independentTrainingReplications=0,
        baseStateBefore=before_base, baseStateAfter=after_base,
        writerStateBefore=before_writer, writerStateAfter=after_writer,
        baseWeightsUnchanged=before_base is not None and after_base == before_base,
        writerWeightsUnchanged=before_writer is not None and after_writer == before_writer,
        adapterAndGradientsFrozenAtEnd=frozen_final, originalFilesUnchanged=source_unchanged,
        protectedFilesUnchanged=protected_unchanged, oldToolsUnchanged=tools_unchanged,
        protectedFileHashesBefore=checked['protected'],
        choiceHeadsUnchanged=source_unchanged, allRawSavedBeforeAudit=True,
        outputChanges=sum(p['outputTextChanged'] for p in engine.pairs),
        improvementEstablished=False, semanticReviewPending=True, newObjectReuseTested=False,
        wholeDraftCertified=False, oldBankPromotion=False, pairs=engine.pairs,
        elapsedSeconds=time.monotonic() - start)
    write_once(args.out / 'result.json', result)
    report_path = args.out / 'Lain-Zip-Writer-Check.md'
    report_path.write_text(markdown(checked['contexts'], engine, result), encoding='utf-8')
    progress.mark('结果与全部原文保存完毕', inFlight=None)
    attachment = archive(args.out)
    print('配对检查统计：' + json.dumps({k: result[k] for k in (
        'stopReason', 'error', 'generationAttempts', 'actualStudentGenerations', 'coldReproductions',
        'originalOffDraftReproductions', 'pairedHistoricalObjects', 'coldHistoricalObjects',
        'totalHistoricalObjectsIncludingReplays', 'completePairs', 'actualDraftGenerations',
        'trainingUpdates', 'teacherCalls', 'baseWeightsUnchanged', 'writerWeightsUnchanged',
        'originalFilesUnchanged', 'outputChanges', 'improvementEstablished', 'semanticReviewPending')},
        ensure_ascii=False), flush=True)
    for c in checked['contexts']:
        for r in engine.raw:
            if r.get('caseId') == c['draftRecordId']:
                print('\n' + c['task']['expression'] + ' | ' + r['phase'] + '\n' +
                      r['studentOutput']['raw'], flush=True)
    print('\n完整检查包：' + str(attachment), flush=True)
    return 0 if stop == 'completed' else 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--student', type=Path)
    parser.add_argument('--old-tools', type=Path)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--inspect-only', action='store_true')
    args = parser.parse_args()
    if args.inspect_only:
        inspection, anchors, contexts = source_cases(args.source)
        print(json.dumps(dict(sourceAudit='passed', allRawRecords=64, allRoutesRechecked=36,
             originalDrafts=8, fixedCases=[c['draftRecordId'] for c in contexts],
             coldReplayPlan=len(anchors), studentCalls=0, trainingUpdates=0, teacherCalls=0,
             modelAndAdapterNotLoaded=True, modelFilesNotChecked=True), ensure_ascii=False))
        return 0
    require(args.student is not None and args.old_tools is not None and args.out is not None,
            '真实检查需要原学生环境和独立输出目录')
    return run(args)


if __name__ == '__main__':
    raise SystemExit(main())
