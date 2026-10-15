"""Read-only source checks. Fixtures and incomplete rounds stop before models."""
import copy
from pathlib import Path
from unittest.mock import patch

from draft_inspect_runtime import read,sha,snapshot
import zip_label_grounded_run as old_runtime
from object_choice_core import normalized_features
from zip_label_grounded_checks import feature_messages
from zip_label_feedback_audit import audit_math
from writer_check_core import exact_reproduction
from zip_label_metacognitive_checks import (require,fact_audit,metric_frame,meta_audit,
    fresh_head_proposal,guard_still_holds,meta_messages,restore_head)
from zip_label_metacognitive_core import (PROTOCOL,GENERATION_CAP,FEATURE_BATCH_CAP,measured_item,
    observation_prompt,summarize,question_zip,ARMS)

SOURCE_PIN='bc89f2208e2f1606108d3865e6c30dbd97468c6f08824d9dcb74134e1acc8dd2'

def safe_copies(folder,manifest):
    for name,expected in manifest.items():
        relative=Path(name)
        require(not relative.is_absolute() and '..' not in relative.parts,'Unsafe archive path')
        if relative.suffix=='.zip':continue
        require(sha(folder/relative)==expected,'Source original changed: '+name)

def inspect_source(folder,depth=0):
    require(depth<16,'Source continuation depth bound reached')
    folder=Path(folder).resolve();result=read(folder/'result.json')
    if result.get('protocol')!=PROTOCOL:
        require(sha(folder/'result.json')==SOURCE_PIN,'v6 starts only from the reviewed 9024865b or a complete v6 round')
        parent=read(folder/'source-checkpoint.json');copies=folder/'parent-iteration-originals'
        safe_copies(copies,parent['parentSourceFileHashes'])
        original=Path(parent['parentIterationSource']);reader,hasher=old_runtime.read,old_runtime.sha
        def remap(p):
            p=Path(p)
            return copies/p.relative_to(original) if not original.exists() and p.is_relative_to(original) else p
        with patch.object(old_runtime,'read',lambda p:reader(remap(p))),patch.object(old_runtime,'sha',lambda p:hasher(remap(p))):
            inspected=old_runtime.inspect_iteration(folder)
        roots=inspected['bank']['mathematicalRoots'];raws={r['recordId']:r for r in (
            read(p) for p in (folder/'responses').glob('*-raw.json'))}
        fields=[read(p) for p in sorted((folder/'feature').glob('*.json'))]
        objects=sorted((read(p) for p in (folder/'object').glob('*.json') if read(p)['phase']=='training'),
            key=lambda r:int(r['sourceMathRecordIds'][0].rsplit('-',1)[1]))
        items=[]
        for obj in objects:
            f=[r for r in fields if r['task']==obj['task']][-1]
            obs=raws[f['sourceKeywordRecordId']]
            items.append(measured_item(obj['task'],obs,normalized_features(f['candidateHiddenVectors']),f['id'],
                obj['routeOutcomes'],obj['sourceMathRecordIds']))
        require(len(items)==8,'Eight actual source training anchors required')
        inspected.update(anchors=items,sourceFrame=metric_frame(items,restore_head(inspected['final']['head']),
            'parent-training-readout'),initialMeta=None)
        return inspected
    require(result.get('stopReason')=='completed' and result.get('error') is None and
        result.get('fixtureOnly') is False and result.get('fixtureGenerations')==0 and result.get('teacherCalls')==0 and
        result.get('completeNewObjects')==6 and result.get('coldReproductions')==8 and
        result.get('heldoutLearnedStateUnchanged') is True and result.get('baseWeightsUnchanged') is True and
        result.get('mathematicalWriterUnchanged') is True and result.get('originalFilesUnchanged') is True and
        result.get('rawResponsesWithoutCompletedAudit')==0,'Only complete real frozen-checked v6 sources can resume')
    require(1<=result['metacognitiveRound']<=1000 and result['actualStudentGenerations']<=GENERATION_CAP and
        result['featureForwardBatches']<=FEATURE_BATCH_CAP,'Source schedule or budget differs')
    parent=read(folder/'source-checkpoint.json');copies=folder/'parent-iteration-originals'
    safe_copies(copies,parent['parentSourceFileHashes'])
    require(sha(copies/'result.json')==parent['parentIterationResultSha256'],'Parent result changed')
    previous=inspect_source(copies,depth+1)
    initial=read(folder/'checkpoints/initial.json');final=read(folder/'checkpoints/final.json')
    roots=read(folder/'roots.json');bank=read(folder/'zip-label-bank.json')
    require(initial['head']==previous['final']['head'] and initial['labels']==previous['final']['labels'] and
        initial['metaZip']==previous.get('initialMeta') and
        initial['semanticStateHash']==previous['final']['semanticStateHash'],'Parent state was not restored')
    require(roots==previous['bank']['mathematicalRoots']==bank['mathematicalRoots'] and
        final['head']==result['finalChoiceHead'] and final['labels']==bank['activeLabels'] and
        final['metaZip']==bank['activeMetacognitiveZip'] and bank['newStandaloneMathematicalRules']==0,'Final bank differs')
    for path in (folder/'checkpoints').glob('*.json'):
        cp=read(path)
        require(Path(cp['semanticFile']).name==cp['semanticFile'] and
            sha(path.parent/cp['semanticFile'])==cp['semanticFileSha256'],'Semantic checkpoint file changed')
        restore_head(cp['head'])
    raws={};scored={}
    for p in (folder/'responses').glob('*-raw.json'):
        row=read(p);s=read(p.with_name(p.name.replace('-raw.json','-scored.json')));value=row['studentOutput']
        require(row['fixtureOnly'] is False and not value.get('testDouble') and all(s.get(k)==v for k,v in row.items()),
            'Raw/scored student original differs or is fixture')
        require(row['recordId'] not in raws and len(value['generatedIds'])==value['generatedTokens'] and
            0<value['generatedTokens']<=96 and len(value['samplingTokenLogProbabilities'])==value['generatedTokens'],
            'Token or original provenance differs')
        raws[row['recordId']]=row;scored[row['recordId']]=s
        if row['requestedMathAdapterEnabled'] and row['phase']!='cold_replay':
            require(s['check']==audit_math(row['task'],value,row['selectedCandidate']),'Mathematical score changed')
    require(len(raws)==result['actualStudentGenerations']==result['rawResponsesSaved']==result['scoredResponses'],
        'Original count differs')
    old_cold={read(p)['coldNumber']:read(p) for p in (copies/'responses').glob('*-raw.json')
        if read(p)['phase']=='cold_replay'}
    cold=[r for r in raws.values() if r['phase']=='cold_replay']
    require(len(cold)==8 and {r['coldNumber'] for r in cold}==set(range(1,9)),'Eight cold originals required')
    for row in cold:
        prior=old_cold[row['coldNumber']];match=exact_reproduction(prior['studentOutput'],row['studentOutput'])
        require(match['exact'] and match==scored[row['recordId']]['check']['exactReproduction'] and
            all(row[k]==prior[k] for k in ('studentPrompt','samplingSeed','task','sourceRecordId')),
            'Cold mathematical original cannot be reproduced from the validated parent')
    require(result['baseStateBefore']==result['baseStateAfter']==previous['result']['baseStateBefore'] and
        result['mathematicalWriterStateHash']==result['mathematicalWriterStateAfter']==
        previous['result']['mathematicalWriterStateHash'],'Frozen base/math identity differs')
    fields={read(p)['id']:read(p) for p in (folder/'feature').glob('*.json')}
    require(len(fields)==result['featureForwardBatches'],'Feature count differs')
    for f in fields.values():
        require(f['mathematicalAdapterEnabled'] is False and f['semanticAdapterEnabled'] is False and
            f['candidatePrompts']==[feature_messages(f['task'],raws[f['sourceKeywordRecordId']]['studentOutput'],c)
                for c in f['candidateCards']],'Feature prompts or frozen flags differ')
        normalized_features(f['candidateHiddenVectors'])
        require(old_runtime.summaries_match(normalized_features(f['candidateHiddenVectors']),f['normalizedFeatures']),
            'Saved normalized feature preimage differs')
    def buffer(name):
        items=read(folder/'guard-buffer'/(name+'.json'))['rows']
        for r in items:
            f=fields[r['featureId']];obs=raws[r['observation']['recordId']]
            require(obs==r['observation'] and f['task']==r['task'] and
                old_runtime.summaries_match(normalized_features(f['candidateHiddenVectors']),r['features']) and
                fact_audit(obs['studentOutput'],r['task'])==r['observationAudit'],'Fresh guard originals differ')
        return items
    before=buffer('before');candidate=buffer('candidate');transaction=read(folder/'transaction/atomic-training-transaction.json')
    proposal=fresh_head_proposal(restore_head(initial['head']),before,candidate)
    require(old_runtime.summaries_match(proposal,transaction['headProposal']),'Fresh head guard cannot be replayed')
    after=buffer('after-meta-update') if (folder/'guard-buffer/after-meta-update.json').is_file() else candidate
    check=guard_still_holds(restore_head(initial['head']),restore_head(proposal['afterState']),before,after)
    accepted=proposal['accepted'] and check['accepted']
    require(accepted==transaction['accepted'] and transaction['rolledBack']==(not accepted),'Transaction decision differs')
    actual_items=after if accepted else before
    require(final['head']==(proposal['afterState'] if accepted else initial['head']),'Actual final head differs')
    for name,items,state in (('fresh-training-before',before,initial['head']),
            ('fresh-training-candidate',candidate,proposal['afterState']),('committed-training-final',actual_items,final['head'])):
        frame=metric_frame(items,restore_head(state),name)
        require(old_runtime.summaries_match(frame,read(folder/'metric'/(name+'.json'))),'Training metric cannot be replayed')
    source_frame=read(folder/'metric/parent-training-readout.json')
    require(old_runtime.summaries_match(source_frame,previous['sourceFrame']),'Prior training readout differs')
    for row in raws.values():
        if row['phase'] in ('self_question_zip','self_review_zip'):
            frame=source_frame if row['phase']=='self_question_zip' else read(folder/'metric/committed-training-final.json')
            audit=meta_audit(row['studentOutput'],frame)
            require(audit==scored[row['recordId']]['check'],'Student quantitative claim audit differs')
        elif row['phase'].startswith('guard_') or row['phase'] in ('training_observations','heldout_observations'):
            require(fact_audit(row['studentOutput'],row['task'])==scored[row['recordId']]['check'],'Observation audit differs')
    decisions={read(p)['id']:read(p) for p in (folder/'decision').glob('*.json')}
    objects=[read(p) for p in (folder/'object').glob('*.json')];trials=[read(p) for p in (folder/'trial').glob('*.json')]
    for d in decisions.values():
        f=fields[d['sourceFeatureRecordId']];h=restore_head(initial['head'] if d['arm']=='frozen_before_round' or
            d['task']['split']=='training' else final['head'])
        choice=h.choose(f['normalizedFeatures'],d['policyOutput']['choiceSeed'])
        require(old_runtime.summaries_match(choice,d['policyOutput']),'Saved selector choice differs')
    for obj in objects:
        routes=[scored[i] for i in obj['sourceMathRecordIds']]
        outcomes=[int(r['check']['outcomePassed']) for r in routes]
        require(outcomes==obj['routeOutcomes'],'Shared mathematical route outcomes differ')
        if obj['phase']=='heldout':
            for arm in ARMS:
                h=restore_head(initial['head'] if arm==ARMS[1] else final['head'])
                ps=h.probabilities(normalized_features(fields[obj['featureIdsByArm'][arm]]['candidateHiddenVectors']))[1]
                require(abs(sum(p*y for p,y in zip(ps,outcomes))-obj['expectedPassByArm'][arm])<=1e-12,
                    'Heldout all-route probability differs')
    for t in trials:
        d=decisions[t['decisionId']];r=scored[t['sourceMathRecordId']]
        require(r['selectedCandidate']['id']==d['selectedCandidate']['id'] and
            t['outcomePassed']==r['check']['outcomePassed'],'Sample did not reuse its actual route original')
    require(old_runtime.summaries_match(summarize(objects,trials),result['summary']),'Heldout summary differs')
    # Keep two newest new training objects and six prior anchors, never heldout.
    replay_saved_course(folder,previous,raws,fields,initial,final,roots,objects)
    newest=[r for r in actual_items if r['task']['id'] in {o['id'] for o in objects if o['phase']=='training'}]
    anchors=newest+[r for r in actual_items if r not in newest][-6:]
    require(len(anchors)==8,'Eight next-round training anchors required')
    return dict(folder=folder,result=result,initial=initial,final=final,bank=bank,sourceHashes=snapshot(folder),
        anchors=anchors,sourceFrame=metric_frame(anchors,restore_head(final['head']),'parent-training-readout'),
        initialMeta=bank['activeMetacognitiveZip'])

def replay_saved_course(folder,previous,raws,fields,initial,final,roots,objects):
    """Replay decisions/credits/prompts/rollback using originals, without models.

    Token generation and optimizer numerics are not rerun. Their saved hashes
    are checked against state transitions and checkpoint files; loading the
    next real student still verifies the actual adapter digest.
    """
    from zip_label_metacognitive_core import run_course
    ordered=sorted((r for r in raws.values() if r['phase']!='cold_replay'),key=lambda r:int(r['recordId'].rsplit('-',1)[1]))
    feats=sorted(fields.values(),key=lambda r:int(r['id'].rsplit('-',1)[1]))
    ci=fi=0;learning_hash=initial['semanticStateHash'];current_hash=learning_hash;mode='learning'
    def same(actual,expected,why):require(old_runtime.summaries_match(actual,expected),why)
    def ask(phase,prompt,seed,*,mode,sampled=False,**context):
        nonlocal ci
        require(ci<len(ordered),'Unexpected source replay generation');row=ordered[ci];ci+=1
        require(row['phase']==phase and row['studentPrompt']==prompt and row['samplingSeed']==seed and
            row['requestedMathAdapterEnabled']==(mode=='math') and row['studentOutput']['sampled']==sampled and
            row['studentOutput']['semanticStateHashDuringGeneration']==current_hash and
            all(row.get(k)==v for k,v in context.items()),'Saved generation prompt, state or context differs')
        return copy.deepcopy(row)
    def feature(task,obs,cards):
        nonlocal fi
        require(fi<len(feats),'Unexpected replay feature');f=feats[fi];fi+=1
        require(f['task']==task and f['sourceKeywordRecordId']==obs['recordId'] and f['candidateCards']==cards,
            'Saved feature did not use its actual observation and cards')
        return copy.deepcopy(f['normalizedFeatures']),f['id']
    def save(kind,row):
        path=folder/'responses'/(row['recordId']+'-scored.json') if kind=='scored' else folder/kind/(row['id']+'.json')
        same(row,read(path),'Core replay differs: '+str(path.relative_to(folder)))
    def learn(rows,advantages,phase):
        nonlocal current_hash,learning_hash
        update=read(folder/'update'/(phase+'.json'))['semanticUpdate']
        require(update['beforeHash']==current_hash and update['sourceWordRecordIds']==[r['recordId'] for r in rows],
            'Semantic update state or sampled originals differ')
        same(advantages,update['advantages'],'Semantic credit differs')
        if not update.get('parameterChanged'):require(update['afterHash']==current_hash,'No-op mutated semantic state')
        current_hash=learning_hash=update['afterHash'];return copy.deepcopy(update)
    def select(which):
        nonlocal current_hash,mode
        mode=which;current_hash=initial['semanticStateHash'] if which=='before' else learning_hash
    def restore(state):
        nonlocal current_hash,learning_hash,mode
        current_hash=learning_hash=state;mode='learning'
    def cp(name,head,labels,baseline,meta):
        c=read(folder/'checkpoints'/(name+'.json'))
        same(dict(head=head,labels=labels,baselinePass=baseline,metaZip=meta),
            {k:c[k] for k in ('head','labels','baselinePass','metaZip')},'Checkpoint active state differs')
        require(mode=='learning' and c['semanticStateHash']==current_hash,'Checkpoint semantic state differs')
    plan=read(folder/'zip-label-questions.json')
    course=run_course(plan,roots,initial['head'],initial['labels'],previous['anchors'],previous['sourceFrame'],
        ask,feature,save,learn,select,lambda:current_hash,restore,cp,float('inf'),
        read(folder/'protocol.json')['metacognitiveRound'],initial['baselinePass'],initial['metaZip'])
    require(ci==len(ordered) and fi==len(feats),'Unused or extra generation/feature records')
    same(course['objects'],sorted(objects,key=lambda o:(o['phase']=='heldout',plan[o['phase']].index(o['task']))),
        'Source object order or content differs')
    require(course['finalHead']==final['head'] and course['finalLabels']==final['labels'] and
        course['finalMetaZip']==final['metaZip'],'Replayed committed state differs')
