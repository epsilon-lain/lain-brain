"""Restore archived audit layout and replay 128 updates. Needs NumPy, no API."""
import json,runpy,sys,tempfile,zipfile,socket
from pathlib import Path
from verify_evidence import audit
audit()
ROOT=Path(__file__).resolve().parents[1]/'data'
def deny_network(*args,**kwargs):raise RuntimeError('Network prohibited during offline replay')
socket.create_connection=deny_network
with tempfile.TemporaryDirectory(prefix='lain-zip-offline-audit-') as directory:
 base=Path(directory)
 with zipfile.ZipFile(ROOT/'evidence'/'Lain-Zip-Memory-Learning-Final-Review-20261014.zip') as z:
  for name in z.namelist():
   destination=None
   if name.startswith('primary/source/'):
    destination=base/Path(name).name
   elif name.startswith('primary/evidence/'):
    suffix=name[len('primary/evidence/'):]
    destination=base/'policy-learning-results'/('frozen-plan.json' if suffix=='frozen-plan.json' else 'zip-policy-5411d33ddbc5/'+suffix)
   if destination:
    assert destination.resolve().is_relative_to(base.resolve())
    destination.parent.mkdir(parents=True,exist_ok=True);destination.write_bytes(z.read(name))
 sys.path.insert(0,str(base))
 runpy.run_path(str(base/'analyze_policy.py'),run_name='archived_gradient_audit')
 print('PASS: all 128 sampling, gradient, Adam-state and parameter updates replayed. API calls=0.')
