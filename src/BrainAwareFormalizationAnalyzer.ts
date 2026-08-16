// ── Brain-Aware Formalization Analyzer ─────────────────────────────────
// Live DeepSeek request for the "Formalize using Brain concepts" workflow.
//
// DeepSeek acts as a translator only.  The returned structure is a proposal
// that the workflow validates and re-resolves against the local Brain before
// it can ever become a FormalizationRecord.
// ────────────────────────────────────────────────────────────────────────

import { requestDeepSeek } from "./DeepSeekClient";
import type {
  BrainFormalizationAnalysis,
  BrainFormalizationAnalysisInput
} from "./BrainFormalizationWorkflow";

export const BRAIN_AWARE_FORMALIZATION_RULES: readonly string[] = [
  "Translate semantic structure, not prose style.",
  "Use supplied personal definitions when binding Brain concepts.",
  "Never replace user meaning with standard meaning silently.",
  "Preserve quantifiers.",
  "Preserve implication vs equivalence.",
  "Preserve containment vs equality.",
  "Preserve analogy vs identity.",
  "Missing assumptions must be explicit.",
  "Inference gaps must remain explicit.",
  "Preserve proof-step order.",
  "Never claim Lean verification.",
  "Assistant text is not user-authored evidence.",
  "Use only supported IR categories.",
  "Prefer unresolved ambiguity over invented certainty."
];

const SPEECH_ACTS = new Set([
  "definition_candidate",
  "equivalence_claim",
  "theorem_claim",
  "conjecture",
  "proof_sketch",
  "intuition"
]);

const CLAIM_KINDS = new Set([
  "definition",
  "proposition",
  "theorem",
  "conjecture",
  "intuition"
]);

const ASSUMPTION_KINDS = new Set([
  "user_authoritative",
  "explicit",
  "implicit"
]);

const PROOF_STEP_KINDS = new Set([
  "introduce_object",
  "assume_proposition",
  "invoke_definition",
  "invoke_known_claim",
  "derive_claim",
  "rewrite_using_equivalence",
  "instantiate_quantifier",
  "conclude",
  "unresolved_inference"
]);

const SEMANTIC_CHANGE_CATEGORIES = new Set([
  "added_assumption",
  "removed_ambiguity",
  "strengthened",
  "weakened",
  "added_condition",
  "narrowed_scope"
]);

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is number => typeof item === "number" && Number.isInteger(item)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonResponse(raw: string, context: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  const jsonText = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(jsonText);
  } catch {
    throw new Error(`DeepSeek returned invalid ${context} JSON.`);
  }
}

function invalid(message: string): { error: string } {
  return { error: message };
}

/**
 * Parse and normalize a DeepSeek IR proposal.  This is deterministic and
 * used directly by tests without network access.
 */
export function parsePersonalSemanticIRResponse(
  raw: unknown
): BrainFormalizationAnalysis | { error: string } {
  if (!isRecord(raw)) {
    return invalid("DeepSeek IR proposal must be an object.");
  }

  const speechAct = asString(raw.speechAct);
  if (!SPEECH_ACTS.has(speechAct)) {
    return invalid("Missing or invalid speechAct.");
  }
  const canonicalStatement = asString(raw.canonicalStatement);
  if (canonicalStatement === "") {
    return invalid("Missing canonicalStatement.");
  }

  const objects = (Array.isArray(raw.objects) ? raw.objects : []).map(
    (value) => {
      const object = isRecord(value) ? value : {};
      return {
        name: asString(object.name),
        latex: asString(object.latex) || undefined,
        domain: asString(object.domain) || undefined,
        sourceDomain: asString(object.sourceDomain) || undefined,
        boundPhrase: asString(object.boundPhrase) || undefined
      };
    }
  ).filter((object) => object.name !== "");

  const claims = (Array.isArray(raw.claims) ? raw.claims : []).map(
    (value) => {
      const claim = isRecord(value) ? value : {};
      const kind = asString(claim.kind);
      if (!CLAIM_KINDS.has(kind)) {
        throw new Error(`Invalid claim kind "${kind}".`);
      }
      return {
        kind: kind as BrainFormalizationAnalysis["claims"][number]["kind"],
        statement: asString(claim.statement),
        quantifiers: asString(claim.quantifiers) || undefined,
        sourceQuantifiers: asString(claim.sourceQuantifiers) || undefined,
        conclusion: asString(claim.conclusion) || undefined,
        authority: asString(claim.authority) || "ai_interpreted",
        confidence: typeof claim.confidence === "number"
          ? claim.confidence
          : undefined,
        semanticChangeKind: asString(claim.semanticChangeKind) || undefined,
        boundPhrases: asStringArray(claim.boundPhrases)
      } as BrainFormalizationAnalysis["claims"][number];
    }
  ).filter((claim) => claim.statement !== "");

  const assumptions = (Array.isArray(raw.assumptions) ? raw.assumptions : [])
    .map((value) => {
      const assumption = isRecord(value) ? value : {};
      const kind = asString(assumption.kind);
      if (!ASSUMPTION_KINDS.has(kind)) {
        throw new Error(`Invalid assumption kind "${kind}".`);
      }
      return {
        text: asString(assumption.text),
        kind: kind as BrainFormalizationAnalysis["assumptions"][number]["kind"],
        addedByAI: assumption.addedByAI === true
      };
    })
    .filter((assumption) => assumption.text !== "");

  const relations = (Array.isArray(raw.relations) ? raw.relations : [])
    .map((value) => {
      const relation = isRecord(value) ? value : {};
      return {
        fromObjectName: asString(relation.fromObjectName),
        toObjectName: asString(relation.toObjectName),
        relation: asString(relation.relation),
        note: asString(relation.note) || undefined
      };
    })
    .filter(
      (relation) =>
        relation.fromObjectName !== "" &&
        relation.toObjectName !== "" &&
        relation.relation !== ""
    );

  const proofSteps = (Array.isArray(raw.proofSteps) ? raw.proofSteps : [])
    .map((value) => {
      const step = isRecord(value) ? value : {};
      const kind = asString(step.kind);
      if (!PROOF_STEP_KINDS.has(kind)) {
        throw new Error(`Invalid proof step kind "${kind}".`);
      }
      return {
        kind: kind as BrainFormalizationAnalysis["proofSteps"][number]["kind"],
        description: asString(step.description),
        inputClaimIndexes: asNumberArray(step.inputClaimIndexes),
        outputClaimIndexes: asNumberArray(step.outputClaimIndexes),
        referencedPhrases: asStringArray(step.referencedPhrases),
        assumptionIndexes: asNumberArray(step.assumptionIndexes),
        unresolvedAssumptionIndexes: asNumberArray(
          step.unresolvedAssumptionIndexes
        ),
        authority: asString(step.authority) || "ai_interpreted",
        dependencies: asNumberArray(step.dependencies)
      } as BrainFormalizationAnalysis["proofSteps"][number];
    })
    .filter((step) => step.description !== "");

  const semanticChanges = (
    Array.isArray(raw.semanticChanges) ? raw.semanticChanges : []
  ).map((value) => {
    const change = isRecord(value) ? value : {};
    const category = asString(change.category);
    if (!SEMANTIC_CHANGE_CATEGORIES.has(category)) {
      throw new Error(`Invalid semantic change category "${category}".`);
    }
    return {
      category: category as BrainFormalizationAnalysis["semanticChanges"][number]["category"],
      description: asString(change.description),
      before: asString(change.before) || undefined,
      after: asString(change.after) || undefined,
      relatedAssumptionIndexes: asNumberArray(change.relatedAssumptionIndexes)
    };
  }).filter((change) => change.description !== "");

  const conceptBindings = (
    Array.isArray(raw.conceptBindings) ? raw.conceptBindings : []
  ).map((value) => {
    const binding = isRecord(value) ? value : {};
    return {
      surfacePhrase: asString(binding.surfacePhrase),
      stableId: asString(binding.stableId) || undefined,
      proposedNewTitle: asString(binding.proposedNewTitle) || undefined
    };
  }).filter((binding) => binding.surfacePhrase !== "");

  return {
    speechAct: speechAct as BrainFormalizationAnalysis["speechAct"],
    canonicalStatement,
    quantifiers: asString(raw.quantifiers),
    conclusion: asString(raw.conclusion),
    latexStatement: asString(raw.latexStatement) || undefined,
    conceptBindings,
    objects,
    claims,
    assumptions,
    relations,
    proofSteps,
    ambiguities: asStringArray(raw.ambiguities),
    resolvedAmbiguities: asStringArray(raw.resolvedAmbiguities),
    missingConditions: asStringArray(raw.missingConditions),
    removedAssumptions: asStringArray(raw.removedAssumptions),
    semanticChanges
  };
}

function buildUserMessage(
  input: BrainFormalizationAnalysisInput
): string {
  const candidates = input.candidates
    .map((candidate) =>
      `- ${candidate.id} "${candidate.surfacePhrase}": ` +
      candidate.alternatives
        .map(
          (alternative) =>
            `${alternative.title} (${alternative.conceptId}@${alternative.revision})`
        )
        .join(" | ")
    )
    .join("\n");

  const context = input.conceptContext
    .map((item) => {
      const parts = [
        `Concept: ${item.title} (${item.conceptId}@${item.revision})`
      ];
      if (item.personalDefinition !== undefined) {
        parts.push(`Personal definition: ${item.personalDefinition}`);
      }
      if (item.standardDefinition !== undefined) {
        parts.push(`Standard definition: ${item.standardDefinition}`);
      }
      if (item.definitionConflict) {
        parts.push(
          "NOTE: personal definition differs from standard definition."
        );
      }
      return parts.join("\n");
    })
    .join("\n\n");

  return (
    "<source-text>\n" +
    input.sourceText +
    "\n</source-text>\n\n" +
    "<candidate-concepts>\n" +
    (candidates === "" ? "(none)" : candidates) +
    "\n</candidate-concepts>\n\n" +
    "<bounded-concept-context>\n" +
    (context === "" ? "(none)" : context) +
    "\n</bounded-concept-context>\n\n" +
    "Produce the strict JSON PersonalSemanticIR proposal."
  );
}

const SCHEMA_TEXT = [
  "Return strict JSON only, no Markdown fence, no commentary.",
  "",
  "Shape:",
  "{",
  '  "speechAct": "definition_candidate|equivalence_claim|theorem_claim|conjecture|proof_sketch|intuition",',
  '  "canonicalStatement": "...",',
  '  "quantifiers": "...",',
  '  "conclusion": "...",',
  '  "latexStatement": "...",',
  '  "conceptBindings": [{"surfacePhrase":"...","stableId":"...","proposedNewTitle":"..."}],',
  '  "objects": [{"name":"...","latex":"...","domain":"...","sourceDomain":"...","boundPhrase":"..."}],',
  '  "claims": [{"kind":"...","statement":"...","quantifiers":"...","sourceQuantifiers":"...","conclusion":"...","authority":"...","confidence":0.0,"semanticChangeKind":"unchanged|strengthened|weakened","boundPhrases":["..."]}],',
  '  "assumptions": [{"text":"...","kind":"explicit|implicit|user_authoritative","addedByAI":false}],',
  '  "relations": [{"fromObjectName":"...","toObjectName":"...","relation":"...","note":"..."}],',
  '  "proofSteps": [{"kind":"...","description":"...","inputClaimIndexes":[0],"outputClaimIndexes":[1],"referencedPhrases":["..."],"assumptionIndexes":[0],"unresolvedAssumptionIndexes":[0],"authority":"...","dependencies":[0]}],',
  '  "ambiguities": ["..."],',
  '  "resolvedAmbiguities": ["..."],',
  '  "missingConditions": ["..."],',
  '  "removedAssumptions": ["..."],',
  '  "semanticChanges": [{"category":"added_assumption|removed_ambiguity|strengthened|weakened|added_condition|narrowed_scope","description":"...","before":"...","after":"...","relatedAssumptionIndexes":[0]}]',
  "}"
].join("\n");

export function buildBrainFormalizationAnalysisMessages(
  input: BrainFormalizationAnalysisInput
): { role: "system" | "user"; content: string }[] {
  const rules = BRAIN_AWARE_FORMALIZATION_RULES.map(
    (rule, index) => `${index + 1}. ${rule}`
  ).join("\n");
  return [
    {
      role: "system",
      content:
        "Analyze a selected mathematical source using the supplied bounded " +
        "Personal Brain concept context. You are a translator, not an " +
        "authority.\n\n" +
        "RULES:\n" +
        rules +
        "\n\n" +
        SCHEMA_TEXT
    },
    {
      role: "user",
      content: buildUserMessage(input)
    }
  ];
}

export async function analyzePersonalSemanticIR(
  apiKey: string,
  input: BrainFormalizationAnalysisInput
): Promise<BrainFormalizationAnalysis | { error: string }> {
  const response = await requestDeepSeek(
    apiKey,
    buildBrainFormalizationAnalysisMessages(input)
  );
  try {
    return parsePersonalSemanticIRResponse(
      parseJsonResponse(response, "PersonalSemanticIR proposal")
    );
  } catch (error) {
    return {
      error: error instanceof Error
        ? error.message
        : "Unable to parse PersonalSemanticIR proposal."
    };
  }
}

