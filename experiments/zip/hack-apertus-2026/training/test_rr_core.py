import copy
import tempfile
from pathlib import Path
import unittest
from rr_common import *
from rr_cases import *
from rr_memory import *
from rr_policy import distribution,select
from rr_evaluate import numerical_audit,math_audit
from rr_test_fixtures import *


class CurriculumTests(unittest.TestCase):
    def test_real_error_three_witnesses_are_all_genuine(self):
        plan=make_plan(fixture_cards())
        bad=plan['sourceReadback'][0]
        self.assertEqual([x['leftValue'] for x in bad['observations']],['0','435','1740'])
        self.assertEqual([x['rightValue'] for x in bad['observations']],['189225']*3)
        self.assertEqual(expected(bad,1),'RETRACT');self.assertEqual(expected(bad,3),'RETRACT')

    def test_every_template_claim_and_witness_is_exactly_checked(self):
        plan=make_plan(fixture_cards());validate_plan(plan)
        self.assertEqual(len(plan['training']),42);self.assertEqual(len(plan['heldout']),15)
        for case in plan['training']+plan['heldout']:
            self.assertEqual(equal(case['card']['left'],case['card']['right']),case['card']['knownExactIdentity'])

    def test_fresh_rule_identities_exclude_training_up_to_variable_renaming(self):
        plan=make_plan(fixture_cards())
        self.assertFalse({semantic_key(c['card']) for c in plan['training']}&{semantic_key(c['card']) for c in plan['heldout']})

    def test_false_rule_matching_at_one_point_is_not_used_as_a_fake_conflict(self):
        card=variant('drop_variable',4,'v',False,'training',fixture_cards()[0]);case=make_case(card,'training')
        self.assertNotIn({'v':2},[o['leftAssignment'] for o in case['observations']])
        self.assertEqual(len(case['observations']),3)

    def test_different_input_values_do_not_refute_correct_rule(self):
        plan=make_plan(fixture_cards())
        guards=[c for c in plan['training'] if c['evidenceKind']=='different_inputs_control']
        self.assertTrue(guards)
        for c in guards:
            self.assertEqual(expected(c),'KEEP')
            self.assertTrue(any(x['leftValue']!=x['rightValue'] for x in c['observations']))

    def test_corrupted_observation_and_mutated_split_are_rejected(self):
        p=make_plan(fixture_cards());p['training'][0]['observations'][0]['leftValue']='999';p['planHash']=digest({k:v for k,v in p.items() if k!='planHash'})
        with self.assertRaisesRegex(ValueError,'Incorrect witness'):validate_plan(p)
        p=make_plan(fixture_cards());p['heldout'][0]['split']='training';p['planHash']=digest({k:v for k,v in p.items() if k!='planHash'})
        with self.assertRaises(ValueError):validate_plan(p)

    def test_prompt_never_contains_reward_truth_or_teacher_replacement(self):
        p=make_plan(fixture_cards())
        for case in p['training']+p['heldout']:
            text=str(decision_prompt(case))
            for marker in ['knownExactIdentity','expectedAction','observedReward','teacherWrittenReplacement','sourceReadback']:
                self.assertNotIn(marker,text)
            self.assertNotIn("'rewarded'",text);self.assertNotIn("'zero_reward'",text)

    def test_student_check_prompt_contains_input_not_program_output(self):
        case=make_plan(fixture_cards())['sourceReadback'][0]
        p=numerical_prompt(case,case['observations'][0],'right')
        self.assertNotIn('189225',str(p));self.assertEqual(p[-1]['content'],'435^2')


class MemoryTests(unittest.TestCase):
    def test_wrong_rule_kept_when_student_selects_keep_no_oracle_override(self):
        card=fixture_cards()[0];m=apply_action(initial(card),fixture_decision(card,'KEEP'))
        self.assertFalse(m['universalClaimWithdrawn']);self.assertEqual(len(retrieve(m)),1)

    def test_correct_rule_is_still_deleted_if_student_errs_and_false_alarm_is_visible(self):
        card=fixture_cards()[3];m=apply_action(initial(card),fixture_decision(card,'RETRACT'))
        self.assertTrue(m['universalClaimWithdrawn']);self.assertEqual(retrieve(m),[])

    def test_withdrawal_is_persistent_and_does_not_erase_old_raw_claim(self):
        card=fixture_cards()[0];m=apply_action(initial(card),fixture_decision(card))
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'memory.json';put_once(p,m);loaded=read(p)
            self.assertEqual(retrieve(loaded),[]);self.assertEqual(loaded['card']['right'],card['right'])
            _,messages=followup_prompt(loaded,'q');self.assertNotIn(card['right'],str(messages))

    def test_student_prose_is_saved_unmodified_without_becoming_certified_math(self):
        card=fixture_cards()[0];m=apply_action(initial(card),fixture_decision(card))
        r=fixture_raw('I withdraw the universal claim. I do not yet know the replacement.')
        new=attach_reflection(m,r)
        self.assertEqual(new['studentWrittenText'],raw(r));self.assertEqual(new['version'],2)
        self.assertFalse(new['studentWrittenTextSemanticallyCertified']);self.assertEqual(retrieve(new),[])

    def test_already_withdrawn_rule_is_not_reactivated_by_keep(self):
        card=fixture_cards()[0];m=apply_action(initial(card),fixture_decision(card));m=apply_action(m,fixture_decision(card,'KEEP'))
        self.assertEqual(retrieve(m),[])

    def test_another_card_or_oracle_chosen_edit_is_rejected(self):
        card=fixture_cards()[0];d=fixture_decision(fixture_cards()[1])
        with self.assertRaises(ValueError):apply_action(initial(card),d)
        d=fixture_decision(card);d['expectedActionSuppliedToModel']=True;d['hash']=digest({k:v for k,v in d.items() if k!='hash'})
        with self.assertRaises(ValueError):apply_action(initial(card),d)

    def test_tampered_memory_is_not_read_or_retrieved(self):
        m=initial(fixture_cards()[0]);m['status']='withdrawn_as_universal'
        with self.assertRaises(ValueError):retrieve(m)


class PolicyAndAuditTests(unittest.TestCase):
    def test_distribution_and_exploration_floor(self):
        p=distribution([-1000.,0.],.5)
        self.assertAlmostEqual(sum(p['sampling'].values()),1.)
        self.assertGreaterEqual(min(p['sampling'].values()),.25)

    def test_same_state_prompt_seed_gets_same_paired_sample(self):
        self.assertEqual(select([-2.,-3.],112,.5,True),select([-2.,-3.],112,.5,True))
        self.assertEqual(select([-2.,-3.],1,0.,False)[0],'KEEP')

    def test_numerical_values_must_be_written_and_correct_not_filled_by_host(self):
        self.assertTrue(numerical_audit('3*(0)','0',fixture_raw('3 * 0 = 0'))['correct'])
        self.assertFalse(numerical_audit('435**2','189225',fixture_raw('435**2'))['correct'])
        self.assertFalse(numerical_audit('3*(0)','0',fixture_raw('3 * 0 = 3'))['correct'])
        self.assertFalse(numerical_audit('3*(0)','0',fixture_raw('0',True))['correct'])

    def test_correct_number_spellings_are_accepted_without_computing_unevaluated_answers(self):
        for written in ('0.0','(0)','-0.0','0e0','0/1'):
            self.assertTrue(numerical_audit('3*0','0',fixture_raw(written))['correct'],written)
        self.assertTrue(numerical_audit('435**2','189225',fixture_raw('1.89225e5'))['correct'])
        self.assertFalse(numerical_audit('3*0','0',fixture_raw('3*0'))['correct'])
        self.assertFalse(numerical_audit('3*0','0',fixture_raw('Answer: 1\nAnswer: 0'))['correct'])

    def test_true_final_with_false_intermediate_is_not_counted_as_math_repair(self):
        t=dict(expression='435*v*v',scope='real_polynomial')
        self.assertFalse(math_audit(t,fixture_raw('435*v*v = 435**2 = 435*v**2'))['correct'])
        self.assertTrue(math_audit(t,fixture_raw('435*v*v = 435*v**2'))['correct'])

    def test_expression_only_answer_is_not_penalized_for_having_no_equality_chain(self):
        t=dict(expression='435*v*v',scope='real_polynomial')
        a=math_audit(t,fixture_raw('435*v**2'))
        self.assertTrue(a['correct']);self.assertTrue(a['correctChangedExpression'])
        copied=math_audit(t,fixture_raw('435*v*v'))
        self.assertTrue(copied['correct']);self.assertFalse(copied['correctChangedExpression'])
        self.assertFalse(math_audit(t,fixture_raw('Unsupported assertion\n435*v**2'))['correct'])

    def test_evidence_seal_detects_modified_student_wording(self):
        r=fixture_raw('0');r['studentOutput']['raw']='1'
        with self.assertRaises(ValueError):check_seal(r)


if __name__=='__main__':unittest.main()
