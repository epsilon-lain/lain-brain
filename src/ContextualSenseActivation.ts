// ── M2B.6a-v0 — Contextual Sense Activation ─────────────────────────────
// Pure, deterministic, transient scoring of runtime sense candidates for
// one utterance of one concept.
//
// Two independent dimensions (M2B6A design §3):
//   - contextual relevance: the additive score below. AUTHORITY NEVER
//     CONTRIBUTES TO IT.
//   - authority/provenance: reported as metadata; used only for fallback
//     ordering and presentation — never as evidence of activation.
//
// No LLM calls, no state, no I/O, no persistence. The returned report is
// transient and must never be serialized.
// ────────────────────────────────────────────────────────────────────────

import type { SemanticPriorEpisode } from "./SemanticPrior";
import {
  containsSurfaceMention,
  deriveDistinctiveTerms,
  type RuntimeSenseCandidate,
  type RuntimeSenseAuthority
} from "./RuntimeSenseProjection";
import { extractLexicalSurfaces } from "./SemanticRetrievalQuery";

// ── Named resolution constants ──────────────────────────────────────────

/** Minimum contextual evidence for a candidate to be selectable at all. */
export const MIN_CONTEXT_EVIDENCE = 4;

/** Absolute top-vs-runner-up margin for a clear win (never a ratio). */
export const CLEAR_WIN_MARGIN = 6;

// ── Signal constants (weights; authority has none) ──────────────────────

const V1_TERM_MATCH_BASE = 8;
const V1_TERM_LENGTH_CAP = 6;
const V1_MAX_TERM_CONTRIBUTION = 40;
const V1_INTERLOCUTOR_CUE = 10;
const V2_EPISODE_MATCH = 10;
const V2_MAX_SUPPORTING_EPISODES = 3;
const V4_CONTRADICTION_PENALTY = 30;
const V4_NAMED_ALTERNATIVE_BOOST = 20;

/** Fallback ordering only — presentation, never part of the score. */
export function senseAuthorityFallbackRank(
  authority: RuntimeSenseAuthority
): number {
  switch (authority) {
    case "user_confirmed_personal":
      return 0;
    case "user_authored_unconfirmed":
      return 1;
    case "external_conventional":
      return 2;
    case "ai_provisional":
      return 3;
  }
}

// ── Report types (transient only) ───────────────────────────────────────

export interface SenseActivationEntry {
  readonly senseId: string;
  readonly authority: RuntimeSenseAuthority;
  readonly score: number;
  /** Inspectable trace of every fired signal for this candidate. */
  readonly firedSignals: readonly string[];
}

export type SenseActivationResolution = "selected" | "unresolved";

export interface SenseActivationReport {
  readonly conceptId: string;
  readonly surface: string;
  readonly utterance: string;
  readonly entries: readonly SenseActivationEntry[];
  /** Set when resolution is "selected" without a session direction. */
  readonly selectedSenseId?: string;
  readonly resolution: SenseActivationResolution;
  /**
   * Authority-ordered candidate ids for context-free fallback display.
   * This is presentation policy, deliberately separate from scoring.
   */
  readonly fallbackOrderSenseIds: readonly string[];
  /** Set when a transient session direction (V3) dominated this turn. */
  readonly firedDirectionSenseId?: string;
  readonly constants: Readonly<{
    minContextEvidence: number;
    clearWinMargin: number;
  }>;
}

export interface SenseActivationInput {
  readonly conceptId: string;
  /** The concept surface matched in the utterance. */
  readonly surface: string;
  /** All concept surfaces (title + aliases) for own-surface exclusion. */
  readonly conceptSurfaces: readonly string[];
  readonly candidates: readonly RuntimeSenseCandidate[];
  readonly utterance: string;
  /** Already-retrieved historical episodes (bounded by the caller). */
  readonly priorEpisodes: readonly SemanticPriorEpisode[];
  /** Transient session directions: conceptId → senseId. */
  readonly sessionDirections: ReadonlyMap<string, string>;
}

const INTERLOCUTOR_ADDRESS_PATTERN = /你(?:觉得|认为|说)|请问/u;
const INTERLOCUTOR_MEANING_PATTERN = /你|对话|回答|回应|助手|问题/u;

function normalizeSurfaceText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

// ── V1 / V2 scoring ─────────────────────────────────────────────────────

function scoreLexicalCoText(
  candidate: Readonly<RuntimeSenseCandidate>,
  utteranceSurfaces: ReadonlySet<string>,
  conceptSurfaceList: readonly string[]
): { score: number; firedSignals: string[] } {
  const firedSignals: string[] = [];
  let score = 0;

  const terms = deriveDistinctiveTerms(candidate, conceptSurfaceList);
  for (const term of terms) {
    if (utteranceSurfaces.has(term)) {
      score += V1_TERM_MATCH_BASE + Math.min(term.length, V1_TERM_LENGTH_CAP);
    }
  }
  if (score > 0) {
    score = Math.min(score, V1_MAX_TERM_CONTRIBUTION);
    firedSignals.push("lexical_co_text");
  }

  return { score, firedSignals };
}

function scoreInterlocutorCoText(
  candidate: Readonly<RuntimeSenseCandidate>,
  utterance: string
): { score: number; firedSignals: string[] } {
  if (
    !INTERLOCUTOR_ADDRESS_PATTERN.test(utterance) ||
    !INTERLOCUTOR_MEANING_PATTERN.test(candidate.meaning)
  ) {
    return { score: 0, firedSignals: [] };
  }
  return {
    score: V1_INTERLOCUTOR_CUE,
    firedSignals: ["co_text_interlocutor"]
  };
}

function episodeText(episode: Readonly<SemanticPriorEpisode>): string {
  return [
    ...episode.evidenceRefs.map((ref) => ref.snapshot),
    ...episode.anchors
  ].join(" ");
}

function scorePriorEpisodeEvidence(
  candidate: Readonly<RuntimeSenseCandidate>,
  input: Readonly<SenseActivationInput>
): { score: number; firedSignals: string[] } {
  const terms = deriveDistinctiveTerms(candidate, input.conceptSurfaces);
  let score = 0;
  let supporting = 0;

  for (const episode of input.priorEpisodes) {
    if (supporting >= V2_MAX_SUPPORTING_EPISODES) {
      break;
    }
    const text = episodeText(episode);
    const mentionsSurface = input.conceptSurfaces.some((surface) =>
      containsSurfaceMention(text, surface)
    );
    if (!mentionsSurface) {
      continue;
    }
    const mentionsTerm = terms.some((term) =>
      containsSurfaceMention(text, term)
    );
    if (!mentionsTerm) {
      continue;
    }
    score += V2_EPISODE_MATCH;
    supporting += 1;
  }

  return score > 0
    ? { score, firedSignals: ["prior_episode_evidence"] }
    : { score: 0, firedSignals: [] };
}

// ── V4 correction detection (conservative, fail-safe) ───────────────────

function candidatesMentioning(
  candidates: readonly RuntimeSenseCandidate[],
  conceptSurfaceList: readonly string[],
  token: string
): readonly RuntimeSenseCandidate[] {
  const normalizedToken = normalizeSurfaceText(token);
  if (normalizedToken === "") {
    return Object.freeze([]);
  }
  return Object.freeze(candidates.filter((candidate) => {
    if (containsSurfaceMention(candidate.meaning, token)) {
      return true;
    }
    return deriveDistinctiveTerms(candidate, conceptSurfaceList)
      .some((term) => term === normalizedToken || term.includes(normalizedToken));
  }));
}

interface CorrectionEffects {
  readonly rejectedSenseId?: string;
  readonly boostedSenseId?: string;
}

/**
 * Conservative literal rejection/correction patterns around the matched
 * surface, e.g. "我说的 mirai 不是你，是未来".
 * False negatives are acceptable; false positives are not. When a token
 * cannot be resolved to exactly one candidate, the effect is skipped.
 */
function detectCorrectionEffects(
  input: Readonly<SenseActivationInput>
): CorrectionEffects {
  let rejectedSenseId: string | undefined;
  let boostedSenseId: string | undefined;

  const normalizedSurface = normalizeSurfaceText(input.surface);
  const normalizedUtterance = normalizeSurfaceText(input.utterance);
  const surfaceIndex = normalizedUtterance.indexOf(normalizedSurface);
  if (surfaceIndex === -1) {
    return {};
  }

  const tail = normalizedUtterance.slice(
    surfaceIndex + normalizedSurface.length,
    surfaceIndex + normalizedSurface.length + 48
  );
  const negation = tail.match(
    /不是\s*(你|我|他|[^\s，。？！,]{1,12})/u
  );
  if (negation === null) {
    return {};
  }
  const negationTarget = negation[1]!;

  // Reject the contradicted candidate when the negation target resolves.
  // Pronouns ("你"/"我") reject the interlocutor/entity sense; named
  // targets reject the candidate whose terms mention the target. Both
  // require exactly one resolvable candidate — otherwise skip (fail-safe).
  let rejectedCandidates: readonly RuntimeSenseCandidate[];
  if (/^(你|我|他)$/u.test(negationTarget)) {
    rejectedCandidates = Object.freeze(input.candidates.filter(
      (candidate) => INTERLOCUTOR_MEANING_PATTERN.test(candidate.meaning)
    ));
  } else {
    rejectedCandidates = candidatesMentioning(
      input.candidates,
      input.conceptSurfaces,
      negationTarget
    );
  }
  if (rejectedCandidates.length === 1) {
    rejectedSenseId = rejectedCandidates[0]!.id;
  }

  // Boost a named alternative ("是未来" / "而是未来") when resolvable.
  const rest = tail.slice((negation.index ?? 0) + negation[0].length);
  const alternative = rest.match(/而是\s*([^\s，。？！,]{1,12})/u) ??
    rest.match(/是\s*([^\s，。？！,]{1,12})/u);
  if (alternative !== null) {
    const boosted = candidatesMentioning(
      input.candidates,
      input.conceptSurfaces,
      alternative[1]!
    );
    if (boosted.length === 1 && boosted[0]!.id !== rejectedSenseId) {
      boostedSenseId = boosted[0]!.id;
    }
  }

  return {
    ...(rejectedSenseId === undefined ? {} : { rejectedSenseId }),
    ...(boostedSenseId === undefined ? {} : { boostedSenseId })
  };
}

// ── V3 session direction detection (transient, never persisted) ─────────

export interface DetectedSessionDirection {
  readonly conceptId: string;
  readonly senseId: string;
}

/**
 * Detect an explicit sense direction in the current utterance, e.g.
 * "这里的 mirai 指未来" or the durable wording "以后我说 mirai 通常指未来".
 * v0 has no persistence path: BOTH forms are treated as temporary session
 * direction and expire with the session. When the target does not resolve
 * to exactly one candidate, no direction is recorded (fail-safe).
 */
export function detectSessionDirection(
  input: Readonly<SenseActivationInput>
): DetectedSessionDirection | undefined {
  const surface = normalizeSurfaceText(input.surface);
  const utterance = normalizeSurfaceText(input.utterance);
  if (surface === "" || !utterance.includes(surface)) {
    return undefined;
  }
  const surfacePattern = surface.replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&"
  );

  const patterns: readonly RegExp[] = [
    // Session-scoped: "这里的 mirai 指未来" / "这句话里 X 指 Z".
    new RegExp(
      `(?:这里|这句话(?:里|中)?|这个语境|现在)(?:的|里|中)?\\s*` +
      `${surfacePattern}\\s*(?:指|指的是|表示|说的是|是)\\s*` +
      `(?:是\\s*)?([^\\s，。？！,]{1,12})`,
      "u"
    ),
    // Durable wording (treated as session direction in v0):
    // "以后我说 mirai 通常指未来".
    new RegExp(
      `(?:以后|从现在起|通常)(?:我?说)?\\s*${surfacePattern}\\s*` +
      `(?:通常)?\\s*(?:指|指的是|表示|说的是)\\s*` +
      `(?:是\\s*)?([^\\s，。？！,]{1,12})`,
      "u"
    )
  ];

  for (const pattern of patterns) {
    const match = utterance.match(pattern);
    if (match === null) {
      continue;
    }
    const target = match[1]!;
    const resolved = candidatesMentioning(
      input.candidates,
      input.conceptSurfaces,
      target
    );
    if (resolved.length === 1) {
      return Object.freeze({
        conceptId: input.conceptId,
        senseId: resolved[0]!.id
      });
    }
  }

  return undefined;
}

// ── Fresh referent detection (deployed failure: X filled with 未来) ─────

/**
 * Fresh-referent surfaces are short previously-unresolved tokens the user
 * introduces in a declarative semantic frame:
 *   "X 对我来说是某种自由" / "Y 是我给某个东西起的名字" / "Z 对我意味着……"
 *
 * The safe default (M2B.6a design, Fresh Referent Principle): such a
 * surface is a DISTINCT PROVISIONAL REFERENT — not a placeholder waiting
 * to be filled, not an alias of the most recently activated concept, not
 * a coreference candidate. The model-facing annotation (§8) tells the
 * model exactly that; identity still requires independent user-authored
 * identity evidence ("X 就是未来", "这里 X 指未来").
 *
 * Conservative by construction: only short latin tokens (1-3 letters) in
 * explicit declarative frames, never stored concept surfaces, and a small
 * pronoun/stopword exclusion. False negatives are acceptable; a false
 * positive merely marks a distinct provisional referent, which is always
 * the safe default.
 */
const FRESH_REFERENT_STOPWORDS = new Set([
  "i", "me", "he", "we", "it", "no", "ok", "id", "la", "vs"
]);

// Boundary class includes ASCII punctuation: the utterance is NFKC-
// normalized first, which maps fullwidth ，。；：！？ to , . ; : ! ?.
const FRESH_REFERENT_PATTERN =
  /(?:^|[\s,.;:!?，。；：!?])([a-z]{1,3})\s*(?:对我来说|对我|在我看来|对你来说|对你)?\s*(?:就)?\s*(?:是|表示|代表|意味着|指)/iu;

export function detectFreshReferentSurfaces(
  utterance: string,
  knownSurfaces: readonly string[]
): readonly string[] {
  const normalizedUtterance = normalizeSurfaceText(utterance);
  const known = new Set(
    knownSurfaces.map((surface) => normalizeSurfaceText(surface))
      .filter((surface) => surface !== "")
  );
  const found: string[] = [];
  const seen = new Set<string>();

  const pattern = new RegExp(FRESH_REFERENT_PATTERN.source, "giu");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalizedUtterance)) !== null) {
    const token = match[1]!.toLowerCase();
    if (
      !FRESH_REFERENT_STOPWORDS.has(token) &&
      !known.has(token) &&
      !seen.has(token)
    ) {
      seen.add(token);
      found.push(token);
    }
  }

  return Object.freeze(found);
}

// ── Identity evidence gate (deployed retest failure: X = 未来) ─────────

/**
 * Identity-cue terms found in AI-generated hypotheses. A historical AI
 * hypothesis that SPECULATES about a fresh surface's referent ("X 最可能
 * 指向未来") is never identity evidence — injecting it would create a
 * self-reinforcing loop: guess → persisted → retrieved → appears
 * historically supported → re-guessed. Such hypotheses are withheld from
 * the model-facing context when the fresh surface they mention is active.
 *
 * The cue list covers the speculative phrasings observed in the deployed
 * poisoned episodes, including placeholder-fill and guess forms:
 *   "最可能指向未来", "X 的指代", "待填入具体内容",
 *   "最自然的候选是未来", "助手推测 X=未来".
 * A cue match alone never redacts — the spec must also mention the active
 * fresh surface. False positives merely withhold an AI interpretation
 * (fail-safe direction); the episode's user evidence always survives.
 */
const IDENTITY_CUE_PATTERN =
  /(?:指向|指代|就是指|就是|可能指|最可能|对应|等于|refers?|候选|填入|推测|猜测)/iu;

function specIdentityText(
  spec: Readonly<{
    readonly description?: string;
    readonly symbols?: readonly {
      readonly surface?: string;
      readonly description?: string;
    }[];
    readonly statements?: readonly {
      readonly description?: string;
    }[];
  }>
): string {
  return [
    spec.description ?? "",
    ...(spec.symbols ?? []).flatMap((symbol) => [
      symbol.surface ?? "",
      symbol.description ?? ""
    ]),
    ...(spec.statements ?? []).map((statement) => statement.description ?? "")
  ].join(" ");
}

/**
 * When fresh referents are active, replace the provisional AI hypothesis
 * of any retrieved episode whose spec speculates about a fresh surface's
 * referent with a neutral withheld marker. The episode's own user evidence
 * and anchors are preserved — only the non-identity-authorized
 * interpretation is removed. Purely transient: the persisted episode is
 * never mutated.
 */
export function redactIdentitySuggestiveHypotheses(
  episodes: readonly SemanticPriorEpisode[],
  freshSurfaces: readonly string[]
): readonly SemanticPriorEpisode[] {
  if (freshSurfaces.length === 0) {
    return episodes;
  }
  const tokens = freshSurfaces
    .map((surface) => normalizeSurfaceText(surface))
    .filter((surface) => surface !== "");

  return Object.freeze(episodes.map((episode) => {
    const text = specIdentityText(episode.semanticSpec);
    const mentionedToken = tokens.find((token) => {
      const pattern = new RegExp(
        `(?:^|[^a-z0-9])${token}(?:[^a-z0-9]|$)`,
        "iu"
      );
      return pattern.test(text);
    });
    if (mentionedToken === undefined || !IDENTITY_CUE_PATTERN.test(text)) {
      return episode;
    }
    const spec = episode.semanticSpec;
    const redactedSpec = Object.freeze({
      id: spec.id,
      schemaVersion: spec.schemaVersion,
      claimId: spec.claimId,
      sourceRefs: spec.sourceRefs,
      symbols: Object.freeze([]),
      expressions: Object.freeze([]),
      statements: Object.freeze([]),
      ambiguities: Object.freeze([]),
      resolutions: Object.freeze([]),
      patches: Object.freeze([]),
      analysisStatus: "ready_for_review" as const,
      reviewStatus: "pending" as const,
      revision: spec.revision,
      createdAt: spec.createdAt,
      updatedAt: spec.updatedAt,
      description:
        `AI interpretation withheld: only user-authored identity evidence ` +
        `may support referential identity for "${mentionedToken}".`
    });
    return Object.freeze({
      ...episode,
      semanticSpec: redactedSpec
    });
  }));
}

// ── Activation ──────────────────────────────────────────────────────────

export function activateRuntimeSenses(
  input: Readonly<SenseActivationInput>
): SenseActivationReport {
  const utteranceSurfaces = new Set(
    extractLexicalSurfaces(input.utterance).map(normalizeSurfaceText)
  );
  const correction = detectCorrectionEffects(input);

  const entries: SenseActivationEntry[] = input.candidates.map((candidate) => {
    const firedSignals: string[] = [];
    let score = 0;

    const lexical = scoreLexicalCoText(
      candidate,
      utteranceSurfaces,
      input.conceptSurfaces
    );
    score += lexical.score;
    firedSignals.push(...lexical.firedSignals);

    const interlocutor = scoreInterlocutorCoText(candidate, input.utterance);
    score += interlocutor.score;
    firedSignals.push(...interlocutor.firedSignals);

    const priorEvidence = scorePriorEpisodeEvidence(candidate, input);
    score += priorEvidence.score;
    firedSignals.push(...priorEvidence.firedSignals);

    if (correction.rejectedSenseId === candidate.id) {
      score -= V4_CONTRADICTION_PENALTY;
      firedSignals.push("correction_rejected");
    }
    if (correction.boostedSenseId === candidate.id) {
      score += V4_NAMED_ALTERNATIVE_BOOST;
      firedSignals.push("correction_named_alternative");
    }

    return Object.freeze({
      senseId: candidate.id,
      authority: candidate.authority,
      score,
      firedSignals: Object.freeze([...new Set(firedSignals)])
    });
  });

  const byScore = [...entries].sort(
    (a, b) =>
      b.score - a.score ||
      senseAuthorityFallbackRank(a.authority) -
        senseAuthorityFallbackRank(b.authority) ||
      a.senseId.localeCompare(b.senseId)
  );
  const fallbackOrder = [...entries].sort(
    (a, b) =>
      senseAuthorityFallbackRank(a.authority) -
        senseAuthorityFallbackRank(b.authority) ||
      b.score - a.score ||
      a.senseId.localeCompare(b.senseId)
  );

  const directedSenseId = input.sessionDirections.get(input.conceptId);
  const directedEntry = directedSenseId === undefined
    ? undefined
    : entries.find((entry) => entry.senseId === directedSenseId);

  let selectedSenseId: string | undefined;
  let resolution: SenseActivationResolution;
  if (directedEntry !== undefined) {
    // V3 dominant: temporary user direction wins regardless of score.
    selectedSenseId = directedEntry.senseId;
    resolution = "selected";
  } else {
    const top = byScore[0];
    const runnerUp = byScore[1];
    if (
      top !== undefined &&
      top.score >= MIN_CONTEXT_EVIDENCE &&
      top.score - (runnerUp?.score ?? 0) >= CLEAR_WIN_MARGIN
    ) {
      selectedSenseId = top.senseId;
      resolution = "selected";
    } else {
      resolution = "unresolved";
    }
  }

  return Object.freeze({
    conceptId: input.conceptId,
    surface: input.surface,
    utterance: input.utterance,
    entries: Object.freeze(entries),
    ...(selectedSenseId === undefined
      ? {}
      : { selectedSenseId }),
    resolution,
    fallbackOrderSenseIds: Object.freeze(
      fallbackOrder.map((entry) => entry.senseId)
    ),
    ...(directedEntry === undefined
      ? {}
      : { firedDirectionSenseId: directedEntry.senseId }),
    constants: Object.freeze({
      minContextEvidence: MIN_CONTEXT_EVIDENCE,
      clearWinMargin: CLEAR_WIN_MARGIN
    })
  });
}
