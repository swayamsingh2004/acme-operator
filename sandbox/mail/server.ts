/**
 * Acme Mail — webmail for the AP shared mailbox (sandbox). Nothing leaves the
 * sandbox: "sent" mail is stored in the Sent folder for review and evals.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import { MAIL_ATTACHMENTS, MAIL_DB, PORTS, SANDBOX_TOKEN, VAULT } from "../shared/paths.ts";
import { dbOpener, type Row } from "../shared/sqlite.ts";
import { h, layout, parseCookies, type Brand } from "../shared/html.ts";

const db = dbOpener(MAIL_DB);
const brand: Brand = { name: "Acme Mail", accent: "#0b7a75", logo: "✉" };
const MAILBOX = VAULT.mail.username;
const FOLDERS = ["Inbox", "Processed", "Sent"];
const sessions = new Set<string>();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

type Req = Request & { authed?: boolean };

function render(req: Req, res: Response, title: string, body: string, status = 200) {
  const flash = req.query.ok ? { kind: "ok" as const, text: String(req.query.ok) } : req.query.err ? { kind: "error" as const, text: String(req.query.err) } : null;
  const counts = req.authed ? (db().prepare("SELECT folder, SUM(unread) unread, COUNT(*) n FROM messages GROUP BY folder").all() as Row[]) : [];
  const folderNav = FOLDERS.map((f) => {
    const c = counts.find((x) => x.folder === f);
    return { href: `/?folder=${encodeURIComponent(f)}`, label: `${f}${c?.unread ? ` (${c.unread})` : ""}`, active: req.query.folder === f || (!req.query.folder && f === "Inbox" && req.path === "/") };
  });
  res.status(status).type("html").send(layout({
    brand, title, flash, body,
    user: req.authed ? MAILBOX : undefined,
    nav: req.authed ? [...folderNav, { href: "/compose", label: "Compose" }] : [],
  }));
}

// --- internal API ------------------------------------------------------------
app.get("/api/state", (req, res) => {
  if (req.get("x-sandbox-token") !== SANDBOX_TOKEN) return res.status(401).json({ ok: false });
  res.json({ messages: db().prepare("SELECT * FROM messages ORDER BY id").all() });
});

// --- auth --------------------------------------------------------------------
app.get("/login", (req: Req, res) => render(req, res, "Sign in", `
  <div class="card" style="max-width:420px;margin:60px auto"><h1>Acme Mail</h1>
  <form method="post" action="/login">
    <label for="email">Email</label><input id="email" name="email" autocomplete="username">
    <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password">
    <p><button type="submit">Sign in</button></p></form></div>`));

app.post("/login", (req: Req, res) => {
  if (req.body.email !== VAULT.mail.username || req.body.password !== VAULT.mail.password)
    return render(req, res, "Sign in", `<div class="card" style="max-width:420px;margin:60px auto"><div class="flash error">Wrong email or password.</div><a href="/login">Try again</a></div>`, 401);
  const sid = crypto.randomBytes(16).toString("hex");
  sessions.add(sid);
  res.setHeader("Set-Cookie", `mail_sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  res.redirect("/");
});

app.get("/logout", (_req, res) => { res.setHeader("Set-Cookie", "mail_sid=; Path=/; Max-Age=0"); res.redirect("/login"); });

app.use((req: Req, res: Response, next: NextFunction) => {
  if (!sessions.has(parseCookies(req.headers.cookie).mail_sid ?? "")) return res.redirect("/login");
  req.authed = true;
  next();
});

// --- folders & messages ------------------------------------------------------
app.get("/", (req: Req, res) => {
  const folder = FOLDERS.includes(String(req.query.folder)) ? String(req.query.folder) : "Inbox";
  const rows = db().prepare("SELECT * FROM messages WHERE folder = ? ORDER BY date DESC, id DESC").all(folder) as Row[];
  const who = (m: Row) => (folder === "Sent" ? `To: ${h(m.to_addr)}` : `${h(m.from_name)} &lt;${h(m.from_addr)}&gt;`);
  render(req, res, folder, `<h1>${folder}</h1>
    ${rows.length ? `<table aria-label="${folder} messages"><thead><tr><th></th><th>${folder === "Sent" ? "To" : "From"}</th><th>Subject</th><th>Date</th></tr></thead><tbody>
    ${rows.map((m) => `<tr><td>${m.unread ? "●" : ""}${m.attachment_name ? " 📎" : ""}</td><td>${who(m)}</td><td><a href="/m/${m.id}">${m.unread ? `<strong>${h(m.subject)}</strong>` : h(m.subject)}</a></td><td>${h(m.date.slice(0, 16).replace("T", " "))}</td></tr>`).join("")}
    </tbody></table>` : `<div class="card muted">No messages in ${folder}.</div>`}`);
});

app.get("/m/:id", (req: Req, res) => {
  const m = db().prepare("SELECT * FROM messages WHERE id = ?").get(String(req.params.id)) as Row | undefined;
  if (!m) return render(req, res, "Not found", "<h1>Message not found</h1>", 404);
  db().prepare("UPDATE messages SET unread = 0 WHERE id = ?").run(m.id);
  render(req, res, m.subject, `
    <h1>${h(m.subject)}</h1>
    <div class="card">
      <div class="kv"><div>From</div><div>${h(m.from_name)} &lt;${h(m.from_addr)}&gt;</div><div>To</div><div>${h(m.to_addr)}</div>
      ${m.cc ? `<div>Cc</div><div>${h(m.cc)}</div>` : ""}<div>Date</div><div>${h(m.date.slice(0, 16).replace("T", " "))}</div><div>Folder</div><div>${h(m.folder)}</div></div>
      <hr style="border:0;border-top:1px solid var(--line);margin:14px 0">
      <div style="white-space:pre-wrap">${h(m.body)}</div>
      ${m.attachment_name ? `<p>Attachment: <a href="/attachments/${m.id}/${encodeURIComponent(m.attachment_name)}" download>📎 ${h(m.attachment_name)}</a></p>` : ""}
    </div>
    <div class="row">
      <a class="btn" href="/compose?reply=${m.id}">Reply</a>
      <a class="btn secondary" href="/compose?forward=${m.id}">Forward</a>
      <form class="inline row" method="post" action="/m/${m.id}/move"><label for="folder" style="margin:0">Move to</label>
        <select id="folder" name="folder" style="width:160px">${FOLDERS.filter((f) => f !== m.folder).map((f) => `<option>${f}</option>`).join("")}</select>
        <button type="submit" class="secondary">Move</button></form>
    </div>`);
});

app.get("/attachments/:id/:name", (req, res) => {
  const m = db().prepare("SELECT * FROM messages WHERE id = ?").get(String(req.params.id)) as Row | undefined;
  if (!m?.attachment_path) return res.status(404).send("Not found");
  res.download(path.join(MAIL_ATTACHMENTS, m.attachment_path), m.attachment_name);
});

app.post("/m/:id/move", (req: Req, res) => {
  const folder = String(req.body.folder);
  if (!FOLDERS.includes(folder)) return res.redirect(`/m/${req.params.id}?err=Unknown%20folder`);
  db().prepare("UPDATE messages SET folder = ? WHERE id = ?").run(folder, String(req.params.id));
  res.redirect(`/?folder=Inbox&ok=${encodeURIComponent(`Message moved to ${folder}.`)}`);
});

// --- compose / reply / forward ----------------------------------------------
app.get("/compose", (req: Req, res) => {
  let to = "", subject = "", body = "", mode = "new", ref = "";
  const quote = (m: Row) => `\n\n----- Original message -----\nFrom: ${m.from_name} <${m.from_addr}>\nDate: ${m.date.slice(0, 16).replace("T", " ")}\nSubject: ${m.subject}\n\n${m.body}`;
  if (req.query.reply || req.query.forward) {
    const m = db().prepare("SELECT * FROM messages WHERE id = ?").get(String(req.query.reply ?? req.query.forward)) as Row | undefined;
    if (m) {
      ref = String(m.id);
      if (req.query.reply) { mode = "reply"; to = m.from_addr; subject = m.subject.startsWith("Re:") ? m.subject : `Re: ${m.subject}`; body = quote(m); }
      else { mode = "forward"; subject = `Fwd: ${m.subject}`; body = quote(m); }
    }
  }
  render(req, res, "Compose", `<h1>${mode === "reply" ? "Reply" : mode === "forward" ? "Forward" : "New message"}</h1>
    <div class="card"><form method="post" action="/compose">
      <input type="hidden" name="mode" value="${mode}"><input type="hidden" name="ref" value="${ref}">
      <label for="to">To</label><input id="to" name="to" value="${h(to)}">
      <label for="cc">Cc</label><input id="cc" name="cc">
      <label for="subject">Subject</label><input id="subject" name="subject" value="${h(subject)}">
      <label for="body">Message</label><textarea id="body" name="body">${h(body)}</textarea>
      <p><button type="submit">Send</button></p>
    </form></div>`);
});

app.post("/compose", (req: Req, res) => {
  const { to, cc, subject, body, mode, ref } = req.body as Row;
  const addrs = `${to ?? ""},${cc ?? ""}`.split(/[,;\s]+/).filter(Boolean);
  if (!addrs.length || addrs.some((a) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a))) return res.redirect(`/compose?err=${encodeURIComponent("Enter valid recipient email addresses.")}`);
  if (!String(subject ?? "").trim()) return res.redirect(`/compose?err=${encodeURIComponent("Subject is required.")}`);
  const src = ref ? (db().prepare("SELECT * FROM messages WHERE id = ?").get(String(ref)) as Row | undefined) : undefined;
  const r = db().prepare(`INSERT INTO messages(folder, from_name, from_addr, to_addr, cc, subject, body, date, unread, in_reply_to, kind, attachment_name, attachment_path)
    VALUES('Sent', 'Acme AP Team', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`).run(
    MAILBOX, String(to ?? "").trim(), String(cc ?? "").trim(), subject, body ?? "", new Date().toISOString(), src?.id ?? null, mode ?? "new",
    mode === "forward" ? src?.attachment_name ?? null : null, mode === "forward" ? src?.attachment_path ?? null : null);
  res.redirect(`/m/${r.lastInsertRowid}?ok=${encodeURIComponent("Message sent.")}`);
});

export function startMail(port = PORTS.mail) {
  fs.mkdirSync(MAIL_ATTACHMENTS, { recursive: true });
  return app.listen(port, () => console.log(`[mail] http://localhost:${port}`));
}

if (import.meta.url === `file://${process.argv[1]}`) startMail();
