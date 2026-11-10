import type { ProviderName } from "../config.js";

/** A JSON Schema object (the subset all three providers accept: object/array/string/number/enum). */
export type JsonSchema = {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean";
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: string[];
};

export interface CompletionRequest {
  system: string;
  user: string;
  /** Name for the structured output (tool name / json_schema name). Mock mode also switches on it. */
  schemaName: string;
  schemaDescription: string;
  schema: JsonSchema;
  maxTokens: number;
  signal?: AbortSignal;
  /** Who this call is for (an idea id). Shared rate limits take turns between owners. */
  fairKey?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompletionResult {
  /** Parsed JSON from the model — UNVALIDATED. Always run it through a zod schema (see structured.ts). */
  data: unknown;
  usage: Usage;
}

/**
 * The one interface every provider implements. Adding a provider = one file implementing this.
 * Rate limiting and retries are NOT the provider's job — they're layered on top in managed.ts,
 * so each adapter stays a thin HTTP translation.
 */
export interface LLMProvider {
  readonly name: ProviderName;
  readonly model: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export function addUsage(a: Usage, b: Usage): Usage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };
