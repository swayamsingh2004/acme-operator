/** Ground truth for evals: read the systems of record directly (never through the operator). */
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { DRIVE, SANDBOX_TOKEN, URLS } from "../../sandbox/shared/paths.ts";
import { readTreasuryDb } from "../../sandbox/shared/treasury.ts";

export interface Truth {
  invoices: any[];
  vendors: any[];
  audit: any[];
  mail: any[];
  payees: any[];
  payments: any[];
  drive: (rel: string) => boolean;
  driveFiles: (dir: string) => string[];
  xlsx: (rel: string) => Promise<ExcelJS.Workbook | null>;
}

export async function readTruth(): Promise<Truth> {
  const h = { "x-sandbox-token": SANDBOX_TOKEN };
  const l = (await (await fetch(`${URLS.ledgerly}/api/state`, { headers: h })).json()) as any;
  const m = (await (await fetch(`${URLS.mail}/api/state`, { headers: h })).json()) as any;
  let payees: any[] = [], payments: any[] = [];
  try {
    const db = await readTreasuryDb();
    payees = db.prepare("SELECT * FROM payees").all() as any[];
    payments = db.prepare("SELECT * FROM payments").all() as any[];
    db.close();
  } catch { /* treasury down: payment checks will fail visibly */ }
  return {
    invoices: l.invoices, vendors: l.vendors, audit: l.audit, mail: m.messages, payees, payments,
    drive: (rel) => fs.existsSync(path.join(DRIVE, rel)),
    driveFiles: (dir) => (fs.existsSync(path.join(DRIVE, dir)) ? fs.readdirSync(path.join(DRIVE, dir)) : []),
    xlsx: async (rel) => {
      const f = path.join(DRIVE, rel);
      if (!fs.existsSync(f)) return null;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(f);
      return wb;
    },
  };
}

export const inv = (t: Truth, number: string, vendor?: string) => t.invoices.find((i) => i.number === number && (!vendor || i.vendor_id === vendor));
export const sent = (t: Truth) => t.mail.filter((x) => x.folder === "Sent");
export const sentTo = (t: Truth, addr: string) => sent(t).filter((x) => `${x.to_addr},${x.cc ?? ""}`.toLowerCase().includes(addr.toLowerCase()));
export const mailBySubject = (t: Truth, s: string) => t.mail.find((x) => x.folder !== "Sent" && x.subject.includes(s));
export const textOf = (x: any) => `${x.subject}\n${x.body}`;

/** AP aging buckets per AP-05, computed from Ledgerly state. */
export function agingBuckets(t: Truth) {
  const today = new Date(new Date().toISOString().slice(0, 10));
  const open = t.invoices.filter((i) => !["Paid", "Void"].includes(i.status));
  const b = { Current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0, Total: 0 };
  for (const i of open) {
    const days = Math.round((today.getTime() - new Date(i.due_date).getTime()) / 86400000);
    const k = days <= 0 ? "Current" : days <= 30 ? "1-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+";
    b[k] += i.amount; b.Total += i.amount;
  }
  return { buckets: b, openCount: open.length };
}
