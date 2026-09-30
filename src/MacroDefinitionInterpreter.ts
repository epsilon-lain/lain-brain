import type { TextModelCredentials } from "./TextModelConfig";
import { requestDeepSeek } from "./DeepSeekClient";
import {
  MACRO_SCHEMA_VERSION,
  validateMacroDefinition,
  deriveMacroTriggerLanguages,
  summarizeMacroIntent
} from "./MacroTypes";
import type {
  MacroAction,
  MacroConfirmationPolicy,
  MacroDefinition,
  MacroParameter,
  MacroPattern,
  MacroTriggerLanguage
} from "./MacroTypes";
import { normalizeMacroText } from "./MacroMatcher";

export interface MacroDefinitionInterpreter {
  interpret(
    request: string
  ): Promise<MacroDefinition | { readonly error: string }>;
}

export interface MacroDefinitionPreview {
  readonly triggerPhrases: readonly string[];
  readonly triggerLanguages: readonly MacroTriggerLanguage[];
  readonly triggerIntent: string;
  readonly parameters: readonly string[];
  readonly actions: readonly string[];
  readonly writesToChat: boolean;
  readonly confirmation: string;
  readonly undoable: boolean;
}

export type MacroDefinitionCandidateResult =
  | { readonly ok: true; readonly macro: MacroDefinition }
  | {
      readonly ok: false;
      readonly error: string;
      readonly diagnostics?: readonly MacroDiagnostic[];
    };

export interface MacroDiagnostic {
  readonly path: string;
  readonly expected: string;
  readonly actual: string;
}

export type MacroDefinitionGenerator = (
  apiKey: TextModelCredentials,
  description: string,
  existingMacros: readonly MacroDefinition[]
) => Promise<MacroDefinitionCandidateResult>;

export const MACRO_DEFINITION_SYSTEM_PROMPT = [
  "You translate a user's natural-language macro description into a strict JSON MacroDefinition.",
  "",
  "Allowed patterns are:",
  "- {\"kind\":\"exact\",\"phrase\":\"text\"}",
  "- {\"kind\":\"trailing\",\"phrase\":\"text\"}",
  "- {\"kind\":\"parameterized\",\"template\":\"remove line {n}\",\"parameters\":[{\"name\":\"n\",\"type\":\"integer\",\"min\":1}]}",
  "",
  "Allowed actions are ONLY: submit_to_brain, delete_segment, delete_segment_range, replace_segment,",
  "truncate_from_segment, mark_candidate_note, unmark_candidate_note,",
  "restore_last_step, insert_text. Never invent another action.",
  "",
  "A line-number delete must use delete_segment with \"line\":{\"parameter\":\"n\"}.",
  "A range delete must use delete_segment_range with startLine and endLine parameters.",
  "Use the user's own trigger wording and language for the parameterized pattern.",
  "If the user explicitly authorizes trigger wording in more than one language,",
  "emit one parameterized pattern per authorized language (for example a Chinese",
  "template and an English template). Never add a language the user did not authorize.",
  "For example, a Chinese range delete could use template \"删除第 {start} 行到第 {end} 行\".",
  "A recover/undo macro must use restore_last_step and set undoable to true.",
  "submit_to_brain submits the current Chat Space text.",
  "",
  "Every parameter used in an action or template must be declared in the top-level",
  "\"parameters\" array. Integer parameters may include min and max.",
  "",
  "confirmation must be one of {\"kind\":\"never\"}, {\"kind\":\"always\"},",
  "or {\"kind\":\"destructive\"}.",
  "",
  "Return strict JSON only, no Markdown fence or commentary, with this shape:",
  JSON.stringify({
    id: "macro-id",
    name: "Human readable name",
    patterns: [],
    parameters: [],
    actions: [],
    writesToChat: false,
    undoable: true,
    confirmation: { kind: "destructive" },
    enabled: true,
    createdAt: "ISO date",
    updatedAt: "ISO date",
    schemaVersion: MACRO_SCHEMA_VERSION
  })
].join("\n");

function errorMessage(
  error: unknown,
  fallback: string
): string {
  return error instanceof Error && error.message !== ""
    ? error.message
    : fallback;
}

function requireString(
  value: unknown,
  label: string
): string | null {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : null;
}

function validateParameter(
  value: unknown
): MacroParameter | string {
  if (typeof value !== "object" || value === null) {
    return "Macro parameter must be an object.";
  }
  const input = value as Record<string, unknown>;
  const name = requireString(input.name, "parameter name");
  if (typeof name !== "string") {
    return "Macro parameter name must be non-empty text.";
  }
  if (input.type !== "integer" && input.type !== "text") {
    return `Macro parameter "${name}" must have type integer or text.`;
  }
  const min = input.min;
  const max = input.max;
  if (min !== undefined && (typeof min !== "number" || !Number.isSafeInteger(min))) {
    return `Macro parameter "${name}" min must be an integer.`;
  }
  if (max !== undefined && (typeof max !== "number" || !Number.isSafeInteger(max))) {
    return `Macro parameter "${name}" max must be an integer.`;
  }
  if (
    typeof min === "number" &&
    typeof max === "number" &&
    min > max
  ) {
    return `Macro parameter "${name}" min cannot exceed max.`;
  }
  return {
    name,
    type: input.type,
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {})
  };
}

function validatePattern(
  value: unknown
): MacroPattern | string {
  if (typeof value !== "object" || value === null) {
    return "Macro pattern must be an object.";
  }
  const input = value as Record<string, unknown>;
  const kind = input.kind;
  if (kind === "exact" || kind === "trailing") {
    const phrase = requireString(input.phrase, "pattern phrase");
    return typeof phrase !== "string"
      ? "Macro pattern phrase must be non-empty text."
      : { kind, phrase };
  }
  if (kind === "parameterized") {
    const template = requireString(input.template, "pattern template");
    if (typeof template !== "string") {
      return "Parameterized pattern template must be non-empty text.";
    }
    if (!Array.isArray(input.parameters)) {
      return "Parameterized pattern parameters must be an array.";
    }
    const parameters: MacroParameter[] = [];
    for (const parameter of input.parameters) {
      const validated = validateParameter(parameter);
      if (typeof validated === "string") return validated;
      parameters.push(validated);
    }
    const names = new Set(parameters.map((parameter) => parameter.name));
    const placeholders = Array.from(
      template.matchAll(/\{([^{}]+)\}/g),
      (match) => match[1]?.trim() ?? ""
    ).filter((name) => name !== "");
    if (placeholders.length !== new Set(placeholders).size) {
      return "Parameterized pattern placeholders must be unique.";
    }
    if (placeholders.length !== parameters.length) {
      return "Parameterized pattern template placeholders must match its parameters.";
    }
    if (!placeholders.every((name) => names.has(name))) {
      return "Parameterized pattern references an undeclared parameter.";
    }
    return { kind, template, parameters };
  }
  return "Unsupported macro pattern kind.";
}

function validateAction(
  value: unknown,
  declaredParameters: readonly MacroParameter[]
): MacroAction | string {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return "Macro action must be an object with a kind.";
  }
  const input = value as Record<string, unknown>;
  const kind = input.kind;
  const parameterNames = new Set(
    declaredParameters.map((parameter) => parameter.name)
  );
  switch (kind) {
    case "submit_to_brain":
      return { kind: "submit_to_brain" };
    case "restore_last_step":
      return { kind: "restore_last_step" };
    case "delete_segment": {
      const segmentId = input.segmentId;
      const line = input.line;
      if (segmentId === undefined && line === undefined) {
        return "delete_segment requires segmentId or line.";
      }
      if (segmentId !== undefined) {
        if (typeof segmentId !== "string" || segmentId.trim() === "") {
          return "delete_segment segmentId must be non-empty text.";
        }
        return { kind: "delete_segment", segmentId };
      }
      if (typeof line === "number" && Number.isSafeInteger(line)) {
        return { kind: "delete_segment", line };
      }
      if (typeof line === "object" && line !== null) {
        const parameter = (line as Record<string, unknown>).parameter;
        if (
          typeof parameter === "string" &&
          parameterNames.has(parameter)
        ) {
          return { kind: "delete_segment", line: { parameter } };
        }
      }
      return "delete_segment line must reference a declared parameter.";
    }
    case "delete_segment_range": {
      const startLine = input.startLine;
      const endLine = input.endLine;
      if (startLine === undefined || endLine === undefined) {
        return "delete_segment_range requires startLine and endLine.";
      }
      const resolveLine = (line: unknown): number | { parameter: string } | null => {
        if (typeof line === "number" && Number.isSafeInteger(line)) {
          return line;
        }
        if (typeof line === "object" && line !== null) {
          const parameter = (line as Record<string, unknown>).parameter;
          if (
            typeof parameter === "string" &&
            parameterNames.has(parameter)
          ) {
            return { parameter };
          }
        }
        return null;
      };
      const start = resolveLine(startLine);
      const end = resolveLine(endLine);
      if (start === null || end === null) {
        return "delete_segment_range lines must be numbers or declared parameters.";
      }
      return { kind: "delete_segment_range", startLine: start, endLine: end };
    }
    case "replace_segment": {
      const segmentId = input.segmentId;
      const text = input.text;
      if (typeof segmentId !== "string" || segmentId.trim() === "") {
        return "replace_segment requires a non-empty segmentId.";
      }
      if (typeof text !== "string") {
        return "replace_segment requires text.";
      }
      return { kind: "replace_segment", segmentId, text };
    }
    case "truncate_from_segment":
    case "mark_candidate_note":
    case "unmark_candidate_note": {
      const segmentId = input.segmentId;
      if (typeof segmentId !== "string" || segmentId.trim() === "") {
        return `${kind} requires a non-empty segmentId.`;
      }
      return { kind, segmentId };
    }
    case "insert_text": {
      const text = input.text;
      if (typeof text !== "string" || text.trim() === "") {
        return "insert_text requires non-empty text.";
      }
      const afterSegmentId = input.afterSegmentId;
      return afterSegmentId === undefined
        ? { kind: "insert_text", text }
        : typeof afterSegmentId === "string" && afterSegmentId.trim() !== ""
          ? { kind: "insert_text", text, afterSegmentId }
          : "insert_text afterSegmentId must be non-empty text.";
    }
    default:
      return "Unsupported macro action kind.";
  }
}

function validateConfirmation(
  value: unknown
): MacroConfirmationPolicy | string {
  if (typeof value !== "object" || value === null) {
    return "Macro confirmation must be an object.";
  }
  const kind = (value as Record<string, unknown>).kind;
  return kind === "never" ||
    kind === "always" ||
    kind === "destructive"
    ? { kind }
    : "Macro confirmation kind must be never, always, or destructive.";
}

function patternKey(pattern: MacroPattern): string {
  if (pattern.kind === "exact" || pattern.kind === "trailing") {
    return `${pattern.kind}:${normalizeMacroText(pattern.phrase)}`;
  }
  return `parameterized:${normalizeMacroText(pattern.template)}`;
}

function findMacroConflict(
  candidate: MacroDefinition,
  existingMacros: readonly MacroDefinition[]
): string | null {
  if (candidate.id === "builtin-ka") {
    return "The built-in ka macro id is reserved.";
  }
  if (existingMacros.some((macro) => macro.id === candidate.id)) {
    return "A macro with this id already exists.";
  }

  const existingKeys = new Map<string, MacroDefinition>();
  for (const macro of existingMacros) {
    for (const pattern of macro.patterns) {
      existingKeys.set(patternKey(pattern), macro);
    }
  }

  const candidateKeys = new Set<string>();
  for (const pattern of candidate.patterns) {
    const key = patternKey(pattern);
    if (candidateKeys.has(key)) {
      return "The candidate macro has duplicate trigger patterns.";
    }
    candidateKeys.add(key);
    const existing = existingKeys.get(key);
    if (existing !== undefined) {
      return `This trigger already belongs to "${existing.name}".`;
    }
  }
  return null;
}

export function validateMacroDefinitionCandidate(
  value: unknown,
  existingMacros: readonly MacroDefinition[] = []
): MacroDefinitionCandidateResult {
  const base = validateMacroDefinition(value);
  if (base === null) {
    return {
      ok: false,
      error: "Macro definition failed schema validation.",
      diagnostics: diagnoseMacroSchema(value)
    };
  }
  if (base.schemaVersion !== MACRO_SCHEMA_VERSION) {
    return { ok: false, error: "Macro definition schema version is unsupported." };
  }

  const raw = value as Record<string, unknown>;
  const actions = Array.isArray(raw.actions)
    ? raw.actions.map((action) => {
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
    : raw.actions;
  if (!Array.isArray(raw.patterns) || raw.patterns.length === 0) {
    return { ok: false, error: "Macro definition must contain at least one pattern." };
  }
  if (!Array.isArray(actions) || actions.length === 0) {
    return { ok: false, error: "Macro definition must contain at least one action." };
  }

  const parameters: MacroParameter[] = [];
  for (const parameter of Array.isArray(raw.parameters) ? raw.parameters : []) {
    const validated = validateParameter(parameter);
    if (typeof validated === "string") {
      return { ok: false, error: validated };
    }
    parameters.push(validated);
  }

  const patterns: MacroPattern[] = [];
  for (const pattern of raw.patterns) {
    const validated = validatePattern(pattern);
    if (typeof validated === "string") {
      return { ok: false, error: validated };
    }
    patterns.push(validated);
  }

  const validatedActions: MacroAction[] = [];
  for (const action of actions) {
    const validated = validateAction(action, parameters);
    if (typeof validated === "string") {
      return { ok: false, error: validated };
    }
    validatedActions.push(validated);
  }

  const confirmation = validateConfirmation(raw.confirmation);
  if (typeof confirmation === "string") {
    return { ok: false, error: confirmation };
  }

  const name = requireString(base.name, "name");
  const id = requireString(base.id, "id");
  const createdAt = requireString(base.createdAt, "createdAt");
  const updatedAt = requireString(base.updatedAt, "updatedAt");
  if (
    typeof name !== "string" ||
    typeof id !== "string" ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    return { ok: false, error: "Macro id, name, and dates must be non-empty text." };
  }

  const candidate: MacroDefinition = Object.freeze({
    id,
    name,
    description: typeof base.description === "string" ? base.description : undefined,
    triggerLanguages: deriveMacroTriggerLanguages(
      patterns,
      typeof base.description === "string" ? base.description : undefined
    ),
    triggerIntent: summarizeMacroIntent(validatedActions),
    patterns: Object.freeze(patterns),
    parameters: Object.freeze(parameters),
    actions: Object.freeze(validatedActions),
    writesToChat: base.writesToChat,
    undoable: base.undoable,
    confirmation,
    enabled: base.enabled,
    createdAt,
    updatedAt,
    schemaVersion: MACRO_SCHEMA_VERSION
  });

  const conflict = findMacroConflict(candidate, existingMacros);
  return conflict === null
    ? { ok: true, macro: candidate }
    : { ok: false, error: conflict };
}

function diagnoseMacroSchema(value: unknown): MacroDiagnostic[] {
  if (typeof value !== "object" || value === null) {
    return [{ path: "$", expected: "object", actual: typeof value }];
  }
  const raw = value as Record<string, unknown>;
  const diagnostics: MacroDiagnostic[] = [];
  const checks: Array<[string, string, (v: unknown) => boolean]> = [
    ["$.id", "non-empty string", (v) => typeof v === "string" && v.trim() !== ""],
    ["$.name", "non-empty string", (v) => typeof v === "string" && v.trim() !== ""],
    ["$.patterns", "non-empty array", (v) => Array.isArray(v) && v.length > 0],
    ["$.parameters", "array", (v) => Array.isArray(v)],
    ["$.actions", "non-empty array", (v) => Array.isArray(v) && v.length > 0],
    ["$.createdAt", "string", (v) => typeof v === "string"],
    ["$.updatedAt", "string", (v) => typeof v === "string"],
    ["$.enabled", "boolean", (v) => typeof v === "boolean"]
  ];
  for (const [path, expected, check] of checks) {
    const actual = raw[path.slice(2)];
    if (!check(actual)) {
      diagnostics.push({
        path,
        expected,
        actual: actual === null ? "null" : Array.isArray(actual) ? "array" : typeof actual
      });
    }
  }
  if (Array.isArray(raw.actions)) {
    raw.actions.forEach((action, index) => {
      if (typeof action !== "object" || action === null) {
        diagnostics.push({
          path: `$.actions[${index}]`,
          expected: "object with kind",
          actual: typeof action
        });
        return;
      }
      const kind = "kind" in action ? (action as { kind: unknown }).kind :
        "type" in action ? (action as { type: unknown }).type : undefined;
      if (typeof kind !== "string") {
        diagnostics.push({
          path: `$.actions[${index}].kind`,
          expected: "supported action kind",
          actual: typeof kind
        });
      }
    });
  }
  return diagnostics;
}

export function parseMacroDefinitionCandidateJson(
  raw: string,
  existingMacros: readonly MacroDefinition[] = []
): MacroDefinitionCandidateResult {
  let parsed: unknown;
  try {
    const withoutFence = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    parsed = JSON.parse(withoutFence) as unknown;
  } catch (error) {
    return {
      ok: false,
      error: `Macro definition response was not valid JSON: ${errorMessage(error, "parse failed")}`
    };
  }
  return validateMacroDefinitionCandidate(parsed, existingMacros);
}

export function validateInterpretedMacro(
  value: unknown
): MacroDefinition | { readonly error: string } {
  const result = validateMacroDefinitionCandidate(value);
  return result.ok
    ? result.macro
    : { error: result.error };
}

export async function generateMacroDefinitionCandidate(
  apiKey: TextModelCredentials,
  description: string,
  existingMacros: readonly MacroDefinition[]
): Promise<MacroDefinitionCandidateResult> {
  const existingSummary = existingMacros
    .map((macro) =>
      `${macro.name}: ${macro.patterns.map((pattern) =>
        pattern.kind === "exact" || pattern.kind === "trailing"
          ? pattern.phrase
          : pattern.template
      ).join(", ")}`
    )
    .join("\n");

  const response = await requestDeepSeek(apiKey, [
    {
      role: "system",
      content: MACRO_DEFINITION_SYSTEM_PROMPT
    },
    {
      role: "user",
      content: [
        "Existing macros:",
        existingSummary === "" ? "(none)" : existingSummary,
        "",
        "Macro description:",
        description
      ].join("\n")
    }
  ]);

  const first = parseMacroDefinitionCandidateJson(response, existingMacros);
  if (first.ok) {
    return {
      ok: true,
      macro: {
        ...first.macro,
        description
      }
    };
  }

  const retryResponse = await requestDeepSeek(apiKey, [
    {
      role: "system",
      content: MACRO_DEFINITION_SYSTEM_PROMPT
    },
    {
      role: "user",
      content: [
        "Existing macros:",
        existingSummary === "" ? "(none)" : existingSummary,
        "",
        "Macro description:",
        description
      ].join("\n")
    },
    {
      role: "user",
      content:
        `The previous response failed schema validation: ${first.error}. ` +
        "Return strict JSON only with the corrected MacroDefinition shape."
    }
  ]);

  const retry = parseMacroDefinitionCandidateJson(retryResponse, existingMacros);
  return retry.ok
    ? { ok: true, macro: { ...retry.macro, description } }
    : retry;
}

export function buildMacroDefinitionPreview(
  macro: MacroDefinition
): MacroDefinitionPreview {
  return {
    triggerPhrases: macro.patterns.map((pattern) =>
      pattern.kind === "exact" || pattern.kind === "trailing"
        ? pattern.phrase
        : pattern.template
    ),
    triggerLanguages: macro.triggerLanguages ??
      deriveMacroTriggerLanguages(
        macro.patterns,
        macro.description
      ),
    triggerIntent: macro.triggerIntent ??
      summarizeMacroIntent(macro.actions),
    parameters: macro.parameters.map((parameter) => {
      const bounds =
        parameter.type === "integer"
          ? parameter.min !== undefined || parameter.max !== undefined
            ? ` (${parameter.min ?? ""}..${parameter.max ?? ""})`
            : ""
          : "";
      return `${parameter.name}: ${parameter.type}${bounds}`;
    }),
    actions: macro.actions.map((action) => {
      switch (action.kind) {
        case "submit_to_brain":
          return "Submit Chat Space to Brain";
        case "delete_segment":
          return action.line !== undefined
            ? typeof action.line === "number"
              ? `Delete line ${action.line}`
              : `Delete line {${action.line.parameter}}`
            : `Delete segment ${action.segmentId ?? ""}`;
        case "delete_segment_range":
          return `Delete lines ${formatLine(action.startLine)} through ${formatLine(action.endLine)}`;
        case "replace_segment":
          return `Replace segment ${action.segmentId} with "${action.text}"`;
        case "truncate_from_segment":
          return `Truncate from segment ${action.segmentId}`;
        case "mark_candidate_note":
          return `Mark segment ${action.segmentId} as candidate note`;
        case "unmark_candidate_note":
          return `Unmark segment ${action.segmentId} as candidate note`;
        case "restore_last_step":
          return "Restore last reversible step";
        case "insert_text":
          return `Insert text "${action.text}"`;
      }
    }),
    writesToChat: macro.writesToChat,
    confirmation:
      macro.confirmation.kind === "never"
        ? "No confirmation"
        : macro.confirmation.kind === "always"
          ? "Always confirm"
          : "Confirm destructive actions",
    undoable: macro.undoable
  };
}

function formatLine(
  line: number | { readonly parameter: string } | undefined
): string {
  if (line === undefined) return "?";
  return typeof line === "number" ? String(line) : `{${line.parameter}}`;
}
