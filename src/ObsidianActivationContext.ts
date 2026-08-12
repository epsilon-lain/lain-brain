import {
  MarkdownView,
  type App,
  type HeadingCache
} from "obsidian";

import {
  createActivationSeedSet,
  createActiveHeadingSeed,
  createActiveNoteSeed,
  createSelectedTextSeed,
  type ActivationSeed,
  type ActivationSeedSet
} from "./ActivationSeed";

export interface ObsidianEditorActivationContext {
  readonly cursorLine: number;
  readonly selection: string;
  readonly headingSubpath?: string;
}

/** A read-only, ephemeral snapshot of the active Obsidian note context. */
export interface ObsidianActivationContext {
  readonly activeFilePath: string;
  readonly editor?: ObsidianEditorActivationContext;
}

function freezeContext(
  activeFilePath: string,
  editor?: ObsidianEditorActivationContext
): ObsidianActivationContext {
  if (editor === undefined) {
    return Object.freeze({ activeFilePath });
  }

  return Object.freeze({
    activeFilePath,
    editor: Object.freeze({ ...editor })
  });
}

/**
 * Return the nearest metadata heading at or before the cursor line.
 * Metadata order is not assumed; line and then column determine proximity.
 */
export function findCurrentHeading(
  headings: readonly HeadingCache[],
  cursorLine: number
): HeadingCache | undefined {
  let nearest: HeadingCache | undefined;

  for (const heading of headings) {
    if (
      heading.heading.trim() === "" ||
      heading.position.start.line > cursorLine
    ) {
      continue;
    }

    if (
      nearest === undefined ||
      heading.position.start.line > nearest.position.start.line ||
      (
        heading.position.start.line === nearest.position.start.line &&
        heading.position.start.col > nearest.position.start.col
      )
    ) {
      nearest = heading;
    }
  }

  return nearest;
}

/**
 * Capture live context once. Active-file context is independent of editor
 * focus, while cursor and selection require the currently active MarkdownView
 * for that exact file in source mode.
 */
export function collectObsidianActivationContext(
  app: App
): ObsidianActivationContext | undefined {
  const activeFile = app.workspace.getActiveFile();

  if (activeFile === null || activeFile.extension !== "md") {
    return undefined;
  }

  const noteOnly = freezeContext(activeFile.path);
  const markdownView = app.workspace.getActiveViewOfType(MarkdownView);

  if (
    markdownView === null ||
    markdownView.file?.path !== activeFile.path ||
    markdownView.getMode() !== "source"
  ) {
    return noteOnly;
  }

  let selection: string;
  let cursorLine: number;

  try {
    selection = markdownView.editor.getSelection();
    cursorLine = markdownView.editor.getCursor().line;
  } catch {
    // An editor that disappeared during collection contributes no stale state.
    return noteOnly;
  }

  let headingSubpath: string | undefined;

  try {
    const headings = app.metadataCache.getFileCache(activeFile)?.headings ?? [];
    const currentHeading = findCurrentHeading(headings, cursorLine);
    if (currentHeading !== undefined) {
      headingSubpath = `#${currentHeading.heading}`;
    }
  } catch {
    // Metadata availability must not suppress a real selection snapshot.
  }

  return freezeContext(activeFile.path, {
    cursorLine,
    selection,
    ...(headingSubpath === undefined ? {} : { headingSubpath })
  });
}

/** Convert an explicit context snapshot through the existing Stage 1 API. */
export function createObsidianContextSeedSet(
  context: Readonly<ObsidianActivationContext> | undefined
): ActivationSeedSet {
  if (context === undefined) {
    return createActivationSeedSet([]);
  }

  const seeds: ActivationSeed[] = [
    createActiveNoteSeed(context.activeFilePath)
  ];

  if (context.editor?.headingSubpath !== undefined) {
    seeds.push(createActiveHeadingSeed(
      context.activeFilePath,
      context.editor.headingSubpath
    ));
  }

  if (context.editor !== undefined) {
    const selectionSeed = createSelectedTextSeed(
      context.editor.selection,
      context.activeFilePath,
      context.editor.headingSubpath
    );
    if (selectionSeed !== undefined) {
      seeds.push(selectionSeed);
    }
  }

  return createActivationSeedSet(seeds);
}

/** Collect and convert the current Obsidian context without retaining it. */
export function collectObsidianActivationSeeds(app: App): ActivationSeedSet {
  return createObsidianContextSeedSet(
    collectObsidianActivationContext(app)
  );
}
