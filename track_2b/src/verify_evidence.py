"""Offline integrity and headline-result audit. Sends no model requests."""
import hashlib,json,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]/'data'
def canonical(x):return json.dumps(x,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)
def digest(x):return hashlib.sha256(canonical(x).encode()).hexdigest()
def audit():
 claims=json.loads((ROOT/'Claims-and-Evidence.json').read_text());sealed=0;entries=0;raw_counts={}
 for name,expected in claims['archiveSHA256'].items():
  p=ROOT/'evidence'/name;assert hashlib.sha256(p.read_bytes()).hexdigest()==expected,('Archive changed',name)
  records={}
  with zipfile.ZipFile(p) as z:
   assert z.testzip() is None
   for n in z.namelist():
    assert not n.startswith('/') and '..' not in Path(n).parts
    if n.endswith('manifest.json'):
     manifest=json.loads(z.read(n));prefix=str(Path(n).parent)
     prefix='' if prefix=='.' else prefix+'/'
     for child,h in manifest.items():assert hashlib.sha256(z.read(prefix+child)).hexdigest()==h,child
    if n.endswith('.json'):
     obj=json.loads(z.read(n))
     if isinstance(obj,dict) and 'hash' in obj:
      assert obj['hash']==digest({k:v for k,v in obj.items() if k!='hash'}),n;sealed+=1
     if isinstance(obj,dict) and '/raw/' in '/'+n and 'recordId' in obj:
      assert obj['fixtureOnly'] is False and obj['recordId'] not in records
      records[obj['recordId']]=obj
    entries+=1
   raw_counts[name]=len(records)
   if 'Frozen-Replication' in name:
    r=json.loads(z.read('evidence/result.json'));s=json.loads(z.read('summary.json'))
    assert len(r['rows'])==6 and s['ruleUnits']==5
    assert sum(x['candidateTwoFollowupClosedLoop'] for x in r['rows'] if not x['trueOriginal'])==s['primaryStrictClosedLoops']==3
    assert sum(x['action']=='RETRACT' for x in r['rows'] if not x['trueOriginal'])==4
    assert sum(x['replacementAccepted'] for x in r['rows'] if not x['trueOriginal'])==4
    assert sum(x['correctNoteWithdrawn'] for x in r['rows'] if x['trueOriginal'])==0
    for arm,want in [('no_note',12),('old_note',10),('new_note',12)]:
     assert sum(f['results'][arm]['audit']['correct'] for x in r['rows'] for f in x['followup'])==want
    for row in r['rows']:
     assert records[row['coldBelief']['recordId']]['studentOutput']['raw']==row['coldBelief']['raw']
     for f in row['followup']:
      for ans in f['results'].values():assert records[ans['recordId']]['studentOutput']['raw']==ans['raw']
    example=next(x for x in r['rows'] if x['caseId']=='fixed-source-435-repeat-1')
    for phase,output in [('revision_action',example['reflectionRaw']),('independent_editor',example['replacementRaw'])]:
     assert any(rr['phase']==phase and rr['caseCardId']==example['cardId'] and rr['studentOutput']['raw']==output for rr in records.values())
   if 'Memory-Learning-Final' in name:
    s=json.loads(z.read('primary/summary.json'));r=s['primaryResult'];e=json.loads(z.read('exploratory/result.json'))
    assert r['controllerParameterChangingUpdates']==128 and r['APIModelWeightUpdates']==0
    assert r['learnedGreedyActions']==['RETRACT']*4 and r['learnedSelectedCorrectAnswers']==0
    assert s['heldoutAnswerBreakdown']['LEARNED']['skip']==8
    assert e['flexibleNoteCorrect']==0 and e['primaryFormulaNoteCorrect']==1 and e['denominator']==6
    assert len([n for n in z.namelist() if n.startswith('primary/evidence/controller-commits/')])==128
 assert list(raw_counts.values())==[72,63,110],raw_counts
 return {'status':'PASS','networkRequests':0,'savedRealAPIResponses':sum(raw_counts.values()),'rawCountsByArchive':raw_counts,
 'sealedJSONRecordsVerified':sealed,'archiveEntriesInspected':entries,'headlineCountsAndRawLinksChecked':True}
if __name__=='__main__':print(json.dumps(audit(),indent=2))
