/** Move the Treasury database in/out of the container through the driver API (no bind mounts). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TREASURY_DB, URLS } from "./paths.ts";

export async function treasuryUp(timeoutMs = 3000): Promise<boolean> {
  try {
    const r = await fetch(`${URLS.treasuryDriver}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch { return false; }
}

export async function waitForTreasury(totalMs = 60000): Promise<boolean> {
  const end = Date.now() + totalMs;
  while (Date.now() < end) {
    if (await treasuryUp(2000)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** True if the running container already holds a database (live state we must not overwrite). */
export async function treasuryHasDb(): Promise<boolean> {
  try { return (await fetch(`${URLS.treasuryDriver}/db`, { method: "GET", signal: AbortSignal.timeout(5000) })).ok; } catch { return false; }
}

/** Upload the locally seeded DB into the running container (restarts the app). Only seeding should call this unconditionally. */
export async function uploadTreasuryDb(opts: { onlyIfEmpty?: boolean } = {}): Promise<boolean> {
  if (!fs.existsSync(TREASURY_DB) || !(await treasuryUp())) return false;
  if (opts.onlyIfEmpty && (await treasuryHasDb())) return false;
  const r = await fetch(`${URLS.treasuryDriver}/db`, { method: "PUT", body: fs.readFileSync(TREASURY_DB), signal: AbortSignal.timeout(15000) });
  return r.ok;
}

/** Download the live Treasury DB and open it read-only (for evals / ground truth). */
export async function readTreasuryDb(): Promise<DatabaseSync> {
  const r = await fetch(`${URLS.treasuryDriver}/db`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Treasury DB unavailable (${r.status})`);
  const file = path.join(os.tmpdir(), `treasury-${process.pid}-${Date.now()}.db`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return new DatabaseSync(file, { readOnly: true });
}
