import { requestDeepSeek } from "./DeepSeekClient";
import {
  MACRO_SCHEMA_VERSION,
  validateMacroDefinition
} from "./MacroTypes";
import type {
  MacroAction,
  MacroConfirmationPolicy,
  MacroDefinition,
  MacroParameter,
  MacroPattern
} from "./MacroTypes";
import { normalizeMacroText } from "./MacroMatcher";

export interface MacroDefinitionInterpreter {
  interpret(
    request: string
  ): Promise<MacroDefinition | { readonly error: string }>;
}

export interface MacroDefinitionPreview {
  readonly triggerPhrases: readonly string[];
  readonly parameters: readonly string[];
  readonly actions: readonly string[];
  readonly writesToChat: boolean;
  readonly confirmation: string;
  readonly undoable: boolean;
}

export type MacroDefinitionCandidateResult =
  | { readonly ok: true; readonly macro: MacroDefinition }
  | { readonly ok: false; readonly error: string };

export type MacroDefinitionGenerator = (
  apiKey: string,
  description: string,
  existingMacros: readonly MacroDefinition[]
) => Promise<MacroDefinitionCandidateResult>;

const MACRO_DEFINITION_SYSTEM_PROMPT = [
  "You translate a user's natural-language macro description into a strict JSON MacroDefinition.",
  "",
  "Allowed patterns are:",
  "- {\"kind\":\"exact\",\"phrase\":\"text\"}",
  "- {\"kind\":\"trailing\",\"phrase\":\"text\"}",
  "- {\"kind\":\"parameterized\",\"template\":\"remove line {n}\",\"parameters\":[{\"name\":\"n\",\"type\":\"integer\",\"min\":1}]}",
  "",
  "Allowed actions are ONLY: submit_to_brain, delete_segment, replace_segment,",
  "truncate_from_segment, mark_candidate_note, unmark_candidate_note,",
  "restore_last_step, insert_text. Never invent another action.",
  "",
  "A line-number delete must use delete_segment with \"line\":{\"parameter\":\"n\"}.",
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
    return { ok: false, error: "Macro definition failed schema validation." };
  }
  if (base.schemaVersion !== MACRO_SCHEMA_VERSION) {
    return { ok: false, error: "Macro definition schema version is unsupported." };
  }

  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.patterns) || raw.patterns.length === 0) {
    return { ok: false, error: "Macro definition must contain at least one pattern." };
  }
  if (!Array.isArray(raw.actions) || raw.actions.length === 0) {
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

  const actions: MacroAction[] = [];
  for (const action of raw.actions) {
    const validated = validateAction(action, parameters);
    if (typeof validated === "string") {
      return { ok: false, error: validated };
    }
    actions.push(validated);
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
    patterns: Object.freeze(patterns),
    parameters: Object.freeze(parameters),
    actions: Object.freeze(actions),
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
  apiKey: string,
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

  return parseMacroDefinitionCandidateJson(response, existingMacros);
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
