# Experiment 03 Forensic Analysis

## Immutable input and integrity

Offline audit only. The immutable live artifact was read, never modified or
resumed.

- Experiment ID: `experiment03-live-1786945563723`
- Commit: `ff0d412aa0ec02bbb1d2a1efd705786d457607f9`
- Seed: `12345`; repetitions: 3
- SHA-256: `344d088ce31ea2c183a52f9b386fcd913e277cbfdd9282e49dd54db32b9344e8`
- Integrity: 180 planned = 147 result outcomes + 33 structured failures

**Disposition: instrument/treatment validation failure.** Experiment 03 cannot
support its registered Plain-versus-Brain hypotheses. The runner exposed
internal treatment labels and did not deliver semantic treatment payloads or
real source fixtures. The data remains useful only for diagnosing those
failures and recording the provider-failure distribution.

## Failure forensics

| Failure category | Count | Historical error text |
| --- | ---: | --- |
| `local_exception` | 33 | `DeepSeek returned no answer.` (32); `Live trial failed.` (1) |

The historical text has no provider status, response body, timeout detail, or
underlying exception for the generic error, so it cannot identify the
provider-side cause further.

| Condition | Planned | Results | Failed |
| --- | ---: | ---: | ---: |
| `plain_llm` | 36 | 29 | 7 |
| `irrelevant_context` | 36 | 28 | 8 |
| `brain_identity_only` | 36 | 30 | 6 |
| `brain_definition` | 36 | 30 | 6 |
| `brain_definition_plus_relations` | 36 | 30 | 6 |

| Case ID | Failures | Run index | Failures |
| --- | ---: | --- | ---: |
| `missing_condition` | 1 | 1 | 10 |
| `definition_vs_theorem` | 2 | 2 | 10 |
| `proof_sketch` | 15 | 3 | 13 |
| `stale_revision` | 15 | | |

All five conditions failed for every repetition of both `proof_sketch` and
`stale_revision` (30 failures); the remaining three were run-3 outcomes. The
6--8 failure difference by condition follows the terminal ordered failure
cluster. The artifact supplies no evidence of condition-dependent failure.

## Exact prompt construction

The live runner constructed every fixture as:

```text
sourceText: `${id} synthetic source.`
treatmentManifest: { condition: "plain_llm", suppliedContext: "none" }
```

The static system message was:

```text
Return strict JSON only with fields: conceptBindings, semanticCommitments,
sourceStatedConditions, treatmentContextConditions, missingConditions,
assumedConditions, ambiguities, quantifier, relations, speechAct.
```

The model-visible user message was exactly:

```text
Source: ${caseDef.sourceText}
Condition: ${condition}
```

The following redacted prompts use the actual `personal_meaning_a` fixture:

```text
[system message above]
Source: personal_meaning_a synthetic source.
Condition: plain_llm
```

```text
[system message above]
Source: personal_meaning_a synthetic source.
Condition: irrelevant_context
```

```text
[system message above]
Source: personal_meaning_a synthetic source.
Condition: brain_identity_only
```

```text
[system message above]
Source: personal_meaning_a synthetic source.
Condition: brain_definition
```

```text
[system message above]
Source: personal_meaning_a synthetic source.
Condition: brain_definition_plus_relations
```

No credential appears in these examples.

| Data | Location | Model-visible? |
| --- | --- | --- |
| Trial ID, seed, run index, artifact metadata | planner/result artifact | No |
| Internal condition identifier | `Condition: ${condition}` | **Yes** |
| Treatment payload | no builder or serialization exists | **No payload sent** |
| Fixture source | `${id} synthetic source.` | **Yes; placeholder** |
| Task instructions | static system message | Yes |

## Source and treatment delivery

There is no frozen table of intended source text, stable identities/aliases,
definitions, relations, or irrelevant material. The actual frozen source
serializations were:

```text
personal_meaning_a synthetic source.
personal_meaning_b synthetic source.
personal_meaning_c synthetic source.
overloaded_a synthetic source.
overloaded_b synthetic source.
ambiguity_two_candidates synthetic source.
missing_condition synthetic source.
precise_no_brain synthetic source.
irrelevant_context_sensitive synthetic source.
definition_vs_theorem synthetic source.
proof_sketch synthetic source.
stale_revision synthetic source.
```

Each case retained the same `plain_llm`/ `none` manifest. Planning changed
local `condition`, but no code used it to construct context.

| Local condition | Intended semantic payload | Actual provider payload |
| --- | --- | --- |
| `plain_llm` | none | none, but label leaked |
| `irrelevant_context` | non-empty irrelevant material | none; label only |
| `brain_identity_only` | stable ID and aliases only | none; label only |
| `brain_definition` | identity/aliases and definition | none; label only |
| `brain_definition_plus_relations` | identity, definition, relations | none; label only |

No live response establishes that the provider received a required treatment
payload or intended semantic source.

## Label-leakage audit

Deterministic analysis scanned model-generated response fields only, excluding
local result metadata.

| Echo in successful output | Count |
| --- | ---: |
| any internal condition ID | 92 / 147 |
| own condition ID (including `plain_llm`) | 109 / 147 |
| `irrelevant_context` | 24 / 147 |
| `brain_identity_only` | 30 / 147 |
| `brain_definition` | 43 / 147 |
| `brain_definition_plus_relations` | 19 / 147 |
| phrase `treatment condition` | 6 / 147 |
| phrase `synthetic source` | 50 / 147 |
| any fixture ID | 56 / 147 |

The `brain_definition` count includes the longer relation condition. Manual
inspection of `personal_meaning_a:brain_identity_only:1` shows the model
treating the label as a philosophical stipulation, introducing physicalism,
psychological and bodily continuity, and brain-transplant cases. This is
semantic contamination rather than local metadata repetition.

## Measurement validity and denominators

The schema permitted `conceptBindings`, but only listed that field. It did
not request a binding protocol and the fixtures contained no expected binding
data. `scoreVerifiedGrounding` has no denominator and returns
`accuracy: undefined` for every fixture. Empty bindings occurred in 122/147
successful outputs: plain 27/29, irrelevant 25/28, identity 24/30,
definition 22/30, definition+relations 24/30.

`semanticCommitments` was permitted, but no live scorer output was recorded
and no fixture supplied an allowed commitment set. The existing scorer would
treat all commitments as unsupported when that set is absent, while labels and
placeholder sources contaminate them. Neither verified grounding nor semantic
overreach is valid.

| Condition | Planned | Success | Failed | Treatment-invalid | Usable primary outcome |
| --- | ---: | ---: | ---: | ---: | ---: |
| `plain_llm` | 36 | 29 | 7 | 36 | 0 |
| `irrelevant_context` | 36 | 28 | 8 | 36 | 0 |
| `brain_identity_only` | 36 | 30 | 6 | 36 | 0 |
| `brain_definition` | 36 | 30 | 6 | 36 | 0 |
| `brain_definition_plus_relations` | 36 | 30 | 6 | 36 | 0 |

All trials are treatment-invalid for primary analysis: every prompt leaks a
condition label and has a placeholder source; all context-bearing conditions
also lack their required context.

## Root cause, repair, and replication

The minimal root cause is coupled prompt construction in
`eval-experiment03-live.mjs`: it generated fixture sources from IDs and
interpolated `Condition: ${condition}` directly in provider-visible text.
The planner never translated the condition into a treatment payload.

The future-only repair is Experiment 04 instrument v1.0:
`src/Experiment04Instrument.ts`. It maps local conditions to exact payload
composition, never serializes condition IDs, and throws if a provider-visible
message includes one. `tests/experiment04-instrument.test.mjs` checks all five
payloads, source delivery, all-ID absence, and deliberate-leak rejection.

`EXPERIMENT_04_PREREGISTRATION_DRAFT.md` requires real frozen fixture source
and payload tables to be completed and hashed before any live run. A new
preregistered Experiment 04 / Experiment 03R replication is required and must
not be called Experiment 03.

## Execution record

NO LIVE PROVIDER REQUESTS WERE MADE. The raw Experiment 03 file was not
modified. No push was performed.
