# First definition-prediction experiment

The laptop language-model baseline established real GPU updates and Brain report
import. This separate experiment uses the **same reviewed GPT model definitions**
with a new, randomly initialized 59,144-parameter model and a numeric vocabulary.
It learns to predict a bounded function definition from examples. It does not
load the language checkpoint or change the previous training script/plugin.

## What is learned

For three distinct input/output examples, predict the coefficients of
`f(x) = a*x + b`, with `a` in `{-2,-1,0,1,2}` and `b` in `{-1,0,1}`.
Inputs are ordered pairs; the model sees no task ID or coefficient labels in its
prompt. It emits two coefficient tokens autoregressively using a fixed grammar.
Its second prediction sees its **own** first prediction during evaluation.
Training uses supervised coefficient labels and teacher forcing; there is no
teacher AI. The loss averages two grammar-restricted cross-entropies rather than
ordinary FineWeb next-token loss, so the two losses are not comparable.

A fixed renderer converts predicted coefficients into the AST `a*x + b`.
The independently generated training reference uses `a*(x+1) + (b-a)`.
Brain proves exact equivalence over rational inputs, preserving incorrect
proposals as rejected. These AST templates are programmed; the model does not
invent expression syntax or its own ontology. This tests definition prediction
within a specified hypothesis class, not open-ended concept discovery.

The 15 target functions are represented in both splits. Of the 35 unordered
triples from `x = -3..3`, a fixed seed assigns 24 to training and 11 to evaluation.
All six orders of a triple stay in one split for **all** functions. There are
2,160 training contexts and 990 evaluation contexts. This tests held-out input
combinations of known functions; it does not test unseen functions, out-of-range
values or unseen composition structures. Three distinct pairs uniquely identify
an affine function in this domain. The target family is chosen by us.

## Run on the configured Windows / WSL laptop

Extract the standalone package into a new Desktop folder `lain-object-lab`.
It contains `object_train.py`, the existing `laptop_train.py` helper, and the
reviewed-source digest. Existing local PyTorch is sufficient; no model/data
download or additional package installation is needed.

Read-only inspection:

```powershell
wsl -- /root/lain-training-venv/bin/python /mnt/c/Users/elonl/Desktop/lain-object-lab/object_train.py --project /mnt/c/Users/elonl/parameter-golf --inspect
```

Train (600 steps, two rounds, cumulative update-compute cap 60 seconds):

```powershell
wsl -- /root/lain-training-venv/bin/python /mnt/c/Users/elonl/Desktop/lain-object-lab/object_train.py --project /mnt/c/Users/elonl/parameter-golf
```

`--device cpu` selects CPU explicitly. CUDA is the default and an unavailable GPU
stops execution; there is no silent fallback. `--inspect` creates no outputs.
Source hash checking rejects changed `train_gpt.py` before executing definitions.
The original corpus, language-model weights and previous runs remain untouched.

Outputs use a new `parameter-golf/laptop_runs/object-laptop-<id>/` directory:

- `train.tasks.json`, `eval.tasks.json`: exact dataset snapshots with hashes.
- `manifest.json`, `initial.pt`: settings, scope, source/runner/helper hashes,
  versions and initial model weights.
- `checkpoint-*.pt`: actual updated weights, model configuration and step count.
  They do not include optimizer/RNG state for exact training resumption.
- `before.json`, `evaluation-*.json`: conditional coefficient loss and free
  autoregressive exact-definition accuracy. Evaluation covers every frozen
  context. Whole definitions must have **both** coefficients correct.
- `round-001.json`, `round-002.json`: import these into Brain in order.

Each round proposes 15 definitions from the first fixed **training** context per
function, regardless of whether they are correct. No solver repairs predictions,
no best-case proposal selection occurs, and no evaluation target becomes a
candidate reference. Candidate revisions receive new IDs; semantically identical
objects from different rounds remain separate provenance records. Thus Brain's
cumulative object count is not the number of unique discovered functions.

This standalone runner's mode is `teacher_free`: exact equivalence is the acceptance gate. This name
is an existing protocol setting; the experiment starts with supervised labels
and an external deterministic checker. It is **not** evidence of an AI that has
progressed to independent self-training. Teacher integration, object-library
consumption, composition/routing training and autonomous improvement remain
future work for this standalone runner. The separate
[automatic loop](./AUTO_TRAINING.md) now adds a trained reviewer and consumes
Brain's accepted objects for training-only rehearsal and prioritizes rejected
training tasks. It does not yet learn composition.

Compute timing includes updates but excludes evaluation, checkpoint writes and
startup; it is not total execution time. The cap can overrun by one update.
Peak VRAM is PyTorch's peak allocated bytes, excluding reserved memory, driver
and other applications. Do not use these measurements to claim a comparative
speed or memory advantage without a matched task/budget/control experiment.

## Initial CPU observation and reproducible checks

One exploratory FP32 CPU run with seed 1337, fresh AdamW `lr=0.001`, batch 64:

| Cumulative steps | Held-out exact definition accuracy | Correct fixed training proposals |
| --- | --- | --- |
| 0 | 6.67% | Not submitted |
| 300 | 41.82% | 7 / 15 |
| 600 | 53.84% | 10 / 15 |

The final training-context exact accuracy was 80.83%, versus 53.84% held out,
showing a substantial generalization gap. This is a single-seed observation on
a small synthetic family, with substantial remaining errors. It supports
testing the definition-prediction pipeline, not a
claim that hierarchical objects outperform a baseline. Device/library changes
can change the numbers. No GPU result is claimed for this new task yet.

```sh
python tests/object-train.test.py --source /path/to/reviewed/train_gpt.py
node tests/object-train-import.test.mjs /path/to/generated/two-round-run
```

The CPU test checks disjoint unordered context groups, target-blind decoding,
preservation of wrong proposals, actual parameter changes, checkpoint reload,
snapshot/checkpoint hashes, and actual TypeScript Brain acceptance/export.
The longer CPU observation also passes the real Brain checker, which accepts
17 of 30 proposals across the two rounds and rejects the other 13.

Before moving to learned composition or a teacher-free improvement loop, test
multiple fixed seeds and diagnose the remaining definition errors. A later
object-library comparison must include a matched ordinary-output baseline,
held-out composition templates, and the cost of verification/teacher/retrieval.
