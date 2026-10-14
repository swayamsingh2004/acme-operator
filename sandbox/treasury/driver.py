"""
Computer driver for the Treasury virtual desktop.

Low-level mouse/keyboard/screenshot primitives against the X display (xdotool +
Pillow). The operator harness maps Gemini's computer-use actions onto these over
HTTP; the model never talks to the driver directly.
"""
import io
import json
import os
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image, ImageGrab

DISPLAY = os.environ.get("DISPLAY", ":0")
DB = os.environ.get("TREASURY_DB", "/data/treasury.db")
W, H = 1280, 800
KEY_ALIASES = {"enter": "Return", "return": "Return", "esc": "Escape", "escape": "Escape", "tab": "Tab",
               "backspace": "BackSpace", "delete": "Delete", "space": "space", "cmd": "super", "command": "super",
               "win": "super", "pageup": "Prior", "pagedown": "Next", "up": "Up", "down": "Down",
               "left": "Left", "right": "Right", "home": "Home", "end": "End"}


def xdo(*args):
    subprocess.run(["xdotool", *[str(a) for a in args]], check=True, env={**os.environ, "DISPLAY": DISPLAY},
                   capture_output=True, timeout=30)


def norm_key(combo):
    parts = [p.strip() for p in combo.split("+") if p.strip()]
    return "+".join(KEY_ALIASES.get(p.lower(), p) for p in parts)


def grab():
    return ImageGrab.grab(xdisplay=DISPLAY).convert("RGB")


def png(img):
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def with_mods(mods, fn):
    keys = [norm_key(m) for m in (mods or "").split("+") if m.strip()]
    for k in keys:
        xdo("keydown", k)
    try:
        fn()
    finally:
        for k in reversed(keys):
            xdo("keyup", k)


def move(coord):
    if coord:
        x, y = int(coord[0]), int(coord[1])
        if not (0 <= x < W and 0 <= y < H):
            raise ValueError("coordinate %s is outside the %dx%d screen" % (coord, W, H))
        xdo("mousemove", x, y)


def act(name, inp):
    """Execute one computer-toolset member. Returns text (or raises)."""
    if name in ("left_click", "right_click", "middle_click", "double_click", "triple_click"):
        button = {"left_click": 1, "right_click": 3, "middle_click": 2}.get(name, 1)
        repeat = {"double_click": 2, "triple_click": 3}.get(name, 1)
        move(inp.get("coordinate"))
        with_mods(inp.get("text"), lambda: xdo("click", "--repeat", repeat, "--delay", 90, button))
    elif name == "left_click_drag":
        move(inp["start_coordinate"])
        xdo("mousedown", 1)
        time.sleep(0.1)
        move(inp["coordinate"])
        time.sleep(0.1)
        xdo("mouseup", 1)
    elif name == "mouse_move":
        move(inp["coordinate"])
    elif name == "left_mouse_down":
        xdo("mousedown", 1)
    elif name == "left_mouse_up":
        xdo("mouseup", 1)
    elif name == "cursor_position":
        out = subprocess.run(["xdotool", "getmouselocation", "--shell"], capture_output=True, text=True,
                             env={**os.environ, "DISPLAY": DISPLAY}).stdout
        vals = dict(line.split("=") for line in out.strip().splitlines() if "=" in line)
        return "X=%s, Y=%s" % (vals.get("X"), vals.get("Y"))
    elif name == "scroll":
        move(inp.get("coordinate"))
        button = {"up": 4, "down": 5, "left": 6, "right": 7}[inp["scroll_direction"]]
        amount = max(1, min(int(inp.get("scroll_amount", 3)), 30))
        with_mods(inp.get("text"), lambda: xdo("click", "--repeat", amount, "--delay", 40, button))
    elif name == "type":
        xdo("type", "--delay", 15, "--", inp["text"])
    elif name == "key":
        for _ in range(max(1, min(int(inp.get("repeat", 1)), 100))):
            xdo("key", "--clearmodifiers", norm_key(inp["text"]))
    elif name == "key_down":
        xdo("keydown", norm_key(inp["text"]))
    elif name == "key_up":
        xdo("keyup", norm_key(inp["text"]))
    elif name == "hold_key":
        k = norm_key(inp["text"])
        xdo("keydown", k)
        time.sleep(min(float(inp.get("duration", 1)), 10))
        xdo("keyup", k)
    elif name == "wait":
        time.sleep(min(float(inp.get("duration", 1)), 10))
    else:
        raise ValueError("unsupported action: %s" % name)
    time.sleep(0.35)  # let the UI settle before the next observation
    return "OK"


def restart_app():
    subprocess.run(["pkill", "-f", "treasury/app.py"])
    time.sleep(1.5)


def zoom(region):
    x0, y0, x1, y1 = [int(v) for v in region]
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(W, x1), min(H, y1)
    if x1 <= x0 or y1 <= y0:
        raise ValueError("empty zoom region")
    crop = grab().crop((x0, y0, x1, y1))
    scale = min(W / crop.width, H / crop.height)
    return crop.resize((max(1, int(crop.width * scale)), max(1, int(crop.height * scale))), Image.LANCZOS)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self.send(200, {"ok": True, "display": [W, H]})
        if self.path == "/db":
            try:
                with open(DB, "rb") as f:
                    return self.send(200, f.read(), "application/octet-stream")
            except FileNotFoundError:
                return self.send(404, {"ok": False, "error": "no database loaded"})
        if self.path == "/screenshot":
            try:
                return self.send(200, png(grab()), "image/png")
            except Exception as e:  # noqa: BLE001
                return self.send(500, {"ok": False, "error": str(e)})
        self.send(404, {"ok": False})

    def do_PUT(self):
        if self.path != "/db":
            return self.send(404, {"ok": False})
        n = int(self.headers.get("content-length") or 0)
        data = self.rfile.read(n)
        os.makedirs(os.path.dirname(DB), exist_ok=True)
        tmp = DB + ".upload"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, DB)
        restart_app()
        return self.send(200, {"ok": True, "bytes": len(data)})

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        try:
            if self.path == "/action":
                return self.send(200, {"ok": True, "text": act(body["name"], body.get("input") or {})})
            if self.path == "/zoom":
                return self.send(200, png(zoom(body["region"])), "image/png")
            if self.path == "/reset":
                restart_app()
                return self.send(200, {"ok": True})
        except Exception as e:  # noqa: BLE001
            return self.send(400, {"ok": False, "error": str(e)})
        self.send(404, {"ok": False})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 6090), Handler).serve_forever()
