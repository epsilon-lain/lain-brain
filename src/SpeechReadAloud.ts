export class SpeechReadAloud {
  private enabled = false;
  private voicesLoaded = false;
  private lastStatus = "idle";
  private generation = 0;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.stop();
    }
  }

  isAvailable(): boolean {
    return typeof speechSynthesis !== "undefined" &&
      typeof SpeechSynthesisUtterance !== "undefined";
  }

  stop(): void {
    this.generation += 1;
    if (this.isAvailable()) {
      speechSynthesis.cancel();
    }
    this.lastStatus = "stopped";
  }

  isReading(): boolean {
    return this.lastStatus === "requested" || this.lastStatus === "playing";
  }

  speak(text: string): void {
    if (!this.enabled || text.trim() === "") {
      this.lastStatus = this.enabled ? "empty-text" : "disabled";
      return;
    }
    if (!this.isAvailable()) {
      this.lastStatus = "unavailable";
      return;
    }
    this.stop();
    const generation = this.generation;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onstart = () => {
      if (generation !== this.generation) return;
      this.lastStatus = "playing";
      console.log("speech-status", this.lastStatus);
    };
    utterance.onerror = (event) => {
      if (generation !== this.generation) return;
      this.lastStatus = `error:${event.error}`;
      console.log("speech-status", this.lastStatus);
    };
    utterance.onend = () => {
      if (generation !== this.generation) return;
      this.lastStatus = "ended";
      console.log("speech-status", this.lastStatus);
    };
    if (!this.voicesLoaded) {
      this.voicesLoaded = true;
      const voices = speechSynthesis.getVoices();
      const zh = voices.find((voice) => /zh|cmn|chinese/i.test(voice.lang));
      if (zh !== undefined) {
        utterance.voice = zh;
      }
    }
    speechSynthesis.speak(utterance);
    this.lastStatus = "requested";
  }

  getLastStatus(): string {
    return this.lastStatus;
  }
}
