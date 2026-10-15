"""Local single mathematical-writer inference with the original custom hooks."""
import argparse
from pathlib import Path
import sys


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--base', type=Path, required=True)
    p.add_argument('--adapter', type=Path, required=True)
    p.add_argument('--prompt', required=True)
    p.add_argument('--max-new-tokens', type=int, default=96)
    args = p.parse_args()
    if not args.base.is_dir() or not args.adapter.is_file():
        p.error('Supply the original local base directory and actual safetensors file')
    if not 1 <= args.max_new_tokens <= 512:
        p.error('max-new-tokens must be between 1 and 512')
    import torch
    from safetensors.torch import load_file
    from transformers import AutoModelForCausalLM, AutoTokenizer
    sys.path.insert(0, str(Path(__file__).parent / 'training'))
    from math_writer_adapter import MathWriterAdapter
    tokenizer = AutoTokenizer.from_pretrained(args.base, local_files_only=True, trust_remote_code=False)
    base = AutoModelForCausalLM.from_pretrained(
        args.base, local_files_only=True, trust_remote_code=False,
        torch_dtype=torch.float32, attn_implementation='sdpa')
    base.eval().requires_grad_(False)
    adapter = MathWriterAdapter(base, rank=8, last_layers=4, alpha=16)
    try:
        adapter.restore(load_file(str(args.adapter)))
        adapter.eval()
        ids = tokenizer.apply_chat_template(
            [{'role': 'user', 'content': args.prompt}],
            add_generation_prompt=True, return_tensors='pt')
        limit = getattr(base.config, 'max_position_embeddings', None)
        if isinstance(limit, int) and ids.shape[-1] + args.max_new_tokens > limit:
            raise ValueError('Prompt plus response exceeds configured context; no silent truncation')
        with torch.inference_mode():
            output = base.generate(
                input_ids=ids, attention_mask=torch.ones_like(ids),
                max_new_tokens=args.max_new_tokens, do_sample=False)
        print(tokenizer.decode(output[0, ids.shape[-1]:], skip_special_tokens=True))
    finally:
        adapter.close()


if __name__ == '__main__':
    main()
