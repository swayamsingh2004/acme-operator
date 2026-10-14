/**
 * Policy guard: enforces company/permissions.yaml in code. Every request the
 * operator's browser makes passes through here before it reaches a company
 * system, so the model cannot talk its way past a rule.
 *
 *   - origin allow-list (the browser can only reach registered systems)
 *   - read-only mode (before the task brief exists, and always for the verifier)
 *   - forbid rules (e.g. vendor bank changes)
 *   - require_approval rules with single-use grants issued when a human approves
 */
import type { Permissions } from "../context/company.ts";

export type GuardDecision =
  | { allow: true }
  | { allow: false; rule: string; effect: "forbid" | "require_approval" | "read_only" | "origin"; reason: string };

export interface GuardedRequest { url: string; method: string; body: string }

export class Guard {
  /** read-only: no state-changing requests to company systems (login is allowed). */
  readOnly: boolean;
  private grants: { rule: string; match?: string }[] = [];
  readonly blocked: { rule: string; effect: string; reason: string; url: string; method: string }[] = [];

  constructor(private perms: Permissions, opts: { readOnly: boolean }) {
    this.readOnly = opts.readOnly;
  }

  /** Grant one pass for a require_approval rule (optionally only for a matching detail, e.g. a recipient). */
  grant(rule: string, match?: string) {
    this.grants.push({ rule, match: match?.toLowerCase() });
  }

  check(req: GuardedRequest): GuardDecision {
    let u: URL;
    try { u = new URL(req.url); } catch { return { allow: true }; }
    if (!/^https?:$/.test(u.protocol)) return { allow: true }; // data:, about:, blob:
    const origin = u.origin;
    if (!this.perms.browser.allowed_origins.includes(origin))
      return { allow: false, rule: "origin-allowlist", effect: "origin", reason: `${origin} is not a registered company system. The operator browser may only reach: ${this.perms.browser.allowed_origins.join(", ")}.` };

    const method = req.method.toUpperCase();
    if (method === "GET" || method === "HEAD") return { allow: true };
    if (/^\/login\/?$/.test(u.pathname)) return { allow: true };

    if (this.readOnly)
      return { allow: false, rule: "read-only-phase", effect: "read_only", reason: "This session is read-only. (Operator: submit your task brief and plan before changing anything. Verifier: you may only observe.)" };

    for (const r of this.perms.browser.rules) {
      if (r.origin && r.origin !== origin) continue;
      if (r.method && r.method.toUpperCase() !== method) continue;
      if (!new RegExp(r.path).test(u.pathname)) continue;
      if (r.effect === "forbid") return { allow: false, rule: r.id, effect: "forbid", reason: r.reason };
      if (r.effect === "require_approval") {
        const outside = this.recipientsOutside(r.recipient_domains_allowed, req.body);
        if (r.recipient_domains_allowed && outside.length === 0) continue; // all recipients allowed
        const gi = this.grants.findIndex((g) => g.rule === r.id && (!g.match || outside.every((a) => a.includes(g.match!))));
        if (gi >= 0) { this.grants.splice(gi, 1); continue; }
        return { allow: false, rule: r.id, effect: "require_approval", reason: `${r.reason}${outside.length ? ` Recipients outside the allow-list: ${outside.join(", ")}.` : ""} Request approval (kind 'policy_override', rule_id '${r.id}') and retry only if approved.` };
      }
    }
    return { allow: true };
  }

  private recipientsOutside(allowed: string[] | undefined, body: string): string[] {
    if (!allowed) return [];
    const params = new URLSearchParams(body);
    const addrs = `${params.get("to") ?? ""},${params.get("cc") ?? ""}`.split(/[,;\s]+/).map((a) => a.trim().toLowerCase()).filter(Boolean);
    return addrs.filter((a) => !allowed.some((d) => a.endsWith(`@${d}`)));
  }
}

export function blockedPage(d: Exclude<GuardDecision, { allow: true }>): string {
  return `<!doctype html><html><head><title>Blocked by Acme Operator policy</title></head><body style="font-family:sans-serif;padding:40px;max-width:760px">
  <h1 role="alert">Blocked by Acme Operator policy</h1>
  <p><strong>Rule:</strong> ${d.rule} (${d.effect})</p><p>${d.reason.replace(/</g, "&lt;")}</p>
  <p>Nothing was sent to the company system. Use the browser back button or navigate elsewhere.</p></body></html>`;
}
