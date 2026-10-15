"""Real tiny-model gradient checks; these are NOT Apertus student results.

The original Notebook must run these with its installed Torch before any student
loading. A machine without Torch can inspect the source and run the pure checks,
but must explicitly report these skips rather than call them gradient evidence.
"""
from contextlib import ExitStack,contextmanager
import math
from types import SimpleNamespace
import unittest
from rr_common import sealed
from rr_policy import ACTIONS,scores,option_log_probability,select,update

try:
    import torch
    from torch import nn
except ImportError:
    torch=None;nn=None


if torch is not None:
    from math_writer_adapter import MathWriterAdapter
    from zip_management_head_budget import state_digest

    class TinyLayer(nn.Module):
        def __init__(self):
            super().__init__()
            self.self_attn=nn.Module()
            self.self_attn.q_proj=nn.Linear(8,8,bias=False)
            self.self_attn.v_proj=nn.Linear(8,8,bias=False)

        def forward(self,x):
            return x+torch.tanh(self.self_attn.q_proj(x)+self.self_attn.v_proj(x))

    class TinyCausal(nn.Module):
        def __init__(self):
            super().__init__()
            self.embedding=nn.Embedding(16,8)
            self.model=nn.Module();self.model.layers=nn.ModuleList([TinyLayer(),TinyLayer()])
            self.head=nn.Linear(8,16,bias=False)
            self.generation_config=SimpleNamespace(eos_token_id=15)

        def gradient_checkpointing_disable(self):pass

        def forward(self,input_ids,attention_mask=None,use_cache=False,logits_to_keep=0,**kwargs):
            x=self.embedding(input_ids)
            if attention_mask is not None:x=x*attention_mask.unsqueeze(-1)
            # Causal context, including distinct prefixes; masked trailing padding
            # cannot alter any preceding position's logits.
            x=x.cumsum(dim=1)/torch.arange(1,x.shape[1]+1,device=x.device).reshape(1,-1,1)
            for layer in self.model.layers:x=layer(x)
            logits=self.head(x)
            if logits_to_keep:logits=logits[:,-logits_to_keep:,:]
            return SimpleNamespace(logits=logits,past_key_values=None)


@unittest.skipIf(torch is None,'Torch unavailable here; mandatory real gradient checks run in the original Notebook')
class RealTinyGradientTests(unittest.TestCase):
    def setUp(self):
        torch.manual_seed(731);torch.set_num_threads(2)
        self.base=TinyCausal().eval().requires_grad_(False)
        self.writer=MathWriterAdapter(self.base,rank=2,last_layers=1,alpha=4)
        self.repair=MathWriterAdapter(self.base,rank=2,last_layers=1,alpha=4)
        self.actor=MathWriterAdapter(self.base,rank=2,last_layers=1,alpha=4)
        self.control=MathWriterAdapter(self.base,rank=2,last_layers=1,alpha=4)
        self.control.restore(self.actor.learned_state())
        for m in (self.writer,self.repair,self.control):
            for p in m.parameters_to_train():p.requires_grad_(False);p.grad=None
        self.optimizer=torch.optim.AdamW(self.actor.parameters_to_train(),lr=.01,weight_decay=0.)
        self.control_optimizer=torch.optim.AdamW(self.control.parameters_to_train(),lr=.01,weight_decay=0.)
        self.targets={'KEEP':[5,15],'RETRACT':[6,7,15]}
        self.frozen=(state_digest(self.base),self.writer.digest(),self.repair.digest())

    def tearDown(self):
        for m in (self.control,self.actor,self.repair,self.writer):m.close()

    @contextmanager
    def context(self,control=False):
        with ExitStack() as stack:
            stack.enter_context(self.writer.active(False));stack.enter_context(self.repair.active(True))
            stack.enter_context(self.actor.active(not control));stack.enter_context(self.control.active(control))
            yield

    def rows(self,control=False):
        actor=self.control if control else self.actor;rows=[]
        with self.context(control),torch.no_grad():
            for index,prefix in enumerate(([1,2,3],[4,2,3])):
                values=[float(x) for x in scores(self.base,prefix,self.targets)]
                action,ps=select(values,seed=19+index,epsilon=.5,sampled=True)
                rows.append(sealed(dict(recordId='tiny-only-'+str(index),caseSplit='training',
                    fixtureOnly=False,sampled=True,reflectionHash=actor.digest(),expectedActionSuppliedToModel=False,
                    promptIds=prefix,candidateTokens=self.targets,action=action,exploration=.5,
                    actionLogProbability=math.log(ps['sampling'][action]))))
        return rows

    def assert_frozen(self):
        self.assertEqual(self.frozen,(state_digest(self.base),self.writer.digest(),self.repair.digest()))
        self.assertTrue(all(p.grad is None for p in self.base.parameters()))
        self.assertTrue(all(p.grad is None for m in (self.writer,self.repair,self.control) for p in m.parameters_to_train()))

    def test_masked_batched_action_scores_match_separate_causal_replays(self):
        with self.context(),torch.no_grad():
            batched=scores(self.base,[1,2,3],self.targets)
            separate=torch.stack([option_log_probability(self.base,[1,2,3],self.targets[a])/len(self.targets[a]) for a in ACTIONS])
        self.assertTrue(torch.allclose(batched,separate,atol=1e-6,rtol=1e-6))

    def test_actual_reward_gradients_change_only_new_reflection_parameters(self):
        before=self.actor.digest();rows=self.rows()
        result=update(self.base,self.actor,self.writer,self.repair,self.optimizer,rows,[1.,-1.],self.context)
        self.assertTrue(result['optimizerStep']);self.assertTrue(result['parameterChanged'])
        self.assertNotEqual(before,self.actor.digest());self.assertGreater(result['gradientNorm'],0.)
        self.assertTrue(self.optimizer.state);self.assert_frozen()

    def test_zero_reward_control_never_steps_or_changes_optimizer_and_weights(self):
        before=self.control.digest();rows=self.rows(control=True)
        result=update(self.base,self.control,self.writer,self.repair,self.control_optimizer,
            rows,[1.,-1.],lambda:self.context(True),zero_reward=True)
        self.assertFalse(result['optimizerStep']);self.assertEqual(result['appliedRewards'],[0.,0.])
        self.assertEqual(before,self.control.digest());self.assertFalse(self.control_optimizer.state)
        self.assert_frozen()

    def test_heldout_decisions_are_rejected_before_any_parameter_update(self):
        rows=self.rows();rows[0].pop('hash');rows[0]['caseSplit']='heldout';rows[0]=sealed(rows[0])
        before=self.actor.digest()
        with self.assertRaises(ValueError):update(self.base,self.actor,self.writer,self.repair,
            self.optimizer,rows,[1.,-1.],self.context)
        self.assertEqual(before,self.actor.digest());self.assertFalse(self.optimizer.state);self.assert_frozen()

    def test_tampered_sampling_mixture_cannot_publish_a_gradient_update(self):
        rows=self.rows();rows[1].pop('hash');rows[1]['actionLogProbability']+=.5;rows[1]=sealed(rows[1])
        before=self.actor.digest()
        with self.assertRaises(ValueError):update(self.base,self.actor,self.writer,self.repair,
            self.optimizer,rows,[1.,-1.],self.context)
        self.assertEqual(before,self.actor.digest());self.assertFalse(self.optimizer.state)
        self.assertTrue(all(p.grad is None for p in self.actor.parameters_to_train()));self.assert_frozen()


if __name__=='__main__':unittest.main()
