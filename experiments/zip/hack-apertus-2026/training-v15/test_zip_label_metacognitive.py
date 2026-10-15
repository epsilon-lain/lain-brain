"""Offline fixtures only; never student results, model training or teachers."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from types import ModuleType,SimpleNamespace
from contextlib import nullcontext

from test_zip_label import roots_fixture,response
from zip_guided_helpers import application
from object_choice_core import normalized_features
from zip_content_core import digest
import zip_label_metacognitive_checks as checks
import zip_label_metacognitive_core as core
import zip_label_metacognitive_policy as policy
import zip_label_metacognitive_run as runtime
import zip_label_metacognitive_source as source
from choice_continue_core import make_plan
from zip_label_grounded_checks import feature_messages

def original(raw,task,number=1,capped=False):
    return dict(recordId='explicit-meta-fixture-'+str(number),phase='training_observations',task=task,
        studentOutput=response(raw,sampled=True,capped=capped),fixtureOnly=True)

class MetacognitiveChecks(unittest.TestCase):
    def setUp(self):
        self.roots=roots_fixture();self.task=dict(id='fixture-task',expression='1*(142*v)+2*(142*v)',split='training')

    def test_actual_prefixed_false_chain_is_negative_and_original_never_repaired(self):
        raw='The current object is 1 * (142 * v) + 2 * (142 * v) = 1 * (142v) + 2 * (142v) = 144v + 284v = 338v.'
        row=original(raw,self.task);before=copy.deepcopy(row)
        audit=checks.fact_audit(row['studentOutput'],self.task)
        self.assertEqual(audit['status'],'rejected');self.assertFalse(audit['positiveCreditEligible'])
        self.assertEqual(checks.word_credit(row,audit,.9),-1.);self.assertEqual(row,before)
        self.assertEqual(len(audit['literalAssertions']['links']),3)
        self.assertFalse(audit['originalTextRepaired']);self.assertFalse(audit['missingMathematicsFilled'])

    def test_complete_prefix_links_before_missing_tail_are_diagnostic_only(self):
        for raw,status in [('The current object is v=2*v=','rejected'),('The current object is v=v=','pending')]:
            audit=checks.fact_audit(response(raw),dict(expression='v'))
            self.assertEqual(audit['status'],status);self.assertFalse(audit['positiveCreditEligible'])
            self.assertEqual(len(audit['literalAssertions']['links']),1)
            self.assertFalse(audit['literalAssertions']['completeCoverage'])

    def test_matrix_placeholder_unknown_and_capped_prose_get_zero_positive_credit(self):
        for raw,cap in [('A 3 by 3 matrix with integer entries.',False),('Storage placeholder used {WrittenEqualityTrue}.',False),
            ('The current object is '+self.task['expression']+'.',True),('sin(v)=v.',False)]:
            row=original(raw,self.task,capped=cap);audit=checks.fact_audit(row['studentOutput'],self.task)
            self.assertEqual(audit['status'],'pending');self.assertEqual(checks.word_credit(row,audit,1.),0.)

    def test_grounded_literal_is_bounded_verified_but_cancelled_outside_variable_is_rejected(self):
        task=dict(expression='v',split='training')
        good=checks.fact_audit(response('The current object is v.'),task)
        self.assertTrue(good['positiveCreditEligible']);self.assertFalse(good['wholeNaturalLanguageCertified'])
        for raw in ('v+w-w.','2*v.','3*(4*v+20)=3*4*v+3*20.'):
            self.assertEqual(checks.fact_audit(response(raw),task)['status'],'rejected')

    def frame(self):
        obs=original('The current object is v.',dict(id='f',expression='v',split='training'))
        item=core.measured_item(obs['task'],obs,[[0.],[1.],[-1.]],'explicit-feature',[0,1,0],['m1','m2','m3'])
        return checks.metric_frame([item],checks.StableHead([.5]),'explicit-training-frame'),item

    def test_metric_frame_has_real_training_evidence_and_rejects_heldout(self):
        frame,item=self.frame();self.assertEqual(frame['trainingObjects'],1)
        self.assertFalse(frame['heldoutIncluded']);self.assertEqual(frame['evidence'][0]['mathRecordIds'],['m1','m2','m3'])
        item['task']['split']='heldout'
        with self.assertRaisesRegex(ValueError,'Heldout'):checks.metric_frame([item],checks.StableHead([.5]),'bad')

    def test_numeric_self_claim_verified_without_certifying_question_or_plan(self):
        frame,_=self.frame();claim=dict(question='Why do I repeat one method?',metric='top_choice_concentration',value=1.,
            plan='Compare my observations before choosing.')
        audit=checks.meta_audit(response(json.dumps(claim)),frame)
        self.assertTrue(audit['accepted']);self.assertTrue(audit['questionAndPlanAreUntestedStudentHypotheses'])
        self.assertFalse(audit['wholeNaturalLanguageCertified']);self.assertFalse(audit['targetQuestionSupplied'])

    def test_false_numeric_duplicate_keys_false_math_extra_fields_and_caps_never_activate(self):
        frame,_=self.frame()
        base=dict(question='My own question?',metric='top_choice_concentration',value=.5,plan='Test a plan.')
        self.assertEqual(checks.meta_audit(response(json.dumps(base)),frame)['status'],'rejected')
        base['value']=1.;base['plan']='v=2*v.'
        self.assertEqual(checks.meta_audit(response(json.dumps(base)),frame)['status'],'rejected')
        for raw,cap in [('{"metric":"x","metric":"y"}',False),(json.dumps(dict(base,extra='x')),False),
            (json.dumps(dict(base,plan='Test a plan.')),True),('{"question":',False)]:
            self.assertFalse(checks.meta_audit(response(raw,capped=cap),frame)['accepted'])

    def test_student_chooses_question_no_predefined_weakness_or_family_in_prompt(self):
        frame,_=self.frame();prompt=checks.meta_messages(frame)
        self.assertNotIn('evidence',json.dumps(prompt));self.assertNotIn('family',json.dumps(prompt))
        self.assertNotIn('Why do',json.dumps(prompt));self.assertIn('Choose a weakness',prompt[0]['content'])
        audit=checks.meta_audit(response(json.dumps(dict(question='My own question?',metric='top_choice_concentration',
            value=1.,plan='My own proposed action.'))),frame)
        z=core.question_zip(original(json.dumps(audit['claim']),self.task),audit)
        old={r['id']:core.version_label(r,original('Earlier note.',self.task),language_protocol=core.NATURAL_LANGUAGE) for r in self.roots}
        p=core.observation_prompt(self.task,self.roots,old,z)
        self.assertIn(z['studentRaw'],p[-1]['content']);self.assertTrue(p[-1]['content'].endswith('Current object: '+self.task['expression']))

    def test_meta_gain_uses_same_training_objects_and_signed_metric_change(self):
        frame,item=self.frame();new=checks.metric_frame([item],checks.StableHead([1.]),'later')
        audit=checks.meta_audit(response(json.dumps(dict(question='My own question?',metric='success_probability_mean',
            value=round(frame['metrics']['success_probability_mean'],4),plan='Test a plan.'))),frame)
        self.assertGreater(checks.meta_gain(audit,frame,new),0)
        self.assertLess(checks.meta_gain(audit,new,frame),0)
        new['evidence'][0]['taskId']='other'
        with self.assertRaisesRegex(ValueError,'same actual'):checks.meta_gain(audit,frame,new)

    def test_pending_label_retains_previous_original_and_never_gets_positive_credit(self):
        root=self.roots[0];previous=core.version_label(root,original('Earlier note.',self.task),language_protocol=core.NATURAL_LANGUAGE)
        v=core.label_proposal(root,original('Storage placeholder used {RAISING_V}.',self.task),previous)
        self.assertFalse(v['eligibleForMeasuredTrial']);self.assertEqual(v['activeDescriptionRaw'],'Earlier note.')
        self.assertFalse(v['committedAsRetrievalMetadata'])

    def test_fresh_changed_representation_cannot_hide_behind_cached_guard(self):
        frame,item=self.frame();head=checks.StableHead([2.]);changed=copy.deepcopy(item);changed['features']=[[0.],[-1.],[1.]]
        changed['featureId']='new-current-feature'
        proposal=checks.fresh_head_proposal(head,[item],[changed])
        self.assertFalse(proposal['accepted']);self.assertEqual(head.weights,[2.])
        self.assertEqual(proposal['afterFeatureIds'],['new-current-feature'])
        self.assertFalse(proposal['cachedOldRepresentationsUsedAsCurrent'])

    def test_final_guard_checks_fixed_head_against_original_head_floors(self):
        _,item=self.frame();old=checks.StableHead([2.]);new=checks.StableHead([-.5])
        actual=checks.guard_still_holds(old,new,[item],[item])
        self.assertFalse(actual['accepted']);self.assertTrue(actual['headHeldFixed'])
        self.assertEqual(new.weights,[-.5])

    def test_factual_regression_and_heldout_never_enter_safe_head_proposal(self):
        _,item=self.frame();bad=copy.deepcopy(item);bad['observationAudit']=dict(item['observationAudit'],status='pending')
        self.assertFalse(checks.fresh_head_proposal(checks.StableHead([0.]),[item],[bad])['accepted'])
        item['task']['split']='heldout'
        with self.assertRaisesRegex(ValueError,'Heldout'):checks.fresh_head_proposal(checks.StableHead([0.]),[item],[item])

    def test_all_failed_routes_head_noop_and_all_primary_probabilities_zero(self):
        _,item=self.frame();item['outcomes']=[0,0,0];h=checks.StableHead([.7]);s=h.state()
        proposal=checks.fresh_head_proposal(h,[item],[item])
        self.assertTrue(proposal['accepted']);self.assertFalse(proposal['headChanged']);self.assertEqual(proposal['afterState'],s)

class MetacognitiveLoopChecks(unittest.TestCase):
    def exercise(self,regress=None,pending=False,deadline=None):
        roots=roots_fixture();prior=make_plan(set(),roots)
        excluded={t['semanticInputKey'] for t in prior['training']+prior['heldout']};next_plan=make_plan(excluded,roots)
        plan=dict(next_plan,training=next_plan['training'][:2]);head=checks.StableHead([.4,.4]);head.updates=47
        initial_labels={r['id']:core.version_label(r,original('Earlier note.',prior['training'][0],i),
            language_protocol=core.NATURAL_LANGUAGE) for i,r in enumerate(roots,1)}
        def vec(task):
            return normalized_features([[0.,0.],[1.,0.],[-1.,0.]] if task['family']=='same_factor' else [[0.,0.],[0.,-1.],[0.,1.]])
        anchors=[]
        for i,t in enumerate(prior['training']):
            obs=original('The current object is '+t['expression']+'.',t,100+i)
            anchors.append(core.measured_item(t,obs,vec(t),'prior-feature-'+str(i),
                [0,1,0] if t['family']=='same_factor' else [0,0,1],['prior-math-'+str(i)+'-'+str(j) for j in range(3)]))
        frame=checks.metric_frame(anchors,head,'parent-training-readout')
        saved={};events=[];state=[0];mode=['learning'];learning=[0];calls=[];fs=[];learns=[];checkpoints={};restores=[]
        def save(kind,row):saved.setdefault(kind,[]).append(copy.deepcopy(row));events.append((kind,row.get('phase'),row.get('task',{}).get('id')))
        def ask(phase,prompt,seed,*,mode,sampled=False,**context):
            task=context.get('task');raw='Unknown fixture prose.'
            if mode=='meta':
                readout=json.loads(prompt[-1]['content'].split('\nYour earlier')[0])
                raw=json.dumps(dict(question='How can I improve my measured success?',metric='success_probability_mean',
                    value=round(readout['metrics']['success_probability_mean'],4),plan='Check my actual expression before choosing.'))
            elif mode=='math':
                candidate=context['selectedCandidate']
                ds=[d for d in saved.get('decision',[]) if d['task']['id']==task['id']]
                self.assertEqual(len(ds),1 if task['split']=='training' else 12)
                a=application(candidate['root'],task['expression']) if candidate['kind']!='direct' else None
                raw=task['expression']+' = '+a['output_text'] if a else 'SKIP'
            else:
                raw='The current object is '+task['expression']+'.'
                if pending:raw='Storage placeholder used {WrittenEqualityTrue}.'
                if regress and phase=='guard_'+regress+'_observations' and task['id']==anchors[0]['task']['id']:
                    raw='The current object is v=2*v.'
            row=dict(recordId='meta-fixture-call-'+str(len(calls)+1).zfill(2),phase=phase,studentPrompt=copy.deepcopy(prompt),
                studentOutput=dict(response(raw,sampled),semanticStateHashDuringGeneration='fixture-state-'+str(state[0])),
                samplingSeed=seed,fixtureOnly=True,requestedMathAdapterEnabled=mode=='math',**context)
            calls.append(row);save('raw',row);return row
        def features(task,obs,cards):
            vs=vec(task);fid='meta-fixture-feature-'+str(len(fs)+1).zfill(2)
            fs.append(dict(id=fid,task=task,sourceKeywordRecordId=obs['recordId'],candidateCards=cards,
                normalizedFeatures=vs,candidatePrompts=[feature_messages(task,obs['studentOutput'],c) for c in cards]))
            save('feature',fs[-1]);return vs,fid
        def learn(rows,credits,phase):
            before=state[0];changed=any(abs(c)>1e-12 for c in credits)
            state[0]+=int(changed);learning[0]=state[0]
            result=dict(updated=changed,parameterChanged=changed,beforeHash='fixture-state-'+str(before),
                afterHash='fixture-state-'+str(state[0]),advantages=list(credits),sourceWordRecordIds=[r['recordId'] for r in rows],fixtureOnly=True)
            learns.append(result);return result
        def select(which):mode[0]=which;state[0]=0 if which=='before' else learning[0]
        def restore(which):restores.append(which);state[0]=learning[0]=which;mode[0]='learning'
        def checkpoint(name,h,l,b,m):checkpoints[name]=copy.deepcopy(dict(head=h,labels=l,meta=m,state=state[0]))
        result=core.run_course(plan,roots,head.state(),initial_labels,anchors,frame,ask,features,save,learn,select,
            lambda:state[0],restore,checkpoint,deadline or time.monotonic()+30,1,.2)
        return dict(result=result,saved=saved,events=events,calls=calls,features=fs,learns=learns,restores=restores,
            checkpoints=checkpoints,state=state[0],initial=head.state(),initialLabels=initial_labels,plan=plan,
            anchors=anchors,sourceFrame=frame,roots=roots)

    def test_complete_loop_budgets_actual_zip_flow_fresh_guard_and_frozen_heldout(self):
        e=self.exercise();r=e['result'];s=e['saved']
        self.assertTrue(r['transaction']['accepted']);self.assertEqual(e['state'],2)
        self.assertEqual(len(e['calls'])+8,core.GENERATION_CAP);self.assertEqual(len(e['features']),core.FEATURE_BATCH_CAP)
        self.assertEqual(len(s['raw']),len(s['scored']));self.assertEqual(len(s['object']),6);self.assertEqual(len(s['label-version']),4)
        self.assertEqual(len(s['decision']),50);self.assertEqual(len(s['trial']),50)
        self.assertEqual(len(s['guard-buffer']),3);self.assertTrue(all(len(b['rows'])==10 for b in s['guard-buffer']))
        self.assertEqual([len(u['sourceWordRecordIds']) for u in e['learns']],[6,1])
        meta=r['finalMetaZip'];self.assertTrue(meta['committedAsPromptMetadata'])
        for row in e['calls']:
            if row['phase'] in ('guard_candidate_observations','guard_after-meta-update_observations'):
                self.assertIn(meta['studentRaw'],row['studentPrompt'][-1]['content'])
        review=next(row for row in e['calls'] if row['phase']=='self_review_zip')
        readout=json.loads(review['studentPrompt'][-1]['content'].split('\nYour earlier')[0])
        self.assertEqual(readout['trainingObjects'],10);self.assertNotIn('heldout',readout)
        self.assertFalse(r['selfReviewZip']['committedAsPromptMetadata'])
        self.assertEqual(e['checkpoints']['training-final'],e['checkpoints']['final'])
        self.assertTrue(all(row['fixtureOnly'] for row in s['raw']))

    def test_candidate_regression_rolls_back_writer_labels_zip_and_head(self):
        e=self.exercise('candidate');r=e['result']
        self.assertFalse(r['transaction']['accepted']);self.assertTrue(r['transaction']['rolledBack'])
        self.assertEqual(e['restores'],[0]);self.assertEqual(e['state'],0);self.assertEqual(r['finalHead'],e['initial'])
        self.assertEqual(r['finalLabels'],e['initialLabels']);self.assertIsNone(r['finalMetaZip'])
        self.assertEqual(len(e['calls'])+8,66);self.assertEqual(len(e['features']),40)
        self.assertTrue(any(row['phase']=='guard_candidate_observations' for row in e['saved']['raw']))

    def test_regression_after_self_question_update_rolls_back_both_word_steps(self):
        e=self.exercise('after-meta-update');self.assertEqual(len(e['learns']),2)
        self.assertFalse(e['result']['transaction']['accepted']);self.assertEqual(e['state'],0)
        self.assertEqual(e['result']['finalLabels'],e['initialLabels']);self.assertIsNone(e['result']['finalMetaZip'])
        self.assertEqual(e['result']['finalHead'],e['initial'])

    def test_unverified_prose_zero_credit_no_fabricated_semantic_update(self):
        e=self.exercise(pending=True)
        self.assertEqual(e['learns'][0]['advantages'],[0.]*6);self.assertFalse(e['learns'][0]['parameterChanged'])
        self.assertEqual(e['state'],0);self.assertEqual(e['result']['finalHead'],e['initial'])
        self.assertEqual(len(e['calls'])+8,66);self.assertEqual(len(e['features']),40)

    def test_card_ablation_uses_same_observation_head_and_shared_uniform(self):
        e=self.exercise();dec=e['saved']['decision'];objects=e['result']['objects'][2:]
        for o in objects:
            self.assertEqual(o['observationRecordIdsByArm'][core.ARMS[0]],o['observationRecordIdsByArm'][core.ARMS[2]])
            for seed in (1,2,3):
                ds=[d for d in dec if d['task']['id']==o['id'] and d['seedIndex']==seed]
                self.assertEqual(len(ds),4);self.assertEqual(len({d['policyOutput']['sharedUniformSample'] for d in ds}),1)
            routes=[r for r in e['saved']['scored'] if r['phase']=='heldout_route_math' and r['task']['id']==o['id']]
            self.assertEqual(len(routes),3)
        summary=core.summarize(e['result']['objects'],e['saved']['trial'])
        self.assertEqual(summary['heldout']['objects'],4);self.assertTrue(summary['seedSamplesNotIndependentObjects'])

    def test_source_fixtures_rejected_before_model_import(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);(p/'result.json').write_text(json.dumps(dict(protocol=core.PROTOCOL,fixtureOnly=True)))
            with self.assertRaisesRegex(ValueError,'Only complete real'):source.inspect_source(p)
            (p/'result.json').write_text(json.dumps(dict(protocol='unknown',fixtureOnly=True)))
            with self.assertRaisesRegex(ValueError,'reviewed'):source.inspect_source(p)

    def test_saved_algorithm_replay_accepts_transactions_and_detects_changed_word_credit(self):
        from writer_check_core import write_once
        for stage in (None,'candidate','after-meta-update'):
            e=self.exercise(stage)
            with tempfile.TemporaryDirectory() as d:
                folder=Path(d)
                for kind,rows in e['saved'].items():
                    for row in rows:
                        path=(folder/'responses'/(row['recordId']+'-'+kind+'.json') if kind in ('raw','scored') else
                            folder/kind/(row['id']+'.json'))
                        write_once(path,row)
                write_once(folder/'zip-label-questions.json',e['plan'])
                write_once(folder/'protocol.json',dict(metacognitiveRound=1))
                cps={}
                for name,c in e['checkpoints'].items():
                    cps[name]=dict(head=c['head'],labels=c['labels'],metaZip=c['meta'],baselinePass=.2,
                        semanticStateHash='fixture-state-'+str(c['state']))
                    write_once(folder/'checkpoints'/(name+'.json'),cps[name])
                prior=dict(anchors=e['anchors'],sourceFrame=e['sourceFrame'])
                raws={r['recordId']:r for r in e['calls']};fields={f['id']:f for f in e['features']}
                source.replay_saved_course(folder,prior,raws,fields,cps['initial'],cps['final'],e['roots'],e['result']['objects'])
                path=folder/'update/normal-words.json';row=json.loads(path.read_text());row['semanticUpdate']['advantages'][0]=-.99
                path.write_text(json.dumps(row))
                with self.assertRaisesRegex(ValueError,'credit differs'):
                    source.replay_saved_course(folder,prior,raws,fields,cps['initial'],cps['final'],e['roots'],e['result']['objects'])

    def test_deadline_stops_before_new_training_and_seeds_are_fresh(self):
        with self.assertRaises(TimeoutError):self.exercise(deadline=time.monotonic()-1)
        ns={core.seed_for(1,n,s) for n in (0,1,2,*range(21,31),*range(61,65)) for s in range(60)}
        self.assertEqual(len(ns),17*60)
        self.assertFalse(ns & {core.seed_for(2,n,s) for n in range(100) for s in range(60)})
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'zip-label-metacognitive-partial';p.mkdir();(p/'protocol.json').write_text(json.dumps(
                dict(protocol=core.PROTOCOL,metacognitiveRound=3)))
            self.assertEqual(runtime.next_round(d),4)

def generated_meta_fixture(raw,cap,eos=False):
    stream=list(map(ord,raw))+([0] if eos else [])
    class LP:
        def __init__(self,t):self.token=t
        def float(self):return self
        def __truediv__(self,v):return self
        def __getitem__(self,i):return -.25
        def argmax(self):return self.token
        def exp(self):return self
    class Base:
        generation_config=SimpleNamespace(eos_token_id=0)
        def __init__(self):self.calls=0
        def parameters(self):return iter([SimpleNamespace(device='fixture')])
        def __call__(self,**kwargs):
            t=stream[self.calls];self.calls+=1
            return SimpleNamespace(logits=SimpleNamespace(__getitem__=None),past_key_values='fixture')
    class Logits:
        def __init__(self,t):self.t=t
        def __getitem__(self,k):return LP(self.t)
    class ActualBase(Base):
        def __call__(self,**kwargs):
            t=stream[self.calls];self.calls+=1;return SimpleNamespace(logits=Logits(t),past_key_values='fixture')
    class Prefix(list):
        def tolist(self):return list(self)
    torch=ModuleType('torch');nn=ModuleType('torch.nn');f=ModuleType('torch.nn.functional');torch.nn=nn;nn.functional=f
    torch.Generator=lambda **kwargs:SimpleNamespace(manual_seed=lambda n:'fixture-rng')
    torch.isfinite=lambda x:SimpleNamespace(all=lambda:True);torch.multinomial=lambda x,n,generator:x.token
    torch.tensor=lambda x,**kwargs:x;torch.no_grad=lambda:nullcontext();f.log_softmax=lambda x,dim:x
    gen=ModuleType('zip_generation_policy');gen.prompt_ids=lambda *args:[Prefix([1,2])]
    tok=SimpleNamespace(eos_token_id=0,decode=lambda ids,**kw:''.join(chr(i) for i in ids if i))
    with patch.dict(sys.modules,{'torch':torch,'torch.nn':nn,'torch.nn.functional':f,'zip_generation_policy':gen}):
        return policy.generate_meta(ActualBase(),tok,[],cap,7)

class MetacognitivePolicyChecks(unittest.TestCase):
    def test_separate_trajectory_weights_and_policy_drift_stop_before_step(self):
        import zip_label_grounded_policy as old_policy
        from test_zip_label_grounded import WeightedPolicyChecks
        witness=WeightedPolicyChecks()
        with patch.object(old_policy,'update_weighted_generation',policy.update_words):
            value,state=witness.execute([.6,0.,-.2])
            self.assertAlmostEqual(state['gradient'],-(.6*1-.2*3)/288)
            self.assertEqual(state['steps'],1);self.assertEqual(value['replayLogProbabilities'],[-1.,-2.,-3.])
            with self.assertRaisesRegex(RuntimeError,'no step'):witness.execute([.2,0.,0.],drift=True)

    def test_actual_json_closure_at_last_token_complete_no_marker_no_tokens_dropped(self):
        raw='{"question":"Own?","metric":"m","value":0,"plan":"Own."}'
        row=generated_meta_fixture(raw+'extra',len(raw));self.assertEqual(row['raw'],raw)
        self.assertFalse(row['tokenCapReached']);self.assertEqual(row['generatedIds'],list(map(ord,raw)))
        self.assertEqual(len(row['samplingTokenLogProbabilities']),len(raw));self.assertEqual(row['samplingLogProbability'],-.25*len(raw))

    def test_incomplete_eos_budget_and_duplicate_keys_never_invent_completion(self):
        raw='{"question":"Own?"'
        eos=generated_meta_fixture(raw,len(raw)+2,eos=True)
        self.assertFalse(eos['studentJSONClosureReached']);self.assertEqual(eos['stopReason'],'eos')
        self.assertFalse(eos['tokenCapReached']);self.assertEqual(eos['raw'],raw);self.assertEqual(eos['generatedIds'][-1],0)
        capped=generated_meta_fixture(raw,len(raw));self.assertTrue(capped['tokenCapReached'])
        self.assertFalse(capped['studentJSONClosureReached'])
        dup='{"question":"a","question":"b"}'
        self.assertFalse(generated_meta_fixture(dup,len(dup))['studentJSONClosureReached'])

    def test_zero_credit_noop_before_model_import_and_invalid_denominator_rejected(self):
        before=set(sys.modules);value=policy.update_words(None,None,None,[{}]*6,[0.]*6,576)
        self.assertFalse(value['updated']);self.assertEqual(set(sys.modules),before)
        with self.assertRaisesRegex(ValueError,'denominator'):policy.update_words(None,None,None,[{}],[1.],95)

if __name__=='__main__':unittest.main()
