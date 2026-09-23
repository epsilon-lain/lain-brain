import type { ChatSpaceSnapshot } from "./ChatSpace";

export interface UndoEntry {
  readonly before: ChatSpaceSnapshot;
  readonly after: ChatSpaceSnapshot;
  readonly description: string;
}

export class UndoJournal {
  private readonly entries: UndoEntry[] = [];

  private readonly maxLength: number;
  constructor(maxLength = 100) { this.maxLength = maxLength; }

  push(entry: UndoEntry): void {
    this.entries.push(entry);
    while (this.entries.length > this.maxLength) this.entries.shift();
  }

  pop(): UndoEntry | undefined { return this.entries.pop(); }
  get length(): number { return this.entries.length; }
  clear(): void { this.entries.length = 0; }
}
