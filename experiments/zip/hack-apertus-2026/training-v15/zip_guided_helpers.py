import ast
import copy
from fractions import Fraction
import re
from zip_content_core import OutsideScope, parse_expression, verify_claim, substitute
def normalize_surface(raw):
    """Presentation only: no completing a result or changing variable identity."""
    text = raw.strip()
    changes = []
    fence = re.fullmatch(r'```(?:python|math|text)?\s*\n?([\s\S]*?)\n?```', text, re.I)
    if fence:
        text = fence.group(1).strip()
        changes.append('whole_code_fence')
    if text.startswith('**') and text.endswith('**') and len(text) > 4:
        text = text[2:-2].strip()
        changes.append('whole_bold_wrapper')
    for left, right in [('\\[', '\\]'), ('\\(', '\\)'), ('$$', '$$'), ('$', '$')]:
        if text.startswith(left) and text.endswith(right) and len(text) > len(left) + len(right):
            text = text[len(left):-len(right)].strip()
            changes.append('whole_math_wrapper')
            break
    for before, after in [('\\left', ''), ('\\right', ''), ('\\cdot', '*'), ('\\times', '*'), ('−', '-')]:
        if before in text:
            text = text.replace(before, after)
            changes.append('display_' + before)
    changed = re.sub(r'\^\{([0-8])\}', r'**\1', text)
    if changed != text:
        changes.append('literal_power_braces')
        text = changed
    # Conventional unambiguous multiplication; never lowercase/rename symbols.
    changed = re.sub(r'(?<=\d)(?=[a-zA-Z(])|(?<=\))(?=[a-zA-Z0-9(])|(?<=[a-zA-Z])(?=\()', '*', text)
    if changed != text:
        changes.append('implicit_multiplication')
        text = changed
    if text.endswith('.'):
        text = text[:-1].rstrip()
        changes.append('terminal_period')
    return text, changes

def simplified_polynomial_surface(text):
    """Avoid calling a copy of the unsimplified question a solved answer."""
    try:
        _, tree, _ = parse_expression(text)
    except OutsideScope:
        return False
    terms = []
    def split(node):
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub)):
            split(node.left)
            split(node.right)
        elif isinstance(node, ast.UnaryOp):
            split(node.operand)
        else:
            terms.append(node)
    split(tree.body)
    monomials = set()
    for node in terms:
        factors = []
        def product(n):
            if isinstance(n, ast.BinOp) and isinstance(n.op, ast.Mult):
                product(n.left)
                product(n.right)
            elif isinstance(n, ast.UnaryOp):
                product(n.operand)
            else:
                factors.append(n)
        product(node)
        coefficient_count = 0
        names = set()
        for factor in factors:
            if isinstance(factor, ast.Constant):
                coefficient_count += 1
            elif isinstance(factor, ast.BinOp) and isinstance(factor.op, ast.Div) and not any(
                    isinstance(n, ast.Name) for n in ast.walk(factor)):
                # Only a written numeric ratio, not an unevaluated sum/product.
                parts = [n for n in ast.walk(factor) if isinstance(n, ast.BinOp)]
                if len(parts) != 1:
                    return False
                coefficient_count += 1
            elif isinstance(factor, ast.Name):
                if factor.id in names:
                    return False
                names.add(factor.id)
            elif isinstance(factor, ast.BinOp) and isinstance(factor.op, ast.Pow) and isinstance(factor.left, ast.Name):
                if factor.left.id in names:
                    return False
                names.add(factor.left.id)
            else:
                return False
        if coefficient_count > 1:
            return False
        polynomial = parse_expression(ast.unparse(node))[0]
        if not polynomial:
            if len(terms) != 1:
                return False
            continue
        if len(polynomial) != 1:
            return False
        monomial = next(iter(polynomial))
        if monomial in monomials:
            return False
        monomials.add(monomial)
    return True

def expression_key(text):
    _, tree, _ = parse_expression(text)
    return ast.dump(tree.body, include_attributes=False)

def result_field(row, raw):
    """Only a whole expression/equality or a whole abstention/action is accepted."""
    if raw.strip() == 'SKIP':
        return dict(action='skip')
    action = re.fullmatch(r'\s*REUSE\s+([1-4])\s*', raw)
    if action:
        return dict(action='reuse', indices=[int(action[1]) - 1])
    action = re.fullmatch(r'\s*CONNECT\s+([1-4])\s+([1-4])\s*', raw)
    if action:
        return dict(action='connect', indices=[int(action[1]) - 1, int(action[2]) - 1])
    text, changes = normalize_surface(raw)
    written_input = None
    if text.count('=') == 1:
        source, text = [s.strip() for s in text.split('=')]
        try:
            if expression_key(source) != expression_key(row['expression']):
                return dict(action='pending', reason='Written input does not match the declared task input')
        except OutsideScope:
            return dict(action='pending', reason='Written input is outside the expression interface')
        written_input = source
        changes.append('whole_equality_result_field')
    elif '=' in text:
        return dict(action='pending', reason='Multiple equalities are not a single result field')
    try:
        _, _, names = parse_expression(text)
    except OutsideScope as error:
        return dict(action='pending', reason=str(error))
    # A task's existing real variables are the entire contract; do not invent a
    # new quantified variable or silently change an uppercase identifier.
    if not set(names).issubset(set(parse_expression(row['expression'])[2])):
        return dict(action='pending', reason='Result introduces variables outside the declared task contract')
    rule = dict(operation='rewrite', input=row['expression'], output=text,
                variable='', scope='real_polynomial')
    return dict(action='new', rule=rule, sourceWrittenByStudent=written_input,
                presentationNormalizations=changes, mathematicalResultRepaired=False)

def match_pattern(pattern, actual, bindings):
    if isinstance(pattern, ast.Name):
        value = ast.dump(actual, include_attributes=False)
        if pattern.id in bindings:
            return ast.dump(bindings[pattern.id], include_attributes=False) == value
        bindings[pattern.id] = actual
        return True
    if type(pattern) is not type(actual):
        return False
    if isinstance(pattern, ast.Constant):
        return type(pattern.value) in {int, float} and type(actual.value) in {int, float} and Fraction(str(pattern.value)) == Fraction(str(actual.value))
    if isinstance(pattern, ast.BinOp):
        return type(pattern.op) is type(actual.op) and match_pattern(pattern.left, actual.left, bindings) and match_pattern(pattern.right, actual.right, bindings)
    if isinstance(pattern, ast.UnaryOp):
        return type(pattern.op) is type(actual.op) and match_pattern(pattern.operand, actual.operand, bindings)
    return False

def application(tool, input_text):
    rule = tool['rule']
    if rule['operation'] != 'rewrite' or not verify_claim(rule)['accepted']:
        return None
    try:
        _, pattern, source_names = parse_expression(rule['input'])
        target, target_tree, target_names = parse_expression(rule['output'])
        _, actual, _ = parse_expression(input_text)
        bindings = {}
        if not match_pattern(pattern.body, actual.body, bindings):
            return None
        if set(bindings) != set(source_names + target_names):
            return None
        text_bindings = {name: ast.unparse(node) for name, node in bindings.items()}
        converted = {name: parse_expression(text)[0] for name, text in text_bindings.items()}
        # No equation is solved here: this is explicit substitution into the
        # verified output selected by the student, like an ordinary tool call.
        class Bind(ast.NodeTransformer):
            def visit_Name(self, node):
                return copy.deepcopy(bindings[node.id])
        # Preserve the selected rule's expression structure for a subsequent
        # tool call. Expanding it into a canonical polynomial here would destroy
        # the syntax needed to match the second selected rule.
        output_text = ast.unparse(Bind().visit(copy.deepcopy(target_tree.body)))
        if parse_expression(output_text)[0] != substitute(target, converted):
            raise OutsideScope('AST substitution does not match the exact stored-rule application')
        return dict(operation='rewrite', input_text=input_text, output_text=output_text,
                    binding=text_bindings, variable='')
    except OutsideScope:
        return None
