// Bullpen desktop widget: today's JustCall Sales Dialer numbers, live, on the Windows desktop.
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, screen, safeStorage, powerMonitor, nativeImage, Notification } = require("electron");
const path = require("path");
const fs = require("fs");
const { REPS } = require("./logic");
let autoUpdater = null; try { autoUpdater = require("electron-updater").autoUpdater; } catch (_) {}

const BOARD_URL = "https://claude.ai/artifact/6Jd2KCKpXAcM4nqeizhzGt";

if (!app.requestSingleInstanceLock()) { app.quit(); }
// Renamed from "Call Board": carry over the saved API key and window spot so nothing has to be set up again
function migrateFromCallBoard() {
  try {
    const oldDir = path.join(app.getPath("appData"), "Call Board"), newDir = app.getPath("userData");
    if (oldDir === newDir || !fs.existsSync(oldDir)) return;
    fs.mkdirSync(newDir, { recursive: true });
    for (const f of ["justcall.key", "window.json"]) {
      const from = path.join(oldDir, f), to = path.join(newDir, f);
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to);
    }
  } catch (_) {}
}
app.setAppUserModelId("com.wearehighwater.callboard");

const dataDir = () => app.getPath("userData");
const credFile = () => path.join(dataDir(), "justcall.key");
const stateFile = () => path.join(dataDir(), "window.json");

let widget = null, setupWin = null, tray = null;
let alertPrefs = { popup: true, toast: true };

/* ---------------- credentials (encrypted with Windows' own protection) ---------------- */
function loadCreds() {
  try {
    const buf = fs.readFileSync(credFile());
    const txt = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString("utf8");
    const c = JSON.parse(txt);
    return c && (c.code || (c.key && c.secret)) ? c : null;
  } catch (_) { return null; }
}
function saveCreds(c) {
  const txt = JSON.stringify(c);
  const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(txt) : Buffer.from(txt, "utf8");
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(credFile(), buf);
}

/* ---------------- Bullpen server: the shared brain every screen reads from ---------------- */
const SERVER = process.env.BULLPEN_SERVER || "https://bullpen-server-production.up.railway.app";
const WS = require("ws");
let sock = null, state = null, wsTimer = null, connected = false, lastMsgAt = 0;
let serverStatus = "connecting"; // connecting | live | needs-code | offline
const REP_IDS = new Set(REPS.map(r => r.id));
const startedAt = Date.now();

function accessCode() { const c = loadCreds(); return c && c.code ? c.code : null; }
function connect() {
  clearTimeout(wsTimer);
  const code = accessCode();
  if (!code) { serverStatus = "needs-code"; push(); openSetup(); return; }
  try { if (sock) { sock.removeAllListeners(); sock.terminate(); } } catch (_) {}
  const url = SERVER.replace(/^http/, "ws") + "/ws?token=" + encodeURIComponent(code);
  sock = new WS(url);
  sock.on("open", () => { connected = true; serverStatus = "live"; lastMsgAt = Date.now(); push(); handOverKeyIfNeeded(); });
  sock.on("message", data => {
    lastMsgAt = Date.now();
    let m; try { m = JSON.parse(String(data)); } catch (_) { return; }
    if (m.type === "state") { state = m; push(); }
    else if (m.type === "tick") { if (widget && !widget.isDestroyed()) widget.webContents.send("tick", { next: m.next }); }
    else if (m.type === "alert") onAlert(m);
  });
  sock.on("unexpected-response", (_req, res) => { if (res && res.statusCode === 401) { serverStatus = "needs-code"; push(); openSetup("That access code wasn't accepted."); } });
  const down = () => { connected = false; if (serverStatus !== "needs-code") serverStatus = "offline"; push(); wsTimer = setTimeout(connect, 5000); };
  sock.on("close", down); sock.on("error", () => {});
}
// Older installs saved a JustCall key; hand it to the server once so nobody has to paste it again
async function handOverKeyIfNeeded() {
  const c = loadCreds();
  if (!c || !c.key || !c.secret) return;
  try {
    const r = await fetch(SERVER + "/health"); const h = await r.json();
    if (!h.hasKey) {
      const res = await fetch(SERVER + "/justcall-key?token=" + encodeURIComponent(c.code), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: c.key, secret: c.secret }) });
      if (!res.ok) return;
    }
    saveCreds({ code: c.code }); // key now lives on the server only
  } catch (_) {}
}
async function serverPost(pathname, body) {
  const code = accessCode(); if (!code) return null;
  try { const r = await fetch(SERVER + pathname + "?token=" + encodeURIComponent(code), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }); return await r.json(); } catch (_) { return null; }
}
// no state for 20 s = treat as offline until the socket comes back
setInterval(() => { if (connected && Date.now() - lastMsgAt > 20000) { try { sock && sock.terminate(); } catch (_) {} } }, 5000);

/* ---- meeting pop-ups (the server decides what is a win; each screen decides how loud to be) ---- */
function onAlert(a) {
  try {
    if (alertPrefs.toast && Notification.isSupported()) {
      const n = new Notification({ title: a.title, body: a.body, icon: path.join(__dirname, "icon.png") });
      n.on("click", showWidget); n.show();
    }
  } catch (_) {}
  if (widget && !widget.isDestroyed()) {
    if (!widget.isVisible()) widget.showInactive();
    widget.webContents.send("alert", a);
  }
  if (alertPrefs.popup) showCele({ title: a.title, body: a.body, theme });
}

function push() {
  if (!widget || widget.isDestroyed()) return;
  const s = state || {};
  const status = serverStatus === "needs-code" ? "needs-key" : serverStatus === "offline" || serverStatus === "connecting" ? (state ? "offline" : "loading") : (s.status || "loading");
  widget.webContents.send("state", { status, error: s.error || null, updatedAt: s.updatedAt || null, weekReady: !!s.weekReady, today: s.today || null, week: s.week || null, meetings: s.meetings || [], campaigns: s.campaigns || [], campaignsListed: !!s.campaignsListed, updateReady, version: app.getVersion(), ticker: s.ticker || [], manual: s.manual || {}, server: SERVER });
}

/* ---------------- windows ---------------- */
function readBounds() { try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")); } catch (_) { return null; } }
function saveBounds() {
  if (!widget || widget.isDestroyed()) return;
  try { fs.writeFileSync(stateFile(), JSON.stringify(widget.getBounds())); } catch (_) {}
}
function onScreen(b) {
  return b && screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x + 40 < a.x + a.width && b.x + b.width - 40 > a.x && b.y >= a.y - 10 && b.y + 40 < a.y + a.height;
  });
}

function createWidget() {
  const W = 360, H = 540;
  const wa = screen.getPrimaryDisplay().workArea;
  const saved = readBounds();
  const b = onScreen(saved) ? saved : { x: wa.x + wa.width - W - 16, y: wa.y + 16, width: W, height: H }; // top right
  widget = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height, minWidth: 300, minHeight: 260,
    frame: false, resizable: true, skipTaskbar: true, show: false, maximizable: false, fullscreenable: false,
    transparent: true, backgroundColor: "#00000000", hasShadow: true, title: "Bullpen", icon: path.join(__dirname, "icon.png"),
    backgroundMaterial: acrylicOk() ? "acrylic" : "none",
    icon: path.join(__dirname, "icon.png"), webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  widget.loadFile("widget.html");
  widget.once("ready-to-show", () => { widget.showInactive(); push(); });
  widget.on("moved", () => { if (!tvOn) saveBounds(); }); widget.on("resized", () => { if (!tvOn) saveBounds(); });
  widget.on("close", e => { if (!app.isQuitting) { e.preventDefault(); widget.hide(); } });
  widget.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

function openSetup(message) {
  if (setupWin && !setupWin.isDestroyed()) { setupWin.show(); setupWin.focus(); if (message) setupWin.webContents.send("setup-message", message); return; }
  setupWin = new BrowserWindow({
    width: 460, height: 520, resizable: false, autoHideMenuBar: true, title: "Bullpen setup",
    backgroundColor: "#0e1115", icon: path.join(__dirname, "icon.png"),
    icon: path.join(__dirname, "icon.png"), webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  setupWin.loadFile("setup.html");
  if (message) setupWin.webContents.once("did-finish-load", () => setupWin.webContents.send("setup-message", message));
  setupWin.on("closed", () => { setupWin = null; });
  setupWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

function showWidget() { if (!widget || widget.isDestroyed()) createWidget(); else { widget.show(); widget.focus(); } }

function buildTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, "icon.png")).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip("Bullpen " + app.getVersion());
  const menu = () => Menu.buildFromTemplate([
    { label: "Show Bullpen", click: showWidget },
    { label: "Open full board (campaigns and reasons)", click: () => shell.openExternal(BOARD_URL) },
    { label: "Show last win again", click: () => serverPost("/replay-alert") },
    { label: "Send a test pop-up", click: () => serverPost("/test-alert") },
    { label: "TV mode (full screen)", type: "checkbox", checked: tvOn, click: item => { showWidget(); setTv(item.checked); } },
    { label: "Show today's recap", click: () => { showWidget(); widget && widget.webContents.send("show-recap"); } },
    { type: "separator" },
    { label: "Check for updates", click: () => { if (autoUpdater && app.isPackaged) autoUpdater.checkForUpdates().catch(() => {}); } },
    { label: "Change Bullpen access code", click: () => openSetup() },
    { label: "Start when I log in", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin,
      click: item => app.setLoginItemSettings({ openAtLogin: item.checked }) },
    { type: "separator" },
    { label: "Quit Bullpen", click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu());
  tray.on("right-click", () => tray.setContextMenu(menu()));
  tray.on("click", showWidget);
}

/* ---------------- IPC ---------------- */
ipcMain.on("open-board", () => shell.openExternal(BOARD_URL));
ipcMain.on("open-setup", () => openSetup());
ipcMain.on("hide-widget", () => widget && widget.hide());
// Glass looks use Windows 11's own acrylic blur behind the window; the Original look turns it off
function acrylicOk() {
  if (process.platform !== "win32") return false;
  const b = Number((process.getSystemVersion() || "").split(".")[2] || 0);
  return b >= 22621; // Windows 11 22H2 and up
}
/* ---- updates: new versions come from GitHub releases, download quietly, install on restart ---- */
let updateReady = null;
function setupUpdates() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Install as soon as it's downloaded: the app closes and comes straight back on the new version
  autoUpdater.on("update-downloaded", info => { updateReady = info.version; push(); setTimeout(() => { app.isQuitting = true; autoUpdater.quitAndInstall(true, true); }, 4000); });
  autoUpdater.on("error", () => {});
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 20000);
  setInterval(check, 10000); // every 10 seconds
}
ipcMain.on("install-update", () => { if (updateReady && autoUpdater) { app.isQuitting = true; autoUpdater.quitAndInstall(false, true); } });
ipcMain.on("check-updates", () => { if (autoUpdater && app.isPackaged) autoUpdater.checkForUpdates().catch(() => {}); });

/* ---- TV mode: full screen on this monitor ---- */
// A transparent window can't use Windows' real full-screen mode, so TV mode stretches the window over the whole display instead
let tvBounds = null, tvOn = false;
function setTv(on) {
  if (!widget || widget.isDestroyed()) return;
  if (on && !tvOn) {
    tvBounds = widget.getBounds(); tvOn = true;
    const d = screen.getDisplayMatching(tvBounds);
    applyMaterial();
    widget.setBounds(d.bounds);
    widget.setSkipTaskbar(false);
  } else if (!on && tvOn) {
    tvOn = false;
    widget.setSkipTaskbar(true);
    if (tvBounds && onScreen(tvBounds)) widget.setBounds(tvBounds);
    else { const wa = screen.getPrimaryDisplay().workArea; widget.setBounds({ x: wa.x + wa.width - 376, y: wa.y + 16, width: 360, height: 540 }); }
    applyMaterial();
  }
  widget.webContents.send("tv", tvOn);
}
ipcMain.on("set-tv", (_e, on) => setTv(!!on));
// Dragging the title bar in TV mode: drop back to the small window and carry it under the cursor
let grab = null;
ipcMain.on("tv-drag-start", (_e, { fx, fy }) => {
  if (!widget || widget.isDestroyed()) return;
  setTv(false);
  const b = widget.getBounds(), c = screen.getCursorScreenPoint();
  grab = { x: Math.round(Math.min(Math.max(fx, 0), 1) * b.width), y: Math.round(Math.min(Math.max(fy, 0), 1) * 44) };
  widget.setPosition(c.x - grab.x, c.y - grab.y);
});
ipcMain.on("drag-move", () => {
  if (!grab || !widget || widget.isDestroyed()) return;
  const c = screen.getCursorScreenPoint();
  widget.setPosition(c.x - grab.x, c.y - grab.y);
});
ipcMain.on("drag-end", () => { grab = null; if (widget && !widget.isDestroyed()) saveBounds(); });
// Acrylic (glass) is off in TV mode: Windows re-blurs the whole display on every repaint and it flashes
let theme = "original";
function applyMaterial() {
  if (!widget || widget.isDestroyed()) return;
  try { widget.setBackgroundMaterial(theme === "original" || tvOn || !acrylicOk() ? "none" : "acrylic"); } catch (_) {}
}
ipcMain.on("set-theme", (_e, t) => { theme = t; applyMaterial(); });
/* ---- full-screen meeting pop-up: its own always-on-top window the size of the display ---- */
let cele = null, celeTimer = null;
function showCele(a) {
  const base = widget && !widget.isDestroyed() ? widget.getBounds() : screen.getPrimaryDisplay().bounds;
  const d = screen.getDisplayMatching(base);
  clearTimeout(celeTimer);
  if (!cele || cele.isDestroyed()) {
    cele = new BrowserWindow({ ...d.bounds, frame: false, transparent: true, backgroundColor: "#00000000", alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false, hasShadow: false, show: false, icon: path.join(__dirname, "icon.png"), webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false } });
    cele.setAlwaysOnTop(true, "screen-saver");
    cele.loadFile(path.join(__dirname, "cele.html"));
    cele.once("ready-to-show", () => { cele.show(); cele.webContents.send("cele", a); });
    cele.on("closed", () => { cele = null; });
  } else {
    cele.setBounds(d.bounds); cele.show(); cele.webContents.send("cele", a);
  }
  celeTimer = setTimeout(closeCele, 30 * 60000); // stays up 30 minutes
}
function closeCele() { clearTimeout(celeTimer); if (cele && !cele.isDestroyed()) cele.close(); cele = null; }
ipcMain.on("cele-close", closeCele);
ipcMain.on("set-alerts", (_e, o) => { if (o && typeof o === "object") alertPrefs = Object.assign(alertPrefs, o); });
ipcMain.on("test-alert", () => { serverPost("/test-alert"); });
ipcMain.handle("manual-credit", async (_e, b) => serverPost("/manual", b));
ipcMain.on("recap-opened", () => { if (widget && !widget.isDestroyed()) { widget.show(); widget.moveTop(); } });
ipcMain.on("refresh-now", () => { serverPost("/resync"); });
ipcMain.handle("save-creds", async (_e, c) => {
  const code = String(c && c.key || "").trim();
  if (!code) return { ok: false, message: "Paste the Bullpen access code." };
  try {
    const r = await fetch(SERVER + "/state?token=" + encodeURIComponent(code));
    if (r.status === 401) return { ok: false, message: "That access code wasn't accepted. Check it and try again." };
    if (!r.ok) return { ok: false, message: "Bullpen server returned " + r.status + "." };
  } catch (e) { return { ok: false, message: "Couldn't reach the Bullpen server. Check the internet connection." }; }
  const old = loadCreds() || {};
  saveCreds(Object.assign({}, old, { code }));
  serverStatus = "connecting";
  setTimeout(() => { if (setupWin && !setupWin.isDestroyed()) setupWin.close(); }, 900);
  showWidget(); connect();
  return { ok: true, message: "Connected. Your numbers are loading." };
});

/* ---------------- start ---------------- */
app.on("second-instance", showWidget);
app.on("window-all-closed", e => { /* keep running in the tray */ });
app.whenReady().then(() => {
  migrateFromCallBoard();
  // First run: start automatically when Windows starts
  const flag = path.join(dataDir(), "first-run-done");
  if (!fs.existsSync(flag)) {
    app.setLoginItemSettings({ openAtLogin: true });
    try { fs.mkdirSync(dataDir(), { recursive: true }); fs.writeFileSync(flag, "1"); } catch (_) {}
  }
  if (process.platform === "win32" && app.isPackaged) {
    try {
      shell.writeShortcutLink(path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "Bullpen.lnk"), "replace",
        { target: process.execPath, appUserModelId: "com.wearehighwater.callboard", icon: path.join(path.dirname(process.execPath), "icon.ico"), iconIndex: 0 });
    } catch (_) {}
  }
  buildTray();
  createWidget();
  setupUpdates();
  // Pause while the PC is locked or asleep; pick right back up after
  const resume = () => setTimeout(connect, 1500);
  powerMonitor.on("unlock-screen", resume);
  powerMonitor.on("resume", resume);
  connect();
});
