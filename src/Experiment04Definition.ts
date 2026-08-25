// Frozen, synthetic Experiment 04 definition. This module has no provider code.

export const EXPERIMENT_04_ID = "experiment04-semantic-fidelity-v1";
export const EXPERIMENT_04_SEED = 240417;
export const EXPERIMENT_04_REPETITIONS = 3;
export const EXPERIMENT_04_PROVIDER = { provider: "DeepSeek", model: "deepseek-v4-flash" } as const;

export const EXPERIMENT_04_CONDITIONS = [
  "plain_llm",
  "irrelevant_context",
  "brain_identity_only",
  "brain_definition",
  "brain_definition_plus_relations"
] as const;
export type Experiment04ConditionId = (typeof EXPERIMENT_04_CONDITIONS)[number];

export type BindingRequirement = "required" | "optional";
export interface Experiment04Concept {
  readonly stableConceptId: string;
  readonly aliases: readonly string[];
  readonly category: string;
  readonly personalDefinition: string;
  readonly publicMeaning?: string;
  readonly relations: readonly string[];
}
export interface ExpectedBinding {
  readonly expectedConceptId: string;
  readonly acceptedSurfaceForms: readonly string[];
  readonly requirement: BindingRequirement;
  readonly expectedAmbiguitySet?: readonly string[];
}
export interface Experiment04Fixture {
  readonly fixtureId: string;
  readonly category: string;
  readonly sourceText: string;
  readonly researchRationale: string;
  readonly expectedPersonalConcepts: readonly Experiment04Concept[];
  readonly irrelevantConcept: Experiment04Concept;
  readonly expectedBindings: readonly ExpectedBinding[];
  readonly sourceStatedFacts: readonly string[];
  readonly permittedBackgroundFacts: readonly string[];
  readonly allowedSemanticCommitments: readonly string[];
  readonly forbiddenSemanticCommitments: readonly string[];
  readonly expectedSpeechAct: string;
  readonly expectedQuantifier?: string;
  readonly expectedRelations: readonly string[];
  readonly treatmentSufficiency: {
    readonly intendedTargetPresentInRelevantContext: boolean;
    readonly expectedAbilityToGround: "none" | "optional" | "required" | "preserve_ambiguity";
    readonly ambiguityMustRemain: boolean;
  };
}

export const EXPERIMENT_04_RESPONSE_SCHEMA = {
  type: "object",
  required: ["conceptBindings", "semanticCommitments", "sourceStatedConditions", "treatmentContextConditions", "missingConditions", "assumedConditions", "ambiguities", "quantifier", "relations", "speechAct"],
  conceptBinding: { surfacePhrase: "string", conceptId: "string|null", status: "resolved|ambiguous|unresolved|proposed_new" },
  channels: "arrays of canonical semantic fact labels or short source-grounded statements"
} as const;

export const EXPERIMENT_04_TREATMENT_MANIFEST = {
  plain_llm: "source and common prompt only",
  irrelevant_context: "one non-target semantic reference with identity, definition, and relation fields",
  brain_identity_only: "target concept IDs, aliases, and categories only",
  brain_definition: "identity payload plus bounded personal definitions",
  brain_definition_plus_relations: "definition payload plus fixture-relevant bounded relations"
} as const;

export const EXPERIMENT_04_COMMON_TASK_PROMPT = [
  "Analyze the source while preserving the user's intended semantics.",
  "Use a supplied concept ID only when the source truly refers to its alias or handle.",
  "Do not invent missing personal identities; unresolved concepts may remain unresolved.",
  "Preserve genuine ambiguity instead of forcing a resolution.",
  "Keep missing information distinct from assumptions, and do not add commitments unsupported by the source or reference material.",
  "Return strict JSON with this schema:",
  JSON.stringify(EXPERIMENT_04_RESPONSE_SCHEMA)
].join("\n");

const irrelevant = (): Experiment04Concept => ({
  stableConceptId: "synthetic://background/evening-ledger@1",
  aliases: ["lattice", "evening ledger"],
  category: "personal_note",
  personalDefinition: "A private weekly record of small practical observations.",
  relations: ["evening ledger is maintained alongside a calendar"]
});
const concept = (id: string, aliases: string[], definition: string, relations: string[], category = "personal_concept"): Experiment04Concept => ({
  stableConceptId: `synthetic://personal/${id}@1`, aliases, category, personalDefinition: definition, relations
});
const fixture = (input: Omit<Experiment04Fixture, "irrelevantConcept">): Experiment04Fixture => ({
  ...input, irrelevantConcept: irrelevant()
});

export const EXPERIMENT_04_FIXTURES: readonly Experiment04Fixture[] = [
  fixture({ fixtureId: "harbor-private-meaning", category: "private_meaning", sourceText: "I need to return to the harbor before I decide what to keep.", researchRationale: "Harbor has a private planning meaning unlike its public geographic meaning.", expectedPersonalConcepts: [concept("harbor@1", ["harbor", "the harbor"], "A deliberate pause used to review commitments before removing or keeping them.", ["harbor precedes the keep-or-remove review"])], expectedBindings: [{ expectedConceptId: "synthetic://personal/harbor@1@1", acceptedSurfaceForms: ["harbor", "the harbor"], requirement: "required" }], sourceStatedFacts: ["RETURN_TO_HARBOR_BEFORE_DECISION"], permittedBackgroundFacts: [], allowedSemanticCommitments: ["RETURN_TO_HARBOR_BEFORE_DECISION", "HARBOR_IS_REVIEW_PAUSE"], forbiddenSemanticCommitments: ["HARBOR_IS_SEAPORT"], expectedSpeechAct: "intention", expectedRelations: ["temporal_precedence"], treatmentSufficiency: { intendedTargetPresentInRelevantContext: true, expectedAbilityToGround: "required", ambiguityMustRemain: false } }),
  fixture({ fixtureId: "lantern-private-meaning", category: "private_meaning", sourceText: "The lantern is still lit, so I will not close the project yet.", researchRationale: "Lantern is a private project-status handle rather than a physical object.", expectedPersonalConcepts: [concept("lantern@2", ["lantern", "the lantern"], "An enduring project that remains open while it can still organize useful work.", ["lantern keeps the associated project open"])], expectedBindings: [{ expectedConceptId: "synthetic://personal/lantern@2@1", acceptedSurfaceForms: ["lantern", "the lantern"], requirement: "required" }], sourceStatedFacts: ["LIT_LANTERN_BLOCKS_PROJECT_CLOSURE"], permittedBackgroundFacts: [], allowedSemanticCommitments: ["LIT_LANTERN_BLOCKS_PROJECT_CLOSURE", "LANTERN_IS_ENDURING_PROJECT"], forbiddenSemanticCommitments: ["LANTERN_IS_PHYSICAL_LIGHT"], expectedSpeechAct: "assertion", expectedRelations: ["blocks"], treatmentSufficiency: { intendedTargetPresentInRelevantContext: true, expectedAbilityToGround: "required", ambiguityMustRemain: false } }),
  fixture({ fixtureId: "compass-private-meaning", category: "private_meaning", sourceText: "Use the compass when the discussion starts collecting too many possible directions.", researchRationale: "Compass has a private deliberation meaning unlike a navigational instrument.", expectedPersonalConcepts: [concept("compass@2", ["compass", "the compass"], "A short written criterion that narrows a discussion to the next reversible step.", ["compass narrows a decision to one reversible step"])], expectedBindings: [{ expectedConceptId: "synthetic://personal/compass@2@1", acceptedSurfaceForms: ["compass", "the compass"], requirement: "required" }], sourceStatedFacts: ["COMPASS_USED_FOR_DIRECTION_OVERLOAD"], permittedBackgroundFacts: [], allowedSemanticCommitments: ["COMPASS_USED_FOR_DIRECTION_OVERLOAD", "COMPASS_IS_REVERSIBLE_STEP_CRITERION"], forbiddenSemanticCommitments: ["COMPASS_IS_NAVIGATION_TOOL"], expectedSpeechAct: "instruction", expectedRelations: ["narrows"], treatmentSufficiency: { intendedTargetPresentInRelevantContext: true, expectedAbilityToGround: "required", ambiguityMustRemain: false } }),
  fixture({ fixtureId: "field-overload", category: "overloaded_public_term", sourceText: "This field is ready to split once its examples no longer answer the same question.", researchRationale: "Field is a private inquiry cluster, not an agricultural or mathematical field.", expectedPersonalConcepts: [concept("field@1", ["field", "this field"], "A bounded cluster of questions, examples, and working distinctions maintained together.", ["field may split into two inquiry clusters"])], expectedBindings: [{ expectedConceptId: "synthetic://personal/field@1@1", acceptedSurfaceForms: ["field", "this field"], requirement: "required" }], sourceStatedFacts: ["FIELD_SPLITS_WHEN_EXAMPLES_DIVERGE"], permittedBackgroundFacts: [], allowedSemanticCommitments: ["FIELD_SPLITS_WHEN_EXAMPLES_DIVERGE", "FIELD_IS_INQUIRY_CLUSTER"], forbiddenSemanticCommitments: ["FIELD_IS_ALGEBRAIC_STRUCTURE", "FIELD_IS_LAND"], expectedSpeechAct: "assertion", expectedRelations: ["may_split"], treatmentSufficiency: { intendedTargetPresentInRelevantContext: true, expectedAbilityToGround: "required", ambiguityMustRemain: false } }),
  fixture({ fixtureId: "proof-overload", category: "overloaded_public_term", sourceText: "Keep the proof beside the claim until someone can retrace each step.", researchRationale: "Proof is a reviewed derivation artifact, not generic evidence or a beverage.", expectedPersonalConcepts: [concept("proof@1", ["proof", "the proof"], "A checkable chain of stated steps attached to a claim and available for review.", ["proof supports a claim", "proof can be retraced step by step"])], expectedBindings: [{ expectedConceptId: "synthetic://personal/proof@1@1", acceptedSurfaceForms: ["proof", "the proof"], requirement: "required" }], sourceStatedFacts: ["PROOF_REMAINS_WITH_CLAIM_FOR_RETRACE"], permittedBackgroundFacts: [], allowedSemanticCommitments: ["PROOF_REMAINS_WITH_CLAIM_FOR_RETRACE", "PROOF_IS_CHECKABLE_DERIVATION"], forbiddenSemanticCommitments: ["PROOF_IS_GENERIC_EVIDENCE"], expectedSpeechAct: "instruction", expectedRelations: ["supports"], treatmentSufficiency: { intendedTargetPresentInRelevantContext: true, expectedAbilityToGround: "required", ambiguityMustRemain: false } }),
  fixture({ fixtureId: "bridge-ambiguity", category: "genuine_ambiguity", sourceText: "The bridge is not ready; both readings still fit the note.", researchRationale: "Two legitimate personal concepts share the handle bridge and must remain ambiguous.", expectedPersonalConcepts: [concept("bridge-dialogue@1", ["bridge", "the bridge"], "A note that translates between two collaborators' vocabularies.", ["bridge-dialogue connects two vocabularies"]), concept("bridge-transition@1", ["bridge", "the bridge"], "A provisional step linking an earlier definition to its revised form.", ["bridge-transition links two revisions"])], expectedBindings: [{ expectedConceptId: "synthetic://personal/bridge-dialogue@1@1", acceptedSurfaceForms: ["bridge", "the bridge"], requirement: "required", expectedAmbiguitySet: ["synthetic://personal/bridge-dialogue@1@1", "synthetic://personal/bridge-transition@1@1"] }], sourceStatedFacts: ["BRIDGE_REMAINS_AMBIGUOUS"], permittedBackgroundFacts: [], allowedSemanticCommitments: ["BRIDGE_REMAINS_AMBIGUOUS"], forbiddenSemanticCommitments: ["BRIDGE_RESOLVED_TO_SINGLE_CONCEPT"], expectedSpeechAct: "assertion", expectedRelations: [], treatmentSufficiency: { intendedTargetPresentInRelevantContext: true, expectedAbilityToGround: "preserve_ambiguity", ambiguityMustRemain: true } }),
  fixture({ fixtureId: "normal-operator-missing-assumption", category: "missing_condition", sourceText: "Every normal operator has an eigenbasis.", researchRationale: "The source omits a necessary scope qualification; semantic context should not license invention.", expectedPersonalConcepts: [concept("normal-operator@1", ["normal operator", "normal operators"], "An operator treated under the project's standard Hilbert-space vocabulary.", ["normal operator may require a finite-dimensionality qualification for an eigenbasis claim"], "mathematical_term")], expectedBindings: [{ expectedConceptId: "synthetic://personal/normal-operator@1@1", acceptedSurfaceForms: ["normal operator", "normal operators"], requirement: "optional" }], sourceStatedFacts: ["EIGENBASIS_CLAIM_STATED"], permittedBackgroundFacts: ["FINITE_DIMENSIONALITY_MAY_BE_MISSING"], allowedSemanticCommitments: ["EIGENBASIS_CLAIM_STATED", "FINITE_DIMENSIONALITY_MAY_BE_MISSING"], forbiddenSemanticCommitments: ["EIGENBASIS_CLAIM_UNCONDITIONALLY_ESTABLISHED"], expectedSpeechAct: "theorem_claim", expectedQuantifier: "universal", expectedRelations: [], treatmentSufficiency: { intendedTargetPresentInRelevantContext: true, expectedAbilityToGround: "optional", ambiguityMustRemain: false } }),
  fixture({ fixtureId: "modus-ponens-precision", category: "no_brain_advantage", sourceText: "If P implies Q, and P holds, then Q holds.", researchRationale: "A precise logical statement should offer little semantic-context advantage.", expectedPersonalConcepts: [concept("modus-ponens@1", ["P implies Q", "P", "Q"], "A local inference pattern whose conclusion follows from an implication and its antecedent.", ["modus ponens derives Q from P and P implies Q"], "logical_pattern")], expectedBindings: [], sourceStatedFacts: ["MODUS_PONENS"], permittedBackgroundFacts: [], allowedSemanticCommitments: ["MODUS_PONENS"], forbiddenSemanticCommitments: ["IMPLICATION_IS_EQUIVALENCE"], expectedSpeechAct: "theorem_claim", expectedQuantifier: "conditional", expectedRelations: ["implication"], treatmentSufficiency: { intendedTargetPresentInRelevantContext: false, expectedAbilityToGround: "none", ambiguityMustRemain: false } }),
  fixture({ fixtureId: "delta-control", category: "irrelevant_context_sensitive_control", sourceText: "Mark the delta before comparing the two versions.", researchRationale: "Delta has a personal revision meaning while irrelevant material should not reproduce relevant-context grounding.", expectedPersonalConcepts: [concept("delta@1", ["delta", "the delta"], "A reviewed record of the semantic difference between two versions of one concept.", ["delta compares two concept revisions"])], expectedBindings: [{ expectedConceptId: "synthetic://personal/delta@1@1", acceptedSurfaceForms: ["delta", "the delta"], requirement: "required" }], sourceStatedFacts: ["DELTA_PRECEDES_VERSION_COMPARISON"], permittedBackgroundFacts: [], allowedSemanticCommitments: ["DELTA_PRECEDES_VERSION_COMPARISON", "DELTA_IS_SEMANTIC_DIFFERENCE_RECORD"], forbiddenSemanticCommitments: ["DELTA_IS_NUMERICAL_SUBTRACTION"], expectedSpeechAct: "instruction", expectedRelations: ["precedes"], treatmentSufficiency: { intendedTargetPresentInRelevantContext: true, expectedAbilityToGround: "required", ambiguityMustRemain: false } }),
  fixture({ fixtureId: "boundary-definition", category: "definition_vs_theorem", sourceText: "By boundary I mean the last distinction that must remain explicit before we combine two ideas.", researchRationale: "A definitional speech act must not be promoted into a theorem.", expectedPersonalConcepts: [concept("boundary@1", ["boundary", "the boundary"], "The final explicit distinction preserved before combining two concepts.", ["boundary constrains concept combination"])], expectedBindings: [{ expectedConceptId: "synthetic://personal/boundary@1@1", acceptedSurfaceForms: ["boundary", "the boundary"], requirement: "required" }], sourceStatedFacts: ["BOUNDARY_DEFINED_AS_LAST_EXPLICIT_DISTINCTION"], permittedBackgroundFacts: [], allowedSemanticCommitments: ["BOUNDARY_DEFINED_AS_LAST_EXPLICIT_DISTINCTION", "BOUNDARY_CONSTRAINS_COMBINATION"], forbiddenSemanticCommitments: ["BOUNDARY_THEOREM_ESTABLISHED"], expectedSpeechAct: "definition", expectedRelations: ["constrains"], treatmentSufficiency: { intendedTargetPresentInRelevantContext: true, expectedAbilityToGround: "required", ambiguityMustRemain: false } }),
  fixture({ fixtureId: "spectral-proof-sketch", category: "proof_sketch", sourceText: "Since the spectral theorem applies here, the next step is to diagonalize T.", researchRationale: "A reasoning sketch should retain its provisional speech act.", expectedPersonalConcepts: [concept("spectral-step@1", ["spectral theorem", "diagonalize T"], "A named theorem invocation recorded as a proposed proof step until its hypotheses are checked.", ["spectral-step proposes diagonalization", "spectral-step requires hypothesis check"], "proof_step")], expectedBindings: [{ expectedConceptId: "synthetic://personal/spectral-step@1@1", acceptedSurfaceForms: ["spectral theorem", "diagonalize T"], requirement: "optional" }], sourceStatedFacts: ["SPECTRAL_STEP_PROPOSED"], permittedBackgroundFacts: ["HYPOTHESES_NOT_YET_CHECKED"], allowedSemanticCommitments: ["SPECTRAL_STEP_PROPOSED", "HYPOTHESES_NOT_YET_CHECKED"], forbiddenSemanticCommitments: ["T_ALREADY_DIAGONALIZED"], expectedSpeechAct: "proof_sketch", expectedRelations: ["proposes"], treatmentSufficiency: { intendedTargetPresentInRelevantContext: true, expectedAbilityToGround: "optional", ambiguityMustRemain: false } }),
  fixture({ fixtureId: "compass-revision", category: "stale_revision", sourceText: "The compass now asks for the next reversible step, not the most elegant destination.", researchRationale: "Current revision must be used rather than an obsolete aspirational meaning.", expectedPersonalConcepts: [concept("compass-current@2", ["compass", "the compass"], "Revision 2: a short criterion selecting the next reversible step in a discussion.", ["compass-current supersedes compass-prior", "compass-current selects reversible steps"])], expectedBindings: [{ expectedConceptId: "synthetic://personal/compass-current@2@1", acceptedSurfaceForms: ["compass", "the compass"], requirement: "required" }], sourceStatedFacts: ["COMPASS_SELECTS_REVERSIBLE_STEP"], permittedBackgroundFacts: [], allowedSemanticCommitments: ["COMPASS_SELECTS_REVERSIBLE_STEP", "COMPASS_CURRENT_REVISION"], forbiddenSemanticCommitments: ["COMPASS_IS_ELEGANT_DESTINATION_CRITERION", "COMPASS_PRIOR_REVISION_CURRENT"], expectedSpeechAct: "definition", expectedRelations: ["supersedes"], treatmentSufficiency: { intendedTargetPresentInRelevantContext: true, expectedAbilityToGround: "required", ambiguityMustRemain: false } })
];

export interface Experiment04TrialPlan { readonly trialId: string; readonly fixtureId: string; readonly condition: Experiment04ConditionId; readonly runIndex: number; readonly orderIndex: number; }
export function planExperiment04Trials(): readonly Experiment04TrialPlan[] {
  const plans: Experiment04TrialPlan[] = []; let orderIndex = 0;
  for (let fixtureIndex = 0; fixtureIndex < EXPERIMENT_04_FIXTURES.length; fixtureIndex++) for (let runIndex = 1; runIndex <= EXPERIMENT_04_REPETITIONS; runIndex++) for (let offset = 0; offset < EXPERIMENT_04_CONDITIONS.length; offset++) {
    const condition = EXPERIMENT_04_CONDITIONS[(offset + fixtureIndex + runIndex + EXPERIMENT_04_SEED) % EXPERIMENT_04_CONDITIONS.length]!;
    const fixture = EXPERIMENT_04_FIXTURES[fixtureIndex]!;
    plans.push({ trialId: `${EXPERIMENT_04_ID}:${fixture.fixtureId}:${condition}:${runIndex}`, fixtureId: fixture.fixtureId, condition, runIndex, orderIndex: orderIndex++ });
  }
  return plans;
}

export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") { const object = value as Record<string, unknown>; return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(",")}}`; }
  return JSON.stringify(value);
}
