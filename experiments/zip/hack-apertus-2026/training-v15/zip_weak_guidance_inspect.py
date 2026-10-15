"""Original-data replay of editable guidance, procedural labels and outcome credit."""
import copy
import json
import math
from pathlib import Path
import time
import zipfile
from draft_inspect_runtime import read,sha,snapshot
from object_choice_core import normalized_features
from zip_label_grounded_checks import feature_messages
from zip_summary_training_v4_run import numeric_same
from zip_weak_guidance_core import *
from zip_weak_guidance_course import run_course
from zip_weak_guidance_policy import token_limit


def read_native_guide(folder,guide):
    """Exercise native JSON/text binding on the same path used by source admission."""
    validate_guide(guide)
    require(Path(guide['id']).name==guide['id'],'Invalid native guidance identifier')
    path=Path(folder)/'weak-guidance-zips'/(guide['id']+'.zip')
    with zipfile.ZipFile(path) as archive:
        require(archive.namelist()==['root.json','guidance.txt'] and archive.testzip() is None,
                'Changed native editable guide archive members')
        require(json.loads(archive.read('root.json'))==guide and
                archive.read('guidance.txt').decode()==guide['text'],
                'Changed native editable guide')
    return copy.deepcopy(guide)

def replay_course(folder,initial,notes,number,training_only=False,tail=None):
    folder=Path(folder);plan=read(folder/'weak-guidance-questions.json');roots=read(folder/'roots.json')
    train_ids={t['id'] for t in plan['training']}
    allraw=[read(p) for p in sorted((folder/'responses').glob('*-raw.json'))]
    calls=[r for r in allraw if r['phase']!='cold_replay' and (not training_only or
        r.get('task',{}).get('id') in train_ids or r.get('split') in ('procedural_evaluation','training'))]
    features=[read(p) for p in sorted((folder/'feature').glob('*.json'))]
    if training_only:features=[f for f in features if f['task']['id'] in train_ids]
    cursor=fcursor=0;observed={};states={k:v['stateHash'] for k,v in read(folder/'checkpoints/initial.json')['states'].items()}
    snapshots={};used_steps=set();warm_seen=[];guide_roots={read(p)['id']:read(p) for p in (folder/'guide').glob('*.json')}
    step_rows=[read(p) for kind in ('management-step','guide-step') for p in (folder/kind).glob('*.json')]
    step_by_records={(s['parameterKind'],tuple(s['sourceRecordIds'])):s for s in step_rows}
    require(len(step_rows)==len(step_by_records),'Duplicate sampled optimizer source')
    def ask(phase,messages,seed,*,mode,sampled=False,**context):
        nonlocal cursor
        if cursor==len(calls) and tail is not None:return tail['ask'](phase,messages,seed,mode=mode,sampled=sampled,**context)
        require(cursor<len(calls),'Missing actual student original')
        r=calls[cursor];cursor+=1;v=r['studentOutput']
        snap=context.get('managerSnapshot','current');expected_manager=states['management'] if snap=='current' else snapshots[snap]
        require(r['phase']==phase and r['studentPrompt']==messages and r['samplingSeed']==seed and
            all(r.get(k)==value for k,value in context.items()) and v['sampled'] is sampled and
            v['generationMode']==mode and v['managementStateHashDuringGeneration']==expected_manager and
            v['guideStateHashDuringGeneration']==states['guide'] and
            v['mathAdapterEnabledDuringGeneration']==(mode=='math') and
            v['managementAdapterEnabledDuringGeneration']==(mode=='management') and
            v['guideAdapterEnabledDuringGeneration']==(mode=='guide') and
            v['semanticAdapterEnabledDuringGeneration'] is False and v['summaryAdapterEnabledDuringGeneration'] is False,
            'Changed actual prompt, guide, snapshot, trajectory or mode')
        return copy.deepcopy(r)
    def feature(task,row,cards):
        nonlocal fcursor
        if fcursor==len(features) and tail is not None:return tail['feature'](task,row,cards)
        require(fcursor<len(features),'Missing frozen feature')
        f=features[fcursor];fcursor+=1
        require(f['task']==task and f['sourceObservationRecordId']==row['recordId'] and f['candidateCards']==cards and
            f['candidatePrompts']==[feature_messages(task,row['studentOutput'],c) for c in cards] and
            numeric_same(f['normalizedFeatures'],normalized_features(f['candidateHiddenVectors'])) and
            f['allAdaptersDisabled'] is True,'Changed frozen observations/features')
        return copy.deepcopy(f['normalizedFeatures']),f['id']
    def save(kind,row):
        path=folder/'responses'/(row['recordId']+'-scored.json') if kind=='scored' else folder/kind/(row['id']+'.json')
        if not path.is_file() and tail is not None:
            tail['save'](kind,row);observed.setdefault(kind,[]).append(copy.deepcopy(row));return
        expected=read(path);require(numeric_same(row,expected),'Saved '+kind+' differs from original-algorithm replay')
        observed.setdefault(kind,[]).append(copy.deepcopy(expected));row.clear();row.update(copy.deepcopy(expected))
    def warmup(lessons):
        packets=read(folder/'warm-packets.json')
        for index,batch in enumerate(warm_schedule(lessons),1):
            row=read(folder/'warm-step'/('warm-'+str(index)+'.json'))
            body={k:v for k,v in row.items() if k not in ('warmHash','stateFile','stateFileSha256')}
            require(row['warmHash']==digest(body) and row['parameterKind']=='warm_management' and
                row['beforeHash']==states['management'] and row['lessonIds']==[l['id'] for l in batch] and
                row['packetHashes']==[packets[l['id']]['packetHash'] for l in batch] and row['learningRate']==WARM_LR and
                row['optimizer']=='AdamW' and row['labelAuthor']=='host_procedural_encoding_only' and
                row['studentGenerations']==0 and row['targetsSpecifyEncodingNotTaskJudgment'] is True and
                math.isfinite(row['meanTargetTokenLoss']),'Changed balanced procedural step or attribution')
            for lesson in batch:
                p=packets[lesson['id']]
                require(p['packetHash']==digest({k:v for k,v in p.items() if k!='packetHash'}) and
                    p['lessonContentHash']==digest(lesson) and p['targetText']==lesson['target'] and
                    p['studentResponse'] is False and p['labelAuthor']=='host_procedural_encoding_only' and
                    p['targetIds'][-1] in p['actualConfiguredEosIds'],'Wrong supervised target or EOS packet')
            states['management']=row['afterHash'];warm_seen.append(row)
    def learn(kind,rows,advantages,evidence):
        location='management-feedback' if kind=='management' else 'guide-feedback'
        original=read(folder/location/(evidence['id']+'.json'))['policyUpdate']
        key=(kind,tuple(r['recordId'] for r in rows));nonzero=any(abs(a)>1e-12 for a in advantages)
        require(original['updated'] is nonzero and original['beforeHash']==states[kind] and
            original['sourceRecordIds']==list(key[1]) and original['parameterKind']==kind,'Wrong sampled update source/state')
        if nonzero:
            step=step_by_records.get(key);require(step is not None,'Missing actual optimizer commit')
            require(numeric_same(step['advantages'],advantages) and numeric_same(step['evidence'],evidence) and
                step['beforeHash']==states[kind] and step['afterHash']==original['afterHash'] and
                step['learningRate']==.003 and step['optimizer']=='SGD without momentum','Changed measured credit attribution')
            policy=step['policyUpdate'];values=[r['studentOutput'] for r in rows]
            require(policy['updated'] is True and policy['allSampledTokensReplayed'] is True and
                policy['constantTokenDenominator']==len(rows)*128 and numeric_same(policy['advantages'],advantages) and
                numeric_same(policy['sampledLogProbabilities'],[v['samplingLogProbability'] for v in values]) and
                len(policy['replayLogProbabilities'])==len(values) and all(math.isfinite(lp) and
                    abs(lp-v['samplingLogProbability'])<=.08*v['generatedTokens'] for lp,v in zip(policy['replayLogProbabilities'],values)),
                'Changed native sampled-token replay budget/logs')
            states[kind]=step['afterHash'];used_steps.add(key)
        else:require(key not in step_by_records and original['afterHash']==states[kind],'Zero-credit update changed parameters')
        return copy.deepcopy(original)
    def load(i):require(i in notes,'Unknown original note');return copy.deepcopy(notes[i])
    def store(g):require(guide_roots.get(g['id'])==g,'Changed student-written guidance original')
    def checkpoint(label,bank):
        path=folder/'checkpoints'/(label+'.json')
        if training_only and label=='training-final' and not path.is_file():path=folder/'checkpoints/after-4.json'
        if not path.is_file() and tail is not None:return tail['checkpoint'](label,bank)
        cp=read(path)
        require(cp['bankHash']==digest(bank) and all(cp['states'][k]['stateHash']==states[k] for k in states),
            'Changed committed bank or parameter state')
        if label=='initial':snapshots['pre_round']=states['management']
        if label=='after-warm':snapshots['warm']=states['management']
        if label=='proposal':snapshots['proposal']=states['management']
    course=run_course(plan,roots,initial,ask,feature,save,learn,warmup,checkpoint,load,store,
        tail['deadline'] if tail else time.monotonic()+120,number,training_only=training_only)
    require(cursor==len(calls) and fcursor==len(features) and used_steps==set(step_by_records) and len(warm_seen)==16,
        'Unbound raw, feature or optimizer record')
    for kind in ('scored','object','decision','trial','management-choice','management-feedback','reuse-history',
        'interface-probe','guide','guide-measurement','guide-final-measurement','guide-feedback'):
        paths=(folder/'responses').glob('*-scored.json') if kind=='scored' else (folder/kind).glob('*.json')
        values=[read(p) for p in paths]
        if kind=='scored':values=[r for r in values if r['phase']!='cold_replay']
        if training_only:
            values=[r for r in values if r.get('phase')!='heldout' and
                (r.get('taskId',r.get('task',{}).get('id')) not in {t['id'] for t in plan['heldout']})]
        require(len(values)==len(observed.get(kind,[])),'Unbound '+kind+' originals')
    return course

def inspect_source(folder,depth=0,training_only=False):
    require(depth<8,'Weak-guidance continuation depth limit')
    folder=Path(folder).resolve()
    result=read(folder/'result.json') if (folder/'result.json').is_file() else {}
    protocol=read(folder/'protocol.json')
    if protocol.get('protocol')!=PROTOCOL:
        require(not training_only,'Partial old source must be recovered by v9 first')
        from zip_summary_training_v8_inspect import inspect_training_source
        return inspect_training_source(folder)
    require(protocol['teacherCalls']==0 and not protocol.get('fixtureOnly') and not result.get('fixtureOnly') and
        not result.get('teacherCalls') and not result.get('fixtureGenerations'),'Fixture/teacher source rejected before model import')
    allraw=[read(p) for p in (folder/'responses').glob('*-raw.json')]
    require(0<len(allraw)<=MAX_GENERATIONS,'Raw generation cap')
    for row in allraw:
        v=row['studentOutput']
        require(row['fixtureOnly'] is False and not row.get('offlineFixtureFactory') and not v.get('testDouble') and
            v['originalTextRepaired'] is False and 0<v['generatedTokens']==len(v['generatedIds'])==len(v['samplingTokenLogProbabilities'])<=token_limit(row['phase']) and
            all(type(i) is int and i>=0 for i in v['generatedIds']) and all(math.isfinite(lp) for lp in v['samplingTokenLogProbabilities']) and
            abs(sum(v['samplingTokenLogProbabilities'])-v['samplingLogProbability'])<=1e-10,'Changed or fixture raw provenance')
    source=read(folder/'source-checkpoint.json');parent=Path(source['parentSource']).resolve()
    require(parent!=folder and sha(parent/'result.json')==source['parentResultSha256'],'Changed parent checkpoint')
    previous=inspect_source(parent,depth+1);initial=read(folder/'initial-bank.json')
    expected=copy.deepcopy(previous['managementInitial']);expected['guide']=copy.deepcopy(previous.get('activeGuide',host_guide()))
    require(initial==expected and read(folder/'roots.json')==previous['base']['bank']['mathematicalRoots'],
        'Changed initial bank, guide or frozen root set')
    first=read(folder/'checkpoints/initial.json')
    require(first['states']['management']['stateHash']==previous['managementHash'],'Changed initial management state')
    expected_frozen=dict(base=previous['base']['result']['baseStateBefore'],
        math=previous['base']['result']['mathematicalWriterStateHash'],
        semantic=previous['base']['final']['semanticStateHash'],summary=previous['summaryStateHashes'][A])
    require(first['frozenOriginalHashes']==expected_frozen,'Wrong original frozen weights')
    if previous.get('guideHash'):require(first['states']['guide']['stateHash']==previous['guideHash'],'Changed initial guide writer state')
    for path in (folder/'checkpoints').glob('*.json'):
        cp=read(path)
        require(cp['frozenOriginalHashes']==first['frozenOriginalHashes'],'Original frozen hashes changed between stages')
        for state in cp['states'].values():
            require(Path(state['file']).name==state['file'] and sha(folder/'checkpoints'/state['file'])==state['fileSha256'],'Changed adapter file')
    for kind in ('warm-step','management-step','guide-step'):
        values=[read(p) for p in (folder/kind).glob('*.json')]
        require(len(values)<=({'warm-step':16,'management-step':4,'guide-step':1}[kind]),'Optimizer step budget changed')
        for row in values:
            require(Path(row['stateFile']).name==row['stateFile'] and sha(folder/'checkpoints'/row['stateFile'])==row['stateFileSha256'],
                'Changed optimizer parameter bytes')
    course=replay_course(folder,initial,previous['inherited'],protocol['experimentNumber'],training_only=training_only)
    if training_only:
        require(sum(o['phase']=='training' for o in course['objects'])==4,'TRAIN phase did not complete')
        label='training-final' if (folder/'checkpoints/training-final.json').is_file() else 'after-4'
    else:
        require(result.get('completeTrainingExperiment') is True and result.get('stopReason')=='completed' and result.get('error') is None and
            result['warmOptimizerUpdates']==16 and result['completedTrainingObjects']==result['completedHeldoutObjects']==4 and
            result['coldReproductions']==8 and all(result[k] is True for k in ('baseWeightsUnchanged','mathematicalWriterUnchanged',
                'originalSemanticWriterUnchanged','originalSummaryWriterUnchanged','methodHeadsUnchanged',
                'originalFilesUnchanged','heldoutLearnedStateUnchanged')),'Incomplete or unfrozen weak-guide source')
        require(len(allraw)==result['actualStudentGenerations'] and
            len(list((folder/'feature').glob('*.json')))==result['featureForwardBatches']<=16 and
            len(list((folder/'warm-step').glob('*.json')))==result['warmOptimizerUpdates']==16 and
            len(list((folder/'management-step').glob('*.json')))==result['managementOptimizerUpdates']<=4 and
            len(list((folder/'guide-step').glob('*.json')))==result['guideOptimizerUpdates']<=1 and
            result['trainingUpdates']==result['warmOptimizerUpdates']+result['managementOptimizerUpdates']+result['guideOptimizerUpdates'],
            'Changed real generation or optimizer counters')
        cold=[r for r in allraw if r['phase']=='cold_replay']
        require(len(cold)==8 and all(read(folder/'responses'/(r['recordId']+'-scored.json'))['check']['exactReproduction']['exact']
            for r in cold),'Changed saved cold checks')
        manifest=read(folder/'run-file-manifest.json')['files'];actual=snapshot(folder)
        require(all(actual.get(k)==v for k,v in manifest.items()) and set(actual)-set(manifest)<=
            {'result.json','run-file-manifest.json','Lain-Zip-Weak-Guidance-Review.zip'},'Changed source manifest')
        report=summarize(course)
        report['interfaceProbeCorrectByStage']={s:sum(p['correct'] for p in course['interfaceProbes'] if p['stage']==s)
            for s in ('before_warm','after_warm')}
        report['trainingValidActions']=sum(f['action'] is not None for f in course['managementFeedback'])
        require(numeric_same(report,result['summary']) and course['bank']==read(folder/'memory-bank.json'),'Changed final reported effect/bank')
        label='final'
    last=read(folder/'checkpoints'/(label+'.json'))
    active=course['activeGuide']
    for guide in [initial['guide']]+course['guideCandidates']:
        read_native_guide(folder,guide)
    return dict(base=previous['base'],parent=folder,parentHashes=snapshot(folder),inherited=previous['inherited'],
        managementInitial={k:course['bank'][k] for k in ('entries','history','statuses','head')},
        managementFile=folder/'checkpoints'/last['states']['management']['file'],
        managementHash=last['states']['management']['stateHash'],summaryFiles=previous['summaryFiles'],
        summaryStateHashes=previous['summaryStateHashes'],activeGuide=active,
        guideFile=folder/'checkpoints'/last['states']['guide']['file'],guideHash=last['states']['guide']['stateHash'],
        replayedCourse=course,initial=initial,initialCheckpoint=first,trainingCheckpoint=last,
        parentResume=previous,experimentNumber=protocol['experimentNumber'])
