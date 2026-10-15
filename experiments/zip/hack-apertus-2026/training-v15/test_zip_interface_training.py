"""Offline procedural-training checks; doubles never certify student learning."""
import copy
import json
import math
from pathlib import Path
import sys
import tempfile
from types import ModuleType,SimpleNamespace
import unittest
from unittest.mock import patch
from collections import Counter
from contextlib import contextmanager,redirect_stdout
import io

from test_zip_self_question_memory import evidence_fixture
from test_zip_self_question_tools import output
from test_zip_experience_routing import ACTUAL_356_GREEDY
from zip_content_core import digest
from zip_self_question_memory_core import seal
from zip_experience_binding_run import write_source_zips,read_source_zip
from zip_self_question_tools_policy import input_limits
import zip_interface_training_core as core
import zip_interface_training_policy as policy
import zip_interface_training_run as runtime


class ProceduralTokenizer:
    """Offline byte-shaped target encoding and fixed small prompt prefix."""
    model_max_length=4096;eos_token_id=68
    def apply_chat_template(self,messages,**kwargs):return 'OFFLINE-PROMPT:'+json.dumps(messages)
    def __call__(self,text,**kwargs):
        if text.startswith('OFFLINE-PROMPT:'):return dict(input_ids=[7]*100)
        return dict(input_ids=[ord(c) for c in text])
    def decode(self,ids,**kwargs):return ''.join(chr(i) for i in ids)


class Parameter:
    def __init__(self,value=0.):self.value=value;self.requires_grad=False;self.grad=None
    def requires_grad_(self,value):self.requires_grad=value;return self


class Adapter:
    def __init__(self,enabled=True):self.p=Parameter();self.enabled=enabled;self.training=False
    def parameters_to_train(self):return [self.p]
    def learned_state(self):return dict(value=self.p.value)
    def restore(self,state):self.p.value=state['value']
    def digest(self):return digest(self.learned_state())


class Scalar:
    def __init__(self,value,p=None):self.value=value;self.p=p
    def detach(self):return self
    def cpu(self):return self
    def item(self):return self.value
    def __truediv__(self,n):return Scalar(self.value/n,self.p)
    def backward(self):self.p.grad=(self.p.grad or 0.)+self.value


class Finite:
    def __init__(self,value):self.value=value
    def all(self):return self
    def item(self):return self.value


def torch_double(interface):
    class Optimizer:
        def __init__(self,params,lr,weight_decay):self.params=params;self.lr=lr
        def zero_grad(self,set_to_none):
            for p in self.params:p.grad=None
        def step(self):
            for p in self.params:p.value-=self.lr*(p.grad or 0.)
    def clip(params,limit):
        norm=math.sqrt(sum((p.grad or 0.)**2 for p in params))
        for p in params:
            if p.grad is not None and norm>limit:p.grad*=limit/norm
        return Scalar(norm)
    return SimpleNamespace(optim=SimpleNamespace(AdamW=Optimizer),
        nn=SimpleNamespace(utils=SimpleNamespace(clip_grad_norm_=clip)),
        isfinite=lambda p:Finite(math.isfinite(p.value if isinstance(p,Parameter) else p)))


def value(raw,enabled=False,state='a'*64,capped=False):
    v=output(raw,False,capped);v.update(temperature=1.,semanticAdapterEnabledDuringGeneration=False,
        interfaceAdapterEnabledDuringGeneration=enabled,interfaceStateHashDuringGeneration=state,
        adapterSwitchesStableDuringGeneration=True)
    if capped:v.update(generatedTokens=96,generatedIds=[100]*96,samplingTokenLogProbabilities=[-.25]*96,samplingLogProbability=-24.)
    return v


class Harness:
    """Actual native temporary ZIP I/O, explicitly synthetic model/optimizer."""
    def __init__(self,folder,values=None):
        self.folder=Path(folder);self.evidence,_=evidence_fixture();self.number=1
        self.bank=core.build_bank(runtime.sha(Path(core.__file__)));self.lessons=core.make_lessons(self.evidence,self.bank)
        self.tokenizer=ProceduralTokenizer();self.limits=input_limits(dict(max_position_embeddings=4096),self.tokenizer)
        self.packets={r['id']:policy.encode_lesson(self.tokenizer,r,self.limits,[68]) for r in self.lessons['examples']}
        self.interface=Adapter();self.old=[Adapter(False),Adapter(False)];self.base_p=Parameter()
        self.base=SimpleNamespace(training=False,parameters=lambda:iter([self.base_p]))
        self.source=self.folder/'sources';self.source_hashes=write_source_zips(self.source,self.evidence)
        self.note_folder=self.folder/'notes';self.note_folder.mkdir();self.hashes={}
        self.saved=[];self.calls=[];self.reads=0;self.trains=0;self.remaining=lambda:1.;self.guard=lambda:None
        self.values=dict(before_source_lookup=ACTUAL_356_GREEDY,before_experience_choice=ACTUAL_356_GREEDY,
            after_source_lookup=core.expected_lookup(self.evidence,1),after_experience_choice='T2',
            after_experience_observation='I notice that my attempts have different outcomes.',after_metric_zip_call='CALL Z1')
        if values:self.values.update(values)
    def generate(self,messages,phase,seed,sampled,enabled):
        arm='after' if enabled else 'before';self.calls.append(dict(arm=arm,phase=phase,prompt=copy.deepcopy(messages),seed=seed,sampled=sampled))
        v=self.values[arm+'_'+phase]
        if isinstance(v,Exception):raise v
        return copy.deepcopy(v) if isinstance(v,dict) else value(v,enabled,self.interface.digest())
    def save(self,kind,row):self.saved.append((kind,copy.deepcopy(row)))
    def train(self):
        self.trains+=1
        return policy.train_interface(self.base,self.interface,self.old,self.lessons,self.packets,self.remaining,
            self.guard,lambda row,state:self.save('training-step',row),torch_api=torch_double(self.interface),
            loss_function=lambda base,packet:Scalar(1.,self.interface.p))
    def read(self,identifier):self.reads+=1;return read_source_zip(self.source,self.evidence,identifier,self.source_hashes)
    def install(self,note):self.hashes[note['id']+'.zip']=runtime.write_note_zip(self.note_folder,note,self.evidence,self.bank)
    def replay(self):return runtime.read_note_zips(self.note_folder,self.hashes,self.evidence,self.bank)
    def run(self):return core.run_experiment(self.evidence,self.bank,self.number,self.generate,self.train,self.save,self.guard,self.remaining,self.read,self.install,self.replay)
    def rows(self,kind):return [r for k,r in self.saved if k==kind]
    def summary(self,stop='completed'):return core.summarize(self.rows('raw'),self.rows('scored'),self.rows('note-candidate'),self.rows('source-read'),self.rows('tool-executed'),self.rows('training-step'),stop)


class ProceduralLabelChecks(unittest.TestCase):
    def setUp(self):self.evidence,_=evidence_fixture();self.bank=core.build_bank('a'*64);self.lessons=core.make_lessons(self.evidence,self.bank)
    def test_eleven_literal_addresses_two_balanced_passes_without_diagnosis_targets(self):
        labels=self.lessons['examples'];self.assertEqual([r['target'] for r in labels],['T1','T2','T3','T4']+['CALL Z'+str(i) for i in range(1,8)])
        batches=core.training_batches(self.lessons);self.assertEqual([len(b) for b in batches],[4,4,3,4,4,3])
        self.assertEqual(Counter(r['id'] for b in batches for r in b),{r['id']:2 for r in labels})
        for k in ('studentAuthoredTrainingTargets','mathematicalTargetAnswersProvided','targetWeaknessOrPlanProvided','numericalMetricResultsProvided','heldoutHistoriesUsed'):self.assertFalse(self.lessons[k])
        self.assertTrue(self.lessons['hostSupervisedProceduralLabels']);self.assertEqual(self.lessons['teacherModelCalls'],0)
    def test_originals_all_preserved_but_heldout_and_metric_results_never_enter_labels(self):
        text=str(self.lessons)
        for h in self.evidence['evaluation']:self.assertNotIn(h['goal'],text)
        for h in self.evidence['training']:
            lesson=next(r for r in self.lessons['examples'] if r['target']==h['historyId'])
            self.assertIn(h['goal'],str(lesson['prompt']));self.assertNotIn('features',str(lesson['prompt']))
            for route in h['routes']:self.assertIn(json.dumps(route['original']['studentOutput']['raw']),str(lesson['prompt']))
        self.assertNotIn('desiredQuestion',text);self.assertNotIn('metricValue',text)
    def test_rehashing_changed_labels_sources_or_tool_definitions_does_not_authorize_training(self):
        for key in ('target','sourceTaskId','prompt'):
            broken=copy.deepcopy(self.lessons)
            if key=='prompt':broken['examples'][0][key][-1]['content']='Write the host diagnosis.'
            else:broken['examples'][0][key]='changed'
            broken=seal({k:v for k,v in broken.items() if k!='lessonHash'},'lessonHash')
            with self.subTest(key=key),self.assertRaises(ValueError):core.validate_lessons(broken,self.evidence,self.bank)
        broken=copy.deepcopy(self.bank);broken['tools'][0]['description']='Wrong source.'
        with self.assertRaises(ValueError):core.validate_bank(broken)
    def test_lookup_cannot_bind_a_heldout_goal_or_unknown_tool_definition(self):
        with self.assertRaises(ValueError):core.source_lookup_messages(self.evidence,self.evidence['evaluation'][0]['goal'])
        with self.assertRaises(ValueError):core.metric_lookup_messages(self.bank,'unknown definition')
    def test_free_choice_is_unchanged_current_interface_not_a_training_answer(self):
        messages=core.evaluation_messages(self.evidence,'experience_choice',1)
        self.assertEqual(messages,core.routing_messages(self.evidence,'separate_native'))
        self.assertNotIn('CALL Z',str(messages));self.assertNotIn('weakness',messages[-1]['content'])
        train=core.source_lookup_messages(self.evidence,self.evidence['training'][3]['goal'])
        evaluation=core.evaluation_messages(self.evidence,'source_lookup',1)
        self.assertEqual(train[:-1],evaluation[:-1]);self.assertNotEqual(train[-1],evaluation[-1])
    def test_training_bank_scope_is_four_t_records_even_when_legacy_bank_has_eight(self):
        for t in self.bank['tools']:
            self.assertEqual(t['inputScope'],'four_original_training_histories_T1_to_T4')
            self.assertFalse(t['measuredResultsStored']);self.assertFalse(t['preferredDirectionSupplied'])
        self.assertFalse(self.bank['numericalResultsProvided']);self.assertFalse(self.bank['hostChoosesMetric'])
    def test_fresh_namespace_is_distinct_and_before_after_deliberately_share_seeds(self):
        seeds={core.seed_for(n,p) for n in (1,2) for p in ('source_lookup','experience_choice','experience_observation','metric_zip_call','adapter_initialization')}
        self.assertEqual(len(seeds),10);self.assertTrue(min(seeds)>4_700_001_100)


class TargetAndPolicyChecks(unittest.TestCase):
    def make(self,tmp):return Harness(tmp)
    def test_explicit_program_eos_is_never_reported_as_sampled_student_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=self.make(tmp);p=h.packets['locate-T1']
            self.assertEqual(p['targetIds'],[84,49,68]);self.assertFalse(p['studentResponse']);self.assertFalse(p['sampledStudentTokens'])
            self.assertEqual(p['lossPositions'],'target_address_and_explicit_configured_eos_only')
            policy.validate_packet(p,h.lessons['examples'][0],h.tokenizer,h.limits,[68])
            wrong=copy.deepcopy(p);wrong['targetIds'][-1]=0;wrong=seal({k:v for k,v in wrong.items() if k!='packetHash'},'packetHash')
            with self.assertRaises(ValueError):policy.validate_packet(wrong,h.lessons['examples'][0],h.tokenizer,h.limits,[68])
    def test_configuration_without_actual_eos_or_boolean_id_fails_before_forward(self):
        for v in (True,[],[False],-1):
            with self.subTest(v=v),self.assertRaises(ValueError):policy.eos_ids(dict(eos_token_id=v),ProceduralTokenizer())
    def test_six_real_commit_callbacks_and_twenty_two_example_visits_only_new_parameters_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=self.make(tmp);old=(h.base_p.value,[a.digest() for a in h.old]);initial=h.interface.digest();result=h.train()
            self.assertEqual(result['optimizerSteps'],6);self.assertEqual(result['committedExampleVisits'],22)
            self.assertNotEqual(initial,h.interface.digest());self.assertEqual(old,(h.base_p.value,[a.digest() for a in h.old]))
            self.assertFalse(h.interface.p.requires_grad);self.assertIsNone(h.interface.p.grad)
            policy.validate_steps(h.rows('training-step'),h.lessons,h.packets,initial,h.interface.digest())
    def test_deadline_before_training_performs_no_update_and_no_forward(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=self.make(tmp);initial=h.interface.digest();h.remaining=lambda:0.
            with self.assertRaises(TimeoutError):h.train()
            self.assertEqual(h.interface.digest(),initial);self.assertEqual(h.rows('training-step'),[]);self.assertFalse(h.interface.p.requires_grad)
    def test_nonfinite_gradient_never_reaches_optimizer_and_requires_no_old_weight_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=self.make(tmp);initial=h.interface.digest()
            class BadLoss(Scalar):
                def __truediv__(self,n):return self
                def backward(self):self.p.grad=float('nan')
            with self.assertRaises(ValueError):policy.train_interface(h.base,h.interface,h.old,h.lessons,h.packets,h.remaining,h.guard,
                lambda row,state:h.save('training-step',row),torch_api=torch_double(h.interface),loss_function=lambda b,p:BadLoss(1.,h.interface.p))
            self.assertEqual(h.interface.digest(),initial);self.assertFalse(h.interface.p.requires_grad);self.assertIsNone(h.interface.p.grad)
    def test_failed_checkpoint_commit_rolls_back_only_uncommitted_candidate_step(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=self.make(tmp);initial=h.interface.digest()
            with self.assertRaises(OSError):policy.train_interface(h.base,h.interface,h.old,h.lessons,h.packets,h.remaining,h.guard,
                lambda row,state:(_ for _ in ()).throw(OSError('explicit offline I/O failure')),
                torch_api=torch_double(h.interface),loss_function=lambda b,p:Scalar(1.,h.interface.p))
            self.assertEqual(h.interface.digest(),initial);self.assertIsNone(h.interface.p.grad)
    def test_old_gradient_or_enabled_adapter_blocks_training(self):
        for change in ('grad','enabled','requires_grad'):
            with tempfile.TemporaryDirectory() as tmp:
                h=self.make(tmp)
                if change=='grad':h.base_p.grad=1.
                if change=='requires_grad':h.old[0].p.requires_grad=True
                if change=='enabled':h.old[0].enabled=True
                with self.subTest(change=change),self.assertRaises(ValueError):h.train()
                self.assertEqual(h.rows('training-step'),[])
    def test_changed_optimizer_lineage_cannot_be_rehashed_into_valid_steps(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=self.make(tmp);initial=h.interface.digest();h.train();rows=h.rows('training-step')
            for key,v in (('lessonIds',['locate-T1']),('adapterStateBefore','b'*64),('learningRate',1.),('exampleVisits',99)):
                broken=copy.deepcopy(rows);broken[2][key]=v;broken[2]=seal({k:v for k,v in broken[2].items() if k!='stepHash'},'stepHash')
                with self.subTest(key=key),self.assertRaises(ValueError):policy.validate_steps(broken,h.lessons,h.packets,initial,h.interface.digest())
    def test_target_packet_relabelled_as_student_output_cannot_train(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=self.make(tmp);p=h.packets['locate-T1'];p['studentResponse']=True
            h.packets['locate-T1']=seal({k:v for k,v in p.items() if k!='packetHash'},'packetHash')
            with self.assertRaises(ValueError):h.train()


class InterfaceLoopChecks(unittest.TestCase):
    def test_fixed_before_after_calls_training_between_then_actual_selected_source_and_tool(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);before=copy.deepcopy(h.evidence);h.run();report=h.summary()
            self.assertEqual(len(h.calls),6);self.assertEqual(h.trains,1);self.assertEqual(h.reads,1)
            self.assertEqual([(c['arm'],c['phase']) for c in h.calls[:4]],[(a,p) for a in ('before','after') for p in ('source_lookup','experience_choice')])
            self.assertEqual(h.calls[0]['prompt'],h.calls[2]['prompt']);self.assertEqual(h.calls[0]['seed'],h.calls[2]['seed'])
            self.assertEqual(h.calls[1]['prompt'],h.calls[3]['prompt']);self.assertEqual(h.calls[1]['seed'],h.calls[3]['seed'])
            self.assertTrue(report['completeBeforeAfterInterfaceComparison']);self.assertEqual(report['actualInterfaceOptimizerUpdates'],6)
            self.assertEqual(report['actualMeasurementZipExecutions'],1);self.assertEqual(report['sourceBoundStudentHypothesisZips'],1)
            self.assertEqual(report['byEndpoint']['source_lookup']['signedAfterMinusBefore'],1)
            self.assertFalse(report['semanticSelfAnalysisProved']);self.assertFalse(report['mathematicalBenefitTested'])
            self.assertFalse(report['hostChoosesMetric']);self.assertFalse(report['productionBankUpdated']);self.assertEqual(report['independentTrainingReplications'],0)
            self.assertEqual(h.evidence,before)
    def test_four_invalid_selections_still_complete_training_comparison_without_host_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp,{a+'_'+p:ACTUAL_356_GREEDY for a in ('before','after') for p in ('source_lookup','experience_choice')});h.run();r=h.summary()
            self.assertEqual(len(h.calls),4);self.assertEqual(len(h.rows('training-step')),6);self.assertEqual(h.reads,0)
            self.assertTrue(r['completeBeforeAfterInterfaceComparison']);self.assertEqual(r['sourceBoundStudentHypothesisZips'],0)
            self.assertEqual(r['byEndpoint']['experience_choice']['signedAfterMinusBefore'],0)
    def test_program_lookup_answer_is_never_used_as_autonomous_choice_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp,dict(after_experience_choice='NONE'));h.run()
            self.assertTrue(h.summary()['byEndpoint']['source_lookup']['after']);self.assertFalse(h.summary()['byEndpoint']['experience_choice']['after'])
            self.assertEqual(h.reads,0);self.assertEqual(len(h.calls),4)
    def test_cap_or_goal_continuation_cannot_unlock_selected_source_read(self):
        for v in (value('T2',True,capped=True),value(ACTUAL_356_GREEDY,True)):
            with tempfile.TemporaryDirectory() as tmp:
                h=Harness(tmp,dict(after_experience_choice=v));h.run();self.assertEqual(h.reads,0);self.assertEqual(len(h.calls),4)
    def test_bad_observation_retains_whole_original_but_skips_note_reuse_and_metric_call(self):
        for v in ('v=2*v.',value('I notice outcomes.',True,capped=True)):
            with tempfile.TemporaryDirectory() as tmp:
                h=Harness(tmp,dict(after_experience_observation=v));h.run();self.assertEqual(len(h.calls),5)
                self.assertEqual(h.replay(),[]);self.assertEqual(h.summary()['actualMeasurementZipExecutions'],0)
                self.assertEqual(h.rows('raw')[-1]['studentOutput']['raw'],v['raw'] if isinstance(v,dict) else v)
    def test_invalid_metric_call_does_not_get_repaired_to_tool_execution(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp,dict(after_metric_zip_call='Z7: 0.5'));h.run()
            self.assertEqual(len(h.calls),6);self.assertEqual(h.summary()['actualMeasurementZipExecutions'],0)
    def test_actual_flags_bad_log_sum_or_fixture_save_raw_before_rejection(self):
        for update in ({'semanticAdapterEnabledDuringGeneration':True},{'interfaceAdapterEnabledDuringGeneration':True},
                {'samplingLogProbability':-30.},{'testDouble':True},{'adapterSwitchesStableDuringGeneration':False}):
            with tempfile.TemporaryDirectory() as tmp:
                h=Harness(tmp,dict(before_source_lookup=dict(value('T4'),**update)))
                with self.subTest(update=update),self.assertRaises(ValueError):h.run()
                self.assertEqual(len(h.rows('raw')),1);self.assertEqual(h.rows('scored'),[]);self.assertEqual(h.trains,0)
    def test_failed_generation_keeps_prior_raws_and_committed_training_not_a_completed_pair(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp,dict(after_source_lookup=RuntimeError('explicit offline failure')))
            with self.assertRaises(RuntimeError):h.run()
            r=h.summary('error');self.assertEqual(r['actualStudentGenerations'],2);self.assertEqual(r['actualInterfaceOptimizerUpdates'],6)
            self.assertFalse(r['completeBeforeAfterInterfaceComparison']);self.assertIsNone(r['byEndpoint']['source_lookup']['signedAfterMinusBefore'])
    def test_zero_updates_cannot_certify_complete_training_or_signed_effect(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);h.train=lambda:dict(id='completed',optimizerSteps=0,committedExampleVisits=0,lessonHash=h.lessons['lessonHash'],programSupervisedLabels=True,finiteStateVerified=True)
            with self.assertRaises(ValueError):h.run()
            r=h.summary('error');self.assertEqual(len(h.calls),2);self.assertFalse(r['allElevenRegistryAddressesTrainedEqually'])
            self.assertFalse(r['completeBeforeAfterInterfaceComparison'])
    def test_changed_observation_zip_or_rebound_choice_cannot_be_loaded(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);h.run();note=h.replay()[0];wrong=copy.deepcopy(note);wrong['sourceZip']=core.source_root(h.evidence['training'][0],h.evidence)
            with self.assertRaises(ValueError):core.validate_note(wrong,h.evidence,h.bank)
            path=h.note_folder/'I1.zip';path.write_bytes(b'changed')
            with self.assertRaises(ValueError):h.replay()
    def test_all_failed_training_routes_measure_zero_success_probability_no_regrade(self):
        evidence,_=evidence_fixture(True);bank=core.build_bank('a'*64);v=value('CALL Z1',True)
        check=core.call_audit(v,bank);result=core.execute_measurement(evidence,bank,v,check)
        self.assertEqual(result['value'],0.);self.assertEqual(result['originalHistories'],4)
        self.assertEqual([w['historyId'] for w in result['evidence']],['T1','T2','T3','T4']);self.assertFalse(result['understandingVerified'])
    def test_each_kernel_uses_exact_four_source_histories_and_native_zip_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);kernel=Path(core.__file__);folder=Path(tmp)/'metric';manifest=runtime.write_measurement_zips(folder,h.bank,kernel)
            for t in h.bank['tools']:
                runtime.validate_measurement_zip(folder,h.bank,t['id'],manifest,kernel)
                v=value('CALL '+t['id'],True);m=core.execute_measurement(h.evidence,h.bank,v,core.call_audit(v,h.bank))
                self.assertTrue(0<=m['value']<=1);self.assertEqual(len(m['evidence']),4)
            (folder/'Z1.zip').write_bytes(b'changed')
            with self.assertRaises(ValueError):runtime.validate_measurement_zip(folder,h.bank,'Z1',manifest,kernel)
    def test_scope_mutation_or_deadline_prevents_dependent_actions(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);h.remaining=lambda:0.
            with self.assertRaises(TimeoutError):h.run()
            self.assertEqual(h.calls,[]);self.assertEqual(h.trains,0)


class RuntimeBoundaryChecks(unittest.TestCase):
    def test_tokenizer_only_preflight_covers_all_eleven_targets_and_all_possible_source_prompts(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);student=Path(tmp)/'student';student.mkdir()
            (student/'config.json').write_text(json.dumps(dict(max_position_embeddings=4096,eos_token_id=68)))
            module=ModuleType('transformers');module.AutoTokenizer=SimpleNamespace(from_pretrained=lambda *a,**k:ProceduralTokenizer())
            with patch.dict(sys.modules,transformers=module):limits,packets,report=runtime.prepare_inputs(student,h.evidence,h.bank,h.lessons,1)
            self.assertEqual(len(packets),11);self.assertEqual(len(report['rows']),10)
            self.assertTrue(report['allPlannedPromptsFit']);self.assertEqual(report['actualStudentGenerations'],0)
            self.assertFalse(report['modelWeightsLoaded']);self.assertFalse(report['placeholderStudentObservationCreated'])
            self.assertEqual([r['planningEchoReserve'] for r in report['rows'] if r['phase'].startswith('call-')],[192]*4)
    def test_unreviewed_source_rejected_before_model_import_and_output_creation(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp);args=SimpleNamespace(source=path/'source',out=path/'output')
            with patch.object(runtime,'inspect_source',side_effect=ValueError('unreviewed source')):
                with self.assertRaises(ValueError):runtime.run(args)
            self.assertFalse(args.out.exists())
    def test_partial_run_reserves_number_and_does_not_reuse_old_routing_namespace(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'zip-interface-training-offline';path.mkdir()
            (path/'protocol.json').write_text(json.dumps(dict(protocol=core.PROTOCOL,experimentNumber=3)))
            self.assertEqual(runtime.next_number(tmp),4)

    def test_full_runner_saves_step_checkpoints_actual_flags_and_archive_with_only_explicit_doubles(self):
        # No real torch/model execution occurs: this checks the runner's wiring,
        # integrity boundaries and archive reporting, not optimization quality.
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp);source=folder/'source';source.mkdir();(source/'checkpoints').mkdir()
            student=folder/'student';student.mkdir();old_tools=folder/'old-tools';old_tools.mkdir()
            (source/'result.json').write_text('{}');(source/'source-checkpoint.json').write_text(json.dumps(dict(baseChoiceSource=str(source))))
            (source/'checkpoints'/'semantic.safetensors').write_text(json.dumps({'b.weight':2.}))
            math_path=folder/'math.safetensors';math_path.write_text(json.dumps({'b.weight':1.}))
            (student/'config.json').write_text(json.dumps(dict(max_position_embeddings=4096,eos_token_id=68)))
            (old_tools/'zip_pilot.py').write_text('# explicit offline stand-in\n')
            evidence,_=evidence_fixture();base_p=Parameter()
            class Base:
                training=False;generation_config=SimpleNamespace(eos_token_id=68)
                def parameters(self):return iter([base_p])
                def eval(self):self.training=False;return self
                def requires_grad_(self,value):base_p.requires_grad_(value);return self
            base=Base();created=[]
            class ModelAdapter(Adapter):
                def __init__(self,base,**kwargs):super().__init__();created.append(self)
                def learned_state(self):return {'b.weight':self.p.value}
                def restore(self,state):self.p.value=state['b.weight']
                def eval(self):self.training=False;return self
                def close(self):pass
                @contextmanager
                def active(self,value):
                    old=self.enabled;self.enabled=value
                    try:yield
                    finally:self.enabled=old
            base_hash=digest(dict(base=0.));math_hash=digest({'b.weight':1.});semantic_hash=digest({'b.weight':2.})
            resume=dict(sourceHashes=runtime.snapshot(source),result=dict(mathematicalWriterStateHash=math_hash,baseStateBefore=base_hash),
                final=dict(semanticStateHash=semantic_hash,semanticFile='semantic.safetensors',head={},labels={}),initialMeta={})
            checked=dict(checkpoint=dict(writerStateHash=math_hash),identity=dict(snapshotSha256={'offline':True}),writer=math_path,
                protected={str(student/'config.json'):runtime.sha(student/'config.json')},toolFiles=runtime.snapshot(old_tools))
            transformers=ModuleType('transformers');transformers.AutoTokenizer=SimpleNamespace(from_pretrained=lambda *a,**k:ProceduralTokenizer())
            torch=ModuleType('torch');torch.manual_seed=lambda n:None;torch.count_nonzero=lambda v:Scalar(int(v!=0))
            safetensors=ModuleType('safetensors');st=ModuleType('safetensors.torch')
            st.load_file=lambda p:json.loads(Path(p).read_text())
            def save_file(state,p):
                with Path(p).open('x') as f:json.dump(state,f)
            st.save_file=save_file
            loader=ModuleType('zip_pilot');loader.load_student=lambda *a:(base,ProceduralTokenizer(),dict(snapshotSha256={'offline':True}))
            model=ModuleType('zip_pilot_model');model.state_digest=lambda b:base_hash
            adapter=ModuleType('math_writer_adapter');adapter.MathWriterAdapter=ModelAdapter
            values=[ACTUAL_356_GREEDY,ACTUAL_356_GREEDY,core.expected_lookup(evidence,1),'T2',
                'I notice that my attempts have different outcomes.','CALL Z6']
            def sampler(*args,**kwargs):
                v=value(values.pop(0));v['promptIds']=list(kwargs['input_audit']['promptIds']);return v
            def procedural_train(base,interface,old,lessons,packets,remaining,guard,commit,stage):
                return policy.train_interface(base,interface,old,lessons,packets,remaining,guard,commit,stage,
                    torch_api=torch_double(interface),loss_function=lambda b,p:Scalar(1.,interface.p))
            args=SimpleNamespace(source=source,work=folder,student=student,old_tools=old_tools,out=folder/'out')
            modules=dict(transformers=transformers,torch=torch,safetensors=safetensors,**{'safetensors.torch':st},
                zip_pilot=loader,zip_pilot_model=model,math_writer_adapter=adapter)
            with patch.dict(sys.modules,modules),patch.object(runtime,'inspect_source',return_value=resume),\
                    patch.object(runtime,'load_evidence',return_value=(evidence,{'explicitOfflineOnly':True})),\
                    patch.object(runtime,'preflight',return_value=checked),patch.object(runtime,'generate',side_effect=sampler),\
                    patch.object(runtime,'train_interface',side_effect=procedural_train),redirect_stdout(io.StringIO()):
                status=runtime.run(args)
            result=json.loads((args.out/'result.json').read_text());self.assertEqual(status,0,msg=result.get('error'))
            self.assertEqual(result['trainingUpdates'],6);self.assertEqual(result['actualStudentGenerations'],6)
            self.assertTrue(result['interfaceParametersChanged']);self.assertTrue(result['baseWeightsUnchanged']);self.assertTrue(result['semanticWriterUnchanged'])
            self.assertEqual(len(result['interfaceCheckpointFiles']),8);self.assertTrue((args.out/'Lain-Zip-Interface-Training-Results.zip').is_file())
            self.assertEqual(result['actualMeasurementZipExecutions'],1);self.assertFalse(result['productionCheckpointOrBankUpdated'])
            rows=[json.loads(p.read_text()) for p in (args.out/'responses').glob('*-raw.json')]
            self.assertTrue(all(r['studentOutput']['semanticAdapterEnabledDuringGeneration'] is False for r in rows))
            self.assertTrue(all(r['studentOutput']['interfaceAdapterEnabledDuringGeneration']==(r['arm']=='after') for r in rows))


if __name__=='__main__':unittest.main()
