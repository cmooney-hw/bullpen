// Pure counting logic, shared by the app and the tests. Same rules as the web Rep Call Board.
const GOAL = 250;
const REPS = [
  { id: 429429, name: "David Hibbetts" },
  { id: 493151, name: "Nicole Sosnin" },
  { id: 582196, name: "Brett Knieriem" },
  { id: 404619, name: "Connor Mooney", manager: true } // shown, but no goal and not in team totals
];
const INTERESTED = new Set(["interested", "meeting set"]);
// Reps sometimes log a booked meeting as "Other - See Notes" with "Meeting Set" in the note
const MEETING_NOTE_RE = /(meeting\s*(set|scheduled|booked)|(set|scheduled|booked)\s+(a\s+)?(meeting|demo|appointment)|appointment\s*(set|scheduled|booked))/i;
// Human connection: JustCall heard a person pick up and the call lasted at least a few seconds,
// or the rep logged an outcome that can only come from talking to someone
const HUMAN = new Set(["interested","meeting set","not interested"]);
const MIN_CONNECT_SECS = 5;
const DNC_RE = /(do\s*not\s*call|don'?t\s*call|\bdnc\b|remove (me|him|her|them|us)? ?from|take (me|him|her|them|us) off)/i;

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#039;": "'", "&#39;": "'", "&apos;": "'", "&nbsp;": " " };
function decode(s) {
  return String(s || "")
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#0?39);/g, m => ENTITIES[m] || m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}

const etFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const etYMD = d => etFmt.format(d);
const etHourFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false });
const etHour = d => Number(etHourFmt.format(d).replace(/^24$/, "0"));
const addDays = (ymd, n) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function rowFacts(r) {
  const ci = r.call_info || {};
  const when = new Date(String(r.call_date) + "T" + String(r.call_time) + "Z"); // call_date/time are UTC
  const disp = decode(ci.disposition);
  const note = decode(ci.notes);
  const dl = disp.toLowerCase();
  const isNI = dl === "not interested";
  const pickedUp = String(ci.call_answered_by || "").toLowerCase() === "human pickup" && Number(ci.duration || 0) >= MIN_CONNECT_SECS;
  return {
    id: r.call_id,
    agent: Number(r.agent_id),
    ts: isNaN(when) ? 0 : when.getTime(),
    contact: decode(r.contact_name),
    ymd: isNaN(when) ? String(r.call_user_date || "") : etYMD(when),
    hour: isNaN(when) ? -1 : etHour(when),
    campaign: decode(r.campaign && r.campaign.name),
    campaignId: r.campaign && r.campaign.id != null ? Number(r.campaign.id) : null,
    disp, note,
    interested: INTERESTED.has(dl) || (!isNI && MEETING_NOTE_RE.test(note)),
    human: pickedUp || HUMAN.has(dl) || (!isNI && MEETING_NOTE_RE.test(note)),
    notInterested: isNI && !DNC_RE.test(note)
  };
}

const dow = ymd => new Date(ymd + "T12:00:00Z").getUTCDay();
const mondayOf = ymd => addDays(ymd, -((dow(ymd) + 6) % 7));
function workdaysBetween(start, end) { let n = 0; for (let d = start; d <= end; d = addDays(d, 1)) if (dow(d) >= 1 && dow(d) <= 5) n++; return Math.max(n, 1); }

// calls: Map id -> facts. Numbers for the ET days start..end (inclusive).
function summarize(calls, start, end) {
  end = end || start;
  const days = start === end ? 1 : workdaysBetween(start, end);
  const per = {};
  for (const r of REPS) per[r.id] = { calls: 0, interested: 0, notInterested: 0, human: 0, lastCallTs: 0, camps: {}, byDay: {}, byHour: {} };
  for (const c of calls.values()) {
    if (c.ymd < start || c.ymd > end || !per[c.agent]) continue;
    const p = per[c.agent];
    p.calls++;
    p.byDay[c.ymd] = (p.byDay[c.ymd] || 0) + 1;
    if (c.hour >= 0) p.byHour[c.hour] = (p.byHour[c.hour] || 0) + 1;
    if (c.interested) p.interested++;
    if (c.notInterested) p.notInterested++;
    const k = c.campaign || "No campaign";
    const cc = p.camps[k] || (p.camps[k] = { name: k, calls: 0, interested: 0, notInterested: 0, human: 0 });
    cc.calls++;
    if (c.interested) cc.interested++;
    if (c.notInterested) cc.notInterested++;
    if (c.human) { p.human++; cc.human++; }
    if (c.ts > p.lastCallTs) p.lastCallTs = c.ts;
  }
  const team = { calls: 0, goal: 0, interested: 0, notInterested: 0, human: 0 };
  for (const r of REPS) {
    if (r.manager) continue;
    const p = per[r.id];
    team.calls += p.calls; team.goal += GOAL * days;
    team.interested += p.interested; team.notInterested += p.notInterested; team.human += p.human;
  }
  // Mon..Fri of the period's week, for the per-day bars (only meaningful for a week period)
  const weekDays = []; for (let i = 0; i < 5; i++) weekDays.push(addDays(mondayOf(start), i));
  return {
    start, end, days, team, weekDays,
    reps: REPS.map(r => Object.assign({ id: r.id, name: r.name, manager: !!r.manager, goal: r.manager ? null : GOAL * days }, per[r.id], { camps: Object.values(per[r.id].camps), daily: weekDays.map(d => per[r.id].byDay[d] || 0), hourly: Array.from({ length: 24 }, (_, h) => per[r.id].byHour[h] || 0) }))
  };
}

module.exports = { GOAL, REPS, rowFacts, summarize, etYMD, addDays, decode, mondayOf, dow };
