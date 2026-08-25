// ── Brain Formalization Workflow ──────────────────────────────────────
// A reviewed, read-only path from a selected mathematical source to an
// accepted PersonalSemanticIR and then to the existing FormalizationProtocol.
//
// The workflow never mutates Personal Brain ConceptNodes.  It only reads a
// bounded ConceptIndex and produces review state.  Any future Brain update
// must continue through SemanticDelta authority boundaries.
// ────────────────────────────────────────────────────────────────────────

import {
  lookupConceptById,
  normalizeConceptLookupText,
  type ConceptIndex,
  type ConceptLookupMatchKind
} from "./BrainGrowthIndex";
import {
  resolveConceptBinding,
  buildOriginatingConceptRevisions
} from "./ConceptBindingResolver";
import {
  createPersonalSemanticIR,
  validatePersonalSemanticIR,
  computeSemanticDiff,
  type ConceptBinding,
  type IRAssumptionKind,
  type IRClaimKind,
  type IRClaimSemanticChange,
  type IRProofStepKind,
  type IRSemanticChangeCategory,
  type IRSpeechAct,
  type IRValidationFailure,
  type PersonalSemanticIR,
  type SemanticDiffEntry,
  type SemanticAuthority
} from "./PersonalSemanticIR";
import {
  adaptPersonalSemanticIRToFormalization,
  buildBoundedConceptContext,
  type BrainAwareFormalizationContext,
  type BrainConceptContextItem
} from "./FormalizationAdapter";
import {
  createFormalizationRecord,
  type FormalizationRecord
} from "./FormalizationProtocol";

// ── Source ─────────────────────────────────────────────────────────────

export interface BrainFormalizationSource {
  readonly messageId: string;
  readonly snapshot: string;
  readonly startOffset?: number;
  readonly endOffset?: number;
}

// ── Candidate Concept Discovery ───────────────────────────────────────

export interface ConceptCandidateAlternative {
  readonly conceptId: string;
  readonly title: string;
  readonly revision: number;
  readonly matchedBy: ConceptLookupMatchKind;
}

export interface ConceptCandidate {
  readonly id: string;
  readonly surfacePhrase: string;
  readonly alternatives: readonly ConceptCandidateAlternative[];
}

const EXPLICIT_CONCEPT_ID_PATTERN = /\bconcept:([A-Za-z0-9_-]+)/g;

function pushCandidate(
  groups: Map<string, {
    phrase: string;
    entries: {
      conceptId: string;
      title: string;
      revision: number;
      matchedBy: ConceptLookupMatchKind;
    }[];
  }>,
  phrase: string,
  entry: {
    conceptId: string;
    title: string;
    revision: number;
    matchedBy: ConceptLookupMatchKind;
  }
): void {
  const key = normalizeConceptLookupText(phrase);
  if (key === "") {
    return;
  }
  const group = groups.get(key) ?? { phrase, entries: [] };
  if (!group.entries.some((existing) => existing.conceptId === entry.conceptId)) {
    group.entries.push(entry);
  }
  groups.set(key, group);
}

/**
 * Conservatively discover concepts referenced in the source using only local
 * deterministic lookup (titles, aliases, and explicit `concept:<id>` tokens).
 * This never sends the whole Brain and never invents a binding.
 */
export function discoverConceptCandidates(
  sourceText: string,
  index: Readonly<ConceptIndex>
): ConceptCandidate[] {
  const normalizedSource = normalizeConceptLookupText(sourceText);
  const groups = new Map<string, {
    phrase: string;
    entries: {
      conceptId: string;
      title: string;
      revision: number;
      matchedBy: ConceptLookupMatchKind;
    }[];
  }>();

  for (const concept of index.concepts) {
    const surfacePhrases = [concept.title, ...concept.aliases];
    for (const phrase of surfacePhrases) {
      const normalizedPhrase = normalizeConceptLookupText(phrase);
      if (
        normalizedPhrase === "" ||
        !normalizedSource.includes(normalizedPhrase)
      ) {
        continue;
      }
      pushCandidate(groups, phrase, {
        conceptId: concept.id,
        title: concept.title,
        revision: concept.revision,
        matchedBy: phrase === concept.title ? "exact_title" : "alias"
      });
    }
  }

  // Explicit stable-ID references take precedence and are also surfaced.
  EXPLICIT_CONCEPT_ID_PATTERN.lastIndex = 0;
  for (const match of sourceText.matchAll(EXPLICIT_CONCEPT_ID_PATTERN)) {
    const conceptId = match[1];
    if (conceptId === undefined) {
      continue;
    }
    const lookup = lookupConceptById(index, conceptId);
    if (lookup.kind === "unique_match") {
      pushCandidate(groups, `concept:${conceptId}`, {
        conceptId: lookup.match.concept.id,
        title: lookup.match.concept.title,
        revision: lookup.match.concept.revision,
        matchedBy: "stable_id"
      });
    }
  }

  const candidates: ConceptCandidate[] = [];
  for (const group of groups.values()) {
    candidates.push({
      id: `cand-${candidates.length}`,
      surfacePhrase: group.phrase,
      alternatives: group.entries.map((entry) => ({
        conceptId: entry.conceptId,
        title: entry.title,
        revision: entry.revision,
        matchedBy: entry.matchedBy
      }))
    });
  }

  return candidates;
}

function buildCandidateContext(
  candidates: readonly ConceptCandidate[],
  index: Readonly<ConceptIndex>
): BrainAwareFormalizationContext {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    for (const alternative of candidate.alternatives) {
      ids.add(alternative.conceptId);
    }
  }
  return buildBoundedConceptContext(ids, index);
}

// ── Analyzer Contract ──────────────────────────────────────────────────

export interface ProposedConceptBinding {
  readonly surfacePhrase: string;
  readonly stableId?: string;
  readonly proposedNewTitle?: string;
}

export interface ProposedObject {
  readonly name: string;
  readonly latex?: string;
  readonly domain?: string;
  readonly sourceDomain?: string;
  readonly boundPhrase?: string;
}

export interface ProposedClaim {
  readonly kind: IRClaimKind;
  readonly statement: string;
  readonly quantifiers?: string;
  readonly sourceQuantifiers?: string;
  readonly conclusion?: string;
  readonly authority?: SemanticAuthority;
  readonly confidence?: number;
  readonly semanticChangeKind?: IRClaimSemanticChange;
  readonly boundPhrases?: readonly string[];
}

export interface ProposedAssumption {
  readonly text: string;
  readonly kind: IRAssumptionKind;
  readonly addedByAI: boolean;
}

export interface ProposedRelation {
  readonly fromObjectName: string;
  readonly toObjectName: string;
  readonly relation: string;
  readonly note?: string;
}

export interface ProposedProofStep {
  readonly kind: IRProofStepKind;
  readonly description: string;
  readonly inputClaimIndexes?: readonly number[];
  readonly outputClaimIndexes?: readonly number[];
  readonly referencedPhrases?: readonly string[];
  readonly assumptionIndexes?: readonly number[];
  readonly unresolvedAssumptionIndexes?: readonly number[];
  readonly authority?: SemanticAuthority;
  readonly dependencies?: readonly number[];
}

export interface ProposedSemanticChange {
  readonly category: IRSemanticChangeCategory;
  readonly description: string;
  readonly before?: string;
  readonly after?: string;
  readonly relatedAssumptionIndexes?: readonly number[];
}

export interface BrainFormalizationAnalysis {
  readonly speechAct: IRSpeechAct;
  readonly canonicalStatement: string;
  readonly quantifiers: string;
  readonly conclusion: string;
  readonly latexStatement?: string;
  readonly conceptBindings: readonly ProposedConceptBinding[];
  readonly objects: readonly ProposedObject[];
  readonly claims: readonly ProposedClaim[];
  readonly assumptions: readonly ProposedAssumption[];
  readonly relations: readonly ProposedRelation[];
  readonly proofSteps: readonly ProposedProofStep[];
  readonly ambiguities: readonly string[];
  readonly resolvedAmbiguities: readonly string[];
  readonly missingConditions: readonly string[];
  readonly removedAssumptions: readonly string[];
  readonly semanticChanges: readonly ProposedSemanticChange[];
}

export interface BrainFormalizationAnalysisInput {
  readonly sourceText: string;
  readonly candidates: readonly ConceptCandidate[];
  readonly conceptContext: readonly BrainConceptContextItem[];
}

export interface BrainFormalizationAnalyzer {
  analyze(
    input: BrainFormalizationAnalysisInput
  ): Promise<BrainFormalizationAnalysis | { error: string }>;
}

// ── Review Actions ─────────────────────────────────────────────────────

export interface BrainFormalizationEdit {
  readonly canonicalStatement?: string;
  readonly quantifiers?: string;
  readonly conclusion?: string;
  readonly latexStatement?: string;
  readonly claimStatements?: Readonly<Record<string, string>>;
  readonly objectDomains?: Readonly<Record<string, string>>;
  readonly explicitAssumptions?: readonly string[];
}

export interface BrainFormalizationLinkage {
  readonly irId: string;
  readonly recordId: string;
  readonly claimId: string;
}

export interface BrainFormalizationEvaluation {
  readonly irId: string;
  readonly sourceLength: number;
  readonly resolvedConceptCount: number;
  readonly ambiguousConceptCount: number;
  readonly unresolvedConceptCount: number;
  readonly explicitAssumptionCount: number;
  readonly addedImplicitAssumptionCount: number;
  readonly semanticDiffCategories: readonly string[];
  readonly edited: boolean;
  readonly rejected: boolean;
  readonly formalizationCreated: boolean;
  readonly leanTypecheckResult:
    | "not_checked"
    | "statement_typechecked"
    | "error";
  readonly leanProofResult: "unverified" | "proof_verified";
}

export type BrainFormalizationPhase =
  | "idle"
  | "analyzing"
  | "proposed"
  | "reviewing"
  | "accepted"
  | "rejected"
  | "error";

export interface BrainFormalizationState {
  readonly phase: BrainFormalizationPhase;
  readonly source: BrainFormalizationSource;
  readonly candidates: readonly ConceptCandidate[];
  readonly candidateContext?: BrainAwareFormalizationContext;
  readonly ir?: PersonalSemanticIR;
  readonly validationFailures: readonly IRValidationFailure[];
  readonly semanticDiff: readonly SemanticDiffEntry[];
  readonly edited: boolean;
  readonly error?: string;
  readonly rejectionReason?: string;
  readonly record?: FormalizationRecord;
  readonly linkage?: BrainFormalizationLinkage;
  readonly evaluation?: BrainFormalizationEvaluation;
}

// ── Workflow ───────────────────────────────────────────────────────────

export interface BrainFormalizationWorkflowOptions {
  readonly source: BrainFormalizationSource;
  readonly conceptIndex: Readonly<ConceptIndex>;
  readonly analyzer: BrainFormalizationAnalyzer;
  readonly claimId?: string;
  readonly now?: () => string;
}

export class BrainFormalizationWorkflow {
  private state: BrainFormalizationState;
  private readonly conceptIndex: Readonly<ConceptIndex>;
  private readonly analyzer: BrainFormalizationAnalyzer;
  private readonly claimId: string;

  constructor(options: BrainFormalizationWorkflowOptions) {
    this.conceptIndex = options.conceptIndex;
    this.analyzer = options.analyzer;
    this.claimId = options.claimId?.trim() || options.source.messageId;
    this.state = {
      phase: "idle",
      source: options.source,
      candidates: [],
      validationFailures: [],
      semanticDiff: [],
      edited: false
    };
  }

  getState(): Readonly<BrainFormalizationState> {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state.phase === "analyzing") {
      return;
    }
    this.setState({
      phase: "analyzing",
      error: undefined,
      rejectionReason: undefined
    });

    try {
      const candidates = discoverConceptCandidates(
        this.state.source.snapshot,
        this.conceptIndex
      );
      const candidateContext = buildCandidateContext(
        candidates,
        this.conceptIndex
      );

      const result = await this.analyzer.analyze({
        sourceText: this.state.source.snapshot,
        candidates,
        conceptContext: candidateContext.conceptContext
      });

      if ("error" in result) {
        this.setState({ phase: "error", error: result.error });
        return;
      }

      const ir = this.buildIR(result);
      this.installProposal(ir, candidates, candidateContext, false);
    } catch (error) {
      this.setState({
        phase: "error",
        error: error instanceof Error
          ? error.message
          : "Formalization analysis failed."
      });
    }
  }

  async selectConcept(bindingId: string, conceptId: string): Promise<void> {
    const ir = this.state.ir;
    if (ir === undefined) {
      return;
    }
    const binding = ir.conceptBindings.find((item) => item.id === bindingId);
    if (
      binding === undefined ||
      binding.status !== "ambiguous" ||
      binding.alternatives === undefined
    ) {
      this.setState({ phase: "error", error: "Binding is not ambiguous." });
      return;
    }

    const alternative = binding.alternatives.find(
      (item) => item.conceptId === conceptId
    );
    if (alternative === undefined) {
      this.setState({
        phase: "error",
        error: "Selected concept is not one of the ambiguous alternatives."
      });
      return;
    }

    const lookup = lookupConceptById(this.conceptIndex, conceptId);
    if (lookup.kind !== "unique_match") {
      this.setState({
        phase: "error",
        error: "Selected concept no longer exists in the Brain."
      });
      return;
    }

    const concept = lookup.match.concept;
    const personalDefinition = concept.userDefinition?.text;
    const standardDefinition = concept.standardDefinitions
      .map((entry) => entry.text)
      .find((text) => text.trim() !== "");
    const nextBindings = ir.conceptBindings.map((item) =>
      item.id === bindingId
        ? {
            ...item,
            status: "resolved" as const,
            conceptId: concept.id,
            conceptRevision: concept.revision,
            resolvedTitle: concept.title,
            resolutionMethod: "stable_id" as const,
            alternatives: undefined,
            proposedNewTitle: undefined,
            personalDefinition,
            standardDefinition,
            definitionConflict:
              personalDefinition !== undefined &&
              standardDefinition !== undefined &&
              personalDefinition.trim() !== standardDefinition.trim()
          }
        : item
    );

    this.installProposal(
      this.rebuildIR(ir, {
        conceptBindings: nextBindings,
        originatingConceptRevisions:
          buildOriginatingConceptRevisions(nextBindings)
      }),
      this.state.candidates,
      this.state.candidateContext,
      true
    );
  }

  async edit(patch: BrainFormalizationEdit): Promise<void> {
    const ir = this.state.ir;
    if (ir === undefined) {
      return;
    }
    const next = this.applyEdit(ir, patch);
    this.installProposal(
      next,
      this.state.candidates,
      this.state.candidateContext,
      true
    );
  }

  async reject(reason?: string): Promise<void> {
    this.setState({
      phase: "rejected",
      rejectionReason: reason?.trim() || undefined,
      edited: this.state.edited,
      record: undefined,
      linkage: undefined
    });
    this.setState({ evaluation: buildBrainFormalizationEvaluation(this.state) });
  }

  async accept(): Promise<
    | { ok: true; record: Readonly<FormalizationRecord>; linkage: BrainFormalizationLinkage }
    | { ok: false; error: string }
  > {
    const ir = this.state.ir;
    if (ir === undefined) {
      return { ok: false, error: "No proposed interpretation to accept." };
    }
    const failures = validatePersonalSemanticIR(ir);
    if (failures.length > 0) {
      return {
        ok: false,
        error: "Interpretation is not valid: " +
          failures.map((failure) => failure.code).join(", ")
      };
    }
    const ambiguous = ir.conceptBindings.filter(
      (binding) => binding.status === "ambiguous"
    );
    if (ambiguous.length > 0) {
      return {
        ok: false,
        error:
          "Resolve every ambiguous concept binding before accepting."
      };
    }

    const adapted = adaptPersonalSemanticIRToFormalization(ir, this.claimId);
    if (!adapted.ok) {
      return { ok: false, error: adapted.error };
    }

    let record: FormalizationRecord;
    try {
      record = createFormalizationRecord(adapted.params);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error
          ? error.message
          : "Unable to create FormalizationRecord."
      };
    }

    const linkage: BrainFormalizationLinkage = {
      irId: ir.id,
      recordId: record.id,
      claimId: this.claimId
    };
    this.setState({
      phase: "accepted",
      record,
      linkage,
      edited: this.state.edited
    });
    this.setState({ evaluation: buildBrainFormalizationEvaluation(this.state) });
    return { ok: true, record, linkage };
  }

  // ── Construction ─────────────────────────────────────────────────────

  private buildIR(analysis: BrainFormalizationAnalysis): PersonalSemanticIR {
    const bindings = this.buildBindings(analysis.conceptBindings);
    const bindingIdByPhrase = new Map(
      bindings.map((binding) => [binding.surfacePhrase, binding.id])
    );
    const conceptIdByPhrase = new Map<string, string>();
    for (const binding of bindings) {
      if (binding.status === "resolved" && binding.conceptId !== undefined) {
        conceptIdByPhrase.set(binding.surfacePhrase, binding.conceptId);
      }
    }

    const objects = analysis.objects.map((object, index) => ({
      id: `obj-${index}`,
      name: object.name,
      latex: object.latex,
      domain: object.domain,
      sourceDomain: object.sourceDomain,
      boundConceptId: object.boundPhrase !== undefined
        ? bindingIdByPhrase.get(object.boundPhrase)
        : undefined
    }));

    const objectIdByName = new Map(
      objects.map((object) => [object.name, object.id])
    );
    const claims = analysis.claims.map((claim, index) => ({
      id: `claim-${index}`,
      kind: claim.kind,
      statement: claim.statement,
      quantifiers: claim.quantifiers,
      sourceQuantifiers: claim.sourceQuantifiers,
      conclusion: claim.conclusion,
      authority: claim.authority ?? "ai_interpreted",
      confidence: claim.confidence,
      semanticChangeKind: claim.semanticChangeKind,
      boundConceptIds: (claim.boundPhrases ?? [])
        .map((phrase) => bindingIdByPhrase.get(phrase))
        .filter((id): id is string => id !== undefined)
    }));

    const assumptions = analysis.assumptions.map((assumption, index) => ({
      id: `asmp-${index}`,
      text: assumption.text,
      kind: assumption.kind,
      addedByAI: assumption.addedByAI
    }));

    const relations = analysis.relations.map((relation, index) => ({
      id: `rel-${index}`,
      fromObjectId: this.requireObjectId(
        objectIdByName,
        relation.fromObjectName,
        "relation.fromObjectName"
      ),
      toObjectId: this.requireObjectId(
        objectIdByName,
        relation.toObjectName,
        "relation.toObjectName"
      ),
      relation: relation.relation,
      note: relation.note
    }));

    const proofSteps = analysis.proofSteps.map((step, index) => ({
      id: `step-${index}`,
      kind: step.kind,
      description: step.description,
      inputClaimIds: (step.inputClaimIndexes ?? []).map((claimIndex) =>
        this.requireClaimId(claims, claimIndex, "inputClaimIndexes")
      ),
      outputClaimIds: (step.outputClaimIndexes ?? []).map((claimIndex) =>
        this.requireClaimId(claims, claimIndex, "outputClaimIndexes")
      ),
      referencedConceptIds: (step.referencedPhrases ?? [])
        .map((phrase) => conceptIdByPhrase.get(phrase))
        .filter((id): id is string => id !== undefined),
      assumptionIds: (step.assumptionIndexes ?? []).map((assumptionIndex) =>
        this.requireAssumptionId(
          assumptions,
          assumptionIndex,
          "assumptionIndexes"
        )
      ),
      unresolvedAssumptionIds: (step.unresolvedAssumptionIndexes ?? [])
        .map((assumptionIndex) =>
          this.requireAssumptionId(
            assumptions,
            assumptionIndex,
            "unresolvedAssumptionIndexes"
          )
        ),
      authority: step.authority ?? "ai_interpreted",
      dependencies: (step.dependencies ?? []).map((dependency) =>
        this.requireStepId(analysis.proofSteps, dependency, "dependencies")
      )
    }));

    const unresolvedItems = [];
    for (const binding of bindings) {
      if (binding.status === "unresolved" || binding.status === "proposed_new") {
        unresolvedItems.push({
          id: `unresolved-${unresolvedItems.length}`,
          kind: "concept" as const,
          description: binding.surfacePhrase,
          relatedIds: [binding.id]
        });
      }
    }
    for (let i = 0; i < analysis.ambiguities.length; i++) {
      unresolvedItems.push({
        id: `unresolved-${unresolvedItems.length}`,
        kind: "ambiguity" as const,
        description: analysis.ambiguities[i]!,
        relatedIds: []
      });
    }

    const semanticChanges = analysis.semanticChanges.map((change) => ({
      category: change.category,
      description: change.description,
      before: change.before,
      after: change.after,
      relatedAssumptionIds: (change.relatedAssumptionIndexes ?? []).map(
        (assumptionIndex) =>
          this.requireAssumptionId(
            assumptions,
            assumptionIndex,
            "relatedAssumptionIndexes"
          )
      )
    }));

    return createPersonalSemanticIR({
      id: undefined,
      source: {
        messageId: this.state.source.messageId,
        startOffset: this.state.source.startOffset,
        endOffset: this.state.source.endOffset,
        snapshot: this.state.source.snapshot
      },
      originalExpression: this.state.source.snapshot,
      speechAct: analysis.speechAct,
      authority: "ai_interpreted",
      canonicalStatement: analysis.canonicalStatement,
      quantifiers: analysis.quantifiers,
      conclusion: analysis.conclusion,
      latexStatement: analysis.latexStatement,
      conceptBindings: bindings,
      objects,
      claims,
      assumptions,
      relations,
      proofSteps,
      unresolvedItems,
      ambiguities: analysis.ambiguities,
      resolvedAmbiguities: analysis.resolvedAmbiguities,
      missingConditions: analysis.missingConditions,
      removedAssumptions: analysis.removedAssumptions,
      semanticChanges,
      originatingConceptRevisions: buildOriginatingConceptRevisions(bindings)
    });
  }

  private buildBindings(
    proposals: readonly ProposedConceptBinding[]
  ): ConceptBinding[] {
    return proposals.map((proposal) =>
      resolveConceptBinding(
        {
          phrase: proposal.surfacePhrase,
          stableId: proposal.stableId,
          proposedNewTitle: proposal.proposedNewTitle
        },
        this.conceptIndex
      )
    );
  }

  private requireObjectId(
    objectIdByName: ReadonlyMap<string, string>,
    name: string,
    field: string
  ): string {
    const id = objectIdByName.get(name);
    if (id === undefined) {
      throw new Error(`${field} references unknown object "${name}".`);
    }
    return id;
  }

  private requireClaimId(
    claims: readonly { id: string }[],
    index: number,
    field: string
  ): string {
    const claim = claims[index];
    if (claim === undefined) {
      throw new Error(`${field} index ${index} is out of range.`);
    }
    return claim.id;
  }

  private requireAssumptionId(
    assumptions: readonly { id: string }[],
    index: number,
    field: string
  ): string {
    const assumption = assumptions[index];
    if (assumption === undefined) {
      throw new Error(`${field} index ${index} is out of range.`);
    }
    return assumption.id;
  }

  private requireStepId(
    steps: readonly ProposedProofStep[],
    index: number,
    field: string
  ): string {
    if (!Number.isInteger(index) || index < 0 || index >= steps.length) {
      throw new Error(`${field} index ${index} is out of range.`);
    }
    return `step-${index}`;
  }

  private installProposal(
    ir: PersonalSemanticIR,
    candidates: readonly ConceptCandidate[],
    candidateContext: BrainAwareFormalizationContext | undefined,
    edited: boolean
  ): void {
    const failures = validatePersonalSemanticIR(ir);
    this.setState({
      phase: failures.length > 0 ? "error" : "proposed",
      candidates,
      candidateContext,
      ir,
      validationFailures: failures,
      semanticDiff: computeSemanticDiff(ir),
      edited: edited || this.state.edited,
      error: failures.length > 0
        ? "Validation failed: " +
          failures.map((failure) => failure.code).join(", ")
        : undefined
    });
  }

  private rebuildIR(
    previous: PersonalSemanticIR,
    patch: Partial<{
      conceptBindings: readonly ConceptBinding[];
      originatingConceptRevisions: PersonalSemanticIR["originatingConceptRevisions"];
      canonicalStatement: string;
      quantifiers: string;
      conclusion: string;
      latexStatement?: string;
      claims: PersonalSemanticIR["claims"];
      objects: PersonalSemanticIR["objects"];
      assumptions: PersonalSemanticIR["assumptions"];
      missingConditions: PersonalSemanticIR["missingConditions"];
    }>
  ): PersonalSemanticIR {
    return createPersonalSemanticIR({
      id: previous.id,
      source: previous.source,
      originalExpression: previous.originalExpression,
      speechAct: previous.speechAct,
      authority: previous.authority,
      confidence: previous.confidence,
      canonicalStatement: patch.canonicalStatement ?? previous.canonicalStatement,
      quantifiers: patch.quantifiers ?? previous.quantifiers,
      conclusion: patch.conclusion ?? previous.conclusion,
      latexStatement: patch.latexStatement ?? previous.latexStatement,
      conceptBindings: patch.conceptBindings ?? previous.conceptBindings,
      objects: patch.objects ?? previous.objects,
      claims: patch.claims ?? previous.claims,
      assumptions: patch.assumptions ?? previous.assumptions,
      relations: previous.relations,
      proofSteps: previous.proofSteps,
      unresolvedItems: previous.unresolvedItems,
      ambiguities: previous.ambiguities,
      resolvedAmbiguities: previous.resolvedAmbiguities,
      missingConditions: patch.missingConditions ?? previous.missingConditions,
      removedAssumptions: previous.removedAssumptions,
      semanticChanges: previous.semanticChanges,
      originatingConceptRevisions:
        patch.originatingConceptRevisions ?? previous.originatingConceptRevisions
    });
  }

  private applyEdit(
    ir: PersonalSemanticIR,
    patch: BrainFormalizationEdit
  ): PersonalSemanticIR {
    const claims = patch.claimStatements === undefined
      ? ir.claims
      : ir.claims.map((claim) =>
          patch.claimStatements![claim.id] !== undefined
            ? { ...claim, statement: patch.claimStatements![claim.id]! }
            : claim
        );

    const objects = patch.objectDomains === undefined
      ? ir.objects
      : ir.objects.map((object) =>
          patch.objectDomains![object.id] !== undefined
            ? { ...object, domain: patch.objectDomains![object.id] }
            : object
        );

    const assumptions = patch.explicitAssumptions === undefined
      ? ir.assumptions
      : [
          ...patch.explicitAssumptions.map((text, index) => ({
            id: `asmp-user-${index}`,
            text,
            kind: "explicit" as const,
            addedByAI: false
          })),
          ...ir.assumptions.filter((assumption) => assumption.kind !== "explicit")
        ];

    return this.rebuildIR(ir, {
      canonicalStatement: patch.canonicalStatement,
      quantifiers: patch.quantifiers,
      conclusion: patch.conclusion,
      latexStatement: patch.latexStatement,
      claims,
      objects,
      assumptions
    });
  }

  private setState(next: Partial<BrainFormalizationState>): void {
    this.state = { ...this.state, ...next };
  }
}

// ── Local Evaluation Record ────────────────────────────────────────────

export function buildBrainFormalizationEvaluation(
  state: Readonly<BrainFormalizationState>
): BrainFormalizationEvaluation {
  const ir = state.ir;
  const bindings = ir?.conceptBindings ?? [];
  const assumptions = ir?.assumptions ?? [];
  return {
    irId: ir?.id ?? "",
    sourceLength: state.source.snapshot.length,
    resolvedConceptCount: bindings.filter(
      (binding) => binding.status === "resolved"
    ).length,
    ambiguousConceptCount: bindings.filter(
      (binding) => binding.status === "ambiguous"
    ).length,
    unresolvedConceptCount: bindings.filter(
      (binding) =>
        binding.status === "unresolved" || binding.status === "proposed_new"
    ).length,
    explicitAssumptionCount: assumptions.filter(
      (assumption) => assumption.kind !== "implicit"
    ).length,
    addedImplicitAssumptionCount: assumptions.filter(
      (assumption) => assumption.kind === "implicit" && assumption.addedByAI
    ).length,
    semanticDiffCategories: state.semanticDiff.map((entry) => entry.kind),
    edited: state.edited,
    rejected: state.phase === "rejected",
    formalizationCreated: state.record !== undefined,
    leanTypecheckResult: "not_checked",
    leanProofResult: "unverified"
  };
}
