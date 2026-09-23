export type VoiceSubmitTailResult =
  | { readonly kind: "none" }
  | {
      readonly kind: "exact";
      readonly body: string;
      readonly trigger: string;
    }
  | {
      readonly kind: "uncertain";
      readonly candidate: string;
      readonly body: string;
    };

const TRAILING_PUNCTUATION = /[!?.,;:，。！？；：、]+$/u;
const TRAILING_BODY_SEPARATORS = /[\s,，、;；:：]+$/u;
const UNCERTAIN_TAIL_CANDIDATES = new Set([
  "cut",
  "cat",
  "kah",
  "kaa",
  "k"
]);

function lastWordCandidate(raw: string): string | null {
  const withoutTrailing = raw
    .normalize("NFKC")
    .trim()
    .replace(TRAILING_PUNCTUATION, "")
    .trim();
  if (withoutTrailing === "") {
    return null;
  }
  const tokens = withoutTrailing
    .split(/[\s,，、;；:：]+/u)
    .filter((token) => token !== "");
  return tokens[tokens.length - 1] ?? null;
}

function bodyBeforeCandidate(raw: string, candidate: string): string {
  const index = raw
    .normalize("NFKC")
    .toLocaleLowerCase()
    .lastIndexOf(candidate.normalize("NFKC").toLocaleLowerCase());
  return index > 0
    ? raw
        .slice(0, index)
        .replace(TRAILING_BODY_SEPARATORS, "")
        .trim()
    : "";
}

export function analyzeVoiceSubmitTail(
  raw: string
): VoiceSubmitTailResult {
  const candidate = lastWordCandidate(raw);
  if (candidate === null) {
    return { kind: "none" };
  }

  const lower = candidate.normalize("NFKC").toLocaleLowerCase();
  if (lower === "ka") {
    const body = bodyBeforeCandidate(raw, candidate);
    return { kind: "exact", body, trigger: candidate };
  }

  if (UNCERTAIN_TAIL_CANDIDATES.has(lower)) {
    return {
      kind: "uncertain",
      candidate,
      body: bodyBeforeCandidate(raw, candidate)
    };
  }

  return { kind: "none" };
}
