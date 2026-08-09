import type { App, TFile } from "obsidian";
import {
  validateVisionImage,
  VisionProviderRouter
} from "./OpenAIVisionClient";
import type {
  VisionImageFile,
  VisionProviderClient
} from "./OpenAIVisionClient";
import { canAnalyzeImages } from "./ProviderProfiles";
import type { ProviderProfile } from "./ProviderProfiles";
import {
  askDeepSeek,
  classifyCandidateClaims,
  discussCandidateSelection,
  generateCandidateNote,
  generateSelectionReplacement,
  identifyCandidateTopics,
  repairLatexFormatting
} from "./DeepSeekClient";
import type {
  CandidateSourceMessage,
  CandidateTopicSelection,
  DeepSeekConversationMessage,
  DeepSeekNoteContext,
  SelectionEditRequestContext
} from "./DeepSeekClient";
import {
  buildCandidateNoteMarkdown,
  findConceptEvidence,
  haveSameCandidateConcept,
  normalizeCandidatePrimaryConcept,
  normalizeCandidateTitle
} from "./CandidateNoteRelations";
import type {
  CandidatePrimaryConcept,
  VerifiedCandidateRelation
} from "./CandidateNoteRelations";
import {
  appendLatexFormatWarning,
  reviewLatexFormatting
} from "./LatexFormatReview";
import {
  isSafeWikiLinkTarget,
  suggestCandidateFileName,
  validateCandidateNotePath,
  validateExistingVaultMarkdownPath
} from "./CandidateNoteVault";
import {
  addCandidateParentLink,
  addCandidateChildLink,
  buildCandidateGroupParentMarkdown,
  deriveConciseCandidateGroupTitle,
  extractCandidateParentHint,
  getMarkdownLinkTarget,
  getVaultPathLinkTarget,
  isValidCandidateGroupTitle,
  removeCandidateChildLink,
  setCandidateParentLink,
  stripCandidateParentLinks
} from "./CandidateGroupVault";
import {
  createVaultParentGroupId,
  discoverCandidateParents
} from "./CandidateParentDiscovery";
import {
  DEFAULT_BRAIN_DISPLAY_NAME,
  DEFAULT_USER_DISPLAY_NAME,
  getPersonalizedWorkspaceTitle,
  resolveDisplayName
} from "./PersonalNaming";
import type { PersonalNamingSettings } from "./PersonalNaming";
import {
  hasSafelyLocatedKnowledgeStatus,
  normalizeReviewedClaim,
  removeManagedKnowledgeStatusBlock,
  updateKnowledgeStatusMarkdown
} from "./ClaimClassification";
import type {
  ClaimKind,
  ClaimRecord,
  ClaimReviewItem,
  ClaimSuggestion
} from "./ClaimClassification";
import {
  createFormalizationRecord,
  applyFormalizationReview as applyFormalizationReviewUpdate,
  validateFormalizationInvariants,
  buildAllFormalizationSummaries,
  serializeFormalizationIndex,
  deserializeFormalizationIndex,
  canSetPrimaryFormalization,
  shouldClearPrimaryOnRejection,
  checkLeanEligibility,
  validateLeanCode,
  LEAN_ARTIFACT_SCHEMA_VERSION,
  buildLeanCode,
  selectLeanImportsForFormalization,
  validateLeanBodyNoImports
} from "./FormalizationProtocol";
import type {
  FormalizationRecord,
  FormalizationIndex,
  ReviewStatus,
  SourceRef,
  LeanArtifact,
  LeanArtifactIndex,
  LeanRunner,
  LeanEligibilityResult,
  LeanDiagnostic
} from "./FormalizationProtocol";
import {
  classifyMathSpeechAct,
  generateLeanStatement
} from "./DeepSeekClient";
import type {
  LeanGenerationResult
} from "./DeepSeekClient";

export interface LainBrainImageAttachmentMetadata {
  filename: string;
  mimeType: string;
  byteSize: number;
  providerId: string;
  providerDisplayName: string;
}

export interface LainBrainTranscriptMessage {
  role: "user" | "assistant";
  content: string;
  providerId?: string;
  providerDisplayName?: string;
  attachment?: LainBrainImageAttachmentMetadata;
}

export interface PendingVisionImage {
  file: VisionImageFile;
  filename: string;
  mimeType: string;
  byteSize: number;
}

interface StoredMessage extends LainBrainTranscriptMessage {
  id: string;
  includeInHistory: boolean;
}

export interface CandidateNote {
  id: string;
  title: string;
  primaryConcept: CandidatePrimaryConcept;
  markdown: string;
  sourceMessageIds: string[];
  viewMode: LainBrainCandidateViewMode;
  userEdited: boolean;
  revision: number;
  createdVaultPath?: string;
  createdRevision?: number;
  groupId?: string;
  parentGroupId?: string;
  parentVaultPath?: string;
  claims: ClaimRecord[];
  claimStatusWarning?: string;
  formalizationIds: string[];
  primaryFormalizationId?: string;
}

export interface CandidateGroup {
  id: string;
  title: string;
  sourceMessageIds: string[];
  candidateIds: string[];
  revision: number;
  createdVaultPath?: string;
  createdRevision?: number;
  parentVaultPath?: string;
  parentDisplayTitle?: string;
}

export interface CandidateParentSelection {
  groupId: string;
  parentVaultPath: string;
}

export type CandidateNoteCreateResult =
  | { ok: true; path: string }
  | {
      ok: false;
      error:
        | "Invalid file name"
        | "Invalid destination folder"
        | "File already exists"
        | "Candidate is empty"
        | "Candidate no longer exists"
        | "Pending replacement must be resolved first"
        | "Note already created"
        | "Suggested parent is unavailable. Choose a parent before creating this note."
        | "Vault write failed";
    };

export type CandidateGroupCreateResult =
  | { ok: true; parentPath: string; childPaths: string[] }
  | {
      ok: false;
      error:
        | "Candidate group no longer exists"
        | "Invalid parent title"
        | "Invalid file name"
        | "Invalid destination folder"
        | "File already exists"
        | "Candidate is empty"
        | "Pending replacement must be resolved first"
        | "Group already created"
        | "A group cannot be created while some child notes already exist individually."
        | "Vault write failed";
    };

export type CandidateNoteTrashResult =
  | { ok: true; message: string; warning?: string }
  | {
      ok: false;
      error:
        | "Candidate note no longer exists"
        | "Invalid note path"
        | "Note not found"
        | "Unable to move note to Trash";
    };

export interface SelectionEditContext {
  candidateId: string;
  startOffset: number;
  endOffset: number;
  originalText: string;
  candidateRevision: number;
  beforeContext: string;
  afterContext: string;
  discussionMessages: LainBrainTranscriptMessage[];
  draft: string;
  pendingReplacement?: string;
  replacementError?: string;
}

interface PendingCandidateExtraction {
  historyKey: string;
  topics: CandidateTopicSelection[];
}

export type CandidateGenerationResult =
  "success" | "needs-confirmation" | "failed";
export type ClaimReviewResult =
  | { ok: true; items: ClaimReviewItem[] }
  | { ok: false; error: string };

export type ClaimApplyResult =
  | {
      ok: true;
      appliedCount: number;
      warning?: string;
    }
  | { ok: false; error: string; offendingClaimId?: string };

type SessionListener = () => void;
export type LainBrainLoadingMode = "chat" | null;
export type LainBrainLargeViewMode = "chat" | "candidate";
export type LainBrainCandidateViewMode = "edit" | "preview";
export type LainBrainSendResult =
  "sent" | "blocked" | "needs-vision-confirmation";

/**
 * Ephemeral formalization preview for an un-applied suggestion.
 *
 * Stored in a session-only Map — NEVER written to formalizationIndex
 * or persisted to plugin data.  On Apply the preview is materialized
 * into a proper FormalizationRecord and committed to the index.
 */
export interface SuggestionFormalizationPreview {
  /** The formalization content (same shape as FormalizationRecord). */
  readonly record: FormalizationRecord;
  /** The suggestion ID this preview belongs to. */
  readonly suggestionId: string;
  /** Snapshot of claim text at formalization time (staleness detection). */
  readonly sourceText: string;
  /** Snapshot of claim kind at formalization time. */
  readonly sourceKind: ClaimKind;
}

export class LainBrainSession {
  private readonly messages: StoredMessage[] = [];
  private readonly listeners = new Set<SessionListener>();
  private activeFile: TFile | null = null;
  private activeNoteContext?: DeepSeekNoteContext;
  private noteRevision = 0;
  private nextMessageSequence = 0;
  private nextCandidateSequence = 0;
  private nextCandidateGroupSequence = 0;
  private nextClaimSequence = 0;
  private candidates: CandidateNote[] = [];
  private candidateGroups: CandidateGroup[] = [];
  private candidateVaultActionMessages = new Map<string, string>();
  private pendingCandidateExtraction?: PendingCandidateExtraction;
  private overwriteConflictIds: string[] = [];
  private getPersonalNaming: () => PersonalNamingSettings = () => ({
    userDisplayName: DEFAULT_USER_DISPLAY_NAME,
    brainDisplayName: DEFAULT_BRAIN_DISPLAY_NAME,
    hasCompletedNamingOnboarding: false
  });

  activeCandidateId: string | null = null;
  private generalDraft = "";
  private selectionEditContext?: SelectionEditContext;
  private pendingVisionImage?: PendingVisionImage;
  private readonly confirmedVisionProviderIds = new Set<string>();
  loadingMode: LainBrainLoadingMode = null;
  candidateLoading = false;
  selectionReplacementLoading = false;
  claimReviewLoading = false;
  claimReviewError: string | null = null;
  candidateError: string | null = null;
  largeViewMode: LainBrainLargeViewMode = "chat";
  private formalizationIndex: FormalizationIndex = {
    schemaVersion: 1,
    records: {}
  };
  private leanArtifactIndex: LeanArtifactIndex = {
    schemaVersion: LEAN_ARTIFACT_SCHEMA_VERSION,
    artifacts: {}
  };
  private leanRunner: LeanRunner | null = null;

  // Ephemeral formalization previews for un-applied suggestions.
  // Key = suggestionId.  NOT persisted — survives only within the session.
  // On Apply, previews are materialized into formalizationIndex.
  // On Cancel/Delete, previews are discarded without touching formalizationIndex.
  private suggestionPreviews = new Map<
    string,
    SuggestionFormalizationPreview[]
  >();

  constructor(
    private app: App,
    private getApiKey: () => string,
    private getActiveImageProvider:
      () => ProviderProfile | null = () => null,
    private visionClient: VisionProviderClient =
      new VisionProviderRouter(),
    private askText: typeof askDeepSeek = askDeepSeek,
    private classifyClaims: typeof classifyCandidateClaims =
      classifyCandidateClaims,
    private generateLean: typeof generateLeanStatement =
      generateLeanStatement
  ) {}

  get loading(): boolean {
    return this.loadingMode !== null ||
      this.candidateLoading ||
      this.selectionReplacementLoading ||
      this.claimReviewLoading;
  }

  get userDisplayName(): string {
    return resolveDisplayName(
      this.getPersonalNaming().userDisplayName,
      DEFAULT_USER_DISPLAY_NAME
    );
  }

  get brainDisplayName(): string {
    return resolveDisplayName(
      this.getPersonalNaming().brainDisplayName,
      DEFAULT_BRAIN_DISPLAY_NAME
    );
  }

  get workspaceTitle(): string {
    const naming = this.getPersonalNaming();

    return getPersonalizedWorkspaceTitle({
      userDisplayName: this.userDisplayName,
      brainDisplayName: this.brainDisplayName,
      hasCompletedNamingOnboarding:
        naming.hasCompletedNamingOnboarding === true
    });
  }

  setPersonalNamingProvider(
    provider: () => PersonalNamingSettings
  ): void {
    this.getPersonalNaming = provider;
    this.notify();
  }

  private onFormalizationChanged?: () => void;

  setFormalizationSaveCallback(
    callback: () => void
  ): void {
    this.onFormalizationChanged = callback;
  }

  private notifyFormalizationChanged(): void {
    this.onFormalizationChanged?.();
  }

  private onLeanArtifactsChanged?: () => void;

  setLeanArtifactSaveCallback(
    callback: () => void
  ): void {
    this.onLeanArtifactsChanged = callback;
  }

  private notifyLeanArtifactsChanged(): void {
    this.onLeanArtifactsChanged?.();
  }

  setLeanRunner(runner: LeanRunner | null): void {
    this.leanRunner = runner;
  }

  getLeanRunner(): LeanRunner | null {
    return this.leanRunner;
  }

  setLeanArtifactIndex(index: LeanArtifactIndex | undefined): void {
    if (index === undefined) {
      this.leanArtifactIndex = {
        schemaVersion: LEAN_ARTIFACT_SCHEMA_VERSION,
        artifacts: {}
      };
      return;
    }

    // Defensive copy — same ownership principle as setFormalizationIndex.
    this.leanArtifactIndex = {
      schemaVersion: index.schemaVersion,
      artifacts: { ...index.artifacts }
    };
  }

  getLeanArtifactIndex(): Readonly<LeanArtifactIndex> {
    return this.leanArtifactIndex;
  }

  getLeanArtifactsForClaim(
    claimId: string
  ): Readonly<LeanArtifact>[] {
    return Object.values(this.leanArtifactIndex.artifacts)
      .filter((a) => a.claimId === claimId);
  }

  getLeanArtifactForFormalization(
    formalizationId: string
  ): Readonly<LeanArtifact> | undefined {
    return Object.values(this.leanArtifactIndex.artifacts)
      .find((a) => a.formalizationId === formalizationId);
  }

  notifyPersonalNamingChanged(): void {
    this.notify();
  }

  get draft(): string {
    return this.selectionEditContext?.draft ?? this.generalDraft;
  }

  get activeNoteLabel(): string {
    return this.activeFile === null
      ? "No active note"
      : `Using note: ${this.activeFile.basename}`;
  }

  get activeNoteSourcePath(): string {
    return this.activeFile?.path ?? "";
  }

  get candidateNoteMarkdown(): string {
    return this.getActiveCandidate()?.markdown ?? "";
  }

  get candidateViewMode(): LainBrainCandidateViewMode {
    return this.getActiveCandidate()?.viewMode ?? "preview";
  }

  get hasUserEditedCandidate(): boolean {
    return this.candidates.some((candidate) => candidate.userEdited);
  }

  get hasCandidateNote(): boolean {
    return this.candidates.length > 0;
  }

  get candidateCount(): number {
    return this.candidates.length;
  }

  getCandidateNotes(): readonly CandidateNote[] {
    for (const candidate of this.candidates) {
      candidate.claims ??= [];
      candidate.formalizationIds ??= [];
    }

    return this.candidates;
  }

  getCandidateClaims(candidateId: string): readonly ClaimRecord[] {
    const candidate = this.candidates.find(
      (item) => item.id === candidateId
    );

    if (candidate === undefined) {
      return [];
    }

    candidate.claims ??= [];

    for (const claim of candidate.claims) {
      claim.formalizationIds ??= [];
    }

    return candidate.claims;
  }

  getClaimStatusWarning(candidateId: string): string {
    return this.candidates.find(
      (item) => item.id === candidateId
    )?.claimStatusWarning ?? "";
  }

  getLainBrainManagedVaultPaths(): string[] {
    const paths = new Set<string>();

    for (const candidate of this.candidates) {
      if (candidate.createdVaultPath !== undefined) {
        paths.add(candidate.createdVaultPath);
      }
    }

    return [...paths];
  }

  updateVaultPathReferences(
    previousPath: string,
    nextPath: string
  ): void {
    for (const candidate of this.candidates) {
      if (candidate.createdVaultPath === previousPath) {
        candidate.createdVaultPath = nextPath;
      }

      if (candidate.parentVaultPath === previousPath) {
        candidate.parentVaultPath = nextPath;
      }
    }

    for (const group of this.candidateGroups) {
      if (group.createdVaultPath === previousPath) {
        group.createdVaultPath = nextPath;
      }

      if (group.parentVaultPath === previousPath) {
        group.parentVaultPath = nextPath;
      }
    }

    this.notify();
  }

  getCandidateGroups(): readonly CandidateGroup[] {
    return this.candidateGroups;
  }

  getCandidateGroup(groupId: string): CandidateGroup | undefined {
    const group = this.candidateGroups.find(
      (candidateGroup) => candidateGroup.id === groupId
    );

    if (group !== undefined) {
      this.migrateCandidateGroupParentIdentity(group);
    }

    return group;
  }

  getCandidatesForGroup(groupId: string): CandidateNote[] {
    const group = this.getCandidateGroup(groupId);

    if (group === undefined) {
      return [];
    }

    const ids = new Set(group.candidateIds);

    return this.candidates.filter((candidate) => ids.has(candidate.id));
  }

  getActiveCandidateGroup(): CandidateGroup | undefined {
    const groupId = this.getActiveCandidate()?.groupId;

    return groupId === undefined
      ? undefined
      : this.getCandidateGroup(groupId);
  }

  getAvailableCandidateParentGroups(): CandidateGroup[] {
    return this.candidateGroups.filter((group) => {
      this.migrateCandidateGroupParentIdentity(group);

      return (
        group.parentVaultPath !== undefined &&
        this.app.vault.getFileByPath(group.parentVaultPath) !== null
      );
    });
  }

  async discoverCandidateParentGroups(): Promise<CandidateGroup[]> {
    const discovered = await discoverCandidateParents(this.app);

    for (const parent of discovered) {
      let group = this.candidateGroups.find(
        (item) =>
          item.id === parent.groupId ||
          item.parentVaultPath === parent.parentVaultPath ||
          item.createdVaultPath === parent.parentVaultPath
      );

      if (group === undefined) {
        group = {
          id: parent.groupId,
          title: parent.parentDisplayTitle,
          sourceMessageIds: [],
          candidateIds: [],
          revision: 0
        };
        this.candidateGroups.push(group);
      }

      group.parentVaultPath = parent.parentVaultPath;
      group.parentDisplayTitle = parent.parentDisplayTitle;
      group.createdVaultPath ??= parent.parentVaultPath;
    }

    return this.getAvailableCandidateParentGroups();
  }

  getExistingMarkdownParentFiles(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  registerExistingNoteParent(
    parentVaultPath: string
  ): CandidateGroup | undefined {
    const safePath = validateExistingVaultMarkdownPath(parentVaultPath);

    if (safePath === null) {
      return undefined;
    }

    const file = this.app.vault.getFileByPath(safePath);

    if (file === null) {
      return undefined;
    }

    const existing = this.candidateGroups.find(
      (group) => group.parentVaultPath === safePath
    );

    if (existing !== undefined) {
      return existing;
    }

    const group: CandidateGroup = {
      id: createVaultParentGroupId("existing", safePath),
      title: file.basename,
      sourceMessageIds: [],
      candidateIds: [],
      revision: 0,
      createdVaultPath: safePath,
      parentVaultPath: safePath,
      parentDisplayTitle: file.basename
    };
    this.candidateGroups.push(group);
    return group;
  }

  getCandidateParentStatus(candidateId: string): string {
    const candidate = this.candidates.find(
      (item) => item.id === candidateId
    );

    if (candidate?.parentGroupId === undefined) {
      return "";
    }

    const group = this.getCandidateGroup(candidate.parentGroupId);
    const path = group?.parentVaultPath ?? candidate.parentVaultPath;

    if (
      group === undefined ||
      path === undefined ||
      this.app.vault.getFileByPath(path) === null
    ) {
      return "Suggested parent is unavailable. Choose a parent before creating this note.";
    }

    return `Parent: ${group.parentDisplayTitle ?? group.title}`;
  }

  setCandidateParent(
    candidateId: string,
    groupId: string | null
  ): boolean {
    const candidate = this.candidates.find(
      (item) => item.id === candidateId
    );

    if (
      candidate === undefined ||
      candidate.createdVaultPath !== undefined
    ) {
      return false;
    }

    if (groupId === null) {
      const markdown = stripCandidateParentLinks(candidate.markdown);

      if (markdown !== candidate.markdown) {
        candidate.markdown = markdown;
        candidate.revision += 1;
        candidate.userEdited = true;
      }

      candidate.parentGroupId = undefined;
      candidate.parentVaultPath = undefined;
      this.candidateVaultActionMessages.delete(candidate.id);
      this.notify();
      return true;
    }

    const group = this.getCandidateGroup(groupId);
    const path = group?.parentVaultPath;

    if (
      group === undefined ||
      path === undefined ||
      this.app.vault.getFileByPath(path) === null
    ) {
      this.candidateVaultActionMessages.set(
        candidate.id,
        "Suggested parent is unavailable. Choose a parent before creating this note."
      );
      this.notify();
      return false;
    }

    const displayTitle = group.parentDisplayTitle ?? group.title;
    const markdown = setCandidateParentLink(
      candidate.markdown,
      getVaultPathLinkTarget(path),
      displayTitle
    );

    if (markdown !== candidate.markdown) {
      candidate.markdown = markdown;
      candidate.revision += 1;
      candidate.userEdited = true;
    }

    candidate.parentGroupId = group.id;
    candidate.parentVaultPath = path;
    this.candidateVaultActionMessages.delete(candidate.id);
    this.notify();
    return true;
  }

  getCandidateVaultActionMessage(candidateId: string): string {
    return this.candidateVaultActionMessages.get(candidateId) ?? "";
  }

  getCandidateGroupCreationBlocker(groupId: string): string | null {
    const group = this.getCandidateGroup(groupId);

    if (group === undefined) {
      return "Candidate group no longer exists";
    }

    if (
      this.getCandidatesForGroup(groupId).some(
        (candidate) => candidate.createdVaultPath !== undefined
      )
    ) {
      return "A group cannot be created while some child notes already exist individually.";
    }

    return null;
  }

  getActiveCandidate(): CandidateNote | undefined {
    if (this.activeCandidateId === null) {
      return undefined;
    }

    return this.candidates.find(
      (candidate) => candidate.id === this.activeCandidateId
    );
  }

  getCandidateOverwriteConflicts(): readonly CandidateNote[] {
    const conflictIds = new Set(this.overwriteConflictIds);

    return this.candidates.filter(
      (candidate) => conflictIds.has(candidate.id)
    );
  }

  migrateLegacyCandidateMarkdown(
    markdown: string,
    viewMode: LainBrainCandidateViewMode = "preview",
    userEdited = false
  ): void {
    if (
      this.candidates.length > 0 ||
      (markdown === "" && !userEdited)
    ) {
      return;
    }

    const legacyTitle = normalizeCandidateTitle(
      extractCandidateTitle(markdown, "旧候选笔记")
    );
    const primaryConceptName =
      extractCandidateCoreConcept(markdown) ?? legacyTitle;
    const candidate: CandidateNote = {
      id: this.createCandidateId(),
      title: legacyTitle,
      primaryConcept: {
        name: primaryConceptName,
        aliases: [primaryConceptName]
      },
      markdown,
      sourceMessageIds: this.getCandidateSourceMessages()
        .map((message) => message.id),
      viewMode,
      userEdited,
      revision: 0,
      claims: [],
      formalizationIds: []
    };

    this.candidates.push(candidate);
    this.activeCandidateId = candidate.id;
    this.notify();
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  getTranscriptMessages(): readonly LainBrainTranscriptMessage[] {
    return this.messages;
  }

  getChatTranscriptMessages():
    readonly LainBrainTranscriptMessage[] {
    return this.selectionEditContext?.discussionMessages ??
      this.messages;
  }

  getSelectionEditContext():
    Readonly<SelectionEditContext> | undefined {
    return this.selectionEditContext;
  }

  hasPendingSelectionReplacement(candidateId: string): boolean {
    return (
      this.selectionEditContext?.candidateId === candidateId &&
      this.selectionEditContext.pendingReplacement !== undefined
    );
  }

  async generateClaimReview(
    candidateId: string
  ): Promise<ClaimReviewResult> {
    const candidate = this.candidates.find(
      (item) => item.id === candidateId
    );

    if (
      candidate === undefined ||
      this.activeCandidateId !== candidateId ||
      this.loading
    ) {
      return {
        ok: false,
        error: "Candidate is unavailable for claim review."
      };
    }

    const apiKey = this.getApiKey().trim();

    if (apiKey === "") {
      return {
        ok: false,
        error:
          "Please add your DeepSeek API key in Lain Brain settings."
      };
    }

    const allSources = this.getCandidateSourceMessages();
    const sourceMessages = this.getMessagesForTopic(
      allSources,
      candidate.sourceMessageIds
    );

    this.claimReviewLoading = true;
    this.claimReviewError = null;
    this.notify();

    try {
      const suggestions = await this.classifyClaims(apiKey, {
        title: candidate.title,
        primaryConcept: candidate.primaryConcept.name,
        markdown: candidate.markdown,
        sourceMessages
      });
      if (
        suggestions.some((suggestion) =>
          containsSensitiveClaimData(
            suggestion,
            apiKey
          )
        )
      ) {
        throw new Error("unsafe-claim-suggestion");
      }

      const existingClaims = candidate.claims ?? [];
      const usedIds = new Set<string>();
      const items = suggestions.map((suggestion) => {
        const existing = existingClaims.find(
          (claim) =>
            !usedIds.has(claim.id) &&
            normalizeClaimIdentity(claim.text) ===
              normalizeClaimIdentity(suggestion.text)
        );
        const id = existing?.id ?? this.createClaimId(candidate.id);
        usedIds.add(id);
        return {
          id,
          ...copyClaimSuggestion(suggestion)
        };
      });

      return { ok: true, items };
    } catch {
      const error =
        "Unable to review claims. DeepSeek returned invalid claim suggestions.";
      this.claimReviewError = error;
      return { ok: false, error };
    } finally {
      this.claimReviewLoading = false;
      this.notify();
    }
  }

  createEmptyClaimReviewItem(
    candidateId: string
  ): ClaimReviewItem | null {
    const candidate = this.candidates.find(
      (item) => item.id === candidateId
    );

    if (
      candidate === undefined ||
      this.activeCandidateId !== candidateId
    ) {
      return null;
    }

    return {
      id: this.createClaimId(candidateId),
      text: "",
      kind: "personal_interpretation",
      verification: "user_authored",
      sourceReferences: [],
      sourceMessageIds: []
    };
  }

  applyReviewedClaims(
    candidateId: string,
    selectedItems: readonly ClaimReviewItem[]
  ): ClaimApplyResult {
    const candidate = this.candidates.find(
      (item) => item.id === candidateId
    );

    if (
      candidate === undefined ||
      this.activeCandidateId !== candidateId
    ) {
      return {
        ok: false,
        error: "Candidate is unavailable for claim review."
      };
    }

    if (selectedItems.length === 0) {
      return { ok: true, appliedCount: 0 };
    }

    if (selectedItems.length > 12) {
      return {
        ok: false,
        error: "Select no more than 12 claims."
      };
    }

    const apiKey = this.getApiKey().trim();

    if (
      selectedItems.some((item) =>
        containsSensitiveClaimData(item, apiKey)
      )
    ) {
      return {
        ok: false,
        error: "Selected claims contain unsafe sensitive data."
      };
    }

    // ── Guard: formal_statement must have a valid, reviewed formalization ──
    for (const item of selectedItems) {
      if (item.kind !== "formal_statement") {
        continue;
      }

      // Check committed formalizations first, then ephemeral previews
      const committedFormalizations = this.getFormalizationsForClaim(item.id);
      const acceptedCurrentPreview =
        this.getCurrentFormalizationPreviewForSuggestion(
          item.id,
          item.text,
          item.kind,
          "accepted"
        );

      const committedValid = committedFormalizations.some(
        (r) => r.reviewStatus === "accepted"
      );
      const previewValid = acceptedCurrentPreview !== undefined;

      if (!committedValid && !previewValid) {
        return {
          ok: false,
          error:
            "Formalize and review this formal statement before applying it.",
          offendingClaimId: item.id
        };
      }
    }

    candidate.claims ??= [];
    const allowedSourceIds = new Set(candidate.sourceMessageIds);
    const nextClaims = candidate.claims.map((claim) => ({
      ...claim,
      sourceReferences: [...claim.sourceReferences],
      sourceMessageIds: [...claim.sourceMessageIds],
      formalizationIds: [...(claim.formalizationIds ?? [])]
    }));
    const now = new Date().toISOString();
    let appliedCount = 0;

    for (const item of selectedItems) {
      const existingIndex = nextClaims.findIndex(
        (claim) => claim.id === item.id
      );
      const existing = existingIndex === -1
        ? undefined
        : nextClaims[existingIndex];
      const belongsToCandidate =
        existing !== undefined ||
        item.id.startsWith("claim-" + candidateId + "-");

      if (!belongsToCandidate) {
        continue;
      }

      const normalized = normalizeReviewedClaim(
        {
          ...item,
          sourceMessageIds: item.sourceMessageIds.filter(
            (id) => allowedSourceIds.has(id)
          )
        },
        existing,
        now
      );

      if (normalized === null) {
        continue;
      }

      // ── Materialize suggestion formalization previews ──────────
      // Transfer draft formalizations from suggestion ID to committed claim ID.
      this.materializeSuggestionFormalizations(
        item.id,
        normalized
      );

      if (existingIndex === -1) {
        nextClaims.push(normalized);
      } else {
        nextClaims[existingIndex] = normalized;
      }

      appliedCount += 1;
    }

    if (appliedCount === 0) {
      return {
        ok: false,
        error: "No valid claims were selected."
      };
    }

    candidate.claims = nextClaims;
    const update = updateKnowledgeStatusMarkdown(
      candidate.markdown,
      candidate.claims
    );
    candidate.claimStatusWarning = update.warning;

    if (update.changed) {
      candidate.markdown = update.markdown;
      candidate.revision += 1;
      candidate.userEdited = true;
    }

    this.notify();
    this.notifyFormalizationChanged();
    return {
      ok: true,
      appliedCount,
      warning: update.warning
    };
  }

  /**
   * Materialize suggestion formalization previews: move them from the
   * ephemeral suggestionPreviews store into the persistent formalizationIndex.
   *
   * Updates claimId from the suggestion ID to the newly committed claim ID,
   * links them to the committed claim, and removes them from the ephemeral store.
   *
   * Does NOT re-call the LLM — the user-reviewed formalization content
   * is preserved exactly.
   */
  private materializeSuggestionFormalizations(
    suggestionId: string,
    committedClaim: ClaimRecord
  ): void {
    const previews = this.suggestionPreviews.get(suggestionId);

    if (previews === undefined || previews.length === 0) {
      return;
    }

    const surviving: SuggestionFormalizationPreview[] = [];

    for (const preview of previews) {
      // Verify the preview is not stale relative to the committed text
      if (
        preview.sourceText !== committedClaim.text ||
        preview.sourceKind !== committedClaim.kind
      ) {
        // Stale — discard the preview (the guard above should have caught this)
        continue;
      }

      // Only materialize accepted previews
      if (preview.record.reviewStatus !== "accepted") {
        surviving.push(preview);
        continue;
      }

      // Create a mutable copy with the new committed claimId
      const materialized: FormalizationRecord = {
        ...preview.record,
        claimId: committedClaim.id
      };

      // Write to persistent formalizationIndex
      const recordId = materialized.id;
      this.formalizationIndex.records[recordId] = materialized;

      // Link to committed claim
      committedClaim.formalizationIds ??= [];
      committedClaim.formalizationIds.push(recordId);
      committedClaim.primaryFormalizationId ??= recordId;
    }

    // Remove materialized previews from ephemeral store
    if (surviving.length === 0) {
      this.suggestionPreviews.delete(suggestionId);
    } else {
      this.suggestionPreviews.set(suggestionId, surviving);
    }

    // Now that records are in formalizationIndex, trigger persistence
    this.notifyFormalizationChanged();
  }

  // ── Formalization ────────────────────────────────────────────

  getFormalizationIndex(): Readonly<FormalizationIndex> {
    return this.formalizationIndex;
  }

  setFormalizationIndex(index: FormalizationIndex | undefined): void {
    if (index === undefined) {
      this.formalizationIndex = { schemaVersion: 1, records: {} };
      return;
    }

    // Defensive copy: the caller-owned index may be frozen or
    // non-extensible (e.g. Object.freeze in a settings snapshot).
    // Session must own a mutable records container so materialize
    // can add entries without throwing.
    this.formalizationIndex = {
      schemaVersion: index.schemaVersion,
      records: { ...index.records }
    };
  }

  getFormalization(
    recordId: string
  ): Readonly<FormalizationRecord> | undefined {
    return this.formalizationIndex.records[recordId];
  }

  getFormalizationsForClaim(
    claimId: string
  ): Readonly<FormalizationRecord>[] {
    const candidate = this.candidates.find(
      (c) => c.claims.some((claim) => claim.id === claimId)
    );

    if (candidate === undefined) {
      return [];
    }

    const claim = candidate.claims.find((c) => c.id === claimId);

    if (claim === undefined) {
      return [];
    }

    claim.formalizationIds ??= [];

    return claim.formalizationIds
      .map((id) => this.formalizationIndex.records[id])
      .filter((r): r is FormalizationRecord => r !== undefined);
  }

  /**
   * Get ephemeral formalization previews for an un-applied suggestion.
   * These are NOT in formalizationIndex and are NOT persisted.
   */
  getFormalizationPreviewsForSuggestion(
    suggestionId: string
  ): Readonly<SuggestionFormalizationPreview>[] {
    return this.suggestionPreviews.get(suggestionId) ?? [];
  }

  /**
   * Return the newest preview that still belongs to this suggestion and
   * exactly matches its current editable source. The modal badge and Apply
   * guard share this predicate so a rendered current state cannot disagree
   * with materialization eligibility.
   */
  getCurrentFormalizationPreviewForSuggestion(
    suggestionId: string,
    currentText: string,
    currentKind: ClaimKind,
    reviewStatus?: ReviewStatus
  ): Readonly<SuggestionFormalizationPreview> | undefined {
    const previews = this.suggestionPreviews.get(suggestionId) ?? [];

    for (let index = previews.length - 1; index >= 0; index -= 1) {
      const preview = previews[index]!;

      if (
        preview.suggestionId === suggestionId &&
        preview.sourceText === currentText &&
        preview.sourceKind === currentKind &&
        (reviewStatus === undefined ||
          preview.record.reviewStatus === reviewStatus)
      ) {
        return preview;
      }
    }

    return undefined;
  }

  /**
   * Check whether a suggestion formalization preview is stale relative
   * to the current claim text / kind.
   *
   * Returns:
   *   - undefined  if no suggestion source snapshot exists (not a suggestion
   *                formalization, or already materialized)
   *   - false      if the preview matches the current text and kind
   *   - true       if the preview is stale (text or kind changed)
   */
  /**
   * Check whether a suggestion formalization preview is stale relative
   * to the current claim text / kind.
   *
   * Returns:
   *   - undefined  if no suggestion preview found for this recordId
   *   - false      if the preview matches the current text and kind
   *   - true       if the preview is stale (text or kind changed)
   */
  isFormalizationStale(
    recordId: string,
    currentText: string,
    currentKind: ClaimKind
  ): boolean | undefined {
    const preview = this.findPreviewByRecordId(recordId);

    if (preview === undefined) {
      return undefined; // not a suggestion formalization
    }

    return (
      preview.sourceText !== currentText ||
      preview.sourceKind !== currentKind
    );
  }

  /**
   * Get the source text snapshot for a formalization record.
   * Returns undefined for non-suggestion formalizations.
   */
  getFormalizationSourceSnapshot(
    recordId: string
  ): { sourceText: string; sourceKind: ClaimKind } | undefined {
    const preview = this.findPreviewByRecordId(recordId);

    if (preview === undefined) {
      return undefined;
    }

    return { sourceText: preview.sourceText, sourceKind: preview.sourceKind };
  }

  /** Find a suggestion preview by its record ID across all suggestions. */
  private findPreviewByRecordId(
    recordId: string
  ): SuggestionFormalizationPreview | undefined {
    for (const previews of this.suggestionPreviews.values()) {
      const found = previews.find((p) => p.record.id === recordId);

      if (found !== undefined) {
        return found;
      }
    }

    return undefined;
  }

  /**
   * Remove a single suggestion formalization preview by record ID.
   * Does NOT touch formalizationIndex — only removes from the ephemeral store.
   */
  deleteFormalizationForSuggestion(recordId: string): void {
    for (const [suggestionId, previews] of this.suggestionPreviews) {
      const index = previews.findIndex((p) => p.record.id === recordId);

      if (index !== -1) {
        previews.splice(index, 1);

        if (previews.length === 0) {
          this.suggestionPreviews.delete(suggestionId);
        }

        return;
      }
    }
  }

  /**
   * Remove all ephemeral formalization previews for a suggestion ID.
   * Does NOT touch formalizationIndex.
   */
  deleteAllFormalizationsForSuggestionId(suggestionId: string): void {
    this.suggestionPreviews.delete(suggestionId);
  }

  async generateFormalization(
    candidateId: string,
    claimId: string,
    suggestionItem?: ClaimReviewItem
  ): Promise<
    | { ok: true; record: Readonly<FormalizationRecord> }
    | { ok: false; error: string }
  > {
    const candidate = this.candidates.find(
      (item) => item.id === candidateId
    );

    if (candidate === undefined || this.activeCandidateId !== candidateId) {
      return {
        ok: false,
        error: "Candidate is unavailable for formalization."
      };
    }

    const committedClaim = candidate.claims.find((c) => c.id === claimId);

    // ── Suggestion path: claim not yet applied ──────────────────
    if (committedClaim === undefined && suggestionItem !== undefined) {
      return this.generateFormalizationForSuggestion(
        candidate,
        suggestionItem,
        claimId
      );
    }

    if (committedClaim === undefined) {
      return {
        ok: false,
        error: "Claim not found."
      };
    }

    const apiKey = this.getApiKey().trim();

    if (apiKey === "") {
      return {
        ok: false,
        error: "Please add your DeepSeek API key in Lain Brain settings."
      };
    }

    // Collect sourceRefs from claim's source messages
    const sourceRefs = this.collectSourceRefs(committedClaim.sourceMessageIds);

    if (sourceRefs.length === 0) {
      return {
        ok: false,
        error: "No source messages available for formalization."
      };
    }

    // Collect context messages (all candidate source messages)
    const allSources = this.getCandidateSourceMessages();
    const contextMessages = this.getMessagesForTopic(
      allSources,
      candidate.sourceMessageIds
    );

    // sourceText = the first user message among sourceRefs
    const userRef = sourceRefs.find((ref) => {
      const msg = this.messages.find((m) => m.id === ref.messageId);
      return msg?.role === "user";
    });

    const sourceText = userRef !== undefined
      ? userRef.snapshot
      : sourceRefs[0]?.snapshot ?? "";

    if (sourceText.trim() === "") {
      return {
        ok: false,
        error: "No user text available for formalization."
      };
    }

    this.claimReviewLoading = true;
    this.notify();

    try {
      const result = await classifyMathSpeechAct(apiKey, {
        sourceText,
        contextMessages
      });

      if ("error" in result) {
        this.claimReviewLoading = false;
        this.notify();

        if (result.error === "not_mathematical") {
          return {
            ok: false,
            error: "The selected text does not contain a recognizable mathematical utterance."
          };
        }

        return {
          ok: false,
          error: "Unable to formalize. " + result.error
        };
      }

      const record = createFormalizationRecord({
        claimId,
        sourceRefs,
        speechAct: result.speechAct,
        objects: result.objects,
        explicitAssumptions: result.explicitAssumptions,
        implicitAssumptions: result.implicitAssumptions,
        quantifiers: result.quantifiers,
        conclusion: result.conclusion,
        ambiguities: result.ambiguities,
        missingConditions: result.missingConditions,
        semanticChanges: result.semanticChanges,
        aiNormalizedStatement: result.normalizedStatement,
        latexStatement: result.latexStatement
      });

      // Store in index
      this.formalizationIndex.records[record.id] = record as FormalizationRecord;

      // Link to committed claim
      committedClaim.formalizationIds ??= [];
      committedClaim.formalizationIds.push(record.id);

      // Set as primary if first
      committedClaim.primaryFormalizationId ??= record.id;

      this.claimReviewLoading = false;
      this.notify();
      this.notifyFormalizationChanged();

      return { ok: true, record };
    } catch (error) {
      this.claimReviewLoading = false;
      this.notify();

      return {
        ok: false,
        error: error instanceof Error
          ? "Unable to formalize. " + error.message
          : "Unable to formalize. Please try again."
      };
    }
  }

  /**
   * Generate a formalization preview for an un-applied suggestion.
   *
   * The formalization is stored in the main index with claimId = suggestionId,
   * but is NOT linked to candidate.claims (the claim hasn't been committed).
   * A source text/kind snapshot is saved for staleness detection.
   */
  private async generateFormalizationForSuggestion(
    candidate: CandidateNote,
    suggestionItem: ClaimReviewItem,
    suggestionId: string
  ): Promise<
    | { ok: true; record: Readonly<FormalizationRecord> }
    | { ok: false; error: string }
  > {
    const apiKey = this.getApiKey().trim();

    if (apiKey === "") {
      return {
        ok: false,
        error: "Please add your DeepSeek API key in Lain Brain settings."
      };
    }

    if (suggestionItem.text.trim() === "") {
      return {
        ok: false,
        error: "Claim text is empty. Write a claim before formalizing."
      };
    }

    // Collect sourceRefs from the suggestion's source message IDs
    const sourceRefs = this.collectSourceRefs(suggestionItem.sourceMessageIds);

    // Collect context messages (all candidate source messages)
    const allSources = this.getCandidateSourceMessages();
    const contextMessages = this.getMessagesForTopic(
      allSources,
      candidate.sourceMessageIds
    );

    // Use the claim text itself as the primary source for formalization
    const sourceText = suggestionItem.text;

    this.claimReviewLoading = true;
    this.notify();

    try {
      const result = await classifyMathSpeechAct(apiKey, {
        sourceText,
        contextMessages
      });

      if ("error" in result) {
        this.claimReviewLoading = false;
        this.notify();

        if (result.error === "not_mathematical") {
          return {
            ok: false,
            error: "The claim text does not contain a recognizable mathematical utterance."
          };
        }

        return {
          ok: false,
          error: "Unable to formalize. " + result.error
        };
      }

      const record = createFormalizationRecord({
        claimId: suggestionId,
        sourceRefs,
        speechAct: result.speechAct,
        objects: result.objects,
        explicitAssumptions: result.explicitAssumptions,
        implicitAssumptions: result.implicitAssumptions,
        quantifiers: result.quantifiers,
        conclusion: result.conclusion,
        ambiguities: result.ambiguities,
        missingConditions: result.missingConditions,
        semanticChanges: result.semanticChanges,
        aiNormalizedStatement: result.normalizedStatement,
        latexStatement: result.latexStatement
      });

      // Store in ephemeral preview store — NOT in formalizationIndex.
      // Drafts are never persisted to plugin data.
      const preview: SuggestionFormalizationPreview = {
        record: record as FormalizationRecord,
        suggestionId,
        sourceText: suggestionItem.text,
        sourceKind: suggestionItem.kind
      };

      const existing = this.suggestionPreviews.get(suggestionId) ?? [];
      existing.push(preview);
      this.suggestionPreviews.set(suggestionId, existing);

      this.claimReviewLoading = false;
      this.notify();
      // NOTE: notifyFormalizationChanged is deliberately NOT called here.
      // Draft previews must not trigger persistence to data.json.

      return { ok: true, record };
    } catch (error) {
      this.claimReviewLoading = false;
      this.notify();

      return {
        ok: false,
        error: error instanceof Error
          ? "Unable to formalize. " + error.message
          : "Unable to formalize. Please try again."
      };
    }
  }

  /** Collect SourceRefs from message IDs shared by both suggestion and committed paths. */
  private collectSourceRefs(messageIds: readonly string[]): SourceRef[] {
    const sourceRefs: SourceRef[] = [];
    const seenMessageIds = new Set<string>();

    for (const messageId of messageIds) {
      if (seenMessageIds.has(messageId)) {
        continue;
      }

      seenMessageIds.add(messageId);

      const message = this.messages.find((m) => m.id === messageId);

      if (message === undefined) {
        continue;
      }

      sourceRefs.push({
        messageId: message.id,
        snapshot: message.content
      });
    }

    return sourceRefs;
  }

  applyFormalizationReview(
    recordId: string,
    reviewStatus: ReviewStatus,
    reviewedStatement?: string,
    rejectionReason?: string,
    userNotes?: string
  ): { ok: true; record: Readonly<FormalizationRecord> } | { ok: false; error: string } {
    // Check committed formalization index first
    const existing = this.formalizationIndex.records[recordId];

    if (existing !== undefined) {
      return this.applyCommittedFormalizationReview(
        existing,
        recordId,
        reviewStatus,
        reviewedStatement,
        rejectionReason,
        userNotes
      );
    }

    // Check ephemeral suggestion previews
    const preview = this.findPreviewByRecordId(recordId);

    if (preview !== undefined) {
      return this.applyPreviewFormalizationReview(
        preview,
        reviewStatus,
        reviewedStatement,
        rejectionReason,
        userNotes
      );
    }

    return {
      ok: false,
      error: "Formalization record not found."
    };
  }

  /** Apply review to a committed (persisted) formalization record. */
  private applyCommittedFormalizationReview(
    existing: Readonly<FormalizationRecord>,
    recordId: string,
    reviewStatus: ReviewStatus,
    reviewedStatement?: string,
    rejectionReason?: string,
    userNotes?: string
  ): { ok: true; record: Readonly<FormalizationRecord> } | { ok: false; error: string } {

    try {
      const updated = applyFormalizationReviewUpdate(
        existing,
        reviewStatus,
        reviewedStatement,
        rejectionReason,
        userNotes
      );

      this.formalizationIndex.records[recordId] = updated;

      // Clear primary if the rejected record was primary
      if (reviewStatus === "rejected") {
        this.rejectAndClearPrimaryIfNeeded(updated);
      }

      // Update claim's knowledge status markdown if the claim exists
      for (const candidate of this.candidates) {
        const claim = candidate.claims.find(
          (c) => c.formalizationIds?.includes(recordId)
        );

        if (claim !== undefined) {
          const formalizations = this.getFormalizationsForClaim(claim.id);
          const summaries = buildAllFormalizationSummaries(formalizations);

          // Append formalization summaries to knowledge status if present
          if (summaries !== "" && candidate.markdown.includes("## Knowledge status")) {
            const formalizationStart =
              "<!-- lain-brain:knowledge-status:start -->";
            const formalizationEnd =
              "<!-- lain-brain:knowledge-status:end -->";
            const startIdx = candidate.markdown.indexOf(formalizationStart);
            const endIdx = candidate.markdown.indexOf(formalizationEnd);

            if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
              const statusBlock = candidate.markdown.slice(
                startIdx + formalizationStart.length,
                endIdx
              );
              const hasFormalizations = statusBlock.includes("### Formalizations");
              const updatedBlock = hasFormalizations
                ? statusBlock.replace(
                    /### Formalizations[\s\S]*?(?=###|$)/,
                    summaries
                  )
                : statusBlock.trimEnd() + "\n\n" + summaries;

              candidate.markdown =
                candidate.markdown.slice(0, startIdx + formalizationStart.length) +
                updatedBlock +
                candidate.markdown.slice(endIdx);
              candidate.revision += 1;
            }
          }

          break;
        }
      }

      this.notify();
      this.notifyFormalizationChanged();
      return { ok: true, record: updated };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error
          ? error.message
          : "Unable to apply formalization review."
      };
    }
  }

  /** Apply review to an ephemeral suggestion formalization preview. */
  private applyPreviewFormalizationReview(
    preview: SuggestionFormalizationPreview,
    reviewStatus: ReviewStatus,
    reviewedStatement?: string,
    rejectionReason?: string,
    userNotes?: string
  ): { ok: true; record: Readonly<FormalizationRecord> } | { ok: false; error: string } {
    try {
      const updated = applyFormalizationReviewUpdate(
        preview.record,
        reviewStatus,
        reviewedStatement,
        rejectionReason,
        userNotes
      );

      // Replace the preview's record in-place within the ephemeral store.
      // Find the preview in suggestionPreviews and update it.
      for (const [suggestionId, previews] of this.suggestionPreviews) {
        const index = previews.indexOf(preview);

        if (index !== -1) {
          const updatedPreview: SuggestionFormalizationPreview = {
            ...preview,
            record: updated as FormalizationRecord
          };
          previews[index] = updatedPreview;
          break;
        }
      }

      // NOTE: notifyFormalizationChanged is deliberately NOT called.
      // Draft previews must not trigger persistence to data.json.

      this.notify();
      return { ok: true, record: updated };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error
          ? error.message
          : "Unable to apply formalization review."
      };
    }
  }

  // ── Primary Formalization ────────────────────────────────────

  setPrimaryFormalization(
    claimId: string,
    formalizationId: string
  ): { ok: true } | { ok: false; error: string } {
    const formalization =
      this.formalizationIndex.records[formalizationId];

    if (formalization === undefined) {
      return {
        ok: false,
        error: "Formalization record not found."
      };
    }

    // Find the claim
    const candidate = this.findCandidateByClaimId(claimId);

    if (candidate === undefined) {
      return {
        ok: false,
        error: "Claim not found."
      };
    }

    const claim = candidate.claims.find((c) => c.id === claimId);

    if (claim === undefined) {
      return {
        ok: false,
        error: "Claim not found."
      };
    }

    claim.formalizationIds ??= [];

    const allowed = canSetPrimaryFormalization(
      formalization,
      claim.formalizationIds
    );

    if (!allowed.allowed) {
      return {
        ok: false,
        error: allowed.reason ?? "Cannot set as primary."
      };
    }

    claim.primaryFormalizationId = formalizationId;
    this.notify();
    this.notifyFormalizationChanged();
    return { ok: true };
  }

  getPrimaryFormalizationForClaim(
    claimId: string
  ): Readonly<FormalizationRecord> | undefined {
    const candidate = this.findCandidateByClaimId(claimId);

    if (candidate === undefined) {
      return undefined;
    }

    const claim = candidate.claims.find((c) => c.id === claimId);

    if (
      claim === undefined ||
      claim.primaryFormalizationId === undefined
    ) {
      return undefined;
    }

    return this.formalizationIndex.records[
      claim.primaryFormalizationId
    ];
  }

  private rejectAndClearPrimaryIfNeeded(
    formalization: Readonly<FormalizationRecord>
  ): void {
    for (const candidate of this.candidates) {
      for (const claim of candidate.claims) {
        if (
          shouldClearPrimaryOnRejection(
            formalization,
            claim.primaryFormalizationId
          )
        ) {
          claim.primaryFormalizationId = undefined;
          // Never silently select another record
        }
      }
    }
  }

  private findCandidateByClaimId(
    claimId: string
  ): CandidateNote | undefined {
    return this.candidates.find(
      (c) => c.claims.some((claim) => claim.id === claimId)
    );
  }

  // ── Lean Artifact Management ──────────────────────────────────

  private generateLeanArtifactId(): string {
    return (
      "lean-artifact-" +
      Date.now().toString(36) + "-" +
      Math.random().toString(36).slice(2, 8)
    );
  }

  async generateLeanArtifact(
    claimId: string,
    formalizationId: string
  ): Promise<
    | { ok: true; artifact: Readonly<LeanArtifact> }
    | { ok: false; error: string; blockingReason?: string }
  > {
    const formalization =
      this.formalizationIndex.records[formalizationId];

    if (formalization === undefined) {
      return {
        ok: false,
        error: "Formalization record not found."
      };
    }

    const candidate = this.findCandidateByClaimId(claimId);

    if (candidate === undefined) {
      return {
        ok: false,
        error: "Claim not found."
      };
    }

    const claim = candidate.claims.find((c) => c.id === claimId);

    if (claim === undefined) {
      return {
        ok: false,
        error: "Claim not found."
      };
    }

    const isPrimary =
      claim.primaryFormalizationId === formalizationId;

    const eligibility = checkLeanEligibility(
      formalization,
      isPrimary
    );

    if (!eligibility.eligible) {
      return {
        ok: false,
        error: "Not eligible for Lean statement generation.",
        blockingReason: eligibility.reason
      };
    }

    const apiKey = this.getApiKey().trim();

    if (apiKey === "") {
      return {
        ok: false,
        error:
          "Please add your DeepSeek API key in Lain Brain settings."
      };
    }

    this.claimReviewLoading = true;
    this.notify();

    try {
      const result = await this.generateLean(apiKey, {
        reviewedStatement: formalization.reviewedStatement,
        speechAct: formalization.speechAct,
        conclusion: formalization.conclusion,
        quantifiers: formalization.quantifiers,
        objects: formalization.objects
      });

      if ("error" in result) {
        this.claimReviewLoading = false;
        this.notify();

        return {
          ok: false,
          error: "Unable to generate Lean statement. " + result.error
        };
      }

      // Trust-boundary guard: the LLM body must not carry its own import
      // directives.  Imports are owned exclusively by LeanArtifact.imports.
      const bodyImportDiags = validateLeanBodyNoImports(
        result.leanCode
      );
      if (bodyImportDiags.length > 0) {
        this.claimReviewLoading = false;
        this.notify();

        return {
          ok: false,
          error:
            "LLM generated import lines in the statement body — " +
            "this violates the Lean body contract. " +
            bodyImportDiags[0]!.message
        };
      }

      const now = new Date().toISOString();
      const imports = selectLeanImportsForFormalization(
        formalization,
        result.leanCode
      );
      const fullCode = buildLeanCode(imports, result.leanCode);

      const artifact: LeanArtifact = {
        id: this.generateLeanArtifactId(),
        claimId,
        formalizationId,
        imports,
        generatedCode: fullCode,
        reviewedCode: fullCode,
        status: "not_checked",
        diagnostics: result.unresolvedMappings.map((m) => ({
          severity: "warning" as const,
          message: "Unresolved Mathlib mapping: " + m
        })),
        createdAt: now,
        updatedAt: now
      };

      this.leanArtifactIndex.artifacts[artifact.id] = artifact;
      this.claimReviewLoading = false;
      this.notify();
      this.notifyLeanArtifactsChanged();

      return { ok: true, artifact };
    } catch (error) {
      this.claimReviewLoading = false;
      this.notify();

      return {
        ok: false,
        error: error instanceof Error
          ? "Unable to generate Lean statement. " + error.message
          : "Unable to generate Lean statement. Please try again."
      };
    }
  }

  updateLeanReviewedCode(
    artifactId: string,
    reviewedCode: string
  ): { ok: true; artifact: Readonly<LeanArtifact> } | { ok: false; error: string } {
    const artifact =
      this.leanArtifactIndex.artifacts[artifactId];

    if (artifact === undefined) {
      return {
        ok: false,
        error: "Lean artifact not found."
      };
    }

    if (typeof reviewedCode !== "string" || reviewedCode.trim() === "") {
      return {
        ok: false,
        error: "Reviewed code must be a non-empty string."
      };
    }

    // generatedCode is immutable — only reviewedCode is updated
    const updated: LeanArtifact = {
      ...artifact,
      reviewedCode,
      status: "not_checked",
      diagnostics: [],
      updatedAt: new Date().toISOString()
    };

    this.leanArtifactIndex.artifacts[artifactId] = updated;

    const formalization =
      this.formalizationIndex.records[artifact.formalizationId];
    if (formalization !== undefined) {
      this.formalizationIndex.records[artifact.formalizationId] = {
        ...formalization,
        verificationStatus: "not_checked",
        leanStatement: undefined,
        updatedAt: new Date().toISOString()
      };
      this.notifyFormalizationChanged();
    }

    this.notify();
    this.notifyLeanArtifactsChanged();
    return { ok: true, artifact: updated };
  }

  async runLeanCheck(
    artifactId: string
  ): Promise<
    | { ok: true; artifact: Readonly<LeanArtifact> }
    | { ok: false; error: string; diagnostics: LeanDiagnostic[] }
  > {
    const artifact =
      this.leanArtifactIndex.artifacts[artifactId];

    if (artifact === undefined) {
      return {
        ok: false,
        error: "Lean artifact not found.",
        diagnostics: []
      };
    }

    // Safety validate
    const safetyDiagnostics = validateLeanCode(
      artifact.reviewedCode
    );

    if (safetyDiagnostics.length > 0) {
      const updated: LeanArtifact = {
        ...artifact,
        status: "error",
        diagnostics: safetyDiagnostics,
        updatedAt: new Date().toISOString()
      };
      this.leanArtifactIndex.artifacts[artifactId] = updated;
      this.notify();
      this.notifyLeanArtifactsChanged();

      return {
        ok: false,
        error:
          "Prohibited declarations or placeholders detected in reviewed code.",
        diagnostics: safetyDiagnostics
      };
    }

    if (this.leanRunner === null) {
      return {
        ok: false,
        error: "Lean runner is not configured.",
        diagnostics: []
      };
    }

    try {
      const result = await this.leanRunner.check({
        code: artifact.reviewedCode
      });

      const status = result.status === "statement_typechecked"
        ? "statement_typechecked"
        : "error";

      const updated: LeanArtifact = {
        ...artifact,
        status,
        diagnostics: result.diagnostics,
        updatedAt: new Date().toISOString()
      };

      this.leanArtifactIndex.artifacts[artifactId] = updated;
      this.notify();
      this.notifyLeanArtifactsChanged();

      if (status === "statement_typechecked") {
        const formalization =
          this.formalizationIndex.records[
            artifact.formalizationId
          ];

        if (formalization !== undefined) {
          const updatedFormalization: FormalizationRecord = {
            ...formalization,
            verificationStatus: "statement_typechecked",
            leanStatement: artifact.reviewedCode,
            updatedAt: new Date().toISOString()
          };
          this.formalizationIndex.records[
            artifact.formalizationId
          ] = updatedFormalization;
          this.notifyFormalizationChanged();
        }
      }

      if (status !== "statement_typechecked") {
        return {
          ok: false,
          error: "Lean statement check failed.",
          diagnostics: result.diagnostics
        };
      }

      return { ok: true, artifact: updated };
    } catch {
      const updated: LeanArtifact = {
        ...artifact,
        status: "error",
        diagnostics: [
          {
            severity: "error",
            message: "Lean check failed unexpectedly."
          }
        ],
        updatedAt: new Date().toISOString()
      };
      this.leanArtifactIndex.artifacts[artifactId] = updated;
      this.notify();
      this.notifyLeanArtifactsChanged();

      return {
        ok: false,
        error: "Lean check failed unexpectedly.",
        diagnostics: updated.diagnostics
      };
    }
  }

  /**
   * Connect the already-reviewed, committed formalization path to Lean.
   * Generation and checking remain separate reusable primitives; this method
   * only sequences them for the Review Claims workflow.
   */
  async generateAndRunLeanCheck(
    claimId: string,
    formalizationId: string
  ): Promise<
    | { ok: true; artifact: Readonly<LeanArtifact> }
    | {
        ok: false;
        error: string;
        diagnostics: LeanDiagnostic[];
        blockingReason?: string;
      }
  > {
    const generated = await this.generateLeanArtifact(
      claimId,
      formalizationId
    );

    if (!generated.ok) {
      return {
        ok: false,
        error: generated.error,
        blockingReason: generated.blockingReason,
        diagnostics: []
      };
    }

    const unresolved = generated.artifact.diagnostics.filter(
      (diagnostic) =>
        diagnostic.message.includes("Unresolved Mathlib mapping")
    );

    if (unresolved.length > 0) {
      return {
        ok: false,
        error:
          "Resolve the reported Mathlib mappings before running Lean.",
        diagnostics: unresolved
      };
    }

    return this.runLeanCheck(generated.artifact.id);
  }

  async testLeanEnvironment(): Promise<
    | { ok: true }
    | { ok: false; diagnostics: LeanDiagnostic[] }
  > {
    if (this.leanRunner === null) {
      return {
        ok: false,
        diagnostics: [
          {
            severity: "error",
            message: "Lean runner is not configured."
          }
        ]
      };
    }

    const testCode = [
      "import Mathlib.Data.Real.Basic",
      "",
      "set_option autoImplicit false",
      "",
      "#check (∀ value : ℝ, value + 0 = value)"
    ].join("\n");

    try {
      const result = await this.leanRunner.check({
        code: testCode
      });

      if (result.status === "statement_typechecked") {
        return { ok: true };
      }

      return {
        ok: false,
        diagnostics: result.diagnostics
      };
    } catch {
      return {
        ok: false,
        diagnostics: [
          {
            severity: "error",
            message: "Lean environment test failed unexpectedly."
          }
        ]
      };
    }
  }

  async createCandidateNote(
    candidateId: string,
    fileName: string,
    destinationFolder: string,
    parentSelection?: CandidateParentSelection | null
  ): Promise<CandidateNoteCreateResult> {
    const candidate = this.candidates.find(
      (item) => item.id === candidateId
    );

    if (
      candidate === undefined ||
      this.activeCandidateId !== candidateId
    ) {
      return { ok: false, error: "Candidate no longer exists" };
    }

    if (candidate.createdVaultPath !== undefined) {
      return { ok: false, error: "Note already created" };
    }

    if (candidate.markdown.trim() === "") {
      return { ok: false, error: "Candidate is empty" };
    }

    if (this.hasPendingSelectionReplacement(candidateId)) {
      return {
        ok: false,
        error: "Pending replacement must be resolved first"
      };
    }

    const requestedGroupId = parentSelection === undefined
      ? candidate.parentGroupId
      : parentSelection?.groupId;
    const requestedParentPath = parentSelection === undefined
      ? candidate.parentVaultPath
      : parentSelection?.parentVaultPath;
    const parentGroup = requestedGroupId === undefined
      ? undefined
      : this.getCandidateGroup(requestedGroupId);
    const hasSuggestedParent =
      requestedGroupId !== undefined ||
      requestedParentPath !== undefined;
    const parentPath = parentGroup?.parentVaultPath;
    const parentFile = parentPath === undefined
      ? null
      : this.app.vault.getFileByPath(parentPath);

    if (
      hasSuggestedParent &&
      (
        parentGroup === undefined ||
        parentPath === undefined ||
        parentPath !== requestedParentPath ||
        parentFile === null
      )
    ) {
      this.candidateVaultActionMessages.set(
        candidate.id,
        "Suggested parent is unavailable. Choose a parent before creating this note."
      );
      this.notify();
      return {
        ok: false,
        error: "Suggested parent is unavailable. Choose a parent before creating this note."
      };
    }

    const markdown = parentGroup !== undefined && parentPath !== undefined
      ? setCandidateParentLink(
          candidate.markdown,
          getVaultPathLinkTarget(parentPath),
          parentGroup.parentDisplayTitle ?? parentGroup.title
        )
      : parentSelection === null
        ? stripCandidateParentLinks(candidate.markdown)
        : candidate.markdown;

    const pathResult = validateCandidateNotePath(
      fileName,
      destinationFolder
    );

    if (!pathResult.ok) {
      return pathResult;
    }

    if (
      this.app.vault.getAbstractFileByPath(pathResult.vaultPath) !==
      null
    ) {
      return { ok: false, error: "File already exists" };
    }

    const revision = candidate.revision;
    const candidateMarkdownSnapshot = candidate.markdown;
    let parentUpdate:
      | { file: TFile; markdown: string; added: boolean }
      | undefined;

    if (parentFile !== null) {
      try {
        const currentParentMarkdown =
          await this.app.vault.cachedRead(parentFile);
        const updated = addCandidateChildLink(
          currentParentMarkdown,
          getVaultPathLinkTarget(pathResult.vaultPath),
          candidate.title
        );
        parentUpdate = {
          file: parentFile,
          markdown: updated.markdown,
          added: updated.added
        };
      } catch {
        return { ok: false, error: "Vault write failed" };
      }
    }

    let createdFile: TFile | undefined;

    try {
      await this.ensureVaultFolder(pathResult.folderPath);

      const currentCandidate = this.candidates.find(
        (item) => item.id === candidateId
      );

      if (
        currentCandidate === undefined ||
        this.activeCandidateId !== candidateId ||
        currentCandidate.revision !== revision ||
        currentCandidate.markdown !== candidateMarkdownSnapshot
      ) {
        return { ok: false, error: "Candidate no longer exists" };
      }

      if (this.hasPendingSelectionReplacement(candidateId)) {
        return {
          ok: false,
          error: "Pending replacement must be resolved first"
        };
      }

      if (
        this.app.vault.getAbstractFileByPath(pathResult.vaultPath) !==
        null
      ) {
        return { ok: false, error: "File already exists" };
      }

      if (
        parentPath !== undefined &&
        this.app.vault.getFileByPath(parentPath) === null
      ) {
        return {
          ok: false,
          error: "Suggested parent is unavailable. Choose a parent before creating this note."
        };
      }

      createdFile = await this.app.vault.create(
        pathResult.vaultPath,
        markdown
      );

      if (parentUpdate?.added === true) {
        await this.app.vault.modify(
          parentUpdate.file,
          parentUpdate.markdown
        );
      }

      currentCandidate.createdVaultPath = pathResult.vaultPath;

      if (currentCandidate.markdown !== markdown) {
        currentCandidate.markdown = markdown;
        currentCandidate.revision += 1;
      }

      currentCandidate.createdRevision = currentCandidate.revision;
      currentCandidate.parentGroupId = parentGroup?.id;
      currentCandidate.parentVaultPath = parentPath;
      this.candidateVaultActionMessages.delete(currentCandidate.id);
      this.notify();

      return { ok: true, path: pathResult.vaultPath };
    } catch (error) {
      if (createdFile !== undefined) {
        try {
          await this.app.vault.trash(createdFile, false);
        } catch {
          // The Vault API made its best recoverable rollback attempt.
        }

        return { ok: false, error: "Vault write failed" };
      }

      if (
        error instanceof Error &&
        error.message === "invalid-destination-folder"
      ) {
        return { ok: false, error: "Invalid destination folder" };
      }

      if (
        this.app.vault.getAbstractFileByPath(pathResult.vaultPath) !==
        null
      ) {
        return { ok: false, error: "File already exists" };
      }

      return { ok: false, error: "Vault write failed" };
    }
  }
  async openCreatedCandidateNote(candidateId: string): Promise<boolean> {
    const candidate = this.candidates.find(
      (item) => item.id === candidateId
    );
    const path = candidate?.createdVaultPath;

    if (path === undefined) {
      return false;
    }

    const file = this.app.vault.getFileByPath(path);

    if (file === null) {
      return false;
    }

    try {
      await this.app.workspace.getLeaf("tab").openFile(file);
      return true;
    } catch {
      return false;
    }
  }

  async createCandidateGroup(
    groupId: string,
    parentTitle: string,
    parentFileName: string,
    destinationFolder: string
  ): Promise<CandidateGroupCreateResult> {
    const group = this.getCandidateGroup(groupId);

    if (
      group === undefined ||
      this.getActiveCandidateGroup()?.id !== groupId
    ) {
      return { ok: false, error: "Candidate group no longer exists" };
    }

    if (group.createdVaultPath !== undefined) {
      return { ok: false, error: "Group already created" };
    }

    if (!isValidCandidateGroupTitle(parentTitle)) {
      return { ok: false, error: "Invalid parent title" };
    }

    const children = this.getCandidatesForGroup(groupId);

    if (
      children.length < 2 ||
      children.length !== group.candidateIds.length
    ) {
      return { ok: false, error: "Candidate group no longer exists" };
    }

    if (children.some((candidate) => candidate.createdVaultPath !== undefined)) {
      return {
        ok: false,
        error: "A group cannot be created while some child notes already exist individually."
      };
    }

    if (children.some((candidate) => candidate.markdown.trim() === "")) {
      return { ok: false, error: "Candidate is empty" };
    }

    if (
      children.some((candidate) =>
        this.hasPendingSelectionReplacement(candidate.id)
      )
    ) {
      return {
        ok: false,
        error: "Pending replacement must be resolved first"
      };
    }

    const parentPathResult = validateCandidateNotePath(
      parentFileName,
      destinationFolder
    );

    if (!parentPathResult.ok) {
      return parentPathResult;
    }

    const parentLinkTarget = getVaultPathLinkTarget(
      parentPathResult.vaultPath
    );

    if (!isSafeWikiLinkTarget(parentLinkTarget)) {
      return { ok: false, error: "Invalid file name" };
    }

    const childPlans = children.map((candidate) => {
      const pathResult = validateCandidateNotePath(
        suggestCandidateFileName(candidate.title),
        destinationFolder
      );

      if (!pathResult.ok) {
        return { candidate, pathResult };
      }

      const linkTarget = getMarkdownLinkTarget(pathResult.vaultPath);

      return {
        candidate,
        pathResult,
        linkTarget,
        markdown: addCandidateParentLink(
          candidate.markdown,
          parentLinkTarget,
          parentTitle.trim()
        )
      };
    });

    const invalidChild = childPlans.find(
      (plan) =>
        !plan.pathResult.ok ||
        (
          "linkTarget" in plan &&
          typeof plan.linkTarget === "string" &&
          !isSafeWikiLinkTarget(plan.linkTarget)
        )
    );

    if (invalidChild !== undefined) {
      return {
        ok: false,
        error: invalidChild.pathResult.ok
          ? "Invalid file name"
          : invalidChild.pathResult.error
      };
    }

    const validChildPlans = childPlans.filter(
      (plan): plan is typeof plan & {
        pathResult: Extract<typeof plan.pathResult, { ok: true }>;
        linkTarget: string;
        markdown: string;
      } => plan.pathResult.ok && "linkTarget" in plan
    );
    const allPaths = [
      parentPathResult.vaultPath,
      ...validChildPlans.map((plan) => plan.pathResult.vaultPath)
    ];
    const uniquePaths = new Set(
      allPaths.map((path) => path.normalize("NFKC").toLocaleLowerCase())
    );

    if (uniquePaths.size !== allPaths.length) {
      return { ok: false, error: "File already exists" };
    }

    if (
      allPaths.some(
        (path) => this.app.vault.getAbstractFileByPath(path) !== null
      )
    ) {
      return { ok: false, error: "File already exists" };
    }

    const groupRevision = group.revision;
    const childSnapshots = new Map(
      children.map((candidate) => [
        candidate.id,
        { revision: candidate.revision, markdown: candidate.markdown }
      ])
    );
    const createdFiles: TFile[] = [];

    try {
      await this.ensureVaultFolder(parentPathResult.folderPath);

      const currentGroup = this.getCandidateGroup(groupId);
      const currentChildren = this.getCandidatesForGroup(groupId);
      const changed =
        currentGroup === undefined ||
        currentGroup.revision !== groupRevision ||
        currentGroup.createdVaultPath !== undefined ||
        currentChildren.length !== children.length ||
        currentChildren.some((candidate) => {
          const snapshot = childSnapshots.get(candidate.id);

          return (
            snapshot === undefined ||
            snapshot.revision !== candidate.revision ||
            snapshot.markdown !== candidate.markdown ||
            candidate.createdVaultPath !== undefined ||
            this.hasPendingSelectionReplacement(candidate.id)
          );
        });

      if (changed) {
        return { ok: false, error: "Candidate group no longer exists" };
      }

      if (
        allPaths.some(
          (path) => this.app.vault.getAbstractFileByPath(path) !== null
        )
      ) {
        return { ok: false, error: "File already exists" };
      }

      const parentMarkdown = buildCandidateGroupParentMarkdown(
        parentTitle,
        currentGroup.id,
        validChildPlans.map((plan) => plan.linkTarget)
      );
      createdFiles.push(
        await this.app.vault.create(
          parentPathResult.vaultPath,
          parentMarkdown
        )
      );

      for (const plan of validChildPlans) {
        createdFiles.push(
          await this.app.vault.create(
            plan.pathResult.vaultPath,
            plan.markdown
          )
        );
      }

      const normalizedTitle = parentTitle.trim();

      if (currentGroup.title !== normalizedTitle) {
        currentGroup.title = normalizedTitle;
        currentGroup.revision += 1;
      }

      currentGroup.createdVaultPath = parentPathResult.vaultPath;
      currentGroup.parentVaultPath = parentPathResult.vaultPath;
      currentGroup.parentDisplayTitle = normalizedTitle;
      currentGroup.createdRevision = currentGroup.revision;

      for (const plan of validChildPlans) {
        if (plan.candidate.markdown !== plan.markdown) {
          plan.candidate.markdown = plan.markdown;
          plan.candidate.revision += 1;
        }

        plan.candidate.createdVaultPath = plan.pathResult.vaultPath;
        plan.candidate.createdRevision = plan.candidate.revision;
        plan.candidate.parentGroupId = currentGroup.id;
        plan.candidate.parentVaultPath = parentPathResult.vaultPath;
        this.candidateVaultActionMessages.delete(plan.candidate.id);
      }

      this.notify();

      return {
        ok: true,
        parentPath: parentPathResult.vaultPath,
        childPaths: validChildPlans.map(
          (plan) => plan.pathResult.vaultPath
        )
      };
    } catch {
      for (const file of createdFiles.reverse()) {
        try {
          await this.app.vault.trash(file, false);
        } catch {
          // Continue rolling back every file created by this operation.
        }
      }

      return { ok: false, error: "Vault write failed" };
    }
  }

  async openCreatedCandidateGroup(groupId: string): Promise<boolean> {
    const path = this.getCandidateGroup(groupId)?.parentVaultPath;

    if (path === undefined) {
      return false;
    }

    const file = this.app.vault.getFileByPath(path);

    if (file === null) {
      return false;
    }

    try {
      await this.app.workspace.getLeaf("tab").openFile(file);
      return true;
    } catch {
      return false;
    }
  }

  async trashCandidateNote(
    candidateId: string
  ): Promise<CandidateNoteTrashResult> {
    const candidate = this.candidates.find(
      (item) => item.id === candidateId
    );

    if (
      candidate === undefined ||
      this.activeCandidateId !== candidateId ||
      candidate.createdVaultPath === undefined
    ) {
      return { ok: false, error: "Candidate note no longer exists" };
    }

    const childPath = validateExistingVaultMarkdownPath(
      candidate.createdVaultPath
    );

    if (childPath === null) {
      return { ok: false, error: "Invalid note path" };
    }

    const file = this.app.vault.getFileByPath(childPath);

    if (file === null) {
      return { ok: false, error: "Note not found" };
    }

    const parentPath = candidate.parentVaultPath;
    const childLinkTarget = getMarkdownLinkTarget(childPath);

    try {
      await this.app.vault.trash(file, false);
    } catch {
      return { ok: false, error: "Unable to move note to Trash" };
    }

    let warning: string | undefined;

    if (parentPath !== undefined) {
      const safeParentPath =
        validateExistingVaultMarkdownPath(parentPath);
      const parentFile = safeParentPath === null
        ? null
        : this.app.vault.getFileByPath(safeParentPath);

      if (parentFile === null) {
        warning = "Parent note was not updated.";
      } else {
        try {
          const parentMarkdown =
            await this.app.vault.cachedRead(parentFile);
          const updated = removeCandidateChildLink(
            parentMarkdown,
            childLinkTarget
          );

          if (updated.removed) {
            await this.app.vault.modify(
              parentFile,
              updated.markdown
            );
          } else {
            warning = "Parent note link was not found.";
          }
        } catch {
          warning = "Parent note was not updated.";
        }
      }
    }

    candidate.createdVaultPath = undefined;
    candidate.createdRevision = undefined;
    candidate.parentGroupId = undefined;
    candidate.parentVaultPath = undefined;
    const message = warning === undefined
      ? "Note moved to Trash"
      : `Note moved to Trash — ${warning}`;
    this.candidateVaultActionMessages.set(candidate.id, message);
    this.notify();

    return {
      ok: true,
      message: "Note moved to Trash",
      warning
    };
  }
  getConversationHistory(): DeepSeekConversationMessage[] {
    return this.messages
      .filter((message) => message.includeInHistory)
      .map((message) => ({
        role: message.role,
        content: getMessageContentForModel(message)
      }));
  }

  hasApiKey(): boolean {
    return this.getApiKey().trim() !== "";
  }

  hasCompletedExchange(): boolean {
    const history = this.getConversationHistory();
    const latest = history[history.length - 1];

    return latest?.role === "assistant";
  }

  getVisionProviderConfirmation(): {
    id: string;
    displayName: string;
  } | null {
    const profile = this.getActiveImageProvider();

    if (profile === null || !canAnalyzeImages(profile)) {
      return null;
    }

    return {
      id: profile.id,
      displayName: profile.displayName
    };
  }
  getPendingVisionImage(): Readonly<PendingVisionImage> | undefined {
    return this.pendingVisionImage;
  }

  setPendingVisionImage(file: VisionImageFile): boolean {
    if (this.loading || this.selectionEditContext !== undefined) {
      return false;
    }

    const validationError = validateVisionImage(file);

    if (validationError !== null) {
      this.pendingVisionImage = undefined;
      this.addAssistantNotice(validationError);
      return false;
    }

    this.pendingVisionImage = {
      file,
      filename: file.name,
      mimeType: file.type.toLowerCase(),
      byteSize: file.size
    };
    this.notify();
    return true;
  }

  removePendingVisionImage(): void {
    if (this.pendingVisionImage === undefined) {
      return;
    }

    this.pendingVisionImage = undefined;
    this.notify();
  }

  setDraft(value: string): void {
    if (this.selectionEditContext !== undefined) {
      if (this.selectionEditContext.draft === value) {
        return;
      }

      this.selectionEditContext.draft = value;
    } else {
      if (this.generalDraft === value) {
        return;
      }

      this.generalDraft = value;
    }

    this.notify();
  }

  setCandidateNoteMarkdown(value: string): void {
    const candidate = this.getActiveCandidate();

    if (candidate === undefined) {
      this.migrateLegacyCandidateMarkdown(value, "edit", true);
      return;
    }

    if (candidate.markdown === value) {
      return;
    }

    candidate.markdown = value;
    candidate.userEdited = true;
    candidate.revision += 1;

    if ((candidate.claims?.length ?? 0) > 0) {
      candidate.claimStatusWarning =
        hasSafelyLocatedKnowledgeStatus(value)
          ? undefined
          : "Knowledge status could not be located safely. Reviewed claims remain in this session.";
    }

    this.notify();
  }

  setCandidateViewMode(
    mode: LainBrainCandidateViewMode
  ): void {
    const candidate = this.getActiveCandidate();

    if (candidate === undefined || candidate.viewMode === mode) {
      return;
    }

    candidate.viewMode = mode;
    this.notify();
  }

  setActiveCandidate(candidateId: string): void {
    if (
      this.activeCandidateId === candidateId ||
      !this.candidates.some(
        (candidate) => candidate.id === candidateId
      )
    ) {
      return;
    }

    this.activeCandidateId = candidateId;
    this.notify();
  }

  startSelectionDiscussion(
    candidateId: string,
    startOffset: number,
    endOffset: number
  ): boolean {
    const candidate = this.candidates.find(
      (item) => item.id === candidateId
    );

    if (
      candidate === undefined ||
      candidate.id !== this.activeCandidateId ||
      candidate.viewMode !== "edit" ||
      startOffset < 0 ||
      endOffset > candidate.markdown.length ||
      startOffset >= endOffset
    ) {
      return false;
    }

    const originalText = candidate.markdown.slice(
      startOffset,
      endOffset
    );

    if (originalText.trim() === "") {
      return false;
    }

    const contextRadius = 400;

    this.selectionEditContext = {
      candidateId,
      startOffset,
      endOffset,
      originalText,
      candidateRevision: candidate.revision,
      beforeContext: candidate.markdown.slice(
        Math.max(0, startOffset - contextRadius),
        startOffset
      ),
      afterContext: candidate.markdown.slice(
        endOffset,
        Math.min(
          candidate.markdown.length,
          endOffset + contextRadius
        )
      ),
      discussionMessages: [],
      draft: ""
    };
    this.notify();
    return true;
  }

  cancelSelectionDiscussion(): void {
    if (this.selectionEditContext === undefined) {
      return;
    }

    this.selectionEditContext = undefined;
    this.selectionReplacementLoading = false;
    this.notify();
  }

  discardSelectionReplacement(): void {
    const context = this.selectionEditContext;

    if (
      context === undefined ||
      (
        context.pendingReplacement === undefined &&
        context.replacementError === undefined
      )
    ) {
      return;
    }

    context.pendingReplacement = undefined;
    context.replacementError = undefined;
    this.notify();
  }

  async generateSelectionEditReplacement(): Promise<boolean> {
    const context = this.selectionEditContext;

    if (
      context === undefined ||
      this.loading ||
      !context.discussionMessages.some(
        (message) => message.role === "user"
      )
    ) {
      return false;
    }

    const apiKey = this.getApiKey().trim();

    if (apiKey === "") {
      context.replacementError =
        "Please add your DeepSeek API key in Lain Brain settings.";
      this.notify();
      return false;
    }

    const candidate = this.candidates.find(
      (item) => item.id === context.candidateId
    );

    if (candidate === undefined) {
      context.replacementError =
        "Selection changed. Please select it again.";
      this.notify();
      return false;
    }

    this.selectionReplacementLoading = true;
    context.replacementError = undefined;
    this.notify();

    try {
      const rawReplacement = await generateSelectionReplacement(
        apiKey,
        this.createSelectionRequestContext(candidate, context),
        context.discussionMessages
      );
      const replacement =
        await this.reviewSelectionReplacementLatex(
          apiKey,
          rawReplacement
        );

      if (this.selectionEditContext !== context) {
        return false;
      }

      context.pendingReplacement = replacement;
      return true;
    } catch (error) {
      if (this.selectionEditContext === context) {
        context.replacementError =
          error instanceof Error &&
          error.message === "selection-latex-invalid"
            ? "The LaTeX format check failed. No change was applied."
            : "Unable to generate a replacement. Please try again.";
      }

      return false;
    } finally {
      this.selectionReplacementLoading = false;
      this.notify();
    }
  }

  applySelectionReplacement(): boolean {
    const context = this.selectionEditContext;
    const candidate = context === undefined
      ? undefined
      : this.candidates.find(
          (item) => item.id === context.candidateId
        );

    if (
      context === undefined ||
      candidate === undefined ||
      context.pendingReplacement === undefined ||
      this.activeCandidateId !== context.candidateId ||
      candidate.revision !== context.candidateRevision ||
      candidate.markdown.slice(
        context.startOffset,
        context.endOffset
      ) !== context.originalText
    ) {
      if (context !== undefined) {
        context.replacementError =
          "Selection changed. Please select it again.";
        this.notify();
      }

      return false;
    }

    candidate.markdown =
      candidate.markdown.slice(0, context.startOffset) +
      context.pendingReplacement +
      candidate.markdown.slice(context.endOffset);
    candidate.userEdited = true;
    candidate.revision += 1;
    this.selectionEditContext = undefined;
    this.notify();
    return true;
  }

  clearChat(): void {
    if (this.loading) {
      return;
    }

    this.messages.length = 0;
    this.generalDraft = "";
    this.pendingVisionImage = undefined;
    this.candidateError = null;
    this.notify();
  }

  showLargeChat(): void {
    if (this.largeViewMode === "chat") {
      return;
    }

    this.largeViewMode = "chat";
    this.notify();
  }

  showCandidateNote(candidateId?: string): boolean {
    if (!this.hasCandidateNote) {
      return false;
    }

    if (candidateId !== undefined) {
      this.setActiveCandidate(candidateId);
    } else if (this.getActiveCandidate() === undefined) {
      this.activeCandidateId = this.candidates[0]?.id ?? null;
    }

    if (this.largeViewMode !== "candidate") {
      this.largeViewMode = "candidate";
      this.notify();
    }

    return true;
  }

  async setActiveFile(file: TFile | null): Promise<void> {
    const revision = ++this.noteRevision;

    if (file === null || file.extension !== "md") {
      this.activeFile = null;
      this.activeNoteContext = undefined;
      this.notify();
      return;
    }

    this.activeFile = file;
    this.notify();

    try {
      const content = await this.app.vault.cachedRead(file);

      if (revision !== this.noteRevision || this.activeFile !== file) {
        return;
      }

      this.activeNoteContext = {
        title: file.basename,
        content
      };
      this.notify();
    } catch {
      if (revision === this.noteRevision && this.activeFile === file) {
        this.activeNoteContext = undefined;
        this.notify();
      }
    }
  }

  async refreshActiveNoteContext(): Promise<void> {
    const file = this.activeFile;

    if (file === null) {
      this.activeNoteContext = undefined;
      this.notify();
      return;
    }

    const revision = ++this.noteRevision;
    const content = await this.app.vault.cachedRead(file);

    if (revision !== this.noteRevision || this.activeFile !== file) {
      return;
    }

    this.activeNoteContext = {
      title: file.basename,
      content
    };
    this.notify();
  }

  async send(
    confirmedProviderId?: string
  ): Promise<LainBrainSendResult> {
    if (this.selectionEditContext !== undefined) {
      await this.sendSelectionDiscussion();
      return "sent";
    }

    if (this.loading) {
      return "blocked";
    }

    const message = this.generalDraft.trim();

    if (message === "") {
      this.addAssistantNotice("Please write something first.");
      return "blocked";
    }

    const attachment = this.pendingVisionImage;

    if (attachment !== undefined) {
      const profile = this.getActiveImageProvider();

      if (profile === null || !canAnalyzeImages(profile)) {
        this.addAssistantNotice(
          "The selected AI provider cannot analyze images. Choose a Vision-capable provider in Lain Brain settings."
        );
        return "blocked";
      }

      const validationError = validateVisionImage(attachment.file);

      if (validationError !== null) {
        this.addAssistantNotice(validationError);
        return "blocked";
      }

      if (
        !this.confirmedVisionProviderIds.has(profile.id) &&
        confirmedProviderId !== profile.id
      ) {
        return "needs-vision-confirmation";
      }

      if (confirmedProviderId === profile.id) {
        this.confirmedVisionProviderIds.add(profile.id);
      }

      const attachmentMetadata: LainBrainImageAttachmentMetadata = {
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        byteSize: attachment.byteSize,
        providerId: profile.id,
        providerDisplayName: profile.displayName
      };
      this.messages.push({
        id: this.createMessageId(),
        role: "user",
        content: message,
        providerId: profile.id,
        providerDisplayName: profile.displayName,
        attachment: attachmentMetadata,
        includeInHistory: true
      });
      this.generalDraft = "";
      this.pendingVisionImage = undefined;
      this.loadingMode = "chat";
      this.notify();

      try {
        const response = await this.visionClient.analyzeImage(
          profile,
          message,
          attachment.file
        );

        this.messages.push({
          id: this.createMessageId(),
          role: "assistant",
          content: response.text,
          providerId: response.providerId,
          providerDisplayName: response.providerDisplayName,
          includeInHistory: true
        });
      } catch {
        this.messages.push({
          id: this.createMessageId(),
          role: "assistant",
          content:
            "Unable to analyze the image with the selected AI provider. Please try again.",
          providerId: profile.id,
          providerDisplayName: profile.displayName,
          includeInHistory: false
        });
      } finally {
        this.loadingMode = null;
        this.notify();
      }

      return "sent";
    }

    const apiKey = this.getApiKey().trim();

    if (apiKey === "") {
      this.addAssistantNotice(
        "Please add your DeepSeek API key in Lain Brain settings."
      );
      return "blocked";
    }

    this.messages.push({
      id: this.createMessageId(),
      role: "user",
      content: message,
      providerId: "deepseek",
      providerDisplayName: "DeepSeek",
      includeInHistory: true
    });
    this.generalDraft = "";
    this.loadingMode = "chat";
    this.notify();

    try {
      await this.refreshActiveNoteContext();

      const rawResponse = await this.askText(
        apiKey,
        this.getConversationHistory(),
        this.activeNoteContext
      );
      const response = await this.reviewAndRepairLatex(
        apiKey,
        rawResponse
      );

      this.messages.push({
        id: this.createMessageId(),
        role: "assistant",
        content: response,
        providerId: "deepseek",
        providerDisplayName: "DeepSeek",
        includeInHistory: true
      });
    } catch {
      this.messages.push({
        id: this.createMessageId(),
        role: "assistant",
        content:
          "Unable to get an answer from DeepSeek. Please try again.",
        includeInHistory: false
      });
    } finally {
      this.loadingMode = null;
      this.notify();
    }

    return "sent";
  }
  private async sendSelectionDiscussion(): Promise<void> {
    const context = this.selectionEditContext;

    if (context === undefined || this.loading) {
      return;
    }

    const message = context.draft.trim();

    if (message === "") {
      return;
    }

    const apiKey = this.getApiKey().trim();

    if (apiKey === "") {
      context.replacementError =
        "Please add your DeepSeek API key in Lain Brain settings.";
      this.notify();
      return;
    }

    const candidate = this.candidates.find(
      (item) => item.id === context.candidateId
    );

    if (candidate === undefined) {
      context.replacementError =
        "Selection changed. Please select it again.";
      this.notify();
      return;
    }

    context.discussionMessages.push({
      role: "user",
      content: message
    });
    context.draft = "";
    context.pendingReplacement = undefined;
    context.replacementError = undefined;
    this.loadingMode = "chat";
    this.notify();

    try {
      const rawResponse = await discussCandidateSelection(
        apiKey,
        this.createSelectionRequestContext(candidate, context),
        context.discussionMessages
      );
      const response = await this.reviewAndRepairLatex(
        apiKey,
        rawResponse
      );

      if (this.selectionEditContext !== context) {
        return;
      }

      context.discussionMessages.push({
        role: "assistant",
        content: response
      });
    } catch {
      if (this.selectionEditContext === context) {
        context.discussionMessages.push({
          role: "assistant",
          content: "Unable to discuss this selection. Please try again."
        });
      }
    } finally {
      this.loadingMode = null;
      this.notify();
    }
  }

  async generateOrUpdateCandidateNotes(
    allowOverwriteUserEdits = false
  ): Promise<CandidateGenerationResult> {
    if (this.loading || !this.hasCompletedExchange()) {
      return "failed";
    }

    const apiKey = this.getApiKey().trim();

    if (apiKey === "") {
      this.candidateError =
        "Please add your DeepSeek API key in Lain Brain settings.";
      this.notify();
      return "failed";
    }

    this.candidateLoading = true;
    this.candidateError = null;
    this.overwriteConflictIds = [];
    this.notify();

    try {
      await this.refreshActiveNoteContext();

      const sourceMessages = this.getCandidateSourceMessages();
      const historyKey = sourceMessages
        .map((message) => message.id)
        .join("|");
      let topics: CandidateTopicSelection[];

      if (
        this.pendingCandidateExtraction?.historyKey === historyKey
      ) {
        topics = this.pendingCandidateExtraction.topics;
      } else {
        topics = await this.discoverCandidateTopics(
          apiKey,
          sourceMessages
        );
        this.pendingCandidateExtraction = {
          historyKey,
          topics
        };
      }

      if (topics.length === 0) {
        // ── Claim-driven fallback ──────────────────────────────
        // If topic extraction returned nothing but the conversation
        // contains an independently meaningful claim (e.g. a short
        // mathematical statement), run the existing claim classifier
        // and create atomic topics from any substantive claims found.
        const fallbackTopics =
          await this.tryAtomicClaimFallback(apiKey, sourceMessages);

        if (fallbackTopics.length > 0) {
          topics = fallbackTopics;
        } else {
          this.candidateError =
            "No substantive topics were found in the current chat.";
          return "failed";
        }
      }

      const workItems = topics.flatMap((topic) => {
        const existing = this.findCandidateForTopic(topic);
        const sourceMessageIds = mergeSourceMessageIds(
          existing?.sourceMessageIds ?? [],
          topic.sourceMessageIds,
          sourceMessages
        );
        const hasNewSource = existing === undefined ||
          sourceMessageIds.some(
            (id) => !existing.sourceMessageIds.includes(id)
          );

        if (!hasNewSource) {
          return [];
        }

        return [{
          topic: {
            ...topic,
            sourceMessageIds
          },
          existing
        }];
      });
      const conflicts = workItems
        .map((item) => item.existing)
        .filter(
          (candidate): candidate is CandidateNote =>
            candidate?.userEdited === true
        );

      if (
        conflicts.length > 0 &&
        !allowOverwriteUserEdits
      ) {
        this.overwriteConflictIds = conflicts.map(
          (candidate) => candidate.id
        );
        this.candidateError =
          "Some candidate notes contain manual edits. Confirm before overwriting.";
        return "needs-confirmation";
      }

      const replacements = new Map<string, CandidateNote>();
      const additions: CandidateNote[] = [];
      let lastCandidateId: string | null = null;

      for (const item of workItems) {
        const topicMessages = this.getMessagesForTopic(
          sourceMessages,
          item.topic.sourceMessageIds
        );

        if (topicMessages.length === 0) {
          continue;
        }

        const primaryConcept = normalizeCandidatePrimaryConcept(
          item.topic,
          item.topic.title
        );
        const verifiedRelations =
          await this.findVerifiedConceptNotes(primaryConcept);
        const relevantNoteContext =
          item.topic.activeNoteRelevant
            ? this.activeNoteContext
            : undefined;
        const rawCandidateBody = await generateCandidateNote(
          apiKey,
          topicMessages.map((message) => ({
            role: message.role,
            content: message.content
          })),
          { ...item.topic, ...primaryConcept },
          relevantNoteContext,
          item.existing === undefined
            ? undefined
            : removeManagedKnowledgeStatusBlock(
                item.existing.markdown
              )
        );
        const candidateBody = await this.reviewAndRepairLatex(
          apiKey,
          rawCandidateBody
        );
        const baseMarkdown = buildCandidateNoteMarkdown(
          candidateBody,
          primaryConcept,
          verifiedRelations
        );
        const parentGroup = item.existing?.parentGroupId === undefined
          ? this.findKnownParentGroup(rawCandidateBody, topicMessages)
          : this.getCandidateGroup(item.existing.parentGroupId);
        const parentPath =
          parentGroup?.parentVaultPath ??
          item.existing?.parentVaultPath;
        const parentAvailable =
          parentGroup !== undefined &&
          parentPath !== undefined &&
          this.app.vault.getFileByPath(parentPath) !== null;
        let markdown = parentAvailable
          ? setCandidateParentLink(
              baseMarkdown,
              getVaultPathLinkTarget(parentPath),
              parentGroup.parentDisplayTitle ?? parentGroup.title
            )
          : stripCandidateParentLinks(baseMarkdown);
        const existingClaims = item.existing?.claims ?? [];
        let claimStatusWarning =
          item.existing?.claimStatusWarning;

        if (existingClaims.length > 0) {
          const statusUpdate = updateKnowledgeStatusMarkdown(
            markdown,
            existingClaims
          );

          if (statusUpdate.safe) {
            markdown = statusUpdate.markdown;
            claimStatusWarning = undefined;
          } else {
            claimStatusWarning = statusUpdate.warning;
          }
        }

        const candidate: CandidateNote = {
          id: item.existing?.id ?? this.createCandidateId(),
          title: normalizeCandidateTitle(
            extractCandidateTitle(
              markdown,
              item.topic.title
            ),
            item.topic.title
          ),
          primaryConcept,
          markdown,
          sourceMessageIds: [...item.topic.sourceMessageIds],
          viewMode: item.existing?.viewMode ?? "preview",
          userEdited: false,
          revision: (item.existing?.revision ?? -1) + 1,
          claims: existingClaims,
          claimStatusWarning,
          formalizationIds: item.existing?.formalizationIds ?? [],
          primaryFormalizationId: item.existing?.primaryFormalizationId,
          createdVaultPath: item.existing?.createdVaultPath,
          createdRevision: item.existing?.createdRevision,
          groupId: item.existing?.groupId,
          parentGroupId:
            parentGroup?.id ?? item.existing?.parentGroupId,
          parentVaultPath: parentPath
        };

        if (candidate.parentGroupId !== undefined && !parentAvailable) {
          this.candidateVaultActionMessages.set(
            candidate.id,
            "Suggested parent is unavailable. Choose a parent before creating this note."
          );
        } else {
          this.candidateVaultActionMessages.delete(candidate.id);
        }

        if (item.existing === undefined) {
          additions.push(candidate);
        } else {
          replacements.set(item.existing.id, candidate);
        }

        lastCandidateId = candidate.id;
      }

      if (replacements.size > 0) {
        this.candidates = this.candidates.map(
          (candidate) =>
            replacements.get(candidate.id) ?? candidate
        );
      }

      this.candidates.push(...additions);
      this.reconcileCandidateGroups(sourceMessages);
      this.pendingCandidateExtraction = undefined;
      this.overwriteConflictIds = [];

      if (lastCandidateId !== null) {
        this.activeCandidateId = lastCandidateId;
      } else if (this.getActiveCandidate() === undefined) {
        const matchingCandidate = topics
          .map((topic) => this.findCandidateForTopic(topic))
          .find(
            (candidate): candidate is CandidateNote =>
              candidate !== undefined
          );

        this.activeCandidateId =
          matchingCandidate?.id ??
          this.candidates[0]?.id ??
          null;
      }

      this.largeViewMode = "candidate";
      return "success";
    } catch {
      this.candidateError =
        "Unable to create candidate notes. Please try again.";
      return "failed";
    } finally {
      this.candidateLoading = false;
      this.notify();
    }
  }

  async generateOrUpdateCandidateNote(
    allowOverwriteUserEdits = false
  ): Promise<boolean> {
    return (
      await this.generateOrUpdateCandidateNotes(
        allowOverwriteUserEdits
      )
    ) === "success";
  }

  private async ensureVaultFolder(folderPath: string): Promise<void> {
    const segments = folderPath.split("/");
    let currentPath = "";

    for (const segment of segments) {
      currentPath = currentPath === ""
        ? segment
        : `${currentPath}/${segment}`;
      const existing =
        this.app.vault.getAbstractFileByPath(currentPath);

      if (existing === null) {
        await this.app.vault.createFolder(currentPath);
      } else if (
        this.app.vault.getFolderByPath(currentPath) === null
      ) {
        throw new Error("invalid-destination-folder");
      }
    }
  }

  private createSelectionRequestContext(
    candidate: CandidateNote,
    context: SelectionEditContext
  ): SelectionEditRequestContext {
    return {
      title: candidate.title,
      primaryConcept: candidate.primaryConcept.name,
      originalText: context.originalText,
      beforeContext: context.beforeContext,
      afterContext: context.afterContext
    };
  }

  private async reviewSelectionReplacementLatex(
    apiKey: string,
    markdown: string
  ): Promise<string> {
    const issues = reviewLatexFormatting(markdown);

    if (issues.length === 0) {
      return markdown;
    }

    try {
      const repaired = await repairLatexFormatting(
        apiKey,
        markdown,
        issues.map((issue) => issue.message)
      );

      if (
        repaired.trim() !== "" &&
        reviewLatexFormatting(repaired).length === 0
      ) {
        return repaired;
      }
    } catch {
      // The invalid replacement remains unapplied.
    }

    throw new Error("selection-latex-invalid");
  }

  private async reviewAndRepairLatex(
    apiKey: string,
    markdown: string
  ): Promise<string> {
    const issues = reviewLatexFormatting(markdown);

    if (issues.length === 0) {
      return markdown;
    }

    try {
      const repaired = await repairLatexFormatting(
        apiKey,
        markdown,
        issues.map((issue) => issue.message)
      );
      const repairedIssues = reviewLatexFormatting(repaired);

      if (
        repaired.trim() !== "" &&
        repairedIssues.length === 0
      ) {
        return repaired;
      }

      return appendLatexFormatWarning(
        markdown,
        repairedIssues.length === 0
          ? issues
          : repairedIssues
      );
    } catch {
      return appendLatexFormatWarning(markdown, issues);
    }
  }

  private getCandidateSourceMessages(): CandidateSourceMessage[] {
    return this.messages
      .filter((message) => message.includeInHistory)
      .map((message) => ({
        id: message.id,
        role: message.role,
        content: getMessageContentForModel(message)
      }));
  }

  private async discoverCandidateTopics(
    apiKey: string,
    messages: CandidateSourceMessage[]
  ): Promise<CandidateTopicSelection[]> {
    const extracted: CandidateTopicSelection[] = [];

    for (const batch of createCandidateMessageBatches(messages)) {
      const batchTopics = await identifyCandidateTopics(
        apiKey,
        batch,
        this.activeNoteContext
      );

      for (const topic of batchTopics) {
        const topicMessages = this.getMessagesForTopic(
          messages,
          topic.sourceMessageIds
        );

        if (
          topicMessages.length === 0 ||
          isIgnoredCandidateTopic(topicMessages)
        ) {
          continue;
        }

        const evidence = topicMessages
          .map((message) => message.content)
          .join("\n\n");

        if (findConceptEvidence(evidence, topic) === null) {
          continue;
        }

        extracted.push(topic);
      }
    }

    return mergeCandidateTopics(extracted, messages);
  }

  /**
   * Claim-driven fallback when topic extraction returns zero topics.
   *
   * Uses the existing claim classification path (classifyCandidateClaims)
   * as the authoritative semantic classifier — NO ad-hoc regex or length
   * heuristics.  An extra LLM call is made only when topic extraction
   * already returned empty; it cannot be avoided because the topic-
   * extraction prompt and the claim-classification prompt serve different
   * semantic purposes and produce different output shapes.
   *
   * Eligible claim kinds:
   *   - formal_statement  (must qualify)
   *   - factual_claim     (when genuinely knowledge-bearing)
   *   - open_question     (when substantive)
   *   - personal_interpretation (tied to a concept)
   *
   * Does NOT create topics from greetings, chitchat, or empty content.
   */
  private async tryAtomicClaimFallback(
    apiKey: string,
    messages: CandidateSourceMessage[]
  ): Promise<CandidateTopicSelection[]> {
    const userMessages = messages.filter((m) => m.role === "user");
    if (userMessages.length === 0) {
      return [];
    }

    // Cheap pre-filter: skip obviously trivial messages to avoid
    // wasting an LLM call.  The classifier is still the authoritative
    // semantic decision — this only gates the call itself.
    if (isTrivialMessages(userMessages)) {
      return [];
    }

    // Build a minimal classification request from the raw user messages.
    // No candidate note exists yet, so title/markdown are synthetic.
    //
    // The parser now accepts {claims:[]} as a valid zero-claim semantic
    // result (returns [] without throwing).  Real errors (network, API
    // failure, malformed JSON) still throw and propagate to the
    // generateOrUpdateCandidateNotes catch block, which shows a system
    // failure message rather than mislabeling it as non-substantive.
    const claimResult = await this.classifyClaims(apiKey, {
      title: "Atomic claim",
      primaryConcept: userMessages[0]!.content.slice(0, 60),
      markdown: userMessages.map((m) => m.content).join("\n\n"),
      sourceMessages: userMessages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content
      }))
    });

    // Filter for eligible claim kinds.
    // The classifier itself determines semantic validity — no regex.
    const eligibleKinds = new Set([
      "formal_statement",
      "factual_claim",
      "open_question",
      "personal_interpretation"
    ]);

    const substantiveClaims = claimResult.filter(
      (c) => eligibleKinds.has(c.kind) && c.text.trim() !== ""
    );

    if (substantiveClaims.length === 0) {
      return [];
    }

    // Create one atomic topic per substantive claim.
    // Preserve the original claim text and source message IDs.
    const results: CandidateTopicSelection[] = [];
    const seenTitles = new Set<string>();

    for (const claim of substantiveClaims) {
      const title = claim.text.length <= 70
        ? claim.text
        : claim.text.slice(0, 67) + "...";
      const conceptName = claim.text.length <= 60
        ? claim.text
        : claim.text.slice(0, 57) + "...";

      // Deduplicate by normalized title
      const titleKey = title.normalize("NFKC").toLocaleLowerCase().trim();
      if (seenTitles.has(titleKey)) {
        continue;
      }
      seenTitles.add(titleKey);

      // ── Provenance boundary ────────────────────────────────
      // Require valid sourceMessageIds from the classifier.
      // Safe recovery: only when exactly one user message exists
      // and the classifier returned no ids, we can infer the source.
      // Multiple user messages + missing ids → skip (unresolved).
      let resolvedSourceIds: string[] | null = null;

      if (claim.sourceMessageIds.length > 0) {
        // Verify ids exist in the source messages
        const validIds = claim.sourceMessageIds.filter(
          (id) => userMessages.some((m) => m.id === id)
        );
        if (validIds.length > 0) {
          resolvedSourceIds = [...validIds];
        }
      }

      if (resolvedSourceIds === null && userMessages.length === 1) {
        // Safe recovery: only one possible source
        resolvedSourceIds = [userMessages[0]!.id];
      }

      if (resolvedSourceIds === null) {
        // Unresolved provenance — skip this claim
        continue;
      }

      results.push({
        title,
        conversationTopic: claim.text,
        name: conceptName,
        aliases: [claim.text],
        sourceMessageIds: resolvedSourceIds,
        activeNoteRelevant: false
      });
    }

    return results;
  }

  private getMessagesForTopic(
    messages: CandidateSourceMessage[],
    sourceMessageIds: readonly string[]
  ): CandidateSourceMessage[] {
    const ids = new Set(sourceMessageIds);

    return messages.filter((message) => ids.has(message.id));
  }

  private findCandidateForTopic(
    topic: CandidateTopicSelection
  ): CandidateNote | undefined {
    return this.candidates.find(
      (candidate) =>
        haveSameCandidateConcept(
          candidate.primaryConcept,
          topic
        ) ||
        (
          haveSameSourceMessages(
            candidate.sourceMessageIds,
            topic.sourceMessageIds
          ) &&
          normalizeCandidateLabel(candidate.title) ===
            normalizeCandidateLabel(topic.title)
        )
    );
  }

  private migrateCandidateGroupParentIdentity(
    group: CandidateGroup
  ): void {
    group.parentVaultPath ??= group.createdVaultPath;

    if (group.parentDisplayTitle !== undefined) {
      return;
    }

    const fallback = group.parentVaultPath === undefined
      ? "Candidate Group"
      : getMarkdownLinkTarget(group.parentVaultPath);
    group.parentDisplayTitle = deriveConciseCandidateGroupTitle(
      group.title,
      fallback
    );
  }

  private findKnownParentGroup(
    modelMarkdown: string,
    messages: readonly CandidateSourceMessage[]
  ): CandidateGroup | undefined {
    const hint = extractCandidateParentHint(modelMarkdown);
    const normalizedHint = hint === null
      ? null
      : normalizeCandidateLabel(hint);
    const sourceText = normalizeCandidateLabel(
      messages.map((message) => message.content).join(" ")
    );
    const explicitMatches: CandidateGroup[] = [];
    const contextualMatches: CandidateGroup[] = [];

    for (const group of this.candidateGroups) {
      this.migrateCandidateGroupParentIdentity(group);

      if (group.parentVaultPath === undefined) {
        continue;
      }

      const identities = [
        group.parentDisplayTitle,
        group.title,
        getMarkdownLinkTarget(group.parentVaultPath),
        getVaultPathLinkTarget(group.parentVaultPath)
      ]
        .filter((value): value is string => value !== undefined)
        .map(normalizeCandidateLabel);

      if (
        normalizedHint !== null &&
        identities.includes(normalizedHint)
      ) {
        explicitMatches.push(group);
      }

      const displayTitle = normalizeCandidateLabel(
        group.parentDisplayTitle ?? group.title
      );

      if (
        displayTitle.length >= 4 &&
        sourceText.includes(displayTitle)
      ) {
        contextualMatches.push(group);
      }
    }

    if (explicitMatches.length === 1) {
      return explicitMatches[0];
    }

    return contextualMatches.length === 1
      ? contextualMatches[0]
      : undefined;
  }

  private reconcileCandidateGroups(
    messages: readonly CandidateSourceMessage[]
  ): void {
    const turns = createCandidateSourceTurns(messages);
    const assignments = new Map<
      string,
      {
        messages: CandidateSourceMessage[];
        candidateIds: string[];
      }
    >();

    for (const candidate of this.candidates) {
      const sourceIds = new Set(candidate.sourceMessageIds);
      const turn = turns.find((item) => {
        const userMessage = item.find(
          (message) => message.role === "user"
        );

        return userMessage !== undefined && sourceIds.has(userMessage.id);
      }) ?? turns.find((item) =>
        item.some((message) => sourceIds.has(message.id))
      );

      if (turn === undefined) {
        continue;
      }

      const key = turn[0]?.id;

      if (key === undefined) {
        continue;
      }

      const assignment = assignments.get(key) ?? {
        messages: turn,
        candidateIds: []
      };
      assignment.candidateIds.push(candidate.id);
      assignments.set(key, assignment);
    }

    for (const assignment of assignments.values()) {
      if (assignment.candidateIds.length < 2) {
        continue;
      }

      const assignedCandidates = this.candidates.filter(
        (candidate) => assignment.candidateIds.includes(candidate.id)
      );
      const existingGroupId = assignedCandidates
        .map((candidate) => candidate.groupId)
        .find((groupId): groupId is string =>
          groupId !== undefined &&
          this.getCandidateGroup(groupId) !== undefined
        );
      const sourceMessageIds = assignment.messages.map(
        (message) => message.id
      );
      let group = existingGroupId === undefined
        ? this.candidateGroups.find((candidateGroup) =>
            haveSameSourceMessages(
              candidateGroup.sourceMessageIds,
              sourceMessageIds
            )
          )
        : this.getCandidateGroup(existingGroupId);

      if (group === undefined) {
        group = {
          id: this.createCandidateGroupId(),
          title: deriveCandidateGroupTitle(
            assignment.messages,
            assignedCandidates
          ),
          sourceMessageIds,
          candidateIds: [...assignment.candidateIds],
          revision: 0
        };
        this.candidateGroups.push(group);
      } else {
        const membershipChanged =
          !haveSameSourceMessages(
            group.candidateIds,
            assignment.candidateIds
          );
        const sourceChanged =
          !haveSameSourceMessages(
            group.sourceMessageIds,
            sourceMessageIds
          );

        if (membershipChanged || sourceChanged) {
          group.candidateIds = [...assignment.candidateIds];
          group.sourceMessageIds = sourceMessageIds;
          group.revision += 1;
        }
      }

      for (const candidate of assignedCandidates) {
        candidate.groupId = group.id;
      }
    }
  }

  private createMessageId(): string {
    this.nextMessageSequence += 1;
    return `message-${this.nextMessageSequence}`;
  }

  private createClaimId(candidateId: string): string {
    this.nextClaimSequence += 1;
    return (
      "claim-" + candidateId + "-" +
      Date.now().toString(36) + "-" +
      this.nextClaimSequence
    );
  }

  private createCandidateGroupId(): string {
    this.nextCandidateGroupSequence += 1;
    return (
      `candidate-group-${Date.now().toString(36)}-` +
      this.nextCandidateGroupSequence
    );
  }

  private createCandidateId(): string {
    this.nextCandidateSequence += 1;
    return (
      `candidate-${Date.now().toString(36)}-` +
      this.nextCandidateSequence
    );
  }

  private async findVerifiedConceptNotes(
    concept: CandidatePrimaryConcept
  ): Promise<VerifiedCandidateRelation[]> {
    const verified: VerifiedCandidateRelation[] = [];

    for (const file of this.app.vault.getMarkdownFiles()) {
      try {
        const content = await this.app.vault.cachedRead(file);
        const matchedAlias = findConceptEvidence(content, concept);

        if (matchedAlias === null) {
          continue;
        }

        verified.push({
          linkTarget: file.path.replace(/\.md$/i, ""),
          matchedAlias
        });
      } catch {
        // A temporarily unreadable note is not link evidence.
      }
    }

    return verified.sort((left, right) =>
      left.linkTarget.localeCompare(right.linkTarget)
    );
  }

  private addAssistantNotice(content: string): void {
    this.messages.push({
      id: this.createMessageId(),
      role: "assistant",
      content,
      includeInHistory: false
    });
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function getMessageContentForModel(message: StoredMessage): string {
  const attachment = message.attachment;

  if (attachment === undefined) {
    return message.content;
  }

  return message.content + "\n\n" +
    `Source attachment: ${attachment.filename} (analyzed with ${attachment.providerDisplayName})`;
}


export function createCandidateSourceTurns(
  messages: readonly CandidateSourceMessage[]
): CandidateSourceMessage[][] {
  const turns: CandidateSourceMessage[][] = [];

  for (const message of messages) {
    if (message.role === "user") {
      turns.push([message]);
      continue;
    }

    const current = turns[turns.length - 1];

    if (current !== undefined) {
      current.push(message);
    }
  }

  return turns;
}

function deriveCandidateGroupTitle(
  messages: readonly CandidateSourceMessage[],
  candidates: readonly CandidateNote[]
): string {
  const userMessage = messages.find(
    (message) => message.role === "user"
  );

  return deriveConciseCandidateGroupTitle(
    userMessage?.content ?? "",
    candidates[0]?.title ?? "Candidate Group"
  );
}
export const CANDIDATE_TOPIC_BATCH_SIZE = 12;
export const CANDIDATE_TOPIC_BATCH_OVERLAP = 2;

export function createCandidateMessageBatches(
  messages: readonly CandidateSourceMessage[],
  batchSize = CANDIDATE_TOPIC_BATCH_SIZE,
  overlap = CANDIDATE_TOPIC_BATCH_OVERLAP
): CandidateSourceMessage[][] {
  if (messages.length === 0) {
    return [];
  }

  const safeBatchSize = Math.max(1, batchSize);
  const safeOverlap = Math.min(
    Math.max(0, overlap),
    safeBatchSize - 1
  );
  const step = safeBatchSize - safeOverlap;
  const batches: CandidateSourceMessage[][] = [];

  for (let start = 0; start < messages.length; start += step) {
    batches.push(messages.slice(start, start + safeBatchSize));

    if (start + safeBatchSize >= messages.length) {
      break;
    }
  }

  return batches;
}

export function mergeCandidateTopics(
  topics: readonly CandidateTopicSelection[],
  messages: readonly CandidateSourceMessage[]
): CandidateTopicSelection[] {
  const merged: CandidateTopicSelection[] = [];

  for (const topic of topics) {
    const existing = merged.find(
      (candidate) =>
        haveSameCandidateConcept(candidate, topic)
    );

    if (existing === undefined) {
      merged.push({
        ...topic,
        aliases: [...topic.aliases],
        sourceMessageIds: [...topic.sourceMessageIds]
      });
      continue;
    }

    const concept = normalizeMergedConcept(existing, topic);

    existing.name = concept.name;
    existing.aliases = concept.aliases;
    existing.sourceMessageIds = mergeSourceMessageIds(
      existing.sourceMessageIds,
      topic.sourceMessageIds,
      messages
    );
    existing.activeNoteRelevant =
      existing.activeNoteRelevant ||
      topic.activeNoteRelevant;

    if (topic.title.length < existing.title.length) {
      existing.title = topic.title;
    }
  }

  return merged;
}

function normalizeMergedConcept(
  left: CandidatePrimaryConcept,
  right: CandidatePrimaryConcept
): CandidatePrimaryConcept {
  const aliases = [
    left.name,
    ...left.aliases,
    right.name,
    ...right.aliases
  ];
  const seen = new Set<string>();
  const uniqueAliases: string[] = [];

  for (const alias of aliases) {
    const key = alias
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[‐‑‒–—―]/g, "-")
      .replace(/\s+/g, " ")
      .trim();

    if (key !== "" && !seen.has(key)) {
      seen.add(key);
      uniqueAliases.push(alias);
    }
  }

  return {
    name: left.name,
    aliases: uniqueAliases
  };
}

function mergeSourceMessageIds(
  left: readonly string[],
  right: readonly string[],
  messages: readonly CandidateSourceMessage[]
): string[] {
  const ids = new Set([...left, ...right]);
  const ordered = messages
    .map((message) => message.id)
    .filter((id) => ids.delete(id));

  return [...ordered, ...ids];
}

function haveSameSourceMessages(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length === 0 || right.length === 0) {
    return false;
  }

  const leftIds = new Set(left);

  return right.every((id) => leftIds.has(id)) &&
    left.every((id) => right.includes(id));
}

export function isIgnoredCandidateTopic(
  messages: readonly CandidateSourceMessage[]
): boolean {
  const userTexts = messages
    .filter((message) => message.role === "user")
    .map((message) => normalizeTrivialText(message.content));

  return userTexts.length > 0 &&
    userTexts.every((text) =>
      /^(?:test|testing|测试|你好|hello|hi)$/.test(text)
    );
}

/**
 * Check whether a single message is trivial non-substantive input.
 * Used by the atomic-claim fallback to exclude greetings/chitchat.
 */
export function isTrivialMessages(
  messages: readonly CandidateSourceMessage[]
): boolean {
  const userTexts = messages
    .filter((message) => message.role === "user")
    .map((message) => normalizeTrivialText(message.content));

  return userTexts.length > 0 &&
    userTexts.every((text) =>
      /^(?:test|testing|测试|你好|hello|hi|ok|okay|lol|喵|meow)$/.test(text)
    );
}

function normalizeTrivialText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s，。！？,.!?;；:：'"“”‘’]/g, "");
}

function extractCandidateTitle(
  markdown: string,
  fallback: string
): string {
  const heading = markdown.match(/^#(?!#)\s+(.+?)\s*#*\s*$/m);
  return heading?.[1]?.trim() || fallback;
}

function extractCandidateCoreConcept(
  markdown: string
): string | null {
  const heading = /^##\s+核心概念\s*$/m.exec(markdown);

  if (heading === null) {
    return null;
  }

  const sectionStart = heading.index + heading[0].length;
  const remainder = markdown.slice(sectionStart);
  const nextHeading = remainder.search(/^##\s+/m);
  const section = nextHeading === -1
    ? remainder
    : remainder.slice(0, nextHeading);
  const link = section.match(
    /\[\[([^\]|#^]+)(?:\|[^\]]+)?\]\]/
  );

  return link?.[1]?.trim() ?? null;
}

function containsSensitiveClaimData(
  suggestion: ClaimSuggestion,
  apiKey: string
): boolean {
  const values = [
    suggestion.text,
    suggestion.leanStatement ?? "",
    ...suggestion.sourceReferences
  ];
  const combined = values.join("\n");

  return (
    (apiKey !== "" && combined.includes(apiKey)) ||
    /data:image\/[a-z0-9.+-]+;base64,/i.test(combined)
  );
}

function copyClaimSuggestion(
  suggestion: ClaimSuggestion
): ClaimSuggestion {
  return {
    ...suggestion,
    sourceReferences: [...suggestion.sourceReferences],
    sourceMessageIds: [...suggestion.sourceMessageIds]
  };
}

function normalizeClaimIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCandidateLabel(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
