# M2B.7 Ordinary-Note Migration Implementation Audit

Audit date: 2026-09-03

## Status

M2B.7 implements one explicit ordinary-Markdown-to-ConceptNode migration flow.
The implementation is bounded to a selected existing file, uses pure preparation
and review, and reaches the Vault only through an exact confirmation adapter.

This audit is based on the finished implementation, its deterministic tests,
the complete repository test run, and the production build. Both focused
migration suites, the relevant legacy regression ring, full `npm test`, and
`npm run build` pass on 2026-09-03.

## Architecture

| Boundary | File | Responsibility | Writes? |
| --- | --- | --- | --- |
| Concept domain compatibility | `src/BrainGrowth.ts` | Retains exact reviewed unresolved migration text in optional, non-authoritative `sourceMaterial` without changing meaning authority. | No |
| Pure migration domain | `src/BrainMigration.ts` | Creates the conservative draft, validates explicit identity, constructs the five semantic mappings, reports label collisions, builds the revision-1 ConceptNode, semantic diff, origin, and Markdown preview, and deeply freezes the prepared result. | No |
| Persistence compatibility | `src/BrainGrowthPersistence.ts` | Extends the existing schema-v1 projection with an explicit `ordinary_markdown_migration` origin while retaining the legacy candidate origin. Serializes and validates both routes. | No |
| Selected-note loader | `src/ObsidianConceptMigration.ts` | Validates one Vault-relative Markdown path, reads that file, and classifies it through `inspectConceptMarkdown()`. | No |
| Confirmation/write adapter | `src/ObsidianConceptMigration.ts` | Captures an immutable input snapshot before its first await; revalidates confirmation, projection, source bytes, source kind, index completeness, stable-ID availability, and the reviewed collision set; performs the only migration `vault.modify()`. | Exactly one call on success |
| Migration workspace | `src/BrainMigrationWorkspaceModal.ts` | Presents source, explicit stable ID, five editable mapping fields, preview, semantic diff, Markdown preview, collision warnings, Back, Cancel, and Confirm Migration. Reloads the one-shot index after success. | Only through the confirmation adapter |
| Existing UI entry | `src/BrainMaintenanceWorkspaceModal.ts` | Adds **Prepare Concept Migration** for the active note to the existing Concept Maintenance lookup. | No |
| Restart and identity index | `src/ObsidianConceptIndex.ts` | Existing one-shot read-only discovery loads the migrated schema-v1 projection by stable ID. Confirmation can explicitly bypass Obsidian's cache for identity checks. | No |

No new database, background listener, migration service, AI call, or alternate
persistence format was introduced. `main.ts` does not need another command:
migration is launched narrowly from the existing Concept Maintenance lookup.

## Reviewed lifecycle

```text
ordinary Markdown
  -> explicit selection through Prepare Concept Migration
  -> read exact source path and Markdown snapshot
  -> inert draft: blank stable ID, filename-derived title handle,
     entire source in unresolved material
  -> user enters stable ID and reviews five mappings
  -> Preview (pure)
  -> immutable proposal + semantic diff + Markdown preview + collisions
  -> Back / edit / re-preview / Cancel (zero writes)
     OR
  -> explicit Confirm Migration
  -> immutable input snapshot captured before the first await
  -> per-App confirmation lock
  -> confirmation and projection validation
  -> three uncached source reads + two uncached identity scans
  -> stable-ID, collision, and scan-stability checks
  -> one vault.modify() of the same file
  -> deterministic deserialize and one-shot index reload
```

Reading, opening, inspecting, indexing, or searching an ordinary note never
enters this lifecycle implicitly. Even opening the migration workspace only
loads the selected source; it does not prepare or write a ConceptNode.

## The five mappings

All mapping fields are explicitly user-reviewed. Except for the unresolved
field, mapped text is trimmed at the outer boundary before projection.

| Reviewed mapping | ConceptNode representation | Authority and provenance |
| --- | --- | --- |
| Personal definition | At most one `ConceptUserDefinition` in `userDefinition` | Authoritative only because the user explicitly supplied it in this review. Its exact reviewed snapshot is a `UserTextProvenance` with `sourceKind: "user_edit"`, `actor: "user"`, and a migration-scoped `editId`. |
| Exact user evidence, not yet a definition | At most one entry in `userEvidence` | A separate `user_edit` provenance snapshot. It is evidence and is never promoted to `userDefinition` automatically. |
| Generated / AI interpretation | At most one `ConceptContentEntry` in `generatedInterpretations` | Non-authoritative. It has a migration source reference, not fabricated chat-message provenance, and never becomes personal meaning. |
| Standard / external meaning | At most one `ConceptContentEntry` in `standardDefinitions` | Non-authoritative and structurally separate from personal meaning, with only a migration source reference. |
| Unresolved / ambiguous material | One open `meaning` unresolved item when the reviewed bucket is nonblank | Conservative default. The full exact source Markdown starts here, so arbitrary prose does not become a definition. `sourceMaterial` persists the exact reviewed bucket, including its meaningful outer whitespace, alongside a generic unresolved description and migration source reference. |

If both personal definition and unresolved material are empty, preparation adds
an open `missing-definition` meaning item. Therefore migration without an
approved exact personal definition remains semantically ambiguous.

The system does not claim that text already present in an ordinary note came
from a historical message. Personal definition and evidence use the explicit
current `user_edit` route. The persistence origin is separately recorded as:

```ts
{
  kind: "ordinary_markdown_migration",
  sourceVaultPath,
  preparedAt,
  sourceMarkdownHash
}
```

That origin is stored in the versioned projection. Frontmatter exposes only the
migration source path; the preparation time and source hash remain in the
machine projection. Legacy candidate origins continue to deserialize and
reserialize without being reclassified.

## Exact invariants

1. **Ordinary Markdown is not a ConceptNode.** Only a successful explicitly
   confirmed migration adds the ConceptNode projection.
2. **Reading is not migration.** Inspection, selected-note load, ordinary-note
   indexing, and workspace opening issue no create, modify, trash, or rename.
3. **Stable identity is explicit.** Preparation fails when `conceptId` is blank.
   Filename, title, aliases, and prose are handles or content, never identity.
4. **An existing stable ID is never reused.** A conflict blocks preparation,
   and two uncached confirmation-time scans catch a conflict that appeared
   later within the checked interval.
5. **Same-label concepts remain distinct.** Title/alias collisions are reported
   with stable IDs. They do not merge and do not block a distinct reviewed ID;
   a changed collision set requires re-preview. The canonical collision
   snapshot is included in the deterministic migration ID.
6. **The conservative default is unresolved.** The entire source snapshot starts
   in `unresolvedMaterialText`; no personal definition, evidence, generated
   interpretation, or standard definition is inferred.
7. **AI interpretation is not user meaning.** Generated and external mapping
   routes cannot populate `userDefinition`.
8. **Note-only text gets no invented message provenance.** Only explicit
   `user_edit` snapshots and migration source references are created.
9. **Preview is pure.** The prepared object contains source path, exact source
   bytes, reviewed draft, stable identity, resulting ConceptNode, origin,
   mapping, semantic diff, collisions, and resulting Markdown without a Vault
   API dependency.
10. **The reviewed proposal is immutable and reconstructible.** The result and
    nested structures are frozen. Confirmation regenerates and structurally
    compares the draft, mapping, diff, concept, origin, migration ID, and
    Markdown projection, including the collision-bound review identity. The
    adapter also deep-copies and freezes its input before its first await, so a
    mutable structural clone cannot change the later write.
11. **Migration creates revision 1 only.** `createdAt === updatedAt`, revision is
    1, and history is empty. A prepared object carrying maintenance history is
    rejected.
12. **Confirmation is proposal-specific.** The marker must be
    `confirmed_concept_migration` with non-empty confirmation time and exact
    migration ID, source path, and concept ID.
13. **Staleness is byte-exact and uncached.** All three confirmation source
    reads use `vault.read()` and must equal the reviewed `sourceMarkdown`;
    normalization, semantic equivalence, or a stale cache is insufficient.
14. **Identity checks fail closed.** Both scans use uncached Vault reads. Any
    index load issue blocks the write because global stable-ID absence cannot
    be established safely, and a changed complete scan blocks as
    `identity_check_changed`.
15. **Success modifies the selected file exactly once.** It does not create,
    delete, recreate, rename, merge, or modify the colliding concept.
16. **The readable note survives migration.** Existing body text and unmanaged
    frontmatter are retained while managed frontmatter and the schema-v1
    projection are added.
17. **Restart is deterministic.** The existing one-shot index can deserialize
    and uniquely find the migrated node by its chosen stable ID.
18. **Future or malformed persistence remains invalid.** It is never treated as
    ordinary Markdown and never silently migrated to the current schema.
19. **Local confirmations are serialized.** A per-`App` lock prevents
    simultaneous migration confirmations in this plugin from both claiming one
    stable identity.
20. **Unsupported frontmatter fails closed.** Flow-map/root-sequence roots,
    explicit or complex tagged/escaped keys, YAML document-end markers, managed
    anchor/alias dependencies, and multiline flow values on managed keys are
    rejected during preparation rather than being combined with invalid or
    dangling YAML. BOM, CRLF, nested fields, block scalars, unmanaged
    block-mapping fields, and balanced single-line managed arrays remain
    supported.

## Confirmation rechecks

`persistConfirmedConceptMigration()` applies the checks in this order:

1. Deep-copy and freeze the prepared proposal and confirmation synchronously,
   before the first await.
2. Enter a per-`App` confirmation queue so local migration confirmations cannot
   overlap their identity checks and writes.
3. Validate that the prepared path is safe, Vault-relative Markdown and already
   canonical in the prepared object.
4. Validate the explicit confirmation marker and its migration ID, path,
   concept ID, and non-empty time.
5. Validate the prepared projection: migration origin, source hash, timestamps,
   revision/history, parseable output, collision-bound deterministic rebuild,
   exact serialization, and structural equality of all reviewed objects.
6. Read the selected note with `vault.read()` and require that it is still
   ordinary Markdown and byte-equal to the reviewed source.
7. Load a complete index with uncached reads. Require zero issues, require the
   stable ID to be absent, and require collisions to equal the preview.
8. Re-read the source uncached and repeat the ordinary-kind and byte checks.
9. Load a second complete uncached index; repeat ID and collision checks, then
   require its complete identity snapshot to equal the first scan.
10. Re-read the source uncached a third time and repeat the same source checks.
11. Call `vault.modify(writeLoaded.file, prepared.markdown)` once.

Every failure through step 10 returns before a modification call. A rejected
`vault.modify()` becomes `vault_update_failed`; there is no retry or compensating
write.

## Typed failures

### Preparation

| Code | Meaning |
| --- | --- |
| `invalid_source_path` | The preparation input has no source Vault path. |
| `source_not_ordinary` | The source already contains a valid ConceptNode. |
| `source_invalid_concept_metadata` | A concept marker exists but its metadata is malformed. |
| `source_unsupported_schema_version` | A future/unsupported persistence marker is present. |
| `identity_required` | No explicit stable ID was supplied. |
| `conflicting_identity` | A known ConceptNode already owns the chosen stable ID. |
| `invalid_draft` | Required reviewed data is missing or domain/projection validation rejects the mapping. |

### Selected-note load

| Code | Meaning |
| --- | --- |
| `invalid_source_path` | The selected path is unsafe, non-Markdown, or otherwise invalid. |
| `source_not_found` | The selected file no longer exists. |
| `source_read_failed` | The selected file cannot be read. |
| `source_not_ordinary` | The selected file is already a ConceptNode. |
| `source_invalid_concept_metadata` | The selected file has malformed ConceptNode persistence. |
| `source_unsupported_schema_version` | The selected file has a future/unsupported schema marker. |

### Confirmation/write

The write result includes every selected-note load failure plus:

| Code | Meaning |
| --- | --- |
| `approval_required` | The explicit marker or any marker binding does not match this exact preview. |
| `stale_source` | Source Markdown differs byte-for-byte from the reviewed snapshot. |
| `identity_check_incomplete` | The fresh index has any load issue, so ID uniqueness cannot be established globally. |
| `identity_check_changed` | The two complete identity scans differ during confirmation, so the checked view was not stable. |
| `conflicting_identity` | The proposed stable ID appeared before confirmation. |
| `label_collisions_changed` | The current title/alias collision set differs from preview. |
| `invalid_prepared_projection` | The immutable proposal was altered, is noncanonical, has history/revision drift, or no longer round-trips exactly. |
| `vault_update_failed` | The one attempted Vault modification rejected. No retry is attempted. |

## Changed files

| File | Change |
| --- | --- |
| `src/BrainGrowth.ts` | Adds optional exact `sourceMaterial` to unresolved items so reviewed ambiguous migration text survives restart. |
| `src/BrainMigration.ts` | New pure migration domain, mapping, diff, collision, and prepared-preview model. |
| `src/ObsidianConceptMigration.ts` | New selected-note reader and sole confirmed migration write boundary. |
| `src/BrainMigrationWorkspaceModal.ts` | New explicit migration editor/review/confirmation modal. |
| `src/BrainGrowthPersistence.ts` | Adds typed migration-origin persistence while preserving legacy candidate origins. |
| `src/BrainMaintenanceWorkspaceModal.ts` | Adds the active-note **Prepare Concept Migration** entry point. |
| `src/ObsidianConceptIndex.ts` | Adds an explicit uncached read mode for confirmation-time identity scans while retaining cached ordinary discovery. |
| `tests/brain-migration.test.mjs` | New domain, persistence, race, failure, one-write, and restart coverage. |
| `tests/brain-migration-workspace-modal.test.mjs` | New deterministic modal-flow coverage using Obsidian shims. |
| `package.json` | Registers both focused migration suites and includes them in the full test chain. |
| `main.js` | Regenerated production bundle containing the migration domain, adapter, and workspace flow. |
| `BRAIN_GROWTH.md` | Documents implemented lifecycle, architecture, mappings, provenance, safety boundary, and limits. |
| `M2B7_MIGRATION_IMPLEMENTATION_AUDIT.md` | Records this implementation audit and verification matrix. |

## A-Q test matrix

`PASS` means the behavior was exercised by the indicated deterministic suite
and the complete repository test chain passed on 2026-09-03.

| ID | Required case | Evidence | Status |
| --- | --- | --- | --- |
| A | Ordinary note inspection causes zero writes. | Domain suite inspects, explicitly loads, and indexes an ordinary note; source bytes and write log stay unchanged. UI suite opens the workspace without writing. | PASS |
| B | Prepare migration causes zero writes. | Domain preparation has no App/Vault dependency; UI Preview leaves the write log empty. | PASS |
| C | Cancel causes zero writes. | Modal suite previews, cancels, and verifies the original store and empty write log. | PASS |
| D | Back/edit/re-preview causes zero writes. | Modal suite goes Back, edits all layer fields, re-previews, and retains zero writes. | PASS |
| E | Stale source Markdown at confirmation causes zero writes. | Domain suite changes source bytes before confirmation and during the identity scan, and proves a stale cache cannot hide changed disk bytes. All return `stale_source` with zero modify calls. | PASS |
| F | Source becomes ConceptNode before confirmation causes zero writes. | Domain suite replaces the source with a valid concept projection and receives `source_not_ordinary`. | PASS |
| G | Conflicting stable ID causes zero writes. | Domain suite introduces a distinct note with the proposed ID after preview and proves a stale cache cannot hide it from uncached scans. | PASS |
| H | Same-title distinct identity is not merged. | Domain suite migrates `Freedom` with a new ID beside existing `Freedom`; collision review is ID-bound and the existing file is unchanged. UI suite recovers from a late collision through Back and re-preview. | PASS |
| I | Ambiguous prose is not promoted to `userDefinition`. | Default draft keeps the full source unresolved, has no definition or authoritative evidence, and yields ambiguous meaning. | PASS |
| J | Explicitly mapped exact personal definition survives round trip. | Domain suite checks text and `user_edit` provenance before write, deserialize, reserialize, and restart; modal suite checks mapped definition after persistence. | PASS |
| K | External/generated material never becomes personal meaning. | Domain suite maps all layers, verifies separate arrays, and verifies the personal definition excludes generated/external text. | PASS |
| L | Successful confirmation performs exactly one `modify()`. | Each successful focused scenario performs one modify, no create/trash, on its original path; double confirmation is guarded. | PASS |
| M | Migrated note reloads deterministically after restart. | Domain suite deserializes repeatedly, reserializes, reloads the one-shot index, and obtains a `unique_match` by stable ID. Exact unresolved `sourceMaterial` survives. | PASS |
| N | Unsupported/future schema inputs remain rejected. | Domain suite rejects v9 at inspection, preparation, selected-note load, and prepared-projection confirmation. Unknown origins plus parser-unsafe YAML roots, keys, anchors, flows, and document boundaries are rejected. | PASS |
| O | Existing maintenance tests remain unchanged/passing. | Brain Growth, integration, maintenance, index, both maintenance workspace suites, and all three M2B.6a contextual-sense suites passed separately and in the full chain. | PASS |
| P | Full `npm test` passes. | Complete package test chain exited 0 on 2026-09-03. | PASS |
| Q | `npm run build` passes. | TypeScript validation and the production esbuild bundle exited 0 on 2026-09-03; `main.js` was regenerated. | PASS |

Key commands executed successfully:

```text
npx tsc --noEmit --skipLibCheck
npm run test:brain-migration
npm run test:brain-migration-workspace-modal
npm run test:brain-growth
npm run test:brain-growth-integration
npm run test:brain-maintenance
npm run test:obsidian-concept-index
npm run test:brain-maintenance-workspace
npm run test:brain-maintenance-workspace-modal
npm run test:contextual-sense-projection
npm run test:contextual-sense-activation
npm run test:contextual-sense-identity-gate
npm test
npm run build
```

The domain suite reports zero writes for inspection, preparation, stale source,
source-kind conflict, identity conflict, label-collision race, index-scan race,
and asynchronous mutation of a caller-owned structural clone; one modify per
successful migration; a unique restart match; future-schema rejection; safe
frontmatter handling; and candidate/migration origin compatibility. The
modal suite reports zero writes for prepare, Cancel, Back, and re-preview;
disabled controls during pending confirmation; duplicate-submit prevention;
late-collision recovery; visible five-layer controls; and migrated stable IDs.

## Remaining limitations

- **No atomic Vault transaction.** A per-`App` lock serializes this plugin's
  migration confirmations, two uncached identity scans must agree, and a third
  uncached source read occurs immediately before `vault.modify()`. The Vault API
  does not offer compare-and-swap: another plugin, client, or external process
  can still change the source after that final read, or introduce a stable ID
  after the second scan, before the modify begins.
- **No AI mapping.** There is no classifier, LLM call, inference, suggestion, or
  automatic promotion. The user must place text in each semantic bucket.
- **Coarse mapping granularity.** The review has one freeform text field per
  requested layer, not source-anchored spans or per-paragraph mappings. It does
  not prove that buckets are disjoint, exhaustive, or verbatim slices of the
  source, and it does not map examples, counterexamples, relationships, or
  questions.
- **Coarse unresolved representation.** The exact reviewed unresolved bucket is
  persisted in `sourceMaterial` and survives restart, but it remains one
  freeform bucket rather than source-anchored spans or paragraph-level mapping.
- **No rename or merge.** Migration modifies the original path only. Same-label
  concepts stay distinct, and there is no title-based merge, content merge,
  identity reassignment, file move, delete/recreate, or relationship rewiring.
- **No batch or background migration.** Migration is one explicitly selected
  note at a time. There is no startup scan, watcher, scheduled job, automatic
  repair, or retry.
- **Fail-closed index dependency.** Any unreadable or invalid concept note makes
  the identity scan incomplete and blocks migration, even when that note would
  not actually conflict. This favors false negatives over duplicate identity.
- **Unsupported YAML structures fail closed.** Flow-map/root-sequence roots,
  explicit or complex tagged/escaped keys, YAML document-end markers, managed
  anchor/alias dependencies, and multiline managed flow values are not
  rewritten. Preparation returns `invalid_draft`; there is no YAML conversion
  or automatic repair.
- **Hashes are review identifiers, not locks.** `fnv1a32` binds the source,
  reviewed proposal, and collision snapshot into deterministic identifiers.
  Uncached byte-for-byte source equality and live index scans, not hash
  collision resistance, enforce confirmation staleness and identity absence.
- **No manual Obsidian smoke test yet.** UI behavior is automated through a
  deterministic Obsidian DOM/Vault shim. Actual desktop Modal layout, focus,
  keyboard flow, and interaction with a real Vault remain manually unverified.
