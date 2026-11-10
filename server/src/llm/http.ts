import { ProviderError, parseRetryAfter } from "../core/retry.js";

/**
 * POST JSON with a hard timeout, translating every failure into a ProviderError so the retry
 * layer can classify it uniformly (status null = network/timeout, otherwise the HTTP status).
 */
export async function postJson(
  provider: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<any> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (err) {
    if (signal?.aborted) throw err; // caller cancelled — don't dress it up as retryable
    const reason = timeout.aborted ? `timed out after ${timeoutMs}ms` : (err as Error).message;
    throw new ProviderError(`${provider}: request failed (${reason})`, provider, null);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(
      `${provider}: HTTP ${res.status} ${text.slice(0, 300)}`,
      provider,
      res.status,
      parseRetryAfter(res.headers.get("retry-after")),
    );
  }
  return res.json();
}
