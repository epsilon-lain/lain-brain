import { App, Modal, Setting } from "obsidian";
import type { ConceptNode, ConceptRelationship } from "./BrainGrowth";
import { getConceptMeaningStatus } from "./BrainGrowth";
import { lookupConcept } from "./BrainGrowthIndex";
import { diagnoseBrain } from "./BrainDiagnostics";
import {
  createConceptMaintenanceDraft,
  createMaintenanceRelationship,
  findConceptsSharingLabels,
  prepareConceptMaintenanceDraft,
  prepareConceptMaintenanceRestore,
  type PersonalDefinitionSource,
  type PreparedConceptWorkspaceChange
} from "./BrainMaintenanceWorkspace";
import {
  loadObsidianConceptIndex,
  type ObsidianConceptIndexResult,
  type VaultConceptRecord
} from "./ObsidianConceptIndex";
import {
  loadConceptForMaintenance,
  persistConfirmedConceptUpdate
} from "./ObsidianConceptMaintenance";
import {
  confirmSemanticDelta,
  proposePrincipalSemanticDelta
} from "./SemanticDelta";
import type {
  SemanticPropagationCoordinator
} from "./SemanticPropagationCoordinator";

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

export async function openConceptMaintenanceWorkspace(
  app: App,
  semanticPropagation?: SemanticPropagationCoordinator
): Promise<void> {
  const result = await loadObsidianConceptIndex(app);
  new ConceptMaintenanceLookupModal(
    app,
    result,
    semanticPropagation
  ).open();
}

export class ConceptMaintenanceLookupModal extends Modal {
  private query = "";
  private resultsEl?: HTMLElement;
  private messageEl?: HTMLElement;

  constructor(
    app: App,
    private readonly discovered: ObsidianConceptIndexResult,
    private readonly semanticPropagation?: SemanticPropagationCoordinator
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Open Concept Maintenance");
    this.contentEl.empty();

    new Setting(this.contentEl)
      .setName("Concept ID, title, or alias")
      .setDesc("Ambiguous labels remain separate choices.")
      .addText((text) => {
        text.setValue(this.query);
        text.onChange((value) => {
          this.query = value;
        });
      });

    const actions = actionRow(this.contentEl);
    button(actions, "Use Active Note", () => {
      const path = this.app.workspace.getActiveFile()?.path;
      if (path === undefined) {
        this.setMessage("No active Markdown note.");
        return;
      }
      void this.openPath(path);
    });
    button(actions, "Find Concept", () => this.renderLookup(), "mod-cta");

    this.messageEl = this.contentEl.createEl("p");
    this.messageEl.style.color = "var(--text-muted)";
    this.resultsEl = this.contentEl.createDiv();
    this.renderAll();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private setMessage(value: string, error = false): void {
    this.messageEl?.setText(value);
    if (this.messageEl !== undefined) {
      this.messageEl.style.color = error
        ? "var(--text-error)"
        : "var(--text-muted)";
    }
  }

  private renderAll(): void {
    if (this.discovered.records.length === 0) {
      this.setMessage("No ConceptNode notes were found.");
      this.resultsEl?.empty();
      return;
    }
    this.setMessage(
      `${this.discovered.records.length} concept notes available.`
    );
    this.renderRecords(this.discovered.records);
  }

  private renderLookup(): void {
    const query = this.query.trim();
    if (query === "") {
      this.renderAll();
      return;
    }
    const result = lookupConcept(this.discovered.index, query);
    if (result.kind === "not_found") {
      this.setMessage("No concept matches this query.", true);
      this.resultsEl?.empty();
      return;
    }
    const concepts = result.kind === "unique_match"
      ? [result.match.concept]
      : result.matches.map((match) => match.concept);
    const records = concepts.flatMap((concept) =>
      this.discovered.records.filter((record) => record.concept === concept)
    );
    this.setMessage(
      result.kind === "ambiguous_matches"
        ? "Multiple concepts use this label. Choose by stable ID and path."
        : "One concept found."
    );
    this.renderRecords(records);
  }

  private renderRecords(records: readonly VaultConceptRecord[]): void {
    if (this.resultsEl === undefined) {
      return;
    }
    this.resultsEl.empty();
    for (const record of records) {
      const card = this.resultsEl.createDiv();
      card.style.padding = "0.6rem";
      card.style.marginBottom = "0.5rem";
      card.style.border = "1px solid var(--background-modifier-border)";
      card.style.borderRadius = "4px";
      card.createEl("strong", { text: record.concept.title });
      card.createEl("div", { text: `ID: ${record.concept.id}` });
      card.createEl("div", { text: record.vaultPath });
      button(card, "Open", () => void this.openPath(record.vaultPath));
    }
  }

  private async openPath(vaultPath: string): Promise<void> {
    const loaded = await loadConceptForMaintenance(this.app, vaultPath);
    if (!loaded.ok) {
      this.setMessage(loaded.error, true);
      return;
    }
    this.close();
    new ConceptMaintenanceWorkspaceModal(
      this.app,
      this.discovered,
      loaded.vaultPath,
      loaded.markdown,
      loaded.persisted.conceptNode,
      this.semanticPropagation
    ).open();
  }
}

export class ConceptMaintenanceWorkspaceModal extends Modal {
  private definitionText: string;
  private definitionSource: PersonalDefinitionSource = { kind: "existing" };
  private aliasesText: string;
  private relationships: ConceptRelationship[];
  private readonly resolveItemIds = new Set<string>();
  private newRelation = "related_to";
  private newRelationTargetId = "";
  private prepared?: Extract<PreparedConceptWorkspaceChange, { kind: "updated" }>;
  private statusMessage = "";
  private statusError = false;

  constructor(
    app: App,
    private discovered: ObsidianConceptIndexResult,
    private readonly vaultPath: string,
    private markdown: string,
    private concept: ConceptNode,
    private readonly semanticPropagation?: SemanticPropagationCoordinator
  ) {
    super(app);
    const draft = createConceptMaintenanceDraft(concept);
    this.definitionText = draft.personalDefinitionText;
    this.aliasesText = draft.aliases.join("\n");
    this.relationships = [...draft.relationships];
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
    this.setTitle(`Concept Maintenance — ${this.concept.title}`);
    this.contentEl.empty();
    if (this.prepared !== undefined) {
      this.renderReview();
    } else {
      this.renderInspection();
    }
  }

  private renderStatus(): void {
    const status = this.contentEl.createEl("p", { text: this.statusMessage });
    status.setAttr("data-maintenance-status", "true");
    status.style.minHeight = "1.4em";
    status.style.color = this.statusError
      ? "var(--text-error)"
      : "var(--text-success)";
  }

  private renderInspection(): void {
    const metadata = this.contentEl.createDiv();
    metadata.createEl("div", { text: `Stable ID: ${this.concept.id}` });
    metadata.createEl("div", { text: `Vault path: ${this.vaultPath}` });
    metadata.createEl("div", { text: `Revision: ${this.concept.revision}` });
    metadata.createEl("div", {
      text: `Meaning status: ${getConceptMeaningStatus(this.concept)}`
    });
    this.renderStatus();
    this.renderDiagnostics();
    this.renderStructuralConflicts();
    this.renderPendingDecisions();
    this.renderPersonalMeaning();
    this.renderSemanticLayers();
    this.renderRelationships();
    this.renderAmbiguity();
    this.renderHistory();

    const actions = actionRow(this.contentEl);
    button(actions, "Cancel", () => this.close());
    button(actions, "Prepare Review", () => this.prepareUpdate(), "mod-cta");
  }

  private renderDiagnostics(): void {
    const diagnostics = diagnoseBrain(
      this.discovered.index.concepts,
      [],
      this.semanticPropagation?.getState()
    ).issues
      .filter((item) => item.conceptIds.includes(this.concept.id));
    const shared = findConceptsSharingLabels(
      this.discovered.index.concepts,
      this.concept
    );
    if (diagnostics.length === 0 && shared.length === 0) {
      return;
    }
    const container = section(this.contentEl, "Diagnostics");
    if (shared.length > 0) {
      container.createEl("p", {
        text: "Other concepts use the same label. This does not mean they are the same concept."
      });
      const list = container.createEl("ul");
      for (const concept of shared) {
        list.createEl("li", { text: `${concept.title} — ${concept.id}` });
      }
    }
    const list = container.createEl("ul");
    for (const diagnostic of diagnostics) {
      list.createEl("li", { text: diagnostic.message });
    }
  }

  private renderPendingDecisions(): void {
    if (this.semanticPropagation === undefined) {
      return;
    }
    const state = this.semanticPropagation.getState();
    const decisions = state.pendingDecisions.filter((decision) =>
      decision.status === "pending" &&
      decision.kind !== "structural_conflict" &&
      decision.affectedConceptIds.includes(this.concept.id)
    );
    if (decisions.length === 0) {
      return;
    }
    const container = section(this.contentEl, "Pending semantic decisions");
    container.createEl("p", {
      text:
        "Propagation stopped here because another personal semantic decision may be required."
    });
    for (const decision of decisions) {
      const card = container.createDiv();
      card.createEl("strong", { text: decision.reason });
      card.createEl("div", { text: `Originating delta: ${decision.deltaId}` });
      card.createEl("div", {
        text: `Affected concepts: ${decision.affectedConceptIds.join(", ")}`
      });
      const actions = actionRow(card);
      button(actions, "Mark Resolved", () => {
        void this.resolveDecision(decision.id, "resolved");
      });
      button(actions, "Dismiss", () => {
        void this.resolveDecision(decision.id, "dismissed");
      });
    }
  }

  private renderStructuralConflicts(): void {
    if (this.semanticPropagation === undefined) return;
    const conflicts = (this.semanticPropagation.getState().structuralConflicts ?? [])
      .filter((conflict) =>
        conflict.status !== "superseded" &&
        conflict.affectedConceptIds.includes(this.concept.id)
      );
    if (conflicts.length === 0) return;
    const container = section(this.contentEl, "Structural conflicts");
    container.createEl("p", {
      text:
        "These deterministic diagnostics preserve both sides until you make an explicit semantic decision."
    });
    for (const conflict of conflicts) {
      const card = container.createDiv();
      card.setAttr("data-structural-conflict-id", conflict.id);
      card.createEl("strong", {
        text: conflict.category === "hard_conflict"
          ? "Potential structural conflict detected."
          : "Structural integrity review"
      });
      card.createEl("div", { text: conflict.reason });
      card.createEl("div", {
        text: `Status: ${conflict.status}`
      });
      card.createEl("div", {
        text: `Affected concepts: ${conflict.affectedConceptIds.join(", ")}`
      });
      const details = card.createDiv();
      details.setAttr("data-structural-conflict-details", conflict.id);
      details.style.display = "none";
      details.createEl("div", { text: `Conflict rule: ${conflict.ruleId}` });
      for (const relation of conflict.relationshipEvidence) {
        details.createEl("div", {
          text:
            `${relation.ownerConceptId}: ${relation.relationType} → ${relation.targetConceptId} (${relation.relationshipId})`
        });
      }
      if (conflict.provenance.originatingSemanticDeltaIds.length > 0) {
        details.createEl("div", {
          text:
            `Originating SemanticDelta: ${conflict.provenance.originatingSemanticDeltaIds.join(", ")}`
        });
      }
      const actions = actionRow(card);
      button(actions, "Inspect", () => {
        details.style.display = details.style.display === "none" ? "block" : "none";
      });
      if (conflict.status === "open") {
        button(actions, "Dismiss", () => {
          void this.dismissConflict(conflict.id);
        });
      }
    }
  }

  private async dismissConflict(conflictId: string): Promise<void> {
    if (this.semanticPropagation === undefined) return;
    await this.semanticPropagation.dismissStructuralConflict(
      conflictId,
      new Date().toISOString(),
      `concept-maintenance:${this.concept.id}`
    );
    this.statusMessage = "Structural conflict dismissed.";
    this.statusError = false;
    this.render();
  }

  private async resolveDecision(
    decisionId: string,
    status: "resolved" | "dismissed"
  ): Promise<void> {
    if (this.semanticPropagation === undefined) {
      return;
    }
    await this.semanticPropagation.resolveDecision(decisionId, status);
    this.statusMessage = status === "resolved"
      ? "Pending semantic decision marked resolved."
      : "Pending semantic decision dismissed.";
    this.statusError = false;
    this.render();
  }

  private renderPersonalMeaning(): void {
    const container = section(this.contentEl, "Personal meaning — authoritative");
    container.createEl("p", {
      text:
        "Only text you explicitly prepare and confirm here becomes the personal definition."
    });
    const editor = container.createEl("textarea");
    editor.value = this.definitionText;
    editor.setAttr("aria-label", "Personal definition");
    editor.style.width = "100%";
    editor.style.minHeight = "8rem";
    editor.style.boxSizing = "border-box";
    editor.addEventListener("input", () => {
      this.definitionText = editor.value;
      this.definitionSource = { kind: "maintenance_input" };
    });

    if (this.concept.userEvidence.length > 0) {
      container.createEl("h4", { text: "Exact preserved user evidence" });
      for (const evidence of this.concept.userEvidence) {
        const card = container.createDiv();
        readonlyText(card, evidence.snapshot);
        button(card, "Use Exact Evidence", () => {
          this.definitionText = evidence.snapshot;
          this.definitionSource = { kind: "user_evidence", evidence };
          this.render();
        });
      }
    }
    if (this.concept.alternativeUserDefinitions.length > 0) {
      container.createEl("h4", { text: "Preserved definition alternatives" });
      for (const alternative of this.concept.alternativeUserDefinitions) {
        const card = container.createDiv();
        readonlyText(card, alternative.text);
        button(card, "Choose as Personal Definition", () => {
          this.definitionText = alternative.text;
          this.definitionSource = {
            kind: "user_evidence",
            evidence: alternative.sourceRefs[0] ?? {
              sourceKind: "user_edit",
              editId: alternative.id,
              snapshot: alternative.text,
              actor: "user"
            }
          };
          this.render();
        });
      }
    }
  }

  private renderSemanticLayers(): void {
    const ai = section(this.contentEl, "AI interpretation — non-authoritative");
    ai.createEl("p", {
      text: "Generated interpretation is reference material and is never promoted automatically."
    });
    if (this.concept.generatedInterpretations.length === 0) {
      readonlyText(ai, "None");
    } else {
      for (const entry of this.concept.generatedInterpretations) {
        readonlyText(ai, entry.text);
      }
    }

    const external = section(
      this.contentEl,
      "External / standard meaning — non-authoritative"
    );
    if (this.concept.standardDefinitions.length === 0) {
      readonlyText(external, "None");
    } else {
      for (const entry of this.concept.standardDefinitions) {
        readonlyText(external, entry.text);
      }
    }

    const aliases = section(this.contentEl, "Aliases");
    const aliasEditor = aliases.createEl("textarea");
    aliasEditor.value = this.aliasesText;
    aliasEditor.setAttr("aria-label", "Concept aliases");
    aliasEditor.style.width = "100%";
    aliasEditor.style.minHeight = "4rem";
    aliasEditor.addEventListener("input", () => {
      this.aliasesText = aliasEditor.value;
    });
    aliases.createEl("p", { text: "Enter one alias per line or separate with commas." });
  }

  private renderRelationships(): void {
    const container = section(this.contentEl, "Relationships");
    if (this.relationships.length === 0) {
      container.createEl("p", { text: "No relationships." });
    }
    for (const relationship of this.relationships) {
      const row = new Setting(container)
        .setName(`${relationship.relation} → ${relationship.targetLabel}`)
        .setDesc(`Target ID: ${relationship.targetConceptId}`);
      row.addButton((control) => control
        .setButtonText("Remove")
        .onClick(() => {
          this.relationships = this.relationships.filter(
            (item) => item.id !== relationship.id
          );
          this.render();
        }));
    }

    new Setting(container)
      .setName("Relation type")
      .addText((text) => {
        text.setValue(this.newRelation);
        text.onChange((value) => {
          this.newRelation = value;
        });
      });
    new Setting(container)
      .setName("Target concept")
      .setDesc("Same-label concepts remain separate stable-ID choices.")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "Choose a concept");
        for (const concept of this.discovered.index.concepts) {
          const identityCount = this.discovered.index.concepts.filter(
            (candidate) => candidate.id === concept.id
          ).length;
          if (concept.id !== this.concept.id && identityCount === 1) {
            dropdown.addOption(
              concept.id,
              `${concept.title} — ${concept.id}`
            );
          }
        }
        dropdown.setValue(this.newRelationTargetId);
        dropdown.onChange((value) => {
          this.newRelationTargetId = value;
        });
      });
    button(container, "Add Relationship", () => this.addRelationship());
  }

  private addRelationship(): void {
    const targets = this.discovered.index.concepts.filter(
      (concept) => concept.id === this.newRelationTargetId
    );
    const target = targets.length === 1 ? targets[0] : undefined;
    if (target === undefined) {
      this.statusMessage = "Choose an exact target concept.";
      this.statusError = true;
      this.render();
      return;
    }
    try {
      const relationship = createMaintenanceRelationship({
        sourceConceptId: this.concept.id,
        relation: this.newRelation,
        targetConceptId: target.id,
        targetLabel: target.title
      });
      if (!this.relationships.some((item) =>
        item.relation === relationship.relation &&
        item.targetConceptId === relationship.targetConceptId
      )) {
        this.relationships = [...this.relationships, relationship];
      }
      this.newRelationTargetId = "";
      this.statusMessage = "Relationship added to the draft only.";
      this.statusError = false;
    } catch {
      this.statusMessage = "Relation type and target are required.";
      this.statusError = true;
    }
    this.render();
  }

  private renderAmbiguity(): void {
    const open = this.concept.unresolvedItems.filter(
      (item) => item.status === "open"
    );
    if (open.length === 0) {
      return;
    }
    const container = section(this.contentEl, "Unresolved ambiguity");
    container.createEl("p", {
      text: "Leaving any item unresolved is valid. Diagnostics never auto-fix it."
    });
    for (const item of open) {
      const setting = new Setting(container)
        .setName(`${item.kind}: ${item.text}`)
        .setDesc(item.alternatives.join(" · ") || "No proposed alternatives");
      if (item.kind === "meaning" || item.kind === "interpretation_conflict") {
        setting.addToggle((toggle) => {
          toggle.setValue(this.resolveItemIds.has(item.id));
          toggle.onChange((value) => {
            if (value) {
              this.resolveItemIds.add(item.id);
            } else {
              this.resolveItemIds.delete(item.id);
            }
          });
        });
      }
    }
  }

  private renderHistory(): void {
    const container = section(this.contentEl, "Revision history");
    container.createEl("p", {
      text:
        "Restoring an earlier semantic state creates a new revision; history is not erased."
    });
    if (this.concept.history.length === 0) {
      container.createEl("p", { text: "No previous revisions." });
      return;
    }
    for (const entry of this.concept.history) {
      const card = container.createDiv();
      card.style.marginBottom = "0.75rem";
      card.createEl("strong", { text: `Revision ${entry.revision}` });
      card.createEl("div", { text: entry.reason });
      readonlyText(
        card,
        entry.snapshot.userDefinition?.text ?? "No personal definition"
      );
      button(card, "Prepare Restore", () => {
        this.prepareRestore(entry.revision);
      });
    }
  }

  private splitAliases(): string[] {
    return this.aliasesText.split(/[\n,]/u).map((value) => value.trim())
      .filter((value) => value !== "");
  }

  private prepareUpdate(): void {
    const base = createConceptMaintenanceDraft(this.concept);
    const result = prepareConceptMaintenanceDraft({
      markdown: this.markdown,
      concept: this.concept,
      draft: {
        ...base,
        personalDefinitionText: this.definitionText,
        personalDefinitionSource: this.definitionSource,
        aliases: this.splitAliases(),
        relationships: this.relationships,
        resolveUnresolvedItemIds: [...this.resolveItemIds]
      },
      reviewedAt: new Date().toISOString()
    });
    this.handlePreparation(result);
  }

  private prepareRestore(revision: number): void {
    this.handlePreparation(prepareConceptMaintenanceRestore({
      markdown: this.markdown,
      concept: this.concept,
      restoreRevision: revision,
      reviewedAt: new Date().toISOString()
    }));
  }

  private handlePreparation(result: PreparedConceptWorkspaceChange): void {
    if (result.kind === "updated") {
      this.prepared = result;
      this.statusMessage = "";
      this.statusError = false;
    } else {
      this.statusMessage = result.kind === "no_change"
        ? "No semantic changes to review."
        : result.message;
      this.statusError = result.kind === "failed";
    }
    this.render();
  }

  private renderReview(): void {
    const prepared = this.prepared;
    if (prepared === undefined) {
      return;
    }
    this.contentEl.createEl("p", {
      text:
        "Review every semantic change. The Vault has not been modified yet."
    });
    const principal = proposePrincipalSemanticDelta({
      previous: prepared.previous,
      next: prepared.concept,
      proposedAt: prepared.concept.updatedAt,
      originRef: this.vaultPath,
      reason: "Explicit Concept Maintenance workspace confirmation"
    });
    this.contentEl.createEl("p", {
      text: principal.kind === "proposed"
        ? `Principal SemanticDelta: ${principal.delta.kind}`
        : "No propagating SemanticDelta is required for this reviewed update."
    });
    const list = this.contentEl.createDiv();
    list.setAttr("data-maintenance-diff", "true");
    for (const item of prepared.diff) {
      const card = list.createDiv();
      card.style.padding = "0.75rem";
      card.style.marginBottom = "0.5rem";
      card.style.border = "1px solid var(--background-modifier-border)";
      card.createEl("strong", { text: item.label });
      card.createEl("div", { text: "Before" });
      readonlyText(card, item.before);
      card.createEl("div", { text: "After" });
      readonlyText(card, item.after);
    }
    this.renderStatus();
    const actions = actionRow(this.contentEl);
    button(actions, "Back", () => {
      this.prepared = undefined;
      this.render();
    });
    button(actions, "Cancel", () => this.close());
    const confirm = button(
      actions,
      "Confirm Update",
      () => void this.confirmUpdate(confirm),
      "mod-cta"
    );
  }

  private async confirmUpdate(control: HTMLButtonElement): Promise<void> {
    const prepared = this.prepared;
    if (prepared === undefined) {
      return;
    }
    control.disabled = true;
    const confirmedAt = new Date().toISOString();
    const proposed = proposePrincipalSemanticDelta({
      previous: prepared.previous,
      next: prepared.concept,
      proposedAt: prepared.concept.updatedAt,
      originRef: this.vaultPath,
      reason: "Explicit Concept Maintenance workspace confirmation"
    });
    const confirmed = proposed.kind === "proposed"
      ? confirmSemanticDelta(proposed.delta, {
          kind: "explicit_semantic_delta_confirmation",
          confirmedAt,
          confirmation: {
            kind: "maintenance_confirmation",
            confirmationId: `maintenance-confirmation:${proposed.delta.id}`,
            interactionRef: this.vaultPath,
            userEvidence:
              prepared.concept.userDefinition?.sourceRefs ?? []
          }
        })
      : undefined;
    if (confirmed?.kind === "invalid_confirmation") {
      this.statusMessage = confirmed.message;
      this.statusError = true;
      this.render();
      return;
    }
    if (
      confirmed?.kind === "confirmed" &&
      this.semanticPropagation !== undefined
    ) {
      const recorded = await this.semanticPropagation.recordConfirmedDelta(
        confirmed.delta,
        this.vaultPath
      );
      if (!recorded) {
        this.statusMessage =
          "SemanticDelta could not be persisted; no concept update was written.";
        this.statusError = true;
        this.render();
        return;
      }
    }
    const result = await persistConfirmedConceptUpdate(this.app, {
      vaultPath: this.vaultPath,
      conceptId: this.concept.id,
      expectedRevision: this.concept.revision,
      expectedMarkdown: this.markdown,
      preparedMarkdown: prepared.markdown
    });
    if (!result.ok) {
      if (
        confirmed?.kind === "confirmed" &&
        this.semanticPropagation !== undefined
      ) {
        try {
          await this.semanticPropagation.markOriginWriteFailed(
            confirmed.delta.id
          );
        } catch {
          // The persisted awaiting job is recovered conservatively on reload.
        }
      }
      this.statusMessage = result.error;
      this.statusError = true;
      control.disabled = false;
      this.render();
      return;
    }
    let propagationDeferred = false;
    if (
      confirmed?.kind === "confirmed" &&
      this.semanticPropagation !== undefined
    ) {
      try {
        await this.semanticPropagation.markOriginCommittedAndEnqueue(
          confirmed.delta.id
        );
      } catch {
        propagationDeferred = true;
      }
    }
    const reloaded = await loadConceptForMaintenance(this.app, this.vaultPath);
    if (!reloaded.ok) {
      this.statusMessage = "Concept updated, but the workspace could not reload it.";
      this.statusError = true;
      this.prepared = undefined;
      this.render();
      return;
    }
    this.discovered = await loadObsidianConceptIndex(this.app);
    this.markdown = reloaded.markdown;
    this.concept = reloaded.persisted.conceptNode;
    const draft = createConceptMaintenanceDraft(this.concept);
    this.definitionText = draft.personalDefinitionText;
    this.definitionSource = { kind: "existing" };
    this.aliasesText = draft.aliases.join("\n");
    this.relationships = [...draft.relationships];
    this.resolveItemIds.clear();
    this.prepared = undefined;
    this.statusMessage = propagationDeferred
      ? `Concept updated to revision ${result.revision}; propagation remains incomplete.`
      : `Concept updated to revision ${result.revision}.`;
    this.statusError = propagationDeferred;
    this.render();
  }
}
