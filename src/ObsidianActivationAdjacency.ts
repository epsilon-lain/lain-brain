import {
  TFile,
  normalizePath,
  parseLinktext,
  type App,
  type Reference
} from "obsidian";

import {
  activationTargetKey,
  createActivationSeedSet,
  type ActivationSeed,
  type ActivationTarget
} from "./ActivationSeed";
import { collectObsidianActivationSeeds } from "./ObsidianActivationContext";
import {
  traverseBoundedActivation,
  type ActivationAdjacencyProvider,
  type ActivationEdge,
  type ActivationTraversalBudget,
  type ActivationTraversalResult
} from "./BoundedActivationTraversal";

export interface ObsidianActivationTraversalOptions {
  /** Additional explicit roots; topology neighbors are never added here. */
  readonly extraSeeds?: readonly ActivationSeed[];
  readonly budget?: Readonly<Partial<ActivationTraversalBudget>>;
}

function isMarkdownFile(value: unknown): value is TFile {
  return value instanceof TFile && value.extension === "md";
}

function compareLexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function edgeKey(edge: ActivationEdge): string {
  return JSON.stringify([edge.type, activationTargetKey(edge.target)]);
}

function freezeEdges(edges: readonly ActivationEdge[]): readonly ActivationEdge[] {
  const sorted = edges.map((edge) => Object.freeze({
    type: edge.type,
    target: Object.freeze({ ...edge.target })
  }) as ActivationEdge).sort((left, right) =>
    compareLexical(edgeKey(left), edgeKey(right))
  );
  const unique: ActivationEdge[] = [];
  let previousKey: string | undefined;

  for (const edge of sorted) {
    const currentKey = edgeKey(edge);
    if (currentKey === previousKey) {
      continue;
    }
    previousKey = currentKey;
    unique.push(edge);
  }

  return Object.freeze(unique);
}

function collectOutgoingEdges(
  app: App,
  sourceFile: TFile
): readonly ActivationEdge[] {
  const cache = app.metadataCache.getFileCache(sourceFile);
  if (cache === null) {
    return Object.freeze([]);
  }

  const references: Reference[] = [
    ...(cache.links ?? []),
    ...(cache.embeds ?? []),
    ...(cache.frontmatterLinks ?? [])
  ];
  const edges: ActivationEdge[] = [];

  for (const reference of references) {
    const parsed = parseLinktext(reference.link);
    const linkPath = parsed.path.trim();
    const destination = linkPath === ""
      ? sourceFile
      : app.metadataCache.getFirstLinkpathDest(linkPath, sourceFile.path);

    if (!isMarkdownFile(destination)) {
      continue;
    }

    edges.push({
      type: "outgoing_link",
      target: parsed.subpath === ""
        ? { kind: "vault_note", vaultPath: destination.path }
        : {
            kind: "vault_subpath",
            vaultPath: destination.path,
            subpath: parsed.subpath
          }
    });
  }

  return freezeEdges(edges);
}

function collectBacklinkEdges(
  app: App,
  destinationFile: TFile
): readonly ActivationEdge[] {
  const destinationPath = normalizePath(destinationFile.path);
  const resolvedLinks = app.metadataCache.resolvedLinks ?? {};
  const sourcePaths = Object.keys(resolvedLinks).sort(compareLexical);
  const edges: ActivationEdge[] = [];

  for (const sourcePath of sourcePaths) {
    const destinations = resolvedLinks[sourcePath];
    if ((destinations?.[destinationPath] ?? 0) <= 0) {
      continue;
    }

    const sourceFile = app.vault.getAbstractFileByPath(
      normalizePath(sourcePath)
    );
    if (!isMarkdownFile(sourceFile)) {
      continue;
    }

    edges.push({
      type: "backlink",
      target: { kind: "vault_note", vaultPath: sourceFile.path }
    });
  }

  return freezeEdges(edges);
}

/**
 * Adapt Obsidian's current metadata cache to Stage 3's ephemeral adjacency
 * boundary. No content, graph, retrieval state, or semantic episode is stored.
 */
export function createObsidianActivationAdjacencyProvider(
  app: App
): ActivationAdjacencyProvider {
  return Object.freeze({
    getAdjacent(
      target: Readonly<ActivationTarget>
    ): readonly ActivationEdge[] {
      switch (target.kind) {
        case "surface":
        case "semantic_episode":
          return Object.freeze([]);
        case "vault_subpath": {
          const owner = app.vault.getAbstractFileByPath(
            normalizePath(target.vaultPath)
          );
          if (!isMarkdownFile(owner)) {
            return Object.freeze([]);
          }
          return freezeEdges([{
            type: "containing_note",
            target: { kind: "vault_note", vaultPath: owner.path }
          }]);
        }
        case "vault_note": {
          const sourceFile = app.vault.getAbstractFileByPath(
            normalizePath(target.vaultPath)
          );
          if (!isMarkdownFile(sourceFile)) {
            return Object.freeze([]);
          }
          return freezeEdges([
            ...collectOutgoingEdges(app, sourceFile),
            ...collectBacklinkEdges(app, sourceFile)
          ]);
        }
      }
    }
  });
}

/**
 * Traverse from Stage 2A primary context plus caller-selected explicit roots.
 * Direct topology is supplied only as adjacency, never promoted to a root.
 */
export function traverseObsidianActivation(
  app: App,
  options: Readonly<ObsidianActivationTraversalOptions> = {}
): ActivationTraversalResult {
  const contextRoots = collectObsidianActivationSeeds(app);
  const roots = createActivationSeedSet([
    ...contextRoots.seeds,
    ...(options.extraSeeds ?? [])
  ]);

  return traverseBoundedActivation(
    roots,
    createObsidianActivationAdjacencyProvider(app),
    options.budget ?? {}
  );
}
