/**
 * Empire Meet — standalone multi-party video meeting server.
 *
 * Two jobs:
 *   1. Serve the static landing + room pages (public/).
 *   2. A tiny WebSocket signalling relay for full-mesh WebRTC.
 *
 * A "meeting" is just a room id in the URL — the host generates a link on the
 * landing page and shares it; anyone who opens it joins. No accounts, no DB.
 * Media flows peer-to-peer (optionally via TURN); this server only relays the
 * SDP offers/answers + ICE candidates, addressed peer-to-peer by id.
 *
 * Deliberately dependency-light (Node http + `ws`) so it runs anywhere and
 * tunnels cleanly — it is NOT coupled to the recruitment stack.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 3030);
const MAX_PEERS = Number(process.env.MAX_PEERS || 16); // full-mesh gets heavy past this
const PUBLIC_DIR = path.join(__dirname, "public");

// ── ICE servers (STUN always; Twilio TURN if creds are set) ─────────────────
const TWILIO_SID = (process.env.TWILIO_ACCOUNT_SID || "").trim();
const TWILIO_TOKEN = (process.env.TWILIO_AUTH_TOKEN || "").trim();
const STATIC_ICE = [{ urls: "stun:stun.l.google.com:19302" }];
let iceCache = { at: 0, servers: STATIC_ICE };

async function getIceServers() {
  if (!TWILIO_SID || !TWILIO_TOKEN) return STATIC_ICE;
  // Twilio NTS tokens last ~24h; cache for an hour.
  if (Date.now() - iceCache.at < 3600_000) return iceCache.servers;
  try {
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Tokens.json`,
      { method: "POST", headers: { Authorization: `Basic ${auth}` } },
    );
    const data = await res.json();
    if (Array.isArray(data.ice_servers)) {
      // Twilio returns {url|urls, username, credential}
      const servers = data.ice_servers.map((s) => ({
        urls: s.urls || s.url,
        username: s.username,
        credential: s.credential,
      }));
      iceCache = { at: Date.now(), servers };
      return servers;
    }
  } catch (e) {
    console.warn("[ice] Twilio token fetch failed, using STUN only:", e.message);
  }
  return STATIC_ICE;
}

// ── Static file serving ─────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

// Scan public/downloads and classify installers by platform so the download
// page can show live buttons for what's built and "coming soon" for the rest.
function listDownloads() {
  const dir = path.join(PUBLIC_DIR, "downloads");
  const out = { mac: [], win: [], linux: [] };
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return out; }
  for (const name of files) {
    const lower = name.toLowerCase();
    if (lower.endsWith(".blockmap")) continue; // updater sidecar, not a download
    let bucket = null;
    if (lower.endsWith(".dmg")) bucket = "mac";
    else if (lower.endsWith(".exe")) bucket = "win";
    else if (lower.endsWith(".appimage")) bucket = "linux";
    else if (lower.endsWith(".zip") && lower.includes("mac")) bucket = "mac";
    else if (lower.endsWith(".zip") && lower.includes("win")) bucket = "win";
    if (!bucket) continue;
    let size = 0;
    try { size = fs.statSync(path.join(dir, name)).size; } catch {}
    const arch = lower.includes("arm64") ? "Apple Silicon" : lower.includes("x64") || lower.includes("x86_64") ? "Intel/x64" : "";
    out[bucket].push({ name, url: `/downloads/${encodeURIComponent(name)}`, size, arch });
  }
  return out;
}

function sendFile(res, file, status = 200) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(status, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname === "/ice") {
    const servers = await getIceServers();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ iceServers: servers }));
    return;
  }
  // New meeting: mint a room id and hand it back (host copies/opens the link).
  if (pathname === "/api/new-meeting") {
    const id = newRoomId();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id, path: `/room/${id}` }));
    return;
  }
  // Which desktop installers are actually built + available to download.
  if (pathname === "/api/downloads") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(listDownloads()));
    return;
  }
  // /room/<id> → the room shell (id read client-side from the path).
  if (pathname.startsWith("/room/")) {
    sendFile(res, path.join(PUBLIC_DIR, "room.html"));
    return;
  }
  if (pathname === "/" || pathname === "/index.html") {
    sendFile(res, path.join(PUBLIC_DIR, "index.html"));
    return;
  }
  // Static assets, path-traversal-guarded.
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  // Installer downloads: force a save dialog with the real filename.
  if (pathname.startsWith("/downloads/")) {
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end("Not found"); return; }
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${path.basename(file)}"`,
        "Content-Length": buf.length,
      });
      res.end(buf);
    });
    return;
  }
  sendFile(res, file);
});

// ── WebSocket signalling ────────────────────────────────────────────────────
// rooms:  roomId -> Map(peerId -> { ws, name })
// agents: roomId -> Set(ws)   native OS-control helpers (silent, non-participant)
const rooms = new Map();
const agents = new Map();
const wss = new WebSocketServer({ server, path: "/ws" });

function agentsIn(roomId) {
  return agents.get(roomId) || null;
}

function newRoomId() {
  // Human-ish, url-safe (e.g. "kx7m-9p2q-a3zt")
  const s = crypto.randomBytes(9).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

function othersInRoom(room, peerId) {
  return [...room.entries()].filter(([id]) => id !== peerId);
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = (url.searchParams.get("room") || "").trim();
  const name = (url.searchParams.get("name") || "Guest").slice(0, 60);
  const role = (url.searchParams.get("role") || "peer").trim();
  if (!roomId) {
    ws.close(4400, "missing room");
    return;
  }

  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  const room = rooms.get(roomId);

  // ── Native OS-control agent ────────────────────────────────────────────────
  // A helper running on the sharer's own machine. It is NOT a meeting
  // participant: it doesn't appear in the grid/People, isn't counted, and
  // never gets media. It only listens for the same broadcast control signals
  // (ctrl-active / ctrl-move / ctrl-click) the browser overlay uses, and turns
  // them into real OS mouse/keyboard input — gated by the very same permission
  // handshake (it injects nothing until the sharer clicks Allow).
  if (role === "agent") {
    if (!agents.has(roomId)) agents.set(roomId, new Set());
    agents.get(roomId).add(ws);
    send(ws, { type: "welcome-agent", room: roomId });
    for (const [, p] of room) send(p.ws, { type: "agent-status", online: true });
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      msg.from = "agent";
      for (const [, p] of room) send(p.ws, msg); // agent -> participants (status etc.)
    });
    const bye = () => {
      const set = agents.get(roomId);
      if (set) { set.delete(ws); if (!set.size) agents.delete(roomId); }
      const r = rooms.get(roomId);
      if (r) for (const [, p] of r) send(p.ws, { type: "agent-status", online: false });
    };
    ws.on("close", bye);
    ws.on("error", bye);
    return;
  }

  if (room.size >= MAX_PEERS) {
    send(ws, { type: "room-full" });
    ws.close(4403, "room full");
    return;
  }

  const peerId = crypto.randomBytes(8).toString("hex");
  const existing = [...room.entries()].map(([id, p]) => ({ id, name: p.name }));
  room.set(peerId, { ws, name });

  // Newcomer learns its id + who's already here (it will initiate offers to them).
  send(ws, { type: "welcome", selfId: peerId, name, peers: existing });
  // If a native control agent is already listening, let the newcomer know.
  if (agentsIn(roomId)?.size) send(ws, { type: "agent-status", online: true });
  // Everyone else is told a peer joined.
  for (const [, p] of othersInRoom(room, peerId)) {
    send(p.ws, { type: "peer-joined", id: peerId, name });
  }

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    msg.from = peerId; // stamp sender so peers know who to answer
    const target = msg.to;
    if (target) {
      const t = room.get(target);
      if (t) send(t.ws, msg);
    } else {
      for (const [, p] of othersInRoom(room, peerId)) send(p.ws, msg);
      // Broadcasts (ctrl-active / ctrl-move / ctrl-click …) also feed any agent.
      const set = agentsIn(roomId);
      if (set) for (const a of set) send(a, msg);
    }
  });

  const leave = () => {
    room.delete(peerId);
    for (const [, p] of room) send(p.ws, { type: "peer-left", id: peerId });
    if (room.size === 0) rooms.delete(roomId);
  };
  ws.on("close", leave);
  ws.on("error", leave);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Empire Meet on http://0.0.0.0:${PORT}  (TURN: ${TWILIO_SID ? "Twilio" : "STUN-only"})`);
});
