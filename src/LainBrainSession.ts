import type { App, TFile } from "obsidian";
import {
  askDeepSeek,
  generateCandidateNote,
  identifyCandidateTopics,
  repairLatexFormatting
} from "./DeepSeekClient";
import type {
  CandidateSourceMessage,
  CandidateTopicSelection,
  DeepSeekConversationMessage,
  DeepSeekNoteContext
} from "./DeepSeekClient";
import {
  buildCandidateNoteMarkdown,
  findConceptEvidence,
  haveSameCandidateConcept
} from "./CandidateNoteRelations";
import type {
  CandidatePrimaryConcept,
  VerifiedCandidateRelation
} from "./CandidateNoteRelations";
import {
  appendLatexFormatWarning,
  reviewLatexFormatting
} from "./LatexFormatReview";

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
  private candidates: CandidateNote[] = [];
  private pendingCandidateExtraction?: PendingCandidateExtraction;
  private overwriteConflictIds: string[] = [];

  activeCandidateId: string | null = null;
  draft = "";
  loadingMode: LainBrainLoadingMode = null;
  candidateLoading = false;
  candidateError: string | null = null;
  largeViewMode: LainBrainLargeViewMode = "chat";

  constructor(
    private app: App,
    private getApiKey: () => string
  ) {}

  get loading(): boolean {
    return this.loadingMode !== null || this.candidateLoading;
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

    const primaryConceptName =
      extractCandidateCoreConcept(markdown) ??
      extractCandidateTitle(markdown, "旧候选笔记");
    const candidate: CandidateNote = {
      id: this.createCandidateId(),
      title: extractCandidateTitle(markdown, "旧候选笔记"),
      primaryConcept: {
        name: primaryConceptName,
        aliases: [primaryConceptName]
      },
      markdown,
      sourceMessageIds: this.getCandidateSourceMessages()
        .map((message) => message.id),
      viewMode,
      userEdited
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
    if (this.draft === value) {
      return;
    }

    this.draft = value;
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

  clearChat(): void {
    if (this.loading) {
      return;
    }

    this.messages.length = 0;
    this.draft = "";
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
    if (this.loading) {
      return;
    }

    const message = this.draft.trim();

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
    this.draft = "";
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
          "当前聊天中没有发现可整理的实质主题。";
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
          "部分候选笔记包含手动修改；覆盖前需要确认。";
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

        const verifiedRelations =
          await this.findVerifiedConceptNotes(item.topic);
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
          item.topic,
          relevantNoteContext,
          item.existing?.markdown
        );
        const candidateBody = await this.reviewAndRepairLatex(
          apiKey,
          rawCandidateBody
        );
        const markdown = buildCandidateNoteMarkdown(
          candidateBody,
          item.topic,
          verifiedRelations
        );
        const candidate: CandidateNote = {
          id: item.existing?.id ?? this.createCandidateId(),
          title: extractCandidateTitle(
            markdown,
            item.topic.title
          ),
          primaryConcept: {
            name: item.topic.name,
            aliases: [...item.topic.aliases]
          },
          markdown,
          sourceMessageIds: [...item.topic.sourceMessageIds],
          viewMode: item.existing?.viewMode ?? "preview",
          userEdited: false
        };

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

  private createMessageId(): string {
    this.nextMessageSequence += 1;
    return `message-${this.nextMessageSequence}`;
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
