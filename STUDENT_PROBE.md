# Pretrained language student development probe

The actual laptop GPT probe returned repeated words or punctuation on all six
prompts for both the 17,059,912 parameter `final_model.pt` and its twenty-update
continuation. Both choice diagnostics were 1/4. This is too little evidence to
diagnose the precise cause; repetition also occurred on ordinary continuations,
not just instructions. Prior supplied training logs showed loss rising from
6.9371 to about 17 during the original short run. The later loss reduction did
not establish usable free generation. This does not evaluate the zip hypothesis.

Select a separately pretrained language student instead of continuing those
weights. This changes the student and tokenizer; it does not convert or reuse the
Parameter Golf weights. Qwen2.5-0.5B-Instruct has a GPT-style decoder architecture,
roughly 0.49B parameters, Chinese support and Apache 2.0 licensing. The pinned
official revision is `7ae557604adf67be50417f59c2c2f167def9a775`.
Official card: https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct

Build with `python tools/build_student_launcher.py --out /path/Probe-LainStudent.ps1`.
Save to Desktop and run a single PowerShell line:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$([Environment]::GetFolderPath('Desktop'))\Probe-LainStudent.ps1"
```

The launcher reuses `/root/lain-training-venv/bin/python` and its working PyTorch.
It installs `transformers==4.57.6` and dependencies into that venv using binary
packages; it does not request the torch extra or install a new PyTorch wheel.
Dependency versions are recorded. It downloads approximately 1GB from official
Hugging Face into `~/lain-student-cache`; future runs reuse this cache. Model
access is anonymous (`token=False`). Only enumerated tokenizer/config/license
files and Safetensors weights are downloaded; remote model code is disabled.
Files are hashed before and after inference. Downloads and packages cost network
traffic/disk space; no paid teacher API or training is used.

CUDA availability and free memory are checked before installation/download.
Inference uses BF16 if supported, otherwise FP32, with eager attention, batch one,
six public development prompts, at most 512 prompt tokens and 128 generated
tokens per prompt. Generation checks a 30-second limit between steps; individual
forward calls can overrun it. Weights are frozen, inference mode is used, and
there is no optimizer. Short-run peak allocated/reserved VRAM is recorded. This
does not measure adapter training memory or prove 8GB training feasibility.

Reports and incremental raw outputs go in a fresh
`parameter-golf/student_runs/student-probe-<id>` folder. Existing old checkpoints,
Obsidian and Brain are untouched. `-ProjectPath`, `-Device cpu` and `-Offline`
are supported. Offline means model files only: missing dependencies still need
installation. Failures stop instead of selecting another model or mirror.

Raw Chinese/English explanations, note-conditioned composition, a counterexample
and an incomplete-proof ledger are shown without automatic correctness scores.
Review responses and actual VRAM before implementing zip training. These prompts
must not become the final unseen test set. Notes in prompts are ordinary text,
not learned neural zips. Apertus teacher integration is still pending.

Validation uses a local tiny Qwen2 causal model through the actual Transformers
loader, tokenizer chat template and generation path, with unchanged tensor/file
checks. This verifies plumbing, not the pretrained model's quality. The native
Windows launcher and laptop CUDA inference remain to be tested by the user.
