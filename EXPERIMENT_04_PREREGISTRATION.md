# Experiment 04 Preregistration

## Status

FROZEN OFFLINE DESIGN. No provider request is authorized by this document. Experiment 03 remains an instrument/treatment validation failure; Experiment 04 is a corrected preregistered replication.

## Research question and hypotheses

Does bounded synthetic Personal Brain semantic context improve locally verified grounding without increasing unsupported semantic commitments? H1: relevant identity/definition context improves verified grounding where personal meaning is required. H2: richer context can alter overreach in either direction. H3: no material advantage is expected for the precise logical fixture. H4: matched irrelevant material must not reproduce relevant grounding.

## Frozen design

- Definition SHA-256: `552b95d2a008ef77daeb47aaa80087e0953411d226f0c26250207f2396d06711`
- Fixture table SHA-256: `04e356cc19f106066e73c0a30cf6c09c2f836fce1bad489996c7b17e02a88a0f`
- Treatment manifest SHA-256: `2603e22d59fcc609b1cfc0fa2ade5e9839843b517ee836a2da2ae6b636b7d265`
- Common task prompt SHA-256: `979ed816c0c7b5c771b7f5545b091a33aa9b634dfca7d1b9379bee3969484ea4`
- Response schema SHA-256: `7f31d0cd9f8f50f4e0918db5ab737725fa1933d9e6fd17120815622ef3c2f29e`
- Provider/model: DeepSeek / deepseek-v4-flash
- Seed: 240417
- Repetitions: 3
- Trial count: 12 fixtures × 5 conditions × 3 repetitions = 180

## Fixtures

- `harbor-private-meaning` — I need to return to the harbor before I decide what to keep.
- `lantern-private-meaning` — The lantern is still lit, so I will not close the project yet.
- `compass-private-meaning` — Use the compass when the discussion starts collecting too many possible directions.
- `field-overload` — This field is ready to split once its examples no longer answer the same question.
- `proof-overload` — Keep the proof beside the claim until someone can retrace each step.
- `bridge-ambiguity` — The bridge is not ready; both readings still fit the note.
- `normal-operator-missing-assumption` — Every normal operator has an eigenbasis.
- `modus-ponens-precision` — If P implies Q, and P holds, then Q holds.
- `delta-control` — Mark the delta before comparing the two versions.
- `boundary-definition` — By boundary I mean the last distinction that must remain explicit before we combine two ideas.
- `spectral-proof-sketch` — Since the spectral theorem applies here, the next step is to diagonalize T.
- `compass-revision` — The compass now asks for the next reversible step, not the most elegant destination.

## Conditions

The five local conditions are recorded only in local plans and results. Provider-visible prompts contain actual source text and, where applicable, condition-neutral semantic references. Plain has no reference; irrelevant has a non-target semantic object; identity has IDs/aliases/categories; definition adds bounded definitions; definition+relations adds only bounded fixture-relevant relations.

## Outcomes and analysis

Primary outcomes: deterministic verified grounding accuracy and unsupported semantic-overreach count against each fixture's allowed commitment set. Secondary outcomes: ambiguity preservation, quantifier/relation/speech-act fidelity, missing-information recognition, invalid-output rate, and provider failure rate. Include only preflight-valid trials; exclude treatment-invalid outcomes; never impute or retry failures. Stop after all 180 planned trials or an explicit provider/environment failure. Report repeated runs separately with no significance testing.

## Privacy and limits

All sources and semantic objects are synthetic; no Vault data or credentials are present. This small synthetic experiment cannot support a general superiority claim. Experiment 03 motivated label invisibility, real fixture freezing, prompt snapshots, and definition hashing.
