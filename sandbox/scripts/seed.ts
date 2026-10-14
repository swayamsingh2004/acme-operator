/**
 * Seed (or reset) the sandbox company for a scenario.
 *   npm run seed                 -> "demo" scenario
 *   npm run seed -- pay-invoice  -> a specific scenario
 *
 * Materialises: Ledgerly DB, Acme Mail DB + attachments, Treasury DB, and the
 * shared drive. Invoice documents are rendered from HTML with Chromium (PDF for
 * emailed invoices, a skewed grayscale PNG for scanned paper invoices).
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { DATA, DRIVE, LEDGERLY_DB, MAIL_ATTACHMENTS, MAIL_DB, TREASURY_DB, TREASURY_DIR, VAULT } from "../shared/paths.ts";
import { uploadTreasuryDb } from "../shared/treasury.ts";
import { freshDb } from "../shared/sqlite.ts";
import { money } from "../shared/html.ts";
import {
  AP_MAILBOX, EMAILS, INVOICES, PURCHASE_ORDERS, SCANS, SCENARIOS, TREASURY_PAYMENTS, VENDORS,
  day, docTotal, treasuryPayees, vendor, type InvoiceDoc, type Scenario,
} from "../shared/world.ts";

function invoiceHtml(d: InvoiceDoc, scanned: boolean): string {
  const v = vendor(d.vendor_id);
  const sub = d.lines.reduce((s, l) => s + l.qty * l.unit, 0);
  const rows = d.lines.map((l) => `<tr><td>${l.description}</td><td class="n">${l.qty}</td><td class="n">${money(l.unit)}</td><td class="n">${money(l.qty * l.unit)}</td></tr>`).join("");
  const extras = (d.extras ?? []).map((e) => `<tr><td colspan="3" class="n">${e.label}</td><td class="n">${money(e.amount)}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;font-family:Helvetica,Arial,sans-serif;color:#222;${scanned ? "background:#ececec;" : ""}}
    .page{width:760px;padding:48px 52px;background:#fff;${scanned ? "transform:rotate(-1.1deg);filter:grayscale(1) contrast(1.15) blur(.35px);margin:30px;box-shadow:0 0 0 1px #ccc;" : ""}}
    .top{display:flex;justify-content:space-between;align-items:flex-start}
    .vname{font-size:22px;font-weight:700}.muted{color:#666;font-size:12px;line-height:1.5}
    h1{font-size:30px;letter-spacing:4px;margin:0;color:#444}
    .meta{margin-top:28px;display:grid;grid-template-columns:1fr 1fr;gap:16px}
    .box{border:1px solid #ddd;padding:12px;font-size:13px;line-height:1.6}
    table{width:100%;border-collapse:collapse;margin-top:26px;font-size:13px}th{background:#f1f1f1;text-align:left;padding:8px}td{padding:8px;border-bottom:1px solid #eee}
    .n{text-align:right}.total td{font-weight:700;font-size:15px;border-top:2px solid #333}
    .notes{margin-top:26px;font-size:12px;color:#444}
  </style></head><body><div class="page">
    <div class="top"><div><div class="vname">${v.name}</div><div class="muted">${v.address}<br>${v.email} · ${v.phone}</div></div><h1>INVOICE</h1></div>
    <div class="meta">
      <div class="box"><b>Bill to</b><br>Acme Robotics, Inc.<br>Accounts Payable<br>500 Innovation Dr, San Jose, CA 95134<br>${AP_MAILBOX}</div>
      <div class="box"><b>Invoice no.:</b> ${d.number}<br><b>Invoice date:</b> ${d.invoice_date}<br><b>Due date:</b> ${d.due_date}<br><b>Customer PO:</b> ${d.po_number ?? "—"}<br><b>Terms:</b> Net ${v.terms_days}</div>
    </div>
    <table><thead><tr><th>Description</th><th class="n">Qty</th><th class="n">Unit price</th><th class="n">Amount</th></tr></thead><tbody>
      ${rows}<tr><td colspan="3" class="n">Subtotal</td><td class="n">${money(sub)}</td></tr>${extras}
      <tr class="total"><td colspan="3" class="n">TOTAL DUE (USD)</td><td class="n">${money(docTotal(d))}</td></tr></tbody></table>
    <div class="notes">${d.notes ? `<p><b>${d.notes}</b></p>` : ""}<p>Remit to: ${v.bank_name}, account ending ${v.account_last4}. Please reference the invoice number with your payment.</p></div>
  </div></body></html>`;
}

async function renderDoc(browser: Browser, d: InvoiceDoc, outFile: string) {
  const page = await browser.newPage({ viewport: { width: 860, height: 1100 } });
  await page.setContent(invoiceHtml(d, d.kind === "scan"));
  if (d.kind === "scan") await page.locator(".page").screenshot({ path: outFile });
  else await page.pdf({ path: outFile, format: "Letter", printBackground: true });
  await page.close();
}

function seedLedgerly(s: Scenario) {
  freshDb(LEDGERLY_DB, (db) => {
    db.exec(`
      CREATE TABLE users(username TEXT PRIMARY KEY, password TEXT, display_name TEXT, role TEXT, approval_limit REAL);
      CREATE TABLE sessions(sid TEXT PRIMARY KEY, username TEXT, requests INTEGER, created TEXT);
      CREATE TABLE vendors(id TEXT PRIMARY KEY, name TEXT, email TEXT, phone TEXT, terms_days INTEGER, bank_name TEXT, account_last4 TEXT, routing TEXT, status TEXT, address TEXT);
      CREATE TABLE purchase_orders(number TEXT PRIMARY KEY, vendor_id TEXT, description TEXT, amount REAL, received REAL, status TEXT, created TEXT);
      CREATE TABLE invoices(id INTEGER PRIMARY KEY AUTOINCREMENT, vendor_id TEXT, number TEXT, invoice_date TEXT, due_date TEXT, po_number TEXT, amount REAL, status TEXT, description TEXT,
        hold_reason TEXT, paid_date TEXT, payment_ref TEXT, approved_by TEXT, source TEXT, source_file TEXT, created_by TEXT, created_at TEXT, UNIQUE(vendor_id, number));
      CREATE TABLE payment_authorizations(code TEXT PRIMARY KEY, vendor_id TEXT, invoice_number TEXT, amount REAL, approver TEXT, created_at TEXT, used_at TEXT);
      CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, user TEXT, action TEXT, entity TEXT, detail TEXT);
      CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);`);
    const users = db.prepare("INSERT INTO users VALUES(?, ?, ?, ?, ?)");
    users.run(VAULT.ledgerly.username, VAULT.ledgerly.password, "AI Operator", "AP Clerk", 5000);
    users.run("dana.whitfield", "controller-2026!", "Dana Whitfield", "Controller", 50000);
    users.run("marcus.lee", "cfo-2026!", "Marcus Lee", "CFO", 1e9);
    const v = db.prepare("INSERT INTO vendors VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const x of VENDORS) v.run(x.id, x.name, x.email, x.phone, x.terms_days, x.bank_name, x.account_last4, x.routing, x.status, x.address);
    const p = db.prepare("INSERT INTO purchase_orders VALUES(?, ?, ?, ?, ?, ?, ?)");
    for (const x of PURCHASE_ORDERS) p.run(x.number, x.vendor_id, x.description, x.amount, x.received, x.status, x.created);
    const inv = db.prepare(`INSERT INTO invoices(vendor_id, number, invoice_date, due_date, po_number, amount, status, description, hold_reason, paid_date, payment_ref, approved_by, source, source_file, created_by, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'ap.clerk', ?)`);
    const au = db.prepare("INSERT INTO audit(ts, user, action, entity, detail) VALUES(?, ?, ?, ?, ?)");
    for (const x of INVOICES) {
      inv.run(x.vendor_id, x.number, x.invoice_date, x.due_date, x.po_number, x.amount, x.status, x.description, x.hold_reason ?? null, x.paid_date ?? null, x.payment_ref ?? null, x.approved_by ?? null, x.source, `${x.invoice_date}T09:00:00`);
      au.run(`${x.invoice_date}T09:00:00`, "ap.clerk", "create", `invoice:${x.number}`, `${x.vendor_id} ${money(x.amount)}`);
      if (x.status === "On hold") au.run(`${x.invoice_date}T09:05:00`, "ap.clerk", "hold", `invoice:${x.number}`, x.hold_reason ?? "");
      if (x.approved_by) au.run(`${x.invoice_date}T15:00:00`, x.approved_by, "approve", `invoice:${x.number}`, `Approved ${money(x.amount)}`);
      if (x.paid_date) au.run(`${x.paid_date}T10:00:00`, "ap.clerk", "mark_paid", `invoice:${x.number}`, `Payment ${x.payment_ref}`);
    }
    const st = db.prepare("INSERT INTO settings VALUES(?, ?)");
    for (const [k, val] of Object.entries(s.ledgerlySettings ?? {})) st.run(k, val);
  });
}

function seedMail(s: Scenario, docsDir: string) {
  fs.rmSync(MAIL_ATTACHMENTS, { recursive: true, force: true });
  fs.mkdirSync(MAIL_ATTACHMENTS, { recursive: true });
  freshDb(MAIL_DB, (db) => {
    db.exec(`CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, folder TEXT, from_name TEXT, from_addr TEXT, to_addr TEXT, cc TEXT, subject TEXT, body TEXT,
      date TEXT, unread INTEGER, in_reply_to INTEGER, kind TEXT, attachment_name TEXT, attachment_path TEXT)`);
    const ins = db.prepare(`INSERT INTO messages(folder, from_name, from_addr, to_addr, cc, subject, body, date, unread, in_reply_to, kind, attachment_name, attachment_path)
      VALUES(?, ?, ?, ?, '', ?, ?, ?, ?, NULL, 'received', ?, ?)`);
    // A little history so the mailbox looks lived-in.
    ins.run("Processed", "Globex Accounts Receivable", "ap@globex.example", AP_MAILBOX, "Globex invoice GX-2024-0118 (PO-50231)", "Please find attached invoice GX-2024-0118.\n\nGlobex AR", `${day(-20)}T08:12:00`, 0, null, null);
    ins.run("Processed", "Stark Precision Parts AR", "ar@starkparts.example", AP_MAILBOX, "Invoices SPP-3301 / SPP-3307", "Attached: SPP-3301 and SPP-3307 for gear set batches A and B.\n\nStark AR", `${day(-9)}T11:40:00`, 0, null, null);
    s.emails.forEach((key, i) => {
      const e = EMAILS[key];
      let attName: string | null = null, attPath: string | null = null;
      if (e.attachment) {
        attName = e.attachment.file;
        attPath = `${i + 1}-${e.attachment.file}`;
        fs.copyFileSync(path.join(docsDir, e.attachment.file), path.join(MAIL_ATTACHMENTS, attPath));
      }
      const t = new Date(Date.now() - e.received_days_ago * 86400000 - (s.emails.length - i) * 600000);
      ins.run("Inbox", e.from_name, e.from, e.to, e.subject, e.body, t.toISOString().slice(0, 19), 1, attName, attPath);
    });
  });
}

function seedTreasury(s: Scenario) {
  fs.mkdirSync(TREASURY_DIR, { recursive: true });
  freshDb(TREASURY_DB, (db) => {
    db.exec(`CREATE TABLE payees(payee_id TEXT PRIMARY KEY, name TEXT, bank_name TEXT, account_last4 TEXT, routing TEXT, last_changed TEXT);
      CREATE TABLE payments(confirmation TEXT PRIMARY KEY, payee_id TEXT, invoice_ref TEXT, amount REAL, value_date TEXT, released_by TEXT, released_at TEXT);`);
    const p = db.prepare("INSERT INTO payees VALUES(?, ?, ?, ?, ?, ?)");
    for (const x of treasuryPayees()) {
      const o = s.treasuryPayeeOverrides?.[x.payee_id];
      const y = { ...x, ...o };
      p.run(y.payee_id, y.name, y.bank_name, y.account_last4, y.routing, o ? day(-2) : day(-200));
    }
    const pay = db.prepare("INSERT INTO payments VALUES(?, ?, ?, ?, ?, ?, ?)");
    for (const x of TREASURY_PAYMENTS) pay.run(x.confirmation, x.payee_id, x.invoice_ref, x.amount, x.value_date, x.released_by, `${x.value_date}T10:00:00`);
  });
}

function seedDrive(s: Scenario, docsDir: string) {
  fs.rmSync(DRIVE, { recursive: true, force: true });
  for (const d of ["AP/Scanned Invoices/Processed", "AP/Reports", "AP/Working"]) fs.mkdirSync(path.join(DRIVE, d), { recursive: true });
  for (const key of s.scans) fs.copyFileSync(path.join(docsDir, SCANS[key].file), path.join(DRIVE, "AP/Scanned Invoices", SCANS[key].file));
  fs.writeFileSync(path.join(DRIVE, "AP/README.txt"), "Acme Robotics — Accounts Payable shared folder.\n\nScanned Invoices/   incoming paper invoices (move to Processed/ when entered)\nReports/            AP reports (aging etc.)\nWorking/            scratch space\n");
}

export async function seed(scenarioId = "demo"): Promise<Scenario> {
  const s = SCENARIOS[scenarioId];
  if (!s) throw new Error(`Unknown scenario '${scenarioId}'. Known: ${Object.keys(SCENARIOS).join(", ")}`);
  fs.mkdirSync(DATA, { recursive: true });
  const docsDir = path.join(DATA, "docs");
  fs.mkdirSync(docsDir, { recursive: true });
  const docs = [...s.emails.map((k) => EMAILS[k].attachment).filter(Boolean), ...s.scans.map((k) => SCANS[k])] as InvoiceDoc[];
  if (docs.length) {
    const browser = await chromium.launch();
    for (const d of docs) await renderDoc(browser, d, path.join(docsDir, d.file));
    await browser.close();
  }
  seedLedgerly(s);
  seedMail(s, docsDir);
  seedTreasury(s);
  seedDrive(s, docsDir);
  // Push the Treasury DB into the container (restarts the app). If the container is
  // down, `npm run sandbox` uploads it on start.
  await uploadTreasuryDb().catch(() => false);
  return s;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const id = process.argv[2] ?? "demo";
  seed(id).then((s) => console.log(`Seeded scenario '${s.id}': ${s.title}`)).catch((e) => { console.error(e); process.exit(1); });
}
