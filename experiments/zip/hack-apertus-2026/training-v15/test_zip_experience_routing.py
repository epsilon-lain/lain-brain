"""Offline checks; no mock generation is a real student experiment."""
import copy
import io
import json
from contextlib import redirect_stdout,contextmanager
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

from test_zip_self_question_memory import evidence_fixture
from test_zip_self_question_tools import output,CounterTokenizer
from zip_content_core import digest
from zip_self_question_memory_core import seal
from zip_self_question_tools_core import validate_generation as unchanged_semantic_validator
from zip_experience_binding_core import choice_audit,observation_audit,source_root
from zip_experience_binding_run import write_source_zips,read_source_zip
import zip_experience_routing_core as core
import zip_experience_routing_run as runtime

ACTUAL_356_GREEDY='T1 goal: Rewrite 1 * (149 * v) + 2 * (149 * v) = 1 * (1985 * v) + 2 * (149 * v) = 3 * (1985 * v) = 3 * (6 * v + 17)'
ACTUAL_356_SAMPLED='T1 goal: "Rewrite 1 * (149 * v) + 2 * (149 * v) = 1 * (1985 * v) + 2 * ( occupational goal: T1 goal reason: The goal was STATEMENT, not SHAPE."\n\nЯ не могу помочь с T1-задачей из-за неправильного пропуска.'


def value(raw,enabled=True,capped=False):
    v=output(raw,False,capped);v['temperature']=1.;v['semanticAdapterEnabledDuringGeneration']=enabled
    if capped:
        v['generatedIds']=[101]*96;v['samplingTokenLogProbabilities']=[-.25]*96
        v['generatedTokens']=96;v['samplingLogProbability']=-24.
    return v


class Harness:
    def __init__(self,folder,number=1,values=None):
        self.evidence,_=evidence_fixture();self.folder=Path(folder);self.number=number
        self.source=self.folder/'source';self.source_hashes=write_source_zips(self.source,self.evidence)
        self.notes=self.folder/'notes';self.notes.mkdir();self.hashes={};self.saved=[];self.calls=[]
        self.values=dict(combined_semantic=ACTUAL_356_GREEDY,separate_semantic='T2',
            combined_native='NONE',separate_native='T3',
            separate_semantic_observation='I notice that my attempts have different outcomes.',
            separate_native_observation='I want to examine how the outcomes differ.')
        if values is not None:self.values.update(values)
        self.frozen=lambda:None;self.remaining=lambda:1.;self.reads=0
    def generate(self,messages,phase,seed,sampled,enabled):
        name=next(c[0] for c in core.CONDITIONS if c[2]==enabled and phase=='experience_choice' and
            core.routing_messages(self.evidence,c[0])==messages) if phase=='experience_choice' else ('separate_semantic' if enabled else 'separate_native')
        self.calls.append(dict(name=name,phase=phase,seed=seed,sampled=sampled,enabled=enabled,messages=copy.deepcopy(messages)))
        key=name if phase=='experience_choice' else name+'_observation';v=self.values[key]
        if isinstance(v,Exception):raise v
        return copy.deepcopy(v) if isinstance(v,dict) else value(v,enabled)
    def save(self,kind,row):self.saved.append((kind,copy.deepcopy(row)))
    def read(self,identifier):
        self.reads+=1;return read_source_zip(self.source,self.evidence,identifier,self.source_hashes)
    def install(self,note):self.hashes[note['id']+'.zip']=runtime.write_note_zip(self.notes,note,self.evidence)
    def replay(self):return runtime.read_note_zips(self.notes,self.hashes,self.evidence)
    def run(self):return core.run_experiment(self.evidence,self.number,self.generate,self.save,self.frozen,self.remaining,self.read,self.install,self.replay)
    def rows(self,kind):return [r for k,r in self.saved if k==kind]
    def summary(self,stop='completed'):return core.summarize(self.rows('raw'),self.rows('scored'),self.rows('note-candidate'),
        self.rows('observation-stage'),self.rows('source-read'),stop,self.number)


class RoutingChecks(unittest.TestCase):
    def setUp(self):self.evidence,_=evidence_fixture()
    def test_current_instruction_has_own_user_turn_all_old_words_and_original_records_preserved(self):
        a=core.routing_messages(self.evidence,'combined_semantic');b=core.routing_messages(self.evidence,'separate_semantic')
        self.assertEqual(a[0],b[0]);self.assertEqual(a[1]['content'],b[1]['content']+b[2]['content'])
        self.assertEqual([r['role'] for r in b],['system','user','user'])
        self.assertTrue(b[-1]['content'].startswith('Current request:'));self.assertNotIn('PASS',b[-1]['content'])
        self.assertNotIn('Z1',str(b));self.assertNotIn('E1 goal:',str(b))
        for h in self.evidence['training']:
            for r in h['routes']:self.assertIn(json.dumps(r['original']['studentOutput']['raw']),b[1]['content'])
    def test_adapter_pairs_identical_prompts_no_target_history_or_host_observation(self):
        for form in ('combined','separate'):
            self.assertEqual(core.routing_messages(self.evidence,form+'_semantic'),core.routing_messages(self.evidence,form+'_native'))
        request=core.routing_messages(self.evidence,'separate_native')[-1]['content']
        self.assertIn('T1, T2, T3, or T4',request);self.assertIn('NONE',request);self.assertNotIn('failure',request)
    def test_actual_goal_continuations_remain_failed_under_unchanged_literal_audit(self):
        for raw in (ACTUAL_356_GREEDY,ACTUAL_356_SAMPLED):
            before=value(raw);self.assertFalse(choice_audit(before,self.evidence)['selectionVerified']);self.assertEqual(before['raw'],raw)
        self.assertFalse(choice_audit(value('T1\nexplanation'),self.evidence)['selectionVerified'])
    def test_native_outputs_keep_actual_flag_old_semantic_only_validator_stays_strict(self):
        native=value('T1',False);before=copy.deepcopy(native);core.validate_generation(native,False);self.assertEqual(native,before)
        with self.assertRaises(ValueError):unchanged_semantic_validator(native,False)
        with self.assertRaises(ValueError):core.validate_generation(native,True)
        with self.assertRaises(ValueError):core.validate_generation(value('T1',True),False)
    def test_fixture_changed_log_sum_sampler_and_math_flags_rejected_without_text_repair(self):
        for update in ({'fixtureOnly':True},{'testDouble':True},{'samplingLogProbability':2.},
            {'sampled':True},{'temperature':.8},{'temperature':True},{'mathAdapterEnabledDuringGeneration':True},
            {'stopReason':'unknown'},{'generatedIds':[1]},{'samplingTokenLogProbabilities':[float('nan')]*3}):
            with self.subTest(update=update),self.assertRaises(ValueError):core.validate_generation(dict(value('T1'),**update),True)
    def test_cap_and_missing_eos_never_unlock_choice_even_with_a_known_id(self):
        capped=value('T2',True,True);core.validate_generation(capped,True)
        self.assertFalse(choice_audit(capped,self.evidence)['selectionVerified'])
        self.assertFalse(choice_audit(dict(value('T2'),stopReason='unknown'),self.evidence)['selectionVerified'])
    def test_four_fresh_selection_conditions_counterbalanced_without_outcome_adaptation(self):
        for n in range(1,5):
            self.assertEqual({c[0] for c in core.scheduled_conditions(n)},{c[0] for c in core.CONDITIONS})
        self.assertEqual(len({core.scheduled_conditions(n)[0][0] for n in range(1,5)}),4)
        self.assertNotEqual(core.seed_for(1,'experience_choice'),core.seed_for(2,'experience_choice'))
        self.assertNotEqual(core.seed_for(1,'experience_choice'),4_600_001_011)
    def test_changed_history_or_choice_cannot_rebind_source_even_with_recomputed_hashes(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);h.run();choice=next(r for r in h.rows('scored') if r['condition']=='separate_semantic' and r['phase']=='experience_choice')
            root=source_root(h.evidence['training'][1],h.evidence);core.validate_choice(choice,h.evidence,root)
            with self.assertRaises(ValueError):core.validate_choice(choice,h.evidence,source_root(h.evidence['training'][0],h.evidence))
            wrong=copy.deepcopy(choice);wrong['check']['historyId']='T1'
            with self.assertRaises(ValueError):core.validate_choice(wrong,h.evidence,root)
            wrong=copy.deepcopy(choice);wrong['studentPrompt'][-1]['content']='host target T1'
            with self.assertRaises(ValueError):core.validate_choice(wrong,h.evidence,root)


class RoutingLoopChecks(unittest.TestCase):
    def test_all_four_selections_precede_two_observations_exact_six_call_budget(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);before=copy.deepcopy(h.evidence);h.run();report=h.summary()
            self.assertEqual([c['phase'] for c in h.calls],['experience_choice']*4+['experience_observation']*2)
            self.assertEqual([c['name'] for c in h.calls[:4]],[c[0] for c in core.CONDITIONS]);self.assertTrue(all(c['sampled'] is False for c in h.calls))
            self.assertEqual(len({c['seed'] for c in h.calls[:4]}),1);self.assertEqual(h.reads,2)
            self.assertTrue(report['completeFixedInterfaceComparison']);self.assertEqual(report['sourceBoundStudentHypothesisZips'],2)
            self.assertEqual(report['independentHistoryContexts'],1);self.assertEqual(h.evidence,before)
            self.assertFalse(report['memoryReuseEffectTested']);self.assertFalse(report['semanticSelfAnalysisProved']);self.assertEqual(report['trainingUpdates'],0)
    def test_four_failed_choices_still_run_four_calls_no_source_read_and_no_effect_claim(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp,values={c[0]:ACTUAL_356_GREEDY for c in core.CONDITIONS});h.run();r=h.summary()
            self.assertEqual(len(h.calls),4);self.assertEqual(h.reads,0);self.assertEqual(len(h.replay()),0)
            self.assertTrue(r['completeFixedInterfaceComparison']);self.assertEqual(r['decision'],'no_valid_selection_in_four_fixed_conditions_stop_downstream_effect_claims')
            self.assertEqual(r['observationResponses'],0);self.assertEqual(r['auditedSelectionResponses'],4)
    def test_valid_none_is_interface_decline_never_counted_as_failure_of_understanding(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp,values={c[0]:'NONE' for c in core.CONDITIONS});h.run();r=h.summary()
            self.assertEqual(r['decision'],'literal_interface_worked_but_no_history_selected');self.assertEqual(h.reads,0)
            self.assertTrue(all(c['literalInterfaceValid'] and not c['selectionVerified'] for c in r['byCondition'].values()))
    def test_successful_control_never_fills_failed_corrected_selection(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp,values=dict(combined_semantic='T4',separate_semantic='not selected',combined_native='T2',separate_native='NONE'))
            h.run();r=h.summary();self.assertEqual(h.reads,0);self.assertEqual(len(h.calls),4)
            self.assertEqual(r['decision'],'only_combined_control_selected_no_host_fallback')
    def test_native_success_has_own_original_source_and_never_changes_production_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp,values=dict(separate_semantic='not selected'));h.run();r=h.summary()
            self.assertEqual(len(h.calls),5);self.assertEqual(r['decision'],'corrected_native_selected_history_learned_interface_not_selected_no_production_switch')
            note=h.replay()[0];self.assertEqual(note['id'],'R2');self.assertFalse(note['studentObservation']['studentOutput']['semanticAdapterEnabledDuringGeneration'])
            self.assertFalse(note['productionActive']);self.assertEqual(note['sourceZip']['id'],'T3')
            text=note['studentObservation']['studentPrompt'][-1]['content'];self.assertIn('one short sentence',text);self.assertNotIn('T2',text)
    def test_false_math_capped_and_pure_copy_observation_remain_unusable_v2_rules(self):
        for raw in ('I notice v=2*v.',ACTUAL_356_GREEDY,value('I notice something.',True,True)):
            with self.subTest(raw=raw),tempfile.TemporaryDirectory() as tmp:
                h=Harness(tmp,values=dict(separate_semantic_observation=raw,separate_native='NONE'));h.run()
                self.assertEqual(h.summary()['sourceBoundStudentHypothesisZips'],0)
    def test_actual_notes_retain_whole_native_choice_output_tokens_and_false_certificates(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);h.run();note=h.replay()[1];self.assertFalse(note['wholeNoteTruthVerified']);self.assertFalse(note['reuseEffectTested'])
            with zipfile.ZipFile(h.notes/'R2.zip') as z:
                self.assertEqual(json.loads(z.read('student-choice.json')),note['studentChoice'])
                self.assertEqual(json.loads(z.read('student-observation.json')),note['studentObservation'])
            changed=copy.deepcopy(note);changed['studentObservation']['studentOutput']['raw']='Host replacement.'
            changed=seal({k:v for k,v in changed.items() if k!='noteHash'},'noteHash')
            with self.assertRaises(ValueError):core.validate_note(changed,h.evidence)
            (h.notes/'R2.zip').write_bytes(b'tampered archive')
            with self.assertRaises(ValueError):h.replay()
    def test_raw_is_saved_before_wrong_actual_adapter_flag_or_log_rejection(self):
        for altered in (dict(value('T2'),semanticAdapterEnabledDuringGeneration=False),dict(value('T2'),samplingLogProbability=8.)):
            with self.subTest(altered=altered),tempfile.TemporaryDirectory() as tmp:
                h=Harness(tmp,values=dict(combined_semantic=altered))
                with self.assertRaises(ValueError):h.run()
                self.assertEqual(len(h.rows('raw')),1);self.assertEqual(h.rows('scored'),[])
                self.assertFalse(h.summary('error')['completeFixedInterfaceComparison']);self.assertIsNone(h.summary('error')['descriptiveSingleContextDifferences'])
    def test_returned_raw_survives_frozen_state_rejection_before_any_audit(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp)
            def frozen():
                if h.rows('raw'):raise ValueError('frozen state changed')
            h.frozen=frozen
            with self.assertRaises(ValueError):h.run()
            self.assertEqual(len(h.rows('raw')),1);self.assertEqual(h.rows('scored'),[])
    def test_failure_and_deadline_never_fabricate_completed_pairs_or_dependent_generations(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp,values=dict(separate_native=RuntimeError('model return failure')))
            with self.assertRaises(RuntimeError):h.run()
            self.assertEqual(len(h.rows('raw')),3);self.assertFalse(h.summary('error')['completeFixedInterfaceComparison']);self.assertEqual(h.reads,0)
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);h.remaining=lambda:0
            with self.assertRaises(TimeoutError):h.run()
            self.assertEqual(h.calls,[])
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);h.remaining=lambda:0 if len(h.rows('scored'))==4 else 1
            with self.assertRaises(TimeoutError):h.run()
            self.assertEqual(len(h.calls),4);self.assertEqual(h.reads,0);self.assertIsNone(h.summary('time_budget')['descriptiveSingleContextDifferences'])
    def test_fixed_paired_differences_are_signed_single_context_not_learning_gain(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);h.run();r=h.summary();d=r['descriptiveSingleContextDifferences']['selectionVerified']
            self.assertEqual(d['separateMinusCombinedByAdapter'],dict(semantic=1,native=1))
            self.assertEqual(d['semanticMinusNativeByForm'],dict(combined=0,separate=0))
            self.assertTrue(r['fourConditionsAreNotIndependentContexts']);self.assertFalse(r['statisticalSignificanceClaimed'])
            self.assertEqual(r['actualMeasurementZipExecutions'],0)
    def test_summary_rejects_changed_pair_prompt_and_does_not_call_unscored_raw_completed(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);h.run();scored=h.rows('scored');raw=h.rows('raw')
            native=next(r for r in scored if r['condition']=='combined_native');native['studentPrompt'][-1]['content']='changed'
            matching=next(r for r in raw if r['recordId']==native['recordId']);matching['studentPrompt']=native['studentPrompt']
            with self.assertRaises(ValueError):core.summarize(raw,scored,h.rows('note-candidate'),h.rows('observation-stage'),h.rows('source-read'),'completed',1)
            r=core.summarize(h.rows('raw'),h.rows('scored')[:-1],[],[],[],'completed',1)
            self.assertFalse(r['completeFixedInterfaceComparison']);self.assertIsNone(r['descriptiveSingleContextDifferences'])


class RuntimeChecks(unittest.TestCase):
    def test_full_runner_dispatches_real_adapter_context_flags_restores_them_and_keeps_source_frozen(self):
        # Every object in this test is an explicitly offline model double.
        # No returned counter from this temporary run is a student result.
        evidence,_=evidence_fixture();adapters=[];observed=[]
        class Base:
            training=False
            def __init__(self):self.p=SimpleNamespace(requires_grad=False,grad=None)
            def parameters(self):return iter([self.p])
            def eval(self):self.training=False;return self
            def requires_grad_(self,v):self.p.requires_grad=v;return self
        class Adapter:
            def __init__(self,*a,**kw):
                self.enabled=True;self.training=False;self.hash='offline-math' if not adapters else 'offline-semantic';adapters.append(self)
            def restore(self,v):pass
            def digest(self):return self.hash
            def eval(self):self.training=False;return self
            def parameters_to_train(self):return []
            def close(self):pass
            @contextmanager
            def active(self,enabled):
                previous=self.enabled;self.enabled=enabled
                try:yield
                finally:self.enabled=previous
        def generate(base,tokenizer,messages,phase,seed,sampled,input_audit):
            observed.append((adapters[0].enabled,adapters[1].enabled))
            self.assertEqual(phase,'experience_review');self.assertFalse(sampled)
            raw='I notice that the recorded outcomes differ.' if messages[-1]['content'].startswith('Current request: In one short sentence') else 'T2'
            return dict(value(raw,adapters[1].enabled),promptIds=input_audit['promptIds'])
        fake_tokenizer=ModuleType('transformers');fake_tokenizer.AutoTokenizer=SimpleNamespace(from_pretrained=lambda *a,**kw:CounterTokenizer(100))
        fake_safe=ModuleType('safetensors');fake_safe_torch=ModuleType('safetensors.torch');fake_safe_torch.load_file=lambda p:{}
        fake_pilot=ModuleType('zip_pilot');fake_pilot.load_student=lambda *a:(Base(),CounterTokenizer(100),dict(snapshotSha256={}))
        fake_model=ModuleType('zip_pilot_model');fake_model.state_digest=lambda model:'offline-base'
        fake_adapter=ModuleType('math_writer_adapter');fake_adapter.MathWriterAdapter=Adapter
        doubles={'transformers':fake_tokenizer,'safetensors':fake_safe,'safetensors.torch':fake_safe_torch,
            'zip_pilot':fake_pilot,'zip_pilot_model':fake_model,'math_writer_adapter':fake_adapter}
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);source=p/'source';student=p/'student';old=p/'old'
            for f in (source/'checkpoints',student,old):f.mkdir(parents=True)
            (source/'result.json').write_text('{}');(source/'source-checkpoint.json').write_text(json.dumps(dict(baseChoiceSource=str(source))))
            (student/'config.json').write_text('{"max_position_embeddings":4096}');hashes=runtime.snapshot(source)
            resume=dict(folder=str(source),sourceHashes=hashes,initialMeta={},result=dict(mathematicalWriterStateHash='offline-math',baseStateBefore='offline-base'),
                final=dict(semanticFile='not-loaded-offline',semanticStateHash='offline-semantic',head=evidence['head'],labels=[]))
            checked=dict(writer='not-loaded-offline',checkpoint=dict(writerStateHash='offline-math'),identity=dict(snapshotSha256={}),protected={},toolFiles={})
            args=SimpleNamespace(source=source,out=p/'zip-experience-routing-test',work=p,student=student,old_tools=old)
            captured=io.StringIO()
            with patch.object(runtime,'inspect_source',return_value=resume),patch.object(runtime,'load_evidence',return_value=(evidence,{})),\
                patch.object(runtime,'preflight',return_value=checked),patch.object(runtime,'generate',side_effect=generate),\
                patch.dict(sys.modules,doubles),redirect_stdout(captured):status=runtime.run(args)
            self.assertEqual(status,0,captured.getvalue())
            r=json.loads((args.out/'result.json').read_text());self.assertEqual(r['actualStudentGenerations'],6)
            self.assertTrue(r['summary']['completeFixedInterfaceComparison']);self.assertEqual(r['sourceBoundStudentHypothesisZips'],2)
            self.assertTrue(r['inMemoryFrozenFlagsChecked']);self.assertTrue(r['semanticWriterUnchanged'])
            self.assertEqual(runtime.snapshot(source),hashes);self.assertTrue(all(a.enabled is True for a in adapters))
            self.assertEqual(observed,[(False,True),(False,True),(False,False),(False,False),(False,True),(False,False)])
            rows=[json.loads(f.read_text()) for f in (args.out/'responses').glob('*-raw.json')]
            self.assertEqual(sum(x['studentOutput']['semanticAdapterEnabledDuringGeneration'] is False for x in rows),3)
    def test_native_and_semantic_prompts_preflight_with_real_turn_roles_before_weights_and_no_placeholder_choice(self):
        e,_=evidence_fixture();fake=ModuleType('transformers');fake.AutoTokenizer=SimpleNamespace(from_pretrained=lambda *a,**kw:CounterTokenizer())
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);(p/'config.json').write_text('{"max_position_embeddings":4096}')
            with patch.dict(sys.modules,{'transformers':fake}):limits,pre=runtime.prepare_inputs(p,e,1)
        self.assertEqual(len(pre['rows']),8);self.assertTrue(pre['allPlannedPromptsFit']);self.assertFalse(pre['modelWeightsLoaded'])
        self.assertFalse(pre['placeholderStudentChoiceCreated']);self.assertEqual(pre['actualStudentGenerations'],0)
        self.assertEqual(pre['rows'][0]['audit']['promptIds'],pre['rows'][2]['audit']['promptIds'])
        self.assertEqual(pre['rows'][1]['audit']['promptIds'],pre['rows'][3]['audit']['promptIds'])
    def test_partial_numbers_reserved_and_seed_namespace_does_not_reuse_previous_probes(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'zip-experience-routing-partial';p.mkdir();(p/'protocol.json').write_text(json.dumps(dict(protocol=core.PROTOCOL,experimentNumber=3)))
            self.assertEqual(runtime.next_number(Path(tmp)),4)
            self.assertGreater(core.seed_for(4,'experience_choice'),4_600_000_000+1000*1000+200)
    def test_unreviewed_fixture_source_rejected_before_model_import_or_output_creation(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);source=p/'source';source.mkdir();(source/'result.json').write_text('{"fixtureOnly":true}')
            args=SimpleNamespace(source=source,out=p/'out',work=p,student=p/'student',old_tools=p/'old')
            before=set(sys.modules)
            with self.assertRaises(ValueError):runtime.run(args)
            self.assertFalse(args.out.exists());self.assertNotIn('torch',set(sys.modules)-before)
    def test_overlong_or_unsupported_template_preflight_archives_error_zero_calls_before_weights(self):
        e,_=evidence_fixture()
        for tokenizer in (CounterTokenizer(4001),None):
            with self.subTest(tokenizer=tokenizer),tempfile.TemporaryDirectory() as tmp:
                p=Path(tmp);source=p/'source';student=p/'student';old=p/'old'
                for f in (source/'checkpoints',student,old):f.mkdir(parents=True)
                (source/'result.json').write_text('{}');(source/'source-checkpoint.json').write_text(json.dumps(dict(baseChoiceSource=str(source))))
                (student/'config.json').write_text('{"max_position_embeddings":4096}');hashes=runtime.snapshot(source)
                resume=dict(folder=str(source),sourceHashes=hashes,initialMeta={},result=dict(mathematicalWriterStateHash='offline-math',baseStateBefore='offline-base'),
                    final=dict(semanticFile='not-loaded',semanticStateHash='offline-semantic',head=e['head'],labels=[]))
                checked=dict(checkpoint=dict(writerStateHash='offline-math'),identity=dict(snapshotSha256={}),protected={},toolFiles={})
                fake=ModuleType('transformers')
                if tokenizer is None:
                    class RejectTurns(CounterTokenizer):
                        def apply_chat_template(self,*a,**kw):raise ValueError('unsupported chat roles')
                    tokenizer=RejectTurns()
                fake.AutoTokenizer=SimpleNamespace(from_pretrained=lambda *a,**kw:tokenizer)
                args=SimpleNamespace(source=source,out=p/'zip-experience-routing-test',work=p,student=student,old_tools=old)
                with patch.object(runtime,'inspect_source',return_value=resume),patch.object(runtime,'load_evidence',return_value=(e,{})),\
                    patch.object(runtime,'preflight',return_value=checked),patch.dict(sys.modules,{'transformers':fake}),redirect_stdout(io.StringIO()):
                    self.assertEqual(runtime.run(args),1)
                r=json.loads((args.out/'result.json').read_text());self.assertEqual(r['actualStudentGenerations'],0);self.assertFalse(r['modelWeightsLoaded'])
                self.assertTrue((args.out/'Lain-Zip-Experience-Routing-Results.zip').is_file());self.assertEqual(runtime.snapshot(source),hashes)
                self.assertNotIn('Final check:',r['error'])


if __name__=='__main__':unittest.main()
