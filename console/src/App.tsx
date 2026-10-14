import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deriveRun, type HumanRequest, type Phase, type RunEvent, type RunView } from "./types";

interface Info {
  model: string; verifierModel: string; thinking: string; apiKey: boolean; treasury: boolean;
  systems: { ledgerly: string; mail: string; treasuryVnc: string };
  scenarios: { id: string; title: string }[];
  examples: { scenario: string; request: string; label: string }[];
  active: { id: string | null; request: string } | null;
}
interface RunListItem { id: string; meta: any }

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as any).error ?? r.statusText);
  return j as T;
};
const fileUrl = (runId: string, rel: string) => `/api/runs/${runId}/files/${rel}`;

const STEPS: { key: string; label: string; phases: Phase[] }[] = [
  { key: "u", label: "Understand", phases: ["understanding"] },
  { key: "p", label: "Plan", phases: ["planning"] },
  { key: "e", label: "Execute", phases: ["executing", "awaiting_human"] },
  { key: "v", label: "Verify", phases: ["verifying"] },
  { key: "c", label: "Complete", phases: ["completed", "escalated", "blocked", "needs_review", "failed", "cancelled"] },
];
const TERMINAL: Phase[] = ["completed", "escalated", "blocked", "needs_review", "failed", "cancelled"];
const STATUS_TONE: Record<string, string> = { completed: "good", escalated: "warn", blocked: "warn", needs_review: "bad", failed: "bad", cancelled: "muted", running: "info" };

export default function App() {
  const [info, setInfo] = useState<Info | null>(null);
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, RunEvent[]>>({});
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [i, r] = await Promise.all([api<Info>("/api/info"), api<RunListItem[]>("/api/runs")]);
    setInfo(i); setRuns(r);
    return { i, r };
  }, []);

  useEffect(() => {
    refresh().then(({ i, r }) => setSelected((s) => s ?? i.active?.id ?? r[0]?.id ?? null)).catch((e) => setError(String(e)));
    let ws: WebSocket | null = null; let stop = false;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.onmessage = (m) => {
        const e = JSON.parse(m.data) as RunEvent;
        setEvents((prev) => {
          const list = prev[e.runId] ?? [];
          if (list.length && list[list.length - 1].seq >= e.seq) return prev;
          return { ...prev, [e.runId]: [...list, e] };
        });
        if (e.type === "run_started") { setSelected(e.runId); refresh(); }
        if (e.type === "run_finished") setTimeout(refresh, 400);
      };
      ws.onclose = () => { if (!stop) setTimeout(connect, 1500); };
    };
    connect();
    return () => { stop = true; ws?.close(); };
  }, [refresh]);

  useEffect(() => {
    if (!selected) return;
    api<{ events: RunEvent[] }>(`/api/runs/${selected}`).then(({ events: ev }) =>
      setEvents((prev) => {
        const live = prev[selected] ?? [];
        const maxSeq = ev.at(-1)?.seq ?? 0;
        return { ...prev, [selected]: [...ev, ...live.filter((x) => x.seq > maxSeq)] };
      }),
    );
  }, [selected]);

  const view = useMemo(() => (selected && events[selected] ? deriveRun(selected, events[selected]) : null), [selected, events]);

  return (
    <div className="app">
      <header className="top">
        <div className="brand"><span className="logo">◈</span> Acme Operator <span className="sub">AI employee · Accounts Payable</span></div>
        <div className="top-right">
          {info && <span className="chip">{info.model} · thinking {info.thinking} · verifier {info.verifierModel}</span>}
          {info && <a className="chip link" href={info.systems.ledgerly} target="_blank">Ledgerly ↗</a>}
          {info && <a className="chip link" href={info.systems.mail} target="_blank">Acme Mail ↗</a>}
          {info && <a className={`chip link ${info.treasury ? "" : "bad"}`} href={info.systems.treasuryVnc} target="_blank">Treasury desktop {info.treasury ? "↗" : "(offline)"}</a>}
        </div>
      </header>
      {info && !info.apiKey && <div className="banner bad">GEMINI_API_KEY is not set on the server. Add it to <code>.env</code> and restart <code>npm start</code>.</div>}
      {error && <div className="banner bad">{error}</div>}
      <div className="body">
        <aside className="side">
          <Composer info={info} busy={Boolean(info?.active)} onStarted={(id) => { setSelected(id); refresh(); }} onError={setError} />
          <h3 className="side-h">Runs</h3>
          <div className="runs">
            {runs.map((r) => {
              const st = r.meta?.status ?? "running";
              return (
                <button key={r.id} className={`run-item ${selected === r.id ? "sel" : ""}`} onClick={() => setSelected(r.id)}>
                  <div className="run-req">{r.meta?.request ?? r.id}</div>
                  <div className="run-meta"><span className={`pill ${STATUS_TONE[st] ?? "info"}`}>{st.replace("_", " ")}</span>
                    {r.meta?.scenario && <span className="muted">{r.meta.scenario}</span>}
                    {r.meta?.usage && <span className="muted">${r.meta.usage.costUsd.toFixed(2)}</span>}
                    <span className="muted">{r.id.slice(5, 16).replace("T", " ")}</span></div>
                </button>
              );
            })}
            {!runs.length && <p className="muted pad">No runs yet. Pick an example above and press Run.</p>}
          </div>
        </aside>
        <main className="main">
          {view ? <RunPanel view={view} events={events[view.id] ?? []} info={info} onImage={setLightbox} onError={setError} /> : <Empty />}
        </main>
      </div>
      {lightbox && <div className="lightbox" onClick={() => setLightbox(null)}><img src={lightbox} alt="screenshot" /></div>}
    </div>
  );
}

function Empty() {
  return (
    <div className="empty">
      <h2>Give the operator a task</h2>
      <p>The operator turns a short request into completed, verified work inside Acme's systems: a web ERP, webmail, a legacy desktop treasury app and the shared drive. It follows company SOPs, asks for approval when policy requires, and an independent verifier checks the result in the systems before the run is closed.</p>
      <p className="muted">Choose an example on the left (each one resets the sandbox company to a matching scenario), then press <b>Run</b>.</p>
    </div>
  );
}

function Composer({ info, busy, onStarted, onError }: { info: Info | null; busy: boolean; onStarted: (id: string) => void; onError: (e: string | null) => void }) {
  const [request, setRequest] = useState("");
  const [scenario, setScenario] = useState("demo");
  const [by, setBy] = useState("Dana Whitfield (Controller)");
  const [sending, setSending] = useState(false);
  const start = async () => {
    setSending(true); onError(null);
    try { const { id } = await api<{ id: string }>("/api/runs", { method: "POST", body: JSON.stringify({ request, requestedBy: by, scenario: scenario || undefined }) }); onStarted(id); }
    catch (e: any) { onError(e.message); } finally { setSending(false); }
  };
  return (
    <div className="composer">
      <label>Request</label>
      <textarea value={request} onChange={(e) => setRequest(e.target.value)} placeholder="e.g. Please process everything that came into the AP inbox today." rows={3} />
      <div className="row2">
        <div><label>From</label><input value={by} onChange={(e) => setBy(e.target.value)} /></div>
        <div><label>Sandbox scenario</label>
          <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
            <option value="">Keep current state</option>
            {info?.scenarios.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
          </select></div>
      </div>
      <button className="primary" disabled={!request.trim() || busy || sending || !info?.apiKey} onClick={start}>{busy ? "A run is in progress…" : sending ? "Starting…" : "Run"}</button>
      <div className="examples">
        {info?.examples.map((x) => (
          <button key={x.label} className="ex" title={x.request} onClick={() => { setRequest(x.request); setScenario(x.scenario); }}>{x.label}</button>
        ))}
      </div>
    </div>
  );
}

function RunPanel({ view, events, info, onImage, onError }: { view: RunView; events: RunEvent[]; info: Info | null; onImage: (s: string) => void; onError: (e: string | null) => void }) {
  const [tab, setTab] = useState<"activity" | "report" | "company">("activity");
  const [live, setLive] = useState<"desktop" | "browser">("browser");
  const done = TERMINAL.includes(view.phase);
  useEffect(() => { if (done) setTab("report"); else setTab("activity"); }, [view.id, done]);
  const stepIdx = STEPS.findIndex((s) => s.phases.includes(view.phase));
  const dur = view.startedAt ? Math.round(((done ? new Date(view.lastAt).getTime() : Date.now()) - new Date(view.startedAt).getTime()) / 1000) : 0;

  return (
    <div className="runpanel">
      <div className="run-head">
        <div className="run-title">
          <div className="req">“{view.request}”</div>
          <div className="meta">
            <span className={`pill ${STATUS_TONE[done ? view.phase : "running"] ?? "info"}`}>{view.phase.replace("_", " ")}</span>
            {view.scenario && <span>scenario <b>{view.scenario}</b></span>}
            <span>{Math.floor(dur / 60)}m {dur % 60}s</span>
            {view.usage && <span>${view.usage.costUsd.toFixed(2)} · {view.turns} turns</span>}
            {view.policyBlocks > 0 && <span className="bad-t">🛡 {view.policyBlocks} policy block(s)</span>}
            {!done && <button className="ghost" onClick={() => api(`/api/runs/${view.id}/cancel`, { method: "POST" }).catch((e) => onError(e.message))}>Stop</button>}
          </div>
        </div>
        <div className="stepper">
          {STEPS.map((s, i) => (
            <div key={s.key} className={`step ${i < stepIdx ? "past" : i === stepIdx ? (done ? "past" : "now") : ""}`}>
              <span className="dot" />{i === 2 && view.phase === "awaiting_human" ? "Waiting for you" : s.label}
            </div>
          ))}
        </div>
      </div>

      {view.pending.map((p) => <HumanCard key={p.reqId} req={p} onError={onError} />)}

      <div className="cols">
        <section className="left">
          <div className="tabs">
            <button className={tab === "activity" ? "on" : ""} onClick={() => setTab("activity")}>Activity</button>
            <button className={tab === "report" ? "on" : ""} onClick={() => setTab("report")}>Report{view.verdicts.length ? ` · ${view.verdicts.at(-1)!.overall === "pass" ? "verified ✓" : "verification ✗"}` : ""}</button>
            <button className={tab === "company" ? "on" : ""} onClick={() => setTab("company")}>Company systems</button>
          </div>
          {tab === "activity" && <Activity runId={view.id} events={events} onImage={onImage} live={!done} />}
          {tab === "report" && <Report view={view} onImage={onImage} />}
          {tab === "company" && <CompanyState />}
        </section>
        <section className="right">
          <div className="card">
            <h4>Plan</h4>
            {view.plan.length ? (
              <ol className="plan">{view.plan.map((s) => (
                <li key={s.id} className={s.status}><span className="st">{{ done: "✓", in_progress: "◐", blocked: "⛔", skipped: "⤼", pending: "○" }[s.status]}</span>
                  <div><div>{s.title}</div>{s.note && <div className="note">{s.note}</div>}</div></li>))}</ol>
            ) : <p className="muted">{view.brief ? "Planning…" : "Understanding the request…"}</p>}
          </div>
          {view.brief && (
            <div className="card">
              <h4>Success criteria</h4>
              <ul className="crit">{view.brief.success_criteria.map((c, i) => {
                const v = view.verdicts.at(-1)?.criteria.find((x) => x.criterion === c);
                return <li key={i}><span className={`tick ${v?.status ?? ""}`}>{v ? (v.status === "pass" ? "✓" : v.status === "fail" ? "✗" : "?") : "·"}</span>{c}</li>;
              })}</ul>
              <div className="muted small">Procedures: {view.brief.procedures.join("; ")}</div>
            </div>
          )}
          <div className="card live">
            <div className="live-tabs">
              <button className={live === "browser" ? "on" : ""} onClick={() => setLive("browser")}>Browser</button>
              <button className={live === "desktop" ? "on" : ""} onClick={() => setLive("desktop")}>Treasury desktop (live)</button>
            </div>
            {live === "browser"
              ? view.lastBrowserShot ? <img className="shot" src={fileUrl(view.id, view.lastBrowserShot)} onClick={() => onImage(fileUrl(view.id, view.lastBrowserShot!))} /> : <p className="muted pad">No browser activity yet.</p>
              : info?.treasury ? <iframe className="vnc" src={info.systems.treasuryVnc} title="Treasury desktop" /> : <p className="muted pad">Treasury desktop is offline.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}

function HumanCard({ req, onError }: { req: HumanRequest; onError: (e: string | null) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async (body: any) => {
    setBusy(true);
    try { await api("/api/human/respond", { method: "POST", body: JSON.stringify({ reqId: req.reqId, ...body }) }); } catch (e: any) { onError(e.message); } finally { setBusy(false); }
  };
  if (req.kind === "question") return (
    <div className="human q">
      <div className="h-kind">❓ The operator needs your input</div>
      <div className="h-title">{req.question}</div>
      {req.context && <div className="h-ctx">{req.context}</div>}
      <div className="h-actions">
        {req.options?.map((o) => <button key={o} disabled={busy} onClick={() => send({ kind: "answer", answer: o, by: "Dana Whitfield (Controller)" })}>{o}</button>)}
        <input placeholder="Type an answer…" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && note.trim() && send({ kind: "answer", answer: note, by: "Dana Whitfield (Controller)" })} />
        <button className="primary" disabled={busy || !note.trim()} onClick={() => send({ kind: "answer", answer: note, by: "Dana Whitfield (Controller)" })}>Send</button>
      </div>
    </div>
  );
  return (
    <div className="human a">
      <div className="h-kind">🔐 Approval requested · {req.approvalKind.replace("_", " ")} · approver: {req.approver}</div>
      <div className="h-title">{req.title}</div>
      <div className="h-details">{Object.entries(req.details).map(([k, v]) => <span key={k}><b>{k}</b> {k === "amount" ? `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 })}` : String(v)}</span>)}</div>
      <div className="h-ctx">{req.justification}</div>
      <div className="h-actions">
        <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="good" disabled={busy} onClick={() => send({ kind: "decision", approved: true, note: note || undefined, by: req.approver })}>Approve</button>
        <button className="bad" disabled={busy} onClick={() => send({ kind: "decision", approved: false, note: note || "Rejected", by: req.approver })}>Reject</button>
      </div>
    </div>
  );
}

const TOOL_ICON = (name: string, toolset?: string) =>
  toolset === "computer" ? "🖥" : name.startsWith("browser_") ? "🌐" : ["read_file", "list_files", "write_file", "write_spreadsheet", "move_file"].includes(name) ? "📁"
    : ["search_company_docs", "read_company_doc", "remember"].includes(name) ? "📘" : ["ask_human", "request_approval"].includes(name) ? "👤" : name === "submit_verdict" ? "⚖️" : "⚙";

function brief(input: any): string {
  if (!input || typeof input !== "object") return "";
  if (input.url) return input.url.replace(/^https?:\/\/localhost:\d+/, "");
  if (input.query) return `“${input.query}”`;
  if (input.path) return input.path;
  if (input.id) return input.id;
  if (input.system) return input.system;
  if (input.text) return `“${String(input.text).slice(0, 50)}”`;
  if (input.coordinate) return `(${input.coordinate.join(", ")})`;
  if (input.region) return `[${input.region.join(", ")}]`;
  if (input.fields) return input.fields.map((f: any) => f.value).join(" · ").slice(0, 80);
  if (input.title) return input.title;
  if (input.question) return input.question;
  return "";
}

function Activity({ runId, events, onImage, live }: { runId: string; events: RunEvent[]; onImage: (s: string) => void; live: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  const [showThinking, setShowThinking] = useState(true);
  useEffect(() => { if (live) end.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [events.length, live]);
  const calls = new Map<string, Extract<RunEvent, { type: "tool_call" }>>();
  const rows: React.ReactElement[] = [];
  for (const e of events) {
    const v = e.actor === "verifier";
    const k = `${e.seq}`;
    switch (e.type) {
      case "phase": rows.push(<div key={k} className="phase-sep">{e.phase.replace("_", " ")}</div>); break;
      case "thinking": if (showThinking) rows.push(<details key={k} className={`think ${v ? "ver" : ""}`}><summary>{v ? "verifier " : ""}reasoning · {e.text.slice(0, 110).replace(/\s+/g, " ")}…</summary><div>{e.text}</div></details>); break;
      case "assistant_text": rows.push(<div key={k} className={`say ${v ? "ver" : ""}`}>{e.text}</div>); break;
      case "tool_call": calls.set(e.id, e); break;
      case "tool_result": {
        const c = calls.get(e.id);
        rows.push(
          <div key={k} className={`act ${e.ok ? "" : "err"} ${v ? "ver" : ""}`}>
            <span className="ic">{TOOL_ICON(e.name, c?.toolset)}</span>
            <div className="act-body">
              <div><b>{e.name}</b> <span className="muted">{brief(c?.input)}</span></div>
              <div className="sum">{e.summary}</div>
            </div>
            {e.image && <img className="thumb" src={fileUrl(runId, e.image)} onClick={() => onImage(fileUrl(runId, e.image!))} />}
            <span className="ms">{e.ms > 999 ? `${(e.ms / 1000).toFixed(1)}s` : `${e.ms}ms`}</span>
          </div>);
        break;
      }
      case "brief": rows.push(<div key={k} className="block brief"><b>Task brief</b><div>{e.brief.intended_outcome}</div><div className="muted">{e.brief.interpretation}</div></div>); break;
      case "plan": rows.push(<div key={k} className="mini muted">plan updated · {e.steps.filter((s) => s.status === "done").length}/{e.steps.length} done</div>); break;
      case "policy": rows.push(<div key={k} className="block policy">🛡 <b>Policy guard blocked</b> <code>{e.rule}</code> ({e.effect}) — {e.detail}</div>); break;
      case "harness": rows.push(<div key={k} className="block harness">⚙ {e.message}</div>); break;
      case "human_request": rows.push(<div key={k} className="block human-ev">👤 {e.request.kind === "question" ? `Asked: ${e.request.question}` : `Approval requested: ${e.request.title}`}</div>); break;
      case "human_response": rows.push(<div key={k} className="block human-ev">👤 {e.response.kind === "answer" ? `${e.response.by} answered “${e.response.answer}”` : `${e.response.approved ? "Approved" : "Rejected"} by ${e.response.by}${e.response.note ? ` — “${e.response.note}”` : ""}`}</div>); break;
      case "evidence": rows.push(<div key={k} className="block evidence">📎 <b>{e.label}</b> — {e.detail}</div>); break;
      case "verification":
        rows.push(e.status === "started"
          ? <div key={k} className="phase-sep ver">independent verification · round {e.round}</div>
          : <div key={k} className={`block verdict ${e.verdict?.overall}`}><b>Verdict: {e.verdict?.overall.toUpperCase()}</b>{e.verdict?.criteria.map((c, i) => <div key={i}>{c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "?"} {c.criterion}</div>)}</div>);
        break;
      case "error": rows.push(<div key={k} className="block policy">Error: {e.message}</div>); break;
      case "run_finished": rows.push(<div key={k} className={`block finish ${STATUS_TONE[e.status]}`}><b>Run finished: {e.status.replace("_", " ")}</b><div>{e.summary}</div></div>); break;
    }
  }
  return (
    <div className="activity">
      <label className="toggle"><input type="checkbox" checked={showThinking} onChange={(e) => setShowThinking(e.target.checked)} /> show reasoning</label>
      {rows}
      {live && <div className="typing">working…</div>}
      <div ref={end} />
    </div>
  );
}

function Report({ view, onImage }: { view: RunView; onImage: (s: string) => void }) {
  const o = view.finished?.outcome;
  const v = view.verdicts.at(-1);
  return (
    <div className="report">
      {!view.finished && <p className="muted">The report is completed when the run finishes. Live state so far:</p>}
      {o && <>
        <h3>Outcome</h3>
        <p className="summary">{o.summary}</p>
        {o.items.length > 0 && <table><thead><tr><th>Item</th><th>Outcome</th><th>Detail</th></tr></thead><tbody>{o.items.map((i, n) => <tr key={n}><td>{i.item}</td><td><b>{i.outcome}</b></td><td>{i.detail}</td></tr>)}</tbody></table>}
        {o.follow_ups.length > 0 && <><h4>Follow-ups for a human</h4><ul>{o.follow_ups.map((f, i) => <li key={i}>{f}</li>)}</ul></>}
      </>}
      {view.finished && !o && <p className="bad-t">{view.finished.summary || "The operator did not complete the task."}</p>}
      {v && <>
        <h3>Independent verification — <span className={v.overall === "pass" ? "good-t" : "bad-t"}>{v.overall.toUpperCase()}</span> <span className="muted small">(round {view.verdicts.length})</span></h3>
        <table><thead><tr><th></th><th>Criterion</th><th>Evidence observed by the verifier</th></tr></thead><tbody>
          {v.criteria.map((c, i) => <tr key={i}><td className={`tick ${c.status}`}>{c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "?"}</td><td>{c.criterion}</td><td>{c.evidence}</td></tr>)}
        </tbody></table>
        <p><b>Procedure compliance:</b> {v.sop_compliance}</p>
        {v.notes && <p className="muted">{v.notes}</p>}
      </>}
      {view.brief && <>
        <h3>How the operator understood the request</h3>
        <p><b>Intended outcome:</b> {view.brief.intended_outcome}</p>
        <p><b>Interpretation:</b> {view.brief.interpretation}</p>
        {view.brief.assumptions.length > 0 && <p><b>Assumptions:</b> {view.brief.assumptions.join(" · ")}</p>}
        {view.brief.risks.length > 0 && <p><b>Risks / red flags:</b> {view.brief.risks.join(" · ")}</p>}
      </>}
      {view.evidence.length > 0 && <>
        <h3>Evidence</h3>
        <div className="evid">{view.evidence.map((e, i) => (
          <div key={i} className="ev-card">{e.image && <img src={fileUrl(view.id, e.image)} onClick={() => onImage(fileUrl(view.id, e.image!))} />}<b>{e.label}</b><div className="muted small">{e.detail}</div></div>
        ))}</div>
      </>}
      {view.finished && <p><a href={fileUrl(view.id, "report.md")} target="_blank">Full evidence report (report.md) ↗</a> · <a href={fileUrl(view.id, "events.jsonl")} target="_blank">raw event log ↗</a></p>}
    </div>
  );
}

function CompanyState() {
  const [s, setS] = useState<any>(null);
  useEffect(() => {
    let t: any; let alive = true;
    const load = () => api<any>("/api/sandbox/state").then((x) => alive && setS(x)).catch(() => {}).finally(() => { if (alive) t = setTimeout(load, 3000); });
    load();
    return () => { alive = false; clearTimeout(t); };
  }, []);
  if (!s) return <p className="muted pad">Loading…</p>;
  const folders = ["Inbox", "Processed", "Sent"];
  return (
    <div className="company">
      <h4>Ledgerly — invoices</h4>
      <table><thead><tr><th>Invoice</th><th>Vendor</th><th className="num">Amount</th><th>Due</th><th>Status</th><th>Ref / reason</th></tr></thead><tbody>
        {[...s.invoices].reverse().map((i: any) => <tr key={i.id}><td>{i.number}</td><td>{i.vendor_id}</td><td className="num">{i.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}</td><td>{i.due_date}</td><td><span className={`pill s-${i.status.replace(" ", "-")}`}>{i.status}</span></td><td className="small">{i.payment_ref ?? i.hold_reason ?? ""}</td></tr>)}
      </tbody></table>
      <h4>Acme Mail — AP mailbox</h4>
      {folders.map((f) => (
        <div key={f}><div className="muted small">{f}</div>
          <ul className="mail">{s.mail.filter((m: any) => m.folder === f).map((m: any) => <li key={m.id}>{f === "Sent" ? `→ ${m.to}` : m.from} · <b>{m.subject}</b></li>)}</ul></div>
      ))}
      <h4>Acme Treasury — payment register</h4>
      <table><thead><tr><th>Confirmation</th><th>Payee</th><th>Invoice</th><th className="num">Amount</th><th>Released by</th></tr></thead><tbody>
        {s.payments.map((p: any) => <tr key={p.confirmation}><td>{p.confirmation}</td><td>{p.payee_id}</td><td>{p.invoice_ref}</td><td className="num">{p.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}</td><td>{p.released_by}</td></tr>)}
      </tbody></table>
      <h4>Ledgerly audit log (latest)</h4>
      <ul className="mail">{s.audit.map((a: any) => <li key={a.id}><span className="muted">{a.ts.slice(5, 16).replace("T", " ")}</span> <b>{a.user}</b> {a.action} {a.entity} — {a.detail}</li>)}</ul>
    </div>
  );
}
