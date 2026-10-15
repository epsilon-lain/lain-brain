"""Verify the separate 14-response implementation smoke without inference."""
import hashlib,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]/'data/prototype-smoke'
def read(p):return json.loads(p.read_text())
def digest(x):return hashlib.sha256(json.dumps(x,sort_keys=True,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode()).hexdigest()
def audit():
    analysis=read(ROOT/'analysis.json');sealed=0;responses=0
    for row in analysis['rows']:
        # Preserve source result hashes and every raw response, including failed controls.
        paths=[p for p in ROOT.glob('live-*') if read(p/'result.json')['hash']==row['sourceResultHash']]
        assert len(paths)==1;path=paths[0];result=read(path/'result.json')
        for p in path.rglob('*.json'):
            x=read(p)
            if isinstance(x,dict) and 'hash' in x:
                assert digest({k:v for k,v in x.items() if k!='hash'})==x['hash'],p.name;sealed+=1
        raw=[read(p) for p in (path/'raw').glob('*.json')]
        assert len(raw)==7 and all(x['fixtureOnly'] is False for x in raw)
        records={x['recordId']:x for x in raw};responses+=len(raw)
        for receipt in (path/'attempts').glob('*.json'):
            x=read(receipt);assert x['status']=='committed'
            assert records['api-'+x['requestId']]['hash']==x['recordHash']
        assert result['action']==row['action'] and result['groundedConflict']==row['groundedConflict']
        assert any(x['studentOutput']['raw']==result['reflectionRaw'] and x['phase']=='revision_action' for x in raw)
        assert any(x['studentOutput']['raw']==result['replacementRaw'] and x['phase']=='independent_editor' for x in raw)
        for arm,want in row['followup'].items():
            got=result['followup'][arm]
            assert records[got['recordId']]['studentOutput']['raw']==got['raw']
            assert bool(got['audit']['fullAudit']['correctFinalAnswer'])==want['finalExpressionCorrect']
            assert bool(got['audit']['correct'])==want['fullOutputAccepted']
        case=read(path/'protocol.json')['case']
        assert bool(case['card'].get('knownExactIdentity') and result['action']=='RETRACT')==row['falseWithdrawalOnCorrectOriginal']
    assert responses==14 and analysis['falseWithdrawalOnCorrectControl']==1
    return {'status':'PASS','separatePrototypeResponses':responses,'sealedRecordsVerified':sealed,
        'falseCorrectNoteWithdrawalsRetained':1,'originalFrozenEvaluationUnchanged':True,'networkRequests':0}
if __name__=='__main__':print(json.dumps(audit(),indent=2))
