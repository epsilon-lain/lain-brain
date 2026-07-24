import { Notice, Plugin } from "obsidian";

export default class LainBrainPlugin extends Plugin {
  onload(): void {
    this.addCommand({
      id: "open-lain-brain",
      name: "Open Lain Brain",

      callback: () => {
        new Notice("Lain Brain is awake.");
      }
    });
  }
}