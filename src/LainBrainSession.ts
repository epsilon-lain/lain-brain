import type { App, TFile } from "obsidian";
import {
  askDeepSeek,
  generateCandidateNote
} from "./DeepSeekClient";
import type {
  DeepSeekConversationMessage,
  DeepSeekNoteContext
} from "./DeepSeekClient";

export interface LainBrainTranscriptMessage {
  role: "user" | "assistant";
  content: string;
}

interface StoredMessage extends LainBrainTranscriptMessage {
  includeInHistory: boolean;
}

type SessionListener = () => void;
export type LainBrainLoadingMode = "chat" | null;
export type LainBrainLargeViewMode = "chat" | "candidate";

export class LainBrainSession {
  private readonly messages: StoredMessage[] = [];
  private readonly listeners = new Set<SessionListener>();
  private activeFile: TFile | null = null;
  private activeNoteContext?: DeepSeekNoteContext;
  private noteRevision = 0;

  draft = "";
  loadingMode: LainBrainLoadingMode = null;
  candidateNoteMarkdown = "";
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

  get hasCandidateNote(): boolean {
    return this.candidateNoteMarkdown !== "";
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

  showCandidateNote(): boolean {
    if (!this.hasCandidateNote) {
      return false;
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
      role: "user",
      content: message,
      includeInHistory: true
    });
    this.draft = "";
    this.loadingMode = "chat";
    this.notify();

    try {
      await this.refreshActiveNoteContext();

      const response = await askDeepSeek(
        apiKey,
        this.getConversationHistory(),
        this.activeNoteContext
      );

      this.messages.push({
        role: "assistant",
        content: response,
        includeInHistory: true
      });
    } catch {
      this.messages.push({
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

  async generateOrUpdateCandidateNote(): Promise<boolean> {
    if (this.loading || !this.hasCompletedExchange()) {
      return false;
    }

    const apiKey = this.getApiKey().trim();

    if (apiKey === "") {
      this.candidateError =
        "Please add your DeepSeek API key in Lain Brain settings.";
      this.notify();
      return false;
    }

    const previousCandidate = this.hasCandidateNote
      ? this.candidateNoteMarkdown
      : undefined;

    this.candidateLoading = true;
    this.candidateError = null;
    this.notify();

    try {
      await this.refreshActiveNoteContext();

      const candidate = await generateCandidateNote(
        apiKey,
        this.getConversationHistory(),
        this.activeNoteContext,
        previousCandidate
      );

      this.candidateNoteMarkdown = candidate;
      this.largeViewMode = "candidate";
      return true;
    } catch {
      this.candidateError =
        "Unable to create a candidate note. Please try again.";
      return false;
    } finally {
      this.candidateLoading = false;
      this.notify();
    }
  }

  private addAssistantNotice(content: string): void {
    this.messages.push({
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
