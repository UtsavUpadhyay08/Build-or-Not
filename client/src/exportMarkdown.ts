import { productName } from "./game/model";
import type { IdeaRecord, PersonaFailure, PersonaVerdict, Synthesis } from "./types";

const VERDICT_LABEL: Record<string, string> = { build: "Build it", maybe: "Maybe", dont_build: "Don’t build it" };

export function ideaToMarkdown(idea: IdeaRecord, verdicts: PersonaVerdict[], failures: PersonaFailure[], synthesis: Synthesis | null, personaName: (id: string) => string): string {
  const lines: string[] = [];
  lines.push(`# ${idea.title}`);
  lines.push("");
  if (idea.kind === "feature" && idea.productContext) {
    const name = productName(idea.productContext);
    lines.push(`_A new feature for ${name || "an existing product"}._`);
    lines.push("");
  }
  lines.push(idea.description);
  lines.push("");
  if (synthesis) {
    lines.push(`## Verdict: ${VERDICT_LABEL[synthesis.overallVerdict]} (${synthesis.overallScore}/100)`);
    lines.push("");
    lines.push(synthesis.summary);
    lines.push("");
    lines.push(`Build: ${synthesis.counts.build} · Maybe: ${synthesis.counts.maybe} · Don't build: ${synthesis.counts.dont_build} (of ${verdicts.length})`);
    lines.push("");
    const d = synthesis.disagreement;
    lines.push(`**Agreement: ${d.confidence}.** ${Math.round(d.agreement * 100)}% gave the most common answer. Score spread ${d.scoreStdDev}, vote split ${d.verdictEntropy} (0 = all agree, 1 = split three ways). ${synthesis.judged} answered, ${synthesis.failed} didn't.`);
    lines.push("");
    lines.push("| Persona group | Mean score | n |", "|---|---|---|");
    for (const g of d.byCategory) lines.push(`| ${g.key} | ${g.meanScore} | ${g.n} |`);
    if (d.byProvider.length > 1) {
      lines.push("", "| Model | Mean score | n |", "|---|---|---|");
      for (const g of d.byProvider) lines.push(`| ${g.key} | ${g.meanScore} | ${g.n} |`);
    }
    lines.push("");
    lines.push("### Top concerns");
    for (const c of synthesis.topConcerns) lines.push(`- **${c.theme}** (${c.mentionCount}/${verdicts.length}) — ${c.example}`);
    lines.push("");
    lines.push("### Top appeals");
    for (const a of synthesis.topAppeals) lines.push(`- **${a.theme}** (${a.mentionCount}/${verdicts.length}) — ${a.example}`);
    lines.push("");
  }
  lines.push(`## All ${verdicts.length} persona verdicts`);
  lines.push("");
  for (const v of verdicts) {
    lines.push(`### ${personaName(v.personaId)} — ${VERDICT_LABEL[v.verdict]} (${v.score}/10) · ${v.model}`);
    if (v.fix) lines.push(`_Would change their mind: ${v.fix}_`, "");
    lines.push(v.reasoning);
    lines.push(`- Concern: ${v.topConcern}`);
    lines.push(`- Appeal: ${v.topAppeal}`);
    lines.push("");
  }
  if (failures.length) {
    lines.push("## No response");
    for (const f of failures) lines.push(`- ${personaName(f.personaId)} (${f.model}): ${f.error}`);
  }
  return lines.join("\n");
}
