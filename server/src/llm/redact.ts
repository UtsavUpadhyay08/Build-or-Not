/**
 * Ideas are public, and failure messages are saved with them. Some providers quote part of a bad
 * key back in their error text ("Incorrect API key provided: sk-abc…xyz"), so anything that looks
 * like a key is replaced before it's stored, shown or logged. Known keys are removed exactly too.
 */
const KEYISH = [
  /\bsk-ant-[A-Za-z0-9_-]{6,}/g, // Anthropic
  /\bsk-or-[A-Za-z0-9_-]{6,}/g, // OpenRouter
  /\bsk-(?:proj-)?[A-Za-z0-9_*.-]{6,}/g, // OpenAI (also its own masked echoes like sk-abc*****xyz)
  /\bgsk_[A-Za-z0-9*]{6,}/g, // Groq
  /\bAIza[A-Za-z0-9_-]{10,}/g, // Google
  /\bAQ\.[A-Za-z0-9_-]{10,}/g, // Google (newer keys)
  /\b(?:bearer|key=|api[_-]?key[=:]\s*)[A-Za-z0-9._-]{12,}/gi,
];

export function redactSecrets(text: string, known: string[] = []): string {
  let out = text;
  for (const k of known) if (k && k.length >= 8) out = out.split(k).join("[key hidden]");
  for (const re of KEYISH) out = out.replace(re, "[key hidden]");
  return out;
}
