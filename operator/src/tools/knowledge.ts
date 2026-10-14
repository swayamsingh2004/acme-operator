/** Company knowledge tools: search and read the handbook, and save durable lessons to memory. */
import fs from "node:fs";
import { PATHS } from "../config.ts";
import { S, type ToolDef } from "./types.ts";

export const knowledgeTools: ToolDef[] = [
  {
    name: "search_company_docs",
    description: "Search the company handbook (SOPs, policies, approval matrix, contacts, systems guide). Returns the best-matching sections with their document id. Use it to find the procedure that governs the task before acting.",
    input_schema: S.obj({ query: S.str("What you need to know, e.g. 'duplicate invoice check' or 'bank details change request'") }),
    gate: "any", verifier: true,
    async run(input, ctx) {
      const hits = ctx.company.search(input.query, 5);
      if (!hits.length) return { content: "No matching handbook sections. Try different words, or list documents in the company context.", summary: `no results for "${input.query}"` };
      return {
        content: hits.map((h) => `### ${h.doc} — ${h.title} › ${h.heading} (score ${h.score})\n${h.snippet}`).join("\n\n"),
        summary: `${hits.length} result(s): ${[...new Set(hits.map((h) => h.doc))].join(", ")}`,
      };
    },
  },
  {
    name: "read_company_doc",
    description: "Read a full handbook document by id (e.g. AP-01, POL-01).",
    input_schema: S.obj({ id: S.str("Document id from the handbook index, e.g. AP-02") }),
    gate: "any", verifier: true,
    async run(input, ctx) {
      const d = ctx.company.docs.find((x) => x.id.toLowerCase() === String(input.id).trim().toLowerCase());
      if (!d) return { content: `No document '${input.id}'. Available: ${ctx.company.docs.map((x) => x.id).join(", ")}`, isError: true, summary: `unknown doc ${input.id}` };
      return { content: `# ${d.id} — ${d.title}\nOwner: ${d.owner} · Updated: ${d.updated}\n\n${d.body}`, summary: `read ${d.id} ${d.title}` };
    },
  },
  {
    name: "remember",
    description: "Save a short, durable lesson for future runs (e.g. a system quirk or a vendor-specific convention you discovered). Do not store task results or personal data.",
    input_schema: S.obj({ lesson: S.str("One sentence: context · lesson") }),
    gate: "any",
    async run(input) {
      const line = `- ${new Date().toISOString().slice(0, 10)} · ${String(input.lesson).replace(/\s+/g, " ").trim()}\n`;
      fs.appendFileSync(PATHS.memory, line);
      return { content: "Saved to operator memory.", summary: `remembered: ${String(input.lesson).slice(0, 80)}` };
    },
  },
];
