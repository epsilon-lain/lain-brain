// ── M2B.6a-v0 — Runtime Sense Projection ────────────────────────────────
// Transient, read-only projection of the EXISTING ConceptNode authority
// buckets into uniform sense candidates for ONE foreground request.
//
// Hard invariants (see M2B6A_CONTEXTUAL_SENSE_LAYER_DESIGN.md):
//   - projection performs NO persistence and never mutates ConceptNodes;
//   - the provenance of each source bucket is retained, never invented
//     and never erased;
//   - derived runtime ids are deterministic and stable per source entry
//     (never array-position dependent when a stable source id exists);
//   - authority is metadata only — it never contributes to contextual
//     relevance scoring (see ContextualSenseActivation).
// ────────────────────────────────────────────────────────────────────────

import type { ConceptNode } from "./BrainGrowth";
import type { UserTextProvenance } from "./KnowledgeProtocol";
import { extractLexicalSurfaces } from "./SemanticRetrievalQuery";

/** Authority classes of the runtime sense model. Metadata, never a score. */
export type RuntimeSenseAuthority =
  | "user_confirmed_personal"
  | "user_authored_unconfirmed"
  | "external_conventional"
  | "ai_provisional";

/** Per-class provenance. The original source metadata is retained. */
export type RuntimeSenseProvenance =
  | {
      readonly kind: "user_text";
      readonly refs: readonly UserTextProvenance[];
    }
  | {
      readonly kind: "external_source";
      readonly refs: readonly string[];
    }
  | {
      readonly kind: "ai_generated";
      readonly refs: readonly string[];
    };

/** The existing ConceptNode bucket a candidate was projected from. */
export type RuntimeSenseSourceBucket =
  | "userDefinition"
  | "alternativeUserDefinitions"
  | "standardDefinitions"
  | "generatedInterpretations";

/** One transient sense candidate. Never persisted, never mutated. */
export interface RuntimeSenseCandidate {
  /** Deterministic: `sense:<conceptId>:<authority>:<sourceEntryId>`. */
  readonly id: string;
  readonly conceptId: string;
  readonly conceptTitle: string;
  /** The concept surface (title or alias) matched in the utterance. */
  readonly matchedSurface: string;
  readonly meaning: string;
  readonly authority: RuntimeSenseAuthority;
  readonly provenance: RuntimeSenseProvenance;
  readonly sourceBucket: RuntimeSenseSourceBucket;
}

const MAX_DISTINCTIVE_TERMS = 12;

export function normalizeSurfaceText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function containsCjk(value: string): boolean {
  return /[㐀-䶿一-鿿豈-﫿]/u.test(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Deterministic surface mention check. CJK surfaces use plain substring
 * containment (Chinese text has no word separators); alphabetic surfaces
 * require word boundaries so "lain" never matches "explain".
 */
export function containsSurfaceMention(
  text: string,
  surface: string
): boolean {
  const normalizedText = normalizeSurfaceText(text);
  const normalizedSurface = normalizeSurfaceText(surface);
  if (normalizedSurface === "") {
    return false;
  }
  if (containsCjk(normalizedSurface)) {
    return normalizedText.includes(normalizedSurface);
  }
  const pattern = new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${escapeRegex(normalizedSurface)}(?:[^\\p{L}\\p{N}]|$)`,
    "iu"
  );
  return pattern.test(normalizedText);
}

/** Distinct concept surfaces: title plus aliases, deduplicated. */
export function conceptSurfaces(
  node: Readonly<ConceptNode>
): readonly string[] {
  const surfaces: string[] = [];
  const seen = new Set<string>();
  for (const surface of [node.title, ...node.aliases]) {
    const key = normalizeSurfaceText(surface);
    if (key !== "" && !seen.has(key)) {
      seen.add(key);
      surfaces.push(surface);
    }
  }
  return Object.freeze(surfaces);
}

/**
 * All concept surfaces mentioned in the utterance, longest first.
 * Empty when the utterance does not mention the concept at all.
 */
export function findConceptSurfaceMentions(
  node: Readonly<ConceptNode>,
  utterance: string
): readonly string[] {
  const mentioned = conceptSurfaces(node).filter((surface) =>
    containsSurfaceMention(utterance, surface)
  );
  mentioned.sort((a, b) => b.length - a.length || a.localeCompare(b));
  return Object.freeze(mentioned);
}

function userTextProvenance(
  refs: readonly UserTextProvenance[]
): RuntimeSenseProvenance {
  return Object.freeze({
    kind: "user_text" as const,
    refs: Object.freeze([...refs])
  });
}

/**
 * Project the EXISTING ConceptNode authority buckets into transient sense
 * candidates. Read-only and deterministic. Provenance per bucket:
 *   userDefinition            → user_confirmed_personal  (user_text)
 *   alternativeUserDefinitions→ user_authored_unconfirmed (user_text)
 *   standardDefinitions       → external_conventional    (external_source,
 *                                                         sourceReferences
 *                                                         retained verbatim)
 *   generatedInterpretations  → ai_provisional           (ai_generated)
 *
 * Stale generated interpretations (derivedStatus === "stale") have been
 * mechanically invalidated by the Brain staleness machinery and are never
 * projected: they must not be resurrected as runtime senses, activated, or
 * used to derive retrieval seed terms. Entries with derivedStatus
 * "current" or undefined (legacy) project unchanged.
 */
export function projectRuntimeSenseCandidates(
  node: Readonly<ConceptNode>,
  matchedSurface: string
): readonly RuntimeSenseCandidate[] {
  const candidates: RuntimeSenseCandidate[] = [];

  const push = (
    entryId: string,
    meaning: string,
    authority: RuntimeSenseAuthority,
    provenance: RuntimeSenseProvenance,
    sourceBucket: RuntimeSenseSourceBucket
  ): void => {
    candidates.push(Object.freeze({
      id: `sense:${node.id}:${authority}:${entryId}`,
      conceptId: node.id,
      conceptTitle: node.title,
      matchedSurface,
      meaning,
      authority,
      provenance,
      sourceBucket
    }));
  };

  if (node.userDefinition !== undefined) {
    push(
      node.userDefinition.id,
      node.userDefinition.text,
      "user_confirmed_personal",
      userTextProvenance(node.userDefinition.sourceRefs),
      "userDefinition"
    );
  }

  for (const definition of node.alternativeUserDefinitions) {
    push(
      definition.id,
      definition.text,
      "user_authored_unconfirmed",
      userTextProvenance(definition.sourceRefs),
      "alternativeUserDefinitions"
    );
  }

  for (const entry of node.standardDefinitions) {
    push(
      entry.id,
      entry.text,
      "external_conventional",
      Object.freeze({
        kind: "external_source" as const,
        refs: Object.freeze([...entry.sourceReferences])
      }),
      "standardDefinitions"
    );
  }

  for (const entry of node.generatedInterpretations) {
    if (entry.derivedStatus === "stale") {
      continue;
    }
    push(
      entry.id,
      entry.text,
      "ai_provisional",
      Object.freeze({
        kind: "ai_generated" as const,
        refs: Object.freeze([...entry.sourceReferences])
      }),
      "generatedInterpretations"
    );
  }

  return Object.freeze(candidates);
}

/**
 * Distinctive terms for contextual matching: lexical surfaces of the
 * meaning plus the usable provenance text, minus the concept's own
 * surfaces (identity of the concept is not sense-discriminating).
 * Deterministic and bounded.
 */
export function deriveDistinctiveTerms(
  candidate: Readonly<RuntimeSenseCandidate>,
  conceptSurfaceList: readonly string[]
): readonly string[] {
  const sources: string[] = [candidate.meaning];
  for (const ref of candidate.provenance.refs) {
    const text = typeof ref === "string" ? ref : ref.snapshot;
    if (text.trim() !== "") {
      sources.push(text);
    }
  }

  const ownSurfaces = new Set(
    conceptSurfaceList.map((surface) => normalizeSurfaceText(surface))
      .filter((surface) => surface !== "")
  );

  const terms = new Set<string>();
  for (const source of sources) {
    for (const surface of extractLexicalSurfaces(source)) {
      const normalized = normalizeSurfaceText(surface);
      if (normalized.length < 2) {
        continue;
      }
      const overlapsOwnSurface = [...ownSurfaces].some((own) =>
        normalized === own ||
        normalized.includes(own) ||
        own.includes(normalized)
      );
      if (!overlapsOwnSurface) {
        terms.add(normalized);
      }
    }
  }

  return Object.freeze([...terms].sort().slice(0, MAX_DISTINCTIVE_TERMS));
}
