/**
 * File tools over two roots:
 *   drive/...      the company shared drive (permissions.yaml decides read/write/move)
 *   downloads/...  files this run downloaded from company systems (read-only)
 * PDFs are text-extracted, images are returned as images (for scanned paper),
 * spreadsheets are rendered as CSV.
 */
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { extractText, getDocumentProxy } from "unpdf";
import { DRIVE } from "../../../sandbox/shared/paths.ts";
import { S, type ToolContext, type ToolDef, type ToolOutput } from "./types.ts";

function globToRe(glob: string): RegExp {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${re}$`);
}
const allowed = (rel: string, globs: string[]) => globs.some((g) => globToRe(g).test(rel));

function resolve(p: string, ctx: ToolContext): { abs: string; root: "drive" | "downloads"; rel: string } {
  const clean = String(p).trim().replace(/^\/+/, "").replace(/\\/g, "/");
  const [head, ...rest] = clean.split("/");
  const rel = path.posix.normalize(rest.join("/") || ".");
  if (rel.startsWith("..")) throw new Error("Path escapes its root.");
  if (head === "drive") return { abs: path.join(DRIVE, rel), root: "drive", rel: rel === "." ? "" : rel };
  if (head === "downloads") return { abs: path.join(ctx.recorder.downloadsDir, rel), root: "downloads", rel: rel === "." ? "" : rel };
  throw new Error(`Paths must start with 'drive/' (shared drive) or 'downloads/' (files downloaded in this run). Got '${p}'.`);
}

const fail = (msg: string): ToolOutput => ({ content: msg, isError: true, summary: msg.slice(0, 90) });

export const fileTools: ToolDef[] = [
  {
    name: "list_files",
    description: "List a folder on the shared drive ('drive/AP/Scanned Invoices') or this run's downloads ('downloads').",
    input_schema: S.obj({ path: S.str("Folder path starting with drive/ or downloads") }),
    gate: "any", verifier: true,
    async run(input, ctx) {
      try {
        const { abs } = resolve(input.path, ctx);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return fail(`Not a folder: ${input.path}`);
        const items = fs.readdirSync(abs, { withFileTypes: true }).filter((d) => !d.name.startsWith("."))
          .map((d) => d.isDirectory() ? `${d.name}/` : `${d.name}  (${fs.statSync(path.join(abs, d.name)).size} bytes, modified ${fs.statSync(path.join(abs, d.name)).mtime.toISOString().slice(0, 16)})`);
        return { content: items.length ? items.join("\n") : "(empty folder)", summary: `${input.path}: ${items.length} item(s)` };
      } catch (e: any) { return fail(e.message); }
    },
  },
  {
    name: "read_file",
    description: "Read a file: PDFs return extracted text, images (scans) return the image, .xlsx returns each sheet as CSV, text files return text.",
    input_schema: S.obj({ path: S.str("File path starting with drive/ or downloads/") }),
    gate: "any", verifier: true,
    async run(input, ctx) {
      try {
        const { abs } = resolve(input.path, ctx);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return fail(`File not found: ${input.path}`);
        const ext = path.extname(abs).toLowerCase();
        const buf = fs.readFileSync(abs);
        if (ext === ".pdf") {
          const pdf = await getDocumentProxy(new Uint8Array(buf));
          const { totalPages, text } = await extractText(pdf, { mergePages: true });
          return { content: `PDF ${path.basename(abs)} (${totalPages} page(s)) — extracted text:\n\n${String(text).trim()}`, summary: `read PDF ${path.basename(abs)}` };
        }
        if ([".png", ".jpg", ".jpeg"].includes(ext)) {
          const image = ctx.recorder.saveImage(buf, `file-${path.basename(abs)}`);
          return {
            content: [
              { type: "text", text: `Image file ${path.basename(abs)} (a scanned document — read it carefully):` },
              { type: "image", data: buf.toString("base64"), mime_type: ext === ".png" ? "image/png" : "image/jpeg" },
            ],
            summary: `read image ${path.basename(abs)}`, image,
          };
        }
        if (ext === ".xlsx") {
          const wb = new ExcelJS.Workbook();
          await wb.xlsx.load(buf as any);
          const out: string[] = [];
          wb.eachSheet((ws) => {
            out.push(`## Sheet: ${ws.name}`);
            ws.eachRow((row) => out.push((row.values as any[]).slice(1).map((v) => (v && typeof v === "object" && "result" in v ? v.result : v) ?? "").join(",")));
          });
          return { content: out.join("\n"), summary: `read workbook ${path.basename(abs)}` };
        }
        return { content: buf.toString("utf8").slice(0, 30000), summary: `read ${path.basename(abs)}` };
      } catch (e: any) { return fail(e.message); }
    },
  },
  {
    name: "write_file",
    description: "Write a text file to the shared drive (only folders the operator may write to, e.g. drive/AP/Reports/ or drive/AP/Working/).",
    input_schema: S.obj({ path: S.str("Destination starting with drive/"), content: S.str("File contents") }),
    gate: "after_plan",
    async run(input, ctx) {
      try {
        const r = resolve(input.path, ctx);
        if (r.root !== "drive" || !allowed(r.rel, ctx.company.permissions.files.write)) return fail(`Permission denied: the operator may only write to ${ctx.company.permissions.files.write.join(", ")} on the drive.`);
        fs.mkdirSync(path.dirname(r.abs), { recursive: true });
        fs.writeFileSync(r.abs, input.content);
        return { content: `Wrote ${input.path} (${Buffer.byteLength(input.content)} bytes).`, summary: `wrote ${input.path}` };
      } catch (e: any) { return fail(e.message); }
    },
  },
  {
    name: "write_spreadsheet",
    description: "Create an .xlsx workbook on the shared drive. Numbers stay numeric. Each sheet has column headers and rows; bold header row, optional bold last row (totals).",
    input_schema: S.obj({
      path: S.str("Destination .xlsx path starting with drive/"),
      sheets: S.arr(S.obj({
        name: S.str("Sheet name"),
        columns: S.arr(S.str("Column header")),
        rows: S.arr(S.arr({ anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }] }), "Rows of cell values, in column order"),
        bold_last_row: S.bool("Bold the last row (e.g. a TOTAL row)"),
      })),
    }),
    gate: "after_plan",
    async run(input, ctx) {
      try {
        const r = resolve(input.path, ctx);
        if (r.root !== "drive" || !allowed(r.rel, ctx.company.permissions.files.write)) return fail(`Permission denied: the operator may only write to ${ctx.company.permissions.files.write.join(", ")} on the drive.`);
        if (!r.abs.endsWith(".xlsx")) return fail("Path must end with .xlsx");
        const wb = new ExcelJS.Workbook();
        wb.creator = "Acme Operator";
        for (const sh of input.sheets) {
          const ws = wb.addWorksheet(String(sh.name).slice(0, 31));
          ws.addRow(sh.columns).font = { bold: true };
          for (const row of sh.rows) ws.addRow(row);
          if (sh.bold_last_row && sh.rows.length) ws.lastRow!.font = { bold: true };
          ws.columns.forEach((c, i) => {
            c.width = Math.min(40, Math.max(10, String(sh.columns[i] ?? "").length + 2, ...sh.rows.map((rw: any[]) => String(rw[i] ?? "").length + 2)));
            if (sh.rows.some((rw: any[]) => typeof rw[i] === "number")) c.numFmt = "#,##0.00";
          });
        }
        fs.mkdirSync(path.dirname(r.abs), { recursive: true });
        await wb.xlsx.writeFile(r.abs);
        return { content: `Wrote ${input.path} with sheet(s): ${input.sheets.map((s: any) => `${s.name} (${s.rows.length} rows)`).join(", ")}.`, summary: `wrote ${input.path}` };
      } catch (e: any) { return fail(e.message); }
    },
  },
  {
    name: "move_file",
    description: "Move a file on the shared drive, e.g. a processed scan into 'drive/AP/Scanned Invoices/Processed/'.",
    input_schema: S.obj({ from: S.str("Source path starting with drive/"), to: S.str("Destination path (file or folder) starting with drive/") }),
    gate: "after_plan",
    async run(input, ctx) {
      try {
        const a = resolve(input.from, ctx), b = resolve(input.to, ctx);
        if (a.root !== "drive" || b.root !== "drive") return fail("Both paths must be on the drive.");
        if (!fs.existsSync(a.abs)) return fail(`File not found: ${input.from}`);
        let dest = b, destAbs = b.abs;
        if (fs.existsSync(b.abs) && fs.statSync(b.abs).isDirectory()) { destAbs = path.join(b.abs, path.basename(a.abs)); dest = { ...b, rel: path.posix.join(b.rel, path.basename(a.abs)) }; }
        const p = ctx.company.permissions.files;
        if (!allowed(a.rel, p.move_from) || !allowed(dest.rel, p.write)) return fail(`Permission denied: may move from ${p.move_from.join(", ")} into ${p.write.join(", ")}.`);
        fs.mkdirSync(path.dirname(destAbs), { recursive: true });
        fs.renameSync(a.abs, destAbs);
        return { content: `Moved ${input.from} → drive/${dest.rel}`, summary: `moved ${path.basename(a.abs)} → ${path.posix.dirname(dest.rel)}` };
      } catch (e: any) { return fail(e.message); }
    },
  },
];
