import "dotenv/config";
import path from "node:path";
import { ROOT } from "../../sandbox/shared/paths.ts";

export const PATHS = {
  root: ROOT,
  company: path.join(ROOT, "company"),
  handbook: path.join(ROOT, "company", "handbook"),
  memory: path.join(ROOT, "company", "memory", "notes.md"),
  runs: path.join(ROOT, "runs"),
  consoleDist: path.join(ROOT, "console", "dist"),
};

const env = (k: string, d: string) => (process.env[k] ?? "").trim() || d;
export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

export const CONFIG = {
  operatorModel: env("OPERATOR_MODEL", "gemini-3.5-flash-lite"),
  verifierModel: env("VERIFIER_MODEL", "gemini-3.5-flash-lite"),
  /** Used when the primary model is overloaded (503/timeout). Empty = no fallback. */
  fallbackModel: (process.env.FALLBACK_MODEL ?? "gemini-3-flash-preview").trim(),
  /** How long to wait on the primary model before treating it as overloaded. */
  primaryTimeoutMs: Number(env("PRIMARY_TIMEOUT_MS", "150000")),
  /** Upper bound for any single request (a hung model is treated as overloaded and retried). */
  requestTimeoutMs: Number(env("REQUEST_TIMEOUT_MS", "240000")),
  /** Minimum gap between API requests (free-tier rate limits). */
  minRequestIntervalMs: Number(env("MIN_REQUEST_INTERVAL_MS", "4000")),
  operatorThinking: env("OPERATOR_THINKING", "high") as ThinkingLevel,
  verifierThinking: env("VERIFIER_THINKING", "medium") as ThinkingLevel,
  maxTurns: Number(env("OPERATOR_MAX_TURNS", "150")),
  maxCostUsd: Number(env("OPERATOR_MAX_COST_USD", "10")),
  maxVerificationRounds: 2,
  headed: env("OPERATOR_HEADED", "false") === "true",
  port: Number(env("CONSOLE_PORT", "4100")),
};

export const hasApiKey = () => Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);

/** USD per million tokens at paid-tier list prices (3.8 Flash promotional rate through 2026-12-31). On the free tier these are list-price equivalents, not charges. */
const PRICING: Record<string, { input: number; output: number; cached: number }> = {
  "gemini-3.8-flash": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cached: 0.03 },
  "gemini-3-flash-preview": { input: 0.5, output: 3.0, cached: 0.05 },
};

export interface Usage { input: number; output: number; cached: number; thought: number; costUsd: number }
export const emptyUsage = (): Usage => ({ input: 0, output: 0, cached: 0, thought: 0, costUsd: 0 });

/** Accumulate one interaction's usage. Thinking tokens are billed as output. */
export function addUsage(total: Usage, model: string, u: { total_input_tokens?: number; total_cached_tokens?: number; total_output_tokens?: number; total_thought_tokens?: number; total_tool_use_tokens?: number } | undefined) {
  if (!u) return;
  const p = PRICING[model] ?? PRICING["gemini-3.8-flash"];
  const input = (u.total_input_tokens ?? 0) + (u.total_tool_use_tokens ?? 0);
  const cached = Math.min(u.total_cached_tokens ?? 0, input);
  const output = u.total_output_tokens ?? 0;
  const thought = u.total_thought_tokens ?? 0;
  total.input += input; total.cached += cached; total.output += output; total.thought += thought;
  total.costUsd += ((input - cached) * p.input + cached * p.cached + (output + thought) * p.output) / 1e6;
}
