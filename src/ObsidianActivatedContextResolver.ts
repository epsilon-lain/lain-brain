import {
  TFile,
  normalizePath,
  resolveSubpath,
  type App
} from "obsidian";

import type {
  ActivatedContextContentPart,
  ActivatedContextTargetResolution,
  ActivatedVaultContextResolver,
  ActivatedVaultContextResolverSession,
  VaultActivatedTarget
} from "./ActivatedContextMaterialization";

function emptyResolution(
  code: "target_missing" | "not_markdown" | "read_failed" |
    "metadata_unavailable" | "subpath_not_found" |
    "unsupported_subpath" | "empty_content"
): ActivatedContextTargetResolution {
  return Object.freeze({
    contentParts: Object.freeze([]),
    diagnostics: Object.freeze([code])
  });
}

function createVaultPart(
  target: Readonly<VaultActivatedTarget>,
  text: string
): ActivatedContextContentPart {
  return Object.freeze({
    sourceRole: "vault_markdown",
    text,
    provenance: target.kind === "vault_note"
      ? Object.freeze({
          kind: "vault_location",
          vaultPath: target.vaultPath
        })
      : Object.freeze({
          kind: "vault_location",
          vaultPath: target.vaultPath,
          subpath: target.subpath
        }),
    truncated: false
  });
}

function isMarkdownFile(value: unknown): value is TFile {
  return value instanceof TFile && value.extension === "md";
}

function createSession(app: App): ActivatedVaultContextResolverSession {
  const reads = new Map<string, Promise<string>>();

  const readOnce = (file: TFile): Promise<string> => {
    const path = normalizePath(file.path);
    let pending = reads.get(path);
    if (pending === undefined) {
      pending = app.vault.cachedRead(file);
      reads.set(path, pending);
    }
    return pending;
  };

  return Object.freeze({
    async resolveVaultTarget(
      target: Readonly<VaultActivatedTarget>
    ): Promise<ActivatedContextTargetResolution> {
      const abstractFile = app.vault.getAbstractFileByPath(
        normalizePath(target.vaultPath)
      );
      if (abstractFile === null) {
        return emptyResolution("target_missing");
      }
      if (!isMarkdownFile(abstractFile)) {
        return emptyResolution("not_markdown");
      }

      let markdown: string;
      try {
        markdown = await readOnce(abstractFile);
      } catch {
        return emptyResolution("read_failed");
      }

      if (target.kind === "vault_note") {
        return markdown.length === 0
          ? emptyResolution("empty_content")
          : Object.freeze({
              contentParts: Object.freeze([
                createVaultPart(target, markdown)
              ])
            });
      }

      const cache = app.metadataCache.getFileCache(abstractFile);
      if (cache === null) {
        return emptyResolution("metadata_unavailable");
      }

      let resolved: ReturnType<typeof resolveSubpath>;
      try {
        resolved = resolveSubpath(cache, target.subpath);
      } catch {
        return emptyResolution("subpath_not_found");
      }

      if (resolved === null) {
        return emptyResolution("subpath_not_found");
      }
      if (resolved.type !== "heading" && resolved.type !== "block") {
        return emptyResolution("unsupported_subpath");
      }

      const start = resolved.start.offset;
      const end = resolved.end?.offset ?? markdown.length;
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end < start ||
        end > markdown.length
      ) {
        return emptyResolution("subpath_not_found");
      }

      const section = markdown.slice(start, end);
      return section.length === 0
        ? emptyResolution("empty_content")
        : Object.freeze({
            contentParts: Object.freeze([
              createVaultPart(target, section)
            ])
          });
    }
  });
}

/** Read-only exact-path Obsidian content resolver with per-call read caching. */
export function createObsidianActivatedContextResolver(
  app: App
): ActivatedVaultContextResolver {
  return Object.freeze({
    beginMaterialization(): ActivatedVaultContextResolverSession {
      return createSession(app);
    }
  });
}
