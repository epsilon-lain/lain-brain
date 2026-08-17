# Experiment 03 Pre-Registration

## Status

FROZEN. Do not run live requests until the v2 harness passes and the user
explicitly invokes the live command.

## Research question

Does Personal Brain context improve locally verified stable-concept grounding
while increasing, decreasing, or leaving unchanged unsupported semantic
over-interpretation?

## Hypotheses

- H1: Personal Brain identity information increases verified grounding
  accuracy relative to `plain_llm` and `irrelevant_context` on fixtures
  requiring personal semantics.
- H2: Richer semantic context may change unsupported semantic overreach; the
  direction is not assumed.
- H3: On fixtures where Personal Brain information is irrelevant, Brain
  conditions should not materially improve verified grounding.
- H4: Irrelevant extra context should not reproduce the grounding advantage
  of relevant Personal Brain identity if the effect is semantic rather than
  context-volume driven.

## Fixtures (exactly 12)

1. `personal_meaning_a`
2. `personal_meaning_b`
3. `personal_meaning_c`
4. `overloaded_a`
5. `overloaded_b`
6. `ambiguity_two_candidates`
7. `missing_condition`
8. `precise_no_brain`
9. `irrelevant_context_sensitive`
10. `definition_vs_theorem`
11. `proof_sketch`
12. `stale_revision`

All fixtures are synthetic and never use real Vault data.

## Conditions (exactly 5)

- `plain_llm`
- `irrelevant_context`
- `brain_identity_only`
- `brain_definition`
- `brain_definition_plus_relations`

## Repetitions

3 per case per condition.

## Planned trial count

12 cases × 5 conditions × 3 repetitions = **180 trials**.

## Primary outcomes (exactly 2)

1. `verified_grounding_accuracy`
2. `unsupported_semantic_overreach`

## Secondary outcomes

- ambiguity handling
- quantifier preservation
- relation preservation
- speech-act fidelity
- correction burden
- missing-condition recognition
- invalid-output rate
- provider/failure rate
- Lean statement typecheck where naturally applicable

## Verified-binding rule

A binding counts as correct only when deterministic local validation confirms
that the produced stable ID matches the fixture expected Personal Brain ID.
Arbitrary model-invented IDs and mere `status = resolved` labels do not count.

## Treatment-integrity rule

Each fixture has a treatment manifest. A planned Brain trial that does not
receive its required context is marked `treatment_invalid` and excluded from
the Brain comparison.

## Overreach representation

Overreach is scored from structured `semanticCommitments`, not free-text
similarity. No LLM judge is used.

## Missing vs assumed conditions

The result schema separates `missingConditions`, `assumedConditions`,
`sourceStatedConditions`, and `treatmentContextConditions`. Contradictory
missing-and-assumed classification is flagged deterministically.

## Ordering strategy

Deterministic balanced seeded order. Seed is frozen in the run metadata.

## Seed policy

Default seed `12345`. A dry run with the same seed must reproduce the same
order.

## Retry policy

No automatic retries. Failed or invalid trials remain visible.

## Stopping rule

Stop after all 180 planned trials or an explicit provider/environment failure.

## Inclusion/exclusion rules

- Include only trials whose treatment integrity validates.
- Exclude `treatment_invalid` trials from the primary treatment comparison.
- Do not impute missing trials.
- Do not rerun only bad-looking trials.

## Scorer version

Semantic Fidelity v2 (`SEMANTIC_FIDELITY_V2_SCHEMA_VERSION = 2`).

## Analysis plan

Report verified grounding and unsupported overreach separately, with
repeated-run visibility and no significance testing at this sample size.

## Privacy

Synthetic fixtures only. No API keys in output, no uploads, no telemetry, no
real Vault access.

## Interpretation limits

This is a small synthetic paired experiment. No causal or general superiority
claim is permitted.

## Post-hoc origins

The five-condition design and the grounding/overreach separation are motivated
by the post-hoc Evaluation 02 forensic audit, not by a prior Evaluation 02
pre-registration.

