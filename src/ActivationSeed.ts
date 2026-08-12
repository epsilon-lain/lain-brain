import { normalizePath } from "obsidian";

import type { SemanticPriorEpisode } from "./SemanticPrior";

/**
 * Describes why a target is accessible in the current context.
 * Origins carry no truth, confidence, or authority semantics.
 */
export type ActivationSeedOrigin =
  | "current_utterance"
  | "semantic_query"
  | "active_note"
  | "active_heading"
  | "selected_text"
  | "wikilink"
  | "backlink"
  | "note_metadata"
  | "recent_semantic_context"
  | "semantic_prior";

/** A context target that may become relevant to later activation traversal. */
export type ActivationTarget =
  | { readonly kind: "surface"; readonly text: string }
  | { readonly kind: "vault_note"; readonly vaultPath: string }
  | {
      readonly kind: "vault_subpath";
      readonly vaultPath: string;
      readonly subpath: string;
    }
  | {
      readonly kind: "semantic_episode";
      readonly episodeId: string;
    };

/** The concrete source location from which an activation source was derived. */
export type ActivationSeedProvenance =
  | {
      readonly kind: "message";
      readonly messageId: string;
    }
  | {
      readonly kind: "vault_location";
      readonly vaultPath: string;
      readonly subpath?: string;
    }
  | {
      readonly kind: "semantic_episode";
      readonly episodeId: string;
    };

export interface ActivationSeedSource {
  readonly origin: ActivationSeedOrigin;
  readonly provenance: ActivationSeedProvenance;
}

/**
 * One normalized target with every distinct reason it is currently accessible.
 * Multiple sources do not imply greater truth or authority.
 */
export interface ActivationSeed {
  readonly target: ActivationTarget;
  readonly sources: readonly ActivationSeedSource[];
}

/** An ephemeral snapshot of the current activation entry points. */
export interface ActivationSeedSet {
  readonly seeds: readonly ActivationSeed[];
}

function normalizeSurfaceForKey(text: string): string {
  return text.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function normalizeVaultPath(vaultPath: string): string {
  return normalizePath(vaultPath.trim());
}

function normalizeSubpath(subpath: string): string {
  return subpath.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

/** Stable comparison key for a target. It is not a persisted identity. */
export function activationTargetKey(target: ActivationTarget): string {
  switch (target.kind) {
    case "surface":
      return JSON.stringify(["surface", normalizeSurfaceForKey(target.text)]);
    case "vault_note":
      return JSON.stringify([
        "vault_note",
        normalizeVaultPath(target.vaultPath)
      ]);
    case "vault_subpath":
      return JSON.stringify([
        "vault_subpath",
        normalizeVaultPath(target.vaultPath),
        normalizeSubpath(target.subpath)
      ]);
    case "semantic_episode":
      return JSON.stringify(["semantic_episode", target.episodeId]);
  }
}

/** Stable comparison key for a source. It is not a persisted identity. */
export function activationSeedSourceKey(
  source: ActivationSeedSource
): string {
  const provenance = source.provenance;

  switch (provenance.kind) {
    case "message":
      return JSON.stringify([
        source.origin,
        "message",
        provenance.messageId
      ]);
    case "vault_location":
      return JSON.stringify([
        source.origin,
        "vault_location",
        normalizeVaultPath(provenance.vaultPath),
        provenance.subpath === undefined
          ? null
          : normalizeSubpath(provenance.subpath)
      ]);
    case "semantic_episode":
      return JSON.stringify([
        source.origin,
        "semantic_episode",
        provenance.episodeId
      ]);
  }
}

function cloneTarget(target: ActivationTarget): ActivationTarget {
  switch (target.kind) {
    case "surface":
      // Surface normalization is comparison-only. Preserve the first text.
      return Object.freeze({ kind: "surface", text: target.text });
    case "vault_note":
      return Object.freeze({
        kind: "vault_note",
        vaultPath: normalizeVaultPath(target.vaultPath)
      });
    case "vault_subpath":
      return Object.freeze({
        kind: "vault_subpath",
        vaultPath: normalizeVaultPath(target.vaultPath),
        subpath: normalizeSubpath(target.subpath)
      });
    case "semantic_episode":
      return Object.freeze({
        kind: "semantic_episode",
        episodeId: target.episodeId
      });
  }
}

function cloneProvenance(
  provenance: ActivationSeedProvenance
): ActivationSeedProvenance {
  switch (provenance.kind) {
    case "message":
      return Object.freeze({
        kind: "message",
        messageId: provenance.messageId
      });
    case "vault_location": {
      const base = {
        kind: "vault_location" as const,
        vaultPath: normalizeVaultPath(provenance.vaultPath)
      };

      return provenance.subpath === undefined
        ? Object.freeze(base)
        : Object.freeze({
            ...base,
            subpath: normalizeSubpath(provenance.subpath)
          });
    }
    case "semantic_episode":
      return Object.freeze({
        kind: "semantic_episode",
        episodeId: provenance.episodeId
      });
  }
}

function cloneSource(source: ActivationSeedSource): ActivationSeedSource {
  return Object.freeze({
    origin: source.origin,
    provenance: cloneProvenance(source.provenance)
  });
}

function freezeSeed(
  target: ActivationTarget,
  sources: readonly ActivationSeedSource[]
): ActivationSeed {
  return Object.freeze({
    target: cloneTarget(target),
    sources: Object.freeze(sources.map(cloneSource))
  });
}

/**
 * Merge equal normalized targets and collapse exact duplicate sources.
 * Target and source order are both the order of first occurrence.
 */
export function mergeActivationSeeds(
  seeds: readonly ActivationSeed[]
): readonly ActivationSeed[] {
  const orderedTargets: Array<{
    target: ActivationTarget;
    sources: ActivationSeedSource[];
    sourceKeys: Set<string>;
  }> = [];
  const targetsByKey = new Map<string, (typeof orderedTargets)[number]>();

  for (const seed of seeds) {
    if (
      seed.target.kind === "surface" &&
      normalizeSurfaceForKey(seed.target.text) === ""
    ) {
      continue;
    }

    const targetKey = activationTargetKey(seed.target);
    let accumulated = targetsByKey.get(targetKey);

    if (accumulated === undefined) {
      accumulated = {
        target: cloneTarget(seed.target),
        sources: [],
        sourceKeys: new Set<string>()
      };
      targetsByKey.set(targetKey, accumulated);
      orderedTargets.push(accumulated);
    }

    for (const source of seed.sources) {
      const sourceKey = activationSeedSourceKey(source);
      if (accumulated.sourceKeys.has(sourceKey)) {
        continue;
      }
      accumulated.sourceKeys.add(sourceKey);
      accumulated.sources.push(cloneSource(source));
    }
  }

  return Object.freeze(
    orderedTargets.map(({ target, sources }) => freezeSeed(target, sources))
  );
}

export function createActivationSeedSet(
  seeds: readonly ActivationSeed[]
): ActivationSeedSet {
  return Object.freeze({ seeds: mergeActivationSeeds(seeds) });
}

function createSingleSourceSeed(
  target: ActivationTarget,
  source: ActivationSeedSource
): ActivationSeed {
  return freezeSeed(target, [source]);
}

export function createCurrentUtteranceSeed(
  text: string,
  messageId: string
): ActivationSeed | undefined {
  if (normalizeSurfaceForKey(text) === "") {
    return undefined;
  }

  return createSingleSourceSeed(
    { kind: "surface", text },
    {
      origin: "current_utterance",
      provenance: { kind: "message", messageId }
    }
  );
}

export function createActiveNoteSeed(vaultPath: string): ActivationSeed {
  return createSingleSourceSeed(
    { kind: "vault_note", vaultPath },
    {
      origin: "active_note",
      provenance: { kind: "vault_location", vaultPath }
    }
  );
}

export function createActiveHeadingSeed(
  vaultPath: string,
  subpath: string
): ActivationSeed {
  return createSingleSourceSeed(
    { kind: "vault_subpath", vaultPath, subpath },
    {
      origin: "active_heading",
      provenance: { kind: "vault_location", vaultPath, subpath }
    }
  );
}

export function createSelectedTextSeed(
  text: string,
  vaultPath: string,
  subpath?: string
): ActivationSeed | undefined {
  if (normalizeSurfaceForKey(text) === "") {
    return undefined;
  }

  const provenance: ActivationSeedProvenance = subpath === undefined
    ? { kind: "vault_location", vaultPath }
    : { kind: "vault_location", vaultPath, subpath };

  return createSingleSourceSeed(
    { kind: "surface", text },
    { origin: "selected_text", provenance }
  );
}

/**
 * Convert only exact query surfaces. Other provisional query fields are not
 * activation targets in Stage 1.
 */
export function createSemanticQuerySurfaceSeeds(
  query: Readonly<{ readonly seedSurfaces: readonly string[] }>,
  originatingMessageId: string
): readonly ActivationSeed[] {
  const seeds: ActivationSeed[] = [];

  for (const text of query.seedSurfaces) {
    if (normalizeSurfaceForKey(text) === "") {
      continue;
    }

    seeds.push(createSingleSourceSeed(
      { kind: "surface", text },
      {
        origin: "semantic_query",
        provenance: {
          kind: "message",
          messageId: originatingMessageId
        }
      }
    ));
  }

  return mergeActivationSeeds(seeds);
}

/** Create a seed for an episode that retrieval has already identified. */
export function createSemanticPriorEpisodeSeed(
  episode: Readonly<SemanticPriorEpisode>
): ActivationSeed {
  return createSingleSourceSeed(
    { kind: "semantic_episode", episodeId: episode.id },
    {
      origin: "semantic_prior",
      provenance: {
        kind: "semantic_episode",
        episodeId: episode.id
      }
    }
  );
}
