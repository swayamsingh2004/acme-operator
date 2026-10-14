/**
 * Control tools: how the model moves the harness's state machine forward.
 *   submit_task_brief  Understand → Plan   (unlocks approvals; system writes still need a plan)
 *   update_plan        Plan → Execute      (unlocks state-changing actions)
 *   record_evidence    attach a labelled screenshot/fact to the evidence report
 *   complete_task      Execute → Verify    (triggers the independent verifier)
 */
import { S, type ToolDef } from "./types.ts";

export const controlTools: ToolDef[] = [
  {
    name: "submit_task_brief",
    description:
      "Record your understanding of the request before changing anything. Success criteria must be concrete, observable end states in company systems (e.g. 'Ledgerly invoice WL-5561 for V-1006 exists, $2,640.00, PO-50281, status Approved'), so an independent verifier can check them. Company systems stay read-only until this brief and a plan exist.",
    input_schema: S.obj({
      intended_outcome: S.str("What the requester actually wants to be true when you're done, in one or two sentences"),
      interpretation: S.str("How you read the request, including what it leaves unstated and how you resolved it"),
      success_criteria: S.arr(S.str("A checkable end state"), "Observable end states that define 'done'"),
      procedures: S.arr(S.str("Handbook document id + the rule that applies, e.g. 'AP-01 §2.2 duplicate check'")),
      systems: S.arr(S.str("System id")),
      assumptions: S.arr(S.str("Assumption")),
      risks: S.arr(S.str("Risk or red flag noticed")),
      needs_human_input: S.bool("True if you cannot proceed safely without asking the human (then call ask_human next)"),
    }),
    gate: "any",
    async run(input, ctx) {
      if (!input.success_criteria?.length) return { content: "A brief needs at least one success criterion.", isError: true, summary: "brief rejected: no criteria" };
      const first = !ctx.state.brief;
      ctx.state.brief = input;
      ctx.recorder.emit({ type: "brief", brief: input });
      if (first) ctx.hooks.setPhase("planning");
      return {
        content: `Brief recorded (${input.success_criteria.length} success criteria). ${input.needs_human_input ? "You flagged that you need human input — ask now with ask_human. " : ""}Next: call update_plan with your step-by-step plan.`,
        summary: `brief: ${input.intended_outcome.slice(0, 100)}`,
      };
    },
  },
  {
    name: "update_plan",
    description: "Create or replace your plan (the full ordered list of steps with statuses). Call it at the start, and whenever a step changes status or you learn something that changes the plan. Your supervisor watches it live.",
    input_schema: S.obj({
      steps: S.arr(S.obj({
        id: S.str("Short id, e.g. '1' or '2b'"),
        title: S.str("What this step does"),
        status: S.enum(["pending", "in_progress", "done", "blocked", "skipped"], "Step status"),
        system: S.str("Main system used (ledgerly, mail, treasury, drive, handbook)"),
        note: S.str("Result or reason (for done/blocked/skipped)"),
      }, ["id", "title", "status"])),
    }),
    gate: "after_brief",
    async run(input, ctx) {
      const first = ctx.state.plan.length === 0;
      ctx.state.plan = input.steps;
      ctx.recorder.emit({ type: "plan", steps: input.steps });
      if (first) { ctx.guard.readOnly = false; ctx.hooks.setPhase("executing"); }
      const done = input.steps.filter((s: any) => s.status === "done").length;
      return { content: `Plan updated (${done}/${input.steps.length} done).${first ? " Company systems are now writable for you, within policy." : ""}`, summary: `plan ${done}/${input.steps.length} done` };
    },
  },
  {
    name: "record_evidence",
    description: "Attach evidence to the final report: a fact you observed and, optionally, a screenshot of the browser or Treasury desktop as it is now (e.g. the Treasury payment confirmation).",
    input_schema: S.obj({
      label: S.str("Short label, e.g. 'Treasury confirmation TRX-241337'"),
      detail: S.str("What this shows and where it was observed"),
      capture: S.enum(["browser", "desktop", "none"], "Screenshot to attach"),
    }),
    gate: "after_brief",
    async run(input, ctx) {
      let image: string | undefined;
      if (input.capture === "browser") image = await ctx.browser.evidenceShot(`evidence-${input.label}`);
      if (input.capture === "desktop") {
        try { image = ctx.recorder.saveImage(await ctx.desktop.screenshotPng(), `evidence-${input.label}`); } catch { /* desktop down */ }
      }
      ctx.state.evidence.push({ label: input.label, detail: input.detail, image });
      ctx.recorder.emit({ type: "evidence", label: input.label, detail: input.detail, image });
      return { content: `Evidence recorded${image ? " with screenshot" : ""}.`, summary: `evidence: ${input.label}`, image };
    },
  },
  {
    name: "complete_task",
    description:
      "Finish the task. Call only after you have re-checked the end state in the systems. Triggers an independent verifier that checks your success criteria directly in the systems; if it finds a problem you'll receive the findings and must fix them (or explain) and call complete_task again. Use outcome 'escalated' or 'blocked' when a control or policy correctly stopped the work and a human must act.",
    input_schema: S.obj({
      outcome: S.enum(["completed", "partially_completed", "escalated", "blocked", "failed"], "Overall outcome"),
      summary: S.str("For your supervisor: what was done, what needs their attention, with references (invoice numbers, confirmation numbers)"),
      items: S.arr(S.obj({ item: S.str("Item, e.g. 'WL-5561 (Wayne Logistics)'"), outcome: S.str("e.g. approved / pending approval / on hold / duplicate / paid / escalated"), detail: S.str("Facts and references") }), "One entry per item handled"),
      follow_ups: S.arr(S.str("Something a human needs to do next")),
    }),
    gate: "after_brief",
    async run(input, ctx) {
      ctx.state.completion = input;
      return ctx.hooks.complete(input);
    },
  },
];
