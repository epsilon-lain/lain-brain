// ── Concept Binding Resolver ───────────────────────────────────────────
// Binds surface phrases to stable Personal Brain ConceptNodes without ever
// identifying a concept by display string alone.
//
// Personal definitions are authoritative.  A resolved binding therefore
// carries both the personal definition (if any) and the standard definition
// (if any) separately, plus an explicit `definitionConflict` flag so the
// formalization layer can warn instead of silently correcting the user.
// ────────────────────────────────────────────────────────────────────────

import {
  lookupConcept,
  lookupConceptById,
  normalizeConceptLookupText,
  type ConceptIndex,
  type ConceptLookupMatchKind
} from "./BrainGrowthIndex";
import type { ConceptNode } from "./BrainGrowth";
import type {
  ConceptBinding,
  ConceptBindingAlternative,
  ConceptRevisionRef,
  ConceptResolutionMethod
} from "./PersonalSemanticIR";

function generateId(): string {
  try {
    return globalThis.crypto?.randomUUID?.() ?? fallbackId();
  } catch {
    return fallbackId();
  }
}

function fallbackId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function firstNonEmpty(
  values: readonly (string | undefined)[]
): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

function standardDefinitionOf(concept: Readonly<ConceptNode>): string | undefined {
  return firstNonEmpty(
    concept.standardDefinitions.map((entry) => entry.text)
  );
}

function conceptRevisionRef(
  concept: Readonly<ConceptNode>,
  matchedBy: ConceptResolutionMethod
): ConceptRevisionRef {
  return {
    conceptId: concept.id,
    revision: concept.revision,
    title: concept.title,
    matchedBy
  };
}

function bindingFromResolved(
  phrase: string,
  concept: Readonly<ConceptNode>,
  matchedBy: ConceptLookupMatchKind
): ConceptBinding {
  const personalDefinition = concept.userDefinition?.text;
  const standardDefinition = standardDefinitionOf(concept);
  const definitionConflict =
    personalDefinition !== undefined &&
    standardDefinition !== undefined &&
    normalizeConceptLookupText(personalDefinition) !==
      normalizeConceptLookupText(standardDefinition);

  return {
    id: generateId(),
    surfacePhrase: phrase,
    status: "resolved",
    conceptId: concept.id,
    conceptRevision: concept.revision,
    resolvedTitle: concept.title,
    resolutionMethod: matchedBy,
    personalDefinition,
    standardDefinition,
    definitionConflict
  };
}

function bindingFromAmbiguous(
  phrase: string,
  concepts: readonly ConceptNode[],
  matchedBy: ConceptLookupMatchKind
): ConceptBinding {
  const alternatives: ConceptBindingAlternative[] = concepts.map((concept) => ({
    conceptId: concept.id,
    title: concept.title,
    revision: concept.revision
  }));

  return {
    id: generateId(),
    surfacePhrase: phrase,
    status: "ambiguous",
    resolutionMethod: matchedBy,
    alternatives
  };
}

function bindingFromUnresolved(phrase: string): ConceptBinding {
  return {
    id: generateId(),
    surfacePhrase: phrase,
    status: "unresolved",
    resolutionMethod: "none"
  };
}

function bindingFromProposed(phrase: string): ConceptBinding {
  return {
    id: generateId(),
    surfacePhrase: phrase,
    status: "proposed_new",
    resolutionMethod: "none",
    proposedNewTitle: phrase
  };
}

export interface ResolveConceptBindingInput {
  /** Surface phrase to resolve. */
  readonly phrase?: string;
  /** Optional explicit stable concept ID, which takes precedence. */
  readonly stableId?: string;
  /** Optional proposed title used when no concept matches. */
  readonly proposedNewTitle?: string;
}

export function resolveConceptBinding(
  input: ResolveConceptBindingInput,
  index: Readonly<ConceptIndex>
): ConceptBinding {
  if (input.stableId !== undefined && input.stableId.trim() !== "") {
    const byId = lookupConceptById(index, input.stableId.trim());
    if (byId.kind === "unique_match") {
      return bindingFromResolved(
        input.phrase ?? byId.match.concept.title,
        byId.match.concept,
        "stable_id"
      );
    }
    if (byId.kind === "ambiguous_matches") {
      return bindingFromAmbiguous(
        input.phrase ?? input.stableId.trim(),
        byId.matches.map((match) => match.concept),
        "stable_id"
      );
    }
  }

  const phrase = input.phrase?.trim() ?? "";
  if (phrase === "") {
    return bindingFromUnresolved(input.stableId ?? "");
  }

  const lookup = lookupConcept(index, phrase);
  if (lookup.kind === "unique_match") {
    return bindingFromResolved(
      phrase,
      lookup.match.concept,
      lookup.match.matchedBy
    );
  }
  if (lookup.kind === "ambiguous_matches") {
    return bindingFromAmbiguous(
      phrase,
      lookup.matches.map((match) => match.concept),
      lookup.matches[0]?.matchedBy ?? "normalized_title"
    );
  }

  const proposedTitle = input.proposedNewTitle?.trim();
  if (proposedTitle !== undefined && proposedTitle !== "") {
    return {
      id: generateId(),
      surfacePhrase: phrase,
      status: "proposed_new",
      resolutionMethod: "none",
      proposedNewTitle: proposedTitle
    };
  }

  return bindingFromUnresolved(phrase);
}

export function resolveConceptBindings(
  phrases: readonly string[],
  index: Readonly<ConceptIndex>
): ConceptBinding[] {
  return phrases.map((phrase) => resolveConceptBinding({ phrase }, index));
}

export function buildOriginatingConceptRevisions(
  bindings: readonly ConceptBinding[]
): ConceptRevisionRef[] {
  const seen = new Set<string>();
  const revisions: ConceptRevisionRef[] = [];

  for (const binding of bindings) {
    if (binding.status !== "resolved" || binding.conceptId === undefined) {
      continue;
    }
    const key = `${binding.conceptId}@${binding.conceptRevision}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    revisions.push({
      conceptId: binding.conceptId,
      revision: binding.conceptRevision ?? 1,
      title: binding.resolvedTitle ?? binding.surfacePhrase,
      matchedBy: binding.resolutionMethod
    });
  }

  return revisions;
}

