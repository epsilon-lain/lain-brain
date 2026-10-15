"""Replay a saved course using original outputs/features; no model calls."""
import copy
import math
from pathlib import Path
import time

from draft_inspect_runtime import read, sha, snapshot
from object_choice_core import normalized_features
from zip_label_grounded_checks import feature_messages
from zip_summary_training_v4_run import numeric_same, inspect_training_source as inspect_v4_source
from zip_label_metacognitive_source import inspect_source
from zip_summary_training_v5_core import *


def bounded_saved_equal(actual, expected):
    """Hash preimages must verify; only finite numerical reductions may vary."""
    if type(actual) is not type(expected):return False
    if isinstance(actual,dict):
        if set(actual)!=set(expected):return False
        seals={key for key,fields in (
            ('summaryHash',{'studentRaw','studentOriginal','audit'}),
            ('eventHash',{'task','observation','decision','routes'}),
            ('gateHash',{'evidence','minimumSimilarity','admitted'}),
            ('groupHash',{'candidateSummaryZipIds','candidatesPerEvent'})) if key in expected and fields<=set(expected)}
        for key in seals:
            if expected[key]!=digest({k:v for k,v in expected.items() if k!=key}):return False
        return all((key in seals) or
            bounded_saved_equal(actual[key],expected[key]) for key in actual)
    if isinstance(actual,(list,tuple)):
        return len(actual)==len(expected) and all(bounded_saved_equal(a,b) for a,b in zip(actual,expected))
    return numeric_same(actual,expected)


def replay_saved_course(folder, result, inherited, initial, final, features, raws, steps):
    """Derive decisions, audits, ranking, context gates and all reported credit."""
    folder=Path(folder);plan=read(folder/'zip-summary-questions.json');roots=read(folder/'roots.json')
    calls=[r for r in raws.values() if r['phase']!='cold_replay']
    calls.sort(key=lambda r:int(r['recordId'].rsplit('-',1)[1]))
    ordered_features=sorted(features.values(),key=lambda f:int(f['id'].rsplit('-',1)[1]))
    cursor=0;f_cursor=0;selected=BRANCHES[0];observed={};notes=copy.deepcopy(inherited)
    writer_states={b:initial['summaryStates'][b]['stateHash'] for b in BRANCHES}
    group_results={read(p)['id']:read(p) for p in (folder/'group-result').glob('*.json')}
    steps_by_group={s['sourceGroupId']:s for s in steps}
    require(len(steps_by_group)==len(steps),'Duplicate writing optimizer group')

    def select(b):
        nonlocal selected
        selected=b

    def ask(phase,messages,seed,*,mode,sampled=False,**context):
        nonlocal cursor
        require(cursor<len(calls),'Missing actual returned student original');row=calls[cursor];cursor+=1
        require(row['phase']==phase and row['studentPrompt']==messages and row['samplingSeed']==seed and
            all(row.get(k)==v for k,v in context.items()),'Original prompt, sequence, seed or context changed')
        value=row['studentOutput']
        require(value['sampled'] is sampled and value['generationMode']==mode and
            value['summaryStateHashDuringGeneration']==writer_states[selected] and
            value['summaryAdapterEnabledDuringGeneration']==(mode=='summary') and
            value['semanticAdapterEnabledDuringGeneration'] is False and
            value['mathAdapterEnabledDuringGeneration']==(mode=='math'), 'Generation used another writer or adapter route')
        return copy.deepcopy(row)

    def feature(task,row,cards):
        nonlocal f_cursor
        require(f_cursor<len(ordered_features),'Missing actual feature batch');f=ordered_features[f_cursor];f_cursor+=1
        require(f['task']==task and f['sourceObservationRecordId']==row['recordId'] and f['candidateCards']==cards and
            f['candidatePrompts']==[feature_messages(task,row['studentOutput'],c) for c in cards] and
            numeric_same(f['normalizedFeatures'],normalized_features(f['candidateHiddenVectors'])) and
            all(f[k] is False for k in ('mathematicalAdapterEnabled','semanticAdapterEnabled','summaryAdapterEnabled')),
            'Feature preimage, original observation or candidate context changed')
        return copy.deepcopy(f['normalizedFeatures']),f['id']

    def save(kind,row):
        path=folder/'responses'/(row['recordId']+'-scored.json') if kind=='scored' else folder/kind/(row['id']+'.json')
        expected=read(path)
        # Floating reductions may differ by <=1e-12; hashes are exact preimages
        # of those saved numbers, not a tolerance for arbitrary text changes.
        compared=copy.deepcopy(row)
        if kind=='update':
            require(numeric_same(row['headUpdate']['afterState']['weights'],expected['headUpdate']['afterState']['weights']),
                'Replayed selector parameters changed')
            compared['headUpdate']['afterState']['parameterHash']=expected['headUpdate']['afterState']['parameterHash']
            compared['headUpdate']['afterHash']=expected['headUpdate']['afterHash']
        if kind in ('summary','summary-group','context-gate'):
            field={'summary':'summaryHash','summary-group':'groupHash','context-gate':'gateHash'}[kind]
            require(expected[field]==digest({k:v for k,v in expected.items() if k!=field}), 'Saved hash preimage changed')
            compared[field]=expected[field]
        require(bounded_saved_equal(compared,expected),'Saved '+kind+' cannot be reproduced from original evidence')
        observed.setdefault(kind,[]).append(copy.deepcopy(expected))
        row.clear();row.update(copy.deepcopy(expected))

    def learn(group_notes,credit,reason):
        require(reason=='candidate_group_feedback' and credit['branch']==selected and
            bounded_saved_equal(group_credit(make_group(group_notes),group_notes,{n['id']:credit['candidateCredits'][n['id']]['measurements'] for n in group_notes}),credit),
            'Saved writing credit changed')
        gid=credit['groupId'];saved=group_results[gid]['summaryUpdate'];nonzero=any(abs(v)>1e-12 for v in credit['batchAdvantages'])
        require(saved['updated'] is nonzero,'A zero-credit or missing optimizer step was claimed')
        require(saved['sourceGroupId']==gid and bounded_saved_equal(saved['credit'],credit) and
            saved['beforeHash']==writer_states[selected], 'Returned writing result belongs to another group or policy')
        if nonzero:
            step=steps_by_group.get(gid);require(step is not None,'Real optimizer step file missing')
            require(numeric_same(step['credit'],credit) and step['sourceSummaryZipIds']==[n['id'] for n in group_notes] and
                step['sourceWordRecordIds']==[n['sourceRecordId'] for n in group_notes] and
                step['branch']==selected and step['beforeHash']==writer_states[selected] and
                all(n['studentOriginal']['studentOutput']['summaryStateHashDuringGeneration']==step['beforeHash'] for n in group_notes),
                'Optimizer was attributed to another original, branch, credit or policy')
            policy=step['policyUpdate']
            require(policy['updated'] is True and numeric_same(policy['advantages'],credit['batchAdvantages']) and
                policy['constantTokenDenominator']==CANDIDATES_PER_EVENT*MAX_TOKENS and
                policy['allSampledTokensReplayed'] is True and
                numeric_same(policy['sampledLogProbabilities'],[n['studentOriginal']['studentOutput']['samplingLogProbability'] for n in group_notes]) and
                len(policy['replayLogProbabilities'])==CANDIDATES_PER_EVENT and
                all(math.isfinite(v) for v in policy['replayLogProbabilities']) and
                all(abs(v-n['studentOriginal']['studentOutput']['samplingLogProbability'])<=.08*n['studentOriginal']['studentOutput']['generatedTokens']
                    for v,n in zip(policy['replayLogProbabilities'],group_notes)), 'Writing trajectory weights or replay logs changed')
            require(saved['beforeHash']==step['beforeHash'] and saved['afterHash']==step['afterHash'] and
                numeric_same(saved['credit'],credit), 'Returned writing update differs from its saved step')
            writer_states[selected]=step['afterHash']
        else:require(gid not in steps_by_group,'Zero credit created a checkpoint step')
        require(saved['afterHash']==writer_states[selected],'Returned writer state does not follow committed updates')
        return copy.deepcopy(saved)

    def store(note):
        require(notes.get(note['id'])==note,'Native ZIP lost a whole student original')

    def load(identifier):
        require(identifier in notes,'Unregistered summary context');return copy.deepcopy(notes[identifier])

    def checkpoint(label,heads,banks,gates):
        saved=read(folder/'checkpoints'/(label+'.json'))
        require(numeric_same(heads,saved['heads']) and banks==saved['banks'] and
            {b:writer_states[b] for b in BRANCHES}=={b:saved['summaryStates'][b]['stateHash'] for b in BRANCHES} and
            {b:gates[b]['gateHash'] if gates[b] else None for b in BRANCHES}==saved['contextGateHashes'],
            'Checkpoint, context or writer transitions cannot be replayed')
        if 'contextGates' in saved:require(numeric_same(gates,saved['contextGates']), 'Frozen gate state changed')

    course=run_course(plan,roots,initial['heads'],ask,feature,save,learn,select,store,load,checkpoint,
        time.monotonic()+120,result['trainingRound'],initial['banks'],initial['contextGates'])
    require(cursor==len(calls) and f_cursor==len(features),'Unbound actual student generation or feature')
    require(numeric_same(course['finalHeads'],final['heads']) and course['finalBanks']==final['banks'] and
        numeric_same(course['finalGates'],final['contextGates']),'Final learned state changed')
    for kind in ('object','update','trial','summary','summary-group','group-result','summary-rating','zip-reference',
            'context-gate','summary-context-review','group-measurement','context-choice'):
        expected=len(list((folder/kind).glob('*.json')))
        require(len(observed.get(kind,[]))==expected,'Unbound or duplicate '+kind+' record')
    rebuilt=summarize(observed.get('object',[]),observed.get('trial',[]),observed.get('summary',[]),
        observed.get('update',[]),observed.get('group-result',[]),observed.get('summary-rating',[]),
        observed.get('zip-reference',[]),observed.get('summary-context-review',[]))
    require(numeric_same(rebuilt,result['summary']),'Saved report differs from original paired measurements')
    return course


def inspect_training_source(folder):
    folder=Path(folder).resolve();result=read(folder/'result.json')
    require(result.get('fixtureOnly') is False and not result.get('fixtureGenerations') and not result.get('teacherCalls') and
        not result.get('offlineFixtureFactory'), 'Fixture or teacher-backed source rejected before model import')
    if result.get('protocol')!=PROTOCOL:
        old=inspect_v4_source(folder)
        # A new gate protocol requires TRAIN evidence for its context decisions.
        # Archive old context without changing any old score or writer state.
        old['initialGates']={b:None for b in BRANCHES}
        for b,identifier in old['initialBanks'].items():
            if identifier:
                old['inheritedContextReviews'][b]=dict(summaryZipId=identifier,retainedForNewTaskContext=False,
                    currentContextAudit=audit_summary(old['inherited'][identifier]['studentOriginal']['studentOutput'],old['inherited'][identifier]['event']),
                    reason='prior_context_has_no_v5_training_gate',oldScoresChanged=False,oldSampledTrajectoryNotTrainedAgain=True)
        old['initialBanks']={b:None for b in BRANCHES}
        return old
    require(result['stopReason']=='completed' and result['error'] is None and result['completeTrainingExperiment'] is True and
        result['completedTrainingObjects']==TRAINING_OBJECTS and result['completedHeldoutObjects']==HELDOUT_OBJECTS and
        result['coldReproductions']==8 and result['heldoutLearnedStateUnchanged'] is True and
        all(result[k] is True for k in ('baseWeightsUnchanged','mathematicalWriterUnchanged','originalSemanticWriterUnchanged','originalFilesUnchanged')),
        'Only a complete real frozen-checked v5 run may resume')
    manifest=read(folder/'run-file-manifest.json')['files'];actual=snapshot(folder)
    require(all(actual.get(k)==v for k,v in manifest.items()) and set(actual)-set(manifest)<=
        {'run-file-manifest.json','result.json','Lain-Zip-Summary-Training-Results.zip','Lain-Zip-Summary-Training-Review.zip'},
        'Source originals or checkpoint bytes changed')
    base=inspect_source(folder/'foundation-originals');source_cp=read(folder/'source-checkpoint.json')
    require(source_cp['baseStateHash']==base['result']['baseStateBefore'] and
        source_cp['mathematicalWriterStateHash']==base['result']['mathematicalWriterStateHash'], 'Different frozen foundation')
    bank=read(folder/'summary-zip-bank.json');notes={}
    from zip_summary_training_v5_run import read_summary_zip
    for identifier in bank['zipByteHashes']:notes[identifier]=read_summary_zip(folder/'summary-zips',identifier,bank['zipByteHashes'])
    initial=read(folder/'checkpoints/initial.json');final=read(folder/'checkpoints/final.json')
    require(final['heads']==result['finalHeads'] and final['banks']==result['finalBanks']==bank['activeByBranch'] and
        final['contextGates']==result['finalGates']==bank['contextGates'], 'Final heads, bank or gates differ')
    for cp in (initial,final):
        for b in BRANCHES:
            restore_head(cp['heads'][b]);state=cp['summaryStates'][b]
            require(Path(state['file']).name==state['file'] and sha(folder/'checkpoints'/state['file'])==state['fileSha256'], 'Writer checkpoint changed')
            if cp['banks'][b]:validate_gate(cp['contextGates'][b],notes[cp['banks'][b]])
            else:require(cp['contextGates'][b] is None,'Inactive bank carries an active gate')
    raws={read(p)['recordId']:read(p) for p in (folder/'responses').glob('*-raw.json')}
    require(len(raws)==result['actualStudentGenerations']<=MAX_GENERATIONS, 'Returned student count changed')
    for row in raws.values():
        value=row['studentOutput'];scored=read(folder/'responses'/(row['recordId']+'-scored.json'))
        require(row['fixtureOnly'] is False and not value.get('testDouble') and not row.get('offlineFixtureFactory') and
            all(scored.get(k)==v for k,v in row.items()) and
            0<value['generatedTokens']==len(value['generatedIds'])==len(value['samplingTokenLogProbabilities'])<=MAX_TOKENS and
            all(type(t) is int and t>=0 for t in value['generatedIds']) and
            all(math.isfinite(p) for p in value['samplingTokenLogProbabilities']) and
            abs(sum(value['samplingTokenLogProbabilities'])-value['samplingLogProbability'])<=1e-10 and
            value['originalTextRepaired'] is False,'Original text, token logs or provenance changed')
    cold=[r for r in raws.values() if r['phase']=='cold_replay']
    require(len(cold)==8 and all(read(folder/'responses'/(r['recordId']+'-scored.json'))['check']['exactReproduction']['exact'] for r in cold),
        'Incomplete cold reproductions')
    features={read(p)['id']:read(p) for p in (folder/'feature').glob('*.json')}
    require(len(features)==result['featureForwardBatches']<=MAX_FEATURE_BATCHES,'Feature count changed')
    steps=[read(p) for p in (folder/'summary-step').glob('*.json')]
    require(len(steps)==result['summaryOptimizerUpdates']<=2*GROUPS_PER_BRANCH,'Optimizer step count changed')
    for step in steps:
        require(Path(step['file']).name==step['file'] and sha(folder/'checkpoints'/step['file'])==step['fileSha256'], 'Optimizer checkpoint changed')
    course=replay_saved_course(folder,result,notes,initial,final,features,raws,steps)
    require(result['trainingUpdates']==len(steps)+sum(u['headUpdate']['updated'] for u in course['updates']) and
        result['studentWrittenSummaryZips']==len(course['summaries'])==2*SUMMARIES_PER_BRANCH and
        result['usableSummaryZips']==sum(n['audit']['eligibleForTrial'] for n in course['summaries']) and
        result['retainedActiveSummaryZips']==sum(bool(v) for v in final['banks'].values()), 'Final counters changed')
    return dict(base=base,parent=folder,parentHashes=actual,initialHeads=final['heads'],initialBanks=final['banks'],initialGates=final['contextGates'],
        summaryFiles={b:folder/'checkpoints'/final['summaryStates'][b]['file'] for b in BRANCHES},
        summaryStateHashes={b:final['summaryStates'][b]['stateHash'] for b in BRANCHES},inherited=notes,
        inheritedContextReviews={b:dict(summaryZipId=final['banks'][b],retainedForNewTaskContext=True,
            reason='retained_prior_v5_training_gate',oldScoresChanged=False) for b in BRANCHES if final['banks'][b]})
