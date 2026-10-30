// Build-time smoke test: run the app for a few seconds against a tiny fake JustCall, fail if the main process throws.
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const now = new Date(), rows = [];
for (let i = 0; i < 120; i++) { const d = new Date(now.getTime() - i * 60000); rows.push({ call_id: 5000 - i, agent_id: [429429, 493151, 582196, 404619][i % 4], campaign: { id: 1, name: "Smoke Campaign" }, call_date: d.toISOString().slice(0, 10), call_time: d.toISOString().slice(11, 19), call_info: { disposition: i % 9 === 0 ? "Meeting Set" : i % 7 === 0 ? "Not Interested" : "No Answer", notes: i % 11 === 0 ? "meeting set for friday" : "" }, contact_name: "Test " + i }); }
const camps = [{ id: 1, name: "Smoke Campaign", status: "Remaining", created_date: now.toISOString().slice(0, 10), assigned_to_id: { team_members: [{ id: 429429 }] }, contacts_count: { imported: 100 } }];
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"); res.writeHead(200, { "content-type": "application/json" });
  if (u.pathname.endsWith("campaigns")) return res.end(JSON.stringify({ data: camps }));
  const pg = +u.searchParams.get("page") || 0, pp = +u.searchParams.get("per_page") || 100;
  res.end(JSON.stringify({ status: "success", data: rows.slice(pg * pp, pg * pp + pp) }));
}).listen(0, "127.0.0.1", () => {
  process.env.CALLBOARD_TEST_API = "http://127.0.0.1:" + srv.address().port + "/calls";
  // run the real Bullpen server in-process against the fake JustCall, then point the app at it
  process.env.PORT = "0"; process.env.ACCESS_TOKEN = "smoke"; process.env.JUSTCALL_KEY = "k"; process.env.JUSTCALL_SECRET = "s";
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bullpen-smoke-data-"));
  const { app } = require("electron");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bullpen-smoke-"));
  app.setPath("userData", home);
  fs.writeFileSync(path.join(home, "justcall.key"), JSON.stringify({ code: "smoke" }));
  process.on("uncaughtException", e => { console.error("SMOKE FAIL:", e && e.stack || e); app.exit(1); });
  process.on("unhandledRejection", e => { console.error("SMOKE FAIL (promise):", e && e.stack || e); app.exit(1); });
  const bserver = require("./server/index.js");
  const wait = setInterval(() => { if (!bserver.port()) return; clearInterval(wait); process.env.BULLPEN_SERVER = "http://127.0.0.1:" + bserver.port(); require("./main.js"); }, 50);
  app.whenReady().then(() => setTimeout(async () => {
    const r = await fetch(process.env.BULLPEN_SERVER + "/state?token=smoke").then(r => r.json()).catch(() => null);
    if (!r || !r.today || !r.today.team.calls) { console.error("SMOKE FAIL: server has no numbers", r && r.status); app.exit(1); }
    console.log("SMOKE OK", r.today.team.calls, "calls"); app.exit(0);
  }, 9000));
});
