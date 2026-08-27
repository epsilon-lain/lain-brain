// ── M2B.6a-v0 — Contextual Sense Prompt Annotation ──────────────────────
// Renders the compact, temporary, advisory sense-context block that is
// injected into the model-facing prompt.
//
// Hard rules:
//   - clearly temporary and advisory; never persisted;
//   - authority metadata describes provenance, NOT contextual probability;
//   - no percentages, no persistent "current sense";
//   - ambiguous situations say "unresolved" instead of pretending;
//   - related content carried by similarity is labeled "related meaning /
//     distinct referent" and never generates identity claims (same_as,
//     alias_of, refers_to, coreference, merge are NEVER emitted here).
// ────────────────────────────────────────────────────────────────────────

import type { SenseActivationReport } from "./ContextualSenseActivation";
import type {
  RuntimeSenseAuthority,
  RuntimeSenseCandidate
} from "./RuntimeSenseProjection";

const MAX_ANNOTATION_CHARS = 1400;
const MAX_CONCEPTS_PER_BLOCK = 3;
const MAX_CANDIDATES_PER_CONCEPT = 4;
const MAX_LABEL_CHARS = 44;

export const SENSE_CONTEXT_POLICY = [
  "Sense context (temporary, advisory):",
  "This context is temporary and advisory. Authority describes provenance,",
  "not contextual probability. Related context establishes similarity only",
  "— never infer same object, alias, or coreference from similarity,",
  "activation, discourse adjacency, co-text, or retrieval. Identity",
  "requires independent user-authored identity evidence (for example",
  "\"X 就是未来\", \"这里 X 指未来\", \"X 是未来的另一个名字\")."
].join("\n");

/** Compact, display-only, derived at render time. Never confirmed. */
export function deriveSenseLabel(
  candidate: Readonly<RuntimeSenseCandidate>
): string {
  const firstLine = candidate.meaning
    .split(/\r?\n/u)[0]!
    .trim()
    .replace(/\s+/gu, " ");
  return firstLine.length <= MAX_LABEL_CHARS
    ? firstLine
    : `${firstLine.slice(0, MAX_LABEL_CHARS - 3)}...`;
}

function authorityLabel(authority: RuntimeSenseAuthority): string {
  switch (authority) {
    case "user_confirmed_personal":
      return "user-confirmed";
    case "user_authored_unconfirmed":
      return "user-authored (unconfirmed)";
    case "external_conventional":
      return "external";
    case "ai_provisional":
      return "AI hypothesis";
  }
}

/**
 * Transient result of the sense layer for one foreground send.
 * `annotation` is "" when there is nothing to inject (degraded).
 */
export interface RuntimeSenseContext {
  /** One report per surface-matched concept, in deterministic order. */
  readonly reports: readonly SenseActivationReport[];
  /** Additive retrieval seed surfaces from selected/strong candidates. */
  readonly extraSeedSurfaces: readonly string[];
  /** Concepts retrieved by similarity only — distinct referents. */
  readonly relatedOnlySurfaces: readonly string[];
  /**
   * Fresh surfaces introduced by the user in a declarative frame
   * ("X 对我来说是某种自由"). Marked as distinct provisional referents,
   * never placeholders to fill (Fresh Referent Principle).
   */
  readonly freshReferentSurfaces: readonly string[];
  readonly annotation: string;
  readonly degraded: boolean;
}

export function degradedSenseContext(): RuntimeSenseContext {
  return Object.freeze({
    reports: Object.freeze([]),
    extraSeedSurfaces: Object.freeze([]),
    relatedOnlySurfaces: Object.freeze([]),
    freshReferentSurfaces: Object.freeze([]),
    annotation: "",
    degraded: true
  });
}

/**
 * Render the compact annotation block. Pure and deterministic.
 * Returns "" when there is nothing to say.
 */
export function renderSenseContextAnnotation(
  reports: readonly SenseActivationReport[],
  candidatesById: ReadonlyMap<string, RuntimeSenseCandidate>,
  relatedOnlySurfaces: readonly string[],
  freshReferentSurfaces: readonly string[]
): string {
  if (
    reports.length === 0 &&
    relatedOnlySurfaces.length === 0 &&
    freshReferentSurfaces.length === 0
  ) {
    return "";
  }

  const lines: string[] = [];
  let chars = SENSE_CONTEXT_POLICY.length;

  const append = (line: string): boolean => {
    if (chars + line.length + 1 > MAX_ANNOTATION_CHARS) {
      return false;
    }
    lines.push(line);
    chars += line.length + 1;
    return true;
  };

  for (const report of reports.slice(0, MAX_CONCEPTS_PER_BLOCK)) {
    if (!append(`surface: ${report.surface}`)) {
      break;
    }

    const ordered = [...report.entries].sort(
      (a, b) =>
        b.score - a.score ||
        a.authority.localeCompare(b.authority) ||
        a.senseId.localeCompare(b.senseId)
    );
    for (const entry of ordered.slice(0, MAX_CANDIDATES_PER_CONCEPT)) {
      const candidate = candidatesById.get(entry.senseId);
      if (candidate === undefined) {
        continue;
      }
      const current =
        report.selectedSenseId === entry.senseId
          ? report.firedDirectionSenseId === entry.senseId
            ? " — current-context: selected (session direction)"
            : " — current-context: selected"
          : "";
      if (
        !append(
          `candidate: ${deriveSenseLabel(candidate)}` +
          ` — authority: ${authorityLabel(entry.authority)}${current}`
        )
      ) {
        break;
      }
    }

    if (report.resolution === "unresolved") {
      append(
        "current-context: unresolved (multiple plausible senses)"
      );
    }
  }

  if (freshReferentSurfaces.length > 0) {
    for (const surface of freshReferentSurfaces.slice(0, 4)) {
      if (!append(
        `fresh referent: ${surface} — a distinct provisional referent, ` +
        "not a placeholder to fill, not an alias of a related or recently " +
        "activated concept. Identity requires user-authored identity evidence."
      )) {
        break;
      }
    }
  }

  if (relatedOnlySurfaces.length > 0) {
    append(
      "related meaning / distinct referent (similarity only, no identity " +
      `inference): ${relatedOnlySurfaces.slice(0, 4).join(", ")}`
    );
  }

  return lines.length === 0
    ? ""
    : `${SENSE_CONTEXT_POLICY}\n${lines.join("\n")}`;
}
