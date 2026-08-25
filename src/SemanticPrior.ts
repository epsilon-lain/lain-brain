// ── Persistent Semantic Prior Episodes ──────────────────────────────────
// M2B.4: Immutable historical semantic-hypothesis snapshots.
//
// A SemanticPriorEpisode records the assistant's working SemanticSpec at a
// specific moment, anchored by exact user-authored language surfaces. It is
// never a UserConclusion, never an authoritative definition, and never a
// permanent user model.
//
// Episodes are internal plugin protocol state. They survive chat clear, panel
// close, and Obsidian restart, but are never written to Vault markdown files.
//
// Invariants:
//   1. Episodes are immutable after creation (deep frozen).
//   2. Every evidence actor === "user".
//   3. No assistant prose is stored as evidence.
//   4. Episodes for the same anchor coexist — later episodes do not overwrite
//      earlier ones.
//   5. Anchors are derived deterministically from the SemanticSpec and
//      from exact user-authored evidence text surfaces (M2B.5).
//   6. Retrieval is deterministic: exact/substring matching plus
//      structure-aware seeding (M2B.5), no embeddings.
// ────────────────────────────────────────────────────────────────────────

import type {
  SemanticAmbiguity,
  SemanticExpression,
  SemanticSpec,
  SemanticStatement,
  SemanticSymbol
} from "./SemanticSpec";
import type { UserTextProvenance } from "./KnowledgeProtocol";
import { extractLexicalSurfaces } from "./SemanticRetrievalQuery";
import type { SemanticRetrievalQuery } from "./SemanticRetrievalQuery";

// We only import the type; createSemanticSpec is not needed for slicing
// because we build a structurally minimal slice object directly.

// ── Constants ──────────────────────────────────────────────────────────

export const SEMANTIC_PRIOR_SCHEMA_VERSION = 1;

/** Maximum episodes returned by retrieval. */
const MAX_RETRIEVED_EPISODES = 5;

/** Maximum rendered characters for prior context injected into foreground. */
const MAX_PRIOR_CONTEXT_CHARS = 2500;

/**
 * Minimum anchor length in characters. Shorter anchors are too generic and
 * produce noisy retrievals.
 */
const MIN_ANCHOR_LENGTH = 2;

/**
 * Characters that should not appear as standalone anchors.
 */
const STOP_ANCHORS = new Set([
  "it", "this", "that", "the", "a", "an", "is", "be", "to", "of", "in",
  "on", "at", "by", "for", "and", "or", "not", "if", "so", "we", "he",
  "she", "they", "me", "my", "our", "your", "no", "yes", "ok", "hi",
  "hello", "test", "x", "y", "z", "n", "m", "a", "b", "c", "?", "。",
  "吗", "喵", "嗯", "哦"
]);

/**
 * Maximum number of evidence-text anchors merged into one episode.
 * Bounded so a long evidence snapshot cannot inflate anchor sets
 * without limit.
 */
const MAX_EVIDENCE_ANCHORS = 48;

// ── Types ──────────────────────────────────────────────────────────────

export interface SemanticPriorEpisode {
  readonly id: string;
  readonly createdAt: number;

  /**
   * Exact user-authored evidence supporting the historical hypothesis.
   * Every evidence actor must be "user".
   */
  readonly evidenceRefs: readonly UserTextProvenance[];

  /**
   * Exact user surface forms that make this episode potentially relevant
   * again. These are retrieval anchors, NOT canonical concept IDs.
   */
  readonly anchors: readonly string[];

  /**
   * Snapshot of the working semantic hypothesis at that moment.
   * This remains an assistant hypothesis.
   */
  readonly semanticSpec: SemanticSpec;

  readonly semanticSessionId: string;
  readonly semanticRevision: number;
}

export interface SemanticPriorState {
  readonly schemaVersion: number;
  readonly episodes: readonly SemanticPriorEpisode[];
}

export interface CreateSemanticPriorEpisodeParams {
  readonly evidenceRefs: readonly UserTextProvenance[];
  readonly semanticSpec: SemanticSpec;
  readonly semanticSessionId: string;
  readonly semanticRevision: number;
}

// ── Deep Immutability Helpers ──────────────────────────────────────────

function deepFreeze<T>(value: T): T {
  if (value === null || value === undefined ||
      (typeof value !== "object" && typeof value !== "function")) {
    return value;
  }
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
  } else {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function deepClone<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as unknown as T;
  }
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(value as object)) {
    clone[key] = deepClone((value as Record<string, unknown>)[key]);
  }
  return clone as T;
}

// ── ID Generation ──────────────────────────────────────────────────────

function generateEpisodeId(): string {
  try {
    return `spe-${globalThis.crypto?.randomUUID?.() ?? fallbackId()}`;
  } catch {
    return `spe-${fallbackId()}`;
  }
}

function fallbackId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Anchor Derivation ──────────────────────────────────────────────────

/**
 * Derive retrieval anchors deterministically from a SemanticSpec.
 *
 * Prefers exact user-visible surface forms already represented in the spec:
 *   - user-defined symbols/concepts
 *   - unresolved user expressions
 *   - relation/operator surfaces
 *   - meaningful named concepts
 *
 * Avoids generic anchors: "it", "this", punctuation, single generic
 * mathematical variable names, common stop words.
 *
 * Does NOT invent normalized standard terminology merely for retrieval.
 */
/**
 * Derive deterministic retrieval anchors for an episode.
 *
 * Anchors come from two channels:
 *   1. SemanticSpec symbols, statements, and descriptions (M2B.4).
 *   2. Exact user-authored evidence text surfaces — CJK bigram/trigram
 *      windows and alphabetic words (M2B.5). This keeps the user's own
 *      language retrievable even when the LLM models only entities.
 *
 * The evidence channel is empty unless evidence refs are supplied, so
 * spec-only callers observe the historical behavior unchanged.
 */
export function deriveAnchors(
  semanticSpec: Readonly<SemanticSpec>,
  evidenceRefs: readonly UserTextProvenance[] = []
): readonly string[] {
  const anchors = new Set<string>();

  for (const symbol of semanticSpec.symbols) {
    const surface = symbol.surface.trim();
    if (surface === "") {
      continue;
    }

    // Always include user-defined symbols as anchors
    if (symbol.userDefined === true) {
      anchors.add(surface);
    }

    // Include unresolved symbols (genuinely ambiguous user language)
    if (symbol.role === "unresolved") {
      anchors.add(surface);
    }

    // Include concepts with meaningful names (non-generic, non-trivial)
    if (
      symbol.role === "concept" ||
      symbol.role === "relation" ||
      symbol.role === "function" ||
      symbol.role === "operator" ||
      symbol.role === "predicate" ||
      symbol.role === "domain" ||
      symbol.role === "collection"
    ) {
      if (!isStopAnchor(surface)) {
        anchors.add(surface);
      }
    }

    // Include proposition-level symbols as conceptual anchors
    if (symbol.role === "proposition" && !isStopAnchor(surface)) {
      anchors.add(surface);
    }
  }

  // Also derive anchors from descriptions and statement descriptions
  for (const stmt of semanticSpec.statements) {
    if (stmt.description !== undefined && stmt.description.trim() !== "") {
      const words = extractMeaningfulPhrases(stmt.description);
      for (const word of words) {
        anchors.add(word);
      }
    }
  }

  // Add symbol descriptions that contain user-coined phrases
  for (const symbol of semanticSpec.symbols) {
    if (
      symbol.description !== undefined &&
      symbol.description.trim() !== ""
    ) {
      const phrases = extractMeaningfulPhrases(symbol.description);
      for (const phrase of phrases) {
        if (!isStopAnchor(phrase)) {
          anchors.add(phrase);
        }
      }
    }
  }

  // Evidence-text lexical anchors (M2B.5)
  for (const anchor of deriveEvidenceTextAnchors(evidenceRefs)) {
    anchors.add(anchor);
  }

  return deepFreeze([...anchors].sort());
}

/**
 * Extract potentially meaningful multi-character phrases from a description
 * string. This is a conservative heuristic — it looks for CJK character
 * sequences and longer alphabetic words.
 */
function extractMeaningfulPhrases(text: string): string[] {
  const results: string[] = [];

  // Extract CJK character sequences (2+ chars)
  const cjkRegex = /[一-鿿㐀-䶿]{2,}/g;
  let match: RegExpExecArray | null;
  while ((match = cjkRegex.exec(text)) !== null) {
    results.push(match[0]);
  }

  // Extract alphabetic sequences (4+ chars, likely meaningful)
  const wordRegex = /[a-zA-ZÀ-ɏ]{4,}/g;
  while ((match = wordRegex.exec(text)) !== null) {
    const word = match[0].toLowerCase();
    if (!isStopAnchor(word)) {
      results.push(match[0]);
    }
  }

  return results;
}

function isStopAnchor(value: string): boolean {
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s，。！？,.!?;；:：'"''""'']/g, "")
    .trim();

  if (normalized.length < MIN_ANCHOR_LENGTH) {
    return true;
  }

  return STOP_ANCHORS.has(normalized);
}

// ── Evidence Text Anchors (M2B.5) ────────────────────────────────────────────────────────────

/**
 * Materialize the exact user-authored text of an evidence ref.
 * For message spans only the marked slice is used; no truncation is
 * applied here because this feeds deterministic anchor derivation.
 */
function materializeEvidenceText(
  source: Readonly<UserTextProvenance>
): string {
  if (source.sourceKind === "user_edit") {
    return source.snapshot;
  }
  if (
    source.startOffset !== undefined &&
    source.endOffset !== undefined
  ) {
    return source.snapshot.slice(source.startOffset, source.endOffset);
  }
  return source.snapshot;
}

/**
 * Derive retrieval anchors from the raw user-authored evidence text of
 * an episode. Deterministic, no LLM call.
 */
export function deriveEvidenceTextAnchors(
  evidenceRefs: readonly UserTextProvenance[]
): readonly string[] {
  const anchors = new Set<string>();

  for (const ref of evidenceRefs) {
    const surfaces = extractLexicalSurfaces(materializeEvidenceText(ref));
    for (const surface of surfaces) {
      if (!isStopAnchor(surface)) {
        anchors.add(surface);
      }
    }
  }

  return deepFreeze([...anchors].sort().slice(0, MAX_EVIDENCE_ANCHORS));
}

// ── Evidence Identity ──────────────────────────────────────────────────

/**
 * Extract a stable identity key from a UserTextProvenance for diffing.
 * Uses messageId for spans and editId for edits, falling back to snapshot
 * content for identity when neither is available.
 */
function evidenceIdentityKey(ref: Readonly<UserTextProvenance>): string {
  if (ref.sourceKind === "message_span") {
    return `msg:${ref.messageId}`;
  }
  // user_edit or future kinds
  return `edit:${(ref as { editId: string }).editId}`;
}

// ── Semantic Spec Slicing ──────────────────────────────────────────────

/**
 * Create a local semantic slice containing only objects directly supported
 * by or referencing the episode-local user evidence.
 *
 * The slice preserves structural self-containment: any expression or
 * statement included in the slice must have all its referenced child IDs
 * also present in the slice. Unrelated historical symbols from the
 * cumulative working hypothesis are excluded.
 *
 * Returns null when the evidence matches no source refs or produces no
 * meaningful symbols — in that case no episode should be created.
 */
export function sliceSemanticSpecForEvidence(
  spec: Readonly<SemanticSpec>,
  episodeEvidenceRefs: readonly UserTextProvenance[]
): SemanticSpec | null {
  // ── 1. Match source refs to episode evidence ──────────────────────
  // Build identity sets: messageIds (for spans) and snapshots (for edits
  // or as fallback). UserTextEdit has no messageId — match by snapshot.
  const evidenceMsgIds = new Set<string>();
  const evidenceSnapshots = new Set<string>();
  for (const ref of episodeEvidenceRefs) {
    evidenceSnapshots.add(ref.snapshot);
    if (ref.sourceKind === "message_span") {
      evidenceMsgIds.add(ref.messageId);
    }
  }

  const matchedSourceRefs = spec.sourceRefs.filter(
    (sr) =>
      evidenceMsgIds.has(sr.messageId) ||
      evidenceSnapshots.has(sr.snapshot)
  );

  if (matchedSourceRefs.length === 0) {
    return null;
  }

  const matchedSourceRefIds = new Set(
    matchedSourceRefs.map((sr) => sr.id)
  );

  // ── 2. Symbols directly supported by matched source refs ──────────
  const localSymbols = spec.symbols.filter((sym) =>
    sym.sourceRefIds.some((id) => matchedSourceRefIds.has(id))
  );

  if (localSymbols.length === 0) {
    return null;
  }

  const localSymbolIds = new Set(localSymbols.map((s) => s.id));

  // ── 3. Expressions transitively reachable from local symbols ──────
  // Start from expressions directly referencing local symbols, then
  // close transitively over child expression IDs to keep the slice
  // self-contained.
  const exprIndex = new Map<string, Readonly<SemanticExpression>>();
  for (const expr of spec.expressions) {
    exprIndex.set(expr.id, expr);
  }

  const localExprIds = new Set<string>();
  const queue: string[] = [];

  // Seed: expressions that reference local symbols
  for (const expr of spec.expressions) {
    if (referencesAnySymbol(expr, localSymbolIds)) {
      if (!localExprIds.has(expr.id)) {
        localExprIds.add(expr.id);
        queue.push(expr.id);
      }
    }
  }

  // Transitive closure over child expression references
  while (queue.length > 0) {
    const exprId = queue.pop()!;
    const childIds = collectChildExprIds(exprIndex.get(exprId));
    for (const childId of childIds) {
      if (!localExprIds.has(childId)) {
        localExprIds.add(childId);
        queue.push(childId);
      }
    }
  }

  const localExpressions = spec.expressions.filter((e) =>
    localExprIds.has(e.id)
  );

  // ── 4. Statements referencing local symbols/expressions ───────────
  const localStatements = spec.statements.filter((stmt) =>
    statementReferencesLocal(stmt, localSymbolIds, localExprIds)
  );

  // ── 5. Ambiguities affecting local symbols ────────────────────────
  const localAmbiguities = spec.ambiguities.filter((amb) =>
    amb.affectedIds.some((id) => localSymbolIds.has(id))
  );

  // ── 6. Only include resolutions/patches linked to local ambiguities ─
  const localAmbiguityIds = new Set(localAmbiguities.map((a) => a.id));
  const localResolutions = spec.resolutions.filter((r) =>
    localAmbiguityIds.has(r.ambiguityId)
  );
  const localPatches = spec.patches.filter((p) =>
    localAmbiguityIds.has(p.ambiguityId)
  );

  // ── 7. Build the local slice ──────────────────────────────────────
  // We construct the slice directly rather than via createSemanticSpec
  // because the slice may not satisfy all full-spec invariants (e.g.,
  // analysisStatus derivation may differ when only a subset of
  // ambiguities is present). The slice is a historical snapshot for
  // retrieval/rendering, not an active working spec.
  const slice: SemanticSpec = deepFreeze({
    id: spec.id,
    schemaVersion: spec.schemaVersion,
    claimId: spec.claimId,
    sourceRefs: deepFreeze(matchedSourceRefs),
    symbols: deepFreeze(localSymbols),
    expressions: deepFreeze(localExpressions),
    statements: deepFreeze(localStatements),
    ambiguities: deepFreeze(localAmbiguities),
    resolutions: deepFreeze(localResolutions),
    patches: deepFreeze(localPatches),
    analysisStatus: spec.analysisStatus,
    reviewStatus: spec.reviewStatus,
    revision: spec.revision,
    createdAt: spec.createdAt,
    updatedAt: spec.updatedAt,
    description: spec.description
  } as SemanticSpec);

  return slice;
}

/** Check whether an expression directly references any of the given symbols. */
function referencesAnySymbol(
  expr: Readonly<SemanticExpression>,
  symbolIds: ReadonlySet<string>
): boolean {
  if (expr.symbolId !== undefined && symbolIds.has(expr.symbolId)) {
    return true;
  }
  if (
    expr.operatorSymbolId !== undefined &&
    symbolIds.has(expr.operatorSymbolId)
  ) {
    return true;
  }
  if (
    expr.binderSymbolId !== undefined &&
    symbolIds.has(expr.binderSymbolId)
  ) {
    return true;
  }
  return false;
}

/** Collect all child expression IDs referenced by an expression. */
function collectChildExprIds(
  expr: Readonly<SemanticExpression> | undefined
): string[] {
  if (expr === undefined) {
    return [];
  }
  const ids: string[] = [];
  if (expr.argumentExprIds !== undefined) {
    ids.push(...expr.argumentExprIds);
  }
  if (expr.leftExprId !== undefined) ids.push(expr.leftExprId);
  if (expr.rightExprId !== undefined) ids.push(expr.rightExprId);
  if (expr.operandExprId !== undefined) ids.push(expr.operandExprId);
  if (expr.operandExprIds !== undefined) ids.push(...expr.operandExprIds);
  if (expr.elementExprId !== undefined) ids.push(expr.elementExprId);
  if (expr.collectionExprId !== undefined) ids.push(expr.collectionExprId);
  if (expr.bodyExprId !== undefined) ids.push(expr.bodyExprId);
  if (expr.domainExprId !== undefined) ids.push(expr.domainExprId);
  return ids;
}

/** Check whether a statement references any of the given local symbols/expressions. */
function statementReferencesLocal(
  stmt: Readonly<SemanticStatement>,
  symbolIds: ReadonlySet<string>,
  exprIds: ReadonlySet<string>
): boolean {
  if (
    stmt.subjectSymbolId !== undefined &&
    symbolIds.has(stmt.subjectSymbolId)
  ) {
    return true;
  }
  if (stmt.bodyExprId !== undefined && exprIds.has(stmt.bodyExprId)) {
    return true;
  }
  if (stmt.conclusionExprId !== undefined && exprIds.has(stmt.conclusionExprId)) {
    return true;
  }
  if (stmt.exprId !== undefined && exprIds.has(stmt.exprId)) {
    return true;
  }
  if (stmt.premiseExprIds !== undefined) {
    for (const id of stmt.premiseExprIds) {
      if (exprIds.has(id)) return true;
    }
  }
  return false;
}

// ── Episode Creation ───────────────────────────────────────────────────

function validateEvidenceRefs(
  evidenceRefs: readonly UserTextProvenance[]
): void {
  if (evidenceRefs.length === 0) {
    throw new Error("Semantic prior episode requires at least one user evidence ref.");
  }

  for (let i = 0; i < evidenceRefs.length; i++) {
    const ref = evidenceRefs[i]!;
    if (ref.actor !== "user") {
      throw new Error(
        `Semantic prior evidence ref ${i} has actor "${ref.actor}" — ` +
        `all evidence must be user-authored.`
      );
    }
  }
}

/**
 * Create an immutable SemanticPriorEpisode.
 *
 * The episode is deeply frozen and must never change after creation.
 * It captures a historical snapshot of the assistant's working hypothesis,
 * not a permanent user definition.
 */
export function createSemanticPriorEpisode(
  params: CreateSemanticPriorEpisodeParams
): SemanticPriorEpisode {
  validateEvidenceRefs(params.evidenceRefs);

  const anchors = deriveAnchors(params.semanticSpec, params.evidenceRefs);

  if (anchors.length === 0) {
    throw new Error(
      "Semantic prior episode must have at least one anchor derived from " +
      "the semantic spec or user evidence text."
    );
  }

  const episode: SemanticPriorEpisode = {
    id: generateEpisodeId(),
    createdAt: Date.now(),
    evidenceRefs: deepFreeze(deepClone(params.evidenceRefs)),
    anchors,
    semanticSpec: params.semanticSpec,
    semanticSessionId: params.semanticSessionId,
    semanticRevision: params.semanticRevision
  };

  return deepFreeze(episode);
}

// ── State Management ───────────────────────────────────────────────────

export function createEmptySemanticPriorState(): SemanticPriorState {
  return deepFreeze({
    schemaVersion: SEMANTIC_PRIOR_SCHEMA_VERSION,
    episodes: deepFreeze([])
  });
}

export function addEpisodeToState(
  state: SemanticPriorState,
  episode: SemanticPriorEpisode
): SemanticPriorState {
  return deepFreeze({
    ...state,
    episodes: deepFreeze([...state.episodes, episode])
  });
}

// ── Migration ──────────────────────────────────────────────────────────

/**
 * Migrate/deserialize stored prior state from plugin data.
 *
 * Returns a valid SemanticPriorState from any stored value, defaulting to
 * empty when no prior state exists.
 */
export function migrateSemanticPriorState(
  stored: unknown
): SemanticPriorState {
  if (
    stored === null ||
    stored === undefined ||
    typeof stored !== "object"
  ) {
    return createEmptySemanticPriorState();
  }

  const value = stored as Record<string, unknown>;

  if (
    typeof value.schemaVersion !== "number" ||
    !Array.isArray(value.episodes)
  ) {
    return createEmptySemanticPriorState();
  }

  const episodes: SemanticPriorEpisode[] = [];

  for (const item of value.episodes) {
    if (
      item === null ||
      typeof item !== "object" ||
      typeof (item as Record<string, unknown>).id !== "string" ||
      typeof (item as Record<string, unknown>).createdAt !== "number" ||
      !Array.isArray((item as Record<string, unknown>).evidenceRefs) ||
      !Array.isArray((item as Record<string, unknown>).anchors) ||
      typeof (item as Record<string, unknown>).semanticSpec !== "object" ||
      typeof (item as Record<string, unknown>).semanticSessionId !== "string" ||
      typeof (item as Record<string, unknown>).semanticRevision !== "number"
    ) {
      // Skip malformed episodes during migration
      continue;
    }

    const ep = item as Record<string, unknown>;
    const evidenceRefs = ep.evidenceRefs as unknown[];
    // Validate every evidence ref has actor "user"
    if (
      evidenceRefs.some(
        (ref) =>
          ref === null ||
          typeof ref !== "object" ||
          (ref as Record<string, unknown>).actor !== "user"
      )
    ) {
      continue;
    }

    episodes.push(deepFreeze({
      id: ep.id as string,
      createdAt: ep.createdAt as number,
      evidenceRefs: deepFreeze(ep.evidenceRefs as readonly UserTextProvenance[]),
      anchors: deepFreeze(ep.anchors as readonly string[]),
      semanticSpec: deepFreeze(ep.semanticSpec as SemanticSpec),
      semanticSessionId: ep.semanticSessionId as string,
      semanticRevision: ep.semanticRevision as number
    }) as SemanticPriorEpisode);
  }

  return deepFreeze({
    schemaVersion: SEMANTIC_PRIOR_SCHEMA_VERSION,
    episodes: deepFreeze(episodes)
  });
}

// ── Retrieval ──────────────────────────────────────────────────────────

interface ScoredEpisode {
  episode: SemanticPriorEpisode;
  /**
   * Higher score = more relevant.
   *   - Exact match of entire user text: +100 per match
   *   - Exact anchor match: +50 per anchor
   *   - Substring match: +20 per match
   *   - Longer specific anchor: bonus proportional to length
   */
  score: number;
  matchedAnchors: string[];
}

/**
 * Deterministic lexical scoring of one episode against normalized user
 * text. Shared by the flat retrieval path and the structure-aware
 * retrieval path (M2B.5) so both channels rank identically on lexical
 * evidence.
 */
function scoreEpisodeLexical(
  episode: SemanticPriorEpisode,
  normalizedText: string
): { score: number; matchedAnchors: string[] } {
  let score = 0;
  const matchedAnchors: string[] = [];

  for (const anchor of episode.anchors) {
    const normalizedAnchor = anchor
      .normalize("NFKC")
      .toLocaleLowerCase();

    if (normalizedAnchor.length === 0) {
      continue;
    }

    // Exact match of the full anchor in the user text
    if (normalizedText.includes(normalizedAnchor)) {
      // Longer anchors are more specific — bonus proportional to length
      score += 20 + normalizedAnchor.length;

      // Bonus for anchors that are particularly specific
      if (normalizedAnchor.length >= 6) {
        score += 30;
      }

      matchedAnchors.push(anchor);
    }
    // Partial overlap: anchor contains a substring of user text
    else if (normalizedAnchor.length >= 4) {
      // Check if any meaningful substring of the anchor appears in user text
      const minSubLen = Math.max(3, Math.floor(normalizedAnchor.length * 0.5));
      let found = false;
      for (let i = 0; i <= normalizedAnchor.length - minSubLen; i++) {
        const sub = normalizedAnchor.slice(i, i + minSubLen);
        if (normalizedText.includes(sub)) {
          score += 5 + sub.length;
          found = true;
        }
      }
      if (found) {
        matchedAnchors.push(anchor);
      }
    }
  }

  return { score, matchedAnchors };
}

/**
 * Retrieve a small number of potentially relevant historical episodes.
 *
 * Uses simple deterministic matching: exact/sub-string overlap between
 * current user text and episode anchors.
 *
 * Ranking:
 *   1. Prefer longer/specific anchor matches
 *   2. Prefer more recent episodes when relevance ties
 *   3. Max 3–5 episodes
 */
export function retrieveRelevantPriors(
  state: SemanticPriorState,
  currentUserText: string,
  maxEpisodes: number = MAX_RETRIEVED_EPISODES
): readonly SemanticPriorEpisode[] {
  if (state.episodes.length === 0 || currentUserText.trim() === "") {
    return deepFreeze([]);
  }

  const normalizedText = currentUserText
    .normalize("NFKC")
    .toLocaleLowerCase();

  const scored: ScoredEpisode[] = [];

  for (const episode of state.episodes) {
    const { score, matchedAnchors } = scoreEpisodeLexical(
      episode,
      normalizedText
    );

    if (matchedAnchors.length > 0) {
      scored.push({ episode, score, matchedAnchors });
    }
  }

  // Sort: highest score first, then most recent when scores tie
  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return b.episode.createdAt - a.episode.createdAt;
  });

  return deepFreeze(
    scored.slice(0, maxEpisodes).map((s) => s.episode)
  );
}

// ── Structure-Aware Retrieval (M2B.5) ───────────────────────────────────────────────────────

/** Structural scoring weights for symbol-intersection retrieval. */
const STRUCTURAL_EXACT_MATCH = 6;
const STRUCTURAL_USER_DEFINED_BONUS = 3;
const STRUCTURAL_PARTIAL_MATCH = 2;
const STRUCTURAL_INTERSECTION_BONUS = 8;
const SEED_EXACT_MATCH = 6;
const SEED_CONTAINMENT_MATCH = 2;

/**
 * One symbol occurrence in the cross-episode symbol index.
 */
export interface EpisodeSymbolIndexEntry {
  readonly episode: SemanticPriorEpisode;
  readonly surface: string;
  readonly userDefined: boolean;
}

function normalizeSurface(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().trim();
}

/**
 * Build the in-memory cross-episode symbol index (M2B.5 scope 10d).
 *
 * Maps each normalized symbol surface to every episode whose SemanticSpec
 * contains that symbol. Deterministic: entries are sorted by episode
 * creation time, then episode id.
 */
export function buildEpisodeSymbolIndex(
  episodes: readonly SemanticPriorEpisode[]
): ReadonlyMap<string, readonly EpisodeSymbolIndexEntry[]> {
  const index = new Map<string, EpisodeSymbolIndexEntry[]>();

  for (const episode of episodes) {
    for (const symbol of episode.semanticSpec.symbols) {
      const surface = symbol.surface.trim();
      if (surface === "") {
        continue;
      }
      const key = normalizeSurface(surface);
      if (key === "") {
        continue;
      }
      const entries = index.get(key) ?? [];
      entries.push({
        episode,
        surface,
        userDefined: symbol.userDefined === true
      });
      index.set(key, entries);
    }
  }

  for (const entries of index.values()) {
    entries.sort(
      (a, b) =>
        a.episode.createdAt - b.episode.createdAt ||
        a.episode.id.localeCompare(b.episode.id)
    );
    Object.freeze(entries);
  }

  return index;
}

/**
 * Lexical seed-channel scoring: match query seed surfaces against episode
 * anchors in both containment directions. This is the fallback channel
 * that keeps retrieval working when no structural fields are populated.
 */
function scoreSeedSurfaces(
  episode: SemanticPriorEpisode,
  seedSurfaces: readonly string[]
): number {
  if (seedSurfaces.length === 0) {
    return 0;
  }

  let score = 0;

  for (const seed of seedSurfaces) {
    const normalizedSeed = normalizeSurface(seed);
    if (normalizedSeed.length < MIN_ANCHOR_LENGTH) {
      continue;
    }

    let best = 0;
    for (const anchor of episode.anchors) {
      const normalizedAnchor = normalizeSurface(anchor);
      if (normalizedAnchor.length === 0) {
        continue;
      }
      if (normalizedAnchor === normalizedSeed) {
        best = Math.max(best, SEED_EXACT_MATCH + normalizedAnchor.length);
      } else if (normalizedAnchor.includes(normalizedSeed)) {
        best = Math.max(best, SEED_CONTAINMENT_MATCH + normalizedSeed.length);
      } else if (
        normalizedSeed.includes(normalizedAnchor) &&
        normalizedAnchor.length >= MIN_ANCHOR_LENGTH
      ) {
        best = Math.max(best, SEED_CONTAINMENT_MATCH + normalizedAnchor.length);
      }
    }
    score += best;
  }

  return score;
}

/**
 * Structural scoring: intersect query subject/relation refs with the
 * episode's SemanticSpec symbols. userDefined symbols weigh more; an
 * episode matching BOTH a subject and a relation ref receives an
 * intersection bonus (M2B.5 scope 10e).
 */
function scoreStructuralSymbols(
  episode: SemanticPriorEpisode,
  query: Readonly<SemanticRetrievalQuery>
): { score: number; structuralMatches: string[] } {
  if (query.subjectRefs.length === 0 && query.relationRefs.length === 0) {
    return { score: 0, structuralMatches: [] };
  }

  let score = 0;
  let subjectMatched = false;
  let relationMatched = false;
  const structuralMatches: string[] = [];

  for (const symbol of episode.semanticSpec.symbols) {
    const symbolSurface = normalizeSurface(symbol.surface);
    if (symbolSurface === "") {
      continue;
    }

    for (const ref of query.subjectRefs) {
      const refSurface = normalizeSurface(ref.surface);
      if (refSurface === "") {
        continue;
      }
      if (symbolSurface === refSurface) {
        score += STRUCTURAL_EXACT_MATCH;
        if (symbol.userDefined === true) {
          score += STRUCTURAL_USER_DEFINED_BONUS;
        }
        subjectMatched = true;
        structuralMatches.push(symbol.surface.trim());
      } else if (
        symbolSurface.includes(refSurface) ||
        refSurface.includes(symbolSurface)
      ) {
        if (
          Math.min(symbolSurface.length, refSurface.length) >=
          MIN_ANCHOR_LENGTH
        ) {
          score += STRUCTURAL_PARTIAL_MATCH;
          subjectMatched = true;
        }
      }
    }

    for (const ref of query.relationRefs) {
      const refSurface = normalizeSurface(ref.surface);
      if (refSurface === "") {
        continue;
      }
      if (symbolSurface === refSurface) {
        score += STRUCTURAL_EXACT_MATCH;
        if (symbol.userDefined === true) {
          score += STRUCTURAL_USER_DEFINED_BONUS;
        }
        relationMatched = true;
        structuralMatches.push(symbol.surface.trim());
      } else if (
        symbolSurface.includes(refSurface) ||
        refSurface.includes(symbolSurface)
      ) {
        if (
          Math.min(symbolSurface.length, refSurface.length) >=
          MIN_ANCHOR_LENGTH
        ) {
          score += STRUCTURAL_PARTIAL_MATCH;
          relationMatched = true;
        }
      }
    }
  }

  if (subjectMatched && relationMatched) {
    score += STRUCTURAL_INTERSECTION_BONUS;
  }

  return { score, structuralMatches: [...new Set(structuralMatches)] };
}

/**
 * Retrieve historical episodes using structure-aware seeding (M2B.5).
 *
 * The total score adjoins three deterministic channels:
 *   1. Lexical baseline: the established flat anchor matching against the
 *      current user text (unchanged from M2B.4).
 *   2. Seed surfaces: query lexical seeds matched against anchors in both
 *      containment directions.
 *   3. Structural intersection: subject/relation refs intersected with
 *      episode symbols, weighted by userDefined, with an intersection
 *      bonus when both channels land on the same episode.
 *
 * With an empty query this degrades exactly to the flat lexical result —
 * fail-safe, never fail-dangerous. No LLM call is involved.
 */
export function retrieveRelevantPriorsStructured(
  state: SemanticPriorState,
  currentUserText: string,
  query: Readonly<SemanticRetrievalQuery>,
  maxEpisodes: number = MAX_RETRIEVED_EPISODES
): readonly SemanticPriorEpisode[] {
  if (state.episodes.length === 0 || currentUserText.trim() === "") {
    return deepFreeze([]);
  }

  const normalizedText = currentUserText
    .normalize("NFKC")
    .toLocaleLowerCase();

  const scored: Array<{
    episode: SemanticPriorEpisode;
    score: number;
  }> = [];

  for (const episode of state.episodes) {
    const lexical = scoreEpisodeLexical(episode, normalizedText);
    const seedScore = scoreSeedSurfaces(episode, query.seedSurfaces);
    const structural = scoreStructuralSymbols(episode, query);

    const total = lexical.score + seedScore + structural.score;
    if (total > 0) {
      scored.push({ episode, score: total });
    }
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.episode.createdAt - a.episode.createdAt ||
      a.episode.id.localeCompare(b.episode.id)
  );

  return deepFreeze(scored.slice(0, maxEpisodes).map((s) => s.episode));
}

// ── Rendering ──────────────────────────────────────────────────────────

/**
 * Render selected prior episodes into a compact advisory prompt section.
 *
 * This is deterministic — no LLM call is used to summarize priors.
 *
 * The rendered output explicitly states:
 *   - priors are historical assistant hypotheses
 *   - they are not user definitions
 *   - current user language always has higher authority
 */
export function renderPriorsForPrompt(
  episodes: readonly SemanticPriorEpisode[],
  maxChars: number = MAX_PRIOR_CONTEXT_CHARS
): string {
  if (episodes.length === 0) {
    return "";
  }

  const header = [
    "── Historical semantic priors ──",
    "",
    "The following are historical ASSISTANT WORKING HYPOTHESES derived from",
    "earlier user-authored language.",
    "",
    "They are not definitions of the user.",
    "They are not authoritative.",
    "They are not UserConclusions.",
    "",
    "Use them only as tentative starting points when they genuinely help",
    "interpret the CURRENT message.",
    "",
    "The current user's language always has greater authority than any",
    "historical prior.",
    "",
    "If the current message conflicts with a prior:",
    "- follow the current message",
    "- treat the old prior as historical",
    "- do not tell the user they are contradicting their \"stored definition\"",
    "- do not force reconciliation",
    "- do not silently carry conclusions from the old premise"
  ].join("\n");

  const parts: string[] = [header];
  let totalChars = header.length;

  for (const episode of episodes) {
    const rendered = renderSingleEpisode(episode);
    const withSeparator = `\n\n── Episode ${episode.id.slice(-8)} ──\n${rendered}`;

    if (totalChars + withSeparator.length > maxChars) {
      // If we can't fit the full episode, try a truncated version
      const remaining = maxChars - totalChars - 50;
      if (remaining > 200) {
        parts.push(`\n\n── Episode ${episode.id.slice(-8)} (truncated) ──`);
        parts.push(renderSingleEpisodeCompact(episode, remaining));
      }
      break;
    }

    parts.push(withSeparator);
    totalChars += withSeparator.length;
  }

  return parts.join("");
}

function renderSingleEpisode(episode: SemanticPriorEpisode): string {
  const lines: string[] = [];

  // Anchors
  if (episode.anchors.length > 0) {
    const displayAnchors = episode.anchors.slice(0, 6);
    lines.push(`User phrases: ${displayAnchors.join(", ")}`);
  }

  // Symbols from the semantic spec
  const symbols = episode.semanticSpec.symbols;
  if (symbols.length > 0) {
    const significantSymbols = symbols.filter(
      (s) =>
        s.userDefined === true ||
        s.role === "unresolved" ||
        s.role === "concept" ||
        s.role === "relation" ||
        s.role === "function" ||
        s.role === "operator"
    );

    if (significantSymbols.length > 0) {
      const symbolLines = significantSymbols.slice(0, 5).map((s) => {
        const roleLabel = s.userDefined === true
          ? `user-created ${s.role}`
          : s.role;
        const desc = s.description !== undefined
          ? ` — ${truncate(s.description, 80)}`
          : "";
        return `  "${s.surface}": ${roleLabel}${desc}`;
      });
      lines.push(`Historical working hypothesis treated:`);
      lines.push(...symbolLines);
    }
  }

  // Unresolved ambiguities from the spec
  const unresolvedAmbigs = episode.semanticSpec.ambiguities.filter(
    (a) => a.blocking
  );
  if (unresolvedAmbigs.length > 0) {
    lines.push("Unresolved at that time:");
    for (const amb of unresolvedAmbigs.slice(0, 3)) {
      lines.push(`  - ${truncate(amb.question, 120)}`);
    }
  }

  // Evidence excerpts
  if (episode.evidenceRefs.length > 0) {
    lines.push("User evidence:");
    for (const ref of episode.evidenceRefs.slice(0, 2)) {
      const excerpt = materializeProvenanceExcerpt(ref, 120);
      if (excerpt !== "") {
        lines.push(`  "${excerpt}"`);
      }
    }
  }

  return lines.join("\n");
}

function renderSingleEpisodeCompact(
  episode: SemanticPriorEpisode,
  maxChars: number
): string {
  const full = renderSingleEpisode(episode);
  if (full.length <= maxChars) {
    return full;
  }
  // Truncate to fit
  return full.slice(0, maxChars - 3) + "...";
}

function materializeProvenanceExcerpt(
  source: Readonly<UserTextProvenance>,
  maxLen: number
): string {
  let text: string;
  if (source.sourceKind === "user_edit") {
    text = source.snapshot;
  } else if (
    source.startOffset !== undefined &&
    source.endOffset !== undefined
  ) {
    text = source.snapshot.slice(source.startOffset, source.endOffset);
  } else {
    text = source.snapshot;
  }
  return truncate(text, maxLen);
}

function truncate(value: string, maxLen: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) {
    return normalized;
  }
  return normalized.slice(0, maxLen - 3) + "...";
}

// ── Developer Diagnostics ──────────────────────────────────────────────

export function getSemanticPriorEpisodeCount(
  state: SemanticPriorState
): number {
  return state.episodes.length;
}

export function getSemanticPriorEpisodes(
  state: SemanticPriorState
): readonly SemanticPriorEpisode[] {
  return state.episodes;
}

export function getLastInjectedSemanticPriorIds(
  episodes: readonly SemanticPriorEpisode[]
): readonly string[] {
  return episodes.map((e) => e.id);
}
