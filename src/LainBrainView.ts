import {
  ItemView,
  setIcon,
  TFile,
  TFolder,
  WorkspaceLeaf
} from "obsidian";
import { LainBrainChatPanel } from "./LainBrainChatPanel";
import type { DeepSeekNoteContext } from "./DeepSeekClient";
import type { LainBrainSession } from "./LainBrainSession";

export const VIEW_TYPE_LAIN_BRAIN = "lain-brain-view";

export class LainBrainView extends ItemView {
  private chatPanel?: LainBrainChatPanel;
  private unsubscribe?: () => void;

  constructor(
    leaf: WorkspaceLeaf,
    private session: LainBrainSession,
    private openLargeView: () => Promise<void>
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_LAIN_BRAIN;
  }

  getDisplayText(): string {
    return "Lain Brain";
  }

  getIcon(): string {
    return "brain";
  }

  private async ensureFolder(path: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);

    if (existing === null) {
      await this.app.vault.createFolder(path);
      return;
    }

    if (!(existing instanceof TFolder)) {
      throw new Error(`A file already exists at ${path}.`);
    }
  }

  private getAvailableDraftPath(created: Date): string {
    const filename = created
      .toISOString()
      .replace(/[:.]/g, "-");
    let suffix = 0;

    while (true) {
      const suffixText = suffix === 0 ? "" : `-${suffix}`;
      const path =
        `Lain Brain/Drafts/${filename}${suffixText}.md`;

      if (this.app.vault.getAbstractFileByPath(path) === null) {
        return path;
      }

      suffix += 1;
    }
  }

  private async createDraftNote(
    body: string,
    noteContext?: DeepSeekNoteContext
  ): Promise<TFile> {
    await this.ensureFolder("Lain Brain");
    await this.ensureFolder("Lain Brain/Drafts");

    const created = new Date();
    const path = this.getAvailableDraftPath(created);
    const sourceNote = noteContext === undefined
      ? ""
      : `[[${noteContext.title}]]`;
    const content =
      "---\n" +
      "lain_brain_status: draft\n" +
      `source_note: ${JSON.stringify(sourceNote)}\n` +
      `created: ${created.toISOString()}\n` +
      "---\n\n" +
      `${body.trim()}\n`;

    return this.app.vault.create(path, content);
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();

    const header = this.contentEl.createDiv();
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";

    const title = header.createEl("h2", {
      text: "Lain Brain"
    });
    title.style.margin = "0";

    const expandButton = header.createEl("button");
    setIcon(expandButton, "plus");
    expandButton.setAttr("aria-label", "Open large Lain Brain chat");
    expandButton.style.width = "13px";
    expandButton.style.height = "13px";
    expandButton.style.display = "inline-flex";
    expandButton.style.alignItems = "center";
    expandButton.style.justifyContent = "center";
    expandButton.style.padding = "0";
    expandButton.style.border = "none";
    expandButton.style.borderRadius = "50%";
    expandButton.style.backgroundColor = "#7c3aed";
    expandButton.style.color = "#ffffff";
    expandButton.style.fontSize = "11px";
    expandButton.style.lineHeight = "1";
    expandButton.style.boxSizing = "border-box";
    expandButton.style.cursor = "pointer";

    const expandIcon = expandButton.querySelector("svg");

    if (expandIcon !== null) {
      expandIcon.style.width = "11px";
      expandIcon.style.height = "11px";
    }

    expandButton.addEventListener("click", () => {
      void this.openLargeView();
    });

    this.contentEl.createEl("p", {
      text: "Build a personal knowledge model with your notes."
    });

    const chatContainer = this.contentEl.createDiv();
    this.chatPanel = new LainBrainChatPanel(
      chatContainer,
      this.session,
      false
    );

    const organizeButton = this.contentEl.createEl("button", {
      text: "整理为候选节点"
    });
    const organizeStatus = this.contentEl.createEl("p");

    const updateOrganizeButton = (): void => {
      organizeButton.style.display =
        this.session.canCreateKnowledgeNode()
          ? "inline-block"
          : "none";
      organizeButton.disabled = this.session.loading;
    };

    this.unsubscribe = this.session.subscribe(updateOrganizeButton);
    updateOrganizeButton();

    organizeButton.addEventListener("click", async () => {
      if (!this.session.hasApiKey()) {
        organizeStatus.setText(
          "Please add your DeepSeek API key in Lain Brain settings."
        );
        return;
      }

      const noteContext = this.session.getActiveNoteContext();
      organizeStatus.setText("Organizing draft...");

      try {
        const body = await this.session.generateKnowledgeNode();
        const draftFile = await this.createDraftNote(
          body,
          noteContext
        );

        organizeStatus.setText("Draft created.");
        await this.app.workspace
          .getLeaf("tab")
          .openFile(draftFile);
      } catch {
        organizeStatus.setText(
          "Unable to create a draft node. Please try again."
        );
      }
    });

    this.chatPanel.focus();
  }

  async onClose(): Promise<void> {
    this.chatPanel?.destroy();
    this.chatPanel = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
