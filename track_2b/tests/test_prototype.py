"""Offline plumbing tests use explicit fake transport, never mock evidence."""
import json,sys,tempfile,unittest,threading,urllib.request
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
import app

class PrototypeTests(unittest.TestCase):
    def test_final_expression_and_full_output_scores_are_separate(self):
        path=app.ROOT/'data/prototype-smoke/live-55f307ce878f/result.json'
        result=app.H['check_seal'](json.loads(path.read_text()))
        scores=app.displayed_scores(result['followup']['no_note']['audit'])
        self.assertTrue(scores['contentCorrect'])
        self.assertFalse(scores['strictCorrect'])
        self.assertFalse(app.displayed_scores(result['followup']['old_note']['audit'])['contentCorrect'])
    def test_python_http_archive_ui_and_status(self):
        server=app.ThreadingHTTPServer(('127.0.0.1',0),app.Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        base='http://127.0.0.1:'+str(server.server_address[1])
        try:
            with urllib.request.urlopen(base+'/api/evidence') as response:x=json.load(response)
            self.assertIn('NOT LIVE',x['mode']);self.assertTrue(x['row']['replacementAccepted'])
            with urllib.request.urlopen(base+'/') as response:html=response.read().decode()
            self.assertNotIn('__CSRF__',html)
            with urllib.request.urlopen(base+'/api/status') as response:status=json.load(response)
            self.assertNotIn('key',status)
        finally:server.shutdown();server.server_close();thread.join()
    def test_archived_example_and_negative_result_are_distinct(self):
        x=app.archived()
        self.assertEqual(x['row']['replacementRaw'],'435 * v²')
        self.assertFalse(x['row']['followup'][1]['results']['old_note']['audit']['correct'])
        self.assertTrue(x['row']['followup'][1]['results']['new_note']['audit']['correct'])
        self.assertEqual(x['learning']['TESTCorrect'],0)
    def test_key_required_and_private_endpoint_rejected(self):
        with self.assertRaises(ValueError):app.config('')
        with patch.object(app,'BASE','https://user:password@example.com/v1'):
            with self.assertRaises(ValueError):app.config('private-test-value')
    def test_non_apertus_model_rejected(self):
        with patch.object(app,'MODEL','some-other-model'):
            with self.assertRaises(ValueError):app.config('private-test-value')
    def test_pending_receipt_survives_provider_failure(self):
        with tempfile.TemporaryDirectory() as p:
            ledger=app.Ledger(p,{'url':'https://example.invalid/v1','model':app.MODEL,'key':'test-private-value'})
            with patch.object(app.urllib.request,'build_opener',side_effect=RuntimeError('simulated transport failure')):
                with self.assertRaises(RuntimeError):ledger.ask('offline_test',app.cases()['435'],[])
            receipts=[json.loads(x.read_text()) for x in (Path(p)/'attempts').glob('*.json')]
            self.assertEqual(receipts[0]['status'],'pending')
            self.assertEqual(list((Path(p)/'raw').iterdir()),[])
            self.assertNotIn('test-private-value',''.join(x.read_text() for x in Path(p).rglob('*.json')))
    def test_tampered_cached_response_rejected_without_network(self):
        with tempfile.TemporaryDirectory() as p:
            cfg={'url':'https://example.invalid/v1','model':app.MODEL,'key':'private-test-value'}
            c=app.cases()['435'];body={'model':app.MODEL,'messages':[],'max_tokens':1024,'temperature':0}
            ident=app.H['digest']({'body':body,'phase':'offline_test','caseId':c['id'],'endpoint':cfg['url']})
            ledger=app.Ledger(p,cfg);(Path(p)/'raw'/(ident+'.json')).write_text(json.dumps({'hash':'invalid','studentOutput':{'raw':'fabricated'}}))
            with patch.object(app.urllib.request,'build_opener',side_effect=AssertionError('network must not run')):
                with self.assertRaises(Exception):ledger.ask('offline_test',c,[])
    def test_exact_auditor_rejects_wrong_replacement(self):
        c=app.cases()['435']
        def record(text):return app.H['sealed']({'recordId':'explicit-test-fixture','caseCardId':c['card']['id'],'fixtureOnly':True,'studentOutput':{'raw':text,'tokenCapReached':False}})
        self.assertFalse(app.H['proposal_audit'](c,record('435**2'))['accepted'])
        self.assertTrue(app.H['proposal_audit'](c,record('435*v**2'))['accepted'])
    def test_normalization_does_not_change_coefficients(self):
        r=app.H['sealed']({'recordId':'explicit-test-fixture','caseCardId':'test-card','studentOutput':{'raw':'435 * v²','tokenCapReached':False}})
        x=app.normalized(r);self.assertEqual(x['studentOutput']['raw'],'435 * v**2');self.assertEqual(x['originalRaw'],'435 * v²')

if __name__=='__main__':unittest.main()
