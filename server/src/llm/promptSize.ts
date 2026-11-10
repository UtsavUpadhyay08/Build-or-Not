/** Total characters of every persona's system prompt (plus the fixed user-message wrapper), for token estimates. */
import { PERSONAS } from "../personas.js";
import { personaSystemPrompt } from "../panel/prompts.js";

const USER_WRAPPER = "Here is the idea:\n\n\n\nGive your verdict.".length;
export const ALL_PERSONAS_PROMPT_CHARS = PERSONAS.reduce((s, p) => s + personaSystemPrompt(p, PERSONAS.length).length + USER_WRAPPER, 0);
