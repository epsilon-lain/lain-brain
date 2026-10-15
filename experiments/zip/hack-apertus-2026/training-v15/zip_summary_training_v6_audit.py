"""Read-only literal checks; original words, scores and mathematics are retained.

Presentation is masked at the SAME character offsets. Unsupported equality
syntax remains pending, rather than disappearing from the trial admission check.
No missing expression, variable binding, ending or explanation is supplied.
"""
import ast
import re

from zip_content_core import OutsideScope, parse_expression, verify_claim
from zip_summary_training_v3_core import audit_summary as legacy_audit

AUDIT_PROTOCOL = 'selected-experience-literal-audit-v6'
MAX_SUMMARY_TOKENS = 128
MAX_SUMMARY_WORDS = 40


def presentation_view(raw):
    """Mask only delimiters; indices still refer to the untouched original."""
    view = list(raw)
    pattern = r'(?<![\w)])\*\*(?=\S)(.+?)\*\*(?![\w(])'
    for match in re.finditer(pattern, raw):
        for start, end in ((match.start(), match.start(1)), (match.end(1), match.end())):
            view[start:end] = ' ' * (end - start)
    for i, char in enumerate(raw):
        if char in '`$':
            view[i] = ' '
    return ''.join(view)


def quote_spans(raw):
    return [(m.start(), m.end(), m.group(1)) for pattern in
        (r'(?<!`)`([^`\n]+)`(?!`)', r'"([^"\n]+)"', r'“([^”\n]+)”')
        for m in re.finditer(pattern, raw)]


def selected_route(event):
    return next(r for r in event['routes'] if r['recordId'] == event['selectedRouteRecordId'])


def outcome_claims(raw, event):
    view = presentation_view(raw)
    quotes = quote_spans(raw)
    actual = selected_route(event)['check']['outcomePassed']
    subject = r'(?:(?:(?:the|this|my|current|source|selected|chosen|actual)\s+){0,3}(?:task|attempt|route|experience|process))'
    outcome = (r'(?P<outcome>not\s+(?:successful|solved|completed)|still\s+(?:unsolved|unresolved)|'
        r'unsolved|unresolved|unsuccessful|successfully\s+(?:completed|solved|rewritten)|'
        r'successful|solved|failed|passed|succeeded|a\s+failure|a\s+success)')
    patterns = [r'(?:^|[.!?\n])\s*' + subject + r'\s+(?:(?:is|was|remains|remained|has\s+been)\s+)?' + outcome + r'\b',
        r'(?:^|[.!?\n])\s*(?:Completed\s+task:\s*)?(?P<outcome>Successfully\s+rewrote)\b',
        r'(?:^|[.!?\n])\s*(?P<outcome>Successful\s+rewrite)\s+(?:of|from|using|:)']
    rows = []
    for pattern in patterns:
        for match in re.finditer(pattern, view, re.I):
            if any(a <= match.start('outcome') < b for a, b, _ in quotes):
                continue
            claimed = not bool(re.search(r'not|unsolved|unresolved|unsuccessful|failed|failure', match['outcome'], re.I))
            end = match.end()
            if raw[end:end+2] == '**' and view[end:end+2] == '  ':
                end += 2
            rows.append(dict(span=[match.start(), end], literal=raw[match.start():end],
                claimedSuccess=claimed, actualSuccess=actual, binds='selected_route',
                sourceRouteRecordIds=[selected_route(event)['recordId']],
                explicitlyDisproved=claimed != actual, originalTextRepaired=False))
    for match in re.finditer(r'(?:^|[。！？\n])\s*(?:本题|这道题|当前任务|本次任务)(?:仍然|仍|尚)?(?:未解决|没有解决|成功|失败)', view):
        if any(a <= match.start() < b for a, b, _ in quotes):
            continue
        text = match.group(0)
        claimed = not any(word in text for word in ('未解决', '没有解决', '失败'))
        rows.append(dict(span=[match.start(), match.end()], literal=raw[match.start():match.end()],
            claimedSuccess=claimed, actualSuccess=actual, binds='selected_route',
            sourceRouteRecordIds=[selected_route(event)['recordId']],
            explicitlyDisproved=claimed != actual, originalTextRepaired=False))
    return rows


def _arithmetic(text):
    if not 0 < len(text) <= 500:
        return False
    try:
        tree = ast.parse(text.strip().replace('^', '**'), mode='eval')
    except (SyntaxError, ValueError, RecursionError):
        return False
    nodes = list(ast.walk(tree))
    allowed = (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Name, ast.Load,
        ast.Constant, ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.UAdd, ast.USub)
    return len(nodes) <= 160 and all(isinstance(n, allowed) and
        (not isinstance(n, ast.Constant) or type(n.value) in (int, float)) for n in nodes)


def _prose_tail(tail):
    tail = tail.lstrip()
    if not tail:
        return True
    if re.match(r'\.[.\d]', tail):
        return False
    if tail[0] in ',;.!?"\')]}':
        return True
    if re.match(r'\((?:[A-Z][A-Za-z]+\s+[A-Za-z]|[A-Z][A-Za-z]+,)', tail):
        return True  # A written prose annotation, not an invented math term.
    return bool(re.match(r'(?:because|which|while|where|so|therefore|is|was|means|using|and\s+(?:the|this))\b', tail, re.I))


def _expression_span(piece, suffix):
    """A complete written expression; never salvage a missing operator tail."""
    if len(piece) > 800:
        return None
    if suffix:
        end = len(piece.rstrip())
        for match in re.finditer(r'(?<!\w)(?:\d|\.\d|[^\W\d]|[\(+\-])', piece[:end]):
            start = match.start()
            prefix = piece[:start].rstrip()
            prose_wrapper = prefix == '(' or bool(re.search(r'(?:^|\s)[A-Za-z]{2,}\s*\($',prefix))
            if prefix and ((prefix[-1] in '+-*/^(' and not prose_wrapper) or prefix[-1].isdigit() or
                    re.search(r'(?:^|\s)[a-z]$',prefix)):
                continue
            text = piece[start:end]
            if _arithmetic(text):
                return start, end, text
    else:
        start = len(piece) - len(piece.lstrip())
        for end in range(len(piece.rstrip()), start, -1):
            text = piece[start:end].rstrip()
            actual_end = start + len(text)
            if text and _prose_tail(piece[actual_end:]) and _arithmetic(text):
                return start, actual_end, text
    return None


def inline_equalities(raw, event):
    """Audit literal inline pairs, including parenthetic formulas and Unicode.

Names unsupported by the existing verifier are reported as pending. This is
an exclusion check, not a truth certificate for an entire note.
"""
    view = presentation_view(raw)
    quotes = quote_spans(raw)
    sources = {r['studentOutput']['raw'].strip() for r in event['routes']}
    rows = []
    offset = 0
    for line in view.splitlines(keepends=True):
        equals = list(re.finditer(r'(?<![<>=!])=(?!=)', line))
        if len(equals) > 16:
            rows.append(dict(status='pending', reason='equality_chain_bound', span=[offset, offset+len(line)]))
            offset += len(line)
            continue
        for i, eq in enumerate(equals):
            position = offset + eq.start()
            quoted = next(((a,b,text) for a,b,text in quotes if a <= position < b), None)
            if quoted and quoted[2].strip() in sources:
                rows.append(dict(status='source_quote', reason='literal_whole_source_quote',
                    span=[quoted[0],quoted[1]], literal=raw[quoted[0]:quoted[1]], proseTruthCertified=False))
                continue
            left_start = equals[i-1].end() if i else 0
            right_end = equals[i+1].start() if i+1 < len(equals) else len(line)
            left_piece = line[left_start:eq.start()]
            right_piece = line[eq.end():right_end]
            left = _expression_span(left_piece, True)
            right = _expression_span(right_piece, False)
            looks_math = bool(re.search(r'\d|[+*/^()]|(?:^|\s)[a-z](?:\s|$)', left_piece+' '+right_piece))
            if left is None or right is None:
                if looks_math:
                    rows.append(dict(status='pending', reason='unparsed_or_incomplete_literal_equality',
                        span=[offset+left_start,offset+right_end],
                        literal=raw[offset+left_start:offset+right_end], missingMathematicsFilled=False))
                continue
            a = offset+left_start+left[0]
            b = offset+eq.end()+right[1]
            row = dict(span=[a,b], literal=raw[a:b], left=left[2], right=right[2],
                studentEqualityInvented=False, originalTextRepaired=False,
                presentationOnlyMaskUsed=True, wholeProseTruthCertified=False)
            try:
                parse_expression(left[2]); parse_expression(right[2])
                proof = verify_claim(dict(input=left[2],output=right[2],operation='rewrite',
                    variable='',scope='real_polynomial'))
                row.update(status=proof['status'], exactAudit=proof,
                    explicitlyDisproved=proof['status']=='rejected')
            except (OutsideScope, RecursionError):
                row.update(status='pending', reason='literal_math_outside_existing_verifier', explicitlyDisproved=False)
            rows.append(row)
        offset += len(line)
    return rows


def rule_support_claims(raw, event):
    view = presentation_view(raw)
    pattern = (r'\b(?:the\s+)?stored\s+rule\s+(?:support(?:s|ed)?|supporting)\s*'
        r'(?:(?:is|was)\s*)?:?\s*(?P<value>None|True|False)\b')
    route = selected_route(event)
    actual = route['check']['auditFacts']['selectedToolSupported']
    rows = []
    for match in re.finditer(pattern, view, re.I):
        if any(a <= match.start('value') < b for a,b,_ in quote_spans(raw)):
            continue
        claimed = {'none':None, 'true':True, 'false':False}[match['value'].lower()]
        rows.append(dict(span=[match.start(),match.end()],literal=raw[match.start():match.end()],
            claimedSupport=claimed, actualSupport=actual, sourceRouteRecordId=route['recordId'],
            explicitlyDisproved=claimed is not actual, originalTextRepaired=False))
    return rows


def audit_summary(output, event):
    audit = legacy_audit(output, event)
    raw = output['raw']
    claims = outcome_claims(raw,event)
    maths = inline_equalities(raw,event)
    support = rule_support_claims(raw,event)
    if any(c['explicitlyDisproved'] for c in claims):
        audit['reasons'].append('disproved_direct_experience_outcome')
    if any(c.get('explicitlyDisproved') for c in maths):
        audit['reasons'].append('disproved_inline_literal_identity')
    if any(c['status']=='pending' for c in maths):
        audit['reasons'].append('pending_unparsed_inline_mathematics')
    if any(c['explicitlyDisproved'] for c in support):
        audit['reasons'].append('disproved_selected_rule_support')
    words = len(raw.split())
    if words > MAX_SUMMARY_WORDS:
        audit['reasons'].append('summary_word_budget_exceeded')
    audit.update(eligibleForTrial=not audit['reasons'],directExperienceOutcomeClaims=claims,
        inlineLiteralEqualities=maths,selectedRuleSupportClaims=support,
        summaryWordCount=words,summaryWordLimit=MAX_SUMMARY_WORDS,
        taskResultAuditCoverage=AUDIT_PROTOCOL,unknownProseIsNotTruthCertified=True,
        pendingMathematicsMayNotEnterTrial=True,wholeProseTruthCertified=False)
    return audit
