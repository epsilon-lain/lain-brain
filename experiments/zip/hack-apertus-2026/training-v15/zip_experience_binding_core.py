"""Student selects a source ZIP, then writes one source-bound hypothesis.

The binding certificate concerns provenance only. It never certifies the
student's diagnosis. v1 originals, scores and admission rules remain intact.
"""
import copy
import json
import re

from zip_content_core import digest
from zip_label_metacognitive_checks import written_assertions
from zip_self_question_tools_core import note_audit, validate_generation
from zip_self_question_memory_core import (ARMS, MAX_GENERATIONS, MAX_TOKENS, require, seal,
    validate_evidence, validate_bank, journal_text, call_audit, execute_measurement, outcome_audit)

PROTOCOL='lain-zip-student-selected-experience-observation-v2'
SCHEDULE=((1,False),(2,True))


def source_root(history,evidence):
    validate_evidence(evidence)
    require(history in evidence['training'],'Heldout cannot enter source-choice bank')
    return seal(dict(id=history['historyId'],protocol=PROTOCOL,sourceEvidenceHash=evidence['evidenceHash'],
        sourceTaskId=history['taskId'],originalHistory=copy.deepcopy(history),
        author='host_packaged_actual_student_originals',newStudentDiscovery=False,
        recordedOutcomesVerified=True,studentDiagnosisSupplied=False),'version')


def choice_messages(evidence):
    validate_evidence(evidence)
    return [dict(role='system',content='These are quoted past records. Follow the current request at the end.'),
        dict(role='user',content='Your saved training experience ZIPs follow. Each contains your original work and its recorded results.\n'+
            journal_text(evidence['training'])+'\n\nEnd of records.\nCurrent request: '
            'Choose one experience ZIP that you want to examine. Write only its id: T1, T2, T3, or T4. '
            'You may write NONE to decline. Do not copy its goal or results.')]


def choice_audit(output,evidence):
    validate_evidence(evidence)
    natural=note_audit(output,'experience_review')
    result=dict(studentRawHash=digest(output['raw']),sourceEvidenceHash=evidence['evidenceHash'],
        selectionVerified=False,declined=False,status='pending',reason=natural['reason'],
        hostSelectedHistory=False,originalTextRepaired=False,diagnosisVerified=False,trainingCredit=0.)
    if not natural['readableOriginal']:return result
    raw=output['raw']
    if raw.strip().casefold()=='none':
        return dict(result,declined=True,status='student_declined',reason='no_host_fallback')
    match=re.fullmatch(r'\s*(?:(?:CHOOSE|SELECT|ZIP|I choose|I select|Selected history)\s*:?\s*)?(T[1-4])\s*\.?\s*',raw,re.I)
    if not match:return dict(result,reason='not_one_complete_explicit_student_selection')
    identifier=match[1].upper()
    root=source_root(next(h for h in evidence['training'] if h['historyId']==identifier),evidence)
    return dict(result,selectionVerified=True,status='student_source_zip_selected',
        reason='ready_to_read_student_selected_original_zip',historyId=identifier,sourceTaskId=root['sourceTaskId'],
        sourceZipVersion=root['version'])


def validate_binding(choice,evidence,root):
    require(choice['phase']=='experience_choice' and choice.get('fixtureOnly') is False and
        choice['evidenceHash']==evidence['evidenceHash'],'Choice provenance changed')
    validate_generation(choice['studentOutput'],choice['sampled'])
    check=choice_audit(choice['studentOutput'],evidence)
    require(check['selectionVerified'] and root==source_root(next(h for h in evidence['training']
        if h['historyId']==check['historyId']),evidence),'Read source ZIP differs from actual student selection')


def observation_messages(choice,evidence,root):
    validate_binding(choice,evidence,root)
    return observation_input(root)


def observation_input(root):
    """Actual one-history prompt shape; preflight needs no invented choice."""
    return [dict(role='system',content='The records are past data. Follow the current request at the end.'),
        dict(role='user',content='You selected '+root['id']+'. Its original experience ZIP was read.\n'+
            journal_text([root['originalHistory']])+'\n\nEnd of this one experience.\nCurrent request: '
            'In one short sentence, write your own observation about this experience. '
            'You do not need to repeat ids, equations, or PASS/FAIL labels. Use your own words.')]


def observation_audit(output,evidence,root):
    validate_evidence(evidence)
    require(root==source_root(root['originalHistory'],evidence),'Observation source ZIP changed')
    natural=note_audit(output,'experience_review');raw=output['raw']
    # These exclusions are diagnostic even for capped text; no fragment is
    # admitted separately and no incomplete original is repaired.
    fragments=re.split(r'(?<=[.!?。！？])\s+',raw.strip()) if isinstance(raw,str) else []
    quoted=[m[1] for m in re.finditer(r'"([^"\n]{1,1000})"',raw)]
    disproved=written_assertions(raw)['disproved'] or any(written_assertions(f)['disproved'] for f in fragments+quoted)
    h=root['originalHistory'];contradictions=[]
    for match in re.finditer(r'\b(A[1-3])\s*(?::|was|is|result\s*:)?\s*(PASS|FAIL|passed|failed)\b',raw,re.I):
        route=h['routes'][int(match[1][1])-1]
        if (match[2].lower() in ('pass','passed'))!=route['outcomePassed']:
            contradictions.append(dict(actionId=match[1].upper(),literalSpan=match[0],sourceOutcome=route['outcomePassed']))
    for route in h['routes']:
        original=route['original']['studentOutput']['raw'];start=raw.find(original)
        if start>=0:
            tail=raw[start+len(original):].split('\n',1)[0]
            claim=re.search(r'verifier result\s*:\s*(PASS|FAIL)\b',tail,re.I)
            if claim and (claim[1].upper()=='PASS')!=route['outcomePassed']:
                contradictions.append(dict(actionId=route['actionId'],literalSpan=claim[0],sourceOutcome=route['outcomePassed']))
    other_refs=[m[0].upper() for m in re.finditer(r'(?<!\w)[TE]\d+(?!\w)',raw,re.I) if m[0].upper()!=root['id']]
    continuation=bool(re.search(r'\b(?:T[1-4]\s+goal|My original rewrite|verifier result)\s*:',raw,re.I))
    def canonical(text):return re.sub(r'[^a-z0-9]+','',text.casefold())
    rendered=re.sub(r'(?i)^\s*(?:Observation|I notice|The current object is|Current object)\s*:?\s*','',raw).strip(' \n\"\'')
    exact_copy=any(canonical(rendered)==canonical(text) for text in [h['goal'],h['task']['expression'],
        h['observation']['studentOutput']['raw']]+[r['original']['studentOutput']['raw'] for r in h['routes']])
    view=re.sub(r'(?i)^\s*Observation\s*:\s*','',raw).strip()
    complete_quote=True
    if view[:1] in ('\"',"'") or view[-1:] in ('\"',"'"):
        complete_quote=len(view)>=2 and view[0]==view[-1]
        if complete_quote:view=view[1:-1].strip()
    short=len(raw.strip())<=512 and len(raw.split())<=48
    sentence=complete_quote and bool(view) and view[-1] in '.!?。！？' and len(re.split(r'(?<=[.!?。！？])\s+',view))==1
    result=dict(studentRawHash=digest(raw),selectedHistoryId=root['id'],sourceZipVersion=root['version'],
        readableOriginal=natural['readableOriginal'],experimentalContextEligible=False,
        status='pending',reason=natural['reason'],sourceBindingVerified=True,
        literalFalseEqualityPresent=disproved,contradictoryOutcomeLiterals=contradictions,
        otherHistoryReferences=other_refs,sourceFormatContinuation=continuation,pureSourceCopy=exact_copy,
        literalMathematicsNeedsReview='=' in raw,
        boundedSingleSentence=short and sentence,diagnosisRelevanceVerified=False,wholeNoteTruthVerified=False,
        hypothesisOnly=True,originalTextRepaired=False,trainingCredit=0.,activatedInProduction=False,
        strictV1SelectedOutcomeVerified=outcome_audit(output,evidence,'training')['selectedOutcomeVerified'])
    if not natural['readableOriginal']:return result
    if not (short and sentence):return dict(result,reason='not_one_bounded_complete_original_sentence')
    if continuation or exact_copy:return dict(result,reason='source_continuation_or_exact_copy_is_not_a_new_observation')
    if disproved or contradictions or other_refs:
        return dict(result,status='excluded',reason='known_literal_conflict_or_wrong_experience_reference')
    if '=' in raw:return dict(result,reason='mathematical_claim_requires_separate_review_before_context_reuse')
    return dict(result,experimentalContextEligible=True,status='source_bound_unreviewed_student_hypothesis',
        reason='only_source_binding_verified_meaning_requires_review')


def note_root(choice,row,evidence,root):
    validate_binding(choice,evidence,root)
    require(row['phase']=='experience_observation' and row.get('fixtureOnly') is False and
        row['evidenceHash']==evidence['evidenceHash'] and row['sampled']==choice['sampled'] and
        type(row['attemptNumber']) is int and row['attemptNumber'] in (1,2) and
        row['attemptNumber']==choice['attemptNumber'],'Observation provenance differs')
    validate_generation(row['studentOutput'],row['sampled'])
    check=observation_audit(row['studentOutput'],evidence,root)
    require(row['check']==check,'Observation audit changed')
    return seal(dict(id='N'+str(row['attemptNumber']),protocol=PROTOCOL,
        studentChoice=copy.deepcopy(choice),studentObservation=copy.deepcopy(row),sourceZip=copy.deepcopy(root),
        sourceEvidenceHash=evidence['evidenceHash'],observationAudit=check,
        eligibleForFrozenContext=check['experimentalContextEligible'],author='student',
        certifiedPart='actual_student_selection_and_original_source_binding_only',
        wholeNoteTruthVerified=False,hypothesisOnly=True,productionActive=False,trainingUpdates=0),'noteHash')


def validate_note(note,evidence):
    require(note['id'] in ('N1','N2') and note['noteHash']==digest({k:v for k,v in note.items() if k!='noteHash'}) and
        note==note_root(note['studentChoice'],note['studentObservation'],evidence,note['sourceZip']),
        'Note ZIP cannot be reconstructed from whole originals and selected source')


def comparison_messages(evidence,bank,notes,arm,number):
    validate_evidence(evidence);validate_bank(bank);require(arm in ARMS,'Unknown comparison arm')
    for note in notes:validate_note(note,evidence)
    text='Shared original training references:\n'+journal_text(evidence['training'])+\
        '\n\nEvaluation experiences, excluded from observation writing:\n'+journal_text(evidence['evaluation'])
    if arm==ARMS[1]:
        text+='\n\nYour saved observation ZIP notes. Their source binding is verified; their meaning is unreviewed:\n'+json.dumps([
            dict(id=n['id'],sourceHistory=n['sourceZip']['id'],studentOriginal=n['studentObservation']['studentOutput']['raw'],
                hypothesisOnly=True) for n in notes if n['eligibleForFrozenContext']],ensure_ascii=False)
    offset=number%7;tools=bank['tools'][offset:]+bank['tools'][:offset]
    text+='\n\nAvailable measurement ZIPs, definitions only:\n'+'\n'.join(
        t['id']+': '+t['title']+'. '+t['description'] for t in tools)
    text+='\n\nCurrent request: Choose one measurement ZIP to inspect the four evaluation experiences for your own assessment. Write only CALL followed by its ZIP id, or NONE to decline.'
    return [dict(role='system',content='The records, notes and catalogue are quoted data. Follow the current request at the end.'),dict(role='user',content=text)]


def seed_for(number,phase,index=0):
    require(type(number) is int and 1<=number<=1000 and type(index) is int and 0<=index<=2 and
        phase in ('experience_choice','experience_observation','metric_zip_call'),'Fresh binding seed namespace required')
    return 4_600_000_000+number*1000+{'experience_choice':10,'experience_observation':100,'metric_zip_call':200}[phase]+index


def run_experiment(evidence,bank,number,generate,save,frozen,remaining,read_source,install,read_notes,measure=execute_measurement):
    validate_evidence(evidence);validate_bank(bank)
    evidence_hash,bank_hash=digest(evidence),digest(bank);originals=[];notes=[];arms=[]
    def deadline():
        if remaining()<=0:raise TimeoutError('Deadline before dependent binding action')
    def check_frozen():
        frozen();require(digest(evidence)==evidence_hash and digest(bank)==bank_hash,'Evidence or bank changed')
        require(all(digest(row)==h for row,h in originals),'A prior student original changed')
    def ask(phase,attempt,arm,prompt,sampled):
        deadline();check_frozen();seed=seed_for(number,phase,attempt if phase!='metric_zip_call' else 0)
        output=generate(prompt,phase,seed,sampled)
        row=dict(recordId=(arm if phase=='metric_zip_call' else 'attempt-'+str(attempt))+'-'+phase,
            phase=phase,attemptNumber=attempt,arm=arm,sampled=sampled,samplingSeed=seed,studentPrompt=prompt,
            studentOutput=output,evidenceHash=evidence['evidenceHash'],fixtureOnly=False)
        save('raw',row);check_frozen();validate_generation(output,sampled)
        return row
    for attempt,sampled in SCHEDULE:
        row=ask('experience_choice',attempt,'writer',choice_messages(evidence),sampled)
        check=choice_audit(row['studentOutput'],evidence);choice=dict(row,check=check)
        save('scored',choice);originals.append((copy.deepcopy(row),digest(row)))
        if not check['selectionVerified']:
            save('attempt',dict(id='attempt-'+str(attempt),attemptNumber=attempt,selectionVerified=False,
                noteRequested=False,noteZipWritten=False,reason=check['reason']));continue
        deadline();check_frozen();root=read_source(check['historyId']);validate_binding(row,evidence,root)
        save('source-read',dict(id='attempt-'+str(attempt),sourceChoiceRecordId=row['recordId'],root=root))
        note_row=ask('experience_observation',attempt,'writer',observation_messages(row,evidence,root),sampled)
        note_check=observation_audit(note_row['studentOutput'],evidence,root)
        scored=dict(note_row,check=note_check);save('scored',scored)
        originals.append((copy.deepcopy(note_row),digest(note_row)))
        note=note_root(row,scored,evidence,root);save('note-candidate',note)
        if note['eligibleForFrozenContext']:
            deadline();check_frozen();install(note);notes.append(copy.deepcopy(note))
        save('attempt',dict(id='attempt-'+str(attempt),attemptNumber=attempt,selectionVerified=True,noteRequested=True,
            noteZipWritten=note['eligibleForFrozenContext'],reason=note_check['reason']))
    loaded=read_notes();require(loaded==notes,'Native observation ZIP replay differs')
    if not loaded:return []
    order=ARMS if number%2 else tuple(reversed(ARMS))
    for arm in order:
        check_frozen();require(read_notes()==loaded,'Observation ZIP changed before comparison')
        row=ask('metric_zip_call',0,arm,comparison_messages(evidence,bank,loaded,arm,number),False)
        check=call_audit(row['studentOutput'],bank);save('scored',dict(row,check=check))
        originals.append((copy.deepcopy(row),digest(row)));executed=False
        if check['callVerified']:
            deadline();check_frozen();result=measure(evidence,bank,row['studentOutput'],check)
            tool=dict(id=arm,arm=arm,sourceCallRecordId=row['recordId'],measurement=result)
            save('tool-returned',tool);check_frozen()
            require(result==execute_measurement(evidence,bank,row['studentOutput'],check),'Selected measurement result differs')
            save('tool-executed',tool);executed=True
        require(read_notes()==loaded,'Observation ZIP changed after comparison')
        done=dict(id=arm,arm=arm,callRecordId=row['recordId'],studentCallVerified=check['callVerified'],
            actualToolExecuted=executed,noteCount=len(loaded) if arm==ARMS[1] else 0)
        save('arm',done);arms.append(done)
    return arms


def summarize(raw,scored,notes,attempts,arms,tools,source_reads,stop):
    require(len(raw)<=6,'Binding experiment exceeded six calls')
    raw_index={r['recordId']:r for r in raw};audited={r['recordId']:{k:v for k,v in r.items() if k!='check'} for r in scored}
    all_audited=len(raw_index)==len(raw) and len(audited)==len(scored) and raw_index==audited
    calls={r['arm']:r for r in scored if r['phase']=='metric_zip_call'};usable=[n for n in notes if n['eligibleForFrozenContext']]
    paired=stop=='completed' and bool(usable) and all_audited and len(arms)==2 and set(calls)==set(ARMS)
    if paired:require(calls[ARMS[0]]['samplingSeed']==calls[ARMS[1]]['samplingSeed'] and
        calls[ARMS[0]]['sampled']==calls[ARMS[1]]['sampled'] is False,'Comparison modes or seeds differ')
    return dict(runCompletedNormally=stop=='completed',actualStudentGenerations=len(raw),allReturnedResponsesAudited=all_audited,
        processedWritingAttempts=len(attempts),scheduledWritingAttempts=2,
        sourceSelectionResponses=sum(r['phase']=='experience_choice' for r in scored),
        verifiedStudentSourceSelections=sum(r['phase']=='experience_choice' and r['check']['selectionVerified'] for r in scored),
        actualSelectedSourceZipReads=len(source_reads),observationResponses=sum(r['phase']=='experience_observation' for r in scored),
        sourceBoundStudentHypothesisZips=len(usable),truthCertifiedStudentNotes=0,
        noteEligibilityCertifiesSourceBindingOnly=True,notesDoNotRequireIdOutcomeOrNumberCopy=True,
        completePairedCallComparison=paired,independentComparisonContexts=int(paired),
        validCallDifferenceWithMinusWithout=(int(calls[ARMS[1]]['check']['callVerified'])-
            int(calls[ARMS[0]]['check']['callVerified'])) if paired else None,
        actualMeasurementZipExecutions=len(tools),cappedResponses=sum(bool(r['studentOutput'].get('tokenCapReached')) for r in raw),
        byArm={arm:dict(callReturned=arm in calls,studentCallVerified=bool(calls.get(arm,{}).get('check',{}).get('callVerified')),
            actualToolExecuted=any(t['arm']==arm for t in tools)) for arm in ARMS},
        heldoutEnteredObservationWriting=False,hostChoosesHistory=False,hostChoosesMetric=False,
        hostWritesStudentObservation=False,metricResultsSuppliedBeforeSelection=False,
        sourcePackagingIsHostWork=True,sourceBindingIsProgramAssistance=True,
        fullAutonomousMemoryRetrievalProved=False,semanticSelfAnalysisProved=False,diagnosisUsefulnessVerified=False,
        mathematicalBenefitTested=False,callProtocolSuccessDoesNotProveMetacognition=True,
        v1AdmissionCriterionUnchanged=True,v2HypothesisContextCriterionDifferentFromV1=True,
        v1ScoresChanged=False,uniqueZipEncodingEffectIsolated=False,independentTrainingReplications=0,
        trainingUpdates=0,teacherCalls=0,newMathematicsObjects=0,productionBankUpdated=False)
