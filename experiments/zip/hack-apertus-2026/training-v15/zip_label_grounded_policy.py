"""Weighted replay of the student's exact sampled trajectories, v5.

Imports of the actual tensor runtime happen only inside the training callback.
No output tokens, repairs, selected-tool targets or teacher text are supplied.
"""
import math


def update_weighted_generation(base, adapter, optimizer, responses, advantages, max_tokens):
    if len(responses) != 3 or len(advantages) != 3 or any(
            not math.isfinite(a) or abs(a) > 2 for a in advantages):
        raise ValueError('Three finite separately assigned trajectory credits required')
    if type(max_tokens) is not int or max_tokens <= 0:
        raise ValueError('Fixed positive token denominator required')
    if not any(abs(a) > 1e-12 for a in advantages):
        return dict(updated=False, parameterChanged=False, advantages=list(advantages),
                    reason='all separate trajectory credits are zero')
    import torch
    from zip_generation_policy import response_log_probability
    before = adapter.digest()
    optimizer.zero_grad(set_to_none=True)
    logps = [response_log_probability(base, r) for r in responses]
    replay = [float(lp.detach()) for lp in logps]
    sampled = [r['samplingLogProbability'] for r in responses]
    for actual, saved, response in zip(replay, sampled, responses):
        if not math.isfinite(actual) or abs(actual-saved) > .08*response['generatedTokens']:
            raise RuntimeError('Sampled trajectory differs from policy replay; no optimizer step')
    # One denominator fixed before sampling. A capped or shorter response is
    # neither repaired nor rewarded merely for having a particular length.
    loss = -sum(a*lp for a, lp in zip(advantages, logps))/max_tokens
    if not torch.isfinite(loss):
        raise RuntimeError('Nonfinite weighted policy loss')
    loss.backward()
    if any(p.grad is not None for p in base.parameters()):
        raise RuntimeError('Frozen base received gradients')
    norm = torch.nn.utils.clip_grad_norm_(adapter.parameters_to_train(), 1., error_if_nonfinite=True)
    optimizer.step()
    return dict(updated=True, parameterChanged=before != adapter.digest(), loss=float(loss.detach()),
        gradientNorm=float(norm), advantages=list(advantages),
        replayLogProbabilities=replay, sampledLogProbabilities=sampled,
        constantTokenDenominator=max_tokens, allSampledTokensReplayed=True,
        zeroCreditRowsReceiveNoGradient=True)
