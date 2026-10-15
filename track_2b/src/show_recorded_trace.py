"""Display untouched archived model text, not a new model generation."""
import json,zipfile
from pathlib import Path
from verify_evidence import audit
audit()
ROOT=Path(__file__).resolve().parents[1]/'data'
with zipfile.ZipFile(ROOT/'evidence'/'Lain-Zip-Frozen-Replication-Review-20261014.zip') as z:
 r=json.loads(z.read('evidence/result.json'))
 row=next(x for x in r['rows'] if x['caseId']=='fixed-source-435-repeat-1')
 print('RECORDED EVIDENCE - NO LIVE INFERENCE - NO API CALLS\n')
 print('Inherited wrong note from earlier 0.5B student: 435 * v * v = 435^2')
 print('Fixed counterexample input: v = 0')
 print('Model sign checks:',row['properties'])
 print('\nOriginal model decision and explanation:\n'+row['reflectionRaw'])
 print('\nOriginal model-written replacement:\n'+row['replacementRaw'])
 print('\nOld note hash:',row['oldHash']);print('Revised note hash:',row['newHash'])
 for f in row['followup']:
  print('\nLater query: variable='+f['variable']+', multiplier='+str(f['multiplier']))
  for arm,a in f['results'].items():
   print(arm+' | original output: '+a['raw']+' | content correct: '+str(a['audit']['correct']))
   print('  original record: '+a['recordId'])
 print('\nScope: inherited-memory repair on an already-explored rule; no gain over the no-note content baseline.')
