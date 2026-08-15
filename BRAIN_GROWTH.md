# Brain Growth and Maintenance v1

Confirmed semantic changes and bounded derived maintenance are documented in
[`SEMANTIC_DELTA.md`](SEMANTIC_DELTA.md).

Brain Growth v1 connects the pure concept-node domain to the existing reviewed
Candidate Note workflow. It deliberately does not add a database, an AI
auto-edit path, or a second Vault-write boundary.

## Architectural placement

- `KnowledgeProtocol.ts` remains the authority boundary for exact user-authored
  language. `ConceptUserDefinition` reuses `UserTextProvenance` and is validated
  through `createUserConclusion()`.
- `CandidateNote` remains the reviewed in-memory Markdown draft used by the
  existing organizer and Create Note/Create Group flows.
- `BrainGrowth.ts` models the immutable semantic aggregate.
- `BrainGrowthCandidateAdapter.ts` converts only an explicitly confirmed
  candidate snapshot into a `ConceptNode`; it has no Obsidian dependency and
  performs no write.
- `BrainGrowthPersistence.ts` owns the versioned Markdown projection and
  deterministic single-note loader.
- `BrainGrowthIndex.ts` provides deterministic ID/title/alias lookup with
  explicit not-found, unique, and ambiguous results.
- `ObsidianConceptIndex.ts` is a one-shot read-only adapter that discovers valid
  concept notes after restart. It ignores ordinary Markdown and installs no
  listener or background index.
- `BrainMaintenance.ts` applies explicitly approved immutable updates and
  history restores, then prepares new Markdown without writing it.
- `BrainMaintenanceWorkspace.ts` owns draft provenance, field-level semantic
  diffs, reviewed relationship replacement, and restore preparation without an
  Obsidian dependency.
- `BrainMaintenanceWorkspaceModal.ts` provides the first user-facing lookup,
  inspection, edit, review, and confirmation flow using Obsidian `Modal` and
  `Setting` controls.
- `ObsidianConceptMaintenance.ts` owns the single reviewed modification
  boundary. It validates the exact original Markdown, stable ID, and expected
  revision immediately before one `vault.modify()` call.
- `BrainDiagnostics.ts` reports structural problems without repairing them.
- `LainBrainSession.createCandidateNote()` and `createCandidateGroup()` remain
  the only concept-creation boundaries; confirmed maintenance uses the separate
  single-existing-note modification boundary above.

## Reviewed lifecycle

```text
User language
  -> CandidateNote
  -> user review/edit
  -> confirmed Create Note or Create Group
  -> ConceptNode adapter
  -> Markdown projection written by the existing Vault boundary
  -> deterministic single-note reload
  -> read-only index and lookup
  -> reviewed maintenance update
  -> new immutable revision
  -> semantic field-level diff
  -> explicit Confirm Update
  -> one checked Vault modification
  -> deterministic reload
```

Preview, regeneration, adapter invocation, and serialization are pure/in-memory
operations. Cancelling the existing confirmation modal performs no conversion
or Vault write. A conversion failure happens before `vault.create()` and cannot
leave a partially persisted concept.

Candidates retain exact source-message snapshots alongside their source IDs so
the approval boundary can still preserve provenance after `Clear Chat`. Legacy
candidates without snapshots continue to load; missing evidence leaves the
concept ambiguous rather than fabricating text.

## Concept identity and meaning

`ConceptNode.id` is stable identity. The title and aliases are labels only and
must never be used to assert that two concepts have the same meaning.

The user's current definition is stored separately from standard or external
definitions. If a different user definition arrives through a normal update,
the existing definition is preserved and the incoming definition becomes an
unresolved alternative. Only an explicit user redefinition or explicit meaning
resolution promotes a replacement.

The integration keeps three layers structurally distinct:

1. `userEvidence` and `userDefinition` contain exact `KnowledgeProtocol`
   user provenance. Evidence does not automatically become a definition.
2. `generatedInterpretations` contains the reviewed candidate Markdown. Even
   after review, generated/reorganized wording is not relabeled as exact user
   authorship.
3. `standardDefinitions` contains explicit external or conventional meaning.

When the confirmed candidate has no separately approved exact user definition,
the resulting node retains the source evidence but remains `ambiguous`. This is
preferred to inferring a definition from candidate prose.

Concepts without a user definition, with competing definition alternatives, or
with an open meaning ambiguity report `meaningStatus = "ambiguous"`. This is a
representation of missing semantic resolution, not a confidence score.

## Growth operations

The public pure functions support:

- concept creation and additive updates;
- separate user and external definitions;
- examples and counterexamples;
- explicit relationship creation, modification, and removal;
- duplicate-edge prevention using relation type plus target concept ID;
- detection of relationship targets absent from a caller-provided known-ID set;
- open/resolved questions and meaning ambiguity;
- exact revision inspection and restoration.

Every meaningful mutation returns a new deeply frozen node, increments its
revision, and appends the previous complete semantic snapshot to `history`.
No-op and duplicate additions return the existing node and do not create fake
history.

## Markdown persistence and reload

The existing reviewed candidate body remains readable. Persistence adds concise
frontmatter:

```yaml
---
lain-brain-type: concept-node
lain-brain-concept-id: "..."
lain-brain-concept-revision: 1
lain-brain-concept-status: defined
lain-brain-concept-aliases: ["alias"]
lain-brain-concept-relationships: 0
lain-brain-concept-unresolved: 0
lain-brain-candidate-id: "candidate-id"
---
```

It also adds one versioned, percent-encoded machine projection in an HTML
comment. The projection is an explicit schema rather than an implicit dump: it
retains stable ID, revision/history, aliases, exact provenance, the three
semantic layers, relationships, and unresolved items. The comment avoids
disturbing the human-readable candidate body.

`deserializeConceptNodeFromMarkdown()` reads exactly one note, validates the
supported schema and provenance through the domain constructors, deeply freezes
the result, and reconstructs both the `ConceptNode` and candidate origin. It
does not scan the Vault or write anything.

`inspectConceptMarkdown()` is the non-throwing compatibility boundary. It
returns `ordinary_markdown`, a validated `concept_node`, or a typed invalid
result. Notes with future persistence versions are rejected as
`unsupported_schema_version`; they are never silently interpreted using the
current schema.

## Identity, relationships, and duplicate safety

Concept identity is `ConceptNode.id`, initially derived from the stable
candidate ID at the confirmation boundary. Titles, filenames, and aliases are
handles only; renaming a note does not change the persisted ID.

Relationships become `ConceptRelationship` edges only when the adapter receives
an explicit stable target concept ID. A relationship-section wikilink without
such an ID becomes an unresolved item instead of a fabricated node identity.

`assessCandidateConceptConflict()` distinguishes an exact ID match from a title
collision. Equal normalized titles with different IDs are reported as
`same_title_distinct_identity`; no automatic merge occurs.

## Lookup and restart discovery

`createConceptIndex()` indexes already loaded nodes without changing them.
Lookup is available by stable ID, exact title, normalized title, and alias.
Every lookup returns one of:

- `not_found`;
- `unique_match`;
- `ambiguous_matches`.

No title or alias lookup selects an arbitrary winner. Duplicate stable IDs are
also ambiguous rather than silently collapsed.

`loadObsidianConceptIndex()` reads Markdown files in deterministic vault-path
order, validates concept metadata, and returns records plus structured load
issues. Ordinary Markdown remains ordinary Markdown. The adapter calls only
`getMarkdownFiles()` and `cachedRead()` and performs no migration or write.

## Reviewed maintenance

`applyReviewedConceptUpdate()` requires:

- an explicit `confirmed_concept_update` approval marker;
- an exact stable concept ID;
- the revision that was reviewed.

Missing, duplicate-ID, or stale targets return typed failures. Valid updates
reuse `updateConceptNode()`: external/generated material remains separate,
conflicting user meaning is preserved as an alternative, and authoritative
replacement requires `explicit_user_redefinition`. No-op updates return
`no_change` and create no fake revision.

`preparePersistedConceptUpdate()` and `preparePersistedConceptRestore()` load,
validate, update/restore, and serialize entirely in memory. Failure returns the
original Markdown unchanged. They intentionally do not call a Vault API; a
future reviewed UI must pass the prepared text through an explicit approved
write boundary.

History stores complete previous semantic snapshots. Restoring a prior state
creates a new revision rather than deleting later history. The current v1
projection favors correctness and deterministic recovery over compact storage;
long-lived concepts may therefore grow their hidden metadata substantially.

## Concept Maintenance workspace

The command palette action **Open Concept Maintenance** performs a one-shot
read-only concept-index scan. The lookup field accepts a stable ID, exact or
normalized title, or alias. An ambiguous label displays every matching concept
with its stable ID and Vault-relative path; it never chooses one automatically.
**Use Active Note** safely rejects ordinary Markdown and unsupported concept
schema versions without converting them.

The workspace presents the concept in separate sections:

- **Personal meaning — authoritative** contains the only editable definition
  field. The user can enter exact text or deliberately copy a preserved exact
  evidence span into it. Manual text receives `user_edit` provenance; historical
  message provenance is reused only when the chosen text exactly matches it.
- **AI interpretation — non-authoritative** is read-only and is never promoted
  into personal meaning.
- **External / standard meaning — non-authoritative** is also read-only.

Aliases may be reviewed as a complete set. Relationships show their relation
type, stable target ID, and display label. Removal is draft-only; additions
require an exact stable-ID choice from the loaded index. Same-label concepts
remain distinct options. Open meaning and interpretation conflicts may be left
unresolved or explicitly marked resolved as part of the reviewed definition.

**Prepare Review** creates an immutable proposed node and a field-level semantic
diff. It does not write. The review shows definition, alias, status,
relationship, ambiguity, history-restore, and revision changes without exposing
the encoded persistence projection. **Back** preserves the draft and **Cancel**
closes without writing.

Only **Confirm Update** calls `persistConfirmedConceptUpdate()`. Immediately
before `vault.modify()`, the adapter reloads the exact file and requires:

- the same safe Vault-relative path;
- the same stable concept ID;
- the same expected revision;
- byte-for-byte equality with the Markdown that was reviewed;
- a valid prepared projection for exactly the next revision.

Any mismatch is a stale update and produces zero writes. The workspace asks the
user to reload and review; it does not merge. A successful update performs one
Vault modification and then reloads both the concept and one-shot index.

History is read-only until the user selects **Prepare Restore**. The restored
state appears in the same semantic diff and still requires **Confirm Update**.
Restoring revision N creates a new current revision rather than removing later
history.

Concept-level diagnostics and same-label warnings are displayed read-only. They
never repair, merge, or persist anything.

## Integrity diagnostics

`diagnoseBrain()` is pure and read-only. It reports:

- duplicate stable IDs;
- suspicious same-title groups;
- missing exact user definitions;
- unresolved meaning or interpretation conflicts;
- unresolved relationship labels;
- stable relationships whose targets are absent;
- malformed revision history;
- invalid persistence metadata supplied by the caller.

Diagnostics never infer a repair, merge concepts, create missing nodes, or
write files.

## Safety invariants

- Exact user meaning is authoritative; evidence is not automatically a
  definition.
- Generated and external meanings never overwrite user meaning.
- Title and alias equality do not establish concept identity.
- Ambiguity and conflict remain explicit.
- Preview, generation, loading, lookup, diagnostics, update preparation, and
  restore preparation perform no Vault write.
- Confirmed Create Note/Create Group are the only creation paths. Confirmed
  Concept Maintenance is the only existing-note semantic modification path.
- Opening, editing, preparing, reviewing, going back, cancelling, stale
  confirmation, and invalid persistence all produce zero maintenance writes.

## Deliberate limits

- The workspace deliberately has no automatic merge UI or AI suggestion action.
- No automatic migration of existing candidate or Vault notes is attempted.
- The Vault index is one-shot and metadata-only; it is not semantic search and
  does not persist a secondary database.
- Current Create Note safely persists source evidence and generated
  interpretation. The maintenance workspace is where a user may explicitly
  promote an exact evidence span or manual edit to personal meaning.
- No title-based concept merge, ontology, graph traversal, LLM call, cloud sync,
  or model training is included.
- Title changes are not exposed by this workspace, and no file is renamed.
- External definitions and AI interpretations are inspectable but not editable
  in v1; this keeps non-authoritative layers from being promoted accidentally.
- Obsidian GUI smoke testing was not performed by the automated environment;
  the actual Modal DOM and Vault boundary are covered by deterministic shims.

The next milestone should add one explicit **ordinary-note-to-ConceptNode
migration review** that lets a user choose a stable identity and semantic layer
mapping before any existing Markdown note is upgraded. It must reuse the same
preview, semantic-diff, and explicit-confirmation boundaries.
