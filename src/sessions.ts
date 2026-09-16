/**
 * Bounded session registry for the HTTP transport. Entries are kept in least-recently-used
 * order; the oldest is closed when the cap is reached, and idle entries are closed by sweep().
 */

export interface Closable {
  close(): Promise<void>;
}

export const MAX_SESSIONS = 1000;
export const SESSION_IDLE_MS = 30 * 60 * 1000;

export class SessionStore<T extends Closable> {
  private readonly entries = new Map<string, { value: T; lastSeen: number }>();

  constructor(
    private readonly max = MAX_SESSIONS,
    private readonly idleMs = SESSION_IDLE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /** Look up a session and mark it as used. */
  get(id: string): T | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entries.delete(id);
    entry.lastSeen = this.now();
    this.entries.set(id, entry);
    return entry.value;
  }

  /** Register a session, closing the least recently used one if the store is full. */
  add(id: string, value: T): void {
    this.entries.delete(id);
    while (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.evict(oldest);
    }
    this.entries.set(id, { value, lastSeen: this.now() });
  }

  delete(id: string): void {
    this.entries.delete(id);
  }

  /** Close every session idle for longer than the idle timeout. */
  sweep(): void {
    const cutoff = this.now() - this.idleMs;
    for (const [id, entry] of this.entries) {
      if (entry.lastSeen > cutoff) break;
      this.evict(id);
    }
  }

  private evict(id: string): void {
    const entry = this.entries.get(id);
    this.entries.delete(id);
    entry?.value.close().catch(() => {});
  }
}
