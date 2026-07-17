# Empire Meet — Desktop app

The same meeting web app in a native window, **plus real remote control** — the
thing a browser tab can't do. When you share your screen and approve a control
request, an invited participant's pointer really moves your mouse and clicks.
Zoom/TeamViewer work the exact same way (native app + a one-time OS permission).

## How real control works here

- The renderer (`../public/room.js`) detects it's inside this app via
  `window.empireDesktop` (exposed by `preload.js`).
- While **you are the sharer** and you clicked **Allow**, each incoming
  `ctrl-move` / `ctrl-click` is sent over IPC to the main process.
- Main pipes it to `injector.py`, a tiny subprocess that injects real input:
  - **macOS** → CoreGraphics via `ctypes` (no native build; Python ships with macOS)
  - **Windows** → `user32` (SendInput/SetCursorPos) via `ctypes`
  - **Linux** → PyAutoGUI fallback
- It only ever injects on **your** machine, only after **you** approved, and
  only for the one peer you approved (`grantedControllerId`, set locally — a
  forged network message can't enable it). Nothing to pair, no PIN.

> Windows note: the injector needs a Python 3 interpreter on the machine being
> controlled (macOS already has one). If Python isn't found, the app still runs
> as a full meeting client with the guided pointer — only *real* injection is
> off. A future build can bundle Python or a native module to remove this.

## Run in development

```bash
cd desktop
npm install                              # downloads Electron (needs network)
npm start -- http://localhost:3030       # or your tunnel URL
```

First launch on macOS prompts for **Accessibility** + **Screen Recording** —
grant them (System Settings › Privacy & Security). That's the same one-time
step Zoom requires.

## Build installers

electron-builder outputs straight into `../public/downloads/`, so the site's
Download page (`/download.html`) and `/api/downloads` pick them up automatically.

```bash
cd desktop
npm install
npm run dist:mac      # → ../public/downloads/Empire-Meet-<ver>-mac-<arch>.dmg + .zip
npm run dist:win      # → ...-win-x64.exe (nsis installer + portable)  [run on Windows]
npm run dist:linux    # → ...-linux.AppImage
```

You can only build a given OS's installer **on that OS** (or in CI) — a Mac
can't natively produce a Windows `.exe` without Wine.

### Recommended: build BOTH via GitHub Actions (no Windows machine needed)

`.github/workflows/build-desktop.yml` builds macOS **and** Windows on real
runners and attaches the installers to a GitHub Release:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

Then either commit the built files into `public/downloads/` (small teams) or
point the Download page at the Release asset URLs.

## Signing / notarization

These configs build **unsigned** (macOS ad-hoc via `identity: null`). Unsigned
apps trigger a one-time warning:

- **macOS:** right-click the app → **Open** → **Open** (bypasses Gatekeeper once).
- **Windows:** SmartScreen → **More info** → **Run anyway**.

For a clean public download, sign + notarize: add an Apple Developer ID
(`CSC_LINK`/`CSC_KEY_PASSWORD` + `notarize`) and a Windows Authenticode cert.
That's an account/credential step — nothing in the code blocks it.

## Files

| File | Role |
|------|------|
| `main.js` | Electron main — window, media/screen permissions, spawns injector, IPC bridge |
| `preload.js` | Exposes the safe `window.empireDesktop` bridge to the page |
| `injector.py` | stdin loop → real OS input (reuses `../agent/control_agent.py` backends) |
| `package.json` | Electron + electron-builder config (mac/win/linux targets) |
