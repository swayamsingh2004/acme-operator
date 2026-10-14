/**
 * Desktop control for Acme Treasury through Gemini's native computer-use tool
 * (environment "desktop"). The model sees only screenshots and emits actions
 * with coordinates on a normalized 0–999 grid; this class maps each action to
 * the virtual desktop's driver (xdotool on a 1280x800 X display) and returns a
 * fresh screenshot, as the computer-use contract expects.
 */
import { URLS } from "../../../sandbox/shared/paths.ts";
import type { Recorder } from "../evidence/recorder.ts";
import type { ToolOutput } from "./types.ts";

export const SCREEN = { width: 1280, height: 800 };

/** Gemini's predefined desktop computer-use actions. */
export const COMPUTER_ACTIONS = new Set([
  "click", "double_click", "triple_click", "middle_click", "right_click", "mouse_down", "mouse_up", "move",
  "type", "drag_and_drop", "wait", "press_key", "key_down", "key_up", "hotkey", "take_screenshot", "scroll",
]);
/** Actions that only observe (allowed before a plan exists). */
export const OBSERVE_ACTIONS = new Set(["take_screenshot", "wait"]);

export const COMPUTER_TOOL = { type: "computer_use", environment: "desktop", enable_prompt_injection_detection: true };

const KEYS: Record<string, string> = {
  enter: "Return", return: "Return", control: "ctrl", ctrl: "ctrl", shift: "shift", alt: "alt", option: "alt",
  meta: "super", command: "super", cmd: "super", win: "super", super: "super", escape: "Escape", esc: "Escape",
  tab: "Tab", backspace: "BackSpace", delete: "Delete", del: "Delete", space: "space", " ": "space",
  arrowup: "Up", arrowdown: "Down", arrowleft: "Left", arrowright: "Right", up: "Up", down: "Down", left: "Left", right: "Right",
  pageup: "Prior", pagedown: "Next", home: "Home", end: "End", insert: "Insert",
};
const keyName = (k: string) => { const t = String(k).trim(); const low = t.toLowerCase(); return KEYS[low] ?? (/^f\d{1,2}$/.test(low) ? low.toUpperCase() : t); };
const combo = (keys: string[]) => keys.flatMap((k) => String(k).split("+")).map(keyName).join("+");

const px = (x: number) => Math.min(SCREEN.width - 1, Math.max(0, Math.round((Number(x) / 1000) * SCREEN.width)));
const py = (y: number) => Math.min(SCREEN.height - 1, Math.max(0, Math.round((Number(y) / 1000) * SCREEN.height)));
const at = (a: any) => [px(a.x), py(a.y)];

export class DesktopDriver {
  constructor(private recorder: Recorder, private label: "operator" | "verifier") {}

  async available(): Promise<boolean> {
    try { return (await fetch(`${URLS.treasuryDriver}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
  }

  async screenshotPng(): Promise<Buffer> {
    const r = await fetch(`${URLS.treasuryDriver}/screenshot`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`screenshot failed (${r.status})`);
    return Buffer.from(await r.arrayBuffer());
  }

  private async driver(name: string, input: Record<string, unknown> = {}) {
    const r = await fetch(`${URLS.treasuryDriver}/action`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, input }),
      signal: AbortSignal.timeout(Math.max(20000, (Number(input.duration ?? 0) + 10) * 1000)),
    });
    const j = (await r.json()) as { ok: boolean; error?: string };
    if (!j.ok) throw new Error(j.error ?? "driver error");
  }

  /** Translate one Gemini computer-use action into driver calls. */
  private async perform(name: string, a: any): Promise<void> {
    switch (name) {
      case "click": return this.driver("left_click", { coordinate: at(a) });
      case "double_click": case "triple_click": case "middle_click": case "right_click": return this.driver(name, { coordinate: at(a) });
      case "move": return this.driver("mouse_move", { coordinate: at(a) });
      case "mouse_down": await this.driver("mouse_move", { coordinate: at(a) }); return this.driver("left_mouse_down");
      case "mouse_up": await this.driver("mouse_move", { coordinate: at(a) }); return this.driver("left_mouse_up");
      case "drag_and_drop": return this.driver("left_click_drag", { start_coordinate: [px(a.start_x), py(a.start_y)], coordinate: [px(a.end_x), py(a.end_y)] });
      case "type":
        await this.driver("type", { text: String(a.text ?? "") });
        if (a.press_enter) await this.driver("key", { text: "Return" });
        return;
      case "press_key": return this.driver("key", { text: combo([a.key]) });
      case "hotkey": return this.driver("key", { text: combo(a.keys ?? []) });
      case "key_down": return this.driver("key_down", { text: keyName(a.key) });
      case "key_up": return this.driver("key_up", { text: keyName(a.key) });
      case "scroll": {
        const clicks = a.magnitude_in_pixels ? Math.max(1, Math.min(15, Math.round(Number(a.magnitude_in_pixels) / 80))) : 3;
        return this.driver("scroll", { coordinate: a.x !== undefined ? at(a) : undefined, scroll_direction: a.direction ?? "down", scroll_amount: clicks });
      }
      case "wait": return this.driver("wait", { duration: Math.min(10, Number(a.seconds ?? 1)) });
      case "take_screenshot": return;
      default: throw new Error(`unsupported computer action '${name}'`);
    }
  }

  /** Run an action and return the result the model expects: status JSON + a fresh screenshot. */
  async run(name: string, args: any, extra: Record<string, unknown> = {}): Promise<ToolOutput> {
    try {
      await this.perform(name, args ?? {});
      const png = await this.screenshotPng();
      const image = this.recorder.saveImage(png, `${this.label}-treasury-${name}`);
      return {
        content: [
          { type: "text", text: JSON.stringify({ status: "ok", ...extra }) },
          { type: "image", data: png.toString("base64"), mime_type: "image/png" },
        ],
        summary: describe(name, args),
        image,
      };
    } catch (e: any) {
      const msg = /fetch failed|ECONNREFUSED|aborted|timeout/i.test(String(e?.message ?? e))
        ? "Treasury desktop is not reachable (is the acme-treasury container running?)."
        : String(e?.message ?? e);
      return { content: JSON.stringify({ status: "error", error: msg }), isError: true, summary: `${name} failed: ${msg}` };
    }
  }
}

function describe(name: string, a: any): string {
  const why = a?.intent ? ` — ${String(a.intent).slice(0, 60)}` : "";
  if (a?.x !== undefined) return `${name} @ (${px(a.x)}, ${py(a.y)})${why}`;
  if (name === "type") return `type "${String(a.text).slice(0, 40)}"${a.press_enter ? " ⏎" : ""}${why}`;
  if (name === "press_key") return `key ${a.key}${why}`;
  if (name === "hotkey") return `hotkey ${(a.keys ?? []).join("+")}${why}`;
  if (name === "take_screenshot") return `Treasury screenshot${why}`;
  return `${name}${why}`;
}
