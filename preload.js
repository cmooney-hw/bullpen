const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("board", {
  onState: cb => ipcRenderer.on("state", (_e, s) => cb(s)),
  onSetupMessage: cb => ipcRenderer.on("setup-message", (_e, m) => cb(m)),
  openBoard: () => ipcRenderer.send("open-board"),
  openSetup: () => ipcRenderer.send("open-setup"),
  hide: () => ipcRenderer.send("hide-widget"),
  refresh: () => ipcRenderer.send("refresh-now"),
  setTheme: t => ipcRenderer.send("set-theme", t),
  installUpdate: () => ipcRenderer.send("install-update"),
  setTv: on => ipcRenderer.send("set-tv", !!on),
  tvDragStart: (fx, fy) => ipcRenderer.send("tv-drag-start", { fx, fy }),
  dragMove: () => ipcRenderer.send("drag-move"),
  dragEnd: () => ipcRenderer.send("drag-end"),
  onTv: cb => ipcRenderer.on("tv", (_e, on) => cb(on)),
  recapOpened: () => ipcRenderer.send("recap-opened"),
  onTick: cb => ipcRenderer.on("tick", (_e, t) => cb(t)),
  onAlert: cb => ipcRenderer.on("alert", (_e, a) => cb(a)),
  onShowRecap: cb => ipcRenderer.on("show-recap", () => cb()),
  saveCreds: (key, secret) => ipcRenderer.invoke("save-creds", { key, secret })
});
