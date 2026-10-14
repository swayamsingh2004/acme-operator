/**
 * CLI:  npm run op -- "Process the new invoices in the AP inbox" [--scenario demo] [--as "Name"] [--auto-approve]
 *
 * Streams the run live in the terminal; questions and approvals are answered at the prompt
 * (or automatically approved with --auto-approve). Evidence lands in runs/<id>/.
 */
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { seed } from "../../sandbox/scripts/seed.ts";
import { bus, type HumanRequest, type HumanResponse, type RunEvent } from "./engine/events.ts";
import { runOperator } from "./engine/run.ts";
import { ensureSandbox } from "./sandbox.ts";
import { hasApiKey, PATHS } from "./config.ts";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const bool = (n: string) => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };
const scenario = flag("--scenario");
const as = flag("--as");
const autoApprove = bool("--auto-approve");
const request = args.join(" ").trim();

const c = { dim: (s: string) => `\x1b[2m${s}\x1b[0m`, b: (s: string) => `\x1b[1m${s}\x1b[0m`, g: (s: string) => `\x1b[32m${s}\x1b[0m`, r: (s: string) => `\x1b[31m${s}\x1b[0m`, y: (s: string) => `\x1b[33m${s}\x1b[0m`, c: (s: string) => `\x1b[36m${s}\x1b[0m`, m: (s: string) => `\x1b[35m${s}\x1b[0m` };

function render(e: RunEvent) {
  const who = e.actor === "verifier" ? c.m("verifier ") : "";
  switch (e.type) {
    case "phase": console.log(`\n${c.b(c.c(`━━ ${e.phase.toUpperCase()} ━━`))}`); break;
    case "thinking": console.log(c.dim(`${who}💭 ${e.text.replace(/\s+/g, " ").slice(0, 300)}`)); break;
    case "assistant_text": console.log(`${who}${e.text}`); break;
    case "tool_call": break;
    case "tool_result": console.log(`${who}${e.ok ? c.g("✓") : c.r("✗")} ${c.b(e.name)} ${c.dim(e.summary)}`); break;
    case "brief": console.log(`${c.b("Brief:")} ${e.brief.intended_outcome}\n${e.brief.success_criteria.map((s) => `  • ${s}`).join("\n")}`); break;
    case "plan": console.log(e.steps.map((s) => `  ${{ done: c.g("☑"), in_progress: c.y("◐"), blocked: c.r("⛔"), skipped: "⤼", pending: "☐" }[s.status]} ${s.id}. ${s.title}`).join("\n")); break;
    case "policy": console.log(c.r(`🛡  policy ${e.rule} (${e.effect}): ${e.detail}`)); break;
    case "harness": console.log(c.y(`⚙  ${e.message}`)); break;
    case "verification": if (e.status === "finished" && e.verdict) console.log(`${c.m("Verdict:")} ${e.verdict.overall === "pass" ? c.g("PASS") : c.r("FAIL")}\n${e.verdict.criteria.map((x) => `  ${x.status === "pass" ? c.g("✓") : x.status === "fail" ? c.r("✗") : c.y("?")} ${x.criterion}`).join("\n")}`); break;
    case "usage": break;
    case "error": console.log(c.r(`Error: ${e.message}`)); break;
    case "run_finished": console.log(`\n${c.b("Status:")} ${e.status}\n${e.summary}`); break;
  }
}

async function cliResponder(req: HumanRequest): Promise<HumanResponse> {
  if (req.kind === "approval" && autoApprove) return { reqId: req.reqId, kind: "decision", approved: true, note: "auto-approved (--auto-approve)", by: "CLI (auto)" };
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    if (req.kind === "question") {
      console.log(`\n${c.y("❓ The operator asks:")} ${req.question}\n${c.dim(req.context ?? "")}${req.options?.length ? `\nOptions: ${req.options.map((o, i) => `[${i + 1}] ${o}`).join("  ")}` : ""}`);
      const a = (await rl.question("> ")).trim();
      const n = Number(a);
      return { reqId: req.reqId, kind: "answer", answer: req.options && n >= 1 && n <= req.options.length ? req.options[n - 1] : a, by: as ?? "Supervisor (CLI)" };
    }
    console.log(`\n${c.y(`🔐 Approval requested (${req.approvalKind}) — approver: ${req.approver}`)}\n${c.b(req.title)}\n${JSON.stringify(req.details)}\n${req.justification}`);
    const a = (await rl.question("Approve? [y/N] (optionally add a note after the letter) > ")).trim();
    return { reqId: req.reqId, kind: "decision", approved: /^y/i.test(a), note: a.replace(/^[yn]\w*\s*/i, "") || undefined, by: as ?? req.approver };
  } finally { rl.close(); }
}

async function main() {
  if (!request) {
    console.log('Usage: npm run op -- "<request>" [--scenario <id>] [--as "<name>"] [--auto-approve]');
    process.exit(1);
  }
  if (!hasApiKey()) { console.log(c.r("GEMINI_API_KEY is not set. Add it to .env (see .env.example).")); process.exit(1); }
  await ensureSandbox();
  if (scenario) { const s = await seed(scenario); console.log(c.dim(`Sandbox reset to scenario '${s.id}': ${s.title}`)); }
  bus.onEvent(render);
  const ac = new AbortController();
  process.on("SIGINT", () => { console.log(c.y("\nCancelling…")); ac.abort(); });
  const report = await runOperator({ request, requestedBy: as, scenario, signal: ac.signal, responder: cliResponder });
  console.log(`\n${c.b("Evidence:")} ${PATHS.runs}/${report.id}/report.md  ·  $${report.usage.costUsd.toFixed(2)}  ·  ${Math.round(report.durationSec)}s`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
