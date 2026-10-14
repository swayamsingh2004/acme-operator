// Mirrors operator/src/engine/events.ts (kept separate so the console bundle has no server imports).
export type Phase =
  | "understanding" | "planning" | "executing" | "awaiting_human" | "verifying"
  | "completed" | "escalated" | "blocked" | "needs_review" | "failed" | "cancelled";

export interface TaskBrief { intended_outcome: string; interpretation: string; success_criteria: string[]; procedures: string[]; systems: string[]; assumptions: string[]; risks: string[]; needs_human_input: boolean }
export interface PlanStep { id: string; title: string; status: "pending" | "in_progress" | "done" | "blocked" | "skipped"; system?: string; note?: string }
export interface Verdict { overall: "pass" | "fail"; criteria: { criterion: string; status: "pass" | "fail" | "unverifiable"; evidence: string }[]; sop_compliance: string; notes: string }
export type HumanRequest =
  | { reqId: string; kind: "question"; question: string; options?: string[]; context?: string }
  | { reqId: string; kind: "approval"; approvalKind: string; title: string; details: Record<string, unknown>; justification: string; approver: string };
export type HumanResponse =
  | { reqId: string; kind: "answer"; answer: string; by: string }
  | { reqId: string; kind: "decision"; approved: boolean; note?: string; by: string };
export interface Usage { input: number; output: number; cached: number; thought: number; costUsd: number }

export type RunEvent = { runId: string; seq: number; ts: string; actor?: "operator" | "verifier" } & (
  | { type: "run_started"; request: string; scenario?: string; model: string }
  | { type: "phase"; phase: Phase }
  | { type: "thinking"; text: string }
  | { type: "assistant_text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: any; toolset?: string }
  | { type: "tool_result"; id: string; name: string; ok: boolean; summary: string; image?: string; ms: number }
  | { type: "brief"; brief: TaskBrief }
  | { type: "plan"; steps: PlanStep[] }
  | { type: "evidence"; label: string; detail: string; image?: string }
  | { type: "policy"; rule: string; effect: string; detail: string }
  | { type: "harness"; message: string }
  | { type: "human_request"; request: HumanRequest }
  | { type: "human_response"; response: HumanResponse }
  | { type: "verification"; round: number; status: "started" | "finished"; verdict?: Verdict }
  | { type: "usage"; usage: Usage; turns: number }
  | { type: "run_finished"; status: Phase; summary: string; outcome?: { outcome: string; summary: string; items: { item: string; outcome: string; detail: string }[]; follow_ups: string[] } }
  | { type: "error"; message: string }
);

export interface RunView {
  id: string;
  request: string;
  scenario?: string;
  phase: Phase;
  startedAt: string;
  lastAt: string;
  brief: TaskBrief | null;
  plan: PlanStep[];
  verdicts: Verdict[];
  usage: Usage | null;
  turns: number;
  pending: HumanRequest[];
  finished: Extract<RunEvent, { type: "run_finished" }> | null;
  lastBrowserShot: string | null;
  lastDesktopShot: string | null;
  evidence: { label: string; detail: string; image?: string }[];
  policyBlocks: number;
}

export function deriveRun(id: string, events: RunEvent[]): RunView {
  const v: RunView = { id, request: "", phase: "understanding", startedAt: "", lastAt: "", brief: null, plan: [], verdicts: [], usage: null, turns: 0, pending: [], finished: null, lastBrowserShot: null, lastDesktopShot: null, evidence: [], policyBlocks: 0 };
  const open = new Map<string, HumanRequest>();
  const calls = new Map<string, Extract<RunEvent, { type: "tool_call" }>>();
  for (const e of events) {
    v.lastAt = e.ts;
    switch (e.type) {
      case "run_started": v.request = e.request; v.scenario = e.scenario; v.startedAt = e.ts; break;
      case "phase": v.phase = e.phase; break;
      case "brief": v.brief = e.brief; break;
      case "plan": v.plan = e.steps; break;
      case "verification": if (e.verdict) v.verdicts.push(e.verdict); break;
      case "usage": v.usage = e.usage; v.turns = Math.max(v.turns, e.actor === "verifier" ? v.turns : e.turns); break;
      case "human_request": open.set(e.request.reqId, e.request); break;
      case "human_response": open.delete(e.response.reqId); break;
      case "run_finished": v.finished = e; v.phase = e.status; break;
      case "evidence": v.evidence.push({ label: e.label, detail: e.detail, image: e.image }); break;
      case "policy": v.policyBlocks++; break;
      case "tool_call": calls.set(e.id, e); break;
      case "tool_result":
        if (e.image) { if (calls.get(e.id)?.toolset === "computer" || /treasury/.test(e.image)) v.lastDesktopShot = e.image; else if (/browser|click|submit|login|evidence/.test(e.image)) v.lastBrowserShot = e.image; }
        break;
    }
  }
  v.pending = v.finished ? [] : [...open.values()];
  return v;
}
