# Laptop Training Lab v0

This adds the **Brain-side exchange and object library** for the laptop-training
experiment. The separate [laptop GPT runner](./LAPTOP_TRAINING.md) now exports
ordinary next-token baseline records. A separate [automatic runner](./AUTO_TRAINING.md)
now uses a trained small GPT reviewer and feeds Brain feedback into external
training. There is no weight training inside this plugin or measured claim of
speedup, lower VRAM, higher accuracy or autonomous improvement.

## Try the implemented loop

1. Build/install this branch using the README instructions, then reload Obsidian.
2. Open the command palette and choose **Lain Brain: Open Training Lab**.
3. Choose `examples/training-lab/round-01.instrument.json` and click
   **导入并验证这一轮**. Alternatively, the **载入合成示例** button fills the editor
   with this synthetic round; loading alone does not save anything.
4. Import `round-02.instrument.json` into the same run. It defines `f(f(x))`
   using the first round's accepted `f(x) = 2x + 1`. The local checker derives
   `4x + 3` and compares it to an independent reference without object calls.
5. Click **导出对象库供下一轮训练**. The new JSON under
   `Lain Brain Training Exports/` contains definitions, canonical forms,
   provenance and the exact round boundary. A subsequent trainer can interpret
   these expressions directly. It must check `sourceKind`; instrument examples
   are not experimental training evidence.
6. Reload the plugin and reopen the lab: both rounds remain available. Use
   **导出完整历史备份** to preserve the normalized inputs. There is currently no
   history-backup import or archive/delete UI.

Repeated round imports are rejected, rather than overwriting history. To repeat
the walkthrough, use a new `runId` consistently in both example files.

## Local storage and authority

The plugin stores the history separately from ordinary settings in
`<vault-config-dir>/plugins/lain-brain/training-lab.json` (using the installed
manifest directory when supplied). No personal ConceptNode, definition,
SemanticDelta, chat message or proof state is changed. Exports are newly created
JSON files; existing files are not overwritten. They contain no provider keys.

One repository instance serializes imports across lab windows and re-reads the
stored history for each operation. Storage errors surface in the lab. Malformed
history is not silently reset: preserve the original file and repair/restore it
before importing again. Normalized input snapshots are frozen in memory; reload
recomputes verification instead of trusting stored `verified` flags.

## Round format

The examples are complete, executable protocol fixtures. Required top-level
fields are:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Exactly `1` |
| `kind` | `training` for trainer reports; `instrument` for synthetic fixtures |
| `runId`, `round` | Stable experiment ID; consecutive round numbers starting at 1 |
| `recordedAt` | Canonical UTC timestamp, e.g. `2026-10-01T00:00:00.000Z` |
| `student` | Model name, parameter count (1–100 million), checkpoint SHA256 |
| `dataset` | Distinct training/evaluation snapshot SHA256 digests |
| `config` | `mode`, device description and nonnegative integer seed |
| `measurements` | Cumulative `steps`; reported `trainLoss`, `trainSeconds` (the supplied runners use cumulative update time); optional `peakVramMb`, `evalAccuracy` |
| `predictions` | Up to 32 input/target/prediction examples, each marked `train` or `eval`; empty predictions are preserved |
| `candidates` | Up to 16 proposed objects with ID, label, definition and a training reference; optional teacher report |

Checkpoint/dataset digests and all training measurements are **reported by the
imported file**, not independently verified against weights, data or a GPU.
Reported accuracy is not recomputed from these sampled predictions. Declaring
`kind: training` is not proof that parameter updates happened. The trainer must
later supply actual artifacts and reproducible evaluation. Brain costs and
teacher costs must be measured separately before any efficiency comparison.

A run freezes kind, model identity/size, dataset digests, mode, device and seed.
Round numbers and cumulative steps increase; timestamps cannot move backwards.
Candidate IDs cannot be reused, even after rejection. A revised object gets a
new ID; its earlier snapshot and all old dependencies remain intact. Different
experimental conditions use separate run IDs. Labels are display text and never
resolve object identity. No objects are shared across runs in v0.

### Callable definitions

The domain is one rational-valued input `x`, with definitions of the form
`a*x + b`, where `a` and `b` are rational numbers. An expression is one of:

```json
{"op": "x"}
{"op": "const", "value": "1/3"}
{"op": "add", "left": {"op": "x"}, "right": {"op": "const", "value": "1"}}
{"op": "scale", "factor": "2", "body": {"op": "x"}}
{"op": "call", "objectId": "double-plus-one", "argument": {"op": "x"}}
```

Rationals use integer or `numerator/denominator` strings (positive denominator,
no decimals/exponents); they are normalized using exact BigInt arithmetic. No
Python/JavaScript code, file paths, network access or arbitrary execution is
supported. Call arguments can be expressions, so objects can be composed.

Each candidate's independent `reference` has `taskId`, `split: "train"`, and a
definition in the same language **without object calls**. The reference is
supplied by the trainer; equivalence to it does not certify its correctness,
its membership in a hashed dataset, or its natural-language interpretation.
Evaluation references cannot be declared as candidate evidence. A dishonest
trainer could still mislabel data; the future data pipeline must enforce the
actual split. Sampled evaluation predictions are never included in object
exports.

### Verification and acceptance are distinct

The checker symbolically reduces each expression to its exact rational slope
and intercept. Equal pairs prove equivalence **for every rational input** to
the supplied reference within this limited language. This is stronger than
matching a few examples, and narrower than verifying arbitrary meanings.

| Mode | Object acceptance rule |
| --- | --- |
| `baseline` | No candidates enter an exported object library |
| `brain_objects` | Exact local equivalence AND a reported teacher `approve` |
| `teacher_free` | Exact local equivalence; teacher report is not an acceptance gate |

Teacher fields are `model`, `decision` (`approve`, `reject`, `uncertain`) and
`rationale`. A reported teacher's approval cannot override failed verification.
In `brain_objects`, missing/uncertain reviews remain `awaiting_teacher`;
rejected reviews remain rejected. `teacher_free` removes the teacher gate, not
the local checker. These rules do not constitute an independent live AI review.

Calls may reference only accepted objects from **earlier rounds of the same
run**. Self/cyclic/forward/same-round/cross-run references and references to
rejected objects fail. Objects carry their originating round and checkpoint
digest. No graph edge weights, learned routing vectors or free-form object
discovery are implemented yet; the external model will learn selection and
composition, while Brain holds the library and evidence.

### Bounds and errors

Per-round input is limited to 2 MiB; history to 8 MiB and 128 rounds. Each
expression allows at most 128 nodes and depth 24. Input rational strings allow
128 characters; intermediate normalized integers allow 4096 characters.
Unknown fields/schema versions, unsafe IDs, malformed hashes, non-finite
measurements, duplicated IDs and changing run configuration reject an import.
Valid proposals which differ mathematically or use unavailable objects are
preserved in history as rejected candidates. They are excluded from exports.

## Baseline runner and next experiment

`tools/laptop_train.py` reuses the user's reviewed Parameter Golf model and local
data, performs short single-device optimizer updates, saves new checkpoints,
and exports baseline records accepted by this plugin. See
[LAPTOP_TRAINING.md](./LAPTOP_TRAINING.md) for inspection, execution, assumptions,
measurement definitions and the CPU integration test. This language-model
baseline does not yet generate affine objects or consume the object library.

The [first definition-prediction runner](./OBJECT_TRAINING.md) now trains a
separate small GPT to predict bounded affine coefficients from example pairs.
It exports actual model proposals with training-only references for this
checker's `teacher_free` gate, including wrong predictions. It does not consume
the resulting library or implement a live teacher. Its held-out input-combination
evaluation is not a comparison with the FineWeb language-model baseline.

The subsequent composition/feedback experiment still needs a trainer that:

1. Generates and freezes a synthetic affine-task dataset, with composition
   templates held out from training and independently recorded hashes.
2. Runs a genuine small-model baseline with optimizer steps and saves weights.
3. Reports real loss, predictions, elapsed time and peak VRAM as `kind: training`.
4. Imports Brain's object manifest and trains selection/composition of callable
   definitions rather than only generating a whole expression.
5. Proposes candidate definitions and obtains a local teacher review in the
   `brain_objects` condition; the teacher must not see held-out answers.
6. Compares baseline, Brain with teacher and teacher-free conditions under equal
   budgets, accounting for library lookup, verification and teacher costs.

The plugin's [automatic data exchange](./AUTO_TRAINING.md) responds to external
requests in the fixed test-vault queue, using the same history repository as
manual imports. The plugin does not start background training or call paid providers. The
external runner starts GPU work only when explicitly invoked without `--inspect`.
General semantic proof and personal-note mutation remain outside this experiment.

## Checks

The modal shows the selected filename and puts progress/success/error feedback
above the JSON editor. Import success and operation failures also display an
Obsidian notification. Selecting a file only fills the editor; click the import
button to save. `before.json` and `evaluation-*.json` are score summaries; select
the complete `round-001.json`, followed by `round-002.json`, instead. Duplicate
or out-of-order imports are rejected while keeping the existing history.

`npm run test:training-lab` exercises two-round import/composition/export/reload,
an independent interpreter, exact rational arithmetic, teacher-approved wrong
definitions, dependency gates, malformed input and resource limits, frozen run
metadata, concurrent imports, storage failures, corrupt-history preservation,
and the Obsidian-facing modal using an API/DOM shim. It does not constitute a
live Obsidian or GPU test. `npm run build` performs TypeScript checking and
builds the installable plugin artifact.
