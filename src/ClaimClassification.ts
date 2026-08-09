export const CLAIM_KINDS = [
  "personal_interpretation",
  "factual_claim",
  "open_question",
  "formal_statement"
] as const;

export type ClaimKind = typeof CLAIM_KINDS[number];

export const CLAIM_VERIFICATIONS = [
  "user_authored",
  "source_pending",
  "source_cited",
  "lean_pending",
  "lean_checked"
] as const;

export type ClaimVerification =
  typeof CLAIM_VERIFICATIONS[number];

export type LeanProofStatus =
  | "not_started"
  | "checking"
  | "passed"
  | "failed";

export interface ClaimRecord {
  id: string;
  text: string;
  kind: ClaimKind;
  verification: ClaimVerification;
  sourceReferences: string[];
  sourceMessageIds: string[];
  userApproved: boolean;
  createdAt?: string;
  updatedAt?: string;
  leanStatement?: string;
  leanFilePath?: string;
  leanProofStatus?: LeanProofStatus;
  formalizationIds: string[];
  primaryFormalizationId?: string;
}

export interface ClaimSuggestion {
  text: string;
  kind: ClaimKind;
  verification: ClaimVerification;
  sourceReferences: string[];
  sourceMessageIds: string[];
  leanStatement?: string;
}

export interface ClaimReviewItem extends ClaimSuggestion {
  id: string;
}

export interface KnowledgeStatusUpdate {
  markdown: string;
  safe: boolean;
  changed: boolean;
  warning?: string;
}

export const KNOWLEDGE_STATUS_START =
  "<!-- lain-brain:knowledge-status:start -->";
export const KNOWLEDGE_STATUS_END =
  "<!-- lain-brain:knowledge-status:end -->";
export const KNOWLEDGE_STATUS_WARNING =
  "Knowledge status could not be updated safely. Review the candidate Markdown manually.";

const KNOWLEDGE_STATUS_HEADING = /^## Knowledge status\s*$/m;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

export function isClaimKind(value: unknown): value is ClaimKind {
  return typeof value === "string" &&
    (CLAIM_KINDS as readonly string[]).includes(value);
}

export function isClaimVerification(
  value: unknown
): value is ClaimVerification {
  return typeof value === "string" &&
    (CLAIM_VERIFICATIONS as readonly string[]).includes(value);
}

export function normalizeClaimText(value: string): string {
  const trimmed = value.trim();

  if (
    trimmed === "" ||
    trimmed.length > 2000 ||
    CONTROL_CHARACTERS.test(trimmed) ||
    trimmed.includes(KNOWLEDGE_STATUS_START) ||
    trimmed.includes(KNOWLEDGE_STATUS_END)
  ) {
    return "";
  }

  return trimmed;
}

export function normalizeSourceReferences(
  values: readonly string[]
): string[] {
  const normalized = values
    .map((value) => value.trim())
    .filter(
      (value) =>
        value !== "" &&
        value.length <= 500 &&
        !CONTROL_CHARACTERS.test(value)
    );

  return [...new Set(normalized)].slice(0, 20);
}

export function getClaimVerification(
  kind: ClaimKind,
  sourceReferences: readonly string[],
  requested?: ClaimVerification
): ClaimVerification {
  if (kind === "personal_interpretation") {
    return "user_authored";
  }

  if (kind === "formal_statement") {
    return "lean_pending";
  }

  if (kind === "open_question") {
    return "source_pending";
  }

  return (
    requested === "source_cited" &&
    sourceReferences.length > 0
  )
    ? "source_cited"
    : "source_pending";
}

export function normalizeClaimSuggestion(
  value: unknown,
  allowedSourceMessageIds: ReadonlySet<string>,
  evidenceText: string
): ClaimSuggestion | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const item = value as Record<string, unknown>;
  const text = typeof item.text === "string"
    ? normalizeClaimText(item.text)
    : "";

  if (text === "" || !isClaimKind(item.kind)) {
    return null;
  }

  const sourceReferences = Array.isArray(item.sourceReferences)
    ? normalizeSourceReferences(
        item.sourceReferences.filter(
          (reference): reference is string =>
            typeof reference === "string" &&
            evidenceText.includes(reference.trim())
        )
      )
    : [];
  const sourceMessageIds = Array.isArray(item.sourceMessageIds)
    ? [
        ...new Set(
          item.sourceMessageIds.filter(
            (id): id is string =>
              typeof id === "string" &&
              allowedSourceMessageIds.has(id)
          )
        )
      ]
    : [];
  const requested = isClaimVerification(item.verification)
    ? item.verification
    : undefined;
  const leanStatement =
    item.kind === "formal_statement" &&
    typeof item.leanStatement === "string"
      ? normalizeClaimText(item.leanStatement) || undefined
      : undefined;

  return {
    text,
    kind: item.kind,
    verification: getClaimVerification(
      item.kind,
      sourceReferences,
      requested
    ),
    sourceReferences,
    sourceMessageIds,
    leanStatement
  };
}

export function parseClaimSuggestionsJson(
  response: string,
  allowedSourceMessageIds: ReadonlySet<string>,
  evidenceText: string
): ClaimSuggestion[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(response.trim());
  } catch {
    throw new Error("DeepSeek returned invalid claim suggestions.");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as Record<string, unknown>).claims)
  ) {
    throw new Error("DeepSeek returned invalid claim suggestions.");
  }

  const rawClaims = (parsed as { claims: unknown[] }).claims;

  // The prompt instructs the model to return 3–12 claims for Review
  // Claims; the atomic-claim organizer fallback may legitimately produce
  // 0 or 1.  An empty claims array is a valid semantic result ("no
  // substantive claims found"), not an error.
  if (rawClaims.length > 12) {
    throw new Error("DeepSeek returned invalid claim suggestions.");
  }

  if (rawClaims.length === 0) {
    return [];
  }

  const claims = rawClaims
    .map((value) =>
      normalizeClaimSuggestion(
        value,
        allowedSourceMessageIds,
        evidenceText
      )
    )
    .filter((claim): claim is ClaimSuggestion => claim !== null);

  const uniqueClaims = claims.filter(
    (claim, index) =>
      claims.findIndex(
        (other) =>
          other.kind === claim.kind &&
          normalizeClaimIdentity(other.text) ===
            normalizeClaimIdentity(claim.text)
      ) === index
  );

  // rawClaims had entries but none survived normalization →
  // the response was malformed, not an intentional zero.
  if (uniqueClaims.length === 0) {
    throw new Error("DeepSeek returned invalid claim suggestions.");
  }

  return uniqueClaims;
}

export function normalizeReviewedClaim(
  item: ClaimReviewItem,
  existing: ClaimRecord | undefined,
  now: string
): ClaimRecord | null {
  const text = normalizeClaimText(item.text);

  if (text === "" || !isClaimKind(item.kind)) {
    return null;
  }

  const sourceReferences = normalizeSourceReferences(
    item.sourceReferences
  );
  const sourceMessageIds = [
    ...new Set(
      item.sourceMessageIds.filter(
        (id) => typeof id === "string" && id.trim() !== ""
      )
    )
  ];
  const leanStatement = item.kind === "formal_statement" &&
    typeof item.leanStatement === "string"
    ? normalizeClaimText(item.leanStatement) || undefined
    : undefined;

  return {
    id: item.id,
    text,
    kind: item.kind,
    verification:
      existing?.verification === "lean_checked" &&
      existing.leanProofStatus === "passed"
        ? "lean_checked"
        : getClaimVerification(
            item.kind,
            sourceReferences,
            item.verification
          ),
    sourceReferences,
    sourceMessageIds,
    userApproved: true,
    formalizationIds: existing?.formalizationIds ?? [],
    primaryFormalizationId: existing?.primaryFormalizationId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    leanStatement,
    leanFilePath:
      item.kind === "formal_statement"
        ? existing?.leanFilePath
        : undefined,
    leanProofStatus:
      item.kind === "formal_statement"
        ? (
            existing?.leanProofStatus === "passed"
              ? "passed"
              : existing?.leanProofStatus ?? "not_started"
          )
        : undefined
  };
}

export function buildKnowledgeStatusBlock(
  claims: readonly ClaimRecord[]
): string {
  const approved = claims.filter((claim) => claim.userApproved);
  const sections: string[] = [];

  addClaimSection(
    sections,
    "My interpretation",
    approved.filter(
      (claim) => claim.kind === "personal_interpretation"
    )
  );
  addClaimSection(
    sections,
    "Source-cited claims",
    approved.filter(
      (claim) =>
        claim.kind === "factual_claim" &&
        claim.verification === "source_cited"
    )
  );
  addClaimSection(
    sections,
    "Claims needing sources",
    approved.filter(
      (claim) =>
        claim.kind === "factual_claim" &&
        claim.verification !== "source_cited"
    )
  );
  addClaimSection(
    sections,
    "Open questions",
    approved.filter((claim) => claim.kind === "open_question")
  );
  addClaimSection(
    sections,
    "Formalization candidates",
    approved.filter(
      (claim) => claim.kind === "formal_statement"
    )
  );

  return [
    KNOWLEDGE_STATUS_START,
    "## Knowledge status",
    "",
    ...sections,
    KNOWLEDGE_STATUS_END
  ].join("\n");
}

export function updateKnowledgeStatusMarkdown(
  markdown: string,
  claims: readonly ClaimRecord[]
): KnowledgeStatusUpdate {
  const block = buildKnowledgeStatusBlock(claims);
  const starts = findAll(markdown, KNOWLEDGE_STATUS_START);
  const ends = findAll(markdown, KNOWLEDGE_STATUS_END);

  if (starts.length === 0 && ends.length === 0) {
    if (KNOWLEDGE_STATUS_HEADING.test(markdown)) {
      return {
        markdown,
        safe: false,
        changed: false,
        warning: KNOWLEDGE_STATUS_WARNING
      };
    }

    const separator = markdown === ""
      ? ""
      : markdown.endsWith("\n")
        ? "\n"
        : "\n\n";
    return {
      markdown: markdown + separator + block,
      safe: true,
      changed: true
    };
  }

  const start = starts[0];
  const end = ends[0];

  if (
    starts.length !== 1 ||
    ends.length !== 1 ||
    start === undefined ||
    end === undefined ||
    start > end
  ) {
    return {
      markdown,
      safe: false,
      changed: false,
      warning: KNOWLEDGE_STATUS_WARNING
    };
  }

  const endOffset = end + KNOWLEDGE_STATUS_END.length;
  const next = markdown.slice(0, start) +
    block +
    markdown.slice(endOffset);

  return {
    markdown: next,
    safe: true,
    changed: next !== markdown
  };
}

export function removeManagedKnowledgeStatusBlock(
  markdown: string
): string {
  const starts = findAll(markdown, KNOWLEDGE_STATUS_START);
  const ends = findAll(markdown, KNOWLEDGE_STATUS_END);
  const start = starts[0];
  const end = ends[0];

  if (
    starts.length !== 1 ||
    ends.length !== 1 ||
    start === undefined ||
    end === undefined ||
    start > end
  ) {
    return markdown;
  }

  const endOffset = end + KNOWLEDGE_STATUS_END.length;
  return (
    markdown.slice(0, start) +
    markdown.slice(endOffset)
  ).trimEnd();
}

export function hasSafelyLocatedKnowledgeStatus(
  markdown: string
): boolean {
  const starts = findAll(markdown, KNOWLEDGE_STATUS_START);
  const ends = findAll(markdown, KNOWLEDGE_STATUS_END);

  const start = starts[0];
  const end = ends[0];

  return (
    starts.length === 1 &&
    ends.length === 1 &&
    start !== undefined &&
    end !== undefined &&
    start < end
  );
}

function normalizeClaimIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function addClaimSection(
  sections: string[],
  heading: string,
  claims: readonly ClaimRecord[]
): void {
  if (claims.length === 0) {
    return;
  }

  sections.push("### " + heading);

  for (const claim of claims) {
    sections.push(formatClaimBullet(claim));

    if (claim.sourceReferences.length > 0) {
      sections.push(
        "  - Sources: " + claim.sourceReferences.join("; ")
      );
    }

    if (claim.kind === "formal_statement") {
      sections.push(
        claim.verification === "lean_checked" &&
        claim.leanProofStatus === "passed"
          ? "  - Status: Lean-checked"
          : "  - Status: Ready for Lean review"
      );
    }
  }

  sections.push("");
}

function formatClaimBullet(claim: ClaimRecord): string {
  return "- " + claim.text.replace(/\n/g, "\n  ");
}

function findAll(value: string, target: string): number[] {
  const indexes: number[] = [];
  let offset = 0;

  while (offset <= value.length) {
    const index = value.indexOf(target, offset);

    if (index === -1) {
      break;
    }

    indexes.push(index);
    offset = index + target.length;
  }

  return indexes;
}
