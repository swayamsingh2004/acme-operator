import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, "../..");
export const SANDBOX = path.join(ROOT, "sandbox");
export const DATA = path.join(SANDBOX, "data");
export const DRIVE = path.join(SANDBOX, "drive");
export const LEDGERLY_DB = path.join(DATA, "ledgerly.db");
export const MAIL_DB = path.join(DATA, "mail.db");
export const MAIL_ATTACHMENTS = path.join(DATA, "mail-attachments");
export const TREASURY_DIR = path.join(DATA, "treasury");
export const TREASURY_DB = path.join(TREASURY_DIR, "treasury.db");

export const PORTS = { ledgerly: 4101, mail: 4102, treasuryVnc: 6080, treasuryDriver: 6090, console: 4100 };
export const URLS = {
  ledgerly: `http://localhost:${PORTS.ledgerly}`,
  mail: `http://localhost:${PORTS.mail}`,
  treasuryDriver: `http://localhost:${PORTS.treasuryDriver}`,
  treasuryVnc: `http://localhost:${PORTS.treasuryVnc}/vnc.html?autoconnect=1&resize=scale&view_only=1`,
};

/** Admin token for sandbox-internal APIs (state dumps, approval hooks). Not exposed to the model. */
export const SANDBOX_TOKEN = process.env.SANDBOX_TOKEN ?? "acme-sandbox-admin";

/** Credentials vault: the operator harness injects these; the model only ever sees the system id. */
export const VAULT: Record<string, { username: string; password: string }> = {
  ledgerly: { username: "ap.operator", password: "ledgerly-ap-2026!" },
  mail: { username: "ap@acme-robotics.example", password: "mail-ap-2026!" },
};
