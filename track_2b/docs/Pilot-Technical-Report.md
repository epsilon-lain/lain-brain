# Lain ZIP: Checkable and Revisable Memory for Apertus

Pilot technical report | Evidence cutoff: 14 October 2026
epsilon-lain | Lain Brain | AI-assisted implementation and analysis

## Abstract

Persistent memory can propagate an erroneous rule across later tasks. Lain ZIP studies a small, auditable workflow in which an Apertus agent checks a saved rule, decides whether to withdraw it, writes a replacement, and reuses the saved revision. In a frozen 70B replication covering five rule units and six episodes, all four wrong-rule episodes produced withdrawals and verified replacements; three met the predeclared strict two-follow-up criterion. Mathematical content accuracy was 12/12 without a note, 10/12 with the old note, and 12/12 with the revised note. The two repaired errors were repetitions of one underlying task. A separate outcome-trained external controller completed 128 real updates but selected withdrawal for every held-out context, yielding eight abstentions and no correct answers. These results demonstrate a limited inherited-memory repair workflow and expose a failure of the present learning objective and training distribution. They do not establish broad autonomous self-correction.

## Problem and purpose

An agent that can retrieve memory also needs a way to challenge it. A plausible note can be wrong, become obsolete, or apply outside its scope. Fluent reflection alone is not an adequate success criterion. The practical target is a record whose content, provenance, mutation and later use can be inspected.

## Implemented contribution

The prototype combines actual Apertus responses with versioned external notes, raw-before-grade storage, exact rational polynomial auditing, interruption-aware request receipts and matched note-use comparisons. Its purpose is to make successful repair and failed repair separately measurable. It is a research harness rather than a deployed application.

Saved rule → fixed counterexample → model-authored check → withdrawal decision → independent replacement → exact audit → save/read back → later use

In this report, ZIP means a reusable external knowledge record. The evidence packages also use ordinary .zip archives for delivery; the two uses should not be confused.

# 1. Frozen memory-repair replication

Apertus-v1.5-70B was called through CSCS with temperature 0 and a 1,024-token cap. The rule list, interface and primary criteria were frozen before this replication. One genuine earlier 0.5B wrong note was inherited; other units were designed tests or correct-note controls. The API model did not author the inherited error. The genuine 435 rule had already been explored, so this is not a blind held-out discovery.

| Measure | Observed result |
|---|---|
| Rule units / episodes | 5 / 6 |
| Wrong-rule units / episodes | 3 / 4 |
| Withdrawals / verified replacements | 4/4 / 4/4 |
| Strict two-follow-up closed loops | 3/4 |
| Mistaken withdrawals of correct notes | 0/2 |
| Content correct: no / old / revised note | 12/12 / 10/12 / 12/12 |
| Strict collected-form answers | 10/12 / 10/12 / 12/12 |

## One archived trace (display-normalized)

```text
Inherited note: 435 * v * v = 435^2
Fixed witness: v = 0
Model checks: left ZERO; right POSITIVE
Model action: RETRACT
Model replacement: 435 * v²
Saved notation: 435 * v**2
Later query: simplify 2 * 435 * z * z
Old-note output: 2 * 435^2 * z^2
Revised-note output: 870 * z**2
```

The superscript conversion is display normalization, not an inserted coefficient or teacher-written answer. The model generated the replacement independently; the polynomial auditor admitted it only after checking equivalence to the original expression. The saved record was read back before later retrieval.

## Interpretation

This supports conditional repair of inherited external memory in a restricted polynomial setting. It does not show an improvement beyond the no-memory content baseline. The old-note failures repeated the same 435/z task twice, not two independent discoveries. A fourth mathematically valid episode failed the fixed sign-token interface; its explanatory text is a secondary annotation and does not change the 3/4 primary score. One correct-note control wrote KEEP with prose rather than compliant JSON; the host left the note unchanged. Exact certificates cover formal expressions, not natural-language reflections.

# 2. Learning memory operations from later outcomes

A separate experiment used opaque affine functions whose coefficients could change. Apertus wrote an old note from old observations and a candidate note from current observations. An external four-action linear softmax controller learned KEEP, OVERWRITE, APPEND or RETRACT from actual later API answer utilities. Six TRAIN contexts preceded the final controller; four TEST contexts and eight questions were evaluated after freezing its parameters.

| Quantity | Observed result |
|---|---|
| API model weight updates | 0 |
| External controller updates | 128, independently replayed |
| Initial uniform expected TEST utility | -0.56975 |
| Learned greedy TEST utility | -0.12000 |
| Constant RETRACT TEST utility | -0.12000 |
| Learned actions / correct answers | 4 RETRACT / 0 of 8 |
| Learned abstentions | 8 of 8 |

Correct integers earned +1, wrong integers -1, SKIP -0.10 and invalid format -0.25, minus frozen operation and memory-character costs. Utility improvement can therefore come from avoiding confident errors. Here it did: the learned policy matched constant withdrawal and did not improve correctness.

## Why this is not successful conditional repair

All six realized TRAIN contexts favored RETRACT under the fixed utility. The generated new notes did not fit their observations. Although the curriculum specified stable, changed and incomplete cases, the actual data lacked useful KEEP and OVERWRITE incentives. Eight human-designed features included host-computed consistency checks, so the checking ability itself was not learned by the LLM. The controller trained by sampled REINFORCE/Adam replay of cached real action outcomes, not fresh online LLM rollouts at each update. TEST selection referenced real precomputed operation trials using only frozen weights and public features.

## Exploratory feedback-conditioned note writing

Ten additional calls gave the LLM only TRAIN failure feedback, asked it to propose a note-writing procedure, and applied the procedure to three TEST contexts. Flexible notes scored 0/6; the original formula-note comparison scored 1/6. A note correctly derived 5x-3 but later answers were 10 and 23 instead of 7 and 17. The generated procedure also incorrectly questioned whether two distinct observations uniquely determine a known affine function. This is a prompt-conditioned exploration with zero weight updates, not discovery of a human-unknown learning method.

# 3. Evidence, reproducibility and limitations

## What a reviewer can check without credentials

The dossier contains three unchanged evidence archives: a 72-response exploratory 8B/70B diagnostic, a 63-response frozen 70B replication, and a 110-response memory-learning package. Together they contain 245 saved real API responses and 247 request attempts; two attempts in the interrupted learning experiment have uncertain completion. The offline verifier checks archive manifests, sealed JSON records and raw-record links. The recorded-trace demo prints the original successful example without calling an API.

```text
python tools/verify_evidence.py
python tools/show_recorded_trace.py
```

The exact experiment sources are included inside the original archives. Fresh model runs require a private CSCS credential and may incur charges. Resuming reuses committed outputs; an interrupted remote request can be uncertain, so exactly-once remote execution is not claimed. API weights are not tensor-hash pinned; requested/returned model IDs and provider fingerprints are recorded.

## Corrections are part of the record

The initial diagnostic exposed a superscript-format rejection. The fixed replication retained strict interface failures rather than reclassifying them as primary successes. Before controller training or TEST generation, implicit multiplication such as 3x was connected to the existing display normalizer while reusing 43 original responses. The feedback-note pilot fixed an empty-memory substitution assertion after eight saved responses and then completed two pending questions. Correction receipts and original source snapshots are preserved.

## Limits of the evidence

The experiments are small, one-seed pilots. Rule episodes are not all independent; previously explored material is identified. No statistical significance, broad reasoning improvement, spontaneous discovery of an unnoticed own error, or learned LLM note-writing ability is claimed. The algebra actor already knows the underlying family. Full inference budgets were not matched against ordinary retry/editor-only baselines. Format compliance, mathematical correctness, repair, safe abstention and later use are scored separately.

## Cost and deployment

The prototype uses open Apertus models through a Swiss-hosted inference endpoint, a small external controller and local audit/storage code. Offline review needs only Python standard libraries; controller replay additionally uses NumPy. Actual currency costs, throughput at scale and self-hosted deployment have not been benchmarked. A sovereign deployment is technically plausible, but only the CSCS-hosted API configuration was demonstrated in these runs.

# 4. Research position and next experiments

## Relation to prior work

Reflexion [1] uses reflective language in external memory without updating the LLM weights. Memory-R1 [2] learns structured memory management and use with outcome-driven reinforcement learning. SCoRe [3] studies multi-turn reinforcement learning for correction, including problematic correction behavior. Lain ZIP is not a claim to have invented reflection or learned memory management. Its present contribution is an inspectable engineering pilot linking formal rule checks, actual note mutations, raw response provenance and both positive and negative outcomes.

## Questions that remain worth testing

First, validate realized TRAIN behavior before optimization: there must be genuinely useful examples of preserving correct notes, overwriting erroneous notes and withdrawing when evidence is insufficient. Second, train the note writer and memory controller as distinct components, scoring later task accuracy and preserving original observations. Third, compare frozen policies against no note, old note, constant actions and equal-budget ordinary rewriting on previously unseen functions and multiple seeds. A useful result must beat appropriate fixed baselines and cannot rely solely on abstention.

## Takeaway

In a limited setting, an Apertus-based system can revise an inherited erroneous note and reuse the checked replacement. Learning when and how to revise memory remains an empirical problem: access to withdrawal and an outcome reward did not automatically produce a useful conditional policy in this pilot. The prototype makes that distinction auditable.

## References

[1] Shinn et al. Reflexion: Language Agents with Verbal Reinforcement Learning (2023). https://arxiv.org/abs/2303.11366

[2] Yan et al. Memory-R1: Enhancing Large Language Model Agents to Manage and Utilize Memories via Reinforcement Learning (2025; revised 2026). https://arxiv.org/abs/2508.19828

[3] Kumar et al. Training Language Models to Self-Correct via Reinforcement Learning (2024). https://arxiv.org/abs/2409.12917

CSCS inference documentation: https://docs.cscs.ch/services/inference/api/

Project source: https://github.com/epsilon-lain/lain-brain/tree/codex/zip-conditional-v24-20261014
