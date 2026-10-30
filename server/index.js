// Bullpen server: the one shared brain. Pulls JustCall, keeps the week's numbers, and pushes
// identical state to every Bullpen screen over a websocket. Runs on Railway.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { rowFacts, summarize, etYMD, addDays, mondayOf, REPS, GOAL, decode } = require("./logic");

const PORT = Number(process.env.PORT || 8080);
const TOKEN = String(process.env.ACCESS_TOKEN || "");
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : path.join(__dirname, "data"));
// JustCall key: from the environment, or saved on disk after a widget hands it over once
const CREDS = { key: String(process.env.JUSTCALL_KEY || ""), secret: String(process.env.JUSTCALL_SECRET || "") };
const keyFile = () => path.join(DATA_DIR, "justcall.json");
try { if (!CREDS.key) { const k = JSON.parse(fs.readFileSync(keyFile(), "utf8")); if (k && k.key && k.secret) Object.assign(CREDS, k); } } catch (_) {}
const API = process.env.CALLBOARD_TEST_API || "https://api.justcall.io/v2.1/sales_dialer/calls";
const CAMPAIGNS_API = process.env.CALLBOARD_TEST_API ? process.env.CALLBOARD_TEST_API.replace(/calls$/, "campaigns") : "https://api.justcall.io/v2.1/sales_dialer/campaigns";
const POLL_MS = 3000, OFFLINE_RETRY_MS = 15000;
const VERSION = "3.0.0";

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------------- JustCall ---------------- */
class ApiError extends Error { constructor(kind, msg) { super(msg); this.kind = kind; } }
async function getCalls(params, base) {
  const url = (base || API) + "?" + new URLSearchParams(params).toString();
  let res;
  try { res = await fetch(url, { headers: { Authorization: CREDS.key + ":" + CREDS.secret, Accept: "application/json" }, signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw new ApiError("offline", "Can't reach JustCall"); }
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
const range = day => ({ from_datetime: addDays(mondayOf(day), -1), to_datetime: day + " 23:59:59" });

function rollDay() {
  const day = etYMD(new Date()), monday = mondayOf(day);
  if (feed.day === day) return;
  const fresh = feed.week !== monday;
  if (fresh) { feed.calls = new Map(); notified.clear(); feed.ready = false; backfill.page = 1; backfill.done = false; camps.byId = new Map(); camps.listedAt = 0; }
  feed.day = day; feed.week = monday;
  if (fresh && loadCache()) push();
}

/* ---- manual credits: { "YYYY-MM-DD": { "<agent id>": { calls, meetings } } }, kept on the server's disk ---- */
const manualFile = path.join(DATA_DIR, "manual.json");
let manual = {};
try { manual = JSON.parse(fs.readFileSync(manualFile, "utf8")) || {}; } catch (_) {}
function saveManual() { try { fs.writeFileSync(manualFile, JSON.stringify(manual, null, 2)); } catch (e) { log("manual save failed", e.message); } }

/* ---- meeting alerts: broadcast to every screen; each screen decides how loud to be ---- */
function alertFor(f) {
  const rep = REPS.find(r => r.id === f.agent);
  const kind = String(f.disp || "").toLowerCase() === "interested" ? "Interested" : "Meeting set";
  const title = kind + " · " + (rep ? rep.name : "Rep");
  const body = [f.contact, f.campaign].filter(Boolean).join(" · ") + (f.note ? "\n" + String(f.note).slice(0, 120) : "");
  return { type: "alert", title, body, at: Date.now(), agent: f.agent, test: String(f.id).startsWith("test-") };
}
let lastAlert = null;
function notifyMeeting(f) {
  if (notified.has(f.id)) return;
  notified.add(f.id);
  log("ALERT", f.id, f.disp, f.contact);
  lastAlert = alertFor(f);
  broadcast(lastAlert);
}
function maybeNotify(f, prev) {
  if (f.interested && !(prev && prev.interested) && REP_IDS.has(f.agent) && f.ymd === feed.day && f.ts >= startedAt - 15 * 60000) notifyMeeting(f);
}

/* ---- live feed ---- */
async function pollNewest() {
  for (let page = 0; page < 4; page++) {
    const rows = await getCalls(Object.assign(range(feed.day), { per_page: 100, page, sort: "id", order: "desc" }));
    let overlap = false, older = false;
    for (const r of rows) {
      const f = rowFacts(r);
      const prev = feed.calls.get(f.id);
      if (prev) overlap = true;
      if (f.ymd < feed.week) { older = true; continue; }
      feed.calls.set(f.id, f); cacheDirty = true;
      trackCampaignCall(f);
      maybeNotify(f, prev);
    }
    if (overlap || older || rows.length < 100 || feed.calls.size <= 100) break;
  }
}

/* ---- campaigns ---- */
const HISTORY_DAYS = 89;
const camps = { byId: new Map(), listedAt: 0, relist: false };
function teamCampaign(c) {
  const members = (c.assigned_to_id && c.assigned_to_id.team_members) || [];
  return members.some(m => REP_IDS.has(Number(m.id))) || REP_IDS.has(Number(c.created_by_id)) && members.length === 0;
}
async function listCampaigns() {
  const cutoff = addDays(etYMD(new Date()), -HISTORY_DAYS);
  const found = [];
  for (let page = 0; page < 20; page++) {
    const rows = await getCalls({ per_page: 50, page }, CAMPAIGNS_API);
    for (const c of rows) {
      if (!teamCampaign(c)) continue;
      found.push({ id: Number(c.id), name: decode(c.name), status: String(c.status || ""), created: String(c.created_date || ""),
        contacts: (c.contacts_count && (c.contacts_count.imported ?? c.contacts_count.uploaded)) || 0 });
    }
    const oldest = rows.length ? String(rows[rows.length - 1].created_date || "") : "";
    if (rows.length < 50 || (oldest && oldest < cutoff)) break;
    await sleep(1500);
  }
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
async function loadCampaignPage() {
  const c = [...camps.byId.values()].find(x => !x.loaded);
  if (!c) return false;
  const today = etYMD(new Date()), cutoff = addDays(today, -HISTORY_DAYS);
  const rows = await getCalls({ campaign_id: c.id, from_datetime: c.created > cutoff ? c.created : cutoff, to_datetime: today + " 23:59:59", per_page: 100, page: c.page, sort: "id", order: "asc" });
  for (const r of rows) { const f = rowFacts(r); if (REP_IDS.has(f.agent)) c.calls.set(f.id, { interested: f.interested, notInterested: f.notInterested }); }
  if (rows.length < 100) c.loaded = true; else c.page++;
  cacheDirty = true;
  push();
  return true;
}
function trackCampaignCall(f) {
  const c = f.campaignId != null && camps.byId.get(f.campaignId);
  if (f.campaignId != null && !c && REP_IDS.has(f.agent) && camps.listedAt) camps.relist = true;
  if (c && REP_IDS.has(f.agent)) { c.calls.set(f.id, { interested: f.interested, notInterested: f.notInterested }); cacheDirty = true; }
}
function tickerEvents() {
  if (!feed.day) return [];
  const ev = [], perRep = {};
  for (const f of feed.calls.values()) {
    if (f.ymd !== feed.day || !REP_IDS.has(f.agent)) continue;
    (perRep[f.agent] || (perRep[f.agent] = [])).push(f.ts);
    if (f.interested) {
      const rep = REPS.find(r => r.id === f.agent);
      ev.push({ ts: f.ts, kind: String(f.disp).toLowerCase() === "interested" ? "interested" : "meeting", rep: rep ? rep.name : "Rep", who: f.contact, campaign: f.campaign });
    }
  }
  for (const [id, list] of Object.entries(perRep)) {
    list.sort((a, b) => a - b);
    const rep = REPS.find(r => r.id === Number(id));
    if (rep && !rep.manager && list.length >= GOAL) ev.push({ ts: list[GOAL - 1], kind: "goal", rep: rep.name, n: GOAL });
  }
  const teamGoal = GOAL * REPS.filter(r => !r.manager).length;
  const nm = []; for (const r of REPS) if (!r.manager && perRep[r.id]) nm.push(...perRep[r.id]); nm.sort((a, b) => a - b);
  if (nm.length >= teamGoal) ev.push({ ts: nm[teamGoal - 1], kind: "team", n: teamGoal });
  return ev.sort((a, b) => b.ts - a.ts).slice(0, 10);
}
function campaignSummary() {
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

/* ---- background loader + re-syncs ---- */
const backfill = { page: 1, done: false, running: false, resyncAt: 0, resyncWeekAt: 0, wanted: false };
const RESYNC_MS = 5 * 60000, RESYNC_WEEK_MS = 15 * 60000;
async function resync(fromDay) {
  for (let page = 0; page < 60; page++) {
    const rows = await getCalls(Object.assign(range(feed.day), { per_page: 100, page, sort: "id", order: "desc" }));
    let older = false;
    for (const r of rows) { const f = rowFacts(r); if (f.ymd < fromDay) { older = true; continue; } const prev = feed.calls.get(f.id); feed.calls.set(f.id, f); cacheDirty = true; trackCampaignCall(f); maybeNotify(f, prev); }
    if (older || rows.length < 100) break;
    await sleep(1500);
  }
  backfill.resyncAt = Date.now();
  if (fromDay === feed.week) backfill.resyncWeekAt = Date.now();
  push();
}

/* ---- disk cache ---- */
const cacheFile = path.join(DATA_DIR, "week-cache.json");
let cacheDirty = false, lastCacheWrite = 0;
function saveCache(force) {
  if (!feed.week || (!cacheDirty && !force)) return;
  if (!force && Date.now() - lastCacheWrite < 20000) return;
  try {
    const data = { v: 4, week: feed.week, savedAt: Date.now(), calls: [...feed.calls.values()],
      camps: [...camps.byId.values()].map(c => ({ id: c.id, name: c.name, status: c.status, created: c.created, contacts: c.contacts, page: c.page, loaded: c.loaded, calls: [...c.calls.entries()] })),
      campsListedAt: camps.listedAt };
    fs.writeFileSync(cacheFile + ".tmp", JSON.stringify(data)); fs.renameSync(cacheFile + ".tmp", cacheFile);
    cacheDirty = false; lastCacheWrite = Date.now();
  } catch (e) { log("cache save failed", e.message); }
}
function loadCache() {
  try {
    const d = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (!d || d.v !== 4 || d.week !== feed.week) return false;
    for (const f of d.calls || []) feed.calls.set(f.id, f);
    for (const c of d.camps || []) camps.byId.set(c.id, Object.assign({}, c, { calls: new Map(c.calls || []) }));
    camps.listedAt = d.campsListedAt || 0;
    feed.ready = feed.calls.size > 0;
    backfill.page = 1; backfill.done = false;
    log("cache loaded:", feed.calls.size, "calls");
    return true;
  } catch (_) { return false; }
}
setInterval(() => saveCache(false), 20000);

async function runBackfill() {
  if (backfill.running) return;
  backfill.running = true;
  for (;;) {
    if (!feed.day) { await sleep(5000); continue; }
    if (Date.now() < feed.backoffUntil) { await sleep(10000); continue; }
    try {
      if (backfill.wanted) { backfill.wanted = false; await resync(feed.day); }   // a webhook asked for an immediate re-read
      else if (!backfill.done) {
        const rows = await getCalls(Object.assign(range(feed.day), { per_page: 100, page: backfill.page, sort: "id", order: "desc" }));
        let older = false, known = 0;
        for (const r of rows) { const f = rowFacts(r); if (f.ymd >= feed.week) { if (!feed.calls.has(f.id)) { feed.calls.set(f.id, f); cacheDirty = true; } else known++; } else older = true; }
        push();
        if (rows.length < 100 || older || backfill.page >= 150 || (rows.length && known === rows.length)) { backfill.done = true; feed.ready = true; push(); saveCache(true); }
        else backfill.page++;
      } else if (Date.now() - camps.listedAt > 10 * 60000 || camps.relist) { camps.relist = false; await listCampaigns(); push(); }
      else if (Date.now() - backfill.resyncWeekAt > RESYNC_WEEK_MS) await resync(feed.week);
      else if (Date.now() - backfill.resyncAt > RESYNC_MS) await resync(feed.day);
      else if (!(await loadCampaignPage())) { await sleep(5000); continue; }
      await sleep(4000);
    } catch (e) {
      log("backfill error", e.kind, e.message);
      if (e.kind === "rate") feed.backoffUntil = Date.now() + 2 * 60000;
      await sleep(e.kind === "rate" ? 60000 : 20000);
    }
  }
}

let timer = null, running = false;
async function tick() {
  if (running) return;
  if (!CREDS.key || !CREDS.secret) { feed.status = "needs-key"; feed.error = "Server has no JustCall key"; push(); timer = setTimeout(tick, 30000); return; }
  running = true;
  let next = POLL_MS;
  try {
    rollDay();
    if (!feed.updatedAt) { feed.status = "loading"; push(); }
    await pollNewest();
    feed.status = "live"; feed.error = null; feed.updatedAt = Date.now();
    broadcast({ type: "tick", next: POLL_MS });
    if (!backfill.running) runBackfill();
  } catch (e) {
    feed.error = e.message || "Something went wrong";
    log("poll error", e.kind, e.message);
    if (e.kind === "auth") { feed.status = "needs-key"; next = 60000; }
    else if (e.kind === "rate") { feed.status = "slow"; feed.backoffUntil = Date.now() + 2 * 60000; next = 15000; }
    else { feed.status = "offline"; next = OFFLINE_RETRY_MS; }
  }
  running = false;
  push();
  timer = setTimeout(tick, next);
}

/* ---- state ---- */
let lastState = null;
function buildState() {
  const today = feed.day ? summarize(feed.calls, feed.day, feed.day, manual) : null;
  const week = feed.day ? summarize(feed.calls, feed.week, feed.day, manual) : null;
  const meetings = feed.day ? [...feed.calls.values()].filter(c => c.ymd === feed.day && c.interested && REP_IDS.has(c.agent))
    .sort((a, b) => a.ts - b.ts).map(c => ({ agent: c.agent, contact: c.contact, campaign: c.campaign, disp: c.disp, note: String(c.note || "").slice(0, 160) })) : [];
  return { type: "state", status: feed.status, error: feed.error, updatedAt: feed.updatedAt, weekReady: feed.ready, today, week, meetings,
    campaigns: campaignSummary(), campaignsListed: camps.listedAt > 0, ticker: tickerEvents(), manual, serverVersion: VERSION, clients: wss ? wss.clients.size : 0 };
}
function push() { lastState = buildState(); broadcast(lastState); }

/* ---- HTTP + WebSocket ---- */
const authed = req => { const u = new URL(req.url, "http://x"); const t = u.searchParams.get("token") || (req.headers.authorization || "").replace(/^Bearer /, ""); return TOKEN && t === TOKEN; };
const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { let b = ""; req.on("data", c => { b += c; if (b.length > 1e6) req.destroy(); }); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch (_) { r({}); } }); });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,OPTIONS" }); return res.end(); }
  if (u.pathname === "/health") return json(res, 200, { ok: true, status: feed.status, hasKey: !!CREDS.key, calls: feed.calls.size, day: feed.day, clients: wss.clients.size, version: VERSION });
  if (u.pathname === "/webhook/justcall" && req.method === "POST") { await readBody(req); backfill.wanted = true; log("webhook: re-sync requested"); return json(res, 200, { ok: true }); }
  if (!authed(req)) return json(res, 401, { error: "unauthorized" });
  if (u.pathname === "/state") return json(res, 200, lastState || buildState());
  if (u.pathname === "/manual" && req.method === "GET") return json(res, 200, manual);
  if (u.pathname === "/manual" && req.method === "POST") {
    const b = await readBody(req);
    const day = String(b.day || feed.day || etYMD(new Date())), agent = String(Number(b.agent || 0));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !REP_IDS.has(Number(agent))) return json(res, 400, { error: "need day and a known agent" });
    const cur = (manual[day] && manual[day][agent]) || { calls: 0, meetings: 0 };
    const next = { calls: Math.max(0, cur.calls + Number(b.calls || 0)), meetings: Math.max(0, cur.meetings + Number(b.meetings || 0)) };
    if (b.set) { next.calls = Math.max(0, Number(b.calls || 0)); next.meetings = Math.max(0, Number(b.meetings || 0)); }
    manual[day] = manual[day] || {}; manual[day][agent] = next;
    if (!next.calls && !next.meetings) delete manual[day][agent];
    if (!Object.keys(manual[day]).length) delete manual[day];
    saveManual(); push();
    if (Number(b.meetings || 0) > 0 && !b.set) { const rep = REPS.find(r => r.id === Number(agent)); lastAlert = { type: "alert", title: "Meeting set · " + (rep ? rep.name : "Rep"), body: "Added by manager", at: Date.now(), agent: Number(agent), test: false }; broadcast(lastAlert); }
    return json(res, 200, { ok: true, manual });
  }
  if (u.pathname === "/justcall-key" && req.method === "POST") {
    const b = await readBody(req); const key = String(b.key || "").trim(), secret = String(b.secret || "").trim();
    if (!key || !secret) return json(res, 400, { ok: false, message: "Paste both the API key and the API secret." });
    const saved = { key: CREDS.key, secret: CREDS.secret }; Object.assign(CREDS, { key, secret });
    try { await getCalls(Object.assign(range(etYMD(new Date())), { per_page: 1, page: 0 })); }
    catch (e) { Object.assign(CREDS, saved); return json(res, 400, { ok: false, message: e.kind === "auth" ? "JustCall didn't accept that key and secret." : (e.message || "Couldn't reach JustCall.") }); }
    try { fs.writeFileSync(keyFile(), JSON.stringify({ key, secret })); } catch (e) { log("key save failed", e.message); }
    feed.day = null; feed.week = null; feed.calls = new Map(); feed.ready = false; feed.updatedAt = null; backfill.page = 1; backfill.done = false; feed.backoffUntil = 0;
    clearTimeout(timer); tick();
    return json(res, 200, { ok: true, message: "Connected. The board is loading." });
  }
  if (u.pathname === "/replay-alert" && req.method === "POST") { if (lastAlert) broadcast(Object.assign({}, lastAlert, { at: Date.now() })); return json(res, 200, { ok: true, replayed: !!lastAlert }); }
  if (u.pathname === "/test-alert" && req.method === "POST") { const r = REPS[Math.floor(Math.random() * 3)]; broadcast(alertFor({ id: "test-" + Date.now(), agent: r.id, disp: "Meeting Set", contact: "Test contact", campaign: "Test campaign", note: "This is a test. Real ones look like this." })); return json(res, 200, { ok: true }); }
  if (u.pathname === "/resync" && req.method === "POST") { backfill.wanted = true; return json(res, 200, { ok: true }); }
  json(res, 404, { error: "not found" });
});
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (!authed(req)) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => { wss.emit("connection", ws, req); });
});
wss.on("connection", ws => {
  ws.isAlive = true; ws.on("pong", () => { ws.isAlive = true; });
  ws.send(JSON.stringify(lastState || buildState()));
  ws.on("error", () => {});
});
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); } }, 30000);
function broadcast(msg) { const s = JSON.stringify(msg); for (const ws of wss.clients) if (ws.readyState === 1) ws.send(s); }

server.listen(PORT, () => { log("Bullpen server", VERSION, "on", server.address().port, "data in", DATA_DIR); tick(); });
module.exports = { port: () => server.address() && server.address().port };
process.on("SIGTERM", () => { saveCache(true); process.exit(0); });
