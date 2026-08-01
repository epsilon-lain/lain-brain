export interface CandidatePrimaryConcept {
  name: string;
  aliases: string[];
}

export interface VerifiedCandidateRelation {
  linkTarget: string;
  matchedAlias: string;
}

interface FenceState {
  marker: "`" | "~";
  length: number;
}

const PSEUDOINVERSE_ALIASES = [
  "伪逆",
  "pseudoinverse",
  "Moore-Penrose inverse",
  "Moore–Penrose inverse",
  "Moore-Penrose pseudoinverse",
  "Moore–Penrose pseudoinverse"
];

const PSEUDOINVERSE_KEYS = new Set(
  PSEUDOINVERSE_ALIASES.map(normalizeSearchText)
);

export function normalizeCandidatePrimaryConcept(
  concept: CandidatePrimaryConcept
): CandidatePrimaryConcept {
  const terms = [concept.name, ...concept.aliases]
    .map(cleanConceptTerm)
    .filter((term): term is string => term !== "");

  if (
    terms.some((term) =>
      PSEUDOINVERSE_KEYS.has(normalizeSearchText(term))
    )
  ) {
    return {
      name: "伪逆",
      aliases: [...PSEUDOINVERSE_ALIASES]
    };
  }

  const name = terms[0];

  if (name === undefined) {
    throw new Error("No primary concept was identified.");
  }

  const aliases = [
    ...new Map(
      terms.map((term) => [normalizeSearchText(term), term])
    ).values()
  ];

  return {
    name,
    aliases
  };
}

export function findConfirmedPrimaryConcept(
  text: string
): CandidatePrimaryConcept | null {
  const pseudoinverse: CandidatePrimaryConcept = {
    name: "伪逆",
    aliases: [...PSEUDOINVERSE_ALIASES]
  };

  return findConceptEvidence(text, pseudoinverse) === null
    ? null
    : pseudoinverse;
}

export function findConceptEvidence(
  text: string,
  concept: CandidatePrimaryConcept
): string | null {
  const normalizedText = normalizeSearchText(text);

  for (const alias of concept.aliases) {
    const normalizedAlias = normalizeSearchText(alias);

    if (
      normalizedAlias !== "" &&
      containsNormalizedTerm(normalizedText, normalizedAlias)
    ) {
      return alias;
    }
  }

  return null;
}

export function haveSameCandidateConcept(
  left: CandidatePrimaryConcept,
  right: CandidatePrimaryConcept
): boolean {
  const leftTerms = new Set(
    [left.name, ...left.aliases]
      .map(normalizeSearchText)
      .filter((term) => term !== "")
  );

  return [right.name, ...right.aliases]
    .map(normalizeSearchText)
    .some((term) => term !== "" && leftTerms.has(term));
}

export function buildCandidateNoteMarkdown(
  modelMarkdown: string,
  concept: CandidatePrimaryConcept,
  relations: VerifiedCandidateRelation[]
): string {
  const sanitizedBody = stripManagedSections(
    stripWikiLinksOutsideCode(modelMarkdown)
  ).trim();
  const bodyLines = sanitizedBody === ""
    ? []
    : sanitizedBody.split("\n");
  const firstContentIndex = bodyLines.findIndex(
    (line) => line.trim() !== ""
  );
  let title = "";
  let body = sanitizedBody;

  if (firstContentIndex !== -1) {
    const firstContentLine = bodyLines[firstContentIndex];

    if (
      firstContentLine !== undefined &&
      /^#(?!#)\s+\S/.test(firstContentLine)
    ) {
      title = firstContentLine.trim();
      bodyLines.splice(firstContentIndex, 1);
      body = bodyLines.join("\n").trim();
    }
  }

  const coreConcept =
    `## 核心概念\n- [[${sanitizeWikiTarget(concept.name)}]]`;
  const uniqueRelations = new Map<
    string,
    VerifiedCandidateRelation
  >();

  for (const relation of relations) {
    if (!uniqueRelations.has(relation.linkTarget)) {
      uniqueRelations.set(relation.linkTarget, relation);
    }
  }

  const sortedRelations = [...uniqueRelations.values()].sort(
    (left, right) =>
      left.linkTarget.localeCompare(right.linkTarget)
  );
  const relationBody = sortedRelations.length === 0
    ? "暂未发现包含同一核心概念的已有节点。"
    : sortedRelations
        .map(
          (relation) =>
            `- [[${sanitizeWikiTarget(relation.linkTarget)}]]` +
            `（正文命中：${escapeMarkdownText(
              relation.matchedAlias
            )}）`
        )
        .join("\n");
  const relationSection = `## 关系\n${relationBody}`;

  return [title, coreConcept, body, relationSection]
    .filter((section) => section !== "")
    .join("\n\n")
    .trim();
}

function cleanConceptTerm(value: string): string {
  return value
    .replace(/\[\[|\]\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function containsNormalizedTerm(
  text: string,
  term: string
): boolean {
  if (!/[a-z0-9]/i.test(term)) {
    return text.includes(term);
  }

  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(^|[^a-z0-9])${escaped}($|[^a-z0-9])`,
    "i"
  );

  return pattern.test(text);
}

function stripManagedSections(markdown: string): string {
  const managedHeadings = new Set([
    "核心概念",
    "关系",
    "primary concept",
    "core concept",
    "relations",
    "relationships"
  ]);
  const keptLines: string[] = [];
  let skippedHeadingLevel: number | null = null;

  for (const line of markdown.split("\n")) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);

    if (heading !== null) {
      const level = heading[1]?.length ?? 0;
      const title = (
        heading[2]
          ?.trim()
          .replace(/[:：]+$/, "")
          .toLocaleLowerCase() ?? ""
      );

      if (managedHeadings.has(title)) {
        skippedHeadingLevel = level;
        continue;
      }

      if (
        skippedHeadingLevel !== null &&
        level <= skippedHeadingLevel
      ) {
        skippedHeadingLevel = null;
      }
    }

    if (skippedHeadingLevel === null) {
      keptLines.push(line);
    }
  }

  return keptLines.join("\n");
}

function stripWikiLinksOutsideCode(markdown: string): string {
  let result = "";
  let index = 0;
  let inlineCodeTicks = 0;
  let fence: FenceState | null = null;

  while (index < markdown.length) {
    const atLineStart = index === 0 || markdown[index - 1] === "\n";

    if (atLineStart && inlineCodeTicks === 0) {
      const newlineIndex = markdown.indexOf("\n", index);
      const lineEnd = newlineIndex === -1
        ? markdown.length
        : newlineIndex;
      const line = markdown.slice(index, lineEnd);
      const fenceMatch = line.match(
        /^(?:(?:[ \t]*>[ \t]?)*[ \t]*)(`{3,}|~{3,})/
      );

      if (fence !== null) {
        if (isClosingFence(line, fence, fenceMatch)) {
          fence = null;
        }

        result += line;

        if (newlineIndex !== -1) {
          result += "\n";
        }

        index = newlineIndex === -1
          ? markdown.length
          : newlineIndex + 1;
        continue;
      }

      const markerRun = fenceMatch?.[1];

      if (markerRun !== undefined) {
        const marker = markerRun[0];

        if (marker === "`" || marker === "~") {
          fence = {
            marker,
            length: markerRun.length
          };
        }

        result += line;

        if (newlineIndex !== -1) {
          result += "\n";
        }

        index = newlineIndex === -1
          ? markdown.length
          : newlineIndex + 1;
        continue;
      }
    }

    const character = markdown.charAt(index);

    if (character === "`") {
      let runLength = 1;

      while (markdown[index + runLength] === "`") {
        runLength += 1;
      }

      result += markdown.slice(index, index + runLength);

      if (inlineCodeTicks === 0) {
        inlineCodeTicks = runLength;
      } else if (inlineCodeTicks === runLength) {
        inlineCodeTicks = 0;
      }

      index += runLength;
      continue;
    }

    if (inlineCodeTicks === 0) {
      const embedded = markdown.startsWith("![[", index);
      const linkStart = embedded ? index + 1 : index;

      if (markdown.startsWith("[[", linkStart)) {
        const linkEnd = markdown.indexOf("]]", linkStart + 2);

        if (linkEnd !== -1) {
          const linkText = markdown.slice(linkStart + 2, linkEnd);
          result += getWikiLinkDisplayText(linkText);
          index = linkEnd + 2;
          continue;
        }
      }

      const markdownImage = markdown.startsWith("![", index);
      const markdownLinkStart = markdownImage ? index + 1 : index;

      if (markdown.charAt(markdownLinkStart) === "[") {
        const labelEnd = markdown.indexOf("]", markdownLinkStart + 1);

        if (
          labelEnd !== -1 &&
          markdown.charAt(labelEnd + 1) === "("
        ) {
          const destinationEnd = markdown.indexOf(")", labelEnd + 2);

          if (destinationEnd !== -1) {
            result += markdown.slice(
              markdownLinkStart + 1,
              labelEnd
            );
            index = destinationEnd + 1;
            continue;
          }
        }
      }
    }

    result += character;
    index += 1;
  }

  return result;
}

function isClosingFence(
  line: string,
  fence: FenceState,
  match: RegExpMatchArray | null
): boolean {
  if (match === null) {
    return false;
  }

  const markerRun = match[1];

  if (
    markerRun === undefined ||
    markerRun[0] !== fence.marker ||
    markerRun.length < fence.length
  ) {
    return false;
  }

  return /^[ \t]*$/.test(line.slice(match[0].length));
}

function getWikiLinkDisplayText(linkText: string): string {
  const aliasSeparator = linkText.lastIndexOf("|");

  if (aliasSeparator !== -1) {
    return linkText.slice(aliasSeparator + 1).trim();
  }

  return linkText
    .split("#", 1)[0]
    ?.split("^", 1)[0]
    ?.trim() ?? "";
}

function sanitizeWikiTarget(value: string): string {
  const sanitized = value
    .replace(/\[\[|\]\]/g, "")
    .replace(/[|#^\r\n]/g, "")
    .trim();

  if (sanitized === "") {
    throw new Error("A wiki-link target was empty.");
  }

  return sanitized;
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_[\]])/g, "\\$1");
}
