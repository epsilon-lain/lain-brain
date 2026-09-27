export class SpeechReadAloud {
  private enabled = false;
  private voicesLoaded = false;
  private lastStatus = "idle";

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
    if (this.isAvailable()) {
      speechSynthesis.cancel();
    }
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
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onstart = () => {
      this.lastStatus = "playing";
      console.log("speech-status", this.lastStatus);
    };
    utterance.onerror = (event) => {
      this.lastStatus = `error:${event.error}`;
      console.log("speech-status", this.lastStatus);
    };
    utterance.onend = () => {
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
