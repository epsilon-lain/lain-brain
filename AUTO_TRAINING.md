# Automatic local alignment and training

This implements a **bounded supervised loop** on the existing affine task.
Two small GPTs are used: a student and an independently initialized reviewer.
The reviewer predicts coefficients from training input/output pairs. Brain then
requires both model agreement and exact equivalence to the supplied training
reference before accepting an object. The student consumes Brain's feedback
and exported objects in subsequent optimizer updates.

The reviewer is another actual trained 59,144-parameter GPT, not an API wrapper,
handwritten approval rule or language model giving a prose critique. It is
trained with seed 7331 on the same frozen supervised training split, once per
compatible configuration, then cached and frozen. Separate initialization does
not make its errors statistically independent. Disagreement is reported as
`uncertain`. Model agreement cannot override mathematical rejection.

## One download, no manual extraction or round imports

The generated `Start-LainTraining.ps1` contains the plugin and Python tools.
Save it to the Desktop, then run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$([Environment]::GetFolderPath('Desktop'))\Start-LainTraining.ps1"
```

It verifies the embedded package and each file, installs tools into
`Desktop/lain-training-auto`, and installs the plugin into the existing
`Desktop/LainBrainTrainingTest` vault. Changed destination files are backed up
under the tool folder before replacement. History/settings are retained.
The execution-policy setting applies to this process only. Nothing is downloaded,
no provider keys are read by the trainer, and no paid services are invoked.

After the first plugin replacement, **disable/re-enable Lain Brain once** in
Obsidian so its loaded code includes the sync service. Keep this test vault open.
The launcher waits for a Brain handshake before any training updates. Subsequent
runs of the same launcher need no extraction, import or plugin reload when the
installed files already match. Future code releases still need a new launcher;
this is not an unattended software-update service.

The default project is `%USERPROFILE%/parameter-golf`. Paths can be supplied
with `-ProjectPath` and `-VaultPath`. `-Device cpu` selects CPU explicitly;
`-Rounds` accepts 1–8, default 2. GPU availability, the reviewed model-source
hash, vault presence and compatible checkpoint configuration are checked.
No new Python dependency is required beyond the configured PyTorch environment.
The launcher expects its existing `/root/lain-training-venv/bin/python`.

Default behavior:

1. Continue the newest compatible checkpoint directly under an `object-laptop-*`
   or `auto-object-*` run. If none exists, initialize a new random student.
   The selected path/hash is recorded. Optimizer state starts fresh.
2. Connect to Brain. Train/cache an independent reviewer for up to 600 steps.
3. Train the student for 300 steps; submit its 15 fixed training-context
   proposals and real reviewer predictions automatically.
4. Brain verifies/saves the round and returns the accepted library and all
   candidate verdicts. Its mode is `brain_objects`, with the teacher gate enabled.
5. Prioritize the original training tasks rejected/awaiting review by weight 4
   versus 1. Execute the accepted definitions to regenerate training pairs on
   **training-only** input triples. The next round uses these object-derived
   examples for one quarter of each batch, when objects exist.
6. Train/align/import the second round and stop. No indefinite background
   training is started. Cached reviewer weights are reused next time.

The supervised family, input split and fixed AST renderer are the same as
[OBJECT_TRAINING.md](./OBJECT_TRAINING.md). Object-derived examples repeat that
family; this is object rehearsal and feedback-driven replay, **not learned
composition, a new ontology, or unrestricted self-improvement**. No guarantee
of accuracy gains or smaller compute is made. Matched-budget controls and
multiple seeds are needed to measure any benefit of the feedback policy.

## Exchange and persistence

`tools/auto_train.py` writes atomic, data-only requests under the fixed vault
folder `Lain Brain Training Queue`. The plugin checks for pending requests every
1.5 seconds, processes at most four per tick, and replies with a boundary-specific
object library. Queue data is part of the chosen experimental vault, including
when that vault is synced by the user. This prototype assumes one running
Obsidian instance writing that vault's history.

Python **never writes** `training-lab.json`. Automatic imports and the manual
modal share the same `TrainingLabRepository` transaction queue, avoiding competing
history writers. Retry of an identical round is idempotent; different content
at the same run/round is rejected. Repeated rounds cannot advance training.
Responses are atomically renamed into place. Missing Brain, history write
failure, malformed/oversized content, mismatched checkpoints, or incorrect
library boundaries stop further training. The finite timeout defaults to 180s.
The plugin does not launch processes or execute text from requests.

All training outputs go into a new `project/laptop_runs/auto-object-<id>`:
dataset snapshots, manifest, initial/updated weights, evaluations, round reports,
Brain responses, feedback summaries, and object-derived replay snapshots.
The manifest records student initialization and the frozen reviewer checkpoint
hash. Evaluation predictions/targets are absent from the object export and
replay pipeline. Neural review is calculated using only training prompts.

Default cumulative **update-compute** limits are 60 seconds for reviewer
preparation and 60 seconds for student updates. Startup, evaluation, exchange
waits and I/O are outside those limits. The loop is also bounded by round/step
counts; a time cap can overrun by one update. `Ctrl+C` stops the external process.
Creating `STOP` in the current student run folder stops before the next update.
Weights are preserved; optimizer/RNG state is not an exact resume snapshot.
A Linux/WSL process lock prevents overlapping automatic sessions for the same
project, and is released automatically when the process exits. There is no
automatic deletion of historical runs or queue files.

## Checks

```sh
npm run build
npm run test:training-lab
node tests/training-sync.test.mjs
python tests/auto-train.test.py --source /reviewed/train_gpt.py --initial /affine/checkpoint.pt
python tools/build_auto_launcher.py --out /path/to/Start-LainTraining.ps1
```

The service test covers opt-in handshake, mathematical rejection despite teacher
approval, automatic import/export, duplicate/collision handling, exact export
boundaries, and history/reply failure recovery. The CPU integration test uses
the actual trained reviewer and actual TypeScript Brain service hosted by a
test-only filesystem process. Two student optimizer rounds update weights and
the second consumes real exported-object rehearsal examples. It also checks
target-blind review, train-only replay, cached reviewer reuse and disconnect
handling. It is not a live Windows PowerShell, Obsidian or GPU test.
