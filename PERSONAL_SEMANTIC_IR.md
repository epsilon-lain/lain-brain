# Personal Semantic IR v0

## 1. Motivation

Lain Brain already separates personal meaning from public meaning inside
`ConceptNode`s, and already formalizes reviewed mathematical statements into
Lean 4 through `FormalizationProtocol`. Those two systems describe the same
underlying idea from different directions:

- the Brain knows **what a concept means to this user**;
- the formalization layer knows **how a statement projects into Lean**.

What is missing is the object that lives *between* them: an explicit,
target-independent semantic representation of a single interpreted
mathematical expression or proof fragment. This milestone adds that object.

The pipeline being introduced is:

```text
Human natural language
    ↓
Personal Brain (ConceptNode resolution)
    ↓
PersonalSemanticIR
    ↓
FormalizationProtocol adapter
    ↓
Lean 4
```

The point is **not** automatic theorem proving. The point is preserving what
the user actually meant while the same semantic object moves between surface
representations.

## 2. Word vs concept

A word or phrase is only a handle. Two people can use the same phrase for
different concepts, and one person can rename a concept without changing what
it refers to. `PersonalSemanticIR` therefore binds surface phrases to stable
`ConceptNode` IDs, never to title strings alone.

The invariant is:

```text
surface language ≠ semantic object
```

so changing the surface language must not silently change the meaning.

## 3. Personal Brain as semantic IR

The Brain already behaves like a personal semantic index: stable concept IDs,
aliases, relationships, ambiguity, provenance, and revision history. The new
IR does not duplicate that index. It *references* it through bindings and
keeps only the resolved or unresolved status needed for a single utterance.

## 4. ConceptNode bindings

A `ConceptBinding` records:

- surface phrase and optional source span;
- resolution method (`stable_id`, `exact_title`, `normalized_title`, `alias`,
  or `model_proposed`);
- status (`resolved`, `ambiguous`, `unresolved`, or `proposed_new`);
- the stable `ConceptNode` ID and revision when resolved;
- alternatives when ambiguous;
- a proposed title when no concept exists;
- the authoritative personal definition and the standard definition,
  kept separate, with an explicit `definitionConflict` flag.

Ambiguity is never resolved silently. A missing concept is represented as
unresolved or as a proposed new concept, never as a guessed string identity.

## 5. Frontend / backend architecture

The IR is target-independent. The code exposes minimal adapter interfaces:

```text
SemanticFrontend<Input> → PersonalSemanticIR
SemanticBackend<Output>  ← PersonalSemanticIR
```

The v0 implementation contains:

- a natural-language math frontend boundary (source + DeepSeek rules);
- a canonical human-readable text backend (`renderPersonalSemanticIR`);
- a `FormalizationProtocol` / Lean projection (`FormalizationAdapter`).

The IR stores no Lean syntax. Python, Rust, C, English↔Japanese, and
Brain-to-Brain adapters are explicitly out of scope for this milestone.

## 6. Natural-language math frontend

The frontend boundary is represented by the structured
`PersonalSemanticIR` fields and by `BRAIN_AWARE_INTERPRETATION_RULES`, which
constrain DeepSeek to act as a translator, not an authority. DeepSeek may
propose an interpretation; it must never mark that interpretation as
user-authoritative, invent silent assumptions, or claim Lean verification.

## 7. FormalizationProtocol adapter

`adaptPersonalSemanticIRToFormalization` deterministically projects an IR into
the existing `CreateFormalizationParams`. It reuses:

- `MathSpeechActKind`;
- `MathObject`;
- `FormalizationAssumption`;
- `SourceRef`;
- `SemanticChange`;
- review and verification status invariants.

It also guarantees the existing invariant that every implicit assumption is
referenced by an `added_assumption` semantic change. Brain bindings and
originating concept revisions are preserved alongside the projected record.

## 8. Lean backend

The existing `LeanRunner` / `LeanArtifact` infrastructure is unchanged. The
new layer distinguishes:

- semantic translation succeeded;
- Lean statement typechecked;
- Lean proof verified.

Only the Lean kernel may produce `proof_verified`. The IR layer never emits
that status and never stores Lean syntax.

## 9. Semantic authority

Meaning can come from four places, and the IR keeps them separate:

- `user_authoritative` — the user actually asserted it;
- `ai_interpreted` — the model proposed it;
- `external_standard` — a public definition;
- `unresolved` — not yet determined.

A generated IR is `ai_interpreted` by default, even when all concept bindings
are already resolved in the Brain.

## 10. Review boundary

An interpretation that materially changes meaning requires review. The IR
records the signals that should trigger review:

- added assumptions;
- changed quantifiers;
- narrowed domains;
- strengthened or weakened claims;
- ambiguous concept selection;
- newly introduced objects;
- reinterpretation of a user-defined concept.

`computeSemanticDiff` turns these into human-readable entries so the user can
answer one question: *is this still what I meant?*

## 11. Meaning-preservation invariants

The tests cover the traps that matter for this milestone:

- “Every A” is not converted to “Some A”;
- “A implies B” is not converted to “A iff B”;
- “A is contained in B” is not converted to “A = B”;
- “A is analogous to B” is not converted to “A and B are the same”;
- a personal definition of A displaces a public definition only when the
  Brain actually contains it, and any conflict is surfaced explicitly.

## 12. Privacy

Only resolved concept context referenced by the current IR may leave the
device. `buildBrainAwareFormalizationContext` deliberately excludes API keys,
unrelated notes, arbitrary Vault content, attachments, and unrelated plugin
metadata. The whole Brain is never sent.

## 13. Current limitations

- This is a semantic-representation milestone, not an automatic prover.
- There is no live DeepSeek/UI wiring yet; the DeepSeek boundary rules and
  bounded context builder are ready to be wired into the existing chat flow.
- Semantic-diff categories that require natural-language understanding
  (for example, detecting a subtle quantifier shift) are represented
  explicitly rather than inferred from free text.
- The renderer is a debugging aid, not a claim of lossless translation.

## 14. Future language adapters

The interfaces are intentionally narrow so future frontends and backends can
be added without hardcoding the IR to Lean syntax:

- more natural languages;
- programming-language proof assistants;
- diagrammatic or symbolic frontends;
- Brain-to-Brain exchange (explicitly not implemented here).

---

## Live workflow (v1)

The Chat UI now exposes one explicit reviewed action:

**“Formalize using Brain concepts”**

The flow is review-first:

```text
selected user mathematics
    ↓
bounded local ConceptNode discovery
    ↓
DeepSeek proposes PersonalSemanticIR
    ↓
deterministic validation
    ↓
semantic review UI
    ↓
Accept / Edit / Reject
    ↓
FormalizationProtocol
    ↓
Lean statement / verification
```

The review surface shows the original expression, concept bindings, objects,
claims, explicit versus AI-added assumptions, proof steps, semantic diff, and
canonical interpretation. Ambiguous bindings must be resolved explicitly
before acceptance. Acceptance is the only path into `FormalizationProtocol`.

The workflow is a **read-only** operation on the Brain: it never changes
personal definitions, creates `SemanticDelta`s, adds relationships, resolves
ambiguity, or mutates `StructuralConflict` records.

The live DeepSeek request includes only bounded concept context for concepts
locally discovered in the selected source. It never sends API keys, the whole
Brain, unrelated notes, attachments, images, PDFs, or unrelated chat history.

Lean status remains three separate states:

- semantic interpretation: proposed / accepted / rejected;
- formalization statement: pending / typechecked / error;
- proof: unverified / verified (only the Lean kernel may produce the latter).

This is not automatic theorem proving. It is the first live path for
preserving the user's meaning across the natural-language-to-Lean boundary.

---

## Durable semantic lineage

An accepted formalization is now persisted as `BrainFormalizationMemory`,
versioned alongside the other plugin data. The persisted record preserves:

- stable memory, IR, FormalizationRecord, and claim IDs;
- the exact source message ID and source snapshot required by provenance;
- ConceptNode IDs and exact revisions used at acceptance;
- resolved/unresolved binding snapshots and resolution methods;
- review decision (`accepted` or `edited_then_accepted`);
- reviewed semantic-diff categories;
- the full versioned `PersonalSemanticIR`;
- a minimal local evaluation summary;
- Lean statement/proof status.

This is **history**, not current Brain state. If a concept later changes,
the old formalization continues to reference the revision it used. The
current Brain and the historical interpretation are never silently merged.

The read API supports:

- lookup by FormalizationRecord ID;
- lookup by PersonalSemanticIR ID;
- listing the concept bindings used by a formalization;
- reverse lookup: which accepted formalizations referenced a concept;
- current-versus-historical concept comparison;
- semantic staleness (`current`, `changed`, `partially_missing`,
  `unavailable`).

Acceptance is replay-safe: stable IDs prevent duplicate memory, linkage, and
FormalizationRecords. Lean status can evolve later without rewriting the IR.

Persistence is local plugin data only. No new network request, no telemetry,
no Cloud, and no GitHub sync are involved. Persisted data omits API keys,
DeepSeek request/response bodies, unrelated Vault notes, unrelated chat
history, attachments, images, and PDFs.

---

## Durable verification lineage

The three kinds of truth stay distinct and are mirrored separately:

- **Semantic interpretation accepted** — user review authority;
- **Lean statement typechecked** — Lean elaboration/typechecking authority;
- **Lean proof verified** — formal kernel authority.

`synchronizeBrainFormalizationStatus` consumes the already-authoritative
`FormalizationProtocol` verification status and mirrors it into the linked
`BrainFormalizationMemory` without interpreting Lean output itself. The
memory layer is a historical mirror, never a verifier.

The existing Lean statement check path updates the durable memory after the
authoritative `FormalizationRecord` status changes. Replay-safe status
updates avoid duplicate records or timestamp churn.

Transient Lean errors do not erase a previously recorded `proof_verified`
result. Editing reviewed code is an explicit reset and mirrors the
authoritative reset to `not_checked`.

Semantic staleness can coexist with verification: a formalization may remain
`proof_verified` under its historical concept revision even while the current
Brain meaning has changed. Neither state is silently rewritten into the
other.

---

## Real Lean proof verification

`proof_verified` is now produced only by a dedicated proof-verification path,
not by statement checking, model output, or semantic acceptance.

The path constructs a trusted theorem wrapper itself:

```lean
<existing imports>
set_option autoImplicit false

theorem lain_target_<hash> : <exact reviewed proposition> := by
  <candidate proof body>
```

The proof body may not inject its own `theorem`, `axiom`, `def`, `lemma`,
`import`, or other top-level declarations. `sorry`, `admit`, and `sorryAx`
are rejected before execution. The exact proposition is derived from the
already-generated `#check` statement, so a candidate cannot silently prove a
different, easier statement.

`verifyLeanProofWithRunner` reuses the existing `LeanRunner`; successful
elaboration of the wrapper is the only event that triggers
`FormalizationRecord.verificationStatus = "proof_verified"`, followed by the
existing durable-memory synchronization.

Statement typechecking and proof verification remain separate. A statement
that merely typechecks is `statement_typechecked`, never `proof_verified`.

The claim is deliberately precise:

> Lean accepted this proof under the configured Lean environment.

It is not a claim of axiom-free constructivity or automatic theorem proving.

---

## Proof workspace and durable verification evidence

The exact Lean proposition is now a first-class `LeanFormalizationTarget`
rather than a string recovered from generated `#check` presentation source.
New formalizations store the canonical proposition, its imports, and its
hash directly.

The proof workspace separates two surfaces:

- **Exact Lean target** — read-only;
- **Lean proof body** — editable.

This mirrors the trusted-wrapper architecture: the proof body can fill only
the proof position inside the fixed theorem declaration.

Proof drafts are local, reloadable working state. A draft records its target
hash, proof hash, provenance (`user_authored`, `ai_generated`,
`user_edited`, or `imported`), and edit state. Drafts are never treated as
formally correct.

Successful or failed verification produces an immutable
`LeanProofVerificationArtifact` containing the exact target hash, proof hash,
theorem wrapper name, provenance, import environment, result, diagnostics,
and timestamps. A verified artifact certifies exactly one
`(target hash, proof hash)` pair. Editing the proof or changing the target
does not rewrite the old artifact; it creates an unverified or stale current
candidate instead.

Semantic staleness and proof verification remain independent: an old proof
can remain `proof_verified` while the current Brain concept revision reports
`changed`.

All of this is local plugin data. Proof bodies, drafts, and verification
artifacts are never uploaded and never sent to DeepSeek as part of this
milestone.

---

## Parser-free canonical Lean proposition

For newly generated Lean formalizations, DeepSeek now returns a structured
`proposition` field containing the canonical Lean proposition directly. The
application constructs the executable `#check` source and the proof wrapper
from that same proposition:

```text
reviewed meaning
    ↓
canonical Lean proposition
    ↓
┌──────────────────────────────┐
│                              │
↓                              ↓
statement-check source        proof-verification source
```

The `#check` form is a deterministic execution projection, not the source of
truth. Proposition boundary validation rejects wrappers such as `#check`,
`theorem`/`lemma` declarations, Markdown fences, imports, placeholders, and
top-level declaration injection before a canonical target is created.

`LeanFormalizationTarget.provenance` distinguishes `structured_generation`
from `migrated_legacy`. The legacy `extractLeanPropositionFromCheckSource`
remains compatibility-only and is never used by the new formalization path.

Statement checking and proof verification share one canonical target, one
proposition hash, and one invalidation boundary.
