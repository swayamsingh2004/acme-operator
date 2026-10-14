import type { CompanyContext } from "../context/company.ts";
import type { Recorder } from "../evidence/recorder.ts";
import type { HumanBroker } from "../human/broker.ts";
import type { Guard } from "../policy/guard.ts";
import type { BrowserSession } from "./browser.ts";
import type { DesktopDriver } from "./desktop.ts";

/** Provider-neutral tool result: plain text, or text + image parts (screenshots, scans). */
export type ResultContent = string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mime_type: string }>;

export interface ToolOutput {
  content: ResultContent;
  isError?: boolean;
  /** One-line summary for the live console / event log. */
  summary: string;
  /** Run-relative path of a screenshot taken as evidence for this step. */
  image?: string;
}

/**
 * When a tool may run. The harness enforces this (not the prompt):
 *  any         — always (reading docs, files, looking at systems, asking a human)
 *  after_brief — once the task brief is recorded
 *  after_plan  — once a plan exists (anything that can change state)
 */
export type Gate = "any" | "after_brief" | "after_plan";

export interface ToolContext {
  runId: string;
  actor: "operator" | "verifier";
  company: CompanyContext;
  recorder: Recorder;
  broker: HumanBroker;
  guard: Guard;
  browser: BrowserSession;
  desktop: DesktopDriver;
  /** Mutable run state the control tools update. */
  state: RunState;
  /** Harness callbacks (phase transitions, completion → independent verification). */
  hooks: {
    setPhase(p: import("../engine/events.ts").Phase): void;
    complete(claim: CompletionClaim): Promise<ToolOutput>;
    verdict?(v: import("../engine/events.ts").Verdict): void;
  };
}

export interface RunState {
  brief: import("../engine/events.ts").TaskBrief | null;
  plan: import("../engine/events.ts").PlanStep[];
  approvals: { kind: string; title: string; details: unknown; approved: boolean; by: string; note?: string; result?: string }[];
  answers: { question: string; answer: string; by: string }[];
  evidence: { label: string; detail: string; image?: string }[];
  completion: CompletionClaim | null;
  verdicts: import("../engine/events.ts").Verdict[];
}

export interface CompletionClaim {
  outcome: "completed" | "partially_completed" | "escalated" | "blocked" | "failed";
  summary: string;
  items: { item: string; outcome: string; detail: string }[];
  follow_ups: string[];
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  gate: Gate;
  /** Available to the independent verifier (observation-only tools). */
  verifier?: boolean;
  run(input: any, ctx: ToolContext): Promise<ToolOutput>;
}

/** Compact helpers for JSON-schema authoring (strict-mode compatible). */
export const S = {
  obj(props: Record<string, unknown>, required: string[] = Object.keys(props)) {
    return { type: "object", properties: props, required, additionalProperties: false };
  },
  str(description: string, extra: Record<string, unknown> = {}) { return { type: "string", description, ...extra }; },
  num(description: string) { return { type: "number", description }; },
  bool(description: string) { return { type: "boolean", description }; },
  arr(items: unknown, description?: string) { return { type: "array", items, ...(description ? { description } : {}) }; },
  enum(values: string[], description: string) { return { type: "string", enum: values, description }; },
};

export const text = (t: string): ResultContent => t;
