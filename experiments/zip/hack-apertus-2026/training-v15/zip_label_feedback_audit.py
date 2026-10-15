"""Versioned task grounding and separate feedback on original student text.

Legacy audits remain available and unchanged. The new protocol checks exact
polynomial task equivalence independently of presentation, then requires an
actual changed step and a bounded replay of the selected frozen rule.
"""
import copy
import json

from zip_content_core import OutsideScope, digest, parse_expression, verify_claim
from zip_guided_helpers import expression_key, normalize_surface
from zip_answer_audit import math_parts
from tool_loop_kernel import (claim, surface_key, _combine_options, _distribution_options)
from object_choice_core import audit_math as legacy_audit_math

PROTOCOL = 'exact-task-equivalence-with-selected-rule-replay-v1'
ITERATION_PROTOCOL = 'lain-zip-label-feedback-fix-v4'
SOURCE_RESULT_SHA256 = 'a9c7bac643d1fc6b0651bb8aa93b97b8eedaf1adbefc5b7f4df629b963732d76'


def single_equality(task_input, response):
    raw = response['raw']
    result = dict(status='pending', parsed=False, rawHash=digest(raw),
        reason='One complete equality is required', hostFilledMathematics=False,
        scoringProtocol=PROTOCOL)
    if raw.strip().upper() in {'SKIP', 'UNKNOWN'}:
        return dict(result, status='skip', reason='Explicit abstention')
    text, presentation = normalize_surface(raw)
    if text.count('=') != 1:
        return result
    try:
        try:
            left, right = math_parts(raw)
        except OutsideScope:
            left, right = math_parts(text)
        _, _, left_names = parse_expression(left)
        _, _, right_names = parse_expression(right)
        _, _, task_names = parse_expression(task_input)
        exact = verify_claim(claim(left, right))
        grounding = verify_claim(claim(task_input, left))
        outside = sorted((set(left_names) | set(right_names)) - set(task_names))
        syntactic = expression_key(left) == expression_key(task_input)
        result.update(parsed=True, left=left, right=right, claim=claim(left,right),
            exactAudit=exact, taskEquivalenceAudit=grounding,
            sourceMatchesTask=bool(grounding['accepted']),
            sourceSyntaxMatchesTask=syntactic, outsideTaskVariables=outside,
            presentationNormalizations=['bounded_math_parts']+presentation,
            completeTextCoverage=True, tokenCapReached=bool(response.get('tokenCapReached')),
            originalTask=task_input, originalStudentLeft=left,
            originalStudentRight=right, studentTextRepaired=False)
        if exact['status'] == 'rejected':
            return dict(result,status='rejected',reason='Written equality has an exact nonzero residual')
        if outside:
            return dict(result,reason='Written expression introduces variables outside the task')
        if response.get('tokenCapReached'):
            return dict(result,reason='Student generation reached its token budget; completion unconfirmed')
        if not grounding['accepted']:
            return dict(result,reason='Written left side is not exactly equivalent to the current task')
        if not exact['accepted']:
            return dict(result,reason='Written equality has no accepted exact certificate')
        # Copying or reversing to the unchanged task is not a successful rewrite.
        if (surface_key(left) == surface_key(right) or
                surface_key(task_input) == surface_key(right)):
            return dict(result,status='no_progress',reason='Only copying, AC formatting or numeric folding')
        return dict(result,status='verified',reason='Complete changed equality with exact task equivalence')
    except OutsideScope as error:
        return dict(result,reason=str(error))


def support_selected_rule(task_input, parsed, tool, kind):
    record = copy.deepcopy(parsed)
    if record['status'] != 'verified':
        return dict(record,toolSupported=False)
    try:
        source_check = verify_claim(tool['rule'])
        if not source_check['accepted'] or not source_check['reusable']:
            return dict(record,status='blocked',toolSupported=False,
                reason='Frozen rule failed exact re-verification')
        if kind not in {'combine','distribute'}:
            raise ValueError('Unknown selected route kind')
        # Replay on the GIVEN task, never a host-completed student left side.
        # Exact task grounding already relates the student's written source to
        # this input. The output is matched only under the old surface background.
        options = (_combine_options(task_input,tool,False) if kind=='combine' else
                   _distribution_options(task_input,tool,False))
        for transformed,replay in options:
            if surface_key(transformed) == surface_key(record['right']):
                return dict(record,toolSupported=True,toolId=tool['id'],toolVersion=tool['version'],
                    sourceClaimHash=digest(tool['rule']),sourceRuleRechecked=True,
                    kind=kind,replay=replay,rootCertificate=source_check['certificate'],
                    replaySourceIsOriginalTask=True,
                    replaySourceTaskEquivalenceCertificate=parsed['taskEquivalenceAudit'],
                    kernelBackground='addition/multiplication AC, multiplicative unit, closed rational arithmetic',
                    mathematicalOutputComputedOnlyAfterStudentResponse=True)
        return dict(record,status='pending',toolSupported=False,
            reason='True grounded equality lacks the selected frozen-rule replay')
    except OutsideScope as error:
        return dict(record,status='pending',toolSupported=False,reason=str(error))


def truth_value(audit):
    if not audit:
        return None
    if audit.get('accepted'):
        return True
    return False if audit.get('status')=='rejected' else None


def audit_math(task,output,candidate):
    legacy = legacy_audit_math(task,output,candidate)
    parsed = single_equality(task['expression'],output)
    replay = (None if candidate['kind']=='direct' else
              support_selected_rule(task['expression'],parsed,candidate['root'],candidate['kind']))
    true_grounded = bool(parsed.get('parsed') and parsed.get('sourceMatchesTask') and
        not parsed.get('outsideTaskVariables') and not output.get('tokenCapReached') and
        parsed.get('exactAudit',{}).get('accepted'))
    passed = parsed['status']=='verified' and (replay is None or replay.get('toolSupported') is True)
    facts = dict(writtenEqualityTrue=truth_value(parsed.get('exactAudit')),
        writtenLeftEquivalentToTask=truth_value(parsed.get('taskEquivalenceAudit')),
        originalLeftSyntaxPreserved=parsed.get('sourceSyntaxMatchesTask') if parsed.get('parsed') else None,
        onlyTaskVariablesUsed=not bool(parsed.get('outsideTaskVariables')) if parsed.get('parsed') else None,
        completeSingleEquality=bool(parsed.get('parsed') and not output.get('tokenCapReached')),
        actualRewriteProgress=parsed['status']=='verified',
        selectedToolRequired=candidate['kind']!='direct',
        selectedToolSupported=(replay.get('toolSupported') if replay and parsed['status']=='verified' else None),
        outcomePassed=bool(passed))
    reasons = []
    if not parsed.get('parsed'): reasons.append('missing_or_unparsed_complete_equality')
    if output.get('tokenCapReached'): reasons.append('incomplete_generation')
    if facts['writtenEqualityTrue'] is False: reasons.append('written_mathematical_identity_false')
    if facts['writtenLeftEquivalentToTask'] is False: reasons.append('different_task_input')
    if facts['onlyTaskVariablesUsed'] is False: reasons.append('outside_task_variables')
    if parsed['status']=='no_progress': reasons.append('no_actual_rewrite_progress')
    if parsed['status']=='verified' and replay and not replay.get('toolSupported'):
        reasons.append('selected_tool_did_not_support_this_step')
    return dict(completeEqualityCheck=parsed,mathematicallyCorrectWrittenEquality=true_grounded,
        changedCurrentMathematics=parsed['status']=='verified',selectedToolReplay=replay,
        outcomePassed=bool(passed),reward=1. if passed else -1.,rewardForMerelySelectingZip=0.,
        hostFilledMathematics=False,scoringProtocol=PROTOCOL,auditFacts=facts,
        failureReasons=reasons,legacyStrictAudit=legacy,
        legacyOutcomePassed=legacy['outcomePassed'],oldArchiveScoreChanged=False,
        presentationDifferenceNotMathematicalFailure=bool(parsed.get('parsed') and
            parsed.get('sourceMatchesTask') and not parsed.get('sourceSyntaxMatchesTask')))


def feedback_for(check):
    # Only facts about this retained actual attempt. No output, replacement
    # expression, binding, certificate residual, task family or correct-tool label.
    return dict(scoringProtocol=PROTOCOL,facts=copy.deepcopy(check['auditFacts']),
        failureReasons=list(check['failureReasons']),unknownFactsRemainUnknown=True)


def diagnostic(task,output,candidate,check):
    return dict(category=('verified_outcome' if check['outcomePassed'] else
        '+'.join(check['failureReasons']) or 'unresolved_exact_audit'),
        facts=copy.deepcopy(check['auditFacts']),
        failureReasons=list(check['failureReasons']),
        originalTextSavedBeforeAudit=True,programCorrectedAnswerOrBindingsSupplied=False,
        scoringProtocol=PROTOCOL)


def replay_case_diagnostics(raws):
    cases=[]
    for row in raws:
        if row.get('phase') not in ('training_route_math','heldout_route_math','retest_route_math'):
            continue
        check=audit_math(row['task'],row['studentOutput'],row['selectedCandidate'])
        cases.append(dict(recordId=row['recordId'],taskId=row['task']['id'],
            legacyOutcomePassed=check['legacyOutcomePassed'],
            newProtocolWouldPass=check['outcomePassed'],auditFacts=check['auditFacts'],
            failureReasons=check['failureReasons'],oldArchiveScoreChanged=False))
    return dict(scoringProtocol=PROTOCOL,cases=cases,
        diagnosticsOnly=True,oldArchiveScoreChanged=False,studentCalls=0,trainingUpdates=0)
