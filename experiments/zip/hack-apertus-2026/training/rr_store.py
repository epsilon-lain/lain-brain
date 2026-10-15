"""Weights + optimizer + zero-reward control + feedback receipt are ONE durable commit."""
import os
import shutil
import uuid
from pathlib import Path
from rr_common import *


def commits(out,binding):
    rows=[];prior=binding['initialReflectionHash'];control=binding['initialControlHash']
    from rr_cases import expected,validate_plan
    plan=read(Path(out)/'plan.json');validate_plan(plan)
    training={c['id']:c for c in plan['training']}
    for i,p in enumerate(sorted((Path(out)/'committed').glob('step-*')),1):
        r=read(p/'receipt.json');check_seal(r)
        require(set(r['fileHashes'])=={'reflection.safetensors','control.safetensors','optimizer.pt'},
            'Commit must contain exactly the declared weight/optimizer files')
        require(p.name=='step-'+str(i).zfill(4) and r['ordinal']==i and r['protocol']==PROTOCOL and
            r['sourceBindingHash']==digest(binding) and r['rewarded']['beforeReflectionHash']==prior and
            r['control']['beforeReflectionHash']==control==r['control']['afterReflectionHash'],
            'Broken reflection update/control receipt chain')
        for name,h in r['fileHashes'].items():require(sha(p/name)==h,'Committed file changed: '+name)
        check_seal(r['feedback'])
        for arm,receipt_key in [('rewarded','rewarded'),('zero_reward','control')]:
            ids=r[receipt_key]['sourceDecisionIds']
            require(len(ids)==len(r[receipt_key]['sourceDecisionHashes'])==2,'A committed batch must contain two TRAIN decisions')
            for j,rid in enumerate(ids):
                d=read(Path(out)/'decisions'/(rid+'.json'));check_seal(d)
                require(d['caseSplit']=='training' and d['caseId'] in training and
                    d['binding']['sourceBindingHash']==digest(binding) and d['binding']['arm']==arm and
                    d['reflectionHash']==r[receipt_key]['beforeReflectionHash'] and
                    d['hash']==r[receipt_key]['sourceDecisionHashes'][j] and
                    d['fixtureOnly']==binding.get('fixtureOnly',False), 'Committed decision provenance changed')
                observed=1. if d['action']==expected(training[d['caseId']]) else -1.
                require(r[receipt_key]['appliedRewards'][j]==(observed if arm=='rewarded' else 0.),
                    'Committed reward does not match its saved student action')
        prior=r['rewarded']['afterReflectionHash'];rows.append((p,r))
    return rows


def publish(out,ordinal,binding,rewarded,control,feedback,save):
    root=Path(out)/'committed';root.mkdir(parents=True,exist_ok=True)
    target=root/('step-'+str(ordinal).zfill(4));require(not target.exists(),'Refuse duplicate committed optimizer step')
    temporary=root/('.preparing-'+uuid.uuid4().hex);temporary.mkdir()
    try:
        save(temporary)
        names=('reflection.safetensors','control.safetensors','optimizer.pt')
        require(all((temporary/name).is_file() for name in names),'Incomplete optimizer/checkpoint transaction')
        receipt=sealed(dict(protocol=PROTOCOL,ordinal=ordinal,sourceBindingHash=digest(binding),
            rewarded=rewarded,control=control,feedback=feedback,
            fileHashes={name:sha(temporary/name) for name in names}))
        atomic_json(temporary/'receipt.json',receipt)
        for p in temporary.iterdir():
            with p.open('rb') as f:os.fsync(f.fileno())
        os.replace(temporary,target)
        fd=os.open(root,os.O_RDONLY)
        try:os.fsync(fd)
        finally:os.close(fd)
    finally:
        if temporary.exists():shutil.rmtree(temporary)


def partial(out,error,fixture_only=False):
    p=Path(out);rows=[read(x) for x in sorted((p/'committed').glob('step-*/receipt.json'))]
    r=dict(protocol=PROTOCOL,complete=False,fixtureOnly=fixture_only,error=error,
        committedReflectionSteps=len(rows),rewardedParameterChanges=sum(x['rewarded']['parameterChanged'] for x in rows),
        controlParameterChanges=sum(x['control']['parameterChanged'] for x in rows),
        actualDecisionRecords=len(list((p/'decisions').glob('*.json'))),
        actualStudentGenerations=len(list((p/'responses').glob('*.json'))),
        oldBaseUpdates=0,oldMathWriterUpdates=0,oldRepairUpdates=0)
    atomic_json(p/'partial-result.json',r);return r
