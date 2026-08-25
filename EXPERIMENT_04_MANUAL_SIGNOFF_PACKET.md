# Experiment 04 Manual Sign-off Packet

## 1. Frozen identity

- Git commit: `85ef924c689556f4176d53910d202ad83f472b7c`
- Definition SHA-256: `552b95d2a008ef77daeb47aaa80087e0953411d226f0c26250207f2396d06711`
- Fixture-table SHA-256: `04e356cc19f106066e73c0a30cf6c09c2f836fce1bad489996c7b17e02a88a0f`
- Treatment-manifest SHA-256: `2603e22d59fcc609b1cfc0fa2ade5e9839843b517ee836a2da2ae6b636b7d265`
- Common-prompt SHA-256: `979ed816c0c7b5c771b7f5545b091a33aa9b634dfca7d1b9379bee3969484ea4`
- Response-schema SHA-256: `7f31d0cd9f8f50f4e0918db5ab737725fa1933d9e6fd17120815622ef3c2f29e`
- Provider/model: DeepSeek / deepseek-v4-flash
- Seed: 240417; fixtures: 12; conditions: 5; repetitions: 3; planned trials: 180

All values match the frozen experiment definition. This is an audit artifact, not a redesign.

## 2. Reviewer criteria

For every fixture, independently assess: source validity; plain fairness; irrelevant-context fairness; identity-only purity; definition purity; definition+relations purity; condition neutrality; grounding validity; overreach validity; and speech-act/logic validity. In particular, confirm that plain is not handicapped, irrelevant material is genuinely non-target, rich context does not simply state the desired answer, the common task/source/schema are unchanged, ambiguity remains ambiguity, and local ground truth is defensible.

## 3. All frozen fixtures and provider-visible prompts

## 0. harbor-private-meaning

**Exact source text:** I need to return to the harbor before I decide what to keep.

**Research rationale:** Harbor has a private planning meaning unlike its public geographic meaning.

**Expected binding(s):**
- required: `synthetic://personal/harbor@1@1`; accepted forms: harbor, the harbor

**Expected ambiguity:** No ambiguity preservation requirement.

**Expected speech act:** intention

**Expected quantifier / relation behavior:** no special quantifier; temporal_precedence.

**Licensed commitments:** RETURN_TO_HARBOR_BEFORE_DECISION, HARBOR_IS_REVIEW_PAUSE

**Forbidden commitments:** HARBOR_IS_SEAPORT

### Treatment sufficiency and condition-diff audit

Within this fixture, source/common task/response schema are mechanically identical; only semantic-reference payload is permitted to differ.

| Local condition | Source SHA | Context SHA | Chars | Target semantics present | Grounding expectation | Ambiguity retained | Final request SHA |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| plain_llm | cdac3d261b652c85d0da31eb1a71e75d77a02e10a19864d7e7f3287f810ea8de | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | 0 | false | required | false | 0fba968b653a015a11bba841f44f8fe325bd9050c5d1b515d356809dffd7397d |
| irrelevant_context | cdac3d261b652c85d0da31eb1a71e75d77a02e10a19864d7e7f3287f810ea8de | a5fdc16d009a68fbf2260654c4ac11579adaae4a141ffa83b085cf39a9f11bac | 237 | false | required | false | 11f977045ca38d5bcd50a0e6682752cc76d7e7011b4f4b8e96d7f0f3afebf11b |
| brain_identity_only | cdac3d261b652c85d0da31eb1a71e75d77a02e10a19864d7e7f3287f810ea8de | 95b09aaca1aaa324f801617002444d93d0c88ed31303825332de2047d2acf9f6 | 98 | true | required | false | 10ee4df552279b57e8ba0601796b03d290898991d34e6b19b88a13f610b70a77 |
| brain_definition | cdac3d261b652c85d0da31eb1a71e75d77a02e10a19864d7e7f3287f810ea8de | 57753e604175e8a382a1496a86af2613ac4cf8cc9e0c7bf54c918f008d0f48a4 | 189 | true | required | false | e14def6d87a3d583e49d4c011f6563c4e7e03461de3b7ca0b471bea5074c1a87 |
| brain_definition_plus_relations | cdac3d261b652c85d0da31eb1a71e75d77a02e10a19864d7e7f3287f810ea8de | cfd4c798fae6a60291003b4415ecbdcdc51cf1c1d37acc914fb9bdb6fe88567c | 241 | true | required | false | a6e66a0e0ca02b70a2daf75ab077de1bc9a90a30ebb9b880af1c5326f78b9e92 |

### All exact provider-visible prompts

### Local audit heading: plain_llm

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: irrelevant_context

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: brain_identity_only

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: brain_definition

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: brain_definition_plus_relations

*The heading is not provider-visible; the exact frozen request body follows.*

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

## 1. lantern-private-meaning

**Exact source text:** The lantern is still lit, so I will not close the project yet.

**Research rationale:** Lantern is a private project-status handle rather than a physical object.

**Expected binding(s):**
- required: `synthetic://personal/lantern@2@1`; accepted forms: lantern, the lantern

**Expected ambiguity:** No ambiguity preservation requirement.

**Expected speech act:** assertion

**Expected quantifier / relation behavior:** no special quantifier; blocks.

**Licensed commitments:** LIT_LANTERN_BLOCKS_PROJECT_CLOSURE, LANTERN_IS_ENDURING_PROJECT

**Forbidden commitments:** LANTERN_IS_PHYSICAL_LIGHT

### Treatment sufficiency and condition-diff audit

Within this fixture, source/common task/response schema are mechanically identical; only semantic-reference payload is permitted to differ.

| Local condition | Source SHA | Context SHA | Chars | Target semantics present | Grounding expectation | Ambiguity retained | Final request SHA |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| plain_llm | a5e2d4f1542f6c57fdff1ae2bcc58b733d4f7692c6abc8ede15dc5f78f415b03 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | 0 | false | required | false | 91b94889b88a4234b6d17cb22a0c07d3f1e93ae8d2c420053e3335f2fc0bb79a |
| irrelevant_context | a5e2d4f1542f6c57fdff1ae2bcc58b733d4f7692c6abc8ede15dc5f78f415b03 | a5fdc16d009a68fbf2260654c4ac11579adaae4a141ffa83b085cf39a9f11bac | 237 | false | required | false | 7332f16109eed832b22a7be185ae7e335c6ad03349bb891ac0fc4ecdf43e6f5a |
| brain_identity_only | a5e2d4f1542f6c57fdff1ae2bcc58b733d4f7692c6abc8ede15dc5f78f415b03 | 41e3162feb3baff8529243001578b2efc8f781670841476abf75d9537f6b06ec | 101 | true | required | false | 82ec463e4baad642fa09f5ebd7dd9bc72117b1fcc590e9e2e6b9159c84e5f085 |
| brain_definition | a5e2d4f1542f6c57fdff1ae2bcc58b733d4f7692c6abc8ede15dc5f78f415b03 | dc52d0b2a732fb3e753d56e7bac8916366fe45261c9c29c62a7405ce32c75299 | 192 | true | required | false | 8ae2bdd66b3b96493626ba34f661d0049b177f70dafe68fdc214d029e83e73b3 |
| brain_definition_plus_relations | a5e2d4f1542f6c57fdff1ae2bcc58b733d4f7692c6abc8ede15dc5f78f415b03 | 733851d1ea191ef21fdac46e5848482df1cf303a2112d94da42adcfb7a5b9066 | 244 | true | required | false | 19a4208542228ef6830f284e3e2e68cb84f2290f2b77339ef3597a3a5be7db55 |

### All exact provider-visible prompts

### Local audit heading: plain_llm

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: irrelevant_context

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: brain_identity_only

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: brain_definition

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: brain_definition_plus_relations

*The heading is not provider-visible; the exact frozen request body follows.*

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

## 2. compass-private-meaning

**Exact source text:** Use the compass when the discussion starts collecting too many possible directions.

**Research rationale:** Compass has a private deliberation meaning unlike a navigational instrument.

**Expected binding(s):**
- required: `synthetic://personal/compass@2@1`; accepted forms: compass, the compass

**Expected ambiguity:** No ambiguity preservation requirement.

**Expected speech act:** instruction

**Expected quantifier / relation behavior:** no special quantifier; narrows.

**Licensed commitments:** COMPASS_USED_FOR_DIRECTION_OVERLOAD, COMPASS_IS_REVERSIBLE_STEP_CRITERION

**Forbidden commitments:** COMPASS_IS_NAVIGATION_TOOL

### Treatment sufficiency and condition-diff audit

Within this fixture, source/common task/response schema are mechanically identical; only semantic-reference payload is permitted to differ.

| Local condition | Source SHA | Context SHA | Chars | Target semantics present | Grounding expectation | Ambiguity retained | Final request SHA |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| plain_llm | ae10120b95c5c383efe077b0086e63687a4ac1b930fe9a76bfa9f86b5bffe45d | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | 0 | false | required | false | 568aa89b3bb558e3109ece496f52219c1927e499b0e821311d0e5d873141d47b |
| irrelevant_context | ae10120b95c5c383efe077b0086e63687a4ac1b930fe9a76bfa9f86b5bffe45d | a5fdc16d009a68fbf2260654c4ac11579adaae4a141ffa83b085cf39a9f11bac | 237 | false | required | false | 5bb3ee80512bf8d32995924fd61939b2f4f3987fff70c81594f9b622e92c419e |
| brain_identity_only | ae10120b95c5c383efe077b0086e63687a4ac1b930fe9a76bfa9f86b5bffe45d | 1acc798aa39f7810572dfd3bb98a1e3bfd9f908235b9b92eccffb8bb7e567bea | 101 | true | required | false | a4335658852a84ecdcc4f9c17470ce299a68a6e13dd72f938c0adcae4a09b5a3 |
| brain_definition | ae10120b95c5c383efe077b0086e63687a4ac1b930fe9a76bfa9f86b5bffe45d | e5111ea84d194e630c2f8f82dddc5091f6ca6ff0a8556c13f427075db64d6cda | 194 | true | required | false | a86bb3706551112fafbde89fb1d619a1dba962e25a3adde5c002d5574f18d3ff |
| brain_definition_plus_relations | ae10120b95c5c383efe077b0086e63687a4ac1b930fe9a76bfa9f86b5bffe45d | a51a980cc1009fe99274789037c3720f8dd88e3268d10ce5e6028afbea3a1ad2 | 254 | true | required | false | bb563fab81ead718c168500802a31b1ac9c58730d6b0fb3970420d72e129556b |

### All exact provider-visible prompts

### Local audit heading: plain_llm

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: irrelevant_context

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: brain_identity_only

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: brain_definition

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: brain_definition_plus_relations

*The heading is not provider-visible; the exact frozen request body follows.*

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

## 3. field-overload

**Exact source text:** This field is ready to split once its examples no longer answer the same question.

**Research rationale:** Field is a private inquiry cluster, not an agricultural or mathematical field.

**Expected binding(s):**
- required: `synthetic://personal/field@1@1`; accepted forms: field, this field

**Expected ambiguity:** No ambiguity preservation requirement.

**Expected speech act:** assertion

**Expected quantifier / relation behavior:** no special quantifier; may_split.

**Licensed commitments:** FIELD_SPLITS_WHEN_EXAMPLES_DIVERGE, FIELD_IS_INQUIRY_CLUSTER

**Forbidden commitments:** FIELD_IS_ALGEBRAIC_STRUCTURE, FIELD_IS_LAND

### Treatment sufficiency and condition-diff audit

Within this fixture, source/common task/response schema are mechanically identical; only semantic-reference payload is permitted to differ.

| Local condition | Source SHA | Context SHA | Chars | Target semantics present | Grounding expectation | Ambiguity retained | Final request SHA |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| plain_llm | b25653833a1df852f36f58372f6430d4efe50f7cfcd0d0c594d6b79425dd6f10 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | 0 | false | required | false | fe5d574e49926805abbc1745d2d3a0fe69de07938788e9aa051015ec09e0084b |
| irrelevant_context | b25653833a1df852f36f58372f6430d4efe50f7cfcd0d0c594d6b79425dd6f10 | a5fdc16d009a68fbf2260654c4ac11579adaae4a141ffa83b085cf39a9f11bac | 237 | false | required | false | d9247e8d9ebf3bcbba2dc9fba1332411632ef6a10170a18b3378849c18f37b14 |
| brain_identity_only | b25653833a1df852f36f58372f6430d4efe50f7cfcd0d0c594d6b79425dd6f10 | 8bad8d1b959f032e975e6364eaae76b4632af4d8e469f3db20627ee45ee2209c | 96 | true | required | false | 81e9d8b4f13c58ba64cbca8712827a5f8f48ddf2ec64a473ecf44466ed6dc25b |
| brain_definition | b25653833a1df852f36f58372f6430d4efe50f7cfcd0d0c594d6b79425dd6f10 | 43a3055e9825db86e841e05d46ddf0ca4fb50273dff93991d03e3d45d665fd68 | 196 | true | required | false | b01d6b5e1d1f5d3d84441bb7bc4c9deebd12138a3948ee2b71688eb190582f9a |
| brain_definition_plus_relations | b25653833a1df852f36f58372f6430d4efe50f7cfcd0d0c594d6b79425dd6f10 | b2aca80d4de3a5de079bc2135081fc1aaee2ebd9f3c9863514f14e2321ed8d6f | 248 | true | required | false | 44e1cc1a6c5f7252955d3b0d8e55ef592f9134e218b9339fdd5404165411825a |

### All exact provider-visible prompts

### Local audit heading: plain_llm

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: irrelevant_context

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: brain_identity_only

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: brain_definition

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: brain_definition_plus_relations

*The heading is not provider-visible; the exact frozen request body follows.*

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
Relation: field may split into two inquiry clusters
```

## 4. proof-overload

**Exact source text:** Keep the proof beside the claim until someone can retrace each step.

**Research rationale:** Proof is a reviewed derivation artifact, not generic evidence or a beverage.

**Expected binding(s):**
- required: `synthetic://personal/proof@1@1`; accepted forms: proof, the proof

**Expected ambiguity:** No ambiguity preservation requirement.

**Expected speech act:** instruction

**Expected quantifier / relation behavior:** no special quantifier; supports.

**Licensed commitments:** PROOF_REMAINS_WITH_CLAIM_FOR_RETRACE, PROOF_IS_CHECKABLE_DERIVATION

**Forbidden commitments:** PROOF_IS_GENERIC_EVIDENCE

### Treatment sufficiency and condition-diff audit

Within this fixture, source/common task/response schema are mechanically identical; only semantic-reference payload is permitted to differ.

| Local condition | Source SHA | Context SHA | Chars | Target semantics present | Grounding expectation | Ambiguity retained | Final request SHA |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| plain_llm | 156b16e430e6ecd5f70076318fe00776267d0d46e116ad0c697c0c33a1be212a | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | 0 | false | required | false | b2db02aa852acc08b75c564f8e7e3fb1918ca67ccf53f55179668aa88bca5b8b |
| irrelevant_context | 156b16e430e6ecd5f70076318fe00776267d0d46e116ad0c697c0c33a1be212a | a5fdc16d009a68fbf2260654c4ac11579adaae4a141ffa83b085cf39a9f11bac | 237 | false | required | false | 6b7607a4ac410f47c83d472b2b8979e89c01fdbb0ca50fea2451ff11a4a17196 |
| brain_identity_only | 156b16e430e6ecd5f70076318fe00776267d0d46e116ad0c697c0c33a1be212a | 8992274b5d4eed9c0436dbdd8a2afd856fd8ed20100a834c00a1da223ee80918 | 95 | true | required | false | c890f49da6c962d426c9a7349da02f0fe8cd93a3208a79c944962ad78b315d74 |
| brain_definition | 156b16e430e6ecd5f70076318fe00776267d0d46e116ad0c697c0c33a1be212a | 545600cb64c33c0fba4f96d259d38cd762786b4a597823f02962832e6e5f43db | 187 | true | required | false | 075c01322f59ae22f0919cfbdaad945e4d6ee1b5be753a33c00eb95ecd2b733b |
| brain_definition_plus_relations | 156b16e430e6ecd5f70076318fe00776267d0d46e116ad0c697c0c33a1be212a | 9ec1fb9bf47f1b8402994fff35ecc57ade2ac02fe2f4af74111d5693cececca9 | 265 | true | required | false | 92e1bed03d85ae9d668fdeb5cd2f770de5b7339bb606c354fc57843718d17fc5 |

### All exact provider-visible prompts

### Local audit heading: plain_llm

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: irrelevant_context

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: brain_identity_only

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: brain_definition

*The heading is not provider-visible; the exact frozen request body follows.*

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
Definition: A checkable chain of stated steps attached to a claim and available for review.
```

### Local audit heading: brain_definition_plus_relations

*The heading is not provider-visible; the exact frozen request body follows.*

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
Definition: A checkable chain of stated steps attached to a claim and available for review.
Relation: proof supports a claim
Relation: proof can be retraced step by step
```

## 5. bridge-ambiguity

**Exact source text:** The bridge is not ready; both readings still fit the note.

**Research rationale:** Two legitimate personal concepts share the handle bridge and must remain ambiguous.

**Expected binding(s):**
- required: `synthetic://personal/bridge-dialogue@1@1`; accepted forms: bridge, the bridge; ambiguity set: synthetic://personal/bridge-dialogue@1@1, synthetic://personal/bridge-transition@1@1

**Expected ambiguity:** Preserve the two-candidate ambiguity.

**Expected speech act:** assertion

**Expected quantifier / relation behavior:** no special quantifier; no required relation.

**Licensed commitments:** BRIDGE_REMAINS_AMBIGUOUS

**Forbidden commitments:** BRIDGE_RESOLVED_TO_SINGLE_CONCEPT

### Treatment sufficiency and condition-diff audit

Within this fixture, source/common task/response schema are mechanically identical; only semantic-reference payload is permitted to differ.

| Local condition | Source SHA | Context SHA | Chars | Target semantics present | Grounding expectation | Ambiguity retained | Final request SHA |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| plain_llm | 6af3a16fefee9d0b07be4659baf49375fa4943571ac3b35b1f3dec5f1bfd2b96 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | 0 | false | preserve_ambiguity | true | 65b7660f607d8f5b8be21e499686ef14e3c907056e75d21dad97c9da14235eb6 |
| irrelevant_context | 6af3a16fefee9d0b07be4659baf49375fa4943571ac3b35b1f3dec5f1bfd2b96 | a5fdc16d009a68fbf2260654c4ac11579adaae4a141ffa83b085cf39a9f11bac | 237 | false | preserve_ambiguity | true | a3ca716b3954b7a3cbd2606e4aa2a93e0207e9b4ce488ddab0d57a73bd160d52 |
| brain_identity_only | 6af3a16fefee9d0b07be4659baf49375fa4943571ac3b35b1f3dec5f1bfd2b96 | c49c555de55c0e081cbaf01f6530cdccd547877ef05b0efd7e15186ebd5d85f3 | 218 | true | preserve_ambiguity | true | da17863b13568d31e4047fb9cba9313524bf1c4e66fa02828ba1c6a53b68cc7b |
| brain_definition | 6af3a16fefee9d0b07be4659baf49375fa4943571ac3b35b1f3dec5f1bfd2b96 | d1545b68da9d81205ae0d5860445be2132cb1d22f588c4450d4fd5c7f4bd420b | 376 | true | preserve_ambiguity | true | 0fd4fa4d4539f6e69bee0e03cbaf88ae9936b174366c51a1605a58d6fa2ee489 |
| brain_definition_plus_relations | 6af3a16fefee9d0b07be4659baf49375fa4943571ac3b35b1f3dec5f1bfd2b96 | d44f51ed120cd79d0bdcb8db398ff93282a94d010f67a5bcb2785a5fba274e96 | 476 | true | preserve_ambiguity | true | aa67b4047f872243bab5650b0b47defc9ed7226aafab7b09baec7b79e70ec939 |

### All exact provider-visible prompts

### Local audit heading: plain_llm

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: irrelevant_context

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: brain_identity_only

*The heading is not provider-visible; the exact frozen request body follows.*

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
Concept ID: synthetic://personal/bridge-dialogue@1@1
Aliases: bridge, the bridge
Category: personal_concept

Concept ID: synthetic://personal/bridge-transition@1@1
Aliases: bridge, the bridge
Category: personal_concept
```

### Local audit heading: brain_definition

*The heading is not provider-visible; the exact frozen request body follows.*

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
Concept ID: synthetic://personal/bridge-dialogue@1@1
Aliases: bridge, the bridge
Category: personal_concept
Definition: A note that translates between two collaborators' vocabularies.

Concept ID: synthetic://personal/bridge-transition@1@1
Aliases: bridge, the bridge
Category: personal_concept
Definition: A provisional step linking an earlier definition to its revised form.
```

### Local audit heading: brain_definition_plus_relations

*The heading is not provider-visible; the exact frozen request body follows.*

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
Concept ID: synthetic://personal/bridge-dialogue@1@1
Aliases: bridge, the bridge
Category: personal_concept
Definition: A note that translates between two collaborators' vocabularies.
Relation: bridge-dialogue connects two vocabularies

Concept ID: synthetic://personal/bridge-transition@1@1
Aliases: bridge, the bridge
Category: personal_concept
Definition: A provisional step linking an earlier definition to its revised form.
Relation: bridge-transition links two revisions
```

## 6. normal-operator-missing-assumption

**Exact source text:** Every normal operator has an eigenbasis.

**Research rationale:** The source omits a necessary scope qualification; semantic context should not license invention.

**Expected binding(s):**
- optional: `synthetic://personal/normal-operator@1@1`; accepted forms: normal operator, normal operators

**Expected ambiguity:** No ambiguity preservation requirement.

**Expected speech act:** theorem_claim

**Expected quantifier / relation behavior:** universal; no required relation.

**Licensed commitments:** EIGENBASIS_CLAIM_STATED, FINITE_DIMENSIONALITY_MAY_BE_MISSING

**Forbidden commitments:** EIGENBASIS_CLAIM_UNCONDITIONALLY_ESTABLISHED

### Treatment sufficiency and condition-diff audit

Within this fixture, source/common task/response schema are mechanically identical; only semantic-reference payload is permitted to differ.

| Local condition | Source SHA | Context SHA | Chars | Target semantics present | Grounding expectation | Ambiguity retained | Final request SHA |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| plain_llm | 892524e9c5e0beb5597ae38dd70c4aec3ad6c6ece02958d84da1db0178e655db | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | 0 | false | optional | false | 108caa1ab152292340b1f2f175beb24c3c506d9f2b665d05c055f283799418d3 |
| irrelevant_context | 892524e9c5e0beb5597ae38dd70c4aec3ad6c6ece02958d84da1db0178e655db | a5fdc16d009a68fbf2260654c4ac11579adaae4a141ffa83b085cf39a9f11bac | 237 | false | optional | false | e1be11d22c59d1eb9a54489c5b31e3617320d394c20899cd84e28f93d4ad3cc3 |
| brain_identity_only | 892524e9c5e0beb5597ae38dd70c4aec3ad6c6ece02958d84da1db0178e655db | 73c1672457b10f6fc000ac15626b83d06ee17d0b2d42bf8851951b65d2b48637 | 123 | true | optional | false | 48c245ecab4f58cfd89c9d1e2c974be34d670fb8c7d1d9d9cf87e67e27fefe46 |
| brain_definition | 892524e9c5e0beb5597ae38dd70c4aec3ad6c6ece02958d84da1db0178e655db | df1acc0e36769c69630622c17bde266a2cfe73faa40a31aeae4458605cc6b8a8 | 210 | true | optional | false | e83abfb0e97ebb34e9bc3d9effa7c37fb633db4cf65db1f184190126f0262b08 |
| brain_definition_plus_relations | 892524e9c5e0beb5597ae38dd70c4aec3ad6c6ece02958d84da1db0178e655db | f0feb45c522d8798db663b90b742ba565640722901088c0c2f0c4ee9ae17784a | 310 | true | optional | false | e7951453c3b8c525626edfeb62b15832c6cbd7a09e18f794f0702699b64461f9 |

### All exact provider-visible prompts

### Local audit heading: plain_llm

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: irrelevant_context

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: brain_identity_only

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: brain_definition

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: brain_definition_plus_relations

*The heading is not provider-visible; the exact frozen request body follows.*

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
Relation: normal operator may require a finite-dimensionality qualification for an eigenbasis claim
```

## 7. modus-ponens-precision

**Exact source text:** If P implies Q, and P holds, then Q holds.

**Research rationale:** A precise logical statement should offer little semantic-context advantage.

**Expected binding(s):**
- None preregistered.

**Expected ambiguity:** No ambiguity preservation requirement.

**Expected speech act:** theorem_claim

**Expected quantifier / relation behavior:** conditional; implication.

**Licensed commitments:** MODUS_PONENS

**Forbidden commitments:** IMPLICATION_IS_EQUIVALENCE

### Treatment sufficiency and condition-diff audit

Within this fixture, source/common task/response schema are mechanically identical; only semantic-reference payload is permitted to differ.

| Local condition | Source SHA | Context SHA | Chars | Target semantics present | Grounding expectation | Ambiguity retained | Final request SHA |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| plain_llm | 4594afb0b26aa80558f8eca49223db68f59e455fc8ac918032b03db4dc02dd58 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | 0 | false | none | false | 0feaafc4fdf8884d2339c36c272edc08a46a635600353c8805cadc7420fb49b7 |
| irrelevant_context | 4594afb0b26aa80558f8eca49223db68f59e455fc8ac918032b03db4dc02dd58 | a5fdc16d009a68fbf2260654c4ac11579adaae4a141ffa83b085cf39a9f11bac | 237 | false | none | false | b26def7448282763aab605b101c535f174d630dfe5ffea81aa2c311041ad9e26 |
| brain_identity_only | 4594afb0b26aa80558f8eca49223db68f59e455fc8ac918032b03db4dc02dd58 | b22a6d081368ae97ddece20d3ae12f21dc13756019d5c374431905aecbe7ccf9 | 102 | false | none | false | ad9c4d80d189d522e027a0a9740dfe9ca39f5c9ed985343eae30ef4e1dd8c7e5 |
| brain_definition | 4594afb0b26aa80558f8eca49223db68f59e455fc8ac918032b03db4dc02dd58 | c4a08b6afa5b63203d054ee551877b2d378af7707e703d795c1022327ffe8c36 | 205 | false | none | false | 8ee9295ab84a708e987beeec562e9b26ce309420f1d2da888d364a5877ee87c7 |
| brain_definition_plus_relations | 4594afb0b26aa80558f8eca49223db68f59e455fc8ac918032b03db4dc02dd58 | 5972b3f6c7e497846f6ddcde8eb48637ae42e2858adbac5539df6e9cb88cd0a4 | 261 | false | none | false | 21812cd0d072b902e97fa3b6c69a321f9ccc0cd1f4c59e5168c79957cac81df6 |

### All exact provider-visible prompts

### Local audit heading: plain_llm

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: irrelevant_context

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: brain_identity_only

*The heading is not provider-visible; the exact frozen request body follows.*

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
Aliases: P implies Q, P, Q
Category: logical_pattern
```

### Local audit heading: brain_definition

*The heading is not provider-visible; the exact frozen request body follows.*

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
Aliases: P implies Q, P, Q
Category: logical_pattern
Definition: A local inference pattern whose conclusion follows from an implication and its antecedent.
```

### Local audit heading: brain_definition_plus_relations

*The heading is not provider-visible; the exact frozen request body follows.*

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
Aliases: P implies Q, P, Q
Category: logical_pattern
Definition: A local inference pattern whose conclusion follows from an implication and its antecedent.
Relation: modus ponens derives Q from P and P implies Q
```

## 8. delta-control

**Exact source text:** Mark the delta before comparing the two versions.

**Research rationale:** Delta has a personal revision meaning while irrelevant material should not reproduce relevant-context grounding.

**Expected binding(s):**
- required: `synthetic://personal/delta@1@1`; accepted forms: delta, the delta

**Expected ambiguity:** No ambiguity preservation requirement.

**Expected speech act:** instruction

**Expected quantifier / relation behavior:** no special quantifier; precedes.

**Licensed commitments:** DELTA_PRECEDES_VERSION_COMPARISON, DELTA_IS_SEMANTIC_DIFFERENCE_RECORD

**Forbidden commitments:** DELTA_IS_NUMERICAL_SUBTRACTION

### Treatment sufficiency and condition-diff audit

Within this fixture, source/common task/response schema are mechanically identical; only semantic-reference payload is permitted to differ.

| Local condition | Source SHA | Context SHA | Chars | Target semantics present | Grounding expectation | Ambiguity retained | Final request SHA |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| plain_llm | 3d1f9e5afdbbdaccc7386f998e6fe6e0583afe7d48f64b6cda05e2f3403ff1ea | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | 0 | false | required | false | 5b1ea4063e090ead5bc1cdd06f59cb4c360819958a3a7ce8915c92096999c5e5 |
| irrelevant_context | 3d1f9e5afdbbdaccc7386f998e6fe6e0583afe7d48f64b6cda05e2f3403ff1ea | a5fdc16d009a68fbf2260654c4ac11579adaae4a141ffa83b085cf39a9f11bac | 237 | false | required | false | 1827835c3cd2cac548e2fde522d20bf9ad3cb090496f605a9e6e37179a559933 |
| brain_identity_only | 3d1f9e5afdbbdaccc7386f998e6fe6e0583afe7d48f64b6cda05e2f3403ff1ea | 553ce3fd49f2bb398d08a756ded15f9f0b6499d62b82f165ca7f5e6a50e9b519 | 95 | true | required | false | 0bfd319d905d6f7a9dec0e7dc8a4bd274c9598b1fb24c50da3e72f01d5d177bb |
| brain_definition | 3d1f9e5afdbbdaccc7386f998e6fe6e0583afe7d48f64b6cda05e2f3403ff1ea | 5835cfefe566e5ed0b8373a30b68ff690ce971aa90e128acbf3806fd59750be8 | 189 | true | required | false | 5c33293b7e2d702dd8e125dfc1682699c57cf29d2d1e4495f8bc99d1a71c2bfd |
| brain_definition_plus_relations | 3d1f9e5afdbbdaccc7386f998e6fe6e0583afe7d48f64b6cda05e2f3403ff1ea | 4d4cb3f0527016724105a526f94688594dfb3bb4447f40eb49c66fc607066b4c | 236 | true | required | false | a05923f24c8f0270835bd5fc2bb44728b0567818e3e298984b81fb43a04b46ce |

### All exact provider-visible prompts

### Local audit heading: plain_llm

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: irrelevant_context

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: brain_identity_only

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: brain_definition

*The heading is not provider-visible; the exact frozen request body follows.*

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
Definition: A reviewed record of the semantic difference between two versions of one concept.
```

### Local audit heading: brain_definition_plus_relations

*The heading is not provider-visible; the exact frozen request body follows.*

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
Definition: A reviewed record of the semantic difference between two versions of one concept.
Relation: delta compares two concept revisions
```

## 9. boundary-definition

**Exact source text:** By boundary I mean the last distinction that must remain explicit before we combine two ideas.

**Research rationale:** A definitional speech act must not be promoted into a theorem.

**Expected binding(s):**
- required: `synthetic://personal/boundary@1@1`; accepted forms: boundary, the boundary

**Expected ambiguity:** No ambiguity preservation requirement.

**Expected speech act:** definition

**Expected quantifier / relation behavior:** no special quantifier; constrains.

**Licensed commitments:** BOUNDARY_DEFINED_AS_LAST_EXPLICIT_DISTINCTION, BOUNDARY_CONSTRAINS_COMBINATION

**Forbidden commitments:** BOUNDARY_THEOREM_ESTABLISHED

### Treatment sufficiency and condition-diff audit

Within this fixture, source/common task/response schema are mechanically identical; only semantic-reference payload is permitted to differ.

| Local condition | Source SHA | Context SHA | Chars | Target semantics present | Grounding expectation | Ambiguity retained | Final request SHA |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| plain_llm | 62fa0048a99f8c17309e5c915624109fdb05a0feaf34a64be464c66b43fb50f1 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | 0 | false | required | false | 0cc4981a315944d0e34ef23db0bd82e757c36f1ba7c6e39b3a6aaa867b1268e8 |
| irrelevant_context | 62fa0048a99f8c17309e5c915624109fdb05a0feaf34a64be464c66b43fb50f1 | a5fdc16d009a68fbf2260654c4ac11579adaae4a141ffa83b085cf39a9f11bac | 237 | false | required | false | 2dbaba26182bd3632ad28443d70100a6686d6e555100b32148f02e93a6a56e1b |
| brain_identity_only | 62fa0048a99f8c17309e5c915624109fdb05a0feaf34a64be464c66b43fb50f1 | 42762991d3723f9d18f1f075c94cbace725d9ebbd54be5b678b40c0833bf39b4 | 104 | true | required | false | 417ff946d03383e0a51b651c5f21bd15f3f453025cf0ab5d617dc30611692e0e |
| brain_definition | 62fa0048a99f8c17309e5c915624109fdb05a0feaf34a64be464c66b43fb50f1 | 5637ed32590247e4cc987e8bd4f981ace96c9d54a8374db2c7a32a6d7f5d70c0 | 188 | true | required | false | 51becb436e9a253316be4ee40ef17cdaf10bdfad5403e66c0bf6b968eb0fe483 |
| brain_definition_plus_relations | 62fa0048a99f8c17309e5c915624109fdb05a0feaf34a64be464c66b43fb50f1 | aceb19943b90ee2bf5c81e3f090ff8aa15a8a751569bb866083f4a7f137c31b0 | 238 | true | required | false | 13b758cad8c7db5da64130228868e4e222a1939e28c371a9feed0e7485959310 |

### All exact provider-visible prompts

### Local audit heading: plain_llm

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: irrelevant_context

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: brain_identity_only

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: brain_definition

*The heading is not provider-visible; the exact frozen request body follows.*

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
Definition: The final explicit distinction preserved before combining two concepts.
```

### Local audit heading: brain_definition_plus_relations

*The heading is not provider-visible; the exact frozen request body follows.*

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
Definition: The final explicit distinction preserved before combining two concepts.
Relation: boundary constrains concept combination
```

## 10. spectral-proof-sketch

**Exact source text:** Since the spectral theorem applies here, the next step is to diagonalize T.

**Research rationale:** A reasoning sketch should retain its provisional speech act.

**Expected binding(s):**
- optional: `synthetic://personal/spectral-step@1@1`; accepted forms: spectral theorem, diagonalize T

**Expected ambiguity:** No ambiguity preservation requirement.

**Expected speech act:** proof_sketch

**Expected quantifier / relation behavior:** no special quantifier; proposes.

**Licensed commitments:** SPECTRAL_STEP_PROPOSED, HYPOTHESES_NOT_YET_CHECKED

**Forbidden commitments:** T_ALREADY_DIAGONALIZED

### Treatment sufficiency and condition-diff audit

Within this fixture, source/common task/response schema are mechanically identical; only semantic-reference payload is permitted to differ.

| Local condition | Source SHA | Context SHA | Chars | Target semantics present | Grounding expectation | Ambiguity retained | Final request SHA |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| plain_llm | 04df3114a91d2bd8ddc5fde33a054b33417cc1261e88bc69854335adefa60032 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | 0 | false | optional | false | 283862cf51104d8d95e32a7d5cbb22530c0ab3edbee7a0ead5b03ac63ceb08f3 |
| irrelevant_context | 04df3114a91d2bd8ddc5fde33a054b33417cc1261e88bc69854335adefa60032 | a5fdc16d009a68fbf2260654c4ac11579adaae4a141ffa83b085cf39a9f11bac | 237 | false | optional | false | ce5d01ce4dbbad804cbc67341ba7fcf513939164364bcccc21321e872d5fffdc |
| brain_identity_only | 04df3114a91d2bd8ddc5fde33a054b33417cc1261e88bc69854335adefa60032 | 77dd10739c546c8b86e0364714829f1b7dae7035924e50b3ade45282efd01e3d | 112 | true | optional | false | af4fa125ecaf056e63ff118cb9b5e0be39687693ecdc284decb813abfce5de72 |
| brain_definition | 04df3114a91d2bd8ddc5fde33a054b33417cc1261e88bc69854335adefa60032 | e51827e52b919642e5a9e3ef5d11e75db6ed19cc66926577ba6d97e92ccb50ff | 219 | true | optional | false | 13a9c849b1187389dfe8a6dac7ce76d86c4a99e114056b55b08bf5464ccd8a01 |
| brain_definition_plus_relations | 04df3114a91d2bd8ddc5fde33a054b33417cc1261e88bc69854335adefa60032 | 93e5b3b303f6d85b702d44dc56337b11b1af86e98c212db635952209e2437d5d | 318 | true | optional | false | 5657796e10f710f14096acc5d2cbea2d50082b0cc5382bc9de227e60600b2313 |

### All exact provider-visible prompts

### Local audit heading: plain_llm

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: irrelevant_context

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: brain_identity_only

*The heading is not provider-visible; the exact frozen request body follows.*

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
Aliases: spectral theorem, diagonalize T
Category: proof_step
```

### Local audit heading: brain_definition

*The heading is not provider-visible; the exact frozen request body follows.*

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
Aliases: spectral theorem, diagonalize T
Category: proof_step
Definition: A named theorem invocation recorded as a proposed proof step until its hypotheses are checked.
```

### Local audit heading: brain_definition_plus_relations

*The heading is not provider-visible; the exact frozen request body follows.*

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
Aliases: spectral theorem, diagonalize T
Category: proof_step
Definition: A named theorem invocation recorded as a proposed proof step until its hypotheses are checked.
Relation: spectral-step proposes diagonalization
Relation: spectral-step requires hypothesis check
```

## 11. compass-revision

**Exact source text:** The compass now asks for the next reversible step, not the most elegant destination.

**Research rationale:** Current revision must be used rather than an obsolete aspirational meaning.

**Expected binding(s):**
- required: `synthetic://personal/compass-current@2@1`; accepted forms: compass, the compass

**Expected ambiguity:** No ambiguity preservation requirement.

**Expected speech act:** definition

**Expected quantifier / relation behavior:** no special quantifier; supersedes.

**Licensed commitments:** COMPASS_SELECTS_REVERSIBLE_STEP, COMPASS_CURRENT_REVISION

**Forbidden commitments:** COMPASS_IS_ELEGANT_DESTINATION_CRITERION, COMPASS_PRIOR_REVISION_CURRENT

### Treatment sufficiency and condition-diff audit

Within this fixture, source/common task/response schema are mechanically identical; only semantic-reference payload is permitted to differ.

| Local condition | Source SHA | Context SHA | Chars | Target semantics present | Grounding expectation | Ambiguity retained | Final request SHA |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| plain_llm | 5111f34bf53c7033ff4b22708a5c6101cc92268db3e5245b67c8645a53d4e4fc | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | 0 | false | required | false | a05d9fb8297d85d0c475b1d8130563713b0cb6363df57fb5053d543613e1e19d |
| irrelevant_context | 5111f34bf53c7033ff4b22708a5c6101cc92268db3e5245b67c8645a53d4e4fc | a5fdc16d009a68fbf2260654c4ac11579adaae4a141ffa83b085cf39a9f11bac | 237 | false | required | false | daa5229ed6c07f0102e0b8930c88af57071d0927e5b8a3cf5d296a1f20ad6753 |
| brain_identity_only | 5111f34bf53c7033ff4b22708a5c6101cc92268db3e5245b67c8645a53d4e4fc | 1832dbf91677e6268034dad24cf965d8f94f038bd5fae034115931346e9f7d09 | 109 | true | required | false | 1362b749bd918fb2a0964a8b926d4fd143662bd10d4a5d7acf44c3d77f105014 |
| brain_definition | 5111f34bf53c7033ff4b22708a5c6101cc92268db3e5245b67c8645a53d4e4fc | d80beb868d206aa97b1e4fb74de85afad5a5dbc408d2fb8a168e78b6034d1773 | 203 | true | required | false | d349381f6854e6975bd726a4974f303c2da0c50271b791309259a79a70186f24 |
| brain_definition_plus_relations | 5111f34bf53c7033ff4b22708a5c6101cc92268db3e5245b67c8645a53d4e4fc | 51406bc00692b3fc1b74a269cbb6b061d19735f8b8e44d5475f57f20b9b0d048 | 305 | true | required | false | 5ca475e471c84be2bb8ba0bd8df973b328ffcc48b1a35b4a3343648e07721a14 |

### All exact provider-visible prompts

### Local audit heading: plain_llm

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: irrelevant_context

*The heading is not provider-visible; the exact frozen request body follows.*

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

### Local audit heading: brain_identity_only

*The heading is not provider-visible; the exact frozen request body follows.*

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
Concept ID: synthetic://personal/compass-current@2@1
Aliases: compass, the compass
Category: personal_concept
```

### Local audit heading: brain_definition

*The heading is not provider-visible; the exact frozen request body follows.*

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
Concept ID: synthetic://personal/compass-current@2@1
Aliases: compass, the compass
Category: personal_concept
Definition: Revision 2: a short criterion selecting the next reversible step in a discussion.
```

### Local audit heading: brain_definition_plus_relations

*The heading is not provider-visible; the exact frozen request body follows.*

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
Concept ID: synthetic://personal/compass-current@2@1
Aliases: compass, the compass
Category: personal_concept
Definition: Revision 2: a short criterion selecting the next reversible step in a discussion.
Relation: compass-current supersedes compass-prior
Relation: compass-current selects reversible steps
```

## 4. Prompt difference summary

The per-fixture tables record source hash, common prompt hash `979ed816c0c7b5c771b7f5545b091a33aa9b634dfca7d1b9379bee3969484ea4`, response schema hash `7f31d0cd9f8f50f4e0918db5ab737725fa1933d9e6fd17120815622ef3c2f29e`, context hash/count, and final request hash. Source, task prompt, and schema remain identical across the five requests for a fixture. Only semantic-reference payload may differ.

## 5. Possible answer leakage

Conservative static/manual flags; they do not authorize or invalidate the frozen design automatically.

| Fixture | Risk | Rationale |
| --- | --- | --- |
| harbor-private-meaning | MODERATE | Definition closely matches the keep-or-remove review in the source. |
| lantern-private-meaning | HIGH | Relation directly says the lantern keeps its project open. |
| compass-private-meaning | MODERATE | Definition supplies the reversible-step interpretation central to the source. |
| field-overload | HIGH | Relation closely restates splitting after divergent examples. |
| proof-overload | MODERATE | Definition closely frames retraceable proof behavior. |
| bridge-ambiguity | LOW | Candidates are symmetric, but their descriptive IDs may cue reading types. |
| normal-operator-missing-assumption | HIGH | Relation names the finite-dimensionality qualification expected to be missing. |
| modus-ponens-precision | HIGH | Logical-pattern definition explicitly restates the source inference. |
| delta-control | HIGH | Definition and relation nearly restate comparing revisions. |
| boundary-definition | MODERATE | Definition repeats the source meaning, though the source is itself definitional. |
| spectral-proof-sketch | HIGH | Semantic object calls the theorem invocation a proposed proof step and names diagonalization. |
| compass-revision | HIGH | Current/supersedes wording cues which revision should govern. |

## 6. Irrelevant-context audit

### harbor-private-meaning

- Payload ID: `synthetic://background/evening-ledger@1`; aliases: lattice, evening ledger
- Target IDs: `synthetic://personal/harbor@1@1`
- Character count: 237
- Deterministic target overlap: none
- Manual assessment: NONE: no target ID, alias, definition, relation, or material conceptual overlap found.

```text
Concept ID: synthetic://background/evening-ledger@1
Aliases: lattice, evening ledger
Category: personal_note
Definition: A private weekly record of small practical observations.
Relation: evening ledger is maintained alongside a calendar
```

### lantern-private-meaning

- Payload ID: `synthetic://background/evening-ledger@1`; aliases: lattice, evening ledger
- Target IDs: `synthetic://personal/lantern@2@1`
- Character count: 237
- Deterministic target overlap: none
- Manual assessment: NONE: no target ID, alias, definition, relation, or material conceptual overlap found.

```text
Concept ID: synthetic://background/evening-ledger@1
Aliases: lattice, evening ledger
Category: personal_note
Definition: A private weekly record of small practical observations.
Relation: evening ledger is maintained alongside a calendar
```

### compass-private-meaning

- Payload ID: `synthetic://background/evening-ledger@1`; aliases: lattice, evening ledger
- Target IDs: `synthetic://personal/compass@2@1`
- Character count: 237
- Deterministic target overlap: none
- Manual assessment: NONE: no target ID, alias, definition, relation, or material conceptual overlap found.

```text
Concept ID: synthetic://background/evening-ledger@1
Aliases: lattice, evening ledger
Category: personal_note
Definition: A private weekly record of small practical observations.
Relation: evening ledger is maintained alongside a calendar
```

### field-overload

- Payload ID: `synthetic://background/evening-ledger@1`; aliases: lattice, evening ledger
- Target IDs: `synthetic://personal/field@1@1`
- Character count: 237
- Deterministic target overlap: none
- Manual assessment: NONE: no target ID, alias, definition, relation, or material conceptual overlap found.

```text
Concept ID: synthetic://background/evening-ledger@1
Aliases: lattice, evening ledger
Category: personal_note
Definition: A private weekly record of small practical observations.
Relation: evening ledger is maintained alongside a calendar
```

### proof-overload

- Payload ID: `synthetic://background/evening-ledger@1`; aliases: lattice, evening ledger
- Target IDs: `synthetic://personal/proof@1@1`
- Character count: 237
- Deterministic target overlap: none
- Manual assessment: NONE: no target ID, alias, definition, relation, or material conceptual overlap found.

```text
Concept ID: synthetic://background/evening-ledger@1
Aliases: lattice, evening ledger
Category: personal_note
Definition: A private weekly record of small practical observations.
Relation: evening ledger is maintained alongside a calendar
```

### bridge-ambiguity

- Payload ID: `synthetic://background/evening-ledger@1`; aliases: lattice, evening ledger
- Target IDs: `synthetic://personal/bridge-dialogue@1@1`, `synthetic://personal/bridge-transition@1@1`
- Character count: 237
- Deterministic target overlap: none
- Manual assessment: LOW lexical overlap: `personal_note` contains the ordinary word note, also present in the source; no target ID, alias, definition, or relation overlaps.

```text
Concept ID: synthetic://background/evening-ledger@1
Aliases: lattice, evening ledger
Category: personal_note
Definition: A private weekly record of small practical observations.
Relation: evening ledger is maintained alongside a calendar
```

### normal-operator-missing-assumption

- Payload ID: `synthetic://background/evening-ledger@1`; aliases: lattice, evening ledger
- Target IDs: `synthetic://personal/normal-operator@1@1`
- Character count: 237
- Deterministic target overlap: none
- Manual assessment: NONE: no target ID, alias, definition, relation, or material conceptual overlap found.

```text
Concept ID: synthetic://background/evening-ledger@1
Aliases: lattice, evening ledger
Category: personal_note
Definition: A private weekly record of small practical observations.
Relation: evening ledger is maintained alongside a calendar
```

### modus-ponens-precision

- Payload ID: `synthetic://background/evening-ledger@1`; aliases: lattice, evening ledger
- Target IDs: `synthetic://personal/modus-ponens@1@1`
- Character count: 237
- Deterministic target overlap: none
- Manual assessment: NONE: no target ID, alias, definition, relation, or material conceptual overlap found.

```text
Concept ID: synthetic://background/evening-ledger@1
Aliases: lattice, evening ledger
Category: personal_note
Definition: A private weekly record of small practical observations.
Relation: evening ledger is maintained alongside a calendar
```

### delta-control

- Payload ID: `synthetic://background/evening-ledger@1`; aliases: lattice, evening ledger
- Target IDs: `synthetic://personal/delta@1@1`
- Character count: 237
- Deterministic target overlap: none
- Manual assessment: NONE: no target ID, alias, definition, relation, or material conceptual overlap found.

```text
Concept ID: synthetic://background/evening-ledger@1
Aliases: lattice, evening ledger
Category: personal_note
Definition: A private weekly record of small practical observations.
Relation: evening ledger is maintained alongside a calendar
```

### boundary-definition

- Payload ID: `synthetic://background/evening-ledger@1`; aliases: lattice, evening ledger
- Target IDs: `synthetic://personal/boundary@1@1`
- Character count: 237
- Deterministic target overlap: none
- Manual assessment: NONE: no target ID, alias, definition, relation, or material conceptual overlap found.

```text
Concept ID: synthetic://background/evening-ledger@1
Aliases: lattice, evening ledger
Category: personal_note
Definition: A private weekly record of small practical observations.
Relation: evening ledger is maintained alongside a calendar
```

### spectral-proof-sketch

- Payload ID: `synthetic://background/evening-ledger@1`; aliases: lattice, evening ledger
- Target IDs: `synthetic://personal/spectral-step@1@1`
- Character count: 237
- Deterministic target overlap: none
- Manual assessment: NONE: no target ID, alias, definition, relation, or material conceptual overlap found.

```text
Concept ID: synthetic://background/evening-ledger@1
Aliases: lattice, evening ledger
Category: personal_note
Definition: A private weekly record of small practical observations.
Relation: evening ledger is maintained alongside a calendar
```

### compass-revision

- Payload ID: `synthetic://background/evening-ledger@1`; aliases: lattice, evening ledger
- Target IDs: `synthetic://personal/compass-current@2@1`
- Character count: 237
- Deterministic target overlap: none
- Manual assessment: NONE: no target ID, alias, definition, relation, or material conceptual overlap found.

```text
Concept ID: synthetic://background/evening-ledger@1
Aliases: lattice, evening ledger
Category: personal_note
Definition: A private weekly record of small practical observations.
Relation: evening ledger is maintained alongside a calendar
```

## 7. Context-length audit

Descriptive only; no post-freeze normalization was performed.

| Local condition | Min | Max | Mean | Median |
| --- | ---: | ---: | ---: | ---: |
| plain_llm | 0 | 0 | 0.0 | 0 |
| irrelevant_context | 237 | 237 | 237.0 | 237 |
| brain_identity_only | 95 | 218 | 112.8 | 101.5 |
| brain_definition | 187 | 376 | 212.3 | 195 |
| brain_definition_plus_relations | 236 | 476 | 283.0 | 257.5 |

## 8. Ambiguity audit

`bridge-ambiguity` has two legitimate frozen candidates, both rendered symmetrically in rich context. The source says both readings fit; correct behavior is preserving ambiguity, not selecting one.

## 9. Stale-revision audit

`compass-revision` has a frozen current target and explicit auditable binding rule. Its rich context contains no imperative such as “correct”, “wrong”, or “choose this”, but its current/supersedes wording is conservatively flagged HIGH above.

## 10. Control audits

`modus-ponens-precision` is the no-advantage logical control; `delta-control` tests relevant versus generic extra-context effects. Both require close human scrutiny because their relevant content can cue the source interpretation.

## 11. Proof and speech-act audits

`boundary-definition`, `spectral-proof-sketch`, and `proof-overload` are frozen with source-based speech-act expectations. No common prompt gives a speech-act label, but semantic-object prose may cue it; Section 5 flags those risks.

## 12. Machine preflight reproduction

Offline checks completed successfully: `npm test`; `npx tsc --noEmit --skipLibCheck`; `npm run build`; `git diff --check`; `npm run eval:experiment04:dry-run`. The dry run reported 12 fixtures, 5 conditions, 3 repetitions, 180 planned trials, preflight PASS, prompt-leak audit PASS, and zero provider/network requests.

## 13. Human sign-off table

Automated checks do not grant authorization. Every status is deliberately pending.

| Fixture | source_valid | plain_fair | irrelevant_valid | identity_pure | definition_pure | relations_pure | no_label_leakage | grounding_ground_truth_valid | overreach_ground_truth_valid | answer_leakage_risk | reviewer_notes | signoff_status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| harbor-private-meaning | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | MODERATE |  | PENDING HUMAN REVIEW |
| lantern-private-meaning | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | HIGH |  | PENDING HUMAN REVIEW |
| compass-private-meaning | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | MODERATE |  | PENDING HUMAN REVIEW |
| field-overload | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | HIGH |  | PENDING HUMAN REVIEW |
| proof-overload | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | MODERATE |  | PENDING HUMAN REVIEW |
| bridge-ambiguity | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | LOW |  | PENDING HUMAN REVIEW |
| normal-operator-missing-assumption | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | HIGH |  | PENDING HUMAN REVIEW |
| modus-ponens-precision | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | HIGH |  | PENDING HUMAN REVIEW |
| delta-control | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | HIGH |  | PENDING HUMAN REVIEW |
| boundary-definition | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | MODERATE |  | PENDING HUMAN REVIEW |
| spectral-proof-sketch | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | HIGH |  | PENDING HUMAN REVIEW |
| compass-revision | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | HIGH |  | PENDING HUMAN REVIEW |

## 14. Global sign-off

> EXPERIMENT 04 LIVE AUTHORIZATION: **PENDING HUMAN REVIEW**

No live experiment is authorized by this packet.
