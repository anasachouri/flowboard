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
        map[deviceId] = { id: deviceId, name, boardId, at: Date.now(), principal: pid };
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
});
