"""Offline contracts using explicit fixtures. No model or actual training."""
import copy
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from types import ModuleType, SimpleNamespace

import zip_label_core as core
from object_choice_core import ChoiceHead, normalized_features, feature_messages
from zip_guided_helpers import application
from writer_check_core import write_once


def roots_fixture():
    return [dict(id=name,version='fixture-'+name,rule=dict(operation='rewrite',input=left,
        output=right,variable='',scope='real_polynomial')) for name,left,right in
        [('combine','1*x+2*x','3*x'),('distribute','c*(a+b)','c*a+c*b')]]


def response(text, sampled=False, capped=False):
    return dict(raw=text,generatedTokens=3,generatedIds=[1,2,3],promptIds=[5,6],
        tokenCapReached=capped,sampled=sampled,temperature=.8 if sampled else 1.,testDouble=True)


def generated_note_fixture(text, max_tokens=96, sampled=True, append_eos=False,
                           language_protocol=core.COMPACT_LANGUAGE):
    """Synthetic token stream exercises only stopping and original preservation."""
    import zip_semantic_generation
    stream=list(map(ord,text))+([0] if append_eos else [])
    class LP:
        def __init__(self, token):self.token=token
        def float(self):return self
        def __truediv__(self, other):return self
        def __getitem__(self, index):return -.25
        def argmax(self):return self.token
        def exp(self):return self
    class Logits:
        def __init__(self,token):self.token=token
        def __getitem__(self,index):return LP(self.token)
    class Base:
        generation_config=SimpleNamespace(eos_token_id=0)
        def __init__(self):self.calls=0
        def parameters(self):return iter([SimpleNamespace(device='fixture')])
        def __call__(self,**kwargs):
            token=stream[self.calls];self.calls+=1
            return SimpleNamespace(logits=Logits(token),past_key_values='fixture-cache')
    class Prompt(list):
        def tolist(self):return list(self)
    torch=ModuleType('torch');nn=ModuleType('torch.nn');functional=ModuleType('torch.nn.functional')
    torch.nn=nn;nn.functional=functional
    torch.Generator=lambda **kw:SimpleNamespace(manual_seed=lambda seed:'fixture-rng')
    torch.isfinite=lambda lp:SimpleNamespace(all=lambda:True)
    torch.multinomial=lambda lp,n,generator:lp.token
    torch.tensor=lambda value,**kwargs:value
    torch.no_grad=lambda:__import__('contextlib').nullcontext()
    functional.log_softmax=lambda lp,dim:lp
    policy=ModuleType('zip_generation_policy')
    policy.prompt_ids=lambda *args:[Prompt([5,6])]
    tokenizer=SimpleNamespace(eos_token_id=0,decode=lambda ids,**kwargs:''.join(chr(i) for i in ids if i))
    base=Base()
    with patch.dict(sys.modules,{'torch':torch,'torch.nn':nn,'torch.nn.functional':functional,
                                'zip_generation_policy':policy}):
        result=zip_semantic_generation.generate_note(base,tokenizer,[],max_tokens,7,sampled=sampled,
            language_protocol=language_protocol)
    return result,base.calls


class LabelIterationChecks(unittest.TestCase):
    def setUp(self):
        self.roots=roots_fixture();self.plan=core.make_plan(set(),self.roots)
        self.labels={root['id']:core.version_label(root,dict(recordId='fixture-initial-'+root['id'],
            studentOutput=response('Initial student prose for '+root['id']))) for root in self.roots}

    def exercise(self, zero_outcomes=False, direct_success=False, deadline=None, fail_revision=False,
                 language_protocol=core.LEGACY_LANGUAGE, capped_revisions=False, initial_labels=None):
        initial_labels=copy.deepcopy(self.labels if initial_labels is None else initial_labels)
        saved={k:[] for k in ('raw','scored','decision','feature','trial','instance','object',
            'update','label-version','failure')}
        events=[];calls=[];features=[];word_updates=[];checkpoints={}
        current=['learning'];version=[0]
        head=ChoiceHead([.8,-.2]);head.updates=16;initial=head.state()

        def save(kind,row):
            events.append((kind,row.get('recordId',row.get('id'))))
            saved[kind].append(copy.deepcopy(row))

        def ask(phase,prompt,seed,*,mode,sampled=False,**context):
            calls.append((phase,copy.deepcopy(prompt),seed,mode,current[0]))
            text='Fixture student observations, line 1.\nWhole original, line 2.'
            if phase.endswith('route_math'):
                task=context['task'];candidate=context['selectedCandidate']
                decisions=[d for d in saved['decision'] if d['task']['id']==task['id']]
                self.assertEqual(len(decisions),1 if task['split']=='training' else 9)
                self.assertTrue(context['hostSpecifiedRoute']);self.assertFalse(context['autonomousToolUseClaimed'])
                call=application(candidate['root'],task['expression']) if candidate['kind']!='direct' else None
                if candidate['kind']=='direct' and direct_success:
                    call=next((a for a in (application(r,task['expression']) for r in self.roots) if a),None)
                text=task['expression']+' = '+call['output_text'] if call and not zero_outcomes else 'SKIP'
            if phase=='training_zip_label_revision':
                self.assertEqual(len([r for r in saved['scored'] if r.get('task',{}).get('id')==context['task']['id']
                    and r['phase']=='training_route_math']),3)
                text='Revised fixture ZIP description '+str(len(calls))+'.'
                if fail_revision:
                    raise RuntimeError('fixture revision failure')
            if mode=='semantic' and language_protocol==core.COMPACT_LANGUAGE:
                text+='\n[END_NOTE]'
            row=dict(recordId='fixture-word-'+str(len(calls)).zfill(2),phase=phase,
                studentPrompt=copy.deepcopy(prompt),studentOutput=dict(response(text,sampled,
                    capped=capped_revisions and phase=='training_zip_label_revision'),
                    semanticStateHashDuringGeneration='fixture-state-'+str(version[0]),
                    semanticWriterMode=current[0]),samplingSeed=seed,fixtureOnly=True,**context)
            save('raw',row)
            return row

        def represent(task,words,candidates):
            # Synthetic witness of card changes, never a real backbone result.
            changed=any(c.get('sourceLabelVersion') not in {v['id'] for v in initial_labels.values()}
                for c in candidates if c['kind']!='direct')
            vectors=[[1.,.1],[.1,2. if changed else 1.],[-1.,-1.]]
            row=dict(id='fixture-feature-'+str(len(features)+1).zfill(2),task=copy.deepcopy(task),
                sourceKeywordRecordId=words['recordId'],candidateCards=copy.deepcopy(candidates),
                candidatePrompts=[feature_messages(task,words['studentOutput'],c) for c in candidates],
                candidateHiddenVectors=vectors,candidateOrder=[c['id'] for c in candidates])
            features.append(row);save('feature',row)
            return normalized_features(vectors),row['id']

        def learn(rows,reward,baseline,number):
            self.assertEqual(current[0],'learning');self.assertEqual(number,len(word_updates)+1)
            self.assertEqual(len(rows),3)
            self.assertTrue(all(r['studentOutput']['sampled'] for r in rows))
            self.assertEqual(len({r['studentOutput']['semanticStateHashDuringGeneration'] for r in rows}),1)
            word_updates.append(dict(rows=copy.deepcopy(rows),reward=reward,baseline=baseline))
            version[0]+=1
            return dict(updated=True,parameterChanged=True,fixtureOnly=True)

        def select(mode):
            current[0]=mode

        def checkpoint(name,state,labels,baseline):
            checkpoints[name]=copy.deepcopy(dict(head=state,labels=labels,baseline=baseline))

        actual_audit=core.audit_math
        def audited(*args):
            self.assertEqual(events[-1][0],'raw')
            return actual_audit(*args)

        with patch.object(core,'audit_math',audited):
            result=core.run_course(self.plan,self.roots,initial,initial_labels,ask,represent,save,
                learn,select,checkpoint,deadline or time.monotonic()+30,1,
                language_protocol=language_protocol)
        return dict(result=result,saved=saved,calls=calls,features=features,
            wordUpdates=word_updates,checkpoints=checkpoints,initial=initial,events=events)

    def test_full_loop_writes_features_and_labels_and_keeps_all_originals(self):
        e=self.exercise();s=e['saved']
        self.assertEqual(len(s['raw']),68)
        self.assertEqual(len(s['raw']),len(s['scored']))
        self.assertEqual(8+2+len(s['raw']),78)
        self.assertEqual(len(s['feature']),28)
        self.assertEqual(len(s['object']),12)
        self.assertEqual(len(s['label-version']),16)
        self.assertEqual(len(s['update']),8)
        self.assertEqual(len(s['decision']),44)
        self.assertEqual(len(s['trial']),44)
        self.assertEqual(len(s['failure']),24)
        self.assertEqual(len(s['instance']),12)
        self.assertTrue(all(row['fixtureOnly'] for row in s['raw']))

    def test_revised_notes_flow_into_later_student_observations_and_cards(self):
        e=self.exercise();s=e['saved']
        words=[r for r in s['raw'] if r['phase']=='training_observations']
        first_versions=s['label-version'][:2]
        prompt='\n'.join(m['content'] for m in words[1]['studentPrompt'])
        for version in first_versions:
            self.assertIn(version['studentRaw'],prompt)
        self.assertEqual(s['update'][0]['labelParentsAfter'],s['update'][1]['labelParentsBefore'])
        for feature in s['feature']:
            original=next(r for r in s['raw'] if r['recordId']==feature['sourceKeywordRecordId'])
            self.assertTrue(all(original['studentOutput']['raw'] in p[1]['content']
                                for p in feature['candidatePrompts']))

    def test_words_and_both_descriptions_receive_actual_expected_success_feedback(self):
        e=self.exercise()
        for learned,update in zip(e['wordUpdates'],e['saved']['update']):
            self.assertEqual(learned['reward'],update['expectedPassWithRevisedLabels'])
            self.assertEqual(learned['baseline'],update['baselinePassBefore'])
            self.assertEqual([r['phase'] for r in learned['rows']],
                ['training_observations','training_zip_label_revision','training_zip_label_revision'])
            self.assertFalse(update['correctToolLabelSupplied'])
            self.assertFalse(update['humanFeatureTargetsSupplied'])

    def test_heldout_weights_labels_and_pre_round_control_do_not_update(self):
        e=self.exercise()
        self.assertEqual(e['checkpoints']['training-final'],e['checkpoints']['final'])
        self.assertEqual(e['checkpoints']['initial']['head'],e['initial'])
        self.assertEqual(e['checkpoints']['initial']['labels'],self.labels)
        self.assertEqual(len(e['wordUpdates']),8)
        heldwords=[c for c in e['calls'] if c[0]=='heldout_observations']
        self.assertEqual([c[4] for c in heldwords],['learning','before']*4)
        self.assertEqual(len([c for c in e['calls'] if c[0]=='heldout_route_math']),12)

    def test_all_choices_precede_math_and_seed_trials_reuse_same_three_routes(self):
        e=self.exercise();s=e['saved']
        for obj in [o for o in s['object'] if o['phase']=='heldout']:
            decisions=[d for d in s['decision'] if d['task']['id']==obj['id']]
            self.assertEqual(len(decisions),9)
            for index in range(1,4):
                paired=[d for d in decisions if d['seedIndex']==index]
                self.assertEqual(len({d['policyOutput']['choiceSeed'] for d in paired}),1)
                self.assertEqual(len({d['policyOutput']['sharedUniformSample'] for d in paired}),1)
            trials=[t for t in s['trial'] if t.get('taskId')==obj['id']]
            self.assertEqual({t['sourceMathRecordId'] for t in trials} - set(obj['sourceMathRecordIds']),set())
            self.assertEqual(len(obj['sourceMathRecordIds']),3)

    def test_metadata_ablation_changes_only_cards_for_same_learned_observations_and_head(self):
        e=self.exercise();s=e['saved']
        for task in self.plan['heldout']:
            ds=[d for d in s['decision'] if d['task']['id']==task['id'] and d['seedIndex']==1]
            learned=next(d for d in ds if d['arm']==core.ARMS[0])
            ablation=next(d for d in ds if d['arm']==core.ARMS[2])
            self.assertEqual(learned['sourceKeywordRecordId'],ablation['sourceKeywordRecordId'])
            self.assertEqual(learned['policyOutput']['parameterHash'],ablation['policyOutput']['parameterHash'])
            feature=next(f for f in s['feature'] if f['id']==ablation['sourceFeatureRecordId'])
            self.assertEqual([c['sourceLabelVersion'] for c in feature['candidateCards'][1:]],
                [self.labels[r['id']]['id'] for r in self.roots])

    def test_primary_metric_uses_all_real_routes_and_not_sample_success(self):
        e=self.exercise();summary=core.summarize(e['saved']['object'])
        held=[o for o in e['saved']['object'] if o['phase']=='heldout']
        for arm in core.ARMS:
            expected=sum(sum(p*y for p,y in zip(o['probabilitiesByArm'][arm],o['routeOutcomes'])) for o in held)/4
            self.assertAlmostEqual(summary['heldout']['expectedPassByArm'][arm],expected)
        self.assertEqual(summary['heldoutUniqueObjects'],4)
        self.assertEqual(summary['uniqueNewObjects'],12)
        self.assertEqual(summary['independentTrainingReplications'],0)

    def test_direct_success_and_all_failed_route_originals_are_retained(self):
        e=self.exercise(direct_success=True)
        self.assertTrue(all(o['routeOutcomes'][0]==1 for o in e['saved']['object']))
        for update in e['saved']['update']:
            self.assertEqual(update['headUpdate']['routeRewards'][0],1.)
        e=self.exercise(zero_outcomes=True)
        self.assertEqual(len(e['saved']['failure']),36)
        self.assertFalse(any(u['headUpdate']['updated'] for u in e['saved']['update']))
        self.assertEqual(e['result']['finalHead'],e['initial'])

    def test_incomplete_description_preserves_old_card_without_repair_or_certification(self):
        old=self.labels['combine']
        row=dict(recordId='fixture-capped',studentOutput=response('1*x+2*x = 100*x',capped=True))
        revised=core.version_label(self.roots[0],row,old)
        self.assertFalse(revised['activatedAsRetrievalMetadata'])
        self.assertEqual(revised['activeDescriptionRaw'],old['studentRaw'])
        self.assertEqual(revised['studentRaw'],'1*x+2*x = 100*x')
        self.assertFalse(revised['wholeNaturalLanguageCertified'])
        self.assertFalse(revised['mathematicalRootChanged'])

    def test_new_plans_and_round_choice_seed_sets_do_not_reuse_old_objects_or_seeds(self):
        excluded={t['semanticInputKey'] for t in self.plan['training']+self.plan['heldout']}
        new=core.make_plan(excluded,self.roots)
        self.assertFalse(excluded & {t['semanticInputKey'] for t in new['training']+new['heldout']})
        first={core.seed_for(1,n,s) for n in range(1,13) for s in range(100)}
        second={core.seed_for(2,n,s) for n in range(1,13) for s in range(100)}
        self.assertFalse(first&second)

    def test_prompt_cards_have_no_handwritten_semantic_tags_or_task_family(self):
        cards=core.cards(self.roots,self.labels)
        self.assertTrue(all(c['tags']==[] for c in cards))
        task=dict(self.plan['training'][0],family='SECRET_FAMILY',split='SECRET_SPLIT')
        prompts=core.observations_messages(task,self.roots,self.labels)
        text='\n'.join(p['content'] for p in prompts)
        self.assertNotIn('SECRET_FAMILY',text);self.assertNotIn('SECRET_SPLIT',text)
        for candidate in cards:
            text='\n'.join(p['content'] for p in feature_messages(task,response('all my words'),candidate))
            self.assertNotIn('SECRET_FAMILY',text);self.assertNotIn('SECRET_SPLIT',text)

    def test_deadline_stops_before_student_generation(self):
        with self.assertRaises(TimeoutError):
            self.exercise(deadline=time.monotonic()-1)

    def test_fixture_iteration_is_rejected_before_any_model_import(self):
        import zip_label_run
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp)
            write_once(folder/'result.json',dict(protocol=core.PROTOCOL,fixtureOnly=True,stopReason='completed'))
            before=set(sys.modules)
            with self.assertRaisesRegex(ValueError,'仅完整真实'):
                zip_label_run.inspect_iteration(folder)
            self.assertFalse({'torch','transformers','safetensors'}&(set(sys.modules)-before))

    def test_compact_prompts_remove_archive_ambiguity_without_teaching_features(self):
        task=dict(self.plan['training'][0],family='SECRET_FAMILY',split='SECRET_SPLIT')
        route=dict(check=dict(outcomePassed=False,completeEqualityCheck=dict(reason='fixture'),
            selectedToolReplay=None),studentOutput=response('SKIP'))
        words=dict(studentOutput=response('My own observation.\n[END_NOTE]'))
        prompts=[core.initial_label_messages(self.roots[0],core.COMPACT_LANGUAGE),
            core.observations_messages(task,self.roots,self.labels,core.COMPACT_LANGUAGE),
            core.revision_messages(task,self.roots[0],self.labels['combine'],words,route,core.COMPACT_LANGUAGE)]
        for prompt in prompts:
            text='\n'.join(p['content'] for p in prompt)
            self.assertIn('algebraic rewrite',text)
            self.assertIn('[END_NOTE]',text);self.assertIn('40 words',text)
            for secret in ('SECRET_FAMILY','SECRET_SPLIT','ZIP','correct tool:','correct answer:'):
                self.assertNotIn(secret,text)
        self.assertEqual(core.cards(self.roots,self.labels,core.COMPACT_LANGUAGE)[1]['tags'],[])

    def test_end_marker_is_student_text_and_never_completes_an_unfinished_note(self):
        from zip_semantic_generation import note_ended,note_contract
        good='My own complete observation.\n[END_NOTE]'
        self.assertTrue(note_ended(good));self.assertTrue(note_contract(good)['complete'])
        for bad in ('unfinished\n[END_NOTE]','A sentence.',
                    'A sentence. [END_NOTE]','A sentence.\n[END_NOTE]\nMore text.',
                    ' '.join(['word']*41)+'.\n[END_NOTE]',
                    'One. Two. Three. Four.\n[END_NOTE]'):
            self.assertFalse(note_contract(bad)['complete'],bad)
        self.assertFalse(note_contract(good,capped=True)['complete'])
        self.assertFalse(note_contract(good)['semanticTruthCertified'])

    def test_compact_incomplete_description_preserves_prior_original_without_repair(self):
        root=self.roots[0];old=self.labels[root['id']]
        raw='This unfinished text'
        row=dict(recordId='fixture-bad-note',phase='training_zip_label_revision',
            task=dict(id='fixture-task'),studentOutput=response(raw))
        v=core.version_label(root,row,old,core.COMPACT_LANGUAGE)
        self.assertEqual(v['studentRaw'],raw)
        self.assertEqual(v['activeDescriptionRaw'],old['activeDescriptionRaw'])
        self.assertFalse(v['activatedAsRetrievalMetadata'])
        self.assertFalse(v['noteFramingCheck']['originalTextRepaired'])

    def test_compact_completion_does_not_certify_wrong_mathematics(self):
        row=dict(recordId='fixture-wrong-note',phase='training_zip_label_revision',
            task=dict(id='fixture-task'),studentOutput=response('2 = 3.\n[END_NOTE]'))
        v=core.version_label(self.roots[0],row,self.labels['combine'],core.COMPACT_LANGUAGE)
        self.assertTrue(v['activatedAsRetrievalMetadata'])
        self.assertFalse(v['wholeNaturalLanguageCertified'])
        self.assertFalse(v['mathematicalRootChanged'])
        self.assertEqual(v['rootClaimHash'],self.labels['combine']['rootClaimHash'])

    def test_migration_keeps_weights_and_uses_generation_count_instead_of_round_number(self):
        self.assertTrue(core.needs_note_bootstrap(self.labels))
        migrated={r['id']:core.version_label(r,dict(recordId='new-'+r['id'],phase='initial_zip_label',
            studentOutput=response('My own short note.\n[END_NOTE]')),self.labels[r['id']],core.COMPACT_LANGUAGE)
            for r in self.roots}
        self.assertFalse(core.needs_note_bootstrap(migrated))
        self.assertEqual(core.complete_generation_count(2),78)
        self.assertEqual(core.complete_generation_count(0),76)
        self.assertTrue(all(v['parentDescriptionId']==self.labels[k]['id'] for k,v in migrated.items()))

    def test_compact_real_reuse_is_reported_separately_from_generated_revisions(self):
        e=self.exercise(language_protocol=core.COMPACT_LANGUAGE)
        summary=core.summarize(e['result']['objects'],e['saved']['trial'])
        self.assertEqual(summary['activatedLabelRevisions'],16)
        self.assertEqual(summary['revisionsUsedInLaterObservationPrompts'],16)
        self.assertEqual(summary['revisionsUsedInLaterSelectionPrompts'],16)
        self.assertTrue(summary['descriptionsReturnToLaterObservationAndSelectionPrompts'])
        second=e['saved']['object'][1]
        for v in e['saved']['label-version'][:2]:
            self.assertIn(v['id'],second['observationLabelIdsUsed'].values())

    def test_zero_activated_revisions_does_not_claim_a_completed_description_loop(self):
        e=self.exercise(language_protocol=core.COMPACT_LANGUAGE,capped_revisions=True)
        summary=core.summarize(e['result']['objects'],e['saved']['trial'])
        self.assertEqual(len(e['saved']['label-version']),16)
        self.assertEqual(summary['activatedLabelRevisions'],0)
        self.assertEqual(summary['revisionsUsedInLaterObservationPrompts'],0)
        self.assertFalse(summary['descriptionsReturnToLaterObservationAndSelectionPrompts'])
        self.assertEqual(e['checkpoints']['initial']['labels'],e['checkpoints']['final']['labels'])

    def test_semantic_generator_stops_on_actual_marker_and_retains_all_token_log_probabilities(self):
        note='My note.\n[END_NOTE]'
        for sampled in (True,False):
            result,calls=generated_note_fixture(note+'\nUnrequested extra text.',sampled=sampled)
            self.assertEqual(result['raw'],note)
            self.assertEqual(result['generatedIds'],list(map(ord,note)))
            self.assertEqual(result['promptIds'],[5,6])
            self.assertEqual(calls,len(note))
            self.assertEqual(result['samplingTokenLogProbabilities'],[-.25]*len(note))
            self.assertEqual(result['samplingLogProbability'],-.25*len(note))
            self.assertEqual(result['stopReason'],'student_end_marker')
            self.assertFalse(result['tokenCapReached'])

    def test_semantic_marker_at_last_budget_token_is_complete_but_cap_without_marker_is_not(self):
        suffix='.\n[END_NOTE]';note='A'*(96-len(suffix))+suffix
        good,calls=generated_note_fixture(note)
        bad,calls=generated_note_fixture('A'*96)
        self.assertEqual(good['generatedTokens'],96);self.assertFalse(good['tokenCapReached'])
        self.assertTrue(good['studentEndMarkerReached'])
        self.assertEqual(bad['raw'],'A'*96);self.assertTrue(bad['tokenCapReached'])
        self.assertFalse(bad['studentEndMarkerReached'])

    def test_semantic_eos_does_not_invent_a_missing_end_marker(self):
        result,calls=generated_note_fixture('My note.',append_eos=True)
        self.assertEqual(result['raw'],'My note.')
        self.assertEqual(result['generatedIds'][-1],0)
        self.assertEqual(result['stopReason'],'eos')
        self.assertFalse(result['studentEndMarkerReached'])
        self.assertFalse(result['tokenCapReached'])
        self.assertFalse(core.note_contract(result['raw'])['complete'])

    def test_natural_framing_accepts_actual_c2db5c9b_short_eos_original_without_repair(self):
        from zip_semantic_generation import framing_check
        raw='The rewritten expression is: 1*x + 2*x = 3*x.'
        check=framing_check(raw,False,core.NATURAL_LANGUAGE)
        self.assertTrue(check['complete'])
        self.assertFalse(check['studentEndMarkerRequired'])
        self.assertFalse(check['originalTextRepaired'])
        self.assertFalse(check['semanticTruthCertified'])

    def test_natural_generator_keeps_sampled_tokens_and_stops_on_student_sentence(self):
        note='This is my own observation.'
        for sampled in (True,False):
            result,calls=generated_note_fixture(note+' More unrequested text.',sampled=sampled,
                language_protocol=core.NATURAL_LANGUAGE)
            self.assertEqual(result['raw'],note)
            self.assertEqual(result['generatedIds'],list(map(ord,note)))
            self.assertEqual(calls,len(note))
            self.assertEqual(result['samplingTokenLogProbabilities'],[-.25]*len(note))
            self.assertEqual(result['stopReason'],'student_sentence_boundary')
            self.assertTrue(result['studentSentenceBoundaryReached'])
            self.assertFalse(result['studentEndMarkerReached'])
            self.assertFalse(result['tokenCapReached'])

    def test_natural_numeric_dots_do_not_end_a_note_and_eos_is_preserved(self):
        note='I see 0.5 repeated, e.g. here.'
        result,calls=generated_note_fixture(note,language_protocol=core.NATURAL_LANGUAGE)
        self.assertEqual(result['raw'],note)
        self.assertEqual(calls,len(note))
        result,calls=generated_note_fixture('The coefficient is 3.',append_eos=True,
            language_protocol=core.NATURAL_LANGUAGE)
        self.assertEqual(result['stopReason'],'eos')
        self.assertEqual(result['generatedIds'][-1],0)
        self.assertTrue(core.framing_check(result['raw'],False,core.NATURAL_LANGUAGE)['complete'])

    def test_natural_eos_and_token_budget_never_complete_unfinished_prose(self):
        result,calls=generated_note_fixture('Unfinished text',append_eos=True,
            language_protocol=core.NATURAL_LANGUAGE)
        self.assertEqual(result['raw'],'Unfinished text')
        self.assertFalse(core.framing_check(result['raw'],False,core.NATURAL_LANGUAGE)['complete'])
        good,calls=generated_note_fixture('A'*95+'.',language_protocol=core.NATURAL_LANGUAGE)
        bad,calls=generated_note_fixture('A'*96,language_protocol=core.NATURAL_LANGUAGE)
        self.assertEqual(good['generatedTokens'],96);self.assertFalse(good['tokenCapReached'])
        self.assertTrue(core.framing_check(good['raw'],False,core.NATURAL_LANGUAGE)['complete'])
        self.assertTrue(bad['tokenCapReached'])
        self.assertFalse(core.framing_check(bad['raw'],True,core.NATURAL_LANGUAGE)['complete'])

    def bootstrap_fixture(self, previous, originals):
        saved=[];iterator=iter(originals)
        def save(kind,row):saved.append((kind,copy.deepcopy(row)))
        def ask(phase,prompt,seed,**context):
            raw,capped=next(iterator)
            row=dict(recordId='fixture-bootstrap-'+str(len(saved)),phase=phase,
                studentOutput=response(raw,capped=capped),studentPrompt=prompt,
                fixtureOnly=True,samplingSeed=seed,**context)
            save('raw',row)
            return row
        labels=core.bootstrap_notes(self.roots,previous,ask,save,2)
        return labels,saved

    def test_natural_incomplete_bootstrap_keeps_both_originals_and_previous_labels(self):
        before=copy.deepcopy(self.labels)
        labels,saved=self.bootstrap_fixture(before,[('Unfinished note',False),('A'*96,True)])
        self.assertEqual(labels,before)
        self.assertEqual(self.labels,before)
        self.assertEqual([k for k,r in saved],['raw','scored','label-version']*2)
        self.assertEqual([r['studentOutput']['raw'] for k,r in saved if k=='raw'],['Unfinished note','A'*96])
        self.assertTrue(all(not r['activatedAsRetrievalMetadata'] for k,r in saved if k=='label-version'))

    def test_natural_empty_bootstrap_continues_actual_feedback_and_shared_control(self):
        labels,saved=self.bootstrap_fixture({},[('Unfinished note',False),('A'*96,True)])
        self.assertTrue(all(v['activeDescriptionRaw']=='' and v['sourceRecordId'] is None and
            v['hostSemanticDescriptionSupplied'] is False for v in labels.values()))
        e=self.exercise(language_protocol=core.NATURAL_LANGUAGE,initial_labels=labels)
        self.assertEqual(len(e['result']['objects']),12)
        self.assertEqual(len(e['result']['updates']),8)
        self.assertEqual(e['checkpoints']['initial']['labels'],labels)
        frozen_ids={k:v['id'] for k,v in labels.items()}
        for obj in e['result']['objects'][8:]:
            self.assertEqual(obj['observationLabelIdsUsedByArm'][core.ARMS[1]],frozen_ids)
            self.assertEqual(obj['selectionLabelIdsUsedByArm'][core.ARMS[1]],frozen_ids)
        summary=core.summarize(e['result']['objects'],e['saved']['trial'])
        self.assertEqual(summary['activatedLabelRevisions'],16)
        self.assertTrue(summary['descriptionsReturnToLaterObservationAndSelectionPrompts'])

    def test_natural_mixed_bootstrap_activates_only_complete_student_original(self):
        raw='The rewritten expression is: 1*x + 2*x = 3*x.'
        labels,saved=self.bootstrap_fixture(self.labels,[(raw,False),('Unfinished note',False)])
        self.assertEqual(labels['combine']['studentRaw'],raw)
        self.assertTrue(labels['combine']['activatedAsRetrievalMetadata'])
        self.assertEqual(labels['distribute'],self.labels['distribute'])
        self.assertFalse(labels['combine']['wholeNaturalLanguageCertified'])

    def test_natural_zero_activated_revisions_still_train_but_do_not_claim_reuse(self):
        e=self.exercise(language_protocol=core.NATURAL_LANGUAGE,capped_revisions=True)
        self.assertEqual(len(e['result']['updates']),8)
        summary=core.summarize(e['result']['objects'],e['saved']['trial'])
        self.assertEqual(summary['activatedLabelRevisions'],0)
        self.assertFalse(summary['descriptionsReturnToLaterObservationAndSelectionPrompts'])
        self.assertEqual(e['checkpoints']['initial']['labels'],e['checkpoints']['final']['labels'])

    def test_natural_prompts_supply_framing_but_no_human_feature_targets(self):
        prompts=[core.initial_label_messages(self.roots[0],core.NATURAL_LANGUAGE),
            core.observations_messages(self.plan['training'][0],self.roots,self.labels,core.NATURAL_LANGUAGE)]
        for prompt in prompts:
            text=str(prompt)
            for absent in ('[END_NOTE]','ZIP','same_factor','product_of_sum','combine like terms','distributive'):
                self.assertNotIn(absent,text)

    def test_recent_complete_skips_failed_v2_and_accepts_v3_without_loading_models(self):
        from zip_label_run import recent_complete
        with tempfile.TemporaryDirectory() as tmp:
            work=Path(tmp);source=work/'base'
            for name,protocol,status,number in [('old-v1',core.PROTOCOL,'completed',1),
                ('failed-v2',core.COMPACT_PROTOCOL,'error',2),('new-v3',core.NATURAL_PROTOCOL,'completed',2)]:
                folder=work/('zip-label-iterate-'+name);folder.mkdir()
                write_once(folder/'result.json',dict(protocol=protocol,stopReason=status,
                    fixtureOnly=False,iterationRound=number))
                write_once(folder/'source-checkpoint.json',dict(baseChoiceSource=str(source)))
            self.assertEqual(recent_complete(work,source).name,'zip-label-iterate-new-v3')
            (work/'zip-label-iterate-new-v3/result.json').unlink()
            self.assertEqual(recent_complete(work,source).name,'zip-label-iterate-old-v1')


if __name__=='__main__':unittest.main(verbosity=2)
