"""Offline recovery and save-failure checks. No real model or optimizer steps."""
import copy
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import zipfile
import contextlib
import io
import os
import sys
from writer_check_progress import LaunchMonitor
from zip_summary_training_v9_progress import run_child
from draft_inspect_runtime import read,sha,snapshot
import zip_summary_training_v9_recovery as recovery
from zip_summary_training_v9_receipts import atomic_json,publish_partial,harvest_review,phase_receipt
import test_zip_summary_training_v8 as fixtures
from zip_summary_training_v8_core import digest,summarize
from zip_summary_training_v9_select import select_source


class RecoveryChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures.CourseChecks.setUpClass()

    def materialize(self,p):
        helper=fixtures.CourseChecks()
        out,result=helper.write_replay(p)
        for f in out['features']:
            path=p/'feature'/(f['id']+'.json');path.parent.mkdir(exist_ok=True);path.write_text(json.dumps(f))
        for kind in ('summary','management'):
            for s in (s for s in out['steps'] if s['parameterKind']==kind):
                path=p/(kind+'-step')/(s['id']+'.json');path.parent.mkdir(exist_ok=True);path.write_text(json.dumps(s))
        return out,result

    def test_train_only_reconstructs_full_bank_without_admitting_heldout(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);out,result=self.materialize(p)
            train={t['id'] for t in out['plan']['training']}
            (p/'checkpoints/final.json').unlink()
            course=recovery.replay_saved_course(p,dict(trainingRound=1),out['notes'],out['initial'],out['checkpoints'][0],
                {f['id']:f for f in out['features'] if f['task']['id'] in train},
                {r['recordId']:r for r in out['rows'] if r['task']['id'] in train},
                out['steps'],training_only=True)
            self.assertEqual(len(course['objects']),8)
            self.assertEqual(len(course['revisionFeedback']),2)
            self.assertEqual(course['history'],out['course']['history'])
            self.assertTrue(all(r['split']=='training' for r in course['history']))

    def test_train_replay_rejects_changed_credit(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);out,_=self.materialize(p);train={t['id'] for t in out['plan']['training']}
            steps=copy.deepcopy(out['steps']);steps[0]['advantages'][0]*=-1
            with self.assertRaisesRegex(ValueError,'feedback|attribution'):
                recovery.replay_saved_course(p,dict(trainingRound=1),out['notes'],out['initial'],out['checkpoints'][0],
                    {f['id']:f for f in out['features'] if f['task']['id'] in train},
                    {r['recordId']:r for r in out['rows'] if r['task']['id'] in train},steps,training_only=True)

    def test_after_eighth_training_checkpoint_can_recover_without_training_final(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);out,_=self.materialize(p);train={t['id'] for t in out['plan']['training']}
            (p/'checkpoints/training-final.json').unlink()
            course=recovery.replay_saved_course(p,dict(trainingRound=1),out['notes'],out['initial'],out['checkpoints'][0],
                {f['id']:f for f in out['features'] if f['task']['id'] in train},
                {r['recordId']:r for r in out['rows'] if r['task']['id'] in train},out['steps'],training_only=True)
            self.assertEqual(course['history'],out['course']['history'])

    def test_missing_training_step_never_unlocks_recovery(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);out,_=self.materialize(p);train={t['id'] for t in out['plan']['training']}
            with self.assertRaisesRegex(ValueError,'checkpoint step missing'):
                recovery.replay_saved_course(p,dict(trainingRound=1),out['notes'],out['initial'],out['checkpoints'][0],
                    {f['id']:f for f in out['features'] if f['task']['id'] in train},
                    {r['recordId']:r for r in out['rows'] if r['task']['id'] in train},out['steps'][1:],training_only=True)

    def test_prefix_resume_only_generates_missing_heldout_tail_without_optimizer(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);out,_=self.materialize(p)
            fullraw={r['recordId']:r for r in out['rows']}
            fixed_tasks={t['id'] for t in out['plan']['training']+out['plan']['heldout'][:2]}
            prefix=[r for r in out['rows'] if r['task']['id'] in fixed_tasks]
            # The first returned observation of the next heldout task also
            # survives; its feature has not been returned when interrupted.
            nextrow=next(r for r in out['rows'] if r['task']['id'] not in fixed_tasks)
            prefix.append(nextrow);oldids={r['recordId'] for r in prefix}
            for path in (p/'responses').glob('*.json'):
                if read(path)['recordId'] not in oldids:path.unlink()
            fullfeatures={f['id']:f for f in out['features']}
            oldfeatures={i:f for i,f in fullfeatures.items() if f['task']['id'] in fixed_tasks}
            for kind in ('feature','object','trial','decision','management-choice'):
                for path in (p/kind).glob('*.json'):
                    row=read(path)
                    if recovery.record_task_id(row) not in fixed_tasks:path.unlink()
            (p/'checkpoints/final.json').unlink()
            before={str(path.relative_to(p)):sha(path) for path in p.rglob('*') if path.is_file()}
            asked=[];forwarded=[]
            remainingraw=[r for r in out['rows'] if r['recordId'] not in oldids]
            remainingfeatures=[f for f in out['features'] if f['id'] not in oldfeatures]
            def ask(phase,messages,seed,**kw):
                row=copy.deepcopy(remainingraw.pop(0))
                self.assertEqual(row['task']['split'],'heldout')
                self.assertEqual((row['phase'],row['studentPrompt'],row['samplingSeed']),(phase,messages,seed))
                asked.append(row['recordId'])
                path=p/'responses'/(row['recordId']+'-raw.json');path.write_text(json.dumps(row))
                return row
            def feature(task,row,cards):
                f=remainingfeatures.pop(0)
                self.assertEqual(f['task']['split'],'heldout')
                self.assertEqual((f['task'],f['sourceObservationRecordId'],f['candidateCards']),(task,row['recordId'],cards))
                path=p/'feature'/(f['id']+'.json');path.write_text(json.dumps(f))
                return copy.deepcopy(f['normalizedFeatures']),f['id']
            def save(kind,row):
                self.assertNotIn(kind,('management-feedback','revision-feedback','summary'))
                path=p/'responses'/(row['recordId']+'-scored.json') if kind=='scored' else p/kind/(row['id']+'.json')
                self.assertFalse(path.exists())
                path.parent.mkdir(exist_ok=True);path.write_text(json.dumps(row));forwarded.append(kind)
            def checkpoint(label,entries,history,status):
                self.assertEqual(label,'final')
                cp=next(c for c in out['checkpoints'] if c['label']==label)
                (p/'checkpoints/final.json').write_text(json.dumps(cp))
            course=recovery.replay_saved_course(p,dict(trainingRound=1),out['notes'],out['initial'],out['checkpoints'][0],
                oldfeatures,{r['recordId']:r for r in prefix},out['steps'],
                tail=dict(ask=ask,feature=feature,save=save,checkpoint=checkpoint,deadline=time.monotonic()+60))
            self.assertEqual(course,out['course'])
            self.assertEqual(len(asked),len(out['rows'])-len(prefix))
            self.assertFalse(remainingfeatures or remainingraw)
            self.assertTrue(all(sha(p/name)==value for name,value in before.items()))
            self.assertEqual(summarize(course)['heldoutObjects'],4)

    def test_missing_result_review_contains_originals_and_committed_updates(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);out,_=self.materialize(p)
            receipt=publish_partial(p,'simulated hard kill before result')
            target=p/'review.zip';harvest_review(p,target)
            self.assertFalse(receipt['completeTrainingExperiment'])
            self.assertTrue(receipt['integrityChecksPending'])
            self.assertEqual(receipt['committedManagementStepFiles'],len([s for s in out['steps'] if s['parameterKind']=='management']))
            with zipfile.ZipFile(target) as archive:
                self.assertIn('partial-result.json',archive.namelist())
                self.assertTrue(any(n.endswith('-raw.json') for n in archive.namelist()))
                self.assertTrue(any(n.startswith('management-feedback/') for n in archive.namelist()))
                self.assertFalse(any(n.startswith('feature/') or n.endswith('.safetensors') for n in archive.namelist()))

    def test_training_receipt_precedes_heldout_and_binds_ledger(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);out,_=self.materialize(p)
            cp=next(c for c in out['checkpoints'] if c['label']=='training-final')
            bank={k:out['course'][k] for k in ('entries','history','statuses')}
            bank['head']=out['initial']['head']
            phase_receipt(p,bank,cp)
            saved=read(p/'training-bank-receipt.json')
            self.assertTrue(saved['trainingPhaseComplete'])
            self.assertFalse(saved['heldoutPhaseComplete'])
            bank['history']=bank['history'][:-1]
            with self.assertRaisesRegex(ValueError,'bank differ'):phase_receipt(p,bank,cp)

    def test_recovery_copy_preserves_original_and_archives_old_metadata(self):
        with tempfile.TemporaryDirectory() as d:
            source=Path(d)/'old';source.mkdir()
            (source/'result.json').write_text('{"partial":true}')
            (source/'responses').mkdir();(source/'responses/x-raw.json').write_text('original')
            before=snapshot(source);output=Path(d)/'new'
            recovery.clone_evidence(source,output)
            atomic_json(output/'result.json',dict(new=True))
            self.assertEqual(snapshot(source),before)
            self.assertEqual((output/'responses/x-raw.json').read_text(),'original')
            self.assertEqual(read(output/'recovery-original-metadata/old/result.json'),dict(partial=True))
            self.assertNotEqual((source/'responses/x-raw.json').stat().st_ino,(output/'responses/x-raw.json').stat().st_ino)
            atomic_json(output/'result.json',dict(secondPartial=True))
            third=Path(d)/'third';recovery.clone_evidence(output,third)
            self.assertEqual(read(third/'recovery-original-metadata/old/result.json'),dict(partial=True))
            self.assertEqual(read(third/'recovery-original-metadata/new/result.json'),dict(secondPartial=True))

    def test_selector_recovers_newest_complete_training_phase_not_old_source(self):
        with tempfile.TemporaryDirectory() as d:
            work=Path(d);base=work/'zip-summary-training-base';old=work/'zip-summary-training-interrupted'
            atomic_json(old/'source-checkpoint.json',dict(parentSource=str(base)))
            atomic_json(old/'protocol.json',dict(protocol=recovery.PROTOCOL,trainingRound=15))
            atomic_json(old/'checkpoints/after-8.json',dict(saved=True))
            self.assertEqual(select_source(work,base,old),(base,old))
            # A successful recovery now becomes the fixed continuation source.
            complete=work/'zip-summary-training-finished'
            atomic_json(complete/'result.json',dict(protocol=recovery.PROTOCOL,trainingRound=15,
                stopReason='completed',error=None,completeTrainingExperiment=True,recoveryOriginalFolder=str(old)))
            atomic_json(complete/'run-file-manifest.json',dict(files={}))
            self.assertEqual(select_source(work,base,old),(complete,None))
            # If the next training completes but its evaluation stops, recover
            # it instead of rerunning the old completed source again.
            newer=work/'zip-summary-training-next'
            atomic_json(newer/'source-checkpoint.json',dict(parentSource=str(complete)))
            atomic_json(newer/'protocol.json',dict(protocol=recovery.PROTOCOL,trainingRound=16))
            atomic_json(newer/'checkpoints/after-8.json',dict(saved=True))
            self.assertEqual(select_source(work,base,old),(complete,newer))

    def test_selector_does_not_admit_complete_result_without_committed_manifest(self):
        with tempfile.TemporaryDirectory() as d:
            work=Path(d);base=work/'base';candidate=work/'zip-summary-training-uncommitted'
            atomic_json(candidate/'result.json',dict(protocol=recovery.PROTOCOL,trainingRound=1,
                stopReason='completed',error=None,completeTrainingExperiment=True))
            self.assertEqual(select_source(work,base,work/'missing'),(base,None))

    def test_fixture_rejected_before_parent_or_model_import(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)
            atomic_json(p/'protocol.json',dict(protocol=recovery.PROTOCOL,teacherCalls=0))
            atomic_json(p/'responses/management-call-001-raw.json',dict(recordId='management-call-001',
                fixtureOnly=True,studentOutput=dict(testDouble=True)))
            with patch('zip_summary_training_v8_inspect.inspect_training_source',side_effect=AssertionError('must not read parent')):
                with self.assertRaisesRegex(ValueError,'Fixture'):recovery.inspect_interrupted_course(p)

    def test_parent_termination_allows_receipt_before_slow_final_checks(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)
            code="""import signal,sys,time,json
from pathlib import Path
p=Path(sys.argv[1])
def stop(*args):
    from zip_summary_training_v9_receipts import publish_partial,harvest_review
    publish_partial(p,'simulated compute timeout')
    harvest_review(p,p/'review.zip')
    time.sleep(.3)
    (p/'final-check-finished.json').write_text('{"saved":true}')
    raise SystemExit(0)
signal.signal(signal.SIGTERM,stop)
(p/'responses').mkdir()
(p/'responses/actual-raw.json').write_text('{"raw":"unchanged original"}')
while True:time.sleep(.05)
"""
            monitor=LaunchMonitor(total_seconds=2)
            with contextlib.redirect_stdout(io.StringIO()):
                result=run_child([sys.executable,'-c',code,str(p)],dict(os.environ),monitor)
            self.assertTrue(result['parentTotalBudgetReached'])
            self.assertEqual(result['exitCode'],0)
            self.assertEqual(read(p/'partial-result.json')['actualSavedRawResponses'],1)
            self.assertTrue((p/'final-check-finished.json').is_file())
            with zipfile.ZipFile(p/'review.zip') as archive:
                self.assertIn('responses/actual-raw.json',archive.namelist())


if __name__=='__main__':unittest.main()
