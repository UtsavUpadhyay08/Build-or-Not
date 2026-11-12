/**
 * Mock provider: no network, deterministic output, but it goes through the SAME pool, token
 * bucket, retry and validation path as a real provider. With MOCK_FAILURE_RATE /
 * MOCK_MALFORMED_RATE set you can watch retries, re-asks and quorum handling in the UI for free.
 */
import { ProviderError } from "../core/retry.js";
import type { CompletionRequest, CompletionResult, LLMProvider } from "./types.js";

export function hash(s: string): number {
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const VERDICTS = ["dont_build", "maybe", "build"] as const;

function mockVerdict(seed: number, label: string) {
  const score = 1 + (seed % 10);
  const verdict = score >= 7 ? "build" : score >= 4 ? "maybe" : "dont_build";
  return {
    verdict,
    score,
    reasoning: `(mock ${label}) Placeholder judgment — add an API key in .env for a real, idea-specific reaction.`,
    topConcern: `(mock) concern #${seed % 7}`,
    topAppeal: `(mock) appeal #${seed % 5}`,
    fix: `(mock) fix #${seed % 6}: narrow it to one audience first.`,
  };
}

export class MockProvider implements LLMProvider {
  readonly name = "mock" as const;
  private calls = 0;

  constructor(
    readonly model: string,
    private readonly latencyMs: number,
    private readonly failureRate: number,
    private readonly malformedRate = 0,
    private readonly random: () => number = Math.random,
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls++;
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs * (0.5 + this.random())));
    if (req.signal?.aborted) throw req.signal.reason;

    if (this.random() < this.failureRate) {
      const is429 = this.random() < 0.6;
      throw new ProviderError(`mock: simulated ${is429 ? "429 rate limit" : "503 overloaded"}`, "mock", is429 ? 429 : 503, is429 ? 300 : null);
    }

    const usage = { inputTokens: Math.ceil((req.system.length + req.user.length) / 4), outputTokens: 120 };
    if (this.random() < this.malformedRate) {
      return { data: { verdict: "definitely", score: "eleven" }, usage }; // fails zod -> triggers re-ask
    }

    const seed = hash(this.model + "|" + req.system + "|" + req.user);
    switch (req.schemaName) {
      case "submit_verdict":
        return { data: mockVerdict(seed, this.model), usage };

      case "submit_panel": {
        // Baseline condition: one call returns all personas. Persona ids appear in the system prompt roster as "id: <id>".
        const ids = [...(req.system + "\n" + req.user).matchAll(/id: ([a-z0-9-]+)/g)].map((m) => m[1]);
        return {
          data: { judgments: ids.map((personaId) => ({ personaId, ...mockVerdict(hash(personaId + seed), this.model + " single-prompt") })) },
          usage: { ...usage, outputTokens: 60 * ids.length },
        };
      }

      case "submit_draft": {
        // Simulated "fill it in": echo the idea back as a plausible brief.
        const idea = req.user.replace(/^[\s\S]*?(?:Feature idea|Idea):\s*/, "").trim().replace(/\s+/g, " ");
        const words = idea.split(" ").filter(Boolean);
        const title = words.slice(0, 4).join(" ").replace(/[.,;:!?]+$/, "") || "Untitled idea";
        const pick = (k: number) => 3 + ((seed >> k) % 6);
        return {
          data: {
            title: title.charAt(0).toUpperCase() + title.slice(1),
            description: `${idea.charAt(0).toUpperCase()}${idea.slice(1)}${/[.!?]$/.test(idea) ? "" : "."} (Simulated draft: add an API key for a real write-up.)`,
            targetAudience: "(simulated) People who have this problem today",
            pricingModel: "(simulated) Free to start, paid plan later",
            competitors: "(simulated) Spreadsheets, existing apps",
            sliders: { reach: pick(1), buildCost: pick(4), userImportance: pick(7), complexity: pick(10), value: pick(13), risk: pick(16) },
          },
          usage,
        };
      }

      case "submit_improve": {
        // Group the first few persona ids found in the prompt into plausible mock changes.
        const ids = [...new Set([...req.user.matchAll(/\(id: ([a-z0-9_-]+)/g)].map((m) => m[1]))];
        const slice = (a: number, b: number) => ids.slice(a, Math.min(b, ids.length));
        const title = /(?:^|\n)Title: (.+)/.exec(req.user)?.[1]?.trim() ?? "Your idea";
        return {
          data: {
            keep: "(mock) The core pain is real — keep the one-click settle-up.",
            changes: [
              { title: "(mock) Narrow the first audience", detail: "(mock) Launch for one specific group before going broad.", personaIds: slice(0, 5) },
              { title: "(mock) Explain the privacy story up front", detail: "(mock) Say what happens to the data on the landing page.", personaIds: slice(5, 8) },
              { title: "(mock) Cut the hardest feature from v1", detail: "(mock) Ship without the riskiest integration first.", personaIds: slice(8, 10) },
            ],
            revised: {
              title,
              description: "(mock revised) The same idea with the three changes above applied. Add an API key in .env for a real revision.",
              targetAudience: "(mock) The single group from change #1",
              pricingModel: "(mock) Unchanged",
              competitors: "(mock) Unchanged",
            },
          },
          usage,
        };
      }

      case "submit_synthesis":
        return {
          data: {
            topConcerns: [
              { theme: "(mock) Cost and complexity", mentionCount: 14, example: "(mock) Several personas worried about ongoing cost." },
              { theme: "(mock) Unclear differentiation", mentionCount: 9, example: "(mock) Not sure why this beats existing tools." },
            ],
            topAppeals: [{ theme: "(mock) Saves time for a specific group", mentionCount: 12, example: "(mock) Liked the direct time savings." }],
            summary: "(mock synthesis) Add an API key to .env and resubmit for real theme extraction.",
          },
          usage,
        };

      default:
        return { data: { verdict: VERDICTS[seed % 3] }, usage };
    }
  }
}
