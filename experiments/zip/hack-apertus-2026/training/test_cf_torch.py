"""Actual tiny-model gradient tests, never actual student evidence."""
import copy
import unittest
import test_rr_torch as tiny
from rr_common import sealed
from cf_policy import scores,probabilities,expected_update,editor_update,sequence_log_probability


@unittest.skipIf(tiny.torch is None,'Torch unavailable here; mandatory in original Notebook')
class RealConditionalGradientTests(unittest.TestCase):
    def setUp(self):
        self.t=tiny.RealTinyGradientTests();self.t.setUp();self.b=self.t.base;self.actor=self.t.actor
        self.targets={'ZERO':[5,15],'POSITIVE':[6,7,15],'NEGATIVE':[8,9,10,15]}
    def tearDown(self):self.t.tearDown()
    def row(self,control=False):
        actor=self.t.control if control else self.actor
        with self.t.context(control),tiny.torch.no_grad():v=[float(x) for x in scores(self.b,[1,2,3],self.targets)]
        return sealed(dict(recordId='tiny-only',caseSplit='training',fixtureOnly=False,adapterHash=actor.digest(),
            expectedActionSuppliedToModel=False,promptIds=[1,2,3],candidateTokens=self.targets,probabilities=probabilities(v,list(self.targets))))
    def test_three_masked_options_match_individual_causal_scores(self):
        from rr_policy import option_log_probability
        with self.t.context(),tiny.torch.no_grad():
            actual=scores(self.b,[1,2,3],self.targets)
            expected=tiny.torch.stack([option_log_probability(self.b,[1,2,3],v)/len(v) for v in self.targets.values()])
        self.assertTrue(tiny.torch.allclose(actual,expected,atol=1e-6,rtol=1e-6))
    def test_expected_return_changes_only_new_parameters(self):
        r=expected_update(self.b,self.actor,self.t.optimizer,[self.row()],[{'ZERO':1.,'POSITIVE':-1.,'NEGATIVE':-1.}],self.t.context,(self.t.writer,self.t.repair,self.t.control))
        self.assertTrue(r['parameterChanged']);self.assertGreater(r['gradientNorm'],0.);self.t.assert_frozen()
    def test_zero_reward_never_steps_or_populates_optimizer(self):
        before=self.t.control.digest()
        r=expected_update(self.b,self.t.control,self.t.control_optimizer,[self.row(True)],[{'ZERO':1.,'POSITIVE':-1.,'NEGATIVE':-1.}],lambda:self.t.context(True),(self.t.writer,self.t.repair),zero=True)
        self.assertFalse(r['optimizerStep']);self.assertEqual(before,self.t.control.digest());self.assertFalse(self.t.control_optimizer.state)
    def test_heldout_or_wrong_on_policy_scores_cannot_step(self):
        for field,value in [('caseSplit','heldout'),('probabilities',{'ZERO':1.,'POSITIVE':0.,'NEGATIVE':0.})]:
            d=self.row();d.pop('hash');d[field]=value;before=self.actor.digest()
            with self.assertRaises(ValueError):expected_update(self.b,self.actor,self.t.optimizer,[sealed(d)],[{'ZERO':1.,'POSITIVE':-1.,'NEGATIVE':-1.}],self.t.context,(self.t.writer,self.t.repair,self.t.control))
            self.assertEqual(before,self.actor.digest());self.assertFalse(self.t.optimizer.state)
    def proposals(self):
        rows=[]
        with self.t.context(),tiny.torch.no_grad():lp=float(sequence_log_probability(self.b,[1,2,3],[5,15],.8))
        for i in range(2):rows.append(sealed(dict(recordId='tiny-proposal-'+str(i),caseSplit='training',fixtureOnly=False,binding=dict(adapterHash=self.actor.digest()),studentOutput=dict(sampled=True,originalTextRepaired=False,promptIds=[1,2,3],generatedIds=[5,15],temperature=.8,samplingLogProbability=lp))))
        return rows
    def test_real_sequence_reward_changes_only_editor_parameters(self):
        r=editor_update(self.b,self.actor,self.t.optimizer,self.proposals(),[1.,1.],self.t.context,(self.t.writer,self.t.repair,self.t.control))
        self.assertTrue(r['parameterChanged']);self.assertTrue(r['optimizerStep']);self.t.assert_frozen()
    def test_sequence_replay_mismatch_and_zero_signal_do_not_step(self):
        rows=self.proposals();rows[1].pop('hash');rows[1]['studentOutput']['samplingLogProbability']+=1.;rows[1]=sealed(rows[1]);before=self.actor.digest()
        with self.assertRaises(ValueError):editor_update(self.b,self.actor,self.t.optimizer,rows,[1.,1.],self.t.context,(self.t.writer,self.t.repair,self.t.control))
        self.assertEqual(before,self.actor.digest());self.assertFalse(self.t.optimizer.state)
        r=editor_update(self.b,self.actor,self.t.optimizer,self.proposals(),[0.,0.],self.t.context,(self.t.writer,self.t.repair,self.t.control))
        self.assertFalse(r['optimizerStep']);self.assertFalse(self.t.optimizer.state)


if __name__=='__main__':unittest.main()
