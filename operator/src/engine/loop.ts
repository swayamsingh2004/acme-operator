/**
 * The agent loop shared by the operator and the verifier:
 *
 *   model turn → tool calls → harness gates → execute → observe (results,
 *   screenshots, policy blocks) → harness notes (stuck/budget) → next turn
 *
 * Uses Gemini's stateful Interactions API: each turn sends only the new steps
 * (function results + harness notes) and chains on previous_interaction_id.
 */
import Ajv from "ajv";
import { addUsage, type ThinkingLevel, type Usage } from "../config.ts";
import { COMPUTER_ACTIONS, COMPUTER_TOOL } from "../tools/desktop.ts";
import type { ToolContext, ToolDef, ToolOutput } from "../tools/types.ts";
import { callModel, newRoute, type InputStep, type ModelRoute, type Step } from "./llm.ts";

const ajv = new Ajv({ allErrors: true, strict: false });

export interface LoopOptions {
  actor: "operator" | "verifier";
  model: string;
  thinking: ThinkingLevel;
  system: string;
  tools: ToolDef[];
  computer: boolean;
  /** First user message (request + company context). */
  firstInput: string;
  ctx: ToolContext;
  usage: Usage;
  maxTurns: number;
  maxCostUsd: number;
  signal?: AbortSignal;
  /** Local transcript (every input and output step, images stripped) for the evidence folder. */
  transcript: unknown[];
  isDone(): boolean;
  /** Called when the model ends a turn without tool calls. Return a nudge to continue, or null to stop. */
  onIdle(text: string, idleCount: number): string | null;
  /** Harness gate: return an error message to refuse a call. */
  gate?(name: string, input: any, def: ToolDef | undefined): string | null;
}

export type LoopEnd = "done" | "idle" | "max_turns" | "budget" | "refusal" | "cancelled";

export function toolParams(defs: ToolDef[], computer: boolean): any[] {
  const tools: any[] = defs.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.input_schema }));
  if (computer) tools.push(COMPUTER_TOOL);
  return tools;
}

const stripImages = (x: any): any =>
  Array.isArray(x) ? x.map(stripImages)
    : x && typeof x === "object" ? (x.type === "image" && x.data ? { type: "image", omitted: true } : Object.fromEntries(Object.entries(x).map(([k, v]) => [k, stripImages(v)])))
    : x;

export interface LoopResult { end: LoopEnd; turns: number; lastText: string; lastInteractionId?: string; route: ModelRoute }

export async function runLoop(o: LoopOptions): Promise<LoopResult> {
  const { ctx } = o;
  const recorder = ctx.recorder;
  const tools = toolParams(o.tools, o.computer);
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const validators = new Map(o.tools.map((t) => [t.name, ajv.compile(t.input_schema)]));
  const recent: string[] = [];
  let idle = 0, turns = 0, lastText = "", warnedBudget = false;
  let input: string | InputStep[] = o.firstInput;
  let previousId: string | undefined;
  const route = newRoute(o.model);
  if (route.current !== o.model) recorder.emit({ type: "harness", message: `${o.model} was recently overloaded; using ${route.current} for this ${o.actor} session.` }, o.actor);

  while (true) {
    if (o.signal?.aborted) return { end: "cancelled", turns, lastText, lastInteractionId: previousId, route };
    if (turns >= o.maxTurns) return { end: "max_turns", turns, lastText, lastInteractionId: previousId, route };
    if (o.usage.costUsd >= o.maxCostUsd) return { end: "budget", turns, lastText, lastInteractionId: previousId, route };
    turns++;

    const res = await callModel({
      route, thinking: o.thinking, system: o.system, tools, input, previousId, signal: o.signal,
      onNotice: (m) => recorder.emit({ type: "harness", message: m }, o.actor),
    });
    o.transcript.push({ turn: turns, interaction: res.id, input: stripImages(input), output: stripImages(res.steps), status: res.status });
    previousId = res.id;
    addUsage(o.usage, res.model, res.usage);
    recorder.emit({ type: "usage", usage: { ...o.usage }, turns }, o.actor);

    const calls: Extract<Step, { type: "function_call" }>[] = [];
    for (const s of res.steps) {
      if (s.type === "thought") {
        const text = (s.summary ?? []).map((c: any) => c.text ?? "").join("\n").trim();
        if (text) recorder.emit({ type: "thinking", text }, o.actor);
      } else if (s.type === "model_output") {
        const text = (s.content ?? []).map((c: any) => c.text ?? "").join("").trim();
        if (text) { lastText = text; recorder.emit({ type: "assistant_text", text }, o.actor); }
        if (s.error?.message) recorder.emit({ type: "error", message: s.error.message }, o.actor);
      } else if (s.type === "function_call") calls.push(s as any);
    }

    if (["failed", "cancelled"].includes(res.status) && !calls.length) {
      recorder.emit({ type: "error", message: `Interaction ${res.status}.` }, o.actor);
      return { end: "refusal", turns, lastText, lastInteractionId: previousId, route };
    }

    if (!calls.length) {
      if (o.isDone()) return { end: "done", turns, lastText, lastInteractionId: previousId, route };
      const nudge = o.onIdle(lastText, ++idle);
      if (!nudge) return { end: "idle", turns, lastText, lastInteractionId: previousId, route };
      recorder.emit({ type: "harness", message: nudge }, o.actor);
      input = [{ type: "user_input", content: [{ type: "text", text: `[harness] ${nudge}` }] }];
      continue;
    }
    idle = 0;

    const next: InputStep[] = [];
    const notes: string[] = [];
    let computerHalted = false;

    for (const call of calls) {
      // Gemini may attach a safety_decision to ANY call (desktop actions, but also e.g. sending
      // an email). It is not a tool argument: strip it, and if it requires confirmation a
      // human must confirm before the tool runs.
      const { safety_decision: safety, ...args } = (call.arguments ?? {}) as Record<string, any>;
      const def = byName.get(call.name);
      const isComputer = !def && COMPUTER_ACTIONS.has(call.name);
      recorder.emit({ type: "tool_call", id: call.id, name: call.name, input: args, toolset: isComputer ? "computer" : undefined }, o.actor);
      const t0 = Date.now();
      let out: ToolOutput;

      if (o.signal?.aborted) out = { content: "Run cancelled by supervisor.", isError: true, summary: "cancelled" };
      else if (isComputer && computerHalted) out = { content: "Not executed: an earlier computer action in this turn failed.", isError: true, summary: "not executed (batch halted)" };
      else {
        const gateMsg = o.gate?.(call.name, args, def) ?? null;
        const confirm = gateMsg ? null : await confirmIfRequired(call.name, args, safety, o);
        if (gateMsg) out = { content: gateMsg, isError: true, summary: `refused by harness: ${gateMsg.slice(0, 70)}` };
        else if (confirm?.denied) out = confirm.denied;
        else if (isComputer) out = await o.ctx.desktop.run(call.name, args, confirm ? { safety_acknowledgement: true } : {});
        else if (!def) out = { content: `Unknown tool '${call.name}'.`, isError: true, summary: "unknown tool" };
        else {
          const valid = validators.get(call.name)!;
          if (!valid(args)) out = { content: `Invalid arguments for ${call.name}: ${ajv.errorsText(valid.errors)}`, isError: true, summary: "invalid arguments" };
          else {
            try {
              out = await def.run(args, ctx);
              if (confirm && typeof out.content === "string") out.content = `[safety_acknowledgement: confirmed by ${confirm.by}]\n${out.content}`;
            }
            catch (e: any) { out = { content: `Tool error: ${e?.message ?? e}`, isError: true, summary: `error: ${String(e?.message ?? e).slice(0, 80)}` }; }
          }
        }
        if (isComputer && out.isError) computerHalted = true;
      }

      recorder.emit({ type: "tool_result", id: call.id, name: call.name, ok: !out.isError, summary: out.summary, image: out.image, ms: Date.now() - t0 }, o.actor);
      next.push({ type: "function_result", call_id: call.id, name: call.name, result: out.content as any, ...(out.isError ? { is_error: true } : {}) });

      // Stuck detection: the same state-changing call (same arguments) repeated with no progress.
      if (!["take_screenshot", "wait", "browser_snapshot", "update_plan"].includes(call.name)) {
        const { intent: _i, ...rest } = args as any;
        const sig = `${call.name}:${JSON.stringify(rest)}`;
        recent.push(sig);
        if (recent.length > 6) recent.shift();
        const n = recent.filter((s) => s === sig).length;
        if (n >= 3) notes.push(`You have made the same ${call.name} call ${n} times recently. It is not working — step back, look at the current state, and try a different approach, or escalate with ask_human.`);
      }
    }

    if (!warnedBudget && (o.usage.costUsd > o.maxCostUsd * 0.8 || turns > o.maxTurns * 0.8)) {
      warnedBudget = true;
      notes.push(`Budget notice: ${turns}/${o.maxTurns} turns and $${o.usage.costUsd.toFixed(2)}/$${o.maxCostUsd} used. Prioritise finishing and verifying the most important items; report anything left undone.`);
    }
    for (const n of [...new Set(notes)]) { next.push({ type: "user_input", content: [{ type: "text", text: `[harness] ${n}` }] }); recorder.emit({ type: "harness", message: n }, o.actor); }
    input = next;

    if (o.isDone()) return { end: "done", turns, lastText, lastInteractionId: previousId, route };
  }
}

/**
 * Gemini's safety layer can mark a call `require_confirmation`. Route that to a
 * human (the same approval channel as policy approvals); the verifier is never
 * allowed to confirm. Returns null when no confirmation is needed.
 */
async function confirmIfRequired(name: string, args: any, safety: any, o: LoopOptions): Promise<{ by: string; denied?: undefined } | { denied: ToolOutput; by?: undefined } | null> {
  if (safety?.decision !== "require_confirmation") return null;
  const deny = (reason: string, summary: string) => ({ denied: { content: JSON.stringify({ status: "denied", reason }), isError: true, summary } });
  if (o.actor === "verifier") return deny("The verifier may not perform actions that need confirmation.", "safety confirmation denied (verifier)");
  const { ctx } = o;
  const reqId = ctx.broker.newId();
  const what = args.intent ?? (name === "browser_fill" ? "submit a form" : name);
  const request = {
    reqId, kind: "approval" as const, approvalKind: "safety_confirmation", title: `Confirm: ${what}`,
    details: { tool: name, ...(args.url ? { url: args.url } : {}), explanation: safety.explanation ?? "" },
    justification: `Gemini's safety layer asked for human confirmation before this action. ${safety.explanation ?? ""}`,
    approver: "Dana Whitfield (Controller)",
  };
  ctx.hooks.setPhase("awaiting_human");
  ctx.recorder.emit({ type: "human_request", request });
  const r = await ctx.broker.request(ctx.runId, request);
  ctx.recorder.emit({ type: "human_response", response: r });
  ctx.hooks.setPhase("executing");
  const ok = r.kind === "decision" && r.approved;
  ctx.state.approvals.push({ kind: "safety_confirmation", title: request.title, details: request.details, approved: ok, by: r.by, note: r.kind === "decision" ? r.note : r.answer });
  return ok ? { by: r.by } : deny("A human declined to confirm this action. Do not retry it; report it.", "safety confirmation declined");
}
