/**
 * Human-in-the-loop tools. ask_human for ambiguity/escalation; request_approval
 * for policy-required approvals. Approval kinds and their hooks come from
 * permissions.yaml — when a human approves, the approver's action is executed in
 * the system of record and the result (e.g. a dual-control code) is returned.
 */
import { runApprovalHook, type ApprovalDetails } from "../policy/approvals.ts";
import { S, type ToolDef } from "./types.ts";

export const humanTools: ToolDef[] = [
  {
    name: "ask_human",
    description: "Ask your supervisor a question and wait for the answer. Use for genuine ambiguity (e.g. several records match the request), missing information you cannot find in any system, or escalations an SOP requires. Give context and, when possible, options.",
    input_schema: S.obj({
      question: S.str("The question, self-contained"),
      context: S.str("What you found that makes this necessary (facts, record ids)"),
      options: S.arr(S.str("An answer option"), "Suggested answers, if the choice is among known options"),
    }, ["question", "context"]),
    gate: "any",
    async run(input, ctx) {
      const reqId = ctx.broker.newId();
      ctx.hooks.setPhase("awaiting_human");
      ctx.recorder.emit({ type: "human_request", request: { reqId, kind: "question", question: input.question, options: input.options, context: input.context } });
      const r = await ctx.broker.request(ctx.runId, { reqId, kind: "question", question: input.question, options: input.options, context: input.context });
      ctx.recorder.emit({ type: "human_response", response: r });
      ctx.hooks.setPhase("executing");
      const answer = r.kind === "answer" ? r.answer : r.approved ? "yes" : "no";
      ctx.state.answers.push({ question: input.question, answer, by: r.by });
      return { content: `${r.by} answered: ${answer}`, summary: `human answered: ${answer.slice(0, 80)}` };
    },
  },
  {
    name: "request_approval",
    description:
      "Request a human approval required by policy, and wait for the decision. Kinds: 'invoice_approval' (invoice above your $5,000 limit — the Controller's approval is then recorded in Ledgerly), 'payment_release' (dual-control code for payments >= $10,000 — returned as PA-XXXXX), 'policy_override' (a browser action held by a require_approval policy rule — pass rule_id and recipient), 'exception' (any deviation from an SOP or a fraud/risk escalation needing a decision). State the facts and your recommendation in the justification.",
    input_schema: S.obj({
      kind: S.enum(["invoice_approval", "payment_release", "policy_override", "exception"], "Approval kind"),
      title: S.str("Short title, e.g. 'Approve Globex invoice GX-2024-0131 ($18,600.00)'"),
      details: S.obj({
        vendor_id: S.str("Ledgerly vendor id, e.g. V-1001"),
        invoice_number: S.str("Invoice number exactly as in Ledgerly"),
        amount: S.num("Amount in USD"),
        rule_id: S.str("Policy rule id (policy_override only)"),
        recipient: S.str("Email recipient the override is for (policy_override only)"),
        notes: S.str("Anything else the approver needs"),
      }, []),
      justification: S.str("Facts checked (with sources) and your recommendation"),
    }),
    gate: "after_brief",
    async run(input, ctx) {
      const kinds = ctx.company.permissions.approvals.kinds;
      const spec = kinds[input.kind];
      if (!spec) return { content: `Unknown approval kind '${input.kind}'. Kinds: ${Object.keys(kinds).join(", ")}`, isError: true, summary: "unknown approval kind" };
      const details = (input.details ?? {}) as ApprovalDetails;
      const missing = (spec.required_fields ?? []).filter((f) => (details as any)[f] === undefined || (details as any)[f] === "");
      if (missing.length) return { content: `Approval kind '${input.kind}' requires details: ${missing.join(", ")}.`, isError: true, summary: `missing ${missing.join(", ")}` };
      const reqId = ctx.broker.newId();
      const request = { reqId, kind: "approval" as const, approvalKind: input.kind, title: input.title, details: details as Record<string, unknown>, justification: input.justification, approver: spec.approver };
      ctx.hooks.setPhase("awaiting_human");
      ctx.recorder.emit({ type: "human_request", request });
      const r = await ctx.broker.request(ctx.runId, request);
      ctx.recorder.emit({ type: "human_response", response: r });
      ctx.hooks.setPhase("executing");
      if (r.kind !== "decision" || !r.approved) {
        const note = r.kind === "decision" ? r.note : r.answer;
        ctx.state.approvals.push({ kind: input.kind, title: input.title, details, approved: false, by: r.by, note });
        return { content: `REJECTED by ${r.by}${note ? `: ${note}` : ""}. Do not perform the action; follow the procedure for a rejection and report it.`, summary: `approval rejected by ${r.by}` };
      }
      const hook = await runApprovalHook(spec.hook, details, r.by, ctx.guard).catch((e) => ({ ok: false, message: `Approval hook failed: ${e.message}` }));
      ctx.state.approvals.push({ kind: input.kind, title: input.title, details, approved: true, by: r.by, note: r.note, result: hook.message });
      return {
        content: `APPROVED by ${r.by}${r.note ? ` (note: ${r.note})` : ""}.\nSystem result: ${hook.message}${hook.ok ? "" : "\nThe approval was given but the system action failed — investigate before proceeding."}`,
        summary: `approved by ${r.by}${hook.ok ? "" : " (hook failed)"}`,
        isError: !hook.ok,
      };
    },
  },
];
