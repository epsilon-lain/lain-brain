"""Offline protocol simulations. These never count as real student training."""
import copy
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from object_choice_core import ChoiceHead
from test_zip_summary_training_v2 import roots
import test_zip_summary_training_v6 as old
import zip_summary_training_v7_core as core
import zip_summary_training_v7_scope as scope
import zip_summary_training_v7_run as runtime
import zip_summary_training_v7_inspect as inspector
import zip_summary_training_v7_series as series


class CourseChecks(unittest.TestCase):
    def fixture_run(self,**kw):
        with patch.object(old,'core',core),patch.object(old,'make_plan',scope.make_plan):
            return old.CourseChecks.fixture_run(self,**kw)

    def complete(self,**kw):
        out=self.fixture_run(**kw);self.assertNotIn('error',out,repr(out.get('error')))
        return out

    def write_replay(self,folder):
        out=self.complete()
        def put(relative,row):
            p=folder/relative;p.parent.mkdir(parents=True,exist_ok=True)
            p.write_text(json.dumps(row,ensure_ascii=False))
        put('zip-summary-questions.json',out['plan']);put('roots.json',roots())
        for row in out['rows']:put('responses/'+row['recordId']+'-raw.json',row)
        for kind,row in out['saved']:
            put('responses/'+row['recordId']+'-scored.json' if kind=='scored' else kind+'/'+row['id']+'.json',row)
        for cp in out['checkpoints']:put('checkpoints/'+cp['label']+'.json',cp)
        course=out['course'];readers=course['readerTraining']
        reader_updates=sum(r['updates']['note']['updated']+r['updates']['control']['updated'] for r in readers)
        report=core.summarize(course['objects'],[r for k,r in out['saved'] if k=='trial'],course['summaries'],
            course['updates'],course['groupResults'],course['ratings'],course['references'],course['retentionReviews'])
        report.update(curriculumStage=1,actualReaderCalibrationRecords=len(readers),actualReaderHeadUpdates=reader_updates)
        result=dict(trainingRound=1,curriculumStage=1,readerCalibrationRecords=len(readers),
            readerHeadTrainingUpdates=reader_updates,summary=report,fixtureOnly=True,offlineFixtureFactory=True)
        return out,result

    def replay(self,folder,out,result):
        return inspector.replay_saved_course(folder,result,out['notes'],out['checkpoints'][0],out['checkpoints'][-1],
            {f['id']:f for f in out['features']},{r['recordId']:r for r in out['rows']},out['steps'])

    def test_full_course_trains_readers_and_words_then_freezes_seven_paired_arms(self):
        out=self.complete();c=out['course']
        self.assertEqual(len(c['summaries']),12);self.assertEqual(len(c['readerTraining']),12)
        self.assertEqual(len(out['learns']),4);self.assertTrue(c['heldoutStateUnchanged'])
        self.assertLessEqual(len(out['rows'])+8,core.MAX_GENERATIONS)
        self.assertLessEqual(len(out['features'])+4,core.MAX_FEATURE_BATCHES)
        self.assertTrue(all(s['policyUpdate']['constantTokenDenominator']==384 for s in out['steps']))
        for obj in c['objects']:
            positions=[i for i,(k,r) in enumerate(out['saved']) if k=='decision' and r['task']['id']==obj['id']]
            routes=[i for i,(k,r) in enumerate(out['saved']) if k=='scored' and r['phase']=='route_math' and r['task']['id']==obj['id']]
            self.assertLess(max(positions),min(routes))
            if obj['phase']=='heldout':
                self.assertEqual(len(positions),21);self.assertEqual(len(obj['expectedPassByArm']),7)
                self.assertEqual(obj['trainingUpdates'],0)

    def test_related_gain_is_not_cancelled_by_forced_unrelated_reuse(self):
        out=self.complete(mixed=True)
        credits=[c for g in out['course']['groupResults'] for c in g['candidateCredits'].values()]
        good=[c for c in credits if c['eligibleForRetention'] and c['ungatedValidationMean']<0]
        self.assertTrue(good,'The fixture must exercise positive local and negative forced global effects')
        for c in good:
            self.assertGreater(c['relatedValidationGain'],0);self.assertEqual(c['outsideScopePolicyGain'],0)
            self.assertGreater(c['sameReaderSummaryGain'],0)
        selected=[g for g in out['course']['groupResults'] if g['selectedSummaryZipId']]
        self.assertTrue(selected);self.assertTrue(any(a>0 for g in selected for a in g['batchAdvantages']))

    def test_calibration_is_excluded_and_readers_use_equal_initial_states(self):
        out=self.complete()
        for reader in out['course']['readerTraining']:
            self.assertEqual(reader['calibrationCase']['task']['curriculumRole'],'reader_calibration')
            self.assertEqual(reader['updates']['note']['beforeHash'],reader['updates']['control']['beforeHash'])
            self.assertFalse(reader['heldoutEnteredReaderTraining']);self.assertFalse(reader['validationOutcomesEnteredReaderTraining'])
        for g in out['course']['groupResults']:
            for c in g['candidateCredits'].values():
                calibration,val,guard=c['measurements']
                self.assertAlmostEqual(c['signedFullReuseGain'],(val['signedFullReuseGain']+guard['signedFullReuseGain'])/2)
                self.assertTrue(c['calibrationExcludedFromWordReward'])

    def test_reader_learning_without_note_benefit_cannot_reward_words(self):
        out=self.complete();n=next(iter(out['notes'].values()))
        original=next(r for r in out['course']['readerTraining'] if r['summaryZipId']==n['id'])
        case=copy.deepcopy(original['calibrationCase']);case['withSummary']=copy.deepcopy(case['without'])
        reader=scope.fit_reader(n,case,original['beforeState'])
        self.assertEqual(reader['heads']['note'],reader['heads']['control'])
        source=next(c for g in out['course']['groupResults'] for i,c in g['candidateCredits'].items() if i==n['id'])
        cases=[copy.deepcopy(m['case']) for m in source['measurements']]
        for case in cases:case['withSummary']=copy.deepcopy(case['without'])
        measurements=[scope.measure(n,case,reader,original['beforeState']) for case in cases]
        c=core.aggregate_credit(n,measurements)
        self.assertEqual(c['sameReaderSummaryGain'],0);self.assertFalse(c['eligibleForRetention'])

    def test_bad_and_invalid_notes_do_not_enter_ordinary_head_replay(self):
        for kw in (dict(all_bad=True),dict(invalid=True),dict(all_failed=True)):
            out=self.complete(**kw)
            self.assertTrue(all(g['selectedSummaryZipId'] is None for g in out['course']['groupResults']))
            self.assertTrue(all(a<=0 for cr in out['learns'] for a in cr['batchAdvantages']))
            self.assertEqual(out['course']['finalBanks'],{b:[] for b in core.BRANCHES})
            for u in out['course']['updates']:
                self.assertTrue(u['candidateWasIsolatedFromOperativeReplay'])
        self.assertEqual(len(self.complete(invalid=True)['course']['readerTraining']),0)

    def test_multiple_scoped_notes_can_survive_without_cross_scope_forcing(self):
        out=self.complete();gates=out['course']['finalGates'][core.BRANCHES[0]]
        self.assertGreaterEqual(len(gates['entries']),2)
        for task in out['plan']['heldout']:
            decision=core.context_decision(task,None,gates);self.assertFalse(decision['currentOutcomeRead'])
            n=out['notes'][decision['selectedSummaryZipId']]
            self.assertEqual(n['event']['task']['family'],task['family'])
        self.assertFalse(gates['studentAutonomousRetrieval'])

    def test_continuation_with_existing_notes_fits_actual_generation_and_feature_caps(self):
        prior=self.complete();run=core.run_course
        excluded={t['semanticInputKey'] for t in prior['plan']['training']+prior['plan']['heldout']}
        def continued(*args,**kw):
            args=list(args)
            for n in prior['notes'].values():args[8](n)
            args[2]=prior['course']['finalHeads'];args[12]=2
            return run(*args,initial_banks=prior['course']['finalBanks'],initial_gates=prior['course']['finalGates'])
        with patch.object(old,'core',core),patch.object(old,'make_plan',lambda ex,rr:scope.make_plan(excluded|ex,rr,2)),\
                patch.object(core,'run_course',side_effect=continued):
            out=old.CourseChecks.fixture_run(self)
        self.assertNotIn('error',out,repr(out.get('error')))
        self.assertLessEqual(len(out['rows'])+8,core.MAX_GENERATIONS)
        self.assertLessEqual(len(out['features']),core.MAX_FEATURE_BATCHES)
        self.assertTrue(out['course']['heldoutStateUnchanged'])

    def test_changed_reader_validation_claim_or_heldout_evidence_is_rejected(self):
        out=self.complete();n=next(iter(out['notes'].values()))
        c=next(c for g in out['course']['groupResults'] for i,c in g['candidateCredits'].items() if i==n['id'])
        for field in ('heads','scopeShapes'):
            row=copy.deepcopy(c['measurements'][0]['readerTraining'])
            if field=='heads':row[field]['note']['weights'][0]+=.01
            else:row[field]=['changed']
            with self.assertRaises(ValueError):scope.validate_reader(n,row)
        for mode in ('number','heldout','role'):
            ms=copy.deepcopy(c['measurements'])
            if mode=='number':ms[1]['signedFullReuseGain']+=.1
            elif mode=='heldout':ms[1]['case']['task']['split']='heldout'
            else:ms[1]['curriculumRole']='reader_calibration'
            with self.assertRaises(ValueError):core.aggregate_credit(n,ms)

    def test_complete_saved_algorithm_replay_and_changed_optimizer_credit_detection(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp);out,result=self.write_replay(p);replayed=self.replay(p,out,result)
            self.assertEqual(replayed['finalBanks'],out['course']['finalBanks'])
            path=next((p/'group-result').glob('*.json'));row=json.loads(path.read_text())
            row['batchAdvantages'][0]+=.01;path.write_text(json.dumps(row))
            with self.assertRaises(ValueError):self.replay(p,out,result)

    def test_changed_saved_reader_record_fails_replay(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp);out,result=self.write_replay(p)
            path=next((p/'reader-training').glob('*.json'));row=json.loads(path.read_text())
            row['heads']['note']['weights'][0]+=.01;path.write_text(json.dumps(row))
            with self.assertRaises(ValueError):self.replay(p,out,result)

    def test_deadline_and_failed_generation_preserve_actual_originals(self):
        out=self.fixture_run(deadline=time.monotonic()-1);self.assertIsInstance(out['error'],TimeoutError)
        self.assertEqual(out['rows'],[])
        out=self.fixture_run(fail_at=4);self.assertIsInstance(out['error'],RuntimeError)
        self.assertEqual(len(out['rows']),4);self.assertEqual(out['learns'],[])

    def test_native_zip_retains_original_and_detects_changed_bytes(self):
        n=next(iter(self.complete()['notes'].values()))
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp);hashes={n['id']:runtime.write_summary_zip(p,n)}
            self.assertEqual(runtime.read_summary_zip(p,n['id'],hashes),n)
            path=p/(n['id']+'.zip');path.write_bytes(path.read_bytes()+b'changed')
            with self.assertRaises(ValueError):runtime.read_summary_zip(p,n['id'],hashes)


class ProtocolChecks(unittest.TestCase):
    def test_three_stages_keep_fresh_inputs_and_separate_calibration(self):
        seen=set()
        for stage in (1,2,3):
            plan=scope.make_plan(seen,roots(),stage);scope.validate_plan(plan)
            keys={t['semanticInputKey'] for t in plan['training']+plan['heldout']}
            self.assertFalse(keys&seen);seen.update(keys)
            self.assertEqual(len(keys),12)
            self.assertFalse(plan['structuralGeneralizationProved'])
        self.assertIn('w',scope.make_plan(set(),roots(),2)['training'][1]['expression'])
        self.assertIn('+',scope.make_plan(set(),roots(),3)['training'][1]['expression'])

    def test_ast_scope_abstracts_numbers_names_but_preserves_structure(self):
        self.assertEqual(scope.expression_shape('3 * (5 * v + 34)'),scope.expression_shape('4 * (6 * w + 37)'))
        self.assertNotEqual(scope.expression_shape('v + v'),scope.expression_shape('v + w'))
        self.assertNotEqual(scope.expression_shape('3 * (5 * v + 34)'),scope.expression_shape('1 * (7 * v) + 2 * (7 * v)'))

    def test_new_seed_namespace_and_partial_rounds_are_reserved(self):
        self.assertGreater(core.seed_for(1,0,0),old.core.seed_for(1000,20,99))
        with tempfile.TemporaryDirectory() as temp:
            for version in (6,7):
                p=Path(temp)/('zip-summary-training-simulated-'+str(version));p.mkdir()
                (p/'protocol.json').write_text(json.dumps(dict(protocol='lain-zip-experience-summary-training-v'+str(version),trainingRound=version)))
            self.assertEqual(runtime.next_number(temp),8)

    def test_fixture_source_cannot_import_model_or_start_training(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp);(p/'result.json').write_text(json.dumps(dict(fixtureOnly=True)))
            with self.assertRaisesRegex(ValueError,'Fixture'):runtime.inspect_training_source(p)

    def test_source_migration_keeps_old_weights_and_archives_but_requires_new_reader(self):
        prior=dict(initialHeads={b:ChoiceHead([.1,.2]).state() for b in core.BRANCHES},
            initialBanks={b:None for b in core.BRANCHES},initialGates={b:None for b in core.BRANCHES},
            inherited={'old-note':{'studentRaw':'old original'}},summaryStateHashes={b:'saved-writer-'+b for b in core.BRANCHES},
            inheritedContextReviews={})
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp);(p/'result.json').write_text(json.dumps(dict(protocol=old.core.PROTOCOL,fixtureOnly=False)))
            with patch.object(inspector,'inspect_previous_source',return_value=copy.deepcopy(prior)):
                resumed=inspector.inspect_training_source(p)
        for k in ('initialHeads','summaryStateHashes','inherited'):self.assertEqual(resumed[k],prior[k])
        self.assertEqual(resumed['curriculumStage'],0);self.assertEqual(resumed['initialBanks'],{b:[] for b in core.BRANCHES})

    def test_series_recipe_discloses_assistance_and_separate_budget(self):
        fixed=series.recipe('test',3)
        self.assertEqual(fixed['trainingObjectsPerRound'],8);self.assertEqual(fixed['maximumGenerationsPerRound'],120)
        self.assertEqual(fixed['isolatedReaderStepCapPerRound'],24)
        self.assertTrue(fixed['readerCalibrationExcludedFromWordReward']);self.assertFalse(fixed['nextSourceChosenByHeldoutScore'])
        with tempfile.TemporaryDirectory() as temp:
            out=series.run_series(temp,temp,Path(temp)/'series',fixed,lambda *a: self.fail('expired deadline called'),time.monotonic()-1)
            self.assertEqual(out['report']['completedRounds'],0);self.assertEqual(out['report']['actualTrainingUpdates'],0)

class SeriesChecks(unittest.TestCase):
    def metadata(self,folder,parent,stage=1):
        # Metadata simulation ONLY; full source inspection still requires all
        # actual originals, token logs, cold replay and model checkpoint bytes.
        folder.mkdir();parent.mkdir(exist_ok=True)
        (parent/'result.json').write_text(json.dumps(dict(curriculumStage=stage-1)))
        plan=scope.make_plan(set(),roots(),stage)
        means={a:.4 for a in core.EVALUATION_ARMS}
        result=dict(protocol=core.PROTOCOL,curriculumStage=stage,fixtureOnly=False,fixtureGenerations=0,teacherCalls=0,
            stopReason='completed',error=None,completeTrainingExperiment=True,
            completedTrainingObjects=8,completedHeldoutObjects=4,coldReproductions=8,
            actualStudentGenerations=120,studentWrittenSummaryZips=12,summaryOptimizerUpdates=4,
            readerHeadTrainingUpdates=24,readerCalibrationRecords=12,trainingUpdates=44,summary=dict(expectedPassByArm=means),
            **{k:True for k in ('baseWeightsUnchanged','mathematicalWriterUnchanged','originalSemanticWriterUnchanged',
                'originalFilesUnchanged','heldoutLearnedStateUnchanged')})
        protocol=dict(protocol=core.PROTOCOL,curriculumStage=stage,maximumSummaryTokens=128,summaryMaximumWords=40,
            summaryAuditProtocol='selected-experience-literal-audit-v6',summaryPromptContainsOnlySelectedAction=True,
            maximumReaderHeadUpdates=24,readerCalibrationExcludedFromWordReward=True)
        for name,row in (('result.json',result),('protocol.json',protocol),('zip-summary-questions.json',plan),
                ('source-checkpoint.json',dict(parentSource=str(parent)))):
            (folder/name).write_text(json.dumps(row))
        (folder/'object').mkdir()
        for task in plan['heldout']:
            row=dict(id=task['id'],phase='heldout',trainingUpdates=0,allChoicesSavedBeforeRoutes=True,
                routeOutcomes=[0,1,0],probabilitiesByArm={a:[.3,.4,.3] for a in core.EVALUATION_ARMS},expectedPassByArm=means)
            (folder/'object'/(task['id']+'.json')).write_text(json.dumps(row))

    def test_complete_metadata_requires_all_seven_arms_and_next_fixed_stage(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);p=root/'simulated';parent=root/'simulated-parent';self.metadata(p,parent)
            result,held,cp=series.validate_round(p,parent,series.recipe('fixture',3),set())
            self.assertEqual(len(held),4);self.assertEqual(result['curriculumStage'],1)
            (parent/'result.json').write_text(json.dumps(dict(curriculumStage=1)))
            with self.assertRaisesRegex(ValueError,'curriculum'):series.validate_round(p,parent,series.recipe('fixture',3),set())

    def test_changed_budget_probability_and_reused_inputs_stop_continuation(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);p=root/'simulated';parent=root/'simulated-parent';self.metadata(p,parent)
            fixed=series.recipe('fixture',3);seen=set();series.validate_round(p,parent,fixed,seen)
            with self.assertRaisesRegex(ValueError,'reused'):series.validate_round(p,parent,fixed,seen)
            path=p/'result.json';original=json.loads(path.read_text());changed=copy.deepcopy(original)
            changed['readerHeadTrainingUpdates']=25;path.write_text(json.dumps(changed))
            with self.assertRaisesRegex(ValueError,'update counts'):series.validate_round(p,parent,fixed,set())
            path.write_text(json.dumps(original));held=next((p/'object').glob('*.json'));row=json.loads(held.read_text())
            row['expectedPassByArm'][core.EVALUATION_ARMS[5]]=.5;held.write_text(json.dumps(row))
            with self.assertRaisesRegex(ValueError,'probability'):series.validate_round(p,parent,fixed,set())


if __name__=='__main__':unittest.main()
