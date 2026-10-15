"""Freeze the exact reviewed e1828281 experiment and its last real student adapter."""
from rr_common import *
from rr_sources import admit as admit_legacy
from rr_store import commits as legacy_commits

PRIOR_HASH='5dea279016c9e11efaf95529e15362edefc9325355677840d863b7683ccfd8e8'


def admit(source):
    source=Path(source).resolve();protected={}
    for name,h in read(Path(__file__).with_name('cf_pins.json')).items():
        require(sha(source/name)==h,'Reviewed v23 source changed: '+name);protected[str(source/name)]=h
    p=read(source/'protocol.json');r=read(source/'result.json');b=read(source/'source-checkpoint.json')
    require(p['protocol']=='lain-zip-reflection-reward-final-v23' and r['complete'] and not r['fixtureOnly'] and
        r['committedReflectionSteps']==64 and r['rewardedParameterChanges']==64 and r['zeroRewardParameterChanges']==0,
        'Completed genuine reviewed v23 required')
    a=admit_legacy(Path(p['source']),Path(p['notesSource']));protected.update(a['protected'])
    tail=legacy_commits(source,b);require(len(tail)==64,'v23 receipt chain changed')
    deployment=read(source/'deployment-reflection.json');prior=source/'committed/step-0064/reflection.safetensors'
    require(Path(deployment['reflectionFile']).resolve()==prior and deployment['sourceBindingHash']==digest(b) and
        deployment['reflectionHash']==tail[-1][1]['rewarded']['afterReflectionHash']==PRIOR_HASH,'v23 deployment changed')
    protected[str(prior)]=tail[-1][1]['fileHashes']['reflection.safetensors']
    a.update(protected=protected,priorPath=prior,priorHash=PRIOR_HASH,latestSource=source,
        previousPlan=read(source/'plan.json'),previousResult=r,previousBinding=b)
    return a
