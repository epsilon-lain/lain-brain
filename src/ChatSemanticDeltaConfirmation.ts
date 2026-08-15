import type { App } from "obsidian";
import {
  createConceptNode,
  removeConceptRelationship,
  resolveConceptUnresolvedItem,
  updateConceptNode,
  type ConceptNode,
  type ConceptRelationship,
  type ConceptUnresolvedItem,
  type ConceptUserDefinition
} from "./BrainGrowth";
import {
  serializeConceptNodeIntoMarkdown,
  type ConceptPersistenceOrigin
} from "./BrainGrowthPersistence";
import { preparePersistedConceptUpdate } from "./BrainMaintenance";
import {
  DEFAULT_CANDIDATE_NOTE_FOLDER,
  suggestCandidateFileName,
  validateCandidateNotePath
} from "./CandidateNoteVault";
import {
  CHAT_DISTINCTION_RELATION,
  CHAT_STRUCTURAL_RELATION_TYPES,
  type ChatSemanticDeltaProposal,
  type ChatSemanticDeltaProposalTarget,
  type ChatStructuralRelationType
} from "./ChatSemanticDelta";
import type { UserTextProvenance } from "./KnowledgeProtocol";
import {
  confirmSemanticDelta,
  proposePrincipalSemanticDelta,
  type ConfirmedSemanticDelta
} from "./SemanticDelta";
import {
  loadConceptForMaintenance,
  persistConfirmedConceptUpdate
} from "./ObsidianConceptMaintenance";

export interface ChatSemanticDeltaPropagationPort {
  recordConfirmedDelta(
    delta: Readonly<ConfirmedSemanticDelta>,
    originVaultPath: string
  ): Promise<boolean>;
  markOriginWriteFailed(deltaId: string): Promise<void>;
  markOriginCommittedAndEnqueue(deltaId: string): Promise<void>;
}

export type ConfirmChatSemanticDeltaResult =
  | {
      readonly ok: true;
      readonly delta: ConfirmedSemanticDelta;
      readonly conceptId: string;
      readonly vaultPath: string;
      readonly propagationQueued: boolean;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

function userDefinition(
  proposal: Readonly<ChatSemanticDeltaProposal>,
  meaning: string
): ConceptUserDefinition {
  return Object.freeze({
    id: `chat-definition:${proposal.fingerprint}`,
    text: meaning,
    // The reviewed card text is the exact authoritative definition. Earlier
    // message spans remain userEvidence and confirmation provenance; joining
    // them here would falsely claim their concatenation equals this definition.
    sourceRefs: Object.freeze([Object.freeze({
      sourceKind: "user_edit" as const,
      editId: `chat-semantic-confirmation:${proposal.id}`,
      snapshot: meaning,
      actor: "user" as const
    })])
  });
}

function confirmPreparedDelta(
  proposal: Readonly<ChatSemanticDeltaProposal>,
  previous: Parameters<typeof proposePrincipalSemanticDelta>[0]["previous"],
  next: Parameters<typeof proposePrincipalSemanticDelta>[0]["next"],
  confirmedAt: string,
  confirmationEvidence: readonly UserTextProvenance[],
  reviewedText: string
): ConfirmedSemanticDelta | undefined {
  const proposed = proposePrincipalSemanticDelta({
    previous,
    next,
    proposedAt: proposal.createdAt,
    originRef: `chat:${proposal.sourceMessageIds.join(",")}`,
    reason: proposal.reason,
    proposalConfidence: proposal.confidence
  });
  if (proposed.kind !== "proposed") {
    return undefined;
  }
  const confirmed = confirmSemanticDelta(proposed.delta, {
    kind: "explicit_semantic_delta_confirmation",
    confirmedAt,
    confirmation: {
      kind: "chat_confirmation",
      confirmationId: `chat-confirmation:${proposal.id}`,
      interactionRef: `chat:${proposal.sourceMessageIds.join(",")}`,
      userEvidence: [
        ...proposal.evidence,
        ...confirmationEvidence,
        {
          sourceKind: "user_edit",
          editId: `chat-semantic-confirmation:${proposal.id}`,
          snapshot: reviewedText,
          actor: "user"
        }
      ]
    }
  });
  return confirmed.kind === "confirmed" ? confirmed.delta : undefined;
}

async function markFailedQuietly(
  propagation: ChatSemanticDeltaPropagationPort,
  deltaId: string
): Promise<void> {
  try {
    await propagation.markOriginWriteFailed(deltaId);
  } catch {
    // The persisted awaiting job is conservatively recovered on reload.
  }
}

async function enqueueQuietly(
  propagation: ChatSemanticDeltaPropagationPort,
  deltaId: string
): Promise<boolean> {
  try {
    await propagation.markOriginCommittedAndEnqueue(deltaId);
    return true;
  } catch {
    return false;
  }
}

async function ensureVaultFolder(app: App, folderPath: string): Promise<void> {
  const segments = folderPath.split("/");
  let current = "";
  for (const segment of segments) {
    current = current === "" ? segment : `${current}/${segment}`;
    const existing = app.vault.getAbstractFileByPath(current);
    if (existing === null) {
      await app.vault.createFolder(current);
    } else if (app.vault.getFolderByPath(current) === null) {
      throw new Error("invalid-folder");
    }
  }
}

async function confirmKnownConcept(
  app: App,
  propagation: ChatSemanticDeltaPropagationPort,
  proposal: Readonly<ChatSemanticDeltaProposal>,
  meaning: string,
  confirmedAt: string,
  confirmationEvidence: readonly UserTextProvenance[]
): Promise<ConfirmChatSemanticDeltaResult> {
  if (proposal.target.kind !== "known_concept") {
    return { ok: false, error: "Choose one concept before confirming." };
  }
  const loaded = await loadConceptForMaintenance(app, proposal.target.vaultPath);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }
  const current = loaded.persisted.conceptNode;
  if (
    current.id !== proposal.target.conceptId ||
    current.revision !== proposal.target.revision
  ) {
    return {
      ok: false,
      error: "The concept changed. Review this semantic change again."
    };
  }
  const prepared = preparePersistedConceptUpdate(loaded.markdown, {
    approval: { kind: "confirmed_concept_update", approvedAt: confirmedAt },
    conceptId: current.id,
    expectedRevision: current.revision,
    update: {
      userDefinition: userDefinition(proposal, meaning),
      userDefinitionMode: "explicit_user_redefinition"
    },
    change: {
      changedAt: confirmedAt,
      reason: `Explicit Chat semantic confirmation ${proposal.id}`
    }
  });
  if (prepared.kind !== "updated") {
    return {
      ok: false,
      error: prepared.kind === "failed"
        ? prepared.message
        : "The confirmed meaning does not change this concept."
    };
  }
  const delta = confirmPreparedDelta(
    proposal,
    prepared.previous,
    prepared.concept,
    confirmedAt,
    confirmationEvidence,
    meaning
  );
  if (delta === undefined) {
    return { ok: false, error: "The semantic change could not be confirmed." };
  }
  if (!await propagation.recordConfirmedDelta(delta, loaded.vaultPath)) {
    return {
      ok: false,
      error: "Semantic change could not be persisted; the concept was not changed."
    };
  }
  const write = await persistConfirmedConceptUpdate(app, {
    vaultPath: loaded.vaultPath,
    conceptId: current.id,
    expectedRevision: current.revision,
    expectedMarkdown: loaded.markdown,
    preparedMarkdown: prepared.markdown
  });
  if (!write.ok) {
    await markFailedQuietly(propagation, delta.id);
    return { ok: false, error: write.error };
  }
  return {
    ok: true,
    delta,
    conceptId: current.id,
    vaultPath: loaded.vaultPath,
    propagationQueued: await enqueueQuietly(propagation, delta.id)
  };
}

async function confirmNewConcept(
  app: App,
  propagation: ChatSemanticDeltaPropagationPort,
  proposal: Readonly<ChatSemanticDeltaProposal>,
  meaning: string,
  confirmedAt: string,
  confirmationEvidence: readonly UserTextProvenance[]
): Promise<ConfirmChatSemanticDeltaResult> {
  if (proposal.target.kind !== "new_concept") {
    return { ok: false, error: "The new concept proposal is unavailable." };
  }
  const title = proposal.target.suggestedTitle.trim();
  const path = validateCandidateNotePath(
    suggestCandidateFileName(title),
    DEFAULT_CANDIDATE_NOTE_FOLDER
  );
  if (!path.ok) {
    return { ok: false, error: path.error };
  }
  if (app.vault.getAbstractFileByPath(path.vaultPath) !== null) {
    return {
      ok: false,
      error: "A note with this concept name already exists."
    };
  }
  const conceptId = `concept:chat-${proposal.fingerprint}`;
  const base = createConceptNode({
    id: conceptId,
    title,
    userEvidence: proposal.evidence,
    createdAt: confirmedAt
  });
  const concept = updateConceptNode(base, {
    userDefinition: userDefinition(proposal, meaning),
    userDefinitionMode: "explicit_user_redefinition"
  }, {
    changedAt: confirmedAt,
    reason: `Explicit Chat semantic confirmation ${proposal.id}`
  });
  const delta = confirmPreparedDelta(
    proposal,
    base,
    concept,
    confirmedAt,
    confirmationEvidence,
    meaning
  );
  if (delta === undefined) {
    return { ok: false, error: "The new semantic concept could not be confirmed." };
  }
  if (!await propagation.recordConfirmedDelta(delta, path.vaultPath)) {
    return {
      ok: false,
      error: "Semantic change could not be persisted; no concept note was created."
    };
  }
  const readable = `# ${title}\n\n${meaning}`;
  const markdown = serializeConceptNodeIntoMarkdown(readable, concept, {
    candidateId: proposal.id,
    candidateRevision: 0,
    approvedAt: confirmedAt
  });
  try {
    await ensureVaultFolder(app, path.folderPath);
    if (app.vault.getAbstractFileByPath(path.vaultPath) !== null) {
      await markFailedQuietly(propagation, delta.id);
      return {
        ok: false,
        error: "A note with this concept name already exists."
      };
    }
    await app.vault.create(path.vaultPath, markdown);
  } catch {
    await markFailedQuietly(propagation, delta.id);
    return { ok: false, error: "Vault write failed" };
  }
  return {
    ok: true,
    delta,
    conceptId,
    vaultPath: path.vaultPath,
    propagationQueued: await enqueueQuietly(propagation, delta.id)
  };
}

interface ResolvedStructuralParticipant {
  readonly concept: ConceptNode;
  readonly vaultPath: string;
  readonly markdown?: string;
  readonly persistenceOrigin?: ConceptPersistenceOrigin;
  readonly isNew: boolean;
}

function stableStructuralHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function relationTypeIsAllowed(
  value: string | undefined
): value is ChatStructuralRelationType | typeof CHAT_DISTINCTION_RELATION {
  return value === CHAT_DISTINCTION_RELATION ||
    CHAT_STRUCTURAL_RELATION_TYPES.includes(
      value as ChatStructuralRelationType
    );
}

async function resolveStructuralParticipant(
  app: App,
  proposal: Readonly<ChatSemanticDeltaProposal>,
  target: Readonly<ChatSemanticDeltaProposalTarget>,
  confirmedAt: string
): Promise<ResolvedStructuralParticipant | undefined> {
  if (target.kind === "ambiguous_concept") return undefined;
  if (target.kind === "known_concept") {
    const loaded = await loadConceptForMaintenance(app, target.vaultPath);
    if (!loaded.ok) return undefined;
    const concept = loaded.persisted.conceptNode;
    if (
      concept.id !== target.conceptId ||
      concept.revision !== target.revision
    ) {
      return undefined;
    }
    return {
      concept,
      vaultPath: loaded.vaultPath,
      markdown: loaded.markdown,
      persistenceOrigin: loaded.persisted.origin,
      isNew: false
    };
  }
  const title = target.suggestedTitle.trim();
  const path = validateCandidateNotePath(
    suggestCandidateFileName(title),
    DEFAULT_CANDIDATE_NOTE_FOLDER
  );
  if (!path.ok || app.vault.getAbstractFileByPath(path.vaultPath) !== null) {
    return undefined;
  }
  return {
    concept: createConceptNode({
      id: `concept:chat-${proposal.fingerprint}-${stableStructuralHash(title)}`,
      title,
      userEvidence: proposal.evidence,
      createdAt: confirmedAt
    }),
    vaultPath: path.vaultPath,
    isNew: true
  };
}

function structuralRelationship(
  proposal: Readonly<ChatSemanticDeltaProposal>,
  target: Readonly<ConceptNode>
): ConceptRelationship | undefined {
  if (!relationTypeIsAllowed(proposal.relationType)) return undefined;
  return {
    id: `chat-relationship:${stableStructuralHash([
      proposal.fingerprint,
      proposal.relationType,
      target.id
    ].join("\u0000"))}`,
    relation: proposal.relationType,
    targetConceptId: target.id,
    targetLabel: target.title,
    sourceReferences: [
      `chat-confirmation:${proposal.id}`,
      ...proposal.sourceMessageIds.map((id) => `chat-message:${id}`)
    ]
  };
}

function exactAmbiguityItem(
  concept: Readonly<ConceptNode>,
  proposal: Readonly<ChatSemanticDeltaProposal>
): ConceptUnresolvedItem | undefined {
  const label = proposal.ambiguityLabel?.normalize("NFKC").trim()
    .toLocaleLowerCase();
  if (label === undefined || label === "") return undefined;
  const matches = concept.unresolvedItems.filter((item) =>
    item.status === "open" &&
    (item.kind === "meaning" || item.kind === "interpretation_conflict") &&
    (
      item.text.normalize("NFKC").trim().toLocaleLowerCase() === label ||
      item.alternatives.some((alternative) =>
        alternative.normalize("NFKC").trim().toLocaleLowerCase() === label
      )
    )
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function applyStructuralChange(
  proposal: Readonly<ChatSemanticDeltaProposal>,
  source: Readonly<ConceptNode>,
  target: Readonly<ConceptNode>,
  reviewedText: string,
  confirmedAt: string
): ConceptNode | undefined {
  const change = {
    changedAt: confirmedAt,
    reason: `Explicit Chat semantic confirmation ${proposal.id}`
  };
  if (proposal.changeKind === "ambiguity_resolved") {
    const unresolved = exactAmbiguityItem(source, proposal);
    return unresolved === undefined
      ? undefined
      : resolveConceptUnresolvedItem(
          source,
          unresolved.id,
          `${target.id}: ${reviewedText}`,
          change
        );
  }
  if (proposal.changeKind === "relationship_removed") {
    if (!relationTypeIsAllowed(proposal.relationType)) return undefined;
    const matches = source.relationships.filter((relationship) =>
      relationship.relation === proposal.relationType &&
      relationship.targetConceptId === target.id
    );
    return matches.length === 1
      ? removeConceptRelationship(source, matches[0]!.id, change)
      : undefined;
  }
  if (
    proposal.changeKind !== "relationship_confirmed" &&
    proposal.changeKind !== "concept_distinction"
  ) {
    return undefined;
  }
  const relationship = structuralRelationship(proposal, target);
  if (relationship === undefined) return undefined;
  return updateConceptNode(source, {
    relationships: [relationship],
    userEvidence: proposal.evidence
  }, change);
}

async function createConfirmedParticipant(
  app: App,
  participant: Readonly<ResolvedStructuralParticipant>,
  concept: Readonly<ConceptNode>,
  proposal: Readonly<ChatSemanticDeltaProposal>,
  confirmedAt: string
): Promise<void> {
  const slash = participant.vaultPath.lastIndexOf("/");
  const folder = slash < 0 ? "" : participant.vaultPath.slice(0, slash);
  if (folder !== "") await ensureVaultFolder(app, folder);
  if (app.vault.getAbstractFileByPath(participant.vaultPath) !== null) {
    throw new Error("concept-collision");
  }
  await app.vault.create(
    participant.vaultPath,
    serializeConceptNodeIntoMarkdown(`# ${concept.title}`, concept, {
      candidateId: proposal.id,
      candidateRevision: 0,
      approvedAt: confirmedAt
    })
  );
}

async function rollbackCreatedParticipants(
  app: App,
  createdPaths: readonly string[]
): Promise<void> {
  for (const path of [...createdPaths].reverse()) {
    try {
      const file = app.vault.getFileByPath(path);
      if (file !== null) await app.vault.trash(file, false);
    } catch {
      // Only files created by this failed confirmed operation are attempted.
    }
  }
}

async function confirmStructuralChange(
  app: App,
  propagation: ChatSemanticDeltaPropagationPort,
  proposal: Readonly<ChatSemanticDeltaProposal>,
  reviewedText: string,
  confirmedAt: string,
  confirmationEvidence: readonly UserTextProvenance[]
): Promise<ConfirmChatSemanticDeltaResult> {
  if (proposal.secondaryTarget === undefined) {
    return { ok: false, error: "The structural target is unavailable." };
  }
  const source = await resolveStructuralParticipant(
    app, proposal, proposal.target, confirmedAt
  );
  const target = await resolveStructuralParticipant(
    app, proposal, proposal.secondaryTarget, confirmedAt
  );
  if (source === undefined || target === undefined) {
    return {
      ok: false,
      error: "A concept changed or is unavailable. Review this semantic change again."
    };
  }
  if (source.concept.id === target.concept.id) {
    return {
      ok: false,
      error: "A structural change requires two distinct concepts."
    };
  }
  const next = applyStructuralChange(
    proposal,
    source.concept,
    target.concept,
    reviewedText,
    confirmedAt
  );
  if (next === undefined || next === source.concept) {
    return {
      ok: false,
      error: "The confirmed structural change is unavailable or already recorded."
    };
  }
  const delta = confirmPreparedDelta(
    proposal,
    source.concept,
    next,
    confirmedAt,
    confirmationEvidence,
    reviewedText
  );
  if (delta === undefined) {
    return {
      ok: false,
      error: "The structural semantic change could not be confirmed."
    };
  }
  if (!await propagation.recordConfirmedDelta(delta, source.vaultPath)) {
    return {
      ok: false,
      error: "Semantic change could not be persisted; no concept was changed."
    };
  }

  const createdPaths: string[] = [];
  try {
    if (target.isNew) {
      await createConfirmedParticipant(
        app, target, target.concept, proposal, confirmedAt
      );
      createdPaths.push(target.vaultPath);
    }
    if (source.isNew) {
      await createConfirmedParticipant(app, source, next, proposal, confirmedAt);
      createdPaths.push(source.vaultPath);
    } else {
      const preparedMarkdown = serializeConceptNodeIntoMarkdown(
        source.markdown!,
        next,
        source.persistenceOrigin!
      );
      const write = await persistConfirmedConceptUpdate(app, {
        vaultPath: source.vaultPath,
        conceptId: source.concept.id,
        expectedRevision: source.concept.revision,
        expectedMarkdown: source.markdown!,
        preparedMarkdown
      });
      if (!write.ok) throw new Error("origin-write-failed");
    }
  } catch {
    await rollbackCreatedParticipants(app, createdPaths);
    await markFailedQuietly(propagation, delta.id);
    return { ok: false, error: "Vault write failed" };
  }

  return {
    ok: true,
    delta,
    conceptId: source.concept.id,
    vaultPath: source.vaultPath,
    propagationQueued: await enqueueQuietly(propagation, delta.id)
  };
}

/** The only Chat proposal -> authoritative delta adapter. */
export async function confirmChatSemanticDelta(
  app: App,
  propagation: ChatSemanticDeltaPropagationPort,
  proposal: Readonly<ChatSemanticDeltaProposal>,
  editedMeaning: string,
  confirmedAt: string,
  confirmationEvidence: readonly UserTextProvenance[] = []
): Promise<ConfirmChatSemanticDeltaResult> {
  if (proposal.status !== "active") {
    return { ok: false, error: "This semantic proposal is no longer active." };
  }
  const meaning = editedMeaning.trim();
  if (
    meaning === "" || meaning.length > 4000 ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(meaning)
  ) {
    return { ok: false, error: "The confirmed meaning is invalid." };
  }
  if (
    proposal.target.kind === "ambiguous_concept" ||
    proposal.secondaryTarget?.kind === "ambiguous_concept"
  ) {
    return { ok: false, error: "Choose one concept before confirming." };
  }
  if (proposal.changeKind !== "personal_definition") {
    return confirmStructuralChange(
      app,
      propagation,
      proposal,
      meaning,
      confirmedAt,
      confirmationEvidence
    );
  }
  return proposal.target.kind === "known_concept"
    ? confirmKnownConcept(
        app,
        propagation,
        proposal,
        meaning,
        confirmedAt,
        confirmationEvidence
      )
    : confirmNewConcept(
        app,
        propagation,
        proposal,
        meaning,
        confirmedAt,
        confirmationEvidence
      );
}
