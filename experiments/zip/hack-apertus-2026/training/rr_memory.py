"""The host executes the STUDENT'S action; an oracle cannot choose the memory edit."""
import copy
from rr_common import *


def initial(card):
    return sealed(dict(card=copy.deepcopy(card),version=0,status='active_unverified',
        universalClaimWithdrawn=False,history=[],correctnessAutomaticallyCertified=False))


def apply_action(memory,decision):
    check_seal(memory);check_seal(decision)
    require(decision['action'] in ('KEEP','RETRACT'),'Unsupported student action')
    require(decision['caseCardId']==memory['card']['id'],'Edit belongs to another ZIP')
    require(decision['expectedActionSuppliedToModel'] is False,'Oracle-chosen edits are forbidden')
    new=copy.deepcopy(memory);new.pop('hash');new['version']+=1
    if decision['action']=='RETRACT':new['status']='withdrawn_as_universal';new['universalClaimWithdrawn']=True
    # KEEP does not make a new theorem, and does not automatically reactivate a withdrawn card.
    new['history'].append(dict(decisionId=decision['recordId'],action=decision['action'],
        studentSelectedAction=True,oracleSelectedAction=False))
    return sealed(new)


def retrieve(memory):
    check_seal(memory)
    return [] if memory['status']=='withdrawn_as_universal' else [copy.deepcopy(memory['card'])]


def attach_reflection(memory,record):
    """A second durable version holds the student's untouched note, without certifying it."""
    check_seal(memory);check_seal(record)
    new=copy.deepcopy(memory);new.pop('hash');new['version']+=1
    new['parentMemoryHash']=memory['hash']
    new['studentWrittenText']=raw(record)
    new['studentWrittenTextRecordId']=record['recordId']
    new['studentWrittenTextHash']=digest(raw(record))
    new['studentWrittenTextSemanticallyCertified']=False
    new['history'].append(dict(type='student_written_reflection',recordId=record['recordId'],
        sourceRecordHash=record['hash'],originalTextRepaired=False))
    return sealed(new)


def followup_prompt(memory,variable,use_student_text=False):
    card=memory['card']
    import re
    expression=re.sub(r'\b'+re.escape(card['variable'])+r'\b',variable,card['left'])
    visible=retrieve(memory)
    if use_student_text:
        context=('Your own revised ZIP draft, not certified by the host:\n'+memory.get('studentWrittenText','')+
            '\nState of its old universal assertion: '+memory['status']+
            '. Do not assume a withdrawn assertion is still valid.')
    elif visible:
        rule=card['left']+' = '+card['right']
        context='Candidate saved ZIP, not certified by the host:\n'+rule
    else:
        # The withdrawn formula is deliberately not supplied as an active shortcut.
        context='No active saved ZIP is available. Solve independently, or write SKIP if unsure.'
    prompt=[dict(role='system',content='Rewrite the requested expression once. Use * and **. '
        'An equality chain is allowed. Do not invent a certified rule.'),
        dict(role='user',content=context+'\nCurrent expression: '+expression+'. All named variables are independent real numbers.')]
    return dict(expression=expression,scope='real_polynomial'),prompt
