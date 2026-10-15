import json,sys,tempfile,unittest,zipfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from export_checkpoints import export,inventory
class ExportTests(unittest.TestCase):
    def test_export_selects_only_requested_checkpoint_bytes(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t)/'train';root.mkdir();(root/'adapter.safetensors').write_bytes(b'explicit test fixture, not real weights')
            (root/'private.env').write_text('PRIVATE_FIELD=not-to-export')
            self.assertEqual(len(inventory(root)),1)
            out=Path(t)/'export.zip';result=export(root,['adapter.safetensors'],out)
            with zipfile.ZipFile(out) as z:
                self.assertNotIn('private.env',z.namelist());self.assertEqual(z.read('checkpoints/adapter.safetensors'),(root/'adapter.safetensors').read_bytes())
                self.assertEqual(len(json.loads(z.read('checkpoint-manifest.json'))['files']),1)
            self.assertFalse(result['uploaded'])
    def test_outside_root_and_overwrite_are_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t)/'train';root.mkdir();(Path(t)/'outside.pt').write_bytes(b'explicit fixture')
            with self.assertRaises(ValueError):export(root,['../outside.pt'],Path(t)/'out.zip')
            (root/'one.pt').write_bytes(b'explicit fixture');out=Path(t)/'out.zip';out.write_bytes(b'existing')
            with self.assertRaises(ValueError):export(root,['one.pt'],out)
