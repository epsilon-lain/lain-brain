export class ChatSpaceSubmissionGate<T> {
  private activePromise?: Promise<T>;

  get busy(): boolean { return this.activePromise !== undefined; }

  run(task: () => Promise<T>): Promise<T> {
    if (this.activePromise !== undefined) return this.activePromise;
    const promise = task();
    this.activePromise = promise;
    promise.then(
      () => { if (this.activePromise === promise) this.activePromise = undefined; },
      () => { if (this.activePromise === promise) this.activePromise = undefined; }
    );
    return promise;
  }
}
