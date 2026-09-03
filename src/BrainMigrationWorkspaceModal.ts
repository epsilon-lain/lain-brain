import { App, Modal, Setting } from "obsidian";
import {
  createConceptMigrationDraft,
  prepareConceptMigration,
  type ConceptMigrationDraft,
  type ConceptMigrationLabelCollision,
  type PreparedConceptMigration
} from "./BrainMigration";
import {
  loadOrdinaryNoteForMigration,
  persistConfirmedConceptMigration,
  type ConceptMigrationWriteFailureCode,
  type ConceptMigrationWriteResult
} from "./ObsidianConceptMigration";
import {
  loadObsidianConceptIndex,
  type ObsidianConceptIndexResult
} from "./ObsidianConceptIndex";

interface CompletedConceptMigration {
  readonly conceptId: string;
  readonly title: string;
  readonly vaultPath: string;
}

function section(container: HTMLElement, title: string): HTMLElement {
  const result = container.createDiv();
  result.style.marginTop = "1rem";
  result.style.paddingTop = "0.75rem";
  result.style.borderTop = "1px solid var(--background-modifier-border)";
  result.createEl("h3", { text: title });
  return result;
}

function readonlyText(container: HTMLElement, text: string): HTMLElement {
  const value = container.createEl("div", { text });
  value.style.whiteSpace = "pre-wrap";
  value.style.userSelect = "text";
  value.style.padding = "0.5rem";
  value.style.borderRadius = "4px";
  value.style.backgroundColor = "var(--background-secondary)";
  return value;
}

function actionRow(container: HTMLElement): HTMLElement {
  const actions = container.createDiv();
  actions.style.display = "flex";
  actions.style.flexWrap = "wrap";
  actions.style.justifyContent = "flex-end";
  actions.style.gap = "0.5rem";
  actions.style.marginTop = "1rem";
  return actions;
}

function button(
  container: HTMLElement,
  label: string,
  onClick: () => void,
  cssClass?: string
): HTMLButtonElement {
  const control = container.createEl("button", { text: label });
  if (cssClass !== undefined) {
    control.addClass(cssClass);
  }
  control.addEventListener("click", onClick);
  return control;
}

function describeCollision(
  value: Readonly<ConceptMigrationLabelCollision>
): string {
  return `${value.title} - ID: ${value.conceptId} - Matching labels: ${
    value.matchedLabels.join(", ")
  }`;
}

function shouldRefreshIndexAfterFailure(
  code: ConceptMigrationWriteFailureCode
): boolean {
  return code === "conflicting_identity" ||
    code === "label_collisions_changed" ||
    code === "identity_check_incomplete" ||
    code === "identity_check_changed";
}

/**
 * Load one ordinary note and open an explicit migration review. Loading never
 * prepares or writes a ConceptNode.
 */
export async function openConceptMigrationWorkspace(
  app: App,
  discovered: ObsidianConceptIndexResult,
  vaultPath: string
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  const loaded = await loadOrdinaryNoteForMigration(app, vaultPath);
  if (!loaded.ok) {
    return Object.freeze({ ok: false, error: loaded.error });
  }
  new ConceptMigrationWorkspaceModal(
    app,
    discovered,
    loaded.vaultPath,
    loaded.markdown
  ).open();
  return Object.freeze({ ok: true });
}

export class ConceptMigrationWorkspaceModal extends Modal {
  private conceptId: string;
  private title: string;
  private aliasesText: string;
  private userDefinitionText: string;
  private userEvidenceText: string;
  private generatedInterpretationText: string;
  private standardDefinitionText: string;
  private unresolvedMaterialText: string;
  private prepared?: PreparedConceptMigration;
  private completed?: CompletedConceptMigration;
  private statusMessage = "";
  private statusError = false;
  private isConfirming = false;

  constructor(
    app: App,
    private discovered: ObsidianConceptIndexResult,
    private readonly sourceVaultPath: string,
    private readonly sourceMarkdown: string
  ) {
    super(app);
    const draft = createConceptMigrationDraft({
      sourceVaultPath,
      sourceMarkdown
    });
    this.conceptId = draft.conceptId;
    this.title = draft.title;
    this.aliasesText = draft.aliases.join("\n");
    this.userDefinitionText = draft.userDefinitionText;
    this.userEvidenceText = draft.userEvidenceText;
    this.generatedInterpretationText = draft.generatedInterpretationText;
    this.standardDefinitionText = draft.standardDefinitionText;
    this.unresolvedMaterialText = draft.unresolvedMaterialText;
  }

  onOpen(): void {
    this.modalEl.style.width = "min(900px, 92vw)";
    this.modalEl.style.maxWidth = "900px";
    this.contentEl.style.maxHeight = "78vh";
    this.contentEl.style.overflowY = "auto";
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();
    if (this.completed !== undefined) {
      this.renderCompletion();
      return;
    }
    if (this.prepared !== undefined) {
      this.renderReview();
      return;
    }
    this.renderEditor();
  }

  private renderStatus(): void {
    const status = this.contentEl.createEl("p", { text: this.statusMessage });
    status.setAttr("data-migration-status", "true");
    status.style.minHeight = "1.4em";
    status.style.color = this.statusError
      ? "var(--text-error)"
      : "var(--text-success)";
  }

  private renderEditor(): void {
    this.setTitle("Prepare Concept Migration");
    const source = section(this.contentEl, "Source note");
    source.createEl("div", { text: `Vault path: ${this.sourceVaultPath}` });
    const sourcePreview = readonlyText(source, this.sourceMarkdown);
    sourcePreview.setAttr("data-migration-source-preview", "true");
    sourcePreview.style.maxHeight = "12rem";
    sourcePreview.style.overflowY = "auto";

    const identity = section(this.contentEl, "Stable identity");
    new Setting(identity)
      .setName("Concept ID")
      .setDesc("Enter the stable identity explicitly.")
      .addText((text) => {
        text.setValue(this.conceptId);
        text.onChange((value) => {
          this.conceptId = value;
        });
      });
    new Setting(identity)
      .setName("Title")
      .setDesc("The title is a display handle, not the concept identity.")
      .addText((text) => {
        text.setValue(this.title);
        text.onChange((value) => {
          this.title = value;
        });
      });
    this.renderTextarea(
      identity,
      "Aliases",
      "Concept aliases",
      this.aliasesText,
      (value) => {
        this.aliasesText = value;
      },
      "One alias per line or comma-separated."
    );

    const mapping = section(this.contentEl, "Semantic layer mapping");
    this.renderTextarea(
      mapping,
      "Personal definition - authoritative",
      "Personal definition mapping",
      this.userDefinitionText,
      (value) => {
        this.userDefinitionText = value;
      }
    );
    this.renderTextarea(
      mapping,
      "Exact user evidence - not yet a definition",
      "User evidence mapping",
      this.userEvidenceText,
      (value) => {
        this.userEvidenceText = value;
      }
    );
    this.renderTextarea(
      mapping,
      "Generated / AI interpretation - non-authoritative",
      "Generated interpretation mapping",
      this.generatedInterpretationText,
      (value) => {
        this.generatedInterpretationText = value;
      }
    );
    this.renderTextarea(
      mapping,
      "Standard / external meaning - non-authoritative",
      "Standard definition mapping",
      this.standardDefinitionText,
      (value) => {
        this.standardDefinitionText = value;
      }
    );
    this.renderTextarea(
      mapping,
      "Unresolved / ambiguous material",
      "Unresolved material mapping",
      this.unresolvedMaterialText,
      (value) => {
        this.unresolvedMaterialText = value;
      }
    );

    this.renderStatus();
    const actions = actionRow(this.contentEl);
    button(actions, "Cancel", () => this.close());
    button(actions, "Preview", () => this.preparePreview(), "mod-cta");
  }

  private renderTextarea(
    container: HTMLElement,
    label: string,
    ariaLabel: string,
    value: string,
    onInput: (value: string) => void,
    description?: string
  ): void {
    const field = container.createDiv();
    field.style.marginTop = "0.75rem";
    field.createEl("strong", { text: label });
    if (description !== undefined) {
      field.createEl("div", { text: description });
    }
    const editor = field.createEl("textarea");
    editor.value = value;
    editor.setAttr("aria-label", ariaLabel);
    editor.style.width = "100%";
    editor.style.minHeight = "5rem";
    editor.style.boxSizing = "border-box";
    editor.addEventListener("input", () => onInput(editor.value));
  }

  private aliases(): readonly string[] {
    return this.aliasesText.split(/[\n,]/u)
      .map((value) => value.trim())
      .filter((value) => value !== "");
  }

  private currentDraft(): ConceptMigrationDraft {
    return Object.freeze({
      conceptId: this.conceptId,
      title: this.title,
      aliases: Object.freeze([...this.aliases()]),
      userDefinitionText: this.userDefinitionText,
      userEvidenceText: this.userEvidenceText,
      generatedInterpretationText: this.generatedInterpretationText,
      standardDefinitionText: this.standardDefinitionText,
      unresolvedMaterialText: this.unresolvedMaterialText
    });
  }

  private preparePreview(): void {
    const result = prepareConceptMigration({
      sourceVaultPath: this.sourceVaultPath,
      sourceMarkdown: this.sourceMarkdown,
      draft: this.currentDraft(),
      knownConcepts: this.discovered.index.concepts,
      preparedAt: new Date().toISOString()
    });
    if (result.kind === "prepared") {
      this.prepared = result;
      this.statusMessage = "";
      this.statusError = false;
    } else {
      this.statusMessage = result.message;
      this.statusError = true;
    }
    this.render();
  }

  private renderReview(): void {
    const prepared = this.prepared;
    if (prepared === undefined) {
      return;
    }
    this.setTitle("Review Concept Migration");
    this.contentEl.createEl("p", {
      text: "The source note has not been modified."
    });
    const identity = section(this.contentEl, "Proposed ConceptNode");
    identity.createEl("div", { text: `Stable ID: ${prepared.concept.id}` });
    identity.createEl("div", { text: `Title: ${prepared.concept.title}` });
    identity.createEl("div", { text: `Vault path: ${prepared.sourceVaultPath}` });

    this.renderMappedLayers(prepared);
    this.renderCollisions(prepared);

    const diff = section(this.contentEl, "Semantic migration diff");
    diff.setAttr("data-migration-diff", "true");
    for (const item of prepared.diff) {
      const row = diff.createDiv();
      row.style.padding = "0.75rem 0";
      row.style.borderBottom = "1px solid var(--background-modifier-border)";
      row.createEl("strong", { text: item.label });
      row.createEl("div", { text: "Before" });
      readonlyText(row, item.before);
      row.createEl("div", { text: "After" });
      readonlyText(row, item.after);
    }

    const markdown = section(this.contentEl, "Resulting Markdown preview");
    const markdownPreview = readonlyText(markdown, prepared.markdown);
    markdownPreview.setAttr("data-migration-markdown-preview", "true");
    markdownPreview.style.maxHeight = "12rem";
    markdownPreview.style.overflowY = "auto";

    this.renderStatus();
    const actions = actionRow(this.contentEl);
    const back = button(actions, "Back", () => {
      if (this.isConfirming) {
        return;
      }
      this.prepared = undefined;
      this.statusMessage = "";
      this.statusError = false;
      this.render();
    });
    back.disabled = this.isConfirming;
    const cancel = button(actions, "Cancel", () => {
      if (!this.isConfirming) {
        this.close();
      }
    });
    cancel.disabled = this.isConfirming;
    const confirm = button(
      actions,
      "Confirm Migration",
      () => void this.confirmMigration(confirm),
      "mod-cta"
    );
    confirm.disabled = this.isConfirming;
  }

  private renderMappedLayers(prepared: PreparedConceptMigration): void {
    const mapping = section(this.contentEl, "Reviewed semantic mapping");
    const layers = [
      ["Personal definition - authoritative",
        prepared.mapping.userDefinitionText || "None"],
      ["Exact user evidence - not yet a definition",
        prepared.mapping.userEvidenceText || "None"],
      ["Generated / AI interpretation - non-authoritative",
        prepared.mapping.generatedInterpretationText || "None"],
      ["Standard / external meaning - non-authoritative",
        prepared.mapping.standardDefinitionText || "None"],
      ["Unresolved / ambiguous material",
        prepared.mapping.unresolvedMaterialText || "None"]
    ] as const;
    for (const [label, value] of layers) {
      mapping.createEl("strong", { text: label });
      readonlyText(mapping, value);
    }
  }

  private renderCollisions(prepared: PreparedConceptMigration): void {
    if (prepared.labelCollisions.length === 0) {
      return;
    }
    const collisions = section(this.contentEl, "Label collisions");
    collisions.createEl("p", {
      text: "These concepts share a title or alias. They remain distinct identities."
    });
    const list = collisions.createEl("ul");
    for (const collision of prepared.labelCollisions) {
      list.createEl("li", { text: describeCollision(collision) });
    }
  }

  private async confirmMigration(control: HTMLButtonElement): Promise<void> {
    const prepared = this.prepared;
    if (prepared === undefined || this.isConfirming) {
      return;
    }
    this.isConfirming = true;
    control.disabled = true;
    this.render();
    let result: ConceptMigrationWriteResult;
    try {
      result = await persistConfirmedConceptMigration(this.app, {
        prepared,
        confirmation: {
          kind: "confirmed_concept_migration",
          confirmedAt: new Date().toISOString(),
          migrationId: prepared.migrationId,
          sourceVaultPath: prepared.sourceVaultPath,
          conceptId: prepared.concept.id
        }
      });
    } catch {
      this.statusMessage = "Concept migration confirmation failed.";
      this.statusError = true;
      this.isConfirming = false;
      this.render();
      return;
    }
    if (!result.ok) {
      if (shouldRefreshIndexAfterFailure(result.code)) {
        try {
          this.discovered = await loadObsidianConceptIndex(
            this.app,
            { freshRead: true }
          );
        } catch {
          // Preserve the typed confirmation failure and the last complete index.
        }
      }
      this.statusMessage = result.error;
      this.statusError = true;
      this.isConfirming = false;
      this.render();
      return;
    }

    try {
      this.discovered = await loadObsidianConceptIndex(
        this.app,
        { freshRead: true }
      );
      this.completed = Object.freeze({
        conceptId: prepared.concept.id,
        title: prepared.concept.title,
        vaultPath: prepared.sourceVaultPath
      });
      this.prepared = undefined;
      this.statusMessage = "Concept migration complete.";
      this.statusError = false;
    } catch {
      this.completed = Object.freeze({
        conceptId: prepared.concept.id,
        title: prepared.concept.title,
        vaultPath: prepared.sourceVaultPath
      });
      this.prepared = undefined;
      this.statusMessage =
        "Concept migration complete, but the concept index could not reload.";
      this.statusError = true;
    }
    this.isConfirming = false;
    this.render();
  }

  private renderCompletion(): void {
    const completed = this.completed;
    if (completed === undefined) {
      return;
    }
    this.setTitle("Concept Migration Complete");
    this.renderStatus();
    const details = section(this.contentEl, completed.title);
    details.createEl("div", { text: `Stable ID: ${completed.conceptId}` });
    details.createEl("div", { text: `Vault path: ${completed.vaultPath}` });
    const actions = actionRow(this.contentEl);
    button(actions, "Close", () => this.close(), "mod-cta");
  }
}
