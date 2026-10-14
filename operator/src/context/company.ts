/**
 * Company context: the handbook (SOPs/policies), the systems registry, the
 * operator's machine-enforced permissions, and learned memory. Loaded fresh
 * for every run so edits to company documents take effect immediately.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { PATHS } from "../config.ts";

export interface HandbookDoc { id: string; title: string; summary: string; owner: string; updated: string; file: string; body: string }
interface Chunk { doc: HandbookDoc; heading: string; text: string; tokens: string[] }

export interface Permissions {
  browser: {
    allowed_origins: string[];
    rules: { id: string; effect: "forbid" | "require_approval"; origin?: string; method?: string; path: string; recipient_domains_allowed?: string[]; reason: string }[];
  };
  files: { read: string[]; write: string[]; move_from: string[] };
  approvals: { kinds: Record<string, { approver: string; hook: string; required_fields?: string[] }> };
  limits: Record<string, number>;
}

export interface CompanyContext {
  docs: HandbookDoc[];
  systems: any;
  permissions: Permissions;
  memory: string;
  search(query: string, k?: number): { doc: string; title: string; heading: string; snippet: string; score: number }[];
  preamble(): string;
}

function parseDoc(file: string): HandbookDoc {
  const raw = fs.readFileSync(file, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const meta = m ? YAML.parse(m[1]) : {};
  return { id: meta.id ?? path.basename(file, ".md"), title: meta.title ?? path.basename(file), summary: meta.summary ?? "", owner: meta.owner ?? "", updated: String(meta.updated ?? ""), file: path.relative(PATHS.root, file), body: m ? m[2] : raw };
}

const STOP = new Set("the a an and or of to in on for is are be by with from as at it this that if not no any all must may our we you your its into than then".split(" "));
const tokenize = (s: string) => s.toLowerCase().replace(/[^a-z0-9$.\- ]/g, " ").split(/\s+/).map((t) => t.replace(/^[.\-]+|[.\-]+$/g, "")).filter((t) => t.length > 1 && !STOP.has(t));

/** Split a markdown doc into heading-scoped chunks for retrieval. */
function chunk(doc: HandbookDoc): Chunk[] {
  const out: Chunk[] = [];
  let heading = doc.title, buf: string[] = [];
  const flush = () => { const text = buf.join("\n").trim(); if (text) out.push({ doc, heading, text, tokens: tokenize(`${doc.title} ${heading} ${text}`) }); buf = []; };
  for (const line of doc.body.split("\n")) {
    if (/^#{1,3} /.test(line)) { flush(); heading = line.replace(/^#+ /, ""); } else buf.push(line);
  }
  flush();
  return out;
}

/** Plain BM25 over heading chunks — the handbook is small, so no vector DB is needed. */
function bm25(chunks: Chunk[]) {
  const N = chunks.length, avg = chunks.reduce((s, c) => s + c.tokens.length, 0) / Math.max(N, 1);
  const df = new Map<string, number>();
  for (const c of chunks) for (const t of new Set(c.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  return (query: string, k: number) => {
    const q = tokenize(query);
    return chunks
      .map((c) => {
        let score = 0;
        for (const t of q) {
          const f = c.tokens.filter((x) => x === t).length;
          if (!f) continue;
          const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
          score += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (c.tokens.length / avg))));
        }
        return { c, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  };
}

export function loadCompany(): CompanyContext {
  const docs = fs.readdirSync(PATHS.handbook).filter((f) => f.endsWith(".md")).sort().map((f) => parseDoc(path.join(PATHS.handbook, f)));
  const systems = YAML.parse(fs.readFileSync(path.join(PATHS.company, "systems.yaml"), "utf8"));
  const permissions = YAML.parse(fs.readFileSync(path.join(PATHS.company, "permissions.yaml"), "utf8")) as Permissions;
  const memory = fs.existsSync(PATHS.memory) ? fs.readFileSync(PATHS.memory, "utf8") : "";
  const search = bm25(docs.flatMap(chunk));
  return {
    docs, systems, permissions, memory,
    search(query, k = 5) {
      return search(query, k).map(({ c, score }) => ({ doc: c.doc.id, title: c.doc.title, heading: c.heading, snippet: c.text.slice(0, 1200), score: Math.round(score * 100) / 100 }));
    },
    preamble() {
      const sys = (systems.systems as any[]).map((s) => `- **${s.name}** (id \`${s.id}\`, ${s.kind}${s.url ? `, ${s.url}` : ""}) — source of truth for: ${(s.source_of_truth_for ?? []).join(", ")}${s.folders ? `; folders: ${s.folders.join(", ")}` : ""}. Access: ${s.how_to_access}`).join("\n");
      const idx = docs.map((d) => `- \`${d.id}\` **${d.title}** — ${d.summary}`).join("\n");
      return [
        `## Company: ${systems.company.name}`,
        `You are ${systems.company.operator_identity}. Supervisor: ${systems.company.supervisor}.`,
        `\n## Systems you can use\n${sys}`,
        `\n## Company handbook (read the relevant documents before acting)\n${idx}`,
        `\n## Machine-enforced limits (the harness blocks violations)\n- Browser may only reach: ${permissions.browser.allowed_origins.join(", ")}\n${permissions.browser.rules.map((r) => `- [${r.effect}] ${r.reason}`).join("\n")}\n- Drive write access: ${permissions.files.write.join(", ")}\n- Approval request kinds: ${Object.entries(permissions.approvals.kinds).map(([k, v]) => `\`${k}\` (approver: ${v.approver}; fields: ${(v.required_fields ?? []).join(", ") || "none"})`).join("; ")}`,
        `\n## Operator memory (lessons from earlier runs)\n${memory.trim() || "(none)"}`,
      ].join("\n");
    },
  };
}
