"""Download a pinned pretrained language student and inspect bounded raw outputs.

Inference only. No teacher, optimizer, zip module or automatic capability verdict.
"""
from __future__ import annotations

import argparse
import hashlib
from importlib.metadata import version, PackageNotFoundError
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

MODEL_ID = "Qwen/Qwen2.5-0.5B-Instruct"
REVISION = "7ae557604adf67be50417f59c2c2f167def9a775"
TRANSFORMERS_VERSION = "4.57.6"
FILES = ["config.json", "generation_config.json", "model.safetensors",
         "tokenizer.json", "tokenizer_config.json", "merges.txt", "vocab.json", "LICENSE"]
PROMPTS = [
    ("language_zh", "请用两句话解释图书馆是什么。"),
    ("language_en", "Explain in two short sentences what a library is."),
    ("explanation", "用自己的话解释 y = 2*x + 1 的含义，再给一个具体例子。"),
    ("composition", "笔记A：把输入乘以2。笔记B：把输入加1。输入是3，先用A，再用B。说明每一步。"),
    ("counterexample", "有人说：(x+1)^2 总等于 x^2+1。请给出一个反例，并修正公式。"),
    ("partial_progress", "我们暂时不能完成证明。已知：所有A都是B，所有B都是C；尚不知道是否存在A。请列出能确定的结论、仍未确定的结论和下一步需要的证据。不要把猜测当成证明。"),
]


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def write_json(path, data):
    with Path(path).open("x", encoding="utf-8") as stream:
        json.dump(data, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")


def dependencies(install):
    try:
        installed = version("transformers")
    except PackageNotFoundError:
        installed = None
    if installed != TRANSFORMERS_VERSION:
        if not install:
            raise RuntimeError(f"Need transformers=={TRANSFORMERS_VERSION}; use --install-deps")
        print("Installing pinned Transformers and its dependencies; reusing existing PyTorch.", flush=True)
        subprocess.run([sys.executable, "-m", "pip", "install", "--only-binary=:all:",
                        f"transformers=={TRANSFORMERS_VERSION}"], check=True, timeout=900)


def render(report):
    lines = ["# 预训练学生起点检查", "", "开发诊断：训练更新 0；老师调用 0；zip 模块尚未实现。", "",
             "这些公开提示仅用于开发检查。输出是否正确需要审阅，不能用作最终未见测试。", "",
             f"模型：{report['modelId']}；revision：{report['revision']}",
             f"精度：{report['dtype']}；参数：{report['parameters']:,}；推理显存峰值（allocated）：{report['peakAllocatedMiB']}", "",
             "显存数字仅对应此次短上下文推理，不能当作训练显存。", ""]
    for item in report["outputs"]:
        lines += [f"## {item['kind']}", "", "提示：" + json.dumps(item['prompt'], ensure_ascii=False), "",
                  "原始回答：" + json.dumps(item['response'], ensure_ascii=False), "",
                  f"生成 tokens：{item['generatedTokens']}；结束 token：{item['endedWithEos']}；耗时：{item['seconds']:.2f}s", ""]
    return "\n".join(lines)


def probe(model, tokenizer, out, metadata, device, max_tokens):
    import torch
    model.eval().requires_grad_(False)
    if any(p.requires_grad for p in model.parameters()):
        raise RuntimeError("Student weights were not frozen")
    report = dict(metadata, parameters=sum(p.numel() for p in model.parameters()),
                  trainingUpdates=0, teacherCalls=0, zipImplemented=False,
                  decoding="greedy; unmodified repetition penalty", outputs=[], peakAllocatedMiB=None)
    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()
    for index, (kind, prompt) in enumerate(PROMPTS, 1):
        text = tokenizer.apply_chat_template([{"role": "user", "content": prompt}],
                                             tokenize=False, add_generation_prompt=True)
        inputs = tokenizer(text, return_tensors="pt", return_token_type_ids=False).to(device)
        if inputs.input_ids.shape[1] > 512:
            raise RuntimeError("Diagnostic prompt exceeds 512 tokens")
        started = time.monotonic()
        with torch.inference_mode():
            generated = model.generate(**inputs, do_sample=False, max_new_tokens=max_tokens,
                                       max_time=30.0, use_cache=True,
                                       pad_token_id=tokenizer.eos_token_id)
        ids = generated[0, inputs.input_ids.shape[1]:].tolist()
        eos_ids = model.generation_config.eos_token_id
        if not isinstance(eos_ids, list):
            eos_ids = [eos_ids]
        response = tokenizer.decode(ids, skip_special_tokens=True)
        record = dict(kind=kind, prompt=prompt, response=response, generatedTokenIds=ids,
                      generatedTokens=len(ids), endedWithEos=bool(ids and ids[-1] in eos_ids),
                      seconds=time.monotonic() - started)
        report["outputs"].append(record)
        print(f"PROBE {index}/{len(PROMPTS)} {kind}: {json.dumps(response, ensure_ascii=False)}", flush=True)
        write_json(out / f"probe-{index:03d}.json", record)
    if any(p.grad is not None for p in model.parameters()):
        raise RuntimeError("Unexpected student gradients")
    if device == "cuda":
        report["peakAllocatedMiB"] = torch.cuda.max_memory_allocated() / 1024**2
        report["peakReservedMiB"] = torch.cuda.max_memory_reserved() / 1024**2
    return report


def run(args):
    import torch
    if not args.project.is_dir():
        raise RuntimeError("Project directory does not exist")
    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA unavailable; stopping before download")
    dtype = torch.bfloat16 if args.device == "cuda" and torch.cuda.is_bf16_supported() else torch.float32
    if args.device == "cuda":
        free, total = torch.cuda.mem_get_info()
        minimum = (3 if dtype == torch.bfloat16 else 4) * 1024**3
        print(f"GPU: {torch.cuda.get_device_name(0)}; free VRAM: {free / 1024**3:.2f} GiB", flush=True)
        if free < minimum:
            raise RuntimeError("Insufficient free VRAM for this inference check; close GPU apps or use --device cpu")
    else:
        torch.set_num_threads(min(4, torch.get_num_threads()))
    torch.manual_seed(1337)
    dependencies(args.install_deps)
    os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    from huggingface_hub import snapshot_download
    from transformers import AutoModelForCausalLM, AutoTokenizer
    print("Fetching pinned pretrained student (~1 GB first download); cached files reused.", flush=True)
    snapshot = Path(snapshot_download(MODEL_ID, revision=REVISION, cache_dir=str(args.cache),
                                     allow_patterns=FILES, local_files_only=args.offline,
                                     token=False, max_workers=2))
    if any(not (snapshot / name).is_file() for name in FILES):
        raise RuntimeError("Pinned model snapshot incomplete")
    hashes = {name: digest(snapshot / name) for name in FILES}
    tokenizer = AutoTokenizer.from_pretrained(snapshot, local_files_only=True, trust_remote_code=False)
    model = AutoModelForCausalLM.from_pretrained(snapshot, local_files_only=True, trust_remote_code=False,
                                                use_safetensors=True, dtype=dtype,
                                                attn_implementation="eager").to(args.device)
    if model.config.model_type != "qwen2" or sum(p.numel() for p in model.parameters()) > 600_000_000:
        raise RuntimeError("Unexpected student architecture or size")
    out = args.project / "student_runs" / ("student-probe-" + uuid.uuid4().hex[:12])
    out.mkdir(parents=True, exist_ok=False)
    metadata = dict(modelId=MODEL_ID, revision=REVISION, device=args.device, dtype=str(dtype),
                    snapshotPath=str(snapshot), snapshotSha256=hashes,
                    runnerSha256=digest(__file__), torchVersion=str(torch.__version__),
                    dependencies={key: version(key) for key in
                                  ["transformers", "huggingface-hub", "tokenizers", "safetensors"]},
                    scope="raw development outputs; no automated suitability verdict; not a held-out benchmark",
                    maxNewTokens=args.max_new_tokens, maxTimePerPromptSeconds=30,
                    timingLimit="checked between generation iterations; individual forward pass can exceed it")
    write_json(out / "manifest.json", metadata)
    report = probe(model, tokenizer, out, metadata, args.device, args.max_new_tokens)
    if hashes != {name: digest(snapshot / name) for name in FILES}:
        raise RuntimeError("Student snapshot changed during inference")
    write_json(out / "report.json", report)
    (out / "report.md").write_text(render(report), encoding="utf-8")
    print(f"DONE. Training updates=0; teacher calls=0. Report: {out / 'report.md'}", flush=True)
    if args.device == "cuda":
        print(f"Inference peak allocated VRAM: {report['peakAllocatedMiB']:.1f} MiB", flush=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--project", type=Path, required=True)
    p.add_argument("--cache", type=Path, default=Path.home() / "lain-student-cache")
    p.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
    p.add_argument("--offline", action="store_true")
    p.add_argument("--install-deps", action="store_true")
    p.add_argument("--max-new-tokens", type=int, choices=range(1, 129), default=128)
    run(p.parse_args())
