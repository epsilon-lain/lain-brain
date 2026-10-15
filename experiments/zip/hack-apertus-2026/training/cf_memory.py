"""Student-chosen withdrawal and single student-written, formally checked replacement."""
import copy
import re
from rr_common import *
from rr_memory import initial,apply_action,attach_reflection
from rr_evaluate import math_audit


def proposal_audit(c,record):
    a=math_audit(dict(expression=c['card']['left'],scope='real_polynomial'),record)
    final=a['fullAudit']['writtenFinalExpression']
    accepted=bool(a['correctChangedExpression'] and a['fullAudit']['correctSimplifiedAnswer'] and final)
    reward=1. if accepted else 0. if a['correct'] or raw(record).strip().upper()=='SKIP' else -1. if a['falseSteps'] or a['finalEquivalent'] is False and a['formatComplete'] else -.2
    return dict(audit=a,studentFinal=final,accepted=accepted,reward=reward,
        studentRecordId=record['recordId'],studentRecordHash=record['hash'],
        teacherReplacementSupplied=False,hostWroteReplacement=False,rawOriginalRepaired=False)


def attach_proposal(memory,record,audit):
    check_seal(memory);check_seal(record)
    require(memory['universalClaimWithdrawn'],'Cannot replace a rule before actual withdrawal')
    require(record['caseCardId']==memory['card']['id'],'Proposal belongs to another rule')
    require(proposal_audit(dict(card=memory['card']),record)==audit,'Proposal audit was changed')
    new=copy.deepcopy(memory);new.pop('hash');new['parentMemoryHash']=memory['hash'];new['version']+=1
    new['proposal']=dict(raw=raw(record),recordId=record['recordId'],recordHash=record['hash'],audit=audit)
    new['replacementStatus']='active_verified_student_proposal' if audit['accepted'] else 'no_admitted_replacement'
    if audit['accepted']:
        new['replacement']=dict(left=memory['card']['left'],right=audit['studentFinal'],variable=memory['card']['variable'],
            author='student',sourceRecordId=record['recordId'],sourceRecordHash=record['hash'],externallyPolynomialChecked=True)
    new['history'].append(dict(type='student_proposal',accepted=audit['accepted'],recordId=record['recordId']))
    return sealed(new)


def active_note(memory):
    check_seal(memory)
    if memory.get('replacement'):return copy.deepcopy(memory['replacement'])
    return None if memory['universalClaimWithdrawn'] else copy.deepcopy(memory['card'])


def followup(memory,variable,no_note=False,multiplier=1):
    d=memory['card'];rename=lambda s:re.sub(r'\b'+re.escape(d['variable'])+r'\b',variable,s)
    expr=rename(d['left']);expr=expr if multiplier==1 else str(multiplier)+' * ('+expr+')'
    note=None if no_note else active_note(memory)
    text='No active saved ZIP is available.' if note is None else 'Retrieved saved ZIP (same variable binding):\n'+rename(note['left'])+' = '+rename(note['right'])
    text+='\nExpression to collect: '+expr+'. All named variables are independent real numbers.'
    return dict(expression=expr,scope='real_polynomial'),[
        dict(role='system',content='Write one collected algebraic expression. Use * and **. An equality chain is allowed. If unsure write SKIP.'),
        dict(role='user',content=text)]
