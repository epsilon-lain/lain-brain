# M2B.6a — Contextual Sense Layer — Design Document

Status: **DESIGN ONLY**. No source changes, no implementation, no commits, no provider calls.
Revision 2 — incorporates the Mirai design review (authority/relevance separation,
stable sense identity, runtime-first v0).

A concept (ConceptNode / note) must no longer be treated as having one globally
fixed meaning. The same surface may legitimately carry multiple semantic
senses, and the sense that applies at any moment is a **contextual, temporary
activation** — never a permanent percentage stored next to the meaning.

Core principles:

> Concept identity is stable.
> Sense membership is persistent and authority-aware.
> Sense activation is contextual and temporary.
>
> Authority ≠ contextual relevance.
> Semantic relevance ≠ referential identity.

And the standing lain-brain authority rule, unchanged:

> AI interpretation must NEVER silently become lain's personal meaning.

---

## 1. Current architecture audit

All findings are from reading the actual current source (`src/*.ts`).

### 1.1 Where the current architecture already supports multiple meanings

The claim "one concept ≈ one meaning" is only partially true today. The
ConceptNode aggregate (`src/BrainGrowth.ts`) already keeps **four authority
buckets of meaning** for one concept:

| Field | Shape | Authority today |
|---|---|---|
| `userDefinition` | `ConceptUserDefinition {id, text, sourceRefs}` | The one authoritative user meaning. `sourceRefs` are `UserTextProvenance` with `actor: "user"` and the text must exactly match its provenance (`KnowledgeProtocol.validateUserConclusion`). |
| `alternativeUserDefinitions` | `ConceptUserDefinition[]` | Preserved **user-authored** definitions that differ from the current one; quarantined as unresolved alternatives (see `updateConceptNode` `userDefinitionMode: "preserve_user_meaning"`, `BrainGrowth.ts:660-683`). |
| `standardDefinitions` | `ConceptContentEntry[]` | External/dictionary meanings, non-authoritative. Entries carry `sourceReferences: string[]` — their own provenance shape. |
| `generatedInterpretations` | `ConceptContentEntry[]` | AI-derived interpretations with `derivedStatus: "current"|"stale"`, `dependencies` (conceptId+revision), `staleBecauseDeltaId`. Non-authoritative by construction. |

Additional multi-meaning machinery that already exists and should be reused:

- **Ambiguity + resolution ceremony** — `SemanticSpec` (`src/SemanticSpec.ts`)
  has `ambiguities` (with `blocking` flag and pre-defined `choices`), user
  `resolutions` (actor `"user"`), and auditable `patches`. The chat analyzer's
  blocking rule is already the right one
  (`src/ChatSemanticAnalyzer.ts:300-302`):
  > "A blocking ambiguity is rare. Use blocking=true only when at least two
  > plausible interpretations remain after using conversation context and
  > their difference would materially change the next reasoning or action.
  > A merely new, informal, metaphorical, or undefined user term is not blocking."
- **Personal vs standard split at formalization time** —
  `ConceptBinding` (`src/PersonalSemanticIR.ts:109-129`) carries
  `personalDefinition` and `standardDefinition` **separately** plus a
  `definitionConflict` flag; `ConceptBindingResolver` makes the personal
  meaning displace the standard one *with a warning instead of silently*.
  This is a two-sense view that already enforces the key authority rule.
- **Authority-gated edges** — `UserKnowledgeEdge`
  (`src/KnowledgeProtocol.ts:145-154`) has `proposedBy: "user"|"ai"` and
  `reviewStatus: pending|accepted|rejected` — a proven pattern for
  "AI may propose, only review makes it authoritative".
- **Promotion ladder with provenance** — the chat semantic-delta flow:
  AI proposal (`ChatSemanticDeltaProposal`, `authority: "proposed"`) → the
  user **edits the proposed meaning card** → explicit confirmation →
  `ConfirmedSemanticDelta` (`authority: "user_confirmed"`), where the
  definition's provenance is a `user_edit` of the reviewed card
  (`src/ChatSemanticDeltaConfirmation.ts:62-76`). Only user-confirmed deltas
  may propagate (`src/SemanticPropagation.ts:183-185`). **This is the exact
  "AI never silently becomes user meaning" invariant, already structurally
  enforced** — the sense layer must keep it, not reinvent it.
- **Candidate-preserving lookup** — `lookupConcept`
  (`src/BrainGrowthIndex.ts:137-156`) resolves by tiers (stable id → exact
  title → normalized title → alias) and **preserves multiple candidates**
  per tier instead of choosing one.
- **Revision history** — `ConceptNode.history` holds full snapshots per
  revision with reasons; `restoreConceptRevision` exists
  (`src/BrainGrowth.ts:851-874`). Maintenance goes through an explicit
  approval boundary with stale-revision guards
  (`src/BrainMaintenance.ts`).
- **Provenance-role separation in the model-facing context** — the activated
  context pipeline (`src/ActivatedContextPromptAdapter.ts`) already labels
  content for the model: `user_evidence` (exact historical user-originated
  language), `provisional_semantic_interpretation` (historical AI-owned
  interpretation, "never quote as user speech"), `vault_markdown`. Sense
  injection must reuse these roles rather than invent new ones.

### 1.2 Where "one concept ≈ one meaning" is actually assumed

1. **`ConceptNode.userDefinition` is a single slot.** A second user meaning
   can only exist as a *quarantined alternative* that is cleared on
   resolution (`resolveConceptMeaning` clears `alternativeUserDefinitions`).
   There is no per-meaning identity, so nothing else can reference
   "mirai-as-assistant" vs "mirai-as-future".
2. **`getConceptMeaningStatus`** (`BrainGrowth.ts:829-839`) — `defined` iff
   exactly one userDefinition and zero alternatives and zero open meaning
   items. A concept with two legitimate senses is modeled as *broken*
   (ambiguous) instead of *polysemous*.
3. **`renderConceptNodeMarkdown`** renders a singular "My definition".
4. **Consumers read one definition**: `ConceptBindingResolver`,
   `FormalizationAdapter.ts:191`, `BrainFormalizationWorkflow.ts:456`,
   `BrainDiagnostics.ts:124`, `SemanticPropagation.requiresPendingDefinitionReview`.
5. **`SemanticDelta`** kinds `personal_definition_created/redefined`
   (`src/SemanticDelta.ts:10-15`) model *one* definition transition per
   revision pair. Adding a second concurrent sense is not representable.
6. **`ChatSemanticDeltaProposal`** carries one `proposedMeaning` — the chat
   flow can only propose to replace the meaning, never to add a sense.
7. **Retrieval is surface-level, not sense-level**: `SemanticPrior` episode
   retrieval (`src/SemanticPrior.ts`) and `SemanticRetrievalQuery` match
   surfaces/anchors/symbols, with no notion of which meaning of the surface
   applied historically.
8. **The activation pipeline** (`ActivationSeed` → `BoundedActivationTraversal`
   → `ActivatedContextMaterialization` → `ActivatedContextPromptAdapter`) has
   target kinds `surface | vault_note | vault_subpath | semantic_episode` —
   there is no concept-sense target kind, and no sense-aware ordering.

### 1.3 Classification: implemented / partially reusable / incompatible / design-only

| Piece | Verdict |
|---|---|
| Authority buckets on `ConceptNode` | **Partially reusable** — they ARE an implicit authority model; what is missing is per-meaning identity, default-sense pointer, and uniform shape. The design generalizes them, it does not replace them. |
| `ConceptUserDefinition {id, text, sourceRefs}` | **Reusable** — this is already 80% of a sense record. |
| Provenance rules (`UserTextProvenance`, exact-match rule) | **Reusable unchanged** — senses with user authority keep the exact-match invariant. |
| Chat delta proposal → user edits card → confirmation → user_edit provenance | **Reusable unchanged** — the promotion path for new senses. |
| `SemanticSpec` ambiguities/choices/resolutions + blocking rule | **Reusable unchanged** — the ambiguity policy for multiple active senses. |
| `UserKnowledgeEdge` proposedBy/reviewStatus | **Reusable pattern** — future sense-level edges. |
| `ConceptRelationship` (edges target `conceptId`, not senses) | **Partially reusable** — concept-level edges stay as-is in v0; sense-level edges are future-graph work (see §15). |
| `generatedInterpretations` staleness machinery (`derivedStatus`, `dependencies`, propagation invalidation) | **Incompatible with a naive fold-in** — coupled to `ConceptContentEntry`. Kept in place in v0 (which is runtime-only, §13); fold-in deferred with no scheduled commitment (review decision Q6). |
| `BoundedActivationTraversal` | **Reusable unchanged** — v0 does NOT add a new target kind; senses enter as seeds/annotation (see §8). |
| Persistence projection (`lain-brain-concept-data:v1`) | **Unchanged in v0** — a v2 projection with a deterministic v1→v2 migration is FUTURE PERSISTENCE PHASE design (§10), explicitly out of v0 scope. |
| Anything resembling a persisted activation score | **Does not exist today** — the design must keep it that way. |

### 1.4 Critical assessment

The current architecture is *closer to the target than the problem statement
implies*. The real gaps are three, in decreasing order of difficulty:

1. **No stable identity per meaning.** Senses cannot be referenced,
   revised, related, or activated because only the current definition has
   an addressable slot.
2. **Exactly-one-authoritative-meaning semantics.** Alternatives are
   quarantined, cleared on resolution, and unranked.
3. **No contextual activation.** Which meaning applies is left entirely to
   the model, fed by whichever surface happened to be retrieved (the M2B.5
   cross-chat failure was one symptom of this: context materialization was
   meaning-blind).

The long-term move is to **generalize the existing buckets into a uniform
sense table** with a default-sense pointer, and compute activation as a
transient pure function. Building a parallel sense store alongside
`ConceptNode` would create two homes for concept meaning and force the
future graph to join across stores — rejected.

The short-term move — **M2B.6a-v0 — is a runtime-only experiment**: project
the existing buckets into sense candidates at send time, activate them
contextually, and measure whether the annotation + retrieval boost actually
improves Brain behavior *before* making any representation permanent (§13).

---

## 2. Problem statement

- A ConceptNode can legitimately carry multiple senses (mirai = lain's
  assistant entity **and** Japanese 未来 = future).
- "Which senses belong to the concept" is persistent, authority-aware
  knowledge. "Which sense is active right now" is a temporary,
  context-dependent computation.
- The two must never be confused: no persisted percentages, no activation
  scores stored next to meanings. A 70/30 split conflates long-term semantic
  truth with a transient guess.
- Authority and contextual relevance are **two independent dimensions**:
  authority says what kind of claim a sense is and how it may be quoted,
  trusted, persisted, or promoted; relevance says what the current utterance
  means right now. Authority must never act as ordinary evidence that a
  sense is contextually active.
- The existing authority invariant must hold: AI interpretation never
  silently becomes lain's personal meaning, and dictionary meaning never
  silently displaces it either.
- Semantic relevance must never be mistaken for referential identity
  (§3 identity invariant).

---

## 3. Definitions

- **Concept** (`ConceptNode`): the stable identity. Owns surfaces
  (title + aliases) and all meanings. Identity ≠ meaning.
- **Sense** (`ConceptSense`): ONE meaning of ONE concept, with authority and
  provenance. Membership is persistent. (Persistence-phase design, §4; v0
  projects candidates at runtime without writing them.)
- **Default sense** (`primarySenseId`, persistence phase): the concept's
  default personal sense used for **context-free fallback and legacy-consumer
  compatibility**. It does **NOT** mean "the only true/authoritative
  meaning" — multiple `user_confirmed_personal` senses may coexist.
- **Sense activation**: a transient, per-request ranking of a concept's
  senses produced by a pure deterministic function from the current context.
  Never persisted, never stored on the sense.
- **Concept activation**: the relevance/accessibility number a concept or
  surface receives in the existing activation pipeline (traversal →
  materialization). It is *relevance only* — the prompt policy already
  declares this ("Activation means relevance/accessibility only"); this
  design reaffirms it and adds: activation says nothing about identity.
- **Semantic similarity**: scored, heuristic relatedness between two
  meanings/surfaces (shared anchors, co-occurrence, structural overlap).
  It is evidence for "worth retrieving as related context" — never for
  identity.
- **Referential identity** (same_as / alias_of / refers_to / coreference /
  merge): the claim that two surfaces or concepts denote the same object.
  Requires **independent supporting evidence** — at minimum an explicit
  user-authored equivalence statement; the durable form is the existing
  user-confirmed alias/merge flow.
- **Authority vs relevance**: authority/provenance answers "what kind of
  semantic claim is this, and how may it be quoted, trusted, persisted, or
  promoted?" Contextual relevance answers "what does this utterance mean
  right now?" Authority may control fallback, presentation, and persistence
  policy — but it is **not** an activation signal and never contributes to
  the contextual relevance score.
- **Alias vs sense**: an alias is an alternative *surface* for the same
  identity (existing `ConceptNode.aliases`). A sense is an alternative
  *meaning*. They are orthogonal; adding a sense must never be used to
  encode an alias.
- **Property / attribute / relation vs sense**: a property or relation holds
  *of the thing denoted* within one sense; a different sense means the
  surface *denotes a different thing in a different frame*.

  **The boundary test** (used in scenario B and for sense identity): try
  substituting the candidate meaning for the surface in the user's
  utterance.
  - If the substitution preserves what is being talked about (only
    elaborating it) → same sense; record it as a property/relation/statement.
  - If the substitution changes the referent → a different sense.

  Corollaries: "蓝璃 represents 离开封闭系统" is a **relation of the key
  within its personal sense**, not a second sense. "蓝璃 *is now* the codename
  of the concept 离开封闭系统" would repurpose the surface to denote the
  concept itself → a **new sense** (user-authored, unconfirmed until
  confirmed). Revisions are history, not senses (§9 scenario C).

**IDENTITY INVARIANT — semantic relevance, activation, adjacency, and
co-text/retrieval are each ≠ referential identity.**

- SEMANTIC RELEVANCE ≠ REFERENTIAL IDENTITY
- CONTEXTUAL ACTIVATION ≠ REFERENTIAL IDENTITY
- DISCOURSE ADJACENCY ≠ REFERENTIAL IDENTITY
- CO-TEXT / RETRIEVAL ≠ REFERENTIAL IDENTITY

A semantically similar, highly activated, recently discussed, or
retrieved concept may be injected as *related context*, but none of these
may ever establish same_as, alias_of, refers_to, coreference, or a
concept merge. Identity/coreference claims require **independent
identity evidence** — e.g. "X 就是未来", "这里 X 指未来", "X 是未来的另一
个名字", "我说 X 的时候就是指未来". Similarity, activation, adjacency,
and retrieval are context, not evidence.

**FRESH REFERENT PRINCIPLE.** When the user explicitly introduces a
previously unresolved surface in a declarative semantic statement —
"X 对我来说是某种自由", "Y 是我给某个东西起的名字", "Z 对我意味着……" —
the safe default is: treat that surface as a **distinct provisional
referent**. It is NOT:

- a placeholder / empty slot waiting to be filled,
- an alias of the most recently activated or discussed concept,
- a coreference candidate,
- the same entity as a semantically related prior,

unless the user's language supplies independent identity/coreference
evidence. A NEW EXPLICIT SURFACE ≠ AN UNBOUND PLACEHOLDER BY DEFAULT.
(Deployed failure: "X 对我来说是某种自由" after a mirai/未来 discussion
was answered with "X 是一个空的格子…最自然的填法大概是未来" — the fix,
§8/§13, marks fresh surfaces as distinct provisional referents in the
model-facing context and forbids identity inference from discourse
adjacency.)

**AUTHORITY/RELEVANCE INVARIANT.**
Authority is not contextual evidence. A sense's authority class never
contributes to its contextual relevance score; it only sets fallback
ordering, quoting/presentation rules, persistence eligibility, and promotion
paths. (authority ≠ contextual relevance.)

---

## 4. Persistent sense model — FUTURE PERSISTENCE PHASE (design target, NOT v0 scope)

> Everything in this section and §5/§10 describes the *eventual* persistent
> representation. **M2B.6a-v0 (§13) is a runtime-only experiment and writes
> nothing.** This phase starts only after the experiment shows real product
> benefit.

One sense is one record. Do not over-model it.

```ts
// src/ConceptSense.ts (new, pure model module — design sketch)

export const CONCEPT_SENSE_SCHEMA_VERSION = 1 as const;

export type SenseAuthority =
  | "user_confirmed_personal"     // the confirmed personal meaning
  | "user_authored_unconfirmed"   // user-authored, not confirmed as default
  | "external_conventional"       // dictionary / conventional meaning
  | "ai_provisional";             // AI hypothesis

/** Provenance is per-class. A sense keeps the provenance appropriate to
 *  its source; it is never reduced to "no provenance". */
export type ConceptSenseProvenance =
  | { readonly kind: "user_text";
      readonly refs: readonly UserTextProvenance[] }      // actor:"user"
  | { readonly kind: "external_source";
      readonly refs: readonly string[] }                  // e.g. migrated
      // from standardDefinitions.sourceReferences — retained verbatim
  | { readonly kind: "ai_generated";
      readonly refs: readonly string[] };                 // future fold-in

export interface ConceptSense {
  readonly schemaVersion: typeof CONCEPT_SENSE_SCHEMA_VERSION;
  /** Globally unique, stable: "sense:<conceptId>:<n>". Cross-referenceable
   *  by the future M2B.6 edge graph. */
  readonly id: string;
  readonly conceptId: string;
  /** Short display label ("assistant / entity", "future"). Derived
   *  automatically at render time; display-only, never used for retrieval
   *  truth, never needs confirmation (review decision Q2). */
  readonly label?: string;
  /** The sense's definition text. For user-authority senses this is exact
   *  user-authored language (existing provenance invariant). */
  readonly meaning: string;
  readonly authority: SenseAuthority;
  readonly provenance: ConceptSenseProvenance;
  readonly createdAt: string;
}
```

### 4.1 Sense identity is stable across refinements

A sense is **not** globally immutable in the sense that every correction
creates a new sense. Identity follows the referent/frame boundary (§3):

- **Same referent / same semantic frame, refined meaning**
  → **preserve `senseId`**; the refined meaning lands in a **new
  ConceptNode revision** (the existing snapshot/history machinery records
  the when and why).
- **Genuinely different referent/frame**
  → **new `senseId`**.

The substitution/referent test is the boundary in both directions.

Likewise, promotion `user_authored_unconfirmed → user_confirmed_personal`
for the **same meaning preserves the same `senseId`** — the authority/review
state changes in a new ConceptNode revision, never by replacing the record.
Each revision's snapshot is immutable (existing ConceptNode semantics); the
sense's *identity* simply spans revisions.

### 4.2 Default sense pointer

```ts
readonly senses: readonly ConceptSense[];   // (persistence phase)
readonly primarySenseId?: string;           // must reference a
                                            // user_confirmed_personal sense
```

`primarySenseId` means **"default personal sense used for context-free
fallback and legacy-consumer compatibility"** — not "the only true meaning".
Multiple `user_confirmed_personal` senses may coexist; exactly one may be
the default. The derived legacy view (`userDefinition`) continues to expose
the default sense to existing consumers (`ConceptBindingResolver`,
`FormalizationAdapter`, `BrainDiagnostics`, `SemanticPropagation`,
`ChatSemanticDelta`, `BrainFormalizationWorkflow`), so they keep working
unchanged while the sense layer evolves.

Deliberately **NOT** in the sense:

| Rejected field | Why rejected |
|---|---|
| `activation` / `score` / `frequency` / any percentage | Runtime-only. Persisting it is the exact conflation the requirement forbids. |
| `revisedAt` / mutable `status` | Time and status live in the ConceptNode revision history; the sense identity spans revisions (§4.1). A `status` field invites state-transition machinery with no benefit. "Default vs historical" is derived: `primarySenseId` points at the default; everything else is historical or non-default. |
| `contextHints` (model-suggested cue lists) | Activation cues are derived deterministically from `meaning` + provenance at runtime (§6). Persisted model-suggested hints would encode wrong priors and would need their own invalidation story. Revisit only if empirical testing shows derivation is insufficient. |
| Relations to other senses/concepts | Future graph edges (§15). The sense only needs to be *addressable* (`id`); edges live elsewhere. |
| Embedding vectors | Deferred. Deterministic, inspectable scoring first. |

---

## 5. Authority model — FUTURE PERSISTENCE PHASE (design target, NOT v0 scope)

Four classes. Authority governs fallback, presentation (how a sense may be
quoted), persistence eligibility, and promotion — **never activation**
(review decision 1; §3 authority/relevance invariant).

| | `user_confirmed_personal` | `user_authored_unconfirmed` | `external_conventional` | `ai_provisional` |
|---|---|---|---|---|
| **Created by** | Explicit user confirmation only (existing chat semantic-delta card or maintenance review). Provenance: `user_text` (`user_edit` of the reviewed card / user message spans). | User-authored text recorded as a meaning that differs from the current default (existing `preserve_user_meaning` flow), or a durable statement like "以后我说 X 通常指 Z" (§16 Q5). | Existing `standardDefinitions` content (migration, provenance retained), or future reviewed external mappings. AI may *suggest* one, but without grounded external provenance it stays `ai_provisional` (review decision Q1). | AI analysis only (existing `ChatSemanticDeltaProposal` / `generatedInterpretations`). |
| **Fallback ordering** | First (default when context is uninformative). | After confirmed. | After user classes. | Last. |
| **Quoting / presentation** | Quoted as `user_evidence`. | Quoted as `user_evidence` (the language really is user-authored) with a separate annotation "unconfirmed / not the default" (review decision Q4). | Quoted as external-source material with its provenance retained; never user speech. | Quoted as `provisional_semantic_interpretation`; never quoted as user speech (existing policy). |
| **Affects interpretation** | The default interpretation; may displace any other sense **when context is uninformative** (fallback), with the existing warning instead of silent override. | Carried as a hypothesis; never silently the default. | May help interpret (e.g. 未来 ↔ mirai) — contextual relevance can select it over the personal default for a given utterance; it never changes what the personal sense *is*. | May help interpret; always AI-owned; never user speech. |
| **Persisted** | Yes (only class allowed as `primarySenseId`). | Yes. | Yes, with its own provenance shape (`external_source`). | In the future phase: in the sense table. Until then: remains in the existing `generatedInterpretations` bucket (already persisted, quarantined, with staleness machinery). |
| **Promotion** | Terminal. | → `user_confirmed_personal` via the **existing** explicit confirmation boundary; **same `senseId`**, authority recorded in a new ConceptNode revision. | → cannot be promoted directly by any automated step. The user must restate the meaning in their own words (creating a user-authority sense through the existing confirmation). | → only via the existing path: AI proposes → user **edits the card** → explicit confirmation → `user_confirmed_personal` with `user_edit` provenance. |
| **User action for promotion** | — (already at top) | Explicit confirmation (existing UI). | Restatement + confirmation (authoring). | Card edit + confirmation. |
| **May override** | Any other class **as the default/fallback**; never erases other senses. | Never the default without confirmation. | Never any user class's persistence/quoting status; may be contextually selected for interpretation. | Never anything; conflicts with user senses are surfaced (existing `definitionConflict` precedent). |

Critical invariants (enforced at runtime + tests):

1. `primarySenseId` must reference a `user_confirmed_personal` sense.
2. User-authority sense text must exactly match its user provenance
   (existing rule, extended to senses).
3. Promotion never copies AI text into user provenance — the user's
   authored/edited text is the definition (existing mechanism, unchanged).
4. **Sense identity is preserved across refinements** — same referent/frame
   → same `senseId`, new ConceptNode revision; new referent/frame → new
   `senseId`. Promotion preserves `senseId`.
5. Identity operations (alias, merge, coreference) are recorded only via
   the existing user-confirmed flows. Similarity or activation never
   triggers them (§3 identity invariant).
6. **Authority never contributes to the contextual relevance score**
   (§3 authority/relevance invariant; review decision 1).

---

## 6. Runtime activation model

### 6.1 Two layers, strictly separated

**Persistent layer** (eventually: concept note / v2 projection): senses,
`primarySenseId`, history. No activation anywhere in it. In v0 the
"persistent layer" is simply the **existing authority buckets, untouched**.

**Runtime layer** (per send, in memory only): a transient
`SenseActivationReport` held on the session like `lastInjectedPriorIds`
(diagnosable, never serialized). Example shape:

```ts
interface SenseActivationReport {
  readonly conceptId: string;
  readonly surface: string;          // matched surface in the utterance
  readonly entries: readonly {
    readonly senseId: string;        // v0: derived projection id (§13)
    readonly authority: SenseAuthority;
    readonly score: number;          // contextual relevance only — authority
                                     // is reported alongside, never inside
    readonly firedSignals: readonly string[];  // inspectable trace
  }[];
  readonly resolved: boolean;        // false → fail-safe fallback (§8)
}
```

Computed by a **pure, deterministic** function
`activateConceptSenses(input) → report`. No LLM call. No state. No I/O
beyond what the caller already has. Never persisted — the serialization
layer has no field for it and the validator rejects it (invariant test).

### 6.2 Two independent dimensions

- **Contextual relevance** — "what does this utterance mean right now?" —
  the additive score below. Authority is **not** one of its terms (review
  decision 1).
- **Authority/provenance** — "what kind of claim is this, and how may it be
  quoted, trusted, persisted, promoted?" — reported per entry; consumed by
  fallback ordering, quoting/presentation rules, and persistence policy
  only (§5). It decides ties *after* relevance has done its work, never
  before.

### 6.3 v0 signals (exactly four — review decision 8)

The first runtime experiment starts with the smallest defensible set.
Additional signals are added only after **observed product failures**
justify them (§6.4).

| # | Signal | Why it helps | Authoritative or heuristic? | How it can fail |
|---|---|---|---|---|
| V1 | **Lexical / co-text evidence** — the utterance (surface match + surrounding words) contains the sense's `meaning` text or distinctive phrases from its provenance | Users reuse their own wording; local context discriminates senses with shared surfaces; carries language-frame cues ("未来", "词", "读") | Heuristic | Metonymy, paraphrase, quoting; very short utterances have no co-text |
| V2 | **Sense-specific SemanticPrior evidence** — historical episodes whose anchors/evidence match the surface AND sense-specific terms; recency-weighted within the signal | Historical usage context: which sense this user has actually been using | Heuristic | Cross-topic adjacency; old episodes dominating |
| V3 | **Explicit session direction** — the user explicitly scopes which sense they mean in the current session ("这里/这句话里的 X 指 Z") | Direct user direction | **Authoritative for this conversation only** — expires with the session by construction; never persisted | None meaningful — it is temporary by design |
| V4 | **Explicit contradiction/correction** — literal rejection patterns adjacent to the surface ("我说的 mirai 不是你，是未来"; "不是…而是…") | User correction is the strongest local signal | Heuristic pattern — **must fail safe**: only conservative literal patterns; a missed pattern is fine, a false positive is not | False negatives (softened wording) are acceptable; the penalty never *removes* a sense from candidates, only de-ranks it |

### 6.4 Deferred signals (NOT in v0; add only after observed failures justify)

- Session-spec structural overlap (current `SemanticSpec` symbols/relations
  vs sense terms) — depends on shadow-analysis timing and can be stale.
- Active-note scoring — weak, noisy.
- Script/domain cues as a *separate* signal — already partially carried by
  V1 co-text; split out only if a real failure demands it.
- Generic recency scoring — recency ≠ relevance.
- Graph signals, embeddings — explicitly out (§13 non-goals).

### 6.5 Combination and dominance

- `score = Σ wᵢ · sᵢ` over the fired v0 signals; all weights are named
  constants. **No authority term exists.**
- V3 (session direction) **dominates**: when fired, the named sense wins
  regardless of score (temporary override, not persistence).
- V4 (contradiction) applies a **penalty** to the contradicted sense and a
  boost to any named alternative.
- Authority enters **only after relevance**: near-ties fall back to
  authority order (default personal sense first), and presentation rules
  apply per class (§5). Authority can therefore *never* flip a clear
  relevance win — "未来这个词读 mirai 吗" selects the external sense on
  lexical/co-text evidence alone, with authority merely deciding how that
  sense may be quoted.

---

## 7. Ambiguity policy

Combination of B (carry multiple hypotheses) and D (threshold), with the
existing blocking rule as the only trigger for questions (E):

1. Compute activation (§6).
2. **Clear winner** (top score exceeds the runner-up by an **absolute
   contextual-score margin** AND meets a **minimum evidence threshold** —
   not a multiplicative ratio; review decision Q3 — and no contradiction,
   no V3 override): use that sense. No question.
3. **Near tie or insufficient evidence**: carry the top senses as
   hypotheses in the working spec (existing `SemanticSpec.ambiguities` with
   `blocking: false`), and let the reply acknowledge the double reading
   briefly when it matters. Fallback ordering for presentation is
   authority-based (§5); that is presentation, not activation.
4. **Ask a clarification ONLY** when the existing blocking rule fires:
   ≥2 senses remain plausible after context AND the difference would
   materially change the next reasoning or action AND the request requires
   committing to one (e.g. recording a definition, mutating the concept
   graph). The question must offer the concrete sense choices (existing
   `choices` shape) and is guarded by the existing `GENERIC_CONFIRMATION`
   rejection ("Is this correct?"-style questions are never generated).
5. **"mirai is important"** → near tie → carry both hypotheses, non-blocking,
   no question. This preserves the existing principle: clarification is for
   real blocking ambiguity, never a mandatory confirmation step.
6. **Similarity never triggers identity questions.** An "is X the same as
   Y?" question requires an identity hypothesis grounded in evidence
   (typically the user's own wording signaling possible equivalence).
   Seeing that a concept is merely similar to the current topic is not a
   blocking ambiguity and must not produce a clarification — it produces
   related context with the distinct-referent stance (§9 scenario D).

The margin and evidence threshold are named constants — deterministic,
tunable without schema change; initial values chosen at implementation.

---

## 8. Retrieval integration

Order of operations in the foreground send path (design-only; the existing
steps are `LainBrainSession.send()` → `selectRelevantSemanticPriorEpisodes`
→ `prepareForegroundActivatedContext` → `askText`):

1. **Surface extraction** (existing) — seed surfaces from the utterance.
2. **Concept lookup** — cached concept index (existing `loadObsidianConceptIndex`;
   v0 adds a per-session cache). Concepts whose title/alias surfaces appear
   in the utterance.
3. **Sense candidate projection** (v0) — project the concept's existing
   buckets into transient sense candidates (§13.3): `userDefinition` and
   `alternativeUserDefinitions` as user-authority candidates,
   `standardDefinitions` as `external_conventional` candidates (provenance
   retained), `generatedInterpretations` as `ai_provisional` candidates.
   No persistence is touched.
4. **Activation** — pure `activateConceptSenses` (§6). Transient report.
5. **Retrieval effects** (all additive — see fail-safe below):
   - The **activated senses' distinctive terms** join the
     `SemanticRetrievalQuery` seed surfaces (a boost channel, exactly like
     the M2B.5 seeding — retrieval stays fail-safe and advisory).
   - `SemanticPrior` retrieval gains a **sense-anchored bonus channel**:
     episodes whose anchors/evidence match the active sense's terms score
     higher; episodes that match only other senses are not suppressed,
     only ranked lower.
   - The prompt gets a **sense annotation block** (compact, only for
     concepts mentioned in the utterance that have ≥2 sense candidates):
     ```
     Sense context (temporary, current conversation):
       "mirai": [active] assistant / entity — lain-confirmed
                future — external
     ```
     Labels are derived automatically at render time (review decision Q2).
     Injected through the existing activated-context pipeline, reusing the
     existing provenance roles: user senses quoted as `user_evidence`
     (with "unconfirmed / not the default" annotation where applicable —
     review decision Q4), others as `provisional_semantic_interpretation`-
     grade material, the active marker as plain policy text.
     Budget-checked by the existing prompt adapter (the block is small and
     hard-capped).
   - **Identity safety in related-context injection.** Whenever a concept
     is injected on similarity without identity evidence, it is marked
     "related (similar meaning), distinct referent". The prompt policy
     line: "Related context establishes similarity only — never infer
     same object, alias, or coreference from similarity, activation,
     discourse adjacency, co-text, or retrieval. Identity requires
     independent user-authored identity evidence." **Fresh Referent
     Principle (§3)**: surfaces the user introduces in a declarative
     frame ("X 对我来说是某种自由") are annotated as distinct
     provisional referents — "not a placeholder to fill, not an alias of
     a related or recently activated concept". The safe default
     model-facing stance for the deployed X case is exactly:
     "这里先把 X 当作一个独立的指称。你说它对你来说和某种自由有关。
     刚才的'未来'在语义上可能相关，但目前没有证据说明 X 就是未来，
     所以我不会把它们合并。" (See §9 scenario E.)
6. **Interpretation effect**: the active sense feeds the shadow semantic
   analyzer request as context (same annotation block), so the session's
   working hypothesis records *which sense* it built on — but the
   hypothesis stays provisional (existing authority rules unchanged).

**Fail-safe (a wrong activation must fail safe):**

- Activation only **adds, orders, and annotates**. It never removes a sense
  or an episode from the context; the full retrieved evidence stays
  available to the model.
- If activation throws, ties, or its inputs are missing → the pipeline
  degrades to today's behavior exactly: authority-ordered senses with the
  default sense first, no annotation, unchanged retrieval. (This is also
  precisely the current single-meaning behavior, so the fallback is
  behavior-preserving.)
- If the model follows a wrong annotation, the user's current language still
  outranks everything (existing prompt policy), and the contradiction cue
  (V4) exists to catch explicit corrections next turn.

---

## 9. Worked examples

### SCENARIO A — "mirai"

Persistent senses:

1. `user_confirmed_personal` — "lain 的助手/实体，在个人协议中指代助手"
2. `external_conventional` — "日语『未来』= future"

**A1 — "mirai 你觉得这个怎么样"**
- Candidates: S1, S2. Fired: V1 co-text ("你觉得" addresses an
  interlocutor — a people cue). The external sense fires nothing.
- Activation: S1 ≫ S2 → **S1 active**. Reply addresses the assistant sense.
- Authority: S1 is the default anyway. **Nothing persists.**

**A2 — "未来这个词读 mirai 吗"**
- Fired: V1 lexical/co-text (未来, 词, 读 — language-topic). No other
  signals fire; authority plays **no part in the score**.
- Activation: S2 wins on lexical/co-text evidence alone → **S2 active**.
  Reply: yes, 未来 reads "mirai"; optionally note it differs from lain's
  personal mirai.
- Authority handling: S1 remains the default personal sense; the external
  sense only *helped interpret this utterance*. **Nothing persists.**

**A3 — "mirai no mirai"**
- Fired: both surfaces present, no disambiguating co-text, no contradiction.
- Activation: near tie → **carry both hypotheses** (blocking=false), no
  question. Reply may note the double reading (Japanese wordplay vs the
  assistant naming its own future).
- **Nothing persists.**

**A4 — "我说的 mirai 不是你，是未来"**
- Fired: V4 contradiction on S1 ("不是你"), V1 on S2 ("是未来").
- Activation: **S2 active**; S1 remains listed in the annotation.
- Authority handling: this is a *usage scoping*, not a redefinition — the
  concept's senses are unchanged. **Nothing persists.** (If the user wants
  this to become durable, that is the existing confirmation flow's job.)

### SCENARIO B — 蓝璃 (sense vs everything else)

Known personal meaning: 蓝璃 is a fictional key name and represents
"离开封闭系统".

- **Senses**: exactly **one** — the personal sense. "represents 离开封闭系统"
  is a **relation/property within that sense** (the key symbolizes the
  concept), not a second sense. Substitution test: replacing 蓝璃 with
  "离开封闭系统" in "蓝璃代表离开封闭系统" yields nonsense about the *key*
  (the key is not the concept); the referent is unchanged only if we keep
  the key and attach the symbolic relation. → same sense.
- **Aliases**: none exist today; if lain later says "蓝璃我有时就叫璃", that
  is an **alias** (new surface, same identity), not a sense.
- **Attributes**: "今天的测试背景颜色是橙色" is a property of the *test*,
  not of 蓝璃 — never a sense.
- **Revisions**: the delta history (name → symbolizes 离开封闭系统, not a
  door-opening key) is a **revision chain with history entries**, not
  multiple senses. Old snapshots remain in `history`.
- **When would a second sense appear?** If lain says "蓝璃现在就是离开封闭
  系统这个概念的代号" — the surface would now *denote the concept itself*.
  Substitution test: replacing 蓝璃 with "the concept 离开封闭系统" changes
  the referent of the utterance → **new sense** (new senseId),
  `user_authored_unconfirmed` until lain confirms it through the existing
  card flow.

### SCENARIO C — revision ("以前我把 X 当成 Y，但现在我说 X 时通常指 Z")

This creates:

1. **A new sense** for X = Z, authority `user_authored_unconfirmed`
   (the statement is user-authored; evidence = the message span). The old
   sense (Y) **stays in the sense table** — nothing is destroyed.
2. **Temporal knowledge via existing machinery**: the concept revision
   history (with reason, e.g. "用户说明 X 现在通常指 Z") records *when*;
   the old sense's createdAt records when it was born. No new temporal
   relation type is needed.
3. **Activation prior does NOT change automatically** — activation is
   computed fresh per turn. The new sense naturally ranks well (V1/V2
   evidence), but there is no stored "prefer Z now" score. That is the
   entire point of §4.
4. If lain **confirms** (existing card flow) → the new sense's authority
   becomes `user_confirmed_personal` **with the same senseId** (review
   decision 2), the default pointer may move, and a
   `personal_definition_redefined` delta records it; Y remains historical
   (a confirmed personal sense that is simply no longer the default —
   multiple confirmed senses may coexist). Until then, the default remains
   Y and the status is the honest "unconfirmed new meaning exists".

### SCENARIO D — X vs 蓝璃 (deployed failure: similarity mistaken for identity)

Persistent knowledge: 蓝璃 has the lain-confirmed personal sense — a
fictional key name that represents "离开封闭系统".

New user statement: **"X 对我来说是某种自由。"**

- **Candidate analysis**: X is a *new surface* — no stored concept, no
  stored senses. 蓝璃 is retrieved as related context: its sense terms
  ("离开封闭系统" → freedom-adjacent meaning) are semantically similar to
  "某种自由". Retrieving it is **correct and desirable** — the deployed
  failure was the next step.
- **What went wrong in the deployed behavior**: the Brain asked whether X
  *might be* 蓝璃. That is an **identity hypothesis generated from
  similarity alone** — exactly what the identity invariant (§3) forbids.
  The user introduced X as its own referent with its own meaning; there is
  no equivalence statement, no alias signal, no coreference evidence.
- **Activation reasoning**: concept activation of 蓝璃 is **high** (related
  context) — correct. Referential identity evidence for X = 蓝璃 is
  **zero** — similarity is context, not evidence. The two quantities are
  independent and must not be conflated.
- **Selected behavior**: inject 蓝璃 as related context with the
  distinct-referent marker (§8). No merge, no alias, no identity question.
  The safe model-facing stance is exactly:
  > "X is currently treated as a distinct referent. Its meaning resembles
  > the previously known 蓝璃 / 离开封闭系统 context, but there is no
  > evidence that X and 蓝璃 are the same object."
- **When an identity question becomes legitimate**: only when the *user*
  signals possible equivalence ("X 是不是就是蓝璃?" — the user asking, not
  the Brain), or when an identity hypothesis is grounded in explicit
  user-authored evidence and its difference materially changes the next
  action (existing blocking rule, §7 item 6).
- **Authority handling**: nothing persists. No alias is added, no sense is
  attached to 蓝璃, no concept merge occurs. The new statement about X may
  eventually seed a concept *for X* through the existing flows (user
  confirmation), but it never touches 蓝璃's senses.

**SECOND DEPLOYED OCCURRENCE (same utterance, after the mirai/未来
discussion):** the Brain no longer guessed X = 蓝璃 (identity-safety PASS),
but answered **"X 是一个空的格子"** and **"最自然的填法大概是未来"**, then
asked whether X was 未来. Forensic cause (traced through the actual
runtime): the X turn ran in the same session right after A1–A4, so the
conversation history contained the whole 未来 discussion (discourse
adjacency); retrieval also surfaced the previous X-turn episode whose own
shadow hypothesis said "上下文中最可能指向'未来'" plus an old episode
whose anchors contain "占位符" (placeholder priming); the sense annotation
covered only similarity/activation grounds and said nothing about X
itself. The model therefore treated the new surface as an unbound slot
and filled it from adjacent discourse — **DISCOURSE PROXIMITY ≠
REFERENTIAL IDENTITY** and **A NEW EXPLICIT SURFACE ≠ AN UNBOUND
PLACEHOLDER BY DEFAULT** (Fresh Referent Principle, §3).

- **Selected behavior (v0 fix)**: the annotation now marks the fresh
  surface as a distinct provisional referent ("not a placeholder to fill,
  not an alias of a related or recently activated concept") and the
  identity policy enumerates discourse adjacency, co-text, and retrieval
  as non-identity grounds. The safe model-facing stance is exactly:
  > "这里先把 X 当作一个独立的指称。你说它对你来说和某种自由有关。
  > 刚才的'未来'在语义上可能相关，但目前没有证据说明 X 就是未来，
  > 所以我不会把它们合并。"
- **Relatedness is preserved, identity is not**: 未来/mirai content may
  remain in the conversation and retrieval context; only the identity
  inference is forbidden.

---

## 10. Migration & backward compatibility — FUTURE PERSISTENCE PHASE (design target, NOT v0 scope)

> Applies only when the runtime experiment (§13) has proven the model and a
> persistent representation is commissioned. **v0 performs no migration.**

**Deterministic, non-destructive, no user review required.**

- Persistence projection bumps `lain-brain-concept-data:v1` → `v2`
  (`src/BrainGrowthPersistence.ts`; the version gate already exists).
  The v1 reader is retained indefinitely; v2 files carry `senses[]` +
  `primarySenseId` at every snapshot level (current + each history
  snapshot), and the derived legacy `userDefinition` view is rebuilt at
  load.
- **Mapping function** (pure, applied to current node and every history
  snapshot identically):

  | Existing field | Migrates to |
  |---|---|
  | `userDefinition` | sense, `user_confirmed_personal`, **becomes `primarySenseId`**; provenance `user_text` (refs copied verbatim) |
  | `alternativeUserDefinitions` (each) | sense, `user_authored_unconfirmed`, provenance `user_text` |
  | `standardDefinitions` (each) | sense, `external_conventional`, provenance `external_source` with the entry's `sourceReferences` **retained verbatim** — provenance is never silently erased (review decision 4) |
  | `generatedInterpretations` | **stays in its bucket**; projected as `ai_provisional` candidates at runtime. Fold-in is deferred with no scheduled commitment (review decision Q6), because the staleness/dependency machinery (`derivedStatus`, `dependencies`, propagation invalidation) is coupled to `ConceptContentEntry`. |

- **Dedup (review decision 5): do NOT dedup identical normalized meaning
  text across different authority/provenance classes.** "External source
  says M" and "lain says M" are **distinct semantic facts** even when M is
  textually identical. Dedup only true duplicates *within* a compatible
  authority + provenance pair (same class, same meaning, same provenance
  refs). Deterministic.
- **AI interpretations are never promoted**: `generatedInterpretations`
  never produce user-authority senses. A dictionary meaning never becomes
  personal meaning by migration. The only promotion path is the existing
  user-confirmation flow (§5).
- **Old vaults open without review**: migration runs in memory at load;
  the readable note body and user content are untouched. The file is
  re-serialized as v2 lazily on the next save.
- **Revisions migrate**: history snapshots go through the same mapping, so
  `getConceptRevision`/`restoreConceptRevision` semantics survive, and
  sense ids are stable across those snapshots (§4.1).
- Determinism test: migrate the same v1 projection twice → identical v2.

---

## 11. Product UX (lain is the user, not the architect)

Lightweight; no ontology editor.

- **Concept note** (future persistence phase): the rendered note (existing
  `renderConceptNodeMarkdown`) gains a compact "Meanings" list under the
  title, e.g.

  ```md
  ## Meanings
  - ✓ assistant / entity — lain-confirmed (default)
  - ○ future — external
  - ? project-specific meaning — AI hypothesis
  ```

  Authority badges, default marker from `primarySenseId`. No percentages,
  no sliders.
- **Chat**: when a sense-aware interpretation is active, the existing
  semantic-change card can propose **"add a new sense"** (reusing the exact
  edit-and-confirm interaction) instead of only replacing the meaning.
- **Current-sense indicator (review decision Q7)**: do **not** show it
  constantly. Expose it in the inspection/debug UI, and optionally surface
  it in the panel **only when a non-default sense or a near-tie is active**
  (the moments where transparency actually matters).
- **Conflict disclaimer (review decision Q8)**: only surface it when the
  difference between senses could genuinely cause user-visible
  misinterpretation (e.g. the model follows the external sense for a
  personal-looking request). No mandatory disclaimer.
- **Promotion** is always the existing confirm action — no new modal, no
  new confirmation ritual. Clarification questions follow §7 and are rare.

---

## 12. Threat / failure analysis

| Risk | Mitigation |
|---|---|
| Sense explosion | Senses are created only through: future migration, the existing user-confirmation flow, or an explicit durable user statement. No background sense mining. v0 writes nothing at all. Display caps (top-N per note) are a UX concern, not a data mutation. |
| Duplicate senses | Dedup **within** compatible authority + provenance only (review decision 5); cross-authority identical text is intentionally kept — it is two different facts. |
| AI-invented senses accumulating forever | AI senses stay in the quarantined bucket / lowest authority class; capped in display; removable via existing maintenance; they never affect `primarySenseId`. v0: AI candidates exist only inside the transient report. |
| Personal meaning overwritten by dictionary meaning | Authority rules (§5) + personal-displaces-standard presentation + definitionConflict surfacing; contextual relevance may select the dictionary sense for one utterance but can never promote it or change the personal sense. |
| Authority leaking into activation | Explicit invariant (§3, review decision 1): authority is excluded from the relevance score by construction; a unit test asserts no authority term contributes. |
| Context activation unstable (flapping) | Activation is a pure function of named constants and inspected inputs — reproducible, testable, no hidden state, no LLM. |
| Circular activation | Impossible in v0: activation reads only the sense's own content + session context; senses do not activate each other. (If future graph edges feed activation, the traversal's existing bounded/visited machinery applies.) |
| Wrong-sense retrieval | Fail-safe (§8): activation is additive/ordering-only; full evidence stays in context; the user's current language always outranks context (existing policy). |
| Historical meaning lost | Senses are append-only in the future phase; history snapshots preserved; alternatives are no longer cleared on resolution (behavior change: keep, don't destroy). |
| Temporary activation persisted as truth | No activation field exists in any schema; the serialization validator rejects unknown fields (existing validation style); invariant test. |
| Excessive clarification questions | Reuse the existing blocking rule + GENERIC_CONFIRMATION guard; near ties are carried silently as hypotheses; similarity never triggers identity questions (§7 item 6). |
| Aliases mixed with senses | `aliases` field untouched; the substitution test (§3) is documented and tested; UI separates surfaces from meanings. |
| Properties mixed with senses | Same boundary test; scenario B documents the 蓝璃 case; test fixtures encode it. |
| Prompt context inflation | The sense annotation block is hard-capped (only utterance-mentioned concepts with ≥2 senses; a few lines each; counted in the existing prompt budget). |
| Similarity mistaken for referential identity (false coreference — deployed failure: X ≈ 蓝璃) | Identity invariant (§3): similarity/activation never implies same_as/alias_of/refers_to/coreference/merge. Related context is injected with an explicit distinct-referent stance (§8); identity questions arise only from user signals (§7 item 6); identity mutations happen only through user-confirmed flows. Covered by a mandatory identity-safety e2e test (§13.6). |
| Discourse adjacency mistaken for coreference / fresh surface treated as an unbound placeholder (deployed failure: X filled with 未来) | Fresh Referent Principle (§3): declaratively introduced fresh surfaces are annotated as distinct provisional referents — never placeholders; the identity policy explicitly forbids inference from discourse adjacency, co-text, and retrieval (§8). Covered by the fresh-referent unit + e2e tests (§13.6). |

---

## 13. M2B.6a-v0 specification (runtime experiment — minimal first implementation)

**The first implementation is a RUNTIME EXPERIMENT, not a persistence
migration** (review decision 7). Its purpose: empirically test whether
contextual sense selection actually improves Brain behavior **before**
making the representation permanent.

### 13.1 v0 pipeline

```
Existing ConceptNode authority buckets
 (userDefinition / alternativeUserDefinitions / standardDefinitions /
  generatedInterpretations)                    ← untouched, unchanged
        ↓
runtime sense-candidate projection            ← new, pure, read-only
        ↓
pure contextual activation                    ← new, pure (§6)
        ↓
transient SenseActivationReport               ← in-memory only
        ↓
small prompt annotation + additive retrieval seed boost   ← new, additive
        ↓
current Brain runtime                         ← unchanged
```

### 13.2 Explicitly NOT in v0

- NO persistence schema v2. NO v1→v2 migration. NO permanent ConceptSense
  write path.
- NO graph. NO embeddings. NO automatic sense mining.
- NO authority in the relevance score. NO deferred signals (§6.4).

### 13.3 Sense-candidate projection (pure)

For each concept whose title/alias surface appears in the utterance:

- `userDefinition` → candidate `user_confirmed_personal`, id
  `sense:<conceptId>:default` (derived, stable within the session),
  provenance = its `sourceRefs`.
- each `alternativeUserDefinitions` → candidate `user_authored_unconfirmed`,
  derived id `sense:<conceptId>:alt:<n>`.
- each `standardDefinitions` entry → candidate `external_conventional`,
  derived id `sense:<conceptId>:ext:<n>`, provenance = the entry's
  `sourceReferences` **retained** (review decision 4 — projection must
  never erase provenance).
- each `generatedInterpretations` entry → candidate `ai_provisional`,
  derived id `sense:<conceptId>:ai:<n>`.

Projection is deterministic (stable ordering by id), read-only, and
produces the candidate list for §6. Nothing is written anywhere.

### 13.4 Runtime flow

Per send: surface extraction → cached concept index lookup →
sense-candidate projection (§13.3) → pure activation (§6: V1–V4 only) →
transient report → additive retrieval boosts + capped annotation block with
identity safety (§8) → existing activated-context pipeline → model.
Shadow analysis receives the same annotation block (provisional only).
Fallback = current behavior exactly (§8 fail-safe).

### 13.5 Invariants

- §3 identity invariant (semantic relevance ≠ referential identity) —
  the X/蓝璃 scenario remains **mandatory** in tests.
- §3 authority/relevance invariant — authority never contributes to the
  relevance score.
- §8 fail-safe — activation is additive/ordering-only; degradation path is
  behavior-preserving.
- No activation state is serialized anywhere; the report lives and dies
  with the session.

### 13.6 Tests required (v0)

1. Projection: buckets → candidates with correct authority per class;
   `standardDefinitions` provenance (`sourceReferences`) retained verbatim;
   deterministic ordering.
2. Activation signals: unit tests per signal (V1–V4) with fixed fixtures;
   the four mirai queries from §9 A1–A4 (A2 must select the external sense
   on lexical/co-text evidence with no authority term); tie behavior; V3
   dominance; V4 penalty never removes a sense; **no authority term in the
   score** (unit assertion).
3. Ambiguity policy: near-tie → dual hypothesis, no question; absolute
   margin + minimum evidence threshold behavior; blocking rule fires only
   on material difference.
4. Identity-safety tests (X/蓝璃 scenario, stubbed providers):
   (a) e2e — a statement about a new surface merely similar to an existing
   concept must inject that concept as *related context*, carry the
   distinct-referent stance in the model-facing context, and never emit an
   identity question or an identity claim; the concept's buckets must be
   unchanged after the turn.
   (b) unit — the activation report contains no identity fields; identity
   can only be recorded via the existing user-confirmed flows.
5. Fresh-referent tests (deployed failure: X filled with 未来):
   (a) unit — declarative fresh-surface detection ("X 对我来说是某种自由"
   → ["x"]; "Y 是我给某个东西起的名字" → ["y"]; "X 就是未来" → ["x"];
   no frame → []; stored concept surfaces → []; pronouns/stopwords → []).
   (b) e2e — after a mirai/未来 exchange, "X 对我来说是某种自由" must
   mark X as a distinct provisional referent ("not a placeholder to
   fill"), carry the discourse-adjacency identity policy in the prompt,
   never suggest X = 未来 in the annotation, keep 未来 as conversational
   context, and mutate nothing.
6. Fail-safe test: broken/missing activation inputs → output identical to
   current behavior (no annotation, unchanged retrieval).
7. Invariant test: no activation field can be serialized into a concept
   note / data.json.

Persistence-phase tests (migration determinism, senseId stability across
refinements, default-pointer invariants, per-class provenance retention,
within-class dedup) are specified in §4/§5/§10 and belong to the FUTURE
PERSISTENCE PHASE — **not to v0**.

### 13.7 Explicit non-goals for v0

- No persistence schema change, no migration, no ConceptSense write path.
- No embeddings / neural scoring; no graph signals.
- No persisted activation, frequency, or context scores.
- No auto-sense mining from chat.
- No sense-target kind in the traversal (annotation + surface seeds only).
- No ontology/editor UI beyond the §11 sketches.
- No fold-in of `generatedInterpretations` (deferred, review decision Q6).
- Deferred activation signals (§6.4) — added only after observed product
  failures justify them.

---

## 14. Non-goals (standing)

- Never silently promote AI or external meaning to personal meaning.
- Never persist activation as semantic truth.
- Never use authority as contextual activation evidence.
- Never infer referential identity from similarity or activation.
- Never turn the clarification flow into a mandatory confirmation ritual.
- M2B.6 graph (edges, contradiction/analogy/dependency, weighted
  activation) is out of scope here — but §15 below guarantees the design
  is its substrate rather than an obstacle.

---

## 15. Relationship to the future M2B.6 graph (substrate only)

The design is chosen so the future graph is additive, not a rewrite:

- **Senses as edge endpoints**: globally unique `sense:<conceptId>:<n>`
  ids mean contradiction / analogy / dependency / revision-chain edges can
  key directly on sense ids.
- **Per-class provenance** on each sense gives every future edge an
  authority-grounded anchor (edges inherit the weakest endpoint's
  authority unless user-confirmed — same pattern as `UserKnowledgeEdge`).
- **Activation signals become edge features later**: V1 (co-occurrence),
  V2 (episode co-mention), V4 (contradiction) are exactly the statistics
  that future weighted edges would consolidate. v0 computes them per-turn
  without storing them; the future graph may cache aggregates as *graph*
  state (still never as sense truth).
- **Temporal relations** (revision chains, "previously meant Y") are
  already representable from `createdAt` + concept history + stable sense
  ids across revisions (§4.1); the future graph adds explicit edges if
  needed.
- **No circular activation substrate**: v0 has no sense→sense activation
  dependencies, so introducing edges later cannot create activation
  cycles without also introducing the bounded traversal that already
  exists for vault/episode targets.

What v0 deliberately does **not** bake in: any graph topology, any edge
schema, any cross-episode identity scheme beyond the globally unique sense
id (which is itself future-phase).

---

## 16. Design review decisions (Mirai review — resolved)

The eight open questions are resolved as follows:

**Q1 — External auto-proposal.** AI may *suggest* an `external_conventional`
sense, but v0 must not persist AI output directly as `external_conventional`.
Without grounded external provenance (a real source reference), the proposal
remains `ai_provisional`. Persisting external senses requires
external provenance.

**Q2 — Labels.** Display labels are derived automatically at render time
(from meaning text). Labels are display-only, need no confirmation, and are
never used for retrieval truth.

**Q3 — Ambiguity threshold.** Absolute contextual-score margin plus a
minimum evidence threshold — not a multiplicative top/runner-up ratio.
(Exact constant values are chosen at implementation; they are tunable
constants, not schema.)

**Q4 — user_authored_unconfirmed in the prompt.** Retain `user_evidence`
provenance (the language really is user-authored), with a separate
annotation of semantic status: "unconfirmed / not the default".

**Q5 — "现在 X 指 Z".** Distinguish scope:
- "这里/这句话里的 X 指 Z" → session-only direction (V3), **no
  persistence**.
- "以后/现在通常我说 X 指 Z" → durable intent: may record a
  `user_authored_unconfirmed` sense automatically; changing the
  default/primary sense still requires the existing confirmation boundary.

**Q6 — AI-sense fold-in.** Deferred until after real contextual-sense
product testing. No scheduled v0.1 commitment yet.

**Q7 — UI current-sense indicator.** Do not show it constantly. Expose it
in inspection/debug UI, and optionally surface it when a non-default sense
or a near-tie is active.

**Q8 — Conflict disclaimer.** Only surface it when the sense difference
could genuinely cause user-visible misinterpretation. No mandatory
disclaimer.

Remaining tunable constants (implementation-time, not design questions):
initial values for the V1–V4 weights, the absolute margin, and the minimum
evidence threshold.

---

*End of design document. No code was modified, nothing was implemented,
committed, or pushed, and no provider calls were made.*
