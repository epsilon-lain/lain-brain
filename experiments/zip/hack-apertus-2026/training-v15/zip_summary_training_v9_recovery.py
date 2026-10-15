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
from zip_summary_training_v9_core import run_course
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



def record_task_id(row):
    return row.get('task',{}).get('id') or row.get('taskId') or row.get('sourceTaskId')

def replay_saved_course(folder,result,notes,initial,initial_cp,features,raws,steps,training_only=False,tail=None):
    folder=Path(folder);plan=read(folder/'zip-summary-questions.json');roots=read(folder/'roots.json')
    calls=sorted((r for r in raws.values() if r['phase']!='cold_replay'),key=lambda r:int(r['recordId'].rsplit('-',1)[1]))
    ff=sorted(features.values(),key=lambda f:int(f['id'].rsplit('-',1)[1]));cursor=f_cursor=0
    states=dict(summary=initial_cp['summaryState']['stateHash'],management=initial_cp['managementState']['stateHash'])
    initial_management=states['management'];known=copy.deepcopy(notes);observed={};used_steps=set()
    step_by_records={(s['parameterKind'],tuple(s['sourceRecordIds'])):s for s in steps}
    require(len(step_by_records)==len(steps),'Duplicate optimizer attribution')
    def ask(phase,messages,seed,*,mode,sampled=False,**context):
        nonlocal cursor
        if cursor==len(calls) and tail is not None:
            return tail['ask'](phase,messages,seed,mode=mode,sampled=sampled,**context)
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
        if f_cursor==len(ff) and tail is not None:return tail['feature'](task,row,cards)
        require(f_cursor<len(ff),'Missing frozen feature batch');f=ff[f_cursor];f_cursor+=1
        require(f['task']==task and f['sourceObservationRecordId']==row['recordId'] and f['candidateCards']==cards and
            f['candidatePrompts']==[feature_messages(task,row['studentOutput'],c) for c in cards] and
            numeric_same(f['normalizedFeatures'],normalized_features(f['candidateHiddenVectors'])) and
            all(f[k] is False for k in ('mathematicalAdapterEnabled','semanticAdapterEnabled','summaryAdapterEnabled','managementAdapterEnabled')),
            'Frozen feature original or adapter route changed')
        return copy.deepcopy(f['normalizedFeatures']),f['id']
    def save(kind,row):
        path=folder/'responses'/(row['recordId']+'-scored.json') if kind=='scored' else folder/kind/(row['id']+'.json')
        if not path.is_file() and tail is not None:
            tail['save'](kind,row);observed.setdefault(kind,[]).append(copy.deepcopy(row));return
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
        path=folder/'checkpoints'/(label+'.json')
        if training_only and label=='training-final' and not path.is_file():
            path=folder/'checkpoints/after-8.json'
        if not path.is_file() and tail is not None:return tail['checkpoint'](label,entries,history,statuses)
        cp=read(path)
        require(cp['entriesHash']==digest(entries) and cp['historiesHash']==digest(history) and cp['statusesHash']==digest(statuses) and
            cp['head']==initial['head'] and cp['summaryState']['stateHash']==states['summary'] and
            cp['managementState']['stateHash']==states['management'],'Frozen head, ledger, status or parameters changed')
    course=run_course(plan,roots,initial,ask,feature,save,learn,load,store,checkpoint,(tail['deadline'] if tail is not None else time.monotonic()+120),result['trainingRound'],training_only=training_only)
    require(cursor==len(calls) and f_cursor==len(features) and used_steps==set(step_by_records),'Unbound original, feature or optimizer')
    for kind in ('scored','object','decision','trial','management-choice','management-feedback','reuse-history','summary','revision-measurement','revision-feedback'):
        paths=list((folder/'responses').glob('*-scored.json')) if kind=='scored' else list((folder/kind).glob('*.json'))
        records=[read(p) for p in paths]
        records=[r for r in records if r.get('phase')!='cold_replay']
        if training_only:
            train_ids={t['id'] for t in plan['training']}
            records=[r for r in records if record_task_id(r) in train_ids]
        expected=len(records)
        require(len(observed.get(kind,[]))==expected,'Unbound '+kind+' record')
    if not training_only and tail is None:
        require(numeric_same(summarize(course),result['summary']),'Reported management metric changed')
    return course


def verify_state_files(folder, checkpoint):
    for kind in ('summaryState','managementState','frozenSealState'):
        state=checkpoint[kind]
        require(type(state['file']) is str and Path(state['file']).name==state['file'] and
            sha(folder/'checkpoints'/state['file'])==state['fileSha256'],
            'Missing/changed committed checkpoint: '+kind)


def clone_evidence(source, output):
    """Copy originals into a new append-only recovery folder; never overwrite source."""
    import shutil
    source=Path(source).resolve();output=Path(output).resolve()
    require(not output.exists() and not output.is_relative_to(source) and
        not source.is_relative_to(output),'Recovery output overlaps originals')
    output.mkdir()
    skipped={'result.json','error.json','run-file-manifest.json','memory-bank.json',
        'partial-result.json','training-bank-receipt.json','recovery.json',
        'Lain-Zip-Memory-Management-Review.zip'}
    for path in sorted(source.rglob('*')):
        require(not path.is_symlink(),'Symlink in recovery source')
        if not path.is_file():continue
        rel=path.relative_to(source)
        if len(rel.parts)==1 and path.name in skipped:
            rel=Path('recovery-original-metadata')/source.name/rel
        target=output/rel;target.parent.mkdir(parents=True,exist_ok=True)
        # Filesystem reflinks are not assumed. Copy independently so later
        # replacements cannot change an original inode.
        require(not target.exists(),'Recovery archive filename collision')
        shutil.copyfile(path,target)


def inspect_interrupted_course(folder):
    """Admit a COMPLETE TRAIN phase by exact saved-algorithm replay, not log counts."""
    import zipfile
    from zip_summary_training_v8_inspect import inspect_training_source
    from zip_summary_training_v8_run import read_summary_zip
    folder=Path(folder).resolve()
    protocol=read(folder/'protocol.json')
    require(protocol.get('protocol')==PROTOCOL and protocol.get('teacherCalls')==0 and
        not protocol.get('fixtureOnly') and not protocol.get('offlineFixtureFactory'),
        'Recovery requires the original real management course')
    raws={r['recordId']:r for p in sorted((folder/'responses').glob('*-raw.json')) if (r:=read(p))}
    require(0<len(raws)<=MAX_GENERATIONS and len(raws)==len(list((folder/'responses').glob('*-raw.json'))),
        'Missing/duplicate student originals')
    for row in raws.values():
        value=row['studentOutput']
        require(row.get('fixtureOnly') is False and not row.get('offlineFixtureFactory') and
            not value.get('testDouble') and value.get('originalTextRepaired') is False and
            0<value['generatedTokens']==len(value['generatedIds'])==len(value['samplingTokenLogProbabilities'])<=token_limit(row['phase']) and
            value['responseTokenLimit']==token_limit(row['phase']) and
            all(type(i) is int and i>=0 for i in value['generatedIds']) and
            all(math.isfinite(lp) for lp in value['samplingTokenLogProbabilities']) and
            abs(sum(value['samplingTokenLogProbabilities'])-value['samplingLogProbability'])<=1e-10,
            'Fixture/changed raw token provenance rejected before model import')
    require([int(r['recordId'].rsplit('-',1)[1]) for r in raws.values()]==list(range(1,len(raws)+1)),
        'Returned call prefix is not contiguous')
    source=read(folder/'source-checkpoint.json');parent=Path(source['parentSource']).resolve()
    require(parent!=folder and sha(parent/'result.json')==source['parentResultSha256'],
        'Recovery parent checkpoint changed')
    previous=inspect_training_source(parent)
    foundation=previous['base'];fp=Path(foundation['folder'])
    require(read(folder/'roots.json')==foundation['bank']['mathematicalRoots'] and
        source['baseStateHash']==foundation['result']['baseStateBefore'] and
        source['mathematicalWriterStateHash']==foundation['result']['mathematicalWriterStateHash'],
        'Changed frozen foundation or roots')
    # Foundation copies are still independently checked against their original
    # manifest, including files not used by the live evaluation.
    for name,expected in foundation['sourceHashes'].items():
        if Path(name).suffix=='.zip':continue
        require(sha(folder/'foundation-originals'/name)==expected,'Changed exported foundation original: '+name)
    initial=read(folder/'management-initial.json')
    require(initial==previous['managementInitial'],'Changed start head, histories or note catalogue')
    first=read(folder/'checkpoints/initial.json')
    last_path=folder/'checkpoints/training-final.json'
    if not last_path.is_file():last_path=folder/'checkpoints/after-8.json'
    last=read(last_path)
    require(first['summaryState']['stateHash']==previous['summaryStateHashes'][A] and
        first['frozenSealState']['stateHash']==previous['summaryStateHashes'][BRANCHES[1]],
        'Changed initial summary writer or frozen seal')
    if previous.get('managementHash'):
        require(first['managementState']['stateHash']==previous['managementHash'],'Changed initial manager')
    for cp in (first,last,*(read(p) for p in (folder/'checkpoints').glob('after-*.json'))):
        verify_state_files(folder,cp)
        require(cp['baseStateHash']==source['baseStateHash'] and
            cp['mathematicalWriterStateHash']==source['mathematicalWriterStateHash'] and
            cp['originalSemanticStateHash']==foundation['final']['semanticStateHash'],
            'Wrong frozen parameter guards in training checkpoint')
    hashes={p.stem:sha(p) for p in (folder/'summary-zips').glob('*.zip')}
    notes={i:read_summary_zip(folder/'summary-zips',i,hashes) for i in hashes}
    require(all(notes.get(i)==n for i,n in previous['inherited'].items()),'Inherited note original changed')
    features={r['id']:r for p in (folder/'feature').glob('*.json') if (r:=read(p))}
    require(len(features)<=MAX_FEATURE_BATCHES,'Feature budget changed')
    steps=[read(p) for kind in ('management-step','summary-step') for p in (folder/kind).glob('*.json')]
    for step in steps:
        require(Path(step['file']).name==step['file'] and sha(folder/'checkpoints'/step['file'])==step['fileSha256'],
            'Committed optimizer bytes changed')
    ms=[s for s in steps if s['parameterKind']=='management']
    ws=[s for s in steps if s['parameterKind']=='summary']
    require(len(steps)==len(ms)+len(ws) and len(ms)<=8 and len(ws)<=2,'Optimizer budgets changed')
    for kind,values,field in (('management',ms,'managementState'),('summary',ws,'summaryState')):
        values.sort(key=lambda s:int(s['id'].rsplit('-',1)[1]))
        require([s['id'] for s in values]==[kind+'-'+str(i) for i in range(1,len(values)+1)],'Step sequence changed')
        require(last[field]['stateHash']==(values[-1]['afterHash'] if values else first[field]['stateHash']),
            'Final training checkpoint omits/adds an optimizer step')
    plan=read(folder/'zip-summary-questions.json');validate_plan(plan)
    train_ids={t['id'] for t in plan['training']}
    training_raw={i:r for i,r in raws.items() if record_task_id(r) in train_ids}
    training_features={i:f for i,f in features.items() if record_task_id(f) in train_ids}
    course=replay_saved_course(folder,dict(trainingRound=protocol['trainingRound']),notes,initial,first,
        training_features,training_raw,steps,training_only=True)
    require(len(course['objects'])==8 and len(course['revisions'])==6 and len(course['revisionFeedback'])==2,
        'Training/revision feedback did not complete')
    require(last['entriesHash']==digest(course['entries']) and last['historiesHash']==digest(course['history']) and
        last['statusesHash']==digest(course['statuses']) and last['head']==initial['head'],
        'Recovered bank differs from committed training checkpoint')
    bank=dict(entries=course['entries'],history=course['history'],statuses=course['statuses'],head=initial['head'])
    # Neither partial HELD data nor its scores are admitted to this bank.
    validate_history(bank['history'])
    original_hashes=snapshot(folder)
    return dict(parentResume=previous,trainingRound=protocol['trainingRound'],parent=parent,
        initial=initial,initialCheckpoint=first,trainingCheckpoint=last,bank=bank,notes=notes,
        raws=raws,features=features,managementSteps=ms,summarySteps=ws,originalHashes=original_hashes,
        summaryFile=folder/'checkpoints'/last['summaryState']['file'],summaryHash=last['summaryState']['stateHash'],
        managementFile=folder/'checkpoints'/last['managementState']['file'],managementHash=last['managementState']['stateHash'],
        initialManagementFile=folder/'checkpoints'/first['managementState']['file'],
        parentWasFreshManager=previous.get('managementFile') is None)
