import contextlib,importlib.util,io,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch

PATH=Path(__file__).with_name('Lain-Zip-Apertus-API-Test.py')
spec=importlib.util.spec_from_file_location('api_v25',PATH)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class APIContractTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.work=Path(self.temp.name)
        self.h=m.setup(self.work)
        self.cfg=dict(key='NOT-A-REAL-KEY',url='https://example.invalid/v1',model='swiss-ai/Apertus-v1.5-8B',token_field='max_tokens',budget=512,extra={})
        self.api=m.API(self.cfg,self.work/'out',self.h)
        self.count=0
    def tearDown(self):self.temp.cleanup()
    def response(self,cfg,path,body=None):
        self.count+=1;messages=body['messages'];system=messages[0]['content'];user=messages[-1]['content']
        c=m.PLAN['cases'][0]
        if 'Classify the sign' in system:
            raw='ZERO' if '(0)' in user else 'POSITIVE'
        elif 'Count factors' in system:
            raw='TWICE' if user.endswith('v') or user.endswith('m') else 'ONCE'
        elif 'evidence-commit' in system:
            raw='RETRACT' if 'Left at 0: ZERO\nRight at 0: POSITIVE' in user else 'KEEP'
        elif 'original product' in system:raw='435 * v**2' if '435' in user else '49 * m**2'
        elif 'revised ZIP' in system:raw='The same-input zero/positive mismatch refutes the old universal claim. Retain the variable squared.'
        else:
            if '435' in user:a='435'
            elif '315' in user:a='315'
            else:a='49'
            variable='v' if 'Collect:' in user else 'z' if '* z' in user else 'q'
            coef=int(a)*(2 if '2 * (' in user else 1)
            raw=str(coef)+' * '+variable+('' if a=='315' else '**2')
        return {'id':'mock-response-'+str(self.count),'model':cfg['model'],'choices':[{'message':{'content':raw},'finish_reason':'stop'}],'usage':{'completion_tokens':9}}
    def test_parse_never_infers_ambiguous_choice(self):
        self.assertIsNone(m.parse_choice('KEEP or RETRACT',('KEEP','RETRACT')))
        self.assertIsNone(m.parse_choice('RETRACT',('KEEP','RETRACT'),True))
        self.assertEqual(m.parse_choice('{"action":"RETRACT"}',('KEEP','RETRACT')),'RETRACT')
    def test_missing_config_does_not_echo_secret(self):
        with patch.dict(m.os.environ,{},clear=True):
            with self.assertRaises(RuntimeError) as e:m.config({'API_KEY':'never-echo-this'})
        self.assertNotIn('never-echo-this',str(e.exception))
    def test_local_student_model_not_selected_as_api(self):
        with patch.dict(m.os.environ,{},clear=True):
            cfg=m.config({'API_KEY':'x','BASE_URL':'https://example.invalid/v1','MODEL_ID':'swiss-ai/Apertus-v1.1-0.5B-Instruct'})
            self.assertIsNone(cfg['model'])
    def test_configuration_dict_and_mixed_case_aliases(self):
        with patch.dict(m.os.environ,{},clear=True):
            cfg=m.config({'APERTUS_SETTINGS':{'apiKey':'private','baseURL':'https://example.invalid/v1','modelId':'Apertus-8B'}})
            self.assertEqual(cfg['key'],'private');self.assertEqual(cfg['model'],'Apertus-8B')
    def test_named_client_is_detected(self):
        from types import SimpleNamespace
        with patch.dict(m.os.environ,{},clear=True):
            cfg=m.config({'swiss_client':SimpleNamespace(base_url='https://example.invalid/v1',api_key='private')})
            self.assertEqual(cfg['key'],'private')
    def test_nested_api_config_detected(self):
        with patch.dict(m.os.environ,{},clear=True):
            cfg=m.config({'settings':{'apertus':{'token':'private','endpoint':'https://example.invalid/v1','model':'Apertus-8B'}}})
            self.assertEqual(cfg['key'],'private')
    def test_multiple_provider_pairs_are_not_combined(self):
        ns={'api_config_a':{'api_key':'A','base_url':'https://a.invalid/v1'},'api_config_b':{'api_key':'B','base_url':'https://b.invalid/v1'}}
        with patch.dict(m.os.environ,{},clear=True),self.assertRaises(m.ConfigurationMissing) as e:m.config(ns)
        self.assertNotIn('https://',str(e.exception))
    def test_inventory_only_exposes_names_and_types(self):
        text=json.dumps(m.configuration_inventory({'APERTUS_KEY':'never-print-secret','api_config':{'token':'never-print-secret','endpoint':'https://private.invalid'}}))
        self.assertIn('APERTUS_KEY',text);self.assertNotIn('never-print-secret',text);self.assertNotIn('private.invalid',text)
    def test_model_discovery_selects_apertus_8b(self):
        cfg=dict(self.cfg,model=None)
        with patch.object(m,'request',return_value={'data':[{'id':'other-model'},{'id':'Apertus-v1.5-70B'},{'id':'Apertus-v1.5-8B'}]}):
            self.assertEqual(m.resolve_model(cfg)['model'],'Apertus-v1.5-8B')
    def test_insecure_external_url_rejected(self):
        with self.assertRaises(RuntimeError):m.config({'ZIP_API_CONFIG':{'api_key':'x','base_url':'http://remote.invalid','model':'Apertus-8B'}})
    def test_original_prompts_have_no_gold_values(self):
        c=m.PLAN['cases'][0]
        for role in self.h['ROLES']:
            p=self.h['property_prompt'](c,role)
            self.assertNotIn('189225',str(p))
        self.assertNotIn('435 * v**2',str(self.h['memory_prompt'](c)))
    def test_same_sign_and_different_inputs_are_controls(self):
        self.assertEqual(self.h['ideal_action'](m.PLAN['cases'][3]),'KEEP')
        self.assertEqual(self.h['ideal_action'](m.PLAN['cases'][4]),'KEEP')
        self.assertEqual(self.h['ideal_action'](m.PLAN['cases'][0]),'RETRACT')
    def test_grounded_loop_note_is_read_back_and_reused(self):
        with patch.object(m,'request',self.response),contextlib.redirect_stdout(io.StringIO()):
            row=m.episode(self.api,m.PLAN['cases'][0],self.h)
        self.assertTrue(row['candidateClosedLoop'])
        self.assertEqual(row['newNoteCorrectAnswers'],2)
        saved=self.h['read'](self.api.out/'episodes'/m.PLAN['cases'][0]['id']/'03-new-note.json')
        self.assertEqual(saved['replacement']['right'],'435 * v**2')
        self.assertFalse(row['apiAuthoredOriginal'])
    def test_committed_response_reused_without_api(self):
        c=m.PLAN['cases'][0];p=self.h['property_prompt'](c,'left_sign')
        with patch.object(m,'request',self.response),contextlib.redirect_stdout(io.StringIO()):r=self.api.ask('left_sign',c,p)
        with patch.object(m,'request',side_effect=AssertionError('must not request')):replay=self.api.ask('left_sign',c,p)
        self.assertEqual(r,replay)
    def test_tampered_raw_record_rejected_before_reuse(self):
        c=m.PLAN['cases'][0];p=self.h['property_prompt'](c,'left_sign')
        with patch.object(m,'request',self.response),contextlib.redirect_stdout(io.StringIO()):self.api.ask('left_sign',c,p)
        path=next((self.api.out/'raw').glob('*.json'));r=json.loads(path.read_text());r['studentOutput']['raw']='POSITIVE';path.write_text(json.dumps(r))
        with self.assertRaises(ValueError):self.api.ask('left_sign',c,p)
    def test_secret_never_written_in_evidence_or_zip(self):
        c=m.PLAN['cases'][0]
        with patch.object(m,'request',self.response),contextlib.redirect_stdout(io.StringIO()):self.api.ask('left_sign',c,self.h['property_prompt'](c,'left_sign'))
        for p in self.api.out.rglob('*.json'):self.assertNotIn('NOT-A-REAL-KEY',p.read_text())
        z=m.package(self.api.out)
        with m.zipfile.ZipFile(z) as f:
            self.assertIsNone(f.testzip())
            for n in f.namelist():self.assertNotIn(b'NOT-A-REAL-KEY',f.read(n))
    def test_copy_and_wrong_formula_never_admitted(self):
        c=m.PLAN['cases'][0]
        def rec(text):return self.h['sealed']({'recordId':'fixture','caseCardId':c['card']['id'],'studentOutput':{'raw':text,'tokenCapReached':False}})
        self.assertFalse(self.h['proposal_audit'](c,rec('435 * v * v'))['accepted'])
        self.assertFalse(self.h['proposal_audit'](c,rec('435**2'))['accepted'])
        self.assertTrue(self.h['proposal_audit'](c,rec('435 * v**2'))['accepted'])
    def test_invalid_action_is_not_promoted_to_keep(self):
        original=self.response
        def response(cfg,path,body=None):
            r=original(cfg,path,body)
            if 'evidence-commit' in body['messages'][0]['content']:r['choices'][0]['message']['content']='I might KEEP or RETRACT.'
            return r
        with patch.object(m,'request',response),contextlib.redirect_stdout(io.StringIO()):row=m.episode(self.api,m.PLAN['cases'][0],self.h)
        self.assertIsNone(row['afterAction']);self.assertFalse(row['replacementAccepted']);self.assertFalse(row['candidateClosedLoop'])
    def test_full_mock_pipeline_is_labeled_zero_training(self):
        ns={'ZIP_API_WORK':str(self.work),'ZIP_API_CONFIG':{'api_key':'NOT-A-REAL-KEY','base_url':self.cfg['url'],'model':self.cfg['model']}}
        with patch.object(m,'request',self.response),contextlib.redirect_stdout(io.StringIO()):result=m.run(ns)
        self.assertTrue(result['complete']);self.assertEqual(result['trainingUpdates'],0)
        self.assertFalse(result['ownUnnoticedErrorRepairProven'])
        self.assertEqual(result['correctEvidenceControls'],3)
        self.assertLessEqual(result['attemptedPOSTs'],72)

if __name__=='__main__':unittest.main(verbosity=2)
