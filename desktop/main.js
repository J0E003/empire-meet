/**
 * Empire Meet — desktop client (Electron).
 *
 * It's the same meeting web app in a native window, PLUS the thing a browser
 * tab can never do: when you share your screen and click "Allow" on a control
 * request, an approved participant's pointer really moves your mouse & clicks.
 *
 * How real control works here (Zoom-style, no separate agent, no PIN):
 *   • The renderer (room.js) detects it's inside this app (window.empireDesktop).
 *   • While you are the sharer and control is active, each incoming ctrl-move /
 *     ctrl-click is forwarded over IPC to this main process.
 *   • Main pipes it to a tiny Python injector subprocess that calls macOS
 *     CoreGraphics (ctypes, no native build) — or PyAutoGUI on Windows/Linux.
 *   • It only ever injects on YOUR machine, only after YOU clicked Allow, so
 *     there's nothing to forge — the trust is "you ran this app + granted the
 *     OS permission", exactly like Zoom/TeamViewer.
 *
 * Config: meeting server URL from argv[2] or EMPIRE_MEET_URL, default localhost.
 */

const { app, BrowserWindow, ipcMain, session, desktopCapturer, systemPreferences, dialog, shell } = require("electron");
const path = require("path");
const { spawn } = require("child_process");

// Meeting URL: CLI arg wins, then env, then the app can navigate from the landing.
const MEETING_URL = (process.argv.find((a) => /^https?:\/\//.test(a))) || process.env.EMPIRE_MEET_URL || "http://localhost:3030";

// Python discovery differs per OS (Windows usually has `py`/`python`, not `python3`).
const PY_CANDIDATES = process.env.EMPIRE_PYTHON
  ? [process.env.EMPIRE_PYTHON]
  : (process.platform === "win32" ? ["py", "python", "python3"] : ["python3", "python"]);

let win = null;
let injector = null;      // child process
let injectorReady = false;

// In a packaged app, injector.py + the agent/ dir are shipped as extraResources
// (they can't run from inside the asar). In dev they sit next to this file.
function resPaths() {
  if (app.isPackaged) {
    return {
      script: path.join(process.resourcesPath, "injector.py"),
      agentDir: path.join(process.resourcesPath, "agent"),
    };
  }
  return {
    script: path.join(__dirname, "injector.py"),
    agentDir: path.join(__dirname, "..", "agent"),
  };
}

// ── Native input injector (Python subprocess) ───────────────────────────────
function startInjector(idx = 0) {
  if (injector || idx >= PY_CANDIDATES.length) {
    if (!injector && idx >= PY_CANDIDATES.length) {
      console.error("[main] no Python found; real control unavailable. Tried:", PY_CANDIDATES.join(", "));
    }
    return;
  }
  const { script, agentDir } = resPaths();
  const py = PY_CANDIDATES[idx];
  let child;
  try {
    child = spawn(py, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, EMPIRE_AGENT_DIR: agentDir },
    });
  } catch {
    return startInjector(idx + 1);
  }
  // If this Python isn't found, spawn emits 'error'; fall through to the next.
  child.on("error", () => { if (!injectorReady) { injector = null; startInjector(idx + 1); } });
  child.stdout.on("data", (d) => {
    const s = d.toString().trim();
    if (s) console.log("[injector]", s);
    if (s.includes("READY")) injectorReady = true;
  });
  child.stderr.on("data", (d) => console.error("[injector:err]", d.toString().trim()));
  child.on("exit", (code) => {
    console.log("[main] injector exited", code);
    injector = null; injectorReady = false;
  });
  injector = child;
}

function sendToInjector(line) {
  if (!injector || !injector.stdin.writable) return;
  try { injector.stdin.write(line + "\n"); } catch {}
}

// ── Renderer → native bridge ─────────────────────────────────────────────────
ipcMain.on("native-inject", (_e, cmd) => {
  if (!cmd || typeof cmd.x !== "number" || typeof cmd.y !== "number") return;
  const x = Math.max(0, Math.min(1, cmd.x)).toFixed(5);
  const y = Math.max(0, Math.min(1, cmd.y)).toFixed(5);
  if (cmd.kind === "move") sendToInjector(`M ${x} ${y}`);
  else if (cmd.kind === "click") sendToInjector(`C ${x} ${y}`);
});

ipcMain.handle("native-status", () => ({
  injector: !!injector,
  ready: injectorReady,
  platform: process.platform,
  accessibility: process.platform === "darwin"
    ? systemPreferences.isTrustedAccessibilityClient(false)
    : true,
}));

// Let the renderer (or a button) trigger the macOS Accessibility prompt.
ipcMain.handle("native-request-accessibility", () => {
  if (process.platform !== "darwin") return true;
  const trusted = systemPreferences.isTrustedAccessibilityClient(true); // true = prompt
  if (!trusted) {
    shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
  }
  return trusted;
});

// ── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: "#0b0b12",
    title: "Empire Meet",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const ses = win.webContents.session;

  // Auto-grant camera / mic / screen prompts (this is a first-party meeting app).
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(["media", "display-capture", "audioCapture", "videoCapture"].includes(permission));
  });

  // Screen share: hand getDisplayMedia the primary screen (whole screen → so
  // remote-control coordinates map to the full display).
  if (ses.setDisplayMediaRequestHandler) {
    ses.setDisplayMediaRequestHandler((_request, callback) => {
      desktopCapturer.getSources({ types: ["screen"] }).then((sources) => {
        callback(sources.length ? { video: sources[0] } : {});
      }).catch(() => callback({}));
    }, { useSystemPicker: true });
  }

  win.loadURL(MEETING_URL);
  win.webContents.on("did-fail-load", (_e, code, desc) => {
    dialog.showErrorBox("Can't reach the meeting server",
      `${MEETING_URL}\n\n${desc} (${code})\n\nStart it (node server.js) or pass the tunnel URL:\n  npm start -- https://your-tunnel.trycloudflare.com`);
  });
}

app.whenReady().then(() => {
  startInjector();
  createWindow();

  // Nudge the macOS permissions up front so control "just works" later.
  if (process.platform === "darwin") {
    try {
      systemPreferences.isTrustedAccessibilityClient(true); // prompt if needed
      if (systemPreferences.getMediaAccessStatus("screen") !== "granted") {
        // Screen Recording can't be prompted programmatically; the first share
        // triggers the OS prompt. Nothing to do here but note it.
      }
    } catch {}
  }

  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("quit", () => { if (injector) try { injector.kill(); } catch {} });
