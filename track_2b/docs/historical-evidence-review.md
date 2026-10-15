# Lain ZIP: historical training evidence review

Review date: 15 October 2026. Status: screening of supplied result summaries, not a reproduction of the underlying experiments.

The local experiments contain positive learning results that should be represented in the submission. The strongest supported story is modular, externally checked learning: a mathematical writer can improve, a learned selector can assign more probability to successful routes, and some student-written notes can change subsequent behavior. Autonomous retrieval, reliable self-correction, and discovery of new mathematical principles remain unestablished.

## Evidence coverage and counting

Twenty supplied text fragments concatenate to 480,000 characters. They contain 84 complete compacted JSON records covering 86 file paths, followed by the beginning of the scale-curve record. Complete fields were recovered from that partial record without inventing its missing suffix. The final pasted continuation covers the scale-curve suffix and the remaining 43 records. Its relevant observations were transcribed separately; the pasted continuation was not reconstructed as a byte-exact local JSON file.

The supplied INDEX lists **130 top-level result/partial-result/summary files across 113 run directories**. Two byte-identical warmup pairs are represented by aliases in the compact export, giving 128 distinct exported records. These counts describe files and directories. They do not describe independent training replications. Partial and final receipts, result and summary files, aggregate series and their component courses, replays, and frozen probes must not be added as separate training runs or discoveries.

The exporter replaced many nested dictionaries with field names and many lists with item counts. Such omissions are **unavailable observations**, not zeros. In particular, several heldout comparisons, proof traces, per-object results, and self-revision outcomes cannot be recovered numerically from this screening export. An assertion such as `baseWeightsUnchanged: true` is a reported integrity check; this review did not itself hash the original model files.

## Findings worth adding to the report

### 1. A trained selector improved successful-route probability on four frozen retests

The four retests each contain eight new objects. The mathematical writer was greedy and frozen. The host scheduled and audited all candidate method routes; the selector assigned probability to those saved outcomes. The metric is the probability mass on routes whose actual generated mathematics passed verification.

| Retest | Objects | Trained selector | Initial selector | Difference |
| --- | ---: | ---: | ---: | ---: |
| `2475c06b` | 8 | 43.07% | 29.17% | +13.90 pp |
| `709ff875` | 8 | 36.42% | 20.83% | +15.58 pp |
| `3f226854` | 8 | 48.92% | 41.67% | +7.25 pp |
| `63b01086` | 8 | 50.39% | 45.83% | +4.55 pp |
| Equal-weight descriptive mean | 32 reported objects | 44.70% | 34.38% | +10.32 pp |

Across these summaries, 16 objects favor the trained selector, 12 favor the initial selector, and four tie. Three policy seeds per object do not triple the object count. The four retests reuse learned state and do not constitute four independently trained models. Cross-batch object uniqueness and source checkpoint bindings should be confirmed from originals before publishing the pooled count as a unique-object result.

The subsequent eight-update choice continuation reports a +2.66 pp heldout difference against its own frozen pre-round head on four objects, while its pre-feedback training-object difference is −3.20 pp. This supports a limited selection-learning observation, not autonomous tool retrieval or a generally reliable improvement.

### 2. Mathematical-writer training produced a substantial paired periodic result, with a much smaller final-snapshot result

`zip-math-long-362b296b` reports 192 committed mathematical-writer optimizer updates, 630 student generations, verified rehearsal, and positive and negative on-policy trajectories. The base, management policy, and method policies remained frozen. No heldout optimizer updates or teacher calls are reported in this run. This training regime includes verified rehearsal and should be described explicitly rather than characterized as unassisted discovery.

| Comparison | Evaluation scope | Initial writer | Trained writer | Difference |
| --- | --- | ---: | ---: | ---: |
| Managed routes | All periodic evaluations: 24 objects | 25.02% | 44.41% | +19.39 pp |
| Without summary | Same periodic scope | 24.26% | 43.66% | +19.40 pp |
| Uniform routes | Same periodic scope | 22.22% | 31.94% | +9.72 pp |
| Managed routes | Final snapshot: four fresh objects | 53.58% | 54.24% | +0.67 pp |
| Without summary | Same final snapshot | 56.82% | 57.86% | +1.04 pp |

The periodic aggregate compares paired writers within each evaluated object, across different training milestones and different evaluation inputs. **It is not the final checkpoint's accuracy on a fixed 24-object test.** Raw differences between milestone means are not a learning curve. The largest gain persists without summary context, so it primarily supports writer learning rather than a memory mechanism. The number of objects with no successful route falls from eight to three in the periodic aggregate.

### 3. Refreshing route policies improved the route-mass metric; summary management added less

`zip-route-refresh-cfcb1157` evaluates eight heldout objects with a frozen mathematical writer and reports 84 updates each for contextual routes, global routes, contextual management, and global management controls.

| Policy combination | Verified-success route mass |
| --- | ---: |
| Old routes and old manager | 20.98% |
| Refreshed routes and old manager | 52.61% |
| Refreshed routes and refreshed manager | 57.27% |
| Refreshed routes without summary | 58.38% |
| Global route correction and old manager | 45.26% |
| Refreshed routes and global manager | 58.09% |

The reported route-refresh difference is +31.63 pp and the additional manager difference is +4.66 pp. The complete refreshed system is below the no-summary arm by 1.10 pp and below the global-manager control by 0.81 pp. The result supports policy learning within the supplied route system; it does not isolate a benefit of student prose, ZIP encoding, or contextual management over every simpler baseline.

### 4. Rewarded local applications improved during real adapter training

| Course | Paired training episodes | Reward-on verified applications | Reward-off verified applications | Reward-on changing updates |
| --- | ---: | ---: | ---: | ---: |
| Shift continuation `c1a2b115` | 128 | 28 | 18 | 59 |
| Scaffold `b1e08b63` | 128 | 70 | 47 | 115 |
| Scaffold replication `d27d9608` | 128 | 54 | 43 | 101 |
| Scale course `309e8004` | 512 | 346 | 160 | 377 |

These are **training-course observations under evolving policies**, not frozen heldout accuracies. In the scale course the corresponding rates are 67.58% and 31.25%. Reported Torch audits include reward-direction checks, actual-student gradient replay, LoRA/optimizer checkpoint round trips, and an unchanged zero-reward control. These strengthen the implementation evidence. Heldout milestone and same-content control values were compacted away and need targeted recovery before making a generalization claim. The scale course reports zero student-derived rules and no completed child-tool reuse comparison.

### 5. Student-written descriptions and notes sometimes helped, with important negative results

The description/selector courses report small heldout gains against frozen pre-round copies. The v5 grounded-feedback branches `47624235` and `9024865b` report +3.88 pp and +3.81 pp on four objects each. Replacing learned description cards with old cards, while retaining the learned observation and selector, reduces the metric by 1.69 pp and 2.75 pp respectively. Both branches report two successful greedy top-route choices out of four, versus zero for the common pre-round baseline. A frozen eight-object retest `85f9385c` reports +2.14 pp for an earlier learned checkpoint.

These are candidate context effects within host-arranged interfaces. Natural-language descriptions are not certified as wholly true. The card ablation does not isolate the effect of learning to generate observations. The two grounded-feedback branches share a parent and are not independent replications. The two frozen branch comparisons report top-route counts of 4/8 and 4/8 against 2/8 on one batch, and 4/8 and 5/8 against 0/8 on another; their primary probability-mass differences are unavailable in this export.

For the later v7 summary courses, the same-reader, same-head comparison with and without summary gives:

| Round | Run suffix | Heldout objects | Summary context effect |
| --- | --- | ---: | ---: |
| 11 | `19c328cb` | 4 | 0.00 pp |
| 12 | `464f3215` | 4 | −3.78 pp |
| 13 | `1e35f1a6` | 4 | −2.10 pp |
| 14 | `f994839d` | 4 | +3.74 pp |
| 15 | `76c8254e` | 4 | −1.92 pp |
| 16 | `58af84e4` | 4 | +8.59 pp |
| Equal-weight descriptive mean | Six successive courses | 24 reported objects | +0.75 pp |

The six-course mean is calculated in this review from the six reported differences; it is not a preregistered aggregate. The courses form a continuation chain with curriculum changes, not independent training replications. The fixed three-course v7 series for rounds 11–13 reports −1.96 pp overall. The later series that completed only rounds 14–15 reports +0.91 pp. These series overlap the individual rows and must not be counted again.

Round 16's +8.59 pp is worth retaining as a bounded positive observation. It should appear alongside the negative rounds and the small overall descriptive mean. It does not by itself establish that summary-writer training caused a general improvement. The system used program-supplied structural scope and did not demonstrate autonomous retrieval or autonomous discovery of a note's scope.

Earlier v1/v2 summary courses report −0.38 pp and −5.09 pp context effects. Several v3–v6 courses retained no active notes and therefore have a zero operative context effect. Excluding those rounds merely because no note survived would overstate the result.

### 6. Limited direct answer-context benefits exist alongside memory failures

The frozen answer ablation `9b6430c7` reports 2/16 simplified answers with the stored rule text versus 0/16 without it, and 3/16 nontrivial rewrites versus 0/16. The stored content was placed in the prompt; the original structural reader was disabled. Ordinary-text and incorrect-note controls were run, but their numeric outcomes were compacted away. A ZIP-specific advantage cannot yet be claimed.

The local-memory test `02bbca10` is a useful counterexample: the old-tools condition yielded eight clean changed mathematical results out of eight, versus three without notes, while local ZIP notes and the same-content text condition both produced eight wrong finals. Its stricter local-memory-result criterion was zero in all conditions. These are different outcome definitions and should not be merged. Rechecking stored memories for truth did not guarantee successful downstream use.

## What the later failures actually delimit

| Area | Observation | Interpretation |
| --- | --- | --- |
| Frozen one-step self-check | `5f7067b9`: eight clean drafts became six clean self-check outputs | No demonstrated benefit; two outputs lost coverage. This was a deliberately simple, previously evaluated warmup. |
| Frozen reflection | `7ae06e07`: transfer passes 4/8 initially and on ordinary retry, 1/8 with reflection | The tested reflection context harmed three cases; self-check outputs were unparsed on the source set. |
| Independent verifier | `0b7cffaa`: 128 verifier updates; initial and trained systems both 12/24 passes | No answer-level gain. Verdict-classification metrics remain unavailable, so classification improvement cannot be ruled out from this export. |
| Contradiction repair | `626f2c24`: gated initial/trained systems both 3/8; ungated repair 0/8 to 1/8; transfer 4/8 to 4/8 | A narrow ungated change, with no established gated or transfer benefit. |
| Conditional editor | `a1afc8a6`: 96 meta parameter changes, zero eligible editor episodes, zero editor parameter changes | The 32 committed editor entries must not be called 32 effective editor learning updates. Heldout actions and revision outcomes were omitted by compaction. |
| Native memory management | `0ebb26f3`: no valid actions, no activated revisions; learned result equals always-suspend | Invalid-response fallback is not learned student suspension. Recovery reused 80 of 92 responses and committed zero new optimizer updates. |
| Weak guidance | `9177cc30`: incomplete timeout, one heldout object, no valid heldout actions | Its advantage over always-use equals fallback behavior; it is not evidence of learned management. |
| Explicit management head | `e39be545`: +2.08 pp versus uniform, but −0.49 pp versus always-suspend | Learning a nonuniform action probability is insufficient to establish useful contextual management. |
| Contextual management | `9c66fce3`: +0.23 pp over its frozen head, +0.0044 pp over matched global, below always-suspend | Little incremental contextual benefit in this batch. |
| Geometry management variants | Three eight-object batches: +1.85, +0.17, +0.87 pp versus matched global | Small positive comparisons; only two variants exceed both constant-use and constant-suspend policies. Shared lineage and differing batches preclude a reliability claim. |
| Autonomous source/metric selection | Several frozen probes produced no verified choices, tool executions, or questions | The requested multistage mechanism did not complete. Lack of a tested downstream benefit is distinct from a zero score on an executed downstream task. |
| Tool construction | Affine bridge, new-tool loop, and single-rule recovery admitted no new derived tools | Reuse was not tested when no tool was admitted. Do not report unrun reuse tests as 0% accuracy. |
| Self-model | `74252455`: 37 fixture checks, zero student generations or updates | Evidence for the host state-machine implementation, not student discovery or learning. |
| Implementation failures | Prompt-length preflight, undefined function, fixed-token-denominator error, and deadlines | Separate implementation/resource failures from mathematical errors. Unchecked integrity flags after an early error do not prove actual weight mutation. |

Early supervised warmup also deserves balanced reporting: two square checks became parseable and verified after 12 updates, but subsequent correction traded square success for product success while the overall four-check pass count stayed 2/4. Development checks were used for selection; the final test was unopened. Loss reduction alone was not a general improvement result.

Teacher usage is phase-specific. Several later local runs report zero teacher calls and no teacher answer targets; earlier teacher-reviewed training made hundreds of teacher calls, and an independent math-writer course used 96 SFT updates with reference answers. A project-wide claim of “no teacher calls” or “no reference-answer training” would be false.

## Proposed English report language

> We evaluated learning at separate points in an externally checked memory-and-tool pipeline. In four frozen eight-object retests, a trained method selector assigned 36.42–50.39% probability mass to verified successful routes, compared with 20.83–45.83% for its initial counterpart; each paired batch favored the trained selector. These retests reuse learned state and are not independent training replications. A separate mathematical-writer course improved paired successful-route mass by 19.39 percentage points across 24 periodic evaluation objects, while the final checkpoint's four-object comparison improved by only 0.67 points. Student-written summaries had mixed context effects: six successive v7 courses ranged from −3.78 to +8.59 points, with a descriptive mean of +0.75 points. These results support bounded modular learning and occasional useful memory context; they do not establish autonomous retrieval, reliable self-correction, or new mathematical-principle discovery.

These local approximately 0.5B experiments should be kept distinct from the archived frozen 70B API note-revision episodes and from an external controller's updates. They are complementary evidence, not one pooled benchmark.

## Minimum evidence recovery before promoting claims

No retraining is needed to resolve the main omissions. A single targeted, read-only extraction should retrieve these selected branches, with arrays preserved and file-hash manifests excluded:

1. **Scale course:** `learningCurve[*].singleSteps`, `endpointControls`, and the construction/admission outcomes at all requested milestones. This decides whether the 346-versus-160 training result extends to frozen objects.
2. **Both scaffold courses:** `frozenSummary`, including all same-content controls and paired comparisons. This decides whether the independent scaffold run reproduced a heldout benefit.
3. **Writer and selector:** per-object rows, source checkpoint identifiers, task identifiers, and the actual generated mathematics underlying the v15 and four selector retests. This verifies eligibility, overlap, aggregation and the claim that routes were checked from student output.
4. **Positive and negative note courses:** candidate originals, their source experiences, admission/scope decisions, and paired heldout observations for rounds 12, 14 and 16. This supports a concrete example without selecting only the best round. Retain all six rounds in the result table.
5. **Conditional revision:** `summary.heldout`, `summary.sourceReadback`, and the actual proposed notes for `a1afc8a6`; and `summary.heldout` for `e1828281`. These nested outcomes were erased by the compact export and cannot be inferred from update counts.

The primary task is selecting and checking existing evidence. The current export does not justify another broad training run or another manual file-by-file transfer.

## Arithmetic and provenance checks performed here

The four selector means, percentage-point conversions, six-course v7 mean, training-course application rates, and writer/route differences were recomputed from supplied numbers. Partial/final receipts were grouped by run directory. No optimizer ran, no model was loaded, no experiment score was changed, and no public repository was updated for this review. Original student generations and full checkpoint files were not available here for independent replay.

The inventory below records every indexed run directory and the source representation used. “Pasted extract” means a selected-field transcription of the user's final continuation, not a complete raw experiment file. Numeric results in the narrative retain the limitations above.

## Run-directory inventory

Generation counts below are reported per selected run summary, not totals to sum. Recovery, cold reproductions, series aggregation and partial receipts can overlap.

| Run directory | Indexed files | Source representation | Screening observation |
| --- | ---: | --- | --- |
| `balanced-preparation-950a4b76` | 1 | Parsed compact JSON | Balanced candidate not selected; no improvement |
| `checkpoint-selection-a233ab80` | 1 | Parsed compact JSON | No improved checkpoint selected; dev used for selection |
| `interface-correction-5cdb54c9` | 2 | Parsed compact JSON | Loss falls; square/product tradeoff; four-check total unchanged |
| `interface-warmup-1e599a61` | 2 | Parsed compact JSON | 12 supervised updates; format and formula usability improves on 2 checks |
| `interface-warmup-8dec83c6` | 2 | Parsed compact JSON | Byte-identical warmup result/summary alias; not an independent replication |
| `math-prompt-probe-6fb38729` | 1 | Parsed compact JSON | 8 frozen outputs unparsed; automatic correctness unavailable |
| `math-writer-98cfe9e1` | 1 | Parsed compact JSON | 96 reference-answer SFT steps; heldout difference 0, composition difference +1 |
| `math-zip-7193d87b` | 1 | Parsed compact JSON | 72-episode paired prefix; arm outcomes omitted |
| `math-zip-b975b7e1` | 1 | Parsed compact JSON | 72-episode paired prefix; arm outcomes omitted |
| `math-zip-v2-d4b66809` | 1 | Parsed compact JSON | Writer preflight failed; no training |
| `math-zip-v3-019315c0` | 1 | Parsed compact JSON | 12-episode paired prefix; arm outcomes omitted |
| `zip-affine-bridge-8e8fbb51` | 1 | Parsed compact JSON | 4 construction objects; no supported proof steps or admitted tool |
| `zip-answer-ablation-9b6430c7` | 1 | Parsed compact JSON | Simplified answers 2/16 with note vs 0/16 without; controls omitted |
| `zip-arithmetic-aa1466c2` | 1 | Parsed compact JSON | 3 fixed arithmetic tasks wrong in each adapter condition |
| `zip-choice-continue-ce4ac969` | 1 | Parsed compact JSON | 4 heldout; continuation +2.66 pp versus frozen pre-round head |
| `zip-choice-retest-2475c06b` | 1 | Parsed compact JSON | 8 objects; trained-minus-initial route mass +13.90 pp |
| `zip-choice-retest-3f226854` | 1 | Parsed compact JSON | 8 objects; trained-minus-initial route mass +7.25 pp |
| `zip-choice-retest-63b01086` | 1 | Parsed compact JSON | 8 objects; trained-minus-initial route mass +4.55 pp |
| `zip-choice-retest-709ff875` | 1 | Parsed compact JSON | 8 objects; trained-minus-initial route mass +15.58 pp |
| `zip-conditional-final-a1afc8a6` | 2 | Parsed compact JSON | 96 meta parameter changes; 0 eligible/effective editor updates; outcomes omitted |
| `zip-contradiction-626f2c24` | 2 | Parsed compact JSON | Gated answer performance unchanged; ungated 0/8 to 1/8 |
| `zip-discovery-e27b77ad` | 1 | Parsed compact JSON | Paired discovery setup; arm outcomes omitted; no promotion |
| `zip-distribution-focus-d11174a6` | 1 | Parsed compact JSON | 9 updates; broader distribution gate failed; combine retention gate passed |
| `zip-experience-binding-356edaf2` | 1 | Parsed compact JSON | No verified source selections; downstream comparison unavailable |
| `zip-experience-memory-c1648d4f` | 1 | Parsed compact JSON | No reusable note admitted; downstream contrast not executed |
| `zip-experience-routing-6c4b1546` | 1 | Parsed compact JSON | 4 interface conditions; no valid selection; downstream stage stopped |
| `zip-experiment-student-0573f301` | 1 | Parsed compact JSON | 20 cumulative supervised updates; no reward updates or default promotion |
| `zip-field-curriculum-7f3e816c` | 1 | Parsed compact JSON | 2 scaffolded correct tools per arm; no fully student-authored rules |
| `zip-generation-reward-ecba3157` | 1 | Parsed compact JSON | Teacher-schema failure after 2 pairs; no updates or heldout evaluation |
| `zip-generation-reward-eecffb06` | 1 | Parsed compact JSON | 116 pairs; 230 on-arm updates; no admitted tools; 49/64 eval completed |
| `zip-guided-reuse-0c052026` | 1 | Parsed compact JSON | Prepared inputs only; no generation or training |
| `zip-interface-training-1aad680a` | 1 | Parsed compact JSON | 6 supervised registry-interface updates; 1 selected source read |
| `zip-keyword-agent-251ea097` | 1 | Parsed compact JSON | 1 paired object; neither condition solves; phase scaffolding |
| `zip-keyword-agent-3f639cdd` | 1 | Parsed compact JSON | 4 paired objects; neither condition solves |
| `zip-keyword-agent-50333185` | 1 | Parsed compact JSON | Frozen same-object router ablation; no interface recovery in 2 matched slots |
| `zip-keyword-agent-87c5f7cf` | 1 | Parsed compact JSON | Frozen same-object router ablation; key condition outcomes omitted |
| `zip-keyword-agent-b45fae12` | 1 | Parsed compact JSON | 1 paired object; neither condition solves; phase scaffolding |
| `zip-keyword-agent-d2ade9c0` | 1 | Parsed compact JSON | Typed interface same-object diagnostic; condition outcomes omitted |
| `zip-label-feedback-fix-bab0e1a2` | 1 | Parsed compact JSON | 4 heldout; total +2.40 pp; card ablation +2.77 pp |
| `zip-label-feedback-fix-ce3a8917` | 1 | Parsed compact JSON | 4 heldout; total +3.19 pp; card ablation +0.53 pp |
| `zip-label-frozen-compare-1c174005` | 1 | Parsed compact JSON | 8 new objects; top-route passes 4/8, 4/8 vs 2/8 common baseline |
| `zip-label-frozen-compare-9ffb328e` | 1 | Parsed compact JSON | 8 new objects; top-route passes 4/8, 5/8 vs 0/8 common baseline |
| `zip-label-frozen-retest-85f9385c` | 1 | Parsed compact JSON | 8 new objects; learned checkpoint +2.14 pp versus frozen pre-round copy |
| `zip-label-grounded-feedback-47624235` | 1 | Parsed compact JSON | 4 heldout; total +3.88 pp; card ablation +1.69 pp |
| `zip-label-grounded-feedback-9024865b` | 1 | Parsed compact JSON | 4 heldout; total +3.81 pp; card ablation +2.75 pp |
| `zip-label-iterate-1ab4121a` | 1 | Parsed compact JSON | 4 heldout; total +1.53 pp; card effect 0 |
| `zip-label-iterate-8aa47599` | 1 | Parsed compact JSON | 4 heldout; total +2.15 pp; card effect +2.87 pp |
| `zip-label-iterate-c2db5c9b` | 1 | Parsed compact JSON | Bootstrap incomplete; no training or heldout objects |
| `zip-label-metacognitive-2e1bbab4` | 1 | Parsed compact JSON | 1 semantic update; 4 heldout; all reported effects 0 |
| `zip-local-memory-02bbca10` | 1 | Parsed compact JSON | Old tools 8/8 clean changes vs no-note 3/8; local notes 8 wrong finals |
| `zip-local-rewrite-753b8732` | 1 | Parsed compact JSON | 32 pairs; applications 4 vs 4; 10 on-arm updates; eval values omitted |
| `zip-management-context-9c66fce3` | 2 | Parsed compact JSON | 8 heldout; +0.23 pp vs prior; +0.0044 pp vs global; below always-suspend |
| `zip-management-geometry-b65172c0c7bf` | 2 | Parsed compact JSON | 8 heldout; +1.85 pp vs global; below always-use |
| `zip-management-geometry-da51df33` | 2 | Parsed compact JSON | 8 heldout; +0.17 pp vs global; +0.10 pp vs always-suspend |
| `zip-management-geometry-e2e1880732aa` | 2 | Parsed compact JSON | 8 heldout; +0.87 pp vs global; exceeds both constant policies |
| `zip-management-head-d9bece34` | 2 | Parsed compact JSON | Deadline before generation; no heldout result |
| `zip-management-head-e39be545` | 2 | Parsed compact JSON | 4 heldout; +2.08 pp vs uniform; below always-suspend |
| `zip-math-long-362b296b` | 2 | Parsed compact JSON | 192 updates; periodic paired +19.39 pp; final snapshot +0.67 pp |
| `zip-memory-management-series-fdd863a4` | 1 | Parsed compact JSON | Requested 1 round; completed 0; series receipt only |
| `zip-micro-diagnostic-abe4dbdf` | 1 | Parsed compact JSON | 24 student generations; teacher fixture audit falsely approves 5/16 |
| `zip-morning-reuse-16e4080b` | 1 | Parsed compact JSON | 32 pairs; no verified written applications; 2 answer-reward updates |
| `zip-new-tool-loop-906276d3` | 1 | Parsed compact JSON | 16 objects; no supported steps, proposals, or admitted tools |
| `zip-note-revision-5ee56bce` | 1 | Parsed compact JSON | Frozen direct-counterexample note revision; no certified revision/reuse candidate |
| `zip-object-choice-train-0f66d059` | 1 | Parsed compact JSON | 8 choice updates; 10 saved student notes; detailed heldout counts omitted |
| `zip-prompt-control-db66e664` | 1 | Parsed compact JSON | 8 objects across 4 frozen conditions; prompt comparison values omitted |
| `zip-reflection-1db341ec` | 1 | Parsed compact JSON | Interrupted before student generations; no training |
| `zip-reflection-7ae06e07` | 2 | Parsed compact JSON | Frozen transfer: initial/ordinary 4/8 vs reflection 1/8 |
| `zip-reflection-reward-e1828281` | 1 | Parsed compact JSON | 64 constrained reflection steps; zero-reward unchanged; outcomes omitted |
| `zip-reward-gate-fix-a9e201cf` | 1 | Parsed compact JSON | Read-only admission repair; 57 fixture checks; no new tools |
| `zip-route-refresh-cfcb1157` | 2 | Parsed compact JSON | 8 heldout; route refresh +31.63 pp; full system below no-summary |
| `zip-scaffold-replication-d27d9608` | 1 | Parsed compact JSON | 128 pairs; training verified 54 vs 43; heldout comparison omitted |
| `zip-scaffold-train-b1e08b63` | 1 | Parsed compact JSON | 128 pairs; training verified 70 vs 47; heldout comparison omitted |
| `zip-scale-curve-309e8004` | 1 | Parsed prefix + pasted suffix | 512 paired episodes; training verified 346 vs 160; 377 updates; heldout values omitted |
| `zip-self-model-74252455` | 1 | Pasted extract | 37 fixture checks; no student generation or training |
| `zip-self-probe-a64e212b` | 1 | Pasted extract | 8 frozen pairs; strict paired supported-correct count 0 before and after |
| `zip-self-question-focus-1f424047` | 1 | Pasted extract | 3 choices; no verified metric choices; no question responses |
| `zip-self-question-natural-d834e74f` | 1 | Pasted extract | 6 frozen calls; condition outcomes omitted; no training |
| `zip-self-question-probe-cd8b0829` | 1 | Pasted extract | 6 format calls; no interface candidates selected |
| `zip-self-question-tools-175a4b45` | 1 | Pasted extract | Prompt-length preflight error; no student output |
| `zip-self-question-tools-53ce0a2d` | 1 | Pasted extract | 2 readable assessments; no verified calls or executed measurement tools |
| `zip-self-question-tools-eee69203` | 1 | Pasted extract | 2 capped assessments; no subsequent tool or question response |
| `zip-serial-train-7aeb7e7f` | 1 | Pasted extract | 64 paired episodes; 43 on-arm updates; each arm verified 1 self-check application |
| `zip-shift128-c1a2b115` | 1 | Pasted extract | 128 paired episodes; training local applications 28 vs 18; frozen values omitted |
| `zip-short-prompt-probe-fabf77dd` | 1 | Pasted extract | 8 frozen generations; 4 teacher calls; detailed condition outcomes omitted |
| `zip-short-reward-6098e6f0` | 1 | Pasted extract | Stopped after 8 pairs; no supported rule or optimizer updates; evaluation not run |
| `zip-single-rule-recovery-cd341b42` | 1 | Pasted extract | Training applications 43 vs 33; fresh-skill construction gate failed; no child reuse test |
| `zip-step-check-5f7067b9` | 1 | Pasted extract | Frozen one-step draft 8/8 clean; self-check 6/8 clean |
| `zip-summary-series-1df92b55` | 1 | Pasted extract | 2/3 requested courses complete; +0.91 pp summary context mean; component courses overlap |
| `zip-summary-series-26b7ff0e` | 1 | Pasted extract | No completed course or heldout objects; failed constituent course |
| `zip-summary-series-4780e5eb` | 1 | Pasted extract | 3 courses complete; summary context effect 0; component courses overlap |
| `zip-summary-series-4a197531` | 1 | Pasted extract | 3 courses complete; summary context effect -1.96 pp; component courses overlap |
| `zip-summary-training-004dc1f8` | 1 | Pasted extract | Round 2; 4 heldout objects; summary context -0.38 pp |
| `zip-summary-training-0ebb26f3` | 2 | Pasted extract | Recovered round 17; no valid management actions; 80 reused + 12 new responses |
| `zip-summary-training-19c328cb` | 1 | Pasted extract | Round 11; 4 heldout; summary context 0 pp; no retained notes |
| `zip-summary-training-1e35f1a6` | 1 | Pasted extract | Round 13; 4 heldout; summary context -2.10 pp |
| `zip-summary-training-1ec78353` | 1 | Pasted extract | Round 3; 4 heldout; summary context -5.09 pp |
| `zip-summary-training-29b24f95` | 1 | Pasted extract | Round 10; 4 heldout; no operative summary effect |
| `zip-summary-training-2b98620f` | 1 | Pasted extract | Round 5; 4 heldout; all 6 candidates rejected; no operative summary effect |
| `zip-summary-training-3f1d69dc` | 1 | Pasted extract | Round 4; 4 heldout; 6 summaries withdrawn; no operative summary effect |
| `zip-summary-training-464f3215` | 1 | Pasted extract | Round 12; 4 heldout; summary context -3.78 pp |
| `zip-summary-training-50b538ff` | 1 | Pasted extract | Round 9; 4 heldout; no operative summary effect |
| `zip-summary-training-58af84e4` | 1 | Pasted extract | Round 16; 4 heldout; summary context +8.59 pp; no autonomous selection |
| `zip-summary-training-76c8254e` | 1 | Pasted extract | Round 15; 4 heldout; summary context -1.92 pp |
| `zip-summary-training-78246141` | 1 | Pasted extract | Round 8; 4 heldout; no operative summary effect |
| `zip-summary-training-bb06ffe3` | 1 | Pasted extract | Round 7 denominator implementation error; 0 heldout; 0 summary updates |
| `zip-summary-training-e1ea1bcf` | 1 | Pasted extract | Round 6; 4 heldout; no operative summary effect |
| `zip-summary-training-f5436e93` | 1 | Pasted extract | Round 1 undefined-function error before generations; integrity flags not conclusive |
| `zip-summary-training-f994839d` | 1 | Pasted extract | Round 14; 4 heldout; summary context +3.74 pp |
| `zip-targeted-ef9473b4` | 1 | Pasted extract | Frozen targeted revision; 0 old-to-new rescued cases; capped reflection texts |
| `zip-textbook-object-bf6eee8e` | 1 | Pasted extract | 23 frozen generations incl. 8 cold replays; comparison outcomes omitted |
| `zip-verification-0b7cffaa` | 2 | Pasted extract | 128 verifier updates; initial/trained answer passes both 12/24 |
| `zip-weak-guidance-9177cc30` | 2 | Pasted extract | Incomplete timeout; 1 heldout object; no valid actions or activated guide |
| `zip-writer-check-b6de0eff` | 1 | Pasted extract | 2 historical draft pairs changed output; benefit not established; 0 new objects |
