#!/usr/bin/env python3
"""
Empire Meet — native remote-control agent.

WHAT THIS IS
------------
A browser tab cannot move another computer's mouse — the OS sandbox forbids it.
So the in-meeting "remote control" is, by itself, only a *guided pointer*: the
controller's cursor and clicks are drawn on top of the shared screen so you can
point and say "click there", but nothing is actually pressed.

This little helper closes that gap. You run it on the machine whose screen you
are SHARING. It joins your meeting as a silent, invisible listener (it is NOT a
participant — no video, no tile, not counted) and turns an approved
participant's pointer + clicks into REAL mouse/keyboard input on this machine.

PERMISSION MODEL (read this)
----------------------------
Nothing is injected until BOTH of these happen:
  1. You (the sharer) click "Allow" on the control request inside the meeting.
  2. You pair this agent by typing the PIN below into the meeting's pairing box.
The PIN is shown only here, in your terminal — a meeting participant can't see
it, so no one can promote themselves to real control by forging a message.
Control ends the instant you Release/Revoke, stop sharing, or quit this agent
(Ctrl-C). Slam the mouse into a screen corner for PyAutoGUI's fail-safe abort.

USAGE
-----
  python3 control_agent.py <meeting-link-or-code> [--url BASE_URL] [--name NAME]

  # full link (recommended — the agent figures out the server + room):
  python3 control_agent.py https://your-tunnel.trycloudflare.com/room/abcd-efgh-ijkl
  # just the code, against a local server:
  python3 control_agent.py abcd-efgh-ijkl --url http://localhost:3030

REQUIREMENTS
------------
  pip install --user websocket-client pyautogui
  macOS: System Settings → Privacy & Security → grant your TERMINAL app both
         "Accessibility" and "Screen Recording". (You must do this yourself;
         software can't grant its own OS permissions.)

NOTES / LIMITS
--------------
  • Coordinates map to your PRIMARY display, full-screen. Share "Entire Screen"
    (not a single window/tab) for accurate mapping.
  • Multi-monitor spanning isn't handled — control targets the primary display.
"""

from __future__ import annotations  # allow `str | None` hints on Python 3.9

import argparse
import json
import secrets
import sys
from urllib.parse import urlparse, quote


def parse_target(target: str, base_url: str | None):
    """Return (ws_url, room_code) from a link/code (+ optional base URL)."""
    room = target.strip()
    origin = None
    if room.startswith("http://") or room.startswith("https://"):
        u = urlparse(room)
        origin = f"{u.scheme}://{u.netloc}"
        path = u.path
    else:
        path = room
    # extract the room code from ".../room/CODE" or a bare code
    if "/room/" in path:
        code = path.split("/room/", 1)[1]
    else:
        code = path
    code = code.strip("/").replace("room/", "").split("?")[0].split("#")[0].strip()

    base = base_url or origin or "http://localhost:3030"
    b = urlparse(base)
    ws_scheme = "wss" if b.scheme == "https" else "ws"
    return f"{ws_scheme}://{b.netloc}/ws?room={quote(code)}&role=agent&name={quote('Control Agent')}", code


class ControlGate:
    """Decides whether an incoming control signal may inject real OS input.

    Injection is permitted only after a PIN-authenticated grant (a ctrl-active
    carrying the matching pairing PIN), and thereafter only for signals stamped
    `from` that authorised controller. Kept as pure logic + coordinate mapping
    so it is unit-testable without a real display or websocket.
    """

    def __init__(self, pin, screen_w, screen_h, injector):
        self.pin = (pin or "").upper()
        self.w = int(screen_w)
        self.h = int(screen_h)
        self.injector = injector
        self.controller = None  # peerId currently authorised to inject

    def _xy(self, m):
        x = max(0, min(self.w - 1, int(float(m.get("x", 0)) * self.w)))
        y = max(0, min(self.h - 1, int(float(m.get("y", 0)) * self.h)))
        return x, y

    def handle(self, m):
        """Process one signalling message; returns a short action string."""
        if not isinstance(m, dict):
            return "ignored"
        t = m.get("type")

        if t == "ctrl-active":  # authoritative grant/clear from the sharer
            cid = m.get("controllerId")
            if not cid:
                ended = self.controller is not None
                self.controller = None
                return "ended" if ended else "noop"
            if (m.get("pin") or "").upper() == self.pin:
                self.controller = cid
                return "granted"
            return "rejected-pin"  # forged/unpaired grant → no real control

        authorised = self.controller is not None and m.get("from") == self.controller
        if t == "ctrl-move" and authorised:
            x, y = self._xy(m); self.injector.move(x, y); return "move"
        if t == "ctrl-click" and authorised:
            x, y = self._xy(m); self.injector.click(x, y); return "click"
        if t == "ctrl-key" and authorised:
            self.injector.key(m.get("text"), m.get("key")); return "key"
        return "ignored"


class MacQuartzInjector:
    """Real mouse/keyboard input on macOS via CoreGraphics, called through
    ctypes — so it needs NO third-party packages (no pyautogui/pyobjc build).

    Still requires the running terminal to hold macOS *Accessibility*
    permission; without it CGEventPost is silently ignored by the OS.
    """

    # CGEventType / button / tap constants
    _MOUSE_MOVED = 5
    _L_DOWN = 1
    _L_UP = 2
    _HID_TAP = 0
    _BTN_LEFT = 0

    def __init__(self):
        import ctypes
        import ctypes.util
        self.ctypes = ctypes
        lib = ctypes.util.find_library("CoreGraphics") or ctypes.util.find_library("ApplicationServices")
        if not lib:
            raise OSError("CoreGraphics not found (not macOS?)")
        cg = ctypes.CDLL(lib)
        cf = ctypes.CDLL(ctypes.util.find_library("CoreFoundation"))

        class CGPoint(ctypes.Structure):
            _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]

        class CGSize(ctypes.Structure):
            _fields_ = [("width", ctypes.c_double), ("height", ctypes.c_double)]

        class CGRect(ctypes.Structure):
            _fields_ = [("origin", CGPoint), ("size", CGSize)]

        cg.CGMainDisplayID.restype = ctypes.c_uint32
        cg.CGDisplayBounds.restype = CGRect
        cg.CGDisplayBounds.argtypes = [ctypes.c_uint32]
        cg.CGEventCreateMouseEvent.restype = ctypes.c_void_p
        cg.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, CGPoint, ctypes.c_uint32]
        cg.CGEventCreateKeyboardEvent.restype = ctypes.c_void_p
        cg.CGEventCreateKeyboardEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint16, ctypes.c_bool]
        cg.CGEventKeyboardSetUnicodeString.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p]
        cg.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
        cg.CGEventCreate.restype = ctypes.c_void_p
        cg.CGEventCreate.argtypes = [ctypes.c_void_p]
        cg.CGEventGetLocation.restype = CGPoint
        cg.CGEventGetLocation.argtypes = [ctypes.c_void_p]
        cf.CFRelease.argtypes = [ctypes.c_void_p]

        self.cg = cg
        self.cf = cf
        self.CGPoint = CGPoint
        bounds = cg.CGDisplayBounds(cg.CGMainDisplayID())
        self.width = int(bounds.size.width)    # points (mouse-event coordinate space)
        self.height = int(bounds.size.height)
        self.name = "macOS CoreGraphics (ctypes)"

    def _post_mouse(self, etype, x, y, button=_BTN_LEFT):
        ev = self.cg.CGEventCreateMouseEvent(None, etype, self.CGPoint(float(x), float(y)), button)
        if ev:
            self.cg.CGEventPost(self._HID_TAP, ev)
            self.cf.CFRelease(ev)

    def move(self, x, y):
        try: self._post_mouse(self._MOUSE_MOVED, x, y)
        except Exception: pass

    def click(self, x, y):
        try:
            self._post_mouse(self._L_DOWN, x, y)
            self._post_mouse(self._L_UP, x, y)
        except Exception: pass

    def key(self, text, key):
        # Best-effort unicode typing (special keys not mapped). Browser UI
        # doesn't send keystrokes yet, so this is here for completeness.
        if not text:
            return
        try:
            ctypes = self.ctypes
            for ch in text:
                buf = ctypes.create_unicode_buffer(ch)
                for down in (True, False):
                    ev = self.cg.CGEventCreateKeyboardEvent(None, 0, down)
                    if not ev:
                        continue
                    self.cg.CGEventKeyboardSetUnicodeString(ev, 1, buf)
                    self.cg.CGEventPost(self._HID_TAP, ev)
                    self.cf.CFRelease(ev)
        except Exception:
            pass

    def get_pos(self):
        ev = self.cg.CGEventCreate(None)
        p = self.cg.CGEventGetLocation(ev)
        if ev:
            self.cf.CFRelease(ev)
        return (p.x, p.y)


class WindowsCtypesInjector:
    """Real mouse/keyboard input on Windows via user32 (ctypes) — no build, no
    third-party package. Windows doesn't gate SendInput behind an Accessibility
    grant the way macOS does (though UIPI blocks sending to higher-integrity
    windows)."""

    def __init__(self):
        import ctypes
        self.ctypes = ctypes
        self.user32 = ctypes.windll.user32  # only exists on Windows
        try:
            self.user32.SetProcessDPIAware()
        except Exception:
            pass
        self.width = self.user32.GetSystemMetrics(0) or 1920
        self.height = self.user32.GetSystemMetrics(1) or 1080

        class POINT(ctypes.Structure):
            _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

        self._POINT = POINT
        self.name = "Windows user32 (ctypes)"

    def move(self, x, y):
        try: self.user32.SetCursorPos(int(x), int(y))
        except Exception: pass

    def click(self, x, y):
        try:
            self.user32.SetCursorPos(int(x), int(y))
            self.user32.mouse_event(0x0002, 0, 0, 0, 0)  # LEFTDOWN
            self.user32.mouse_event(0x0004, 0, 0, 0, 0)  # LEFTUP
        except Exception: pass

    def key(self, text, key):
        if not text:
            return
        try:
            for ch in text:
                vk = self.user32.VkKeyScanW(ord(ch)) & 0xFF
                self.user32.keybd_event(vk, 0, 0, 0)
                self.user32.keybd_event(vk, 0, 2, 0)  # KEYEVENTF_KEYUP
        except Exception:
            pass

    def get_pos(self):
        try:
            pt = self._POINT()
            self.user32.GetCursorPos(self.ctypes.byref(pt))
            return (pt.x, pt.y)
        except Exception:
            return (0, 0)


class PyAutoGuiInjector:
    """Cross-platform fallback (Linux, or any OS if pyautogui is installed)."""

    def __init__(self, pg):
        self.pg = pg
        pg.FAILSAFE = True
        pg.PAUSE = 0
        self.width, self.height = pg.size()
        self.name = "PyAutoGUI"

    def move(self, x, y):
        try: self.pg.moveTo(x, y, _pause=False)
        except Exception: pass

    def click(self, x, y):
        try: self.pg.click(x, y)
        except Exception: pass

    def key(self, text, key):
        try:
            if text: self.pg.typewrite(text, interval=0)
            elif key: self.pg.press(key)
        except Exception: pass

    def get_pos(self):
        try:
            p = self.pg.position(); return (p[0], p[1])
        except Exception:
            return (0, 0)


def make_injector():
    """Pick the best available real-input backend for this OS (no native builds)."""
    if sys.platform == "darwin":
        try:
            return MacQuartzInjector()
        except Exception as e:
            print(f"[agent] CoreGraphics backend unavailable ({e}); trying PyAutoGUI…")
    elif sys.platform.startswith("win"):
        try:
            return WindowsCtypesInjector()
        except Exception as e:
            print(f"[agent] user32 backend unavailable ({e}); trying PyAutoGUI…")
    try:
        import pyautogui
        return PyAutoGuiInjector(pyautogui)
    except Exception:
        sys.exit(
            "No input backend available.\n"
            "  • macOS: built-in CoreGraphics backend — grant Accessibility permission.\n"
            "  • Windows: built-in user32 backend — should work out of the box.\n"
            "  • Linux: pip install --user pyautogui"
        )


def run_selftest():
    """Move the real cursor a little and check the OS honoured it → proves
    Accessibility permission is granted. Moves the pointer back afterwards."""
    inj = make_injector()
    print(f"[selftest] backend: {inj.name}  |  screen: {inj.width} x {inj.height}")
    start = inj.get_pos()
    print(f"[selftest] cursor now at {start}")
    tx, ty = inj.width // 2, inj.height // 2
    inj.move(tx, ty)
    import time; time.sleep(0.25)
    after = inj.get_pos()
    print(f"[selftest] asked to move to ({tx}, {ty}); cursor is now at {after}")
    moved = abs(after[0] - tx) < 5 and abs(after[1] - ty) < 5
    # put it back roughly where it was
    inj.move(int(start[0]), int(start[1]))
    if moved:
        print("[selftest] ✅ REAL mouse control works — this machine can be controlled.")
        return 0
    print(
        "[selftest] ❌ the cursor did NOT move.\n"
        "  → macOS is blocking input injection. Grant your terminal app\n"
        "    'Accessibility' (and 'Screen Recording' for sharing) under\n"
        "    System Settings › Privacy & Security, then re-run. Only you can\n"
        "    grant this — it can't be done from software."
    )
    return 1


def main():
    ap = argparse.ArgumentParser(description="Empire Meet native remote-control agent")
    ap.add_argument("target", nargs="?", help="meeting link (…/room/CODE) or just the room CODE")
    ap.add_argument("--url", default=None, help="server base URL (e.g. http://localhost:3030); inferred from a full link if omitted")
    ap.add_argument("--name", default="Control Agent", help="unused label")
    ap.add_argument("--pin", default=None, help="use a fixed pairing PIN instead of a random one")
    ap.add_argument("--selftest", action="store_true", help="verify real input works on this machine, then exit")
    args = ap.parse_args()

    if args.selftest:
        sys.exit(run_selftest())
    if not args.target:
        ap.error("a meeting link or room CODE is required (or use --selftest)")

    # Lazy import so --help / --selftest work without websocket-client.
    try:
        import websocket  # websocket-client
    except ImportError:
        sys.exit("Missing dependency. Run:  pip install --user websocket-client")

    injector = make_injector()
    screen_w, screen_h = injector.width, injector.height

    ws_url, code = parse_target(args.target, args.url)
    pin = (args.pin or secrets.token_hex(3)).upper()

    gate = ControlGate(pin, screen_w, screen_h, injector)

    print("\n" + "=" * 58)
    print("  EMPIRE MEET — native control agent")
    print("=" * 58)
    print(f"  Room     : {code}")
    print(f"  Server   : {ws_url.split('?')[0]}")
    print(f"  Backend  : {injector.name}")
    print(f"  Screen   : {screen_w} x {screen_h} (primary display)")
    print("-" * 58)
    print(f"  PAIRING PIN:   {pin}")
    print("  → In the meeting, share your screen, approve the control")
    print("    request, then enter this PIN in the pairing box to turn")
    print("    the guided pointer into REAL mouse/keyboard control.")
    print("=" * 58 + "\n")

    def on_message(_ws, message):
        try:
            m = json.loads(message)
        except (ValueError, TypeError):
            return
        if m.get("type") == "welcome-agent":
            print(f"[agent] connected to room {m.get('room', code)} — waiting for a paired control grant.")
            return
        action = gate.handle(m)
        if action == "granted":
            who = m.get("controllerName") or m.get("controllerId")
            print(f"[agent] ✅ paired — '{who}' now has REAL control of this machine.")
        elif action == "rejected-pin":
            print("[agent] ⚠ control grant ignored (no/incorrect pairing PIN — guided pointer only).")
        elif action == "ended":
            print("[agent] control ended — real input DISABLED.")

    def on_open(_ws):
        print("[agent] websocket open.")

    def on_error(_ws, err):
        print(f"[agent] error: {err}")

    def on_close(_ws, code_, reason):
        gate.controller = None
        print(f"[agent] disconnected ({code_} {reason or ''}). Reconnecting…")

    app = websocket.WebSocketApp(
        ws_url,
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close,
    )
    try:
        # reconnect keeps the agent alive across tunnel blips / server restarts.
        app.run_forever(reconnect=5)
    except KeyboardInterrupt:
        print("\n[agent] stopped. Real control disabled.")


if __name__ == "__main__":
    main()
