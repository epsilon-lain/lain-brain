"""Meaningful offline pairing, freeze, failure and provenance checks."""
import copy
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from object_choice_core import ChoiceHead, normalized_features
from zip_guided_helpers import application
from writer_check_core import write_once
from test_zip_label import roots_fixture, response
from zip_label_grounded_core import version_label, seed_for
from zip_label_grounded_checks import feature_messages
from zip_semantic_generation import NATURAL_LANGUAGE
import zip_label_compare_core as core


class FrozenComparisonChecks(unittest.TestCase):
    def setUp(self):
        self.roots=roots_fixture();self.tasks=core.fresh_tasks(set(),self.roots)
        def state(prefix,weights):
            labels={r['id']:version_label(r,dict(recordId='fixture-'+prefix+r['id'],phase='initial_zip_label',
                studentOutput=response(prefix+' student authored note.')),language_protocol=NATURAL_LANGUAGE)
                for r in self.roots}
            return dict(head=ChoiceHead(weights).state(),labels=labels)
        self.before=state('before',[.4,-.1]);self.a=state('a',[.8,-.3]);self.b=state('b',[-.2,.8])

    def exercise(self,all_failed=False,deadline=None,fail_math=False,mutate=False):
        saved={k:[] for k in ('raw','scored','feature','decision','trial','instance','failure','object')}
        current=['branch_a'];calls=[];original=copy.deepcopy((self.roots,self.before,self.a,self.b))
        def save(kind,row):saved[kind].append(copy.deepcopy(row))
        def frozen():self.assertEqual((self.roots,self.before,self.a,self.b),original)
        def select(mode):current[0]=mode;frozen()
        def ask(phase,prompt,seed,*,mode,sampled=False,**context):
            self.assertFalse(sampled);task=context['task'];calls.append((phase,current[0],seed))
            text='Fixture student '+current[0]+' observation.'
            if phase=='comparison_route_math':
                self.assertEqual(sum(d['task']['id']==task['id'] for d in saved['decision']),15)
                self.assertTrue(context['hostSpecifiedRoute']);self.assertFalse(context['autonomousToolUseClaimed'])
                candidate=context['selectedCandidate']
                applied=application(candidate['root'],task['expression']) if candidate['kind']!='direct' else None
                text=task['expression']+' = '+applied['output_text'] if applied and not all_failed else 'SKIP'
            row=dict(recordId='fixture-compare-'+str(len(calls)),phase=phase,studentPrompt=copy.deepcopy(prompt),
                studentOutput=response(text),samplingSeed=seed,fixtureOnly=True,**context)
            save('raw',row)
            if fail_math and phase=='comparison_route_math':raise RuntimeError('fixture stops after original saved')
            return row
        def features(task,words,candidates):
            row=dict(id='fixture-feature-'+str(len(saved['feature'])),task=copy.deepcopy(task),
                sourceKeywordRecordId=words['recordId'],candidateCards=copy.deepcopy(candidates),
                candidatePrompts=[feature_messages(task,words['studentOutput'],c) for c in candidates])
            save('feature',row)
            if mutate:self.a['head']['weights'][0]+=1
            return normalized_features([[1.,.1],[.1,1.],[-1.,-1.]]),row['id']
        run=lambda:core.run_comparison(self.tasks,self.roots,self.before,self.a,self.b,ask,features,save,
            select,frozen,time.monotonic()+30 if deadline is None else deadline,1)
        if fail_math:
            with self.assertRaisesRegex(RuntimeError,'original saved'):run()
            objects=[]
        elif deadline is not None:
            with self.assertRaises(TimeoutError):run()
            objects=[]
        elif mutate:
            with self.assertRaises(AssertionError):run()
            objects=[]
        else:objects=run();frozen()
        return dict(saved=saved,calls=calls,objects=objects)

    def test_five_arms_frozen_budget_and_all_fifteen_choices_precede_routes(self):
        e=self.exercise()
        self.assertEqual(len(e['calls']),48) # Plus eight cold replays in runtime.
        self.assertEqual(len(e['saved']['feature']),40)
        self.assertEqual(len(e['saved']['decision']),120)
        self.assertEqual(len(e['saved']['trial']),120)
        self.assertEqual(len(e['objects']),8)
        self.assertTrue(all(o['trainingUpdates']==o['newLabelRevisions']==0 for o in e['objects']))
        self.assertTrue(all(r['fixtureOnly'] for r in e['saved']['raw']))

    def test_two_ablations_reuse_their_own_observation_head_uniform_and_only_change_cards(self):
        e=self.exercise();fields={f['id']:f for f in e['saved']['feature']}
        for task in self.tasks:
            rows=[d for d in e['saved']['decision'] if d['task']['id']==task['id']]
            for seed in (1,2,3):
                ds={d['arm']:d for d in rows if d['seedIndex']==seed}
                self.assertEqual(len({d['policyOutput']['sharedUniformSample'] for d in ds.values()}),1)
                for a,b in ((core.ARMS[0],core.ARMS[3]),(core.ARMS[1],core.ARMS[4])):
                    self.assertEqual(ds[a]['sourceKeywordRecordId'],ds[b]['sourceKeywordRecordId'])
                    self.assertEqual(ds[a]['policyOutput']['parameterHash'],ds[b]['policyOutput']['parameterHash'])
                    self.assertNotEqual(fields[ds[a]['sourceFeatureRecordId']]['candidateCards'],
                        fields[ds[b]['sourceFeatureRecordId']]['candidateCards'])
                self.assertEqual(len({ds[a]['sourceKeywordRecordId'] for a in core.ARMS[:3]}),3)

    def test_three_actual_route_originals_are_shared_by_all_arms_and_seeds(self):
        e=self.exercise();scored={r['recordId']:r for r in e['saved']['scored']}
        for obj in e['objects']:
            self.assertEqual(len(obj['sourceMathRecordIds']),3)
            rows=[t for t in e['saved']['trial'] if t['taskId']==obj['id']]
            self.assertTrue(all(t['sourceMathRecordId'] in obj['sourceMathRecordIds'] for t in rows))
            self.assertTrue(all(t['outcomePassed']==scored[t['sourceMathRecordId']]['check']['outcomePassed'] for t in rows))
        summary=core.comparison_summary(e['objects'],e['saved']['trial'])
        self.assertEqual(summary['uniqueNewObjects'],8)
        self.assertEqual(summary['heldoutByFamily']['same_factor']['objects'],4)
        self.assertTrue(all(v['trials']==24 for v in summary['sampledHeldoutOutcomesByArm'].values()))
        self.assertFalse(summary['checkpointsSelectedByHeldout'])

    def test_all_failed_routes_keep_failures_and_all_primary_probabilities_zero(self):
        e=self.exercise(all_failed=True);self.assertEqual(len(e['saved']['failure']),24)
        s=core.comparison_summary(e['objects'],e['saved']['trial'])
        self.assertTrue(all(v==0 for v in s['heldout']['expectedPassByArm'].values()))
        self.assertTrue(all(v==0 for v in s['heldout']['meanPairedDifferences'].values()))

    def test_signed_paired_metric_uses_all_successful_routes_not_sampled_passes(self):
        e=self.exercise();obj=copy.deepcopy(e['objects'][0])
        obj['routeOutcomes']=[1,1,0]
        for a in core.ARMS:obj['expectedPassByArm'][a]=sum(obj['probabilitiesByArm'][a][:2])
        obj['pairedDifferences']={k:obj['expectedPassByArm'][a]-obj['expectedPassByArm'][b]
            for k,(a,b) in core.COMPARISONS.items()}
        s=core.comparison_summary([obj],[])
        self.assertAlmostEqual(s['heldout']['meanPairedDifferences']['9024865b_minus_47624235'],
            obj['expectedPassByArm'][core.ARMS[1]]-obj['expectedPassByArm'][core.ARMS[0]])
        self.assertTrue(all(v['trials']==0 for v in s['sampledHeldoutOutcomesByArm'].values()))

    def test_deadline_and_failure_do_not_fabricate_completed_objects(self):
        self.assertEqual(self.exercise(deadline=time.monotonic()-1)['calls'],[])
        e=self.exercise(fail_math=True)
        self.assertEqual(len(e['saved']['object']),0)
        self.assertEqual(e['saved']['raw'][-1]['phase'],'comparison_route_math')
        s=core.comparison_summary([],e['saved']['trial'])
        self.assertIsNone(s['heldout']['meanPairedDifferences']['9024865b_minus_47624235'])

    def test_mutating_a_frozen_checkpoint_is_detected(self):self.exercise(mutate=True)

    def test_new_tasks_and_namespace_do_not_reuse_training_or_prior_comparison_seeds(self):
        keys={t['semanticInputKey'] for t in self.tasks}
        more=core.fresh_tasks(keys,self.roots)
        self.assertFalse(keys & {t['semanticInputKey'] for t in more})
        old={seed_for(5,n,s) for n in range(13) for s in range(100)}
        a={core.seed_for_comparison(1,n,s) for n in range(1,9) for s in (1,20,51,52,53)}
        b={core.seed_for_comparison(2,n,s) for n in range(1,9) for s in (1,20,51,52,53)}
        self.assertFalse(a & b);self.assertFalse(a & old)

    def test_prompts_end_in_current_object_and_have_no_manual_family_tags(self):
        e=self.exercise()
        for f in e['saved']['feature']:
            self.assertTrue(all(c['tags']==[] for c in f['candidateCards']))
            self.assertTrue(all(p[-1]['content'].endswith(f['task']['expression']) for p in f['candidatePrompts']))

    def test_fixtures_and_wrong_source_order_rejected_before_source_or_model_import(self):
        from zip_label_compare_run import checked_pair
        with tempfile.TemporaryDirectory() as tmp:
            a,b=Path(tmp)/'a',Path(tmp)/'b';a.mkdir();b.mkdir()
            for p in (a,b):write_once(p/'result.json',dict(protocol='fixture',fixtureOnly=True))
            with patch('zip_label_compare_run.source_runtime.inspect_iteration',side_effect=AssertionError('should not inspect')):
                with self.assertRaisesRegex(ValueError,'pinned'):checked_pair(a,b)
        self.assertNotIn('torch',sys.modules)

    def test_partial_comparison_reserves_its_number(self):
        from zip_label_compare_run import retest_number
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp)/'zip-label-frozen-compare-partial';folder.mkdir()
            write_once(folder/'protocol.json',dict(protocol=core.PROTOCOL,comparisonNumber=1))
            self.assertEqual(retest_number(tmp),2)

    def test_partial_trials_without_completed_object_are_not_counted(self):
        e=self.exercise();s=core.comparison_summary(e['objects'][:1],e['saved']['trial'])
        self.assertTrue(all(v['trials']==3 for v in s['sampledHeldoutOutcomesByArm'].values()))


if __name__=='__main__':unittest.main(verbosity=2)
