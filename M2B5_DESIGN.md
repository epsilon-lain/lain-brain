# M2B.4 Runtime Inspection + M2B.5 Retrieval Architecture Design

## PART 1 — Actual Runtime Episode Representation

### Source
`C:\Users\elonl\Desktop\lain-brain-dev\.obsidian\plugins\lain-brain\data.json`
→ `semanticPriorState.episodes`

### Total persisted episodes: 2

---

### Episode 0 — "lain 喜欢猫猫"

```
id: spe-564d88bd-be67-4dcf-afa2-1f38b4ab0b07
createdAt: 1786512532675
semanticSessionId: chat-semantic-message-1
semanticRevision: 2
evidenceRefs (1):
  "lain 喜欢猫猫"
```

**Symbols:**

| Surface | Role | userDefined | Description |
|---------|------|-------------|-------------|
| `lain` | entity | **true** | 用户引入的名字/昵称，具体指称对象未由证据进一步定义 |
| `猫猫` | concept | **true** | 用户使用的亲昵叠词，指猫；保留原词形，不等同于标准"猫"概念 |
| `喜欢` | relation | **false** | 用户表达的喜欢关系，具体类型或强度未在证据中定义 |

**Key observation**: "喜欢" is modeled as relation but **NOT userDefined**. The LLM treated it as a common predicate rather than a user-coined term.

**Anchors (14)**: `lain`, `不等同于标准`, `保留原词形`, `具体指称对象未由证据进一步定义`, `具体类型或强度未在证据中定义`, `喜欢`, `指猫`, `昵称`, `概念`, `猫猫`, `用户使用的亲昵叠词`, `用户引入的名字`, `用户表达的喜欢关系`, `用户证据断言`

**Critical anchor**: "喜欢" IS present. This means E0 WILL match queries containing "喜欢" or "最喜欢" (substring).

---

### Episode 1 — "lain 最喜欢什么喵？" + "定义过哦喵"

```
id: spe-ec373dc1-ae2a-4417-b3fd-954941eb0377
createdAt: 1786513331200
semanticSessionId: chat-semantic-message-7
semanticRevision: 2
evidenceRefs (2):
  "lain 最喜欢什么喵？"
  "定义过哦喵"
```

**Symbols:**

| Surface | Role | userDefined | Description |
|---------|------|-------------|-------------|
| `lain` | entity | false | 被询问偏好的对象 |
| `最喜欢` | relation | **true** | 用户声称已定义过的'最喜欢'关系/算子；其具体定义内容未知 |
| `什么` | variable | false | 原问题中待求的偏好对象 |
| `定义过` | predicate | false | 元语言谓词：某表达式已经被定义过 |

**Key observation**: "最喜欢" IS modeled as userDefined=True relation. The LLM correctly identified this as a user-coined term. But the description says "其具体定义内容未知" — the LLM knows it was supposedly defined before, but the definition content itself is NOT in this episode.

**Anchors (13)**: `但没有给出定义内容`, `元语言谓词`, `关系`, `其具体定义内容未知`, `原问题中待求的偏好对象`, `定义过`, `最喜欢`, `某表达式已经被定义过`, `此前已经定义过`, `用户声称已定义过的`, `用户断言`, `算子`, `被询问偏好的对象`

**Critical anchor**: "最喜欢" IS present. "定义过" IS present.

---

### CRITICAL FINDING: "lain 最喜欢素子姐姐" is NOT in ANY persisted episode.

```
"素子姐姐" found in: NOT FOUND
"最喜欢素子" found in: NOT FOUND
```

**The evidence defining `favorite(lain, 素子姐姐)` was never stored.**

---

## PART 2 — Exact Failure Class

### Root cause: Layer A — Persistence / creation failure

The episode for "lain 最喜欢素子姐姐" was never created or persisted.

Likely mechanism (`LainBrainSession.clearChat()` → `enqueueChatSemanticAnalysis`):

```
Turn B: "lain 最喜欢素子姐姐"
  → send()
  → foreground response succeeds, assistant message appended
  → enqueueChatSemanticAnalysis(apiKey, userMessage_B, response)
  → shadow analysis queued on chatSemanticQueue (async)

User: clearChat()
  → chatSemanticGeneration += 1
  → chatSemanticSession = undefined
  → pendingSemanticWork = null

Shadow analysis completes:
  → generation !== this.chatSemanticGeneration → return (silent discard)
  → Episode for Turn B NEVER CREATED
```

The foreground chat exchange completed successfully — the assistant replied. The user saw the response. But the semantic shadow was racing `clearChat()` and lost.

### Secondary classification

Even if the episode had been created, the retrieval would have:
- **Anchors**: likely `["最喜欢", "素子姐姐"]` (based on Episode 1's pattern)
- Query "lain 最喜欢什么喵？" would match "最喜欢" → E_B retrieved
- E_B would contain the evidence "lain 最喜欢素子姐姐"
- The foreground LLM would have the answer

So the **execution** failure (clearChat invalidation) masked whether the **modeling** would have succeeded.

### The benchmark's structural requirement

The query `favorite(lain, ?)` has this property:

> **THE ANSWER SURFACE DOES NOT NEED TO APPEAR IN THE QUERY.**

"素子姐姐" never appears in "lain 最喜欢什么喵？". The retrieval must bridge from the RELATION ("最喜欢") and the SUBJECT ("lain") to the historical assertion that fills the OBJECT slot ("素子姐姐").

This is a **relation-slot retrieval** problem:
- History: `favorite(lain, 素子姐姐)`
- Query: `favorite(lain, ?)`

The current architecture's only bridging mechanism is substring matching on symbol SURFACES. If the answer surface isn't a substring of the query, it can't be found unless a shared relation surface bridges.

Episode 0 and Episode 1 demonstrate this bridging DOES work when the relation surface is shared:
- E0: anchors `["喜欢", "猫猫"]` → "喜欢" substring of "最喜欢" → matches
- E1: anchors `["最喜欢", ...]` → "最喜欢" substring of query → matches

But the structural requirement is stronger: retrieve the SLOT VALUE even when the relation surface varies.

---

## PART 3 — Benchmark Categories

### B1. Relation-slot retrieval
```
History:  favorite(lain, 素子姐姐)
Query:    favorite(lain, ?)
Required: retrieve episode containing 素子姐姐 via relation "最喜欢" + subject "lain"
Challenge: answer surface "素子姐姐" not in query
```

### B2. Definition lookup
```
History:  user defines X as "自定义的时间尺度"
Query:    "X 是什么？"
Required: retrieve the definition statement of X
Challenge: query references X by name; definition body may use different terms
```

### B3. Paraphrase
```
History:  "最喜欢"
Query:    "最偏爱"
Required: retrieve relevant prior even when surfaces differ
Note:     do NOT hardcode this pair; treat as capability requirement
```

### B4. Dependency propagation
```
History:  A → B → C (B depends on A, C depends on B)
Query:    A is revised
Required: B, C become reachable as potentially affected
Challenge: upstream change → downstream impact visibility
```

### B5. Counterexample lookup
```
History:  K contradicts H (counterexample relation)
Query:    "之前什么反驳过 H？"
Required: retrieve K via contradiction edge from H
Challenge: query names H, answer is K — connected by structural relation
```

### B6. Temporal state distinction
```
History:  H0 → H1 → H2 (revisions of same concept)
Query:    "以前怎么看 X？" vs "现在怎么看 X？"
Required: distinguish H0 (old) from H2 (current)
Challenge: temporal qualifier changes which revision is relevant
```

### B7. Analogy retrieval
```
History:  X analogous_to Y
Query:    "这个和之前什么东西像？" (referring to current topic Z)
Required: if Z relates to X, retrieve Y via analogy edge
Challenge: multi-hop: Z→X→Y through structural edges
```

### B8. Custom-world context
```
History:  World W with assumptions/rules {A1, A2, R1}
Query:    entering W's context
Required: retrieve W-local structure, not unrelated global rules
Challenge: scoping — world membership boundary
```

### B9. Irrelevant recent distractor
```
History:  E_old relevant, E_recent unrelated
Query:    matches E_old semantically
Required: E_old ranks above E_recent
Challenge: recency bias must not override semantic relevance
```

### B10. Current correction
```
History:  H says X = Y
Current:  "X 不是 Y"
Required: current language overrides historical prior in foreground injection
Already enforced by authority disclaimer; verify structurally
```

---

## PART 4 — Minimal SemanticRetrievalQuery Proposal

```typescript
/**
 * Provisional semantic retrieval query derived from the current user utterance.
 *
 * This remains an assistant interpretation — it obeys the same
 * semantic-authority rules as the rest of Lain Brain.
 */
interface SemanticRetrievalQuery {
  /**
   * Exact user surface forms that seed the retrieval.
   * These are the raw language tokens that MUST be findable in history.
   */
  readonly seedSurfaces: readonly string[];

  /**
   * Entities / concepts that the query is ABOUT.
   * Example: "lain", "速度", "复数乘法"
   */
  readonly subjectRefs: readonly SubjectRef[];

  /**
   * Relations mentioned or implied by the query.
   * Example: { surface: "最喜欢", kind: "user_relation" }
   */
  readonly relationRefs: readonly RelationRef[];

  /**
   * Slots that the query is asking to FILL.
   * Example: { role: "object", constraint: "is favorite target of lain" }
   * UNKNOWN means "the answer to this slot is what we're searching for."
   */
  readonly openSlots: readonly OpenSlot[];

  /**
   * Temporal framing: is the query asking about current state,
   * historical state, or change over time?
   */
  readonly temporalIntent: TemporalIntent;

  /**
   * What kind of retrieval is this?
   * Guides edge-weighting in the activation model.
   */
  readonly retrievalIntent: RetrievalIntent;
}

type TemporalIntent =
  | "current_state"
  | "historical_state"
  | "revision_history"
  | "unspecified";

type RetrievalIntent =
  | "fill_slot"         // "X 是什么？", "最喜欢什么？"
  | "lookup_definition" // "X 的定义是？"
  | "find_evidence"     // "之前什么支持/反驳过？"
  | "find_related"      // "和这个像的东西？"
  | "propagate_change"  // "改了A会影响什么？"
  | "understand_context"; // general comprehension

interface SubjectRef {
  readonly surface: string;
  readonly roleHint?: string;
}

interface RelationRef {
  readonly surface: string;
  readonly kind: "user_relation" | "standard_relation" | "unknown";
}

interface OpenSlot {
  readonly role: "object" | "definition" | "evidence" | "related";
  readonly constraint?: string;
}
```

**Design principle**: The query is a PROVISIONAL STRUCTURE, not a committed parse. It seeds retrieval without becoming authoritative. If the query structure is wrong, retrieval degrades to surface matching — fail-safe, not fail-dangerous.

**Minimum viable query**: Even with only `seedSurfaces` populated (all other fields empty), the system falls back to current substring-anchor retrieval. The structural fields ENABLE richer retrieval without REQUIRING it.

---

## PART 5 — Seed Generation Channels

A `SemanticRetrievalQuery` could be seeded from multiple channels, each with different cost/precision tradeoffs:

### Channel 1: Lexical (deterministic, zero-cost)
- Extract all non-stop CJK bigrams/trigrams from current user utterance
- Populate `seedSurfaces`
- No structural fields
- **Already available**: current anchor derivation could be extended to evidence text

### Channel 2: Current SemanticSpec (deterministic, zero-cost if spec exists)
- If a ChatSemanticSession exists with a current SemanticSpec:
  - Walk symbols → populate `subjectRefs` with role information
  - Walk relations → populate `relationRefs`
  - Walk ambiguities with unresolved roles → populate `openSlots`
- **Partially available**: ChatSemanticSession already exists from prior shadow analysis

### Channel 3: Lightweight structural parse (future LLM call, optional)
- Ask the foreground LLM to produce a `SemanticRetrievalQuery` alongside its reply
- Same LLM call, just additional structured output
- NOT a separate request — piggybacks on the foreground response
- **Not yet available**: would require modifying the foreground system prompt

### Channel 4: Full shadow analysis (existing, async, already implemented)
- The existing `ChatSemanticAnalyzer` produces a full SemanticSpec
- The SemanticSpec contains symbols, roles, relations, statements, ambiguities
- Could derive `SemanticRetrievalQuery` from the semantic shadow output
- **Already partially available**: the shadow spec contains most structural information

---

## PART 6 — Future Weighted Activation Design

Conceptual sketch — NOT for implementation yet:

```
current utterance
  → provisional SemanticRetrievalQuery
  → seed nodes + seed relations
  → weighted activation spreading
  → relevant subgraph of historical episodes
```

### Activation sources (seeds)
- `seedSurfaces[i]` → activates episodes whose anchors contain that surface
- `subjectRefs[i]` → activates episodes whose symbols match the subject
- `relationRefs[i]` → activates episodes whose relation symbols are compatible
- `openSlots[i]` → biases toward episodes that fill those slots

### Edge types and intent-dependent weights

| Edge type | fill_slot | lookup_def | find_evidence | propagate_change | find_related |
|-----------|-----------|------------|---------------|------------------|--------------|
| same-anchor | medium | medium | medium | low | medium |
| same-subject | **high** | medium | medium | medium | medium |
| same-relation | **high** | low | low | low | low |
| definition-of | low | **high** | low | low | low |
| depends-on | low | low | low | **high** | low |
| contradicts | low | low | **high** | low | low |
| analogous-to | low | low | low | low | **high** |
| revises | medium | low | medium | medium | low |
| temporal-order | varies | low | low | medium | low |

**Key insight**: There is NO single global edge weight. The relevance of an edge DEPENDS on what the user is trying to do (`retrievalIntent`).

### Spreading mechanics (conceptual)
1. Seed nodes get initial activation = 1.0
2. Activation spreads along edges with decay factor × edge_weight(retrievalIntent)
3. After N hops (N ≤ 3 for V1), collect activated nodes
4. Rank by accumulated activation
5. Top-K episodes containing those nodes are retrieved

### Why this solves the benchmarks
- **B1 (relation-slot)**: "最喜欢" relation seeds activate episodes sharing that relation; "lain" subject seeds further boost episodes about lain's preferences → E_素子 surfaces
- **B3 (paraphrase)**: If "最偏爱" and "最喜欢" share a structural edge (e.g., both are preference relations), activation crosses
- **B4 (dependency)**: `propagate_change` intent weights `depends-on` edges HIGH → downstream nodes activated
- **B6 (temporal)**: `temporalIntent` biases edge traversal to prefer/deprioritize older revisions

---

## PART 7 — Role of Lexical / N-gram Retrieval

Lexical retrieval (n-gram / substring matching on raw user evidence text) should be:

1. **Always available as a fallback seed source**
   - Extract n-grams from current utterance → populate `seedSurfaces`
   - Extract n-grams from historical evidence → index as additional anchors
   - This ensures retrieval works even when structural modeling is absent

2. **NOT the primary retrieval architecture**
   - Lexical matching alone fails on paraphrases (B3)
   - Lexical matching alone fails on dependency queries (B4)
   - Lexical matching alone can't distinguish temporal states (B6)
   - Lexical matching alone can't follow analogy edges (B7)

3. **A complement to structural retrieval**
   - Lexical seeds provide initial activation points
   - Structural edges amplify and route that activation to semantically related nodes
   - Together: lexical recall + structural precision

### Immediate action for M2B.4.x
The evidence-text n-gram indexing should be added as a **cheap lexical fallback** — not as the architecture. It's a 20-line deterministic function that makes the current system robust against LLM modeling gaps without changing the retrieval design.

---

## PART 8 — What Existing SemanticSpec Already Supports

The LLM-produced SemanticSpec (as seen in the actual episodes) already contains:

| Structural element | Present in real episodes? | Usable for retrieval? |
|---|---|---|
| Symbol surfaces | YES — "猫猫", "喜欢", "最喜欢" | YES — direct anchor matching |
| Symbol roles | YES — entity, concept, relation, variable, predicate | YES — can distinguish subjects from relations from answer-slots |
| userDefined flag | YES — correctly distinguishes coined vs standard terms | YES — user-defined terms are stronger retrieval seeds |
| Symbol descriptions | YES — rich Chinese descriptions | YES — can extract additional anchors; also hints at semantics |
| Statements (assertion/definition/rule) | YES — kind is modeled | YES — definition-of edges, assertion structure |
| Expression AST (application, symbol_ref) | YES — structured predicate-argument | YES — can extract `favorite(lain, ?)` structure |
| Ambiguities (with questions and choices) | YES | YES — unresolved questions can seed `openSlots` |
| Source provenance (messageId, snapshot) | YES | YES — links structures back to exact evidence |
| Resolutions/patches | Possibly (when user clarifies) | YES — tracks semantic evolution |

**The LLM is already producing rich structured output.** The retrieval architecture just isn't consuming it structurally yet — it's only indexing symbol surfaces as flat string anchors.

---

## PART 9 — What Representation Is Missing

1. **Cross-episode edges**: Episodes are isolated. There are no explicit edges connecting:
   - E0's "喜欢" relation to E1's "最喜欢" relation (they share a surface but no structural link)
   - E0's "lain" entity to E1's "lain" entity (same entity, different episodes)
   - Revision chains, dependency chains, contradiction edges

2. **Query structure**: No `SemanticRetrievalQuery` type exists. The retrieval function takes a flat string.

3. **Activation model**: No weighted graph traversal. Retrieval is flat scoring + recency tiebreak.

4. **Retrieval intent**: The system doesn't know whether the user is asking for a definition, filling a slot, or checking dependencies. All queries are treated identically.

5. **Temporal indexing**: Episodes have timestamps but no temporal relations (this-revises-that, this-is-older-definition-of-X).

6. **Lexical fallback channel**: Evidence text is not indexed as anchors (the n-gram gap identified in the regression).

---

## PART 10 — Smallest Coherent M2B.5 Milestone

### M2B.5 — Semantic Retrieval Seeding

**Goal**: Enable retrieval that can bridge from a query to historical episodes via shared semantic structure, not just shared surface text.

**Scope** (in priority order):

#### 10a. Evidence-text lexical anchors (the cheap fallback)
- Extract CJK n-grams from `evidenceRefs[].snapshot` and add to episode anchors
- ~20 lines of deterministic code in `deriveAnchors()`
- Immediately fixes the regression where entity-only LLM output produces zero retrieval

#### 10b. `SemanticRetrievalQuery` type
- Define the interface (as sketched above)
- Minimal: `seedSurfaces` populated from current utterance text

#### 10c. Structural seed generation from current SemanticSpec
- If `ChatSemanticSession` exists with a current `SemanticSpec`:
  - Walk symbols → populate `subjectRefs`
  - Walk relation symbols → populate `relationRefs`
  - Walk unresolved/variable symbols → populate `openSlots`
- Deterministic, no additional LLM call

#### 10d. Cross-episode symbol alignment
- Build an in-memory index mapping symbol surfaces → episodes
- When query names "最喜欢", find ALL episodes that have a "最喜欢" symbol
- When query names "lain", find ALL episodes that have a "lain" symbol
- Intersection: episodes containing BOTH "lain" AND "最喜欢" are strong candidates
- This solves B1 (relation-slot) without a full graph

#### 10e. Retrieval that uses the query structure
- Replace/adjoin the current flat string retrieval with:
  - Score episodes by: `|subjectRefs ∩ episode.symbols| + |relationRefs ∩ episode.symbols|`
  - Weight userDefined symbols higher
  - Lexical seedSurface matching as fallback
- Deterministic, no LLM call

#### Explicitly deferred to M2B.6+:
- Cross-episode edge construction
- Weighted activation model
- Retrieval-intent-dependent edge weights
- Temporal indexing
- Paraphrase / analogy edges (requires semantic embedding or explicit LLM linking)

### Why this ordering

M2B.5 makes the retrieval STRUCTURE-AWARE without requiring a full graph. It uses the SemanticSpec structures the LLM already produces (symbols, roles, userDefined flags) to do INTERSECTION-BASED retrieval: find episodes that share structural elements with the query.

This directly solves the benchmark B1 (relation-slot):
- Query: `favorite(lain, ?)`
- Seed generation: subjectRefs=[{surface:"lain"}], relationRefs=[{surface:"最喜欢"}]
- Symbol intersection: find episodes containing BOTH "lain" AND "最喜欢"
- → Episode 0 (猫猫) has "lain" + "喜欢" (close but not exact)
- → Episode for 素子姐姐 (if it existed) would have "lain" + "最喜欢" + "素子姐姐"
- The intersection scoring naturally prefers the more structurally relevant episode

Combined with 10a (lexical fallback), the system becomes robust against LLM modeling gaps while also gaining structural precision when the LLM DOES produce good output.
