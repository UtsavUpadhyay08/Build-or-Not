import { describe, it, expect } from "vitest";
import { TokenBucket, type Clock } from "./tokenBucket.js";
import { runPool } from "./workerPool.js";
import { backoffDelay, parseRetryAfter, ProviderError, withRetry } from "./retry.js";

/** Virtual clock: timers fire only when the test advances time. No real sleeping. */
class FakeClock implements Clock {
  t = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = this.nextId++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimeout(h: unknown) {
    this.timers = this.timers.filter((x) => x.id !== h);
  }
  async advance(ms: number) {
    const end = this.t + ms;
    while (true) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
      await Promise.resolve();
    }
    this.t = end;
    await new Promise((r) => setImmediate(r)); // flush resolved acquire() promises
  }
}

describe("TokenBucket", () => {
  it("allows a burst up to capacity immediately, then throttles to the refill rate", async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(3, 1, clock); // burst 3, 1 token/sec
    const granted: number[] = [];
    for (let i = 0; i < 6; i++) bucket.acquire().then(() => granted.push(clock.now()));

    await clock.advance(0);
    expect(granted).toEqual([0, 0, 0]); // burst
    await clock.advance(1000);
    expect(granted).toHaveLength(4);
    await clock.advance(2000);
    expect(granted).toEqual([0, 0, 0, 1000, 2000, 3000]); // then 1/sec
  });

  it("grants strictly in FIFO order", async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(1, 1, clock);
    const order: string[] = [];
    bucket.acquire().then(() => order.push("a"));
    bucket.acquire().then(() => order.push("b"));
    bucket.acquire().then(() => order.push("c"));
    await clock.advance(5000);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("pauseFor blocks everyone and drops the burst (shared backpressure after a 429)", async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(5, 10, clock);
    bucket.pauseFor(2000);
    let got = false;
    bucket.acquire().then(() => (got = true));
    await clock.advance(1999);
    expect(got).toBe(false);
    await clock.advance(200); // after the pause, tokens refill from zero at 10/sec
    expect(got).toBe(true);
  });

  it("never exceeds capacity no matter how long it idles", async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(4, 100, clock);
    await clock.advance(60_000);
    expect(bucket.available()).toBe(4);
  });
});

describe("runPool", () => {
  it("never runs more than `concurrency` jobs at once, and runs every job", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await runPool(
      Array.from({ length: 45 }, (_, i) => i),
      async (i) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1 + (i % 3)));
        inFlight--;
        return i * 2;
      },
      { concurrency: 6 },
    );
    expect(peak).toBe(6);
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual(Array.from({ length: 45 }, (_, i) => i * 2));
  });

  it("isolates failures: one failing job doesn't reject the pool or affect others", async () => {
    const results = await runPool([1, 2, 3, 4], async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    }, { concurrency: 2 });
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled"]);
  });

  it("stops pulling new work after abort and reports the rest as skipped", async () => {
    const ac = new AbortController();
    const results = await runPool(
      Array.from({ length: 10 }, (_, i) => i),
      async (i) => {
        if (i === 2) ac.abort();
        return i;
      },
      { concurrency: 1, signal: ac.signal },
    );
    expect(results.filter((r) => r.status === "skipped")).toHaveLength(7);
  });
});

describe("retry", () => {
  const noSleep = { sleep: async () => {}, random: () => 0.5 };

  it("retries transient errors and succeeds", async () => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        if (++calls < 3) throw new ProviderError("overloaded", "x", 503);
        return "ok";
      },
      { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 1000, ...noSleep },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does NOT retry permanent errors like 400/401", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new ProviderError("bad key", "x", 401);
      }, { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 1, ...noSleep }),
    ).rejects.toThrow("bad key");
    expect(calls).toBe(1);
  });

  it("gives up after maxAttempts", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new ProviderError("timeout", "x", null);
      }, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, ...noSleep }),
    ).rejects.toThrow();
    expect(calls).toBe(3);
  });

  it("honours Retry-After over computed backoff", async () => {
    const delays: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        if (++calls === 1) throw new ProviderError("429", "x", 429, 7000);
        return 1;
      },
      { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 30_000, sleep: async (ms) => void delays.push(ms) },
    );
    expect(delays).toEqual([7000]);
  });

  it("full-jitter backoff stays within [0, min(max, base*2^attempt))", () => {
    expect(backoffDelay(0, 500, 20_000, () => 0.999)).toBeLessThan(500);
    expect(backoffDelay(3, 500, 20_000, () => 0.999)).toBeLessThan(4000);
    expect(backoffDelay(10, 500, 20_000, () => 0.999)).toBeLessThan(20_000);
    expect(backoffDelay(3, 500, 20_000, () => 0)).toBe(0);
  });

  it("parses Retry-After as seconds or HTTP date", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(parseRetryAfter(null)).toBeNull();
  });
});
