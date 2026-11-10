import { describe, expect, it } from "vitest";
import { TokenBucket, type Clock } from "./tokenBucket.js";
import { shareSendPlan, type SendPlan } from "../llm/capacity.js";

function fakeClock() {
  let t = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let id = 0;
  const clock: Clock = {
    now: () => t,
    setTimeout: (fn, ms) => (timers.push({ at: t + ms, fn, id: ++id }), id),
    clearTimeout: (h) => {
      const i = timers.findIndex((x) => x.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  const advance = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      t = next.at;
      next.fn();
      await Promise.resolve();
    }
    t = end;
    await Promise.resolve();
  };
  return { clock, advance };
}

describe("TokenBucket fair turns", () => {
  it("runs that queue at the same time take turns instead of the first one taking every slot", async () => {
    const { clock, advance } = fakeClock();
    const b = new TokenBucket(1, 1, clock); // 1 call per second
    await b.acquire(1, "warmup");
    const order: string[] = [];
    const runs = ["A", "B", "C"];
    // Run A queues all 5 of its calls first, then B, then C.
    const all = runs.flatMap((r) => Array.from({ length: 5 }, () => b.acquire(1, r).then(() => order.push(r))));
    expect(b.waitingOwners).toBe(3);
    await advance(6000);
    expect(order.slice(0, 6)).toEqual(["A", "B", "C", "A", "B", "C"]);
    await advance(20000);
    await Promise.all(all);
    expect(order).toHaveLength(15);
  });

  it("without an owner it is still plain first-come", async () => {
    const { clock, advance } = fakeClock();
    const b = new TokenBucket(1, 1, clock);
    await b.acquire();
    const order: number[] = [];
    const ps = [1, 2, 3].map((n) => b.acquire().then(() => order.push(n)));
    await advance(5000);
    await Promise.all(ps);
    expect(order).toEqual([1, 2, 3]);
  });

  it("the plan says when other ideas share the key", () => {
    const plan: SendPlan = { mode: "auto", startNow: 18, concurrency: 18, startAllSec: 90, providers: [], warnings: [] };
    expect(shareSendPlan(plan, 0)).toBe(plan);
    const s = shareSendPlan(plan, 2);
    expect(s).toMatchObject({ sharedWith: 2, startNow: 6, startAllSec: 270 });
  });
});
