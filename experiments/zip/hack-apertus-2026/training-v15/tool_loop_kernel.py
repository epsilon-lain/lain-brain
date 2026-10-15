"""Exact, bounded replay of student-written one-equality proof steps.

Two routes must change the same object in different tool orders. They share
roots, so they are not independent axiomatizations. Actual correctness comes
from a separate rational-polynomial certificate. No repaired mathematics is
ever passed to the student, stored as its claim, or rewarded as discovery.
"""
import ast
import copy
from fractions import Fraction
import itertools

from zip_content_core import OutsideScope, digest, instance_key, parse_expression, verify_claim
from zip_guided_helpers import application, expression_key, match_pattern, normalize_surface, simplified_polynomial_surface
from zip_answer_audit import math_parts


def claim(left, right):
    return dict(operation='rewrite', input=left, output=right, variable='', scope='real_polynomial')


def object_key(text):
    poly = parse_expression(text)[0]
    return digest(instance_key(poly, poly))


def _surface(node):
    """Only AC regrouping, units and closed rational arithmetic; no distribution.

    This is a declared kernel background, not a third student discovery.
    Powers and sums inside products retain their written structure.
    """
    if isinstance(node, ast.Constant):
        return ('number', str(Fraction(str(node.value))))
    if isinstance(node, ast.Name):
        return ('name', node.id)
    if isinstance(node, ast.UnaryOp):
        value = _surface(node.operand)
        return value if isinstance(node.op, ast.UAdd) else _product([('number', '-1'), value])
    if isinstance(node, ast.BinOp):
        if isinstance(node.op, ast.Add):
            return _sum([_surface(node.left), _surface(node.right)])
        if isinstance(node.op, ast.Sub):
            return _sum([_surface(node.left), _product([('number', '-1'), _surface(node.right)])])
        if isinstance(node.op, ast.Mult):
            return _product([_surface(node.left), _surface(node.right)])
        if isinstance(node.op, ast.Div):
            denominator = parse_expression(ast.unparse(node.right))[0]
            divisor = denominator.get((), Fraction(0))
            if not divisor or any(k for k in denominator):
                raise OutsideScope('Nonconstant divisor')
            return _product([_surface(node.left), ('number', str(1 / divisor))])
        if isinstance(node.op, ast.Pow):
            left = _surface(node.left)
            if left[0] == 'number':
                return ('number', str(Fraction(left[1]) ** node.right.value))
            if node.right.value == 0: return ('number', '1')
            if node.right.value == 1: return left
            return ('power', left, node.right.value)
    raise OutsideScope('Unsupported surface expression')


def _sum(values):
    members = []; constant = Fraction(0)
    for value in values:
        for part in value[1] if value[0] == 'sum' else [value]:
            if part[0] == 'number': constant += Fraction(part[1])
            else: members.append(part)
    if constant: members.append(('number', str(constant)))
    members.sort(key=repr)
    return ('number', '0') if not members else members[0] if len(members) == 1 else ('sum', tuple(members))


def _product(values):
    members = []; constant = Fraction(1)
    for value in values:
        for part in value[1] if value[0] == 'product' else [value]:
            if part[0] == 'number': constant *= Fraction(part[1])
            else: members.append(part)
    if not constant: return ('number', '0')
    if constant != 1 or not members: members.append(('number', str(constant)))
    members.sort(key=repr)
    return members[0] if len(members) == 1 else ('product', tuple(members))


def surface_key(text):
    return _surface(parse_expression(text)[1].body)


def single_equality(task_input, response):
    """A missing left side or missing step is never supplied by the parser."""
    raw = response['raw']; result = dict(status='pending', parsed=False, rawHash=digest(raw),
        reason='One complete equality is required', hostFilledMathematics=False)
    if raw.strip().upper() in {'SKIP', 'UNKNOWN'}:
        return dict(result, status='skip', reason='Explicit abstention')
    text, presentation = normalize_surface(raw)
    if text.count('=') != 1: return result
    try:
        # Try each written side first, so **left** = **right** is not mistaken
        # for a single bold wrapper around the whole response.
        try: left, right = math_parts(raw)
        except OutsideScope: left, right = math_parts(text)
        left_poly, _, left_names = parse_expression(left)
        right_poly, _, right_names = parse_expression(right)
        task_poly, _, task_names = parse_expression(task_input)
        check = verify_claim(claim(left, right))
        outside = sorted((set(left_names) | set(right_names)) - set(task_names))
        grounded = expression_key(left) == expression_key(task_input)
        result.update(parsed=True, left=left, right=right, claim=claim(left, right), exactAudit=check,
            sourceMatchesTask=grounded, outsideTaskVariables=outside, presentationNormalizations=['bounded_math_parts']+presentation,
            completeTextCoverage=True, tokenCapReached=bool(response.get('tokenCapReached')))
        if check['status'] == 'rejected':
            return dict(result, status='rejected', reason=check['reason'])
        if outside or not grounded or response.get('tokenCapReached') or not check['accepted']:
            return dict(result, reason='Input, variable contract, completion or exact audit failed')
        if surface_key(left) == surface_key(right):
            return dict(result, status='no_progress', reason='Only copying, AC formatting or numeric folding')
        return dict(result, status='verified', reason='Complete changed exact equality')
    except OutsideScope as error:
        return dict(result, reason=str(error))


def _ast(text): return parse_expression(text)[1].body


def _parts(node):
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return _parts(node.left) + _parts(node.right)
    return [node]


def _joined(parts):
    result = copy.deepcopy(parts[0])
    for part in parts[1:]: result = ast.BinOp(left=result, op=ast.Add(), right=copy.deepcopy(part))
    return result


def _paths(node, path=()):
    yield path, node
    if isinstance(node, ast.BinOp):
        yield from _paths(node.left, path + ('left',))
        yield from _paths(node.right, path + ('right',))
    elif isinstance(node, ast.UnaryOp):
        yield from _paths(node.operand, path + ('operand',))


def _replace(node, path, replacement):
    if not path: return copy.deepcopy(replacement)
    result = copy.deepcopy(node); current = result
    for name in path[:-1]: current = getattr(current, name)
    setattr(current, path[-1], copy.deepcopy(replacement))
    return result


def _distribution_options(left, tool, batch):
    tree = _ast(left); calls = []
    for path, node in _paths(tree):
        call = application(tool, ast.unparse(node))
        if call: calls.append((path, call))
    if len(calls) > 12: raise OutsideScope('Too many distributive matches')
    for count in range(1, min(4, len(calls)) + 1) if batch else (1,):
        for selected in itertools.combinations(calls, count):
            paths = [x[0] for x in selected]
            if any(a == b[:len(a)] for a in paths for b in paths if a != b): continue
            transformed = tree
            for path, call in sorted(selected, key=lambda x: len(x[0]), reverse=True):
                transformed = _replace(transformed, path, _ast(call['output_text']))
            yield ast.unparse(transformed), [dict(path=list(path), binding=call['binding']) for path, call in selected]


def _combine_options(left, tool, batch):
    if not batch:
        call = application(tool, left)
        if call: yield call['output_text'], [dict(path=[], binding=call['binding'])]
        return
    terms = _parts(_ast(left))
    if len(terms) > 8: raise OutsideScope('Too many additive terms')
    pattern = _ast(tool['rule']['input']); results = []
    for i, j in itertools.permutations(range(len(terms)), 2):
        first = terms[i]
        variants = [first, ast.BinOp(left=ast.Constant(1), op=ast.Mult(), right=copy.deepcopy(first))]
        for variant in variants:
            bindings = {}; pair = ast.BinOp(left=variant, op=ast.Add(), right=terms[j])
            if not match_pattern(pattern, pair, bindings): continue
            call = application(tool, ast.unparse(pair))
            if call:
                results.append((frozenset((i, j)), _ast(call['output_text']), call['binding']))
                break
    if len(results) > 16: raise OutsideScope('Too many additive matches')
    for count in range(1, min(4, len(results)) + 1):
        for chosen in itertools.combinations(results, count):
            indices = [i for item in chosen for i in item[0]]
            if len(indices) != len(set(indices)): continue
            transformed = [term for i, term in enumerate(terms) if i not in indices] + [item[1] for item in chosen]
            details = [dict(additiveTermIndices=sorted(item[0]), binding=item[2]) for item in chosen]
            yield ast.unparse(_joined(transformed)), details


def support_step(source, response, tool, kind):
    record = single_equality(source, response)
    if record['status'] != 'verified': return dict(record, toolSupported=False)
    source_check = verify_claim(tool['rule'])
    if not source_check['accepted'] or not source_check['reusable']:
        return dict(record, status='blocked', toolSupported=False, reason='Old tool failed re-verification')
    if kind not in {'combine', 'distribute', 'distribute_each', 'combine_each'}:
        raise ValueError('Unknown proof step')
    options = _combine_options(record['left'], tool, kind == 'combine_each') if kind.startswith('combine') else _distribution_options(
        record['left'], tool, kind == 'distribute_each')
    for transformed, replay in options:
        if surface_key(transformed) == surface_key(record['right']):
            return dict(record, toolSupported=True, toolId=tool['id'], toolVersion=tool['version'],
                sourceClaimHash=digest(tool['rule']), sourceRuleRechecked=True,
                kind=kind, replay=replay, rootCertificate=source_check['certificate'],
                kernelBackground='addition/multiplication AC, multiplicative unit, closed rational arithmetic',
                mathematicalOutputComputedOnlyAfterStudentResponse=True)
    return dict(record, status='pending', toolSupported=False, reason='True equality lacks the requested stored-rule replay')


def expanded_surface(text):
    tree = _ast(text)
    return not any(isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mult) and (
        isinstance(node.left, ast.BinOp) and isinstance(node.left.op, (ast.Add, ast.Sub)) or
        isinstance(node.right, ast.BinOp) and isinstance(node.right.op, (ast.Add, ast.Sub))) for node in ast.walk(tree))


def admit(task, proposal, routes, roots, existing):
    parsed = single_equality(task['expression'], proposal)
    result = dict(status=parsed['status'], admitted=False, parsedProposal=parsed,
        twoDistinctToolOrdersSupported=False, independentRootSets=False, newMathematicalPrinciple=False)
    if parsed['status'] != 'verified': return result
    if not expanded_surface(parsed['right']):
        return dict(result, status='pending', reason='Candidate must compose collection and distribution, not stop at the old tool')
    if set(routes) != {'combine_then_distribute', 'distribute_then_combine'} or any(len(v) != 2 for v in routes.values()):
        return dict(result, status='pending', reason='Both complete student routes are required')
    rechecked = {}
    for route, records in routes.items():
        current = task['expression']; checks = []
        sequence = [('combine', roots[0]), ('distribute', roots[1])] if route.startswith('combine') else [('distribute_each', roots[1]), ('combine_each', roots[0])]
        for record, (kind, root) in zip(records, sequence):
            check = support_step(current, record['studentOutput'], root, kind)
            checks.append(check)
            if not check.get('toolSupported'):
                return dict(result, status='pending', reason='Stored student proof failed replay', failedRoute=route, failedStep=check)
            current = check['right']
        if surface_key(current) != surface_key(parsed['right']):
            return dict(result, status='pending', reason='Student routes do not terminate at the written candidate')
        rechecked[route] = checks
    left = rechecked['combine_then_distribute']; right = rechecked['distribute_then_combine']
    different = surface_key(left[0]['right']) != surface_key(right[0]['right']) and [x['toolId'] for x in left] != [x['toolId'] for x in right]
    if not different: return dict(result, status='pending', reason='Routes repeat the same intermediate or tool order')
    checked = parsed['exactAudit']; rule_key = checked['ruleKey']
    if rule_key in existing: return dict(result, status='duplicate', reason='A renamed or reformatted stored rule is not new')
    tool = dict(id='student-derived-zip-' + rule_key[:16], version=checked['claimHash'], rule=parsed['claim'],
        studentRaw=proposal['raw'], studentRawHash=digest(proposal['raw']), originalProblem=copy.deepcopy(task),
        proposalOutput=copy.deepcopy(proposal),
        exactAudit=checked, scope='real_polynomial', routes=copy.deepcopy(routes), routeReplays=rechecked,
        dependencies=[dict(id=r['id'], version=r['version'], claimHash=digest(r['rule']), rule=copy.deepcopy(r['rule'])) for r in roots],
        provenance=dict(author='student', kind='new local derived tool; existing principles',
            candidateResultAndProofStepsWrittenByStudent=True, hostFilledMathematics=False,
            autoImportedIntoOriginalBank=False, teacherCalls=0, activeOnlyInIsolatedTrial=True),
        twoDistinctToolOrdersSupported=True, rootDisjointProofs=False, independentProofChains=0,
        newMathematicalPrinciple=False, absoluteCorrectnessGuaranteedByTwoRoutes=False)
    return dict(result, status='admitted', admitted=True, tool=tool, ruleKey=rule_key,
        twoDistinctToolOrdersSupported=True, reason='Student claim and both actual routes have bounded exact certificates')


def recheck_tool(tool, roots):
    """Loading a bank is not trust: recheck content, old versions and both routes."""
    if tool.get('studentRawHash') != digest(tool.get('studentRaw')) or tool.get('proposalOutput', {}).get('raw') != tool.get('studentRaw'):
        return dict(accepted=False, reason='Stored original student text differs')
    dependencies = [dict(id=r['id'], version=r['version'], claimHash=digest(r['rule']), rule=copy.deepcopy(r['rule'])) for r in roots]
    if tool.get('dependencies') != dependencies:
        return dict(accepted=False, reason='A parent rule or version changed')
    existing = {verify_claim(r['rule']).get('ruleKey') for r in roots}
    replay = admit(tool['originalProblem'], tool['proposalOutput'], tool['routes'], roots, existing)
    accepted = bool(replay.get('admitted') and replay['tool'] == tool)
    return dict(accepted=accepted, reason='Exact content and actual saved routes replayed' if accepted else 'Saved proof or claim differs',
        newDiscoveryCounted=False, weightsOpened=False)


def reuse_check(task, response, tool):
    parsed = single_equality(task['expression'], response)
    raw, presentation = normalize_surface(response['raw'])
    final = parsed.get('right')
    if not final and '=' not in raw and response['raw'].strip().upper() not in {'SKIP', 'UNKNOWN'}:
        try: parse_expression(raw); final = raw
        except OutsideScope: pass
    exact = verify_claim(claim(task['expression'], final)) if final else None
    variables = set(parse_expression(task['expression'])[2])
    within = final is not None and set(parse_expression(final)[2]).issubset(variables)
    completed = bool(exact and exact['accepted'] and within and not response.get('tokenCapReached'))
    changed = bool(completed and parsed['status'] != 'rejected' and surface_key(final) != surface_key(task['expression']))
    call = application(tool, task['expression']) if verify_claim(tool['rule'])['accepted'] else None
    replay = bool(parsed['status'] == 'verified' and call and surface_key(call['output_text']) == surface_key(parsed['right']))
    return dict(status=parsed['status'], exactMathematics=completed, cleanChangedMathematics=changed,
        completeVerifiedChildApplication=replay, cleanSimplifiedAnswer=bool(changed and simplified_polynomial_surface(final)),
        copiedOriginal=bool(final and surface_key(final) == surface_key(task['expression'])),
        explicitSkip=response['raw'].strip().upper() in {'SKIP', 'UNKNOWN'},
        wrongWrittenEquality=parsed['status'] == 'rejected', wrongFinal=bool(exact and exact['status'] == 'rejected'),
        correctFinalWithFalseWrittenEquality=bool(completed and parsed['status'] == 'rejected'),
        finalWrittenByStudent=final, unknownText=not parsed['parsed'] and final is None and parsed['status'] != 'skip',
        tokenCapReached=bool(response.get('tokenCapReached')), fullEqualityAudit=parsed,
        applicationReplay=dict(toolId=tool['id'], version=tool['version'], binding=call['binding']) if replay else None,
        kernelTruthDoesNotProveStudentSemanticUnderstanding=True, hostFilledMathematics=False)
