"""v4 experience-driven calls to provisioned measurement ZIPs; no optimizer."""
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
import hashlib

from draft_inspect_runtime import read, sha, snapshot
from writer_check_core import write_once
from writer_check_run import preflight
from zip_label_metacognitive_source import inspect_source
from zip_self_question_tools_core import (PROTOCOL, PHASES, MAX_ATTEMPTS, MAX_GENERATIONS, MAX_TOKENS,
    SCHEDULE, INPUT_PRESENTATION_VERSION, REVIEW_REQUEST_VERSION, require, run_probe, summary,
    completion_status, review_messages,
    history_presentation, build_bank, validate_bank, execute_tool)
from zip_self_question_tools_source import load_bundle
from zip_self_question_tools_policy import generate, input_limits, prompt_audit, require_input, preflight_prompts
from zip_self_question_tools_progress import StageProgress


def write_tool_zips(folder, bank):
    """Provision actual immutable ZIP files with roots and the bound kernel."""
    validate_bank(bank)
    folder.mkdir(parents=True, exist_ok=False)
    kernel = Path(__file__).with_name('zip_self_question_tools_core.py').read_bytes()
    require(hashlib.sha256(kernel).hexdigest() == bank['tools'][0]['kernelSha256'], 'Kernel source hash changed')
    for tool in bank['tools']:
        path = folder / (tool['id'] + '.zip')
        with zipfile.ZipFile(path, 'x', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('root.json', json.dumps(tool, ensure_ascii=False, indent=2))
            archive.writestr('kernel.py', kernel)
            archive.writestr('README.txt', 'Host-provisioned measurement ZIP. The frozen runner reads this root and dispatches only its fixed allowlisted operation. It never executes arbitrary ZIP contents. Dependencies and evidence are in the complete result package. No measured values, preferred directions, student questions or plans are stored in this ZIP. This is a tool definition, not a student-trained neuron.\n')
    write_once(folder / 'bank.json', bank)
    return snapshot(folder)


def validate_tool_file(folder, bank, identifier):
    tool = next(t for t in bank['tools'] if t['id'] == identifier)
    with zipfile.ZipFile(folder / (identifier + '.zip')) as archive:
        require(archive.namelist() == ['root.json', 'kernel.py', 'README.txt'] and archive.testzip() is None,
                'Measurement ZIP contents changed')
        require(json.loads(archive.read('root.json')) == tool and
                hashlib.sha256(archive.read('kernel.py')).hexdigest() == tool['kernelSha256'],
                'Measurement root/kernel binding changed')


def next_probe(work):
    numbers = []
    for folder in Path(work).glob('zip-self-question-tools-*'):
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


def prepare_inputs(student, bundle, bank, probe_number):
    # Read the original local tokenizer/config before any weight allocation.
    # Match load_student's regex policy exactly, and never download a model.
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(student, local_files_only=True, trust_remote_code=False,
        fix_mistral_regex=False)
    limits = input_limits(read(student / 'config.json'), tokenizer)
    return limits, preflight_prompts(bundle, bank, tokenizer, limits, probe_number)


def run(args):
    start = time.monotonic()
    parent = args.source.resolve()
    resume = inspect_source(parent)  # Reject incomplete/fixture sources before any model import.
    bundle, route_provenance = load_bundle(resume)
    kernel_sha = sha(Path(__file__).with_name('zip_self_question_tools_core.py'))
    bank = build_bank(kernel_sha)
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
    progress = StageProgress(os.environ.get('ZIP_SELF_QUESTION_TOOLS_PROGRESS_FILE'))
    write_once(args.out / 'protocol.json', dict(protocol=PROTOCOL, probeNumber=probe_number,
        inputPresentationVersion=INPUT_PRESENTATION_VERSION, inputLengthCheckedBeforeWeightsLoaded=True,
        reviewRequestVersion=REVIEW_REQUEST_VERSION, currentReviewRequestAfterAllHistory=True,
        requestedReviewSentences=1, historicalComparisonIsNotPairedCausalEvidence=True,
        completionReportingVersion=2,
        everyActualPrefixCheckedWithOriginalTokenizer=True, historical2048TokenGuardUnmodified=True,
        inputCeilingTokens=4096, actualModelContextLimitAlsoEnforced=True,
        duplicateActionDefinitionsFactoredByExactString=True, allEightOriginalHistoriesReviewed=True,
        callAndQuestionUseStudentAssessmentWithoutRepeatedJournal=True,
        phases=list(PHASES), scheduledAttempts=MAX_ATTEMPTS,
        decodingSchedule=[dict(attempt=n, sampled=sampled) for n,sampled in SCHEDULE],
        hostChoosesMetric=False, measurementToolsAuthoredByHost=True,
        assessmentBeforeCatalogue=True, metricTableSuppliedBeforeSelection=False,
        selectedToolOnlyComputedAfterActualStudentCall=True,
        numericalCopyNotRequired=True, provisionedMeasurementToolCount=len(bank['tools']),
        fixedAllowlistKernelSha256=kernel_sha,
        semanticRelevanceAutomaticallyCertified=False,
        invalidOrDeclinedCallSkipsQuestionWithoutFallbackOrRetry=True,
        actualNaturalEosRequired=True, questionOnlyNoPlan=True, historicalScoresChanged=False,
        generationCap=MAX_GENERATIONS, tokensPerGeneration=MAX_TOKENS,
        sourceFrameHash=bundle['privateSourceFrame']['frameHash'], evidenceBundleHash=bundle['bundleHash'],
        bankHash=bank['bankHash'], originalTrainingObjects=8, independentTrainingHistorySets=1,
        newMathematicsObjects=0, heldoutUsed=False, fullSoftmaxSampling=True,
        teacherCalls=0, trainingUpdates=0, mathematicalWriterFrozen=True, semanticWriterFrozen=True,
        sourceHeadAndLabelsFrozen=True, hostQuestionOrPlanSupplied=False, originalTextRepaired=False,
        newStudentZipActivated=False, measurementToolBankProvisioned=True,
        sourceActiveZipBankUnchanged=True, disprovedReflectionLiteralsAreDiagnosticOnly=True,
        performanceBenefitTested=False, automaticTrainingStarted=False,
        sourceSelectedByChronology=True, partialProbeNumbersReserved=True, totalSeconds=600))
    write_once(args.out / 'source-checkpoint.json', dict(source=str(parent), sourceResultSha256=sha(parent / 'result.json'),
        sourceProtocol=resume['result']['protocol'], sourceFileHashes=resume['sourceHashes'],
        semanticCheckpointSha256=sha(parent / 'checkpoints' / resume['final']['semanticFile']),
        semanticStateHash=resume['final']['semanticStateHash'],
        originalHead=resume['final']['head'], originalLabels=resume['final']['labels'],
        originalMetaZip=resume.get('initialMeta'), continuationCheckpointCreated=False))
    write_once(args.out / 'private-source-readout-not-in-prompts.json', bundle['privateSourceFrame'])
    write_once(args.out / 'experience-evidence-bundle.json', bundle)
    write_once(args.out / 'prompt-history-presentation.json', history_presentation(bundle))
    write_once(args.out / 'source-route-provenance.json', route_provenance)
    write_once(args.out / 'experience-journal.json', dict(rows=bundle['journal'], trainingOnly=True,
        containsAggregateMetricTable=False, taskHistoryOrderChosenByScores=False,
        sourceObservationsAndMathPreservedVerbatim=True, mathematicalRoutesWereHostAssigned=True))
    tool_folder = args.out / 'measurement-zips'
    tool_snapshot = write_tool_zips(tool_folder, bank)
    initial_bundle_hash, initial_bank_hash = bundle['bundleHash'], bank['bankHash']
    write_once(args.out / 'source-training-anchors.json', dict(rows=resume['anchors'], trainingOnly=True,
        representationsFromLastCommittedSource=True, freshModelRepresentationsNotGenerated=True))
    for key, original in bundle['routes'].items():
        write_once(args.out / 'source-training-routes' / (key.replace('/', '-') + '.json'), original)
    for path in Path(__file__).resolve().parent.glob('*.py'):
        target = args.out / 'evaluation-code' / path.name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(path.read_bytes())
    deadline = time.monotonic() + max(0., float(os.environ.get('ZIP_SELF_QUESTION_TOOLS_DEADLINE', str(time.time() + 600))) - time.time())
    attempts = 0
    input_audits = []
    limits = input_preflight = None
    raw_rows, scored_rows, completed_attempts, executed_tools = [], [], [], []
    base = mathematical = semantic = None
    base_before = math_before = semantic_before = None
    base_after = math_after = semantic_after = None
    source_ok = protected_ok = tools_ok = frozen_ok = bank_ok = None
    stop, error = 'completed', None

    def save(kind, row):
        target = (args.out / 'responses' / (row['recordId'] + '-' + kind + '.json') if kind in ('raw', 'scored')
                  else args.out / kind / (row['id'] + '.json'))
        write_once(target, row)
        if kind == 'raw':
            raw_rows.append(copy.deepcopy(row))
        elif kind == 'scored':
            scored_rows.append(copy.deepcopy(row))
        elif kind == 'attempt':
            completed_attempts.append(copy.deepcopy(row))
        elif kind == 'tool-executed':
            executed_tools.append(copy.deepcopy(row))
        progress.mark(rawResponsesSaved=len(raw_rows), scoredResponses=len(scored_rows), generationAttempts=attempts,
                      inFlight=None, completedAttempts=len(completed_attempts))

    def timeout(signum, handler):
        raise TimeoutError('Experience measurement ZIP deadline reached')

    old_term = signal.signal(signal.SIGTERM, timeout)
    old_alarm = signal.signal(signal.SIGALRM, timeout)
    signal.setitimer(signal.ITIMER_REAL, max(.001, deadline - time.monotonic()))
    try:
        progress.mark('只加载原 tokenizer；预检回顾、调用和提问的输入长度，尚未加载学生权重')
        limits, input_preflight = prepare_inputs(args.student, bundle, bank, probe_number)
        write_once(args.out / 'prompt-length-preflight.json', input_preflight)
        for row in input_preflight['rows']:
            require_input(row['audit'])
            require(row['planningFits'], 'Input planning budget exceeded for ' + row['phase'] +
                ': planned=' + str(row['plannedTokens']) + ', allowed=' + str(limits['maxInputTokens']))
        print('输入预检通过：八题完整经历 ' + str(input_preflight['rows'][0]['audit']['inputTokens']) +
            ' token；本轮输入上限 ' + str(limits['maxInputTokens']) +
            ' token；调用和提问模板也已检查。随后每次生成前再次核对实际输入。', flush=True)
        progress.mark('加载冻结学生；两次经历评估、指标 ZIP 调用与提问，最多六次生成')
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
            require(bundle['bundleHash'] == initial_bundle_hash and bank['bankHash'] == initial_bank_hash and
                snapshot(tool_folder) == tool_snapshot and
                sha(Path(__file__).with_name('zip_self_question_tools_core.py')) == kernel_sha,
                'Experience bundle, kernel or measurement ZIP bank changed')
            require(mathematical.enabled is True and semantic.enabled is True and
                not base.training and not mathematical.training and not semantic.training and
                all(not p.requires_grad and p.grad is None for p in list(base.parameters()) +
                    mathematical.parameters_to_train() + semantic.parameters_to_train()), 'Frozen state/gradient flags changed')
            require(state_digest(base) == base_before and mathematical.digest() == math_before and
                    semantic.digest() == semantic_before, 'A frozen parameter changed')

        def ask(prompt, condition, seed, sampled):
            nonlocal attempts
            require(attempts < MAX_GENERATIONS, 'Six-generation budget reached')
            audit = prompt_audit(tokenizer, prompt, limits)
            input_audits.append(copy.deepcopy(audit))
            write_once(args.out / 'prompt-inputs' / (str(seed) + '-' + condition + '.json'),
                dict(phase=condition, samplingSeed=seed, studentPrompt=prompt, audit=audit,
                    studentGenerationStarted=False))
            require_input(audit)
            attempts += 1
            progress.mark('经历／指标 ZIP ' + str(attempts) + '/6：' + condition + (' sampled' if sampled else ' greedy'),
                          generationAttempts=attempts, inFlight=dict(condition=condition, seed=seed))
            begin = time.monotonic()
            with mathematical.active(False), semantic.active(True):
                value = generate(base, tokenizer, prompt, condition, seed, sampled, input_audit=audit)
            value = dict(value, mathAdapterEnabledDuringGeneration=False, semanticAdapterEnabledDuringGeneration=True,
                         semanticStateHashDuringGeneration=semantic_before, generationSeconds=time.monotonic() - begin,
                         promptInputAudit={k:v for k,v in audit.items() if k != 'promptIds'})
            return value

        def measure(evidence, tools, call_output, call_check):
            validate_tool_file(tool_folder, tools, call_check['zipId'])
            return execute_tool(evidence, tools, call_output, call_check)

        run_probe(bundle, bank, probe_number, ask, save, frozen,
                  lambda: deadline - time.monotonic(), measure=measure)
        frozen()
        frozen_ok = True
    except Exception as exc:
        stop = 'time_budget' if isinstance(exc, TimeoutError) else 'error'
        error = type(exc).__name__ + ': ' + str(exc)
        write_once(args.out / 'error.json', dict(error=error, traceback=traceback.format_exc(),
            generationAttempts=attempts, rawResponsesSaved=len(raw_rows), scoredResponses=len(scored_rows),
            modelWeightsLoaded=base is not None,
            actualInputTokens=input_audits[-1]['inputTokens'] if input_audits else None))
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
            bank_ok = snapshot(tool_folder) == tool_snapshot
            require(source_ok and protected_ok and tools_ok and bank_ok and
                (base is None or base_before is not None and base_after == base_before) and
                (mathematical is None or math_before is not None and math_after == math_before) and
                (semantic is None or semantic_before is not None and semantic_after == semantic_before),
                'Final source/model/tool frozen check failed')
        except Exception as exc:
            stop = 'error'
            error = (error + '; ' if error else '') + 'Final check: ' + str(exc)
        if semantic is not None:
            semantic.close()
        if mathematical is not None:
            mathematical.close()
    completed_status = completion_status(stop, raw_rows, scored_rows, completed_attempts, executed_tools)
    result = dict(protocol=PROTOCOL, probeNumber=probe_number, stopReason=stop, error=error,
        reviewRequestVersion=REVIEW_REQUEST_VERSION, currentReviewRequestAfterAllHistory=True,
        requestedReviewSentences=1, completionReportingVersion=2,
        historicalComparisonIsNotPairedCausalEvidence=True,
        inputPresentationVersion=INPUT_PRESENTATION_VERSION, modelWeightsLoaded=base is not None,
        inputLengthCheckedBeforeWeightsLoaded=input_preflight is not None,
        inputPreflightPassed=input_preflight['allPlannedPromptsFit'] if input_preflight else False,
        inputLimits=limits, checkedActualInputTokenCounts=[x['inputTokens'] for x in input_audits],
        allActualInputBudgetsPassed=all(x['fitsInputBudget'] for x in input_audits),
        fixtureOnly=False, fixtureGenerations=0, teacherCalls=0, generationAttempts=attempts,
        actualStudentGenerations=len(raw_rows), rawResponsesSaved=len(raw_rows), scoredResponses=len(scored_rows),
        rawResponsesWithoutCompletedAudit=len(raw_rows) - len(scored_rows),
        **completed_status,
        completedAttempts=len(completed_attempts), generationCap=MAX_GENERATIONS,
        invalidOrDeclinedCallNeverUnlocksQuestion=True, semanticRelevanceAutomaticallyCertified=False,
        questionOnlyNoPlan=True, measurementDefinitionsAuthoredByHost=True,
        hostProvisionedMeasurementToolZips=len(bank['tools']), trainedMeasurementToolZips=0,
        metricTableSuppliedBeforeSelection=False, assessmentBeforeCatalogue=True,
        numbersCopiedByStudentNotRequired=True, measurementZipsUnchanged=bank_ok,
        trainingUpdates=0, semanticTrainingUpdates=0, choiceHeadTrainingUpdates=0, featureForwardBatches=0,
        newMathematicsObjects=0, heldoutObjects=0, newActivatedZipLabels=0, activeMetaZipUnchanged=True,
        baseStateBefore=base_before, baseStateAfter=base_after,
        baseWeightsUnchanged=bool(protected_ok) if base is None else base_before is not None and base_before == base_after,
        mathematicalWriterStateBefore=math_before, mathematicalWriterStateAfter=math_after,
        mathematicalWriterUnchanged=bool(protected_ok) if mathematical is None else math_before is not None and math_before == math_after,
        semanticStateBefore=semantic_before, semanticStateAfter=semantic_after,
        semanticWriterUnchanged=bool(source_ok) if semantic is None else semantic_before is not None and semantic_before == semantic_after,
        sourceFilesUnchanged=source_ok, protectedModelFilesUnchanged=protected_ok, originalToolsUnchanged=tools_ok,
        inMemoryFrozenFlagsChecked=frozen_ok, summary=summary(scored_rows, completed_attempts, executed_tools), elapsedSeconds=time.monotonic() - start,
        continuationCheckpointCreated=False, mathematicalBenefitProved=False, fullMetacognitionProved=False)
    write_once(args.out / 'result.json', result)
    lines = ['# 从经历评估到自主调用指标 ZIP（v4，末尾单句回顾）', '',
        '两次预先固定尝试：一次贪心、一次抽样。八题真实经历完整保留，当前回顾要求放在全部记录末尾，只要求学生用自己的话写一句观察。随后查看只有定义的指标 ZIP 目录，主动调用一个 ZIP；程序核验调用并计算所选指标，再让学生提出一个问题。最多六次生成，每次96token。指标根由程序提供，尚未训练；数字由工具计算，不能证明学生理解。没有整体指标表、预设弱点、示范问题、抄数字要求、重试或默认选择。', '',
        '程序正常结束、两次尝试处理完，以及回顾→调用 ZIP→提问实际走完，分别报告。三步完成要求每一步都是学生实际 EOS 原文、有效调用后有真实工具结果、最后有完整单问题；它只表示字面流程完成，内容相关性和理解仍需审阅。本次使用新种子；与旧结果的比较只能用于探索，不能证明提示变更的因果收益。', '',
        '```json', json.dumps(result['summary'], ensure_ascii=False, indent=2), '```', '',
        '八题经历中的相同动作说明仅按原文去重，用编号关联每次尝试；目标、学生原文和核验成败均保留。调用与提问阶段回显学生自己的评估，提问阶段仅展示所选工具的真实测量数值与定义，完整工具证据另存。输入上限取本地配置、tokenizer上下文和4096token资源上限的交集，另外为回答预留96token；三个阶段先预检，真实生成前再次核验，绝不自动裁剪。历史生成器及旧分数未修改。', '',
        '审阅原文时分别检查：学生评估是否依赖真实任务和结果；所选指标 ZIP 能否检验它自己提出的问题；最终问题是否结合工具结果；是否引入无来源事实。评估或问题中的错误等式可能是对旧错误的引用，标记为诊断事实，不能单凭它判断断言意图，也不给信用或改动原数学分数。程序只核验字面调用和工具数字，不自动认证发现问题、工具适用性、内容相关性或元认知能力。', '']
    for row in scored_rows:
        lines += ['## ' + row['recordId'], '', '原始学生文字：', '', '````text',
                  row['studentOutput']['raw'], '````', '', '状态：' + row['check']['status'] + '；原因：' + row['check']['reason'], '']
    (args.out / 'Lain-Zip-Self-Question-Tools-Review.md').write_text('\n'.join(lines), encoding='utf-8')
    archive = args.out / 'Lain-Zip-Self-Question-Tools-Results.zip'
    with zipfile.ZipFile(archive, 'x', zipfile.ZIP_DEFLATED) as z:
        for path in sorted(args.out.rglob('*')):
            if path.is_file() and path != archive:
                z.write(path, path.relative_to(args.out))
    print('经历评估与指标 ZIP 调用摘要：' + json.dumps(result['summary'], ensure_ascii=False), flush=True)
    print('完整性：' + json.dumps({k: result[k] for k in ('stopReason', 'error', 'actualStudentGenerations',
        'runCompletedNormally', 'allScheduledAttemptsProcessed', 'completedThreeStageAttempts',
        'completeExperienceToolExperiment',
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
        bundle, provenance = load_bundle(source)
        bank = build_bank(sha(Path(__file__).with_name('zip_self_question_tools_core.py')))
        print(json.dumps(dict(sourceProtocol=source['result']['protocol'], sourceTrainingObjects=8,
            evidenceBundleHash=bundle['bundleHash'], sourceFrameHash=bundle['privateSourceFrame']['frameHash'],
            sourceSemanticStateHash=source['final']['semanticStateHash'],
            firstAssessmentPrompt=review_messages(bundle), measurementToolRoots=bank,
            sourceRouteCount=len(provenance), metricTableSuppliedBeforeSelection=False,
            questionStageRequiresActualVerifiedStudentToolCall=True,
            hostChoosesMetric=False, measurementDefinitionsAuthoredByHost=True,
            semanticRelevanceAutomaticallyCertified=False,
            maximumStudentCalls=MAX_GENERATIONS, scheduledAttempts=MAX_ATTEMPTS,
            studentCalls=0, teacherCalls=0, trainingUpdates=0, modelNotLoaded=True), ensure_ascii=False))
        return 0
    require(all(getattr(args, k) is not None for k in ('work', 'student', 'old_tools', 'out')), 'Original Notebook paths required')
    return run(args)


if __name__ == '__main__':
    raise SystemExit(main())
