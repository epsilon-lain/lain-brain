"""Bypass only the mathematical LoRA during explicitly scheduled retrieval slots."""
import copy

EXPECTED_V3_AGENT_HASHES = {
    'keyword_zip_run.py': '7315abe692107af74eec700df3e21f52eaef3394d134a20abc555475f733bf05',
    'typed_zip_core.py': '0dd6764c8d2822716ac90e613346c4b1ef2e1d7772c137af84a2693cc14276ff',
}
HISTORICAL_ARMS = {'base_router_zip_loop': 'typed_zip_loop',
                   'base_router_empty_loop': 'typed_empty_loop',
                   'directed_math_control': 'directed_math_control'}


def writer_enabled_for(arm, stage):
    if arm not in HISTORICAL_ARMS or stage not in {'keywords', 'reference_id', 'math'}:
        raise ValueError('Undeclared generation route')
    return stage == 'math' or arm == 'directed_math_control'


def invoke_adapter_route(adapter, generate, writer_enabled):
    """Use the original adapter's exception-safe context manager; do not change tensors."""
    if type(writer_enabled) is not bool or adapter.enabled is not True:
        raise ValueError('The frozen math adapter must be enabled outside generation')
    with adapter.active(writer_enabled):
        if adapter.enabled is not writer_enabled:
            raise ValueError('Requested adapter route was not activated')
        output = generate()
        observed = adapter.enabled
    # The caller persists this output before checking weights, parsing or auditing it.
    return dict(output, mathAdapterEnabledDuringGeneration=observed,
                generationRoute='reward_on_math_writer' if observed else 'frozen_base_retrieval')


def compare_historical_slots(episodes, prior_actions):
    """Pair complete saved slots; never extract useful fragments or replace old ratings."""
    comparisons = []; unmatched = []
    for episode in episodes:
        old_arm = HISTORICAL_ARMS[episode['arm']]
        for row in episode['actions']:
            matches = [old for old in prior_actions
                if old['arm'] == old_arm and old['task']['id'] == row['task']['id']
                and old.get('stage') == row['stage']
                and old.get('roundNumber') == row['roundNumber']
                and old['actionNumber'] == row['actionNumber']]
            if len(matches) != 1:
                unmatched.append(dict(arm=row['arm'], stage=row['stage'], actionNumber=row['actionNumber'],
                    reason='no_unique_saved_v3_slot'))
                continue
            old = matches[0]
            before = old['studentOutput']; after = row['studentOutput']
            match = dict(prompt=old['studentPrompt'] == row['studentPrompt'],
                currentExpression=old['currentBefore'] == row['currentBefore'],
                task=old['task'] == row['task'], samplingSeed=old['samplingSeed'] == row['samplingSeed'],
                promptTokenIds='promptIds' in before and 'promptIds' in after
                    and before['promptIds'] == after['promptIds'],
                greedyDecoding=before.get('sampled') is False and after.get('sampled') is False,
                temperature=before.get('temperature') == after.get('temperature') == 1.)
            exact = all(match.values())
            comparisons.append(dict(arm=row['arm'], stage=row['stage'], actionNumber=row['actionNumber'],
                savedBaselineArm=old_arm, match=match, exactPromptInputAndSeedMatch=exact,
                baselineMathAdapterEnabled=True,
                currentMathAdapterEnabled=after.get('mathAdapterEnabledDuringGeneration'),
                baselineAccepted=old['check']['accepted'], currentAccepted=row['check']['accepted'],
                baselineRaw=before['raw'], currentRaw=after['raw'],
                rawUnchanged=before['raw'] == after['raw'],
                generatedIdsUnchanged=before.get('generatedIds') == after.get('generatedIds')
                    if 'generatedIds' in before and 'generatedIds' in after else None,
                baselineCheck=copy.deepcopy(old['check']), currentCheck=copy.deepcopy(row['check']),
                adapterOnlyIntervention=exact and row['stage'] in {'keywords', 'reference_id'}
                    and after.get('mathAdapterEnabledDuringGeneration') is False))
    retrieval = [pair for pair in comparisons if pair['adapterOnlyIntervention']]
    math = [pair for pair in comparisons if pair['stage'] == 'math'
        and pair['exactPromptInputAndSeedMatch'] and pair['currentMathAdapterEnabled'] is True]
    return dict(baseline='saved_actual_v3_slots', newBaselineGenerations=0,
        savedV3GeneratorHashesChecked=True, comparisons=comparisons, unmatchedSlots=unmatched,
        matchedRetrievalSlots=len(retrieval),
        retrievalFormatRecoveries=sum(not p['baselineAccepted'] and p['currentAccepted'] for p in retrieval),
        retrievalFormatRegressions=sum(p['baselineAccepted'] and not p['currentAccepted'] for p in retrieval),
        matchedControlMathSlots=len(math),
        exactControlMathReproductions=sum(p['rawUnchanged'] and p['generatedIdsUnchanged'] is True for p in math),
        historicalBaselineRatherThanConcurrentRandomization=True,
        independentFreshProblems=0, generalAdapterInterferenceProved=False, descriptiveOnly=True)
