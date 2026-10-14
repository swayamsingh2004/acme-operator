/**
 * Start the sandbox company: Ledgerly + Acme Mail (Node) and Acme Treasury (Docker).
 * Seeds the demo scenario first if no data exists.
 */
import fs from "node:fs";
import { execSync } from "node:child_process";
import { LEDGERLY_DB, ROOT, URLS } from "./shared/paths.ts";
import { seed } from "./scripts/seed.ts";
import { uploadTreasuryDb, waitForTreasury } from "./shared/treasury.ts";
import { startLedgerly } from "./ledgerly/server.ts";
import { startMail } from "./mail/server.ts";

export async function startSandbox(opts: { treasury?: boolean } = {}) {
  if (!fs.existsSync(LEDGERLY_DB)) await seed("demo");
  startLedgerly();
  startMail();
  if (opts.treasury !== false) {
    try {
      execSync("docker compose -f sandbox/treasury/docker-compose.yml up -d", { cwd: ROOT, stdio: "ignore", timeout: 120000 });
      if (await waitForTreasury()) {
        await uploadTreasuryDb({ onlyIfEmpty: true });
        console.log(`[treasury] live view ${URLS.treasuryVnc}`);
      } else console.warn("[treasury] container started but the driver is not responding");
    } catch {
      console.warn("[treasury] could not start the Treasury container — is Docker running? (npm run treasury:build first)");
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) startSandbox();
