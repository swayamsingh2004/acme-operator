/** Tiny server-side HTML helpers shared by the sandbox web apps. */

export function h(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function money(n: number): string {
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export interface Brand {
  name: string;
  accent: string;
  logo: string;
}

export function layout(opts: {
  brand: Brand;
  title: string;
  nav?: { href: string; label: string; active?: boolean }[];
  user?: string;
  flash?: { kind: "ok" | "error" | "info"; text: string } | null;
  body: string;
}): string {
  const { brand } = opts;
  const nav = (opts.nav ?? [])
    .map((n) => `<a href="${n.href}" class="${n.active ? "active" : ""}">${h(n.label)}</a>`)
    .join("");
  const flash = opts.flash ? `<div class="flash ${opts.flash.kind}" role="status">${h(opts.flash.text)}</div>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(opts.title)} · ${h(brand.name)}</title>
<style>
:root{--accent:${brand.accent};--bg:#f6f7f9;--card:#fff;--ink:#1d2330;--muted:#667085;--line:#e4e7ec}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--ink)}
header{background:#fff;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:24px;padding:0 24px;height:56px}
header .logo{font-weight:700;font-size:17px;color:var(--accent);display:flex;gap:8px;align-items:center;text-decoration:none}
header nav{display:flex;gap:4px}header nav a{color:var(--muted);text-decoration:none;padding:8px 12px;border-radius:6px}
header nav a.active,header nav a:hover{background:#f2f4f7;color:var(--ink)}
header .user{margin-left:auto;color:var(--muted);display:flex;gap:12px;align-items:center}
main{max-width:1180px;margin:24px auto;padding:0 24px}
h1{font-size:22px;margin:0 0 16px}h2{font-size:16px;margin:24px 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{background:#fafbfc;color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
a{color:var(--accent)}
.btn,button{display:inline-block;background:var(--accent);color:#fff;border:0;border-radius:6px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
.btn.secondary,button.secondary{background:#fff;color:var(--ink);border:1px solid var(--line)}
button.danger{background:#b42318}
form.inline{display:inline}
label{display:block;font-weight:600;margin:10px 0 4px}
input,select,textarea{font:inherit;padding:8px 10px;border:1px solid #d0d5dd;border-radius:6px;width:100%;max-width:420px;background:#fff}
textarea{max-width:720px;min-height:140px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.kv{display:grid;grid-template-columns:180px 1fr;gap:6px 16px}.kv div:nth-child(odd){color:var(--muted)}
.flash{padding:10px 14px;border-radius:8px;margin-bottom:16px;font-weight:500}.flash.ok{background:#ecfdf3;color:#067647}.flash.error{background:#fef3f2;color:#b42318}.flash.info{background:#eff8ff;color:#175cd3}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;background:#f2f4f7;color:#344054}
.badge.Approved{background:#ecfdf3;color:#067647}.badge.Paid{background:#eef4ff;color:#3538cd}.badge.On.hold,.badge.hold{background:#fef3f2;color:#b42318}.badge.Pending{background:#fffaeb;color:#b54708}.badge.Entered{background:#f2f4f7}
.muted{color:var(--muted)}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.stat{font-size:26px;font-weight:700}
</style></head>
<body>
<header><a class="logo" href="/">${brand.logo} ${h(brand.name)}</a><nav aria-label="Main">${nav}</nav>
${opts.user ? `<div class="user"><span>Signed in as <strong>${h(opts.user)}</strong></span><a href="/logout">Sign out</a></div>` : ""}</header>
<main>${flash}${opts.body}</main>
</body></html>`;
}

export function statusBadge(status: string): string {
  const cls = status === "On hold" ? "hold" : status.split(" ")[0];
  return `<span class="badge ${h(cls)}">${h(status)}</span>`;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Parse a user-entered money amount. Accepts "2640", "2,640.00", "$2,640.00". */
export function parseAmount(raw: string): number | null {
  const s = String(raw ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100) / 100;
}
