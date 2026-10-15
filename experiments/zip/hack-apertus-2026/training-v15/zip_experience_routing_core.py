"""Frozen interface correction with a fixed 2x2 check, not memory training.

The literal v2 audits are unchanged. Only chat-turn boundaries and the
semantic adapter switch differ across four precommitted greedy conditions.
Whole native outputs retain their actual adapter flags; none are rewritten
to satisfy the old semantic-only generation validator.
"""
import copy
import math

from zip_content_core import digest
from zip_self_question_memory_core import require, seal, validate_evidence, sequential_sum
from zip_experience_binding_core import source_root, choice_messages, choice_audit, observation_input, observation_audit

PROTOCOL = 'lain-zip-experience-routing-interface-frozen-v3'
MAX_GENERATIONS = 6
MAX_TOKENS = 96
CONDITIONS = (
    ('combined_semantic', 'combined', True),
    ('separate_semantic', 'separate', True),
    ('combined_native', 'combined', False),
    ('separate_native', 'separate', False),
)
OBSERVATION_CONDITIONS = ('separate_semantic', 'separate_native')


def condition_spec(name):
    require(name in {r[0] for r in CONDITIONS}, 'Unknown routing condition')
    return next(r for r in CONDITIONS if r[0] == name)


def scheduled_conditions(number):
    require(type(number) is int and 1 <= number <= 1000, 'Invalid routing experiment number')
    offset = (number - 1) % 4
    return CONDITIONS[offset:] + CONDITIONS[:offset]


def separate_request(messages, boundary):
    require(len(messages) == 2 and messages[1]['role'] == 'user' and
        messages[1]['content'].count(boundary) == 1, 'Expected original request boundary')
    text = messages[1]['content']; split = text.index(boundary) + len(boundary)
    result = [copy.deepcopy(messages[0]), dict(role='user', content=text[:split]),
        dict(role='user', content=text[split:])]
    require(result[-1]['content'].startswith('Current request:') and
        result[1]['content'] + result[2]['content'] == text, 'Original words changed while separating request')
    return result


def routing_messages(evidence, name):
    _, form, _ = condition_spec(name)
    original = choice_messages(evidence)
    return original if form == 'combined' else separate_request(original, '\n\nEnd of records.\n')


def selected_observation_input(root):
    return separate_request(observation_input(root), '\n\nEnd of this one experience.\n')


def seed_for(number, phase):
    require(type(number) is int and 1 <= number <= 1000 and phase in ('experience_choice', 'experience_observation'),
        'Fresh routing seed namespace required')
    return 4_700_000_000 + number * 1000 + (10 if phase == 'experience_choice' else 100)


def validate_generation(value, semantic_enabled):
    require(type(semantic_enabled) is bool and not value.get('testDouble') and not value.get('fixtureOnly') and
        type(value.get('generatedTokens')) is int and 0 < value['generatedTokens'] <= MAX_TOKENS and
        len(value['generatedIds']) == len(value['samplingTokenLogProbabilities']) == value['generatedTokens'] and
        all(type(t) is int and t >= 0 for t in value['generatedIds']) and
        all(type(lp) in (int, float) and math.isfinite(lp) for lp in value['samplingTokenLogProbabilities']),
        'Actual whole original tokens and log probabilities required')
    require(value.get('sampled') is False and type(value.get('temperature')) in (int, float) and value.get('temperature') == 1. and
        value.get('mathAdapterEnabledDuringGeneration') is False and
        value.get('semanticAdapterEnabledDuringGeneration') is semantic_enabled,
        'Actual frozen routing generation conditions differ')
    total = sequential_sum(value['samplingTokenLogProbabilities'])
    require(type(value.get('samplingLogProbability')) in (int, float) and
        math.isfinite(value['samplingLogProbability']) and abs(total - value['samplingLogProbability']) <= 1e-10,
        'Whole original token log probability sum changed')
    require(value.get('stopReason') in ('eos', 'token_cap') and
        type(value.get('tokenCapReached')) is bool and
        value['tokenCapReached'] == (value['stopReason'] == 'token_cap'), 'Unknown original stopping condition')
    if value['tokenCapReached']:
        require(value['generatedTokens'] == MAX_TOKENS, 'Token cap before actual budget')
    if 'promptInputAudit' in value:
        audit = value['promptInputAudit']
        require(audit['inputTokens'] == len(value['promptIds']) and
            audit['promptIdsHash'] == digest(value['promptIds']) and audit['fitsInputBudget'] is True and
            audit['noSilentTruncation'] is True, 'Generated prefix differs from checked input')


def validate_choice(row, evidence, root=None):
    _, _, enabled = condition_spec(row['condition'])
    require(row.get('fixtureOnly') is False and row['protocol'] == PROTOCOL and row['phase'] == 'experience_choice' and
        row['evidenceHash'] == evidence['evidenceHash'] and row['sampled'] is False and
        row['semanticAdapterEnabled'] is enabled and row['studentPrompt'] == routing_messages(evidence, row['condition']) and
        row['samplingSeed'] == seed_for(row['experimentNumber'], 'experience_choice'), 'Routing choice provenance changed')
    validate_generation(row['studentOutput'], enabled)
    check = choice_audit(row['studentOutput'], evidence)
    require(row['check'] == check, 'Original literal choice audit changed')
    if root is not None:
        require(check['selectionVerified'] and root == source_root(next(h for h in evidence['training']
            if h['historyId'] == check['historyId']), evidence), 'Source ZIP differs from actual student choice')
    return check


def observation_messages(choice, evidence, root):
    require(choice['condition'] in OBSERVATION_CONDITIONS, 'Control arm cannot be a fallback source')
    validate_choice(choice, evidence, root)
    return selected_observation_input(root)


def note_root(choice, row, evidence, root):
    validate_choice(choice, evidence, root)
    require(choice['condition'] in OBSERVATION_CONDITIONS and row.get('fixtureOnly') is False and
        row['protocol'] == PROTOCOL and row['phase'] == 'experience_observation' and
        row['condition'] == choice['condition'] and row['experimentNumber'] == choice['experimentNumber'] and
        row['sourceChoiceRecordId'] == choice['recordId'] and row['evidenceHash'] == evidence['evidenceHash'] and
        row['sampled'] is False and row['semanticAdapterEnabled'] is choice['semanticAdapterEnabled'] and
        row['samplingSeed'] == seed_for(row['experimentNumber'], 'experience_observation') and
        row['studentPrompt'] == observation_messages(choice, evidence, root), 'Observation provenance differs')
    validate_generation(row['studentOutput'], row['semanticAdapterEnabled'])
    check = observation_audit(row['studentOutput'], evidence, root)
    require(row['check'] == check, 'Unchanged v2 hypothesis audit differs')
    return seal(dict(id='R1' if choice['condition'] == 'separate_semantic' else 'R2', protocol=PROTOCOL,
        condition=choice['condition'], studentChoice=copy.deepcopy(choice), studentObservation=copy.deepcopy(row),
        sourceZip=copy.deepcopy(root), sourceEvidenceHash=evidence['evidenceHash'], observationAudit=check,
        eligibleForFrozenContext=check['experimentalContextEligible'], author='student', hypothesisOnly=True,
        certifiedPart='actual_student_selection_and_original_source_binding_only', wholeNoteTruthVerified=False,
        productionActive=False, trainingUpdates=0, reuseEffectTested=False), 'noteHash')


def validate_note(note, evidence):
    require(note == note_root(note['studentChoice'], note['studentObservation'], evidence, note['sourceZip']),
        'Native routing note differs from whole original choice and observation')


def run_experiment(evidence, number, generate, save, frozen, remaining, read_source, install, read_notes):
    validate_evidence(evidence); evidence_hash = digest(evidence); originals = []; choices = {}; installed = []
    def guard():
        frozen()
        require(digest(evidence) == evidence_hash and all(digest(row) == h for row, h in originals),
            'Evidence or an earlier student original changed')
    def deadline():
        if remaining() <= 0: raise TimeoutError('Routing deadline before dependent action')
    def ask(phase, name, prompt, source_id=None):
        deadline(); guard(); _, form, enabled = condition_spec(name)
        require(len(originals) < MAX_GENERATIONS, 'Six-generation routing cap')
        seed = seed_for(number, phase); value = generate(prompt, phase, seed, False, enabled)
        row = dict(recordId=name + '-' + phase, protocol=PROTOCOL, experimentNumber=number, phase=phase,
            condition=name, promptForm=form, semanticAdapterEnabled=enabled, sampled=False, samplingSeed=seed,
            studentPrompt=prompt, studentOutput=value, sourceChoiceRecordId=source_id,
            evidenceHash=evidence['evidenceHash'], fixtureOnly=False)
        save('raw', row); guard(); validate_generation(value, enabled)
        originals.append((copy.deepcopy(row), digest(row)))
        return row
    # All four selections are independent fixed calls. A failed literal
    # choice never skips another selection or causes an adaptive retry.
    for name, _, _ in scheduled_conditions(number):
        row = ask('experience_choice', name, routing_messages(evidence, name))
        scored = dict(row, check=choice_audit(row['studentOutput'], evidence))
        validate_choice(scored, evidence); save('scored', scored); choices[name] = scored
    # Only the two predeclared corrected interfaces may request observations.
    # A successful control never fills a failed corrected-interface choice.
    for name in OBSERVATION_CONDITIONS:
        choice = choices[name]; check = choice['check']
        if not check['selectionVerified']:
            save('observation-stage', dict(id=name, condition=name, requested=False, noteZipWritten=False,
                reason=check['reason'])); continue
        deadline(); guard(); root = read_source(check['historyId']); validate_choice(choice, evidence, root)
        save('source-read', dict(id=name, condition=name, sourceChoiceRecordId=choice['recordId'], root=root))
        row = ask('experience_observation', name, observation_messages(choice, evidence, root), choice['recordId'])
        scored = dict(row, check=observation_audit(row['studentOutput'], evidence, root)); save('scored', scored)
        note = note_root(choice, scored, evidence, root); save('note-candidate', note)
        if note['eligibleForFrozenContext']:
            deadline(); guard(); install(note); installed.append(copy.deepcopy(note))
        save('observation-stage', dict(id=name, condition=name, requested=True,
            noteZipWritten=note['eligibleForFrozenContext'], reason=note['observationAudit']['reason']))
    guard(); require(read_notes() == sorted(installed, key=lambda n:n['id']), 'Native whole observation ZIP replay differs')
    return choices


def summarize(raw, scored, notes, stages, reads, stop, number):
    require(len(raw) <= MAX_GENERATIONS, 'Routing generation budget exceeded')
    ids = {r['recordId']:r for r in raw}
    audits = {r['recordId']:{k:v for k,v in r.items() if k != 'check'} for r in scored}
    complete_audits = len(ids) == len(raw) and len(audits) == len(scored) and ids == audits
    choices = {r['condition']:r for r in scored if r['phase'] == 'experience_choice'}
    expected = {c[0] for c in CONDITIONS}
    complete = stop == 'completed' and complete_audits and len([r for r in scored if r['phase'] == 'experience_choice']) == 4 and set(choices) == expected
    if complete:
        require(len({r['samplingSeed'] for r in choices.values()}) == 1 and
            [r['condition'] for r in raw if r['phase'] == 'experience_choice'] == [c[0] for c in scheduled_conditions(number)],
            'Fixed selection schedule or paired seeds changed')
        for form in ('combined', 'separate'):
            require(choices[form+'_semantic']['studentPrompt'] == choices[form+'_native']['studentPrompt'],
                'Adapter pair prompts differ')
    cells = {}
    for name, form, enabled in CONDITIONS:
        row = choices.get(name); check = row['check'] if row else {}
        cells[name] = dict(responseReturned=any(r['phase']=='experience_choice' and r['condition']==name for r in raw),
            responseAudited=row is not None, promptForm=form, semanticAdapterEnabled=enabled,
            selectionVerified=bool(check.get('selectionVerified')), declined=bool(check.get('declined')),
            literalInterfaceValid=bool(check.get('selectionVerified') or check.get('declined')),
            selectedHistory=check.get('historyId'), reason=check.get('reason'))
    deltas = {}
    if complete:
        for endpoint in ('selectionVerified', 'literalInterfaceValid'):
            deltas[endpoint] = dict(separateMinusCombinedByAdapter={model:int(cells['separate_'+model][endpoint])-int(cells['combined_'+model][endpoint]) for model in ('semantic','native')},
                semanticMinusNativeByForm={form:int(cells[form+'_semantic'][endpoint])-int(cells[form+'_native'][endpoint]) for form in ('combined','separate')})
    if not complete: decision = 'fixed_comparison_incomplete_no_effect_readout'
    elif cells['separate_semantic']['selectionVerified']: decision = 'corrected_learned_interface_selected_history_observation_attempted'
    elif cells['separate_native']['selectionVerified']: decision = 'corrected_native_selected_history_learned_interface_not_selected_no_production_switch'
    elif any(c['selectionVerified'] for c in cells.values()): decision = 'only_combined_control_selected_no_host_fallback'
    elif any(c['literalInterfaceValid'] for c in cells.values()): decision = 'literal_interface_worked_but_no_history_selected'
    else: decision = 'no_valid_selection_in_four_fixed_conditions_stop_downstream_effect_claims'
    return dict(runCompletedNormally=stop=='completed', actualStudentGenerations=len(raw), allReturnedResponsesAudited=complete_audits,
        scheduledIndependentSelectionCalls=4, auditedSelectionResponses=len(choices), completeFixedInterfaceComparison=complete,
        conditionOrder=[c[0] for c in scheduled_conditions(number)], byCondition=cells,
        descriptiveSingleContextDifferences=deltas if complete else None, decision=decision,
        actualSelectedSourceZipReads=len(reads), observationResponses=sum(r['phase']=='experience_observation' for r in scored),
        sourceBoundStudentHypothesisZips=sum(n['eligibleForFrozenContext'] for n in notes),
        observationStagesProcessed=len(stages), cappedResponses=sum(bool(r['studentOutput'].get('tokenCapReached')) for r in raw),
        truthCertifiedStudentNotes=0, semanticSelfAnalysisProved=False, diagnosisUsefulnessVerified=False,
        memoryReuseEffectTested=False, mathematicalBenefitTested=False,
        fixedFrozenDiagnosticIsNotTraining=True, independentTrainingReplications=0,
        independentHistoryContexts=int(complete), fourConditionsAreNotIndependentContexts=True,
        statisticalSignificanceClaimed=False, oldV1AndV2AuditsAndScoresUnchanged=True,
        correctedPromptKeepsAllOriginalWords=True, independentCurrentUserTurn=True,
        hostChoosesHistory=False, hostChoosesMetric=False, hostWritesStudentObservation=False,
        forcedGrammar=False, adaptiveRetries=False, nativeControlIsNotAnAutomaticFallback=True,
        automaticCandidateActivation=False, productionBankUpdated=False,
        heldoutEnteredSelectionOrObservation=False, metricTableSupplied=False,
        actualMeasurementZipExecutions=0, trainingUpdates=0, teacherCalls=0)
