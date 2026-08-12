import type {
  ActivationSeedSource,
  ActivationTarget
} from "./ActivationSeed";
import type {
  ActivationTrace,
  ActivationTraceHop,
  ActivationTraversalResult
} from "./BoundedActivationTraversal";

export type ActivatedContextSourceRole =
  | "surface_context"
  | "vault_markdown"
  | "user_evidence"
  | "provisional_semantic_interpretation";

export type ActivatedContextContentPartProvenance =
  | { readonly kind: "activation_target" }
  | {
      readonly kind: "vault_location";
      readonly vaultPath: string;
      readonly subpath?: string;
    }
  | {
      readonly kind: "episode_evidence";
      readonly episodeId: string;
      readonly evidenceIndex: number;
      readonly messageId?: string;
      readonly editId?: string;
      readonly startOffset?: number;
      readonly endOffset?: number;
    }
  | {
      readonly kind: "episode_interpretation";
      readonly episodeId: string;
      readonly semanticSpecId: string;
    };

export interface ActivatedContextContentPart {
  readonly sourceRole: ActivatedContextSourceRole;
  readonly text: string;
  readonly provenance: ActivatedContextContentPartProvenance;
  readonly truncated: boolean;
}

export interface ActivatedContextItem {
  readonly target: ActivationTarget;

  /** Accessibility/relevance copied from Stage 3, never authority. */
  readonly activation: number;

  readonly depth: number;
  readonly trace: ActivationTrace;
  readonly contentParts: readonly ActivatedContextContentPart[];
  readonly characterCount: number;
  readonly truncated: boolean;
}

export type ActivatedContextDiagnosticCode =
  | "target_missing"
  | "not_markdown"
  | "read_failed"
  | "metadata_unavailable"
  | "subpath_not_found"
  | "unsupported_subpath"
  | "episode_missing"
  | "invalid_evidence"
  | "empty_content";

export interface ActivatedContextDiagnostic {
  readonly resultIndex: number;
  readonly target: ActivationTarget;
  readonly code: ActivatedContextDiagnosticCode;
}

export interface ActivatedContextBudgetUsage {
  readonly consideredResults: number;
  readonly materializedItems: number;
  /** JavaScript UTF-16 code units, with surrogate-safe prefix cuts. */
  readonly characters: number;
  readonly noteItems: number;
  readonly semanticEpisodeItems: number;
  readonly surfaceItems: number;
  readonly omittedResults: number;
}

export interface ActivatedContextBundle {
  readonly items: readonly ActivatedContextItem[];
  readonly diagnostics: readonly ActivatedContextDiagnostic[];
  readonly budgetUsage: ActivatedContextBudgetUsage;
  /** True only when this layer's configured budgets omit or shorten content. */
  readonly truncated: boolean;
}

export interface ActivatedContextBudget {
  readonly maxItems: number;
  readonly maxCharactersPerItem: number;
  readonly maxTotalCharacters: number;
  readonly maxNoteItems: number;
  readonly maxSemanticEpisodeItems: number;
  readonly maxSurfaceItems: number;
  readonly maxContentPartsPerItem: number;
}

export const DEFAULT_ACTIVATED_CONTEXT_BUDGET:
Readonly<ActivatedContextBudget> = Object.freeze({
  maxItems: 12,
  maxCharactersPerItem: 4000,
  maxTotalCharacters: 12000,
  maxNoteItems: 8,
  maxSemanticEpisodeItems: 3,
  maxSurfaceItems: 4,
  maxContentPartsPerItem: 16
});

export type VaultActivatedTarget = Extract<
  ActivationTarget,
  { readonly kind: "vault_note" | "vault_subpath" }
>;

export interface ActivatedContextTargetResolution {
  readonly contentParts: readonly ActivatedContextContentPart[];
  readonly diagnostics?: readonly ActivatedContextDiagnosticCode[];
}

export interface ActivatedVaultContextResolverSession {
  resolveVaultTarget(
    target: Readonly<VaultActivatedTarget>
  ): Promise<ActivatedContextTargetResolution>;
}

export interface ActivatedVaultContextResolver {
  /** Begin one materialization snapshot, including its per-call read cache. */
  beginMaterialization(): ActivatedVaultContextResolverSession;
}

export interface ActivatedSemanticEpisodeContextResolverSession {
  resolveSemanticEpisode(
    episodeId: string
  ): Promise<ActivatedContextTargetResolution>;
}

export interface ActivatedSemanticEpisodeContextResolver {
  beginMaterialization(): ActivatedSemanticEpisodeContextResolverSession;
}

export interface ActivatedContextResolvers {
  readonly vault?: ActivatedVaultContextResolver;
  readonly semanticEpisode?: ActivatedSemanticEpisodeContextResolver;
}

function requireNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer.`);
  }
}

export function resolveActivatedContextBudget(
  supplied: Readonly<Partial<ActivatedContextBudget>> = {}
): Readonly<ActivatedContextBudget> {
  const budget: ActivatedContextBudget = {
    ...DEFAULT_ACTIVATED_CONTEXT_BUDGET,
    ...supplied
  };

  requireNonNegativeInteger("maxItems", budget.maxItems);
  requireNonNegativeInteger(
    "maxCharactersPerItem",
    budget.maxCharactersPerItem
  );
  requireNonNegativeInteger(
    "maxTotalCharacters",
    budget.maxTotalCharacters
  );
  requireNonNegativeInteger("maxNoteItems", budget.maxNoteItems);
  requireNonNegativeInteger(
    "maxSemanticEpisodeItems",
    budget.maxSemanticEpisodeItems
  );
  requireNonNegativeInteger("maxSurfaceItems", budget.maxSurfaceItems);
  requireNonNegativeInteger(
    "maxContentPartsPerItem",
    budget.maxContentPartsPerItem
  );

  return Object.freeze(budget);
}

function cloneTarget(target: Readonly<ActivationTarget>): ActivationTarget {
  switch (target.kind) {
    case "surface":
      return Object.freeze({ kind: "surface", text: target.text });
    case "vault_note":
      return Object.freeze({
        kind: "vault_note",
        vaultPath: target.vaultPath
      });
    case "vault_subpath":
      return Object.freeze({
        kind: "vault_subpath",
        vaultPath: target.vaultPath,
        subpath: target.subpath
      });
    case "semantic_episode":
      return Object.freeze({
        kind: "semantic_episode",
        episodeId: target.episodeId
      });
  }
}

function cloneSeedSource(
  source: Readonly<ActivationSeedSource>
): ActivationSeedSource {
  const provenance = source.provenance;
  const clonedProvenance = provenance.kind === "message"
    ? Object.freeze({
        kind: "message" as const,
        messageId: provenance.messageId
      })
    : provenance.kind === "semantic_episode"
      ? Object.freeze({
          kind: "semantic_episode" as const,
          episodeId: provenance.episodeId
        })
      : provenance.subpath === undefined
        ? Object.freeze({
            kind: "vault_location" as const,
            vaultPath: provenance.vaultPath
          })
        : Object.freeze({
            kind: "vault_location" as const,
            vaultPath: provenance.vaultPath,
            subpath: provenance.subpath
          });

  return Object.freeze({
    origin: source.origin,
    provenance: clonedProvenance
  });
}

function cloneTraceHop(
  hop: Readonly<ActivationTraceHop>
): ActivationTraceHop {
  return Object.freeze({
    type: hop.type,
    from: cloneTarget(hop.from),
    to: cloneTarget(hop.to)
  });
}

function cloneTrace(trace: Readonly<ActivationTrace>): ActivationTrace {
  return Object.freeze({
    seedTarget: cloneTarget(trace.seedTarget),
    seedSources: Object.freeze(trace.seedSources.map(cloneSeedSource)),
    hops: Object.freeze(trace.hops.map(cloneTraceHop))
  });
}

function clonePartProvenance(
  provenance: Readonly<ActivatedContextContentPartProvenance>
): ActivatedContextContentPartProvenance {
  switch (provenance.kind) {
    case "activation_target":
      return Object.freeze({ kind: "activation_target" });
    case "vault_location":
      return provenance.subpath === undefined
        ? Object.freeze({
            kind: "vault_location",
            vaultPath: provenance.vaultPath
          })
        : Object.freeze({
            kind: "vault_location",
            vaultPath: provenance.vaultPath,
            subpath: provenance.subpath
          });
    case "episode_evidence":
      return Object.freeze({
        kind: "episode_evidence",
        episodeId: provenance.episodeId,
        evidenceIndex: provenance.evidenceIndex,
        ...(provenance.messageId === undefined
          ? {} : { messageId: provenance.messageId }),
        ...(provenance.editId === undefined
          ? {} : { editId: provenance.editId }),
        ...(provenance.startOffset === undefined
          ? {} : { startOffset: provenance.startOffset }),
        ...(provenance.endOffset === undefined
          ? {} : { endOffset: provenance.endOffset })
      });
    case "episode_interpretation":
      return Object.freeze({
        kind: "episode_interpretation",
        episodeId: provenance.episodeId,
        semanticSpecId: provenance.semanticSpecId
      });
  }
}

function freezePart(
  part: Readonly<ActivatedContextContentPart>,
  text: string,
  truncated: boolean
): ActivatedContextContentPart {
  return Object.freeze({
    sourceRole: part.sourceRole,
    text,
    provenance: clonePartProvenance(part.provenance),
    truncated
  });
}

function surrogateSafePrefix(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  let end = Math.max(0, maxLength);
  if (
    end > 0 &&
    end < text.length &&
    text.charCodeAt(end - 1) >= 0xD800 &&
    text.charCodeAt(end - 1) <= 0xDBFF &&
    text.charCodeAt(end) >= 0xDC00 &&
    text.charCodeAt(end) <= 0xDFFF
  ) {
    end -= 1;
  }
  return text.slice(0, end);
}

function createDiagnostic(
  resultIndex: number,
  target: Readonly<ActivationTarget>,
  code: ActivatedContextDiagnosticCode
): ActivatedContextDiagnostic {
  return Object.freeze({
    resultIndex,
    target: cloneTarget(target),
    code
  });
}

function targetQuotaAvailable(
  target: Readonly<ActivationTarget>,
  budget: Readonly<ActivatedContextBudget>,
  counts: Readonly<{
    notes: number;
    episodes: number;
    surfaces: number;
  }>
): boolean {
  switch (target.kind) {
    case "vault_note":
    case "vault_subpath":
      return counts.notes < budget.maxNoteItems;
    case "semantic_episode":
      return counts.episodes < budget.maxSemanticEpisodeItems;
    case "surface":
      return counts.surfaces < budget.maxSurfaceItems;
  }
}

function createSurfaceResolution(
  target: Extract<ActivationTarget, { readonly kind: "surface" }>
): ActivatedContextTargetResolution {
  return Object.freeze({
    contentParts: Object.freeze([Object.freeze({
      sourceRole: "surface_context",
      text: target.text,
      provenance: Object.freeze({ kind: "activation_target" }),
      truncated: false
    })])
  });
}

function createFailedResolution(
  code: ActivatedContextDiagnosticCode
): ActivatedContextTargetResolution {
  return Object.freeze({
    contentParts: Object.freeze([]),
    diagnostics: Object.freeze([code])
  });
}

async function resolveTarget(
  target: Readonly<ActivationTarget>,
  vaultSession: ActivatedVaultContextResolverSession | undefined,
  episodeSession: ActivatedSemanticEpisodeContextResolverSession | undefined
): Promise<ActivatedContextTargetResolution> {
  switch (target.kind) {
    case "surface":
      return createSurfaceResolution(target);
    case "vault_note":
    case "vault_subpath":
      return vaultSession === undefined
        ? createFailedResolution("target_missing")
        : vaultSession.resolveVaultTarget(target);
    case "semantic_episode":
      return episodeSession === undefined
        ? createFailedResolution("episode_missing")
        : episodeSession.resolveSemanticEpisode(target.episodeId);
  }
}

/**
 * Materialize Stage 3 results in their existing order. This function performs
 * no retrieval, reranking, authority inference, persistence, or prompt work.
 */
export async function materializeActivatedContext(
  traversal: Readonly<ActivationTraversalResult>,
  resolvers: Readonly<ActivatedContextResolvers>,
  suppliedBudget: Readonly<Partial<ActivatedContextBudget>> = {}
): Promise<ActivatedContextBundle> {
  const budget = resolveActivatedContextBudget(suppliedBudget);
  const vaultSession = resolvers.vault?.beginMaterialization();
  const episodeSession = resolvers.semanticEpisode?.beginMaterialization();
  const items: ActivatedContextItem[] = [];
  const diagnostics: ActivatedContextDiagnostic[] = [];
  let characterCount = 0;
  let noteItems = 0;
  let episodeItems = 0;
  let surfaceItems = 0;
  let omittedResults = 0;
  let truncated = false;

  for (let resultIndex = 0; resultIndex < traversal.results.length; resultIndex++) {
    const result = traversal.results[resultIndex]!;
    const counts = {
      notes: noteItems,
      episodes: episodeItems,
      surfaces: surfaceItems
    };

    if (
      items.length >= budget.maxItems ||
      characterCount >= budget.maxTotalCharacters ||
      !targetQuotaAvailable(result.target, budget, counts)
    ) {
      omittedResults += 1;
      truncated = true;
      continue;
    }

    let resolution: ActivatedContextTargetResolution;
    try {
      resolution = await resolveTarget(
        result.target,
        vaultSession,
        episodeSession
      );
    } catch {
      resolution = createFailedResolution(
        result.target.kind === "semantic_episode"
          ? "episode_missing"
          : "read_failed"
      );
    }

    for (const code of resolution.diagnostics ?? []) {
      diagnostics.push(createDiagnostic(resultIndex, result.target, code));
    }

    const selectedParts = resolution.contentParts.slice(
      0,
      budget.maxContentPartsPerItem
    );
    let itemTruncated =
      resolution.contentParts.length > selectedParts.length;
    let itemCharacters = 0;
    const contentParts: ActivatedContextContentPart[] = [];

    for (const part of selectedParts) {
      const itemRemaining = budget.maxCharactersPerItem - itemCharacters;
      const totalRemaining = budget.maxTotalCharacters - characterCount;
      const allowed = Math.max(0, Math.min(itemRemaining, totalRemaining));
      const text = surrogateSafePrefix(part.text, allowed);
      const partTruncated = part.truncated || text.length < part.text.length;

      if (partTruncated) {
        itemTruncated = true;
      }
      if (text.length > 0) {
        contentParts.push(freezePart(part, text, partTruncated));
        itemCharacters += text.length;
        characterCount += text.length;
      }
      if (text.length < part.text.length) {
        break;
      }
    }

    if (itemTruncated) {
      truncated = true;
    }

    if (contentParts.length === 0) {
      omittedResults += 1;
      if (
        (resolution.diagnostics ?? []).length === 0 &&
        !(resolution.diagnostics ?? []).includes("empty_content")
      ) {
        diagnostics.push(createDiagnostic(
          resultIndex,
          result.target,
          "empty_content"
        ));
      }
      continue;
    }

    items.push(Object.freeze({
      target: cloneTarget(result.target),
      activation: result.activation,
      depth: result.depth,
      trace: cloneTrace(result.trace),
      contentParts: Object.freeze(contentParts),
      characterCount: itemCharacters,
      truncated: itemTruncated
    }));

    switch (result.target.kind) {
      case "vault_note":
      case "vault_subpath":
        noteItems += 1;
        break;
      case "semantic_episode":
        episodeItems += 1;
        break;
      case "surface":
        surfaceItems += 1;
        break;
    }
  }

  const budgetUsage: ActivatedContextBudgetUsage = Object.freeze({
    consideredResults: traversal.results.length,
    materializedItems: items.length,
    characters: characterCount,
    noteItems,
    semanticEpisodeItems: episodeItems,
    surfaceItems,
    omittedResults
  });

  return Object.freeze({
    items: Object.freeze(items),
    diagnostics: Object.freeze(diagnostics),
    budgetUsage,
    truncated
  });
}
