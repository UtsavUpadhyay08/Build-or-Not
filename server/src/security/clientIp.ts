/**
 * The visitor's real IP address, for the daily limits and request rate limits.
 *
 * Behind a host's proxies, the TCP connection comes from the proxy, not the visitor. Counting
 * proxy hops in X-Forwarded-For (Express "trust proxy") is fragile: on Render the chain is
 * visitor → Cloudflare → Render's internal proxy, and with the wrong count every visitor gets the
 * same address and shares one set of free runs. The leftmost X-Forwarded-For entry can be faked.
 *
 * So, in order:
 *   1. CLIENT_IP_HEADER, if the owner set one (e.g. "cf-connecting-ip" behind their own Cloudflare)
 *   2. On Render (RENDER=true is set by Render): True-Client-IP, else CF-Connecting-IP. Render's
 *      Cloudflare edge sets these to the real visitor address and overwrites (or rejects) any value
 *      the visitor sends, so they can't be faked.
 *   3. Otherwise Express's req.ip (with TRUST_PROXY hops, 0 by default = the direct connection).
 * Headers are only trusted in cases 1 and 2; locally nobody can fake an address by sending them.
 */
import type { Request } from "express";

const firstIp = (v: string | undefined) => (v ?? "").split(",")[0]?.trim() || "";

export function clientIpSource(): string {
  const custom = process.env.CLIENT_IP_HEADER?.trim().toLowerCase();
  if (custom) return `the ${custom} header (CLIENT_IP_HEADER)`;
  if (process.env.RENDER === "true") return "Render's True-Client-IP header";
  return `the connection${Number(process.env.TRUST_PROXY) > 0 ? ` (TRUST_PROXY=${process.env.TRUST_PROXY})` : ""}`;
}

export function clientIp(req: Request): string {
  const custom = process.env.CLIENT_IP_HEADER?.trim().toLowerCase();
  if (custom) {
    const v = firstIp(req.get(custom));
    if (v) return v;
  }
  if (process.env.RENDER === "true") {
    const v = firstIp(req.get("true-client-ip")) || firstIp(req.get("cf-connecting-ip"));
    if (v) return v;
  }
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}
