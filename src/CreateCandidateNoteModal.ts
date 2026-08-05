import {
  App,
  FuzzySuggestModal,
  Modal,
  Setting
} from "obsidian";
import type { TFile } from "obsidian";
import {
  DEFAULT_CANDIDATE_NOTE_FOLDER,
  suggestCandidateFileName,
  validateCandidateNotePath
} from "./CandidateNoteVault";
import type {
  CandidateParentSelection,
  LainBrainSession
} from "./LainBrainSession";

const PARENT_UNAVAILABLE_MESSAGE =
  "Suggested parent is unavailable. Choose a parent before creating this note.";
const CHOOSE_EXISTING_NOTE_VALUE = "__choose_existing_note__";

export class CreateCandidateNoteModal extends Modal {
  private fileName: string;
  private destinationFolder = DEFAULT_CANDIDATE_NOTE_FOLDER;
  private parentSelection: CandidateParentSelection | null = null;
  private parentSelectionInitialized = false;
  private parentDiscoveryStarted = false;
  private readonly parentSelections =
    new Map<string, CandidateParentSelection>();
  private finalPathEl?: HTMLElement;
  private errorEl?: HTMLElement;
  private createButton?: HTMLButtonElement;

  constructor(
    app: App,
    private session: LainBrainSession,
    private candidateId: string,
    private candidateTitle: string
  ) {
    super(app);
    this.fileName = suggestCandidateFileName(candidateTitle);
  }

  onOpen(): void {
    this.setTitle("Create Note");
    this.contentEl.empty();

    new Setting(this.contentEl)
      .setName("Candidate title")
      .setDesc(this.candidateTitle);

    new Setting(this.contentEl)
      .setName("File name")
      .addText((text) => {
        text.setValue(this.fileName);
        text.onChange((value) => {
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

    this.renderParentSelector();

    const pathSetting = new Setting(this.contentEl)
      .setName("Final vault path");
    this.finalPathEl = pathSetting.descEl;

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
      text: "Create Note"
    });
    this.createButton.addClass("mod-cta");
    this.createButton.addEventListener("click", () => {
      void this.createNote();
    });

    this.updatePathPreview();

    if (!this.parentDiscoveryStarted) {
      this.parentDiscoveryStarted = true;
      void this.discoverPersistentParents();
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async discoverPersistentParents(): Promise<void> {
    try {
      await this.session.discoverCandidateParentGroups();
      this.onOpen();
    } catch {
      // Keep the modal usable with No parent if discovery fails.
    }
  }

  private renderParentSelector(): void {
    const candidate = this.session.getCandidateNotes().find(
      (item) => item.id === this.candidateId
    );
    const availableParents =
      this.session.getAvailableCandidateParentGroups();
    const existingFiles =
      this.session.getExistingMarkdownParentFiles();
    const parentSetting = new Setting(this.contentEl)
      .setName("Parent note (optional)");

    this.parentSelections.clear();

    parentSetting.addDropdown((dropdown) => {
      dropdown.addOption("", "No parent");

      for (const group of availableParents) {
        if (group.parentVaultPath === undefined) {
          continue;
        }

        this.parentSelections.set(group.id, {
          groupId: group.id,
          parentVaultPath: group.parentVaultPath
        });
        dropdown.addOption(
          group.id,
          group.parentDisplayTitle ?? group.title
        );
      }

      if (existingFiles.length > 0) {
        dropdown.addOption(
          CHOOSE_EXISTING_NOTE_VALUE,
          "Choose an existing note…"
        );
      }

      if (!this.parentSelectionInitialized) {
        const suggestedGroupId = candidate?.parentGroupId;

        if (suggestedGroupId !== undefined) {
          this.parentSelection =
            this.parentSelections.get(suggestedGroupId) ?? {
              groupId: suggestedGroupId,
              parentVaultPath: candidate?.parentVaultPath ?? ""
            };
        }

        this.parentSelectionInitialized = true;
      }

      if (
        this.parentSelection !== null &&
        !this.parentSelections.has(this.parentSelection.groupId)
      ) {
        dropdown.addOption(
          this.parentSelection.groupId,
          "Suggested parent unavailable"
        );
      }

      dropdown.setValue(this.parentSelection?.groupId ?? "");
      this.updateParentDescription(parentSetting);
      dropdown.onChange((value) => {
        if (value === CHOOSE_EXISTING_NOTE_VALUE) {
          dropdown.setValue(this.parentSelection?.groupId ?? "");
          this.openExistingNoteChooser();
          return;
        }

        this.parentSelection =
          value === ""
            ? null
            : this.parentSelections.get(value) ?? {
                groupId: value,
                parentVaultPath: ""
              };
        this.updateParentDescription(parentSetting);
        this.errorEl?.setText("");
      });
    });
  }

  private openExistingNoteChooser(): void {
    const files = this.session.getExistingMarkdownParentFiles();

    if (files.length === 0) {
      return;
    }

    new ExistingParentNoteSuggestModal(
      this.app,
      files,
      (file) => {
        const group = this.session.registerExistingNoteParent(file.path);

        if (group?.parentVaultPath === undefined) {
          return;
        }

        this.parentSelection = {
          groupId: group.id,
          parentVaultPath: group.parentVaultPath
        };
        this.onOpen();
      }
    ).open();
  }

  private updateParentDescription(setting: Setting): void {
    if (this.parentSelection === null) {
      setting.setDesc("No parent");
      return;
    }

    const selected = this.parentSelections.get(
      this.parentSelection.groupId
    );
    const group = this.session.getCandidateGroup(
      this.parentSelection.groupId
    );

    setting.setDesc(
      selected === undefined
        ? PARENT_UNAVAILABLE_MESSAGE
        : "Parent: " +
          (group?.parentDisplayTitle ?? group?.title ?? "")
    );
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

  private async createNote(): Promise<void> {
    if (this.createButton !== undefined) {
      this.createButton.disabled = true;
    }

    const result = await this.session.createCandidateNote(
      this.candidateId,
      this.fileName,
      this.destinationFolder,
      this.parentSelection
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

class ExistingParentNoteSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private files: TFile[],
    private choose: (file: TFile) => void
  ) {
    super(app);
    this.setPlaceholder("Choose an existing Markdown note");
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.choose(file);
  }
}
