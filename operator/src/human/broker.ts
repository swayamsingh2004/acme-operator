/**
 * Human-in-the-loop broker. The operator asks questions and requests approvals
 * through here; a person answers in the web console or CLI, or a scripted
 * responder answers in evals. The run simply awaits the promise.
 */
import crypto from "node:crypto";
import type { HumanRequest, HumanResponse } from "../engine/events.ts";

export type AutoResponder = (req: HumanRequest) => Promise<HumanResponse | undefined> | HumanResponse | undefined;

interface Pending { runId: string; request: HumanRequest; resolve: (r: HumanResponse) => void }

export class HumanBroker {
  private pending = new Map<string, Pending>();
  private responders = new Map<string, AutoResponder>();

  /** Register an automatic responder for a run (CLI prompt, eval script). */
  setResponder(runId: string, fn: AutoResponder | undefined) {
    if (fn) this.responders.set(runId, fn); else this.responders.delete(runId);
  }

  newId(): string { return crypto.randomBytes(4).toString("hex"); }

  async request(runId: string, request: HumanRequest): Promise<HumanResponse> {
    const auto = this.responders.get(runId);
    const p = new Promise<HumanResponse>((resolve) => this.pending.set(request.reqId, { runId, request, resolve }));
    if (auto) {
      Promise.resolve(auto(request)).then((r) => { if (r) this.respond(r); }).catch(() => {});
    }
    return p;
  }

  respond(response: HumanResponse): boolean {
    const p = this.pending.get(response.reqId);
    if (!p) return false;
    this.pending.delete(response.reqId);
    p.resolve(response);
    return true;
  }

  pendingFor(runId?: string): { runId: string; request: HumanRequest }[] {
    return [...this.pending.values()].filter((p) => !runId || p.runId === runId).map(({ runId, request }) => ({ runId, request }));
  }

  /** Cancel everything pending for a run (e.g. the run was stopped). */
  cancel(runId: string) {
    for (const [id, p] of this.pending) {
      if (p.runId !== runId) continue;
      this.pending.delete(id);
      p.resolve(p.request.kind === "question"
        ? { reqId: id, kind: "answer", answer: "(run cancelled — no answer)", by: "system" }
        : { reqId: id, kind: "decision", approved: false, note: "Run cancelled", by: "system" });
    }
  }
}

export const broker = new HumanBroker();
