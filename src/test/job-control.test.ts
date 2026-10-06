// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { JobCancelled, JobControl, JobTimeout } from "@/lib/job-control";

const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const p = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };

describe("JobControl (scan/requote lock)", () => {
  it("synchronous lock: a second job cannot start while one runs", () => {
    const c = new JobControl();
    const j = c.begin()!;
    expect(j).toBeTruthy();
    expect(c.begin()).toBeNull();
    c.end(j);
    expect(c.begin()).not.toBeNull();
  });

  it("invalidate (pause/hide/config) aborts the in-flight step, bumps generation and frees the lock only after the request drains", async () => {
    const c = new JobControl();
    const j = c.begin()!;
    const d = deferred<number>();
    const g0 = c.gen;
    const pr = j.step(d.p, 10_000, "Rent read");
    c.invalidate();
    await expect(pr).rejects.toBeInstanceOf(JobCancelled);
    expect(c.gen).toBe(g0 + 1);
    expect(j.alive()).toBe(false);
    c.end(j);
    expect(c.draining).toBe(true);
    expect(c.begin()).toBeNull();            // underlying RPC still running: no overlap
    d.resolve(1); await d.p; await Promise.resolve(); await Promise.resolve();
    expect(c.draining).toBe(false);
    expect(c.begin()).not.toBeNull();
  });

  it("timeout reports draining and stops further steps; lock stays held by the drain latch", async () => {
    vi.useFakeTimers();
    const c = new JobControl();
    const j = c.begin()!;
    const d = deferred<string>();
    const pr = j.step(d.p, 1000, "SDK pool load");
    vi.advanceTimersByTime(1001);
    await expect(pr).rejects.toBeInstanceOf(JobTimeout);
    await expect(pr).rejects.toThrow(/drain/);
    c.end(j);
    expect(c.busy).toBe(true);
    expect(c.begin()).toBeNull();
    d.resolve("late"); await d.p; await Promise.resolve(); await Promise.resolve();
    expect(c.begin()).not.toBeNull();
    vi.useRealTimers();
  });

  it("a result arriving after cancellation is discarded (step throws, no stale commit)", async () => {
    const c = new JobControl();
    const j = c.begin()!;
    const d = deferred<string>();
    const pr = j.step(d.p, 10_000, "Fee read");
    c.invalidate();
    d.resolve("stale");
    await expect(pr).rejects.toBeInstanceOf(JobCancelled);
    await expect(j.step(Promise.resolve(1), 1000, "next")).rejects.toBeInstanceOf(JobCancelled);
  });

  it("change-away-and-back (ABA) still kills the old job: generation is monotonic", () => {
    const c = new JobControl();
    const j = c.begin()!;
    c.invalidate(); c.invalidate();
    expect(j.alive()).toBe(false);
    expect(() => j.check()).toThrow(JobCancelled);
  });

  it("an obsolete job's end() does not release a newer job's lock", async () => {
    const c = new JobControl();
    const old = c.begin()!;
    c.invalidate();
    c.end(old);
    const fresh = c.begin()!;
    c.end(old);                       // late finally from the old job
    expect(c.running).toBe(true);
    expect(fresh.alive()).toBe(true);
  });

  it("unmount cancels and refuses new jobs", () => {
    const c = new JobControl();
    const j = c.begin()!;
    c.unmount();
    expect(j.alive()).toBe(false);
    c.end(j);
    expect(c.begin()).toBeNull();
  });

  it("notifies subscribers on lock/drain changes (UI re-renders draining state)", async () => {
    const c = new JobControl();
    const f = vi.fn();
    c.subscribe(f);
    const j = c.begin()!;
    c.end(j);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
