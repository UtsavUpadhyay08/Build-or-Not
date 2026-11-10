/**
 * One adapter for every provider that speaks the OpenAI Chat Completions format:
 * OpenAI itself, plus the free options Groq, OpenRouter and OpenCode Zen.
 *
 * The catch with free models is that structured-output support is uneven. Some accept
 * response_format: json_schema, some only json_object, some neither. So the adapter degrades:
 *
 *   json_schema  ->  json_object + schema in the prompt  ->  plain prompt + "reply with JSON only"
 *
 * The first mode that a provider/model rejects with a 400/404/422 "unsupported parameter" error is
 * remembered for the rest of the process, so the downgrade costs one extra request, once.
 * Whatever comes back is still validated by zod (structured.ts), which re-asks on bad output.
 *
 * Free reasoning models (gpt-oss, deepseek, qwen…) may wrap answers in <think>…</think> or code
 * fences; extractJson() strips those.
 */
import { config } from "../config.js";
import { ProviderError } from "../core/retry.js";
import { postJson } from "./http.js";
import type { CompletionRequest, CompletionResult, LLMProvider } from "./types.js";

export type CompatName = "openai" | "groq" | "openrouter" | "opencode";
type Mode = "json_schema" | "json_object" | "prompt";

interface CompatSpec {
  base: string; // includes the version path, e.g. https://api.groq.com/openai/v1
  keyPrefix?: string;
  /** Floor for max output tokens: reasoning models spend tokens "thinking" before the answer. */
  minOutputTokens: number;
  headers?: Record<string, string>;
  extraBody?: (model: string) => Record<string, unknown>;
  /** How to recognise a free model id when picking one automatically. */
  isFree?: (id: string) => boolean;
}

export const COMPAT: Record<CompatName, CompatSpec> = {
  openai: { base: "https://api.openai.com/v1", keyPrefix: "sk-", minOutputTokens: 0 },
  groq: {
    base: "https://api.groq.com/openai/v1",
    keyPrefix: "gsk_",
    minOutputTokens: 1500,
    // gpt-oss models reason before answering; "low" keeps answers fast and inside Groq's free tokens-per-minute.
    extraBody: (model) => (model.includes("gpt-oss") ? { reasoning_effort: "low" } : {}),
    isFree: () => true, // Groq's free plan covers its whole catalogue (with low limits)
  },
  openrouter: {
    base: "https://openrouter.ai/api/v1",
    keyPrefix: "sk-or-",
    minOutputTokens: 1500,
    headers: { "HTTP-Referer": "http://localhost:5174", "X-Title": "Build or Not" },
    extraBody: () => ({ reasoning: { effort: "low", exclude: true } }),
    isFree: (id) => id.endsWith(":free"),
  },
  opencode: {
    base: "https://opencode.ai/zen/v1",
    minOutputTokens: 1500,
    isFree: (id) => id.endsWith("-free") || id === "big-pickle",
  },
};

/** <NAME>_BASE_URL overrides the whole base, including the version path. */
export function compatBase(name: CompatName): string {
  return (process.env[`${name.toUpperCase()}_BASE_URL`]?.trim() || COMPAT[name].base).replace(/\/$/, "");
}

/** Remembered working mode per provider+model, shared by every instance in the process. */
const modeCache = new Map<string, Mode>();

const UNSUPPORTED = /response_format|json_schema|json_object|structured|not supported|unsupported|no endpoints found|does not support|invalid.*schema/i;

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(
    readonly name: CompatName,
    readonly model: string,
    private readonly apiKey: string,
    /** OpenRouter: other free models to fall back to when this one is rate-limited upstream. */
    private readonly fallbacks: string[] = [],
  ) {}

  private get spec() {
    return COMPAT[this.name];
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const key = `${this.name}/${this.model}`;
    let mode: Mode = modeCache.get(key) ?? "json_schema";
    while (true) {
      try {
        const json = await this.send(req, mode);
        modeCache.set(key, mode);
        const content = json.choices?.[0]?.message?.content;
        return {
          data: extractJson(content),
          usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
        };
      } catch (err) {
        const next = downgrade(mode);
        if (next && err instanceof ProviderError && (err.status === 400 || err.status === 404 || err.status === 422) && UNSUPPORTED.test(err.message)) {
          mode = next;
          continue;
        }
        throw err;
      }
    }
  }

  private send(req: CompletionRequest, mode: Mode) {
    const schemaHint =
      mode === "json_schema"
        ? ""
        : `\n\nRespond with ONLY a JSON object (no prose, no markdown code fences) that matches this JSON Schema:\n${JSON.stringify(req.schema)}`;
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: "system", content: req.system + schemaHint },
        { role: "user", content: req.user },
      ],
      ...(this.name === "openai" ? { max_completion_tokens: req.maxTokens } : { max_tokens: Math.max(req.maxTokens, this.spec.minOutputTokens) }),
      ...(this.spec.extraBody?.(this.model) ?? {}),
      // OpenRouter tries these in order when the first model's upstream is rate-limited.
      ...(this.name === "openrouter" && this.fallbacks.length ? { models: [this.model, ...this.fallbacks].slice(0, 3) } : {}),
    };
    if (mode === "json_schema") {
      // strict:false so we don't need additionalProperties:false everywhere; zod is the real gate.
      body.response_format = { type: "json_schema", json_schema: { name: req.schemaName, description: req.schemaDescription, schema: req.schema, strict: false } };
    } else if (mode === "json_object") {
      body.response_format = { type: "json_object" };
    }
    return postJson(
      this.name,
      `${compatBase(this.name)}/chat/completions`,
      { authorization: `Bearer ${this.apiKey}`, ...(this.spec.headers ?? {}) },
      body,
      config.requestTimeoutMs,
      req.signal,
    );
  }
}

function downgrade(mode: Mode): Mode | null {
  return mode === "json_schema" ? "json_object" : mode === "json_object" ? "prompt" : null;
}

/**
 * Pull a JSON object out of whatever the model returned: plain JSON, JSON in ```fences```,
 * JSON after a <think>…</think> block, or JSON with chatter around it. If nothing parses,
 * return the raw text so validation fails and structured.ts re-asks with the error.
 */
export function extractJson(content: unknown): unknown {
  if (typeof content !== "string") return content ?? null;
  let text = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    return content;
  }
}

export function _resetModeCache() {
  modeCache.clear();
}
