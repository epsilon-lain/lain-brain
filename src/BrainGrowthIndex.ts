import type { ConceptNode } from "./BrainGrowth";

export type ConceptLookupMatchKind =
  | "stable_id"
  | "exact_title"
  | "normalized_title"
  | "alias";

export interface ConceptLookupMatch {
  readonly concept: ConceptNode;
  readonly matchedBy: ConceptLookupMatchKind;
}

export type ConceptLookupResult =
  | {
      readonly kind: "not_found";
      readonly query: string;
    }
  | {
      readonly kind: "unique_match";
      readonly query: string;
      readonly match: ConceptLookupMatch;
    }
  | {
      readonly kind: "ambiguous_matches";
      readonly query: string;
      readonly matches: readonly ConceptLookupMatch[];
    };

export interface ConceptIndex {
  /** Input order is retained as the deterministic tie order. */
  readonly concepts: readonly ConceptNode[];
}

export function normalizeConceptLookupText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ")
    .toLocaleLowerCase();
}

export function createConceptIndex(
  concepts: readonly ConceptNode[]
): ConceptIndex {
  return Object.freeze({ concepts: Object.freeze([...concepts]) });
}

function resultFromMatches(
  query: string,
  matches: readonly ConceptLookupMatch[]
): ConceptLookupResult {
  if (matches.length === 0) {
    return Object.freeze({ kind: "not_found", query });
  }
  if (matches.length === 1) {
    return Object.freeze({
      kind: "unique_match",
      query,
      match: Object.freeze(matches[0]!)
    });
  }
  return Object.freeze({
    kind: "ambiguous_matches",
    query,
    matches: Object.freeze(matches.map((match) => Object.freeze(match)))
  });
}

function findMatches(
  index: Readonly<ConceptIndex>,
  query: string,
  matchedBy: ConceptLookupMatchKind,
  predicate: (concept: Readonly<ConceptNode>) => boolean
): ConceptLookupResult {
  return resultFromMatches(
    query,
    index.concepts
      .filter(predicate)
      .map((concept) => ({ concept, matchedBy }))
  );
}

export function lookupConceptById(
  index: Readonly<ConceptIndex>,
  conceptId: string
): ConceptLookupResult {
  return findMatches(
    index,
    conceptId,
    "stable_id",
    (concept) => concept.id === conceptId
  );
}

export function lookupConceptByExactTitle(
  index: Readonly<ConceptIndex>,
  title: string
): ConceptLookupResult {
  return findMatches(
    index,
    title,
    "exact_title",
    (concept) => concept.title === title
  );
}

export function lookupConceptByNormalizedTitle(
  index: Readonly<ConceptIndex>,
  title: string
): ConceptLookupResult {
  const normalized = normalizeConceptLookupText(title);
  return findMatches(
    index,
    title,
    "normalized_title",
    (concept) => normalizeConceptLookupText(concept.title) === normalized
  );
}

export function lookupConceptByAlias(
  index: Readonly<ConceptIndex>,
  alias: string
): ConceptLookupResult {
  const normalized = normalizeConceptLookupText(alias);
  return findMatches(
    index,
    alias,
    "alias",
    (concept) => concept.aliases.some(
      (candidate) => normalizeConceptLookupText(candidate) === normalized
    )
  );
}

/**
 * Conservative convenience lookup. Stronger identity/label matches win, but
 * each tier preserves multiple candidates instead of choosing one.
 */
export function lookupConcept(
  index: Readonly<ConceptIndex>,
  query: string
): ConceptLookupResult {
  const finders = [
    lookupConceptById,
    lookupConceptByExactTitle,
    lookupConceptByNormalizedTitle,
    lookupConceptByAlias
  ] as const;

  for (const find of finders) {
    const result = find(index, query);
    if (result.kind !== "not_found") {
      return result;
    }
  }

  return Object.freeze({ kind: "not_found", query });
}
