# Lain ZIP — Apertus models and training methods

Public model/training companion for the **Lain Brain** Hack Apertus Track 2B project. The submitted API prototype uses frozen Apertus v1.5 8B/70B; the local learning experiments use **Apertus v1.1 0.5B Instruct** (438,349,352 base parameters). These are separate experiments.

## Contents and current release status

- [Training methodology](TRAINING.md): architecture, optimization, controls and evaluation scope.
- [Model card](MODEL_CARD.md): local adapter format, model identities and limitations.
- [Original v15 mathematical-writing runtime](training-v15/): 180 source modules received from the training Notebook, including the actual v15 loss and recipe. Historical host state is still required for a full continuation.
- [Readable original v24 training modules](training/): 35 files decoded verbatim from the archived v24 runner, including adapter implementation, policy losses, mathematical verifier, transactional checkpoint handling, and tests.
- [Original self-contained v24 runner](train_v24.py) and [source hashes](source-manifest.json).
- [Historical evidence review](historical-evidence-review.md): positive, negative and unavailable observations, with all 113 indexed run directories represented.
- [Checkpoint publication manifest](checkpoint-manifest.json): exact intended source files; **all seven actual adapter files are now available in [models/](models/)**.
- [Small Notebook export](export_model_bundle.py): exports selected adapters, binding metadata and v15 runtime source from the original training host without running training, loading model weights, or making network requests.
- [Single-adapter inference loader](load_adapter.py): uses the original custom hooks; it is not a PEFT loader or the full multicomponent revision pipeline.

No raw API response archives, credentials, user screenshots, base-model weights, or optimizer pickles were added by this publication. The runtime can generate new local evidence when explicitly run in the original environment.

## Check the training implementation without loading Apertus

```bash
cd experiments/zip/hack-apertus-2026/training
python cf_checks.py
```

Tests requiring Torch are skipped when Torch is absent. To require actual tiny-model gradient checks, install the training dependencies and run:

```bash
python cf_checks.py --require-torch
```

Fixtures validate implementation behavior; they are not measurements of student learning. The historical run recorded Python/Torch 2.3.1+cpu, Transformers 4.57.6 and CPU execution. Use a separate environment; installing dependencies is not required to read the code.

## Original training continuation

The runner requires the original reviewed source chain, base snapshot, historical ledgers and adapters under `/mnt/workspace/lain-zip-pilot`. It validates their bindings and refuses mismatches. A fresh clone alone cannot resume the historical experiment.

```bash
python train_v24.py --self-test
# In the original Notebook environment only:
python train_v24.py
```

The second command can resume/start the historical course. Use `--help` first to review budgets. No historical training is started automatically by this repository.

## Available trained checkpoints

The [models/](models/) directory contains seven actual custom safetensors adapters: v15 mathematical writer, scale-course writer, v24 meta, unchanged v24 editor, and frozen repair/reflection dependencies plus a reflection zero-reward control. Every file is 427,440 bytes. Their SHA256 file hashes, independently recomputed tensor-state hashes and original source paths are in [checkpoint-manifest.json](checkpoint-manifest.json).

```bash
cd experiments/zip/hack-apertus-2026
python verify_adapters.py
```

All seven files passed local structure, finite-value and identity checks. This does not replace a real base-model inference test, which has not been run in the publication environment.

## Regenerate the original small export

If GitHub downloads are reset by the Notebook network, paste the entire [offline export cell](export_model_bundle_offline.py) directly into a Notebook cell. It needs no network connection.

Otherwise, in the original training Notebook, run the contents of `export_model_bundle.py`, or save the file and execute:

```python
%run export_model_bundle.py
```

It creates one small `Lain-ZIP-Model-Bundle-*.zip` and displays a download link. It selects four named approximately 417 KiB adapters, plus any directly referenced adapter dependencies inside the original workspace, subject to a total size cap. It does not copy the 0.5B base model or training history archives. Missing checkpoints are reported rather than replaced by fabricated files.

The exported ZIP has now been received and its selected adapters and original runtime sources have been added to this branch. The large base model, tokenizer, optimizer states and complete historical ledgers are not included. Models must retain the licensing and attribution obligations of their original base; the repository's MIT source license does not replace the base-model license.

## Local single-adapter inference

After obtaining the exact original base snapshot and a mathematical-writer adapter:

```bash
python load_adapter.py \
  --base /path/to/Apertus-v1.1-0.5B-Instruct \
  --adapter models/math-writer-v15.safetensors \
  --prompt 'Simplify 3 * (2 * x + 1). Return one expression.'
```

The loader reads local files only and prints a new generated response; it does not certify its truth. Do not use a v24 meta/editor checkpoint as a standalone mathematical writer, or treat this loader as a reproduction of the stacked historical pipeline.

## Submission relationship

This branch preserves the existing Lain Brain repository and adds this companion directory. The complete Track 2B prototype, six-page report and demo are separate submission artifacts. This companion is intended to expose the actual training implementation and clarify checkpoint availability; it does not claim the final submission has already been sent.
