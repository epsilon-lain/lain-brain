"""Train one separate semantic writer and continue the learned choice head."""
import argparse
import copy
import json
import math
import os
from pathlib import Path
import signal
import sys
import time
import traceback
import zipfile

sys.path.insert(0,str(Path(__file__).resolve().parent))
from writer_check_run import preflight as checked_source
from writer_check_run import source_cases
from writer_check_core import write_once, exact_reproduction
from draft_inspect_runtime import read, sha, snapshot
from zip_content_core import digest
from tool_loop_course import archived_inputs
from object_choice_core import normalized_features, feature_messages, audit_math
from choice_retest_core import restore_head
from choice_continue_core import feedback_update
from zip_label_core import (PROTOCOL,COMPACT_PROTOCOL,NATURAL_PROTOCOL,TOKENS,GENERATION_CAP,FEATURE_BATCH_CAP,ARMS,
    WRITER_LEARNING_RATE,make_plan,initial_label_messages,observations_messages,
    revision_messages,cards,version_label,run_course,summarize,require,
    needs_note_bootstrap,complete_generation_count,seed_for,bootstrap_notes,empty_label)
from zip_semantic_generation import (LEGACY_LANGUAGE,COMPACT_LANGUAGE,NATURAL_LANGUAGE,
    NOTE_LANGUAGES,note_contract,framing_check,sentence_ended,generate_note)
from zip_label_progress import StageProgress


def close_weights(a,b):
    return len(a)==len(b) and all(abs(x-y)<=1e-12 for x,y in zip(a,b))


def inspect_iteration(folder):
    """Before model imports: validate originals, math scores and checkpoint files."""
    folder=Path(folder).resolve();result=read(folder/'result.json')
    require(result.get('protocol') in (PROTOCOL,COMPACT_PROTOCOL,NATURAL_PROTOCOL) and result.get('stopReason')=='completed' and
        result.get('error') is None and result.get('fixtureOnly') is False and
        result.get('fixtureGenerations')==0 and result.get('teacherCalls')==0 and
        result.get('completeNewObjects')==12 and result.get('coldReproductions')==8 and
        result.get('semanticFeedbackSteps')==8 and result.get('headFeedbackSteps')==8 and
        result.get('heldoutTrainingUpdates')==0 and result.get('rawResponsesWithoutCompletedAudit')==0 and
        result.get('actualStudentGenerations') in (76,78) and result.get('featureForwardBatches')==28 and
        result.get('baseWeightsUnchanged') is True and result.get('mathematicalWriterUnchanged') is True and
        result.get('originalFilesUnchanged') is True and result.get('protectedFilesUnchanged') is True and
        result.get('oldToolsUnchanged') is True and result.get('resumeFilesUnchanged') is True and
        result.get('possibleUnrecordedSemanticMutation') is False and
        result.get('heldoutLearnedStateUnchanged') is True,
        '仅完整真实 ZIP 标签迭代结果可接续')
    require(type(result.get('iterationRound')) is int and 1<=result['iterationRound']<=1000,
            'Invalid iteration round')
    language_protocol = {PROTOCOL:LEGACY_LANGUAGE,COMPACT_PROTOCOL:COMPACT_LANGUAGE,
        NATURAL_PROTOCOL:NATURAL_LANGUAGE}[result['protocol']]
    bootstrap_count = (2 if result['iterationRound']==1 else 0) if language_protocol==LEGACY_LANGUAGE else result.get('bootstrapDescriptionCount')
    require(result['actualStudentGenerations']==complete_generation_count(bootstrap_count),
            'Generation count differs from initial/resumed protocol')
    if language_protocol in NOTE_LANGUAGES:
        require(result.get('languageProtocol')==language_protocol,'Language protocol differs')
    roots=read(folder/'roots.json');initial=read(folder/'checkpoints/initial.json')
    final=read(folder/'checkpoints/final.json');bank=read(folder/'zip-label-bank.json')
    parent=read(folder/'source-checkpoint.json')
    require(parent['startingHead']==initial['head'] and parent['iterationRound']==result['iterationRound'],
            'Initial checkpoint does not match the saved continuation source')
    if parent.get('parentIterationSource'):
        previous=Path(parent['parentIterationSource'])
        require(sha(previous/'result.json')==parent['parentIterationResultSha256'] and
            sha(previous/'checkpoints/final.json')==parent['parentFinalCheckpointSha256'] and
            sha(previous/'zip-label-bank.json')==parent['parentLabelBankSha256'],
            'Parent iteration files changed')
        previous_final=read(previous/'checkpoints/final.json')
        require(parent['startingHead']==previous_final['head'] and
            initial['semanticStateHash']==previous_final['semanticStateHash'] and
            abs(initial['baselinePass']-previous_final['baselinePass'])<=1e-12,
            'Continuation did not restore parent weights and reward baseline')
        if language_protocol in NOTE_LANGUAGES:
            require(parent['startingLabels']==previous_final['labels'], 'Parent descriptions differ')
    require(final['head']==result['finalChoiceHead'] and final['labels']==bank['activeLabels'] and
            bank['mathematicalRoots']==roots and bank['newStandaloneMathematicalRules']==0,
            'Saved head, bank or roots differ')
    require(initial['semanticStateHash']==result['semanticStateBefore'] and
        final['semanticStateHash']==result['semanticStateAfter'] and
        initial['labels']==bank['initialLabels'], 'Semantic checkpoint or initial labels differ')
    for checkpoint in (initial,final):
        path=folder/'checkpoints'/checkpoint['semanticFile']
        require(Path(checkpoint['semanticFile']).name==checkpoint['semanticFile'] and
                sha(path)==checkpoint['semanticFileSha256'], 'Semantic checkpoint file changed')
        restore_head(checkpoint['head'])
    raws={};scored={}
    for path in sorted((folder/'responses').glob('*-raw.json')):
        row=read(path);checked=read(path.with_name(path.name.replace('-raw.json','-scored.json')))
        require(not row['studentOutput'].get('testDouble') and row.get('fixtureOnly') is False and
                all(checked.get(k)==v for k,v in row.items()), 'A raw/scored record differs or is a fixture')
        require(row['recordId'] not in raws,'Duplicate original record')
        raws[row['recordId']]=row;scored[row['recordId']]=checked
    require(len(raws)==result['actualStudentGenerations']==result['rawResponsesSaved']==result['scoredResponses'],
            'Generation record count differs')
    if language_protocol in NOTE_LANGUAGES:
        bootstrap_rows=[r for r in raws.values() if r['phase']=='initial_zip_label']
        require(len(bootstrap_rows)==bootstrap_count,'Bootstrap description count differs')
        bootstrap_labels=copy.deepcopy(bank['preBootstrapLabels'])
        require(parent['startingLabels']==bootstrap_labels and
            parent['bootstrapDescriptionCount']==bootstrap_count and
            bootstrap_count==(2 if needs_note_bootstrap(bootstrap_labels,language_protocol) else 0),
            'Bootstrap plan differs from parent description completeness')
        if bootstrap_count:
            if language_protocol==NATURAL_LANGUAGE:
                bootstrap_labels={root['id']:copy.deepcopy(bootstrap_labels.get(root['id']) or empty_label(root))
                    for root in roots}
            for root,row in zip(roots,bootstrap_rows):
                require(row['rootId']==root['id'] and row['studentPrompt']==initial_label_messages(root,language_protocol)
                    and row['studentOutput']['semanticStateHashDuringGeneration']==initial['semanticStateHash']
                    and row['previousLabelVersion']==(bank['preBootstrapLabels'].get(root['id']) or {}).get('id'),
                    'Bootstrap note did not use restored pre-round state or the compact protocol')
                version=version_label(root,row,bootstrap_labels.get(root['id']),language_protocol)
                require(version==scored[row['recordId']]['check'], 'Bootstrap original differs')
                if language_protocol==COMPACT_LANGUAGE:
                    require(version['activatedAsRetrievalMetadata'],'Bootstrap original is incomplete')
                if version['activatedAsRetrievalMetadata']:
                    bootstrap_labels[root['id']]=version
        require(bootstrap_labels==initial['labels'] and (language_protocol==NATURAL_LANGUAGE or
                not needs_note_bootstrap(bootstrap_labels,language_protocol)),
                'Shared initial short notes cannot be replayed')
        require(result['completeBootstrapDescriptions']==sum(
            scored[r['recordId']]['check']['activatedAsRetrievalMetadata'] for r in bootstrap_rows),
            'Complete bootstrap count differs from originals')
        if language_protocol==NATURAL_LANGUAGE:
            require(result.get('incompleteBootstrapStopsTraining') is False and
                result.get('incompleteBootstrapDescriptions')==bootstrap_count-result['completeBootstrapDescriptions'],
                'Incomplete bootstrap continuation/count differs')
        for row in raws.values():
            if row['requestedMathAdapterEnabled']:continue
            output=row['studentOutput']
            require(output.get('languageProtocol')==language_protocol and
                output.get('originalTextRepaired') is False,'Semantic stop provenance differs')
            if language_protocol==COMPACT_LANGUAGE:
                require(output.get('studentEndMarkerReached')==note_contract(output['raw'])['studentEndMarkerPresent'],
                    'Semantic marker provenance differs')
            else:
                require(output.get('studentEndMarkerReached') is False and
                    output.get('studentEndMarkerRequired') is False and
                    output.get('studentSentenceBoundaryReached')==sentence_ended(output['raw']) and
                    output.get('stopReason') in ('eos','token_cap','student_sentence_boundary') and
                    (output['stopReason']!='student_sentence_boundary' or output['studentSentenceBoundaryReached']) and
                    (output['stopReason']!='token_cap' or output['tokenCapReached']),
                    'Natural semantic stop provenance differs')
    routes=[r for r in scored.values() if r['phase'] in ('training_route_math','heldout_route_math')]
    require(len(routes)==36,'All 36 method routes must be retained')
    for row in routes:
        require(audit_math(row['task'],row['studentOutput'],row['selectedCandidate'])==row['check'],
                'Saved mathematical audit cannot be replayed')
    versions=[read(p) for p in (folder/'label-version').glob('*.json')]
    for version in versions:
        require(version['sourceRecordId'] in raws and
            version['studentRaw']==raws[version['sourceRecordId']]['studentOutput']['raw'] and
            version['studentRawHash']==digest(version['studentRaw']) and
            version['wholeNaturalLanguageCertified'] is False,'Student label original differs')
    vectors={read(p)['id']:read(p) for p in (folder/'feature').glob('*.json')}
    objects=[read(p) for p in sorted((folder/'object').glob('*.json'))]
    objects_by_id={o['id']:o for o in objects}
    if language_protocol in NOTE_LANGUAGES:
        plan=read(folder/'zip-label-questions.json')
        objects=[objects_by_id[t['id']] for t in plan['training']+plan['heldout']]
    updates=[read(p) for p in sorted((folder/'update').glob('*.json'))]
    require(len(updates)==8 and len(vectors)==28,'Incomplete feedback/feature records')
    for field in vectors.values():
        words=raws[field['sourceKeywordRecordId']]
        require(field['candidatePrompts']==[feature_messages(field['task'],words['studentOutput'],c)
            for c in field['candidateCards']] and len(field['candidateCards'])==3 and
            all(c['tags']==[] for c in field['candidateCards']), 'Frozen feature source prompt differs')
    replay_head=restore_head(initial['head']);max_error=0.;semantic_hash=initial['semanticStateHash']
    baseline=initial['baselinePass'];labels=copy.deepcopy(initial['labels'])
    for number,update in enumerate(updates,1):
        field=vectors[update['featureAfterId']]
        math_rows=[scored[k] for k in update['mathematicalRecordIds']]
        outcomes=[int(r['check']['outcomePassed']) for r in math_rows]
        replay=feedback_update(replay_head,normalized_features(field['candidateHiddenVectors']),outcomes,number)
        saved=update['headUpdate']
        require(close_weights(replay['beforeState']['weights'],saved['beforeState']['weights']) and
                close_weights(replay['afterState']['weights'],saved['afterState']['weights']) and
                replay['routeOutcomes']==saved['routeOutcomes'],'Choice feedback numerical replay differs')
        max_error=max(max_error,max(abs(x-y) for x,y in zip(replay['afterState']['weights'],saved['afterState']['weights'])))
        require(len(update['wordRecordIds'])==3 and all(raws[k]['studentOutput']['sampled'] is True
                for k in update['wordRecordIds']),'Language feedback missing sampled originals')
        word_rows=[raws[k] for k in update['wordRecordIds']]
        require([r['phase'] for r in word_rows]==['training_observations',
            'training_zip_label_revision','training_zip_label_revision'] and
            all(r['studentOutput']['semanticStateHashDuringGeneration']==semantic_hash for r in word_rows),
            'Word trajectories did not share one pre-feedback semantic state')
        require(update['labelParentsBefore']=={k:v['id'] for k,v in labels.items()},
            'Description feedback lineage differs')
        if language_protocol in NOTE_LANGUAGES:
            obj=objects_by_id[update['taskId']]
            parent_ids={k:v['id'] for k,v in labels.items()}
            require(obj['observationLabelIdsUsed']==parent_ids and obj['selectionLabelIdsUsed']==parent_ids
                and vectors[update['featureBeforeId']]['candidateCards']==cards(roots,labels,language_protocol),
                'Reported pre-feedback note usage differs from actual prompts')
        require(word_rows[0]['studentPrompt']==observations_messages(
            word_rows[0]['task'],roots,labels,language_protocol), 'Student observations did not use saved ZIP notes')
        activated=[]
        for root,row in zip(roots,word_rows[1:]):
            route=scored[row['sourceMathRecordId']]
            require(route['selectedCandidate']['id']==root['id'] and
                row['studentPrompt']==revision_messages(
                    row['task'],root,labels[root['id']],word_rows[0],route,language_protocol), 'ZIP revision source differs')
            proposed=version_label(root,row,labels[root['id']],language_protocol)
            require(proposed in versions, 'Complete label version cannot be replayed')
            if proposed['activatedAsRetrievalMetadata']:
                labels[root['id']]=proposed;activated.append(proposed['id'])
        if language_protocol in NOTE_LANGUAGES:
            require(obj['activatedRevisionIds']==activated,'Activated revision count differs from saved originals')
        require(update['labelParentsAfter']=={k:v['id'] for k,v in labels.items()} and
            field['candidateCards']==cards(roots,labels,language_protocol),
            'Revised descriptions did not feed the audited feature batch')
        require(abs(baseline-update['baselinePassBefore'])<=1e-12 and
            abs(update['expectedPassWithRevisedLabels']-replay['expectedPassBefore'])<=1e-12,
            'Semantic reward or baseline differs from actual route expectation')
        semantic_update=update['semanticUpdate'];semantic_hash=semantic_update['afterHash']
        require(semantic_update['beforeHash']==word_rows[0]['studentOutput']['semanticStateHashDuringGeneration']
            and semantic_update['sourceWordRecordIds']==update['wordRecordIds'] and
            abs(semantic_update['expectedPassReward']-replay['expectedPassBefore'])<=1e-12,
            'Logged word feedback does not match sampled student originals')
        baseline=.9*baseline+.1*replay['expectedPassBefore']
        checkpoint=read(folder/'checkpoints'/('after-'+str(number).zfill(2)+'.json'))
        require(checkpoint['semanticStateHash']==semantic_hash and checkpoint['labels']==labels and
            abs(checkpoint['baselinePass']-baseline)<=1e-12 and
            sha(folder/'checkpoints'/checkpoint['semanticFile'])==checkpoint['semanticFileSha256'],
            'Intermediate semantic checkpoint differs')
    require(close_weights(replay_head.weights,final['head']['weights']), 'Final head differs from feedback')
    require(semantic_hash==final['semanticStateHash'] and labels==final['labels'] and
        abs(final['baselinePass']-baseline)<=1e-12, 'Final word/description checkpoint chain differs')
    if language_protocol in NOTE_LANGUAGES:
        require(len(objects)==len(objects_by_id)==12,'Incomplete object records')
        for obj in objects:
            if obj['phase']!='heldout':continue
            learned_ids={k:v['id'] for k,v in labels.items()}
            control_ids={k:v['id'] for k,v in initial['labels'].items()}
            require(obj['observationLabelIdsUsedByArm']=={ARMS[0]:learned_ids,ARMS[1]:control_ids,ARMS[2]:learned_ids}
                and obj['selectionLabelIdsUsedByArm']=={ARMS[0]:learned_ids,ARMS[1]:control_ids,ARMS[2]:control_ids},
                'Reported heldout note reuse differs from frozen/learned banks')
            for arm,use_labels in ((ARMS[0],labels),(ARMS[1],initial['labels'])):
                rows=[r for r in raws.values() if r['phase']=='heldout_observations' and
                    r['task']['id']==obj['id'] and r['arm']==arm]
                require(len(rows)==1 and rows[0]['studentPrompt']==observations_messages(
                    obj['task'],roots,use_labels,language_protocol),'Heldout note prompt differs')
            for field in vectors.values():
                if field['task']['id']!=obj['id']:continue
                row=raws[field['sourceKeywordRecordId']]
                use_labels=labels if row['arm']==ARMS[0] and field['candidateCards']==cards(roots,labels,language_protocol) else initial['labels']
                require(field['candidateCards']==cards(roots,use_labels,language_protocol),
                    'Heldout description cards cannot be replayed')
        trials=[read(p) for p in sorted((folder/'trial').glob('*.json'))]
        require(summarize(objects,trials)==result['summary'] and
            result['activatedLabelRevisions']==result['summary']['activatedLabelRevisions'],
            'Reported description flow cannot be reproduced from saved objects')
    return dict(folder=folder,result=result,initial=initial,final=final,bank=bank,
        sourceHashes=snapshot(folder),headReplayMaximumAbsoluteDifference=max_error,
        headReplayTolerance=1e-12,headBitExactReplayClaimed=False)


def recent_complete(work,base_source):
    candidates=[]
    for path in work.glob('zip-label-iterate-*'):
        if not (path/'result.json').is_file():
            continue
        row=read(path/'result.json')
        if row.get('protocol') in (PROTOCOL,COMPACT_PROTOCOL,NATURAL_PROTOCOL) and row.get('stopReason')=='completed' and not row.get('fixtureOnly'):
            checkpoint=read(path/'source-checkpoint.json')
            if Path(checkpoint['baseChoiceSource']).resolve()==base_source.resolve():
                candidates.append((row['iterationRound'],path.stat().st_mtime_ns,path))
    return max(candidates,key=lambda x:(x[0],x[1]))[2] if candidates else None


def run(args):
    started=time.monotonic();progress=StageProgress(os.environ.get('ZIP_LABEL_PROGRESS_FILE'))
    progress.mark('只读核对原学生、64条接续原文和全部历史题目')
    checked=checked_source(args)
    contexts=checked['inspection']['drafts'];roots_by_kind={}
    for route in contexts[0]['allThreeRouteOriginals']:
        if route['selectedCandidate']['kind']!='direct':
            roots_by_kind[route['selectedCandidate']['kind']]=route['selectedCandidate']['root']
    roots=[copy.deepcopy(roots_by_kind[k]) for k in ('combine','distribute')]
    previous=recent_complete(args.work,args.source)
    resume=inspect_iteration(previous) if previous else None
    if resume:
        require(resume['bank']['mathematicalRoots']==roots and
            resume['result']['mathematicalWriterStateHash']==checked['checkpoint']['writerStateHash'],
            'Resume belongs to another mathematical writer or roots')
    round_number=resume['result']['iterationRound']+1 if resume else 1
    require(round_number<=1000,'Iteration round bound reached')
    head_state=copy.deepcopy(resume['final']['head'] if resume else
        read(args.source/'choice-heads/final.json')['heads']['continuing_choice'])
    pre_bootstrap_labels=copy.deepcopy(resume['final']['labels']) if resume else {}
    bootstrap_planned=2 if needs_note_bootstrap(pre_bootstrap_labels,NATURAL_LANGUAGE) else 0
    restore_head(head_state)
    history=[p for p in args.work.glob('zip-*') if p.is_dir() and
             ((p/'result.json').is_file() or list(p.glob('*questions.json')))]
    for p in (args.source,checked['writer'].parent,Path(checked['checkpoint']['choiceSource'])):
        if p not in history:history.append(p)
    excluded,freshness=archived_inputs(history)
    plan=make_plan(excluded,roots)
    require(not {t['semanticInputKey'] for t in plan['training']+plan['heldout']} & excluded,
            'An old object entered the new split')
    args.out.mkdir(parents=True,exist_ok=False)
    for path in sorted(Path(__file__).resolve().parent.glob('*.py')):
        target=args.out/'evaluation-code'/path.name;target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(path.read_bytes())
    for name in ('zip_pilot.py','zip_pilot_model.py'):
        target=args.out/'frozen-original-model-tools'/name;target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes((args.old_tools/name).read_bytes())
    for name,value in [('zip-label-questions.json',plan),('roots.json',roots),
                       ('source-inspection.json',checked['inspection'])]:
        write_once(args.out/name,value)
    for relative,expected in checked['inspection']['sourceFileHashes'].items():
        if Path(relative).suffix=='.zip':continue
        data=(args.source/relative).read_bytes()
        require(__import__('hashlib').sha256(data).hexdigest()==expected,'Source changed during copy')
        target=args.out/'source-originals'/relative;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
    write_once(args.out/'protocol.json',dict(protocol=NATURAL_PROTOCOL,languageProtocol=NATURAL_LANGUAGE,
        iterationRound=round_number,bootstrapDescriptionCount=bootstrap_planned,
        completeRunTextGenerations=complete_generation_count(bootstrap_planned),
        studentGeneratedEndMarker=None,studentEndMarkerRequired=False,noteWordLimit=40,
        semanticEarlyStop='student-generated sentence punctuation or EOS; no text slicing',
        incompleteBootstrapStopsTraining=False,incompleteNotesKeepPreviousMetadata=True,
        missingPriorDescription='empty metadata without host-authored semantic content',
        textGenerationCap=80,tokensPerGeneration=96,featureForwardBatchCap=28,candidatesPerBatch=3,
        trainingObjects=8,heldoutObjects=4,semanticFeedbackStepCap=8,choiceHeadFeedbackStepCap=8,
        semanticWriterLearns=True,observationsAndLabelsStudentAuthored=True,handwrittenSemanticTags=False,
        originalMathematicalWriterFrozen=True,baseFrozen=True,teacherCalls=0,
        fullRouteAuditsHostScheduled=True,unselectedRoutesNotAutonomousToolCalls=True,
        labelRevisionsFeedLaterObservationsAndCandidateCards=True,
        descriptionCardsUnverifiedProse=True,oldMathematicalRulesNotRewrittenByHost=True,
        newStandaloneMathematicalRules=0,heldoutFeedbackUpdates=0,
        primaryMetric='probability mass on all actual successful method routes',
        semanticPolicyAlgorithm='REINFORCE of three sampled student word responses with actual expected route reward',
        semanticOptimizer='SGD without momentum',semanticLearningRate=WRITER_LEARNING_RATE,
        totalSeconds=1200,newStageSeconds=900,historyFreshness=freshness))
    write_once(args.out/'source-checkpoint.json',dict(baseChoiceSource=str(args.source.resolve()),
        parentIterationSource=str(previous) if previous else None,
        parentIterationResultSha256=sha(previous/'result.json') if previous else None,
        parentFinalCheckpointSha256=sha(previous/'checkpoints/final.json') if previous else None,
        parentLabelBankSha256=sha(previous/'zip-label-bank.json') if previous else None,
        iterationRound=round_number,startingHead=head_state,
        startingLabels=pre_bootstrap_labels,bootstrapDescriptionCount=bootstrap_planned,
        originalWriterFile=str(checked['writer']),originalWriterFileSha256=sha(checked['writer']),
        originalWriterStateHash=checked['checkpoint']['writerStateHash']))
    end_wall=float(os.environ.get('ZIP_LABEL_DEADLINE',str(time.time()+1200)))
    deadline=time.monotonic()+max(0.,end_wall-time.time())
    calls=feature_calls=word_steps=word_attempts=0
    raw=[];scored=[];objects=[];updates=[];versions=[];decisions=[];trials=[]
    base=mathematical=semantic=None;state_digest=None
    base_before=math_before=None;semantic_before=semantic_after=None
    before_state=learning_state=None;writer_mode='learning';known_semantic_hash=None
    labels={};baseline=resume['final']['baselinePass'] if resume else .5
    learned_head=copy.deepcopy(head_state);control_labels=None;stop='completed';error=None;course={}
    live_head_state=copy.deepcopy(head_state);live_labels={};live_baseline=baseline
    before_heldout_hash=None;heldout_ok=None;source_ok=None;protected_ok=None;tools_ok=None;resume_ok=None

    def save(kind,row):
        path=(args.out/'responses'/(row['recordId']+'-'+kind+'.json') if kind in ('raw','scored')
              else args.out/kind/(row['id']+'.json'))
        write_once(path,row)
        collection={'raw':raw,'scored':scored,'object':objects,'update':updates,
                    'label-version':versions,'decision':decisions,'trial':trials}.get(kind)
        if collection is not None:collection.append(copy.deepcopy(row))
        progress.mark(rawResponsesSaved=len(raw),scoredResponses=len(scored),
            featureForwardBatches=feature_calls,completeNewObjects=len(objects),
            semanticFeedbackSteps=word_steps,semanticUpdates=sum(u['semanticUpdate']['updated'] for u in updates),
            choiceHeadUpdates=sum(u['headUpdate']['updated'] for u in updates),
            labelRevisions=sum(r['phase']=='training_zip_label_revision' for r in raw),inFlight=None)

    def timeout(signum,frame):raise TimeoutError('Training stage or total budget reached')
    signal.signal(signal.SIGTERM,timeout)
    old_alarm=signal.signal(signal.SIGALRM,timeout)
    signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
    try:
        progress.mark('加载原学生，冻结数学权重，建立可学习的特征／标签适配器')
        import torch
        from safetensors.torch import load_file,save_file
        from zip_pilot import load_student
        from zip_pilot_model import state_digest
        from math_writer_adapter import MathWriterAdapter
        from zip_generation_policy import generate_response,update_generation
        torch.manual_seed(20261009)
        base,tokenizer,metadata=load_student(args.student,'cpu')
        require(metadata['snapshotSha256']==checked['identity']['snapshotSha256'],'Loaded model snapshot differs')
        base_before=state_digest(base)
        mathematical=MathWriterAdapter(base,rank=8,last_layers=4,alpha=16)
        mathematical.restore(load_file(str(checked['writer'])))
        math_before=mathematical.digest()
        require(math_before==checked['checkpoint']['writerStateHash'],'Original math adapter differs')
        for p in mathematical.parameters_to_train():p.requires_grad_(False);p.grad=None
        semantic=MathWriterAdapter(base,rank=8,last_layers=4,alpha=16)
        if resume:
            semantic.restore(load_file(str(previous/'checkpoints'/resume['final']['semanticFile'])))
            require(semantic.digest()==resume['final']['semanticStateHash'],'Semantic resume digest differs')
        base.eval().requires_grad_(False);mathematical.eval();semantic.eval()
        for p in semantic.parameters_to_train():p.requires_grad_(True);p.grad=None
        before_state=semantic.learned_state();learning_state=semantic.learned_state()
        semantic_before=semantic.digest();known_semantic_hash=semantic_before
        optimizer=torch.optim.SGD(semantic.parameters_to_train(),lr=WRITER_LEARNING_RATE)
        write_once(args.out/'observed-model-identity.json',dict(snapshotSha256=metadata['snapshotSha256'],
            modelType=getattr(base.config,'model_type',None),modelParameters=sum(p.numel() for p in base.parameters()),
            mathematicalWriterStateHash=math_before,semanticInitialStateHash=semantic_before,
            headBefore=head_state,device='cpu'))

        def frozen():
            require(mathematical.enabled is True and semantic.enabled is True and
                mathematical.digest()==math_before and not base.training and
                not mathematical.training and not semantic.training and
                all(not p.requires_grad and p.grad is None for p in list(base.parameters())+
                    mathematical.parameters_to_train()),'Original mathematical/base state changed')
            require(semantic.digest()==known_semantic_hash,'Semantic state changed outside recorded training/load')

        def ask(phase,prompt,seed,*,mode,sampled=False,**context):
            nonlocal calls
            require(calls<GENERATION_CAP,'Text generation cap reached')
            if time.monotonic()>=deadline:raise TimeoutError('Text stage budget reached')
            frozen();calls+=1;begin=time.monotonic()
            progress.mark('文字生成 '+str(calls)+'/80：'+phase,generationAttempts=calls,
                          inFlight=dict(kind='text',number=calls,phase=phase))
            with mathematical.active(mode=='math'),semantic.active(mode=='semantic'):
                generator=generate_response if mode=='math' else generate_note
                value=generator(base,tokenizer,prompt,TOKENS,seed,sampled=sampled,
                    temperature=.8 if sampled else 1.,
                    **({'language_protocol':NATURAL_LANGUAGE} if mode=='semantic' else {}))
                value.update(mathAdapterEnabledDuringGeneration=mathematical.enabled,
                    semanticAdapterEnabledDuringGeneration=semantic.enabled,
                    semanticStateHashDuringGeneration=semantic.digest(),semanticWriterMode=writer_mode,
                    generationRoute='frozen_math' if mode=='math' else 'student_semantic_writer')
            row=dict(recordId='zip-label-call-'+str(calls).zfill(2),phase=phase,
                studentPrompt=copy.deepcopy(prompt),studentOutput=value,samplingSeed=seed,
                requestedMathAdapterEnabled=mode=='math',fixtureOnly=False,
                generationSeconds=time.monotonic()-begin,**context)
            save('raw',row);frozen()
            require(not value.get('testDouble') and 0<len(value['generatedIds'])<=TOKENS,
                    'Generation provenance or token count differs')
            return row

        def features(task,keywords,candidates):
            nonlocal feature_calls
            require(feature_calls<FEATURE_BATCH_CAP,'Feature batch cap reached')
            if time.monotonic()>=deadline:raise TimeoutError('Feature stage budget reached')
            frozen();feature_calls+=1;begin=time.monotonic()
            prompts=[feature_messages(task,keywords['studentOutput'],c) for c in candidates]
            sequences=[tokenizer(tokenizer.apply_chat_template(p,tokenize=False,add_generation_prompt=True),
                add_special_tokens=False)['input_ids'] for p in prompts]
            require(all(0<len(s)<=2048 for s in sequences),'Feature prompt too long; no truncation')
            pad=tokenizer.pad_token_id if tokenizer.pad_token_id is not None else tokenizer.eos_token_id
            require(isinstance(pad,int),'No padding token')
            length=max(map(len,sequences))
            ids=torch.tensor([s+[pad]*(length-len(s)) for s in sequences],dtype=torch.long)
            masks=torch.tensor([[1]*len(s)+[0]*(length-len(s)) for s in sequences],dtype=torch.long)
            progress.mark('冻结特征前向 '+str(feature_calls)+'/28，三个候选',
                inFlight=dict(kind='feature',number=feature_calls))
            with mathematical.active(False),semantic.active(False),torch.no_grad():
                hidden=base.model(input_ids=ids,attention_mask=masks,use_cache=False,return_dict=True).last_hidden_state
                vectors=[hidden[i,len(s)-1].detach().float().cpu().tolist() for i,s in enumerate(sequences)]
            row=dict(id='zip-label-feature-'+str(feature_calls).zfill(2),task=copy.deepcopy(task),
                sourceKeywordRecordId=keywords['recordId'],candidateCards=copy.deepcopy(candidates),
                candidatePrompts=prompts,promptIds=sequences,candidateOrder=[c['id'] for c in candidates],
                candidateHiddenVectors=vectors,featureSeconds=time.monotonic()-begin,
                mathematicalAdapterEnabled=False,semanticAdapterEnabled=False)
            save('feature',row);frozen()
            return normalized_features(vectors),row['id']

        def learn_words(rows,reward_pass,baseline_pass,number):
            nonlocal word_steps,word_attempts,learning_state,known_semantic_hash
            require(writer_mode=='learning' and number==word_steps+1 and number<=8,'Language update schedule differs')
            require(len(rows)==3 and all(r['studentOutput']['sampled'] is True and
                r['studentOutput']['semanticStateHashDuringGeneration']==semantic.digest() for r in rows),
                'Sampled word responses came from another semantic policy')
            word_attempts+=1
            progress.mark('写作反馈 '+str(number)+'/8：只更新学生特征／标签适配器')
            before=semantic.digest()
            with mathematical.active(False),semantic.active(True):
                update=update_generation(base,semantic,optimizer,[r['studentOutput'] for r in rows],
                    2*reward_pass-1,2*baseline_pass-1,True,3*TOKENS)
            for p in semantic.parameters_to_train():p.grad=None
            learning_state=semantic.learned_state();known_semantic_hash=semantic.digest()
            word_steps+=1
            update.update(beforeHash=before,afterHash=known_semantic_hash,
                updated=bool(update['updated'] and update.get('parameterChanged')),
                expectedPassReward=reward_pass,baselinePass=baseline_pass,
                featuresAndLabelResponsesBothReceiveGradient=True,onlySemanticAdapterUpdated=True,
                sourceWordRecordIds=[r['recordId'] for r in rows],targetTokensProvided=False)
            frozen();return update

        def select_writer(mode):
            nonlocal writer_mode,known_semantic_hash
            require(mode in ('learning','before'),'Unknown writer mode')
            if mode!=writer_mode:
                semantic.restore(before_state if mode=='before' else learning_state)
                writer_mode=mode;known_semantic_hash=semantic.digest()
            frozen()

        def checkpoint(label,head,bank,reward_baseline):
            nonlocal live_head_state,live_labels,live_baseline,before_heldout_hash
            require(writer_mode=='learning','Checkpoints must save learned state')
            frozen();folder=args.out/'checkpoints';folder.mkdir(exist_ok=True)
            file=label+'.safetensors';path=folder/file
            require(not path.exists(),'Checkpoint would overwrite saved state')
            save_file(semantic.learned_state(),str(path))
            row=dict(protocol=NATURAL_PROTOCOL,languageProtocol=NATURAL_LANGUAGE,
                label=label,head=copy.deepcopy(head),labels=copy.deepcopy(bank),
                baselinePass=reward_baseline,semanticFile=file,semanticFileSha256=sha(path),
                semanticStateHash=semantic.digest(),mathematicalWriterStateHash=math_before,
                optimizer='SGD without momentum',semanticLearningRate=WRITER_LEARNING_RATE)
            write_once(folder/(label+'.json'),row)
            live_head_state=copy.deepcopy(head);live_labels=copy.deepcopy(bank);live_baseline=reward_baseline
            if label=='training-final':
                before_heldout_hash=semantic.digest()

        for number,old in enumerate(checked['anchors'],1):
            row=ask('cold_replay',old['studentPrompt'],old['samplingSeed'],mode='math',sampled=False,
                    task=old['task'],coldNumber=number,sourceRecordId=old['recordId'])
            match=exact_reproduction(old['studentOutput'],row['studentOutput'])
            save('scored',dict(row,check=dict(exactReproduction=match)))
            progress.mark(coldReproductions=number if match['exact'] else number-1)
            require(match['exact'],'Old math writer not exactly reproduced; no new training started')
        deadline=min(deadline,time.monotonic()+900.)
        signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
        labels=copy.deepcopy(pre_bootstrap_labels)
        if bootstrap_planned:
            progress.mark('以已恢复写作权重重写两份短描述；双方对照共享；尚不更新权重')
            labels=bootstrap_notes(roots,pre_bootstrap_labels,ask,save,round_number)
            progress.mark('起始描述原文已保存；不完整项沿用旧描述或留空，继续真实题目反馈')
        control_labels=copy.deepcopy(labels)
        course=run_course(plan,roots,head_state,labels,ask,features,save,learn_words,select_writer,
            checkpoint,deadline,round_number,baseline,NATURAL_LANGUAGE)
        learned_head=course['finalHead'];labels=course['finalLabels'];baseline=course['baselinePass']
        heldout_ok=semantic.digest()==before_heldout_hash and live_head_state==learned_head and live_labels==labels
        require(heldout_ok,'Heldout learned state changed')
    except Exception as exc:
        stop='time_budget' if isinstance(exc,TimeoutError) else 'error'
        error=type(exc).__name__+': '+str(exc)
        write_once(args.out/'error.json',dict(error=error,traceback=traceback.format_exc(),
            textGenerationAttempts=calls,semanticUpdateAttempts=word_attempts,
            completedSemanticFeedbackSteps=word_steps))
        print('已停止：'+error,flush=True)
    finally:
        signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,old_alarm)
        if semantic is not None:
            semantic_after=semantic.digest()
            # Keep a partial checkpoint even if an update was interrupted.
            path=args.out/'partial-semantic-final.safetensors'
            try:save_file(semantic.learned_state(),str(path))
            except Exception as exc:
                error=(error+'; ' if error else '')+'Partial checkpoint: '+str(exc);stop='error'
        try:
            base_after=state_digest(base) if base is not None else None
            math_after=mathematical.digest() if mathematical is not None else None
        except Exception as exc:
            error=(error+'; ' if error else '')+'Final frozen state audit: '+str(exc);stop='error'
        for adapter in (semantic,mathematical):
            if adapter is not None:adapter.close()
        try:
            source_ok=snapshot(args.source.resolve())==checked['inspection']['sourceFileHashes']
            protected_ok=all(sha(Path(p))==h for p,h in checked['protected'].items())
            tools_ok=snapshot(args.old_tools.resolve())==checked['toolFiles']
            resume_ok=snapshot(previous)==resume['sourceHashes'] if resume else True
            require(source_ok and protected_ok and tools_ok and resume_ok,'Original/resume files changed')
            if base_before is not None:require(base_before==base_after,'Frozen base changed')
            if math_before is not None:require(math_before==math_after,'Frozen math writer changed')
        except Exception as exc:
            error=(error+'; ' if error else '')+str(exc);stop='error'
    all_versions=copy.deepcopy(list((control_labels or {}).values()))
    existing_ids={v['id'] for v in all_versions}
    all_versions += [v for v in versions if v['id'] not in existing_ids]
    final_labels=course.get('finalLabels',live_labels or labels)
    final_head=course.get('finalHead',live_head_state)
    bank=dict(protocol=NATURAL_PROTOCOL,languageProtocol=NATURAL_LANGUAGE,
        mathematicalRoots=roots,initialLabels=control_labels,preBootstrapLabels=pre_bootstrap_labels,
        activeLabels=final_labels,allDescriptionVersions=all_versions,
        allDescriptionOriginalRecordIds=[r['recordId'] for r in raw if r['phase'] in
            ('initial_zip_label','training_zip_label_revision')],
        oldBankPromotion=False,newStandaloneMathematicalRules=0,
        mathematicalRootsUnchanged=True,descriptionProseTruthCertified=False,
        parentIterationSource=str(previous) if previous else None)
    write_once(args.out/'zip-label-bank.json',bank)
    result=dict(protocol=NATURAL_PROTOCOL,languageProtocol=NATURAL_LANGUAGE,
        stopReason=stop,error=error,fixtureOnly=False,fixtureGenerations=0,
        iterationRound=round_number,parentIterationSource=str(previous) if previous else None,
        actualStudentGenerations=len(raw),generationAttempts=calls,rawResponsesSaved=len(raw),
        scoredResponses=len(scored),rawResponsesWithoutCompletedAudit=len(raw)-len(scored),
        featureForwardBatches=feature_calls,completeNewObjects=len(objects),
        completedTrainingObjects=sum(o['phase']=='training' for o in objects),
        completedHeldoutObjects=sum(o['phase']=='heldout' for o in objects),
        coldReproductions=sum(r['phase']=='cold_replay' and r['check']['exactReproduction']['exact'] for r in scored),
        generatedTokens=sum(r['studentOutput']['generatedTokens'] for r in raw),
        semanticFeedbackSteps=word_steps,semanticUpdateAttempts=word_attempts,
        semanticTrainingUpdates=sum(u['semanticUpdate']['updated'] for u in updates),
        headFeedbackSteps=len(updates),choiceHeadTrainingUpdates=sum(u['headUpdate']['updated'] for u in updates),
        totalTrainingUpdates=sum(int(u['semanticUpdate']['updated'])+int(u['headUpdate']['updated']) for u in updates),
        heldoutTrainingUpdates=0,baseTrainingUpdates=0,mathematicalWriterTrainingUpdates=0,teacherCalls=0,
        newZipLabelRevisions=sum(r['phase']=='training_zip_label_revision' for r in raw),
        bootstrapDescriptionCount=sum(r['phase']=='initial_zip_label' for r in raw),
        completeBootstrapDescriptions=sum(r['phase']=='initial_zip_label' and
            r['check']['activatedAsRetrievalMetadata'] for r in scored),
        incompleteBootstrapDescriptions=sum(r['phase']=='initial_zip_label' and
            not r['check']['activatedAsRetrievalMetadata'] for r in scored),
        incompleteBootstrapStopsTraining=False,
        cappedSemanticResponses=sum(not r['requestedMathAdapterEnabled'] and
            r['studentOutput']['tokenCapReached'] for r in raw),
        activatedLabelRevisions=sum(r['activatedAsRetrievalMetadata'] for r in versions
            if r['sourceRecordId'] in {q['recordId'] for q in raw if q['phase']=='training_zip_label_revision'}),
        semanticStateBefore=semantic_before,semanticStateAfter=semantic_after,
        semanticWriterParametersChanged=semantic_before is not None and semantic_after!=semantic_before,
        possibleUnrecordedSemanticMutation=semantic_after is not None and semantic_after!=known_semantic_hash,
        baseStateBefore=base_before,baseStateAfter=base_after,baseWeightsUnchanged=base_before is not None and base_after==base_before,
        mathematicalWriterStateHash=math_before,mathematicalWriterStateAfter=math_after,
        mathematicalWriterUnchanged=math_before is not None and math_after==math_before,
        originalFilesUnchanged=source_ok,protectedFilesUnchanged=protected_ok,oldToolsUnchanged=tools_ok,
        resumeFilesUnchanged=resume_ok,heldoutLearnedStateUnchanged=heldout_ok,
        allRawSavedBeforeAudit=True,finalChoiceHead=final_head,
        policySamples=len(decisions),heldoutPolicySamples=sum(t['phase']=='heldout' for t in trials),
        primaryPairedHeldoutSeedTrials=3*sum(o['phase']=='heldout' for o in objects),
        independentTrainingReplications=0,newStandaloneMathematicalRules=0,
        summary=summarize(objects,trials),elapsedSeconds=time.monotonic()-started)
    write_once(args.out/'result.json',result)
    lines=['# 学生特征／ZIP标签迭代结果','',
        '状态：'+stop+'；文字生成 '+str(len(raw))+'；写作权重更新 '+str(result['semanticTrainingUpdates'])+
        '；选择头更新 '+str(result['choiceHeadTrainingUpdates'])+'；老师调用 0。','',
        '完整起始描述 '+str(result['completeBootstrapDescriptions'])+'/'+str(result['bootstrapDescriptionCount'])+
        '；激活的新修订 '+str(result['activatedLabelRevisions'])+'/'+str(result['newZipLabelRevisions'])+
        '；被后续观察题使用的修订 '+str(result['summary']['revisionsUsedInLaterObservationPrompts'])+'。','',
        '原数学规则与数学权重保持冻结。本轮迭代学生的观察文字与ZIP描述，不宣称发现新的独立数学规则。','',
        '完整摘要：','','````json',json.dumps(result['summary'],ensure_ascii=False,indent=2),'````','']
    for row in raw:
        if row['phase'] in ('initial_zip_label','training_observations','training_zip_label_revision','heldout_observations'):
            lines += ['## '+row['recordId']+'：'+row['phase'],'','完整学生原文：','',
                      '````text',row['studentOutput']['raw'],'````','']
    (args.out/'Lain-Zip-Label-Iteration.md').write_text('\n'.join(lines),encoding='utf-8')
    attachment=args.out/'Lain-Zip-Label-Iteration-Results.zip'
    with zipfile.ZipFile(attachment,'x',zipfile.ZIP_DEFLATED) as z:
        for path in sorted(args.out.rglob('*')):
            if path.is_file() and path!=attachment:z.write(path,path.relative_to(args.out))
    print('描述回流：'+json.dumps({k:result['summary'][k] for k in ('activatedLabelRevisions',
        'revisionsUsedInLaterObservationPrompts','revisionsUsedInLaterSelectionPrompts',
        'descriptionsReturnToLaterObservationAndSelectionPrompts')},ensure_ascii=False),flush=True)
    print('ZIP标签迭代统计：'+json.dumps(result['summary'],ensure_ascii=False),flush=True)
    print('完整性：'+json.dumps({k:result[k] for k in ('stopReason','error','actualStudentGenerations',
        'featureForwardBatches','semanticTrainingUpdates','choiceHeadTrainingUpdates','newZipLabelRevisions',
        'bootstrapDescriptionCount','completeBootstrapDescriptions','incompleteBootstrapDescriptions',
        'incompleteBootstrapStopsTraining','activatedLabelRevisions','cappedSemanticResponses',
        'semanticWriterParametersChanged','baseWeightsUnchanged','mathematicalWriterUnchanged',
        'heldoutLearnedStateUnchanged','originalFilesUnchanged','teacherCalls')},ensure_ascii=False),flush=True)
    print('完整结果：'+str(attachment),flush=True)
    return 0 if stop=='completed' else 1


def main():
    p=argparse.ArgumentParser()
    for name in ('source','work','student','old-tools','out'):p.add_argument('--'+name,type=Path)
    p.add_argument('--inspect-only',action='store_true');args=p.parse_args()
    require(args.source is not None,'Source required')
    if args.inspect_only:
        if read(args.source/'result.json').get('protocol') in (PROTOCOL,COMPACT_PROTOCOL,NATURAL_PROTOCOL):
            inspected=inspect_iteration(args.source)
            print(json.dumps(dict(protocol=inspected['result']['protocol'],
                iterationRound=inspected['result']['iterationRound'],
                savedStudentGenerations=inspected['result']['actualStudentGenerations'],
                headReplayMaximumAbsoluteDifference=inspected['headReplayMaximumAbsoluteDifference'],
                headReplayTolerance=1e-12,studentCalls=0,teacherCalls=0,trainingUpdates=0,
                modelNotLoaded=True,iterationModelWeightsNotChecked=True),ensure_ascii=False));return 0
        check,anchors,cases=source_cases(args.source)
        print(json.dumps(dict(sourceRawRecords=64,sourceMathematicalAudits=36,sourceDrafts=8,
            coldReplayPlan=8,studentCalls=0,teacherCalls=0,trainingUpdates=0,
            modelNotLoaded=True,iterationModelWeightsNotChecked=True),ensure_ascii=False));return 0
    require(all(getattr(args,k) is not None for k in ('work','student','old_tools','out')),'Original runtime paths required')
    return run(args)


if __name__=='__main__':raise SystemExit(main())
