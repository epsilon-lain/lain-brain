import { App, Modal, Setting } from "obsidian";
import {
  DEFAULT_CANDIDATE_NOTE_FOLDER,
  suggestCandidateFileName,
  validateCandidateNotePath
} from "./CandidateNoteVault";
import type { LainBrainSession } from "./LainBrainSession";

export class CreateCandidateGroupModal extends Modal {
  private parentTitle: string;
  private fileName: string;
  private destinationFolder = DEFAULT_CANDIDATE_NOTE_FOLDER;
  private fileNameWasEdited = false;
  private fileNameInput?: HTMLInputElement;
  private finalPathEl?: HTMLElement;
  private errorEl?: HTMLElement;
  private createButton?: HTMLButtonElement;

  constructor(
    app: App,
    private session: LainBrainSession,
    private groupId: string
  ) {
    super(app);
    const group = session.getCandidateGroup(groupId);
    this.parentTitle =
      group?.parentDisplayTitle ??
      group?.title ??
      "Candidate Group";
    this.fileName = suggestCandidateFileName(this.parentTitle);
  }

  onOpen(): void {
    const group = this.session.getCandidateGroup(this.groupId);

    this.setTitle("Create Group");
    this.contentEl.empty();

    if (group === undefined) {
      this.contentEl.setText("Candidate group no longer exists");
      return;
    }

    new Setting(this.contentEl)
      .setName("Parent title")
      .addText((text) => {
        text.setValue(this.parentTitle);
        text.onChange((value) => {
          this.parentTitle = value;

          if (!this.fileNameWasEdited) {
            this.fileName = suggestCandidateFileName(value);

            if (this.fileNameInput !== undefined) {
              this.fileNameInput.value = this.fileName;
            }
          }

          this.updatePathPreview();
        });
      });

    new Setting(this.contentEl)
      .setName("Parent file name")
      .addText((text) => {
        this.fileNameInput = text.inputEl;
        text.setValue(this.fileName);
        text.onChange((value) => {
          this.fileNameWasEdited = true;
          this.fileName = value;
          this.updatePathPreview();
        });
      });

    new Setting(this.contentEl)
      .setName("Destination folder")
      .addText((text) => {
        text.setValue(this.destinationFolder);
        text.onChange((value) => {
          this.destinationFolder = value;
          this.updatePathPreview();
        });
      });

    const pathSetting = new Setting(this.contentEl)
      .setName("Final vault path");
    this.finalPathEl = pathSetting.descEl;

    this.contentEl.createEl("h3", { text: "Child notes" });
    const list = this.contentEl.createEl("ul");

    for (const candidate of this.session.getCandidatesForGroup(group.id)) {
      list.createEl("li", { text: candidate.title });
    }

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

    this.createButton = actions.createEl("button", {
      text: "Create Group"
    });
    this.createButton.addClass("mod-cta");
    this.createButton.addEventListener("click", () => {
      void this.createGroup();
    });

    this.updatePathPreview();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private updatePathPreview(): void {
    const result = validateCandidateNotePath(
      this.fileName,
      this.destinationFolder
    );

    this.finalPathEl?.setText(
      result.ok ? result.vaultPath : result.error
    );
    this.errorEl?.setText("");
  }

  private async createGroup(): Promise<void> {
    if (this.createButton !== undefined) {
      this.createButton.disabled = true;
    }

    const result = await this.session.createCandidateGroup(
      this.groupId,
      this.parentTitle,
      this.fileName,
      this.destinationFolder
    );

    if (result.ok) {
      this.close();
      return;
    }

    this.errorEl?.setText(result.error);

    if (this.createButton !== undefined) {
      this.createButton.disabled = false;
    }
  }
}
