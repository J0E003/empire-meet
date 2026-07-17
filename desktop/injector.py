#!/usr/bin/env python3
"""
Empire Meet desktop — native input injector (stdin loop).

Spawned by the Electron main process. Reads one command per line on stdin and
turns normalized (0..1) coordinates into REAL mouse input on this machine,
reusing the backend from ../agent/control_agent.py (macOS CoreGraphics via
ctypes — no native build; PyAutoGUI fallback on Windows/Linux).

Protocol (stdin, whitespace-separated):
    M <x> <y>      move to normalized (x, y) of the primary display
    C <x> <y>      left click at normalized (x, y)
    K <text...>    type text (best-effort)

Prints "READY <backend> <w>x<h>" once the backend is up.
"""

import os
import sys

# Electron main passes EMPIRE_AGENT_DIR (packaged: Resources/agent). Fall back to
# the dev layout (../agent) when run directly.
_agent_dir = os.environ.get("EMPIRE_AGENT_DIR") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "agent"
)
sys.path.insert(0, _agent_dir)

try:
    from control_agent import make_injector
except Exception as e:  # pragma: no cover
    sys.stderr.write(f"injector import failed: {e}\n")
    sys.exit(1)


def main():
    inj = make_injector()
    w, h = inj.width, inj.height
    sys.stdout.write(f"READY {inj.name} {w}x{h}\n")
    sys.stdout.flush()

    def px(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return 0.0

    for line in sys.stdin:
        parts = line.split()
        if not parts:
            continue
        cmd = parts[0]
        if cmd in ("M", "C") and len(parts) >= 3:
            x = max(0, min(w - 1, int(px(parts[1]) * w)))
            y = max(0, min(h - 1, int(px(parts[2]) * h)))
            if cmd == "M":
                inj.move(x, y)
            else:
                inj.click(x, y)
        elif cmd == "K" and len(parts) >= 2:
            inj.key(line.split(" ", 1)[1].rstrip("\n"), None)
        sys.stdout.flush()


if __name__ == "__main__":
    main()
