/** Build the human-readable evidence report (report.md) and machine summary (report.json) for a run. */
import type { Usage } from "../config.ts";
import type { Phase, RunEvent } from "../engine/events.ts";
import type { RunState } from "../tools/types.ts";

export interface RunReport {
  id: string;
  request: string;
  requestedBy: string;
  scenario?: string;
  status: Phase;
  startedAt: string;
  finishedAt: string;
  durationSec: number;
  model: string;
  usage: Usage;
  turns: number;
  state: RunState;
  policyBlocks: { rule: string; effect: string; detail: string }[];
  toolCalls: number;
  error?: string;
}

const esc = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderMarkdown(r: RunReport, events: RunEvent[]): string {
  const s = r.state;
  const c = s.completion;
  const v = s.verdicts.at(-1);
  const out: string[] = [];
  out.push(`# Operator run ${r.id}`, "");
  out.push(`| | |`, `|---|---|`,
    `| **Request** | ${esc(r.request)} |`, `| **Requested by** | ${esc(r.requestedBy)} |`,
    `| **Status** | **${r.status.toUpperCase()}** |`, `| **Verification** | ${v ? `${v.overall.toUpperCase()} (round ${s.verdicts.length})` : "not run"} |`,
    `| **Duration** | ${Math.round(r.durationSec)}s · ${r.turns} model turns · ${r.toolCalls} tool calls |`,
    `| **Model** | ${r.model} |`,
    `| **Cost** | $${r.usage.costUsd.toFixed(2)} (${r.usage.input} input tokens, ${Math.round((100 * r.usage.cached) / Math.max(1, r.usage.input))}% cached; ${r.usage.output} output + ${r.usage.thought} thinking) |`, "");
  if (r.error) out.push(`> **Error:** ${r.error}`, "");

  out.push("## Outcome", "", c ? c.summary : "_The operator did not complete the task._", "");
  if (c?.items.length) {
    out.push("| Item | Outcome | Detail |", "|---|---|---|", ...c.items.map((i) => `| ${esc(i.item)} | ${esc(i.outcome)} | ${esc(i.detail)} |`), "");
  }
  if (c?.follow_ups.length) out.push("**Follow-ups for a human:**", ...c.follow_ups.map((f) => `- ${f}`), "");

  if (v) {
    out.push("## Independent verification", "", `Overall: **${v.overall.toUpperCase()}**`, "", "| Criterion | Result | Evidence observed |", "|---|---|---|",
      ...v.criteria.map((x) => `| ${esc(x.criterion)} | ${x.status === "pass" ? "✅ pass" : x.status === "fail" ? "❌ fail" : "⚠️ unverifiable"} | ${esc(x.evidence)} |`),
      "", `**Procedure compliance:** ${v.sop_compliance}`, "", v.notes ? `**Notes:** ${v.notes}` : "", "");
  }

  if (s.brief) {
    out.push("## Understanding (task brief)", "", `**Intended outcome:** ${s.brief.intended_outcome}`, "", `**Interpretation:** ${s.brief.interpretation}`, "",
      "**Success criteria:**", ...s.brief.success_criteria.map((x) => `- ${x}`), "",
      `**Procedures:** ${s.brief.procedures.join("; ")}`, "", `**Systems:** ${s.brief.systems.join(", ")}`, "");
    if (s.brief.assumptions.length) out.push("**Assumptions:**", ...s.brief.assumptions.map((x) => `- ${x}`), "");
    if (s.brief.risks.length) out.push("**Risks / red flags:**", ...s.brief.risks.map((x) => `- ${x}`), "");
  }

  if (s.plan.length) out.push("## Final plan", "", ...s.plan.map((p) => `- ${{ done: "☑", in_progress: "◐", blocked: "⛔", skipped: "⤼", pending: "☐" }[p.status]} **${p.id}.** ${p.title}${p.note ? ` — _${p.note}_` : ""}`), "");

  if (s.approvals.length || s.answers.length) {
    out.push("## Human-in-the-loop", "");
    for (const a of s.approvals) out.push(`- **Approval (${a.kind})** ${a.title} → ${a.approved ? "APPROVED" : "REJECTED"} by ${a.by}${a.note ? ` ("${a.note}")` : ""}${a.result ? ` · system: ${a.result}` : ""}`);
    for (const q of s.answers) out.push(`- **Question** ${q.question} → "${q.answer}" (${q.by})`);
    out.push("");
  }

  if (r.policyBlocks.length) out.push("## Policy guard interventions", "", ...r.policyBlocks.map((p) => `- \`${p.rule}\` (${p.effect}): ${p.detail}`), "");

  if (s.evidence.length) out.push("## Evidence", "", ...s.evidence.map((e) => `- **${e.label}** — ${e.detail}${e.image ? `\n\n  ![${e.label}](${e.image})` : ""}`), "");

  out.push("## Action timeline", "", "| # | Actor | Action | Result |", "|---|---|---|---|");
  const calls = new Map<string, RunEvent>();
  let n = 0;
  for (const e of events) {
    if (e.type === "tool_call") calls.set(e.id, e);
    if (e.type === "tool_result") {
      const call = calls.get(e.id) as Extract<RunEvent, { type: "tool_call" }> | undefined;
      const inp = call ? JSON.stringify(call.input) : "";
      out.push(`| ${++n} | ${e.actor} | \`${e.name}\` ${esc(inp.length > 90 ? inp.slice(0, 90) + "…" : inp)} | ${e.ok ? "" : "⚠️ "}${esc(e.summary)}${e.image ? ` ([shot](${e.image}))` : ""} |`);
    }
  }
  out.push("");
  return out.join("\n");
}
