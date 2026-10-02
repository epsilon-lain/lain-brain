# Laptop GPT baseline runner

`tools/laptop_train.py` performs ordinary next-token training on one device and
exports actual checkpoint hashes, measurements and prediction examples for the
Brain Training Lab. This is the first baseline for the project. It does not yet
propose object definitions, use a teacher, or train from Brain feedback.

## Windows / WSL quick start

The standalone ZIP contains `laptop_train.py`, `model-source.sha256`, this README,
and the Brain repository's license. Extract its files into
`C:\Users\elonl\Desktop\lain-gpt-laptop`. Keep the Python script and SHA256 file
beside each other. The ZIP does not contain model weights or dataset downloads.

The existing WSL environment already has PyTorch and NumPy. Install the remaining
tokenizer dependency from PowerShell:

```powershell
wsl -- /root/lain-training-venv/bin/python -m pip install sentencepiece
```

First inspect the local assets. This performs CPU checkpoint loading, strict model
shape checks and bounded dataset reads, then exits without updates or output files:

```powershell
wsl -- /root/lain-training-venv/bin/python /mnt/c/Users/elonl/Desktop/lain-gpt-laptop/laptop_train.py --project /mnt/c/Users/elonl/parameter-golf --inspect
```

Expected output includes `status: preflight_ok`, the actual model configuration,
parameter count, snapshot token counts and CUDA availability. An error stops the
run; resolve its named missing asset or mismatch before training. Do not change
the source hash to bypass a mismatch.

After the inspection succeeds, this command starts a short GPU run:

```powershell
wsl -- /root/lain-training-venv/bin/python /mnt/c/Users/elonl/Desktop/lain-gpt-laptop/laptop_train.py --project /mnt/c/Users/elonl/parameter-golf
```

The terminal prints the unique output folder when finished. In the existing test
vault, open **Lain Brain: Open Training Lab** and import only `round-001.json`,
then `round-002.json` if present, in order. These are baseline records, so zero
accepted objects is expected. Do not import the manifest or evaluation JSON as a
round. The existing plugin installation already supports these records.

## Assets and initialization

| Asset | Default within `--project` |
| --- | --- |
| Reviewed model definitions | `train_gpt.py` |
| Unquantized weights | `final_model.pt` |
| SentencePiece tokenizer | `data/tokenizers/fineweb_1024_bpe.model` |
| Training shards | `data/datasets/fineweb10B_sp1024/fineweb_train_*.bin` |
| Validation shards | `data/datasets/fineweb10B_sp1024/fineweb_val_*.bin` |

If default shard folders are absent, discovery also searches under `data` for
those same filenames. `--checkpoint`, `--tokenizer`, `--train-glob` and
`--eval-glob` can select explicit assets. Quote paths and glob patterns.

The script loads the weights with `weights_only=True`, infers layer and head
counts from their tensors, and uses strict state loading. The raw upstream
checkpoint does not encode RoPE base or logit softcap: the runner assumes the
reviewed defaults (10000 and 30) and records this assumption in its manifest.
Checkpoint tensor shapes cannot establish that its earlier training used these
defaults, or that its tokenizer has the same token meanings. Use assets from the
same original experiment. Vocabulary size and token ID ranges are checked.

Each run starts a **fresh AdamW optimizer**. This continues from existing model
weights, not the original Muon optimizer state. The saved checkpoints contain
weights, model configuration and step count; they do not contain optimizer or
random-generator states for exact continuation. `--init random` explicitly
starts a separate four-layer, width-128 GPT with the local tokenizer. It never
silently falls back to random initialization.

Only eight model definitions are extracted from the reviewed source by AST;
the upstream entry point, optimizer and environment configuration are not run.
The complete source is SHA256 checked after newline normalization against
`model-source.sha256`. Keep the original Parameter Golf license and notices with
your original project; its source is not redistributed in this bundle.

## Limits, measurements and outputs

Defaults are 20 optimizer updates, context length 128, microbatch size 1,
two gradient accumulation passes, learning rate 0.0001, and a report every
10 updates. Training uses at most the first 65536 training tokens; validation
uses a separate snapshot of at most 4096 tokens. Training and validation file
overlap, identical snapshots, malformed shard headers and out-of-range IDs are
rejected. No dataset is downloaded or fabricated when assets are missing.

The 120-second limit counts training computation and checks between updates.
It excludes setup, evaluation and checkpoint writing; it is not a whole-process
wall-clock deadline and can exceed the limit by one update. If it stops between
report intervals, a final partial round is saved. `--max-seconds 0` disables this
compute-time limit. Changes to run settings should use separate runs.

CUDA is required by default and unavailable CUDA stops the run. GPU training uses
FP32 parameters and BF16 autocast when supported, otherwise FP32. There is no
distributed training, `torch.compile`, or checkpoint quantization. The small
batches are intended for a laptop; actual GPU compatibility and peak memory
still require a run on the user's hardware. `--device cpu` is available for tests.

| Output in `laptop_runs/gpt-laptop-<id>/` | Meaning |
| --- | --- |
| `manifest.json` | Source, runner, tokenizer and initial weight hashes, configuration, snapshot provenance, versions and assumptions |
| `train.tokens.u16`, `eval.tokens.u16` | Exact little-endian token snapshots used by the run |
| `before.json` | Validation score before any updates |
| `checkpoint-NNN.pt` | New weights, configuration and cumulative update count |
| `evaluation-NNN.json` | Validation loss, next-token accuracy and evaluated token count |
| `round-NNN.json` | Brain-compatible baseline record referencing the actual checkpoint and snapshot hashes |

Validation uses four fixed non-overlapping prefix windows by default. Its accuracy
is teacher-forced next-token accuracy, not free text generation, full-corpus
accuracy or the competition's official BPB. `trainLoss` is the cumulative mean
of batch losses over the run; `steps` and `trainSeconds` are cumulative too.
`peakVramMb` measures PyTorch peak allocated CUDA memory, not all GPU memory.
Two training and two validation contexts each report one predicted next token.
Validation targets are not used for gradient updates. This is a learning
experiment, not evidence of improvement; 20 updates may leave validation worse.

Original files are read only. New runs receive unique folders, and an existing
`--out` directory is rejected. Interrupted runs may leave partial output; import
only complete consecutively numbered round JSON files. The Brain plugin checks
the report's schema and consistency; it does not independently open and verify
the external checkpoint or snapshot files. Its history currently holds 128 rounds.

## Verification

The smoke test uses the actual reviewed GPT definitions with a small CPU model,
a locally generated tokenizer and synthetic token shards. It checks agreement
between the original training loss and extracted logits, causal prefix behavior,
read-only inspection, three actual weight updates across two reports, checkpoint
reload, file hashes, preservation of original assets, invalid input rejection,
and import through the actual TypeScript Brain parser. These fixtures are not
the user's FineWeb training result.

```bash
npm ci
python tests/laptop-train.test.py --source /path/to/reviewed/train_gpt.py
```

Verified here with Python 3.12, PyTorch 2.10.0+cpu, NumPy 2.5.2 and SentencePiece
0.2.2. The user's Python 3.14 / PyTorch 2.11.0+cu128 / RTX 4070 combination has
passed a separate basic CUDA backward check; this runner's GPU execution remains
to be verified on that machine.
