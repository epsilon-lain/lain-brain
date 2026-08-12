import type { App } from "obsidian";

import type {
  ActivationSeed,
  ActivationSeedProvenance,
  ActivationSeedSource,
  ActivationTarget
} from "./ActivationSeed";
import {
  materializeActivatedContext,
  type ActivatedContextBudget,
  type ActivatedContextBundle,
  type ActivatedContextContentPartProvenance,
  type ActivatedSemanticEpisodeContextResolver
} from "./ActivatedContextMaterialization";
import type {
  ActivationTraversalBudget,
  ActivationTraversalResult
} from "./BoundedActivationTraversal";
import { createObsidianActivatedContextResolver } from
  "./ObsidianActivatedContextResolver";
import { traverseObsidianActivation } from "./ObsidianActivationAdjacency";

export interface ObsidianActivatedContextInspectionOptions {
  /** Explicit roots selected by the caller; this helper performs no retrieval. */
  readonly extraSeeds?: readonly ActivationSeed[];
  readonly traversalBudget?: Readonly<Partial<ActivationTraversalBudget>>;
  readonly materializationBudget?: Readonly<Partial<ActivatedContextBudget>>;
  /** Optional exact-ID adapter for already-selected semantic episodes. */
  readonly semanticEpisodeResolver?: ActivatedSemanticEpisodeContextResolver;
}

export interface ActivatedContextInspection {
  readonly traversal: ActivationTraversalResult;
  readonly contextBundle: ActivatedContextBundle;
}

/**
 * Run the existing Stage 4A -> Stage 3 -> Stage 4B pipeline once against a
 * live Obsidian App. The result is ephemeral and is never sent to a prompt,
 * persisted, or installed as a background listener.
 */
export async function inspectActivatedContext(
  app: App,
  options: Readonly<ObsidianActivatedContextInspectionOptions> = {}
): Promise<ActivatedContextInspection> {
  const traversal = traverseObsidianActivation(app, {
    ...(options.extraSeeds === undefined
      ? {} : { extraSeeds: options.extraSeeds }),
    ...(options.traversalBudget === undefined
      ? {} : { budget: options.traversalBudget })
  });
  const contextBundle = await materializeActivatedContext(
    traversal,
    {
      vault: createObsidianActivatedContextResolver(app),
      ...(options.semanticEpisodeResolver === undefined
        ? {} : { semanticEpisode: options.semanticEpisodeResolver })
    },
    options.materializationBudget ?? {}
  );

  return Object.freeze({ traversal, contextBundle });
}

function isAbsolutePath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/u.test(value);
}

function displayVaultPath(vaultPath: string): string {
  return isAbsolutePath(vaultPath)
    ? "[absolute-path-redacted]"
    : vaultPath;
}

function displayTarget(target: Readonly<ActivationTarget>): string {
  switch (target.kind) {
    case "surface":
      // Do not echo arbitrary user text or other surface content in debug logs.
      return `surface(length=${target.text.length})`;
    case "vault_note":
      return `vault_note:${displayVaultPath(target.vaultPath)}`;
    case "vault_subpath":
      return `vault_subpath:${displayVaultPath(target.vaultPath)}` +
        target.subpath;
    case "semantic_episode":
      return `semantic_episode:${target.episodeId}`;
  }
}

function displaySeedProvenance(
  provenance: Readonly<ActivationSeedProvenance>
): string {
  switch (provenance.kind) {
    case "message":
      return `message:${provenance.messageId}`;
    case "vault_location":
      return `vault_location:${displayVaultPath(provenance.vaultPath)}` +
        (provenance.subpath ?? "");
    case "semantic_episode":
      return `semantic_episode:${provenance.episodeId}`;
  }
}

function displaySeedSource(source: Readonly<ActivationSeedSource>): string {
  return `${source.origin}@${displaySeedProvenance(source.provenance)}`;
}

function displayPartProvenance(
  provenance: Readonly<ActivatedContextContentPartProvenance>
): string {
  switch (provenance.kind) {
    case "activation_target":
      return "activation_target";
    case "vault_location":
      return `vault_location:${displayVaultPath(provenance.vaultPath)}` +
        (provenance.subpath ?? "");
    case "episode_evidence":
      return `episode_evidence:${provenance.episodeId}` +
        `#${provenance.evidenceIndex}`;
    case "episode_interpretation":
      return `episode_interpretation:${provenance.episodeId}` +
        `#${provenance.semanticSpecId}`;
  }
}

/**
 * Deterministic, content-minimal representation for development inspection.
 * It reports activation/accessibility metadata and source roles, never content
 * bodies, credentials, prompts, stack traces, or host filesystem locations.
 */
export function formatActivatedContextInspection(
  inspection: Readonly<ActivatedContextInspection>
): string {
  const lines: string[] = [
    "Activated context inspection",
    `Traversal: results=${inspection.traversal.results.length}` +
      ` visited=${inspection.traversal.visitedTargets}` +
      ` expanded=${inspection.traversal.expandedTargets}` +
      ` truncated=${inspection.traversal.truncated}`
  ];

  for (let index = 0; index < inspection.traversal.results.length; index++) {
    const result = inspection.traversal.results[index]!;
    lines.push(
      `Result ${index}: target=${displayTarget(result.target)}` +
        ` activation=${result.activation.toFixed(3)} depth=${result.depth}`,
      `  winningTrace.seed=${displayTarget(result.trace.seedTarget)}` +
        ` sources=${result.trace.seedSources.map(displaySeedSource).join(",")}`
    );
    if (result.trace.hops.length === 0) {
      lines.push("  winningTrace.hops=(root)");
    } else {
      for (let hopIndex = 0; hopIndex < result.trace.hops.length; hopIndex++) {
        const hop = result.trace.hops[hopIndex]!;
        lines.push(
          `  winningTrace.hop.${hopIndex}=${hop.type}` +
            ` ${displayTarget(hop.from)} -> ${displayTarget(hop.to)}`
        );
      }
    }
  }

  lines.push(
    `ContextBundle: items=${inspection.contextBundle.items.length}` +
      ` truncated=${inspection.contextBundle.truncated}`,
    `BudgetUsage: consideredResults=` +
      `${inspection.contextBundle.budgetUsage.consideredResults}` +
      ` materializedItems=` +
      `${inspection.contextBundle.budgetUsage.materializedItems}` +
      ` characters=${inspection.contextBundle.budgetUsage.characters}` +
      ` noteItems=${inspection.contextBundle.budgetUsage.noteItems}` +
      ` semanticEpisodeItems=` +
      `${inspection.contextBundle.budgetUsage.semanticEpisodeItems}` +
      ` surfaceItems=${inspection.contextBundle.budgetUsage.surfaceItems}` +
      ` omittedResults=${inspection.contextBundle.budgetUsage.omittedResults}`
  );
  for (let index = 0; index < inspection.contextBundle.items.length; index++) {
    const item = inspection.contextBundle.items[index]!;
    lines.push(
      `Item ${index}: target=${displayTarget(item.target)}` +
        ` activation=${item.activation.toFixed(3)} depth=${item.depth}` +
        ` truncated=${item.truncated}`
    );
    for (let partIndex = 0; partIndex < item.contentParts.length; partIndex++) {
      const part = item.contentParts[partIndex]!;
      lines.push(
        `  part.${partIndex} sourceRole=${part.sourceRole}` +
          ` characters=${part.text.length}` +
          ` truncated=${part.truncated}` +
          ` provenance=${displayPartProvenance(part.provenance)}`
      );
    }
  }

  lines.push(`Diagnostics: count=${inspection.contextBundle.diagnostics.length}`);
  for (const diagnostic of inspection.contextBundle.diagnostics) {
    lines.push(
      `  result=${diagnostic.resultIndex}` +
        ` target=${displayTarget(diagnostic.target)}` +
        ` code=${diagnostic.code}`
    );
  }

  return lines.join("\n");
}
