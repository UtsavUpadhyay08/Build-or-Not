import type { Persona } from "../personas.js";
import type { LLMProvider } from "../llm/types.js";
import { callStructured } from "../llm/structured.js";
import { costUsd } from "../llm/pricing.js";
import type { CallMeta, IdeaBrief } from "../types.js";
import { describeIdea, personaSystemPrompt, VERDICT_SCHEMA, verdictZ, type DescribeOptions, type VerdictPayload } from "./prompts.js";

/** One persona, one independent call. Returns validated output + call metadata (tokens, cost, latency). */
export async function judgePersona(
  provider: LLMProvider,
  persona: Persona,
  idea: IdeaBrief,
  panelSize: number,
  opts: DescribeOptions & { signal?: AbortSignal } = {},
): Promise<VerdictPayload & CallMeta> {
  const t0 = Date.now();
  const res = await callStructured(
    provider,
    {
      system: personaSystemPrompt(persona, panelSize),
      user: `Here is the idea:\n\n${describeIdea(idea, opts)}\n\nGive your verdict.`,
      schemaName: "submit_verdict",
      schemaDescription: "Submit your judgment of this idea, strictly in your persona's voice and priorities.",
      schema: VERDICT_SCHEMA,
      maxTokens: 600,
      signal: opts.signal,
    },
    verdictZ,
  );
  return {
    ...res.value,
    provider: provider.name,
    model: provider.model,
    inputTokens: res.usage.inputTokens,
    outputTokens: res.usage.outputTokens,
    costUsd: costUsd(provider.model, res.usage),
    latencyMs: Date.now() - t0,
    repaired: res.repaired,
  };
}
