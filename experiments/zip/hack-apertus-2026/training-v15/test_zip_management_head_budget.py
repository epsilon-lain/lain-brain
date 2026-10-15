"""Slow-start regression, phase clocks, and byte-identical bounded hashing."""
import hashlib
import struct
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from zip_management_head_budget import PhaseBudget,state_digest
import zip_management_head_run as runner

HASH_PROBE_NAMES=('hash_probe_float32_values','hash_probe_int64_values',
    'hash_probe_bfloat16_values','hash_probe_empty_values','hash_probe_boolean_scalar')


class BudgetChecks(unittest.TestCase):
    def test_setup_longer_than_old_training_limit_still_gets_full_training_budget(self):
        tick=[0.];clock=PhaseBudget(now=lambda:tick[0])
        tick[0]=901.;clock.check()
        self.assertEqual(clock.enter('training'),1501.)
        tick[0]=1500.9;clock.check()
        tick[0]=1501.
        with self.assertRaisesRegex(TimeoutError,'training'):clock.check()

    def test_setup_is_bounded_and_cannot_start_training_after_expiry(self):
        tick=[0.];clock=PhaseBudget(now=lambda:tick[0]);tick[0]=1200.
        with self.assertRaisesRegex(TimeoutError,'setup'):clock.check()
        self.assertEqual(clock.phase,'setup')

    def test_heldout_and_saving_each_have_separate_time_and_ledger(self):
        tick=[0.];clock=PhaseBudget(now=lambda:tick[0]);tick[0]=900.;clock.mark('model_load')
        tick[0]=901.;clock.enter('training');tick[0]=1000.;self.assertEqual(clock.enter('heldout'),1600.)
        tick[0]=1300.;self.assertEqual(clock.enter('saving'),1660.)
        tick[0]=1500.;row=clock.finish()
        self.assertEqual([x['phase'] for x in row['completedPhases']],['setup','training','heldout','saving'])
        self.assertEqual([x['elapsedSeconds'] for x in row['completedPhases']],[901.,99.,300.,200.])
        self.assertTrue(row['trainingClockStartsAfterModelAndStartWeightChecks'])

    def test_actual_host_flow_survives_simulated_901_second_model_load(self):
        from test_zip_management_head import RuntimeSmokeChecks
        actual=time.monotonic();tick=[actual]
        class SlowLoadBudget(PhaseBudget):
            def mark(self,stage):
                if stage=='math_adapter_restore':tick[0]+=901.
                return super().mark(stage)
        # The existing complete host-flow test asserts all 28 calls, four
        # heldout objects, pause recovery and zero duplicate committed updates.
        # Advance a virtual monotonic clock; no actual waiting/model loading.
        RuntimeSmokeChecks.setUpClass()
        with patch.object(runner.time,'monotonic',side_effect=lambda:tick[0]),patch.object(runner,'PhaseBudget',SlowLoadBudget):
            RuntimeSmokeChecks('test_host_runner_pause_and_exact_prefix_recovery_commit_no_duplicate_updates').test_host_runner_pause_and_exact_prefix_recovery_commit_no_duplicate_updates()


class HashChecks(unittest.TestCase):
    @staticmethod
    def reference(module,torch_module):
        # Original frozen zip_pilot_model.state_digest byte contract.
        digest=hashlib.sha256()
        for name,value in sorted(module.state_dict().items()):
            digest.update(name.encode());value=value.detach().cpu().contiguous()
            digest.update(str(value.dtype).encode());digest.update(str(tuple(value.shape)).encode())
            digest.update(value.reshape(-1).view(torch_module.uint8).numpy().tobytes())
        return digest.hexdigest()

    def test_chunked_digest_matches_old_contract_for_all_chunk_boundaries(self):
        class Tensor:
            def __init__(self,data,dtype,shape):self.data=bytearray(data);self.dtype=dtype;self.shape=shape
            def detach(self):return self
            def cpu(self):return self
            def contiguous(self):return self
            def reshape(self,*a):return self
            def view(self,*a):return self
            def numpy(self):return memoryview(self.data)
        fake_torch=SimpleNamespace(uint8='uint8')
        values={'z-int':Tensor(struct.pack('<qq',-7,99),'torch.int64',(2,)),
                'a-float':Tensor(struct.pack('<ffff',1.25,-0.,float('nan'),-2.5),'torch.float32',(2,2)),
                'scalar':Tensor(b'\x01','torch.bool',()),'empty':Tensor(b'','torch.float32',(0,))}
        module=SimpleNamespace(state_dict=lambda:values)
        expected=self.reference(module,fake_torch)
        for size in (1,3,16,1024*1024):self.assertEqual(state_digest(module,fake_torch,size),expected)
        with self.assertRaises(ValueError):state_digest(module,fake_torch,0)
        # In the original student environment this ALSO exercises actual Torch
        # tensors and their numpy byte views, without loading student weights.
        try:import torch
        except ImportError:return
        actual=torch.nn.Module()
        actual.register_buffer(HASH_PROBE_NAMES[0],torch.arange(15,dtype=torch.float32).reshape(3,5).T)
        actual.register_buffer(HASH_PROBE_NAMES[1],torch.tensor([-1,7],dtype=torch.int64))
        actual.register_buffer(HASH_PROBE_NAMES[2],torch.tensor([.5,-2.],dtype=torch.bfloat16))
        actual.register_buffer(HASH_PROBE_NAMES[3],torch.empty(0))
        actual.register_buffer(HASH_PROBE_NAMES[4],torch.tensor(True))
        self.assertEqual(state_digest(actual,torch,3),self.reference(actual,torch))

    def test_hash_probe_names_cannot_collide_with_module_conversion_methods(self):
        # Run this even when Torch is unavailable locally. The Torch-enabled
        # entry ALSO checks actual nn.Module attributes below.
        known_module_names={'float','half','double','bfloat16','int','type','cpu','cuda','to',
            'train','eval','parameters','buffers','state_dict','register_buffer'}
        self.assertEqual(len(HASH_PROBE_NAMES),len(set(HASH_PROBE_NAMES)))
        self.assertTrue(all(n.startswith('hash_probe_') for n in HASH_PROBE_NAMES))
        self.assertFalse(known_module_names.intersection(HASH_PROBE_NAMES))
        try:import torch
        except ImportError:return
        actual=torch.nn.Module()
        self.assertTrue(all(not hasattr(actual,name) for name in HASH_PROBE_NAMES))

    def test_metadata_and_changed_bytes_still_change_digest(self):
        class Tensor:
            dtype='torch.uint8';shape=(2,)
            def detach(self):return self
            def cpu(self):return self
            def contiguous(self):return self
            def reshape(self,*a):return self
            def view(self,*a):return self
            def numpy(self):return memoryview(b'AB')
        t=Tensor();fake=SimpleNamespace(uint8='bytes');m=SimpleNamespace(state_dict=lambda:{'name':t})
        old=state_digest(m,fake);t.shape=(1,2)
        self.assertNotEqual(state_digest(m,fake),old)
        t.shape=(2,);t.dtype='torch.int8';self.assertNotEqual(state_digest(m,fake),old)
        t.dtype='torch.uint8';t.numpy=lambda:memoryview(b'AC');self.assertNotEqual(state_digest(m,fake),old)


if __name__=='__main__':unittest.main()
