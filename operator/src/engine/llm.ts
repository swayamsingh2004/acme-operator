/**
 * The one place that talks to Gemini — via the Interactions API.
 *
 *  - Stateful: each turn sends only the *new* input steps (tool results, harness
 *    notes) plus previous_interaction_id; Google keeps the history, thought
 *    signatures and implicit cache server-side. We still log every step locally.
 *  - Thinking: thinking_level per role, with thought summaries for the console.
 *  - Model fallback: if the primary model is overloaded (503 / timeout), the run
 *    switches to the fallback model, and a circuit breaker keeps new loops off
 *    the primary for a while so they don't each wait on it.
 *  - Free-tier friendly: a minimum interval between requests and patient
 *    backoff on 429s. Cancellation via AbortSignal.
 */
import { ApiError, GoogleGenAI } from "@google/genai";
import { CONFIG, type ThinkingLevel } from "../config.ts";

let _client: GoogleGenAI | null = null;
const client = () => (_client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY }));

/** Minimal local view of the Interactions step union (the SDK's step types are not all exported). */
export type Step =
  | { type: "thought"; signature?: string; summary?: Array<{ type: string; text?: string }> }
  | { type: "model_output"; content?: Array<{ type: string; text?: string }>; error?: { message?: string } }
  | { type: "function_call"; id: string; name: string; arguments: Record<string, any> }
  | { type: string; [k: string]: any };

export type InputStep =
  | { type: "function_result"; call_id: string; name?: string; is_error?: boolean; result: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mime_type: string }> }
  | { type: "user_input"; content: Array<{ type: "text"; text: string }> };

/** Which model a loop is using; mutated when it falls back. */
export interface ModelRoute { primary: string; fallback?: string; current: string; switchedAt?: string }

const breaker = { primaryDownUntil: new Map<string, number>() };
const BREAKER_MS = 10 * 60 * 1000;

export function newRoute(primary: string, fallback = CONFIG.fallbackModel): ModelRoute {
  const fb = fallback && fallback !== primary ? fallback : undefined;
  const down = (breaker.primaryDownUntil.get(primary) ?? 0) > Date.now();
  return { primary, fallback: fb, current: fb && down ? fb : primary, ...(fb && down ? { switchedAt: new Date().toISOString() } : {}) };
}

export interface CallParams {
  route: ModelRoute;
  thinking: ThinkingLevel;
  system: string;
  tools: any[];
  input: string | InputStep[];
  previousId?: string;
  signal?: AbortSignal;
  onNotice?: (msg: string) => void;
}

export interface CallResult { id: string; status: string; steps: Step[]; usage: any; model: string }

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);
let lastRequestAt = 0;

async function pace() {
  const wait = lastRequestAt + CONFIG.minRequestIntervalMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

export async function callModel(p: CallParams): Promise<CallResult> {
  let safetyBlocks = 0;
  for (let attempt = 1; ; attempt++) {
    const model = p.route.current;
    const onPrimary = model === p.route.primary;
    await pace();
    try {
      const res: any = await client().interactions.create(
        {
          model,
          system_instruction: p.system,
          tools: p.tools,
          input: p.input as any,
          ...(p.previousId ? { previous_interaction_id: p.previousId } : {}),
          store: true,
          generation_config: { thinking_level: p.thinking, thinking_summaries: "auto" },
        } as any,
        { timeout: onPrimary && p.route.fallback ? CONFIG.primaryTimeoutMs : CONFIG.requestTimeoutMs, maxRetries: 0, fetchOptions: { signal: p.signal } } as any,
      );
      return { id: res.id, status: res.status, steps: (res.steps ?? []) as Step[], usage: res.usage, model };
    } catch (err: any) {
      if (p.signal?.aborted) throw err;
      const status = err instanceof ApiError ? err.status : Number(err?.status ?? 0);
      const msg = String(err?.message ?? err);
      const timedOut = !status && /timed? ?out|timeout|aborted/i.test(msg);
      const network = !status && /fetch failed|ECONNRESET|ETIMEDOUT|socket|network/i.test(msg);
      const overloaded = status === 503 || status === 504 || timedOut || /high demand|overloaded/i.test(msg);

      // Gemini's input safety classifier occasionally flags benign business content
      // (seen on plain invoice emails). The failed request creates no interaction, so
      // retrying keeps the chain intact: retry twice, then try the other model once.
      if (status === 400 && /safety/i.test(msg)) {
        safetyBlocks++;
        const other = onPrimary ? p.route.fallback : (breaker.primaryDownUntil.get(p.route.primary) ?? 0) > Date.now() ? undefined : p.route.primary;
        if (safetyBlocks <= 2) { p.onNotice?.(`Gemini safety filter blocked the request on ${model} (likely a false positive) — retrying (${safetyBlocks}/2).`); await new Promise((r) => setTimeout(r, 3000)); continue; }
        if (safetyBlocks === 3 && other) { p.onNotice?.(`Safety filter keeps blocking on ${model}; trying ${other} for this turn.`); p.route.current = other; continue; }
        throw new Error(`Gemini's safety filter repeatedly blocked this turn (${msg}). The run stops here; see the event log for the last content sent.`);
      }
      // Daily quota exhausted (free tier: e.g. "limit: 20 requests per day"): retrying is
      // pointless until it resets. Switch to the fallback now, or stop with a clear message.
      if (status === 429 && /per day|daily/i.test(msg)) {
        const reset = msg.match(/retry in ([0-9hms]+)/i)?.[1];
        breaker.primaryDownUntil.set(model, Date.now() + 6 * 3600 * 1000);
        if (onPrimary && p.route.fallback && (breaker.primaryDownUntil.get(p.route.fallback) ?? 0) < Date.now()) {
          p.route.current = p.route.fallback;
          p.route.switchedAt = new Date().toISOString();
          p.onNotice?.(`Daily free-tier quota for ${model} is used up${reset ? ` (resets in ${reset})` : ""}; switching this run to ${p.route.fallback}.`);
          continue;
        }
        throw new Error(`Daily API quota exhausted for ${model}${reset ? ` (resets in ${reset})` : ""}. Wait for the reset, use a different model (OPERATOR_MODEL in .env), or enable billing for the Gemini project.`);
      }
      if (overloaded && onPrimary && p.route.fallback) {
        breaker.primaryDownUntil.set(p.route.primary, Date.now() + BREAKER_MS);
        p.route.current = p.route.fallback;
        p.route.switchedAt = new Date().toISOString();
        p.onNotice?.(`${p.route.primary} is overloaded (${status || "timeout"}); switching this run to ${p.route.fallback}.`);
        continue;
      }
      if (!(RETRYABLE.has(status) || network || timedOut) || attempt >= 8) throw err;
      const wait = status === 429 ? Math.min(90000, 15000 * attempt) : Math.min(60000, 2000 * 2 ** (attempt - 1));
      p.onNotice?.(`Gemini API ${status || "network/timeout"} on ${model}${status === 429 ? " (rate limit — free tier)" : ""} — retrying in ${Math.round(wait / 1000)}s (attempt ${attempt}/7)`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
