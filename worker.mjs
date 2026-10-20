/* FlowBoard online sync — Cloudflare Worker + Durable Object (free plan).
   The board page is served from ./public, board data lives in a Durable Object,
   and every /api/state call must carry the BOARD_KEY secret. */
'use strict';

const PRESENCE_ACTIVE_MS = 45000;
const PRESENCE_KEEP_MS = 30 * 864e5;
const CALL_MAX_PEERS = 6; /* mesh WebRTC: fine for a founders' sprint, not a webinar */
const ROOM_MAX_SOCKETS = 24; /* call + chat-only sockets per board */
const CHAT_KEEP = 150; /* messages kept per board */
const CHAT_MAX_CHARS = 1000;

export class Board {
  constructor(state, env) {
    this.state = state; this.env = env;
    /* keep call sockets alive without waking the object */
    try { this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch (e) {}
  }
  async getGuests() {
    try { return JSON.parse(await this.state.storage.get('guests') || '[]'); } catch (e) { return []; }
  }
  principal(isMaster, guest) {
    return isMaster ? 'owner' : ('guest:' + (guest && guest.id));
  }
  async readTimer(pid) {
    const t = await this.state.storage.get('timer:' + pid);
    return t && typeof t === 'object' ? t : null;
  }
  async writeTimer(pid, timer) {
    if (!pid) return;
    if (timer && typeof timer === 'object') await this.state.storage.put('timer:' + pid, timer);
    else await this.state.storage.delete('timer:' + pid);
  }
  /* Migrate legacy shared state.timer into the owner bucket once */
  async migrateLegacyTimer(data) {
    if (!data || !data.timer || typeof data.timer !== 'object') return data;
    const existing = await this.readTimer('owner');
    if (!existing) await this.writeTimer('owner', data.timer);
    delete data.timer;
    return data;
  }
  async prunePresence(map) {
    const now = Date.now();
    const alive = {};
    for (const [id, row] of Object.entries(map || {})) {
      if (row && row.at && now - row.at < PRESENCE_KEEP_MS) alive[id] = row;
    }
    return alive;
  }
  guestCoversBoard(g, boardId) {
    if (!g || !boardId) return false;
    if (!Array.isArray(g.boards)) return true; /* legacy = all boards */
    return g.boards.includes(boardId);
  }
  buildPresenceList(map, boardId, scope, pid, guests, isMaster) {
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
    /* Owner also sees invitees who have not visited yet (gray) */
    if (isMaster && boardId && Array.isArray(guests)) {
      for (const g of guests) {
        if (!this.guestCoversBoard(g, boardId)) continue;
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

  /* ----- board room: one WebSocket per participant (Hibernation API, free plan) -----
     The DO relays WebRTC handshakes (offers/answers/ICE) between browsers and keeps a small
     per-board chat log. Audio and video flow peer to peer and never touch the Worker.
     A socket can be chat-only (inCall=false) or in the call (inCall=true). */
  wsAttach(ws) { try { return ws.deserializeAttachment() || null; } catch (e) { return null; } }
  wsSet(ws, patch) { const n = { ...(this.wsAttach(ws) || {}), ...patch }; try { ws.serializeAttachment(n); } catch (e) {} return n; }
  wsSend(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
  callRoom(boardId) { try { return this.state.getWebSockets('room:' + boardId); } catch (e) { return []; } }
  callBroadcast(boardId, except, obj) { for (const o of this.callRoom(boardId)) if (o !== except) this.wsSend(o, obj); }
  callPeers(boardId, except) {
    const out = [];
    for (const o of this.callRoom(boardId)) {
      if (o === except) continue;
      const b = this.wsAttach(o);
      if (b && !b.gone && b.inCall) out.push({ id: b.peerId, name: b.name });
    }
    return out;
  }
  roomPeople(boardId) {
    const out = [];
    for (const o of this.callRoom(boardId)) {
      const b = this.wsAttach(o);
      if (b && !b.gone) out.push({ id: b.peerId, name: b.name, inCall: !!b.inCall });
    }
    return out;
  }
  async chatHistory(boardId) {
    try { const v = await this.state.storage.get('chat:' + boardId); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  async joinCall(ws, a) {
    if (this.callPeers(a.boardId, ws).length >= CALL_MAX_PEERS) { this.wsSend(ws, { type: 'full' }); return false; }
    this.wsSet(ws, { inCall: true });
    this.wsSend(ws, { type: 'peers', self: a.peerId, peers: this.callPeers(a.boardId, ws) });
    this.callBroadcast(a.boardId, ws, { type: 'peer-joined', id: a.peerId, name: a.name });
    return true;
  }
  async webSocketMessage(ws, raw) {
    const a = this.wsAttach(ws);
    if (!a || a.gone) return;
    if (typeof raw !== 'string' || raw.length > 65536) return;
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.type === 'join') {
      this.wsSet(ws, { inCall: false });
      this.wsSend(ws, { type: 'hello', self: a.peerId, pid: a.pid, people: this.roomPeople(a.boardId), chat: await this.chatHistory(a.boardId) });
      if (m.call) await this.joinCall(ws, a);
    } else if (m.type === 'call-join') {
      await this.joinCall(ws, a);
    } else if (m.type === 'call-leave') {
      if (a.inCall) { this.wsSet(ws, { inCall: false }); this.callBroadcast(a.boardId, ws, { type: 'peer-left', id: a.peerId }); }
    } else if (m.type === 'signal' && typeof m.to === 'string' && m.data && typeof m.data === 'object') {
      for (const o of this.callRoom(a.boardId)) {
        const b = this.wsAttach(o);
        if (b && !b.gone && b.peerId === m.to) this.wsSend(o, { type: 'signal', from: a.peerId, name: a.name, data: m.data });
      }
    } else if (m.type === 'chat') {
      const text = String(m.text || '').replace(/\s+$/, '').slice(0, CHAT_MAX_CHARS);
      if (!text.trim()) return;
      const msg = { id: crypto.randomUUID(), from: a.pid, peer: a.peerId, name: a.name, text, at: Date.now() };
      const hist = await this.chatHistory(a.boardId);
      hist.push(msg);
      while (hist.length > CHAT_KEEP) hist.shift();
      await this.state.storage.put('chat:' + a.boardId, hist);
      this.callBroadcast(a.boardId, null, { type: 'chat', msg });
    } else if (m.type === 'leave') {
      this.callGone(ws);
      try { ws.close(1000, 'leave'); } catch (e) {}
    }
  }
  webSocketClose(ws, code, reason) { this.callGone(ws); try { ws.close(code, reason); } catch (e) {} }
  webSocketError(ws) { this.callGone(ws); try { ws.close(1011, 'error'); } catch (e) {} }
  callGone(ws) {
    const a = this.wsAttach(ws);
    if (!a || a.gone) return;
    this.wsSet(ws, { gone: true });
    if (a.inCall) this.callBroadcast(a.boardId, ws, { type: 'peer-left', id: a.peerId });
  }
  /* ----- AI rank: score open tasks against the board goal with Workers AI (free daily allowance) ----- */
  async aiRank(body) {
    const env = this.env || {};
    if (!env.AI || typeof env.AI.run !== 'function') return { ok: false, err: 'AI binding missing: add "ai": { "binding": "AI" } to wrangler.jsonc and redeploy' };
    const goal = String((body && body.goal) || '').slice(0, 300);
    const tasks = (Array.isArray(body && body.tasks) ? body.tasks : []).slice(0, 60).map((t, i) => ({
      n: i + 1, id: String((t && t.id) || '').slice(0, 40), title: String((t && t.title) || '').slice(0, 140),
      desc: String((t && t.desc) || '').replace(/\s+/g, ' ').slice(0, 200),
      labels: (Array.isArray(t && t.labels) ? t.labels : []).slice(0, 6).map((x) => String(x).slice(0, 30)),
      due: String((t && t.due) || '').slice(0, 16), est: Number(t && t.est) || 0, column: String((t && t.column) || '').slice(0, 40),
    })).filter((t) => t.id && t.title);
    if (tasks.length < 2) return { ok: false, err: 'need at least two tasks' };
    const model = env.AI_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
    const system = "You prioritise tasks on a small founding team's kanban board using the Pareto principle: a few tasks create most of the value. Score each task on IMPACT toward the stated goal (1 negligible, 2 minor, 3 useful, 4 important, 5 decisive) and EFFORT (1 under 30 minutes, 2 about an hour, 3 a few hours, 4 a day or two, 5 a week or more). Be decisive and use the full range: about one task in five deserves impact 4 or 5, and about one in five deserves 1. Judge impact by what the goal needs, not by urgency alone. Reply with JSON only.";
    const user = 'Today: ' + new Date().toISOString().slice(0, 10) + '\nGoal: ' + (goal || '(none given, infer the likely goal from the tasks)') + '\n\nTasks:\n' +
      tasks.map((t) => '#' + t.n + ' ' + t.title + (t.column ? ' [' + t.column + ']' : '') + (t.labels.length ? ' {' + t.labels.join(', ') + '}' : '') + (t.due ? ' due ' + t.due : '') + (t.est ? ' est ' + t.est + 'm' : '') + (t.desc ? '\n   ' + t.desc : '')).join('\n') +
      '\n\nReturn {"items":[{"n":1,"impact":1-5,"effort":1-5,"why":"at most 12 words"}, ...]} with every task number exactly once.';
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    const schema = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, impact: { type: 'integer' }, effort: { type: 'integer' }, why: { type: 'string' } }, required: ['n', 'impact', 'effort'] } } }, required: ['items'] };
    let out;
    try {
      out = await env.AI.run(model, { messages, max_tokens: 2048, temperature: 0.2, response_format: { type: 'json_schema', json_schema: schema } });
    } catch (e1) {
      try { out = await env.AI.run(model, { messages, max_tokens: 2048, temperature: 0.2 }); }
      catch (e2) { return { ok: false, err: 'model call failed: ' + ((e2 && e2.message) || e2) }; }
    }
    let text = out && typeof out === 'object' && 'response' in out ? out.response : out;
    let parsed = null;
    if (text && typeof text === 'object' && Array.isArray(text.items)) parsed = text;
    else if (typeof text === 'string') {
      try { parsed = JSON.parse(text); } catch (e) { const m = text.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) {} } }
    }
    if (!parsed || !Array.isArray(parsed.items)) return { ok: false, err: 'the model returned no usable JSON, try again' };
    const byN = new Map(tasks.map((t) => [t.n, t.id]));
    const clamp = (v) => Math.max(1, Math.min(5, Math.round(Number(v) || 3)));
    const items = parsed.items.map((it) => ({ id: byN.get(Number(it && it.n)) || '', impact: clamp(it && it.impact), effort: clamp(it && it.effort), why: String((it && it.why) || '').slice(0, 140) })).filter((it) => it.id);
    return { ok: true, items, model: model.replace(/^@cf\//, '') };
  }
  /* STUN is enough for most home / office networks. Set TURN_KEY_ID + TURN_KEY_API_TOKEN secrets
     (Cloudflare Realtime TURN) to also relay through strict corporate NATs. Credentials are cached ~50 min. */
  async iceServers() {
    const env = this.env || {};
    const now = Date.now();
    if (this._ice && now - this._ice.at < 50 * 60000) return this._ice.data;
    let data = { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }], turn: false };
    if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
      try {
        const r = await fetch('https://rtc.live.cloudflare.com/v1/turn/keys/' + env.TURN_KEY_ID + '/credentials/generate-ice-servers', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + env.TURN_KEY_API_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: 4 * 3600 }),
        });
        if (r.ok) {
          const d = await r.json();
          if (d && Array.isArray(d.iceServers) && d.iceServers.length) data = { iceServers: d.iceServers, turn: true };
        }
      } catch (e) {}
    }
    this._ice = { at: now, data };
    return data;
  }
  async fetch(req) {
    const url = new URL(req.url);
    const isMaster = req.headers.get('x-fb-master') === '1';
    const key = req.headers.get('x-fb-key') || '';

    /* ----- guest (invite link) management: master key only ----- */
    if (url.pathname === '/guests') {
      if (!isMaster) return new Response('forbidden', { status: 403 });
      let guests = await this.getGuests();
      if (req.method === 'GET') return Response.json(guests);
      if (req.method === 'POST') {
        try {
          const b = await req.json();
          if (b && b.action === 'revoke' && b.id) {
            guests = guests.filter(g => g.id !== b.id);
          } else {
            guests.push({ id: crypto.randomUUID(), name: String((b && b.name) || 'Guest').slice(0, 40),
              key: crypto.randomUUID().replace(/-/g, ''),
              boards: (Array.isArray(b && b.boardIds) && b.boardIds.length) ? b.boardIds : null, /* null = every board */
              createdAt: Date.now() });
          }
          await this.state.storage.put('guests', JSON.stringify(guests));
          return Response.json(guests);
        } catch (e) { return Response.json({ ok: false }, { status: 400 }); }
      }
      return new Response('Method not allowed', { status: 405 });
    }

    /* ----- board state: master key or any valid guest key ----- */
    let guest = null;
    if (!isMaster) {
      const guests = await this.getGuests();
      guest = guests.find(g => g.key === key);
      if (!guest) return new Response('unauthorized', { status: 401 });
    }
    /* scope: a Set of board ids this key may see/edit; null = everything (master or legacy invite) */
    const scope = (guest && Array.isArray(guest.boards)) ? new Set(guest.boards) : null;
    const pid = this.principal(isMaster, guest);

    /* ----- board room: ICE servers + WebSocket (call signalling and chat), any valid key, scoped to its boards ----- */
    if (url.pathname === '/ice' && req.method === 'GET') {
      return Response.json(await this.iceServers(), { headers: { 'Cache-Control': 'no-store' } });
    }
    if (url.pathname === '/ai-rank' && req.method === 'POST') {
      let body = null;
      try { body = await req.json(); } catch (e) { return Response.json({ ok: false, err: 'bad json' }, { status: 400 }); }
      return Response.json(await this.aiRank(body), { headers: { 'Cache-Control': 'no-store' } });
    }
    if (url.pathname === '/call') {
      if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
      const boardId = String(url.searchParams.get('boardId') || '').slice(0, 80);
      if (!boardId) return new Response('boardId required', { status: 400 });
      if (scope && !scope.has(boardId)) return new Response('board not allowed', { status: 403 });
      if (this.callRoom(boardId).length >= ROOM_MAX_SOCKETS) return new Response('room full', { status: 429 });
      const peerId = String(url.searchParams.get('peerId') || crypto.randomUUID()).slice(0, 80);
      const name = String((guest && guest.name) || url.searchParams.get('name') || (isMaster ? 'Me' : 'Guest')).trim().slice(0, 40) || 'Guest';
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server, ['room:' + boardId]);
      server.serializeAttachment({ boardId, peerId, name, pid, inCall: false });
      return new Response(null, { status: 101, webSocket: client });
    }

    /* ----- presence: who is looking at a board right now ----- */
    if (url.pathname === '/presence') {
      const guests = await this.getGuests();
      if (req.method === 'GET') {
        const boardId = url.searchParams.get('boardId') || '';
        let map = await this.prunePresence(await this.state.storage.get('presence') || {});
        await this.state.storage.put('presence', map);
        const list = this.buildPresenceList(map, boardId, scope, pid, guests, isMaster);
        return Response.json({ ok: true, people: list }, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (req.method === 'POST') {
        try {
          const b = await req.json();
          const deviceId = String((b && b.deviceId) || '').slice(0, 80);
          const boardId = String((b && b.boardId) || '').slice(0, 80);
          const name = String(
            (guest && guest.name) || (b && b.name) || (isMaster ? 'Me' : 'Guest')
          ).trim().slice(0, 40) || 'Guest';
          if (!deviceId || !boardId) return Response.json({ ok: false, err: 'deviceId and boardId required' }, { status: 400 });
          if (scope && !scope.has(boardId)) return Response.json({ ok: false, err: 'board not allowed' }, { status: 403 });
          let map = await this.prunePresence(await this.state.storage.get('presence') || {});
          map[deviceId] = { id: deviceId, name, boardId, at: Date.now(), principal: pid, inCall: !!(b && b.inCall) };
          await this.state.storage.put('presence', map);
          const list = this.buildPresenceList(map, boardId, scope, pid, guests, isMaster);
          return Response.json({ ok: true, people: list });
        } catch (e) {
          return Response.json({ ok: false }, { status: 400 });
        }
      }
      return new Response('Method not allowed', { status: 405 });
    }

    if (url.pathname !== '/state') return new Response('Not found', { status: 404 });

    if (req.method === 'GET') {
      const raw = await this.state.storage.get('state');
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch (e) {}
      data = await this.migrateLegacyTimer(data);
      if (data.timer !== undefined) {
        delete data.timer;
        await this.state.storage.put('state', JSON.stringify(data));
      }
      const myTimer = await this.readTimer(pid);
      if (!scope) {
        return new Response(JSON.stringify({
          updatedAt: data.updatedAt || 0,
          boards: data.boards || [],
          timer: myTimer,
        }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      }
      const filtered = {
        updatedAt: data.updatedAt || 0,
        boards: (data.boards || []).filter(b => b && scope.has(b.id)),
        timer: myTimer,
      };
      return new Response(JSON.stringify(filtered), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    if (req.method === 'POST') {
      try {
        const body = await req.text();
        if (body.length > 25e6) return Response.json({ ok: false, err: 'too large' }, { status: 413 });
        const incoming = JSON.parse(body);
        if (!incoming || !Array.isArray(incoming.boards)) throw new Error('bad payload');
        /* Pomodoro is per person (owner devices share; guests each have their own) */
        if (incoming.timer !== undefined) await this.writeTimer(pid, incoming.timer);
        const curRaw = await this.state.storage.get('state');
        let cur = {};
        try { cur = curRaw ? JSON.parse(curRaw) : {}; } catch (e) {}
        cur = await this.migrateLegacyTimer(cur);
        if (!scope) {
          /* master: whole-state last-write-wins — never store shared timer in the blob */
          if (!cur.updatedAt || (incoming.updatedAt || 0) >= cur.updatedAt) {
            const toStore = {
              updatedAt: incoming.updatedAt || 0,
              boards: incoming.boards,
            };
            await this.state.storage.put('state', JSON.stringify(toStore));
          }
        } else {
          /* scoped guest: merge only invited boards, and still respect LWW */
          if (!Array.isArray(cur.boards)) cur = { updatedAt: 0, boards: [] };
          const incomingAt = incoming.updatedAt || 0;
          if (!cur.updatedAt || incomingAt >= cur.updatedAt) {
            const map = new Map(cur.boards.map(b => [b.id, b]));
            for (const b of incoming.boards) if (b && scope.has(b.id)) map.set(b.id, b);
            cur.boards = [...map.values()];
            cur.updatedAt = Math.max(cur.updatedAt || 0, incomingAt);
            delete cur.timer;
            await this.state.storage.put('state', JSON.stringify(cur));
          }
        }
        return Response.json({ ok: true });
      } catch (e) {
        return Response.json({ ok: false }, { status: 400 });
      }
    }
    return new Response('Method not allowed', { status: 405 });
  }
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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const key = req.headers.get('x-board-key') || url.searchParams.get('key') || '';
    const isMaster = !!(env.BOARD_KEY && key === env.BOARD_KEY);
    /* sanitized headers to the Durable Object — clients can't fake these */
    const fwdHeaders = { 'x-fb-master': isMaster ? '1' : '0', 'x-fb-key': key, 'Content-Type': 'application/json' };
    const stub = () => env.BOARD.get(env.BOARD.idFromName('main'));

    if (url.pathname === '/api/state') {
      const body = req.method === 'POST' ? await req.text() : undefined;
      return stub().fetch(new Request('https://do/state', { method: req.method, headers: fwdHeaders, body }));
    }

    if (url.pathname === '/api/presence') {
      const body = req.method === 'POST' ? await req.text() : undefined;
      const path = req.method === 'GET'
        ? 'https://do/presence' + url.search
        : 'https://do/presence';
      return stub().fetch(new Request(path, { method: req.method, headers: fwdHeaders, body }));
    }

    /* video call: WebSocket signalling (key via ?key= because browsers can't set headers on WebSockets) */
    if (url.pathname === '/api/call') {
      if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
      const h = new Headers(req.headers);
      h.set('x-fb-master', isMaster ? '1' : '0');
      h.set('x-fb-key', key);
      return stub().fetch(new Request('https://do/call' + url.search, { method: 'GET', headers: h }));
    }
    if (url.pathname === '/api/ice' && req.method === 'GET') {
      return stub().fetch(new Request('https://do/ice', { headers: fwdHeaders }));
    }
    if (url.pathname === '/api/ai-rank' && req.method === 'POST') {
      const body = await req.text();
      return stub().fetch(new Request('https://do/ai-rank', { method: 'POST', headers: fwdHeaders, body }));
    }

    if (url.pathname === '/api/guests') {
      if (!isMaster) return new Response('forbidden', { status: 403 });
      const body = req.method === 'POST' ? await req.text() : undefined;
      return stub().fetch(new Request('https://do/guests', { method: req.method, headers: fwdHeaders, body }));
    }

    if (url.pathname === '/calendar.ics' && req.method === 'GET') {
      const r = await stub().fetch(new Request('https://do/state', { headers: fwdHeaders }));
      if (r.status !== 200) return new Response('unauthorized', { status: 401 });
      let data = {};
      try { data = JSON.parse(await r.text()); } catch (e) {}
      return new Response(buildICS(data), {
        headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'inline; filename=flowboard.ics' }
      });
    }

    /* everything else falls through to the static assets in ./public */
    return new Response('Not found', { status: 404 });
  }
};
