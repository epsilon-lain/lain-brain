"""Bind source originals, TRAIN-only histories and recorded optimizer transitions."""
import copy
import json
import math
from pathlib import Path
import time
from draft_inspect_runtime import read,sha,snapshot
from object_choice_core import normalized_features
from zip_label_grounded_checks import feature_messages
from zip_summary_training_v4_run import numeric_same
from zip_summary_training_v7_inspect import inspect_training_source as inspect_previous_source
from zip_summary_training_v8_core import *
from zip_summary_training_v8_policy import token_limit


def migrate(previous,folder):
    entries=[];notes=previous['inherited']
    gate=previous['initialGates'][A]
    if gate:
        for e in gate['entries']:
            entries.append(seal(dict(summaryZipId=e['summaryZipId'],branch=A,head=copy.deepcopy(e['readerTraining']['heads']['note']),
                scopeShapes=copy.deepcopy(e['readerTraining']['scopeShapes']),sourceTaskId=notes[e['summaryZipId']]['sourceTaskId'],
                generation=0,trainingGain=e['trainingMeanGain'],originEntryHash=e['gateHash'],
                originReaderHash=e['readerTraining']['readerHash']),'entryHash'))
    initial=dict(entries=entries,history=[],statuses={e['summaryZipId']:'available' for e in entries},head=copy.deepcopy(previous['initialHeads'][A]))
    trials={r['taskId']:r for p in (folder/'trial').glob('*.json') if
        (r:=read(p))['phase']=='training' and r['arm']==A}
    # Read ONLY parent TRAIN observations. Rescore those verified originals
    # with the current frozen heads; old historical scores remain untouched.
    for path in sorted((folder/'object').glob('*.json')):
        obj=read(path)
        if obj['phase']!='training':continue
        identifier=obj['sourceSummaryIdsByArm'].get(A)
        entry=next((e for e in entries if e['summaryZipId']==identifier),None)
        if entry is None:continue
        pfid=obj['featureIdsByArm'][BRANCHES[1]];nfid=obj['featureIdsByArm'][A]
        plain=read(folder/'feature'/(pfid+'.json'));noted=read(folder/'feature'/(nfid+'.json'))
        outcomes=obj['routeOutcomes']
        use=expected_pass(restore_head(entry['head']),noted['normalizedFeatures'],outcomes)[0]
        skip=expected_pass(restore_head(initial['head']),plain['normalizedFeatures'],outcomes)[0]
        selected=read(folder/'responses'/(trials[obj['id']]['sourceMathRecordId']+'-scored.json'))
        hr=history_record(obj['task'],notes[identifier],'USE',use,skip,outcomes,obj['sourceMathRecordIds'],
            dict(without=pfid,withSummary=nfid),dict(without=plain['sourceObservationRecordId'],withSummary=noted['sourceObservationRecordId']),
            origin='parent_TRAIN_originals_rescored_under_frozen_start_heads',selected_route=selected)
        initial['history'].append(hr)
    validate_entries(entries,notes);validate_history(initial['history'])
    return initial


def replay_saved_course(folder,result,notes,initial,initial_cp,features,raws,steps):
    folder=Path(folder);plan=read(folder/'zip-summary-questions.json');roots=read(folder/'roots.json')
    calls=sorted((r for r in raws.values() if r['phase']!='cold_replay'),key=lambda r:int(r['recordId'].rsplit('-',1)[1]))
    ff=sorted(features.values(),key=lambda f:int(f['id'].rsplit('-',1)[1]));cursor=f_cursor=0
    states=dict(summary=initial_cp['summaryState']['stateHash'],management=initial_cp['managementState']['stateHash'])
    initial_management=states['management'];known=copy.deepcopy(notes);observed={};used_steps=set()
    step_by_records={(s['parameterKind'],tuple(s['sourceRecordIds'])):s for s in steps}
    require(len(step_by_records)==len(steps),'Duplicate optimizer attribution')
    def ask(phase,messages,seed,*,mode,sampled=False,**context):
        nonlocal cursor
        require(cursor<len(calls),'Missing student original');r=calls[cursor];cursor+=1;v=r['studentOutput']
        require(r['phase']==phase and r['studentPrompt']==messages and r['samplingSeed']==seed and
            all(r.get(k)==value for k,value in context.items()) and v['sampled'] is sampled and v['generationMode']==mode and
            v['summaryStateHashDuringGeneration']==states['summary'] and
            v['managementStateHashDuringGeneration']==(initial_management if context.get('frozenInitialManagement') else states['management']) and
            v['summaryAdapterEnabledDuringGeneration']==(mode=='summary') and
            v['managementAdapterEnabledDuringGeneration']==(mode=='management') and
            v['mathAdapterEnabledDuringGeneration']==(mode=='math') and v['semanticAdapterEnabledDuringGeneration'] is False,
            'Prompt, management history, action route or policy changed')
        return copy.deepcopy(r)
    def feature(task,row,cards):
        nonlocal f_cursor
        require(f_cursor<len(ff),'Missing frozen feature batch');f=ff[f_cursor];f_cursor+=1
        require(f['task']==task and f['sourceObservationRecordId']==row['recordId'] and f['candidateCards']==cards and
            f['candidatePrompts']==[feature_messages(task,row['studentOutput'],c) for c in cards] and
            numeric_same(f['normalizedFeatures'],normalized_features(f['candidateHiddenVectors'])) and
            all(f[k] is False for k in ('mathematicalAdapterEnabled','semanticAdapterEnabled','summaryAdapterEnabled','managementAdapterEnabled')),
            'Frozen feature original or adapter route changed')
        return copy.deepcopy(f['normalizedFeatures']),f['id']
    def save(kind,row):
        path=folder/'responses'/(row['recordId']+'-scored.json') if kind=='scored' else folder/kind/(row['id']+'.json')
        expected=read(path)
        require(numeric_same(row,expected),'Saved '+kind+' changed under original-data replay')
        observed.setdefault(kind,[]).append(copy.deepcopy(expected));row.clear();row.update(copy.deepcopy(expected))
    def learn(kind,rows,advantages,evidence):
        filename='management-feedback' if kind=='management' else 'revision-feedback'
        saved=read(folder/filename/(evidence['id']+'.json'))['policyUpdate'];key=(kind,tuple(r['recordId'] for r in rows))
        require(saved['beforeHash']==states[kind] and saved['parameterKind']==kind and saved['sourceRecordIds']==list(key[1]),'Wrong optimizer policy/source')
        nonzero=any(abs(a)>1e-12 for a in advantages)
        require(saved['updated'] is nonzero,'Unrecorded/zero-credit optimizer transition')
        if nonzero:
            step=step_by_records.get(key);require(step is not None,'Real optimizer checkpoint step missing')
            require(numeric_same(step['advantages'],advantages) and numeric_same(step['evidence'],evidence) and
                step['beforeHash']==states[kind] and step['afterHash']==saved['afterHash'],'Changed feedback or step attribution')
            policy=step['policyUpdate'];values=[r['studentOutput'] for r in rows]
            require(policy['updated'] is True and policy['allSampledTokensReplayed'] is True and
                policy['constantTokenDenominator']==len(rows)*128 and numeric_same(policy['advantages'],advantages) and
                numeric_same(policy['sampledLogProbabilities'],[v['samplingLogProbability'] for v in values]) and
                len(policy['replayLogProbabilities'])==len(rows) and
                all(math.isfinite(lp) and abs(lp-v['samplingLogProbability'])<=.08*v['generatedTokens'] for lp,v in zip(policy['replayLogProbabilities'],values)),
                'Wrong sampled-token budget or policy replay logs')
            states[kind]=step['afterHash'];used_steps.add(key)
        else:require(key not in step_by_records and saved['afterHash']==states[kind],'Zero credit changed weights')
        return copy.deepcopy(saved)
    def load(i):require(i in known,'Unknown native ZIP');return copy.deepcopy(known[i])
    def store(n):require(known.get(n['id'])==n,'Changed or fabricated revised original')
    def checkpoint(label,entries,history,statuses):
        cp=read(folder/'checkpoints'/(label+'.json'))
        require(cp['entriesHash']==digest(entries) and cp['historiesHash']==digest(history) and cp['statusesHash']==digest(statuses) and
            cp['head']==initial['head'] and cp['summaryState']['stateHash']==states['summary'] and
            cp['managementState']['stateHash']==states['management'],'Frozen head, ledger, status or parameters changed')
    course=run_course(plan,roots,initial,ask,feature,save,learn,load,store,checkpoint,time.monotonic()+120,result['trainingRound'])
    require(cursor==len(calls) and f_cursor==len(features) and used_steps==set(step_by_records),'Unbound original, feature or optimizer')
    for kind in ('scored','object','decision','trial','management-choice','management-feedback','reuse-history','summary','revision-measurement','revision-feedback'):
        expected=len(list((folder/'responses').glob('*-scored.json'))) if kind=='scored' else len(list((folder/kind).glob('*.json')))
        # Cold originals are checked separately before new-task replay.
        if kind=='scored':expected-=sum(r['phase']=='cold_replay' for r in raws.values())
        require(len(observed.get(kind,[]))==expected,'Unbound '+kind+' record')
    require(numeric_same(summarize(course),result['summary']),'Reported management metric changed')
    return course


def inspect_training_source(folder):
    folder=Path(folder).resolve();result=read(folder/'result.json')
    require(result.get('fixtureOnly') is False and not result.get('fixtureGenerations') and not result.get('teacherCalls') and
        not result.get('offlineFixtureFactory'),'Fixture/teacher source rejected before model import')
    if result.get('protocol')!=PROTOCOL:
        previous=inspect_previous_source(folder);previous['managementInitial']=migrate(previous,folder)
        previous.update(managementFile=None,managementHash=None)
        return previous
    from zip_summary_training_v8_entry import validate_completed
    validate_completed(result)
    manifest=read(folder/'run-file-manifest.json')['files'];actual=snapshot(folder)
    require(all(actual.get(k)==v for k,v in manifest.items()) and set(actual)-set(manifest)<=
        {'result.json','run-file-manifest.json','Lain-Zip-Memory-Management-Review.zip'},'Source originals/checkpoints changed')
    from zip_label_metacognitive_source import inspect_source
    from zip_summary_training_v8_run import read_summary_zip
    base=inspect_source(folder/'foundation-originals');source_cp=read(folder/'source-checkpoint.json')
    require(source_cp['baseStateHash']==base['result']['baseStateBefore'] and
        source_cp['mathematicalWriterStateHash']==base['result']['mathematicalWriterStateHash'],'Different frozen foundation')
    bank=read(folder/'memory-bank.json');notes={i:read_summary_zip(folder/'summary-zips',i,bank['zipByteHashes']) for i in bank['zipByteHashes']}
    initial=read(folder/'management-initial.json');first=read(folder/'checkpoints/initial.json');last=read(folder/'checkpoints/final.json')
    for path in (folder/'checkpoints').glob('*.json'):
        cp=read(path)
        for state in (cp['summaryState'],cp['managementState'],cp['frozenSealState']):
            require(Path(state['file']).name==state['file'] and sha(folder/'checkpoints'/state['file'])==state['fileSha256'],'Adapter checkpoint bytes changed')
    raws={r['recordId']:r for p in (folder/'responses').glob('*-raw.json') if (r:=read(p))}
    require(len(raws)==result['actualStudentGenerations']<=MAX_GENERATIONS,'Student count changed')
    for row in raws.values():
        v=row['studentOutput'];scored=read(folder/'responses'/(row['recordId']+'-scored.json'))
        require(row['fixtureOnly'] is False and not v.get('testDouble') and not row.get('offlineFixtureFactory') and
            all(scored.get(k)==value for k,value in row.items()) and
            0<v['generatedTokens']==len(v['generatedIds'])==len(v['samplingTokenLogProbabilities'])<=token_limit(row['phase']) and
            v['responseTokenLimit']==token_limit(row['phase']) and v['originalTextRepaired'] is False and
            all(type(i) is int and i>=0 for i in v['generatedIds']) and all(math.isfinite(lp) for lp in v['samplingTokenLogProbabilities']) and
            abs(sum(v['samplingTokenLogProbabilities'])-v['samplingLogProbability'])<=1e-10,'Raw original/stop/logs/provenance changed')
    cold=[r for r in raws.values() if r['phase']=='cold_replay']
    require(len(cold)==8 and all(read(folder/'responses'/(r['recordId']+'-scored.json'))['check']['exactReproduction']['exact'] for r in cold),'Cold originals not reproduced')
    features={r['id']:r for p in (folder/'feature').glob('*.json') if (r:=read(p))}
    require(len(features)==result['featureForwardBatches']<=MAX_FEATURE_BATCHES,'Feature count changed')
    steps=[read(p) for kind in ('summary-step','management-step') for p in (folder/kind).glob('*.json')]
    for step in steps:require(Path(step['file']).name==step['file'] and sha(folder/'checkpoints'/step['file'])==step['fileSha256'],'Optimizer file changed')
    require(sum(s['parameterKind']=='summary' for s in steps)==result['summaryOptimizerUpdates']<=2 and
        sum(s['parameterKind']=='management' for s in steps)==result['managementOptimizerUpdates']<=8 and
        result['trainingUpdates']==len(steps) and result['choiceHeadTrainingUpdates']==0,'Optimizer counts changed')
    course=replay_saved_course(folder,result,notes,initial,first,features,raws,steps)
    require(course['entries']==bank['entries'] and course['history']==bank['history'] and course['statuses']==bank['statuses'] and
        last['head']==initial['head']==bank['head'] and
        result['studentWrittenSummaryZips']==len(course['revisions'])==6,'Final memory/history/frozen head counters changed')
    return dict(base=base,parent=folder,parentHashes=actual,inherited=notes,
        managementInitial=dict(entries=bank['entries'],history=bank['history'],statuses=bank['statuses'],head=bank['head']),
        summaryFiles={A:folder/'checkpoints'/last['summaryState']['file'],BRANCHES[1]:folder/'checkpoints'/last['frozenSealState']['file']},
        summaryStateHashes={A:last['summaryState']['stateHash'],BRANCHES[1]:last['frozenSealState']['stateHash']},
        managementFile=folder/'checkpoints'/last['managementState']['file'],managementHash=last['managementState']['stateHash'])
