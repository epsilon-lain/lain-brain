"""Offline contract checks. Synthetic fixtures are never reported as student runs."""
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

from draft_inspect_runtime import sha
from test_zip_self_question_tools import fixture, output, CounterTokenizer, generated_checked_fixture
from zip_label_metacognitive_checks import restore_head, sequential_sum
import zip_self_question_memory_core as core
import zip_self_question_memory_source as source
import zip_self_question_memory_run as runtime
import zip_self_question_tools_policy as original_policy


def evidence_fixture(all_failed=False):
    bundle, _ = fixture(all_failed)
    partitions = [[], []]
    for index, anchor in enumerate(bundle['anchors']):
        task = copy.deepcopy(anchor['task'])
        split = 0 if index < 4 else 1
        task['split'] = 'training' if split == 0 else 'heldout'
        obs = copy.deepcopy(anchor['observation']);obs['task'] = copy.deepcopy(task)
        routes = [copy.deepcopy(bundle['routes'][task['id'] + '/' + rid]) for rid in anchor['mathRecordIds']]
        for row in routes:row['task'] = copy.deepcopy(task)
        label = ('T' if split == 0 else 'E') + str(index % 4 + 1)
        partitions[split].append(source.history(task,obs,anchor['features'],anchor['featureId'],routes,label))
    head = restore_head(bundle['head'])
    expected = sequential_sum(sequential_sum(p * int(r['outcomePassed']) for p,r in
        zip(head.probabilities(h['features'])[1],h['routes'])) for h in partitions[1]) / 4
    evidence = core.seal(dict(protocol=core.PROTOCOL,training=partitions[0],evaluation=partitions[1],
        head=bundle['head'],sourceTrainingBundleHash=bundle['bundleHash'],independentExpectedPassMean=expected,
        heldoutUsedOnlyForFrozenEvaluation=True,originalTrainingAnchorCount=8,
        trainingHistorySelectionByScores=False,newMathematicsObjects=0),'evidenceHash')
    core.validate_evidence(evidence)
    return evidence, core.build_bank(sha(Path(core.__file__)))


def candidate(evidence, raw='T1 A1 passed. I would inspect my next rewrite.', number=1, capped=False):
    row = dict(recordId='explicit-offline-memory-' + str(number),phase='memory_write',arm='memory_writer',
        sampled=number == 2,samplingSeed=core.seed_for(1,'memory_write',number),
        studentPrompt=core.memory_messages(evidence),studentOutput=output(raw,number == 2,capped),
        evidenceHash=evidence['evidenceHash'],bankHash='offline-bank-unused-in-memory',fixtureOnly=False)
    return core.memory_record(row,evidence,core.outcome_audit(row['studentOutput'],evidence,'training'),number)


class Harness:
    """The loop uses real temporary native ZIP files, but only synthetic generations."""
    def __init__(self, folder, values=None, number=1):
        self.evidence,self.bank = evidence_fixture()
        self.folder = Path(folder);self.folder.mkdir(exist_ok=True)
        self.values = list(values if values is not None else [
            'T1 A1 passed. I would inspect my next rewrite.',
            'T2 A3 failed. I would inspect the recorded attempt.',
            'E1 A1 passed. I want to inspect my recorded work.','CALL Z1',
            'E1 A1 passed. I want to inspect my recorded work.','CALL Z6'])
        self.number=number;self.saved=[];self.generations=[];self.hashes={};self.measures=0;self.reads=0
        self.frozen_callback=lambda:None;self.remaining_callback=lambda:1

    def generate(self,messages,phase,seed,sampled):
        self.generations.append(dict(messages=copy.deepcopy(messages),phase=phase,seed=seed,sampled=sampled))
        value=self.values.pop(0)
        if isinstance(value,Exception):raise value
        return copy.deepcopy(value) if isinstance(value,dict) else output(value,sampled)

    def save(self,kind,row):self.saved.append((kind,copy.deepcopy(row)))

    def install(self,memory):
        self.hashes[memory['id']+'.zip']=runtime.write_memory_zip(self.folder,memory,self.evidence)

    def read(self):
        self.reads+=1
        return runtime.read_memory_zips(self.folder,self.hashes,self.evidence)

    def measure(self,*args):
        self.measures+=1
        return core.execute_measurement(*args)

    def run(self):
        return core.run_experiment(self.evidence,self.bank,self.number,self.generate,self.save,
            self.frozen_callback,self.remaining_callback,self.install,self.read,self.measure)

    def summary(self,stop='completed'):
        def rows(kind):return [row for k,row in self.saved if k==kind]
        return core.summarize(rows('raw'),rows('scored'),rows('memory-candidate'),rows('arm'),rows('tool-executed'),stop)


class EvidenceAndMemoryChecks(unittest.TestCase):
    def setUp(self):self.evidence,self.bank=evidence_fixture()

    def test_memory_uses_only_four_training_originals_and_current_request_at_end(self):
        before=copy.deepcopy(self.evidence);text=core.memory_messages(self.evidence)[-1]['content']
        for h in self.evidence['training']:
            self.assertIn(json.dumps(h['goal']),text)
            self.assertIn(json.dumps(h['observation']['studentOutput']['raw']),text)
            for route in h['routes']:self.assertIn(json.dumps(route['original']['studentOutput']['raw']),text)
        for h in self.evidence['evaluation']:self.assertNotIn(json.dumps(h['goal']),text)
        for tool in self.bank['tools']:self.assertNotIn(tool['operation'],text)
        request=text[text.index('Current request:'):]
        self.assertNotIn('T1',request);self.assertNotIn('A1',request)
        self.assertIn('Use your own words.',request)
        self.assertEqual(self.evidence,before)
        self.assertNotIn('hidden_fixture_family',text)

    def test_partition_provenance_and_route_binding_cannot_be_rehashed_away(self):
        for change in ('heldout','fixture','route','duplicate'):
            broken=copy.deepcopy(self.evidence)
            if change=='heldout':broken['training'][0]['task']['split']='heldout'
            if change=='fixture':broken['training'][0]['observation']['studentOutput']['testDouble']=True
            if change=='route':broken['evaluation'][0]['routes'][0]['outcomePassed']=False
            if change=='duplicate':broken['evaluation'][0]['taskId']=broken['training'][0]['taskId']
            broken=core.seal({k:v for k,v in broken.items() if k!='evidenceHash'},'evidenceHash')
            with self.subTest(change=change),self.assertRaises(ValueError):core.validate_evidence(broken)

    def test_only_selected_outcome_is_verified_and_causal_prose_remains_hypothesis(self):
        raw='T1 A1 passed. This happened because my inner evaluator understands every future task.'
        check=core.outcome_audit(output(raw),self.evidence,'training')
        self.assertTrue(check['selectedOutcomeVerified']);self.assertTrue(check['reusableInFrozenExperiment'])
        self.assertFalse(check['explanationVerified']);self.assertFalse(check['wholeNoteCertified'])
        self.assertEqual(check['trainingCredit'],0)
        self.assertEqual(check['literalOutcomeSpan']['text'],'T1 A1 passed')
        self.assertEqual(raw[check['literalOutcomeSpan']['start']:check['literalOutcomeSpan']['end']],check['literalOutcomeSpan']['text'])
        memory=candidate(self.evidence,raw)
        self.assertEqual(core.memory_presentation(memory,self.evidence)['studentOriginal'],raw)
        self.assertFalse(memory['productionActive'])

    def test_false_unknown_multiple_negated_question_and_hypothetical_facts_do_not_reuse(self):
        cases=['T1 A1 failed. I want to inspect it.','T9 A1 passed.','E1 A1 passed.',
            'T1 A8 passed.','T1 A1 passed. T2 A1 passed.','T1 A1 passed or failed.',
            'Did T1 A1 pass?','T1 A1 passed?','If T1 A1 passed, I would inspect it.',
            'T1 A1 did not pass.','It is false that T1 A1 passed.','T1 A1 passed is false.',
            'T1 A1 should have passed.','T1 A1 might have passed.','T1 A1 passed. v=2*v.']
        for raw in cases:
            with self.subTest(raw=raw):self.assertFalse(core.outcome_audit(output(raw),self.evidence,'training')['reusableInFrozenExperiment'])

    def test_cap_missing_eos_and_unfinished_original_never_gain_memory(self):
        for value in (output('T1 A1 passed.',capped=True),dict(output('T1 A1 passed.'),stopReason='unknown'),
                      output(''),output('T1 A1')):
            self.assertFalse(core.outcome_audit(value,self.evidence,'training')['reusableInFrozenExperiment'])

    def test_evaluation_fact_cannot_be_installed_as_training_memory(self):
        check=core.outcome_audit(output('E1 A1 passed.'),self.evidence,'evaluation')
        self.assertTrue(check['selectedOutcomeVerified']);self.assertFalse(check['reusableInFrozenExperiment'])
        row=candidate(self.evidence)['studentOriginal'];row['studentOutput']=output('E1 A1 passed.')
        with self.assertRaises(ValueError):core.memory_record(row,self.evidence,check,1)

    def test_memory_hash_and_certificate_reconstruct_from_whole_original(self):
        memory=candidate(self.evidence);core.validate_memory(memory,self.evidence)
        for key in ('word','outcome','active','logs'):
            broken=copy.deepcopy(memory)
            if key=='word':broken['studentOriginal']['studentOutput']['raw']='T1 A1 failed.'
            if key=='outcome':broken['claimAudit']['originalOutcomePassed']=False
            if key=='active':broken['productionActive']=True
            if key=='logs':broken['studentOriginal']['studentOutput']['samplingLogProbability']=0
            broken=core.seal({k:v for k,v in broken.items() if k!='memoryHash'},'memoryHash')
            with self.subTest(key=key),self.assertRaises(ValueError):core.validate_memory(broken,self.evidence)

    def test_native_zip_roundtrip_keeps_original_tokens_and_source_and_detects_tampering(self):
        memory=candidate(self.evidence)
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp);p=folder/'M1.zip';hashes={'M1.zip':runtime.write_memory_zip(folder,memory,self.evidence)}
            self.assertEqual(runtime.read_memory_zips(folder,hashes,self.evidence),[memory])
            with zipfile.ZipFile(p) as z:
                original=json.loads(z.read('student-original.json'))
                self.assertEqual(original,memory['studentOriginal'])
                self.assertEqual(original['studentOutput']['generatedIds'],[101,102,103])
                data={n:z.read(n) for n in z.namelist()}
            h=json.loads(data['source-experience.json']);h['goal']='altered original'
            data['source-experience.json']=json.dumps(h).encode();p.unlink()
            with zipfile.ZipFile(p,'x') as z:
                for n,b in data.items():z.writestr(n,b)
            with self.assertRaises(ValueError):runtime.read_memory_zips(folder,hashes,self.evidence)
            with self.assertRaises(ValueError):runtime.read_memory_zips(folder,{'M1.zip':sha(p)},self.evidence)

    def test_unbound_candidates_never_install_and_extra_memory_files_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp)
            with self.assertRaises(ValueError):runtime.write_memory_zip(folder,candidate(self.evidence,'No chosen history.'),self.evidence)
            (folder/'unexpected.zip').write_bytes(b'unknown')
            with self.assertRaises(ValueError):runtime.read_memory_zips(folder,{},self.evidence)

    def test_both_arms_share_all_raw_evidence_and_only_extra_notes_differ(self):
        memory=candidate(self.evidence)
        without=core.review_messages(self.evidence,[memory],core.ARMS[0])
        with_memory=core.review_messages(self.evidence,[memory],core.ARMS[1])
        self.assertEqual(without[0],with_memory[0])
        marker='\n\nYour saved experience ZIP notes'
        a=without[-1]['content'];b=with_memory[-1]['content']
        self.assertEqual(a[:a.index('\n\nEnd of records.')],b[:b.index(marker)])
        self.assertEqual(a[a.index('\n\nEnd of records.'):],b[b.index('\n\nEnd of records.'):])
        self.assertEqual(core.review_messages(self.evidence,[],core.ARMS[0]),core.review_messages(self.evidence,[],core.ARMS[1]))
        self.assertIn(memory['studentOriginal']['studentOutput']['raw'],b)
        self.assertNotIn('hidden_fixture_family',b)


class MeasurementChecks(unittest.TestCase):
    def setUp(self):self.evidence,self.bank=evidence_fixture()

    def test_catalogue_definitions_only_call_request_last_and_paired_order(self):
        text=core.call_messages(output('E1 A1 passed.'),self.bank,3)[-1]['content']
        self.assertGreater(text.index('Current request:'),text.index('Available measurement ZIPs'))
        self.assertTrue(text.endswith('or NONE to decline.'))
        self.assertNotIn('Metric | Value',text)
        for tool in self.bank['tools']:
            self.assertFalse(tool['measuredResultsStored']);self.assertFalse(tool['preferredDirectionSupplied'])
            self.assertFalse(tool['desiredQuestionOrPlanSupplied'])
        self.assertEqual(core.call_messages(output('Same original.'),self.bank,3),
                         core.call_messages(output('Same original.'),self.bank,3))

    def test_actual_53ce_guesses_and_definition_copy_never_execute(self):
        invalid=['Z7: 0.5','Z3: Uncertified observation fraction. Fraction of saved observations marked pending by their factual audits. Pending means there is no audit yet, so this is a placeholder.',
            'CALL Z8','CALL Z1\nCALL Z2','CALL Z2 because it is best']
        for raw in invalid:
            value=output(raw);check=core.call_audit(value,self.bank)
            with self.subTest(raw=raw):
                self.assertFalse(check['callVerified'])
                with self.assertRaises(ValueError):core.execute_measurement(self.evidence,self.bank,value,check)
        self.assertTrue(core.call_audit(output('NONE'),self.bank)['declined'])
        self.assertFalse(core.call_audit(output('CALL Z1',capped=True),self.bank)['callVerified'])

    def test_all_seven_tools_measure_only_four_e_histories_and_match_independent_math(self):
        head=restore_head(self.evidence['head']);histories=self.evidence['evaluation']
        import math
        probs=[head.probabilities(h['features'])[1] for h in histories]
        audits=[h['observationAudit'] for h in histories]
        tops=[max(range(3),key=p.__getitem__) for p in probs]
        expected=[self.evidence['independentExpectedPassMean'],
            sum(a['status']=='rejected' for a in audits)/4,sum(a['status']=='pending' for a in audits)/4,
            sum(a['tokenCapReached'] for a in audits)/4,max(tops.count(x) for x in set(tops))/4,
            sum(-sum(p*math.log(p) for p in ps)/math.log(3) for ps in probs)/4,
            len({h['observation']['studentOutput']['raw'] for h in histories})/4]
        for i,value in enumerate(expected,1):
            original=output('CALL Z'+str(i));result=core.execute_measurement(self.evidence,self.bank,original,core.call_audit(original,self.bank))
            with self.subTest(tool=i):
                self.assertAlmostEqual(result['value'],value,places=9)
                self.assertEqual([w['historyId'] for w in result['evidence']],['E1','E2','E3','E4'])
                self.assertEqual(result['histories'],4);self.assertFalse(result['otherMetricResultsSupplied'])
        self.assertNotEqual(expected[0],sequential_sum(sequential_sum(p*int(r['outcomePassed']) for p,r in
            zip(head.probabilities(h['features'])[1],h['routes'])) for h in self.evidence['training'])/4)

    def test_all_failed_route_probability_zero_and_changed_numeric_result_rejected(self):
        evidence,bank=evidence_fixture(True);value=output('CALL Z1')
        self.assertEqual(core.execute_measurement(evidence,bank,value,core.call_audit(value,bank))['value'],0)
        changed=copy.deepcopy(self.evidence);changed['independentExpectedPassMean']+=.1
        changed=core.seal({k:v for k,v in changed.items() if k!='evidenceHash'},'evidenceHash')
        with self.assertRaises(ValueError):core.execute_measurement(changed,self.bank,value,core.call_audit(value,self.bank))

    def test_native_measurement_roots_and_kernel_hash_are_actual_and_tampering_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp)/'tools';runtime.write_measurement_zips(folder,self.bank)
            for tool in self.bank['tools']:runtime.validate_measurement_zip(folder,self.bank,tool['id'])
            p=folder/'Z1.zip'
            with zipfile.ZipFile(p) as z:root=z.read('root.json')
            p.unlink()
            with zipfile.ZipFile(p,'x') as z:
                z.writestr('root.json',root);z.writestr('kernel.py','changed kernel')
            with self.assertRaises(ValueError):runtime.validate_measurement_zip(folder,self.bank,'Z1')


class MemoryLoopChecks(unittest.TestCase):
    def test_fixed_six_calls_actual_memory_disk_replay_paired_seeds_and_raw_first(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);before=copy.deepcopy(h.evidence);arms=h.run();report=h.summary()
            self.assertEqual(len(arms),2);self.assertEqual(len(h.generations),6);self.assertEqual(h.measures,2)
            self.assertEqual([v['phase'] for v in h.generations],['memory_write','memory_write',
                'evaluation_review','metric_zip_call','evaluation_review','metric_zip_call'])
            self.assertEqual([v['sampled'] for v in h.generations],[False,True,False,False,False,False])
            self.assertEqual(h.generations[2]['seed'],h.generations[4]['seed'])
            self.assertEqual(h.generations[3]['seed'],h.generations[5]['seed'])
            self.assertEqual(h.evidence,before);self.assertGreaterEqual(h.reads,5)
            self.assertEqual(len(h.hashes),2);self.assertEqual(len(list(Path(tmp).glob('*.zip'))),2)
            for i,(kind,row) in enumerate(h.saved):
                if kind=='scored':
                    self.assertEqual(h.saved[i-1][0],'raw')
                    self.assertEqual(h.saved[i-1][1],{k:v for k,v in row.items() if k!='check'})
            self.assertTrue(report['completePairedReplay']);self.assertTrue(report['completeMemoryMeasurementExperiment'])
            self.assertEqual(report['sourceBoundOutcomeDifferenceWithMinusWithout'],0)
            self.assertEqual(report['independentComparisonContexts'],1)
            self.assertTrue(report['outcomeCopyingDoesNotCertifyUnderstanding'])
            self.assertFalse(report['explanationOrPlanVerified']);self.assertFalse(report['mathematicalBenefitTested'])
            self.assertFalse(report['uniqueZipEncodingEffectIsolated']);self.assertEqual(report['trainingUpdates'],0)

    def test_difference_is_signed_paired_factual_binding_not_sample_luck(self):
        for expected,baseline,with_memory in ((1,'failed','passed'),(-1,'passed','failed')):
            with tempfile.TemporaryDirectory() as tmp:
                h=Harness(tmp);h.values[2]='E1 A1 '+baseline+'.';h.values[4]='E1 A1 '+with_memory+'.';h.run()
                self.assertEqual(h.summary()['sourceBoundOutcomeDifferenceWithMinusWithout'],expected)
                self.assertFalse(h.summary()['completeMemoryMeasurementExperiment'])

    def test_invalid_two_candidates_stop_after_two_calls_no_false_replay_or_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp,['I observe some issues.','T1 A1 failed.']);self.assertEqual(h.run(),[])
            self.assertEqual(len(h.generations),2);self.assertEqual(h.measures,0);self.assertEqual(h.hashes,{})
            report=h.summary();self.assertTrue(report['runCompletedNormally'])
            self.assertFalse(report['completePairedReplay']);self.assertFalse(report['memoryContrastAvailable'])
            self.assertIsNone(report['sourceBoundOutcomeDifferenceWithMinusWithout'])
            self.assertEqual(report['memoryCandidates'],2)
            self.assertEqual(report['independentComparisonContexts'],0)

    def test_mixed_candidate_replays_only_one_and_capped_original_not_completed(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);h.values[1]=output('T2 A3 failed.',True,True);h.run()
            self.assertEqual(set(h.hashes),{'M1.zip'});self.assertEqual(h.summary()['cappedResponses'],1)
            content=h.generations[4]['messages'][-1]['content']
            self.assertIn('"id": "M1"',content);self.assertNotIn('"id": "M2"',content)

    def test_capped_review_skips_its_call_without_fabricating_full_completion(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);h.values=[h.values[0],h.values[1],output('E1 A1 passed.',capped=True),h.values[4],h.values[5]]
            arms=h.run();self.assertEqual(len(h.generations),5);self.assertEqual(h.measures,1)
            self.assertIsNone(arms[0]['callRecordId']);self.assertFalse(h.summary()['completePairedReplay'])
            self.assertTrue(h.summary()['memoryContrastAvailable'])

    def test_invalid_and_declined_calls_do_not_execute_default_tool_or_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);h.values[3]='Z7: 0.5';h.values[5]='NONE';h.run()
            self.assertEqual(len(h.generations),6);self.assertEqual(h.measures,0)
            self.assertTrue(h.summary()['completePairedReplay']);self.assertFalse(h.summary()['completeMemoryMeasurementExperiment'])

    def test_counterbalanced_arm_order_keeps_paired_seeds_and_new_namespace(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp,number=2);arms=h.run();self.assertEqual([a['arm'] for a in arms],list(reversed(core.ARMS)))
            self.assertEqual(h.generations[2]['seed'],h.generations[4]['seed'])
            self.assertNotEqual(h.generations[0]['seed'],core.seed_for(1,'memory_write',1))
            self.assertGreater(h.generations[0]['seed'],4_500_000_000)
            self.assertLess(h.generations[0]['seed'],4_600_000_000)
        for number in (0,1001,True):
            with self.assertRaises(ValueError):core.seed_for(number,'memory_write',1)

    def test_failure_preserves_prior_real_return_shape_and_no_pair_is_fabricated(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);h.values[4]=RuntimeError('explicit offline fourth-stage failure')
            with self.assertRaises(RuntimeError):h.run()
            report=h.summary('error');self.assertEqual(report['actualStudentGenerations'],4)
            self.assertFalse(report['completePairedReplay']);self.assertFalse(report['memoryContrastAvailable'])
            self.assertIsNone(report['sourceBoundOutcomeDifferenceWithMinusWithout'])

    def test_fixture_flags_wrong_adapter_and_log_sum_saved_raw_before_rejection(self):
        for field,value in (('fixtureOnly',True),('testDouble',True),('semanticAdapterEnabledDuringGeneration',False),
                            ('mathAdapterEnabledDuringGeneration',True),('samplingLogProbability',-.1)):
            with tempfile.TemporaryDirectory() as tmp:
                h=Harness(tmp);h.values[0]=dict(output('T1 A1 passed.'),**{field:value})
                with self.subTest(field=field),self.assertRaises(ValueError):h.run()
                self.assertEqual([k for k,r in h.saved],['raw']);self.assertEqual(h.hashes,{})
                self.assertFalse(h.summary('error')['allReturnedResponsesAudited'])

    def test_frozen_mutation_after_return_retains_raw_and_never_scores(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp)
            def frozen():
                if h.generations:raise ValueError('explicit offline frozen-state mutation')
            h.frozen_callback=frozen
            with self.assertRaises(ValueError):h.run()
            self.assertEqual([k for k,r in h.saved],['raw']);self.assertEqual(h.hashes,{})

    def test_changed_disk_memory_cannot_hide_behind_valid_cached_note(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);original=h.read
            def read():
                result=original()
                if h.reads==2:
                    (Path(tmp)/'M1.zip').write_bytes(b'changed native memory')
                    return original()
                return result
            h.read=read
            with self.assertRaises(ValueError):h.run()
            self.assertEqual(len(h.generations),2);self.assertEqual(h.measures,0)

    def test_tool_return_saved_before_bad_result_rejected_and_never_counted_executed(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp)
            h.measure=lambda *args:dict(core.execute_measurement(*args),value=.123)
            with self.assertRaises(ValueError):h.run()
            self.assertEqual(sum(k=='tool-returned' for k,r in h.saved),1)
            self.assertEqual(sum(k=='tool-executed' for k,r in h.saved),0)
            self.assertFalse(h.summary('error')['memoryContrastAvailable'])

    def test_deadlines_before_generation_memory_install_and_tool_execution_stop_dependent_work(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);h.remaining_callback=lambda:0
            with self.assertRaises(TimeoutError):h.run()
            self.assertEqual(h.generations,[]);self.assertEqual(h.saved,[])
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);h.remaining_callback=lambda:0 if h.generations else 1
            with self.assertRaises(TimeoutError):h.run()
            self.assertEqual(len(h.generations),1);self.assertEqual(h.hashes,{})
            self.assertEqual([k for k,r in h.saved],['raw','scored','memory-candidate'])
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);h.remaining_callback=lambda:0 if len(h.generations)>=4 else 1
            with self.assertRaises(TimeoutError):h.run()
            self.assertEqual(len(h.generations),4);self.assertEqual(h.measures,0)

    def test_failed_final_frozen_check_and_unscored_or_changed_raw_never_report_gain(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Harness(tmp);h.run()
            self.assertIsNone(h.summary('error')['sourceBoundOutcomeDifferenceWithMinusWithout'])
            row=next(row for k,row in h.saved if k=='raw' and row['phase']=='evaluation_review')
            row['studentOutput']['raw']='Changed after audit.'
            report=h.summary();self.assertFalse(report['allReturnedResponsesAudited'])
            self.assertFalse(report['memoryContrastAvailable']);self.assertIsNone(report['sourceBoundOutcomeDifferenceWithMinusWithout'])


class InputAndRuntimeChecks(unittest.TestCase):
    def test_partial_number_reserved_with_distinct_protocol_and_namespace(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder=root/'zip-experience-memory-partial';folder.mkdir()
            (folder/'protocol.json').write_text(json.dumps(dict(protocol=core.PROTOCOL,experimentNumber=2)))
            other=root/'zip-experience-memory-other';other.mkdir()
            (other/'protocol.json').write_text(json.dumps(dict(protocol='older-experiment',experimentNumber=100)))
            self.assertEqual(runtime.next_number(root),3)

    def test_tokenizer_preflight_reserves_real_response_and_memory_echo_without_forward(self):
        evidence,bank=evidence_fixture();fake=ModuleType('transformers');tokenizer=CounterTokenizer(100)
        fake.AutoTokenizer=SimpleNamespace(from_pretrained=lambda *a,**kw:tokenizer)
        with tempfile.TemporaryDirectory() as tmp:
            student=Path(tmp);(student/'config.json').write_text(json.dumps(dict(max_position_embeddings=4096)))
            with patch.dict(sys.modules,{'transformers':fake}):limits,preflight=runtime.prepare_inputs(student,evidence,bank,1)
            self.assertEqual(limits['maxInputTokens'],4000);self.assertEqual(limits['responseTokenReserve'],96)
            self.assertTrue(preflight['allPlannedPromptsFit']);self.assertFalse(preflight['modelWeightsLoaded'])
            self.assertEqual(preflight['actualStudentGenerations'],0)
            self.assertEqual(preflight['rows'][1]['planningEchoReserve'],576)
            self.assertTrue(all(call['truncation'] is False for call in tokenizer.calls))
            self.assertEqual(runtime.generate,original_policy.generate)

    def test_unchanged_sampler_keeps_actual_eos_and_all_token_logs_without_host_end_marker(self):
        messages=[dict(role='user',content='Explicit offline memory sampler case.')]
        value,_,audit=generated_checked_fixture(CounterTokenizer(12),messages,'experience_review',
            'T1 A1 passed. I would inspect my work.')
        self.assertEqual(value['generatedIds'][-1],0);self.assertEqual(value['stopReason'],'eos')
        self.assertEqual(len(value['samplingTokenLogProbabilities']),value['generatedTokens'])
        self.assertAlmostEqual(sum(value['samplingTokenLogProbabilities']),value['samplingLogProbability'])
        self.assertFalse(value['studentEndMarkerReached']);self.assertTrue(audit['noSilentTruncation'])

    def test_fixture_source_is_rejected_before_model_import_or_output_creation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);parent=root/'source';parent.mkdir();(parent/'result.json').write_text(json.dumps(dict(fixtureOnly=True)))
            args=SimpleNamespace(source=parent,out=root/'out',work=root,student=root/'student',old_tools=root/'tools')
            before=set(sys.modules)
            with self.assertRaises((ValueError,KeyError,FileNotFoundError)):runtime.run(args)
            self.assertFalse(args.out.exists());self.assertNotIn('torch',set(sys.modules)-before)
            self.assertNotIn('safetensors.torch',set(sys.modules)-before)

    def test_overlong_actual_input_archives_zero_calls_before_weights_load(self):
        evidence,bank=evidence_fixture()
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);parent=root/'source';student=root/'student';old_tools=root/'old-tools'
            for p in (parent/'checkpoints',student,old_tools):p.mkdir(parents=True)
            (parent/'result.json').write_text('{}')
            (parent/'source-checkpoint.json').write_text(json.dumps(dict(baseChoiceSource=str(parent))))
            (parent/'checkpoints'/'semantic.safetensors').write_bytes(b'explicit offline stub, not weights')
            (student/'config.json').write_text(json.dumps(dict(max_position_embeddings=4096)))
            source_hashes=runtime.snapshot(parent)
            resume=dict(folder=str(parent),sourceHashes=source_hashes,initialMeta={},
                result=dict(mathematicalWriterStateHash='offline-math',baseStateBefore='offline-base'),
                final=dict(semanticFile='semantic.safetensors',semanticStateHash='offline-semantic',head=evidence['head'],labels=[]))
            checked=dict(checkpoint=dict(writerStateHash='offline-math'),identity=dict(snapshotSha256={}),protected={},toolFiles={})
            fake=ModuleType('transformers');fake.AutoTokenizer=SimpleNamespace(from_pretrained=lambda *a,**kw:CounterTokenizer(4001))
            pilot=ModuleType('zip_pilot');pilot.load_student=lambda *a,**kw:(_ for _ in ()).throw(AssertionError('Weights must not load'))
            args=SimpleNamespace(source=parent,student=student,old_tools=old_tools,out=root/'zip-experience-memory-test',work=root)
            before=set(sys.modules)
            with patch.object(runtime,'inspect_source',return_value=resume),patch.object(runtime,'load_evidence',return_value=(evidence,{})), \
                 patch.object(runtime,'preflight',return_value=checked),patch.dict(sys.modules,{'transformers':fake,'zip_pilot':pilot}),redirect_stdout(io.StringIO()):
                self.assertEqual(runtime.run(args),1)
            result=json.loads((args.out/'result.json').read_text())
            self.assertEqual(result['actualStudentGenerations'],0);self.assertEqual(result['studentWrittenExperienceZips'],0)
            self.assertFalse(result['modelWeightsLoaded']);self.assertFalse(result['inputPreflightPassed'])
            self.assertEqual(result['generationAttempts'],0);self.assertNotIn('Final check:',result['error'])
            self.assertTrue((args.out/'Lain-Zip-Experience-Memory-Results.zip').is_file())
            self.assertEqual(runtime.snapshot(parent),source_hashes)
            self.assertNotIn('torch',set(sys.modules)-before);self.assertNotIn('safetensors.torch',set(sys.modules)-before)


if __name__=='__main__':unittest.main()
