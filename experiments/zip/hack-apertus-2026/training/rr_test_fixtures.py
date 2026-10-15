"""ONLY for unit tests. None of these objects is a real student result."""
from rr_common import *


def fixture_cards():
    specifications=[('drop_variable','435 * v * v','435^2','v',False,'student_saved_zip'),
        ('outer_coefficient','1 * (3 * p + 1) + 2 * (3 * p + 1)','3 * (3 * p + 1) + 2 * (3 * p + 1)','p',False,'student_train_answer'),
        ('swapped_distribution','3 * (8 * p + 2)','24 * (8 + p)','p',False,'student_train_answer'),
        ('correct_identity','1 * (315 * v)','315 * v','v',True,'student_saved_zip')]
    return [dict(id='fixture-card-'+str(i),family=f,left=l,right=r,variable=v,knownExactIdentity=t,
        provenance=dict(kind=k,recordId='fixture-record-'+str(i),recordHash='fixture-hash',
            verbatimExcerpt=l+' = '+r),split='source_readback') for i,(f,l,r,v,t,k) in enumerate(specifications)]


def fixture_decision(card,action='RETRACT'):
    return sealed(dict(recordId='fixture-decision',caseCardId=card['id'],action=action,
        expectedActionSuppliedToModel=False,fixtureOnly=True))


def fixture_raw(text,capped=False):
    return sealed(dict(recordId='fixture-raw',fixtureOnly=True,studentOutput=dict(raw=text,
        tokenCapReached=capped,originalTextRepaired=False,testDouble=True)))
