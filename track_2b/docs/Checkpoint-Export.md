# Export the actual trained student checkpoint

This step runs in the original training Notebook, not the review Docker container. Existing review ZIPs exclude the original 0.5B student's weights.

1. Copy `src/export_checkpoints.py` into the training workspace.
2. Inventory the actual training directory, without loading or uploading any file:

```bash
python export_checkpoints.py --root /mnt/workspace/lain-zip-pilot/zip-conditional-final-a1afc8a6
```

3. Match the checkpoint names to the final committed receipt. Do not select a file merely because its modification time is newest. After selecting the exact relative files, export them with `--files` and `--out`:

```bash
python export_checkpoints.py --root TRAINING_DIRECTORY --files EXACT_RELATIVE_CHECKPOINT --out /mnt/workspace/Lain-ZIP-Student-Checkpoint.zip
```

The two uppercase arguments above are instructions to replace with real paths, not supplied checkpoint names. The exporter only accepts explicitly selected weight/state file extensions inside the chosen directory; it refuses overwrite, computes SHA256 in chunks and preserves bytes without unpickling them. It excludes notebooks, environment files and API credentials.

Retain the matching original loader code, base model revision, tokenizer/configuration and adapter composition. These are custom training checkpoints; a standard PEFT loader, merged-model export or inference compatibility must be verified before claiming them. Historical source is provided in `src/historical-training/`, and the original training environment may still need older modules/checkpoints.

Publication has not occurred. Large weight files can be hosted in a model repository with a model card and linked from GitHub. Clearly separate the actual locally trained student/adapter from frozen 70B API inference. The public model card should report negative results as well as supported behavior.
