/**
 * Approval hooks. When a human approves an operator request, the approver's
 * action is carried out in the system of record (as the approver, not as the
 * operator): e.g. the Controller's invoice approval is recorded in Ledgerly,
 * or Ledgerly issues a dual-control code. The operator then observes the
 * result in the system like anyone else.
 */
import { SANDBOX_TOKEN, URLS } from "../../../sandbox/shared/paths.ts";
import type { Guard } from "./guard.ts";

export interface ApprovalDetails {
  vendor_id?: string;
  invoice_number?: string;
  amount?: number;
  rule_id?: string;
  recipient?: string;
  notes?: string;
}

async function ledgerly(path: string, body: unknown): Promise<{ ok: boolean; message: string; code?: string }> {
  const r = await fetch(`${URLS.ledgerly}/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sandbox-token": SANDBOX_TOKEN },
    body: JSON.stringify(body),
  });
  return (await r.json()) as any;
}

export async function runApprovalHook(hook: string, d: ApprovalDetails, approver: string, guard: Guard): Promise<{ ok: boolean; message: string }> {
  switch (hook) {
    case "ledgerly.approve_invoice":
      return ledgerly("/approvals/invoice", { vendor_id: d.vendor_id, invoice_number: d.invoice_number, amount: d.amount, approver });
    case "ledgerly.issue_payment_authorization": {
      const r = await ledgerly("/payment-authorizations", { vendor_id: d.vendor_id, invoice_number: d.invoice_number, amount: d.amount, approver });
      return r.ok ? { ok: true, message: `${r.message} Release authorization code: ${r.code}` } : r;
    }
    case "guard.grant":
      guard.grant(d.rule_id ?? "", d.recipient);
      return { ok: true, message: `One-time pass granted for policy rule '${d.rule_id}'${d.recipient ? ` (recipient ${d.recipient})` : ""}. Retry the action once.` };
    default:
      return { ok: true, message: "Approval recorded." };
  }
}
