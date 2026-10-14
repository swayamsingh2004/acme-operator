/**
 * An operator run: one company request → completed, verified work.
 *
 *   understanding ─submit_task_brief→ planning ─update_plan→ executing ⇄ awaiting_human
 *        ─complete_task→ verifying ─pass→ completed | escalated | blocked
 *                                  └fail→ executing (fix & retry, max N rounds) → needs_review
 *
 * The state machine lives here, in code. The model drives it through control
 * tools, but cannot skip states: gates refuse out-of-order actions and the
 * policy guard keeps systems read-only until a brief and plan exist.
 */
import { CONFIG, emptyUsage } from "../config.ts";
import { loadCompany } from "../context/company.ts";
import { Recorder } from "../evidence/recorder.ts";
import { renderMarkdown, type RunReport } from "../evidence/report.ts";
import { broker, type AutoResponder } from "../human/broker.ts";
import { Guard } from "../policy/guard.ts";
import { BrowserSession, browserTools } from "../tools/browser.ts";
import { controlTools } from "../tools/control.ts";
import { DesktopDriver, OBSERVE_ACTIONS } from "../tools/desktop.ts";
import { fileTools } from "../tools/files.ts";
import { humanTools } from "../tools/human.ts";
import { knowledgeTools } from "../tools/knowledge.ts";
import type { CompletionClaim, RunState, ToolContext, ToolDef, ToolOutput } from "../tools/types.ts";
import { runVerifier } from "../verify/verifier.ts";
import type { Phase } from "./events.ts";
import { runLoop } from "./loop.ts";
import { OPERATOR_SYSTEM } from "./prompts.ts";

export interface RunOptions {
  request: string;
  requestedBy?: string;
  scenario?: string;
  signal?: AbortSignal;
  /** Automatic human (CLI prompt or eval script). Without one, requests wait for the console. */
  responder?: AutoResponder;
  onStart?: (runId: string) => void;
}

export const OPERATOR_TOOLS: ToolDef[] = [...knowledgeTools, ...fileTools, ...browserTools, ...humanTools, ...controlTools];

const OUTCOME_STATUS: Record<CompletionClaim["outcome"], Phase> = {
  completed: "completed", partially_completed: "needs_review", escalated: "escalated", blocked: "blocked", failed: "failed",
};

export async function runOperator(opts: RunOptions): Promise<RunReport> {
  const started = new Date();
  const recorder = new Recorder();
  const company = loadCompany();
  const requestedBy = opts.requestedBy ?? "Dana Whitfield (Controller)";
  const guard = new Guard(company.permissions, { readOnly: true });
  const browser = new BrowserSession(guard, recorder, "operator");
  const desktop = new DesktopDriver(recorder, "operator");
  const usage = emptyUsage();
  const state: RunState = { brief: null, plan: [], approvals: [], answers: [], evidence: [], completion: null, verdicts: [] };
  let phase: Phase = "understanding";
  let finalStatus: Phase | null = null;
  let verifyRounds = 0;
  let error: string | undefined;

  const setPhase = (p: Phase) => { if (p !== phase) { phase = p; recorder.emit({ type: "phase", phase: p }); } };
  if (opts.responder) broker.setResponder(recorder.id, opts.responder);
  opts.onStart?.(recorder.id);

  const complete = async (claim: CompletionClaim): Promise<ToolOutput> => {
    verifyRounds++;
    setPhase("verifying");
    const verdict = await runVerifier({ runId: recorder.id, recorder, company, broker, request: opts.request, requestedBy, state, claim, round: verifyRounds, usage, signal: opts.signal });
    state.verdicts.push(verdict);
    const failed = verdict.criteria.filter((c) => c.status !== "pass");
    const table = verdict.criteria.map((c) => `- [${c.status.toUpperCase()}] ${c.criterion} — ${c.evidence}`).join("\n");
    if (verdict.overall === "pass") {
      finalStatus = OUTCOME_STATUS[claim.outcome];
      return { content: `Independent verification PASSED.\n${table}\nThe run is complete.`, summary: "verification passed" };
    }
    if (verifyRounds >= CONFIG.maxVerificationRounds) {
      finalStatus = "needs_review";
      return { content: `Independent verification FAILED again; the run ends and is flagged for human review.\n${table}`, summary: "verification failed — needs review" };
    }
    setPhase("executing");
    return {
      content: `Independent verification FAILED (round ${verifyRounds}). Findings:\n${table}\nVerifier notes: ${verdict.notes}\n\nFix what is actually wrong (re-check the systems first — the verifier can also be mistaken; if so, gather evidence that shows it). Update the plan, then call complete_task again. ${failed.length} criterion/criteria not passing.`,
      summary: "verification failed — back to operator",
      isError: true,
    };
  };

  const ctx: ToolContext = { runId: recorder.id, actor: "operator", company, recorder, broker, guard, browser, desktop, state, hooks: { setPhase, complete } };

  recorder.emit({ type: "run_started", request: opts.request, scenario: opts.scenario, model: CONFIG.operatorModel });
  recorder.emit({ type: "phase", phase });

  const desktopUp = await desktop.available();
  const first = [
    `<request from="${requestedBy}" received="${started.toISOString().slice(0, 16).replace("T", " ")}">\n${opts.request}\n</request>`,
    `<company_context>\n${company.preamble()}\n</company_context>`,
    `<environment>\nToday is ${started.toDateString()} (business date ${started.toISOString().slice(0, 10)}).\nAcme Treasury desktop: ${desktopUp ? "online" : "OFFLINE — if the task needs it, report that it is unavailable"}.\nShared drive root for file tools: drive/ · Files you download from web systems: downloads/\n</environment>`,
    "Begin by understanding the request: find the governing procedures and look at the records involved. Then submit your task brief.",
  ].join("\n\n");
  const transcript: unknown[] = [];

  let turns = 0;
  let servedBy = CONFIG.operatorModel;
  try {
    const res = await runLoop({
      actor: "operator", model: CONFIG.operatorModel, thinking: CONFIG.operatorThinking, system: OPERATOR_SYSTEM,
      tools: OPERATOR_TOOLS, computer: true, firstInput: first, transcript, ctx, usage,
      maxTurns: CONFIG.maxTurns, maxCostUsd: CONFIG.maxCostUsd, signal: opts.signal,
      isDone: () => finalStatus !== null,
      onIdle: (_text, n) => {
        if (n > 3) return null;
        if (!state.brief) return "Continue: understand the request and call submit_task_brief.";
        if (!state.plan.length) return "Continue: call update_plan with your plan.";
        return "You ended your turn without a tool call. If the work is finished, re-check the systems and call complete_task; if you are blocked, ask_human; otherwise continue with the next step.";
      },
      gate: (name, _input, def) => {
        if (def?.gate === "after_brief" && !state.brief) return "Refused by harness: submit your task brief (submit_task_brief) first.";
        if (def?.gate === "after_plan" && !state.plan.length) return "Refused by harness: create a plan (update_plan) before changing anything.";
        if (!def && !OBSERVE_ACTIONS.has(name) && !state.plan.length) return "Refused by harness: Treasury actions other than take_screenshot require a brief and a plan first.";
        return null;
      },
    });
    turns = res.turns;
    if (res.route.current !== res.route.primary) servedBy = `${res.route.primary} → ${res.route.current} (fallback: primary overloaded)`;
    if (!finalStatus) {
      finalStatus = res.end === "cancelled" ? "cancelled" : "failed";
      error = { max_turns: "Turn limit reached before completion.", budget: "Cost budget reached before completion.", refusal: "The model declined to continue.", idle: "The operator stopped without completing the task.", cancelled: "Cancelled by supervisor.", done: undefined }[res.end];
    }
  } catch (e: any) {
    finalStatus = opts.signal?.aborted ? "cancelled" : "failed";
    error = String(e?.message ?? e);
    recorder.emit({ type: "error", message: error });
  } finally {
    await browser.close();
    broker.cancel(recorder.id);
    broker.setResponder(recorder.id, undefined);
  }

  const status = finalStatus!;
  setPhase(status);
  const report: RunReport = {
    id: recorder.id, request: opts.request, requestedBy, scenario: opts.scenario, status, model: servedBy,
    startedAt: started.toISOString(), finishedAt: new Date().toISOString(), durationSec: (Date.now() - started.getTime()) / 1000,
    usage, turns, state, error,
    policyBlocks: recorder.events.filter((e) => e.type === "policy").map((e: any) => ({ rule: e.rule, effect: e.effect, detail: e.detail })),
    toolCalls: recorder.events.filter((e) => e.type === "tool_call").length,
  };
  recorder.writeJson("report.json", report);
  recorder.writeText("report.md", renderMarkdown(report, recorder.events));
  recorder.writeJson("transcript.json", transcript);
  recorder.emit({ type: "run_finished", status, summary: state.completion?.summary ?? error ?? "", outcome: state.completion });
  return report;
}

