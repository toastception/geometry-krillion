"use strict";
// Geometry Krillion server. No dependencies: plain Node >= 18.
// Rooms live in memory. The answer banks never leave this process, so clients can't peek at valid answers.
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const G = require("./game.js");
const PORT = +process.env.PORT || 3000, ROUNDS = 7, ROUND_MS = 25000, REVEAL_MS = 9000, MAXP = 12;
const rooms = new Map();
const rej = new Set(); // rejected guesses are saved to rejected.txt so you can add missing valid answers
function logRej(q, t) { const l = q + "\t" + t.toLowerCase(); if (rej.has(l) || rej.size > 3000) return; rej.add(l); fs.appendFile(path.join(__dirname, "rejected.txt"), l + "\n", () => { }); }
const uid = () => crypto.randomBytes(9).toString("hex");
const clean = (s, n) => String(s || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);
const mkCode = () => { let c; do { c = Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[crypto.randomInt(24)]).join(""); } while (rooms.has(c)); return c; };

function pick(seen) {
  // One prompt per topic family, so a dive never repeats the same kind of question.
  // Families are chosen evenly; a family whose prompts were all seen recently is only slightly less likely.
  const fam = new Map(); G.Q.forEach((o, k) => { if (!fam.has(o.g)) fam.set(o.g, []); fam.get(o.g).push(k); });
  const all = [...fam.values()].map(ks => { const un = ks.filter(k => !seen.has(G.Q[k].q)); return { ks, un, score: crypto.randomInt(1000) / 1000 - (un.length ? 0 : 0.35) }; });
  if (all.every(f => !f.un.length)) seen.clear();
  return all.sort((a, b) => b.score - a.score).slice(0, ROUNDS).map(f => { const c = f.un.length ? f.un : f.ks; return c[crypto.randomInt(c.length)]; });
}

function mkRoom(timed, seen) {
  const r = { code: mkCode(), timed, phase: "lobby", host: null, players: new Map(), prompts: [], idx: -1, seen: new Set(seen), timer: null, endsAt: 0, results: null, touched: Date.now() };
  rooms.set(r.code, r); return r;
}
function addPlayer(r, name) {
  const p = { id: uid(), name: clean(name, 16) || "Diver", pts: 0, tiers: [], conn: null, ans: null, misses: 0 };
  r.players.set(p.id, p); if (!r.host) r.host = p.id; return p;
}
const live = r => [...r.players.values()].filter(p => p.conn);

function snap(r, p) {
  const inRound = r.phase === "round", showQ = inRound || r.phase === "reveal";
  const ms = r.phase === "round" && r.timed ? r.endsAt - Date.now() : r.phase === "reveal" && r.timed ? r.revealEnds - Date.now() : null;
  return {
    code: r.code, phase: r.phase, timed: r.timed, you: p.id, round: r.idx + 1, total: ROUNDS,
    q: showQ ? G.Q[r.prompts[r.idx]].q : null,
    msLeft: ms == null ? null : Math.max(0, ms), totalMs: r.phase === "round" ? ROUND_MS : REVEAL_MS,
    players: [...r.players.values()].map(x => ({ id: x.id, name: x.name, pts: x.pts, done: !!x.ans, on: !!x.conn, host: x.id === r.host })),
    my: p.ans ? { tier: p.ans.tier, name: p.ans.name, gain: p.ans.gain } : null, misses: p.misses,
    results: r.phase === "reveal" || r.phase === "final" ? r.results : null
  };
}
const send = (p, d) => { if (p.conn) { try { p.conn.write("data: " + JSON.stringify(d) + "\n\n"); } catch (e) { } } };
const bcast = r => r.players.forEach(p => send(p, snap(r, p)));

function startRound(r) {
  r.idx++; r.phase = "round"; r.results = null;
  r.players.forEach(p => { p.ans = null; p.misses = 0; });
  r.endsAt = Date.now() + ROUND_MS; clearTimeout(r.timer);
  if (r.timed) r.timer = setTimeout(() => endRound(r), ROUND_MS + 300);
  bcast(r);
}
function endRound(r) {
  if (r.phase !== "round") return; clearTimeout(r.timer);
  r.players.forEach(p => { if (!p.ans) p.ans = { tier: null, gain: 0, name: null }; p.pts += p.ans.gain; p.tiers.push(p.ans.tier); });
  r.results = [...r.players.values()].map(p => ({ id: p.id, name: p.name, tier: p.ans.tier, gain: p.ans.gain, pts: p.pts, tiers: p.tiers })).sort((a, b) => b.pts - a.pts);
  r.phase = "reveal"; r.revealEnds = Date.now() + REVEAL_MS; bcast(r);
  if (r.timed) r.timer = setTimeout(() => advance(r), REVEAL_MS);
}
function advance(r) {
  if (r.phase !== "reveal") return; clearTimeout(r.timer);
  if (r.idx >= ROUNDS - 1) { r.phase = "final"; bcast(r); } else startRound(r);
}
function startGame(r) {
  r.prompts = pick(r.seen); r.prompts.forEach(k => r.seen.add(G.Q[k].q));
  r.players.forEach(p => { p.pts = 0; p.tiers = []; });
  r.idx = -1; startRound(r);
}
function checkAllDone(r) { const l = live(r); if (r.phase === "round" && l.length && l.every(p => p.ans)) endRound(r); }
function reassignHost(r) { if (r.players.has(r.host) && r.players.get(r.host).conn) return; const n = live(r)[0]; if (n) r.host = n.id; }

function api(a) {
  const act = a.a;
  if (act === "create") {
    if (rooms.size > 500) return { ok: false, err: "Server is full. Try again soon." };
    const seen = Array.isArray(a.seen) ? a.seen.slice(0, 300).map(x => String(x).slice(0, 200)) : [];
    const r = mkRoom(a.timed !== false, seen), p = addPlayer(r, a.name);
    return { ok: true, room: r.code, pid: p.id };
  }
  const r = rooms.get(clean(a.room, 4).toUpperCase());
  if (!r) return { ok: false, err: "Room not found." };
  r.touched = Date.now();
  if (act === "join") {
    if (a.pid && r.players.has(a.pid)) return { ok: true, room: r.code, pid: a.pid };
    if (r.phase !== "lobby") return { ok: false, err: "That dive already started." };
    if (r.players.size >= MAXP) return { ok: false, err: "Room is full." };
    return { ok: true, room: r.code, pid: addPlayer(r, a.name).id };
  }
  const p = r.players.get(a.pid); if (!p) return { ok: false, err: "Not in this room." };
  const host = r.host === p.id;
  if (act === "start") { if (!host || (r.phase !== "lobby" && r.phase !== "final")) return { ok: false }; startGame(r); return { ok: true }; }
  if (act === "next") { if (!host) return { ok: false }; advance(r); return { ok: true }; }
  if (act === "answer") {
    if (r.phase !== "round" || p.ans) return { ok: false };
    const e = G.find(G.Q[r.prompts[r.idx]], clean(a.text, 60));
    if (!e) { logRej(G.Q[r.prompts[r.idx]].q, clean(a.text, 60)); p.misses++; return { ok: false, invalid: true, misses: p.misses }; }
    p.ans = { tier: e.t, name: e.n, gain: G.TN[e.t][1] };
    bcast(r); checkAllDone(r);
    return { ok: true, tier: e.t, name: e.n, gain: p.ans.gain };
  }
  if (act === "giveup") {
    if (r.phase !== "round" || p.ans || p.misses < 5) return { ok: false };
    p.ans = { tier: null, gain: 0, name: null }; bcast(r); checkAllDone(r); return { ok: true };
  }
  if (act === "leave") {
    r.players.delete(p.id); if (p.conn) try { p.conn.end(); } catch (e) { }
    if (!r.players.size) { clearTimeout(r.timer); rooms.delete(r.code); return { ok: true }; }
    reassignHost(r); bcast(r); checkAllDone(r); return { ok: true };
  }
  return { ok: false };
}

const index = () => fs.readFileSync(path.join(__dirname, "public", "index.html"));
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff" }); return res.end(index());
  }
  if (req.method === "GET" && u.pathname === "/healthz") { res.writeHead(200); return res.end("ok"); }
  if (req.method === "GET" && u.pathname === "/events") {
    const r = rooms.get(clean(u.searchParams.get("room"), 4).toUpperCase()), p = r && r.players.get(u.searchParams.get("pid"));
    if (!p) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    if (p.conn) try { p.conn.end(); } catch (e) { }
    p.conn = res; reassignHost(r); bcast(r);
    req.on("close", () => { if (p.conn === res) { p.conn = null; reassignHost(r); bcast(r); checkAllDone(r); } });
    return;
  }
  if (req.method === "POST" && u.pathname === "/api") {
    let b = ""; req.on("data", c => { b += c; if (b.length > 4000) req.destroy(); });
    req.on("end", () => {
      let out; try { out = api(JSON.parse(b || "{}")); } catch (e) { out = { ok: false, err: "Bad request." }; }
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(out));
    }); return;
  }
  res.writeHead(404); res.end("Not found");
}).listen(PORT, () => console.log("Geometry Krillion on http://localhost:" + PORT));

setInterval(() => rooms.forEach(r => r.players.forEach(p => { if (p.conn) try { p.conn.write(": ping\n\n"); } catch (e) { } })), 20000);
setInterval(() => rooms.forEach((r, c) => { if (!live(r).length && Date.now() - r.touched > 30 * 60 * 1000) { clearTimeout(r.timer); rooms.delete(c); } }), 5 * 60 * 1000);
