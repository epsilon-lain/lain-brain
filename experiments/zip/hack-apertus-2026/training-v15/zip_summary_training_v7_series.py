"""Fixed consecutive courses, every result reported; no heldout-based picking.

All model work occurs in execute_round in the original Notebook environment.
The orchestration and aggregation can be tested offline without loading a model.
"""
import json
import math
from pathlib import Path
import time
import uuid

from zip_summary_training_v7_core import (PROTOCOL, BRANCHES, EVALUATION_ARMS,
    TRAINING_OBJECTS, HELDOUT_OBJECTS, SUMMARIES_PER_BRANCH, GROUPS_PER_BRANCH,
    MAX_GENERATIONS, MAX_FEATURE_BATCHES, MAX_SUMMARY_TOKENS, MAX_SUMMARY_WORDS,
    SUMMARY_LEARNING_RATE, require)
from zip_summary_training_v7_scope import READER_UPDATE_CAP, validate_plan

SERIES_PROTOCOL = 'lain-zip-consecutive-summary-courses-v7'
DEFAULT_ROUNDS = 3
ROUND_SECONDS = 1200


def recipe(payload_hash, rounds):
    require(type(rounds) is int and 1 <= rounds <= 10, 'Rounds must be an integer from 1 to 10')
    return dict(protocol=SERIES_PROTOCOL, courseProtocol=PROTOCOL, requestedRounds=rounds,
        payloadSha256=payload_hash, trainingObjectsPerRound=TRAINING_OBJECTS,
        heldoutObjectsPerRound=HELDOUT_OBJECTS, summaryCandidatesPerRound=2*SUMMARIES_PER_BRANCH,
        writingStepCapPerRound=2*GROUPS_PER_BRANCH, choiceStepCapPerRound=2*TRAINING_OBJECTS,
        isolatedReaderStepCapPerRound=READER_UPDATE_CAP,
        readerCalibrationExcludedFromWordReward=True,
        curriculumStages=['constant_variations','variable_renaming','nested_inner_or_outer_coefficient'],
        stageChosenByCompletedCourseCountNotHeldoutScore=True,
        maximumGenerationsPerRound=MAX_GENERATIONS, maximumFeatureBatchesPerRound=MAX_FEATURE_BATCHES,
        maximumSummaryTokens=MAX_SUMMARY_TOKENS, maximumAdmittedSummaryWords=MAX_SUMMARY_WORDS,
        summaryLearningRate=SUMMARY_LEARNING_RATE, maximumSecondsPerRound=ROUND_SECONDS,
        nextSourcePolicy='immediately_previous_complete_course',
        nextSourceChosenByHeldoutScore=False, adaptiveRetries=False,
        allCompletedRoundsReported=True, feedbackRulesFixedAcrossRounds=True,
        coursesAreContinuationNotIndependentReplications=True, independentTrainingReplications=0,
        earlierHeldoutFeedbackUsedForOptimization=False)


def _write(path, row):
    path = Path(path)
    temp = path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    temp.write_text(json.dumps(row,ensure_ascii=False,indent=2,allow_nan=False)+'\n',encoding='utf-8')
    temp.replace(path)


def validate_round(folder, parent, fixed, seen):
    folder = Path(folder)
    result = json.loads((folder/'result.json').read_text())
    require(result.get('protocol')==PROTOCOL and result.get('fixtureOnly') is False and
        not result.get('fixtureGenerations') and not result.get('teacherCalls') and
        not result.get('offlineFixtureFactory'), 'A fixture or different protocol cannot complete a real series')
    require(result.get('stopReason')=='completed' and result.get('error') is None and
        result.get('completeTrainingExperiment') is True and
        result['completedTrainingObjects']==TRAINING_OBJECTS and result['completedHeldoutObjects']==HELDOUT_OBJECTS and
        result['coldReproductions']==8 and all(result[k] is True for k in
            ('baseWeightsUnchanged','mathematicalWriterUnchanged','originalSemanticWriterUnchanged',
             'originalFilesUnchanged','heldoutLearnedStateUnchanged')),
        'The next course requires the previous course to finish with its frozen checks')
    require(68<=result['actualStudentGenerations']<=MAX_GENERATIONS and
        result['studentWrittenSummaryZips']==2*SUMMARIES_PER_BRANCH and
        0<=result['summaryOptimizerUpdates']<=2*GROUPS_PER_BRANCH and
        0<=result['readerHeadTrainingUpdates']<=READER_UPDATE_CAP and
        result['summaryOptimizerUpdates']+result['readerHeadTrainingUpdates']<=result['trainingUpdates']<=
            2*(GROUPS_PER_BRANCH+TRAINING_OBJECTS)+READER_UPDATE_CAP,
        'Continuous course generation or actual update counts differ')
    protocol = json.loads((folder/'protocol.json').read_text())
    require(protocol['protocol']==PROTOCOL and
        protocol['maximumSummaryTokens']==fixed['maximumSummaryTokens'] and
        protocol['summaryMaximumWords']==fixed['maximumAdmittedSummaryWords'] and
        protocol['summaryAuditProtocol']=='selected-experience-literal-audit-v6' and
        protocol['summaryPromptContainsOnlySelectedAction'] is True and
        protocol['maximumReaderHeadUpdates']==READER_UPDATE_CAP and
        protocol['readerCalibrationExcludedFromWordReward'] is True,
        'Continuous courses changed their fixed recipe')
    checkpoint = json.loads((folder/'source-checkpoint.json').read_text())
    require(Path(checkpoint['parentSource']).resolve()==Path(parent).resolve(),
        'A course resumed a score-selected or unrelated checkpoint')
    plan = json.loads((folder/'zip-summary-questions.json').read_text())
    validate_plan(plan)
    parent_result=json.loads((Path(parent)/'result.json').read_text())
    stage=min(3,parent_result.get('curriculumStage',0)+1)
    require(plan['curriculumStage']==result['curriculumStage']==protocol['curriculumStage']==stage,
        'The fixed curriculum did not continue by completed-course count')
    objects = plan['training']+plan['heldout']
    keys = [o['semanticInputKey'] for o in objects]
    require(len(keys)==TRAINING_OBJECTS+HELDOUT_OBJECTS and len(set(keys))==len(keys) and
        not set(keys)&seen, 'Continuous course objects were reused')
    require(all(t['split']=='training' for t in plan['training']) and
        all(t['split']=='heldout' for t in plan['heldout']), 'Continuous course split changed')
    heldout = [json.loads(p.read_text()) for p in (folder/'object').glob('*.json')]
    heldout = [o for o in heldout if o['phase']=='heldout']
    require(len(heldout)==HELDOUT_OBJECTS and
        {o['id'] for o in heldout}=={t['id'] for t in plan['heldout']}, 'Heldout evidence is incomplete')
    for obj in heldout:
        require(obj['trainingUpdates']==0 and obj['allChoicesSavedBeforeRoutes'] is True and
            len(obj['routeOutcomes'])==3 and all(type(v) is int and v in (0,1) for v in obj['routeOutcomes']),
            'Heldout outcomes or ordering differ')
        for arm in EVALUATION_ARMS:
            p = obj['probabilitiesByArm'][arm]
            require(len(p)==3 and all(type(v) in (int,float) and math.isfinite(v) and 0<=v<=1 for v in p) and
                abs(sum(p)-1)<=1e-12 and
                abs(sum(v*y for v,y in zip(p,obj['routeOutcomes']))-obj['expectedPassByArm'][arm])<=1e-12,
                'Reported probability differs from shared verified routes')
    for arm in EVALUATION_ARMS:
        mean = sum(o['expectedPassByArm'][arm] for o in heldout)/HELDOUT_OBJECTS
        require(abs(mean-result['summary']['expectedPassByArm'][arm])<=1e-12, 'Unpaired course report')
    seen.update(keys)
    return result,heldout,checkpoint


def summarize_series(records, fixed, error=None):
    completed = [r for r in records if r['acceptedForContinuation']]
    heldout = [o for r in completed for o in r['heldoutObjects']]
    count = len(heldout)
    means = {a:sum(o['expectedPassByArm'][a] for o in heldout)/count if count else None for a in EVALUATION_ARMS}
    results = [r['result'] for r in records if r.get('result') is not None]
    reports = [r['summary'] for r in results]
    def total(key):return sum(r.get(key,0) for r in reports)
    return dict(protocol=SERIES_PROTOCOL,courseProtocol=PROTOCOL,
        requestedRounds=fixed['requestedRounds'],attemptedRounds=len(records),completedRounds=len(completed),
        stopReason='completed' if len(completed)==fixed['requestedRounds'] and error is None else 'incomplete',error=error,
        completeFixedSeries=len(completed)==fixed['requestedRounds'] and error is None,
        actualStudentGenerations=sum(r['actualStudentGenerations'] for r in results),
        actualTrainingUpdates=sum(r['trainingUpdates'] for r in results),
        actualSummaryOptimizerUpdates=sum(r['summaryOptimizerUpdates'] for r in results),
        actualIsolatedReaderUpdates=sum(r.get('readerHeadTrainingUpdates',0) for r in results),
        isolatedReaderCalibrationRecords=sum(r.get('readerCalibrationRecords',0) for r in results),
        studentWrittenCandidates=sum(r['studentWrittenSummaryZips'] for r in results),
        completedTrainingObjects=sum(r['completedTrainingObjects'] for r in results),
        completeCourseTrainingObjects=sum(r['result']['completedTrainingObjects'] for r in completed),
        partialCourseTrainingObjects=sum(r['result']['completedTrainingObjects'] for r in records
            if not r['acceptedForContinuation'] and r.get('result') is not None),
        diagnosticCountsIncludeIncompleteRounds=True,
        heldoutUniqueObjects=count,independentSummarySourceTasks=total('uniqueSummarySourceTasks'),
        measuredPositiveCandidateCredits=total('measuredPositiveCandidateCredits'),
        measuredNegativeCandidateCredits=total('measuredNegativeCandidateCredits'),
        cappedSummaries=total('cappedSummaries'),overlongSummaries=total('overlongSummaries'),
        knownContradictionSummaries=total('summariesWithKnownContradictions'),
        pendingMathematicsSummaries=total('pendingInlineMathematicsSummaries'),
        operativeSummaryContextUses=total('operativeSummaryContextUses'),
        expectedPassAcrossAllCompletedHeldoutObjects=means,
        sameHeadSummaryEffectAcrossAllHeldoutObjects=(means[BRANCHES[0]]-means[EVALUATION_ARMS[2]]) if count else None,
        reuseSelectorChangeAgainstOwnFrozenPreRoundHead=(means[EVALUATION_ARMS[6]]-means[EVALUATION_ARMS[3]]) if count else None,
        scopedSummaryPolicyVsMatchedReaderControl=(means[BRANCHES[0]]-means[EVALUATION_ARMS[5]]) if count else None,
        programStructuralScope=True,studentAutonomousScopeDiscoveryTested=False,
        sealSelectorChangeAgainstOwnFrozenPreRoundHead=(means[BRANCHES[1]]-means[EVALUATION_ARMS[4]]) if count else None,
        allRoundsReportedWithoutBestRunSelection=True,recipe=fixed,
        byRound=[dict(seriesOrdinal=r['seriesOrdinal'],folder=r['folder'],exitCode=r['exitCode'],
            acceptedForContinuation=r['acceptedForContinuation'],
            error=r['result'].get('error') if r.get('result') else None,
            completedTrainingObjects=r['result'].get('completedTrainingObjects',0) if r.get('result') else 0,
            completedHeldoutObjects=r['result'].get('completedHeldoutObjects',0) if r.get('result') else 0,
            trainingRound=r['result'].get('trainingRound') if r.get('result') else None,
            curriculumStage=r['result'].get('curriculumStage') if r.get('result') else None,
            report=r['result'].get('summary') if r.get('result') else None) for r in records],
        lastCompleteCheckpoint=completed[-1]['folder'] if completed else None,
        roundsAreNotIndependentTrainingReplications=True,independentTrainingReplications=0,
        differentHeldoutObjectsAcrossRounds=True,rawBetweenRoundMeansDoNotIsolateLearning=True,
        heldoutFeedbackUsedForOptimization=False,nextSourceChosenByHeldoutScore=False,
        statisticalSignificanceClaimed=False,summaryLearningBenefitProved=False)


def run_series(source, work, series_folder, fixed, execute_round, deadline, on_round=None):
    """Execute each planned course once; a failed course stops dependent work."""
    source = Path(source).resolve()
    initial_source = source
    series_folder = Path(series_folder)
    series_folder.mkdir(parents=True,exist_ok=False)
    _write(series_folder/'protocol.json',dict(fixed,initialSource=str(source)))
    records = [];seen = set();error = None;last_attempt = None;foundation = None
    for ordinal in range(1,fixed['requestedRounds']+1):
        if time.monotonic()>=deadline:
            error = 'Timeout before the next planned course';break
        folder = Path(work)/('zip-summary-training-'+uuid.uuid4().hex[:8])
        require(not folder.exists(), 'Random output path already exists; no retry')
        round_deadline = min(deadline,time.monotonic()+ROUND_SECONDS)
        row = dict(seriesOrdinal=ordinal,folder=str(folder),parentSource=str(source),
            acceptedForContinuation=False,exitCode=None,result=None,heldoutObjects=[])
        try:
            status = execute_round(source,folder,ordinal,round_deadline)
            row['exitCode'] = status['exitCode']
            path = folder/'result.json'
            if path.is_file():row['result'] = json.loads(path.read_text())
            if status['exitCode']!=0:
                reason=row['result'].get('error') if row['result'] else None
                raise RuntimeError('Course '+str(ordinal)+' failed: '+str(reason or ('child exit '+str(status['exitCode']))))
            require(row['result'] is not None, 'Course returned no result')
            result,heldout,checkpoint = validate_round(folder,source,fixed,seen)
            identity = (checkpoint['baseStateHash'],checkpoint['mathematicalWriterStateHash'])
            if foundation is None:foundation = identity
            require(identity==foundation, 'A later course changed the frozen foundation')
            row.update(result=result,heldoutObjects=heldout,acceptedForContinuation=True)
            source = folder.resolve()
        except Exception as exc:
            error = type(exc).__name__+': '+str(exc)
        records.append(row);last_attempt = folder
        report = summarize_series(records,fixed,error)
        report.update(initialSource=str(initial_source),resumeSourceForNextAttempt=str(source))
        _write(series_folder/'result.json',report)
        if on_round:on_round(row,report)
        if not row['acceptedForContinuation']:break
    report = summarize_series(records,fixed,error)
    report.update(initialSource=str(initial_source),resumeSourceForNextAttempt=str(source))
    _write(series_folder/'result.json',report)
    return dict(folder=series_folder,lastAttempt=last_attempt,records=records,report=report)
