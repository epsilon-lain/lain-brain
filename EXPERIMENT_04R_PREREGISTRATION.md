# Experiment 04R Preregistration

## Status

FROZEN OFFLINE DESIGN. No provider request is authorized by this document.

## Why Experiment 04R exists

Experiment 04 (`experiment04-semantic-fidelity-v1`) was blocked pre-live by human review due to answer-bearing-context confounding: several provider-visible semantic definitions/relations conflated useful Personal Brain context with directly supplying the scored answer. Experiment 04 made zero provider calls; no Experiment 04 live result exists and none is implied. The original Experiment 04 files and artifacts remain frozen and unchanged as historical evidence of that failure.

Experiment 04R (`experiment04-semantic-fidelity-v1-r1`) is a new frozen revision: the same 12 fixtures, 5 conditions, 3 repetitions, seed, and provider/model, with de-leaked treatment content, a typed per-fixture answer-bearing-context audit manifest, deterministic forbidden-fragment regression guards, and hard evaluator-metadata-absence preflight checks.

## Research question and hypotheses

Does bounded synthetic Personal Brain semantic context improve locally verified grounding without increasing unsupported semantic commitments? H1: relevant identity/definition context improves verified grounding where personal meaning is required. H2: richer context can alter overreach in either direction. H3: no material advantage is expected for the precise logical fixture. H4: matched irrelevant material must not reproduce relevant grounding.

## Frozen design

- Definition SHA-256: `55711fa7ea44fb3979f618d04c7964d19214cef29525debdd28894a355899d5d`
- Fixture table SHA-256: `128909ec3b740496671415cc3989228ec30b4bbf89724806f3930163b428b9d5`
- Treatment manifest SHA-256: `2603e22d59fcc609b1cfc0fa2ade5e9839843b517ee836a2da2ae6b636b7d265`
- Common task prompt SHA-256: `979ed816c0c7b5c771b7f5545b091a33aa9b634dfca7d1b9379bee3969484ea4`
- Response schema SHA-256: `7f31d0cd9f8f50f4e0918db5ab737725fa1933d9e6fd17120815622ef3c2f29e`
- Answer-bearing-context audit manifest SHA-256: `0eab2e7097c76da5443a42c0565324163bf02d2f0c396958683516f2382879db`
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

## Answer-bearing-context audit

Every fixture has exactly one human-reviewed audit entry; all gates (definitionSourceIndependent, relationsSourceIndependent, noSpeechActLeakage, noMissingConditionLeakage, noRevisionAnswerLeakage) are true before preflight can pass. Deterministic forbidden-fragment and evaluator-metadata-absence checks run over every provider-visible rendered message; they are regression guards only and are not a substitute for human review.

- `harbor-private-meaning`: 04 context supplied the keep-or-remove review content and the return-before-decision ordering, both overlapping the scored inference. 04R defines harbor only as a generic personal checkpoint for reviewing active commitments, with an indexing relation; the keep/remove decision and temporal ordering must come from the source.
- `lantern-private-meaning`: 04 stated that the lantern keeps the associated project open, restating the source's closure-blocking conclusion. 04R describes lantern as a project-continuity handle with a status-notes storage relation only; whether the project stays open remains an inference from the source.
- `compass-private-meaning`: 04 supplied the narrowing-to-reversible-step criterion that overlaps the scored answer. 04R keeps only a generic structuring-tool meaning and a discussion-planning indexing relation; the narrowing outcome must come from the source.
- `field-overload`: 04's relation pre-answered the may-split outcome and its two-cluster shape. 04R records only that examples group under a shared working question; the split condition and its shape must come from the source.
- `proof-overload`: 04 restated the supports relation and step-by-step retrace ability. 04R gives a neutral derivation-artifact definition and a storage relation; the retrace-until-checked inference stays with the source.
- `bridge-ambiguity`: 04's provider-visible IDs named the intended readings. 04R uses semantically neutral bridge-a and bridge-b IDs; both candidates remain present and no single resolution is suggested, preserving the scored ambiguity.
- `normal-operator-missing-assumption`: 04 named the missing finite-dimensionality qualification, pre-answering the missing-condition recognition that is scored. 04R context contains no scope qualification; recognition of the missing scope must come from the source and general background knowledge.
- `modus-ponens-precision`: 04 restated the implication-and-antecedent inference the source already states. 04R provides only the pattern's name and its vocabulary category; the derivation remains a source inference.
- `delta-control`: 04's definition labeled the semantic difference between two versions and its relation restated the two-version comparison. 04R defines delta as an annotation on a change with a storage relation; the mark-before-comparing ordering stays with the source.
- `boundary-definition`: 04's definition restated the source's final-explicit-distinction content. 04R keeps a minimal named-distinction meaning with a combination-notes indexing relation; the source's own wording remains the basis for the definition speech-act judgment.
- `spectral-proof-sketch`: 04's context proposed the diagonalization step and noted unchecked hypotheses, pre-answering the proof-status judgment. 04R records only a theorem-reference note object and a linkage relation; the provisional status of the next step must be judged from the source.
- `compass-revision`: 04 stated that the current criterion selects reversible steps and supersedes the prior revision, pre-answering which revision is current and what it selects. 04R records only that two stored revisions exist and are distinct; which revision is current and what it asks for remain source judgments.

## Outcomes and analysis

Primary outcomes: deterministic verified grounding accuracy and unsupported semantic-overreach count against each fixture's allowed commitment set. Secondary outcomes: ambiguity preservation, quantifier/relation/speech-act fidelity, missing-information recognition, invalid-output rate, and provider failure rate. Include only preflight-valid trials; exclude treatment-invalid outcomes; never impute or retry failures. Stop after all 180 planned trials or an explicit provider/environment failure. Report repeated runs separately with no significance testing.

## Privacy and limits

All sources and semantic objects are synthetic; no Vault data or credentials are present. This small synthetic experiment cannot support a general superiority claim. Experiment 04's human-review block motivated the 04R answer-bearing-context audit manifest and leak gates.

## Authorization

This offline dry run made zero provider/network requests and authorizes nothing. No Experiment 04R live request is authorized merely by the offline dry run; any live run requires separate, explicit human approval.
