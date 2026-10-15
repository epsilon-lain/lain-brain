"""Independent q/v LoRA hooks; no mutation, merge, or reuse of old zip state."""
from contextlib import contextmanager
import math
import torch
from torch import nn
from zip_pilot_model import state_digest


class Delta(nn.Module):
    def __init__(self, input_size, output_size, rank, alpha):
        super().__init__()
        self.a=nn.Linear(input_size,rank,bias=False)
        self.b=nn.Linear(rank,output_size,bias=False)
        nn.init.kaiming_uniform_(self.a.weight,a=math.sqrt(5))
        nn.init.zeros_(self.b.weight)
        self.scale=alpha/rank

    def forward(self,x):
        return self.b(self.a(x.float()))*self.scale


class MathWriterAdapter(nn.Module):
    def __init__(self,base,rank=8,last_layers=4,alpha=16):
        super().__init__()
        if not 1<=rank<=32 or not 1<=last_layers<=8: raise ValueError('Adapter bounds')
        self.base=base;self.base.eval().requires_grad_(False)
        self.base.gradient_checkpointing_disable()
        self.enabled=True;self.rank=rank;self.alpha=alpha
        self.deltas=nn.ModuleDict();self.hooks=[];self.targets=[]
        device=next(base.parameters()).device
        layers=base.model.layers
        try:
            for index in range(max(0,len(layers)-last_layers),len(layers)):
                for projection in ['q_proj','v_proj']:
                    layer=getattr(layers[index].self_attn,projection)
                    if not isinstance(layer,nn.Linear): raise ValueError('Need unquantized linear q/v projections')
                    key=f'layer_{index}_{projection}'
                    delta=Delta(layer.in_features,layer.out_features,rank,alpha).to(device)
                    self.deltas[key]=delta
                    self.targets.append(dict(key=key,layer=index,projection=projection,
                        inFeatures=layer.in_features,outFeatures=layer.out_features))
                    self.hooks.append(layer.register_forward_hook(self._make_hook(key)))
        except BaseException:
            self.close();raise

    def _make_hook(self,key):
        def hook(module,args,output):
            if not self.enabled: return output
            return output+self.deltas[key](args[0]).to(output.dtype)
        return hook

    def train(self,mode=True):
        super().train(mode);self.base.eval();return self

    def parameters_to_train(self): return list(self.deltas.parameters())

    def learned_state(self):
        return {k:v.detach().cpu().contiguous().clone() for k,v in self.deltas.state_dict().items()}

    def restore(self,state):
        current=self.deltas.state_dict()
        if set(state)!=set(current) or any(state[k].shape!=current[k].shape or not torch.isfinite(state[k]).all() for k in current):
            raise ValueError('Invalid adapter state')
        self.deltas.load_state_dict(state,strict=True)

    @contextmanager
    def active(self,enabled=True):
        old=self.enabled;self.enabled=enabled
        try: yield
        finally: self.enabled=old

    def digest(self): return state_digest(self.deltas)

    def close(self):
        for hook in self.hooks: hook.remove()
        self.hooks=[]
