"""Meta/editor weights, both zero controls, both optimizers, and feedback commit atomically."""
import shutil
from rr_common import *
from cf_cases import PROTOCOL,validate_plan,return_table

FILES=('meta.safetensors','meta-control.safetensors','editor.safetensors','editor-control.safetensors',
       'meta-optimizer.pt','editor-optimizer.pt')


def commits(out,binding):
    out=Path(out);p=read(out/'plan.json');validate_plan(p);training={c['id']:c for c in p['training']}
    prior=dict(binding['initialHashes']);rows=[]
    for i,directory in enumerate(sorted((out/'committed').glob('step-*')),1):
        r=read(directory/'receipt.json');check_seal(r);check_seal(r['feedback'])
        phase='meta' if i<=p['recipe']['metaSteps'] else 'editor'
        require(directory.name=='step-'+str(i).zfill(4) and r['ordinal']==i and r['protocol']==PROTOCOL and
            r['sourceBindingHash']==digest(binding) and r['phase']==phase and r['beforeHashes']==prior and
            set(r['fileHashes'])==set(FILES),'Broken two-phase receipt chain')
        for name,h in r['fileHashes'].items():require(sha(directory/name)==h,'Committed bytes changed: '+name)
        key=phase;control_key=phase+'_control';after=dict(prior)
        require(r['rewarded']['beforeHash']==prior[key] and r['control']['beforeHash']==r['control']['afterHash']==prior[control_key] and
            r['control']['optimizerStep'] is False and r['control']['parameterChanged'] is False,'Zero reward stepped or hash chain changed')
        after[key]=r['rewarded']['afterHash'];require(r['afterHashes']==after,'Unrelated phase weights changed')
        for arm,receipt_key in [('rewarded','rewarded'),('zero_reward','control')]:
            u=r[receipt_key];require(len(u['sourceIds'])==len(u['sourceHashes']),'Missing source hashes')
            for j,rid in enumerate(u['sourceIds']):
                folder='decisions' if phase=='meta' else 'responses'
                source=read(out/folder/(rid+'.json'));check_seal(source)
                require(source['caseId'] in training and source['caseSplit']=='training' and source['binding']['arm']==arm and
                    source['binding']['sourceBindingHash']==digest(binding) and source['hash']==u['sourceHashes'][j] and
                    source['fixtureOnly']==binding['fixtureOnly'] and source['binding']['adapterHash']==prior[key if arm=='rewarded' else control_key],
                    'TRAIN-only on-policy source binding changed')
            if phase=='meta':
                contexts=r['feedback']['contexts'][arm]
                require(len(contexts)==len(u['sourceIds'])==12,'Two complete six-choice episodes required')
                for j,context in enumerate(contexts):
                    case=training[context['caseId']]
                    require(context['recordId']==u['sourceIds'][j] and
                        u['returnTables'][j]==return_table(case,context['role'],context.get('props')),'Reward table is not grounded in recorded TRAIN case')
            else:
                from cf_memory import proposal_audit
                require(len(u['sourceIds']) in (0,2),'Editor must retain both samples without selection')
                for j,rid in enumerate(u['sourceIds']):
                    source=read(out/'responses'/(rid+'.json'))
                    require(u['observedRewards'][j]==proposal_audit(training[source['caseId']],source)['reward'],'Editor reward disagrees with untouched proposal')
        prior=after;rows.append((directory,r))
    return rows


def publish(out,ordinal,binding,phase,before,after,rewarded,control,feedback,save):
    root=Path(out)/'committed';root.mkdir(parents=True,exist_ok=True)
    target=root/('step-'+str(ordinal).zfill(4));require(not target.exists(),'Refuse duplicate optimizer publication')
    temp=root/('.preparing-'+uuid.uuid4().hex);temp.mkdir()
    try:
        save(temp);require(all((temp/n).is_file() for n in FILES),'Incomplete two-phase transaction')
        receipt=sealed(dict(protocol=PROTOCOL,ordinal=ordinal,phase=phase,sourceBindingHash=digest(binding),
            beforeHashes=before,afterHashes=after,rewarded=rewarded,control=control,feedback=feedback,
            fileHashes={n:sha(temp/n) for n in FILES}))
        atomic_json(temp/'receipt.json',receipt)
        for path in temp.iterdir():
            with path.open('rb') as f:os.fsync(f.fileno())
        os.replace(temp,target)
        fd=os.open(root,os.O_RDONLY)
        try:os.fsync(fd)
        finally:os.close(fd)
        return receipt
    finally:
        if temp.exists():shutil.rmtree(temp)


def partial(out,error,fixture_only=False):
    out=Path(out);rows=[read(p) for p in sorted((out/'committed').glob('step-*/receipt.json'))]
    r=dict(protocol=PROTOCOL,complete=False,fixtureOnly=fixture_only,error=error,
        metaCommitted=sum(x['phase']=='meta' for x in rows),editorCommitted=sum(x['phase']=='editor' for x in rows),
        metaParameterChanges=sum(x['phase']=='meta' and x['rewarded']['parameterChanged'] for x in rows),
        editorParameterChanges=sum(x['phase']=='editor' and x['rewarded']['parameterChanged'] for x in rows),
        actualStudentGenerations=len(list((out/'responses').glob('*.json'))),
        actualDecisionRecords=len(list((out/'decisions').glob('*.json'))),resumeWithoutDuplicateCommittedUpdates=True)
    atomic_json(out/'partial-result.json',r);return r
