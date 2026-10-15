# Training method and interpretation

## Modular experimental design

The local student is a frozen Apertus v1.1 0.5B Instruct base with independent custom q/v low-rank adapters. Separate experiments optimize mathematical writing, method selection, description/summary writing, management, verification or revision. A parameter update in one module does not imply that the other modules learned.

Student output is retained before parsing and mathematical checking. The checker handles a bounded class of real polynomial equalities and exact arithmetic. It is an external mathematical guard, not an Apertus capability. Pending, unparsed, skipped and unexecuted outcomes remain distinct from disproved equalities.

## Policy-gradient updates

Readable implementation: `training/rr_policy.py`, `training/cf_policy.py`, `training/rr_backend.py` and `training/cf_backend.py`. Original optimizer and budget settings are specified by each course's plan; the v24 runner preserves its historical payload and recipe. Inspect the plan before starting an expensive continuation.

Constrained decision training scores the allowed complete token sequences for property or memory actions, including stopping tokens, and derives probabilities from those scores. Outcome-based policy-gradient losses update only the designated adapter through real Torch autograd and AdamW. A matched zero-reward control begins with equal parameters and is not stepped. Free-text editor trajectories are a separate phase, with eligibility checks based on the actual student-computed evidence. In the completed v24 course no editor episode was eligible, so its editor parameters did not change despite 32 committed editor-stage entries.

The scale-course summary reports 512 paired episodes, 346 versus 160 verified training applications, and 377 reward-on changing updates versus zero reward-off updates. This is training evidence; frozen milestone values must be recovered separately. The v15 mathematical-writing course reports 192 committed updates and a regime containing verified rehearsal as well as positive/negative on-policy trajectories. Its original runtime source is now in `training-v15/`. The exact `zip_math_long_core.recipe()` specifies AdamW learning rate 0.0001, no weight decay, gradient clipping at 1, reward baseline 0.5, rehearsal weight 0.25, 96 response tokens and training sampling temperature 0.8. `zip_math_long_policy.update_math()` adds verified-student-target replay to the on-policy reward loss; these are explicitly different training terms.

Earlier phases include reference-answer supervised training and teacher-reviewed generation. Later named courses report zero teacher calls. Claims about supervision must be scoped to the actual course: the whole project was not teacher-free or SFT-free.

## Checkpoint and resumption contract

Transactions bind source identities, raw response records, parameter digests, optimizer states, plans and checkpoint files. Committed receipts are checked on resume; a saved partial result is not another independent experiment. Read `training/cf_store.py`, `training/rr_store.py`, `training/cf_sources.py` and their tests. Historical source pins intentionally prevent silently substituting a different checkpoint chain.

Safetensors adapter files can be inspected independently. Optimizer `.pt` files are not included in the small public model bundle, so that bundle alone is not an exact optimizer-continuation snapshot. The original Notebook remains necessary for a hash-bound historical training continuation.

## Evaluation

The method-selector experiments evaluate the probability mass assigned to candidate routes whose actual student-generated mathematics passed the verifier. The host schedules and audits all candidate routes. Repeated selector seeds share the same generated route outputs and are not independent question objects.

Context ablations keep a reader/head fixed while changing available notes. Different questions across training milestones must not be plotted as a fixed-test learning curve. A frozen retest of one trained head on fresh objects is distinct from independently retraining a model with another seed. A route-mass advantage is distinct from an observed sampled answer accuracy.

See `historical-evidence-review.md` for all positive, null, negative, incomplete and unavailable results, including the distinction between v15's 24-object periodic aggregate and its four-object final-snapshot result.

## Reproduction status

This release exposes the original v24 source and tests. Fixture tests do not load the real base or prove a learning result. The actual original base snapshot, source checkpoint chain, runtime plans and weight bytes must be supplied for historical inference/training reproduction. No new local training or broad replication was performed while publishing this directory.

The received v15 runtime consists of 180 original Python modules. It imports historical host modules such as `zip_pilot` that were outside this selected runtime export. Inspecting the loss, checking adapters and running the single-writer loader are available; a fresh clone cannot by itself reconstruct the entire original host and training history.
