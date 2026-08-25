// Experiment 04R answer-bearing-context audit gate.
//
// Experiment 04 was blocked pre-live by human review because several
// provider-visible semantic definitions/relations were answer-bearing: they
// conflated "useful Personal Brain context" with "directly supplying the
// scored answer". This module is 04R's explicit regression gate against that
// failure class. Everything here is local-only; nothing in this module is
// ever provider-visible.

import type { Experiment04RFixture } from "./Experiment04RDefinition";
import type { ProviderMessage } from "./Experiment04RInstrument";

// ---------------------------------------------------------------------------
// Typed audit manifest: exactly one entry per fixture, all gates true.
// ---------------------------------------------------------------------------

export interface Experiment04RAuditEntry {
  readonly fixtureId: string;
  /** The personal definition supplied as context does not restate the source's scored conclusion. */
  readonly definitionSourceIndependent: boolean;
  /** The relations supplied as context do not restate the source's scored inference. */
  readonly relationsSourceIndependent: boolean;
  /** The context does not name the intended speech-act label (definition, instruction, proof_sketch, ...). */
  readonly noSpeechActLeakage: boolean;
  /** The context does not supply a missing condition the evaluator asks the model to recognize. */
  readonly noMissingConditionLeakage: boolean;
  /** The context does not reveal which stored revision the evaluator expects the model to choose. */
  readonly noRevisionAnswerLeakage: boolean;
  /** Human-review justification recorded at freeze time. Must not be empty. */
  readonly reviewerRationale: string;
}

export const EXPERIMENT_04R_AUDIT_MANIFEST: readonly Experiment04RAuditEntry[] = [
  {
    fixtureId: "harbor-private-meaning",
    definitionSourceIndependent: true,
    relationsSourceIndependent: true,
    noSpeechActLeakage: true,
    noMissingConditionLeakage: true,
    noRevisionAnswerLeakage: true,
    reviewerRationale:
      "04 context supplied the keep-or-remove review content and the return-before-decision ordering, both overlapping the scored inference. 04R defines harbor only as a generic personal checkpoint for reviewing active commitments, with an indexing relation; the keep/remove decision and temporal ordering must come from the source."
  },
  {
    fixtureId: "lantern-private-meaning",
    definitionSourceIndependent: true,
    relationsSourceIndependent: true,
    noSpeechActLeakage: true,
    noMissingConditionLeakage: true,
    noRevisionAnswerLeakage: true,
    reviewerRationale:
      "04 stated that the lantern keeps the associated project open, restating the source's closure-blocking conclusion. 04R describes lantern as a project-continuity handle with a status-notes storage relation only; whether the project stays open remains an inference from the source."
  },
  {
    fixtureId: "compass-private-meaning",
    definitionSourceIndependent: true,
    relationsSourceIndependent: true,
    noSpeechActLeakage: true,
    noMissingConditionLeakage: true,
    noRevisionAnswerLeakage: true,
    reviewerRationale:
      "04 supplied the narrowing-to-reversible-step criterion that overlaps the scored answer. 04R keeps only a generic structuring-tool meaning and a discussion-planning indexing relation; the narrowing outcome must come from the source."
  },
  {
    fixtureId: "field-overload",
    definitionSourceIndependent: true,
    relationsSourceIndependent: true,
    noSpeechActLeakage: true,
    noMissingConditionLeakage: true,
    noRevisionAnswerLeakage: true,
    reviewerRationale:
      "04's relation pre-answered the may-split outcome and its two-cluster shape. 04R records only that examples group under a shared working question; the split condition and its shape must come from the source."
  },
  {
    fixtureId: "proof-overload",
    definitionSourceIndependent: true,
    relationsSourceIndependent: true,
    noSpeechActLeakage: true,
    noMissingConditionLeakage: true,
    noRevisionAnswerLeakage: true,
    reviewerRationale:
      "04 restated the supports relation and step-by-step retrace ability. 04R gives a neutral derivation-artifact definition and a storage relation; the retrace-until-checked inference stays with the source."
  },
  {
    fixtureId: "bridge-ambiguity",
    definitionSourceIndependent: true,
    relationsSourceIndependent: true,
    noSpeechActLeakage: true,
    noMissingConditionLeakage: true,
    noRevisionAnswerLeakage: true,
    reviewerRationale:
      "04's provider-visible IDs named the intended readings. 04R uses semantically neutral bridge-a and bridge-b IDs; both candidates remain present and no single resolution is suggested, preserving the scored ambiguity."
  },
  {
    fixtureId: "normal-operator-missing-assumption",
    definitionSourceIndependent: true,
    relationsSourceIndependent: true,
    noSpeechActLeakage: true,
    noMissingConditionLeakage: true,
    noRevisionAnswerLeakage: true,
    reviewerRationale:
      "04 named the missing finite-dimensionality qualification, pre-answering the missing-condition recognition that is scored. 04R context contains no scope qualification; recognition of the missing scope must come from the source and general background knowledge."
  },
  {
    fixtureId: "modus-ponens-precision",
    definitionSourceIndependent: true,
    relationsSourceIndependent: true,
    noSpeechActLeakage: true,
    noMissingConditionLeakage: true,
    noRevisionAnswerLeakage: true,
    reviewerRationale:
      "04 restated the implication-and-antecedent inference the source already states. 04R provides only the pattern's name and its vocabulary category; the derivation remains a source inference."
  },
  {
    fixtureId: "delta-control",
    definitionSourceIndependent: true,
    relationsSourceIndependent: true,
    noSpeechActLeakage: true,
    noMissingConditionLeakage: true,
    noRevisionAnswerLeakage: true,
    reviewerRationale:
      "04's definition labeled the semantic difference between two versions and its relation restated the two-version comparison. 04R defines delta as an annotation on a change with a storage relation; the mark-before-comparing ordering stays with the source."
  },
  {
    fixtureId: "boundary-definition",
    definitionSourceIndependent: true,
    relationsSourceIndependent: true,
    noSpeechActLeakage: true,
    noMissingConditionLeakage: true,
    noRevisionAnswerLeakage: true,
    reviewerRationale:
      "04's definition restated the source's final-explicit-distinction content. 04R keeps a minimal named-distinction meaning with a combination-notes indexing relation; the source's own wording remains the basis for the definition speech-act judgment."
  },
  {
    fixtureId: "spectral-proof-sketch",
    definitionSourceIndependent: true,
    relationsSourceIndependent: true,
    noSpeechActLeakage: true,
    noMissingConditionLeakage: true,
    noRevisionAnswerLeakage: true,
    reviewerRationale:
      "04's context proposed the diagonalization step and noted unchecked hypotheses, pre-answering the proof-status judgment. 04R records only a theorem-reference note object and a linkage relation; the provisional status of the next step must be judged from the source."
  },
  {
    fixtureId: "compass-revision",
    definitionSourceIndependent: true,
    relationsSourceIndependent: true,
    noSpeechActLeakage: true,
    noMissingConditionLeakage: true,
    noRevisionAnswerLeakage: true,
    reviewerRationale:
      "04 stated that the current criterion selects reversible steps and supersedes the prior revision, pre-answering which revision is current and what it selects. 04R records only that two stored revisions exist and are distinct; which revision is current and what it asks for remain source judgments."
  }
];

const REQUIRED_AUDIT_GATES = [
  "definitionSourceIndependent",
  "relationsSourceIndependent",
  "noSpeechActLeakage",
  "noMissingConditionLeakage",
  "noRevisionAnswerLeakage"
] as const;

/** Coverage + gate validation. Every fixture exactly once, no unknown IDs, all gates true, rationale non-empty. */
export function validateExperiment04RAuditCoverage(
  fixtureIds: readonly string[]
): readonly string[] {
  const errors: string[] = [];
  const counts = new Map<string, number>();
  for (const entry of EXPERIMENT_04R_AUDIT_MANIFEST) {
    counts.set(entry.fixtureId, (counts.get(entry.fixtureId) ?? 0) + 1);
    if (!fixtureIds.includes(entry.fixtureId)) {
      errors.push(`audit: unknown fixture ID ${entry.fixtureId} in audit manifest.`);
    }
    for (const gate of REQUIRED_AUDIT_GATES) {
      if (entry[gate] !== true) {
        errors.push(`audit: ${entry.fixtureId}: gate ${gate} is not true.`);
      }
    }
    if (entry.reviewerRationale.trim() === "") {
      errors.push(`audit: ${entry.fixtureId}: empty reviewer rationale.`);
    }
  }
  for (const fixtureId of fixtureIds) {
    const count = counts.get(fixtureId) ?? 0;
    if (count === 0) errors.push(`audit: missing audit entry for fixture ${fixtureId}.`);
    if (count > 1) errors.push(`audit: duplicate audit entries for fixture ${fixtureId} (${count}).`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Deterministic provider-visible forbidden-fragment protection.
//
// Regression guard only; it is NOT a substitute for human review. These are
// the known answer-bearing phrases (or their equivalents) removed from 04R
// treatment content. Matching is case-insensitive, whitespace-collapsed, and
// hyphen-insensitive, and runs ONLY over provider-visible rendered messages,
// never over hidden evaluator metadata in the Definition.
// ---------------------------------------------------------------------------

export const EXPERIMENT_04R_FORBIDDEN_FRAGMENTS: readonly string[] = [
  // harbor-private-meaning (04: keep-or-remove review context)
  "keep-or-remove",
  // lantern-private-meaning (04: project stays open)
  "keeps the associated project open",
  // field-overload (04: split pre-answered)
  "may split into two inquiry clusters",
  // normal-operator-missing-assumption (04: missing condition supplied)
  "finite-dimensionality qualification",
  // modus-ponens-precision (04: inference restated)
  "derives Q from P",
  "conclusion follows from an implication",
  // spectral-proof-sketch (04: proof status supplied)
  "proposes diagonalization",
  "requires hypothesis check",
  // compass-private-meaning (04: narrowing criterion supplied)
  "narrows a decision to one reversible step",
  // compass-revision (04: current revision and selection supplied)
  "selects reversible steps",
  "supersedes compass-prior",
  "compass-current",
  // proof-overload (04: retrace ability supplied)
  "retraced step by step",
  // boundary-definition (04: definitional content restated)
  "final explicit distinction preserved",
  // delta-control (04: comparison relation restated)
  "compares two concept revisions",
  "semantic difference between two versions",
  // bridge-ambiguity (04: leaked candidate readings)
  "bridge-dialogue",
  "bridge-transition"
];

export function normalizeForFragmentScan(text: string): string {
  return text.toLowerCase().replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

/** Returns the forbidden fragments present in the given text (empty = clean). */
export function findForbiddenFragmentsInText(text: string): readonly string[] {
  const normalized = normalizeForFragmentScan(text);
  return EXPERIMENT_04R_FORBIDDEN_FRAGMENTS.filter((fragment) =>
    normalized.includes(normalizeForFragmentScan(fragment))
  );
}

/** Throws when any provider-visible message reintroduces a known answer-bearing fragment. */
export function assertNoForbiddenFragmentsInProviderVisible(
  messages: readonly ProviderMessage[]
): void {
  const visibleText = messages.map((message) => message.content).join("\n");
  const found = findForbiddenFragmentsInText(visibleText);
  if (found.length > 0) {
    throw new Error(
      `Provider-visible content contains answer-bearing fragment(s): ${found.join("; ")}.`
    );
  }
}

// ---------------------------------------------------------------------------
// Hard evaluator-metadata-absence check.
//
// Fixture-local internal values from sourceStatedFacts, permittedBackgroundFacts,
// allowedSemanticCommitments, and forbiddenSemanticCommitments must never appear
// in any provider-visible request. The exact symbolic label is always checked;
// the underscore-humanized form is additionally checked for labels with two or
// more underscores, so accidental rendering of evaluation labels is caught
// without banning ordinary English that merely resembles a single label token
// pair (e.g. the legitimate alias "modus ponens" for the MODUS_PONENS label).
// ---------------------------------------------------------------------------

function evaluatorMetadataValuesFor(
  fixture: Readonly<Experiment04RFixture>
): readonly string[] {
  return [
    ...fixture.sourceStatedFacts,
    ...fixture.permittedBackgroundFacts,
    ...fixture.allowedSemanticCommitments,
    ...fixture.forbiddenSemanticCommitments
  ];
}

/** Returns the fixture-local evaluator metadata values present in the provider-visible messages. */
export function findEvaluatorMetadataLeaks(
  fixture: Readonly<Experiment04RFixture>,
  messages: readonly ProviderMessage[]
): readonly string[] {
  const visibleText = messages.map((message) => message.content).join("\n");
  const normalizedVisible = visibleText.toLowerCase();
  const leaks: string[] = [];
  for (const value of evaluatorMetadataValuesFor(fixture)) {
    if (visibleText.includes(value)) {
      leaks.push(value);
      continue;
    }
    const humanized = value.toLowerCase().split("_").join(" ");
    if (value.split("_").length >= 3 && normalizedVisible.includes(humanized)) {
      leaks.push(value);
    }
  }
  return leaks;
}

/** Throws when any provider-visible message renders fixture-local evaluator metadata. */
export function assertNoEvaluatorMetadataLeaks(
  fixture: Readonly<Experiment04RFixture>,
  messages: readonly ProviderMessage[]
): void {
  const leaks = findEvaluatorMetadataLeaks(fixture, messages);
  if (leaks.length > 0) {
    throw new Error(
      `Provider-visible content renders evaluator-only metadata: ${leaks.join("; ")}.`
    );
  }
}
