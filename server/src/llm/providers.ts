/**
 * Thin adapters, one per provider, all over plain fetch (no vendor SDKs). Each one only
 * translates "system + user + JSON schema" into that provider's structured-output mechanism:
 *
 *   Anthropic -> forced tool call (tool_choice: {type: "tool"}) whose input_schema is our schema
 *   OpenAI-compatible (OpenAI, Groq, OpenRouter, OpenCode) -> see openaiCompatible.ts
 *   Gemini    -> generationConfig.responseSchema + responseMimeType "application/json"
 *
 * Output is returned UNVALIDATED; structured.ts validates with zod and re-asks once on failure.
 */
import { KeyPool } from "./keyPool.js";
import { config, type ProviderConfig } from "../config.js";
import { ProviderError } from "../core/retry.js";
import { postJson } from "./http.js";

const DEFAULT_BASE: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
};

/** Override with ANTHROPIC_BASE_URL / GEMINI_BASE_URL (gateways, proxies, local test servers). OpenAI-compatible bases: see compatBase(). */
export function baseUrl(name: string): string {
  return (process.env[`${name.toUpperCase()}_BASE_URL`]?.trim() || DEFAULT_BASE[name]).replace(/\/$/, "");
}
import type { CompletionRequest, CompletionResult, JsonSchema, LLMProvider } from "./types.js";
import { MockProvider } from "./mock.js";
import { OpenAICompatibleProvider } from "./openaiCompatible.js";

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  constructor(readonly model: string, private readonly apiKey: string) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const json = await postJson(
      this.name,
      `${baseUrl("anthropic")}/v1/messages`,
      { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      {
        model: this.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        tools: [{ name: req.schemaName, description: req.schemaDescription, input_schema: req.schema }],
        tool_choice: { type: "tool", name: req.schemaName },
      },
      config.requestTimeoutMs,
      req.signal,
    );
    const block = (json.content ?? []).find((b: any) => b.type === "tool_use");
    return {
      data: block?.input ?? null,
      usage: { inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 },
    };
  }
}

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini" as const;
  constructor(readonly model: string, private readonly apiKey: string) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const json = await postJson(
      this.name,
      `${baseUrl("gemini")}/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      { "x-goog-api-key": this.apiKey },
      {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: "user", parts: [{ text: req.user }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: toGeminiSchema(req.schema), maxOutputTokens: req.maxTokens },
      },
      config.requestTimeoutMs,
      req.signal,
    );
    const text = json.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
    return {
      data: safeJsonParse(text),
      usage: { inputTokens: json.usageMetadata?.promptTokenCount ?? 0, outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0 },
    };
  }
}

/** Gemini's responseSchema is an OpenAPI subset with upper-case type names. */
export function toGeminiSchema(s: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = { type: s.type.toUpperCase() };
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.required) out.required = s.required;
  if (s.items) out.items = toGeminiSchema(s.items);
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
  return out;
}

/** Malformed JSON isn't a transport error — return the raw string so validation fails and we re-ask. */
function safeJsonParse(text: unknown): unknown {
  if (typeof text !== "string") return text ?? null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createProvider(cfg: ProviderConfig, modelOverride?: string): LLMProvider {
  // Several keys: one pooled provider over a provider per key.
  if (cfg.apiKeys && cfg.apiKeys.length > 1) {
    return new KeyPool(cfg.apiKeys.map((apiKey) => createProvider({ ...cfg, apiKey, apiKeys: undefined }, modelOverride)));
  }
  const model = modelOverride ?? cfg.model;
  switch (cfg.name) {
    case "anthropic":
      return new AnthropicProvider(model, cfg.apiKey);
    case "openai":
    case "groq":
    case "openrouter":
    case "opencode":
      return new OpenAICompatibleProvider(cfg.name, model, cfg.apiKey, cfg.fallbacks ?? []);
    case "gemini":
      return new GeminiProvider(model, cfg.apiKey);
    case "mock":
      return new MockProvider(model, config.mock.latencyMs, config.mock.failureRate, config.mock.malformedRate);
    default:
      throw new ProviderError(`Unknown provider ${(cfg as ProviderConfig).name}`, String(cfg.name), 400);
  }
}
