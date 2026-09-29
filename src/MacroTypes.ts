export const MACRO_SCHEMA_VERSION = 1 as const;

export type MacroTriggerLanguage = "zh" | "en";

export type MacroPattern =
  | { readonly kind: "exact"; readonly phrase: string }
  | {
      readonly kind: "parameterized";
      readonly template: string;
      readonly parameters: readonly MacroParameter[];
    }
  | { readonly kind: "trailing"; readonly phrase: string };

export interface MacroParameter {
  readonly name: string;
  readonly type: "integer" | "text";
  readonly min?: number;
  readonly max?: number;
}

export type MacroAction =
  | { readonly kind: "submit_to_brain" }
  | { readonly kind: "delete_segment"; readonly segmentId?: string; readonly line?: number | { readonly parameter: string } }
  | {
      readonly kind: "delete_segment_range";
      readonly startLine?: number | { readonly parameter: string };
      readonly endLine?: number | { readonly parameter: string };
    }
  | { readonly kind: "replace_segment"; readonly segmentId?: string; readonly text: string }
  | { readonly kind: "truncate_from_segment"; readonly segmentId?: string }
  | { readonly kind: "mark_candidate_note"; readonly segmentId?: string }
  | { readonly kind: "unmark_candidate_note"; readonly segmentId?: string }
  | { readonly kind: "restore_last_step" }
  | { readonly kind: "insert_text"; readonly text: string; readonly afterSegmentId?: string };

export type MacroConfirmationPolicy =
  | { readonly kind: "never" }
  | { readonly kind: "always" }
  | { readonly kind: "destructive" };

export interface MacroDefinition {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly triggerLanguages?: readonly MacroTriggerLanguage[];
  readonly triggerIntent?: string;
  readonly patterns: readonly MacroPattern[];
  readonly parameters: readonly MacroParameter[];
  readonly actions: readonly MacroAction[];
  readonly writesToChat: boolean;
  readonly undoable: boolean;
  readonly confirmation: MacroConfirmationPolicy;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly schemaVersion: number;
}

/** Detect the language(s) present in a trigger phrase or turn. */
export function detectTriggerLanguages(
  text: string
): readonly MacroTriggerLanguage[] {
  const languages = new Set<MacroTriggerLanguage>();
  if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(text)) languages.add("zh");
  if (/[a-z]/iu.test(text)) languages.add("en");
  return [...languages].sort();
}

/**
 * Conservative, auditable shape check for a "direct operative command". This
 * only rejects clearly non-command turns (long dictation, questions, quoted
 * text, and explicit explanation/paraphrase framing). It never positively
 * proves a command; the model and local parameter validation do the rest.
 */
export function isDirectMacroCommandShape(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  // A dictation/manual is much longer than a spoken command.
  if (trimmed.length > 40) return false;
  // Questions are not commands.
  if (/[？?]$/u.test(trimmed)) return false;
  // Quoted/reported speech is not a direct command.
  if (/[「」『』“”"'`]/u.test(trimmed)) return false;
  // Explicit framing for explanation, example, paraphrase, or definition.
  if (/(例如|比如|举例|意思是|指的是|当我说|我说|如果|所谓|叫做|也就是|即|怎么|如何|什么|为什么|是否|能否|教我|说明|操作)/u.test(trimmed)) {
    return false;
  }
  return true;
}

/**
 * Derive the authorized trigger languages from a macro's concrete trigger
 * wording. Old data without an explicit scope conservatively receives only the
 * languages actually present in its patterns (or description), never "en" for a
 * Chinese-only macro.
 */
export function deriveMacroTriggerLanguages(
  patterns: readonly MacroPattern[],
  description?: string
): readonly MacroTriggerLanguage[] {
  const languages = new Set<MacroTriggerLanguage>();
  for (const pattern of patterns) {
    const raw = pattern.kind === "exact" || pattern.kind === "trailing"
      ? pattern.phrase
      : pattern.template;
    // Placeholder names such as {start}/{end} are not spoken language.
    const text = raw.replace(/\{[^{}]*\}/gu, " ");
    for (const language of detectTriggerLanguages(text)) {
      languages.add(language);
    }
  }
  if (languages.size === 0 && description !== undefined) {
    for (const language of detectTriggerLanguages(description)) {
      languages.add(language);
    }
  }
  return [...languages].sort();
}

/** Stable, locally-derived human-readable description of the trigger intent. */
export function summarizeMacroIntent(actions: readonly MacroAction[]): string {
  const parts = actions.map((action): string => {
    switch (action.kind) {
      case "submit_to_brain":
        return "提交当前 Chat Space 给 Brain";
      case "delete_segment":
        return action.line !== undefined
          ? typeof action.line === "number"
            ? `删除第 ${action.line} 行`
            : "删除指定行"
          : "删除指定段落";
      case "delete_segment_range":
        return "删除 Chat Space 指定行范围";
      case "replace_segment":
        return "替换指定段落";
      case "truncate_from_segment":
        return "从指定段落截断";
      case "mark_candidate_note":
        return "标记候选笔记";
      case "unmark_candidate_note":
        return "取消标记候选笔记";
      case "restore_last_step":
        return "撤销最近一次可恢复操作";
      case "insert_text":
        return "插入文本";
    }
  });
  return parts.join("；");
}

export interface MacroMatchResult {
  readonly kind: "match";
  readonly macro: MacroDefinition;
  readonly parameters: Readonly<Record<string, string | number>>;
  readonly normalizedText: string;
  readonly consumedText: string;
}

export type MacroMatchOutcome =
  | MacroMatchResult
  | { readonly kind: "none"; readonly normalizedText: string }
  | { readonly kind: "conflict"; readonly normalizedText: string; readonly macros: readonly MacroDefinition[] };

export function isMacroAction(value: unknown): value is MacroAction {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  const kind = (value as { kind: unknown }).kind;
  return typeof kind === "string" && new Set([
    "submit_to_brain", "delete_segment", "delete_segment_range", "replace_segment", "truncate_from_segment",
    "mark_candidate_note", "unmark_candidate_note", "restore_last_step", "insert_text"
  ]).has(kind);
}

export function validateMacroDefinition(value: unknown): MacroDefinition | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;
  const actions = Array.isArray(input.actions)
    ? input.actions.map((action) => {
        if (
          typeof action === "object" &&
          action !== null &&
          !("kind" in action) &&
          "type" in action
        ) {
          return { ...action, kind: (action as { type: unknown }).type };
        }
        return action;
      })
    : input.actions;
  if (typeof input.id !== "string" || typeof input.name !== "string" ||
      !Array.isArray(input.patterns) || !Array.isArray(input.parameters) ||
      !Array.isArray(actions) || typeof input.createdAt !== "string" ||
      typeof input.updatedAt !== "string" || typeof input.enabled !== "boolean") return null;
  if (!input.patterns.every((pattern) => {
    if (typeof pattern !== "object" || pattern === null) return false;
    const kind = (pattern as { kind?: unknown }).kind;
    return kind === "exact" || kind === "trailing" || kind === "parameterized";
  }) || !actions.every(isMacroAction)) return null;
  const parameters = input.parameters.filter((item): item is MacroParameter => {
    if (typeof item !== "object" || item === null) return false;
    const parameter = item as Record<string, unknown>;
    return typeof parameter.name === "string" &&
      (parameter.type === "integer" || parameter.type === "text");
  });
  if (parameters.length !== input.parameters.length) return null;
  const patterns = input.patterns as MacroPattern[];
  const description = typeof input.description === "string"
    ? input.description
    : undefined;
  const triggerLanguages =
    Array.isArray(input.triggerLanguages) &&
    input.triggerLanguages.every(
      (language) => language === "zh" || language === "en"
    )
      ? (input.triggerLanguages as MacroTriggerLanguage[])
      : deriveMacroTriggerLanguages(patterns, description);
  return Object.freeze({
    id: input.id,
    name: input.name,
    description,
    triggerLanguages,
    triggerIntent: typeof input.triggerIntent === "string" &&
      input.triggerIntent.trim() !== ""
      ? input.triggerIntent
      : summarizeMacroIntent(actions as MacroAction[]),
    patterns,
    parameters,
    actions: actions as MacroAction[],
    writesToChat: input.writesToChat === true,
    undoable: input.undoable !== false,
    confirmation: input.confirmation === undefined
      ? { kind: "destructive" as const }
      : input.confirmation as MacroConfirmationPolicy,
    enabled: input.enabled,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    schemaVersion: typeof input.schemaVersion === "number" ? input.schemaVersion : MACRO_SCHEMA_VERSION
  });
}
