/* Empire Meet — full-mesh WebRTC room + collaboration features.
   Signalling is a dumb relay: any JSON with a `to` is unicast, else broadcast,
   and the server stamps `from`. So chat / reactions / hands / screen-share
   notices / remote-control all ride the same channel — no server changes. */

const $ = (id) => document.getElementById(id);
const roomId = decodeURIComponent(location.pathname.replace(/^\/room\//, "")).split(/[?#]/)[0];
$("room-code").textContent = roomId;
$("code2").textContent = roomId;

let ws = null, selfId = null, myName = "Guest";
let localStream = null, cameraTrack = null, screenStream = null, sharing = false;
let iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

const peers = new Map(); // peerId -> { pc, name }
const raisedHands = new Set();
let handUp = false;

// Remote control state
let sharerId = null;      // whose screen is currently shared (self or a peer id)
let controllerId = null;  // who is currently controlling the share (or null)
let controllerName = "";
let amController = false;  // true if *I* was granted control
let pendingRequest = null; // { id, name } awaiting my approval (I'm the sharer)
let agentOnline = false;   // a native OS-control agent is listening in this room
let agentPin = "";         // pairing PIN (shown in the sharer's agent terminal) → real control
let grantedControllerId = null; // set ONLY by my own Allow (spoof-proof gate for native injection)
let nativeControlActive = false; // true when control is REAL (desktop app / paired agent), for the banner
const IS_DESKTOP = !!(window.empireDesktop && window.empireDesktop.isDesktop); // Empire Meet desktop app

const AVATAR_COLORS = ["#6d6cf6", "#22d3ee", "#f59e0b", "#34d399", "#f43f5e", "#a78bfa", "#38bdf8"];
const colorFor = (id) => AVATAR_COLORS[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
const initials = (n) => (n || "?").trim().slice(0, 2).toUpperCase();

// ── Pre-join ────────────────────────────────────────────────────────────────
async function initPreview() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    cameraTrack = localStream.getVideoTracks()[0] || null;
    $("preview").srcObject = localStream;
  } catch (e) {
    $("prejoin-err").textContent = "Couldn't access your camera/mic. You can still join to watch/listen. (" + e.name + ")";
    $("prejoin-err").hidden = false;
  }
}
$("pj-mic").addEventListener("click", () => {
  const t = localStream?.getAudioTracks()[0]; if (!t) return;
  t.enabled = !t.enabled;
  $("pj-mic").setAttribute("aria-pressed", String(t.enabled));
  $("pj-mic").textContent = t.enabled ? "🎙 Mic on" : "🔇 Mic off";
});
$("pj-cam").addEventListener("click", () => {
  const t = localStream?.getVideoTracks()[0]; if (!t) return;
  t.enabled = !t.enabled;
  $("pj-cam").setAttribute("aria-pressed", String(t.enabled));
  $("pj-cam").textContent = t.enabled ? "🎥 Cam on" : "🚫 Cam off";
  $("preview-off").hidden = t.enabled;
});
$("name").addEventListener("keydown", (e) => { if (e.key === "Enter") joinMeeting(); });
$("join").addEventListener("click", joinMeeting);

// ── Join ────────────────────────────────────────────────────────────────────
async function joinMeeting() {
  $("join").disabled = true;
  myName = ($("name").value || "Guest").trim().slice(0, 60);
  try {
    const cfg = await fetch("/ice").then((r) => r.json());
    if (cfg?.iceServers?.length) iceServers = cfg.iceServers;
  } catch {}
  $("prejoin").hidden = true;
  $("call").hidden = false;
  addTile("self", myName + " (You)", localStream, true);
  renderPeople();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(myName)}`);
  ws.onmessage = onSignal;
  ws.onclose = () => toast("Disconnected");
  startSpeakingDetection();
}

function sendSignal(o) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); }

// ── Signalling ────────────────────────────────────────────────────────────
async function onSignal(ev) {
  const m = JSON.parse(ev.data);
  switch (m.type) {
    case "welcome":
      selfId = m.selfId; relabelSelfTile();
      for (const p of m.peers) await makePeer(p.id, p.name, true);
      renderPeople();
      break;
    case "room-full": toast("This meeting is full."); break;
    case "peer-joined":
      if (!peers.has(m.id)) peers.set(m.id, { pc: null, name: m.name });
      // Bring late-joiners up to speed on state they missed.
      if (sharing) sendSignal({ type: "sharing", on: true, to: m.id });
      if (handUp) sendSignal({ type: "hand", up: true, to: m.id });
      renderPeople();
      break;
    case "offer": {
      const pc = (await makePeer(m.from, m.name, false)).pc;
      await pc.setRemoteDescription(m.sdp);
      const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
      sendSignal({ type: "answer", to: m.from, sdp: pc.localDescription });
      break;
    }
    case "answer": { const p = peers.get(m.from); if (p?.pc) await p.pc.setRemoteDescription(m.sdp); break; }
    case "ice": { const p = peers.get(m.from); if (p?.pc && m.candidate) { try { await p.pc.addIceCandidate(m.candidate); } catch {} } break; }
    case "peer-left": dropPeer(m.id); break;

    // ── Collaboration ──
    case "chat": addChat(m.name, m.text, false); break;
    case "reaction": flyReaction(m.emoji); break;
    case "hand":
      if (m.up) raisedHands.add(m.from); else raisedHands.delete(m.from);
      renderPeople(); break;
    case "sharing":
      if (m.on) { sharerId = m.from; markSharing(m.from, true); toast(`${peerName(m.from)} started sharing`); }
      else { if (sharerId === m.from) sharerId = null; markSharing(m.from, false); clearControl(); }
      break;
    case "agent-status": // a native OS-control helper connected/left (from the server)
      agentOnline = !!m.online;
      if (!agentOnline) { agentPin = ""; }
      else if (sharing && !agentPin) { promptAgentPair(); }
      else if (agentOnline) { toast("A native control agent is available in this room."); }
      break;

    // ── Remote control handshake ──
    case "ctrl-request": // I'm the sharer; someone asks to control
      if (sharing) { pendingRequest = { id: m.from, name: m.name || peerName(m.from) }; showControlRequest(); }
      break;
    case "ctrl-grant": // my request was approved by the sharer
      amController = true; toast("You have control — move over their shared screen"); enableControllerInput(m.from);
      setControlBtn(true); removeTileControlBtn(m.from);
      break;
    case "ctrl-deny": toast("Control request was declined"); break;
    case "ctrl-active": // sharer announces who controls (broadcast)
      controllerId = m.controllerId; controllerName = m.controllerName || "";
      nativeControlActive = !!m.native; // sharer told us whether it's real OS control
      updateControlBanner();
      break;
    case "ctrl-move":
      if (m.from === controllerId) moveRemoteCursor(m.x, m.y);
      if (canNativelyInject(m.from)) window.empireDesktop.inject({ kind: "move", x: m.x, y: m.y });
      break;
    case "ctrl-click":
      if (m.from === controllerId) rippleRemoteCursor(m.x, m.y);
      if (canNativelyInject(m.from)) window.empireDesktop.inject({ kind: "click", x: m.x, y: m.y });
      break;
    case "ctrl-revoke":
      amController = false; disableControllerInput(); setControlBtn(false); toast("Control was revoked");
      if (sharerId && sharerId !== selfId) addTileControlBtn(sharerId);
      break;
    case "ctrl-release": // the controller gave up control (I'm the sharer)
      if (sharing && m.from === controllerId) clearControl();
      break;
  }
}

async function makePeer(peerId, name, initiator) {
  let e = peers.get(peerId);
  if (e?.pc) return e;
  const pc = new RTCPeerConnection({ iceServers });
  e = { pc, name: name || e?.name || "Guest" };
  peers.set(peerId, e);

  if (localStream) {
    for (const t of localStream.getAudioTracks()) pc.addTrack(t, localStream);
    const vid = sharing && screenStream ? screenStream.getVideoTracks()[0] : cameraTrack;
    if (vid) pc.addTrack(vid, localStream);
  }
  const remote = new MediaStream();
  addTile(peerId, e.name, remote, false);
  pc.ontrack = (ev2) => {
    remote.addTrack(ev2.track);
    const v = document.querySelector(`#tile-${cssId(peerId)} video`);
    if (v && v.srcObject !== remote) v.srcObject = remote;
    attachSpeaking(peerId, remote);
  };
  pc.onicecandidate = (ev2) => { if (ev2.candidate) sendSignal({ type: "ice", to: peerId, candidate: ev2.candidate }); };
  if (initiator) {
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    sendSignal({ type: "offer", to: peerId, name: myName, sdp: pc.localDescription });
  }
  return e;
}
function dropPeer(id) {
  const p = peers.get(id); if (p?.pc) { try { p.pc.close(); } catch {} }
  peers.delete(id); raisedHands.delete(id);
  if (sharerId === id) { sharerId = null; clearControl(); }
  removeTile(id); renderPeople();
}
const peerName = (id) => (id === selfId ? myName : peers.get(id)?.name || "Someone");

// ── Media controls ──────────────────────────────────────────────────────────
$("mic").addEventListener("click", () => {
  const t = localStream?.getAudioTracks()[0]; if (!t) return;
  t.enabled = !t.enabled; $("mic").classList.toggle("off", !t.enabled);
  $("mic").firstElementChild.textContent = t.enabled ? "🎙" : "🔇";
});
$("cam").addEventListener("click", () => {
  if (!cameraTrack) return;
  cameraTrack.enabled = !cameraTrack.enabled; $("cam").classList.toggle("off", !cameraTrack.enabled);
  $("cam").firstElementChild.textContent = cameraTrack.enabled ? "🎥" : "🚫";
});
$("screen").addEventListener("click", () => (sharing ? stopScreen() : startScreen()));
$("control").addEventListener("click", () => {
  if (amController) {
    sendSignal({ type: "ctrl-release", to: sharerId });
    amController = false; disableControllerInput(); setControlBtn(false);
    toast("You released control"); return;
  }
  if (sharing) {
    if (agentOnline && !agentPin) { promptAgentPair(); return; }
    toast("You're sharing — a viewer taps Control (or the button on your screen) to request access, then you approve."); return;
  }
  if (sharerId && sharerId !== selfId) { requestControl(sharerId); return; }
  toast("No one is sharing a screen yet. Ask someone to tap Share, then you can request control of it.");
});
function setControlBtn(active) {
  $("control").classList.toggle("on", active);
  $("control").querySelector(".lbl").textContent = active ? "Release" : "Control";
}
$("leave").addEventListener("click", () => (location.href = "/"));
$("copy").addEventListener("click", async () => { try { await navigator.clipboard.writeText(location.href); toast("Link copied"); } catch {} });

// ── Screen share ──────────────────────────────────────────────────────────
async function startScreen() {
  let ds; try { ds = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }); } catch { return; }
  screenStream = ds; const track = ds.getVideoTracks()[0]; sharing = true; sharerId = selfId;
  $("screen").classList.add("on");
  replaceVideoEverywhere(track);
  setLocalTileTrack(track, false);
  markSharing(selfId, true);
  sendSignal({ type: "sharing", on: true });
  toast("You're sharing your screen");
  if (agentOnline && !agentPin) setTimeout(promptAgentPair, 500); // offer real control
  track.onended = stopScreen;
}
function stopScreen() {
  if (!sharing) return;
  sharing = false; $("screen").classList.remove("on");
  if (screenStream) { screenStream.getTracks().forEach((t) => t.stop()); screenStream = null; }
  if (cameraTrack) { replaceVideoEverywhere(cameraTrack); setLocalTileTrack(cameraTrack, true); }
  markSharing(selfId, false);
  sendSignal({ type: "sharing", on: false });
  clearControl(); // revokes any active control of my screen
}
function replaceVideoEverywhere(track) {
  for (const { pc } of peers.values()) {
    if (!pc) continue;
    const s = pc.getSenders().find((x) => x.track && x.track.kind === "video");
    if (s) s.replaceTrack(track).catch(() => {});
  }
}
function setLocalTileTrack(track, isCamera) {
  const tile = document.getElementById(`tile-${cssId(selfId || "self")}`);
  const v = tile?.querySelector("video");
  if (v) v.srcObject = new MediaStream([track]);
  tile?.classList.toggle("is-camera", !!isCamera);
}

// ── Remote control (permission-gated) ───────────────────────────────────────
// I request control of the peer who is sharing.
function requestControl(targetSharerId) {
  sendSignal({ type: "ctrl-request", to: targetSharerId, name: myName });
  toast("Control requested — waiting for approval…");
}
// I'm the sharer: approve/deny an incoming request.
function showControlRequest() {
  if (!pendingRequest) return;
  const req = pendingRequest; // capture — don't rely on the global at click time
  document.getElementById("ctrl-req-modal")?.remove(); // dedupe any stale modal
  const scrim = document.createElement("div");
  scrim.className = "modal-scrim"; scrim.id = "ctrl-req-modal";
  scrim.innerHTML = `<div class="modal">
    <h3>Allow remote control?</h3>
    <p><b>${escapeHtml(req.name)}</b> is asking to control your shared screen. They'll be able to point and click on what you're sharing (a live guided cursor — it won't move your own mouse).</p>
    <div class="modal-actions"><button class="btn" data-act="deny">Deny</button><button class="btn btn-primary" data-act="allow">Allow</button></div>
  </div>`;
  document.body.appendChild(scrim);
  scrim.querySelector('[data-act="allow"]').addEventListener("click", () => {
    grantControl(req.id, req.name); scrim.remove(); if (pendingRequest === req) pendingRequest = null;
  });
  scrim.querySelector('[data-act="deny"]').addEventListener("click", () => {
    sendSignal({ type: "ctrl-deny", to: req.id }); scrim.remove(); if (pendingRequest === req) pendingRequest = null;
  });
  toast(`${req.name} is requesting control of your screen`);
}
// Native OS injection is allowed ONLY when: I'm running the desktop app, I am
// the one sharing, and the signal comes from the exact peer I personally
// approved (grantedControllerId is set locally by grantControl — a remote peer
// cannot set or spoof it, so no forged ctrl-active can enable real control).
function canNativelyInject(fromId) {
  return IS_DESKTOP && sharing && sharerId === selfId &&
         grantedControllerId && fromId === grantedControllerId;
}
function grantControl(id, name) {
  controllerId = id; controllerName = name; grantedControllerId = id;
  // Real control is live if I'm in the desktop app (in-process injector) OR a
  // PIN-paired native agent is attached.
  nativeControlActive = (IS_DESKTOP && sharing && sharerId === selfId) || !!agentPin;
  sendSignal({ type: "ctrl-grant", to: id });
  // pin is only known to the sharer (printed in their agent's terminal); it
  // authorises the native agent to inject REAL input. Forged grants lack it.
  sendSignal({ type: "ctrl-active", controllerId: id, controllerName: name, pin: agentPin, native: nativeControlActive }); // tell everyone
  updateControlBanner();
}
function clearControl() {
  if (controllerId) sendSignal({ type: "ctrl-revoke", to: controllerId });
  const wasActive = controllerId || amController;
  controllerId = null; controllerName = ""; amController = false; grantedControllerId = null;
  nativeControlActive = false;
  disableControllerInput();
  if (wasActive) sendSignal({ type: "ctrl-active", controllerId: null, pin: agentPin, native: false });
  removeRemoteCursor(); updateControlBanner();
}
// The sharer pairs a native control agent by typing the PIN it printed in their
// terminal. Only someone who can see that terminal (i.e. the sharer) knows it,
// so no meeting participant can promote themselves to real control.
function promptAgentPair() {
  if (agentPin) { toast("Native control already paired."); return; }
  document.getElementById("agent-pair-modal")?.remove();
  const scrim = document.createElement("div");
  scrim.className = "modal-scrim"; scrim.id = "agent-pair-modal";
  scrim.innerHTML = `<div class="modal">
    <h3>Enable real remote control</h3>
    <p>A native control agent is running for this room. Enter the <b>pairing PIN</b> it printed in your terminal to let an approved participant actually move your mouse &amp; keyboard.</p>
    <input id="agent-pin-input" class="input" placeholder="Pairing PIN" autocomplete="off" maxlength="12" />
    <div class="modal-actions"><button class="btn" data-act="skip">Skip (guided pointer only)</button><button class="btn btn-primary" data-act="pair">Pair</button></div>
  </div>`;
  document.body.appendChild(scrim);
  const input = scrim.querySelector("#agent-pin-input");
  input.focus();
  const pair = () => {
    const v = (input.value || "").trim();
    if (!v) { input.focus(); return; }
    agentPin = v; scrim.remove();
    toast("Native control paired — approved participants can now really control this machine.");
    // if control is already active, re-send the grant carrying the pin
    if (controllerId) sendSignal({ type: "ctrl-active", controllerId, controllerName, pin: agentPin });
    updateControlBanner();
  };
  scrim.querySelector('[data-act="pair"]').addEventListener("click", pair);
  scrim.querySelector('[data-act="skip"]').addEventListener("click", () => scrim.remove());
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") pair(); });
}
function updateControlBanner() {
  let b = $("control-banner");
  const active = controllerId && sharerId;
  if (!active) { b?.remove(); return; }
  if (!b) {
    b = document.createElement("div"); b.className = "control-banner"; b.id = "control-banner";
    document.body.appendChild(b);
  }
  const iAmSharer = sharerId === selfId;
  const realControl = agentPin || nativeControlActive || (IS_DESKTOP && iAmSharer);
  const mode = realControl ? " · real control" : " · guided pointer";
  b.innerHTML = `🕹 <span><b>${escapeHtml(controllerName || peerName(controllerId))}</b> is controlling the shared screen<small style="opacity:.7">${mode}</small></span>`;
  if (iAmSharer) {
    const stop = document.createElement("button"); stop.className = "btn btn-sm"; stop.textContent = "Stop";
    stop.onclick = clearControl; b.appendChild(stop);
  }
}
// Controller side: relay my pointer over the shared tile.
let ctrlMoveThrottle = 0;
function enableControllerInput(targetSharerId) {
  const tile = document.getElementById(`tile-${cssId(targetSharerId)}`);
  if (!tile) return;
  tile.classList.add("controllable");
  tile._onMove = (e) => {
    const now = performance.now(); if (now - ctrlMoveThrottle < 40) return; ctrlMoveThrottle = now;
    const r = tile.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    sendSignal({ type: "ctrl-move", x, y });
    moveRemoteCursor(x, y, targetSharerId); // local echo: the controller sees their own guided cursor
  };
  tile._onClick = (e) => {
    const r = tile.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    sendSignal({ type: "ctrl-click", x, y });
    rippleRemoteCursor(x, y, targetSharerId); // local echo
  };
  tile.addEventListener("pointermove", tile._onMove);
  tile.addEventListener("click", tile._onClick);
}
function disableControllerInput() {
  document.querySelectorAll(".controllable").forEach((tile) => {
    tile.classList.remove("controllable");
    if (tile._onMove) tile.removeEventListener("pointermove", tile._onMove);
    if (tile._onClick) tile.removeEventListener("click", tile._onClick);
  });
}
// Everyone: render the controller's cursor on the sharer's tile.
function rcLayer(forId) {
  const sid = forId || sharerId;
  if (!sid) return null;
  const tile = document.getElementById(`tile-${cssId(sid)}`);
  if (!tile) return null;
  let layer = tile.querySelector(".rc-layer");
  if (!layer) { layer = document.createElement("div"); layer.className = "rc-layer"; tile.appendChild(layer); }
  return layer;
}
function moveRemoteCursor(x, y, forId) {
  const layer = rcLayer(forId); if (!layer) return;
  let cur = layer.querySelector(".rc-cursor-wrap");
  if (!cur) {
    cur = document.createElement("div"); cur.className = "rc-cursor-wrap"; cur.style.position = "absolute";
    cur.innerHTML = `<svg class="rc-cursor" viewBox="0 0 24 24" fill="#6d6cf6" stroke="#fff" stroke-width="1.5"><path d="M4 2l7 18 2.5-7.5L21 10z"/></svg><span class="rc-label">${escapeHtml(controllerName || "Controller")}</span>`;
    layer.appendChild(cur);
  }
  cur.style.left = (x * 100) + "%"; cur.style.top = (y * 100) + "%";
}
function rippleRemoteCursor(x, y, forId) {
  const layer = rcLayer(forId); if (!layer) return;
  const rip = document.createElement("div"); rip.className = "rc-ripple";
  rip.style.left = (x * 100) + "%"; rip.style.top = (y * 100) + "%";
  layer.appendChild(rip); setTimeout(() => rip.remove(), 620);
}
function removeRemoteCursor() { document.querySelectorAll(".rc-layer").forEach((l) => (l.innerHTML = "")); }

// ── Chat ────────────────────────────────────────────────────────────────────
$("chat-send").addEventListener("click", sendChat);
$("chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
function sendChat() {
  const text = $("chat-input").value.trim(); if (!text) return;
  $("chat-input").value = "";
  sendSignal({ type: "chat", name: myName, text });
  addChat(myName + " (You)", text, true);
}
function addChat(name, text, mine) {
  const wrap = document.createElement("div"); wrap.className = "chat-msg";
  wrap.innerHTML = `<div class="who" style="${mine ? "color:#93e9f7" : ""}">${escapeHtml(name)}</div><div class="txt">${escapeHtml(text)}</div>`;
  $("tab-chat").appendChild(wrap);
  $("tab-chat").scrollTop = $("tab-chat").scrollHeight;
  if ($("tab-chat").hidden) { unread++; updateChatBadge(); }
}
let unread = 0;
function updateChatBadge() {
  const lbl = $("chat-toggle").querySelector(".lbl");
  lbl.textContent = unread > 0 ? `Chat (${unread})` : "Chat";
}

// ── Reactions + hand ─────────────────────────────────────────────────────────
$("react").addEventListener("click", () => { $("react-pop").hidden = !$("react-pop").hidden; });
$("react-pop").addEventListener("click", (e) => {
  if (e.target.id === "react-pop") { $("react-pop").hidden = true; return; }
  const emoji = e.target.getAttribute("data-e"); if (!emoji) return;
  $("react-pop").hidden = true;
  sendSignal({ type: "reaction", emoji, name: myName }); flyReaction(emoji);
});
function flyReaction(emoji) {
  const el = document.createElement("div"); el.className = "floater"; el.textContent = emoji;
  el.style.left = (30 + Math.random() * 40) + "%";
  document.body.appendChild(el); setTimeout(() => el.remove(), 2600);
}
$("hand").addEventListener("click", () => {
  handUp = !handUp; $("hand").classList.toggle("on", handUp);
  if (handUp) raisedHands.add(selfId); else raisedHands.delete(selfId);
  sendSignal({ type: "hand", up: handUp });
  renderPeople();
});

// ── Panel (people / chat tabs + toggles) ─────────────────────────────────────
function openPanel(tab) {
  $("panel").hidden = false;
  document.querySelectorAll(".panel-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  $("tab-people").hidden = tab !== "people";
  $("tab-chat").hidden = tab !== "chat";
  $("chat-input-row").hidden = tab !== "chat";
  if (tab === "chat") { unread = 0; updateChatBadge(); }
}
document.querySelectorAll(".panel-tab").forEach((t) => t.addEventListener("click", () => openPanel(t.dataset.tab)));
$("chat-toggle").addEventListener("click", () => (($("panel").hidden || $("tab-chat").hidden) ? openPanel("chat") : ($("panel").hidden = true)));
$("people-toggle").addEventListener("click", () => (($("panel").hidden || $("tab-people").hidden) ? openPanel("people") : ($("panel").hidden = true)));

function renderPeople() {
  const el = $("tab-people"); if (!el) return;
  const all = [{ id: selfId || "self", name: myName + " (You)" }, ...[...peers.entries()].map(([id, p]) => ({ id, name: p.name }))];
  el.innerHTML = "";
  for (const p of all) {
    const isSharer = sharerId && (p.id === sharerId || (p.id.includes("self") && sharerId === selfId));
    const row = document.createElement("div"); row.className = "p-person";
    row.innerHTML = `<span class="avatar" style="background:${colorFor(p.id)}">${initials(p.name)}</span>
      <span class="p-name">${escapeHtml(p.name)}${isSharer ? ' <span class="p-meta">· sharing</span>' : ""}</span>
      ${raisedHands.has(p.id) ? '<span class="p-hand">✋</span>' : ""}`;
    // "Request control" affordance: only for a peer who is sharing, and only if I'm not them / not already controlling
    if (sharerId && p.id === sharerId && sharerId !== selfId && !amController) {
      const b = document.createElement("button"); b.className = "btn btn-sm"; b.textContent = "🕹 Control";
      b.onclick = () => requestControl(sharerId);
      row.appendChild(b);
    }
    el.appendChild(row);
  }
}

// ── Tiles / grid ─────────────────────────────────────────────────────────────
function cssId(id) { return String(id).replace(/[^a-z0-9_-]/gi, ""); }
function addTile(id, name, stream, isLocal) {
  const gid = cssId(id);
  if (document.getElementById(`tile-${gid}`)) return;
  const tile = document.createElement("div"); tile.className = "tile is-camera"; tile.id = `tile-${gid}`;
  const video = document.createElement("video"); video.autoplay = true; video.playsInline = true;
  if (isLocal) video.muted = true;
  if (stream) video.srcObject = stream;
  const label = document.createElement("span"); label.className = "tile-name"; label.textContent = name;
  const badges = document.createElement("div"); badges.className = "tile-badges";
  const fs = document.createElement("button");
  fs.className = "tile-fs-btn"; fs.title = "Fullscreen"; fs.textContent = "⛶";
  fs.onclick = (e) => { e.stopPropagation(); toggleTileFullscreen(tile); };
  tile.append(video, label, badges, fs);
  tile.addEventListener("dblclick", () => toggleTileFullscreen(tile));
  $("grid").appendChild(tile); layoutGrid();
}
function toggleTileFullscreen(tile) {
  if (!tile) return;
  if (document.fullscreenElement === tile) { document.exitFullscreen?.(); return; }
  (tile.requestFullscreen || tile.webkitRequestFullscreen)?.call(tile).catch(() => {});
}
function removeTile(id) { document.getElementById(`tile-${cssId(id)}`)?.remove(); layoutGrid(); }
function relabelSelfTile() { const old = document.getElementById("tile-self"); if (old && selfId) old.id = `tile-${cssId(selfId)}`; }
function markSharing(id, on) {
  const tile = document.getElementById(`tile-${cssId(id === selfId ? (selfId || "self") : id)}`);
  if (!tile) { renderPeople(); return; }
  tile.classList.toggle("sharing-tile", on);
  tile.classList.toggle("is-camera", !on);
  let badge = tile.querySelector(".sharing-badge");
  if (on && !badge) { badge = document.createElement("div"); badge.className = "tile-badge sharing-badge"; badge.textContent = "🖥"; tile.querySelector(".tile-badges").appendChild(badge); }
  if (!on && badge) badge.remove();
  if (!on) { const l = tile.querySelector(".rc-layer"); if (l) l.innerHTML = ""; }
  if (on && id !== selfId && !amController) addTileControlBtn(id);
  if (!on) removeTileControlBtn(id);
  renderPeople();
}
function addTileControlBtn(id) {
  const tile = document.getElementById(`tile-${cssId(id)}`);
  if (!tile || tile.querySelector(".tile-ctrl-btn")) return;
  const b = document.createElement("button");
  b.className = "btn btn-sm tile-ctrl-btn"; b.textContent = "🕹 Request control";
  b.onclick = (e) => { e.stopPropagation(); requestControl(id); };
  tile.appendChild(b);
}
function removeTileControlBtn(id) {
  document.getElementById(`tile-${cssId(id)}`)?.querySelector(".tile-ctrl-btn")?.remove();
}
function layoutGrid() {
  const n = $("grid").children.length; $("count").textContent = String(n);
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  $("grid").style.setProperty("--cols", cols);
}

// ── Active-speaker detection (lightweight RMS) ────────────────────────────────
let audioCtx = null;
const analysers = new Map(); // tileId -> analyser
function startSpeakingDetection() {
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
  if (localStream) attachSpeaking(selfId || "self", localStream);
  setInterval(() => {
    let loudest = null, max = 0;
    for (const [tid, an] of analysers) {
      const buf = new Uint8Array(an.frequencyBinCount); an.getByteTimeDomainData(buf);
      let sum = 0; for (const v of buf) sum += (v - 128) * (v - 128);
      const rms = Math.sqrt(sum / buf.length);
      if (rms > max) { max = rms; loudest = tid; }
    }
    document.querySelectorAll(".tile.speaking").forEach((t) => t.classList.remove("speaking"));
    if (loudest && max > 6) document.getElementById(`tile-${cssId(loudest)}`)?.classList.add("speaking");
  }, 350);
}
function attachSpeaking(id, stream) {
  if (!audioCtx || !stream.getAudioTracks().length) return;
  const key = id === (selfId || "self") ? (selfId || "self") : id;
  if (analysers.has(key)) return;
  try {
    const src = audioCtx.createMediaStreamSource(stream);
    const an = audioCtx.createAnalyser(); an.fftSize = 512; src.connect(an);
    analysers.set(key, an);
  } catch {}
}

// ── utils ─────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(t) { const el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), 2600); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

initPreview();
