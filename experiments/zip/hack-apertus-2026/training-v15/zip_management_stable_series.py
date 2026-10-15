"""Fixed two-course continuation journal. No heldout-score source selection."""
import copy
import json
from pathlib import Path
import time
import tempfile
import uuid
import zipfile
from draft_inspect_runtime import read,snapshot
from zip_management_geometry_core import PROTOCOL as COURSE,require,digest,summarize
from zip_management_geometry_receipts import atomic_json,partial,review

PROTOCOL='lain-zip-fixed-two-geometry-courses-v14'
ROUNDS=2
PHASE_SECONDS=dict(setup=1200,training=1200,heldout=600,saving=360)


def source_binding(source,hashes):
    return dict(source=str(Path(source).resolve()),sourceFiles=hashes,
        completeSourceRequired=True,admittedPhase='complete v12/v13; actual TRAIN provenance and numerical ledgers replayed')


def recipe(payload_hash):
    return dict(protocol=PROTOCOL,courseProtocol=COURSE,rounds=ROUNDS,payloadSha256=payload_hash,
        trainingObjectsPerRound=8,heldoutObjectsPerRound=8,sourceReplayTrainingObjects=8,
        opportunitiesPerHeadPerRound=96,heads=['conditioned','raw','global'],
        maximumStudentGenerationsPerRound=88,maximumTokensPerGeneration=96,
        phaseSeconds=PHASE_SECONDS,totalBudgetSeconds=7200,
        nextSourcePolicy='immediately_previous_complete_course',nextSourceChosenByHeldoutScore=False,
        mathWriterTraining=False,languageModelTraining=False,feedbackRecipeChangedBetweenRounds=False,
        independentTrainingReplications=0,allCompletedAndPartialRoundsReported=True)


def find_previous(work,source,fixed):
    matches=[]
    for p in Path(work).glob('zip-management-stability-series-*/series-state.json'):
        v=read(p)
        if v.get('protocol')==PROTOCOL and v.get('source')==str(Path(source).resolve()) and v.get('recipe')==fixed:
            matches.append((v['createdAtNs'],str(p.parent),p.parent))
    return max(matches)[2] if matches else None


def validate_complete(folder,parent,reserved):
    """Read only after the child verified all old weights and wrote its receipt.

    Full parent provenance is independently reaudited by the next child. This
    lightweight harvest avoids loading or hashing the large model twice.
    """
    folder=Path(folder);p=read(folder/'protocol.json');r=read(folder/'result.json')
    require(p['protocol']==COURSE and p['fixtureOnly'] is False and p['teacherCalls']==0 and
        r['protocol']==COURSE and r['fixtureOnly'] is False and r['teacherCalls']==0 and
        r['completeTrainingExperiment'] is True and r['stopReason']=='completed' and r['error'] is None,
        'Not a complete real course')
    require(all(r.get(k) is True for k in ('oldBaseAndMathematicalWeightsUnchanged','originalFilesUnchanged',
        'heldoutLearnedStateUnchanged','oldMethodHeadsUnchanged')) and
        r['languageModelTraining'] is False and r['oldWeightOptimizerUpdates']==0,'Failed course freeze contract')
    require(read(folder/'source-checkpoint.json')['source']==str(Path(parent).resolve()),'Wrong series parent')
    actual=snapshot(folder);manifest=read(folder/'run-file-manifest.json')['files']
    require(all(actual.get(k)==v for k,v in manifest.items()),'Changed completed course bytes')
    plan=read(folder/'plan.json')
    from zip_management_geometry_core import validate_fixed_plan
    validate_fixed_plan(plan,reserved)
    objects=[read(p) for p in sorted((folder/'object').glob('*.json'))]
    require(len(objects)==8 and {o['task']['id'] for o in objects}=={t['id'] for t in plan['heldout']} and
        r['summary']==summarize(objects),'Changed completed frozen report')
    return r,plan


def can_recover(folder,parent):
    folder=Path(folder)
    paths=[folder/n for n in ('protocol.json','plan.json','source-checkpoint.json')]
    if not all(p.is_file() for p in paths):
        # Startup without a plan is restartable only when it saved no calls,
        # features or optimization steps. Never silently discard actual work.
        require(not any(list((folder/k).glob('*.json')) for k in ('responses','feature','head-step')),
            'Unbound saved work requires inspection; refuse fresh retry')
        return False
    require(read(paths[0])['protocol']==COURSE and read(paths[2])['source']==str(Path(parent).resolve()),
        'Wrong recovery course/source')
    return True


def harvest(folder,status):
    folder=Path(folder)
    if (folder/'result.json').is_file():return read(folder/'result.json')
    return partial(folder,'paused' if status.get('paused') else 'child_returned_no_final_result')


def run_series(source,work,folder,fixed,execute,deadline,on_round=None):
    source=Path(source).resolve();work=Path(work);folder=Path(folder)
    require(fixed==recipe(fixed['payloadSha256']),'Changed fixed two-round recipe')
    if (folder/'series-state.json').is_file():
        state=read(folder/'series-state.json')
        require(state['protocol']==PROTOCOL and state['source']==str(source) and state['recipe']==fixed and
            state['recipeHash']==digest(fixed),'Different series/recovery binding')
    else:
        folder.mkdir(parents=True,exist_ok=False)
        state=dict(protocol=PROTOCOL,source=str(source),recipe=fixed,recipeHash=digest(fixed),
            createdAtNs=time.time_ns(),rounds=[])
        atomic_json(folder/'series-state.json',state)
    def persist():
        atomic_json(folder/'series-state.json',state)
        report=summary(state);atomic_json(folder/'series-result.json',report);return report
    # Revalidate accepted courses on every restart, before any child launches.
    parent=source;reserved=set();parent_plan=read(source/'plan.json')
    for split in ('training','heldout'):reserved.update(t['semanticInputKey'] for t in parent_plan[split])
    stop=None
    for ordinal in range(1,ROUNDS+1):
        row=next((r for r in state['rounds'] if r['ordinal']==ordinal),None)
        if row and row['acceptedForContinuation']:
            _,plan=validate_complete(Path(row['folder']),parent,reserved)
            require(row['parentSource']==str(parent),'Changed accepted course parent')
            reserved.update(t['semanticInputKey'] for s in ('training','heldout') for t in plan[s])
            parent=Path(row['folder']);continue
        if time.monotonic()>=deadline:
            stop='series_time_budget';break
        recover=None
        if row:
            require(row['parentSource']==str(parent),'Changed partial course parent')
            old=Path(row['folder'])
            # A child may have committed complete evidence before the Notebook
            # stopped between return and harvesting. Adopt it without rerunning.
            if (old/'result.json').is_file() and read(old/'result.json').get('completeTrainingExperiment'):
                result,plan=validate_complete(old,parent,reserved)
                row.update(acceptedForContinuation=True,result=result,status={'recoveredCompletedReturn':True})
                persist();parent=old
                reserved.update(t['semanticInputKey'] for s in ('training','heldout') for t in plan[s])
                if on_round:on_round(row)
                continue
            if old.is_dir() and can_recover(old,parent):recover=old
            row['attempts'].append(dict(folder=str(old),result=row.get('result'),status=row.get('status')))
        else:
            row=dict(ordinal=ordinal,parentSource=str(parent),acceptedForContinuation=False,attempts=[])
            state['rounds'].append(row)
        out=work/('zip-management-geometry-'+uuid.uuid4().hex[:12])
        row.update(folder=str(out),recoverFrom=str(recover) if recover else None,result=None,status=None)
        persist()  # Journal the exact parent and output before spawning a child.
        status=None
        try:
            status=execute(parent,out,ordinal,recover,min(deadline,time.monotonic()+sum(PHASE_SECONDS.values())))
        except KeyboardInterrupt:
            status=dict(paused=True,exitCode=None)
        except Exception as exc:
            status=dict(paused=False,exitCode=None,error=type(exc).__name__+': '+str(exc))
        result=harvest(out,status) if out.is_dir() else dict(completeTrainingExperiment=False,
            error=status.get('error','Child returned before creating output'),actualStudentGenerations=0)
        row.update(status=status,result=result)
        if status.get('exitCode')==0 and result.get('completeTrainingExperiment'):
            try:
                result,plan=validate_complete(out,parent,reserved)
                row.update(acceptedForContinuation=True,result=result)
                parent=out;reserved.update(t['semanticInputKey'] for s in ('training','heldout') for t in plan[s])
            except Exception as exc:
                row['admissionError']=type(exc).__name__+': '+str(exc)
        persist()
        if on_round:on_round(row)
        if not row['acceptedForContinuation']:
            stop='paused' if status.get('paused') else 'incomplete';break
        if status.get('paused'):
            stop='paused';break
    state['stopReason']=stop or ('completed' if all(r['acceptedForContinuation'] for r in state['rounds'])
        and len(state['rounds'])==ROUNDS else 'incomplete')
    return persist()


def summary(state):
    complete=[r for r in state['rounds'] if r['acceptedForContinuation']]
    objects=[o for r in complete for o in r['result']['summary']['byObject']]
    for r in complete:
        require(r['result']['summary']['heldoutObjects']==8,'Missing completed frozen objects')
    # Partial counts are physical evidence in each current recovery copy, not
    # sums of repeated copies in the attempt archive.
    current=[r.get('result') or {} for r in state['rounds']]
    return dict(protocol=PROTOCOL,recipe=state['recipe'],requestedRounds=ROUNDS,
        attemptedRounds=len(state['rounds']),completedRounds=len(complete),
        completeFixedSeries=len(complete)==ROUNDS,stopReason=state.get('stopReason','in_progress'),
        lastCompleteCheckpoint=complete[-1]['folder'] if complete else state['source'],
        actualStudentGenerations=sum(r.get('actualStudentGenerations',0) for r in current),
        actualManagementHeadUpdates=sum(r.get('actualManagementHeadUpdates',0) for r in current),
        actualRawControlUpdates=sum(r.get('actualRawControlUpdates',0) for r in current),
        actualGlobalControlUpdates=sum(r.get('actualGlobalControlUpdates',0) for r in current),
        completedFrozenObjects=len(objects),allCompletedHeldoutSummary=summarize(objects),
        byRound=copy.deepcopy(state['rounds']),nextSourceChosenByHeldoutScore=False,
        comparisonsArePairedWithinEachRound=True,rawRoundMeansAreNotLearningCurve=True,
        roundsAreContinuationsNotIndependentReplications=True,independentTrainingReplications=0,
        mathematicalWriterUpdated=False,heldoutUsedForOptimization=False,
        statisticalSignificanceClaimed=False,overnightTrainingStarted=False)


def write_review(series_folder,destination):
    """Include completed and incomplete originals, excluding tensors/vectors."""
    series_folder=Path(series_folder);destination=Path(destination)
    state=read(series_folder/'series-state.json')
    temp=destination.with_name(destination.name+'.'+uuid.uuid4().hex+'.tmp')
    with zipfile.ZipFile(temp,'x',zipfile.ZIP_DEFLATED) as z:
        for name in ('series-state.json','series-result.json'):
            z.write(series_folder/name,name)
        for row in state['rounds']:
            folder=Path(row['folder'])
            if folder.is_dir():
                # Never repack inside a completed source: the next round binds
                # every source byte, including its original review archive.
                with tempfile.TemporaryDirectory(prefix='lain-series-review-') as d:
                    archive=Path(d)/'review.zip';review(folder,archive)
                    with zipfile.ZipFile(archive) as inner:
                        for name in inner.namelist():z.writestr('round-'+str(row['ordinal'])+'/'+name,inner.read(name))
    temp.replace(destination);return destination
