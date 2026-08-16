# Lain Brain

**Lain Brain is an experimental personal semantic Brain for Obsidian.**

Instead of treating notes as isolated documents, Lain Brain treats them as persistent **concept nodes**: structured semantic objects that can preserve your own definitions, evidence, relationships, ambiguity, revision history, and the difference between what **you mean**, what **AI infers**, and what an **external source says**.

The long-term idea is simple:

> You should maintain your **meaning**, not manually maintain your **database**.

Lain Brain is currently a public alpha and an active research prototype.

---

## Why Lain Brain?

Natural language is lossy.

Two people may use the same word while referring to different internal concepts. A conventional AI system can also silently substitute a public or statistically likely meaning for what a particular person actually means.

Lain Brain starts from a different assumption:

```text
word ≠ concept
```

A title is only a handle.

The actual concept may include:

* your personal definition;
* exact statements you previously made;
* examples and counterexamples;
* relations to other concepts;
* unresolved ambiguity;
* historical revisions;
* AI-generated interpretations;
* external or conventional definitions.

Lain Brain calls this persistent structured unit a **ConceptNode**.

Conceptually, it behaves like a semantic **ZIP**: one conceptual object from the outside, while retaining rich internal structure.

---

## Current architecture

The current system forms a reviewed semantic-maintenance loop:

```text
Conversation
    ↓
possible principal semantic change
    ↓
user review / confirmation
    ↓
SemanticDelta
    ↓
ConceptNode revision
    ↓
bounded background propagation
    ↓
structural diagnostics
    ↓
only unresolved personal decisions return to the user
```

The central authority rule is:

> **The Brain may notice, propose, propagate safe derived consequences, and diagnose.
> Only the user may authorize changes to their personal meaning.**

---

## Personal Semantic IR (v0)

Lain Brain now includes a first target-independent semantic layer that sits
between natural language and Lean:

```text
natural-language mathematics
    ↓
Personal Brain concept resolution
    ↓
PersonalSemanticIR
    ↓
FormalizationProtocol
    ↓
Lean 4
```

The IR separates *what the user means* from *how it was written*. It preserves
stable concept bindings, personal versus standard definitions, assumptions,
claims, proof-step structure, ambiguity, and provenance without storing Lean
syntax and without mutating the Brain. See
[`PERSONAL_SEMANTIC_IR.md`](./PERSONAL_SEMANTIC_IR.md) for the design and
current limitations. This is the first implementation of the long-term
semantic-interface architecture, not a claim that arbitrary language
translation is solved.

The Chat toolbar also provides **“Formalize using Brain concepts”**, a
review-first workflow for a selected mathematical message: Lain Brain resolves
relevant concepts, DeepSeek proposes a semantic interpretation, the user
reviews meaning (Accept / Edit / Reject), and only an accepted interpretation
is projected into the existing FormalizationProtocol and Lean backend. The
workflow reads the Brain but never mutates it.

Accepted interpretations are persisted as durable **semantic lineage**: the
IR, its exact ConceptNode revisions, review decision, evaluation summary, and
FormalizationRecord linkage survive plugin reload, and remain stable when the
Brain later evolves. All of this is local plugin data only.

Lean statement typecheck and proof verification status are mirrored into this
same local memory through the existing `FormalizationProtocol` authority, so
semantic acceptance, statement typechecking, and proof verification remain
distinct historical facts.

The first genuine Lean proof-verification path now exists: a candidate proof
body is wrapped in a trusted theorem declaration against the exact reviewed
proposition and checked by the existing `LeanRunner`. Only kernel/elaboration
success sets `proof_verified`; `sorry`, `admit`, statement substitution, and
fresh top-level declarations are rejected.

---

## Core features

### Personal ConceptNodes

Notes can become durable semantic concept nodes with:

* stable concept IDs independent of filenames and titles;
* aliases;
* exact personal definitions;
* preserved user evidence and provenance;
* AI-generated interpretations stored separately from user meaning;
* external/standard definitions stored separately;
* explicit semantic relationships;
* unresolved questions and ambiguity;
* immutable semantic revision history.

Renaming a concept does not change its identity.

Two concepts with the same title are not silently merged.

---

### Reviewed Brain Growth

Lain Brain can grow a ConceptNode from reviewed conversation material.

The lifecycle is:

```text
User language
→ CandidateNote
→ review
→ explicit approval
→ ConceptNode
→ durable Markdown
→ reload
```

Previewing, regenerating, or cancelling does not create persistent semantic state.

AI-generated Markdown is never automatically promoted to the user's personal definition.

---

### Concept Maintenance Workspace

Use:

**Lain Brain: Open Concept Maintenance**

to inspect and maintain an existing ConceptNode.

The workspace separates:

* **Personal meaning** — authoritative;
* **Preserved user evidence**;
* **AI interpretation** — non-authoritative;
* **External / standard meaning** — non-authoritative;
* relationships;
* ambiguity;
* diagnostics;
* revision history.

Edits are prepared in memory first.

Before a durable change, Lain Brain shows a semantic review and requires explicit confirmation.

Opening, editing, previewing, cancelling, or encountering a stale revision produces no semantic write.

---

### Chat-First Semantic Delta

Normal conversation is the primary interface.

When enabled, Lain Brain can perform a small supplemental analysis after an eligible text reply and ask:

> **“I think the main thing that changed is this. Is that right?”**

The system currently recognizes reviewed semantic changes including:

* personal-definition changes;
* confirmed relationships;
* removed relationships;
* explicit concept distinctions;
* ambiguity resolution.

Examples:

```text
“When I say A, I mean X.”
```

```text
“A depends on B.”
```

```text
“A and B are not the same concept.”
```

```text
“When I said A earlier, I meant this specific concept.”
```

The proposal itself has **zero authority**.

The user can:

* **Confirm**
* **Edit**
* **Not a change**

Only explicit confirmation creates an authoritative `SemanticDelta`.

At most one principal semantic change is proposed for an interaction.

Most conversations should produce no semantic proposal at all.

---

### Structural Semantic Relationships

Current reviewed relationship types include:

```text
depends_on
example_of
derived_from
analogous_to
related_to
part_of
explicitly_distinct_from
```

Relationship semantics remain narrow.

For example:

```text
A analogous_to B
```

does **not** imply:

```text
A = B
```

and:

```text
A explicitly_distinct_from B
```

does not mean the two concepts cannot still be analogous or otherwise related.

Stable concept IDs are used whenever possible.

Ambiguous identities are surfaced instead of guessed.

---

### Semantic Delta Propagation

The user should not have to manually review every brain cell affected by one conceptual change.

After an explicitly confirmed `SemanticDelta`, Lain Brain can perform bounded background maintenance over explicit dependency structure.

The design principle is:

> **The user reviews causes and semantic decisions.
> The Brain propagates safe consequences.**

Automatic propagation is deliberately narrow.

It may perform deterministic or non-authoritative maintenance such as:

* refreshing cached relationship labels;
* marking explicitly dependent AI-generated interpretations stale;
* refreshing dependency revision metadata;
* recording propagation provenance;
* creating pending semantic decisions.

It may **not** automatically:

* rewrite another concept's personal definition;
* resolve another concept's ambiguity;
* merge concepts;
* delete user evidence;
* promote AI output into user meaning;
* invent downstream personal beliefs.

Unsafe or genuinely personal consequences become pending decisions instead.

---

### Bounded and restart-safe propagation

Propagation uses an explicit bounded queue.

Current default limits include:

* maximum propagation depth: **2**;
* maximum affected concepts per job: **50**;
* maximum Vault writes per job: **25**.

The engine includes:

* cycle detection;
* stable-ID visited tracking;
* replay deduplication;
* stale-revision protection;
* bounded breadth-first traversal;
* restart recovery;
* propagation history;
* failure recording.

Processing the same confirmed delta again does not create duplicate semantic revisions.

---

### Structural Conflict Diagnostics

A growing semantic Brain will eventually contain tension.

Lain Brain now includes deterministic, read-only structural conflict diagnostics.

Examples include:

* an explicit distinction conflicting with an equivalence-like structure;
* a confirmed relationship removal whose relationship incorrectly remains active;
* duplicate symmetric distinction state.

Conflict detection:

* does not call an LLM;
* does not rewrite concepts;
* does not delete relationships;
* does not merge concepts;
* does not automatically decide which meaning is correct.

Importantly:

```text
analogous_to + explicitly_distinct_from
```

is **not** treated as a hard conflict.

A Brain may know that two things resemble one another while also knowing they are different.

Only conflicts that genuinely require personal semantic judgment become pending semantic decisions.

---

### Semantic history and provenance

Lain Brain preserves why semantic changes occurred.

A revision can be traced conceptually as:

```text
Concept revision
    ↑
propagated change
    ↑
SemanticDelta
    ↑
explicit user confirmation
    ↑
conversation evidence
```

History is immutable.

Restoring an older semantic state creates a new revision rather than deleting later history.

The system is designed to answer:

> **“Why did my Brain change this?”**

---

### Ambiguity is allowed

Lain Brain deliberately prefers:

```text
“I don't know which concept you mean yet.”
```

over:

```text
“I will silently choose the statistically most likely meaning.”
```

A concept may remain ambiguous.

A relationship target may remain unresolved.

Several same-label concepts may coexist.

Uncertainty is represented instead of hidden.

---

## Existing note and chat tools

Lain Brain also retains its earlier reviewed knowledge-work features:

* contextual multi-turn DeepSeek chat;
* CandidateNote generation and review;
* grouped parent/child candidate notes;
* Markdown and LaTeX rendering;
* local selection-level edits;
* reviewed note creation;
* reviewed rename and broken-link cleanup;
* optional explicitly configured image-analysis providers;
* configurable user and assistant display names.

The terminal-style interface is only a chat UI.

Lain Brain does **not** execute terminal commands.

---

## Privacy and data handling

Lain Brain is designed around explicit semantic authority and bounded external requests.

### Normal text chat

Text chat is sent to the configured **DeepSeek** provider.

Active-note content may be included when the user intentionally uses it as conversational context.

### Chat Semantic Delta detection

When **Detect semantic changes in chat** is enabled, Lain Brain may send one additional supplemental DeepSeek request after an eligible successful text reply.

This request contains at most **three recent eligible text-only turns** required to detect a possible principal semantic change.

It excludes:

* API keys;
* images;
* attachments;
* PDF contents;
* whole-Vault contents;
* active-note contents;
* unrelated local metadata.

Image/PDF turns do not trigger this semantic-analysis request.

The feature can be disabled in Lain Brain settings.

A semantic-analysis failure does not prevent normal Chat from working.

### Images

Images are sent only through an explicitly configured and selected image provider according to the image workflow.

Image data is not automatically written into Brain semantic state.

### Local Brain state

Concept nodes, revisions, relationships, propagation state, and structural diagnostics are stored through the local Obsidian/Vault architecture.

Lain Brain does not introduce a separate cloud Brain service in the current version.

Review the privacy policies of DeepSeek and any optional provider you configure. Provider requests leave your device and are governed by that provider's policies.

---

## Semantic safety model

The current implementation intentionally distinguishes levels of authority.

### User-authoritative

* explicitly confirmed personal definitions;
* explicitly confirmed structural relationships;
* explicit distinctions;
* explicit ambiguity resolutions;
* explicit edits made during semantic review.

### AI-derived

* interpretations;
* summaries;
* proposed semantic changes;
* possible relationships;
* stale/regenerated derived material.

### External

* dictionary definitions;
* textbook definitions;
* other conventional knowledge.

AI-derived or external information cannot silently replace personal semantic state.

---

## Vault safety

Durable writes are guarded by reviewed boundaries.

For semantic maintenance, the system verifies appropriate combinations of:

* stable concept identity;
* expected revision;
* exact previously reviewed Markdown;
* valid next revision;
* explicit user confirmation.

Stale confirmations do not overwrite newer state.

For multi-step confirmed structural operations, rollback may move only notes **created by that same failed operation** to Obsidian Trash.

Pre-existing user notes are not deleted as rollback.

---

## Requirements

* Obsidian 1.0.0 or later
* Node.js 18 or later and npm when building from source
* A DeepSeek API key for text chat and optional Chat Semantic Delta analysis
* An API key for an optional configured image provider only when image analysis is used

---

## Manual installation

Lain Brain is not currently distributed through the Obsidian Community Plugins catalog.

1. Obtain `main.js` and `manifest.json` from a trusted release, or build them from source.
2. Create:

```text
<your-vault>/.obsidian/plugins/lain-brain/
```

3. Copy `main.js` and `manifest.json` into the directory.
4. Restart or reload Obsidian.
5. Open **Settings → Community plugins** and enable **Lain Brain**.
6. Open **Settings → Lain Brain** to configure providers and behavior.

---

## Build from source

```bash
cd lain-brain
npm ci
npm test
npm run build
```

The production build writes `main.js` to the project root.

Development mode:

```bash
npm run dev
```

---

## Current limitations

Lain Brain is an experimental alpha.

Current limitations include:

* it does not train or fine-tune model weights from the user's Brain;
* semantic change detection currently uses a bounded DeepSeek request rather than a local model;
* Chat Semantic Delta supports a deliberately narrow set of explicitly reviewable change types;
* semantic propagation follows explicit structure rather than fuzzy semantic similarity;
* embeddings and vector search are not part of the current semantic propagation architecture;
* automatic downstream personal-belief inference is intentionally prohibited;
* unresolved structural conflicts still require human judgment;
* the Vault concept index currently favors conservative deterministic behavior over a large autonomous indexing system;
* ordinary Markdown is not silently migrated into ConceptNodes;
* some maintenance and recovery workflows remain alpha-quality;
* Lain Brain is not yet a multi-user or Brain-to-Brain system.

Back up your Vault before using alpha software.

---

## Long-term vision — Ghost in the Brain

The current plugin is only the first layer.

The long-term target is a **Personal Brain / Personal Universe** in which each person can preserve their own:

* concept ZIPs;
* definitions;
* distinctions;
* semantic relationships;
* changes in understanding;
* ways of organizing meaning.

Eventually, different Personal Brains could communicate directly.

Instead of translating only:

```text
language A → language B
```

the goal is to explore:

```text
Personal Universe A
        ↓
semantic alignment / translation
        ↓
Personal Universe B
```

A Brain could know what **A actually means by a concept**, compare that structure with how **B understands related concepts**, and help translate between their semantic worlds.

The goal is not to make everyone think the same way.

It is the opposite:

> **Preserve different cognitive worlds while making them easier to understand across the boundary between people.**

This long-term research direction is called:

# Ghost in the Brain

Brain-to-Brain communication, cloud deployment, Personal Universe publishing, and cross-person semantic translation are **research goals, not current implemented features**.

---

## Research direction

Lain Brain currently sits at the intersection of:

* Human–Computer Interaction;
* Personalized AI;
* Human–AI Interaction;
* semantic representation;
* AI memory;
* personal knowledge systems;
* knowledge representation;
* mediated human communication.

A recurring research question is:

> **How can an AI preserve, maintain, and translate a person's meaning without silently replacing it with the AI's own interpretation?**

---

## Development checks

Before preparing a release:

```bash
npm test
npm run build
```

Public releases should include the required manual-installation artifacts:

* `main.js`
* `manifest.json`

Do not track:

* API credentials;
* local provider settings;
* Vault configuration;
* test Vaults;
* unnecessary build/debug artifacts.

---

## License

Lain Brain is available under the [MIT License](LICENSE).
