/**
 * Independent verification. A second agent, with a fresh context and an
 * observation-only toolset (its browser runs behind a read-only policy guard),
 * checks the operator's success criteria — and anything the criteria missed —
 * directly in the systems of record, then submits a structured verdict.
 */
import { CONFIG, type Usage } from "../config.ts";
import type { CompanyContext } from "../context/company.ts";
import { VERIFIER_SYSTEM } from "../engine/prompts.ts";
import type { Verdict } from "../engine/events.ts";
import { runLoop } from "../engine/loop.ts";
import type { Recorder } from "../evidence/recorder.ts";
import type { HumanBroker } from "../human/broker.ts";
import { Guard } from "../policy/guard.ts";
import { BrowserSession, browserTools } from "../tools/browser.ts";
import { DesktopDriver } from "../tools/desktop.ts";
import { fileTools } from "../tools/files.ts";
import { knowledgeTools } from "../tools/knowledge.ts";
import { S, type CompletionClaim, type RunState, type ToolDef } from "../tools/types.ts";

const submitVerdict: ToolDef = {
  name: "submit_verdict",
  description: "Submit your verification verdict (once, at the end).",
  input_schema: S.obj({
    criteria: S.arr(S.obj({
      criterion: S.str("The criterion checked (operator's or one you added)"),
      status: S.enum(["pass", "fail", "unverifiable"], "Result"),
      evidence: S.str("What you observed, where (ids, amounts, statuses), or why it cannot be observed"),
    })),
    sop_compliance: S.str("Assessment of the key controls/procedures that applied"),
    overall: S.enum(["pass", "fail"], "pass only if no criterion failed and the essential ones were observed"),
    notes: S.str("Anything the operator or supervisor must know (problems to fix, risks)"),
  }),
  gate: "any",
  async run(input, ctx) {
    ctx.hooks.verdict?.(input as Verdict);
    return { content: "Verdict recorded.", summary: `verdict: ${input.overall}` };
  },
};

export async function runVerifier(p: {
  runId: string; recorder: Recorder; company: CompanyContext; broker: HumanBroker;
  request: string; requestedBy: string; state: RunState; claim: CompletionClaim; round: number;
  usage: Usage; signal?: AbortSignal;
}): Promise<Verdict> {
  const guard = new Guard(p.company.permissions, { readOnly: true });
  const browser = new BrowserSession(guard, p.recorder, "verifier");
  const desktop = new DesktopDriver(p.recorder, "verifier");
  let verdict: Verdict | null = null;
  const vstate: RunState = { brief: null, plan: [], approvals: [], answers: [], evidence: [], completion: null, verdicts: [] };
  const ctx = {
    runId: p.runId, actor: "verifier" as const, company: p.company, recorder: p.recorder, broker: p.broker, guard, browser, desktop, state: vstate,
    hooks: { setPhase() {}, async complete() { return { content: "n/a", summary: "n/a" }; }, verdict: (v: Verdict) => { verdict = v; } },
  };
  const tools = [...knowledgeTools.filter((t) => t.verifier), ...fileTools.filter((t) => t.verifier), ...browserTools.filter((t) => t.verifier), submitVerdict];
  const s = p.state;
  const first = [
    `<request from="${p.requestedBy}">\n${p.request}\n</request>`,
    `<operator_brief>\n${JSON.stringify(s.brief, null, 2)}\n</operator_brief>`,
    `<operator_completion_claim round="${p.round}">\n${JSON.stringify(p.claim, null, 2)}\n</operator_completion_claim>`,
    `<human_interactions note="recorded by the harness, not by the operator">\n${JSON.stringify({ approvals: s.approvals, answers: s.answers }, null, 2)}\n</human_interactions>`,
    `<operator_evidence>\n${s.evidence.map((e) => `- ${e.label}: ${e.detail}`).join("\n") || "(none)"}\n</operator_evidence>`,
    p.round > 1 ? `<previous_verdicts>\n${JSON.stringify(s.verdicts, null, 2)}\n</previous_verdicts>` : "",
    `<company_context>\n${p.company.preamble()}\n</company_context>`,
    `Today is ${new Date().toDateString()}. Verify now, then call submit_verdict.`,
  ].filter(Boolean).join("\n\n");
  const transcript: unknown[] = [];

  p.recorder.emit({ type: "verification", round: p.round, status: "started" }, "verifier");
  try {
    await runLoop({
      actor: "verifier", model: CONFIG.verifierModel, thinking: CONFIG.verifierThinking, system: VERIFIER_SYSTEM,
      tools, computer: true, firstInput: first, transcript, ctx, usage: p.usage, maxTurns: 45, maxCostUsd: Number.POSITIVE_INFINITY, signal: p.signal,
      isDone: () => verdict !== null,
      onIdle: (_t, n) => (n <= 2 ? "Finish your checks and call submit_verdict." : null),
    });
  } finally {
    await browser.close();
    p.recorder.writeJson(`verifier-transcript-${p.round}.json`, transcript);
  }
  const v: Verdict = verdict ?? { overall: "fail", criteria: [], sop_compliance: "Verifier did not reach a verdict.", notes: "Verification incomplete — treat as unverified." };
  p.recorder.emit({ type: "verification", round: p.round, status: "finished", verdict: v }, "verifier");
  return v;
}
