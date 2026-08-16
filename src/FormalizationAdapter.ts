// ── PersonalSemanticIR → FormalizationProtocol Adapter ────────────────
// Deterministic projection from the target-independent IR into the existing
// Lain Language ↔ Lean4 protocol.  This module does NOT create a competing
// proof protocol and does NOT mutate the Brain.
//
// Concept bindings and Brain revision provenance are preserved in the IR
// itself and returned alongside the FormalizationProtocol parameters so the
// caller can keep the two representations linked without widening the
// existing persistence schema.
// ────────────────────────────────────────────────────────────────────────

import {
  type CreateFormalizationParams,
  type FormalizationAssumption,
  type MathObject,
  type SemanticChange
} from "./FormalizationProtocol";
import {
  lookupConceptById,
  type ConceptIndex
} from "./BrainGrowthIndex";
import type {
  ConceptBinding,
  ConceptRevisionRef,
  IRSemanticChange,
  PersonalSemanticIR
} from "./PersonalSemanticIR";

export interface AdaptIRSuccess {
  readonly ok: true;
  readonly params: CreateFormalizationParams;
  readonly conceptBindings: readonly ConceptBinding[];
  readonly originatingConceptRevisions: readonly ConceptRevisionRef[];
}

export type AdaptIRResult =
  | AdaptIRSuccess
  | { readonly ok: false; readonly error: string };

function assumptionToFormalization(
  id: string,
  text: string
): FormalizationAssumption {
  return { id, text };
}

function mapSemanticChange(
  change: Readonly<IRSemanticChange>
): SemanticChange {
  return {
    category: change.category,
    description: change.description,
    before: change.before,
    after: change.after,
    relatedAssumptionKeys: change.relatedAssumptionIds
  };
}

/**
 * Convert a validated PersonalSemanticIR into the existing
 * `CreateFormalizationParams` shape.  Implicit assumptions are guaranteed to
 * have a matching `added_assumption` semantic change so the existing
 * FormalizationProtocol invariant is preserved.
 */
export function adaptPersonalSemanticIRToFormalization(
  ir: Readonly<PersonalSemanticIR>,
  claimId: string = ir.source.messageId
): AdaptIRResult {
  if (claimId.trim() === "") {
    return { ok: false, error: "claimId must be a non-empty string." };
  }

  const objects: MathObject[] = ir.objects.map((object) => ({
    name: object.name,
    latex: object.latex,
    domain: object.domain
  }));

  const explicitAssumptions: FormalizationAssumption[] = [];
  const implicitAssumptions: FormalizationAssumption[] = [];

  for (const assumption of ir.assumptions) {
    if (assumption.kind === "implicit") {
      implicitAssumptions.push(
        assumptionToFormalization(assumption.id, assumption.text)
      );
    } else {
      explicitAssumptions.push(
        assumptionToFormalization(assumption.id, assumption.text)
      );
    }
  }

  const semanticChanges: SemanticChange[] = ir.semanticChanges.map(
    mapSemanticChange
  );

  // Guarantee the existing invariant: every implicit assumption must be
  // referenced by an added_assumption semantic change.
  const referencedImplicitIds = new Set<string>();
  for (const change of semanticChanges) {
    if (change.category !== "added_assumption") {
      continue;
    }
    for (const key of change.relatedAssumptionKeys ?? []) {
      referencedImplicitIds.add(key);
    }
  }

  for (const assumption of implicitAssumptions) {
    if (referencedImplicitIds.has(assumption.id)) {
      continue;
    }
    semanticChanges.push({
      category: "added_assumption",
      description: `Assumed: ${assumption.text}`,
      relatedAssumptionKeys: [assumption.id]
    });
  }

  return {
    ok: true,
    params: {
      claimId,
      sourceRefs: [
        {
          messageId: ir.source.messageId,
          startOffset: ir.source.startOffset,
          endOffset: ir.source.endOffset,
          snapshot: ir.source.snapshot
        }
      ],
      speechAct: ir.speechAct,
      objects,
      explicitAssumptions,
      implicitAssumptions,
      quantifiers: ir.quantifiers,
      conclusion: ir.conclusion,
      ambiguities: ir.ambiguities,
      missingConditions: ir.missingConditions,
      semanticChanges,
      aiNormalizedStatement: ir.canonicalStatement,
      latexStatement: ir.latexStatement
    },
    conceptBindings: ir.conceptBindings,
    originatingConceptRevisions: ir.originatingConceptRevisions
  };
}

// ── Brain-Aware Bounded Context ────────────────────────────────────────
// Privacy boundary: only resolved concepts that are actually referenced by
// the current IR are allowed to leave the device.  Never the whole Brain,
// never unrelated notes, never Vault contents.

export interface BrainConceptContextItem {
  readonly conceptId: string;
  readonly title: string;
  readonly revision: number;
  readonly aliases: readonly string[];
  readonly personalDefinition?: string;
  readonly standardDefinition?: string;
  readonly definitionConflict: boolean;
  readonly relevantRelationships: readonly {
    readonly relation: string;
    readonly targetLabel: string;
    readonly targetConceptId: string;
  }[];
}

export interface BrainAwareFormalizationContext {
  readonly conceptContext: readonly BrainConceptContextItem[];
  readonly excludedKinds: readonly string[];
}

/**
 * Build bounded concept context for an explicit set of stable concept IDs.
 * This is the only Brain data that may leave the device for formalization.
 */
export function buildBoundedConceptContext(
  conceptIds: ReadonlySet<string>,
  index: Readonly<ConceptIndex>
): BrainAwareFormalizationContext {
  const conceptContext: BrainConceptContextItem[] = [];

  for (const conceptId of conceptIds) {
    const lookup = lookupConceptById(index, conceptId);
    if (lookup.kind !== "unique_match") {
      continue;
    }
    const concept = lookup.match.concept;
    const personalDefinition = concept.userDefinition?.text;
    const standardDefinition = concept.standardDefinitions
      .map((entry) => entry.text)
      .find((text) => text.trim() !== "");
    const definitionConflict =
      personalDefinition !== undefined &&
      standardDefinition !== undefined &&
      personalDefinition.trim() !== standardDefinition.trim();

    conceptContext.push({
      conceptId: concept.id,
      title: concept.title,
      revision: concept.revision,
      aliases: concept.aliases,
      personalDefinition,
      standardDefinition,
      definitionConflict,
      relevantRelationships: concept.relationships.map((relationship) => ({
        relation: relationship.relation,
        targetLabel: relationship.targetLabel,
        targetConceptId: relationship.targetConceptId
      }))
    });
  }

  return {
    conceptContext,
    excludedKinds: [
      "api_keys",
      "unrelated_notes",
      "vault_content",
      "attachments",
      "unrelated_plugin_metadata"
    ]
  };
}

export function buildBrainAwareFormalizationContext(
  ir: Readonly<PersonalSemanticIR>,
  index: Readonly<ConceptIndex>
): BrainAwareFormalizationContext {
  const requestedConceptIds = new Set<string>();

  for (const binding of ir.conceptBindings) {
    if (binding.status === "resolved" && binding.conceptId !== undefined) {
      requestedConceptIds.add(binding.conceptId);
    }
  }
  for (const revision of ir.originatingConceptRevisions) {
    requestedConceptIds.add(revision.conceptId);
  }

  return buildBoundedConceptContext(requestedConceptIds, index);
}

export function renderBrainAwareFormalizationContext(
  context: Readonly<BrainAwareFormalizationContext>
): string {
  if (context.conceptContext.length === 0) {
    return "No resolved Personal Brain concepts are referenced.";
  }

  return context.conceptContext
    .map((item) => {
      const lines: string[] = [];
      lines.push(
        `Concept: ${item.title} (${item.conceptId}@${item.revision})`
      );
      if (item.aliases.length > 0) {
        lines.push(`  Aliases: ${item.aliases.join(", ")}`);
      }
      if (item.personalDefinition !== undefined) {
        lines.push(`  Personal definition: ${item.personalDefinition}`);
      }
      if (item.standardDefinition !== undefined) {
        lines.push(`  Standard definition: ${item.standardDefinition}`);
      }
      if (item.definitionConflict) {
        lines.push(
          "  WARNING: personal definition differs from standard definition."
        );
      }
      if (item.relevantRelationships.length > 0) {
        lines.push("  Relevant relationships:");
        for (const relationship of item.relevantRelationships) {
          lines.push(
            `    - ${relationship.relation} ${relationship.targetLabel}`
          );
        }
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

// ── DeepSeek Boundary Instructions ─────────────────────────────────────
// DeepSeek may propose interpretation; it must never become the semantic
// authority and must never claim Lean verification.

export const BRAIN_AWARE_INTERPRETATION_RULES: readonly string[] = [
  "Preserve the user's exact mathematical intent.",
  "Resolve provided Personal Brain concepts using their supplied definitions.",
  "Do not replace personal definitions with model-default meanings.",
  "Do not invent missing assumptions silently.",
  "Missing assumptions must be explicit.",
  "Ambiguity must be explicit.",
  "Distinguish intuition from proof.",
  "Distinguish conjecture from theorem claim.",
  "Preserve proof-step order.",
  "Do not output unsupported Semantic IR categories.",
  "Never claim Lean verification.",
  "Never convert assistant wording into user-authored evidence."
];
