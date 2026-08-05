import { App, Modal, Setting } from "obsidian";
import type { LainBrainSession } from "./LainBrainSession";

export class DeleteCandidateNoteModal extends Modal {
  private errorEl?: HTMLElement;
  private trashButton?: HTMLButtonElement;

  constructor(
    app: App,
    private session: LainBrainSession,
    private candidateId: string
  ) {
    super(app);
  }

  onOpen(): void {
    const candidate = this.session.getCandidateNotes().find(
      (item) => item.id === this.candidateId
    );

    this.setTitle("Delete Note");
    this.contentEl.empty();

    if (
      candidate === undefined ||
      candidate.createdVaultPath === undefined
    ) {
      this.contentEl.setText("Candidate note no longer exists");
      return;
    }

    new Setting(this.contentEl)
      .setName("Note title")
      .setDesc(candidate.title);
    new Setting(this.contentEl)
      .setName("Vault-relative path")
      .setDesc(candidate.createdVaultPath);

    this.contentEl.createEl("p", {
      text: "The note will be moved to Obsidian Trash."
    });

    this.errorEl = this.contentEl.createEl("p");
    this.errorEl.style.color = "var(--text-error)";
    this.errorEl.style.minHeight = "1.4em";

    const actions = this.contentEl.createDiv();
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.gap = "0.5rem";

    const cancelButton = actions.createEl("button", {
      text: "Cancel"
    });
    cancelButton.addEventListener("click", () => this.close());

    this.trashButton = actions.createEl("button", {
      text: "Move to Trash"
    });
    this.trashButton.addClass("mod-warning");
    this.trashButton.addEventListener("click", () => {
      void this.moveToTrash();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async moveToTrash(): Promise<void> {
    if (this.trashButton !== undefined) {
      this.trashButton.disabled = true;
    }

    const result = await this.session.trashCandidateNote(
      this.candidateId
    );

    if (result.ok) {
      this.close();
      return;
    }

    this.errorEl?.setText(result.error);

    if (this.trashButton !== undefined) {
      this.trashButton.disabled = false;
    }
  }
}
