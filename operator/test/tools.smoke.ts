/**
 * Tool-layer smoke test (no LLM): exercises the real tools against the real
 * sandbox systems exactly as the model would call them.  npx tsx operator/test/tools.smoke.ts
 */
import assert from "node:assert/strict";
import { seed } from "../../sandbox/scripts/seed.ts";
import { loadCompany } from "../src/context/company.ts";
import { Recorder } from "../src/evidence/recorder.ts";
import { broker } from "../src/human/broker.ts";
import { Guard } from "../src/policy/guard.ts";
import { BrowserSession } from "../src/tools/browser.ts";
import { DesktopDriver } from "../src/tools/desktop.ts";
import { OPERATOR_TOOLS } from "../src/engine/run.ts";
import { ensureSandbox } from "../src/sandbox.ts";
import type { RunState, ToolContext } from "../src/tools/types.ts";

await ensureSandbox();
await seed("demo");
const company = loadCompany();
const recorder = new Recorder("smoke-" + Date.now());
const guard = new Guard(company.permissions, { readOnly: true });
const state: RunState = { brief: null, plan: [], approvals: [], answers: [], evidence: [], completion: null, verdicts: [] };
const browser = new BrowserSession(guard, recorder, "operator");
const ctx: ToolContext = {
  runId: recorder.id, actor: "operator", company, recorder, broker, guard, browser, desktop: new DesktopDriver(recorder, "operator"), state,
  hooks: { setPhase() {}, async complete() { return { content: "ok", summary: "ok" }; } },
};
const tool = (n: string) => OPERATOR_TOOLS.find((t) => t.name === n)!;
const call = async (n: string, input: any) => {
  const out = await tool(n).run(input, ctx);
  const text = typeof out.content === "string" ? out.content : out.content.map((b: any) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
  console.log(`\n▶ ${n} ${JSON.stringify(input).slice(0, 100)}\n  ${out.isError ? "ERROR " : ""}${out.summary}`);
  return { out, text };
};
const refOf = (text: string, re: RegExp) => { const m = text.split("\n").find((l) => re.test(l))?.match(/\[(e\d+)/); assert(m, `no ref for ${re}`); return m![1]; };

// Knowledge
let r = await call("search_company_docs", { query: "duplicate invoice number normalise" });
assert.match(r.text, /AP-01/);

// Files: PDF text + scanned image
r = await call("list_files", { path: "drive/AP/Scanned Invoices" });
assert.match(r.text, /UFC-7790/);
r = await call("read_file", { path: "drive/AP/Scanned Invoices/Umbrella_UFC-7790_scan.png" });
assert(Array.isArray(r.out.content));

// Browser: login + search
r = await call("browser_login", { system: "ledgerly" });
assert.match(r.text, /Accounts Payable overview/);
r = await call("browser_navigate", { url: "http://localhost:4101/invoices?q=1042" });
assert.match(r.text, /INV-1042/);
console.log(r.text.split("\n").slice(0, 14).join("\n"));

// Read-only guard before plan: creating an invoice is blocked
r = await call("browser_navigate", { url: "http://localhost:4101/invoices/new" });
let ref = refOf(r.text, /select "Vendor"/);
r = await call("browser_fill", { fields: [{ ref, value: "V-1006" }, { ref: refOf(r.text, /"Invoice number"/), value: "TEST-1" }], submit_ref: refOf(r.text, /button\] Save invoice/) });
assert.match(r.text, /POLICY GUARD BLOCKED: read-only-phase/);

// After plan: writable; forbid rule still blocks bank changes
guard.readOnly = false;
r = await call("browser_navigate", { url: "http://localhost:4101/vendors/V-1002/bank" });
r = await call("browser_fill", { fields: [{ ref: refOf(r.text, /"Account number"/), value: "773022915508" }], submit_ref: refOf(r.text, /Save bank details/) });
assert.match(r.text, /no-bank-detail-changes/);

// Ledgerly own controls: approval limit
r = await call("browser_navigate", { url: "http://localhost:4101/invoices/new" });
r = await call("browser_fill", {
  fields: [
    { ref: refOf(r.text, /select "Vendor"/), value: "V-1001" }, { ref: refOf(r.text, /"Invoice number"/), value: "GX-2024-0131" },
    { ref: refOf(r.text, /"Invoice date"/), value: "2026-10-11" }, { ref: refOf(r.text, /"Due date"/), value: "2026-11-10" },
    { ref: refOf(r.text, /"PO number/), value: "PO-50290" }, { ref: refOf(r.text, /"Amount/), value: "18,600.00" },
  ], submit_ref: refOf(r.text, /Save invoice/),
});
assert.match(r.text, /Invoice GX-2024-0131 saved/);
r = await call("browser_click", { ref: refOf(r.text, /button\] Approve/) });
assert.match(r.text, /Approval limit exceeded/);

// Mail: download attachment, read PDF; external recipient needs approval
r = await call("browser_login", { system: "mail" });
r = await call("browser_click", { ref: refOf(r.text, /WL-5561/) });
r = await call("browser_click", { ref: refOf(r.text, /WL-5561\.pdf/) });
assert.match(r.text, /Downloaded file saved as downloads\/WL-5561\.pdf/);
r = await call("read_file", { path: "downloads/WL-5561.pdf" });
assert.match(r.text, /2,640\.00/);
r = await call("browser_navigate", { url: "http://localhost:4102/compose" });
r = await call("browser_fill", { fields: [{ ref: refOf(r.text, /"To"/), value: "accounts@initech-payments.example" }, { ref: refOf(r.text, /"Subject"/), value: "test" }], submit_ref: refOf(r.text, /button\] Send/) });
assert.match(r.text, /external-recipient/);
guard.grant("external-recipient", "accounts@initech-payments.example");
r = await call("browser_navigate", { url: "http://localhost:4102/compose" });
r = await call("browser_fill", { fields: [{ ref: refOf(r.text, /"To"/), value: "accounts@initech-payments.example" }, { ref: refOf(r.text, /"Subject"/), value: "test" }], submit_ref: refOf(r.text, /button\] Send/) });
assert.match(r.text, /Message sent/);

// Approval hook: dual-control code via scripted human
state.brief = { intended_outcome: "x", interpretation: "x", success_criteria: ["x"], procedures: [], systems: [], assumptions: [], risks: [], needs_human_input: false };
broker.setResponder(recorder.id, (req) => ({ reqId: req.reqId, kind: "decision", approved: true, by: "Dana Whitfield (test)" }));
r = await call("request_approval", { kind: "payment_release", title: "Pay GX-2024-0118", details: { vendor_id: "V-1001", invoice_number: "GX-2024-0118", amount: 12400 }, justification: "test" });
assert.match(r.text, /PA-[0-9A-F]{5}/);
console.log("  " + r.text.split("\n")[1]);

// Desktop
const d = await ctx.desktop.run("take_screenshot", {});
assert(!d.isError, "treasury screenshot");

await browser.close();
console.log("\n✅ tool smoke test passed — evidence in runs/" + recorder.id);
process.exit(0);
