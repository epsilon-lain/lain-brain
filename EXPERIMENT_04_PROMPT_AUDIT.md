# Experiment 04 Prompt Audit

Internal experiment condition IDs are **NOT** model-visible. The complete offline snapshot set is at `research-audit/experiment04/provider-prompt-snapshots.md`. Only the semantic reference changes across conditions for a fixture; source text and common task prompt are byte-identical.

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
Definition: A deliberate pause used to review commitments before removing or keeping them.
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
Definition: A deliberate pause used to review commitments before removing or keeping them.
Relation: harbor precedes the keep-or-remove review
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
Definition: An enduring project that remains open while it can still organize useful work.
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
Definition: An enduring project that remains open while it can still organize useful work.
Relation: lantern keeps the associated project open
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
Definition: A short written criterion that narrows a discussion to the next reversible step.
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
Definition: A short written criterion that narrows a discussion to the next reversible step.
Relation: compass narrows a decision to one reversible step
```
