"""Admit ONLY reviewed genuine notes, original TRAIN errors and final frozen weights."""
from pathlib import Path
from rr_common import *
from zip_content_core import parse_expression,verify_claim


def equal(a,b):
    return verify_claim(dict(operation='rewrite',input=a,output=b,variable='',scope='real_polynomial'))['accepted']


def admit(source,notes_source):
    source=Path(source).resolve();notes_source=Path(notes_source).resolve()
    pins=read(Path(__file__).with_name('rr_pins.json'));protected={}
    for folder,key in [(source,'repair'),(notes_source,'notes')]:
        for name,h in pins[key].items():
            p=folder/name;require(sha(p)==h,'Reviewed source changed: '+str(p));protected[str(p)]=h
    b=read(source/'source-checkpoint.json');deployment=read(source/'deployment-repair.json')
    receipt=read(source/'committed/step-0032/receipt.json');result=read(source/'result.json')
    require(result['completeTrainingExperiment'] and result['fixtureOnly'] is False and
        result['committedRepairUpdates']==32 and result['parameterChangingUpdates']==32 and
        result['baseWeightsUnchanged'] and result['mathematicalWriterUnchanged'] and result['verifierUnchanged'],
        'Completed genuine final repair checkpoint required')
    require(deployment['sourceBindingHash']==digest(b)==receipt['sourceBindingHash'] and
        receipt['receiptHash']==digest({k:v for k,v in receipt.items() if k!='receiptHash'}) and
        deployment['repairHash']==receipt['afterRepairHash'],'Final repair binding changed')
    repair=source/'committed/step-0032/repair.safetensors';writer=Path(b['mathSource']['writerFile']).resolve()
    require(Path(deployment['repairFile']).resolve()==repair and sha(repair)==receipt['repairFileHash'],'Final repair bytes changed')
    require(sha(writer)==pins['writerFileHash'] and deployment['writerHash']==b['mathSource']['writerHash'],'Final math writer changed')
    protected.update({str(repair):receipt['repairFileHash'],str(writer):pins['writerFileHash']})
    bank=read(notes_source/'reflection-bank.json');bank_rows={x['recordId']:x for x in bank['notes']}
    specifications=[
        (notes_source,'reflection-call-1d5aaf9a83ae2b19e40b616f','drop_variable',
         '435 * v * v','435^2','student_saved_zip',False),
        (source,'contradiction-call-8134ce514d05dc4168ad74a6','outer_coefficient',
         '1 * (3 * p + 1) + 2 * (3 * p + 1)','3 * (3 * p + 1) + 2 * (3 * p + 1)','student_train_answer',False),
        (source,'contradiction-call-26616be39124dc93a78b6888','swapped_distribution',
         '3 * (8 * p + 2)','24 * (8 + p)','student_train_answer',False),
        (notes_source,'reflection-call-9f74faa10886768258f47170','correct_identity',
         '1 * (315 * v)','315 * v','student_saved_zip',True)]
    cards=[];records={}
    for folder,rid,family,left,right,kind,truth in specifications:
        r=read(folder/('responses/'+rid+'.json'))
        require(r['recordHash']==digest({k:v for k,v in r.items() if k!='recordHash'}) and
            r['fixtureOnly'] is False and r['task']['split']=='training' and
            r['studentOutput']['originalTextRepaired'] is False and not r['studentOutput'].get('testDouble'),
            'Not a genuine immutable old TRAIN record')
        excerpt=left+' = '+right
        require(excerpt in raw(r),'Reviewed equality is not a literal student-written excerpt')
        if kind=='student_saved_zip':
            require(bank_rows[rid]['raw']==raw(r) and r['studentOutput']['mathAdapterEnabledDuringGeneration'] is False,
                'Saved note author/bank binding changed')
        require(equal(left,right)==truth,'Reviewed rule truth changed')
        names=set(parse_expression(left)[2])|set(parse_expression(right)[2]);require(len(names)==1,'Single variable required')
        cards.append(dict(id='source-rule-'+digest(dict(left=left,right=right,recordId=rid))[:16],
            family=family,left=left,right=right,variable=next(iter(names)),
            provenance=dict(kind=kind,recordId=rid,recordHash=r['recordHash'],verbatimExcerpt=excerpt),
            knownExactIdentity=truth,split='source_readback'))
        records[rid]=r
    return dict(binding=b,deployment=deployment,writer=writer,repair=repair,
        identity=read(source/'model-identity.json'),protected=protected,cards=cards,sourceRecords=records,
        coldRecord=records['contradiction-call-8134ce514d05dc4168ad74a6'])
