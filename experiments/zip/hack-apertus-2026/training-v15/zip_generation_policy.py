"""Replay precisely the student's sampled response; only new LoRA receives gradients."""
import torch
import torch.nn.functional as F


def prompt_ids(tokenizer,messages,device):
    text=tokenizer.apply_chat_template(messages,tokenize=False,add_generation_prompt=True)
    ids=tokenizer(text,add_special_tokens=False)['input_ids']
    if not 1<=len(ids)<=2048: raise ValueError('Prompt length bound; no silent truncation')
    return torch.tensor([ids],device=device)


def generate_response(base,tokenizer,messages,max_tokens,seed,sampled=True,temperature=.8):
    # Explicit ancestral full-softmax sampling. No hidden top-k/top-p, penalties,
    # grammar completion, supplied answer tokens, or generate() default processors.
    device=next(base.parameters()).device;prefix=prompt_ids(tokenizer,messages,device)
    rng=torch.Generator(device=device).manual_seed(seed)
    eos=base.generation_config.eos_token_id
    if eos is None: eos=tokenizer.eos_token_id
    stops=set(eos if isinstance(eos,list) else [eos])-{None}
    ids=[];logs=[];past=None;next_input=prefix
    with torch.no_grad():
        for _ in range(max_tokens):
            result=base(input_ids=next_input,past_key_values=past,use_cache=True,logits_to_keep=1)
            lp=F.log_softmax(result.logits[0,-1].float()/temperature,dim=-1)
            if not torch.isfinite(lp).all(): raise RuntimeError('Nonfinite generation distribution')
            token=int(torch.multinomial(lp.exp(),1,generator=rng)) if sampled else int(lp.argmax())
            ids.append(token);logs.append(float(lp[token]));past=result.past_key_values
            if token in stops: break
            next_input=torch.tensor([[token]],device=device)
    return dict(raw=tokenizer.decode(ids,skip_special_tokens=True),promptIds=prefix[0].tolist(),generatedIds=ids,
        samplingTokenLogProbabilities=logs,
        generatedTokens=len(ids),sampled=sampled,temperature=temperature,samplingLogProbability=sum(logs),tokenCapReached=len(ids)==max_tokens and ids[-1] not in stops)


def response_token_log_probabilities(base,response):
    if not response['sampled'] or not response['generatedIds']: raise ValueError('Policy update requires a nonempty sampled student response')
    device=next(base.parameters()).device;p=response['promptIds'];g=response['generatedIds']
    ids=torch.tensor([p+g],device=device);targets=torch.tensor([g],device=device)
    logits=base(input_ids=ids,use_cache=False,logits_to_keep=len(g)+1).logits[:,:-1,:].float()/response['temperature']
    if logits.shape[1]!=len(g): raise RuntimeError('Response token alignment differs')
    return F.log_softmax(logits,dim=-1).gather(-1,targets.unsqueeze(-1)).reshape(-1)


def response_log_probability(base,response):
    return response_token_log_probabilities(base,response).sum()


def update_generation(base,adapter,optimizer,responses,reward,baseline,enabled,max_tokens):
    if not enabled or abs(reward-baseline)<1e-12:
        return dict(updated=False,advantage=0. if not enabled else reward-baseline,appliedReward=0. if not enabled else reward,reason='zero-reward control' if not enabled else 'zero advantage')
    before=adapter.digest();optimizer.zero_grad(set_to_none=True)
    logps=[response_log_probability(base,r) for r in responses]
    replay=float(sum(lp.detach() for lp in logps));sampled=sum(r['samplingLogProbability'] for r in responses)
    # Cached sampling versus full-sequence replay can differ slightly on bf16.
    tolerance=.08*sum(r['generatedTokens'] for r in responses)
    if abs(replay-sampled)>tolerance: raise RuntimeError('Sampling/replay policy differs; stopping before optimizer step')
    advantage=reward-baseline
    # One constant denominator for every trajectory, never its selected length.
    loss=-advantage*sum(logps)/max_tokens
    if not torch.isfinite(loss): raise RuntimeError('Nonfinite policy loss')
    loss.backward()
    if any(p.grad is not None for p in base.parameters()): raise RuntimeError('Frozen base received gradients')
    norm=torch.nn.utils.clip_grad_norm_(adapter.parameters_to_train(),1.,error_if_nonfinite=True)
    optimizer.step()
    return dict(updated=True,parameterChanged=before!=adapter.digest(),loss=float(loss.detach()),gradientNorm=float(norm),
        advantage=advantage,appliedReward=reward,replayLogProbability=replay,sampledLogProbability=sampled)
