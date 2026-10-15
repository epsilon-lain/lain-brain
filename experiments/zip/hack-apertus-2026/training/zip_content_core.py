"""Student-authored polynomial tools, exact content audit, admission and rewards.

No language model opinion establishes truth. All certificates state their finite
scope. Unsupported statements stay pending. No teacher/network/model calls.
"""
import ast
from fractions import Fraction
import hashlib
import itertools
import json
import re

MAX_TERMS=128
MAX_DEGREE=12
MAX_VARIABLES=6


def canonical(value): return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)
def digest(value): return hashlib.sha256(canonical(value).encode()).hexdigest()


class OutsideScope(ValueError): pass


def bounded(poly):
    result={m:c for m,c in poly.items() if c}
    variables={name for m in result for name,power in m}
    if len(result)>MAX_TERMS or len(variables)>MAX_VARIABLES or any(sum(p for _,p in m)>MAX_DEGREE for m in result):
        raise OutsideScope('Polynomial resource bounds exceeded')
    if any(c.numerator.bit_length()>256 or c.denominator.bit_length()>256 for c in result.values()):
        raise OutsideScope('Coefficient bounds exceeded')
    return result


def add(a,b,sign=1):
    result=a.copy()
    for monomial,value in b.items(): result[monomial]=result.get(monomial,Fraction(0))+sign*value
    return bounded(result)


def multiply(a,b):
    result={}
    for ma,ca in a.items():
        for mb,cb in b.items():
            powers=dict(ma)
            for name,power in mb: powers[name]=powers.get(name,0)+power
            monomial=tuple(sorted(powers.items()))
            result[monomial]=result.get(monomial,Fraction(0))+ca*cb
            result=bounded(result)
    return result


def derivative(poly,variable):
    result={}
    for monomial,coefficient in poly.items():
        powers=dict(monomial);power=powers.get(variable,0)
        if not power: continue
        if power==1: del powers[variable]
        else: powers[variable]=power-1
        key=tuple(sorted(powers.items()))
        result[key]=result.get(key,Fraction(0))+power*coefficient
    return bounded(result)


def variables(poly): return sorted({name for m in poly for name,p in m})


def poly_json(poly):
    return [dict(powers=dict(m),coefficient=str(c)) for m,c in sorted(poly.items())]


def parse_expression(text):
    if not isinstance(text,str) or not 0<len(text)<=500: raise OutsideScope('Expression length outside bounds')
    try: tree=ast.parse(text.strip().replace('^','**'),mode='eval')
    except SyntaxError as error: raise OutsideScope('Expression syntax not supported') from error
    if sum(1 for _ in ast.walk(tree))>160: raise OutsideScope('AST too large')
    names=[]
    def visit(node):
        if isinstance(node,ast.Constant) and type(node.value) in {int,float}:
            try: value=Fraction(str(node.value))
            except ValueError as error: raise OutsideScope('Nonfinite number') from error
            return bounded({():value})
        if isinstance(node,ast.Name) and re.fullmatch('[a-z]',node.id):
            if node.id not in names: names.append(node.id)
            if len(names)>MAX_VARIABLES: raise OutsideScope('Too many variables')
            return {((node.id,1),):Fraction(1)}
        if isinstance(node,ast.UnaryOp) and isinstance(node.op,(ast.UAdd,ast.USub)):
            value=visit(node.operand)
            return value if isinstance(node.op,ast.UAdd) else {m:-c for m,c in value.items()}
        if isinstance(node,ast.BinOp):
            left=visit(node.left)
            if isinstance(node.op,ast.Pow):
                if not isinstance(node.right,ast.Constant) or type(node.right.value) is not int or not 0<=node.right.value<=8:
                    raise OutsideScope('Only literal powers 0..8 are supported')
                result={():Fraction(1)}
                for _ in range(node.right.value): result=multiply(result,left)
                return result
            right=visit(node.right)
            if isinstance(node.op,ast.Add): return add(left,right)
            if isinstance(node.op,ast.Sub): return add(left,right,-1)
            if isinstance(node.op,ast.Mult): return multiply(left,right)
            if isinstance(node.op,ast.Div):
                # Check syntax names too: y/y is undefined at y=0 even if it simplifies.
                if any(isinstance(n,ast.Name) for n in ast.walk(node.right)):
                    raise OutsideScope('Symbolic denominator needs a separate domain proof')
                if set(right)!={()} or not right[()]: raise OutsideScope('Undefined or nonconstant denominator')
                return bounded({m:c/right[()] for m,c in left.items()})
        raise OutsideScope('Calls, attributes and other syntax are outside the verifier')
    poly=visit(tree.body)
    return poly,tree,names


def alpha_claim(claim):
    """Canonical AST with consistent variable renaming; no whitespace reward."""
    _,source,names=parse_expression(claim['input'])
    _,target,target_names=parse_expression(claim['output'])
    variable=claim.get('variable')
    ordered=([variable] if claim['operation']=='differentiate' else [])+names+target_names
    mapping={}
    for name in ordered:
        if name not in mapping: mapping[name]='v'+str(len(mapping))
    def shape(node):
        if isinstance(node,ast.Expression): return shape(node.body)
        if isinstance(node,ast.Name): return ('name',mapping[node.id])
        if isinstance(node,ast.Constant): return ('number',str(Fraction(str(node.value))))
        if isinstance(node,ast.UnaryOp): return (type(node.op).__name__,shape(node.operand))
        if isinstance(node,ast.BinOp): return (type(node.op).__name__,shape(node.left),shape(node.right))
        raise OutsideScope('Unsupported canonical syntax')
    return dict(operation=claim['operation'],scope=claim['scope'],input=shape(source),output=shape(target),
        variable=mapping.get(variable) if claim['operation']=='differentiate' else None)


def value_at(poly,point):
    total=Fraction(0)
    for monomial,c in poly.items():
        for name,power in monomial: c*=Fraction(point[name])**power
        total+=c
    return total


def counterexample(residual,names):
    for index,values in enumerate(itertools.product([0,1,-1,2],repeat=len(names))):
        if index>=256: break
        point=dict(zip(names,values));value=value_at(residual,point)
        if value: return dict(assignment=point,residual=str(value))
    return None


def complete_claim_interface(claim):
    """Shape only: an interface match is not a mathematical certificate."""
    return (isinstance(claim,dict)
        and set(claim)=={'operation','input','output','variable','scope'}
        and all(isinstance(v,str) for v in claim.values()))


def verify_claim(claim):
    result=dict(status='pending',accepted=False,reusable=False,reason='Outside supported claim interface')
    if not complete_claim_interface(claim): return result
    if claim['scope']!='real_polynomial' or claim['operation'] not in {'rewrite','differentiate'}: return result
    if claim['operation']=='differentiate' and not re.fullmatch('[a-z]',claim['variable']): return result
    if claim['operation']=='rewrite' and claim['variable']!='': return result
    try:
        source,source_tree,source_names=parse_expression(claim['input'])
        target,_,target_names=parse_expression(claim['output'])
        if len(set(source_names+target_names+[claim['variable']])-{''})>MAX_VARIABLES: raise OutsideScope('Too many quantified variables')
        expected=derivative(source,claim['variable']) if claim['operation']=='differentiate' else source
        residual=add(expected,target,-1)
        names=sorted(set(source_names+target_names+([claim['variable']] if claim['variable'] else [])))
        if residual:
            return dict(result,status='rejected',reason='Exact nonzero polynomial residual',
                certificate=dict(kind='nonzero-rational-polynomial',residual=poly_json(residual),counterexample=counterexample(residual,names),
                    scope='all independent real values of the named variables'))
        signature=alpha_claim(claim)
        useful=bool(source_names) and not (claim['operation']=='rewrite' and signature['input']==signature['output'])
        return dict(status='verified',accepted=True,reusable=useful,
            reason='Exact polynomial proof' if useful else 'Verified example or unchanged expression; no reusable tool reward',
            ruleKey=digest(signature),claimHash=digest(claim),
            certificate=dict(kind='exact-rational-polynomial-identity' if claim['operation']=='rewrite' else 'exact-polynomial-derivative',
                quantifiers={name:'independent real variable' for name in names},scope='real_polynomial',
                sourcePolynomial=poly_json(source),targetPolynomial=poly_json(target),residual=[],
                allInputsInScopeChecked=True,naturalLanguageProseCertified=False))
    except OutsideScope as error: return dict(result,reason=str(error))


def faithfully_parse_draft(raw):
    """Parse exact student assertions; never fill a missing or corrected rule."""
    if not isinstance(raw,str) or len(raw)>8000: return None
    try:
        def pairs(items):
            out={}
            for k,v in items:
                if k in out: raise ValueError('Duplicate field')
                out[k]=v
            return out
        obj=json.loads(raw,object_pairs_hook=pairs)
        if complete_claim_interface(obj): return obj
    except ValueError: pass
    match=re.fullmatch(r'\s*The derivative of (.+?) wrt ([a-z]) is (.+?)\.\s*',raw,re.I|re.S)
    if match:
        source,variable,target=match.groups()
        return dict(operation='differentiate',input=source,output=target,variable=variable,scope='real_polynomial')
    return None


def substitute(poly,binding):
    result={}
    for monomial,coefficient in poly.items():
        term={():coefficient}
        for name,power in monomial:
            factor=binding[name]
            for _ in range(power): term=multiply(term,factor)
        result=add(result,term)
    return result


def instance_key(source,target,variable=''):
    names=([variable] if variable else [])+sorted(set(variables(source)+variables(target)))
    mapping={}
    for name in names:
        if name not in mapping: mapping[name]='v'+str(len(mapping))
    def renamed(poly):
        return {tuple(sorted((mapping[name],power) for name,power in monomial)):c for monomial,c in poly.items()}
    return dict(source=poly_json(renamed(source)),target=poly_json(renamed(target)),variable=mapping.get(variable))


class ZipContentModel:
    def __init__(self,answer_weight=.05):
        if not 0<=answer_weight<=.05: raise ValueError('Answer reward must remain minor')
        self.answer_weight=answer_weight
        self.candidates=[];self.verified={};self.reuse_ledger=set();self.connection_ledger=set()
        self.rewarded_reuse_tools=set();self.problem_objects={}

    @classmethod
    def from_state(cls,state):
        """Restore review state and novelty ledgers; reprove every admitted rule."""
        if state.get('protocol')!='lain-zip-content-model-v1': raise ValueError('State protocol differs')
        model=cls(state['answerWeight'])
        for tool in state['verifiedTools']:
            claim=faithfully_parse_draft(tool['studentRaw']);checked=verify_claim(claim)
            if not checked['accepted'] or not checked['reusable'] or claim!=tool['claim']:
                raise ValueError('Restored student content does not verify')
            if tool['id']!='verified-zip-'+checked['ruleKey'][:16] or tool['claimHash']!=checked['claimHash']:
                raise ValueError('Restored tool identity differs')
            restored=json.loads(canonical(tool));restored['certificate']=checked['certificate']
            model.verified[tool['id']]=restored
        model.candidates=json.loads(canonical(state['candidates']))
        for field,attribute in [('reuseLedger','reuse_ledger'),('connectionLedger','connection_ledger')]:
            if any(not re.fullmatch('[0-9a-f]{64}',key) for key in state[field]): raise ValueError('Invalid novelty ledger')
            setattr(model,attribute,set(state[field]))
        rewarded=set(state['rewardedReuseTools'])
        if not rewarded.issubset(model.verified): raise ValueError('Rewarded reuse refers to an absent verified tool')
        model.rewarded_reuse_tools=rewarded
        return model

    def register_problem(self,problem_id,operation,input_text,variable=''):
        """Host environment registers an actual object, never a reference answer."""
        if operation not in {'rewrite','differentiate'}: raise OutsideScope('Problem operation not supported')
        if operation=='differentiate' and not re.fullmatch('[a-z]',variable): raise OutsideScope('Differential variable missing')
        poly,tree,_=parse_expression(input_text)
        pieces=[poly]
        for node in ast.walk(tree):
            if isinstance(node,(ast.BinOp,ast.UnaryOp,ast.Name,ast.Constant)):
                try: pieces.append(parse_expression(ast.unparse(node))[0])
                except OutsideScope: pass
        descriptor=dict(operation=operation,input=input_text,variable=variable,subexpressions=pieces)
        if problem_id in self.problem_objects:
            if self.problem_objects[problem_id]!=descriptor: raise ValueError('Problem object is immutable')
        else: self.problem_objects[problem_id]=descriptor

    def register_question(self,problem_id,question):
        match=re.fullmatch(r'What is the derivative of (.+) wrt ([a-z])\?',question)
        if match: self.register_problem(problem_id,'differentiate',match[1],match[2]);return True
        match=re.fullmatch(r'(?:Expand|Collect the terms in) (.+)\.',question)
        if match: self.register_problem(problem_id,'rewrite',match[1]);return True
        return False

    def submit(self,student_raw,problem_id,answer_correct=False,teacher_opinion=None):
        claim=faithfully_parse_draft(student_raw)
        checked=verify_claim(claim)
        record=dict(author='student',raw=student_raw,rawHash=digest(student_raw),problem=problem_id,
            parsedClaim=claim,verification=checked,teacherOpinion=teacher_opinion,
            teacherOpinionEstablishesTruth=False,contentRewritten=False)
        new=False;tool_id=None
        if checked['accepted'] and checked['reusable']:
            tool_id='verified-zip-'+checked['ruleKey'][:16]
            new=tool_id not in self.verified
            if new: self.verified[tool_id]=dict(id=tool_id,studentRaw=student_raw,claim=claim,
                certificate=checked['certificate'],claimHash=checked['claimHash'],originProblem=problem_id)
        main_reward=1. if new else -.1 if checked['status']=='rejected' else 0.
        bonus=0. if checked['status']=='rejected' else self.answer_weight*int(bool(answer_correct))
        record.update(toolId=tool_id,newVerifiedTool=new,reward=dict(zip=main_reward,answer=bonus,total=main_reward+bonus))
        self.candidates.append(record)
        return record

    def reuse(self,tool_id,problem_id,operation,input_text,output_text,binding,variable='',commit=True):
        result=dict(status='pending',accepted=False,reason='Unknown or unverified tool',reward=0.)
        if tool_id not in self.verified: return result
        tool=self.verified[tool_id];claim=tool['claim']
        try:
            if digest(claim)!=tool['claimHash'] or not verify_claim(claim)['accepted']:
                return dict(result,reason='Stored tool content or provenance hash changed')
            problem=self.problem_objects.get(problem_id)
            if problem is None: return dict(result,reason='No independently registered mathematical problem object')
            original,_,names=parse_expression(claim['input']);target,_,target_names=parse_expression(claim['output'])
            required=set(names+target_names+([claim['variable']] if claim['variable'] else []))
            if not isinstance(binding,dict) or set(binding)!=required: return dict(result,reason='Student must specify every parameter binding')
            converted={k:parse_expression(v)[0] for k,v in binding.items()}
            source_instance=substitute(original,converted);target_instance=substitute(target,converted)
            actual_source,_,actual_names=parse_expression(input_text);actual_target,_,actual_target_names=parse_expression(output_text)
            if actual_source not in problem['subexpressions']:
                return dict(result,status='rejected',reason='Claimed application does not match the actual problem or any parsed subexpression',reward=-.1)
            if operation=='differentiate' and (problem['operation']!='differentiate' or variable!=problem['variable']):
                return dict(result,status='rejected',reason='Differential variable or problem operation differs',reward=-.1)
            application=dict(operation=operation,input=input_text,output=output_text,variable=variable,scope='real_polynomial')
            checked=verify_claim(application)
            if not checked['accepted']: return dict(result,status=checked['status'],reason=checked['reason'],reward=-.1 if checked['status']=='rejected' else 0.)
            if operation!=claim['operation']: return dict(result,status='rejected',reason='Operation differs',reward=-.1)
            if claim['operation']=='differentiate':
                # Composition requires a chain rule. Rename the differential variable
                # only; all other parameter substitutions must be independent of it.
                _,tree,_=parse_expression(binding[claim['variable']])
                if not isinstance(tree.body,ast.Name) or tree.body.id!=variable:
                    return dict(result,reason='Differential variable binding is not a pure renaming')
                if any(variable in variables(value) for key,value in converted.items() if key!=claim['variable']):
                    return dict(result,reason='A constant parameter now depends on the differential variable')
            elif variable!='': return dict(result,reason='Rewrite must not specify a differential variable')
            if source_instance!=actual_source or target_instance!=actual_target:
                return dict(result,status='rejected',reason='Proposed application is not an instance of the student tool',reward=-.1)
            # A new question ID is not evidence of a new mathematical input.
            key=digest(dict(tool=tool_id,operation=operation,instance=instance_key(actual_source,actual_target,variable)))
            fresh=key not in self.reuse_ledger
            source_original=instance_key(original,target,claim['variable'])==instance_key(actual_source,actual_target,variable)
            fresh=fresh and not source_original and problem_id!=tool['originProblem']
            if fresh and commit: self.reuse_ledger.add(key)
            new_reward=fresh and tool_id not in self.rewarded_reuse_tools
            if new_reward and commit: self.rewarded_reuse_tools.add(tool_id)
            return dict(status='verified',accepted=True,reward=1. if new_reward else 0.,newCheckedReuse=fresh,
                certificate=checked['certificate'],key=key,toolId=tool_id,problem=problem_id,studentBinding=binding)
        except (OutsideScope,TypeError,KeyError) as error: return dict(result,reason=str(error))

    def connect(self,first,second,problem_id,first_application,second_application):
        a=self.reuse(first,problem_id,commit=False,**first_application);b=self.reuse(second,problem_id,commit=False,**second_application)
        if not a['accepted'] or not b['accepted']:
            if a['status']=='rejected' or b['status']=='rejected':
                return dict(status='rejected',accepted=False,reward=-.1,reason='An asserted component application is mathematically invalid')
            return dict(status='pending',accepted=False,reward=0.,reason='Both applications need verified content')
        if first==second: return dict(status='pending',accepted=False,reward=0.,reason='Connection needs two distinct tools')
        left,_,_=parse_expression(first_application['output_text']);right,_,_=parse_expression(second_application['input_text'])
        if left!=right: return dict(status='rejected',accepted=False,reward=-.1,reason='Intermediate mathematical object differs')
        key=digest(dict(first=first,second=second,
            secondOperation=second_application['operation']))
        fresh=key not in self.connection_ledger
        if fresh: self.connection_ledger.add(key)
        return dict(status='verified',accepted=True,reward=1. if fresh else 0.,newConnection=fresh,
            certificate=dict(kind='composition-of-two-exact-content-applications',first=a['certificate'],second=b['certificate'],intermediate=poly_json(left)),key=key)

    def export(self):
        return dict(protocol='lain-zip-content-model-v1',candidates=self.candidates,verifiedTools=list(self.verified.values()),
            reuseLedger=sorted(self.reuse_ledger),connectionLedger=sorted(self.connection_ledger),
            rewardedReuseTools=sorted(self.rewarded_reuse_tools),
            answerWeight=self.answer_weight,zipEventReward=1.,wrongAssertionPenalty=-.1,
            teacherRequests=0,modelGenerations=0,trainingUpdates=0,
            scope='bounded real polynomials; all other meanings pending',broadTransferProved=False)
