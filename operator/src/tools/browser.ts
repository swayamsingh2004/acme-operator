/**
 * Browser tools (Playwright). The model reads pages as compact structured
 * snapshots with element refs ([e12]) instead of pixels — faster, cheaper and
 * more reliable for web apps — and can fall back to a screenshot. Every request
 * goes through the policy guard; credentials are injected by the harness.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { VAULT } from "../../../sandbox/shared/paths.ts";
import { CONFIG } from "../config.ts";
import type { Recorder } from "../evidence/recorder.ts";
import { blockedPage, type Guard } from "../policy/guard.ts";
import { S, type ToolDef, type ToolOutput } from "./types.ts";

const SNAPSHOT_LIMIT = 14000;

/** Runs in the page: assigns data-op-ref to interactive elements and renders a text outline. */
const SNAPSHOT_FN = `(() => {
  let n = 0;
  document.querySelectorAll('[data-op-ref]').forEach(el => el.removeAttribute('data-op-ref'));
  const lines = [];
  const clean = s => (s || '').replace(/\\s+/g, ' ').trim();
  const visible = el => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return st.display !== 'none' && st.visibility !== 'hidden' && (r.width > 0 || r.height > 0); };
  const ref = el => { const id = 'e' + (++n); el.setAttribute('data-op-ref', id); return id; };
  const labelFor = el => {
    if (el.id) { const l = document.querySelector('label[for="' + el.id + '"]'); if (l) return clean(l.textContent); }
    return clean(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '');
  };
  const inline = el => {
    // text of a container with refs for links/buttons inside it
    let out = '';
    el.childNodes.forEach(c => {
      if (c.nodeType === 3) out += c.textContent;
      else if (c.nodeType === 1) {
        if (!visible(c)) return;
        if (c.tagName === 'A' && c.getAttribute('href')) out += ' [' + ref(c) + '] ' + clean(c.textContent) + ' ';
        else if (c.tagName === 'BUTTON') out += ' [' + ref(c) + ' button] ' + clean(c.textContent) + ' ';
        else if (['INPUT','SELECT','TEXTAREA'].includes(c.tagName)) out += ' ' + field(c) + ' ';
        else out += ' ' + inline(c) + ' ';
      }
    });
    return clean(out);
  };
  const field = el => {
    const t = el.tagName;
    if (t === 'SELECT') {
      const opts = [...el.options].slice(0, 40).map(o => (o.selected ? '*' : '') + clean(o.textContent));
      return '[' + ref(el) + ' select "' + labelFor(el) + '"] options: ' + opts.join(' | ');
    }
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'hidden') return '';
    if (type === 'submit' || type === 'button') return '[' + ref(el) + ' button] ' + clean(el.value);
    const val = type === 'password' ? (el.value ? '••••' : '') : el.value;
    return '[' + ref(el) + ' ' + (t === 'TEXTAREA' ? 'textarea' : type + ' input') + ' "' + labelFor(el) + '"] = "' + (val || '').slice(0, 2000) + '"';
  };
  const walk = el => {
    if (!visible(el)) return;
    const t = el.tagName;
    if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(t)) return;
    if (/^H[1-6]$/.test(t)) { lines.push('#'.repeat(+t[1]) + ' ' + inline(el)); return; }
    if (t === 'TABLE') {
      const rows = [...el.querySelectorAll('tr')];
      lines.push('table' + (el.getAttribute('aria-label') ? ' "' + el.getAttribute('aria-label') + '"' : '') + ' (' + rows.length + ' rows):');
      rows.forEach(r => lines.push('| ' + [...r.children].map(c => inline(c)).join(' | ') + ' |'));
      return;
    }
    if (t === 'FORM') {
      lines.push('form ' + (el.getAttribute('method') || 'get').toUpperCase() + ' ' + (el.getAttribute('action') || '') + ':');
      [...el.children].forEach(walk);
      return;
    }
    if (['INPUT','SELECT','TEXTAREA'].includes(t)) { const f = field(el); if (f) lines.push(f); return; }
    if (t === 'BUTTON') { lines.push('[' + ref(el) + ' button] ' + clean(el.textContent)); return; }
    if (t === 'A' && el.getAttribute('href')) { lines.push('[' + ref(el) + '] link ' + clean(el.textContent) + ' -> ' + el.getAttribute('href')); return; }
    if (t === 'LABEL') return; // folded into field labels
    const role = el.getAttribute('role');
    const blockKids = [...el.children].some(c => ['DIV','P','TABLE','FORM','H1','H2','H3','UL','OL','LI','SECTION','HEADER','MAIN','NAV','HR'].includes(c.tagName));
    if (!blockKids) { const s = inline(el); if (s) lines.push((role === 'alert' || role === 'status' ? '! ' : '') + s); return; }
    [...el.children].forEach(walk);
  };
  walk(document.body);
  return { title: document.title, url: location.href, text: lines.filter(Boolean).join('\\n') };
})()`;

export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private lastDownload: string | null = null;
  readonly blockedThisStep: string[] = [];

  constructor(private guard: Guard, private recorder: Recorder, private label: "operator" | "verifier") {}

  async ensure(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    this.browser ??= await chromium.launch({ headless: !CONFIG.headed });
    this.context = await this.browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
    await this.context.route("**/*", async (route) => {
      const req = route.request();
      const d = this.guard.check({ url: req.url(), method: req.method(), body: req.postData() ?? "" });
      if (d.allow) return route.continue();
      this.blockedThisStep.push(`${d.rule}: ${d.reason}`);
      this.recorder.emit({ type: "policy", rule: d.rule, effect: d.effect, detail: `${req.method()} ${req.url()} — ${d.reason}` }, this.label);
      if (req.isNavigationRequest()) return route.fulfill({ status: 403, contentType: "text/html", body: blockedPage(d) });
      return route.abort("blockedbyclient");
    });
    this.page = await this.context.newPage();
    this.page.on("download", async (dl) => {
      const file = path.join(this.recorder.downloadsDir, dl.suggestedFilename());
      await dl.saveAs(file);
      this.lastDownload = `downloads/${dl.suggestedFilename()}`;
    });
    this.page.on("dialog", (d) => d.accept().catch(() => {}));
    return this.page;
  }

  async snapshot(note = ""): Promise<ToolOutput> {
    const page = await this.ensure();
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    const snap = (await page.evaluate(SNAPSHOT_FN)) as { title: string; url: string; text: string };
    let body = snap.text;
    if (body.length > SNAPSHOT_LIMIT) body = body.slice(0, SNAPSHOT_LIMIT) + `\n… (truncated ${body.length - SNAPSHOT_LIMIT} chars; narrow the page with a search/filter)`;
    const blocked = this.blockedThisStep.splice(0);
    const dl = this.lastDownload; this.lastDownload = null;
    const header = [
      note,
      blocked.length ? `POLICY GUARD BLOCKED: ${blocked.join(" | ")}` : "",
      dl ? `Downloaded file saved as ${dl} (read it with read_file).` : "",
      `Page: ${snap.title}\nURL: ${snap.url}`,
    ].filter(Boolean).join("\n");
    return { content: `${header}\n---\n${body}`, summary: `${snap.title} (${snap.url.replace(/^https?:\/\/localhost:\d+/, "")})${blocked.length ? " — BLOCKED by policy" : ""}` };
  }

  async evidenceShot(label: string): Promise<string | undefined> {
    if (!this.page || this.page.isClosed()) return undefined;
    try { return this.recorder.saveImage(await this.page.screenshot(), `${this.label}-${label}`); } catch { return undefined; }
  }

  locator(ref: string) {
    if (!/^e\d+$/.test(ref)) throw new Error(`Invalid ref '${ref}'. Use a ref like e12 from the latest snapshot.`);
    return this.page!.locator(`[data-op-ref="${ref}"]`);
  }

  async afterAction(label: string): Promise<ToolOutput> {
    const page = this.page!;
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(250);
    const out = await this.snapshot();
    out.image = await this.evidenceShot(label);
    return out;
  }

  async close() {
    await this.browser?.close().catch(() => {});
    this.browser = null; this.context = null; this.page = null;
  }

  get currentPage(): Page | null { return this.page; }
}

const wrap = async (fn: () => Promise<ToolOutput>): Promise<ToolOutput> => {
  try { return await fn(); } catch (e: any) {
    const msg = String(e?.message ?? e).split("\n")[0];
    return { content: `Browser action failed: ${msg}\nTake a fresh browser_snapshot — refs change after every page load.`, isError: true, summary: `error: ${msg.slice(0, 80)}` };
  }
};

export const browserTools: ToolDef[] = [
  {
    name: "browser_login",
    description: "Sign in to a company web system (Ledgerly or Acme Mail) with the operator's stored credentials. You never see the password. Use this whenever you land on a login page or a session expired.",
    input_schema: S.obj({ system: S.enum(["ledgerly", "mail"], "System id from the systems registry") }),
    gate: "any", verifier: true,
    run: (input, ctx) => wrap(async () => {
      const sys = (ctx.company.systems.systems as any[]).find((s) => s.id === input.system);
      const cred = VAULT[sys?.credential];
      if (!sys || !cred) throw new Error(`No credentials for system '${input.system}'`);
      const page = await ctx.browser.ensure();
      await page.goto(sys.login_url);
      const pw = page.locator('input[type="password"]').first();
      const user = page.locator('input:not([type="password"]):not([type="hidden"])').first();
      await user.fill(cred.username);
      await pw.fill(cred.password);
      await pw.press("Enter");
      await page.waitForLoadState("domcontentloaded");
      const out = await ctx.browser.afterAction(`login-${input.system}`);
      out.content = `Signed in to ${sys.name} as ${cred.username}.\n` + out.content;
      out.summary = `signed in to ${sys.name}`;
      return out;
    }),
  },
  {
    name: "browser_navigate",
    description: "Open a URL in the operator's browser and return a structured snapshot of the page. Only registered company systems are reachable. Search/filter pages accept query strings (e.g. Ledgerly /invoices?q=1042&status=Paid).",
    input_schema: S.obj({ url: S.str("Absolute URL, e.g. http://localhost:4101/invoices?q=Globex") }),
    gate: "any", verifier: true,
    run: (input, ctx) => wrap(async () => {
      const page = await ctx.browser.ensure();
      await page.goto(input.url, { waitUntil: "domcontentloaded" }).catch((e) => { if (!/ERR_BLOCKED_BY_CLIENT|aborted/i.test(String(e))) throw e; });
      return ctx.browser.snapshot();
    }),
  },
  {
    name: "browser_snapshot",
    description: "Return a structured text snapshot of the current page: headings, text, tables, form fields with current values, and clickable elements labelled with refs like [e12]. Refs are only valid until the next page change.",
    input_schema: S.obj({}),
    gate: "any", verifier: true,
    run: (_input, ctx) => wrap(() => ctx.browser.snapshot()),
  },
  {
    name: "browser_click",
    description: "Click a link or button by its ref from the latest snapshot. Returns the snapshot of the resulting page (and notes any file download or policy block).",
    input_schema: S.obj({ ref: S.str("Element ref, e.g. e12") }),
    gate: "any", verifier: true,
    run: (input, ctx) => wrap(async () => {
      const el = ctx.browser.locator(input.ref);
      const label = (await el.textContent({ timeout: 3000 }).catch(() => ""))?.trim().slice(0, 30) || input.ref;
      await el.click({ timeout: 8000 });
      const out = await ctx.browser.afterAction(`click-${label}`);
      out.summary = `clicked "${label}" → ${out.summary}`;
      return out;
    }),
  },
  {
    name: "browser_fill",
    description: "Fill one or more form fields (text inputs, textareas, date inputs as YYYY-MM-DD, selects by visible option text) by ref, then optionally click a submit button. Returns the resulting page snapshot.",
    input_schema: S.obj({
      fields: S.arr(S.obj({ ref: S.str("Field ref, e.g. e7"), value: S.str("Value to enter (for selects: the option text or value)") })),
      submit_ref: S.str("Optional ref of the button to click after filling; omit to just fill"),
    }, ["fields"]),
    gate: "any", verifier: false,
    run: (input, ctx) => wrap(async () => {
      for (const f of input.fields as { ref: string; value: string }[]) {
        const el = ctx.browser.locator(f.ref);
        const tag = await el.evaluate((n) => n.tagName);
        if (tag === "SELECT") {
          const options = await el.evaluate((n: any) => [...n.options].map((o: any) => ({ v: o.value, t: o.textContent.trim() })));
          const want = f.value.trim().toLowerCase();
          const hit = options.find((o) => o.v.toLowerCase() === want || o.t.toLowerCase() === want) ?? options.find((o) => o.t.toLowerCase().includes(want) || (o.v && want.includes(o.v.toLowerCase())));
          if (!hit) throw new Error(`No option matching '${f.value}' in select ${f.ref}. Options: ${options.map((o) => o.t).join(" | ")}`);
          await el.selectOption(hit.v);
        } else {
          await el.fill(f.value);
        }
      }
      if (input.submit_ref) {
        await ctx.browser.locator(input.submit_ref).click({ timeout: 8000 });
        const out = await ctx.browser.afterAction("submit");
        out.summary = `filled ${input.fields.length} field(s) + submit → ${out.summary}`;
        return out;
      }
      const out = await ctx.browser.snapshot();
      out.summary = `filled ${input.fields.length} field(s)`;
      return out;
    }),
  },
  {
    name: "browser_screenshot",
    description: "Take a screenshot of the current browser page (visual fallback when the snapshot is not enough, or as evidence).",
    input_schema: S.obj({}),
    gate: "any", verifier: true,
    run: (_input, ctx) => wrap(async () => {
      const page = await ctx.browser.ensure();
      const png = await page.screenshot();
      const image = ctx.recorder.saveImage(png, `${ctx.actor}-browser`);
      return { content: [{ type: "image", data: png.toString("base64"), mime_type: "image/png" }], summary: "browser screenshot", image };
    }),
  },
  {
    name: "browser_back",
    description: "Go back to the previous page in the browser history.",
    input_schema: S.obj({}),
    gate: "any", verifier: true,
    run: (_input, ctx) => wrap(async () => {
      const page = await ctx.browser.ensure();
      await page.goBack({ waitUntil: "domcontentloaded" });
      return ctx.browser.snapshot();
    }),
  },
];

export function ensureDir(p: string) { fs.mkdirSync(p, { recursive: true }); }
