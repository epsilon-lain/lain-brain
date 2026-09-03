import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: `
      export * from "./src/BrainGrowth";
      export * from "./src/BrainGrowthIndex";
      export * from "./src/BrainGrowthPersistence";
      export * from "./src/BrainMigration";
      export * from "./src/ObsidianConceptMigration";
      export * from "./src/ObsidianConceptIndex";
    `,
    resolveDir: process.cwd(),
    sourcefile: "brain-migration-entry.ts",
    loader: "ts"
  },
  absWorkingDir: process.cwd(),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2021",
  write: false,
  plugins: [{
    name: "obsidian-shim",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: "obsidian",
        namespace: "shim"
      }));
      build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
        loader: "js",
        contents: `exports.normalizePath = (value) =>
          value.replace(/\\\\/g, "/").replace(/\\/{2,}/g, "/");`
      }));
    }
  }]
});
const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  module,
  exports: module.exports,
  require,
  console,
  Object,
  Map,
  Set,
  JSON,
  Math,
  encodeURIComponent,
  decodeURIComponent
});
const api = module.exports;
const preparedAt = "2026-08-16T00:00:00.000Z";
const confirmedAt = "2026-08-16T00:01:00.000Z";
const sourcePath = "Notes/Freedom.md";
const sourceMarkdown = [
  "---",
  "tags:",
  "  - migration-source",
  "custom-key: keep-me",
  "---",
  "# Freedom",
  "",
  "These ordinary notes may contain personal observations, external quotations,",
  "and generated prose. Nothing here is a definition until explicitly mapped."
].join("\n");

const plain = (value) => JSON.parse(JSON.stringify(value));

function makeVault(initialEntries = []) {
  const entries = new Map();
  const calls = [];
  for (const entry of initialEntries) {
    entries.set(entry.path, {
      file: { path: entry.path },
      markdown: entry.markdown,
      readError: entry.readError === true
    });
  }
  const fixture = {
    entries,
    calls,
    add(path, markdown, readError = false) {
      entries.set(path, { file: { path }, markdown, readError });
    },
    setMarkdown(path, markdown) {
      entries.get(path).markdown = markdown;
    },
    setReadError(path, readError) {
      entries.get(path).readError = readError;
    },
    markdown(path) {
      return entries.get(path)?.markdown;
    }
  };
  fixture.app = {
    vault: {
      getFileByPath: (path) => entries.get(path)?.file ?? null,
      getMarkdownFiles: () => [...entries.values()].map((entry) => entry.file),
      cachedRead: async (file) => {
        const entry = entries.get(file.path);
        if (entry?.readError) {
          throw new Error("simulated read failure");
        }
        return entry?.markdown;
      },
      read: async (file) => {
        const entry = entries.get(file.path);
        if (entry?.readError) {
          throw new Error("simulated read failure");
        }
        return entry?.markdown;
      },
      modify: async (file, markdown) => {
        calls.push({ operation: "modify", path: file.path, markdown });
        entries.get(file.path).markdown = markdown;
      },
      create: async (path, markdown) => {
        calls.push({ operation: "create", path, markdown });
      },
      trash: async (file) => {
        calls.push({ operation: "trash", path: file.path });
      }
    }
  };
  return fixture;
}

function candidateMarkdown(id, title, candidateId = `candidate-${id}`) {
  const concept = api.createConceptNode({
    id,
    title,
    createdAt: preparedAt
  });
  const origin = {
    candidateId,
    candidateRevision: 2,
    approvedAt: preparedAt
  };
  return {
    concept,
    origin,
    markdown: api.serializeConceptNodeIntoMarkdown(
      `# ${title}\n\nExisting readable body.`,
      concept,
      origin
    )
  };
}

function prepare(input = {}) {
  const path = input.sourceVaultPath ?? sourcePath;
  const markdown = input.sourceMarkdown ?? sourceMarkdown;
  const draft = api.createConceptMigrationDraft({
    sourceVaultPath: path,
    sourceMarkdown: markdown
  });
  return api.prepareConceptMigration({
    sourceVaultPath: path,
    sourceMarkdown: markdown,
    draft: {
      ...draft,
      conceptId: input.conceptId ?? "concept-migrated-freedom",
      ...(input.draft ?? {})
    },
    knownConcepts: input.knownConcepts ?? [],
    preparedAt: input.preparedAt ?? preparedAt
  });
}

function confirmationFor(prepared, overrides = {}) {
  return {
    kind: "confirmed_concept_migration",
    confirmedAt,
    migrationId: prepared.migrationId,
    sourceVaultPath: prepared.sourceVaultPath,
    conceptId: prepared.concept.id,
    ...overrides
  };
}

const existing = candidateMarkdown("concept-existing-freedom", "Freedom");
const existingPath = "Lain Brain/Notes/Existing Freedom.md";

// A: inspecting, loading, and indexing ordinary Markdown are read-only.
const inspectionFixture = makeVault([
  { path: sourcePath, markdown: sourceMarkdown },
  { path: existingPath, markdown: existing.markdown }
]);
const sourceSnapshot = inspectionFixture.markdown(sourcePath);
assert.equal(api.inspectConceptMarkdown(sourceSnapshot).kind, "ordinary_markdown");
const loadedOrdinary = await api.loadOrdinaryNoteForMigration(
  inspectionFixture.app,
  sourcePath
);
assert.equal(loadedOrdinary.ok, true);
const inspectedIndex = await api.loadObsidianConceptIndex(inspectionFixture.app);
assert.equal(inspectedIndex.records.length, 1);
assert.equal(inspectionFixture.calls.length, 0);
assert.equal(inspectionFixture.markdown(sourcePath), sourceSnapshot);

// B and I: preparation is immutable, read-only, and conservatively ambiguous.
const defaultPrepared = prepare({
  knownConcepts: [existing.concept]
});
assert.equal(defaultPrepared.kind, "prepared");
assert.equal(inspectionFixture.calls.length, 0);
assert.equal(defaultPrepared.sourceVaultPath, sourcePath);
assert.equal(defaultPrepared.sourceMarkdown, sourceMarkdown);
assert.equal(defaultPrepared.mapping.unresolvedMaterialText, sourceMarkdown);
assert.equal(defaultPrepared.concept.userDefinition, undefined);
assert.equal(defaultPrepared.concept.userEvidence.length, 0);
assert.equal(defaultPrepared.concept.generatedInterpretations.length, 0);
assert.equal(defaultPrepared.concept.standardDefinitions.length, 0);
assert.equal(defaultPrepared.concept.unresolvedItems.length, 1);
assert.equal(api.getConceptMeaningStatus(defaultPrepared.concept), "ambiguous");
assert.equal(api.inspectConceptMarkdown(defaultPrepared.markdown).kind, "concept_node");
assert.equal(defaultPrepared.origin.sourceMarkdownHash,
  api.hashConceptMigrationSourceMarkdown(sourceMarkdown));
for (const value of [
  defaultPrepared,
  defaultPrepared.draft,
  defaultPrepared.draft.aliases,
  defaultPrepared.concept,
  defaultPrepared.mapping,
  defaultPrepared.diff,
  defaultPrepared.diff[0],
  defaultPrepared.labelCollisions,
  defaultPrepared.labelCollisions[0]
]) {
  assert.equal(Object.isFrozen(value), true);
}
for (const kind of [
  "stable_identity",
  "personal_definition",
  "user_evidence",
  "generated_interpretation",
  "standard_definition",
  "unresolved_material",
  "meaning_status"
]) {
  assert.equal(defaultPrepared.diff.some((item) => item.kind === kind), true);
}

// Existing nested YAML that happens to use managed-looking keys remains
// readable, while complete top-level managed fields are replaced. Newline
// style is inherited from an ordinary CRLF source without mixed line endings.
const crlfSourceMarkdown = [
  "---",
  "nested-metadata:",
  '  lain-brain-concept-id: "nested-id-must-remain"',
  "  lain-brain-concept-aliases:",
  "    - nested-alias-must-remain",
  "lain-brain-concept-id: |",
  "  stale-top-level-id",
  "  stale-top-level-continuation",
  "lain-brain-concept-aliases:",
  "  - stale-top-level-alias-one",
  "  - stale-top-level-alias-two",
  "plain-key: keep-this-value",
  "---",
  "# CRLF source",
  "",
  "Readable body stays readable."
].join("\r\n");
const crlfPrepared = prepare({
  sourceMarkdown: crlfSourceMarkdown,
  conceptId: "concept-crlf-frontmatter"
});
assert.equal(crlfPrepared.kind, "prepared");
const crlfReadableMarkdown = crlfPrepared.markdown.split(
  "<!-- lain-brain-concept-data:v1:"
)[0];
assert.match(crlfReadableMarkdown,
  /  lain-brain-concept-id: "nested-id-must-remain"\r$/mu);
assert.match(crlfReadableMarkdown,
  /    - nested-alias-must-remain\r$/mu);
assert.match(crlfReadableMarkdown, /plain-key: keep-this-value\r$/mu);
assert.equal(crlfReadableMarkdown.includes("stale-top-level-id"), false);
assert.equal(crlfReadableMarkdown.includes("stale-top-level-continuation"),
  false);
assert.equal(crlfReadableMarkdown.includes("stale-top-level-alias-one"),
  false);
assert.equal(crlfReadableMarkdown.includes("stale-top-level-alias-two"),
  false);
assert.equal((crlfReadableMarkdown.match(
  /^lain-brain-concept-id:/gmu
) ?? []).length, 1);
assert.equal((crlfReadableMarkdown.match(
  /^lain-brain-concept-aliases:/gmu
) ?? []).length, 1);
assert.equal(crlfReadableMarkdown.includes("\r\n# CRLF source\r\n"), true);
assert.equal(crlfPrepared.markdown.replaceAll("\r\n", "").includes("\n"),
  false);

// A YAML block scalar may contain an indented document marker. Only the real
// column-zero delimiter closes frontmatter, and BOM/CRLF remain intact.
const blockScalarSourceMarkdown = "\uFEFF" + [
  "---",
  "description: |",
  "  first line",
  "  ---",
  "  last line",
  "plain-key: keep-after-indented-marker",
  "---",
  "# Block scalar source"
].join("\r\n");
const blockScalarPrepared = prepare({
  sourceMarkdown: blockScalarSourceMarkdown,
  conceptId: "concept-block-scalar-frontmatter"
});
assert.equal(blockScalarPrepared.kind, "prepared");
const blockScalarReadableMarkdown = blockScalarPrepared.markdown.split(
  "<!-- lain-brain-concept-data:v1:"
)[0];
assert.equal(blockScalarReadableMarkdown.startsWith("\uFEFF---\r\n"), true);
assert.match(blockScalarReadableMarkdown,
  /description: \|\r\n  first line\r\n  ---\r\n  last line\r$/mu);
assert.match(blockScalarReadableMarkdown,
  /plain-key: keep-after-indented-marker\r$/mu);
assert.equal(blockScalarPrepared.markdown.replaceAll("\r\n", "").includes("\n"),
  false);

// Appending block keys to another YAML root kind would create invalid
// frontmatter, so migration rejects those notes conservatively during preview.
for (const [conceptId, sourceMarkdown] of [
  [
    "concept-flow-map-frontmatter",
    ["---", "{tags: [migration], owner: user}", "---", "# Flow map"].join("\n")
  ],
  [
    "concept-root-sequence-frontmatter",
    ["---", "- first", "- second", "---", "# Root sequence"].join("\n")
  ],
  [
    "concept-explicit-key-frontmatter",
    [
      "---",
      "? lain-brain-concept-id",
      ": stale-explicit-id",
      "plain-key: keep-me",
      "---",
      "# Explicit key map"
    ].join("\n")
  ],
  [
    "concept-managed-anchor-frontmatter",
    [
      "---",
      "lain-brain-concept-aliases: &stale-aliases",
      "  - stale-alias",
      "copied-aliases: *stale-aliases",
      "---",
      "# Managed anchor"
    ].join("\n")
  ],
  [
    "concept-managed-multiline-flow-value",
    [
      "---",
      "plain-key: keep-me",
      "lain-brain-concept-aliases: [",
      '  "stale-one",',
      '  "stale-two"',
      "]",
      "other-key: keep-me-too",
      "---",
      "# Managed flow value"
    ].join("\n")
  ],
  [
    "concept-tagged-managed-multiline-flow-value",
    [
      "---",
      "plain-key: keep-me",
      "lain-brain-concept-aliases: !!seq [",
      '  "stale-one",',
      '  "stale-two"',
      "]",
      "other-key: keep-me-too",
      "---",
      "# Tagged managed flow value"
    ].join("\n")
  ],
  [
    "concept-document-end-frontmatter",
    [
      "---",
      "plain-key: keep-me",
      "...",
      "---",
      "# Explicit YAML document end"
    ].join("\n")
  ],
  [
    "concept-tagged-managed-key-frontmatter",
    [
      "---",
      "plain-key: keep-me",
      "!!str lain-brain-concept-id: stale-tagged-id",
      "---",
      "# Tagged managed key"
    ].join("\n")
  ],
  [
    "concept-escaped-managed-key-frontmatter",
    [
      "---",
      "plain-key: keep-me",
      '"lain-brain-concept-\\u0069d": stale-escaped-id',
      "---",
      "# Escaped managed key"
    ].join("\n")
  ]
]) {
  const unsupportedRoot = prepare({ conceptId, sourceMarkdown });
  assert.equal(unsupportedRoot.kind, "failed");
  assert.equal(unsupportedRoot.code, "invalid_draft");
}

// Comments inside an indentless managed sequence do not leave later stale
// items orphaned, while a comment belonging to the next field is retained.
const commentedSequenceSourceMarkdown = [
  "---",
  "lain-brain-concept-aliases:",
  "- stale-alias-one",
  "# stale aliases continue",
  "- stale-alias-two",
  "# preserved comment for the next key",
  "plain-key: keep-commented-value",
  "---",
  "# Commented sequence source"
].join("\n");
const commentedSequencePrepared = prepare({
  sourceMarkdown: commentedSequenceSourceMarkdown,
  conceptId: "concept-commented-indentless-sequence"
});
assert.equal(commentedSequencePrepared.kind, "prepared");
const commentedSequenceReadableMarkdown = commentedSequencePrepared.markdown.split(
  "<!-- lain-brain-concept-data:v1:"
)[0];
assert.equal(commentedSequenceReadableMarkdown.includes("stale-alias-one"), false);
assert.equal(commentedSequenceReadableMarkdown.includes("stale-alias-two"), false);
assert.equal(commentedSequenceReadableMarkdown.includes(
  "# stale aliases continue"
), false);
assert.match(commentedSequenceReadableMarkdown,
  /# preserved comment for the next key\nplain-key: keep-commented-value/u);

// A longer unmanaged YAML key that begins with a managed-key prefix must not
// be mistaken for that managed field and removed.
const managedPrefixSourceMarkdown = [
  "---",
  "lain-brain-concept-id:suffix: keep-this-unmanaged-value",
  "plain-key: keep-me",
  "---",
  "# Managed prefix source"
].join("\n");
const managedPrefixPrepared = prepare({
  sourceMarkdown: managedPrefixSourceMarkdown,
  conceptId: "concept-managed-prefix-frontmatter"
});
assert.equal(managedPrefixPrepared.kind, "prepared");
assert.match(
  managedPrefixPrepared.markdown,
  /lain-brain-concept-id:suffix: keep-this-unmanaged-value/u
);

const identityRequiredDraft = api.createConceptMigrationDraft({
  sourceVaultPath: sourcePath,
  sourceMarkdown
});
const identityRequired = api.prepareConceptMigration({
  sourceVaultPath: sourcePath,
  sourceMarkdown,
  draft: identityRequiredDraft,
  knownConcepts: [],
  preparedAt
});
assert.equal(identityRequired.kind, "failed");
assert.equal(identityRequired.code, "identity_required");
const preparationConflict = prepare({
  conceptId: existing.concept.id,
  knownConcepts: [existing.concept]
});
assert.equal(preparationConflict.kind, "failed");
assert.equal(preparationConflict.code, "conflicting_identity");

// Missing or mismatched confirmation never reaches the Vault write boundary.
const approvalFixture = makeVault([{ path: sourcePath, markdown: sourceMarkdown }]);
for (const confirmation of [
  {},
  confirmationFor(defaultPrepared, { kind: "wrong_confirmation" }),
  confirmationFor(defaultPrepared, { confirmedAt: "" }),
  confirmationFor(defaultPrepared, { migrationId: "another-migration" }),
  confirmationFor(defaultPrepared, { sourceVaultPath: "Notes/Other.md" }),
  confirmationFor(defaultPrepared, { conceptId: "concept-other" })
]) {
  const result = await api.persistConfirmedConceptMigration(approvalFixture.app, {
    prepared: defaultPrepared,
    confirmation
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "approval_required");
}
assert.equal(approvalFixture.calls.length, 0);

// A changed preview, even with the same stable ID, is not the reviewed proposal.
const tamperFixture = makeVault([{ path: sourcePath, markdown: sourceMarkdown }]);
const tampered = {
  ...defaultPrepared,
  markdown: defaultPrepared.markdown.replace("# Freedom", "# Changed preview")
};
const tamperResult = await api.persistConfirmedConceptMigration(tamperFixture.app, {
  prepared: tampered,
  confirmation: confirmationFor(tampered)
});
assert.equal(tamperResult.ok, false);
assert.equal(tamperResult.code, "invalid_prepared_projection");
assert.equal(tamperFixture.calls.length, 0);

const proposalTamperCases = [
  {
    ...defaultPrepared,
    mapping: {
      ...defaultPrepared.mapping,
      userDefinitionText: "Review text that does not match the concept."
    }
  },
  {
    ...defaultPrepared,
    diff: defaultPrepared.diff.map((item, index) => index === 0
      ? { ...item, after: "A different identity shown in the review." }
      : item)
  },
  {
    ...defaultPrepared,
    migrationId: "concept-migration:replaced-review-identity"
  },
  {
    // Collision review state is part of the confirmation identity. A clone
    // cannot erase the reviewed warning merely because the current Vault also
    // has no matching label.
    ...defaultPrepared,
    labelCollisions: []
  }
];
for (const proposalTamper of proposalTamperCases) {
  const proposalTamperFixture = makeVault([
    { path: sourcePath, markdown: sourceMarkdown }
  ]);
  const proposalTamperResult = await api.persistConfirmedConceptMigration(
    proposalTamperFixture.app,
    {
      prepared: proposalTamper,
      confirmation: confirmationFor(proposalTamper)
    }
  );
  assert.equal(proposalTamperResult.ok, false);
  assert.equal(proposalTamperResult.code, "invalid_prepared_projection");
  assert.equal(proposalTamperFixture.calls.length, 0);
}

// A self-consistent projection still cannot smuggle in revision history during
// creation. Every migrated node must begin at revision 1 with empty history.
const historyBearingConcept = api.updateConceptNode(
  defaultPrepared.concept,
  { aliases: ["tampered revision"] },
  {
    changedAt: "2026-08-16T00:00:30.000Z",
    reason: "Attempt to smuggle maintenance history into migration"
  }
);
const historyBearingPrepared = {
  ...defaultPrepared,
  concept: historyBearingConcept,
  markdown: api.serializeConceptNodeIntoMarkdown(
    defaultPrepared.sourceMarkdown,
    historyBearingConcept,
    defaultPrepared.origin
  )
};
assert.equal(api.inspectConceptMarkdown(
  historyBearingPrepared.markdown
).persisted.conceptNode.revision, 2);
const historyTamperFixture = makeVault([
  { path: sourcePath, markdown: sourceMarkdown }
]);
const historyTamperResult = await api.persistConfirmedConceptMigration(
  historyTamperFixture.app,
  {
    prepared: historyBearingPrepared,
    confirmation: confirmationFor(historyBearingPrepared)
  }
);
assert.equal(historyTamperResult.ok, false);
assert.equal(historyTamperResult.code, "invalid_prepared_projection");
assert.equal(historyTamperFixture.calls.length, 0);

// Invalid paths, missing notes, and read failures are typed and write nothing.
const pathFixture = makeVault([
  { path: "Notes/Unreadable.md", markdown: "# Unreadable", readError: true }
]);
assert.equal((await api.loadOrdinaryNoteForMigration(
  pathFixture.app,
  "../Outside.md"
)).code, "invalid_source_path");
assert.equal((await api.loadOrdinaryNoteForMigration(
  pathFixture.app,
  "Notes/Missing.md"
)).code, "source_not_found");
assert.equal((await api.loadOrdinaryNoteForMigration(
  pathFixture.app,
  "Notes/Unreadable.md"
)).code, "source_read_failed");
const invalidPathPrepared = {
  ...defaultPrepared,
  sourceVaultPath: "../Outside.md"
};
const invalidPathResult = await api.persistConfirmedConceptMigration(pathFixture.app, {
  prepared: invalidPathPrepared,
  confirmation: confirmationFor(invalidPathPrepared)
});
assert.equal(invalidPathResult.code, "invalid_source_path");
assert.equal(pathFixture.calls.length, 0);

// E: byte-level source staleness blocks before modify.
const staleFixture = makeVault([{ path: sourcePath, markdown: sourceMarkdown }]);
const stalePrepared = prepare();
staleFixture.setMarkdown(sourcePath, `${sourceMarkdown}\n`);
const staleResult = await api.persistConfirmedConceptMigration(staleFixture.app, {
  prepared: stalePrepared,
  confirmation: confirmationFor(stalePrepared)
});
assert.equal(staleResult.ok, false);
assert.equal(staleResult.code, "stale_source");
assert.equal(staleFixture.calls.length, 0);

// Confirmation bypasses Obsidian's cache. Reviewed bytes in cachedRead cannot
// hide a newer on-disk source from the final write boundary.
const sourceCacheDivergenceFixture = makeVault([
  { path: sourcePath, markdown: `${sourceMarkdown}\nChanged on disk.` }
]);
let sourceCacheReads = 0;
sourceCacheDivergenceFixture.app.vault.cachedRead = async () => {
  sourceCacheReads += 1;
  return sourceMarkdown;
};
const sourceCacheDivergenceResult =
  await api.persistConfirmedConceptMigration(
    sourceCacheDivergenceFixture.app,
    {
      prepared: stalePrepared,
      confirmation: confirmationFor(stalePrepared)
    }
  );
assert.equal(sourceCacheDivergenceResult.ok, false);
assert.equal(sourceCacheDivergenceResult.code, "stale_source");
assert.equal(sourceCacheReads, 0);
assert.equal(sourceCacheDivergenceFixture.calls.length, 0);

// The writer captures one immutable proposal before its first await. A mutable
// structural clone cannot alter reviewed collisions or output Markdown from a
// Vault read callback after projection validation.
const asyncMutationFixture = makeVault([
  { path: sourcePath, markdown: sourceMarkdown }
]);
const asyncMutationPrepared = plain(defaultPrepared);
const asyncMutationRead = asyncMutationFixture.app.vault.read;
let asyncMutationApplied = false;
asyncMutationFixture.app.vault.read = async (file) => {
  const markdown = await asyncMutationRead(file);
  if (!asyncMutationApplied) {
    asyncMutationApplied = true;
    asyncMutationPrepared.labelCollisions = [];
    asyncMutationPrepared.markdown = "# Unreviewed replacement";
  }
  return markdown;
};
const asyncMutationResult = await api.persistConfirmedConceptMigration(
  asyncMutationFixture.app,
  {
    prepared: asyncMutationPrepared,
    confirmation: confirmationFor(asyncMutationPrepared)
  }
);
assert.equal(asyncMutationApplied, true);
assert.equal(asyncMutationResult.ok, false);
assert.equal(asyncMutationResult.code, "label_collisions_changed");
assert.equal(asyncMutationFixture.calls.length, 0);
assert.equal(asyncMutationFixture.markdown(sourcePath), sourceMarkdown);

// A mutation during the confirmation-time index scan is caught by the final
// exact re-read immediately before modify.
const scanRaceFixture = makeVault([
  { path: sourcePath, markdown: sourceMarkdown }
]);
const scanRacePrepared = prepare();
const scanRaceRead = scanRaceFixture.app.vault.read;
let scanRaceSourceReads = 0;
scanRaceFixture.app.vault.read = async (file) => {
  const markdown = await scanRaceRead(file);
  if (file.path === sourcePath) {
    scanRaceSourceReads += 1;
    if (scanRaceSourceReads === 2) {
      scanRaceFixture.setMarkdown(
        sourcePath,
        `${sourceMarkdown}\nConcurrent edit during identity scan.`
      );
    }
  }
  return markdown;
};
const scanRaceResult = await api.persistConfirmedConceptMigration(
  scanRaceFixture.app,
  {
    prepared: scanRacePrepared,
    confirmation: confirmationFor(scanRacePrepared)
  }
);
assert.equal(scanRaceResult.ok, false);
assert.equal(scanRaceResult.code, "stale_source");
assert.equal(scanRaceSourceReads, 3);
assert.equal(scanRaceFixture.calls.length, 0);

// An identity introduced after the first index scan's file snapshot is
// non-colliding by itself, but it proves that the reviewed identity view moved.
// The second complete scan must detect that race before any write.
const identityRaceFixture = makeVault([
  { path: sourcePath, markdown: sourceMarkdown }
]);
const identityRacePrepared = prepare();
const identityRaceRead = identityRaceFixture.app.vault.read;
const unrelatedIdentity = candidateMarkdown(
  "concept-created-during-confirmation",
  "Unrelated concept created during confirmation"
);
let identityRaceSourceReads = 0;
identityRaceFixture.app.vault.read = async (file) => {
  const markdown = await identityRaceRead(file);
  if (file.path === sourcePath) {
    identityRaceSourceReads += 1;
    if (identityRaceSourceReads === 2) {
      identityRaceFixture.add(
        "Lain Brain/Notes/Concurrent Identity.md",
        unrelatedIdentity.markdown
      );
    }
  }
  return markdown;
};
const identityRaceResult = await api.persistConfirmedConceptMigration(
  identityRaceFixture.app,
  {
    prepared: identityRacePrepared,
    confirmation: confirmationFor(identityRacePrepared)
  }
);
assert.equal(identityRaceResult.ok, false);
assert.equal(identityRaceResult.code, "identity_check_changed");
assert.equal(identityRaceFixture.calls.length, 0);

const readStaleFixture = makeVault([{ path: sourcePath, markdown: sourceMarkdown }]);
readStaleFixture.setReadError(sourcePath, true);
const readStaleResult = await api.persistConfirmedConceptMigration(
  readStaleFixture.app,
  {
    prepared: stalePrepared,
    confirmation: confirmationFor(stalePrepared)
  }
);
assert.equal(readStaleResult.ok, false);
assert.equal(readStaleResult.code, "source_read_failed");
assert.equal(readStaleFixture.calls.length, 0);

// F: a source that became a ConceptNode cannot be migrated again.
const becameConceptFixture = makeVault([
  { path: sourcePath, markdown: sourceMarkdown }
]);
const intervening = candidateMarkdown("concept-intervening", "Freedom elsewhere");
becameConceptFixture.setMarkdown(sourcePath, intervening.markdown);
const becameConcept = await api.persistConfirmedConceptMigration(
  becameConceptFixture.app,
  {
    prepared: stalePrepared,
    confirmation: confirmationFor(stalePrepared)
  }
);
assert.equal(becameConcept.ok, false);
assert.equal(becameConcept.code, "source_not_ordinary");
assert.equal(becameConceptFixture.calls.length, 0);

// G: a stable-ID conflict appearing after preview is found by a fresh index.
const conflictFixture = makeVault([{ path: sourcePath, markdown: sourceMarkdown }]);
const lateConflict = candidateMarkdown(
  stalePrepared.concept.id,
  "A separately created concept",
  "candidate-late-conflict"
);
conflictFixture.add("Lain Brain/Notes/Late Conflict.md", lateConflict.markdown);
const conflictResult = await api.persistConfirmedConceptMigration(
  conflictFixture.app,
  {
    prepared: stalePrepared,
    confirmation: confirmationFor(stalePrepared)
  }
);
assert.equal(conflictResult.ok, false);
assert.equal(conflictResult.code, "conflicting_identity");
assert.equal(conflictFixture.calls.length, 0);

// Identity scans also bypass cachedRead. A stale cache that presents an
// on-disk conflicting concept as ordinary Markdown cannot permit migration.
const identityCacheDivergenceFixture = makeVault([
  { path: sourcePath, markdown: sourceMarkdown },
  {
    path: "Lain Brain/Notes/Disk Conflict.md",
    markdown: lateConflict.markdown
  }
]);
let identityCacheReads = 0;
identityCacheDivergenceFixture.app.vault.cachedRead = async (file) => {
  identityCacheReads += 1;
  return file.path === sourcePath ? sourceMarkdown : "# Stale ordinary cache";
};
const identityCacheDivergenceResult =
  await api.persistConfirmedConceptMigration(
    identityCacheDivergenceFixture.app,
    {
      prepared: stalePrepared,
      confirmation: confirmationFor(stalePrepared)
    }
  );
assert.equal(identityCacheDivergenceResult.ok, false);
assert.equal(identityCacheDivergenceResult.code, "conflicting_identity");
assert.equal(identityCacheReads, 0);
assert.equal(identityCacheDivergenceFixture.calls.length, 0);

// The per-App confirmation lock prevents two simultaneous reviews from
// creating the same stable identity in separate ordinary notes.
const concurrentSourcePathA = "Notes/Concurrent A.md";
const concurrentSourcePathB = "Notes/Concurrent B.md";
const concurrentSourceMarkdownA = "# Concurrent A\n\nFirst ordinary source.";
const concurrentSourceMarkdownB = "# Concurrent B\n\nSecond ordinary source.";
const concurrentFixture = makeVault([
  { path: concurrentSourcePathA, markdown: concurrentSourceMarkdownA },
  { path: concurrentSourcePathB, markdown: concurrentSourceMarkdownB }
]);
const concurrentConceptId = "concept-shared-concurrent-identity";
const concurrentPreparedA = prepare({
  sourceVaultPath: concurrentSourcePathA,
  sourceMarkdown: concurrentSourceMarkdownA,
  conceptId: concurrentConceptId
});
const concurrentPreparedB = prepare({
  sourceVaultPath: concurrentSourcePathB,
  sourceMarkdown: concurrentSourceMarkdownB,
  conceptId: concurrentConceptId
});
const concurrentResults = await Promise.all([
  api.persistConfirmedConceptMigration(concurrentFixture.app, {
    prepared: concurrentPreparedA,
    confirmation: confirmationFor(concurrentPreparedA)
  }),
  api.persistConfirmedConceptMigration(concurrentFixture.app, {
    prepared: concurrentPreparedB,
    confirmation: confirmationFor(concurrentPreparedB)
  })
]);
assert.equal(concurrentResults.filter((result) => result.ok).length, 1);
assert.equal(concurrentResults.filter(
  (result) => !result.ok && result.code === "conflicting_identity"
).length, 1);
assert.equal(concurrentFixture.calls.length, 1);
assert.equal(concurrentFixture.calls[0].operation, "modify");
const concurrentInspections = [
  api.inspectConceptMarkdown(concurrentFixture.markdown(concurrentSourcePathA)),
  api.inspectConceptMarkdown(concurrentFixture.markdown(concurrentSourcePathB))
];
assert.equal(concurrentInspections.filter(
  (inspection) => inspection.kind === "concept_node"
).length, 1);
assert.equal(concurrentInspections.filter(
  (inspection) => inspection.kind === "ordinary_markdown"
).length, 1);
const concurrentRestarted = await api.loadObsidianConceptIndex(
  concurrentFixture.app
);
assert.equal(concurrentRestarted.issues.length, 0);
assert.equal(concurrentRestarted.records.length, 1);

// A new same-label concept is not an identity merge, but it changes what the
// user reviewed and therefore requires a fresh collision review.
const labelRaceFixture = makeVault([
  { path: sourcePath, markdown: sourceMarkdown }
]);
const labelRacePrepared = prepare({
  conceptId: "concept-label-race",
  knownConcepts: []
});
assert.equal(labelRacePrepared.labelCollisions.length, 0);
const lateSameTitle = candidateMarkdown(
  "concept-distinct-same-title",
  "Freedom",
  "candidate-distinct-same-title"
);
labelRaceFixture.add(
  "Lain Brain/Notes/Late Same Title.md",
  lateSameTitle.markdown
);
const labelRaceResult = await api.persistConfirmedConceptMigration(
  labelRaceFixture.app,
  {
    prepared: labelRacePrepared,
    confirmation: confirmationFor(labelRacePrepared)
  }
);
assert.equal(labelRaceResult.ok, false);
assert.equal(labelRaceResult.code, "label_collisions_changed");
assert.equal(labelRaceFixture.calls.length, 0);

// An incomplete identity scan is also fail-closed.
const incompleteFixture = makeVault([
  { path: sourcePath, markdown: sourceMarkdown },
  { path: "Lain Brain/Notes/Unreadable.md", markdown: "# Maybe concept", readError: true }
]);
const incompleteResult = await api.persistConfirmedConceptMigration(
  incompleteFixture.app,
  {
    prepared: stalePrepared,
    confirmation: confirmationFor(stalePrepared)
  }
);
assert.equal(incompleteResult.ok, false);
assert.equal(incompleteResult.code, "identity_check_incomplete");
assert.equal(incompleteFixture.calls.length, 0);

// N: future schema markers are rejected during load, prepare, and confirmation.
const futureMarkdown = existing.markdown.replace(
  "lain-brain-concept-data:v1:",
  "lain-brain-concept-data:v9:"
);
assert.equal(api.inspectConceptMarkdown(futureMarkdown).code,
  "unsupported_schema_version");
const futurePreparation = prepare({ sourceMarkdown: futureMarkdown });
assert.equal(futurePreparation.kind, "failed");
assert.equal(futurePreparation.code, "source_unsupported_schema_version");
const futureFixture = makeVault([{ path: sourcePath, markdown: futureMarkdown }]);
assert.equal((await api.loadOrdinaryNoteForMigration(
  futureFixture.app,
  sourcePath
)).code, "source_unsupported_schema_version");
const futurePreview = {
  ...stalePrepared,
  markdown: stalePrepared.markdown.replace(
    "lain-brain-concept-data:v1:",
    "lain-brain-concept-data:v9:"
  )
};
const futurePreviewFixture = makeVault([
  { path: sourcePath, markdown: sourceMarkdown }
]);
const futurePreviewResult = await api.persistConfirmedConceptMigration(
  futurePreviewFixture.app,
  {
    prepared: futurePreview,
    confirmation: confirmationFor(futurePreview)
  }
);
assert.equal(futurePreviewResult.code, "invalid_prepared_projection");
assert.equal(futurePreviewFixture.calls.length, 0);

// Legacy candidate origins still round-trip without being reclassified.
const legacyReload = api.deserializeConceptNodeFromMarkdown(existing.markdown);
assert.deepEqual(plain(legacyReload.origin), plain(existing.origin));
const legacyReserialized = api.serializeConceptNodeIntoMarkdown(
  existing.markdown,
  legacyReload.conceptNode,
  legacyReload.origin
);
assert.deepEqual(
  plain(api.deserializeConceptNodeFromMarkdown(legacyReserialized).origin),
  plain(existing.origin)
);
assert.match(legacyReserialized,
  /lain-brain-candidate-id: "candidate-concept-existing-freedom"/u);
assert.equal(legacyReserialized.includes("lain-brain-migration-source"), false);

const unknownOriginMarkdown = existing.markdown.replace(
  /<!-- lain-brain-concept-data:v1:([^\s]+) -->/u,
  (_match, encoded) => {
    const projection = JSON.parse(decodeURIComponent(encoded));
    projection.origin = { kind: "future_origin_kind" };
    return "<!-- lain-brain-concept-data:v1:" +
      encodeURIComponent(JSON.stringify(projection)) + " -->";
  }
);
const unknownOrigin = api.inspectConceptMarkdown(unknownOriginMarkdown);
assert.equal(unknownOrigin.kind, "invalid_concept");
assert.equal(unknownOrigin.code, "invalid_concept_metadata");

// A reviewed partial unresolved excerpt remains byte-exact in its dedicated
// non-authoritative field through confirmation, deserialize, and restart.
const partialUnresolvedMaterial = sourceMarkdown.slice(
  sourceMarkdown.indexOf("external quotations,"),
  sourceMarkdown.indexOf(" Nothing here")
);
assert.equal(partialUnresolvedMaterial,
  "external quotations,\nand generated prose.");
const partialUnresolvedPrepared = prepare({
  conceptId: "concept-partial-unresolved",
  draft: { unresolvedMaterialText: partialUnresolvedMaterial }
});
assert.equal(partialUnresolvedPrepared.kind, "prepared");
assert.equal(
  partialUnresolvedPrepared.concept.unresolvedItems[0].sourceMaterial,
  partialUnresolvedMaterial
);
const partialUnresolvedFixture = makeVault([
  { path: sourcePath, markdown: sourceMarkdown }
]);
const partialUnresolvedResult = await api.persistConfirmedConceptMigration(
  partialUnresolvedFixture.app,
  {
    prepared: partialUnresolvedPrepared,
    confirmation: confirmationFor(partialUnresolvedPrepared)
  }
);
assert.equal(partialUnresolvedResult.ok, true);
assert.equal(partialUnresolvedFixture.calls.length, 1);
const partialUnresolvedReloaded = api.deserializeConceptNodeFromMarkdown(
  partialUnresolvedFixture.markdown(sourcePath)
);
assert.equal(
  partialUnresolvedReloaded.conceptNode.unresolvedItems[0].sourceMaterial,
  partialUnresolvedMaterial
);
const partialUnresolvedRestarted = await api.loadObsidianConceptIndex(
  partialUnresolvedFixture.app
);
assert.equal(partialUnresolvedRestarted.issues.length, 0);
const partialUnresolvedMatch = api.lookupConceptById(
  partialUnresolvedRestarted.index,
  partialUnresolvedPrepared.concept.id
);
assert.equal(partialUnresolvedMatch.kind, "unique_match");
assert.equal(
  partialUnresolvedMatch.match.concept.unresolvedItems[0].sourceMaterial,
  partialUnresolvedMaterial
);

// H, J, K, L, and M: same-title identity stays distinct; reviewed layers
// round-trip; confirmation modifies the original file exactly once; restart
// discovery deterministically reloads the new stable identity.
const successFixture = makeVault([
  { path: sourcePath, markdown: sourceMarkdown },
  { path: existingPath, markdown: existing.markdown }
]);
const beforeExisting = successFixture.markdown(existingPath);
const layeredPrepared = prepare({
  conceptId: "concept-personal-freedom",
  knownConcepts: [existing.concept],
  draft: {
    title: "Freedom",
    aliases: [
      " liberty ",
      "liberty",
      " freedom practice ",
      "freedom practice"
    ],
    userDefinitionText: "Freedom is choosing commitments I can stand behind.",
    userEvidenceText: "I kept this observation as evidence, not a definition.",
    generatedInterpretationText: "An AI interpretation remains non-authoritative.",
    standardDefinitionText: "An external source uses a conventional definition.",
    unresolvedMaterialText: ""
  }
});
assert.equal(layeredPrepared.kind, "prepared");
assert.equal(layeredPrepared.labelCollisions.length, 1);
assert.equal(layeredPrepared.labelCollisions[0].conceptId, existing.concept.id);
assert.equal(layeredPrepared.concept.id, "concept-personal-freedom");
assert.notEqual(layeredPrepared.concept.id, existing.concept.id);
assert.deepEqual(plain(layeredPrepared.concept.aliases), [
  "liberty",
  "freedom practice"
]);
assert.equal(layeredPrepared.concept.userDefinition.text,
  "Freedom is choosing commitments I can stand behind.");
assert.equal(layeredPrepared.concept.userDefinition.sourceRefs[0].sourceKind,
  "user_edit");
assert.match(layeredPrepared.concept.userDefinition.sourceRefs[0].editId,
  /^concept-migration:/u);
assert.equal(layeredPrepared.concept.userEvidence[0].snapshot,
  "I kept this observation as evidence, not a definition.");
assert.equal(layeredPrepared.concept.generatedInterpretations[0].text,
  "An AI interpretation remains non-authoritative.");
assert.equal(layeredPrepared.concept.standardDefinitions[0].text,
  "An external source uses a conventional definition.");
assert.equal(layeredPrepared.concept.userDefinition.text.includes("AI interpretation"),
  false);
assert.equal(layeredPrepared.concept.userDefinition.text.includes("external source"),
  false);
assert.equal(api.getConceptMeaningStatus(layeredPrepared.concept), "defined");

const successResult = await api.persistConfirmedConceptMigration(
  successFixture.app,
  {
    prepared: layeredPrepared,
    confirmation: confirmationFor(layeredPrepared)
  }
);
assert.equal(successResult.ok, true);
assert.equal(successResult.conceptId, layeredPrepared.concept.id);
assert.equal(successResult.revision, 1);
assert.deepEqual(successFixture.calls.map((call) => call.operation), ["modify"]);
assert.equal(successFixture.calls[0].path, sourcePath);
assert.equal(successFixture.markdown(existingPath), beforeExisting);

const migratedMarkdown = successFixture.markdown(sourcePath);
assert.match(migratedMarkdown, /tags:\n  - migration-source/u);
assert.match(migratedMarkdown, /custom-key: keep-me/u);
assert.match(migratedMarkdown, /# Freedom\n\nThese ordinary notes/u);
assert.match(migratedMarkdown,
  /lain-brain-migration-source: "Notes\/Freedom.md"/u);
assert.equal(migratedMarkdown.includes("lain-brain-candidate-id"), false);
const migrated = api.deserializeConceptNodeFromMarkdown(migratedMarkdown);
assert.deepEqual(plain(migrated.conceptNode), plain(layeredPrepared.concept));
assert.deepEqual(plain(migrated.origin), plain(layeredPrepared.origin));
assert.equal(migrated.origin.kind, "ordinary_markdown_migration");
assert.equal(migrated.origin.sourceVaultPath, sourcePath);
assert.equal(migrated.origin.sourceMarkdownHash,
  api.hashConceptMigrationSourceMarkdown(sourceMarkdown));

const migratedAgain = api.deserializeConceptNodeFromMarkdown(migratedMarkdown);
assert.deepEqual(plain(migratedAgain), plain(migrated));
const migrationReserialized = api.serializeConceptNodeIntoMarkdown(
  migratedMarkdown,
  migrated.conceptNode,
  migrated.origin
);
assert.deepEqual(
  plain(api.deserializeConceptNodeFromMarkdown(migrationReserialized)),
  plain(migrated)
);

const restarted = await api.loadObsidianConceptIndex(successFixture.app);
assert.equal(restarted.issues.length, 0);
assert.equal(restarted.records.length, 2);
const restartedMatch = api.lookupConceptById(
  restarted.index,
  layeredPrepared.concept.id
);
assert.equal(restartedMatch.kind, "unique_match");
assert.deepEqual(
  plain(restartedMatch.match.concept),
  plain(layeredPrepared.concept)
);
assert.equal(successFixture.calls.length, 1);

console.log(JSON.stringify({
  ordinaryInspectionWrites: inspectionFixture.calls.length,
  prepareWrites: 0,
  staleSourceWrites: staleFixture.calls.length,
  sourceBecameConceptWrites: becameConceptFixture.calls.length,
  conflictingIdentityWrites: conflictFixture.calls.length,
  labelCollisionRaceWrites: labelRaceFixture.calls.length,
  indexScanRaceWrites: scanRaceFixture.calls.length,
  sameTitleDistinctIdentity: true,
  ambiguousDefault: true,
  reviewedLayersRoundTrip: true,
  successfulModifyCalls: successFixture.calls.length,
  restartReload: restartedMatch.kind,
  futureSchemaRejected: true,
  originCompatibility: ["candidate", "ordinary_markdown_migration"],
  result: "PASS"
}, null, 2));
