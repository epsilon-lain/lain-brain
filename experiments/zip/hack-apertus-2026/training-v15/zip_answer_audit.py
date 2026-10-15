"""Read-only, exact regrading of written answers, equality steps, and format.

Only presentation is normalized. No missing terms, new variable identities,
answers, or unwritten equality steps are supplied. Prose is never certified.
"""
import hashlib
import json
from pathlib import Path
import re

from zip_content_core import OutsideScope, digest, parse_expression, verify_claim
from zip_guided_helpers import (application, expression_key, normalize_surface,
                               simplified_polynomial_surface)

GRADE_VERSION = 'lain-zip-answer-and-equality-audit-v1'
CONDITIONS = ('zip', 'no_zip', 'ordinary_text', 'mismatched_zip')
FINAL_PREFIX = re.compile(
    r'^(?:(?:Therefore|Thus|Hence|So)[,:]?\s*)?(?:The\s+)?'
    r'(?:(?:final|simplified)\s+){0,2}(?:answer|expression|result)'
    r'(?:\s+is\s*:?|\s*:)\s*(.*)$', re.I)


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2,
                               allow_nan=False) + '\n', encoding='utf-8')


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def file_hash(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def clean_math(text):
    text = text.strip()
    # Strip bold spans only at markup boundaries: **2** is markup, u**2 is not.
    text = re.sub(r'(?<![A-Za-z0-9_)])\*\*(?=\S)(.+?)\*\*'
                  r'(?![A-Za-z0-9_(])', r'\1', text)
    text = text.strip()
    if text.endswith('.'):
        text = text[:-1].rstrip()
    normalized, changes = normalize_surface(text)
    if normalized != text:
        changes = ['presentation'] + changes
    parse_expression(normalized)
    return normalized, changes


def math_parts(text):
    parts = text.split('=')
    if len(parts) > 16 or any(not p.strip() for p in parts):
        raise OutsideScope('Empty or overlong equality chain')
    return [clean_math(p)[0] for p in parts]


def extract(raw):
    """Parse whole math lines and explicit final-answer markers, never fragments."""
    result = dict(statements=[], finalMarkers=[], uninterpretedLines=[],
                  extractionComplete=True, abstention=False)
    if not isinstance(raw, str) or len(raw) > 16000:
        return dict(result, extractionComplete=False, reason='Response bounds')
    if raw.strip().lower() in {'unknown', 'skip', '**unknown**', '**unknown**\nunknown'}:
        return dict(result, abstention=True)
    text = raw.strip()
    fence = re.fullmatch(r'```(?:python|math|text)?\s*\n([\s\S]*?)\n?```', text, re.I)
    if fence:
        text = fence[1].strip()
    try:
        parts = math_parts(text)
        result['statements'].append(dict(parts=parts, raw=text, kind='whole_math'))
        return result
    except OutsideScope:
        pass
    lines = text.splitlines()
    if len(lines) > 80:
        return dict(result, extractionComplete=False, reason='Line bounds')
    pending_final = False
    previous_terminal = None
    for index, raw_line in enumerate(lines):
        line = raw_line.strip()
        if not line:
            continue
        # Balanced display wrappers split over lines carry no mathematical claim.
        if line in {'\\[', '\\]', '$$', '```', '```python', '```math', '```text'}:
            continue
        label = re.sub(r'^\*\*(.*?)\*\*', r'\1', line)
        marker = FINAL_PREFIX.fullmatch(label)
        if marker:
            line = marker[1].strip()
            if not line:
                pending_final = True
                continue
            is_final = True
        else:
            is_final = pending_final
        try:
            continuation = line.startswith('=')
            if continuation:
                if previous_terminal is None:
                    raise OutsideScope('Equality continuation has no written preceding expression')
                tail = math_parts(line[1:])
                parts = [previous_terminal] + tail
            else:
                parts = math_parts(line)
            result['statements'].append(dict(parts=parts, raw=raw_line,
                kind='final_marker' if is_final else 'math_line', line=index + 1,
                continuation=continuation))
            previous_terminal = parts[-1]
            if is_final:
                result['finalMarkers'].append(parts[-1])
            pending_final = False
        except OutsideScope:
            result['uninterpretedLines'].append(dict(line=index + 1, raw=raw_line))
            result['extractionComplete'] = False
            pending_final = False
            previous_terminal = None
    if pending_final:
        result['extractionComplete'] = False
        result['reason'] = 'Final marker has no written expression'
    return result


def equality(left, right):
    return verify_claim(dict(operation='rewrite', input=left, output=right,
                             variable='', scope='real_polynomial'))


def grade(row, output, tools=()):
    raw = output['raw']
    extracted = extract(raw)
    statements = extracted['statements']
    task_names = set(parse_expression(row['expression'])[2])
    steps = []
    for statement in statements:
        for left, right in zip(statement['parts'], statement['parts'][1:]):
            proof = equality(left, right)
            outside = sorted((set(parse_expression(left)[2]) | set(parse_expression(right)[2])) - task_names)
            steps.append(dict(left=left, right=right, verification=proof,
                              sourceLine=statement.get('line'), extraTaskVariables=outside))
    rejected = sum(s['verification']['status'] == 'rejected' for s in steps)
    verified = sum(s['verification']['accepted'] for s in steps)
    uncertain = sum(s['verification']['status'] == 'pending' for s in steps)
    cap = bool(output.get('tokenCapReached', False))
    candidate = None
    ambiguous = False
    if extracted['finalMarkers']:
        candidate = extracted['finalMarkers'][-1]
        ambiguous = any(not equality(c, candidate)['accepted']
                        for c in extracted['finalMarkers'])
    elif statements:
        candidate = statements[-1]['parts'][-1]
    extra_names = []
    final_proof = None
    if candidate is not None:
        extra_names = sorted(set(parse_expression(candidate)[2]) - task_names)
        final_proof = equality(row['expression'], candidate)
    content = bool(final_proof and final_proof['accepted'] and not extra_names and not ambiguous)
    correct = content and not cap
    simplified = correct and simplified_polynomial_surface(candidate)
    unchanged = bool(candidate is not None and expression_key(candidate) == expression_key(row['expression']))
    matched_rule = bool(candidate is not None and any(
        call and expression_key(call['output_text']) == expression_key(candidate)
        for call in (application(t, row['expression']) for t in tools)))
    local = correct and not unchanged and (simplified or matched_rule)
    if rejected:
        derivation = 'rejected'
    elif uncertain or not extracted['extractionComplete']:
        derivation = 'pending'
    elif steps:
        derivation = 'verified'
    elif len(statements) <= 1:
        derivation = 'no_steps'
    else:
        # No equality is invented between disconnected expression lines.
        derivation = 'pending'
    strict = False
    if candidate is not None:
        try:
            parse_expression(raw.strip())
            strict = expression_key(raw.strip()) == expression_key(candidate)
        except OutsideScope:
            pass
    if extracted['abstention']:
        fmt = 'abstention'
    elif strict:
        fmt = 'single_expression'
    elif extracted['finalMarkers'] or extracted['uninterpretedLines']:
        fmt = 'prose_or_final_marker'
    elif steps:
        fmt = 'equality_chain'
    elif candidate is not None:
        fmt = 'presentation_wrapped_expression'
    else:
        fmt = 'unparsed'
    if ambiguous:
        status = 'conflicting_final_answers'
    elif extra_names:
        status = 'invalid_task_variables'
    elif cap:
        status = 'unfinished'
    elif final_proof:
        status = final_proof['status']
    else:
        status = 'pending'
    return dict(graderVersion=GRADE_VERSION, finalStatus=status,
        writtenFinalExpression=candidate, completed=not cap,
        finalContentEquivalent=content, correctFinalAnswer=correct,
        correctSimplifiedAnswer=simplified, correctNontrivialRewrite=local,
        equivalentButUnsimplified=correct and not simplified,
        unchangedQuestionCopy=unchanged, matchesStoredApplicationSurface=matched_rule,
        finalVerification=final_proof, extraTaskVariables=extra_names,
        conflictingFinalMarkers=ambiguous, derivationStatus=derivation,
        writtenEqualitySteps=steps, verifiedEqualitySteps=verified,
        falseEqualitySteps=rejected, unsupportedEqualitySteps=uncertain,
        allWrittenEqualitiesCorrect=bool(steps) and not rejected and not uncertain,
        mathematicalProseCertified=False, extractionComplete=extracted['extractionComplete'],
        equalityStepsOutsideTaskVariables=sum(bool(s['extraTaskVariables']) for s in steps),
        uninterpretedLines=extracted['uninterpretedLines'],
        formatStatus=fmt, strictInterfaceCorrect=simplified and strict,
        tokenCapReached=cap, abstention=extracted['abstention'],
        rawHash=digest(raw), mathematicalResultRepaired=False,
        unwrittenIntermediateEqualitiesInserted=False)


def condition_counts(records):
    result = {}
    for condition in CONDITIONS:
        checks = [r['answerCheck'] for r in records if r['condition'] == condition]
        result[condition] = dict(questions=len(checks),
            finalAnswersEquivalent=sum(c['correctFinalAnswer'] for c in checks),
            completedSimplifiedAnswers=sum(c['correctSimplifiedAnswer'] for c in checks),
            correctNontrivialRewrites=sum(c['correctNontrivialRewrite'] for c in checks),
            equivalentButUnsimplified=sum(c['equivalentButUnsimplified'] for c in checks),
            unchangedQuestionCopies=sum(c['unchangedQuestionCopy'] for c in checks),
            falseDerivations=sum(c['derivationStatus'] == 'rejected' for c in checks),
            verifiedEqualitySteps=sum(c['verifiedEqualitySteps'] for c in checks),
            falseEqualitySteps=sum(c['falseEqualitySteps'] for c in checks),
            outsideTaskVariables=sum(bool(c['extraTaskVariables']) for c in checks),
            strictInterfaceCorrect=sum(c['strictInterfaceCorrect'] for c in checks),
            atTokenCap=sum(c['tokenCapReached'] for c in checks),
            pendingFinalAnswers=sum(c['finalStatus'] == 'pending' for c in checks))
    return result


def paired(records, other='no_zip', criterion='correctSimplifiedAnswer'):
    a = {r['caseId']: r for r in records if r['condition'] == 'zip'}
    b = {r['caseId']: r for r in records if r['condition'] == other}
    common = sorted(set(a) & set(b))
    ac = [bool(a[k]['answerCheck'][criterion]) for k in common]
    bc = [bool(b[k]['answerCheck'][criterion]) for k in common]
    return dict(pairedQuestions=len(common), criterion=criterion, otherCondition=other,
        zipCorrect=sum(ac), otherCorrect=sum(bc),
        zipOnlyCorrect=sum(x and not y for x, y in zip(ac, bc)),
        otherOnlyCorrect=sum(y and not x for x, y in zip(ac, bc)),
        bothCorrect=sum(x and y for x, y in zip(ac, bc)),
        neitherCorrect=sum(not x and not y for x, y in zip(ac, bc)),
        correctnessDifference=sum(ac) - sum(bc),
        accuracyDifference=(sum(ac) - sum(bc)) / len(common) if common else None,
        descriptiveOnly=True)


def summarize(records):
    return dict(conditions=condition_counts(records),
        zipVsNoZip=paired(records), zipVsOrdinaryText=paired(records, 'ordinary_text'),
        localRewriteZipVsNoZip=paired(records, criterion='correctNontrivialRewrite'),
        mathematicalPrincipleCount=1, storedMatchingForms=2)


def audit_archive(source, out, tools):
    """Read saved raw files; never call a model, optimizer, teacher, or old grader."""
    source, out = Path(source), Path(out)
    before = {str(p.relative_to(source)): file_hash(p) for p in sorted(source.rglob('*'))
              if p.is_file()}
    paths = [p for p in sorted(source.glob('question-*.json')) if re.fullmatch(
        r'question-\d{2}-(zip|no_zip|ordinary_text|mismatched_zip)\.json', p.name)]
    if len(paths) != 64:
        raise ValueError('Expected the 64 archived actual answer records')
    records, identities = [], set()
    for path in paths:
        old = read(path)
        identity = (old['caseId'], old['condition'])
        if identity in identities:
            raise ValueError('Duplicate archived question/condition')
        identities.add(identity)
        original = read(path.with_name(path.stem + '-raw.json'))
        if original['studentOutput'] != old['studentOutput']:
            raise ValueError('Archived raw and scored generation differ')
        task = old['task']
        if task != original['task'] or old['studentPrompt'] != original['studentPrompt']:
            raise ValueError('Archived prompt or task differs')
        check = grade(task, old['studentOutput'], tools)
        item = dict(caseId=old['caseId'], questionIndex=old['questionIndex'],
            family=old['family'], condition=old['condition'], task=task,
            studentPrompt=old['studentPrompt'], studentOutput=old['studentOutput'],
            answerCheck=check, oldAnswerCheck=old['answerCheck'],
            sourceScoredFile=str(path), sourceRawFile=str(path.with_name(path.stem+'-raw.json')),
            sourceScoredHash=before[str(path.relative_to(source))],
            actualStudentGeneration=old.get('actualStudentGeneration', False))
        records.append(item)
        write(out / path.name, item)
    if len({r['caseId'] for r in records}) != 16 or any(
            sum(r['caseId'] == k for r in records) != 4 for k, _ in identities):
        raise ValueError('Expected 16 complete four-condition questions')
    for case_id, _ in identities:
        group = [r for r in records if r['caseId'] == case_id]
        if any(r['task'] != group[0]['task'] or r['questionIndex'] != group[0]['questionIndex']
               or r['family'] != group[0]['family'] for r in group):
            raise ValueError('Archived conditions do not contain the same paired task')
    old_summary = read(source/'result.json').get('summary')
    changes = [dict(caseId=r['caseId'], condition=r['condition'],
        oldCorrectSimplified=bool(r['oldAnswerCheck'].get('correctSimplifiedAnswer')),
        newCorrectSimplified=r['answerCheck']['correctSimplifiedAnswer'],
        studentRaw=r['studentOutput']['raw']) for r in records
        if bool(r['oldAnswerCheck'].get('correctSimplifiedAnswer')) != r['answerCheck']['correctSimplifiedAnswer']]
    after = {str(p.relative_to(source)): file_hash(p) for p in sorted(source.rglob('*'))
             if p.is_file()}
    result = dict(protocol='lain-zip-readonly-answer-audit-v1', records=len(records),
        actualArchiveReviewed=all(r['actualStudentGeneration'] and not
            r['studentOutput'].get('testDouble') for r in records),
        generations=0, trainingUpdates=0, teacherCalls=0,
        rawOutputsPreserved=before == after, historicalScoresChanged=False,
        historicalRewardsChanged=False, oldSummary=old_summary,
        correctedSummary=summarize(records), changedFinishedAnswerScores=changes,
        graderVersion=GRADE_VERSION, mathematicalProseCertified=False,
        referenceAnswersRead=False, studentDiscoveriesCounted=0)
    write(out/'result.json', result)
    if before != after:
        raise RuntimeError('Read-only archive preservation check failed')
    return result, records
