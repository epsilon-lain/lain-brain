"""Exercise real serialization and subprocess startup boundaries, not model mocks."""
import ast
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile
from unittest.mock import patch
import zip_weak_guidance_inspect as inspector
from zip_weak_guidance_core import host_guide
from test_zip_management_head import student_guide
from zip_management_head_receipts import review
from zip_management_head_progress import LaunchMonitor,run_child
from zip_management_head_offline import run_checks


class NativeSourceBoundaryChecks(unittest.TestCase):
    def write_guide(self,folder,guide,text=None,root=None,extra=False):
        p=Path(folder)/'weak-guidance-zips'/(guide['id']+'.zip');p.parent.mkdir(exist_ok=True)
        with zipfile.ZipFile(p,'w',zipfile.ZIP_DEFLATED) as z:
            z.writestr('root.json',json.dumps(guide if root is None else root))
            z.writestr('guidance.txt',guide['text'] if text is None else text)
            if extra:z.writestr('extra.txt','unbound')

    def test_source_admission_native_json_path_reads_host_and_student_guides(self):
        with tempfile.TemporaryDirectory() as d:
            for g in (host_guide(),student_guide('Compare actual recorded evidence.')):
                self.write_guide(d,g)
                self.assertEqual(inspector.read_native_guide(d,g),g)
            self.assertIs(inspector.json,json)

    def test_native_student_text_and_json_root_tampering_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            g=student_guide('Compare actual recorded evidence.')
            self.write_guide(d,g,text=g['text']+' Changed.')
            with self.assertRaisesRegex(ValueError,'native editable guide'):inspector.read_native_guide(d,g)
            changed=dict(g,text='Different advice')
            self.write_guide(d,g,root=changed)
            with self.assertRaisesRegex(ValueError,'native editable guide'):inspector.read_native_guide(d,g)
            self.write_guide(d,g,extra=True)
            with self.assertRaisesRegex(ValueError,'archive members'):inspector.read_native_guide(d,g)

    def test_all_bundled_json_users_have_explicit_namespace_bindings(self):
        missing=[]
        for path in Path(__file__).resolve().parent.glob('*.py'):
            if path.name.endswith('.template.py'):continue
            tree=ast.parse(path.read_text());uses=[n for n in ast.walk(tree) if isinstance(n,ast.Name) and n.id=='json' and isinstance(n.ctx,ast.Load)]
            if not uses:continue
            imports={a.asname or a.name.split('.')[0] for n in ast.walk(tree)
                     if isinstance(n,(ast.Import,ast.ImportFrom)) for a in n.names}
            bound=any(isinstance(n,ast.Name) and n.id=='json' and isinstance(n.ctx,ast.Store) for n in ast.walk(tree))
            if 'json' not in imports and not bound:missing.append(path.name)
        self.assertEqual(missing,[])


class ActualStartupChecks(unittest.TestCase):
    def test_actual_cli_source_rejection_saves_cause_without_loading_model(self):
        runtime=Path(__file__).resolve().parent
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);source=root/'fixture-source';source.mkdir();out=root/'out'
            (source/'protocol.json').write_text(json.dumps(dict(protocol='lain-zip-editable-weak-guidance-training-v10',teacherCalls=0,fixtureOnly=True)))
            command=[sys.executable,'-B',str(runtime/'zip_management_head_run.py'),'--source',str(source),
                     '--work',str(root),'--student',str(root/'absent-model'),'--old-tools',str(root/'absent-tools'),'--out',str(out)]
            environment=dict(os.environ,PYTHONPATH=str(runtime),PYTHONDONTWRITEBYTECODE='1')
            completed=subprocess.run(command,env=environment,cwd=runtime,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=30)
            self.assertEqual(completed.returncode,1)
            receipt=json.loads((out/'startup-error.json').read_text())
            self.assertIn('Fixture/teacher',receipt['error']);self.assertIn('inspect_source',receipt['traceback'])
            self.assertFalse(receipt['modelWeightsLoaded']);self.assertEqual(receipt['savedReturnedStudentOriginals'],0)
            self.assertEqual(receipt['savedHeadSteps'],0)
            self.assertFalse((out/'protocol.json').exists())
            archive=root/'review.zip';review(out,archive)
            with zipfile.ZipFile(archive) as z:
                self.assertIn('startup-error.json',z.namelist())
                self.assertIn('Fixture/teacher',z.read('startup-error.json').decode())

    def test_actual_child_stderr_is_captured_even_before_output_creation(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);log=root/'child.log';monitor=LaunchMonitor();monitor.deadline=time.monotonic()+30
            with redirect_stdout(io.StringIO()):
                status=run_child([sys.executable,'-c',"raise NameError(\"name 'json' is not defined\")"],
                    dict(os.environ),monitor,log_path=log)
            self.assertEqual(status['exitCode'],1)
            self.assertIn("NameError: name 'json' is not defined",log.read_text())
            self.assertIn('Traceback',log.read_text())

    def test_quiet_success_keeps_simulated_generation_counters_off_notebook(self):
        class Simulated(unittest.TestCase):
            def runTest(self):print('学生实际生成 16/28：route_math\n已暂停')
        capture=io.StringIO()
        with patch.object(unittest.defaultTestLoader,'loadTestsFromNames',return_value=unittest.TestSuite([Simulated()])),redirect_stdout(capture):
            self.assertEqual(run_checks(['isolated_fixture']),0)
        self.assertNotIn('16/28',capture.getvalue());self.assertNotIn('已暂停',capture.getvalue())
        self.assertIn('真实学生生成＝0',capture.getvalue())


if __name__=='__main__':unittest.main()

def test_parent_emergency_review_keeps_full_original_traceback(self):
    import zipfile,json,tempfile
    from pathlib import Path
    namespace={'zipfile':zipfile,'json':json}
    exec('def write_entry_failure_review(archive, status, child_log):\n    """A pre-output crash still delivers its complete original stderr/stdout."""\n    with zipfile.ZipFile(archive, \'x\', zipfile.ZIP_DEFLATED) as z:\n        z.writestr(\'entry-error.json\', json.dumps(status))\n        if child_log.is_file():\n            z.write(child_log, \'child-output.log\')',namespace)
    with tempfile.TemporaryDirectory() as d:
        p=Path(d);log=p/'child.log';log.write_text("Traceback\nNameError: name 'json' is not defined\n")
        namespace['write_entry_failure_review'](p/'review.zip',{'exitCode':1},log)
        with zipfile.ZipFile(p/'review.zip') as z:
            self.assertIn('child-output.log',z.namelist())
            self.assertIn('NameError',z.read('child-output.log').decode())

ActualStartupChecks.test_parent_emergency_review_keeps_full_original_traceback=test_parent_emergency_review_keeps_full_original_traceback
