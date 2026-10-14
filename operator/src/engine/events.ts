/**
 * Everything that happens in a run is an event. Events drive the live console,
 * are persisted to runs/<id>/events.jsonl, and are the raw material of the
 * evidence report. Nothing about a run is known only to the model.
 */
import { EventEmitter } from "node:events";
import type { Usage } from "../config.ts";

export type Phase =
  | "understanding" | "planning" | "executing" | "awaiting_human" | "verifying"
  | "completed" | "escalated" | "blocked" | "needs_review" | "failed" | "cancelled";

export interface TaskBrief {
  intended_outcome: string;
  interpretation: string;
  success_criteria: string[];
  procedures: string[];
  systems: string[];
  assumptions: string[];
  risks: string[];
  needs_human_input: boolean;
}

export interface PlanStep {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "done" | "blocked" | "skipped";
  system?: string;
  note?: string;
}

export interface Verdict {
  overall: "pass" | "fail";
  criteria: { criterion: string; status: "pass" | "fail" | "unverifiable"; evidence: string }[];
  sop_compliance: string;
  notes: string;
}

export type HumanRequest =
  | { reqId: string; kind: "question"; question: string; options?: string[]; context?: string }
  | { reqId: string; kind: "approval"; approvalKind: string; title: string; details: Record<string, unknown>; justification: string; approver: string };

export type HumanResponse =
  | { reqId: string; kind: "answer"; answer: string; by: string }
  | { reqId: string; kind: "decision"; approved: boolean; note?: string; by: string };

export type RunEventBody =
  | { type: "run_started"; request: string; scenario?: string; model: string }
  | { type: "phase"; phase: Phase }
  | { type: "thinking"; text: string }
  | { type: "assistant_text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown; toolset?: string }
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
  | { type: "run_finished"; status: Phase; summary: string; outcome?: unknown }
  | { type: "error"; message: string };

export type RunEvent = RunEventBody & { runId: string; seq: number; ts: string; actor?: "operator" | "verifier" };

export class EventBus extends EventEmitter {
  emitEvent(e: RunEvent) { this.emit("event", e); }
  onEvent(fn: (e: RunEvent) => void) { this.on("event", fn); return () => this.off("event", fn); }
}

export const bus = new EventBus();
bus.setMaxListeners(100);
