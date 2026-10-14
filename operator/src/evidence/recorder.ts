/**
 * Evidence recorder: one folder per run with the full event log, every
 * screenshot, downloads and the final report. A run can be audited (and
 * replayed in the console) without trusting anything the model said.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../config.ts";
import { bus, type RunEvent, type RunEventBody } from "../engine/events.ts";

export class Recorder {
  readonly id: string;
  readonly dir: string;
  readonly shotsDir: string;
  readonly downloadsDir: string;
  private seq = 0;
  private shot = 0;
  readonly events: RunEvent[] = [];

  constructor(id?: string) {
    this.id = id ?? `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${crypto.randomBytes(2).toString("hex")}`;
    this.dir = path.join(PATHS.runs, this.id);
    this.shotsDir = path.join(this.dir, "shots");
    this.downloadsDir = path.join(this.dir, "downloads");
    fs.mkdirSync(this.shotsDir, { recursive: true });
    fs.mkdirSync(this.downloadsDir, { recursive: true });
  }

  emit(body: RunEventBody, actor: "operator" | "verifier" = "operator"): RunEvent {
    const e = { ...body, runId: this.id, seq: ++this.seq, ts: new Date().toISOString(), actor } as RunEvent;
    this.events.push(e);
    fs.appendFileSync(path.join(this.dir, "events.jsonl"), JSON.stringify(e) + "\n");
    bus.emitEvent(e);
    return e;
  }

  /** Save a PNG and return its path relative to the run folder. */
  saveImage(png: Buffer, label: string): string {
    const name = `${String(++this.shot).padStart(3, "0")}-${label.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.png`;
    fs.writeFileSync(path.join(this.shotsDir, name), png);
    return `shots/${name}`;
  }

  writeJson(name: string, data: unknown) {
    fs.writeFileSync(path.join(this.dir, name), JSON.stringify(data, null, 2));
  }

  writeText(name: string, text: string) {
    fs.writeFileSync(path.join(this.dir, name), text);
  }
}

export function listRuns(): { id: string; meta: any }[] {
  if (!fs.existsSync(PATHS.runs)) return [];
  return fs.readdirSync(PATHS.runs)
    .filter((d) => fs.existsSync(path.join(PATHS.runs, d, "events.jsonl")))
    .sort().reverse()
    .map((id) => {
      const f = path.join(PATHS.runs, id, "report.json");
      let meta: any = null;
      if (fs.existsSync(f)) {
        try { meta = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* partial */ }
      }
      if (!meta) {
        const first = fs.readFileSync(path.join(PATHS.runs, id, "events.jsonl"), "utf8").split("\n")[0];
        try { const e = JSON.parse(first); meta = { request: e.request, status: "running" }; } catch { meta = { status: "unknown" }; }
      }
      return { id, meta };
    });
}

export function readRunEvents(id: string): RunEvent[] {
  const f = path.join(PATHS.runs, path.basename(id), "events.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
