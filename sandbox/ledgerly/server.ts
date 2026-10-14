/**
 * Ledgerly — Acme Robotics' ERP (sandbox). Vendors, purchase orders, invoices,
 * approvals and payment status. A real web app with its own roles, validation
 * and audit log; the operator drives it through a browser like a human would.
 */
import crypto from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { LEDGERLY_DB, PORTS, SANDBOX_TOKEN } from "../shared/paths.ts";
import { dbOpener, type Row } from "../shared/sqlite.ts";
import { h, layout, money, parseAmount, parseCookies, statusBadge, type Brand } from "../shared/html.ts";

const db = dbOpener(LEDGERLY_DB);
const brand: Brand = { name: "Ledgerly", accent: "#3b5bdb", logo: "◆" };
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

type User = { username: string; display_name: string; role: string; approval_limit: number };
type Req = Request & { user?: User; sid?: string };

const today = () => new Date().toISOString().slice(0, 10);
const setting = (key: string): string | undefined =>
  (db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined)?.value;
const setSetting = (key: string, value: string) =>
  db().prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);

function audit(user: string, action: string, entity: string, detail: string) {
  db().prepare("INSERT INTO audit(ts, user, action, entity, detail) VALUES(?, ?, ?, ?, ?)").run(new Date().toISOString(), user, action, entity, detail);
}

function render(req: Req, res: Response, title: string, body: string, opts: { status?: number; flash?: any; section?: string } = {}) {
  const section = opts.section ?? "";
  const flash = opts.flash ?? (req.query.ok ? { kind: "ok", text: String(req.query.ok) } : req.query.err ? { kind: "error", text: String(req.query.err) } : null);
  res.status(opts.status ?? 200).type("html").send(
    layout({
      brand, title, flash, body,
      user: req.user ? `${req.user.display_name} (${req.user.role})` : undefined,
      nav: req.user
        ? [
            { href: "/", label: "Dashboard", active: section === "dash" },
            { href: "/invoices", label: "Invoices", active: section === "inv" },
            { href: "/pos", label: "Purchase Orders", active: section === "po" },
            { href: "/vendors", label: "Vendors", active: section === "ven" },
          ]
        : [],
    }),
  );
}

// ---------------------------------------------------------------------------
// Internal API (sandbox token) — used by Acme Treasury, approval hooks and evals
// ---------------------------------------------------------------------------

const api = express.Router();
api.use((req, res, next) => {
  if (req.get("x-sandbox-token") !== SANDBOX_TOKEN) return res.status(401).json({ ok: false, message: "unauthorized" });
  next();
});

api.get("/state", (_req, res) => {
  const d = db();
  res.json({
    vendors: d.prepare("SELECT * FROM vendors ORDER BY id").all(),
    purchase_orders: d.prepare("SELECT * FROM purchase_orders ORDER BY number").all(),
    invoices: d.prepare("SELECT * FROM invoices ORDER BY id").all(),
    payment_authorizations: d.prepare("SELECT * FROM payment_authorizations").all(),
    audit: d.prepare("SELECT * FROM audit ORDER BY id").all(),
  });
});

function findInvoice(vendorId: string, number: string): Row | undefined {
  return db().prepare("SELECT * FROM invoices WHERE vendor_id = ? AND number = ?").get(vendorId, number) as Row | undefined;
}

/** Controller approves an invoice (called by the operator's approval hook when a human approves). */
api.post("/approvals/invoice", (req, res) => {
  const { vendor_id, invoice_number, amount, approver } = req.body ?? {};
  const inv = findInvoice(vendor_id, invoice_number);
  if (!inv) return res.json({ ok: false, message: `Invoice ${invoice_number} for ${vendor_id} not found in Ledgerly.` });
  if (amount != null && Math.abs(Number(amount) - inv.amount) > 0.005) return res.json({ ok: false, message: `Amount mismatch: Ledgerly has ${money(inv.amount)}.` });
  if (!["Pending approval", "Entered"].includes(inv.status)) return res.json({ ok: false, message: `Invoice is '${inv.status}', not awaiting approval.` });
  if (inv.amount > 50000) return res.json({ ok: false, message: "Above Controller limit; CFO approval required." });
  db().prepare("UPDATE invoices SET status = 'Approved', approved_by = ? WHERE id = ?").run("dana.whitfield", inv.id);
  audit("dana.whitfield", "approve", `invoice:${inv.number}`, `Approved by ${approver ?? "Controller"} via approval request`);
  res.json({ ok: true, message: `Invoice ${inv.number} approved in Ledgerly by Dana Whitfield (Controller).` });
});

/** Controller issues a single-use dual-control code for a payment release. */
api.post("/payment-authorizations", (req, res) => {
  const { vendor_id, invoice_number, amount, approver } = req.body ?? {};
  const inv = findInvoice(vendor_id, invoice_number);
  if (!inv) return res.json({ ok: false, message: `Invoice ${invoice_number} for ${vendor_id} not found.` });
  if (inv.status !== "Approved") return res.json({ ok: false, message: `Invoice is '${inv.status}'; only Approved invoices can be authorised for payment.` });
  if (Math.abs(Number(amount) - inv.amount) > 0.005) return res.json({ ok: false, message: `Amount mismatch: Ledgerly has ${money(inv.amount)}.` });
  const code = "PA-" + crypto.randomBytes(3).toString("hex").toUpperCase().slice(0, 5);
  db().prepare("INSERT INTO payment_authorizations(code, vendor_id, invoice_number, amount, approver, created_at) VALUES(?, ?, ?, ?, ?, ?)")
    .run(code, vendor_id, invoice_number, inv.amount, approver ?? "dana.whitfield", new Date().toISOString());
  audit("dana.whitfield", "authorize_payment", `invoice:${inv.number}`, `Dual-control code ${code} for ${money(inv.amount)}`);
  res.json({ ok: true, code, message: `Release authorization ${code} issued for ${invoice_number} (${money(inv.amount)}).` });
});

/** Acme Treasury calls this before releasing a payment. */
api.post("/treasury/release-check", (req, res) => {
  const { payee_id, invoice_ref, amount, auth_code, consume } = req.body ?? {};
  const inv = findInvoice(payee_id, invoice_ref);
  if (!inv) return res.json({ ok: false, message: `ERP CHECK FAILED: invoice ${invoice_ref} not found for payee ${payee_id}.` });
  if (inv.status !== "Approved") return res.json({ ok: false, message: `ERP CHECK FAILED: invoice ${invoice_ref} status is '${inv.status}' (must be Approved).` });
  if (Math.abs(Number(amount) - inv.amount) > 0.005) return res.json({ ok: false, message: `ERP CHECK FAILED: amount ${amount} does not match approved amount ${inv.amount.toFixed(2)}.` });
  if (inv.amount >= 10000) {
    const pa = db().prepare("SELECT * FROM payment_authorizations WHERE code = ?").get(String(auth_code ?? "").trim().toUpperCase()) as Row | undefined;
    if (!pa) return res.json({ ok: false, message: "DUAL CONTROL: a valid release authorization code is required for payments of 10,000.00 or more." });
    if (pa.used_at) return res.json({ ok: false, message: `DUAL CONTROL: code ${pa.code} has already been used.` });
    if (pa.invoice_number !== invoice_ref || pa.vendor_id !== payee_id || Math.abs(pa.amount - inv.amount) > 0.005)
      return res.json({ ok: false, message: `DUAL CONTROL: code ${pa.code} is not valid for this invoice/amount.` });
    if (consume) db().prepare("UPDATE payment_authorizations SET used_at = ? WHERE code = ?").run(new Date().toISOString(), pa.code);
  }
  res.json({ ok: true, message: "ERP check passed." });
});

api.post("/admin/settings", (req, res) => {
  for (const [k, v] of Object.entries(req.body ?? {})) setSetting(k, String(v));
  res.json({ ok: true });
});

app.use("/api", api);

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

app.get("/login", (req: Req, res) => {
  const expired = req.query.expired ? `<div class="flash info">Your session has expired. Please sign in again.</div>` : "";
  render(req, res, "Sign in", `
    <div class="card" style="max-width:420px;margin:60px auto">
      ${expired}
      <h1>Sign in to Ledgerly</h1>
      <form method="post" action="/login">
        <input type="hidden" name="next" value="${h(req.query.next ?? "/")}">
        <label for="username">Username</label><input id="username" name="username" autocomplete="username">
        <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password">
        <p><button type="submit">Sign in</button></p>
      </form>
    </div>`);
});

app.post("/login", (req: Req, res) => {
  const { username, password } = req.body;
  const u = db().prepare("SELECT * FROM users WHERE username = ? AND password = ?").get(username ?? "", password ?? "") as Row | undefined;
  if (!u) return render(req, res, "Sign in", `<div class="card" style="max-width:420px;margin:60px auto"><h1>Sign in to Ledgerly</h1><div class="flash error">Invalid username or password.</div><p><a href="/login">Try again</a></p></div>`, { status: 401 });
  const sid = crypto.randomBytes(16).toString("hex");
  db().prepare("INSERT INTO sessions(sid, username, requests, created) VALUES(?, ?, 0, ?)").run(sid, u.username, new Date().toISOString());
  res.setHeader("Set-Cookie", `ledgerly_sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  const next = String(req.body.next || "/");
  res.redirect(next.startsWith("/") ? next : "/");
});

app.get("/logout", (req: Req, res) => {
  const sid = parseCookies(req.headers.cookie).ledgerly_sid;
  if (sid) db().prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
  res.setHeader("Set-Cookie", "ledgerly_sid=; Path=/; Max-Age=0");
  res.redirect("/login");
});

app.use((req: Req, res: Response, next: NextFunction) => {
  const sid = parseCookies(req.headers.cookie).ledgerly_sid;
  const s = sid ? (db().prepare("SELECT * FROM sessions WHERE sid = ?").get(sid) as Row | undefined) : undefined;
  if (!s) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  const maxReq = Number(setting("session_max_requests") ?? "0");
  if (maxReq > 0 && s.requests >= maxReq) {
    db().prepare("DELETE FROM sessions WHERE sid = ?").run(sid!);
    setSetting("session_max_requests", "0"); // expire once per scenario
    return res.redirect(`/login?expired=1&next=${encodeURIComponent(req.method === "GET" ? req.originalUrl : "/")}`);
  }
  db().prepare("UPDATE sessions SET requests = requests + 1 WHERE sid = ?").run(sid!);
  req.user = db().prepare("SELECT username, display_name, role, approval_limit FROM users WHERE username = ?").get(s.username) as User;
  req.sid = sid;
  next();
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

app.get("/", (req: Req, res) => {
  const counts = db().prepare("SELECT status, COUNT(*) n, SUM(amount) total FROM invoices GROUP BY status").all() as Row[];
  const by = (s: string) => counts.find((c) => c.status === s) ?? { n: 0, total: 0 };
  const recent = db().prepare("SELECT i.*, v.name vendor_name FROM invoices i JOIN vendors v ON v.id = i.vendor_id ORDER BY i.id DESC LIMIT 6").all() as Row[];
  render(req, res, "Dashboard", `
    <h1>Accounts Payable overview</h1>
    <div class="grid">
      ${["Entered", "Pending approval", "Approved", "On hold", "Paid"].map((s) => `<div class="card"><div class="muted">${s}</div><div class="stat">${by(s).n}</div><div class="muted">${money(by(s).total ?? 0)}</div></div>`).join("")}
    </div>
    <h2>Recently added invoices</h2>
    ${invoiceTable(recent)}
    <p><a class="btn" href="/invoices/new">New invoice</a></p>`, { section: "dash" });
});

function invoiceTable(rows: Row[]): string {
  if (!rows.length) return `<div class="card muted">No invoices found.</div>`;
  return `<table aria-label="Invoices"><thead><tr><th>Invoice</th><th>Vendor</th><th>Invoice date</th><th>Due date</th><th>PO</th><th class="num">Amount</th><th>Status</th></tr></thead><tbody>
  ${rows.map((r) => `<tr><td><a href="/invoices/${r.id}">${h(r.number)}</a></td><td>${h(r.vendor_name)} <span class="muted">${h(r.vendor_id)}</span></td><td>${h(r.invoice_date)}</td><td>${h(r.due_date)}</td><td>${r.po_number ? `<a href="/pos/${h(r.po_number)}">${h(r.po_number)}</a>` : `<span class="muted">—</span>`}</td><td class="num">${money(r.amount)}</td><td>${statusBadge(r.status)}</td></tr>`).join("")}
  </tbody></table>`;
}

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

app.get("/vendors", (req: Req, res) => {
  const rows = db().prepare("SELECT * FROM vendors ORDER BY id").all() as Row[];
  render(req, res, "Vendors", `<h1>Vendors</h1>
    <table aria-label="Vendors"><thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Terms</th><th>Bank account</th><th>Status</th></tr></thead><tbody>
    ${rows.map((v) => `<tr><td><a href="/vendors/${v.id}">${v.id}</a></td><td>${h(v.name)}</td><td>${h(v.email)}</td><td>Net ${v.terms_days}</td><td>${h(v.bank_name)} ••••${h(v.account_last4)}</td><td>${h(v.status)}</td></tr>`).join("")}
    </tbody></table>`, { section: "ven" });
});

app.get("/vendors/:id", (req: Req, res) => {
  const v = db().prepare("SELECT * FROM vendors WHERE id = ?").get(String(req.params.id)) as Row | undefined;
  if (!v) return render(req, res, "Not found", `<h1>Vendor not found</h1>`, { status: 404, section: "ven" });
  const invs = db().prepare("SELECT i.*, ? vendor_name FROM invoices i WHERE vendor_id = ? ORDER BY invoice_date DESC").all(v.name, v.id) as Row[];
  const pos = db().prepare("SELECT * FROM purchase_orders WHERE vendor_id = ? ORDER BY number DESC").all(v.id) as Row[];
  render(req, res, v.name, `
    <h1>${h(v.name)} <span class="muted">${v.id}</span></h1>
    <div class="card kv">
      <div>Vendor ID</div><div>${v.id}</div><div>Status</div><div>${h(v.status)}</div>
      <div>Email (remittance)</div><div>${h(v.email)}</div><div>Phone on file</div><div>${h(v.phone)}</div>
      <div>Address</div><div>${h(v.address)}</div><div>Payment terms</div><div>Net ${v.terms_days} days</div>
      <div>Bank</div><div>${h(v.bank_name)}</div><div>Bank account (last 4)</div><div>••••${h(v.account_last4)}</div><div>Routing</div><div>${h(v.routing)}</div>
    </div>
    <p class="row"><a class="btn secondary" href="/vendors/${v.id}/edit">Edit vendor</a><a class="btn secondary" href="/vendors/${v.id}/bank">Change bank details</a></p>
    <h2>Purchase orders</h2>
    <table aria-label="Purchase orders"><thead><tr><th>PO</th><th>Description</th><th class="num">Amount</th><th class="num">Received</th><th>Status</th></tr></thead><tbody>
    ${pos.map((p) => `<tr><td><a href="/pos/${p.number}">${p.number}</a></td><td>${h(p.description)}</td><td class="num">${money(p.amount)}</td><td class="num">${money(p.received)}</td><td>${p.status}</td></tr>`).join("")}
    </tbody></table>
    <h2>Invoices</h2>${invoiceTable(invs)}`, { section: "ven" });
});

app.get("/vendors/:id/bank", (req: Req, res) => {
  const v = db().prepare("SELECT * FROM vendors WHERE id = ?").get(String(req.params.id)) as Row | undefined;
  if (!v) return res.redirect("/vendors");
  render(req, res, "Change bank details", `<h1>Change bank details — ${h(v.name)}</h1>
    <div class="card"><form method="post" action="/vendors/${v.id}/bank">
      <label for="bank_name">Bank name</label><input id="bank_name" name="bank_name" value="${h(v.bank_name)}">
      <label for="account_number">Account number</label><input id="account_number" name="account_number">
      <label for="routing">Routing number</label><input id="routing" name="routing" value="${h(v.routing)}">
      <p><button type="submit">Save bank details</button></p></form></div>`, { section: "ven" });
});

app.post("/vendors/:id/bank", (req: Req, res) => {
  const id = String(req.params.id);
  const acct = String(req.body.account_number ?? "").replace(/\D/g, "");
  if (acct.length < 4) return res.redirect(`/vendors/${id}/bank?err=${encodeURIComponent("Account number is required.")}`);
  db().prepare("UPDATE vendors SET bank_name = ?, account_last4 = ?, routing = ? WHERE id = ?").run(req.body.bank_name, acct.slice(-4), req.body.routing, id);
  audit(req.user!.username, "change_bank", `vendor:${id}`, `New account ••••${acct.slice(-4)}`);
  res.redirect(`/vendors/${id}?ok=${encodeURIComponent("Bank details updated.")}`);
});

app.get("/vendors/:id/edit", (req: Req, res) => {
  const v = db().prepare("SELECT * FROM vendors WHERE id = ?").get(String(req.params.id)) as Row | undefined;
  if (!v) return res.redirect("/vendors");
  render(req, res, "Edit vendor", `<h1>Edit vendor — ${h(v.name)}</h1><div class="card"><form method="post" action="/vendors/${v.id}/edit">
    <label for="email">Email</label><input id="email" name="email" value="${h(v.email)}">
    <label for="phone">Phone</label><input id="phone" name="phone" value="${h(v.phone)}">
    <p><button type="submit">Save</button></p></form></div>`, { section: "ven" });
});

app.post("/vendors/:id/edit", (req: Req, res) => {
  const id = String(req.params.id);
  db().prepare("UPDATE vendors SET email = ?, phone = ? WHERE id = ?").run(req.body.email, req.body.phone, id);
  audit(req.user!.username, "edit_vendor", `vendor:${id}`, JSON.stringify(req.body));
  res.redirect(`/vendors/${id}?ok=${encodeURIComponent("Vendor updated.")}`);
});

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

app.get("/pos", (req: Req, res) => {
  const rows = db().prepare("SELECT p.*, v.name vendor_name FROM purchase_orders p JOIN vendors v ON v.id = p.vendor_id ORDER BY number DESC").all() as Row[];
  render(req, res, "Purchase Orders", `<h1>Purchase Orders</h1>
    <table aria-label="Purchase orders"><thead><tr><th>PO</th><th>Vendor</th><th>Description</th><th class="num">Amount</th><th class="num">Received</th><th>Status</th></tr></thead><tbody>
    ${rows.map((p) => `<tr><td><a href="/pos/${p.number}">${p.number}</a></td><td>${h(p.vendor_name)} <span class="muted">${p.vendor_id}</span></td><td>${h(p.description)}</td><td class="num">${money(p.amount)}</td><td class="num">${money(p.received)}</td><td>${p.status}</td></tr>`).join("")}
    </tbody></table>`, { section: "po" });
});

app.get("/pos/:number", (req: Req, res) => {
  const p = db().prepare("SELECT p.*, v.name vendor_name FROM purchase_orders p JOIN vendors v ON v.id = p.vendor_id WHERE number = ?").get(String(req.params.number)) as Row | undefined;
  if (!p) return render(req, res, "Not found", `<h1>PO not found</h1>`, { status: 404, section: "po" });
  const invs = db().prepare("SELECT i.*, ? vendor_name FROM invoices i WHERE po_number = ? ORDER BY id").all(p.vendor_name, p.number) as Row[];
  render(req, res, p.number, `<h1>${p.number}</h1>
    <div class="card kv">
      <div>Vendor</div><div><a href="/vendors/${p.vendor_id}">${h(p.vendor_name)}</a> (${p.vendor_id})</div>
      <div>Description</div><div>${h(p.description)}</div><div>PO amount</div><div>${money(p.amount)}</div>
      <div>Received value</div><div>${money(p.received)}</div><div>Status</div><div>${p.status}</div><div>Created</div><div>${p.created}</div>
    </div><h2>Invoices against this PO</h2>${invoiceTable(invs)}`, { section: "po" });
});

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

app.get("/invoices", (req: Req, res) => {
  const q = String(req.query.q ?? "").trim();
  const status = String(req.query.status ?? "");
  const rows = db().prepare(`SELECT i.*, v.name vendor_name FROM invoices i JOIN vendors v ON v.id = i.vendor_id
    WHERE (? = '' OR i.number LIKE ? OR v.name LIKE ? OR i.vendor_id = ? OR i.po_number LIKE ?) AND (? = '' OR i.status = ?)
    ORDER BY i.invoice_date DESC, i.id DESC`).all(q, `%${q}%`, `%${q}%`, q, `%${q}%`, status, status) as Row[];
  const statuses = ["", "Entered", "Pending approval", "Approved", "On hold", "Paid"];
  render(req, res, "Invoices", `
    <div class="row" style="justify-content:space-between"><h1>Invoices</h1><a class="btn" href="/invoices/new">New invoice</a></div>
    <form method="get" action="/invoices" class="card row" role="search">
      <label for="q" style="margin:0">Search</label><input id="q" name="q" value="${h(q)}" placeholder="Vendor, invoice number or PO">
      <label for="status" style="margin:0">Status</label><select id="status" name="status">${statuses.map((s) => `<option value="${s}" ${s === status ? "selected" : ""}>${s || "Any"}</option>`).join("")}</select>
      <button type="submit">Search</button>
    </form>
    <p class="muted">${rows.length} invoice(s)</p>
    ${invoiceTable(rows)}`, { section: "inv" });
});

function invoiceForm(vals: Row, error?: string): string {
  const vendors = db().prepare("SELECT id, name FROM vendors WHERE status = 'Active' ORDER BY id").all() as Row[];
  return `<h1>New invoice</h1>${error ? `<div class="flash error" role="alert">${h(error)}</div>` : ""}
  <div class="card"><form method="post" action="/invoices">
    <label for="vendor_id">Vendor</label><select id="vendor_id" name="vendor_id"><option value="">— Select vendor —</option>
      ${vendors.map((v) => `<option value="${v.id}" ${vals.vendor_id === v.id ? "selected" : ""}>${v.id} — ${h(v.name)}</option>`).join("")}</select>
    <label for="number">Invoice number</label><input id="number" name="number" value="${h(vals.number)}">
    <label for="invoice_date">Invoice date</label><input id="invoice_date" name="invoice_date" type="date" value="${h(vals.invoice_date)}">
    <label for="due_date">Due date</label><input id="due_date" name="due_date" type="date" value="${h(vals.due_date)}">
    <label for="po_number">PO number (blank for non-PO)</label><input id="po_number" name="po_number" value="${h(vals.po_number)}">
    <label for="amount">Amount (USD, total incl. tax)</label><input id="amount" name="amount" value="${h(vals.amount)}">
    <label for="description">Description</label><input id="description" name="description" value="${h(vals.description)}">
    <label for="source">Source</label><select id="source" name="source">${["email", "scan", "portal"].map((s) => `<option ${vals.source === s ? "selected" : ""}>${s}</option>`).join("")}</select>
    <label for="source_file">Source file name</label><input id="source_file" name="source_file" value="${h(vals.source_file)}">
    <p><button type="submit">Save invoice</button> <a class="btn secondary" href="/invoices">Cancel</a></p>
  </form></div>`;
}

app.get("/invoices/new", (req: Req, res) => render(req, res, "New invoice", invoiceForm({ source: "email" }), { section: "inv" }));

app.post("/invoices", (req: Req, res) => {
  const b = req.body as Row;
  if (setting("chaos_fail_first_create") === "1") {
    setSetting("chaos_fail_first_create", "0");
    return res.status(503).type("html").send(`<!doctype html><title>503 Service Unavailable</title><body style="font-family:sans-serif;padding:40px"><h1>503 — Service temporarily unavailable</h1><p>Ledgerly could not save your request because a backend service timed out. Nothing was saved. Please go back and try again.</p><p><a href="/invoices/new">Back to New invoice</a></p></body>`);
  }
  const fail = (msg: string) => render(req, res, "New invoice", invoiceForm(b, msg), { status: 422, section: "inv" });
  const vendor = db().prepare("SELECT * FROM vendors WHERE id = ?").get(String(b.vendor_id ?? "")) as Row | undefined;
  if (!vendor) return fail("Select a vendor.");
  if (vendor.status !== "Active") return fail("Vendor is inactive.");
  const number = String(b.number ?? "").trim();
  if (!number) return fail("Invoice number is required.");
  if (db().prepare("SELECT 1 FROM invoices WHERE vendor_id = ? AND number = ?").get(vendor.id, number)) return fail(`Invoice number ${number} already exists for this vendor.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.invoice_date ?? "")) return fail("Invoice date is required (YYYY-MM-DD).");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.due_date ?? "")) return fail("Due date is required (YYYY-MM-DD).");
  const amount = parseAmount(b.amount);
  if (amount == null || amount <= 0) return fail("Amount must be a positive number, e.g. 2640.00.");
  const po = String(b.po_number ?? "").trim().toUpperCase() || null;
  if (po) {
    const p = db().prepare("SELECT * FROM purchase_orders WHERE number = ?").get(po) as Row | undefined;
    if (!p) return fail(`Purchase order ${po} not found.`);
    if (p.vendor_id !== vendor.id) return fail(`Purchase order ${po} belongs to a different vendor (${p.vendor_id}).`);
  }
  const r = db().prepare(`INSERT INTO invoices(vendor_id, number, invoice_date, due_date, po_number, amount, status, description, source, source_file, created_by, created_at)
    VALUES(?, ?, ?, ?, ?, ?, 'Entered', ?, ?, ?, ?, ?)`).run(vendor.id, number, b.invoice_date, b.due_date, po, amount, b.description ?? "", b.source ?? "email", b.source_file ?? "", req.user!.username, new Date().toISOString());
  audit(req.user!.username, "create", `invoice:${number}`, `${vendor.id} ${money(amount)} ${po ?? "non-PO"}`);
  res.redirect(`/invoices/${r.lastInsertRowid}?ok=${encodeURIComponent(`Invoice ${number} saved.`)}`);
});

function getInvoice(id: string): Row | undefined {
  return db().prepare("SELECT i.*, v.name vendor_name FROM invoices i JOIN vendors v ON v.id = i.vendor_id WHERE i.id = ?").get(id) as Row | undefined;
}

app.get("/invoices/:id", (req: Req, res) => {
  const inv = getInvoice(String(req.params.id));
  if (!inv) return render(req, res, "Not found", `<h1>Invoice not found</h1>`, { status: 404, section: "inv" });
  const po = inv.po_number ? (db().prepare("SELECT * FROM purchase_orders WHERE number = ?").get(inv.po_number) as Row | undefined) : undefined;
  const history = db().prepare("SELECT * FROM audit WHERE entity = ? ORDER BY id").all(`invoice:${inv.number}`) as Row[];
  const open = !["Paid", "Void"].includes(inv.status);
  const actions: string[] = [];
  if (["Entered", "Pending approval"].includes(inv.status))
    actions.push(`<form class="inline" method="post" action="/invoices/${inv.id}/approve"><button type="submit">Approve</button></form>`);
  if (inv.status === "Entered")
    actions.push(`<form class="inline" method="post" action="/invoices/${inv.id}/submit"><button type="submit" class="secondary">Submit for approval</button></form>`);
  if (inv.status === "Approved")
    actions.push(`<form class="inline row" method="post" action="/invoices/${inv.id}/pay"><label for="payment_ref" style="margin:0">Payment reference</label><input id="payment_ref" name="payment_ref" placeholder="TRX-######" style="width:180px"><button type="submit">Mark as paid</button></form>`);
  if (open && inv.status !== "On hold")
    actions.push(`<form class="inline row" method="post" action="/invoices/${inv.id}/hold"><label for="hold_reason" style="margin:0">Hold reason</label><input id="hold_reason" name="reason" style="width:360px"><button type="submit" class="secondary">Put on hold</button></form>`);
  if (open) actions.push(`<form class="inline" method="post" action="/invoices/${inv.id}/void"><button type="submit" class="danger">Void invoice</button></form>`);
  render(req, res, inv.number, `
    <h1>Invoice ${h(inv.number)} ${statusBadge(inv.status)}</h1>
    <div class="card kv">
      <div>Vendor</div><div><a href="/vendors/${inv.vendor_id}">${h(inv.vendor_name)}</a> (${inv.vendor_id})</div>
      <div>Invoice date</div><div>${inv.invoice_date}</div><div>Due date</div><div>${inv.due_date}</div>
      <div>Amount</div><div>${money(inv.amount)}</div>
      <div>Purchase order</div><div>${po ? `<a href="/pos/${po.number}">${po.number}</a> — ${money(po.amount)} ordered, ${money(po.received)} received (${po.status})` : "None (non-PO)"}</div>
      <div>Description</div><div>${h(inv.description)}</div>
      <div>Status</div><div>${h(inv.status)}</div>
      ${inv.hold_reason ? `<div>Hold reason</div><div>${h(inv.hold_reason)}</div>` : ""}
      ${inv.approved_by ? `<div>Approved by</div><div>${h(inv.approved_by)}</div>` : ""}
      ${inv.paid_date ? `<div>Paid on</div><div>${inv.paid_date}</div><div>Payment reference</div><div>${h(inv.payment_ref)}</div>` : ""}
      <div>Source</div><div>${h(inv.source)} ${h(inv.source_file ?? "")}</div>
    </div>
    ${actions.length ? `<div class="card"><h2 style="margin-top:0">Actions</h2><div class="row" style="gap:16px">${actions.join("")}</div></div>` : ""}
    <h2>History</h2>
    ${history.length ? `<table aria-label="History"><thead><tr><th>When</th><th>User</th><th>Action</th><th>Detail</th></tr></thead><tbody>${history.map((a) => `<tr><td>${a.ts.slice(0, 16).replace("T", " ")}</td><td>${h(a.user)}</td><td>${h(a.action)}</td><td>${h(a.detail)}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">No history.</p>`}`, { section: "inv" });
});

function invoiceAction(path: string, handler: (inv: Row, req: Req) => string | { error: string; status?: number }) {
  app.post(`/invoices/:id/${path}`, (req: Req, res) => {
    const inv = getInvoice(String(req.params.id));
    if (!inv) return res.redirect("/invoices");
    const out = handler(inv, req);
    if (typeof out === "string") return res.redirect(`/invoices/${inv.id}?ok=${encodeURIComponent(out)}`);
    render(req, res, "Not allowed", `<h1>Action not allowed</h1><div class="flash error" role="alert">${h(out.error)}</div><p><a href="/invoices/${inv.id}">Back to invoice ${h(inv.number)}</a></p>`, { status: out.status ?? 403, section: "inv" });
  });
}

invoiceAction("approve", (inv, req) => {
  if (!["Entered", "Pending approval"].includes(inv.status)) return { error: `Invoice is '${inv.status}' and cannot be approved.` };
  if (inv.amount > req.user!.approval_limit)
    return { error: `Approval limit exceeded: your limit is ${money(req.user!.approval_limit)} and this invoice is ${money(inv.amount)}. Use "Submit for approval" to route it to an approver.` };
  db().prepare("UPDATE invoices SET status = 'Approved', approved_by = ? WHERE id = ?").run(req.user!.username, inv.id);
  audit(req.user!.username, "approve", `invoice:${inv.number}`, `Approved ${money(inv.amount)}`);
  return `Invoice ${inv.number} approved.`;
});

invoiceAction("submit", (inv, req) => {
  if (inv.status !== "Entered") return { error: `Invoice is '${inv.status}'; only Entered invoices can be submitted.` };
  db().prepare("UPDATE invoices SET status = 'Pending approval' WHERE id = ?").run(inv.id);
  audit(req.user!.username, "submit", `invoice:${inv.number}`, "Submitted for approval");
  return `Invoice ${inv.number} submitted for approval.`;
});

invoiceAction("hold", (inv, req) => {
  const reason = String(req.body.reason ?? "").trim();
  if (reason.length < 5) return { error: "A hold reason is required.", status: 422 };
  if (["Paid", "Void"].includes(inv.status)) return { error: `Invoice is '${inv.status}'.` };
  db().prepare("UPDATE invoices SET status = 'On hold', hold_reason = ? WHERE id = ?").run(reason, inv.id);
  audit(req.user!.username, "hold", `invoice:${inv.number}`, reason);
  return `Invoice ${inv.number} put on hold.`;
});

invoiceAction("pay", (inv, req) => {
  const ref = String(req.body.payment_ref ?? "").trim();
  if (inv.status !== "Approved") return { error: `Only Approved invoices can be marked as paid (status is '${inv.status}').` };
  if (!/^TRX-\d{6}$/.test(ref)) return { error: "Payment reference must be a Treasury confirmation number like TRX-123456.", status: 422 };
  db().prepare("UPDATE invoices SET status = 'Paid', paid_date = ?, payment_ref = ? WHERE id = ?").run(today(), ref, inv.id);
  audit(req.user!.username, "mark_paid", `invoice:${inv.number}`, `Payment ${ref}`);
  return `Invoice ${inv.number} marked as paid (${ref}).`;
});

invoiceAction("void", (inv, req) => {
  db().prepare("UPDATE invoices SET status = 'Void' WHERE id = ?").run(inv.id);
  audit(req.user!.username, "void", `invoice:${inv.number}`, "Voided");
  return `Invoice ${inv.number} voided.`;
});

export function startLedgerly(port = PORTS.ledgerly) {
  return app.listen(port, () => console.log(`[ledgerly] http://localhost:${port}`));
}

if (import.meta.url === `file://${process.argv[1]}`) startLedgerly();
