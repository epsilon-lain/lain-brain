"""Offline regression checks only; no synthetic run is reported as a student experiment."""
import copy
import io
import json
from contextlib import redirect_stdout
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

from test_zip_self_question_memory import evidence_fixture
from test_zip_self_question_tools import output,CounterTokenizer,generated_checked_fixture
from zip_content_core import digest
import zip_experience_binding_core as core
import zip_experience_binding_run as runtime
from zip_self_question_memory_core import outcome_audit
import zip_self_question_tools_policy as sampler

ACTUAL_C1648_GREEDY='The current attempt is T2 goal: "Rewrite 3 * (5 * v + 20)."'
ACTUAL_C1648_CAPPED='T2 goal: "Rewrite 3 * (5 * v + 20)."\n\nMy original rewrite: "3 * (5 * v + 20) = 15 * (5v + 20)"; verifier result: PASS\n\nA1 my original rewrite: "149 * v"; verifier result: FAIL\n\nA3 my original rewrite: "133 * v"; verifier result: FAIL\n\n'


class Harness:
    def __init__(self,folder,values=None,number=1):
        self.evidence,self.bank=evidence_fixture();self.folder=Path(folder)
        self.source_folder=self.folder/'source';self.source_snapshot=runtime.write_source_zips(self.source_folder,self.evidence)
        self.note_folder=self.folder/'notes';self.note_folder.mkdir();self.hashes={}
        self.values=list(values if values is not None else ['T2','I notice that my attempts have different recorded outcomes.',
            'T1','I want to examine why my attempts had different results.','CALL Z1','CALL Z6'])
        self.number=number;self.generated=[];self.saved=[];self.source_reads=0;self.note_reads=0;self.measures=0
        self.frozen_callback=lambda:None;self.remaining_callback=lambda:1
    def generate(self,messages,phase,seed,sampled):
        self.generated.append(dict(messages=copy.deepcopy(messages),phase=phase,seed=seed,sampled=sampled))
        v=self.values.pop(0)
        if isinstance(v,Exception):raise v
        return copy.deepcopy(v) if isinstance(v,dict) else output(v,sampled)
    def save(self,kind,row):self.saved.append((kind,copy.deepcopy(row)))
    def read_source(self,identifier):
        self.source_reads+=1
        return runtime.read_source_zip(self.source_folder,self.evidence,identifier,self.source_snapshot)
    def install(self,note):self.hashes[note['id']+'.zip']=runtime.write_note_zip(self.note_folder,note,self.evidence)
    def read_notes(self):
        self.note_reads+=1
        return runtime.read_note_zips(self.note_folder,self.hashes,self.evidence)
    def measure(self,*args):self.measures+=1;return core.execute_measurement(*args)
    def run(self):return core.run_experiment(self.evidence,self.bank,self.number,self.generate,self.save,self.frozen_callback,
        self.remaining_callback,self.read_source,self.install,self.read_notes,self.measure)
    def rows(self,kind):return [r for k,r in self.saved if k==kind]
    def summary(self,stop='completed'):return core.summarize(self.rows('raw'),self.rows('scored'),self.rows('note-candidate'),
        self.rows('attempt'),self.rows('arm'),self.rows('tool-executed'),self.rows('source-read'),stop)


def choice_row(evidence,raw='T2',attempt=1):
    return dict(recordId='explicit-offline-choice',phase='experience_choice',attemptNumber=attempt,sampled=attempt==2,
        studentPrompt=core.choice_messages(evidence),studentOutput=output(raw,attempt==2),evidenceHash=evidence['evidenceHash'],fixtureOnly=False)


class BindingChecks(unittest.TestCase):
    def setUp(self):self.evidence,self.bank=evidence_fixture();self.root=core.source_root(self.evidence['training'][1],self.evidence)
    def test_choice_requests_only_student_history_id_not_a_target_outcome_or_metric(self):
        text=core.choice_messages(self.evidence)[-1]['content'];request=text[text.index('Current request:'):]
        self.assertNotIn('PASS',request);self.assertNotIn('A1',request)
        for tool in self.bank['tools']:self.assertNotIn(tool['operation'],text)
        for h in self.evidence['evaluation']:self.assertNotIn(json.dumps(h['goal']),text)
        self.assertIn('NONE',request)
        for h in self.evidence['training']:
            for r in h['routes']:self.assertIn(json.dumps(r['original']['studentOutput']['raw']),text)
    def test_literal_choices_preserve_original_and_copying_actual_goal_is_not_selection(self):
        for raw in ('T2',' choose T2. ','I select T2','Selected history: T2'):
            check=core.choice_audit(output(raw),self.evidence)
            self.assertTrue(check['selectionVerified']);self.assertEqual(check['historyId'],'T2')
            self.assertEqual(check['studentRawHash'],digest(raw));self.assertFalse(check['hostSelectedHistory'])
        for raw in (ACTUAL_C1648_GREEDY,'T2 goal: text','T1 T2','T7','CHOOSE','I might select T2','{"history":"T2"}'):
            with self.subTest(raw=raw):self.assertFalse(core.choice_audit(output(raw),self.evidence)['selectionVerified'])
        self.assertTrue(core.choice_audit(output('NONE'),self.evidence)['declined'])
        self.assertFalse(core.choice_audit(output('T2',capped=True),self.evidence)['selectionVerified'])
        self.assertFalse(core.choice_audit(dict(output('T2'),stopReason='unknown'),self.evidence)['selectionVerified'])
    def test_observation_uses_only_actually_selected_original_not_a_host_default(self):
        choice=choice_row(self.evidence);text=core.observation_messages(choice,self.evidence,self.root)[-1]['content']
        self.assertIn(json.dumps(self.root['originalHistory']['goal']),text)
        self.assertNotIn(json.dumps(self.evidence['training'][0]['goal']),text)
        request=text[text.index('Current request:'):]
        self.assertIn('one short sentence',request);self.assertIn('do not need to repeat',request)
        for tool in self.bank['tools']:self.assertNotIn(tool['operation'],text)
        wrong=core.source_root(self.evidence['training'][0],self.evidence)
        with self.assertRaises(ValueError):core.observation_messages(choice,self.evidence,wrong)
        with self.assertRaises(ValueError):core.observation_messages(choice_row(self.evidence,'NONE'),self.evidence,self.root)
    def test_note_needs_no_id_number_or_outcome_copy_and_meaning_stays_uncertified(self):
        raw='I notice that my attempts have different recorded outcomes.'
        check=core.observation_audit(output(raw),self.evidence,self.root)
        self.assertTrue(check['experimentalContextEligible']);self.assertTrue(check['sourceBindingVerified'])
        self.assertFalse(check['wholeNoteTruthVerified']);self.assertFalse(check['diagnosisRelevanceVerified'])
        self.assertFalse(check['strictV1SelectedOutcomeVerified']);self.assertTrue(check['hypothesisOnly'])
        self.assertEqual(check['trainingCredit'],0);self.assertFalse(check['activatedInProduction'])
        self.assertFalse(outcome_audit(output(raw),self.evidence,'training')['reusableInFrozenExperiment'])
        self.assertTrue(core.observation_audit(output(raw+'\n\n'),self.evidence,self.root)['experimentalContextEligible'])
        quoted='Observation: "'+raw+'"'
        check=core.observation_audit(output(quoted),self.evidence,self.root)
        self.assertTrue(check['experimentalContextEligible']);self.assertEqual(check['studentRawHash'],digest(quoted))
        self.assertFalse(core.observation_audit(output('Observation: "'+raw),self.evidence,self.root)['experimentalContextEligible'])
    def test_cap_copied_goal_false_math_wrong_outcome_wrong_reference_and_unfinished_text_excluded(self):
        cases=[(ACTUAL_C1648_GREEDY,False),(ACTUAL_C1648_CAPPED,True),
            ('I notice that v=2*v.',False),('A1 failed.',False),('T3 had a different outcome.',False),
            ('I notice that',False),('I observe something. I observe another thing.',False),
            (self.root['originalHistory']['goal'],False)]
        for raw,capped in cases:
            with self.subTest(raw=raw):self.assertFalse(core.observation_audit(output(raw,capped=capped),self.evidence,self.root)['experimentalContextEligible'])
        check=core.observation_audit(output(ACTUAL_C1648_CAPPED,capped=True),self.evidence,self.root)
        self.assertEqual(check['reason'],'capped_original');self.assertTrue(check['literalFalseEqualityPresent'])
        self.assertFalse(check['readableOriginal']);self.assertFalse(check['originalTextRepaired'])
    def test_uncertified_prose_may_be_irrelevant_and_is_never_reported_as_understanding(self):
        check=core.observation_audit(output('I enjoy blue flowers.'),self.evidence,self.root)
        self.assertTrue(check['experimentalContextEligible'])
        self.assertFalse(check['diagnosisRelevanceVerified']);self.assertFalse(check['wholeNoteTruthVerified'])
    def test_source_root_cannot_be_heldout_and_tampered_selection_cannot_rebind(self):
        with self.assertRaises(ValueError):core.source_root(self.evidence['evaluation'][0],self.evidence)
        broken=copy.deepcopy(self.root);broken['originalHistory']['goal']='changed goal'
        broken=core.seal({k:v for k,v in broken.items() if k!='version'},'version')
        with self.assertRaises(ValueError):core.observation_audit(output('Own observation.'),self.evidence,broken)
    def test_actual_source_native_zips_preserve_whole_originals_and_detect_changed_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp)/'source';hashes=runtime.write_source_zips(folder,self.evidence)
            self.assertEqual(set(hashes),{'T1.zip','T2.zip','T3.zip','T4.zip'})
            selected=runtime.read_source_zip(folder,self.evidence,'T2',hashes);self.assertEqual(selected,self.root)
            p=folder/'T2.zip';p.write_bytes(b'changed source ZIP')
            with self.assertRaises(ValueError):runtime.read_source_zip(folder,self.evidence,'T2',hashes)
            with self.assertRaises(ValueError):runtime.read_source_zip(folder,self.evidence,'E1',hashes)
    def test_native_note_replay_keeps_complete_choice_and_observation_tokens_without_host_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);h.run();notes=h.read_notes();self.assertEqual(len(notes),2)
            n=notes[0];self.assertEqual(n['certifiedPart'],'actual_student_selection_and_original_source_binding_only')
            self.assertEqual(n['studentObservation']['studentOutput']['generatedIds'],[101,102,103])
            with zipfile.ZipFile(h.note_folder/'N1.zip') as z:
                self.assertEqual(json.loads(z.read('student-observation.json')),n['studentObservation'])
                self.assertEqual(json.loads(z.read('source-experience.json')),n['sourceZip'])
            broken=copy.deepcopy(n);broken['studentObservation']['studentOutput']['raw']='Host replacement.'
            broken=core.seal({k:v for k,v in broken.items() if k!='noteHash'},'noteHash')
            with self.assertRaises(ValueError):core.validate_note(broken,h.evidence)
            (h.note_folder/'N1.zip').write_bytes(b'changed ZIP')
            with self.assertRaises(ValueError):h.read_notes()


class LoopChecks(unittest.TestCase):
    def test_six_calls_two_real_source_reads_two_hypothesis_zips_and_paired_metric_execution(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);before=copy.deepcopy(h.evidence);arms=h.run();report=h.summary()
            self.assertEqual([r['phase'] for r in h.generated],['experience_choice','experience_observation',
                'experience_choice','experience_observation','metric_zip_call','metric_zip_call'])
            self.assertEqual([r['sampled'] for r in h.generated],[False,False,True,True,False,False])
            self.assertEqual(h.source_reads,2);self.assertEqual(h.measures,2);self.assertEqual(len(h.hashes),2)
            self.assertEqual(h.generated[4]['seed'],h.generated[5]['seed']);self.assertEqual(h.evidence,before)
            self.assertEqual(len(arms),2);self.assertTrue(report['completePairedCallComparison'])
            self.assertEqual(report['truthCertifiedStudentNotes'],0);self.assertEqual(report['sourceBoundStudentHypothesisZips'],2)
            self.assertFalse(report['semanticSelfAnalysisProved']);self.assertEqual(report['trainingUpdates'],0)
            self.assertTrue(report['callProtocolSuccessDoesNotProveMetacognition'])
            for i,(kind,row) in enumerate(h.saved):
                if kind=='scored':self.assertEqual(h.saved[i-1],('raw',{k:v for k,v in row.items() if k!='check'}))
    def test_comparison_shares_originals_catalogue_and_only_adds_actual_notes(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);h.run();a,b=[g['messages'] for g in h.generated[-2:]]
            self.assertEqual(a[0],b[0]);at=a[-1]['content'];bt=b[-1]['content'];marker='\n\nYour saved observation ZIP notes.'
            self.assertEqual(at[:at.index('\n\nAvailable measurement ZIPs')],bt[:bt.index(marker)])
            self.assertEqual(at[at.index('\n\nAvailable measurement ZIPs'):],bt[bt.index('\n\nAvailable measurement ZIPs'):])
            self.assertGreater(bt.index('Current request:'),bt.index('Available measurement ZIPs'))
            self.assertIn(h.rows('note-candidate')[0]['studentObservation']['studentOutput']['raw'],bt)
    def test_actual_old_goal_copy_and_none_skip_only_dependencies_without_host_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp,[ACTUAL_C1648_GREEDY,'NONE']);self.assertEqual(h.run(),[])
            self.assertEqual(len(h.generated),2);self.assertEqual(h.source_reads,0);self.assertEqual(h.hashes,{})
            report=h.summary();self.assertEqual(report['processedWritingAttempts'],2)
            self.assertIsNone(report['validCallDifferenceWithMinusWithout']);self.assertFalse(report['completePairedCallComparison'])
    def test_selected_but_capped_or_copy_observations_do_not_install_or_continue_pair(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp,['T2',output(ACTUAL_C1648_CAPPED,capped=True),'T1',ACTUAL_C1648_GREEDY])
            self.assertEqual(h.run(),[]);self.assertEqual(len(h.generated),4);self.assertEqual(h.source_reads,2)
            self.assertEqual(h.hashes,{});self.assertEqual(h.measures,0)
            self.assertEqual(h.summary()['cappedResponses'],1)
    def test_one_valid_note_is_replayed_alone_and_later_attempt_number_is_not_reused(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp,['NONE','T1','I want to examine my recorded attempts.','CALL Z1','CALL Z6']);h.run()
            self.assertEqual(set(h.hashes),{'N2.zip'});self.assertEqual(len(h.generated),5)
            self.assertEqual(h.summary()['verifiedStudentSourceSelections'],1)
    def test_invalid_or_declined_metric_call_never_executes_default_measurement(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);h.values[-2:]=['Z7: 0.5','NONE'];h.run()
            self.assertEqual(h.measures,0);self.assertTrue(h.summary()['completePairedCallComparison'])
    def test_signed_call_difference_does_not_certify_diagnosis_or_math(self):
        for baseline,with_notes,expected in (('Z7: 0.5','CALL Z1',1),('CALL Z1','Z7: 0.5',-1)):
            with tempfile.TemporaryDirectory() as tmp:
                h=Harness(tmp);h.values[-2:]=[baseline,with_notes];h.run();r=h.summary()
                self.assertEqual(r['validCallDifferenceWithMinusWithout'],expected)
                self.assertFalse(r['mathematicalBenefitTested']);self.assertFalse(r['diagnosisUsefulnessVerified'])
    def test_counterbalanced_order_paired_seed_and_partial_run_reservation(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp,number=2);arms=h.run();self.assertEqual([a['arm'] for a in arms],list(reversed(core.ARMS)))
            self.assertEqual(h.generated[-2]['seed'],h.generated[-1]['seed'])
            self.assertGreater(h.generated[0]['seed'],4_600_000_000)
            folder=Path(tmp)/'zip-experience-binding-partial';folder.mkdir()
            (folder/'protocol.json').write_text(json.dumps(dict(protocol=core.PROTOCOL,experimentNumber=2)))
            self.assertEqual(runtime.next_number(tmp),3)
    def test_raw_saved_before_bad_provenance_log_sum_or_frozen_mutation_is_rejected(self):
        for change in ({'testDouble':True},{'fixtureOnly':True},{'semanticAdapterEnabledDuringGeneration':False},
                       {'samplingLogProbability':-.1}):
            with tempfile.TemporaryDirectory() as tmp:
                h=Harness(tmp);h.values[0]=dict(output('T2'),**change)
                with self.assertRaises(ValueError):h.run()
                self.assertEqual([k for k,r in h.saved],['raw']);self.assertEqual(h.source_reads,0)
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp)
            def frozen():
                if h.generated:raise ValueError('explicit offline frozen mutation')
            h.frozen_callback=frozen
            with self.assertRaises(ValueError):h.run()
            self.assertEqual([k for k,r in h.saved],['raw'])
    def test_generation_failure_and_bad_tool_return_keep_originals_without_false_pair(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);h.values[-1]=RuntimeError('explicit offline generation failure')
            with self.assertRaises(RuntimeError):h.run()
            self.assertEqual(h.summary('error')['actualStudentGenerations'],5)
            self.assertFalse(h.summary('error')['completePairedCallComparison'])
            self.assertIsNone(h.summary('error')['validCallDifferenceWithMinusWithout'])
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);h.measure=lambda *a:dict(core.execute_measurement(*a),value=.123)
            with self.assertRaises(ValueError):h.run()
            self.assertEqual(len(h.rows('tool-returned')),1);self.assertEqual(h.rows('tool-executed'),[])
    def test_deadline_before_call_source_read_note_install_and_measure_stops_dependents(self):
        for threshold,expected_reads in ((0,0),(1,0),(2,1),(5,2)):
            with tempfile.TemporaryDirectory() as tmp:
                h=Harness(tmp);h.remaining_callback=lambda:0 if len(h.generated)>=threshold else 1
                with self.subTest(threshold=threshold),self.assertRaises(TimeoutError):h.run()
                self.assertEqual(len(h.generated),threshold);self.assertEqual(h.source_reads,expected_reads)
                self.assertEqual(h.measures,0)
    def test_wrong_source_root_after_valid_choice_does_not_unlock_observation(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);h.read_source=lambda identifier:core.source_root(h.evidence['training'][0],h.evidence)
            with self.assertRaises(ValueError):h.run()
            self.assertEqual(len(h.generated),1);self.assertEqual(h.rows('source-read'),[])
    def test_memory_byte_changes_and_unaudited_raw_never_create_valid_gain(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);h.run()
            self.assertIsNone(h.summary('error')['validCallDifferenceWithMinusWithout'])
            h.rows('raw')[-1]['studentOutput']['raw']='changed'
            self.assertFalse(h.summary()['completePairedCallComparison'])
            self.assertIsNone(h.summary()['validCallDifferenceWithMinusWithout'])


class RuntimeChecks(unittest.TestCase):
    def test_source_fixture_rejected_before_weight_import_and_output_creation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);parent=root/'source';parent.mkdir();(parent/'result.json').write_text('{"fixtureOnly": true}')
            args=SimpleNamespace(source=parent,out=root/'out',work=root,student=root/'student',old_tools=root/'tools');before=set(sys.modules)
            with self.assertRaises((ValueError,KeyError,FileNotFoundError)):runtime.run(args)
            self.assertFalse(args.out.exists());self.assertNotIn('torch',set(sys.modules)-before)
    def test_preflight_checks_all_four_possible_selected_sources_without_fake_student_choices(self):
        evidence,bank=evidence_fixture();fake=ModuleType('transformers');tok=CounterTokenizer(100)
        fake.AutoTokenizer=SimpleNamespace(from_pretrained=lambda *a,**kw:tok)
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);(p/'config.json').write_text('{"max_position_embeddings":4096}')
            with patch.dict(sys.modules,{'transformers':fake}):limits,report=runtime.prepare_inputs(p,evidence,bank,1)
            self.assertEqual(len(report['rows']),6);self.assertTrue(report['allPlannedPromptsFit'])
            self.assertFalse(report['placeholderStudentChoiceCreated']);self.assertEqual(report['actualStudentGenerations'],0)
            self.assertEqual(limits['maxInputTokens'],4000);self.assertTrue(all(c['truncation'] is False for c in tok.calls))
            self.assertEqual(runtime.generate,sampler.generate)
    def test_actual_eos_and_all_sampler_logs_are_preserved_without_forced_marker(self):
        messages=[dict(role='user',content='Explicit offline selected-source sampler case.')]
        result,_,audit=generated_checked_fixture(CounterTokenizer(12),messages,'experience_review','T2')
        self.assertEqual(result['generatedIds'][-1],0);self.assertEqual(result['stopReason'],'eos')
        self.assertEqual(len(result['generatedIds']),len(result['samplingTokenLogProbabilities']))
        self.assertFalse(result['studentEndMarkerReached']);self.assertTrue(audit['noSilentTruncation'])
    def test_runtime_input_failure_archives_zero_generations_before_weights_load(self):
        evidence,bank=evidence_fixture()
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);parent=root/'source';student=root/'student';old_tools=root/'old-tools'
            for p in (parent/'checkpoints',student,old_tools):p.mkdir(parents=True)
            (parent/'result.json').write_text('{}');(parent/'source-checkpoint.json').write_text(json.dumps(dict(baseChoiceSource=str(parent))))
            (parent/'checkpoints'/'semantic.safetensors').write_bytes(b'explicit offline stub, not weights')
            (student/'config.json').write_text('{"max_position_embeddings":4096}')
            hashes=runtime.snapshot(parent);resume=dict(folder=str(parent),sourceHashes=hashes,initialMeta={},
                result=dict(mathematicalWriterStateHash='offline-math',baseStateBefore='offline-base'),
                final=dict(semanticFile='semantic.safetensors',semanticStateHash='offline-semantic',head=evidence['head'],labels=[]))
            checked=dict(checkpoint=dict(writerStateHash='offline-math'),identity=dict(snapshotSha256={}),protected={},toolFiles={})
            fake=ModuleType('transformers');fake.AutoTokenizer=SimpleNamespace(from_pretrained=lambda *a,**kw:CounterTokenizer(4001))
            args=SimpleNamespace(source=parent,student=student,old_tools=old_tools,out=root/'zip-experience-binding-test',work=root);before=set(sys.modules)
            with patch.object(runtime,'inspect_source',return_value=resume),patch.object(runtime,'load_evidence',return_value=(evidence,{})),\
                 patch.object(runtime,'preflight',return_value=checked),patch.dict(sys.modules,{'transformers':fake}),redirect_stdout(io.StringIO()):
                self.assertEqual(runtime.run(args),1)
            result=json.loads((args.out/'result.json').read_text())
            self.assertEqual(result['actualStudentGenerations'],0);self.assertFalse(result['modelWeightsLoaded'])
            self.assertEqual(result['actualSelectedSourceZipReads'],0);self.assertEqual(result['sourceBoundStudentHypothesisZips'],0)
            self.assertTrue((args.out/'Lain-Zip-Experience-Binding-Results.zip').is_file())
            self.assertNotIn('Final check:',result['error']);self.assertNotIn('torch',set(sys.modules)-before)
            self.assertEqual(runtime.snapshot(parent),hashes)


if __name__=='__main__':unittest.main()
