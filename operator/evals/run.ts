/**
 * Eval runner:  npm run evals [-- case-id ...] [--repeat N]
 *
 * For each case: reset the sandbox to its scenario → run the operator with a
 * scripted supervisor → read ground truth from the systems → score.
 * Also reports whether the independent verifier agreed with ground truth.
 */
import fs from "node:fs";
import path from "node:path";
import { seed } from "../../sandbox/scripts/seed.ts";
import { PATHS } from "../src/config.ts";
import { bus } from "../src/engine/events.ts";
import { runOperator } from "../src/engine/run.ts";
import { ensureSandbox } from "../src/sandbox.ts";
import { CASES, type Check } from "./cases.ts";
import { readTruth } from "./groundtruth.ts";

const args = process.argv.slice(2);
const ri = args.indexOf("--repeat");
const repeat = ri >= 0 ? Number(args.splice(ri, 2)[1]) : 1;
const selected = args.length ? CASES.filter((c) => args.includes(c.id)) : CASES;
if (!selected.length) { console.log(`Unknown case. Cases: ${CASES.map((c) => c.id).join(", ")}`); process.exit(1); }

interface Result { case: string; attempt: number; runId: string; status: string; verifier: string; checks: Check[]; pass: boolean; costUsd: number; durationSec: number; turns: number; error?: string }

await ensureSandbox();
const outDir = path.join(PATHS.runs, "evals", new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"));
fs.mkdirSync(outDir, { recursive: true });
const results: Result[] = [];
let live = "";
bus.onEvent((e) => { if (e.type === "tool_result") process.stdout.write(e.ok ? "." : "x"); if (e.type === "phase") process.stdout.write(` ${e.phase[0].toUpperCase()}`); void live; });

for (const tc of selected) {
  for (let a = 1; a <= repeat; a++) {
    process.stdout.write(`\n▶ ${tc.id}${repeat > 1 ? ` #${a}` : ""}: `);
    await seed(tc.scenario);
    let r: Result;
    try {
      const report = await runOperator({ request: tc.request, scenario: tc.scenario, responder: tc.human });
      const truth = await readTruth();
      const checks = await tc.checks(truth, report);
      const v = report.state.verdicts.at(-1);
      r = { case: tc.id, attempt: a, runId: report.id, status: report.status, verifier: v?.overall ?? "none", checks, pass: checks.every((x) => x.pass), costUsd: report.usage.costUsd, durationSec: report.durationSec, turns: report.turns, error: report.error };
    } catch (e: any) {
      r = { case: tc.id, attempt: a, runId: "-", status: "crashed", verifier: "none", checks: [], pass: false, costUsd: 0, durationSec: 0, turns: 0, error: e.message };
    }
    results.push(r);
    process.stdout.write(`\n  ${r.pass ? "✅ PASS" : "❌ FAIL"}  status=${r.status} verifier=${r.verifier} $${r.costUsd.toFixed(2)} ${Math.round(r.durationSec)}s`);
    for (const ch of r.checks) process.stdout.write(`\n    ${ch.pass ? "✓" : "✗"} ${ch.name}${ch.detail && !ch.pass ? ` (${ch.detail})` : ""}`);
    fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  }
}

const n = results.length, passed = results.filter((r) => r.pass).length;
const agree = results.filter((r) => r.verifier !== "none" && (r.verifier === "pass") === r.pass).length;
const withVerdict = results.filter((r) => r.verifier !== "none").length;
const falsePass = results.filter((r) => r.verifier === "pass" && !r.pass).length;
const cost = results.reduce((s, r) => s + r.costUsd, 0);
const md = [
  `# Eval results — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, "",
  `**Task success (ground truth): ${passed}/${n} (${Math.round((100 * passed) / n)}%)** · verifier agreed with ground truth ${agree}/${withVerdict} · verifier false-passes ${falsePass} · total cost $${cost.toFixed(2)}`, "",
  "| Case | Result | Status | Verifier | Checks | Cost | Time | Run |", "|---|---|---|---|---|---|---|---|",
  ...results.map((r) => `| ${r.case}${repeat > 1 ? ` #${r.attempt}` : ""} | ${r.pass ? "✅" : "❌"} | ${r.status} | ${r.verifier} | ${r.checks.filter((c) => c.pass).length}/${r.checks.length} | $${r.costUsd.toFixed(2)} | ${Math.round(r.durationSec)}s | ${r.runId} |`),
  "", "## Failed checks", "",
  ...results.flatMap((r) => r.checks.filter((c) => !c.pass).map((c) => `- **${r.case}**: ${c.name}${c.detail ? ` — ${c.detail}` : ""}`)),
].join("\n");
fs.writeFileSync(path.join(outDir, "summary.md"), md);
console.log(`\n\n${md}\n\nSaved to ${outDir}`);
process.exit(0);
