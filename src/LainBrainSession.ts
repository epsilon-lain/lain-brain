import type { App, TFile } from "obsidian";
import {
  askDeepSeek,
  createKnowledgeNode
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
export type LainBrainLoadingMode = "chat" | "organize" | null;

export class LainBrainSession {
  private readonly messages: StoredMessage[] = [];
  private readonly listeners = new Set<SessionListener>();
  private activeFile: TFile | null = null;
  private activeNoteContext?: DeepSeekNoteContext;
  private noteRevision = 0;

  draft = "";
  loadingMode: LainBrainLoadingMode = null;

  constructor(
    private app: App,
    private getApiKey: () => string
  ) {}

  get loading(): boolean {
    return this.loadingMode !== null;
  }

  get activeNoteLabel(): string {
    return this.activeFile === null
      ? "No active note"
      : `Using note: ${this.activeFile.basename}`;
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

  getActiveNoteContext(): DeepSeekNoteContext | undefined {
    if (this.activeNoteContext === undefined) {
      return undefined;
    }

    return { ...this.activeNoteContext };
  }

  hasApiKey(): boolean {
    return this.getApiKey().trim() !== "";
  }

  canCreateKnowledgeNode(): boolean {
    if (this.loading) {
      return false;
    }

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

  async generateKnowledgeNode(): Promise<string> {
    if (this.loading) {
      throw new Error("Lain Brain is busy.");
    }

    const apiKey = this.getApiKey().trim();

    if (apiKey === "") {
      throw new Error("Missing DeepSeek API key.");
    }

    this.loadingMode = "organize";
    this.notify();

    try {
      return await createKnowledgeNode(
        apiKey,
        this.getConversationHistory(),
        this.activeNoteContext
      );
    } finally {
      this.loadingMode = null;
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
