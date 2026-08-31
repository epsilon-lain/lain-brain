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

// ── Underspecified retrieval surface gate ──────────────────────────────
//
// UNDERSPECIFIED DISCOURSE REFERENCE != HISTORICAL RETRIEVAL RELEVANCE.
//
// Demonstratives and generic discourse scaffolding may remain in the raw
// user utterance, the SemanticSpec, and local/coreference reasoning — but
// they must not, BY THEMSELVES, retrieve a cross-chat historical episode.
// This gate is used at the HISTORICAL RETRIEVAL boundary only; it is not
// a general language filter. A phrase that combines a demonstrative with
// specific material ("这个算法", "这个定理") is specific and stays usable;
// only purely underspecified surfaces are blocked.
//
// CJK rule: a surface is underspecified when EVERY character is a generic
// discourse character (demonstrative, interrogative, particle, pronoun,
// connective, copula). This blocks "这个" as well as its n-gram
// derivatives ("这个怎", "个怎么", "怎么样") without blocking "这个算法".
// ────────────────────────────────────────────────────────────────────────

const UNDERSPECIFIED_CJK_CHARS = new Set([
  "这", "那", "哪", "些", "什", "么", "怎", "样", "何", "谁",
  "呢", "吗", "吧", "啊", "呀", "的", "了", "个", "是", "就",
  "也", "都", "很", "没", "不", "但", "因", "所", "以", "如",
  "果", "还", "而", "且", "或", "与", "并", "我", "你", "他",
  "她", "它", "们", "为", "有", "可", "已", "经", "自", "己",
  "一", "只", "又", "才", "再", "之", "其", "在", "要", "会",
  "能"
]);

const UNDERSPECIFIED_ENGLISH_SURFACES = new Set([
  "this", "that", "it", "these", "those", "what", "which", "who",
  "whom", "how", "why", "when", "where", "about", "thing", "things",
  "one", "ones", "please", "just", "maybe", "something", "anything",
  "everything", "nothing"
]);

/**
 * Is this surface purely underspecified discourse scaffolding?
 * Shared by query-seed derivation, anchor derivation, and retrieval-time
 * scoring so all historical retrieval channels apply one notion.
 */
export function isUnderspecifiedRetrievalSurface(surface: string): boolean {
  const normalized = surface
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(
      /^[\s，。！？,.!?;；:："'“‘”’]+|[\s，。！？,.!?;；:："'“‘”’]+$/gu,
      ""
    )
    .trim();
  if (normalized === "") {
    return true;
  }
  if (/^[a-zà-ɏ]+$/u.test(normalized)) {
    return UNDERSPECIFIED_ENGLISH_SURFACES.has(normalized);
  }
  if (/^[㐀-鿿]+$/u.test(normalized)) {
    return [...normalized].every((ch) =>
      UNDERSPECIFIED_CJK_CHARS.has(ch)
    );
  }
  // Mixed or other scripts: treat as specific (conservative).
  return false;
}

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
 *
 * Underspecified surfaces (demonstrative/interrogative scaffolding and
 * their n-gram derivatives) are removed here, at the retrieval-seed
 * boundary: they must not seed historical retrieval on their own.
 * extractLexicalSurfaces itself is unchanged.
 */
export function deriveLexicalSeedSurfaces(
  utteranceText: string
): readonly string[] {
  return deepFreeze(
    extractLexicalSurfaces(utteranceText)
      .filter((surface) => !isUnderspecifiedRetrievalSurface(surface))
  );
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
    // Generic discourse references must not act as cross-chat retrieval
    // keys (the SemanticSpec itself is untouched). Variable-role symbols
    // still seed open slots: slots are not retrieval keys.
    const retrievableRef = !isUnderspecifiedRetrievalSurface(surface);

    if (
      symbol.role === "entity" ||
      symbol.role === "concept" ||
      symbol.role === "domain" ||
      symbol.role === "collection"
    ) {
      if (retrievableRef && !seenSubjects.has(key)) {
        seenSubjects.add(key);
        subjectRefs.push({ surface, roleHint: symbol.role });
      }
    } else if (
      symbol.role === "relation" ||
      symbol.role === "predicate" ||
      symbol.role === "function" ||
      symbol.role === "operator"
    ) {
      if (retrievableRef && !seenRelations.has(key)) {
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
