import type { App, TFile } from "obsidian";
import {
  askDeepSeek,
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

export interface LainBrainTranscriptMessage {
  role: "user" | "assistant";
  content: string;
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

type SessionListener = () => void;
export type LainBrainLoadingMode = "chat" | null;
export type LainBrainLargeViewMode = "chat" | "candidate";
export type LainBrainCandidateViewMode = "edit" | "preview";

export class LainBrainSession {
  private readonly messages: StoredMessage[] = [];
  private readonly listeners = new Set<SessionListener>();
  private activeFile: TFile | null = null;
  private activeNoteContext?: DeepSeekNoteContext;
  private noteRevision = 0;
  private nextMessageSequence = 0;
  private nextCandidateSequence = 0;
  private nextCandidateGroupSequence = 0;
  private candidates: CandidateNote[] = [];
  private candidateGroups: CandidateGroup[] = [];
  private candidateVaultActionMessages = new Map<string, string>();
  private pendingCandidateExtraction?: PendingCandidateExtraction;
  private overwriteConflictIds: string[] = [];

  activeCandidateId: string | null = null;
  private generalDraft = "";
  private selectionEditContext?: SelectionEditContext;
  loadingMode: LainBrainLoadingMode = null;
  candidateLoading = false;
  selectionReplacementLoading = false;
  candidateError: string | null = null;
  largeViewMode: LainBrainLargeViewMode = "chat";

  constructor(
    private app: App,
    private getApiKey: () => string
  ) {}

  get loading(): boolean {
    return this.loadingMode !== null ||
      this.candidateLoading ||
      this.selectionReplacementLoading;
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
    return this.candidates;
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
      revision: 0
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
        content: message.content
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

  async send(): Promise<void> {
    if (this.selectionEditContext !== undefined) {
      await this.sendSelectionDiscussion();
      return;
    }

    if (this.loading) {
      return;
    }

    const message = this.generalDraft.trim();

    if (message === "") {
      this.addAssistantNotice("Please write something first.");
      return;
    }

    const apiKey = this.getApiKey().trim();

    if (apiKey === "") {
      this.addAssistantNotice(
        "Please add your DeepSeek API key in Lain Brain settings."
      );
      return;
    }

    this.messages.push({
      id: this.createMessageId(),
      role: "user",
      content: message,
      includeInHistory: true
    });
    this.generalDraft = "";
    this.loadingMode = "chat";
    this.notify();

    try {
      await this.refreshActiveNoteContext();

      const rawResponse = await askDeepSeek(
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
        this.candidateError =
          "No substantive topics were found in the current chat.";
        return "failed";
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
          item.existing?.markdown
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
        const markdown = parentAvailable
          ? setCandidateParentLink(
              baseMarkdown,
              getVaultPathLinkTarget(parentPath),
              parentGroup.parentDisplayTitle ?? parentGroup.title
            )
          : stripCandidateParentLinks(baseMarkdown);
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
        content: message.content
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

function isIgnoredCandidateTopic(
  messages: readonly CandidateSourceMessage[]
): boolean {
  const userTexts = messages
    .filter((message) => message.role === "user")
    .map((message) => normalizeTrivialText(message.content));

  return userTexts.length > 0 &&
    userTexts.every((text) =>
      /^(?:1\+1=2|test|testing|测试|你好|hello|hi)$/.test(text)
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

function normalizeCandidateLabel(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
