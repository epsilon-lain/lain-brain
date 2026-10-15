"""Frozen student constructs two small routes, writes a child, then reuses it."""
import ast
import copy
from collections import Counter
import json
from pathlib import Path
import random
import time

from tool_loop_kernel import admit, claim, object_key, reuse_check, support_step
from zip_content_core import OutsideScope, digest, verify_claim

PROTOCOL = 'lain-zip-student-derived-tool-loop-v1'
TOKENS = 96
CAP = 160
CASES = 16
MAX_TOOLS_TESTED = 8
SEED = 2026100719
ROUTES = ('combine_then_distribute', 'distribute_then_combine')
CONDITIONS = ('new_zip', 'old_tools', 'no_zip', 'same_rule_text', 'mismatched_zip')


def archived_inputs(roots):
    seen = set(); paths_read = []
    def inspect(obj):
        if isinstance(obj, list):
            for child in obj: inspect(child)
        elif isinstance(obj, dict):
            if isinstance(obj.get('expression'), str):
                try: seen.add(object_key(obj['expression']))
                except OutsideScope: pass
            for key, child in obj.items():
                if key in ('rule', 'claim', 'certificate', 'exactAudit', 'recomputedCheck', 'studentOutput', 'studentPrompt', 'event'): continue
                if isinstance(child, (dict, list)): inspect(child)
    for root in roots:
        if not Path(root).is_dir(): continue
        paths = set(Path(root).glob('*questions.json')) | set(Path(root).glob('*inputs.json')) | set(Path(root).glob('*pools.json'))
        paths |= set(Path(root).rglob('*-raw.json'))
        if len(paths) > 4000: raise ValueError('Unexpectedly large archive')
        for path in sorted(paths):
            if path.is_symlink(): raise ValueError('Archive symlink')
            inspect(json.loads(path.read_text(encoding='utf-8'))); paths_read.append(str(path))
    return seen, dict(archiveInputFilesRead=paths_read, historicalInputKeys=len(seen),
        inputFieldsOnlyUsedForFreshness=True, unusedPlannedInputsAlsoExcluded=True,
        answerReferencesUsed=False, freshnessLimitedToListedArchives=True)


def construction_tasks(excluded):
    seen = set(excluded); tasks = []
    candidates = [('two_variables', 'x', 'y')]
    candidates += [('scaled_two_variables', str(i)+'*x', 'y') for i in range(2, 9)]
    candidates += [('polynomial_two_variables', 'x**'+str(i), 'y') for i in range(2, 7)]
    candidates += [('affine', 'x', str(i)) for i in range(1, 2049)]
    # Easy generic sum first, then interleave the remaining families.
    families = {kind: [c for c in candidates if c[0] == kind] for kind in ('two_variables', 'affine', 'scaled_two_variables', 'polynomial_two_variables')}
    while len(tasks) < CASES:
        progress = False
        for family, pool in families.items():
            while pool:
                _, left, right = pool.pop(0); inner = f'{left}+{right}'
                expression = f'1*({inner}) + 2*({inner})'; key = object_key(expression)
                if key in seen: continue
                seen.add(key); progress = True
                tasks.append(dict(id='zip-construction-'+digest(dict(input=expression))[:16], expression=expression,
                    question='Rewrite '+expression+'.', family=family, scope='real_polynomial', conditions=[],
                    semanticInputKey=key, generator='local exact-scoped task generator; not a public benchmark',
                    candidateTargetWrittenByStudent=True))
                break
            if len(tasks) == CASES: break
        if not progress: raise ValueError('Insufficient fresh construction tasks')
    return tasks


def root_text(roots):
    return '\n'.join('Rule '+str(i+1)+': '+r['rule']['input']+' = '+r['rule']['output'] for i, r in enumerate(roots))


def step_messages(current, roots, kind):
    instruction = dict(
        combine='Apply Rule 1 once to the whole expression. Keep the inner expression unchanged.',
        distribute='Apply Rule 2 to the product to remove its brackets.',
        distribute_each='Apply Rule 2 separately to each of the two summands. Do not combine like terms yet.',
        combine_each='Group like terms and apply Rule 1 to them. Do not factor the expression back into brackets.')[kind]
    return [dict(role='system', content='Write exactly one complete equality: the given expression = your rewritten expression. Use * and **. No prose, JSON or rule labels. Write SKIP if unsure.'),
        dict(role='user', content='Rewrite '+current+'.\nAll named variables are independent real numbers.\n'+root_text(roots)+'\n'+instruction)]


def proposal_messages(task, roots, routes):
    # Only the student's already certified text is shown. No computed endpoint,
    # substituted answer, verifier verdict or corrected expression is supplied.
    own = []
    for route in ROUTES:
        for record in routes.get(route, []): own.append(record['studentOutput']['raw'])
    return [dict(role='system', content='Write one complete local mathematical rule as one equality. Start with the original expression and end with the expanded result from your own written steps. No explanation or JSON. Write SKIP if unsure.'),
        dict(role='user', content=task['question']+'\nAll named variables are independent real numbers.\n'+root_text(roots)+'\nYour own previously written equalities:\n'+'\n'.join(own))]


def _bind_input(text, bindings):
    from zip_content_core import parse_expression
    tree = parse_expression(text)[1].body
    class Bind(ast.NodeTransformer):
        def visit_Name(self, node): return copy.deepcopy(ast.parse(bindings[node.id], mode='eval').body)
    return ast.unparse(Bind().visit(copy.deepcopy(tree)))


def reuse_tasks(tools, excluded):
    tasks = []; seen = set(excluded)
    for tool in tools[:MAX_TOOLS_TESTED]:
        for family in ('shift_binding', 'quadratic_binding'):
            for n in range(1, 2049):
                bindings = dict(x=f'u+{n}' if family == 'shift_binding' else f'u**2+{n}', y='v')
                expression = _bind_input(tool['rule']['input'], bindings); key = object_key(expression)
                if key in seen: continue
                seen.add(key)
                tasks.append(dict(id='zip-reuse-'+digest(dict(tool=tool['id'], input=expression))[:16],
                    toolId=tool['id'], expression=expression, question='Rewrite '+expression+'.',
                    family=family, scope='real_polynomial', conditions=[], semanticInputKey=key,
                    generator='local fresh composition from admitted input only',
                    taskBindingRecordedForAuditOnly=bindings, hostComputedTargetInPrompt=False))
                break
            else: raise ValueError('Insufficient fresh reuse objects')
    return tasks


def reuse_messages(task, tool, roots, condition):
    user = task['question']+'\nAll named variables are independent real numbers.'
    if condition in ('new_zip', 'same_rule_text'):
        header = 'Stored rule: ' if condition == 'new_zip' else 'Mathematical rule: '
        user += '\n'+header+tool['rule']['input']+' = '+tool['rule']['output']
    elif condition == 'old_tools': user += '\n'+root_text(roots)
    elif condition == 'mismatched_zip':
        # This stays outside the verified bank and can never become a dependency.
        user += '\nStored rule: '+tool['rule']['input']+' = ('+tool['rule']['output']+')+1'
    elif condition != 'no_zip': raise ValueError('Unknown condition')
    return [dict(role='system', content='Rewrite the whole given expression once. Write one complete equality using * and **. No explanation. Write SKIP if unsure.'), dict(role='user', content=user)]


def build(generate, roots, tasks, save, seconds=1200, proof_prompt_builder=None):
    deadline = time.monotonic()+seconds; proposals = []; bank = {}; route_records = []; status = 'completed'
    existing = {verify_claim(root['rule'])['ruleKey'] for root in roots}
    for number, task in enumerate(tasks, 1):
        if time.monotonic() >= deadline: status = 'construction-time-budget'; break
        routes = {}
        for ri, route in enumerate(ROUTES):
            current = task['expression']; routes[route] = []
            steps = [('combine', roots[0]), ('distribute', roots[1])] if ri == 0 else [('distribute_each', roots[1]), ('combine_each', roots[0])]
            for si, (kind, root) in enumerate(steps):
                if time.monotonic() >= deadline: status = 'construction-time-budget'; break
                prompt = (proof_prompt_builder or step_messages)(current, roots, kind); seed = SEED+number*10+ri*2+si
                response = generate(prompt, TOKENS, seed, sampled=False, temperature=1.)
                raw = dict(task=task, phase='proof_step', route=route, step=si+1, kind=kind,
                    studentPrompt=prompt, studentOutput=response, samplingSeed=seed)
                save('proof-raw', raw)
                checked = support_step(current, response, root, kind)
                scored = dict(raw, check=checked); save('proof-scored', scored); route_records.append(scored)
                if not checked.get('toolSupported'): break
                routes[route].append(scored); current = checked['right']
            if status != 'completed': break
        # A real proposal is requested only after one complete verified route.
        # The denominator remains all construction tasks, including failures.
        if status != 'completed': break
        if not any(len(r) == 2 for r in routes.values()):
            result = dict(task=task, routes=routes, admission=dict(status='pending', admitted=False,
                reason='No complete verified route from which the student can write a candidate'), proposalGenerated=False)
        else:
            prompt = proposal_messages(task, roots, routes); seed = SEED+number*10+9
            response = generate(prompt, TOKENS, seed, sampled=False, temperature=1.)
            raw = dict(task=task, phase='proposal', studentPrompt=prompt, studentOutput=response, samplingSeed=seed)
            save('proposal-raw', raw)
            admission = admit(task, response, routes, roots, existing)
            scored = dict(raw, admission=admission); save('proposal-scored', scored)
            result = dict(task=task, routes=routes, admission=admission, proposalGenerated=True,
                proposalRaw=response['raw'], proposalRawHash=digest(response['raw']))
            if admission['admitted']:
                tool = admission['tool']; bank[tool['id']] = tool; existing.add(admission['ruleKey'])
                save('admitted-tool', tool)
        proposals.append(result); save('candidate', result)
        if number <= 2 or number % 4 == 0:
            print('写入新 zip 进度：', json.dumps(dict(objectsCompleted=number, admittedLocalTools=len(bank),
                candidateStatus=result['admission']['status'], newPrinciplesDiscovered=0), ensure_ascii=False), flush=True)
    return dict(stopReason=status, candidates=proposals, tools=list(bank.values()), proofRecords=route_records)


def evaluate(generate, tasks, tools, roots, save, assert_frozen, seconds=600):
    deadline = time.monotonic()+seconds; bank = {t['id']:t for t in tools}; records = []; stop = 'completed'
    for number, task in enumerate(tasks, 1):
        if time.monotonic() >= deadline: stop = 'reuse-time-budget'; break
        order = list(CONDITIONS); random.Random(SEED+50000+number).shuffle(order)
        for condition in order:
            assert_frozen(); tool = bank[task['toolId']]; prompt = reuse_messages(task, tool, roots, condition)
            seed = SEED+50000+number
            response = generate(prompt, TOKENS, seed, sampled=False, temperature=1.)
            raw = dict(task=task, phase='reuse', condition=condition, studentPrompt=prompt,
                studentOutput=response, samplingSeed=seed)
            save('reuse-raw', raw); assert_frozen()
            checked = reuse_check(task, response, tool)
            record = dict(raw, check=checked); save('reuse-scored', record); records.append(record)
        if number <= 2 or number % 4 == 0:
            print('新 zip 复用进度：', json.dumps(dict(completeFiveConditionQuestions=number,
                questionsPlanned=len(tasks)), ensure_ascii=False), flush=True)
    return dict(stopReason=stop, records=records, summary=evaluation_summary(records, tasks))


def evaluation_summary(records, planned):
    groups = {}
    for condition in CONDITIONS:
        rows = [r for r in records if r['condition'] == condition]; checks = [r['check'] for r in rows]
        groups[condition] = dict(questions=len(rows), completeVerifiedChildApplications=sum(c['completeVerifiedChildApplication'] for c in checks),
            cleanChangedMathematics=sum(c['cleanChangedMathematics'] for c in checks),
            cleanSimplifiedAnswers=sum(c['cleanSimplifiedAnswer'] for c in checks),
            wrongWrittenEqualities=sum(c['wrongWrittenEquality'] for c in checks), wrongFinals=sum(c['wrongFinal'] for c in checks),
            correctFinalsWithFalseWrittenEquality=sum(c['correctFinalWithFalseWrittenEquality'] for c in checks),
            copies=sum(c['copiedOriginal'] for c in checks), skips=sum(c['explicitSkip'] for c in checks),
            unknownResponses=sum(c['unknownText'] for c in checks), atTokenCap=sum(c['tokenCapReached'] for c in checks),
            untestedAccuracyIsUnavailable=not rows)
    pairs = []; complete = 0
    for task in planned:
        rows = {r['condition']:r for r in records if r['task']['id'] == task['id']}
        if set(rows) == set(CONDITIONS): complete += 1
    for other in CONDITIONS[1:]:
        matched = []
        for task in planned:
            rows = {r['condition']:r for r in records if r['task']['id'] == task['id']}
            if 'new_zip' in rows and other in rows:
                matched.append((rows['new_zip']['check']['completeVerifiedChildApplication'], rows[other]['check']['completeVerifiedChildApplication']))
        pairs.append(dict(left='new_zip', right=other, pairedQuestions=len(matched),
            leftCorrect=sum(a for a,b in matched), rightCorrect=sum(b for a,b in matched),
            leftOnlyCorrect=sum(a and not b for a,b in matched), rightOnlyCorrect=sum(b and not a for a,b in matched),
            descriptiveOnly=True))
    return dict(byCondition=groups, completeFiveConditionQuestions=complete, questionsPlanned=len(planned),
        pairedComparisons=pairs, noAdmittedToolsMeansReuseWasNotTested=not planned,
        generalTransferProved=False, structuralReaderTested=False)
