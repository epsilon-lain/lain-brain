// ── Semantic Retrieval Query (M2B.5) ───────────────────────────────────
// Provisional retrieval structure for historical semantic prior episodes.
//
// A SemanticRetrievalQuery is derived deterministically from the current
// user utterance and, when available, the current working SemanticSpec.
// It seeds prior retrieval; it never mutates the Brain, never becomes an
// authoritative parse, and never authorizes semantic change.
//
// Invariants:
//   1. The query is an assistant-side interpretation of the current
//      utterance. It obeys the same authority rules as the SemanticSpec:
//      the user's current language always outranks it.
//   2. Derivation is deterministic — no LLM call, no network access.
//   3. If the structure is wrong or missing, retrieval degrades to
//      surface matching (fail-safe, never fail-dangerous).
// ────────────────────────────────────────────────────────────────────────

import type { SemanticSpec } from "./SemanticSpec";

// ── Constants ──────────────────────────────────────────────────────────

/** Maximum number of lexical seed surfaces kept per derivation. */
const MAX_LEXICAL_SURFACES = 64;

/**
 * Maximum CJK run length preserved whole. Longer runs still contribute
 * bigram/trigram surfaces but are too generic to anchor whole.
 */
const MAX_WHOLE_RUN_LENGTH = 8;

/**
 * Generic interrogative / demonstrative / connective surfaces that must
 * not seed retrieval on their own. Applied to lexical surfaces only;
 * symbol-derived structural refs are never filtered here.
 */
const LEXICAL_STOP_SURFACES = new Set([
  "什么", "怎么", "为什么", "这个", "那个", "哪个", "哪些",
  "我们", "你们", "它们", "自己", "可以", "没有", "但是",
  "因为", "所以", "如果", "已经", "还是", "就是", "一个"
]);

const CJK_RUN_PATTERN = "[一-鿿㐀-䶿]{2,}";
const ALPHA_WORD_PATTERN = "[a-zA-ZÀ-ɏ]{4,}";

// ── Types ──────────────────────────────────────────────────────────────

export type TemporalIntent =
  | "current_state"
  | "historical_state"
  | "revision_history"
  | "unspecified";

export type RetrievalIntent =
  | "fill_slot"
  | "lookup_definition"
  | "find_evidence"
  | "find_related"
  | "propagate_change"
  | "understand_context";

export type RelationRefKind =
  | "user_relation"
  | "standard_relation"
  | "unknown";

export type OpenSlotRole = "object" | "definition" | "evidence" | "related";

export interface SubjectRef {
  readonly surface: string;
  readonly roleHint?: string;
}

export interface RelationRef {
  readonly surface: string;
  readonly kind: RelationRefKind;
}

export interface OpenSlot {
  readonly role: OpenSlotRole;
  readonly constraint?: string;
}

/**
 * Provisional semantic retrieval query derived from the current user
 * utterance.
 *
 * This remains an assistant interpretation — it obeys the same
 * semantic-authority rules as the rest of Lain Brain.
 */
export interface SemanticRetrievalQuery {
  /**
   * Exact user surface forms that seed the retrieval. These are the raw
   * language tokens that MUST be findable in history.
   */
  readonly seedSurfaces: readonly string[];

  /** Entities / concepts that the query is ABOUT. */
  readonly subjectRefs: readonly SubjectRef[];

  /** Relations mentioned or implied by the query. */
  readonly relationRefs: readonly RelationRef[];

  /**
   * Slots that the query is asking to FILL. UNKNOWN means "the answer to
   * this slot is what we're searching for."
   */
  readonly openSlots: readonly OpenSlot[];

  /** Temporal framing of the query. */
  readonly temporalIntent: TemporalIntent;

  /** What kind of retrieval this is. */
  readonly retrievalIntent: RetrievalIntent;
}

export interface BuildSemanticRetrievalQueryParams {
  readonly utteranceText: string;
  readonly semanticSpec?: Readonly<SemanticSpec>;
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

// ── Lexical Surface Extraction ─────────────────────────────────────────

/**
 * Extract deterministic lexical surfaces from raw user-authored text.
 *
 * CJK runs contribute the whole run (when short enough) plus all bigram,
 * trigram, and 4-gram windows. Alphabetic words of 4+ characters contribute
 * their lowercased form. Generic stop surfaces are filtered. The result is
 * deduplicated and sorted so derivation is deterministic.
 */
export function extractLexicalSurfaces(text: string): readonly string[] {
  const surfaces = new Set<string>();

  const cjkRegex = new RegExp(CJK_RUN_PATTERN, "g");
  let match: RegExpExecArray | null;
  while ((match = cjkRegex.exec(text)) !== null) {
    const run = match[0];
    if (run.length <= MAX_WHOLE_RUN_LENGTH) {
      surfaces.add(run);
    }
    for (let i = 0; i + 2 <= run.length; i += 1) {
      surfaces.add(run.slice(i, i + 2));
    }
    for (let i = 0; i + 3 <= run.length; i += 1) {
      surfaces.add(run.slice(i, i + 3));
    }
    for (let i = 0; i + 4 <= run.length; i += 1) {
      surfaces.add(run.slice(i, i + 4));
    }
  }

  const alphaRegex = new RegExp(ALPHA_WORD_PATTERN, "g");
  while ((match = alphaRegex.exec(text)) !== null) {
    surfaces.add(match[0].toLowerCase());
  }

  return deepFreeze(
    [...surfaces]
      .filter((surface) => !LEXICAL_STOP_SURFACES.has(surface))
      .sort()
      .slice(0, MAX_LEXICAL_SURFACES)
  );
}

/**
 * Derive lexical retrieval seeds from the current utterance text.
 * Channel 1 in the M2B.5 design: deterministic and zero-cost.
 */
export function deriveLexicalSeedSurfaces(
  utteranceText: string
): readonly string[] {
  return extractLexicalSurfaces(utteranceText);
}

// ── Query Construction ─────────────────────────────────────────────────

/**
 * Create a structurally empty query. Retrieval driven by this query must
 * degrade to pure surface matching — the fail-safe floor.
 */
export function createEmptySemanticRetrievalQuery(): SemanticRetrievalQuery {
  return deepFreeze({
    seedSurfaces: deepFreeze([]),
    subjectRefs: deepFreeze([]),
    relationRefs: deepFreeze([]),
    openSlots: deepFreeze([]),
    temporalIntent: "unspecified",
    retrievalIntent: "understand_context"
  });
}

/**
 * Build a SemanticRetrievalQuery deterministically.
 *
 * Channel 1 (lexical): seedSurfaces from the utterance text.
 * Channel 2 (structural, only when a spec is supplied):
 *   - entity/concept/domain/collection symbols → subjectRefs
 *   - relation/predicate/function/operator symbols → relationRefs
 *   - variable symbols and blocking ambiguities → openSlots
 *
 * No LLM call is made. The result is deeply frozen.
 */
export function buildSemanticRetrievalQuery(
  params: BuildSemanticRetrievalQueryParams
): SemanticRetrievalQuery {
  const seedSurfaces = deriveLexicalSeedSurfaces(params.utteranceText);
  const spec = params.semanticSpec;

  if (spec === undefined) {
    return deepFreeze({
      seedSurfaces,
      subjectRefs: deepFreeze([]),
      relationRefs: deepFreeze([]),
      openSlots: deepFreeze([]),
      temporalIntent: "unspecified",
      retrievalIntent: "understand_context"
    });
  }

  const subjectRefs: SubjectRef[] = [];
  const relationRefs: RelationRef[] = [];
  const openSlots: OpenSlot[] = [];
  const seenSubjects = new Set<string>();
  const seenRelations = new Set<string>();

  for (const symbol of spec.symbols) {
    const surface = symbol.surface.trim();
    if (surface === "") {
      continue;
    }
    const key = surface.normalize("NFKC").toLocaleLowerCase();

    if (
      symbol.role === "entity" ||
      symbol.role === "concept" ||
      symbol.role === "domain" ||
      symbol.role === "collection"
    ) {
      if (!seenSubjects.has(key)) {
        seenSubjects.add(key);
        subjectRefs.push({ surface, roleHint: symbol.role });
      }
    } else if (
      symbol.role === "relation" ||
      symbol.role === "predicate" ||
      symbol.role === "function" ||
      symbol.role === "operator"
    ) {
      if (!seenRelations.has(key)) {
        seenRelations.add(key);
        relationRefs.push({
          surface,
          kind: symbol.userDefined === true ? "user_relation" : "unknown"
        });
      }
    } else if (symbol.role === "variable") {
      const slot: OpenSlot = symbol.description !== undefined
        ? { role: "object", constraint: symbol.description }
        : { role: "object" };
      openSlots.push(slot);
    }
  }

  for (const ambiguity of spec.ambiguities) {
    if (!ambiguity.blocking) {
      continue;
    }
    openSlots.push({
      role: ambiguity.kind === "definition_scope" ? "definition" : "related",
      constraint: ambiguity.question
    });
  }

  subjectRefs.sort((a, b) => (a.surface < b.surface ? -1 : a.surface > b.surface ? 1 : 0));
  relationRefs.sort((a, b) => (a.surface < b.surface ? -1 : a.surface > b.surface ? 1 : 0));

  return deepFreeze({
    seedSurfaces,
    subjectRefs: deepFreeze(subjectRefs),
    relationRefs: deepFreeze(relationRefs),
    openSlots: deepFreeze(openSlots),
    temporalIntent: "unspecified",
    retrievalIntent: openSlots.length > 0 ? "fill_slot" : "understand_context"
  });
}
