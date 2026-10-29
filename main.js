// Bullpen desktop widget: today's JustCall Sales Dialer numbers, live, on the Windows desktop.
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, screen, safeStorage, powerMonitor, nativeImage, Notification } = require("electron");
const path = require("path");
const fs = require("fs");
const { rowFacts, summarize, etYMD, addDays, mondayOf, REPS, GOAL, decode } = require("./logic");
let autoUpdater = null; try { autoUpdater = require("electron-updater").autoUpdater; } catch (_) {}

const BOARD_URL = "https://claude.ai/artifact/6Jd2KCKpXAcM4nqeizhzGt";
const API = process.env.CALLBOARD_TEST_API || "https://api.justcall.io/v2.1/sales_dialer/calls";
const CAMPAIGNS_API = process.env.CALLBOARD_TEST_API ? process.env.CALLBOARD_TEST_API.replace(/calls$/, "campaigns") : "https://api.justcall.io/v2.1/sales_dialer/campaigns";
const POLL_MS = 3000;          // one request every 3 seconds = about 1,200 an hour, plus backfill pages (Pro plan allows 3,600)
const BACKOFF_MS = 60000;      // if JustCall says "slow down", wait a minute between requests for 5 minutes
const OFFLINE_RETRY_MS = 15000;

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

/* ---------------- credentials (encrypted with Windows' own protection) ---------------- */
function loadCreds() {
  try {
    const buf = fs.readFileSync(credFile());
    const txt = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString("utf8");
    const c = JSON.parse(txt);
    return c && c.key && c.secret ? c : null;
  } catch (_) { return null; }
}
function saveCreds(c) {
  const txt = JSON.stringify(c);
  const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(txt) : Buffer.from(txt, "utf8");
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(credFile(), buf);
}

/* ---------------- JustCall ---------------- */
class ApiError extends Error { constructor(kind, msg) { super(msg); this.kind = kind; } }

async function getCalls(creds, params, base) {
  const url = (base || API) + "?" + new URLSearchParams(params).toString();
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: creds.key + ":" + creds.secret, Accept: "application/json" },
      signal: AbortSignal.timeout(20000)
    });
  } catch (e) { throw new ApiError("offline", "Can't reach JustCall"); }
  if (res.status === 401) throw new ApiError("auth", "JustCall didn't accept the API key");
  if (res.status === 429 || res.status === 403) throw new ApiError("rate", "JustCall asked us to slow down");
  if (!res.ok) throw new ApiError("server", "JustCall returned error " + res.status);
  const body = await res.json().catch(() => null);
  if (!body || !Array.isArray(body.data)) throw new ApiError("server", "Unexpected answer from JustCall");
  return body.data;
}

const feed = { day: null, week: null, calls: new Map(), ready: false, status: "starting", error: null, updatedAt: null, backoffUntil: 0 };
const notified = new Set();
const REP_IDS = new Set(REPS.map(r => r.id));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const startedAt = Date.now();

function range(day) {
  // From the day before Monday so nothing is lost to the account's time zone; days are counted in Eastern time
  return { from_datetime: addDays(mondayOf(day), -1), to_datetime: day + " 23:59:59" };
}

// New day or new week: start the day fresh (keeping the week when it's the same week)
function rollDay() {
  const day = etYMD(new Date()), monday = mondayOf(day);
  if (feed.day === day) return;
  if (feed.week !== monday) { feed.calls = new Map(); notified.clear(); feed.ready = false; backfill.page = 1; backfill.done = false; }
  const fresh = feed.week !== monday;
  feed.day = day; feed.week = monday;
  if (fresh && loadCache()) push();
}

/* ---- manual credits: a small file in the repo (rep, day, counts only), re-read every minute ---- */
const MANUAL_URL = "https://raw.githubusercontent.com/cmooney-hw/bullpen/main/manual.json";
let manual = {};
async function loadManual() {
  try {
    const r = await fetch(MANUAL_URL + "?t=" + Date.now(), { headers: { "Cache-Control": "no-cache" } });
    if (r.ok) { const j = await r.json(); if (j && typeof j === "object") { manual = j; push(); } }
  } catch (_) {}
}
setInterval(loadManual, 60000); setTimeout(loadManual, 3000);

/* ---- meeting pop-ups ---- */
function notifyMeeting(f) {
  if (notified.has(f.id)) return;
  notified.add(f.id);
  if (process.env.CALLBOARD_TEST_API) console.log("NOTIFY", f.id, f.disp, f.contact);
  const rep = REPS.find(r => r.id === f.agent);
  const kind = f.disp.toLowerCase() === "interested" ? "Interested" : "Meeting set";
  const title = kind + " · " + (rep ? rep.name : "Rep");
  const body = [f.contact, f.campaign].filter(Boolean).join(" · ") + (f.note ? "\n" + f.note.slice(0, 120) : "");
  // Windows pop-up
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title, body, icon: path.join(__dirname, "icon.png") });
      n.on("click", showWidget); n.show();
    }
  } catch (_) {}
  // Also show it inside the widget, so it's seen even if Windows hides pop-ups (Focus, Do Not Disturb)
  if (widget && !widget.isDestroyed()) {
    if (!widget.isVisible()) widget.showInactive();
    widget.webContents.send("alert", { title, body, at: Date.now(), agent: f.agent, test: String(f.id).startsWith("test-") });
  }
  showCele({ title, body, theme });
}
function maybeNotify(f, prev) {
  // Pop up for any call that turns Interested / Meeting Set after the widget started (or in the 15 minutes before)
  if (f.interested && !(prev && prev.interested) && REP_IDS.has(f.agent) && f.ymd === feed.day && f.ts >= startedAt - 15 * 60000) notifyMeeting(f);
}

/* ---- live feed: the newest calls, every 5 seconds, never held up by anything else ---- */
async function pollNewest(creds) {
  for (let page = 0; page < 4; page++) {
    const rows = await getCalls(creds, Object.assign(range(feed.day), { per_page: 100, page, sort: "id", order: "desc" }));
    let overlap = false, older = false;
    for (const r of rows) {
      const f = rowFacts(r);
      const prev = feed.calls.get(f.id);
      if (prev) overlap = true;
      if (f.ymd < feed.week) { older = true; continue; }
      feed.calls.set(f.id, f); cacheDirty = true; // also picks up dispositions and notes logged after the call
      trackCampaignCall(f);
      maybeNotify(f, prev);
    }
    // First run: page 0 covers the latest calls; the rest of the week fills in from the background loader
    if (overlap || older || rows.length < 100 || feed.calls.size <= 100) break;
  }
}

/* ---- active campaigns: every non-completed campaign the team works, with lifetime totals ---- */
// JustCall only returns about 90 days of calls, so older campaigns count from 90 days back
const HISTORY_DAYS = 89;
const camps = { list: [], byId: new Map(), listedAt: 0, relist: false };
function teamCampaign(c) {
  const members = (c.assigned_to_id && c.assigned_to_id.team_members) || [];
  return members.some(m => REP_IDS.has(Number(m.id))) || REP_IDS.has(Number(c.created_by_id)) && members.length === 0;
}
async function listCampaigns(creds) {
  const cutoff = addDays(etYMD(new Date()), -HISTORY_DAYS);
  const found = [];
  for (let page = 0; page < 20; page++) {
    const rows = await getCalls(creds, { per_page: 50, page }, CAMPAIGNS_API);
    for (const c of rows) {
      const status = String(c.status || "");
      if (!teamCampaign(c)) continue;
      found.push({ id: Number(c.id), name: decode(c.name), status, created: String(c.created_date || ""),
        contacts: (c.contacts_count && (c.contacts_count.imported ?? c.contacts_count.uploaded)) || 0 });
    }
    const oldest = rows.length ? String(rows[rows.length - 1].created_date || "") : "";
    if (rows.length < 50 || (oldest && oldest < cutoff)) break;
    await sleep(1500);
  }
  // Only campaigns the team actually dialed this week; a campaign marked Completed today still ran this week
  const ranWeek = new Set();
  for (const f of feed.calls.values()) if (f.campaignId != null && REP_IDS.has(f.agent)) ranWeek.add(f.campaignId);
  const next = new Map();
  for (const c of found) {
    if (!ranWeek.has(c.id)) continue;
    const old = camps.byId.get(c.id);
    next.set(c.id, Object.assign(old || { calls: new Map(), page: 0, loaded: false }, c));
  }
  camps.byId = next;
  camps.listedAt = Date.now();
}
// Loads one more page of an active campaign's calls; returns true when there was work to do
async function loadCampaignPage(creds) {
  const c = [...camps.byId.values()].find(x => !x.loaded);
  if (!c) return false;
  const today = etYMD(new Date());
  const cutoff = addDays(today, -HISTORY_DAYS);
  const rows = await getCalls(creds, { campaign_id: c.id, from_datetime: c.created > cutoff ? c.created : cutoff, to_datetime: today + " 23:59:59", per_page: 100, page: c.page, sort: "id", order: "asc" });
  for (const r of rows) { const f = rowFacts(r); if (REP_IDS.has(f.agent)) c.calls.set(f.id, { interested: f.interested, notInterested: f.notInterested }); }
  if (rows.length < 100) c.loaded = true; else c.page++;
  cacheDirty = true;
  push();
  return true;
}
function trackCampaignCall(f) {
  const c = f.campaignId != null && camps.byId.get(f.campaignId);
  if (f.campaignId != null && !c && REP_IDS.has(f.agent) && camps.listedAt) camps.relist = true; // new campaign started: pick it up
  if (c && REP_IDS.has(f.agent)) { c.calls.set(f.id, { interested: f.interested, notInterested: f.notInterested }); cacheDirty = true; }
}
// Ticker: today's meetings/interested calls plus goal milestones, newest first
function tickerEvents() {
  if (!feed.day) return [];
  const ev = [], perRep = {};
  for (const f of feed.calls.values()) {
    if (f.ymd !== feed.day || !REP_IDS.has(f.agent)) continue;
    (perRep[f.agent] || (perRep[f.agent] = [])).push(f.ts);
    if (f.interested) {
      const rep = REPS.find(r => r.id === f.agent);
      ev.push({ ts: f.ts, kind: f.disp.toLowerCase() === "interested" ? "interested" : "meeting", rep: rep ? rep.name : "Rep", who: f.contact, campaign: f.campaign });
    }
  }
  const all = [];
  for (const [id, list] of Object.entries(perRep)) {
    list.sort((a, b) => a - b); all.push(...list);
    const rep = REPS.find(r => r.id === Number(id));
    if (rep && !rep.manager && list.length >= GOAL) ev.push({ ts: list[GOAL - 1], kind: "goal", rep: rep.name, n: GOAL });
  }
  const teamGoal = GOAL * REPS.filter(r => !r.manager).length;
  const teamList = all.filter((_, i) => true).sort((a, b) => a - b);
  // team milestone counts only non-manager calls
  const nm = []; for (const r of REPS) if (!r.manager && perRep[r.id]) nm.push(...perRep[r.id]); nm.sort((a, b) => a - b);
  if (nm.length >= teamGoal) ev.push({ ts: nm[teamGoal - 1], kind: "team", n: teamGoal });
  return ev.sort((a, b) => b.ts - a.ts).slice(0, 10);
}
function campaignSummary() {
  // Which campaigns the team actually dialed today / this week (from the live week of calls)
  const ranToday = new Set(), ranWeek = new Set(), per = {}, names = {};
  const bump = (o, f) => { o.calls++; if (f.interested) o.interested++; if (f.notInterested) o.notInterested++; };
  for (const f of feed.calls.values()) {
    if (f.campaignId == null || !REP_IDS.has(f.agent)) continue;
    ranWeek.add(f.campaignId);
    if (f.campaign) names[f.campaignId] = f.campaign;
    const p = per[f.campaignId] || (per[f.campaignId] = { today: { calls: 0, interested: 0, notInterested: 0 }, week: { calls: 0, interested: 0, notInterested: 0 } });
    bump(p.week, f);
    if (f.ymd === feed.day) { ranToday.add(f.campaignId); bump(p.today, f); }
  }
  // Campaigns seen in this week's calls show right away (this week's numbers come from the calls we already have);
  // the all-time history fills in once the loader gets to each one
  const list = [...camps.byId.values()];
  const have = new Set(list.map(c => c.id));
  for (const id of ranWeek) if (!have.has(id)) list.push({ id, name: names[id] || ("Campaign " + id), created: "", calls: new Map(), loaded: false, pending: true });
  return list.map(c => {
    let interested = 0, notInterested = 0;
    for (const v of c.calls.values()) { if (v.interested) interested++; if (v.notInterested) notInterested++; }
    const pp = per[c.id] || { today: { calls: 0, interested: 0, notInterested: 0 }, week: { calls: 0, interested: 0, notInterested: 0 } };
    return { id: c.id, name: c.name, created: c.created, calls: c.calls.size, interested, notInterested, loading: !c.loaded, ranToday: ranToday.has(c.id), ranWeek: ranWeek.has(c.id), today: pp.today, week: pp.week };
  }).sort((a, b) => (b.created + b.id).localeCompare(a.created + a.id));
}

/* ---- background loader: fills in the rest of the week, a page every 3 seconds, picks up where it left off ---- */
const backfill = { page: 1, done: false, running: false, resyncAt: 0, resyncWeekAt: 0 };
// Re-read today's calls every 5 minutes and the whole week every 15, so disposition edits made later in JustCall show up on every screen
const RESYNC_MS = 5 * 60000, RESYNC_WEEK_MS = 15 * 60000;
async function resync(creds, fromDay) {
  for (let page = 0; page < 60; page++) {
    const rows = await getCalls(creds, Object.assign(range(feed.day), { per_page: 100, page, sort: "id", order: "desc" }));
    let older = false;
    for (const r of rows) { const f = rowFacts(r); if (f.ymd < fromDay) { older = true; continue; } const prev = feed.calls.get(f.id); feed.calls.set(f.id, f); cacheDirty = true; trackCampaignCall(f); maybeNotify(f, prev); }
    if (older || rows.length < 100) break;
    await sleep(1500);
  }
  backfill.resyncAt = Date.now();
  if (fromDay === feed.week) backfill.resyncWeekAt = Date.now();
  push();
}

/* ---- disk cache: the week's calls and campaign history survive restarts (updates restart the app) ---- */
const cacheFile = () => path.join(dataDir(), "week-cache.json");
let cacheDirty = false, lastCacheWrite = 0;
function saveCache(force) {
  if (!feed.week || (!cacheDirty && !force)) return;
  if (!force && Date.now() - lastCacheWrite < 20000) return;
  try {
    const data = { v: 4, week: feed.week, savedAt: Date.now(), backfillDone: backfill.done,
      calls: [...feed.calls.values()],
      camps: [...camps.byId.values()].map(c => ({ id: c.id, name: c.name, status: c.status, created: c.created, contacts: c.contacts, page: c.page, loaded: c.loaded, calls: [...c.calls.entries()] })),
      campsListedAt: camps.listedAt };
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(cacheFile() + ".tmp", JSON.stringify(data)); fs.renameSync(cacheFile() + ".tmp", cacheFile());
    cacheDirty = false; lastCacheWrite = Date.now();
  } catch (_) {}
}
function loadCache() {
  try {
    const d = JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
    if (!d || d.v !== 4 || d.week !== feed.week) return false;
    for (const f of d.calls || []) feed.calls.set(f.id, f);
    for (const c of d.camps || []) camps.byId.set(c.id, Object.assign({}, c, { calls: new Map(c.calls || []) }));
    camps.listedAt = d.campsListedAt || 0;
    // numbers show right away; the loader still walks back until it meets calls it already has
    feed.ready = feed.calls.size > 0;
    backfill.page = 1; backfill.done = false;
    return true;
  } catch (_) { return false; }
}
setInterval(() => saveCache(false), 20000);
app.on("before-quit", () => saveCache(true));
async function runBackfill() {
  if (backfill.running) return;
  backfill.running = true;
  // One request every 3 seconds: first the rest of this week, then active campaigns. Picks up where it left off after any error.
  for (;;) {
    if (paused) { await sleep(5000); continue; }
    const creds = loadCreds();
    if (!creds || !feed.day) { await sleep(5000); continue; }
    if (Date.now() < feed.backoffUntil) { await sleep(10000); continue; }
    try {
      if (!backfill.done) {
        const rows = await getCalls(creds, Object.assign(range(feed.day), { per_page: 100, page: backfill.page, sort: "id", order: "desc" }));
        let older = false;
        let known = 0;
        for (const r of rows) { const f = rowFacts(r); if (f.ymd >= feed.week) { if (!feed.calls.has(f.id)) { feed.calls.set(f.id, f); cacheDirty = true; } else known++; } else older = true; }
        push();
        // done when we run out, reach last week, or a whole page is calls the cache already had
        if (rows.length < 100 || older || backfill.page >= 150 || (rows.length && known === rows.length)) { backfill.done = true; feed.ready = true; push(); saveCache(true); }
        else backfill.page++;
      } else if (Date.now() - camps.listedAt > 10 * 60000 || camps.relist) {
        camps.relist = false;
        await listCampaigns(creds); push();          // refresh which campaigns are active every 10 minutes
      } else if (Date.now() - backfill.resyncWeekAt > RESYNC_WEEK_MS) {
        await resync(creds, feed.week);
      } else if (Date.now() - backfill.resyncAt > RESYNC_MS) {
        await resync(creds, feed.day);
      } else if (!(await loadCampaignPage(creds))) {
        await sleep(15000); continue;                 // nothing to load right now
      }
      await sleep(4000);
    } catch (e) {
      if (e.kind === "rate") feed.backoffUntil = Date.now() + 2 * 60000;
      await sleep(e.kind === "rate" ? 60000 : 20000); // try again later
    }
  }
}

let timer = null, running = false, paused = false;
function schedule(ms) { clearTimeout(timer); if (!paused) timer = setTimeout(tick, ms); }

async function tick() {
  if (running || paused) return;
  const creds = loadCreds();
  if (!creds) { feed.status = "needs-key"; push(); openSetup(); return; }
  running = true;
  let next = POLL_MS;
  try {
    const before = feed.week;
    rollDay();
    if (!feed.updatedAt) { feed.status = "loading"; push(); }
    await pollNewest(creds);
    feed.status = "live"; feed.error = null; feed.updatedAt = Date.now();
    if (widget && !widget.isDestroyed()) widget.webContents.send("tick", { next: POLL_MS }); // the bull turns around on every refresh
    if (!backfill.running) runBackfill();
  } catch (e) {
    feed.error = e.message || "Something went wrong";
    if (e.kind === "auth") { feed.status = "needs-key"; push(); running = false; openSetup(e.message); return; }
    if (e.kind === "rate") { feed.status = "slow"; feed.backoffUntil = Date.now() + 2 * 60000; next = 15000; }
    else { feed.status = "offline"; next = OFFLINE_RETRY_MS; }
  }
  running = false;
  push();
  schedule(next);
}

function push() {
  const today = feed.day ? summarize(feed.calls, feed.day, feed.day, manual) : null;
  const week = feed.day ? summarize(feed.calls, feed.week, feed.day, manual) : null;
  if (process.env.CALLBOARD_TEST_API) console.log("CAMPS", JSON.stringify(campaignSummary()));
  if (process.env.CALLBOARD_TEST_API) console.log("STATE", feed.status, feed.error || "", today ? JSON.stringify(today.team) : "", week ? "week " + week.team.calls + "/" + week.team.goal : "");
  if (!widget || widget.isDestroyed()) return;
  const meetings = feed.day ? [...feed.calls.values()].filter(c => c.ymd === feed.day && c.interested && REP_IDS.has(c.agent))
    .sort((a, b) => a.ts - b.ts).map(c => ({ agent: c.agent, contact: c.contact, campaign: c.campaign, disp: c.disp, note: c.note.slice(0, 160) })) : [];
  widget.webContents.send("state", { status: feed.status, error: feed.error, updatedAt: feed.updatedAt, weekReady: feed.ready, today, week, meetings, campaigns: campaignSummary(), campaignsListed: camps.listedAt > 0, updateReady, version: app.getVersion(), ticker: tickerEvents() });
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
    { label: "Send a test pop-up", click: () => notifyMeeting({ id: "test-" + Date.now(), agent: REPS[0].id, disp: "Meeting Set", contact: "Test contact", campaign: "Test campaign", note: "This is a test. Real ones look like this." }) },
    { label: "TV mode (full screen)", type: "checkbox", checked: tvOn, click: item => { showWidget(); setTv(item.checked); } },
    { label: "Show today's recap", click: () => { showWidget(); widget && widget.webContents.send("show-recap"); } },
    { type: "separator" },
    { label: "Check for updates", click: () => { if (autoUpdater && app.isPackaged) autoUpdater.checkForUpdates().catch(() => {}); } },
    { label: "Change JustCall API key", click: () => openSetup() },
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
  celeTimer = setTimeout(closeCele, 30000);
}
function closeCele() { clearTimeout(celeTimer); if (cele && !cele.isDestroyed()) cele.close(); cele = null; }
ipcMain.on("cele-close", closeCele);
ipcMain.on("test-alert", () => { const r = REPS[Math.floor(Math.random() * 3)]; notifyMeeting({ id: "test-" + Date.now(), agent: r.id, disp: "Meeting Set", contact: "Test contact", campaign: "Test campaign", note: "This is a test. Real ones look like this." }); });
ipcMain.on("recap-opened", () => { if (widget && !widget.isDestroyed()) { widget.show(); widget.moveTop(); } });
ipcMain.on("refresh-now", () => { if (!running) { clearTimeout(timer); tick(); } });
ipcMain.handle("save-creds", async (_e, c) => {
  const creds = { key: String(c && c.key || "").trim(), secret: String(c && c.secret || "").trim() };
  if (!creds.key || !creds.secret) return { ok: false, message: "Paste both the API key and the API secret." };
  try {
    const today = etYMD(new Date());
    await getCalls(creds, Object.assign(range(today), { per_page: 1, page: 0 }));
  } catch (e) {
    return { ok: false, message: e.kind === "auth" ? "JustCall didn't accept that key and secret. Check them and try again." : e.kind === "rate" ? "JustCall is refusing requests right now (403). The key may be fine. Wait until the top of the hour and try again." : (e.message || "Couldn't reach JustCall.") };
  }
  saveCreds(creds);
  feed.day = null; feed.week = null; feed.calls = new Map(); feed.ready = false; backfill.page = 1; backfill.done = false;
  setTimeout(() => { if (setupWin && !setupWin.isDestroyed()) setupWin.close(); }, 900);
  showWidget(); clearTimeout(timer); tick();
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
  powerMonitor.on("lock-screen", () => { paused = true; clearTimeout(timer); });
  powerMonitor.on("suspend", () => { paused = true; clearTimeout(timer); });
  const resume = () => { paused = false; backfill.page = 1; backfill.done = false; schedule(500); }; // re-check the week for anything missed while asleep
  powerMonitor.on("unlock-screen", resume);
  powerMonitor.on("resume", resume);
  tick();
});
