import {
  ItemView,
  WorkspaceLeaf
} from "obsidian";
import { LainBrainChatPanel } from "./LainBrainChatPanel";
import type { LainBrainSession } from "./LainBrainSession";

export const VIEW_TYPE_LAIN_BRAIN_LARGE =
  "lain-brain-large-view";

export class LainBrainLargeView extends ItemView {
  private chatPanel?: LainBrainChatPanel;

  constructor(
    leaf: WorkspaceLeaf,
    private session: LainBrainSession,
    private closeLargeView: () => Promise<void>
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_LAIN_BRAIN_LARGE;
  }

  getDisplayText(): string {
    return "Lain Brain Chat";
  }

  getIcon(): string {
    return "brain";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.style.display = "flex";
    this.contentEl.style.flexDirection = "column";
    this.contentEl.style.height = "100%";
    this.contentEl.style.minHeight = "0";

    const header = this.contentEl.createDiv();
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.marginBottom = "0.75rem";

    const title = header.createEl("h2", {
      text: "Lain Brain"
    });
    title.style.margin = "0";
    title.style.fontFamily = "var(--font-monospace)";

    const collapseButton = header.createEl("button", {
      text: "−"
    });
    collapseButton.setAttr(
      "aria-label",
      "Close large Lain Brain chat"
    );
    collapseButton.style.width = "14px";
    collapseButton.style.height = "14px";
    collapseButton.style.display = "flex";
    collapseButton.style.alignItems = "center";
    collapseButton.style.justifyContent = "center";
    collapseButton.style.padding = "0";
    collapseButton.style.border = "none";
    collapseButton.style.borderRadius = "50%";
    collapseButton.style.backgroundColor = "#7c3aed";
    collapseButton.style.color = "#ffffff";
    collapseButton.style.fontSize = "12px";
    collapseButton.style.lineHeight = "1";
    collapseButton.style.cursor = "pointer";

    collapseButton.addEventListener("click", () => {
      void this.closeLargeView();
    });

    const chatContainer = this.contentEl.createDiv();
    chatContainer.style.flex = "1";
    chatContainer.style.minHeight = "0";

    this.chatPanel = new LainBrainChatPanel(
      chatContainer,
      this.session,
      true
    );
    this.chatPanel.focus();
  }

  async onClose(): Promise<void> {
    this.chatPanel?.destroy();
    this.chatPanel = undefined;
  }
}
