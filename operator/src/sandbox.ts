/** Make sure the sandbox company is reachable (start web apps in-process / Treasury container if needed). */
import { execSync } from "node:child_process";
import { ROOT, URLS } from "../../sandbox/shared/paths.ts";
import { treasuryUp, uploadTreasuryDb, waitForTreasury } from "../../sandbox/shared/treasury.ts";
import { seed } from "../../sandbox/scripts/seed.ts";

async function up(url: string) {
  try { await fetch(url, { signal: AbortSignal.timeout(1500), redirect: "manual" }); return true; } catch { return false; }
}

export async function ensureSandbox(log: (m: string) => void = console.log): Promise<{ treasury: boolean }> {
  const fs = await import("node:fs");
  const { LEDGERLY_DB } = await import("../../sandbox/shared/paths.ts");
  if (!fs.existsSync(LEDGERLY_DB)) { log("Seeding sandbox (demo scenario)…"); await seed("demo"); }
  if (!(await up(`${URLS.ledgerly}/login`))) { (await import("../../sandbox/ledgerly/server.ts")).startLedgerly(); }
  if (!(await up(`${URLS.mail}/login`))) { (await import("../../sandbox/mail/server.ts")).startMail(); }
  let treasury = await treasuryUp();
  if (!treasury) {
    try {
      log("Starting Acme Treasury container…");
      execSync("docker compose -f sandbox/treasury/docker-compose.yml up -d", { cwd: ROOT, stdio: "ignore", timeout: 120000 });
      treasury = await waitForTreasury(60000);
      if (treasury) await uploadTreasuryDb({ onlyIfEmpty: true });
    } catch { treasury = false; }
    if (!treasury) log("⚠ Acme Treasury desktop is not available (Docker). Tasks that need payments will report it.");
  }
  return { treasury };
}
