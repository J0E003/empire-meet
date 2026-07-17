# Empire Meet — Native Remote-Control Agent

A browser tab **cannot** move another computer's mouse or keyboard — the OS
sandbox forbids it. So the "remote control" built into the meeting is, on its
own, a **guided pointer**: the controller's cursor and clicks are drawn on top
of the shared screen ("click there"), but nothing is actually pressed.

This agent closes that gap. Run it **on the machine whose screen you are
sharing**. It joins your meeting as a silent, invisible listener — not a
participant (no tile, no video, not counted) — and turns an approved
participant's pointer + clicks into **real** mouse/keyboard input.

This is the same model TeamViewer / AnyDesk / Zoom Remote Control use: a small
native helper on the controlled machine. The difference is it's opt-in per
meeting and gated by a PIN only you can see.

---

## Install

```bash
pip install --user -r requirements.txt
# or: pip install --user websocket-client pyautogui
```

**macOS permissions (required).** Grant your **terminal app** both:
`System Settings → Privacy & Security → Accessibility` **and** `Screen
Recording`. You have to do this yourself — software can't grant its own OS
permissions. Without Accessibility, PyAutoGUI can't move the mouse.

**Linux:** X11 works out of the box; on Wayland you may need to run under XWayland.
**Windows:** works with no extra permissions.

---

## Run

```bash
# Paste the full meeting link — the agent figures out server + room:
python3 control_agent.py https://your-tunnel.trycloudflare.com/room/abcd-efgh-ijkl

# …or just the room code against a local server:
python3 control_agent.py abcd-efgh-ijkl --url http://localhost:3030
```

It prints a **pairing PIN**:

```
============================================================
  EMPIRE MEET — native control agent
============================================================
  Room     : abcd-efgh-ijkl
  Server   : ws://localhost:3030/ws
  Screen   : 1920 x 1080 (primary display)
------------------------------------------------------------
  PAIRING PIN:   4F9C1A
  → In the meeting, share your screen, approve the control
    request, then enter this PIN in the pairing box to turn
    the guided pointer into REAL mouse/keyboard control.
============================================================
```

## Flow (what enables real control)

1. In the meeting, **Share** your screen (choose **Entire Screen**).
2. A participant taps **Control** / **Request control** → you get an
   Allow/Deny prompt → click **Allow**.
3. A pairing box appears → type the **PIN** from your terminal → **Pair**.
4. That participant's pointer now really moves your mouse and clicks.
   The banner shows **"… is controlling the shared screen · real control"**.

Control ends instantly when you click **Stop/Release/Revoke**, stop sharing,
or quit the agent (`Ctrl-C`).

## Why the PIN

Grants travel over the meeting's relay as messages. Without a secret, any
participant could *forge* a "grant control to me" message and seize your
machine. The PIN is printed only in your terminal, so only you (the person at
the shared machine) can authorise real control. The agent injects nothing
until it sees a grant carrying the matching PIN, and thereafter only obeys the
one participant that grant named.

## Safety

- **Fail-safe:** slam the mouse into any screen corner to abort (PyAutoGUI FAILSAFE).
- **Quit:** `Ctrl-C` drops control immediately.
- Nothing is injected before both **Allow** *and* **Pair**.

## Limits

- Coordinates map to your **primary display, full-screen**. Share *Entire
  Screen* (not a single window or browser tab) for accurate mapping.
- Multi-monitor spanning isn't handled — control targets the primary display.
- Keyboard relay (`ctrl-key`) is supported by the agent but the browser UI
  doesn't send keystrokes yet (pointer + click today).
