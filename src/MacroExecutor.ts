import { ChatSpace } from "./ChatSpace";
import { UndoJournal } from "./UndoJournal";
import type { MacroAction, MacroDefinition, MacroMatchResult } from "./MacroTypes";

export interface MacroExecutionResult { readonly ok: boolean; readonly message: string; readonly submittedText?: string; }

export class MacroExecutor {
  private readonly space: ChatSpace;
  private readonly journal: UndoJournal;
  constructor(space: ChatSpace, journal = new UndoJournal()) { this.space = space; this.journal = journal; }

  execute(match: MacroMatchResult): MacroExecutionResult {
    const before = this.space.snapshot();
    const submitted = this.applyActions(match.macro, match.parameters);
    if (!submitted.ok) {
      this.space.restore(before);
      return submitted;
    }
    const after = this.space.snapshot();
    if (match.macro.undoable && before.segments !== after.segments) this.journal.push({ before, after, description: match.macro.name });
    return { ok: true, message: "Macro completed.", submittedText: submitted.submittedText };
  }

  recover(): MacroExecutionResult {
    const entry = this.journal.pop();
    if (entry === undefined) return { ok: true, message: "There is nothing to recover." };
    this.space.restore(entry.before);
    return { ok: true, message: "Last Chat Space change restored." };
  }

  private applyActions(macro: MacroDefinition, parameters: Readonly<Record<string, string | number>>): MacroExecutionResult {
    for (const action of macro.actions) {
      const result = this.applyAction(action, parameters);
      if (!result.ok) return result;
      if (result.submittedText !== undefined) return result;
    }
    return { ok: true, message: "Macro completed." };
  }

  private applyAction(action: MacroAction, parameters: Readonly<Record<string, string | number>>): MacroExecutionResult {
    switch (action.kind) {
      case "submit_to_brain": return { ok: true, message: "Submitting Chat Space.", submittedText: this.space.text() };
      case "delete_segment": {
        const line = typeof action.line === "object"
          ? parameters[action.line.parameter]
          : action.line;
        return { ok: line === undefined
          ? action.segmentId !== undefined && this.space.deleteSegment(action.segmentId)
          : typeof line === "number" && this.space.deleteLine(line), message: "Unable to delete that segment." };
      }
      case "replace_segment": return { ok: action.segmentId !== undefined && this.space.replaceSegment(action.segmentId, action.text), message: "Unable to replace that segment." };
      case "truncate_from_segment": return { ok: action.segmentId !== undefined && this.space.truncateFromSegment(action.segmentId), message: "Unable to truncate Chat Space." };
      case "mark_candidate_note": return { ok: action.segmentId !== undefined && this.space.markCandidateNote(action.segmentId), message: "Unable to mark that segment." };
      case "unmark_candidate_note": return { ok: action.segmentId !== undefined && this.space.markCandidateNote(action.segmentId, false), message: "Unable to unmark that segment." };
      case "restore_last_step": return this.recover();
      case "insert_text": return { ok: this.space.insertText(action.text, action.afterSegmentId) !== null, message: "Unable to insert text." };
    }
    void parameters;
  }
}
