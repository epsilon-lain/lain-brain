import {
  TFile,
  getAllTags,
  normalizePath,
  parseLinktext,
  type App,
  type CachedMetadata,
  type Reference
} from "obsidian";

import {
  createActivationSeedSet,
  type ActivationSeed,
  type ActivationSeedOrigin,
  type ActivationSeedSet,
  type ActivationTarget
} from "./ActivationSeed";
import {
  collectObsidianActivationContext,
  createObsidianContextSeedSet
} from "./ObsidianActivationContext";

const MAX_FRONTMATTER_ARRAY_ITEMS = 12;

export interface ObsidianTopologySeedOptions {
  /**
   * Frontmatter is opt-in. Only selected keys with safe primitive values are
   * represented; unselected fields and objects are ignored.
   */
  readonly frontmatterKeys?: readonly string[];
}

type FrontmatterPrimitive = string | number | boolean;

function createVaultSourceSeed(
  target: ActivationTarget,
  origin: ActivationSeedOrigin,
  sourceVaultPath: string
): ActivationSeed {
  return {
    target,
    sources: [{
      origin,
      provenance: {
        kind: "vault_location",
        vaultPath: sourceVaultPath
      }
    }]
  };
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function collectReferenceSeeds(
  app: App,
  sourceFile: TFile,
  references: readonly Reference[]
): ActivationSeed[] {
  const seeds: ActivationSeed[] = [];

  for (const reference of references) {
    const parsed = parseLinktext(reference.link);
    const linkPath = parsed.path.trim();
    const destination = linkPath === ""
      ? sourceFile
      : app.metadataCache.getFirstLinkpathDest(linkPath, sourceFile.path);

    if (destination === null) {
      if (reference.link.trim() !== "") {
        seeds.push(createVaultSourceSeed(
          { kind: "surface", text: reference.link },
          "wikilink",
          sourceFile.path
        ));
      }
      continue;
    }

    const target: ActivationTarget = parsed.subpath === ""
      ? { kind: "vault_note", vaultPath: destination.path }
      : {
          kind: "vault_subpath",
          vaultPath: destination.path,
          subpath: parsed.subpath
        };

    seeds.push(createVaultSourceSeed(target, "wikilink", sourceFile.path));
  }

  return seeds;
}

function collectBacklinkSeeds(app: App, activeFile: TFile): ActivationSeed[] {
  const seeds: ActivationSeed[] = [];
  const activePath = normalizePath(activeFile.path);
  const sourcePaths = Object.keys(app.metadataCache.resolvedLinks)
    .sort(comparePaths);

  for (const sourcePath of sourcePaths) {
    const destinations = app.metadataCache.resolvedLinks[sourcePath];
    if ((destinations?.[activePath] ?? 0) <= 0) {
      continue;
    }

    const normalizedSourcePath = normalizePath(sourcePath);
    const sourceFile = app.vault.getAbstractFileByPath(normalizedSourcePath);
    if (!(sourceFile instanceof TFile) || sourceFile.extension !== "md") {
      continue;
    }

    seeds.push(createVaultSourceSeed(
      { kind: "vault_note", vaultPath: sourceFile.path },
      "backlink",
      sourceFile.path
    ));
  }

  return seeds;
}

function collectTagSeeds(
  cache: CachedMetadata,
  sourceFile: TFile
): ActivationSeed[] {
  const tags = getAllTags(cache) ?? [];
  return tags
    .filter((tag) => tag.trim() !== "")
    .map((tag) => createVaultSourceSeed(
      { kind: "surface", text: tag },
      "note_metadata",
      sourceFile.path
    ));
}

function isFrontmatterPrimitive(value: unknown): value is FrontmatterPrimitive {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function frontmatterPrimitiveText(value: FrontmatterPrimitive): string | null {
  if (typeof value === "string") {
    return value.trim() === "" ? null : value;
  }
  return String(value);
}

function collectFrontmatterSeeds(
  cache: CachedMetadata,
  sourceFile: TFile,
  selectedKeys: readonly string[]
): ActivationSeed[] {
  const seeds: ActivationSeed[] = [];
  const frontmatter = cache.frontmatter;

  if (frontmatter === undefined) {
    return seeds;
  }

  for (const key of selectedKeys) {
    if (key.trim() === "" || !Object.prototype.hasOwnProperty.call(frontmatter, key)) {
      continue;
    }

    const value: unknown = frontmatter[key];
    let primitives: readonly FrontmatterPrimitive[];

    if (isFrontmatterPrimitive(value)) {
      primitives = [value];
    } else if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.length <= MAX_FRONTMATTER_ARRAY_ITEMS &&
      value.every(isFrontmatterPrimitive)
    ) {
      primitives = value;
    } else {
      continue;
    }

    for (const primitive of primitives) {
      const valueText = frontmatterPrimitiveText(primitive);
      if (valueText === null) {
        continue;
      }
      seeds.push(createVaultSourceSeed(
        { kind: "surface", text: `${key}: ${valueText}` },
        "note_metadata",
        sourceFile.path
      ));
    }
  }

  return seeds;
}

/**
 * Collect direct native Obsidian topology adjacent to one explicit note.
 * This performs no traversal, ranking, persistence, or semantic inference.
 */
export function collectObsidianTopologySeedsForFile(
  app: App,
  activeFile: TFile,
  options: Readonly<ObsidianTopologySeedOptions> = {}
): ActivationSeedSet {
  const cache = app.metadataCache.getFileCache(activeFile);
  if (cache === null) {
    return createActivationSeedSet(
      collectBacklinkSeeds(app, activeFile)
    );
  }

  const references: Reference[] = [
    ...(cache.links ?? []),
    ...(cache.embeds ?? []),
    ...(cache.frontmatterLinks ?? [])
  ];
  const seeds: ActivationSeed[] = [
    ...collectReferenceSeeds(app, activeFile, references),
    ...collectBacklinkSeeds(app, activeFile),
    ...collectTagSeeds(cache, activeFile),
    ...collectFrontmatterSeeds(
      cache,
      activeFile,
      options.frontmatterKeys ?? []
    )
  ];

  return createActivationSeedSet(seeds);
}

/**
 * Combine the frozen Stage 2A context seeds with direct Stage 2B topology.
 * The context snapshot is collected once; no editor state is retained.
 */
export function collectObsidianActivationSeedsWithTopology(
  app: App,
  options: Readonly<ObsidianTopologySeedOptions> = {}
): ActivationSeedSet {
  const context = collectObsidianActivationContext(app);
  const contextSeeds = createObsidianContextSeedSet(context);

  if (context === undefined) {
    return contextSeeds;
  }

  const activeFile = app.vault.getAbstractFileByPath(context.activeFilePath);
  if (!(activeFile instanceof TFile) || activeFile.extension !== "md") {
    return contextSeeds;
  }

  const topologySeeds = collectObsidianTopologySeedsForFile(
    app,
    activeFile,
    options
  );

  return createActivationSeedSet([
    ...contextSeeds.seeds,
    ...topologySeeds.seeds
  ]);
}
