// Exposes a minimal, safe native bridge to the meeting page (room.js).
// room.js checks `window.empireDesktop?.isDesktop` and, while it is the sharer
// with control granted, calls inject() with normalized (0..1) coordinates.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("empireDesktop", {
  isDesktop: true,
  platform: process.platform,
  inject: (cmd) => ipcRenderer.send("native-inject", cmd),
  status: () => ipcRenderer.invoke("native-status"),
  requestAccessibility: () => ipcRenderer.invoke("native-request-accessibility"),
});
