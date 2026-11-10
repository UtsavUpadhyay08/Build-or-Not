/**
 * Validate-and-re-ask. Structured-output modes make malformed JSON rare, not impossible (wrong
 * enum value, score as a string, missing field, truncated output). We never trust the shape:
 *
 *   call -> zod.safeParse -> ok? return
 *                         -> bad? re-ask ONCE, telling the model exactly what was wrong
 *                                 -> still bad? throw StructuredOutputError (counts as a persona failure)
 *
 * One re-ask, not a loop: if a model can't fix it with the error in hand, a third try is
 * usually wasted money, and the panel tolerates individual failures anyway (quorum).
 */
import type { ZodType } from "zod";
import type { CompletionRequest, LLMProvider, Usage } from "./types.js";
import { addUsage } from "./types.js";

export class StructuredOutputError extends Error {
  constructor(message: string, readonly usage: Usage) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

export interface StructuredResult<T> {
  value: T;
  usage: Usage;
  repaired: boolean; // true if the first answer was invalid and the re-ask fixed it
}

export async function callStructured<T>(provider: LLMProvider, req: CompletionRequest, schema: ZodType<T>): Promise<StructuredResult<T>> {
  const first = await provider.complete(req);
  const parsed = schema.safeParse(first.data);
  if (parsed.success) return { value: parsed.data, usage: first.usage, repaired: false };

  const problems = parsed.error.issues
    .slice(0, 8)
    .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");

  const second = await provider.complete({
    ...req,
    user:
      `${req.user}\n\n---\nYour previous answer did not match the required schema:\n${problems}\n` +
      `Previous answer: ${JSON.stringify(first.data).slice(0, 1500)}\n` +
      `Answer again, using the ${req.schemaName} format exactly.`,
  });
  const usage = addUsage(first.usage, second.usage);
  const reparsed = schema.safeParse(second.data);
  if (reparsed.success) return { value: reparsed.data, usage, repaired: true };

  throw new StructuredOutputError(`${provider.name}/${provider.model}: invalid structured output after re-ask:\n${problems}`, usage);
}
