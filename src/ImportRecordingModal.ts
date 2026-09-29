import {
  App,
  Modal,
  Notice
} from "obsidian";
import { LainBrainSession } from "./LainBrainSession";
import type {
  RecordingFile,
  RecordingImportStage,
  RecordingTranscript
} from "./AssemblyAIFileTranscription";

const ACCEPTED_EXTENSIONS =
  ".mp3,.wav,.m4a,.mp4,.mov,.webm";
const ACCEPTED_TYPES =
  "audio/mpeg,audio/wav,audio/mp4,video/mp4,video/quicktime,video/webm";
const DEFAULT_ANALYSIS_QUESTION =
  "Summarize this recording's main points, decisions, and action items. " +
  "If a category is absent, say so.";

export class ImportRecordingModal extends Modal {
  private statusEl!: HTMLDivElement;
  private editorEl!: HTMLDivElement;
  private titleInput!: HTMLInputElement;
  private transcriptInput!: HTMLTextAreaElement;
  private summaryEl!: HTMLDivElement;
  private transcript: RecordingTranscript | null = null;
  private sourceFileName = "";
  private summary: string | null = null;
  private importToken = 0;
  private busy = false;

  constructor(
    app: App,
    private readonly session: LainBrainSession
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Import recording");
    this.contentEl.createEl("p", {
      text:
        "Choose a local audio or video file. For video, only the audio track is transcribed."
    });

    const pickerRow = this.contentEl.createDiv();
    pickerRow.style.display = "flex";
    pickerRow.style.alignItems = "center";
    pickerRow.style.gap = "0.5rem";
    pickerRow.style.marginBottom = "0.5rem";

    const chooseButton = pickerRow.createEl("button", {
      text: "Choose file"
    });
    const fileInput = pickerRow.createEl("input");
    fileInput.type = "file";
    fileInput.accept = `${ACCEPTED_TYPES},${ACCEPTED_EXTENSIONS}`;
    fileInput.style.display = "none";

    chooseButton.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (file === undefined) return;
      void this.runImport(file);
    });

    this.statusEl = this.contentEl.createDiv();
    this.statusEl.style.fontSize = "0.85rem";
    this.statusEl.style.color = "var(--text-muted)";
    this.statusEl.style.marginBottom = "0.5rem";

    this.editorEl = this.contentEl.createDiv();
    this.editorEl.style.display = "none";
  }

  onClose(): void {
    this.importToken += 1;
    this.session.cancelRecordingImport();
    this.contentEl.empty();
  }

  private async runImport(file: File): Promise<void> {
    this.importToken += 1;
    const token = this.importToken;
    this.session.cancelRecordingImport();
    this.setEditorVisible(false);
    this.setStatus("Reading file…");

    let data: ArrayBuffer;
    try {
      data = await file.arrayBuffer();
    } catch {
      if (token === this.importToken) {
        this.setStatus("Could not read the selected file.");
      }
      return;
    }

    const recording: RecordingFile = { name: file.name, data };
    const result = await this.session.importRecording(
      recording,
      (stage: RecordingImportStage) => {
        if (token !== this.importToken) return;
        if (stage.name === "uploading") {
          this.setStatus(`Uploading… ${stage.detail ?? ""}`);
        } else if (stage.name === "submitting") {
          this.setStatus("Starting transcription…");
        } else if (stage.name === "polling") {
          this.setStatus(`Waiting for transcription… ${stage.detail ?? ""}`);
        }
      }
    );
    if (token !== this.importToken) {
      return;
    }
    if (result.kind === "cancelled") {
      return;
    }
    if (result.kind === "error") {
      this.setStatus(`Transcription failed: ${result.message}`);
      return;
    }

    this.transcript = result.transcript;
    this.sourceFileName = file.name;
    this.summary = null;
    this.renderPreview();
  }

  private renderPreview(): void {
    const transcript = this.transcript;
    if (transcript === null) return;
    this.setStatus("Transcription complete. Review and save.");
    this.editorEl.empty();
    this.editorEl.style.display = "";

    this.editorEl.createEl("strong", { text: "Title" });
    this.titleInput = this.editorEl.createEl("input");
    this.titleInput.type = "text";
    this.titleInput.value =
      this.sourceFileName.replace(/\.[^.]+$/u, "") || "Recording note";
    this.titleInput.style.width = "100%";
    this.titleInput.style.marginTop = "0.2rem";
    this.titleInput.style.marginBottom = "0.5rem";

    this.editorEl.createEl("strong", { text: "Transcript (editable)" });
    this.transcriptInput = this.editorEl.createEl("textarea");
    this.transcriptInput.value = this.formatTranscriptForEditing(transcript);
    this.transcriptInput.style.width = "100%";
    this.transcriptInput.style.minHeight = "10rem";
    this.transcriptInput.style.marginTop = "0.2rem";
    this.transcriptInput.style.marginBottom = "0.5rem";

    this.summaryEl = this.editorEl.createDiv();
    this.summaryEl.style.marginBottom = "0.5rem";
    this.renderSummaryState();

    const summaryButton = this.editorEl.createEl("button", {
      text: "Generate summary"
    });
    summaryButton.addEventListener("click", () => {
      void this.generateSummary();
    });

    const actions = this.editorEl.createDiv();
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.gap = "0.5rem";
    actions.style.marginTop = "0.75rem";

    const cancelButton = actions.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => this.close());

    const saveButton = actions.createEl("button", { text: "Save note" });
    saveButton.addClass("mod-cta");
    saveButton.addEventListener("click", () => {
      void this.saveNote();
    });

    const analyzeButton = actions.createEl("button", {
      text: "Save & analyze with Brain"
    });
    analyzeButton.addClass("mod-cta");
    analyzeButton.addEventListener("click", () => {
      void this.saveAndAnalyze();
    });
  }

  private formatTranscriptForEditing(
    transcript: RecordingTranscript
  ): string {
    if (transcript.utterances.length === 0) {
      return transcript.text;
    }
    return transcript.utterances
      .map((utterance) => {
        const seconds = Math.floor(utterance.startMs / 1000);
        const minutes = Math.floor(seconds / 60);
        const remainder = seconds % 60;
        const pad = (value: number): string =>
          String(value).padStart(2, "0");
        return `[${pad(minutes)}:${pad(remainder)}] ${utterance.speaker}: ${utterance.text}`;
      })
      .join("\n");
  }

  private renderSummaryState(): void {
    if (this.summaryEl === undefined) return;
    this.summaryEl.empty();
    if (this.summary !== null) {
      this.summaryEl.createEl("strong", { text: "Summary: " });
      this.summaryEl.createSpan({ text: this.summary });
    } else {
      this.summaryEl.createSpan({ text: "No summary generated." });
    }
  }

  private async generateSummary(): Promise<void> {
    const transcript = this.transcript;
    if (transcript === null) return;
    this.summaryEl.empty();
    this.summaryEl.createSpan({ text: "Generating summary…" });
    const summary = await this.session.generateRecordingSummary(
      this.transcriptInput.value
    );
    if (summary === null) {
      this.summary = null;
    } else {
      this.summary = summary;
    }
    this.renderSummaryState();
  }

  private async saveNote(): Promise<void> {
    if (this.transcript === null || this.busy) return;
    this.busy = true;
    try {
      const result = await this.persistNote();
      if (result.ok) {
        new Notice("Recording note saved.");
        this.close();
        return;
      }
      this.setStatus(`Save failed: ${result.error}`);
    } catch (error) {
      this.setStatus(
        `Save failed: ${error instanceof Error ? error.message : "unexpected error"}`
      );
    } finally {
      this.busy = false;
    }
  }

  private async saveAndAnalyze(): Promise<void> {
    if (this.transcript === null || this.busy) return;
    this.busy = true;
    this.setStatus("Saving and starting Brain analysis…");
    try {
      const result = await this.persistNote();
      if (!result.ok) {
        this.setStatus(`Save failed: ${result.error}`);
        return;
      }
      this.setStatus("Saved. Starting Brain analysis…");
      const analysis = await this.session.analyzeActiveNote(
        DEFAULT_ANALYSIS_QUESTION
      );
      if (analysis.ok) {
        this.close();
        return;
      }
      this.setStatus(`Analysis failed: ${analysis.reason}`);
    } catch (error) {
      this.setStatus(
        `Analysis failed: ${error instanceof Error ? error.message : "unexpected error"}`
      );
    } finally {
      this.busy = false;
    }
  }

  private async persistNote(): Promise<
    { ok: true; path: string } | { ok: false; error: string }
  > {
    const transcript = this.transcript;
    if (transcript === null) {
      return { ok: false, error: "No transcript available." };
    }
    const editable = this.transcriptInput.value;
    const editableTranscript: RecordingTranscript = {
      text: editable,
      utterances: transcript.utterances,
      speakerCount: transcript.speakerCount
    };
    return this.session.createImportedRecordingNote({
      title: this.titleInput.value,
      sourceFileName: this.sourceFileName,
      transcript: editableTranscript,
      summary: this.summary
    });
  }

  private setEditorVisible(visible: boolean): void {
    this.editorEl.style.display = visible ? "" : "none";
  }

  private setStatus(text: string): void {
    this.statusEl.setText(text);
  }
}
