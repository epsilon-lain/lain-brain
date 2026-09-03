# Brain Growth and Maintenance v1

Confirmed semantic changes and bounded derived maintenance are documented in
[`SEMANTIC_DELTA.md`](SEMANTIC_DELTA.md).

Brain Growth v1 connects the pure concept-node domain to the existing reviewed
Candidate Note workflow. M2B.7 also adds one explicit, reviewed path for
upgrading an already existing ordinary Markdown note. It does not add a
database, an AI auto-edit path, background migration, or an unchecked Vault
write.

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
  deterministic single-note loader. Its explicit origin union preserves both
  legacy candidate creation and `ordinary_markdown_migration` provenance.
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
  `Setting` controls. It is also the explicit entry point for migrating the
  active ordinary note; ordinary-note lookup and inspection still do nothing
  by themselves.
- `ObsidianConceptMaintenance.ts` owns the single reviewed modification
  boundary. It validates the exact original Markdown, stable ID, and expected
  revision immediately before one `vault.modify()` call.
- `BrainMigration.ts` owns the pure ordinary-note migration draft, the five
  reviewed semantic mappings, deterministic migration diff and Markdown
  preview, identity/collision checks, and immutable prepared migration.
- `BrainMigrationWorkspaceModal.ts` owns the narrow editor -> preview -> Back,
  Cancel, or Confirm Migration UI. It cannot write except by calling the
  confirmation adapter.
- `ObsidianConceptMigration.ts` is the sole ordinary-note migration write
  boundary. It revalidates the reviewed source, proposal, identity scan, and
  collision set before exactly one `vault.modify()` call.
- `BrainDiagnostics.ts` reports structural problems without repairing them.
- `LainBrainSession.createCandidateNote()` and `createCandidateGroup()` remain
  the only candidate-to-concept creation boundaries. Confirmed maintenance and
  confirmed ordinary-note migration use their separate, checked
  single-existing-note modification boundaries above.

## Reviewed lifecycle

```text
Reviewed candidate creation:
  User language -> CandidateNote -> user review/edit
    -> confirmed Create Note or Create Group
    -> ConceptNode adapter -> checked Vault create -> deterministic reload

Reviewed maintenance:
  indexed ConceptNode -> inspect/edit -> Prepare Review
    -> immutable next revision + semantic field-level diff
    -> explicit Confirm Update -> one checked Vault modification
    -> deterministic reload

Explicit ordinary-note migration:
  ordinary Markdown -> explicit Prepare Concept Migration
    -> choose stable ID + review five semantic mappings
    -> pure immutable preview + semantic migration diff + Markdown preview
    -> Back / Cancel (zero writes), or explicit Confirm Migration
    -> source/proposal/identity/collision rechecks
    -> one checked Vault modification of the same file
    -> deterministic reload and one-shot index discovery
```

Preview, regeneration, candidate-to-concept adapter invocation, and
serialization are pure/in-memory operations. Cancelling the existing
confirmation modal performs no conversion or Vault write. A conversion failure
happens before `vault.create()` and cannot
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
the result, and reconstructs both the `ConceptNode` and its candidate or
ordinary-note migration origin. It does not scan the Vault or write anything.

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
`getMarkdownFiles()` plus a Vault read and performs no migration or write.
Ordinary discovery uses `cachedRead()`; confirmation-time identity checks opt
into `read()` so a stale cache cannot authorize a migration.

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

## Explicit ordinary-note migration

The Concept Maintenance lookup exposes **Prepare Concept Migration** only as an
explicit action for the active Markdown file. Opening, reading, indexing,
searching, or inspecting an ordinary note leaves it ordinary and performs no
write. Loading the migration workspace captures its safe Vault-relative path
and exact Markdown snapshot, but still does not prepare a ConceptNode.

The initial migration draft deliberately has no stable ID. The filename supplies
only an editable title handle, aliases start empty, and the complete original
Markdown begins in the unresolved bucket. Preview is rejected until the user
enters a stable ConceptNode ID. A matching title or alias never supplies that
identity.

The five explicit mappings are kept structurally separate:

1. **Personal definition - authoritative** becomes one
   `ConceptUserDefinition` only when the user supplies reviewed text. Its exact
   reviewed snapshot receives `user_edit` provenance.
2. **Exact user evidence - not yet a definition** becomes user evidence with
   separate `user_edit` provenance. It is never promoted implicitly.
3. **Generated / AI interpretation - non-authoritative** becomes a generated
   interpretation entry and can never become personal meaning through this
   route.
4. **Standard / external meaning - non-authoritative** becomes a standard
   definition entry and remains separate from personal meaning.
5. **Unresolved / ambiguous material** keeps the ConceptNode ambiguous through
   an open meaning item whose optional `sourceMaterial` retains the exact
   reviewed text. This is the conservative default for the full source note;
   arbitrary prose is never silently treated as a personal definition.

Migration does not invent chat-message provenance for note-only text.
User-reviewed personal text uses `sourceKind = "user_edit"`; generated,
external, and unresolved entries refer only to the reviewed migration source.
The persistence projection records an `ordinary_markdown_migration` origin with
the source Vault path, preparation time, and source-Markdown hash. The readable
original note body and unmanaged frontmatter are retained while the normal
versioned ConceptNode projection and managed frontmatter are added.

`prepareConceptMigration()` is pure and returns a deeply frozen object containing
the source path, byte-exact source Markdown, reviewed draft, chosen identity,
five-part mapping, proposed revision-1 ConceptNode, migration origin, semantic
diff, label collisions, and resulting Markdown. **Preview**, **Back**, and
**Cancel** remain in memory and perform zero Vault writes.

The canonical label-collision snapshot is included in the deterministic
migration ID and checked during reconstruction. An ordinary cloned-object
mutation therefore cannot remove or replace the reviewed warnings while
retaining a valid prepared projection.

Only `persistConfirmedConceptMigration()` may cross the migration write
boundary. It first captures a deeply frozen copy of the prepared proposal and
confirmation before any `await`, so mutation of a structural clone during a
Vault callback cannot change later checks or the Markdown written. Before
modifying the file it requires:

- the same valid Vault-relative path;
- a non-empty `confirmed_concept_migration` marker matching migration ID, path,
  and stable concept ID;
- a deterministic reconstruction of the reviewed draft, mapping, diff, origin,
  revision-1 node with empty history, and exact Markdown projection;
- a first uncached re-read showing that the file is still ordinary Markdown and
  exactly byte-equal to the reviewed snapshot;
- two uncached, issue-free one-shot identity scans in which the chosen stable ID
  is absent and whose complete snapshots are equal;
- a title/alias collision set exactly equal to the one shown in preview during
  both identity scans;
- an uncached source re-read between the scans; and
- a third uncached ordinary-note, byte-equal re-read immediately before
  modification.

Every failed precondition returns a typed failure before `vault.modify()`.
Confirmation attempts on the same Obsidian `App` are serialized so two local
migrations cannot simultaneously claim the same stable ID. A successful
confirmation calls `vault.modify()` exactly once on the original file; it never
creates, deletes, renames, merges, or retries a note. Existing title or alias
collisions are shown with the other stable IDs and may proceed only as a
deliberately distinct identity. A new or changed collision after preview is
stale review; the workspace refreshes its index and requires preview again.

The Vault API has no compare-and-swap operation. Another plugin, client, or
external process can still change the source after the final source read, or
introduce an ID after the second identity scan, before `vault.modify()` begins.
The local confirmation lock cannot close that external interval.

Frontmatter is preserved only when its YAML root and managed fields can be
rewritten safely without a YAML parser. Flow-map/root-sequence roots, explicit
or complex tagged/escaped keys, YAML document-end markers, managed anchor/alias
dependencies, and multiline flow values on managed keys are rejected during
preparation rather than rewritten into invalid YAML. Existing BOM/CRLF style,
nested fields, block scalars, unmanaged block-mapping fields, and balanced
single-line managed arrays are handled deterministically.

After success the workspace reloads the one-shot index. The same persisted
projection is discoverable by `loadObsidianConceptIndex()` after restart, using
the chosen stable ID rather than the filename, title, or aliases.

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
- Preview, generation, loading, lookup, diagnostics, update preparation,
  restore preparation, and migration preparation perform no Vault write.
- Confirmed Create Note/Create Group are the only candidate creation paths.
  Confirmed Concept Maintenance and Confirmed Migration are the only reviewed
  existing-note semantic modification paths.
- Opening, editing, preparing, reviewing, going back, cancelling, stale
  confirmation, and invalid persistence all produce zero maintenance or
  migration writes.
- Ordinary Markdown is not a ConceptNode; reading is not migration; AI
  interpretation is not user meaning; a migration preview is not a write; only
  an exact explicit confirmation can alter the selected ordinary note.

## Deliberate limits

- The workspace deliberately has no automatic merge UI or AI suggestion action.
- Ordinary-note migration is explicit, manual, and one note at a time. There is
  no automatic, batch, startup, background, or AI-authored mapping path.
- The Vault index is one-shot and metadata-only; it is not semantic search and
  does not persist a secondary database.
- Current Create Note safely persists source evidence and generated
  interpretation. The maintenance workspace is where a user may explicitly
  promote an exact evidence span or manual edit to personal meaning.
- No title-based concept merge, ontology, graph traversal, LLM call, cloud sync,
  or model training is included.
- Migration and maintenance do not rename files or merge notes. Title changes
  are not exposed by the maintenance workspace.
- For existing ConceptNodes, external definitions and AI interpretations remain
  inspectable but not editable in the maintenance workspace. Migration review
  can map them explicitly, but only into their separate non-authoritative
  layers.
- Obsidian GUI smoke testing was not performed by the automated environment;
  the actual Modal DOM and Vault boundary are covered by deterministic shims.

The next migration milestone should refine the implemented review with
source-anchored, finer-grained mappings while preserving the same no-inference,
preview, semantic diff, and explicit-confirmation boundaries.
