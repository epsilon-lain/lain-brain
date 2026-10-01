# Existing GPT diagnostic before the zip experiment

The selected route is **Apertus guides, the local GPT learns**. The teacher is
frozen and produces demonstrations, candidate counterexamples and revisions.
These must be checked before training the student. Future experiments reward
verified modeling progress and cross-zip use, not just terminal answers. This
diagnostic does not implement the teacher or zip architecture.

Build the standalone PowerShell file:

```sh
python tools/build_probe_launcher.py --out /path/Probe-LainGPT.ps1
```

Save it to the Windows Desktop and run one line:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$([Environment]::GetFolderPath('Desktop'))\Probe-LainGPT.ps1"
```

No manual extraction, installation, plugin reload, API key, network download,
or model update is involved. Three hash-checked tool files go into a unique
temporary directory and are removed afterward. The user's existing WSL venv,
PyTorch, NumPy and SentencePiece are reused. PowerShell itself has not been run
in the Linux validation environment; the packaged Python tool is tested there.

The default scans `final_model.pt` and the last numbered checkpoint in up to
nine most recently modified `gpt-laptop-*` language runs. It excludes affine,
automatic affine and reviewer directories. Compatible checkpoints must match
the existing SentencePiece vocabulary. It compares `final_model.pt` with the
newest largest language checkpoint, if distinct; it never selects by diagnostic
performance. Scan coverage is bounded, not a full historical inventory.

Pass `-CheckpointPath` to pin a Windows file, `-ProjectPath` for a different
project, `-Device cpu` to select CPU, or `-Inspect` for a read-only inventory
without inference or reports. It stops if CUDA is unavailable instead of silently
switching to CPU. It only accepts the reviewed `train_gpt.py` source and imports
its eight model definitions, not its training entry point. Checkpoints are
unquantized tensor dictionaries loaded with `weights_only=True`, at most 512MiB
and 100M tensor elements. Raw checkpoints lack some hyperparameters; the reviewed
defaults are used and this assumption is recorded.

Actual execution is inference in FP32, with all parameters frozen. The report
includes six short greedy English continuations, four simple four-way rule
likelihood probes, and a 1,024-token fixed validation prefix if shards exist.
There are no automatic comprehension, suitability, or intelligence thresholds.
The validation sample is small, continuations may be truncated, and instruction
performance does not directly measure a base completion model's language ability.
Candidate suffixes are tokenized separately and ranked by total log likelihood;
suffix lengths are recorded. These are auxiliary development diagnostics, not
formal benchmark results or evidence for zip representations. None of these
prompts may be reused as unseen final research tests.

Reports go into a new `parameter-golf/laptop_runs/gpt-probe-<id>` directory,
including inventory/source/checkpoint/tokenizer hashes and raw outputs. Existing
checkpoints are checked again after inference and never overwritten. Repeated
runs create new directories; Ctrl+C retains partial output. `report.md` is for
human review; `report.json` retains all choice scores and token outputs.

After reviewing the actual laptop outputs, select an appropriate student start,
define a new verifiable partial-progress task, and then implement the learned
zip interface. Teacher-generated text alone does not make zip representations
participate in the student's forward computation. Teacher generation cost,
verification cost and student training cost must all be accounted for; final
student evaluation must operate without live teacher access.
