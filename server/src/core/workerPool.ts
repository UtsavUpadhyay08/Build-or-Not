/**
 * Bounded-concurrency worker pool.
 *
 * Runs `fn` over `items` with at most `concurrency` in flight. Why not just Promise.all?
 * Because Promise.all(items.map(fn)) starts ALL 45 requests at once — that's the thundering
 * herd that blows through provider rate limits and opens 45 sockets.
 *
 * How it works: we start N "worker" loops. Each loop pulls the next index from a shared cursor
 * and awaits the job, then pulls again. Node is single-threaded, so `cursor++` is atomic — no
 * two workers can ever take the same index (there's no preemption between the read and the
 * increment). The concurrency here is I/O concurrency: while one worker awaits a network
 * response, the event loop runs the others.
 *
 * Failure semantics: a failing item NEVER rejects the pool. Every item produces a settled
 * result, so 3 failed personas out of 45 don't throw away the other 42. The caller decides what
 * "too many failures" means (see quorum in panel/aggregate.ts).
 *
 * Cancellation: if `signal` aborts, workers stop pulling new items; in-flight items finish
 * (or observe the same signal themselves) and remaining items are reported as "skipped".
 */

export type PoolResult<T, R> =
  | { status: "fulfilled"; item: T; index: number; value: R }
  | { status: "rejected"; item: T; index: number; reason: unknown }
  | { status: "skipped"; item: T; index: number };

export interface PoolOptions {
  concurrency: number;
  signal?: AbortSignal;
}

export async function runPool<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  { concurrency, signal }: PoolOptions,
): Promise<PoolResult<T, R>[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`runPool: concurrency must be a positive integer, got ${concurrency}`);

  const results: PoolResult<T, R>[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      if (signal?.aborted) return;
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i];
      try {
        results[i] = { status: "fulfilled", item, index: i, value: await fn(item, i) };
      } catch (reason) {
        results[i] = { status: "rejected", item, index: i, reason };
      }
    }
  }

  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, worker));

  // Anything never picked up (only possible after abort) is reported explicitly, not left as a hole.
  for (let i = 0; i < items.length; i++) {
    if (!results[i]) results[i] = { status: "skipped", item: items[i], index: i };
  }
  return results;
}
