/**
 * Operator Console server: REST + WebSocket API for the web console.
 *   POST /api/runs                 start a run {request, requestedBy?, scenario?}
 *   POST /api/runs/:id/cancel      stop a run
 *   GET  /api/runs, /api/runs/:id  history and full event log
 *   GET  /api/runs/:id/files/...   screenshots, downloads, report.md
 *   GET  /api/human/pending        open questions / approvals
 *   POST /api/human/respond        answer or decide
 *   POST /api/sandbox/reset        reseed the sandbox company with a scenario
 *   GET  /api/sandbox/state        live snapshot of the company systems
 *   WS   /ws                       live event stream
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import { SANDBOX_TOKEN, URLS } from "../../../sandbox/shared/paths.ts";
import { SCENARIOS } from "../../../sandbox/shared/world.ts";
import { readTreasuryDb, treasuryUp } from "../../../sandbox/shared/treasury.ts";
import { seed } from "../../../sandbox/scripts/seed.ts";
import { CONFIG, hasApiKey, PATHS } from "../config.ts";
import { bus } from "../engine/events.ts";
import { runOperator } from "../engine/run.ts";
import { listRuns, readRunEvents } from "../evidence/recorder.ts";
import { broker } from "../human/broker.ts";
import { ensureSandbox } from "../sandbox.ts";
import { EXAMPLES } from "./examples.ts";

const app = express();
app.use(express.json({ limit: "2mb" }));

let active: { id: string | null; ac: AbortController; request: string } | null = null;

app.get("/api/info", async (_req, res) => {
  res.json({
    model: CONFIG.operatorModel, verifierModel: CONFIG.verifierModel, thinking: CONFIG.operatorThinking,
    apiKey: hasApiKey(),
    systems: { ledgerly: URLS.ledgerly, mail: URLS.mail, treasuryVnc: URLS.treasuryVnc },
    treasury: await treasuryUp(1500),
    scenarios: Object.values(SCENARIOS).map((s) => ({ id: s.id, title: s.title })),
    examples: EXAMPLES,
    active: active ? { id: active.id, request: active.request } : null,
  });
});

app.get("/api/runs", (_req, res) => res.json(listRuns().slice(0, 50)));
app.get("/api/runs/:id", (req, res) => res.json({ id: req.params.id, events: readRunEvents(req.params.id) }));
app.get("/api/runs/:id/files/*rest", (req, res) => {
  const rel = ([] as string[]).concat((req.params as any).rest).join("/");
  const base = path.join(PATHS.runs, path.basename(req.params.id));
  const f = path.resolve(base, rel);
  if (!f.startsWith(base + path.sep) || !fs.existsSync(f)) return res.status(404).end();
  res.sendFile(f);
});

app.post("/api/runs", async (req, res) => {
  if (active) return res.status(409).json({ error: "A run is already in progress. One run at a time: the sandbox company is shared." });
  const { request, requestedBy, scenario } = req.body ?? {};
  if (!request || typeof request !== "string") return res.status(400).json({ error: "request is required" });
  const ac = new AbortController();
  active = { id: null, ac, request };
  try {
    if (scenario) await seed(scenario);
  } catch (e: any) { active = null; return res.status(500).json({ error: `Reset failed: ${e.message}` }); }
  let resolveId!: (id: string) => void;
  const idP = new Promise<string>((r) => (resolveId = r));
  runOperator({ request, requestedBy: requestedBy || undefined, scenario, signal: ac.signal, onStart: (id) => { active!.id = id; resolveId(id); } })
    .catch((e) => console.error("run failed", e))
    .finally(() => { active = null; });
  res.json({ id: await idP });
});

app.post("/api/runs/:id/cancel", (req, res) => {
  if (!active || active.id !== req.params.id) return res.status(404).json({ error: "not running" });
  active.ac.abort();
  broker.cancel(req.params.id);
  res.json({ ok: true });
});

app.get("/api/human/pending", (_req, res) => res.json(broker.pendingFor()));
app.post("/api/human/respond", (req, res) => {
  const ok = broker.respond(req.body);
  res.status(ok ? 200 : 404).json({ ok });
});

app.post("/api/sandbox/reset", async (req, res) => {
  if (active) return res.status(409).json({ error: "Cannot reset while a run is in progress." });
  try { const s = await seed(req.body?.scenario ?? "demo"); res.json({ ok: true, scenario: s }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get("/api/sandbox/state", async (_req, res) => {
  const h = { "x-sandbox-token": SANDBOX_TOKEN };
  try {
    const [l, m] = await Promise.all([
      fetch(`${URLS.ledgerly}/api/state`, { headers: h }).then((r) => r.json() as any),
      fetch(`${URLS.mail}/api/state`, { headers: h }).then((r) => r.json() as any),
    ]);
    let payments: any[] = [];
    try { const db = await readTreasuryDb(); payments = db.prepare("SELECT * FROM payments ORDER BY released_at DESC").all() as any[]; db.close(); } catch { /* treasury down */ }
    res.json({
      invoices: l.invoices.map((i: any) => ({ id: i.id, vendor_id: i.vendor_id, number: i.number, amount: i.amount, status: i.status, due_date: i.due_date, hold_reason: i.hold_reason, payment_ref: i.payment_ref })),
      mail: m.messages.map((x: any) => ({ id: x.id, folder: x.folder, from: x.from_addr, to: x.to_addr, subject: x.subject, date: x.date })),
      payments,
      audit: l.audit.slice(-25).reverse(),
    });
  } catch (e: any) { res.status(503).json({ error: e.message }); }
});

// Console SPA
if (fs.existsSync(PATHS.consoleDist)) {
  app.use(express.static(PATHS.consoleDist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(PATHS.consoleDist, "index.html")));
} else {
  app.get("/", (_req, res) => res.type("text").send("Console not built. Run: npm run console:build"));
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
bus.onEvent((e) => {
  const data = JSON.stringify(e);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
});

await ensureSandbox();
server.listen(CONFIG.port, () => {
  console.log(`\n  Acme Operator Console → http://localhost:${CONFIG.port}`);
  console.log(`  Ledgerly → ${URLS.ledgerly}   Acme Mail → ${URLS.mail}   Treasury (live) → ${URLS.treasuryVnc}`);
  if (!hasApiKey()) console.log("  ⚠ GEMINI_API_KEY is not set — add it to .env before starting a run.");
});
