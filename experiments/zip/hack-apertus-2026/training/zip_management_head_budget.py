"""Separate setup/compute budgets and preserve the original SHA-256 byte stream."""
import hashlib
import math
import time


class PhaseBudget:
    def __init__(self,setup=1200,training=600,heldout=600,saving=360,now=None):
        self.now=now or time.monotonic
        self.limits=dict(setup=float(setup),training=float(training),heldout=float(heldout),saving=float(saving))
        if any(not math.isfinite(v) or v<=0 for v in self.limits.values()):raise ValueError('Invalid phase budget')
        self.started=self.now();self.phase='setup';self.phase_started=self.started
        self.deadline=self.started+self.limits['setup'];self.stage='source_admission';self.stage_started=self.started
        self.stages=[];self.phases=[];self.closed=False

    def mark(self,stage):
        if self.closed:raise ValueError('Closed phase ledger')
        now=self.now()
        self.stages.append(dict(stage=self.stage,phase=self.phase,elapsedSeconds=now-self.stage_started))
        self.stage=stage;self.stage_started=now

    def enter(self,phase):
        if phase not in self.limits or self.closed:raise ValueError('Invalid phase transition')
        now=self.now();self.mark(phase)
        self.phases.append(dict(phase=self.phase,elapsedSeconds=now-self.phase_started,budgetSeconds=self.limits[self.phase]))
        self.phase=phase;self.phase_started=now;self.deadline=now+self.limits[phase]
        return self.deadline

    def check(self):
        if self.now()>=self.deadline:raise TimeoutError(self.phase+' phase deadline')

    def finish(self):
        if not self.closed:
            now=self.now();self.mark('finished')
            self.phases.append(dict(phase=self.phase,elapsedSeconds=now-self.phase_started,budgetSeconds=self.limits[self.phase]))
            self.closed=True
        return self.report()

    def report(self):
        return dict(protocol='explicit-head-separate-phase-budgets-v1',phase=self.phase,
            phaseBudgetsSeconds=self.limits,phaseElapsedSeconds=self.now()-self.phase_started,
            totalElapsedSeconds=self.now()-self.started,completedStages=list(self.stages),
            currentStage=self.stage,completedPhases=list(self.phases),closed=self.closed,
            trainingClockStartsAfterModelAndStartWeightChecks=True)


def state_digest(module,torch_module=None,chunk_bytes=1024*1024):
    """Identical names/dtype/shape/raw bytes to frozen zip_pilot_model.state_digest.

    The old function creates a bytes copy for each full tensor. Feed the same
    contiguous uint8 memoryview in bounded slices, without that extra large copy.
    The source's exact expected digest still must match before any generation.
    """
    if torch_module is None:
        import torch as torch_module
    if type(chunk_bytes) is not int or chunk_bytes<=0:raise ValueError('Invalid hash chunk size')
    digest=hashlib.sha256()
    for name,value in sorted(module.state_dict().items()):
        digest.update(name.encode())
        value=value.detach().cpu().contiguous()
        digest.update(str(value.dtype).encode());digest.update(str(tuple(value.shape)).encode())
        array=value.reshape(-1).view(torch_module.uint8).numpy()
        view=memoryview(array)
        for offset in range(0,len(view),chunk_bytes):digest.update(view[offset:offset+chunk_bytes])
    return digest.hexdigest()
