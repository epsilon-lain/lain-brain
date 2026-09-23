import type { MacroDefinition, MacroMatchOutcome, MacroPattern } from "./MacroTypes";

export function normalizeMacroText(value: string): string {
  return value.normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[，。！？；：、]/g, (character) => ({ "，": ",", "。": ".", "！": "!", "？": "?", "；": ";", "：": ":", "、": "," }[character] ?? character))
    .replace(/[!?.,;:]+$/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patternMatch(pattern: MacroPattern, text: string): { parameters: Record<string, string | number>; consumedText: string } | null {
  if (pattern.kind === "exact") {
    return text === normalizeMacroText(pattern.phrase) ? { parameters: {}, consumedText: text } : null;
  }
  if (pattern.kind === "trailing") {
    const phrase = normalizeMacroText(pattern.phrase);
    return new RegExp(`(?:^|[\\s,])${escapeRegex(phrase)}$`).test(text)
      ? { parameters: {}, consumedText: phrase }
      : null;
  }
  const names = pattern.parameters.map((parameter) => parameter.name);
  const template = normalizeMacroText(pattern.template);
  const parts = template.split(/\{([^}]+)\}/g);
  let source = "^";
  for (let index = 0; index < parts.length; index += 1) {
    if (index % 2 === 0) source += escapeRegex(parts[index] ?? "");
    else source += names.includes(parts[index] ?? "") ? "(.+?)" : escapeRegex(`{${parts[index] ?? ""}}`);
  }
  source += "$";
  const match = new RegExp(source).exec(text);
  if (match === null) return null;
  const parameters: Record<string, string | number> = {};
  for (const [index, parameter] of pattern.parameters.entries()) {
    const raw = (match[index + 1] ?? "").trim();
    if (parameter.type === "integer") {
      if (!/^\d+$/.test(raw)) return null;
      const number = Number(raw);
      if (!Number.isSafeInteger(number) ||
          (parameter.min !== undefined && number < parameter.min) ||
          (parameter.max !== undefined && number > parameter.max)) {
        return null;
      }
      parameters[parameter.name] = number;
    } else {
      if (raw === "") return null;
      parameters[parameter.name] = raw;
    }
  }
  return Object.keys(parameters).length === pattern.parameters.length
    ? { parameters, consumedText: text }
    : null;
}

export class MacroMatcher {
  private readonly macros: readonly MacroDefinition[];
  constructor(macros: readonly MacroDefinition[]) { this.macros = macros; }

  match(input: string): MacroMatchOutcome {
    const normalizedText = normalizeMacroText(input);
    if (normalizedText === "") return { kind: "none", normalizedText };
    const matches = this.macros.filter((macro) => macro.enabled).flatMap((macro) => macro.patterns.map((pattern) => {
      const result = patternMatch(pattern, normalizedText);
      return result === null ? [] : [{ macro, ...result }];
    })).flat();
    const unique = matches.filter((item, index) => matches.findIndex((other) => other.macro.id === item.macro.id) === index);
    if (unique.length > 1) return { kind: "conflict", normalizedText, macros: unique.map((item) => item.macro) };
    const match = unique[0];
    return match === undefined ? { kind: "none", normalizedText } : { kind: "match", ...match, normalizedText };
  }
}
