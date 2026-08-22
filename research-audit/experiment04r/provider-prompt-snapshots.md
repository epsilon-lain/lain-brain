# Experiment 04R Provider-visible Prompt Snapshots

Internal experiment condition IDs, fixture IDs, and evaluator metadata are NOT model-visible; section headings are local audit metadata only.

## harbor-private-meaning

### plain_llm

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
I need to return to the harbor before I decide what to keep.
```

### irrelevant_context

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
I need to return to the harbor before I decide what to keep.

Semantic reference:
Concept ID: synthetic://background/evening-ledger@1
Aliases: lattice, evening ledger
Category: personal_note
Definition: A private weekly record of small practical observations.
Relation: evening ledger is maintained alongside a calendar
```

### brain_identity_only

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
I need to return to the harbor before I decide what to keep.

Semantic reference:
Concept ID: synthetic://personal/harbor@1@1
Aliases: harbor, the harbor
Category: personal_concept
```

### brain_definition

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
I need to return to the harbor before I decide what to keep.

Semantic reference:
Concept ID: synthetic://personal/harbor@1@1
Aliases: harbor, the harbor
Category: personal_concept
Definition: A personal checkpoint for pausing and reviewing active commitments.
```

### brain_definition_plus_relations

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
I need to return to the harbor before I decide what to keep.

Semantic reference:
Concept ID: synthetic://personal/harbor@1@1
Aliases: harbor, the harbor
Category: personal_concept
Definition: A personal checkpoint for pausing and reviewing active commitments.
Relation: harbor is indexed with commitment-review notes
```

## lantern-private-meaning

### plain_llm

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
The lantern is still lit, so I will not close the project yet.
```

### irrelevant_context

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
The lantern is still lit, so I will not close the project yet.

Semantic reference:
Concept ID: synthetic://background/evening-ledger@1
Aliases: lattice, evening ledger
Category: personal_note
Definition: A private weekly record of small practical observations.
Relation: evening ledger is maintained alongside a calendar
```

### brain_identity_only

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
The lantern is still lit, so I will not close the project yet.

Semantic reference:
Concept ID: synthetic://personal/lantern@2@1
Aliases: lantern, the lantern
Category: personal_concept
```

### brain_definition

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
The lantern is still lit, so I will not close the project yet.

Semantic reference:
Concept ID: synthetic://personal/lantern@2@1
Aliases: lantern, the lantern
Category: personal_concept
Definition: A personal handle used to track the continuity of a long-running project across work sessions.
```

### brain_definition_plus_relations

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
The lantern is still lit, so I will not close the project yet.

Semantic reference:
Concept ID: synthetic://personal/lantern@2@1
Aliases: lantern, the lantern
Category: personal_concept
Definition: A personal handle used to track the continuity of a long-running project across work sessions.
Relation: lantern is recorded with the associated project's status notes
```

## compass-private-meaning

### plain_llm

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
Use the compass when the discussion starts collecting too many possible directions.
```

### irrelevant_context

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
Use the compass when the discussion starts collecting too many possible directions.

Semantic reference:
Concept ID: synthetic://background/evening-ledger@1
Aliases: lattice, evening ledger
Category: personal_note
Definition: A private weekly record of small practical observations.
Relation: evening ledger is maintained alongside a calendar
```

### brain_identity_only

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
Use the compass when the discussion starts collecting too many possible directions.

Semantic reference:
Concept ID: synthetic://personal/compass@2@1
Aliases: compass, the compass
Category: personal_concept
```

### brain_definition

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
Use the compass when the discussion starts collecting too many possible directions.

Semantic reference:
Concept ID: synthetic://personal/compass@2@1
Aliases: compass, the compass
Category: personal_concept
Definition: A personal discussion tool used when an open set of choices needs structure.
```

### brain_definition_plus_relations

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
Use the compass when the discussion starts collecting too many possible directions.

Semantic reference:
Concept ID: synthetic://personal/compass@2@1
Aliases: compass, the compass
Category: personal_concept
Definition: A personal discussion tool used when an open set of choices needs structure.
Relation: compass is indexed with discussion-planning notes
```

## field-overload

### plain_llm

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
This field is ready to split once its examples no longer answer the same question.
```

### irrelevant_context

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
This field is ready to split once its examples no longer answer the same question.

Semantic reference:
Concept ID: synthetic://background/evening-ledger@1
Aliases: lattice, evening ledger
Category: personal_note
Definition: A private weekly record of small practical observations.
Relation: evening ledger is maintained alongside a calendar
```

### brain_identity_only

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
This field is ready to split once its examples no longer answer the same question.

Semantic reference:
Concept ID: synthetic://personal/field@1@1
Aliases: field, this field
Category: personal_concept
```

### brain_definition

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
This field is ready to split once its examples no longer answer the same question.

Semantic reference:
Concept ID: synthetic://personal/field@1@1
Aliases: field, this field
Category: personal_concept
Definition: A bounded cluster of questions, examples, and working distinctions maintained together.
```

### brain_definition_plus_relations

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
This field is ready to split once its examples no longer answer the same question.

Semantic reference:
Concept ID: synthetic://personal/field@1@1
Aliases: field, this field
Category: personal_concept
Definition: A bounded cluster of questions, examples, and working distinctions maintained together.
Relation: field groups examples under a shared working question
```

## proof-overload

### plain_llm

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
Keep the proof beside the claim until someone can retrace each step.
```

### irrelevant_context

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
Keep the proof beside the claim until someone can retrace each step.

Semantic reference:
Concept ID: synthetic://background/evening-ledger@1
Aliases: lattice, evening ledger
Category: personal_note
Definition: A private weekly record of small practical observations.
Relation: evening ledger is maintained alongside a calendar
```

### brain_identity_only

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
Keep the proof beside the claim until someone can retrace each step.

Semantic reference:
Concept ID: synthetic://personal/proof@1@1
Aliases: proof, the proof
Category: personal_concept
```

### brain_definition

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
Keep the proof beside the claim until someone can retrace each step.

Semantic reference:
Concept ID: synthetic://personal/proof@1@1
Aliases: proof, the proof
Category: personal_concept
Definition: A project-local derivation artifact composed of explicit steps.
```

### brain_definition_plus_relations

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
Keep the proof beside the claim until someone can retrace each step.

Semantic reference:
Concept ID: synthetic://personal/proof@1@1
Aliases: proof, the proof
Category: personal_concept
Definition: A project-local derivation artifact composed of explicit steps.
Relation: proof is stored with its associated claim
```

## bridge-ambiguity

### plain_llm

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
The bridge is not ready; both readings still fit the note.
```

### irrelevant_context

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
The bridge is not ready; both readings still fit the note.

Semantic reference:
Concept ID: synthetic://background/evening-ledger@1
Aliases: lattice, evening ledger
Category: personal_note
Definition: A private weekly record of small practical observations.
Relation: evening ledger is maintained alongside a calendar
```

### brain_identity_only

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
The bridge is not ready; both readings still fit the note.

Semantic reference:
Concept ID: synthetic://personal/bridge-a@1@1
Aliases: bridge, the bridge
Category: personal_concept

Concept ID: synthetic://personal/bridge-b@1@1
Aliases: bridge, the bridge
Category: personal_concept
```

### brain_definition

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
The bridge is not ready; both readings still fit the note.

Semantic reference:
Concept ID: synthetic://personal/bridge-a@1@1
Aliases: bridge, the bridge
Category: personal_concept
Definition: A note that translates between two collaborators' vocabularies.

Concept ID: synthetic://personal/bridge-b@1@1
Aliases: bridge, the bridge
Category: personal_concept
Definition: A provisional step linking an earlier definition to its revised form.
```

### brain_definition_plus_relations

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
The bridge is not ready; both readings still fit the note.

Semantic reference:
Concept ID: synthetic://personal/bridge-a@1@1
Aliases: bridge, the bridge
Category: personal_concept
Definition: A note that translates between two collaborators' vocabularies.
Relation: bridge-a connects two vocabularies

Concept ID: synthetic://personal/bridge-b@1@1
Aliases: bridge, the bridge
Category: personal_concept
Definition: A provisional step linking an earlier definition to its revised form.
Relation: bridge-b links two revisions
```

## normal-operator-missing-assumption

### plain_llm

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
Every normal operator has an eigenbasis.
```

### irrelevant_context

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
Every normal operator has an eigenbasis.

Semantic reference:
Concept ID: synthetic://background/evening-ledger@1
Aliases: lattice, evening ledger
Category: personal_note
Definition: A private weekly record of small practical observations.
Relation: evening ledger is maintained alongside a calendar
```

### brain_identity_only

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
Every normal operator has an eigenbasis.

Semantic reference:
Concept ID: synthetic://personal/normal-operator@1@1
Aliases: normal operator, normal operators
Category: mathematical_term
```

### brain_definition

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
Every normal operator has an eigenbasis.

Semantic reference:
Concept ID: synthetic://personal/normal-operator@1@1
Aliases: normal operator, normal operators
Category: mathematical_term
Definition: An operator treated under the project's standard Hilbert-space vocabulary.
```

### brain_definition_plus_relations

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
Every normal operator has an eigenbasis.

Semantic reference:
Concept ID: synthetic://personal/normal-operator@1@1
Aliases: normal operator, normal operators
Category: mathematical_term
Definition: An operator treated under the project's standard Hilbert-space vocabulary.
Relation: normal operator is indexed in the project's operator glossary
```

## modus-ponens-precision

### plain_llm

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
If P implies Q, and P holds, then Q holds.
```

### irrelevant_context

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
If P implies Q, and P holds, then Q holds.

Semantic reference:
Concept ID: synthetic://background/evening-ledger@1
Aliases: lattice, evening ledger
Category: personal_note
Definition: A private weekly record of small practical observations.
Relation: evening ledger is maintained alongside a calendar
```

### brain_identity_only

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
If P implies Q, and P holds, then Q holds.

Semantic reference:
Concept ID: synthetic://personal/modus-ponens@1@1
Aliases: modus ponens
Category: logical_pattern
```

### brain_definition

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
If P implies Q, and P holds, then Q holds.

Semantic reference:
Concept ID: synthetic://personal/modus-ponens@1@1
Aliases: modus ponens
Category: logical_pattern
Definition: A named inference pattern in the project's logic vocabulary.
```

### brain_definition_plus_relations

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
If P implies Q, and P holds, then Q holds.

Semantic reference:
Concept ID: synthetic://personal/modus-ponens@1@1
Aliases: modus ponens
Category: logical_pattern
Definition: A named inference pattern in the project's logic vocabulary.
Relation: modus ponens is indexed under inference patterns
```

## delta-control

### plain_llm

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
Mark the delta before comparing the two versions.
```

### irrelevant_context

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
Mark the delta before comparing the two versions.

Semantic reference:
Concept ID: synthetic://background/evening-ledger@1
Aliases: lattice, evening ledger
Category: personal_note
Definition: A private weekly record of small practical observations.
Relation: evening ledger is maintained alongside a calendar
```

### brain_identity_only

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
Mark the delta before comparing the two versions.

Semantic reference:
Concept ID: synthetic://personal/delta@1@1
Aliases: delta, the delta
Category: personal_concept
```

### brain_definition

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
Mark the delta before comparing the two versions.

Semantic reference:
Concept ID: synthetic://personal/delta@1@1
Aliases: delta, the delta
Category: personal_concept
Definition: A reviewed annotation attached to a change between two versions of one concept.
```

### brain_definition_plus_relations

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
Mark the delta before comparing the two versions.

Semantic reference:
Concept ID: synthetic://personal/delta@1@1
Aliases: delta, the delta
Category: personal_concept
Definition: A reviewed annotation attached to a change between two versions of one concept.
Relation: delta is stored with the revision pair it describes
```

## boundary-definition

### plain_llm

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
By boundary I mean the last distinction that must remain explicit before we combine two ideas.
```

### irrelevant_context

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
By boundary I mean the last distinction that must remain explicit before we combine two ideas.

Semantic reference:
Concept ID: synthetic://background/evening-ledger@1
Aliases: lattice, evening ledger
Category: personal_note
Definition: A private weekly record of small practical observations.
Relation: evening ledger is maintained alongside a calendar
```

### brain_identity_only

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
By boundary I mean the last distinction that must remain explicit before we combine two ideas.

Semantic reference:
Concept ID: synthetic://personal/boundary@1@1
Aliases: boundary, the boundary
Category: personal_concept
```

### brain_definition

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
By boundary I mean the last distinction that must remain explicit before we combine two ideas.

Semantic reference:
Concept ID: synthetic://personal/boundary@1@1
Aliases: boundary, the boundary
Category: personal_concept
Definition: A named distinction tracked in notes about combining concepts.
```

### brain_definition_plus_relations

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
By boundary I mean the last distinction that must remain explicit before we combine two ideas.

Semantic reference:
Concept ID: synthetic://personal/boundary@1@1
Aliases: boundary, the boundary
Category: personal_concept
Definition: A named distinction tracked in notes about combining concepts.
Relation: boundary is indexed with concept-combination notes
```

## spectral-proof-sketch

### plain_llm

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
Since the spectral theorem applies here, the next step is to diagonalize T.
```

### irrelevant_context

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
Since the spectral theorem applies here, the next step is to diagonalize T.

Semantic reference:
Concept ID: synthetic://background/evening-ledger@1
Aliases: lattice, evening ledger
Category: personal_note
Definition: A private weekly record of small practical observations.
Relation: evening ledger is maintained alongside a calendar
```

### brain_identity_only

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
Since the spectral theorem applies here, the next step is to diagonalize T.

Semantic reference:
Concept ID: synthetic://personal/spectral-step@1@1
Aliases: spectral theorem
Category: mathematical_note
```

### brain_definition

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
Since the spectral theorem applies here, the next step is to diagonalize T.

Semantic reference:
Concept ID: synthetic://personal/spectral-step@1@1
Aliases: spectral theorem
Category: mathematical_note
Definition: A project-local note object for recording a named theorem reference during mathematical work.
```

### brain_definition_plus_relations

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
Since the spectral theorem applies here, the next step is to diagonalize T.

Semantic reference:
Concept ID: synthetic://personal/spectral-step@1@1
Aliases: spectral theorem
Category: mathematical_note
Definition: A project-local note object for recording a named theorem reference during mathematical work.
Relation: spectral-step is linked to the surrounding mathematical note
```

## compass-revision

### plain_llm

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
The compass now asks for the next reversible step, not the most elegant destination.
```

### irrelevant_context

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
The compass now asks for the next reversible step, not the most elegant destination.

Semantic reference:
Concept ID: synthetic://background/evening-ledger@1
Aliases: lattice, evening ledger
Category: personal_note
Definition: A private weekly record of small practical observations.
Relation: evening ledger is maintained alongside a calendar
```

### brain_identity_only

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
The compass now asks for the next reversible step, not the most elegant destination.

Semantic reference:
Concept ID: synthetic://personal/compass@2@1
Aliases: compass, the compass
Category: personal_concept
```

### brain_definition

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
The compass now asks for the next reversible step, not the most elegant destination.

Semantic reference:
Concept ID: synthetic://personal/compass@2@1
Aliases: compass, the compass
Category: personal_concept
Definition: A stored revision of the personal compass criterion used in discussions.
```

### brain_definition_plus_relations

```text
system:
Analyze the source while preserving the user's intended semantics.
Use a supplied concept ID only when the source truly refers to its alias or handle.
Do not invent missing personal identities; unresolved concepts may remain unresolved.
Preserve genuine ambiguity instead of forcing a resolution.
Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.
Return strict JSON with this schema:
{"type":"object","required":["conceptBindings","semanticCommitments","sourceStatedConditions","treatmentContextConditions","missingConditions","assumedConditions","ambiguities","quantifier","relations","speechAct"],"conceptBinding":{"surfacePhrase":"string","conceptId":"string|null","status":"resolved|ambiguous|unresolved|proposed_new"},"channels":"arrays of canonical semantic fact labels or short source-grounded statements"}

user:
Source text:
The compass now asks for the next reversible step, not the most elegant destination.

Semantic reference:
Concept ID: synthetic://personal/compass@2@1
Aliases: compass, the compass
Category: personal_concept
Definition: A stored revision of the personal compass criterion used in discussions.
Relation: compass@2 and compass@1 are distinct stored revisions
```
