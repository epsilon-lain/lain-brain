import copy
import unittest
from rr_common import sealed,raw
from rr_cases import make_plan as previous_plan
from rr_test_fixtures import fixture_cards,fixture_raw,fixture_decision
from cf_cases import *
from cf_memory import *


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.cards=fixture_cards();self.p=make_plan(self.cards,previous_plan(self.cards))
        self.c=self.p['sourceReadback'][0]

    def proposal(self,text,capped=False):
        r=fixture_raw(text,capped);r.pop('hash');r['caseCardId']=self.c['card']['id'];return sealed(r)

    def test_fixed_curriculum_and_seen_rule_exclusion(self):
        self.assertEqual((len(self.p['training']),len(self.p['heldout']),len(self.p['sourceReadback'])),(46,24,4));validate_plan(self.p)

    def test_435_witness_is_zero_versus_positive_without_big_number(self):
        self.assertEqual([property_truth(self.c,r) for r in ROLES],['ZERO','POSITIVE','ONCE','TWICE'])

    def test_square_coefficients_do_not_make_same_sign_a_counterexample(self):
        self.assertEqual(ideal_action(self.p['sourceReadback'][1]),'KEEP')

    def test_different_inputs_are_not_a_counterexample(self):
        c=self.p['sourceReadback'][2];self.assertEqual(ideal_action(c),'KEEP')
        self.assertFalse(grounded(c,{r:property_truth(c,r) for r in ROLES}))

    def test_correct_negative_and_double_coefficient_controls(self):
        c=next(c for c in self.p['training'] if c['kind']=='correct_negative');self.assertEqual(property_truth(c,'left_sign'),'NEGATIVE')
        c=next(c for c in self.p['training'] if c['kind']=='correct_double_coefficient');self.assertEqual(property_truth(c,'coefficient_count'),'TWICE')

    def test_actual_wrong_signs_are_not_host_filled(self):
        props={r:property_truth(self.c,r) for r in ROLES};props['left_sign']='POSITIVE'
        self.assertFalse(grounded(self.c,props));self.assertEqual(return_table(self.c,'after',props),{'KEEP':0.,'RETRACT':-1.})
        text=memory_prompt(self.c,props)[1]['content'];self.assertIn('Left at 0: POSITIVE',text);self.assertNotIn('Left at 0: ZERO',text)

    def test_prompts_do_not_contain_teacher_numeric_answers_or_new_formula(self):
        text='\n'.join(x['content'] for r in ROLES for x in property_prompt(self.c,r))
        self.assertNotIn('189225',text);self.assertNotIn('435 * v**2',text)
        props={r:property_truth(self.c,r) for r in ROLES}
        self.assertNotIn('435 * v**2','\n'.join(x['content'] for x in repair_prompt(self.c,props,'RETRACT')))

    def test_focus_schedule_visits_every_non_target_case(self):
        cs=[c for c in self.p['training'] if ideal_action(c)=='RETRACT'];target=cs[-1]
        for every in (2,3):self.assertEqual({c['id'] for c in cs},{focused_case(n,cs,target,every)['id'] for n in range(96)})

    def test_correct_collected_student_formula_is_positive(self):
        a=proposal_audit(self.c,self.proposal('435 * v**2'));self.assertTrue(a['accepted']);self.assertEqual(a['reward'],1.)

    def test_question_copy_and_brackets_are_neutral(self):
        for text in ('435 * v * v','(435 * v * v)'):
            a=proposal_audit(self.c,self.proposal(text));self.assertFalse(a['accepted']);self.assertEqual(a['reward'],0.)

    def test_skip_is_not_positive(self):self.assertEqual(proposal_audit(self.c,self.proposal('SKIP'))['reward'],0.)

    def test_wrong_capped_and_false_intermediate_are_never_positive(self):
        for text,capped in [('435**2',False),('435 * v**2',True),('435 * v * v = 435**2 = 435 * v**2',False)]:
            a=proposal_audit(self.c,self.proposal(text,capped));self.assertFalse(a['accepted']);self.assertLessEqual(a['reward'],0.)

    def test_actual_withdrawal_required_before_replacement(self):
        r=self.proposal('435 * v**2')
        with self.assertRaises(ValueError):attach_proposal(initial(self.c['card']),r,proposal_audit(self.c,r))

    def test_tampered_proposal_audit_is_rejected(self):
        m=apply_action(initial(self.c['card']),fixture_decision(self.c['card']))
        r=self.proposal('435**2');a=proposal_audit(self.c,r);a['accepted']=True
        with self.assertRaises(ValueError):attach_proposal(m,r,a)

    def test_student_text_is_saved_but_does_not_replace_checked_slot(self):
        m=apply_action(initial(self.c['card']),fixture_decision(self.c['card']))
        r=self.proposal('435 * v**2');m=attach_proposal(m,r,proposal_audit(self.c,r))
        m=attach_reflection(m,fixture_raw('Bad prose: all variables are constants.'))
        self.assertEqual(active_note(m)['right'],'435 * v**2');self.assertFalse(m['studentWrittenTextSemanticallyCertified'])

    def test_no_note_ablation_really_removes_the_rule(self):
        task,prompt=followup(initial(self.c['card']),'q',no_note=True)
        self.assertNotIn('435^2',prompt[1]['content']);self.assertIn('435 * q * q',task['expression'])


if __name__=='__main__':unittest.main()
