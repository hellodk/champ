export class EventBuffer<T = unknown> {
  private queue: T[] = [];
  private _byteSize = 0;

  constructor(
    private readonly maxEvents: number,
    private readonly maxBytes: number,
  ) {}

  push(event: T): void {
    const serialized = JSON.stringify(event);
    const eventBytes = Buffer.byteLength(serialized, "utf8");
    this.queue.push(event);
    this._byteSize += eventBytes;
    while (
      this.queue.length > this.maxEvents ||
      this._byteSize > this.maxBytes
    ) {
      const oldest = this.queue.shift();
      if (oldest !== undefined) {
        this._byteSize -= Buffer.byteLength(JSON.stringify(oldest), "utf8");
      }
    }
  }

  drain(): T[] {
    const events = this.queue.splice(0);
    this._byteSize = 0;
    return events;
  }

  size(): number {
    return this.queue.length;
  }

  byteSize(): number {
    return this._byteSize;
  }
}
