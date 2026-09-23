export type ChatSpaceSegmentSource = "voice" | "keyboard";

export interface ChatSpaceSegment {
  readonly id: string;
  readonly displayIndex: number;
  readonly text: string;
  readonly source: ChatSpaceSegmentSource;
  readonly createdAt: string;
  readonly isPartial: boolean;
  readonly candidateNote: boolean;
}

export interface ChatSpaceSnapshot {
  readonly segments: readonly ChatSpaceSegment[];
  readonly partialVoiceText: string;
}

function sameSegment(left: ChatSpaceSegment, right: ChatSpaceSegment): boolean {
  return left.id === right.id && left.text === right.text &&
    left.source === right.source && left.createdAt === right.createdAt &&
    left.isPartial === right.isPartial && left.candidateNote === right.candidateNote;
}

let segmentSequence = 0;
function newSegmentId(): string {
  segmentSequence += 1;
  return `chat-segment-${Date.now().toString(36)}-${segmentSequence.toString(36)}`;
}

function cloneSegment(segment: ChatSpaceSegment): ChatSpaceSegment {
  return { ...segment };
}

export class ChatSpace {
  private segments: ChatSpaceSegment[] = [];
  private partialVoiceText = "";

  constructor(snapshot?: ChatSpaceSnapshot) {
    if (snapshot !== undefined) {
      this.segments = snapshot.segments.map(cloneSegment);
      this.partialVoiceText = snapshot.partialVoiceText;
    }
  }

  getSegments(): readonly ChatSpaceSegment[] {
    return this.segments.map(cloneSegment);
  }

  get partialText(): string { return this.partialVoiceText; }

  snapshot(): ChatSpaceSnapshot {
    return { segments: this.getSegments(), partialVoiceText: this.partialVoiceText };
  }

  restore(snapshot: ChatSpaceSnapshot): void {
    this.segments = snapshot.segments.map(cloneSegment);
    this.partialVoiceText = snapshot.partialVoiceText;
  }

  setPartialVoiceText(text: string): void {
    this.partialVoiceText = text;
  }

  addSegment(text: string, source: ChatSpaceSegmentSource, createdAt = new Date().toISOString()): ChatSpaceSegment | null {
    const value = text.trim();
    if (value === "") return null;
    const segment: ChatSpaceSegment = {
      id: newSegmentId(),
      displayIndex: this.segments.length + 1,
      text: value,
      source,
      createdAt,
      isPartial: false,
      candidateNote: false
    };
    this.segments.push(segment);
    return cloneSegment(segment);
  }

  finalizeVoiceTurn(text: string, createdAt?: string): ChatSpaceSegment | null {
    this.partialVoiceText = "";
    return this.addSegment(text, "voice", createdAt);
  }

  appendKeyboardText(text: string, createdAt?: string): ChatSpaceSegment | null {
    return this.addSegment(text, "keyboard", createdAt);
  }

  findSegment(id: string): ChatSpaceSegment | undefined {
    const segment = this.segments.find((item) => item.id === id);
    return segment === undefined ? undefined : cloneSegment(segment);
  }

  deleteSegment(id: string): boolean {
    const index = this.segments.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.segments.splice(index, 1);
    this.reindex();
    return true;
  }

  deleteLine(line: number): boolean {
    const segment = this.segments[line - 1];
    return segment === undefined ? false : this.deleteSegment(segment.id);
  }

  replaceSegment(id: string, text: string): boolean {
    const index = this.segments.findIndex((item) => item.id === id);
    const value = text.trim();
    if (index < 0 || value === "") return false;
    const existing = this.segments[index];
    if (existing === undefined) return false;
    this.segments[index] = { ...existing, text: value };
    return true;
  }

  truncateFromSegment(id: string): boolean {
    const index = this.segments.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.segments.splice(index);
    this.reindex();
    return true;
  }

  markCandidateNote(id: string, marked = true): boolean {
    const index = this.segments.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const existing = this.segments[index];
    if (existing === undefined) return false;
    this.segments[index] = { ...existing, candidateNote: marked };
    return true;
  }

  insertText(text: string, afterSegmentId?: string): ChatSpaceSegment | null {
    const value = text.trim();
    if (value === "") return null;
    const segment: ChatSpaceSegment = {
      id: newSegmentId(), displayIndex: 0, text: value, source: "keyboard",
      createdAt: new Date().toISOString(), isPartial: false, candidateNote: false
    };
    const index = afterSegmentId === undefined
      ? this.segments.length
      : this.segments.findIndex((item) => item.id === afterSegmentId) + 1;
    if (index <= 0) return null;
    this.segments.splice(index, 0, segment);
    this.reindex();
    return cloneSegment(segment);
  }

  text(): string { return this.segments.map((segment) => segment.text).join("\n"); }

  removeSubmittedSnapshot(snapshot: ChatSpaceSnapshot): number {
    const submitted = new Map(snapshot.segments.map((segment) => [segment.id, segment]));
    const before = this.segments.length;
    this.segments = this.segments.filter((segment) => {
      const captured = submitted.get(segment.id);
      return captured === undefined || !sameSegment(segment, captured);
    });
    this.reindex();
    return before - this.segments.length;
  }

  clear(): void { this.segments = []; this.partialVoiceText = ""; }

  private reindex(): void {
    this.segments = this.segments.map((segment, index) => ({ ...segment, displayIndex: index + 1 }));
  }
}
