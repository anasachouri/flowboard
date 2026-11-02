/* FlowBoard live-sync server — zero dependencies, just Node.js.
   Run:  node flowboard-server.js   (or double-click start-flowboard.bat)
   Then open the printed address on every device on the same network/hotspot. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = 8765;
const DIR = __dirname;
const HTML_FILE = path.join(DIR, 'flowboard.html');
const DATA_FILE = path.join(DIR, 'flowboard-data.json');
const KEY_FILE = path.join(DIR, 'flowboard-key.txt');

/* board key: generated once, stored next to the server; only URLs containing it can read/write the board */
let KEY = '';
try { KEY = fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch (e) {}
if (!KEY) { KEY = crypto.randomBytes(9).toString('base64url'); try { fs.writeFileSync(KEY_FILE, KEY); } catch (e) {} }

const GUESTS_FILE = path.join(DIR, 'flowboard-guests.json');
const TIMERS_FILE = path.join(DIR, 'flowboard-timers.json');
const PRESENCE_FILE = path.join(DIR, 'flowboard-presence.json');
const PRESENCE_ACTIVE_MS = 45000;
const PRESENCE_KEEP_MS = 30 * 864e5;
function loadGuests() { try { return JSON.parse(fs.readFileSync(GUESTS_FILE, 'utf8')); } catch (e) { return []; } }
function saveGuests(g) { try { fs.writeFileSync(GUESTS_FILE, JSON.stringify(g, null, 2)); } catch (e) {} }
function loadTimers() { try { return JSON.parse(fs.readFileSync(TIMERS_FILE, 'utf8')); } catch (e) { return {}; } }
function saveTimers(t) { try { fs.writeFileSync(TIMERS_FILE, JSON.stringify(t)); } catch (e) {} }
function loadPresence() { try { return JSON.parse(fs.readFileSync(PRESENCE_FILE, 'utf8')); } catch (e) { return {}; } }
function savePresence(p) { try { fs.writeFileSync(PRESENCE_FILE, JSON.stringify(p)); } catch (e) {} }
function prunePresence(map) {
  const now = Date.now();
  const alive = {};
  for (const [id, row] of Object.entries(map || {})) {
    if (row && row.at && now - row.at < PRESENCE_KEEP_MS) alive[id] = row;
  }
  return alive;
}
function guestCoversBoard(g, boardId) {
  if (!g || !boardId) return false;
  if (!Array.isArray(g.boards)) return true;
  return g.boards.includes(boardId);
}
function buildPresenceList(map, boardId, scope, pid, guests, master) {
  const now = Date.now();
  const byPrincipal = new Map();
  for (const row of Object.values(map || {})) {
    if (!row || (boardId && row.boardId !== boardId)) continue;
    if (scope && !(row.boardId && scope.has(row.boardId))) continue;
    const key = row.principal || row.id;
    const active = !!(row.at && now - row.at < PRESENCE_ACTIVE_MS);
    const prev = byPrincipal.get(key);
    if (!prev || (row.at || 0) > (prev.at || 0)) {
      byPrincipal.set(key, {
        id: row.id,
        name: row.name,
        boardId: row.boardId,
        at: row.at || 0,
        active,
        self: row.principal === pid,
        inCall: !!(row.inCall && active),
      });
    }
  }
  if (master && boardId && Array.isArray(guests)) {
    for (const g of guests) {
      if (!guestCoversBoard(g, boardId)) continue;
      const key = 'guest:' + g.id;
      if (byPrincipal.has(key)) continue;
      byPrincipal.set(key, {
        id: 'invite:' + g.id,
        name: g.name || 'Guest',
        boardId,
        at: 0,
        active: false,
        self: false,
      });
    }
  }
  return [...byPrincipal.values()].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (a.name || '').localeCompare(b.name || '');
  });
}
function reqKey(req, url) {
  const q = (url.split('?')[1] || '').split('&').map(p => p.split('='));
  const qKey = (q.find(p => p[0] === 'key') || [])[1];
  return req.headers['x-board-key'] || (qKey ? decodeURIComponent(qKey) : '');
}
function isMaster(req, url) { return reqKey(req, url) === KEY; }
function findGuest(req, url) {
  const k = reqKey(req, url);
  return loadGuests().find(g => g.key === k) || null;
}
function authorized(req, url) { return isMaster(req, url) || !!findGuest(req, url); }
function principalOf(req, url) {
  if (isMaster(req, url)) return 'owner';
  const g = findGuest(req, url);
  return g ? 'guest:' + g.id : null;
}
/* scope: Set of board ids a guest may see/edit; null = everything (master or legacy invite) */
function scopeOf(req, url) {
  if (isMaster(req, url)) return null;
  const g = findGuest(req, url);
  return (g && Array.isArray(g.boards)) ? new Set(g.boards) : null;
}
function migrateLegacyTimer(data) {
  if (!data || !data.timer || typeof data.timer !== 'object') return data;
  const timers = loadTimers();
  if (!timers.owner) {
    timers.owner = data.timer;
    saveTimers(timers);
  }
  delete data.timer;
  return data;
}

function buildICS(data) {
  const esc = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const now = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FlowBoard//EN', 'X-WR-CALNAME:FlowBoard deadlines'];
  const boards = (data && data.boards) || [];
  for (const b of boards) {
    const doneCols = new Set((b.columns || []).filter(c => c && c.done).map(c => c.id));
    for (const t of (b.tasks || [])) {
      if (!t || !t.due || doneCols.has(t.colId)) continue;
      const raw = String(t.due).replace(/[-:]/g, '');
      L.push('BEGIN:VEVENT', 'UID:' + t.id + '@flowboard', 'DTSTAMP:' + now,
        raw.includes('T') ? 'DTSTART:' + raw + '00' : 'DTSTART;VALUE=DATE:' + raw.slice(0, 8),
        'SUMMARY:' + esc('📋 ' + t.title + (boards.length > 1 ? ' [' + b.name + ']' : '')),
        'DESCRIPTION:' + esc(t.desc),
        'END:VEVENT');
    }
  }
  L.push('END:VCALENDAR');
  return L.join('\r\n');
}

let iceCache = null;
async function iceServers() {
  const now = Date.now();
  if (iceCache && now - iceCache.at < 50 * 60000) return iceCache.data;
  let data = { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }], turn: false };
  try { if (process.env.FLOWBOARD_ICE) data = { iceServers: JSON.parse(process.env.FLOWBOARD_ICE), turn: /turns?:/.test(process.env.FLOWBOARD_ICE) }; } catch (e) { console.log('FLOWBOARD_ICE is not valid JSON:', e.message); }
  const id = process.env.TURN_KEY_ID, tok = process.env.TURN_KEY_API_TOKEN;
  if (id && tok) {
    try {
      const r = await fetch('https://rtc.live.cloudflare.com/v1/turn/keys/' + id + '/credentials/generate-ice-servers', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 4 * 3600 }),
      });
      if (r.ok) {
        const d = await r.json();
        if (d && Array.isArray(d.iceServers) && d.iceServers.length) { data = { iceServers: d.iceServers, turn: true }; console.log(new Date().toISOString() + ' Cloudflare TURN credentials OK'); }
      } else console.log('Cloudflare TURN credentials failed: HTTP ' + r.status);
    } catch (e) { console.log('Cloudflare TURN credentials failed:', (e.cause && e.cause.code) || e.message); }
  }
  iceCache = { at: now, data };
  return data;
}

/* Service worker: network-first for the app page, cached copy only when the server is unreachable
   (or slower than SW_TIMEOUT_MS). API calls are never cached. */
const SW_JS = `
const CACHE = 'flowboard-page';
const PAGES = ['/', '/index.html', '/flowboard.html'];
const SW_TIMEOUT_MS = 3000;
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !PAGES.includes(url.pathname)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = url.origin + '/';
    const net = fetch(req).then(r => {
      if (r.ok && (r.headers.get('content-type') || '').includes('text/html')) cache.put(key, r.clone());
      return r;
    });
    try {
      const r = await Promise.race([net, new Promise(res => setTimeout(res, SW_TIMEOUT_MS, null))]);
      /* 5xx = server/proxy up but app down (e.g. Cloudflare 521/522, Traefik 502): prefer the cached app */
      if (r && r.status < 500) return r;
      if (r) { const c = await cache.match(key); return c || r; }
    } catch (err) {}
    const cached = await cache.match(key);
    return cached || net;
  })());
});
`;

/* ===== AI rank via a local Ollama (same prompt/schema as worker.mjs aiRank on Workers AI) =====
   env OLLAMA_URL (e.g. http://10.10.x.x:11434) + OLLAMA_MODEL; optional OLLAMA_NUM_CTX (default 8192), OLLAMA_TIMEOUT_S (default 180). */
async function aiRank(body) {
  const base = (process.env.OLLAMA_URL || '').replace(/\/+$/, ''), model = process.env.OLLAMA_MODEL || '';
  if (!base || !model) return { ok: false, err: 'AI rank is not configured on this server: set OLLAMA_URL and OLLAMA_MODEL' };
  const goal = String((body && body.goal) || '').slice(0, 300);
  const tasks = (Array.isArray(body && body.tasks) ? body.tasks : []).slice(0, 60).map((t, i) => ({
    n: i + 1, id: String((t && t.id) || '').slice(0, 40), title: String((t && t.title) || '').slice(0, 140),
    desc: String((t && t.desc) || '').replace(/\s+/g, ' ').slice(0, 200),
    labels: (Array.isArray(t && t.labels) ? t.labels : []).slice(0, 6).map((x) => String(x).slice(0, 30)),
    due: String((t && t.due) || '').slice(0, 16), est: Number(t && t.est) || 0, column: String((t && t.column) || '').slice(0, 40),
  })).filter((t) => t.id && t.title);
  if (tasks.length < 2) return { ok: false, err: 'need at least two tasks' };
    const system = "You prioritise tasks on a small founding team's kanban board using the Pareto principle: a few tasks create most of the value. Score each task on IMPACT toward the stated goal (1 negligible, 2 minor, 3 useful, 4 important, 5 decisive) and EFFORT (1 under 30 minutes, 2 about an hour, 3 a few hours, 4 a day or two, 5 a week or more). Be decisive and use the full range: about one task in five deserves impact 4 or 5, and about one in five deserves 1. Judge impact by what the goal needs, not by urgency alone. Reply with JSON only.";
    const user = 'Today: ' + new Date().toISOString().slice(0, 10) + '\nGoal: ' + (goal || '(none given, infer the likely goal from the tasks)') + '\n\nTasks:\n' +
      tasks.map((t) => '#' + t.n + ' ' + t.title + (t.column ? ' [' + t.column + ']' : '') + (t.labels.length ? ' {' + t.labels.join(', ') + '}' : '') + (t.due ? ' due ' + t.due : '') + (t.est ? ' est ' + t.est + 'm' : '') + (t.desc ? '\n   ' + t.desc : '')).join('\n') +
      '\n\nReturn {"items":[{"n":1,"impact":1-5,"effort":1-5,"why":"at most 12 words"}, ...]} with every task number exactly once.';
    const schema = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, impact: { type: 'integer' }, effort: { type: 'integer' }, why: { type: 'string' } }, required: ['n', 'impact', 'effort'] } } }, required: ['items'] };
  const timeoutS = +process.env.OLLAMA_TIMEOUT_S || 180;
  let text;
  try {
    const r = await fetch(base + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutS * 1000),
      body: JSON.stringify({ model, stream: false, format: schema,
        options: { temperature: 0.2, num_ctx: +process.env.OLLAMA_NUM_CTX || 8192 },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    if (!r.ok) { const t = await r.text().catch(() => ''); console.log('AI rank: Ollama HTTP ' + r.status + ' ' + t.slice(0, 200)); return { ok: false, err: 'Ollama returned HTTP ' + r.status + (t ? ': ' + t.slice(0, 120) : '') }; }
    const d = await r.json();
    text = d && d.message && d.message.content;
  } catch (e) {
    const why = (e && e.name === 'TimeoutError') ? 'timed out after ' + timeoutS + ' s' : ((e && e.cause && e.cause.code) || (e && e.message) || String(e));
    console.log('AI rank: cannot reach Ollama at ' + base + ': ' + why);
    return { ok: false, err: 'cannot reach Ollama (' + why + ')' };
  }
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { const m = String(text || '').match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) {} } }
  if (!parsed || !Array.isArray(parsed.items)) return { ok: false, err: 'the model returned no usable JSON, try again' };
  const byN = new Map(tasks.map((t) => [t.n, t.id]));
  const clamp = (v) => Math.max(1, Math.min(5, Math.round(Number(v) || 3)));
  const seen = new Set();
  const items = parsed.items.map((it) => ({ id: byN.get(Number(it && it.n)) || '', impact: clamp(it && it.impact), effort: clamp(it && it.effort), why: String((it && it.why) || '').slice(0, 140) }))
    .filter((it) => it.id && !seen.has(it.id) && seen.add(it.id)); /* drop invented numbers and duplicates */
  console.log(new Date().toISOString() + ' AI rank: ' + model + ' scored ' + items.length + '/' + tasks.length + ' tasks');
  return { ok: true, items, model };
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (req.method === 'GET' && (url === '/' || url === '/index.html' || url === '/flowboard.html')) {
    fs.readFile(HTML_FILE, (err, buf) => {
      if (err) { res.writeHead(500, {'Content-Type':'text/plain'}); res.end('flowboard.html not found — keep it in the same folder as this server.'); return; }
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
      res.end(buf);
    });
    return;
  }

  if (url === '/sw.js' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'});
    res.end(SW_JS);
    return;
  }

  if (url === '/api/info' && req.method === 'GET') {
    const nets = os.networkInterfaces();
    const addrs = [];
    for (const k of Object.keys(nets)) for (const n of nets[k] || []) {
      if (n.family === 'IPv4' && !n.internal) addrs.push('http://' + n.address + ':' + PORT);
    }
    res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(JSON.stringify({addrs, port: PORT}));
    return;
  }

  if (url === '/api/guests') {
    if (!isMaster(req, req.url || '')) { res.writeHead(403, {'Content-Type':'text/plain'}); res.end('forbidden'); return; }
    if (req.method === 'GET') {
      res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify(loadGuests()));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        try {
          const b = JSON.parse(body || '{}');
          let guests = loadGuests();
          if (b && b.action === 'revoke' && b.id) guests = guests.filter(g => g.id !== b.id);
          else guests.push({ id: crypto.randomUUID(), name: String((b && b.name) || 'Guest').slice(0, 40),
            key: crypto.randomUUID().replace(/-/g, ''),
            boards: (Array.isArray(b && b.boardIds) && b.boardIds.length) ? b.boardIds : null,
            createdAt: Date.now() });
          saveGuests(guests);
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify(guests));
        } catch (e) { res.writeHead(400); res.end('{"ok":false}'); }
      });
      return;
    }
    res.writeHead(405); res.end('method not allowed'); return;
  }

  /* ICE servers for WebRTC (same as worker.mjs):
     - default: Cloudflare + Google STUN
     - env FLOWBOARD_ICE='[{"urls":[...]}]' replaces the list (e.g. own coturn)
     - env TURN_KEY_ID + TURN_KEY_API_TOKEN: short-lived Cloudflare Realtime TURN credentials, cached ~50 min */
  if (url === '/api/ice' && req.method === 'GET') {
    if (!authorized(req, req.url || '')) { res.writeHead(401, {'Content-Type':'text/plain'}); res.end('unauthorized'); return; }
    iceServers().then(data => {
      res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify(data));
    });
    return;
  }

  if (url === '/api/ai-rank' && req.method === 'POST') {
    if (!authorized(req, req.url || '')) { res.writeHead(401, {'Content-Type':'text/plain'}); res.end('unauthorized'); return; }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      let b = null; try { b = JSON.parse(body || '{}'); } catch (e) {}
      const out = b ? await aiRank(b) : { ok: false, err: 'bad json' };
      res.writeHead(b ? 200 : 400, {'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify(out));
    });
    return;
  }

  if (url === '/calendar.ics' && req.method === 'GET') {
    if (!authorized(req, req.url || '')) { res.writeHead(401, {'Content-Type':'text/plain'}); res.end('unauthorized'); return; }
    const scope = scopeOf(req, req.url || '');
    fs.readFile(DATA_FILE, (err, buf) => {
      let data = {};
      try { data = JSON.parse(buf); } catch (e) {}
      if (scope) data = { boards: (data.boards || []).filter(b => b && scope.has(b.id)) };
      res.writeHead(200, {'Content-Type':'text/calendar; charset=utf-8','Cache-Control':'no-store'});
      res.end(buildICS(data));
    });
    return;
  }

  if (url === '/api/state' && req.method === 'GET') {
    if (!authorized(req, req.url || '')) { res.writeHead(401, {'Content-Type':'text/plain'}); res.end('unauthorized'); return; }
    const scope = scopeOf(req, req.url || '');
    const pid = principalOf(req, req.url || '');
    fs.readFile(DATA_FILE, (err, buf) => {
      res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
      let data = {};
      if (!err) {
        try { data = JSON.parse(buf); } catch (e) {}
      }
      data = migrateLegacyTimer(data);
      if (data.timer !== undefined) {
        delete data.timer;
        try {
          const tmp = DATA_FILE + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(data));
          fs.renameSync(tmp, DATA_FILE);
        } catch (e) {}
      }
      const timers = loadTimers();
      const myTimer = (pid && timers[pid] && typeof timers[pid] === 'object') ? timers[pid] : null;
      const boards = scope ? (data.boards || []).filter(b => b && scope.has(b.id)) : (data.boards || []);
      res.end(JSON.stringify({ updatedAt: data.updatedAt || 0, boards, timer: myTimer }));
    });
    return;
  }

  if (url === '/api/state' && req.method === 'POST') {
    if (!authorized(req, req.url || '')) { res.writeHead(401, {'Content-Type':'text/plain'}); res.end('unauthorized'); return; }
    const scope = scopeOf(req, req.url || '');
    const pid = principalOf(req, req.url || '');
    let body = '';
    req.on('data', c => { body += c; if (body.length > 100e6) req.destroy(); });
    req.on('end', () => {
      try {
        const incoming = JSON.parse(body);
        if (!incoming || !Array.isArray(incoming.boards)) throw new Error('bad payload');
        if (incoming.timer !== undefined && pid) {
          const timers = loadTimers();
          if (incoming.timer && typeof incoming.timer === 'object') timers[pid] = incoming.timer;
          else delete timers[pid];
          saveTimers(timers);
        }
        let current = {};
        try { current = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
        current = migrateLegacyTimer(current);
        let out;
        if (!scope) {
          /* master: whole-state last-write-wins — never store shared timer in the blob */
          if (!current.updatedAt || (incoming.updatedAt || 0) >= current.updatedAt) {
            out = JSON.stringify({ updatedAt: incoming.updatedAt || 0, boards: incoming.boards });
          }
        } else {
          /* scoped guest: merge only invited boards, still respect LWW */
          if (!Array.isArray(current.boards)) current = { updatedAt: 0, boards: [] };
          const incomingAt = incoming.updatedAt || 0;
          if (!current.updatedAt || incomingAt >= current.updatedAt) {
            const map = new Map(current.boards.map(b => [b.id, b]));
            for (const b of incoming.boards) if (b && scope.has(b.id)) map.set(b.id, b);
            current.boards = [...map.values()];
            current.updatedAt = Math.max(current.updatedAt || 0, incomingAt);
            delete current.timer;
            out = JSON.stringify(current);
          }
        }
        if (out) {
          const tmp = DATA_FILE + '.tmp';
          fs.writeFileSync(tmp, out);
          fs.renameSync(tmp, DATA_FILE);            /* atomic-ish: never a half-written file */
        }
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end('{"ok":true}');
      } catch (e) {
        res.writeHead(400, {'Content-Type':'application/json'});
        res.end('{"ok":false}');
      }
    });
    return;
  }

  if (url.startsWith('/api/presence') && (req.method === 'GET' || req.method === 'POST')) {
    if (!authorized(req, req.url || '')) { res.writeHead(401, {'Content-Type':'text/plain'}); res.end('unauthorized'); return; }
    const scope = scopeOf(req, req.url || '');
    const pid = principalOf(req, req.url || '');
    const guest = findGuest(req, req.url || '');
    const master = isMaster(req, req.url || '');
    const guests = loadGuests();
    if (req.method === 'GET') {
      const q = new URL('http://x' + (req.url || ''));
      const boardId = q.searchParams.get('boardId') || '';
      let map = prunePresence(loadPresence());
      savePresence(map);
      const list = buildPresenceList(map, boardId, scope, pid, guests, master);
      res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({ ok: true, people: list }));
      return;
    }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const b = JSON.parse(body || '{}');
        const deviceId = String((b && b.deviceId) || '').slice(0, 80);
        const boardId = String((b && b.boardId) || '').slice(0, 80);
        const name = String((b && b.name) || (guest && guest.name) || (master ? 'Me' : 'Guest')).trim().slice(0, 40) || 'Guest';
        if (!deviceId || !boardId) {
          res.writeHead(400, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ ok: false, err: 'deviceId and boardId required' }));
          return;
        }
        if (scope && !scope.has(boardId)) {
          res.writeHead(403, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ ok: false, err: 'board not allowed' }));
          return;
        }
        let map = prunePresence(loadPresence());
        map[deviceId] = { id: deviceId, name, boardId, at: Date.now(), principal: pid, inCall: !!(b && b.inCall) };
        savePresence(map);
        const list = buildPresenceList(map, boardId, scope, pid, guests, master);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: true, people: list }));
      } catch (e) {
        res.writeHead(400, {'Content-Type':'application/json'});
        res.end('{"ok":false}');
      }
    });
    return;
  }

  res.writeHead(404, {'Content-Type':'text/plain'});
  res.end('Not found');
});

/* ===== board room: chat + WebRTC signalling over WebSocket (/api/call) =====
   Port of the Board Durable Object room in worker.mjs, zero dependencies (RFC 6455, text frames only). */
const CALL_MAX_PEERS = 6, ROOM_MAX_SOCKETS = 24, CHAT_KEEP = 150, CHAT_MAX_CHARS = 1000, WS_MAX = 65536;
const CHAT_FILE = path.join(DIR, 'flowboard-chat.json');
const rooms = new Map(); /* boardId -> Set<conn> */
function loadChat() { try { return JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8')); } catch (e) { return {}; } }
function saveChat(c) { try { const t = CHAT_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(c)); fs.renameSync(t, CHAT_FILE); } catch (e) {} }
function roomOf(id) { let r = rooms.get(id); if (!r) { r = new Set(); rooms.set(id, r); } return r; }
function wsFrame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | op;
  return Buffer.concat([head, payload]);
}
function wsSendRaw(c, op, buf) { if (c.gone) return; try { c.socket.write(wsFrame(op, buf)); } catch (e) {} }
function wsText(c, str) { wsSendRaw(c, 1, Buffer.from(str)); }
function wsJson(c, obj) { wsText(c, JSON.stringify(obj)); }
function callPeers(c) { const out = []; for (const o of roomOf(c.boardId)) if (o !== c && !o.gone && o.inCall) out.push({ id: o.peerId, name: o.name }); return out; }
function roomPeople(id) { const out = []; for (const o of roomOf(id)) if (!o.gone) out.push({ id: o.peerId, name: o.name, inCall: !!o.inCall }); return out; }
function broadcast(id, except, obj) { for (const o of roomOf(id)) if (o !== except) wsJson(o, obj); }
function joinCall(c) {
  if (callPeers(c).length >= CALL_MAX_PEERS) { wsJson(c, { type: 'full' }); return; }
  c.inCall = true;
  wsJson(c, { type: 'peers', self: c.peerId, peers: callPeers(c) });
  broadcast(c.boardId, c, { type: 'peer-joined', id: c.peerId, name: c.name });
}
function connGone(c) {
  if (c.gone) return;
  c.gone = true;
  const r = roomOf(c.boardId); r.delete(c);
  if (c.inCall) broadcast(c.boardId, c, { type: 'peer-left', id: c.peerId });
  if (!r.size) rooms.delete(c.boardId);
  try { c.socket.end(); } catch (e) {}
}
function onRoomMessage(c, raw) {
  if (raw === 'ping') { wsText(c, 'pong'); return; }
  if (raw.length > WS_MAX) return;
  let m; try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  if (m.type === 'join') {
    c.inCall = false;
    wsJson(c, { type: 'hello', self: c.peerId, pid: c.pid, people: roomPeople(c.boardId), chat: loadChat()[c.boardId] || [] });
    if (m.call) joinCall(c);
  } else if (m.type === 'call-join') {
    joinCall(c);
  } else if (m.type === 'call-leave') {
    if (c.inCall) { c.inCall = false; broadcast(c.boardId, c, { type: 'peer-left', id: c.peerId }); }
  } else if (m.type === 'signal' && typeof m.to === 'string' && m.data && typeof m.data === 'object') {
    for (const o of roomOf(c.boardId)) if (!o.gone && o.peerId === m.to) wsJson(o, { type: 'signal', from: c.peerId, name: c.name, data: m.data });
  } else if (m.type === 'chat') {
    const text = String(m.text || '').replace(/\s+$/, '').slice(0, CHAT_MAX_CHARS);
    if (!text.trim()) return;
    const msg = { id: crypto.randomUUID(), from: c.pid, peer: c.peerId, name: c.name, text, at: Date.now() };
    const all = loadChat(); const hist = Array.isArray(all[c.boardId]) ? all[c.boardId] : [];
    hist.push(msg); while (hist.length > CHAT_KEEP) hist.shift();
    all[c.boardId] = hist; saveChat(all);
    broadcast(c.boardId, null, { type: 'chat', msg });
  } else if (m.type === 'leave') {
    connGone(c);
  }
}
server.on('upgrade', (req, socket) => {
  const fail = (code, txt) => { try { socket.end('HTTP/1.1 ' + code + ' ' + txt + '\r\nConnection: close\r\n\r\n'); } catch (e) {} };
  const full = req.url || '';
  if (full.split('?')[0] !== '/api/call') return fail(404, 'Not Found');
  if ((req.headers.upgrade || '').toLowerCase() !== 'websocket' || !req.headers['sec-websocket-key']) return fail(426, 'Upgrade Required');
  if (!authorized(req, full)) return fail(401, 'Unauthorized');
  const q = new URL('http://x' + full).searchParams;
  const boardId = String(q.get('boardId') || '').slice(0, 80);
  if (!boardId) return fail(400, 'Bad Request');
  const scope = scopeOf(req, full);
  if (scope && !scope.has(boardId)) return fail(403, 'Forbidden');
  if (roomOf(boardId).size >= ROOM_MAX_SOCKETS) return fail(429, 'Too Many Requests');
  const guest = findGuest(req, full), master = isMaster(req, full);
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const c = {
    socket, boardId, inCall: false, gone: false, pid: principalOf(req, full),
    peerId: String(q.get('peerId') || crypto.randomUUID()).slice(0, 80),
    name: String((guest && guest.name) || q.get('name') || (master ? 'Me' : 'Guest')).trim().slice(0, 40) || 'Guest',
  };
  roomOf(boardId).add(c);
  let buf = Buffer.alloc(0), frag = [];
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; const big = buf.readBigUInt64BE(2); if (big > BigInt(WS_MAX * 2)) return connGone(c); len = Number(big); off = 10; }
      if (!masked || len > WS_MAX * 2) return connGone(c); /* clients must mask (RFC 6455 5.1) */
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 8) { wsSendRaw(c, 8, data.subarray(0, 2)); return connGone(c); }
      if (op === 9) { wsSendRaw(c, 10, data); continue; }
      if (op === 10) continue;
      if (op === 1 || op === 2 || op === 0) {
        frag.push(data);
        if (frag.reduce((n, b) => n + b.length, 0) > WS_MAX * 2) return connGone(c);
        if (!fin) continue;
        const msg = Buffer.concat(frag); frag = [];
        onRoomMessage(c, msg.toString('utf8'));
      }
    }
  });
  socket.on('close', () => connGone(c));
  socket.on('error', () => connGone(c));
});

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) addrs.push(n.address);
    }
  }
  console.log('');
  console.log('  FlowBoard live-sync server running!');
  console.log('  ------------------------------------');
  console.log('  On this laptop :  http://localhost:' + PORT + '/#key=' + KEY);
  addrs.forEach(a => console.log('  On your phone  :  http://' + a + ':' + PORT + '/#key=' + KEY + '   (same Wi-Fi / hotspot)'));
  if (!addrs.length) console.log('  (No network address found — connect to a Wi-Fi network or hotspot first.)');
  console.log('');
  console.log('  The part after #key= protects your board — only people with the full');
  console.log('  address can see it. The key is saved in flowboard-key.txt.');
  console.log('  Board data saves to flowboard-data.json in this folder.');
  console.log('  Press Ctrl+C to stop.');
  console.log('  AI rank: ' + (process.env.OLLAMA_URL && process.env.OLLAMA_MODEL ? 'Ollama ' + process.env.OLLAMA_MODEL + ' at ' + process.env.OLLAMA_URL : 'off (set OLLAMA_URL and OLLAMA_MODEL)'));
  console.log('  Calls: ' + (process.env.TURN_KEY_ID && process.env.TURN_KEY_API_TOKEN ? 'Cloudflare TURN enabled' : process.env.FLOWBOARD_ICE ? 'custom ICE list (FLOWBOARD_ICE)' : 'STUN only, no TURN relay'));
});
