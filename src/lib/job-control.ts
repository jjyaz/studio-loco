/**
 * Single-flight job controller for read-only scan/requote work.
 * - One job at a time (synchronous lock).
 * - Monotonic generation: invalidate() bumps it and aborts the active job (no ABA).
 * - step() bounds each await with a timeout and re-checks liveness after it.
 * - An unabortable request left running by a timeout keeps the controller "draining":
 *   no new job may start until that underlying promise settles.
 */
export class JobCancelled extends Error {
  constructor(msg = "Cancelled") { super(msg); this.name = "JobCancelled"; }
}
export class JobTimeout extends Error {
  constructor(label: string, ms: number) { super(`${label} timed out after ${Math.round(ms / 1000)}s — waiting for the request to drain before new work`); this.name = "JobTimeout"; }
}

export interface Job {
  readonly gen: number;
  readonly signal: AbortSignal;
  /** True while this job is the current, uncancelled generation and the owner is mounted. */
  alive(): boolean;
  /** Throws JobCancelled unless alive(). */
  check(): void;
  /** Await p with a timeout; tracks p until it settles; re-checks liveness afterwards. */
  step<T>(p: Promise<T>, ms: number, label: string): Promise<T>;
}

export class JobControl {
  gen = 0;
  mounted = true;
  private active: { ac: AbortController } | null = null;
  private pending = new Set<Promise<unknown>>();
  private listeners = new Set<() => void>();

  subscribe(f: () => void) { this.listeners.add(f); return () => { this.listeners.delete(f); }; }
  private notify() { for (const f of this.listeners) f(); }

  get running() { return this.active !== null; }
  get draining() { return this.pending.size > 0; }
  get busy() { return this.running || this.draining; }

  /** Bump generation and abort the active job immediately. */
  invalidate() {
    this.gen++;
    this.active?.ac.abort();
    this.notify();
  }

  /** Synchronously acquire the lock. null if a job is running or a timed-out request is still draining. */
  begin(): Job | null {
    if (this.busy || !this.mounted) return null;
    const ac = new AbortController();
    const slot = { ac };
    this.active = slot;
    const gen = this.gen;
    const ctl = this;
    const alive = () => ctl.mounted && ctl.gen === gen && !ac.signal.aborted && ctl.active === slot;
    const job: Job = {
      gen, signal: ac.signal, alive,
      check() { if (!alive()) throw new JobCancelled(); },
      async step<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
        job.check();
        const tracked = p.then(() => undefined, () => undefined);
        ctl.pending.add(tracked);
        void tracked.then(() => { ctl.pending.delete(tracked); ctl.notify(); });
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        try {
          const r = await Promise.race([
            p,
            new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new JobTimeout(label, ms)), ms); }),
            new Promise<never>((_, rej) => { onAbort = () => rej(new JobCancelled()); ac.signal.addEventListener("abort", onAbort, { once: true }); }),
          ]);
          job.check();
          return r;
        } finally {
          clearTimeout(timer);
          if (onAbort) ac.signal.removeEventListener("abort", onAbort);
        }
      },
    };
    this.notify();
    return job;
  }

  /** Release the lock (only if still owned). Pending underlying requests keep the controller draining. */
  end(job: Job) {
    if (this.active && this.active.ac.signal === job.signal) { this.active = null; this.notify(); }
  }

  unmount() { this.mounted = false; this.invalidate(); }
}
