/* FlowBoard SaaS experiment. Separate from the personal key-based deploy.
   Auth DO holds accounts/sessions; each user gets an isolated UserBoard DO.
   Signup → verify email → admin approve → login. */
'use strict';

const SESSION_DAYS = 30;
const VERIFY_HOURS = 48;
const RESET_HOURS = 2;
const MAX_BODY = 25e6;

/* Privacy-safe feature counters only. Never task titles/notes */
const FEATURE_EVENTS = {
  pomodoro_start: true,
  pareto_open: true,
  analytics_open: true,
  task_create: true,
  task_open: true,
  filter_use: true,
  search_use: true,
  export: true,
  import: true,
  dark_mode: true,
  board_create: true,
  call_start: true,
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',...headers },
  });
}

function htmlPage(title, body) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:12vh auto;padding:24px;line-height:1.45;color:#1a1a1a}
a{color:#0b6bcb}.ok{color:#0a7a3e}.err{color:#b42318}</style></head><body>${body}</body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.get('Cookie') || '';
  raw.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function sessionCookie(token, req, clear) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  if (clear) return `fb_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  const max = SESSION_DAYS * 86400;
  return `fb_sess=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${max}${secure}`;
}

async function hashPassword(password, saltB64) {
  const enc = new TextEncoder();
  const salt = saltB64
    ? Uint8Array.from(atob(saltB64), c => c.charCodeAt(0))
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key,
    256
  );
  const hash = btoa(String.fromCharCode(...new Uint8Array(bits)));
  const saltOut = btoa(String.fromCharCode(...salt));
  return { hash, salt: saltOut };
}

function isEmailVerified(u) {
  if (!u || u.revoked) return false;
  if (u.admin) return true;
  /* legacy accounts (no field) count as verified */
  return u.emailVerified !== false;
}

/* Legacy accounts (no approved field) stay usable; new signups set approved:false */
function isApproved(u) {
  if (!u || u.revoked) return false;
  if (u.admin) return true;
  return u.approved !== false;
}

function publicUser(u) {
  if (!u) return null;
  const verified = isEmailVerified(u);
  const approved = isApproved(u);
  const st = u.stats || {};
  const features = {};
  const src = st.features || {};
  for (const k of Object.keys(FEATURE_EVENTS)) {
    const n = Number(src[k] || 0);
    if (n > 0) features[k] = n;
  }
  return {
    id: u.id,
    email: u.email,
    name: u.name || '',
    admin: !!u.admin,
    revoked: !!u.revoked,
    emailVerified: verified,
    approved,
    pending: verified && !approved && !u.revoked,
    unverified: !verified && !u.revoked,
    createdAt: u.createdAt || 0,
    lastLoginAt: u.lastLoginAt || 0,
    termsAccepted: !!u.termsAcceptedAt,
    stats: {
      logins: st.logins || 0,
      saves: st.saves || 0,
      lastSaveAt: st.lastSaveAt || 0,
      features,
    },
  };
}

/* ---------- per-user board state ---------- */
const PRESENCE_ACTIVE_MS = 45000;
const PRESENCE_KEEP_MS = 30 * 864e5;

const CALL_MAX_PEERS = 6; /* mesh WebRTC: fine for a founders' sprint, not a webinar */
const ROOM_MAX_SOCKETS = 24; /* call + chat-only sockets per board */
const CHAT_KEEP = 150; /* messages kept per board */
const CHAT_MAX_CHARS = 1000;

export class UserBoard {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    /* keep call sockets alive without waking the object */
    try { this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch (e) {}
  }
  async getGuests() {
    try {
      return JSON.parse((await this.state.storage.get('guests')) || '[]');
    } catch (e) {
      return [];
    }
  }
  principal(isMaster, guest) {
    return isMaster ? 'owner' : 'guest:' + (guest && guest.id);
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
    if (!Array.isArray(g.boards)) return true;
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

    /* Invite links: owner (master) only */
    if (url.pathname === '/guests') {
      if (!isMaster) return new Response('forbidden', { status: 403 });
      let guests = await this.getGuests();
      if (req.method === 'GET') return Response.json(guests);
      if (req.method === 'POST') {
        try {
          const b = await req.json();
          if (b && b.action === 'revoke' && b.id) {
            const removed = guests.find((g) => g.id === b.id) || null;
            guests = guests.filter((g) => g.id !== b.id);
            await this.state.storage.put('guests', JSON.stringify(guests));
            return Response.json({ guests, removed });
          }
          const guest = {
            id: crypto.randomUUID(),
            name: String((b && b.name) || 'Guest').slice(0, 40),
            email: (() => {
              const em = String((b && b.email) || '')
                .trim()
                .toLowerCase();
              return em && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em) ? em : undefined;
            })(),
            key: crypto.randomUUID().replace(/-/g, ''),
            boards: Array.isArray(b && b.boardIds) && b.boardIds.length ? b.boardIds : null,
            createdAt: Date.now(),
          };
          guests.push(guest);
          await this.state.storage.put('guests', JSON.stringify(guests));
          return Response.json({ guests, created: guest });
        } catch (e) {
          return json({ ok: false }, 400);
        }
      }
      return new Response('Method not allowed', { status: 405 });
    }

    let guest = null;
    if (!isMaster) {
      const guests = await this.getGuests();
      guest = guests.find((g) => g.key === key);
      if (!guest) return new Response('unauthorized', { status: 401 });
    }
    const scope = guest && Array.isArray(guest.boards) ? new Set(guest.boards) : null;
    const pid = this.principal(isMaster, guest);
    const guests = await this.getGuests();

    /* ----- board room: ICE servers + WebSocket (call signalling and chat), any valid key, scoped to its boards ----- */
    if (url.pathname === '/ice' && req.method === 'GET') {
      return Response.json(await this.iceServers(), { headers: { 'Cache-Control': 'no-store' } });
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

    if (url.pathname === '/presence') {
      if (req.method === 'GET') {
        const boardId = url.searchParams.get('boardId') || '';
        let map = await this.prunePresence((await this.state.storage.get('presence')) || {});
        await this.state.storage.put('presence', map);
        const list = this.buildPresenceList(map, boardId, scope, pid, guests, isMaster);
        return Response.json({ ok: true, people: list }, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (req.method === 'POST') {
        try {
          const b = await req.json();
          const deviceId = String((b && b.deviceId) || '').slice(0, 80);
          const boardId = String((b && b.boardId) || '').slice(0, 80);
          /* Prefer the invite name so the owner sees who they invited */
          const name = String(
            (guest && guest.name) || (b && b.name) || (isMaster ? 'Me' : 'Guest')
          )
            .trim()
            .slice(0, 40) || 'Guest';
          if (!deviceId || !boardId) return json({ ok: false, err: 'deviceId and boardId required' }, 400);
          if (scope && !scope.has(boardId)) return json({ ok: false, err: 'board not allowed' }, 403);
          let map = await this.prunePresence((await this.state.storage.get('presence')) || {});
          map[deviceId] = { id: deviceId, name, boardId, at: Date.now(), principal: pid, inCall: !!(b && b.inCall) };
          await this.state.storage.put('presence', map);
          const list = this.buildPresenceList(map, boardId, scope, pid, guests, isMaster);
          return Response.json({ ok: true, people: list });
        } catch (e) {
          return json({ ok: false }, 400);
        }
      }
      return new Response('Method not allowed', { status: 405 });
    }

    if (url.pathname === '/shared-refs' && req.method === 'GET') {
      if (!isMaster) return new Response('forbidden', { status: 403 });
      let refs = [];
      try {
        refs = (await this.state.storage.get('sharedRefs')) || [];
      } catch (e) {
        refs = [];
      }
      if (!Array.isArray(refs)) refs = [];
      return Response.json({ ok: true, refs }, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (url.pathname === '/shared-accept' && req.method === 'POST') {
      if (!isMaster) return new Response('forbidden', { status: 403 });
      try {
        const b = await req.json();
        const inviteKey = String((b && b.inviteKey) || '').trim();
        const ownerUserId = String((b && b.ownerUserId) || '').trim();
        const boardId = String((b && b.boardId) || '').trim();
        const boardName = String((b && b.boardName) || 'Shared board').trim().slice(0, 80);
        const ownerLabel = String((b && b.ownerLabel) || 'Friend').trim().slice(0, 60);
        const guestName = String((b && b.guestName) || '').trim().slice(0, 40);
        if (!inviteKey || !ownerUserId || !boardId) {
          return json({ ok: false, err: 'inviteKey, ownerUserId and boardId required' }, 400);
        }
        let refs = [];
        try {
          refs = (await this.state.storage.get('sharedRefs')) || [];
        } catch (e) {
          refs = [];
        }
        if (!Array.isArray(refs)) refs = [];
        const existing = refs.find((r) => r && r.inviteKey === inviteKey && r.boardId === boardId);
        if (existing) {
          existing.boardName = boardName;
          existing.ownerLabel = ownerLabel;
          existing.guestName = guestName || existing.guestName;
          existing.ownerUserId = ownerUserId;
          await this.state.storage.put('sharedRefs', refs);
          return Response.json({ ok: true, ref: existing, already: true });
        }
        const ref = {
          refId: crypto.randomUUID(),
          inviteKey,
          ownerUserId,
          boardId,
          boardName,
          ownerLabel,
          guestName,
          addedAt: Date.now(),
        };
        refs.push(ref);
        await this.state.storage.put('sharedRefs', refs);
        return Response.json({ ok: true, ref });
      } catch (e) {
        return json({ ok: false, err: 'Bad request' }, 400);
      }
    }

    if (url.pathname === '/shared-remove' && req.method === 'POST') {
      if (!isMaster) return new Response('forbidden', { status: 403 });
      try {
        const b = await req.json();
        const refId = String((b && b.refId) || '').trim();
        const inviteKey = String((b && b.inviteKey) || '').trim();
        let refs = [];
        try {
          refs = (await this.state.storage.get('sharedRefs')) || [];
        } catch (e) {
          refs = [];
        }
        if (!Array.isArray(refs)) refs = [];
        refs = refs.filter((r) => {
          if (!r) return false;
          if (refId && r.refId === refId) return false;
          if (!refId && inviteKey && r.inviteKey === inviteKey) return false;
          return true;
        });
        await this.state.storage.put('sharedRefs', refs);
        return Response.json({ ok: true, refs });
      } catch (e) {
        return json({ ok: false, err: 'Bad request' }, 400);
      }
    }

    if (url.pathname !== '/state') return new Response('Not found', { status: 404 });

    if (req.method === 'GET') {
      const raw = await this.state.storage.get('state');
      let data = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch (e) {}
      data = await this.migrateLegacyTimer(data);
      if (data.timer !== undefined) {
        delete data.timer;
        await this.state.storage.put('state', JSON.stringify(data));
      }
      const myTimer = await this.readTimer(pid);
      const payload = {
        updatedAt: data.updatedAt || 0,
        boards: scope ? (data.boards || []).filter((b) => b && scope.has(b.id)) : data.boards || [],
        timer: myTimer,
      };
      return new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
    if (req.method === 'POST') {
      try {
        const body = await req.text();
        if (body.length > MAX_BODY) return json({ ok: false, err: 'too large' }, 413);
        const incoming = JSON.parse(body);
        if (!incoming || !Array.isArray(incoming.boards)) throw new Error('bad payload');
        if (incoming.timer !== undefined) await this.writeTimer(pid, incoming.timer);
        const curRaw = await this.state.storage.get('state');
        let cur = {};
        try {
          cur = curRaw ? JSON.parse(curRaw) : {};
        } catch (e) {}
        cur = await this.migrateLegacyTimer(cur);
        if (!scope) {
          if (!cur.updatedAt || (incoming.updatedAt || 0) >= cur.updatedAt) {
            await this.state.storage.put(
              'state',
              JSON.stringify({ updatedAt: incoming.updatedAt || 0, boards: incoming.boards })
            );
          }
        } else {
          /* Guest scoped write: still respect LWW so a stale guest tab cannot clobber a newer board */
          if (!Array.isArray(cur.boards)) cur = { updatedAt: 0, boards: [] };
          const incomingAt = incoming.updatedAt || 0;
          if (!cur.updatedAt || incomingAt >= cur.updatedAt) {
            const map = new Map(cur.boards.map((b) => [b.id, b]));
            for (const b of incoming.boards) if (b && scope.has(b.id)) map.set(b.id, b);
            cur.boards = [...map.values()];
            cur.updatedAt = Math.max(cur.updatedAt || 0, incomingAt);
            delete cur.timer;
            await this.state.storage.put('state', JSON.stringify(cur));
          }
        }
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false }, 400);
      }
    }
    return new Response('Method not allowed', { status: 405 });
  }
}

/* ---------- accounts + sessions ---------- */
export class Auth {
  constructor(state) {
    this.state = state;
  }

  async getUserByEmail(email) {
    const id = await this.state.storage.get('email:' + email);
    if (!id) return null;
    return (await this.state.storage.get('user:' + id)) || null;
  }

  async getUser(id) {
    return (await this.state.storage.get('user:' + id)) || null;
  }

  async putUser(u) {
    await this.state.storage.put('user:' + u.id, u);
    await this.state.storage.put('email:' + u.email, u.id);
  }

  async listUsers() {
    const list = await this.state.storage.list({ prefix: 'user:' });
    const users = [];
    for (const v of list.values()) if (v && v.id) users.push(v);
    users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return users;
  }

  async createSession(userId) {
    const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    const exp = Date.now() + SESSION_DAYS * 864e5;
    await this.state.storage.put('sess:' + token, { userId, exp });
    return token;
  }

  async createVerifyToken(userId) {
    const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    const exp = Date.now() + VERIFY_HOURS * 3600e3;
    await this.state.storage.put('verify:' + token, { userId, exp, used: false });
    return token;
  }

  async createResetToken(userId) {
    const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    const exp = Date.now() + RESET_HOURS * 3600e3;
    await this.state.storage.put('reset:' + token, { userId, exp });
    return token;
  }

  async sessionUser(token, opts = {}) {
    if (!token) return null;
    const s = await this.state.storage.get('sess:' + token);
    if (!s || !s.userId || (s.exp && s.exp < Date.now())) {
      if (token) await this.state.storage.delete('sess:' + token);
      return null;
    }
    const u = await this.getUser(s.userId);
    if (!u || u.revoked) return null;
    if (!opts.allowPending && (!isEmailVerified(u) || !isApproved(u))) return null;
    return u;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const cookies = parseCookies(req);
    const token = cookies.fb_sess || '';
    const adminEmail = String(req.headers.get('x-admin-email') || '')
     .trim()
     .toLowerCase();

    if (path === '/signup' && req.method === 'POST') {
      try {
        const b = await req.json();
        const email = String((b && b.email) || '')
         .trim()
         .toLowerCase();
        const password = String((b && b.password) || '');
        const name = String((b && b.name) || '').trim().slice(0, 60);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, err: 'Invalid email' }, 400);
        if (password.length < 8) return json({ ok: false, err: 'Password must be at least 8 characters' }, 400);
        if (!(b && b.acceptTerms)) {
          return json({ ok: false, err: 'Please accept the terms to continue.' }, 400);
        }
        const existing = await this.getUserByEmail(email);
        /* Unverified signup left behind after a failed email send: allow retry */
        if (existing && !existing.revoked && !isEmailVerified(existing) && !existing.admin) {
          const { hash, salt } = await hashPassword(password);
          existing.passHash = hash;
          existing.salt = salt;
          if (name) existing.name = name;
          existing.termsAcceptedAt = existing.termsAcceptedAt || Date.now();
          if (existing.verifySentAt && Date.now() - existing.verifySentAt < 60000) {
            return json(
              {
                ok: false,
                needsVerify: true,
                email: existing.email,
                err: 'Account already awaiting verification. Please wait a minute, then use Resend verification email.',
              },
              409
            );
          }
          const verifyToken = await this.createVerifyToken(existing.id);
          existing.verifySentAt = Date.now();
          await this.putUser(existing);
          return json({
            ok: true,
            needsVerify: true,
            email: existing.email,
            user: publicUser(existing),
            verifyToken,
            err: 'Account already awaiting verification. We sent a new verification email.',
          });
        }
        if (existing) return json({ ok: false, err: 'Account already exists. Try logging in.' }, 409);
        const { hash, salt } = await hashPassword(password);
        const users = await this.listUsers();
        const isAdmin = (adminEmail && email === adminEmail) || users.length === 0;
        const u = {
          id: crypto.randomUUID(),
          email,
          name,
          passHash: hash,
          salt,
          admin: isAdmin,
          emailVerified: isAdmin,
          approved: isAdmin,
          revoked: false,
          createdAt: Date.now(),
          lastLoginAt: 0,
          verifySentAt: 0,
          termsAcceptedAt: Date.now(),
          stats: { logins: 0, saves: 0, lastSaveAt: 0, features: {} },
        };
        await this.putUser(u);
        if (isAdmin) {
          u.lastLoginAt = Date.now();
          u.stats.logins = 1;
          await this.putUser(u);
          const sess = await this.createSession(u.id);
          return json(
            { ok: true, user: publicUser(u) },
            200,
            { 'Set-Cookie': sessionCookie(sess, req, false) }
          );
        }
        const verifyToken = await this.createVerifyToken(u.id);
        u.verifySentAt = Date.now();
        await this.putUser(u);
        return json({
          ok: true,
          needsVerify: true,
          email: u.email,
          user: publicUser(u),
          verifyToken,
          err: 'Check your email for a verification link. After that, an admin must approve your account.',
        });
      } catch (e) {
        return json({ ok: false, err: 'Bad request' }, 400);
      }
    }

    if (path === '/login' && req.method === 'POST') {
      try {
        const b = await req.json();
        const email = String((b && b.email) || '')
         .trim()
         .toLowerCase();
        const password = String((b && b.password) || '');
        const u = await this.getUserByEmail(email);
        if (!u) return json({ ok: false, err: 'Email or password incorrect' }, 401);
        if (u.revoked) return json({ ok: false, err: 'Account revoked' }, 403);
        const { hash } = await hashPassword(password, u.salt);
        if (hash !== u.passHash) return json({ ok: false, err: 'Email or password incorrect' }, 401);
        if (adminEmail && u.email === adminEmail) {
          u.admin = true;
          u.approved = true;
          u.emailVerified = true;
        }
        if (!isEmailVerified(u)) {
          return json(
            {
              ok: false,
              needsVerify: true,
              email: u.email,
              err: 'Please verify your email first. Check your inbox (and spam), or resend the verification email.',
            },
            403
          );
        }
        if (!isApproved(u)) {
          return json(
            {
              ok: false,
              pending: true,
              err: 'Email verified. Waiting for admin approval.',
            },
            403
          );
        }
        u.lastLoginAt = Date.now();
        u.stats = u.stats || { logins: 0, saves: 0, lastSaveAt: 0, features: {} };
        u.stats.logins = (u.stats.logins || 0) + 1;
        if (b && b.acceptTerms) u.termsAcceptedAt = u.termsAcceptedAt || Date.now();
        await this.putUser(u);
        const sess = await this.createSession(u.id);
        return json(
          { ok: true, user: publicUser(u), needsTerms: !u.termsAcceptedAt },
          200,
          { 'Set-Cookie': sessionCookie(sess, req, false) }
        );
      } catch (e) {
        return json({ ok: false, err: 'Bad request' }, 400);
      }
    }

    if (path === '/verify-check' && req.method === 'POST') {
      try {
        const b = await req.json();
        const vt = String((b && b.token) || '').trim();
        if (!vt) return json({ ok: false, err: 'Missing token' }, 400);
        const row = await this.state.storage.get('verify:' + vt);
        if (!row || !row.userId || (row.exp && row.exp < Date.now())) {
          return json({
            ok: false,
            err: 'Link expired or invalid. On the login page, use “Resend verification email”.',
          }, 400);
        }
        const u = await this.getUser(row.userId);
        if (!u || u.revoked) return json({ ok: false, err: 'Account not found' }, 404);
        if (row.used || isEmailVerified(u)) {
          return json({
            ok: true,
            alreadyVerified: true,
            pending: !isApproved(u),
            err: isApproved(u)
              ? 'Email already verified. You can log in.'
              : 'Email already verified. Waiting for admin approval.',
          });
        }
        return json({
          ok: true,
          needsConfirm: true,
          email: u.email,
          err: 'Confirm to verify this email address.',
        });
      } catch (e) {
        return json({ ok: false, err: 'Bad request' }, 400);
      }
    }

    if (path === '/verify' && req.method === 'POST') {
      try {
        const b = await req.json();
        const vt = String((b && b.token) || '').trim();
        if (!vt) return json({ ok: false, err: 'Missing token' }, 400);
        const row = await this.state.storage.get('verify:' + vt);
        if (!row || !row.userId || (row.exp && row.exp < Date.now())) {
          if (vt && row && row.exp && row.exp < Date.now()) await this.state.storage.delete('verify:' + vt);
          return json({
            ok: false,
            err: 'Link expired or invalid. On the login page, use “Resend verification email”.',
          }, 400);
        }
        const u = await this.getUser(row.userId);
        if (!u || u.revoked) return json({ ok: false, err: 'Account not found' }, 404);
        if (row.used || isEmailVerified(u)) {
          row.used = true;
          await this.state.storage.put('verify:' + vt, row);
          return json({
            ok: true,
            alreadyVerified: true,
            pending: !isApproved(u),
            user: publicUser(u),
            err: isApproved(u)
              ? 'Email already verified. You can log in.'
              : 'Email already verified. Waiting for admin approval.',
          });
        }
        u.emailVerified = true;
        await this.putUser(u);
        row.used = true;
        await this.state.storage.put('verify:' + vt, row);
        return json({
          ok: true,
          pending: !isApproved(u),
          user: publicUser(u),
          err: isApproved(u)
            ? 'Email verified. You can log in.'
            : 'Email verified. Waiting for admin approval.',
        });
      } catch (e) {
        return json({ ok: false, err: 'Bad request' }, 400);
      }
    }

    if (path === '/resend-verify' && req.method === 'POST') {
      try {
        const b = await req.json();
        const email = String((b && b.email) || '')
         .trim()
         .toLowerCase();
        const u = await this.getUserByEmail(email);
        /* Do not reveal whether the account exists */
        if (!u || u.revoked || isEmailVerified(u)) {
          return json({ ok: true, err: 'If that account needs verification, a new email was sent.' });
        }
        if (u.verifySentAt && Date.now() - u.verifySentAt < 60000) {
          return json({ ok: false, err: 'Please wait a minute before requesting another email.' }, 429);
        }
        const verifyToken = await this.createVerifyToken(u.id);
        u.verifySentAt = Date.now();
        await this.putUser(u);
        return json({
          ok: true,
          needsVerify: true,
          verifyToken,
          email: u.email,
          err: 'Verification email sent.',
        });
      } catch (e) {
        return json({ ok: false, err: 'Bad request' }, 400);
      }
    }

    if (path === '/logout' && req.method === 'POST') {
      if (token) await this.state.storage.delete('sess:' + token);
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', req, true) });
    }

    if (path === '/accept-terms' && req.method === 'POST') {
      const u = await this.sessionUser(token);
      if (!u) return json({ ok: false, err: 'Not logged in' }, 401);
      u.termsAcceptedAt = Date.now();
      if (adminEmail && u.email === adminEmail) {
        u.admin = true;
        u.approved = true;
        u.emailVerified = true;
      }
      await this.putUser(u);
      return json({ ok: true, user: publicUser(u) });
    }

    if (path === '/change-password' && req.method === 'POST') {
      try {
        const u = await this.sessionUser(token);
        if (!u) return json({ ok: false, err: 'Not logged in' }, 401);
        const b = await req.json();
        const current = String((b && b.currentPassword) || '');
        const next = String((b && b.newPassword) || '');
        if (next.length < 8) return json({ ok: false, err: 'New password must be at least 8 characters' }, 400);
        const { hash: curHash } = await hashPassword(current, u.salt);
        if (curHash !== u.passHash) return json({ ok: false, err: 'Current password is incorrect' }, 401);
        const { hash, salt } = await hashPassword(next);
        u.passHash = hash;
        u.salt = salt;
        if (adminEmail && u.email === adminEmail) {
          u.admin = true;
          u.approved = true;
          u.emailVerified = true;
        }
        await this.putUser(u);
        return json({ ok: true, err: 'Password updated.' });
      } catch (e) {
        return json({ ok: false, err: 'Bad request' }, 400);
      }
    }

    if (path === '/forgot-password' && req.method === 'POST') {
      try {
        const b = await req.json();
        const email = String((b && b.email) || '')
         .trim()
         .toLowerCase();
        const generic = {
          ok: true,
          err: 'If that email has an account, a reset link was sent.',
        };
        const u = await this.getUserByEmail(email);
        if (!u || u.revoked) return json(generic);
        if (u.resetSentAt && Date.now() - u.resetSentAt < 60000) {
          return json({ ok: false, err: 'Please wait a minute before requesting another email.' }, 429);
        }
        const resetToken = await this.createResetToken(u.id);
        u.resetSentAt = Date.now();
        await this.putUser(u);
        return json({
          ok: true,
          resetToken,
          email: u.email,
          err: generic.err,
        });
      } catch (e) {
        return json({ ok: false, err: 'Bad request' }, 400);
      }
    }

    if (path === '/reset-password' && req.method === 'POST') {
      try {
        const b = await req.json();
        const rt = String((b && b.token) || '').trim();
        const next = String((b && b.newPassword) || '');
        if (!rt) return json({ ok: false, err: 'Missing token' }, 400);
        if (next.length < 8) return json({ ok: false, err: 'Password must be at least 8 characters' }, 400);
        const row = await this.state.storage.get('reset:' + rt);
        if (!row || !row.userId || (row.exp && row.exp < Date.now())) {
          if (rt) await this.state.storage.delete('reset:' + rt);
          return json({ ok: false, err: 'Reset link expired or invalid' }, 400);
        }
        const u = await this.getUser(row.userId);
        if (!u || u.revoked) return json({ ok: false, err: 'Account not found' }, 404);
        const { hash, salt } = await hashPassword(next);
        u.passHash = hash;
        u.salt = salt;
        if (adminEmail && u.email === adminEmail) {
          u.admin = true;
          u.approved = true;
          u.emailVerified = true;
        }
        await this.putUser(u);
        await this.state.storage.delete('reset:' + rt);
        return json({ ok: true, err: 'Password updated. You can log in.' });
      } catch (e) {
        return json({ ok: false, err: 'Bad request' }, 400);
      }
    }

    if (path === '/me' && req.method === 'GET') {
      const u = await this.sessionUser(token);
      if (!u) return json({ ok: false }, 401);
      if (adminEmail && u.email === adminEmail && !u.admin) {
        u.admin = true;
        u.approved = true;
        u.emailVerified = true;
        await this.putUser(u);
      }
      return json({ ok: true, user: publicUser(u) });
    }

    if (path === '/touch-save' && req.method === 'POST') {
      const u = await this.sessionUser(token);
      if (!u) return json({ ok: false }, 401);
      u.stats = u.stats || { logins: 0, saves: 0, lastSaveAt: 0, features: {} };
      u.stats.saves = (u.stats.saves || 0) + 1;
      u.stats.lastSaveAt = Date.now();
      await this.putUser(u);
      return json({ ok: true });
    }

    if (path === '/track' && req.method === 'POST') {
      try {
        const u = await this.sessionUser(token);
        if (!u) return json({ ok: false }, 401);
        const b = await req.json();
        const events = (b && b.events) || {};
        u.stats = u.stats || { logins: 0, saves: 0, lastSaveAt: 0, features: {} };
        u.stats.features = u.stats.features || {};
        let changed = false;
        for (const [k, raw] of Object.entries(events)) {
          if (!FEATURE_EVENTS[k]) continue;
          const n = Math.min(50, Math.max(0, Math.floor(Number(raw) || 0)));
          if (!n) continue;
          u.stats.features[k] = (u.stats.features[k] || 0) + n;
          changed = true;
        }
        if (changed) await this.putUser(u);
        return json({ ok: true, stats: publicUser(u).stats });
      } catch (e) {
        return json({ ok: false, err: 'Bad request' }, 400);
      }
    }

    if (path === '/admin/users' && req.method === 'GET') {
      const u = await this.sessionUser(token);
      if (!u || !u.admin) return json({ ok: false }, 403);
      const users = (await this.listUsers()).map(publicUser);
      return json({ ok: true, users });
    }

    if (path === '/admin/approve' && req.method === 'POST') {
      const admin = await this.sessionUser(token);
      if (!admin || !admin.admin) return json({ ok: false }, 403);
      try {
        const b = await req.json();
        const target = await this.getUser(b && b.userId);
        if (!target) return json({ ok: false, err: 'Not found' }, 404);
        /* Admin can force-verify stuck accounts (scanner burned the link, etc.) */
        if (b && b.forceVerify) target.emailVerified = true;
        if (!isEmailVerified(target)) {
          return json({ ok: false, err: 'User must verify their email first' }, 400);
        }
        target.approved = true;
        target.revoked = false;
        await this.putUser(target);
        return json({ ok: true, user: publicUser(target) });
      } catch (e) {
        return json({ ok: false }, 400);
      }
    }

    if (path === '/admin/mark-verified' && req.method === 'POST') {
      const admin = await this.sessionUser(token);
      if (!admin || !admin.admin) return json({ ok: false }, 403);
      try {
        const b = await req.json();
        const target = await this.getUser(b && b.userId);
        if (!target) return json({ ok: false, err: 'Not found' }, 404);
        target.emailVerified = true;
        await this.putUser(target);
        return json({ ok: true, user: publicUser(target) });
      } catch (e) {
        return json({ ok: false }, 400);
      }
    }

    if (path === '/admin/revoke' && req.method === 'POST') {
      const admin = await this.sessionUser(token);
      if (!admin || !admin.admin) return json({ ok: false }, 403);
      try {
        const b = await req.json();
        const id = b && b.userId;
        if (!id) return json({ ok: false, err: 'userId required' }, 400);
        if (id === admin.id) return json({ ok: false, err: 'Cannot revoke yourself' }, 400);
        const target = await this.getUser(id);
        if (!target) return json({ ok: false, err: 'Not found' }, 404);
        if (adminEmail && target.email === adminEmail) {
          return json({ ok: false, err: 'Cannot revoke the primary admin account' }, 400);
        }
        target.revoked = true;
        await this.putUser(target);
        return json({ ok: true, user: publicUser(target) });
      } catch (e) {
        return json({ ok: false }, 400);
      }
    }

    if (path === '/admin/restore' && req.method === 'POST') {
      const admin = await this.sessionUser(token);
      if (!admin || !admin.admin) return json({ ok: false }, 403);
      try {
        const b = await req.json();
        const target = await this.getUser(b && b.userId);
        if (!target) return json({ ok: false, err: 'Not found' }, 404);
        target.revoked = false;
        if (isEmailVerified(target)) {
          target.approved = true;
        } else {
          /* Unverified: unlock so they can use Resend verification, then you Approve */
          target.approved = false;
          target.emailVerified = false;
        }
        await this.putUser(target);
        return json({ ok: true, user: publicUser(target) });
      } catch (e) {
        return json({ ok: false }, 400);
      }
    }

    if (path === '/admin/delete' && req.method === 'POST') {
      const admin = await this.sessionUser(token);
      if (!admin || !admin.admin) return json({ ok: false }, 403);
      try {
        const b = await req.json();
        const id = b && b.userId;
        if (!id) return json({ ok: false, err: 'userId required' }, 400);
        if (id === admin.id) return json({ ok: false, err: 'Cannot delete yourself' }, 400);
        const target = await this.getUser(id);
        if (!target) return json({ ok: false, err: 'Not found' }, 404);
        if (adminEmail && target.email === adminEmail) {
          return json({ ok: false, err: 'Cannot delete the primary admin account' }, 400);
        }
        await this.state.storage.delete('user:' + target.id);
        await this.state.storage.delete('email:' + target.email);
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false }, 400);
      }
    }

    if (path === '/session' && req.method === 'GET') {
      const u = await this.sessionUser(token);
      if (!u) return json({ ok: false }, 401);
      return json({ ok: true, userId: u.id, user: publicUser(u) });
    }

    if (path === '/user-public' && req.method === 'GET') {
      const id = String(url.searchParams.get('id') || '').trim();
      if (!id) return json({ ok: false }, 400);
      const u = await this.getUser(id);
      if (!u || u.revoked) return json({ ok: false }, 404);
      return json({
        ok: true,
        user: {
          id: u.id,
          name: u.name || '',
          email: u.email || '',
        },
      });
    }

    if (path === '/emails-for-ids' && req.method === 'POST') {
      try {
        const b = await req.json();
        const ids = Array.isArray(b && b.ids) ? b.ids : [];
        const users = [];
        for (const raw of ids.slice(0, 20)) {
          const id = String(raw || '').trim();
          if (!id) continue;
          const u = await this.getUser(id);
          if (!u || u.revoked || !u.email) continue;
          users.push({
            id: u.id,
            email: u.email,
            name: u.name || '',
          });
        }
        return json({ ok: true, users });
      } catch (e) {
        return json({ ok: false, err: 'Bad request' }, 400);
      }
    }

    /* Global invite-key → owner lookup (internal; Worker only) */
    if (path === '/invite-get' && req.method === 'GET') {
      const key = String(url.searchParams.get('key') || '').trim();
      if (!key) return json({ ok: false }, 400);
      const meta = await this.state.storage.get('invite:' + key);
      if (!meta || !meta.ownerUserId) return json({ ok: false }, 404);
      return json({ ok: true, ownerUserId: meta.ownerUserId, guestId: meta.guestId || '', name: meta.name || '' });
    }
    if (path === '/invite-put' && req.method === 'POST') {
      try {
        const b = await req.json();
        const key = String((b && b.key) || '').trim();
        const ownerUserId = String((b && b.ownerUserId) || '').trim();
        if (!key || !ownerUserId) return json({ ok: false }, 400);
        await this.state.storage.put('invite:' + key, {
          ownerUserId,
          guestId: String((b && b.guestId) || ''),
          name: String((b && b.name) || '').slice(0, 40),
        });
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false }, 400);
      }
    }
    if (path === '/invite-delete' && req.method === 'POST') {
      try {
        const b = await req.json();
        const key = String((b && b.key) || '').trim();
        if (key) await this.state.storage.delete('invite:' + key);
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false }, 400);
      }
    }

    return new Response('Not found', { status: 404 });
  }
}

function buildICS(data) {
  const esc = s =>
    String(s || '')
     .replace(/\\/g, '\\\\')
     .replace(/;/g, '\\;')
     .replace(/,/g, '\\,')
     .replace(/\r?\n/g, '\\n');
  const now = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FlowBoard SaaS//EN', 'X-WR-CALNAME:FlowBoard deadlines'];
  const boards = (data && data.boards) || [];
  for (const b of boards) {
    const doneCols = new Set((b.columns || []).filter(c => c && c.done).map(c => c.id));
    for (const t of b.tasks || []) {
      if (!t || !t.due || doneCols.has(t.colId)) continue;
      const raw = String(t.due).replace(/[-:]/g, '');
      L.push(
        'BEGIN:VEVENT',
        'UID:' + t.id + '@flowboard-saas',
        'DTSTAMP:' + now,
        raw.includes('T') ? 'DTSTART:' + raw + '00' : 'DTSTART;VALUE=DATE:' + raw.slice(0, 8),
        'SUMMARY:' + esc('📋 ' + t.title + (boards.length > 1 ? ' [' + b.name + ']' : '')),
        'DESCRIPTION:' + esc(t.desc),
        'END:VEVENT'
      );
    }
  }
  L.push('END:VCALENDAR');
  return L.join('\r\n');
}

function authHeaders(req, env) {
  const h = new Headers(req.headers);
  h.set('x-admin-email', env.ADMIN_EMAIL || '');
  return h;
}

async function authFetch(env, req, path, init = {}) {
  const stub = env.AUTH.get(env.AUTH.idFromName('registry'));
  const method = init.method || req.method;
  let body = init.body;
  if (body === undefined && method !== 'GET' && method !== 'HEAD') body = await req.clone().text();
  return stub.fetch(
    new Request('https://auth' + path, {
      method,
      headers: authHeaders(req, env),
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
    })
  );
}

async function requireUser(env, req) {
  const r = await authFetch(env, req, '/session', { method: 'GET' });
  if (!r.ok) return null;
  return r.json();
}

/* Add or update a board member by stable account id (user:…). Returns true if changed. */
function upsertBoardMember(board, memberId, name, userId, email) {
  if (!board || !memberId || !name) return false;
  board.members = Array.isArray(board.members) ? board.members : [];
  const want = String(name).trim().slice(0, 60);
  if (!want) return false;
  const em = String(email || '')
    .trim()
    .toLowerCase();
  const emailOk = em && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em) ? em : '';
  let m = board.members.find((x) => x && x.id === memberId);
  if (!m) {
    m = board.members.find(
      (x) => x && String(x.name || '').toLowerCase() === want.toLowerCase() && !String(x.id || '').startsWith('user:')
    );
  }
  if (m) {
    let changed = false;
    if (m.id !== memberId) {
      m.id = memberId;
      changed = true;
    }
    if (m.name !== want) {
      m.name = want;
      changed = true;
    }
    if (userId && m.userId !== userId) {
      m.userId = userId;
      changed = true;
    }
    if (emailOk && m.email !== emailOk) {
      m.email = emailOk;
      changed = true;
    }
    return changed;
  }
  board.members.push({ id: memberId, name: want, userId: userId || undefined, email: emailOk || undefined });
  return true;
}

function remapAssignees(board, fromId, toId) {
  if (!board || !fromId || !toId || fromId === toId) return false;
  let changed = false;
  for (const list of [board.tasks, board.archive]) {
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      if (!t || !Array.isArray(t.assignees)) continue;
      let hit = false;
      t.assignees = t.assignees.map((id) => {
        if (id === fromId) {
          hit = true;
          return toId;
        }
        return id;
      });
      if (hit) {
        t.assignees = [...new Set(t.assignees.filter(Boolean))];
        changed = true;
      }
    }
  }
  return changed;
}

function publicOrigin(req) {
  const url = new URL(req.url);
  const xfProto = req.headers.get('x-forwarded-proto');
  const proto = xfProto || url.protocol.replace(':', '') || 'https';
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || url.host;
  return proto + '://' + host;
}

async function sendMail(env, { to, subject, text, html }) {
  const key = env.RESEND_API_KEY;
  if (!key) {
    return { ok: false, err: 'Email sending not configured (missing RESEND_API_KEY).' };
  }
  const from = env.FROM_EMAIL || 'FlowBoard <onboarding@resend.dev>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
  });
  if (!r.ok) {
    let detail = '';
    try {
      const j = await r.json();
      detail = (j && j.message) || JSON.stringify(j);
    } catch (e) {
      detail = await r.text();
    }
    return { ok: false, err: 'Could not send email: ' + (detail || r.status) };
  }
  return { ok: true };
}

async function sendCallEmail(env, { to, callerName, boardName, link }) {
  const clean = (s) => String(s || '').replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D\-]+/g, ' ').replace(/;/g, ',').replace(/\s+/g, ' ').trim();
  const who = clean(callerName) || 'Someone';
  const board = clean(boardName) || 'a board';
  const url = String(link || '');
  const subject = who + ' is inviting you to a video call on FlowBoard';
  const text = who + ' started a video call on the board "' + board + '" and would like you to join.\n\nJoin the call:\n' + url + '\n\nThe call runs in your browser, nothing to install.\n';
  const html = '<p><b>' + escHtml(who) + '</b> started a video call on the board <b>' + escHtml(board) + '</b> and would like you to join.</p><p><a href="' + escHtml(url) + '">Join the call</a></p><p style="color:#777">The call runs in your browser, nothing to install.</p>';
  return sendMail(env, { to, subject, text, html });
}

async function sendAssignEmail(env, { to, assignerName, taskTitle, boardName, link }) {
  const clean = (s) =>
    String(s || '')
      .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D\-]+/g, ' ')
      .replace(/;/g, ',')
      .replace(/\s+/g, ' ')
      .trim();
  const who = clean(assignerName) || 'Someone';
  const task = clean(taskTitle) || 'a task';
  const board = clean(boardName) || 'a board';
  const url = String(link || '');
  const subject = 'You were assigned a task on FlowBoard';
  const text =
    who +
    ' assigned you the task "' +
    task +
    '" on the board "' +
    board +
    '".\n\nOpen FlowBoard:\n' +
    url +
    '\n';
  const html =
    '<p><b>' +
    escHtml(who) +
    '</b> assigned you the task <b>' +
    escHtml(task) +
    '</b> on the board <b>' +
    escHtml(board) +
    '</b>.</p><p><a href="' +
    escHtml(url) +
    '">Open FlowBoard</a></p>';
  return sendMail(env, { to, subject, text, html });
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

async function sendVerifyEmail(env, to, link) {
  return sendMail(env, {
    to,
    subject: 'Verify your FlowBoard email',
    text:
      'Confirm your FlowBoard account by opening this link (valid 48 hours):\n\n' +
      link +
      '\n\nIf you did not sign up, ignore this email.',
    html:
      '<p>Confirm your FlowBoard account:</p><p><a href="' +
      link +
      '">Verify my email</a></p><p style="color:#666;font-size:13px">Link valid for 48 hours. If you did not sign up, ignore this email.</p>',
  });
}

async function sendResetEmail(env, to, link) {
  return sendMail(env, {
    to,
    subject: 'Reset your FlowBoard password',
    text:
      'Reset your FlowBoard password with this link (valid 2 hours):\n\n' +
      link +
      '\n\nIf you did not ask for a reset, ignore this email.',
    html:
      '<p>Reset your FlowBoard password:</p><p><a href="' +
      link +
      '">Choose a new password</a></p><p style="color:#666;font-size:13px">Link valid for 2 hours. If you did not ask for a reset, ignore this email.</p>',
  });
}

async function signupOrResendWithEmail(env, req, authPath) {
  const r = await authFetch(env, req, authPath);
  const data = await r.json().catch(() => ({}));
  const verifyToken = data.verifyToken;
  if (verifyToken) delete data.verifyToken;
  if (r.ok && verifyToken && data.needsVerify) {
    const origin = publicOrigin(req);
    const link = origin + '/api/auth/verify?token=' + encodeURIComponent(verifyToken);
    const sent = await sendVerifyEmail(env, data.email || (data.user && data.user.email), link);
    if (!sent.ok) {
      return json(
        {
          ok: false,
          needsVerify: true,
          email: data.email || (data.user && data.user.email) || undefined,
          err:
            (sent.err || 'Could not send verification email.') +
            ' Your account was saved — use “Resend verification email” after email is configured.',
        },
        503
      );
    }
    data.err =
      authPath === '/signup'
        ? 'Account created. Check your email to verify, then wait for admin approval.'
        : 'Verification email sent. Check your inbox (and spam).';
  }
  const headers = {};
  const sc = r.headers.get('Set-Cookie');
  if (sc) headers['Set-Cookie'] = sc;
  return json(data, r.status, headers);
}

async function forgotWithEmail(env, req) {
  const r = await authFetch(env, req, '/forgot-password');
  const data = await r.json().catch(() => ({}));
  const resetToken = data.resetToken;
  if (resetToken) delete data.resetToken;
  if (r.ok && resetToken && data.email) {
    const origin = publicOrigin(req);
    const link = origin + '/api/auth/reset?token=' + encodeURIComponent(resetToken);
    const sent = await sendResetEmail(env, data.email, link);
    if (!sent.ok) {
      return json({ ok: false, err: sent.err || 'Could not send reset email.' }, 503);
    }
  }
  /* Always same generic message when email field missing from response */
  return json(
    { ok: true, err: data.err || 'If that email has an account, a reset link was sent.' },
    r.status === 429 ? 429 : 200
  );
}

function resetFormPage(token, msg, ok) {
  const esc = s =>
    String(s || '')
     .replace(/&/g, '&amp;')
     .replace(/</g, '&lt;')
     .replace(/"/g, '&quot;');
  if (ok) {
    return htmlPage(
      'Password updated',
      `<h1 class="ok">Password updated</h1><p>${esc(msg)}</p><p><a href="/">Log in to FlowBoard</a></p>`
    );
  }
  if (!token) {
    return htmlPage(
      'Reset failed',
      `<h1 class="err">Could not reset</h1><p>${esc(msg || 'Invalid or expired link.')}</p><p><a href="/">Back to FlowBoard</a></p>`
    );
  }
  return htmlPage(
    'Reset password',
    `<h1>Reset password</h1>
     <p class="mut">Choose a new password (8+ characters).</p>
     ${msg ? `<p class="err">${esc(msg)}</p>` : ''}
     <form method="POST" action="/api/auth/reset" style="display:flex;flex-direction:column;gap:10px;margin-top:16px">
       <input type="hidden" name="token" value="${esc(token)}">
       <input type="password" name="password" placeholder="New password" minlength="8" required style="padding:10px;font-size:16px">
       <input type="password" name="password2" placeholder="Confirm password" minlength="8" required style="padding:10px;font-size:16px">
       <button type="submit" style="padding:10px;font-size:16px;cursor:pointer">Update password</button>
     </form>
     <p style="margin-top:14px"><a href="/">Cancel</a></p>`
  );
}

/* Who is this request acting as, and whose UserBoard does it land in? (invite key or session cookie) */
async function resolveBoardPrincipal(env, req, url) {
  const inviteKey = String(req.headers.get('x-board-key') || url.searchParams.get('key') || '').trim();
  if (inviteKey) {
    const auth = env.AUTH.get(env.AUTH.idFromName('registry'));
    const lr = await auth.fetch(new Request('https://auth/invite-get?key=' + encodeURIComponent(inviteKey), { method: 'GET' }));
    if (!lr.ok) return null;
    const meta = await lr.json().catch(() => null);
    if (!meta || !meta.ok || !meta.ownerUserId) return null;
    return { ownerUserId: meta.ownerUserId, isMaster: false, guestKey: inviteKey };
  }
  const sess = await requireUser(env, req);
  if (!sess || !sess.userId) return null;
  return { ownerUserId: sess.userId, isMaster: true, guestKey: '' };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === '/api/auth/signup' && req.method === 'POST') {
      return signupOrResendWithEmail(env, req, '/signup');
    }
    if (p === '/api/auth/resend-verify' && req.method === 'POST') {
      return signupOrResendWithEmail(env, req, '/resend-verify');
    }
    if (p === '/api/auth/forgot-password' && req.method === 'POST') {
      return forgotWithEmail(env, req);
    }
    if (p === '/api/auth/login') return authFetch(env, req, '/login');
    if (p === '/api/auth/logout') return authFetch(env, req, '/logout', { method: 'POST', body: '{}' });
    if (p === '/api/auth/change-password') return authFetch(env, req, '/change-password');
    if (p === '/api/auth/accept-terms') return authFetch(env, req, '/accept-terms');

    if (p === '/api/auth/verify' && req.method === 'GET') {
      const token = url.searchParams.get('token') || '';
      const esc = s =>
        String(s || '')
         .replace(/&/g, '&amp;')
         .replace(/</g, '&lt;')
         .replace(/"/g, '&quot;');
      const r = await authFetch(env, req, '/verify-check', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        return htmlPage(
          'Verify failed',
          `<h1 class="err">Could not verify</h1><p>${esc(data.err || 'Invalid or expired link.')}</p>
           <p>Open <a href="/">FlowBoard</a>, log in with your email, then tap <b>Resend verification email</b>.</p>`
        );
      }
      if (data.alreadyVerified) {
        return htmlPage(
          'Email verified',
          `<h1 class="ok">Email verified</h1><p>${esc(data.err || 'Thanks!')}</p><p><a href="/">Go to FlowBoard login</a></p>`
        );
      }
      /* Confirm step: email security scanners often GET links and would burn a one-click token */
      return htmlPage(
        'Verify email',
        `<h1>Verify your email</h1>
         <p>Confirm <b>${esc(data.email || 'this address')}</b> for FlowBoard.</p>
         <form method="POST" action="/api/auth/verify" style="margin-top:18px">
           <input type="hidden" name="token" value="${esc(token)}">
           <button type="submit" style="padding:12px 16px;font-size:16px;cursor:pointer;background:#0d9488;color:#fff;border:none;border-radius:8px">Verify my email</button>
         </form>
         <p style="margin-top:14px"><a href="/">Cancel</a></p>`
      );
    }

    if (p === '/api/auth/verify' && req.method === 'POST') {
      let token = '';
      const ctype = req.headers.get('content-type') || '';
      if (ctype.includes('application/json')) {
        const b = await req.json().catch(() => ({}));
        token = String((b && b.token) || '');
      } else {
        const form = await req.formData().catch(() => null);
        token = form ? String(form.get('token') || '') : '';
      }
      const esc = s =>
        String(s || '')
         .replace(/&/g, '&amp;')
         .replace(/</g, '&lt;')
         .replace(/"/g, '&quot;');
      const r = await authFetch(env, req, '/verify', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        return htmlPage(
          'Verify failed',
          `<h1 class="err">Could not verify</h1><p>${esc(data.err || 'Invalid or expired link.')}</p>
           <p>Open <a href="/">FlowBoard</a>, log in with your email, then tap <b>Resend verification email</b>.</p>`
        );
      }
      return htmlPage(
        'Email verified',
        `<h1 class="ok">Email verified</h1><p>${esc(data.err || 'Thanks!')}</p><p><a href="/">Go to FlowBoard login</a></p>`
      );
    }

    if (p === '/api/auth/reset' && req.method === 'GET') {
      const token = url.searchParams.get('token') || '';
      if (!token) return resetFormPage('', 'Missing reset token', false);
      return resetFormPage(token, '', false);
    }

    if (p === '/api/auth/reset' && req.method === 'POST') {
      let token = '';
      let password = '';
      let password2 = '';
      const ctype = req.headers.get('content-type') || '';
      if (ctype.includes('application/json')) {
        const b = await req.json().catch(() => ({}));
        token = String((b && b.token) || '');
        password = String((b && b.newPassword) || (b && b.password) || '');
        password2 = String((b && b.password2) || password);
      } else {
        const form = await req.formData();
        token = String(form.get('token') || '');
        password = String(form.get('password') || '');
        password2 = String(form.get('password2') || '');
      }
      if (password !== password2) {
        return resetFormPage(token, 'Passwords do not match. Go back and try again.', false);
      }
      const r = await authFetch(env, req, '/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, newPassword: password }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return resetFormPage('', data.err || 'Reset failed', false);
      return resetFormPage('', data.err || 'Password updated. You can log in.', true);
    }

    if (p === '/api/me') return authFetch(env, req, '/me', { method: 'GET' });
    if (p === '/api/track') return authFetch(env, req, '/track');
    if (p === '/api/notify-assign' && req.method === 'POST') {
      const inviteKey = String(req.headers.get('x-board-key') || url.searchParams.get('key') || '').trim();
      let sess = await requireUser(env, req);
      let assigner =
        (sess &&
          sess.user &&
          (sess.user.name || (sess.user.email && String(sess.user.email).split('@')[0]))) ||
        '';
      let selfUserId = (sess && sess.userId) || '';
      let selfEmail =
        (sess && sess.user && sess.user.email && String(sess.user.email).trim().toLowerCase()) || '';

      /* Guests on invite links are not logged in; allow notify via invite key */
      if (!selfUserId) {
        if (!inviteKey) return json({ ok: false, err: 'Not logged in' }, 401);
        const auth = env.AUTH.get(env.AUTH.idFromName('registry'));
        const lr = await auth.fetch(
          new Request('https://auth/invite-get?key=' + encodeURIComponent(inviteKey), { method: 'GET' })
        );
        if (!lr.ok) return json({ ok: false, err: 'Not logged in' }, 401);
        const meta = await lr.json().catch(() => null);
        if (!meta || !meta.ok || !meta.ownerUserId) return json({ ok: false, err: 'Not logged in' }, 401);
        assigner = String(meta.name || '').trim() || 'A teammate';
      }
      if (!assigner) assigner = 'A teammate';

      let body = {};
      try {
        body = await req.json();
      } catch (e) {
        return json({ ok: false, err: 'Bad request' }, 400);
      }
      let ids = Array.isArray(body.assigneeUserIds)
        ? body.assigneeUserIds.map((x) => String(x || '').trim()).filter(Boolean)
        : [];
      ids = [...new Set(ids)].filter((id) => id !== selfUserId).slice(0, 10);

      let emails = Array.isArray(body.assigneeEmails)
        ? body.assigneeEmails
            .map((x) => String(x || '').trim().toLowerCase())
            .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
        : [];
      emails = [...new Set(emails)].filter((e) => e !== selfEmail).slice(0, 10);

      if (!ids.length && !emails.length) return json({ ok: true, sent: 0 });

      const recipients = new Map(); /* email -> display hint */
      for (const e of emails) recipients.set(e, e);

      if (ids.length) {
        const er = await authFetch(env, req, '/emails-for-ids', {
          method: 'POST',
          body: JSON.stringify({ ids }),
        });
        const ej = await er.json().catch(() => ({}));
        const users = (ej && ej.users) || [];
        for (const u of users) {
          if (!u || !u.email) continue;
          const em = String(u.email).trim().toLowerCase();
          if (!em || em === selfEmail) continue;
          recipients.set(em, u.name || em);
        }
      }

      if (!recipients.size) return json({ ok: true, sent: 0 });

      const origin = publicOrigin(req);
      let sent = 0;
      for (const [to] of recipients) {
        const r = await sendAssignEmail(env, {
          to,
          assignerName: assigner,
          taskTitle: body.taskTitle || 'Untitled',
          boardName: body.boardName || 'Board',
          link: origin + '/',
        });
        if (r.ok) sent++;
      }
      return json({ ok: true, sent });
    }
    /* Video call invite by email (same recipient rules as task-assignment emails) */
    if (p === '/api/notify-call' && req.method === 'POST') {
      const inviteKey = String(req.headers.get('x-board-key') || url.searchParams.get('key') || '').trim();
      const sess = await requireUser(env, req);
      let caller = (sess && sess.user && (sess.user.name || (sess.user.email && String(sess.user.email).split('@')[0]))) || '';
      const selfUserId = (sess && sess.userId) || '';
      const selfEmail = (sess && sess.user && sess.user.email && String(sess.user.email).trim().toLowerCase()) || '';
      if (!selfUserId) {
        if (!inviteKey) return json({ ok: false, err: 'Not logged in' }, 401);
        const auth = env.AUTH.get(env.AUTH.idFromName('registry'));
        const lr = await auth.fetch(new Request('https://auth/invite-get?key=' + encodeURIComponent(inviteKey), { method: 'GET' }));
        if (!lr.ok) return json({ ok: false, err: 'Not logged in' }, 401);
        const meta = await lr.json().catch(() => null);
        if (!meta || !meta.ok || !meta.ownerUserId) return json({ ok: false, err: 'Not logged in' }, 401);
        caller = String(meta.name || '').trim() || 'A teammate';
      }
      if (!caller) caller = 'A teammate';
      let body = {};
      try { body = await req.json(); } catch (e) { return json({ ok: false, err: 'Bad request' }, 400); }
      let ids = Array.isArray(body.userIds) ? body.userIds.map((x) => String(x || '').trim()).filter(Boolean) : [];
      ids = [...new Set(ids)].filter((id) => id !== selfUserId).slice(0, 10);
      let emails = Array.isArray(body.emails) ? body.emails.map((x) => String(x || '').trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) : [];
      emails = [...new Set(emails)].filter((e) => e !== selfEmail).slice(0, 10);
      if (!ids.length && !emails.length) return json({ ok: true, sent: 0 });
      const recipients = new Set(emails);
      if (ids.length) {
        const er = await authFetch(env, req, '/emails-for-ids', { method: 'POST', body: JSON.stringify({ ids }) });
        const ej = await er.json().catch(() => ({}));
        for (const u of (ej && ej.users) || []) {
          const em = u && u.email ? String(u.email).trim().toLowerCase() : '';
          if (em && em !== selfEmail) recipients.add(em);
        }
      }
      const origin = publicOrigin(req);
      const boardId = String(body.boardId || '').slice(0, 80);
      const link = origin + '/' + (boardId ? '#call=' + encodeURIComponent(boardId) : '');
      let sent = 0;
      for (const to of recipients) {
        const r = await sendCallEmail(env, { to, callerName: caller, boardName: body.boardName || 'Board', link });
        if (r.ok) sent++;
      }
      return json({ ok: true, sent });
    }
    if (p === '/api/admin/users') return authFetch(env, req, '/admin/users', { method: 'GET' });
    if (p === '/api/admin/approve') return authFetch(env, req, '/admin/approve');
    if (p === '/api/admin/mark-verified') return authFetch(env, req, '/admin/mark-verified');
    if (p === '/api/admin/revoke') return authFetch(env, req, '/admin/revoke');
    if (p === '/api/admin/restore') return authFetch(env, req, '/admin/restore');
    if (p === '/api/admin/delete') return authFetch(env, req, '/admin/delete');

    if (p === '/api/shared' && req.method === 'GET') {
      const sess = await requireUser(env, req);
      if (!sess || !sess.userId) return json({ ok: false }, 401);
      const stub = env.USER_BOARD.get(env.USER_BOARD.idFromName('user:' + sess.userId));
      return stub.fetch(
        new Request('https://board/shared-refs', {
          method: 'GET',
          headers: { 'x-fb-master': '1' },
        })
      );
    }

    if (p === '/api/shared/accept' && req.method === 'POST') {
      const sess = await requireUser(env, req);
      if (!sess || !sess.userId) return json({ ok: false, err: 'Log in to save this shared board.' }, 401);
      let body = {};
      try {
        body = await req.json();
      } catch (e) {
        return json({ ok: false, err: 'Bad request' }, 400);
      }
      const inviteKey = String((body && body.inviteKey) || '').trim();
      if (!inviteKey) return json({ ok: false, err: 'Missing invite key' }, 400);

      const auth = env.AUTH.get(env.AUTH.idFromName('registry'));
      const lr = await auth.fetch(
        new Request('https://auth/invite-get?key=' + encodeURIComponent(inviteKey), { method: 'GET' })
      );
      if (!lr.ok) return json({ ok: false, err: 'Invite link is invalid or was revoked.' }, 404);
      const meta = await lr.json().catch(() => null);
      if (!meta || !meta.ok || !meta.ownerUserId) {
        return json({ ok: false, err: 'Invite link is invalid or was revoked.' }, 404);
      }
      if (meta.ownerUserId === sess.userId) {
        return json({ ok: false, err: 'That invite is for your own board.' }, 400);
      }

      const ownerStub = env.USER_BOARD.get(env.USER_BOARD.idFromName('user:' + meta.ownerUserId));
      const sr = await ownerStub.fetch(
        new Request('https://board/state', {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'x-fb-master': '0',
            'x-fb-key': inviteKey,
          },
        })
      );
      if (!sr.ok) return json({ ok: false, err: 'Could not open the shared board.' }, 403);
      const snap = await sr.json().catch(() => null);
      const boards = (snap && snap.boards) || [];
      if (!boards.length) return json({ ok: false, err: 'No boards available on that invite.' }, 404);

      let ownerLabel = 'Friend';
      try {
        const ou = await auth.fetch(
          new Request('https://auth/user-public?id=' + encodeURIComponent(meta.ownerUserId), { method: 'GET' })
        );
        if (ou.ok) {
          const oj = await ou.json().catch(() => null);
          if (oj && oj.user) {
            ownerLabel = oj.user.name || (oj.user.email && String(oj.user.email).split('@')[0]) || ownerLabel;
          }
        }
      } catch (e) {}

      const inviteeUser = sess.user || {};
      const inviteeLabel =
        inviteeUser.name ||
        (inviteeUser.email && String(inviteeUser.email).split('@')[0]) ||
        meta.name ||
        'Friend';

      /* Owner + accepter become assignable members on the shared board automatically */
      let membersChanged = false;
      const inviteeEmail =
        (inviteeUser.email && String(inviteeUser.email).trim().toLowerCase()) || '';
      for (const b of boards) {
        if (!b) continue;
        if (
          upsertBoardMember(b, 'user:' + meta.ownerUserId, ownerLabel, meta.ownerUserId) ||
          upsertBoardMember(b, 'user:' + sess.userId, inviteeLabel, sess.userId, inviteeEmail)
        ) {
          membersChanged = true;
        }
        /* Merge invite-name-only tags into the accepter's account member */
        if (meta.name) {
          const raw = (b.members || []).find(
            (m) =>
              m &&
              !String(m.id || '').startsWith('user:') &&
              String(m.name || '').toLowerCase() === String(meta.name).toLowerCase()
          );
          if (raw) {
            const dest = (b.members || []).find((m) => m && m.id === 'user:' + sess.userId);
            if (dest) {
              if (remapAssignees(b, raw.id, dest.id)) membersChanged = true;
              if (raw.email && !dest.email) {
                dest.email = raw.email;
                membersChanged = true;
              }
              b.members = b.members.filter((m) => m !== raw);
              membersChanged = true;
            }
          }
        }
      }
      if (membersChanged) {
        await ownerStub.fetch(
          new Request('https://board/state', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-fb-master': '0',
              'x-fb-key': inviteKey,
            },
            body: JSON.stringify({
              updatedAt: Math.max(Date.now(), (snap && snap.updatedAt) || 0),
              boards,
              timer: snap && snap.timer !== undefined ? snap.timer : undefined,
            }),
          })
        );
      }

      const inviteeStub = env.USER_BOARD.get(env.USER_BOARD.idFromName('user:' + sess.userId));
      const accepted = [];
      for (const b of boards) {
        if (!b || !b.id) continue;
        const ar = await inviteeStub.fetch(
          new Request('https://board/shared-accept', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-fb-master': '1' },
            body: JSON.stringify({
              inviteKey,
              ownerUserId: meta.ownerUserId,
              boardId: b.id,
              boardName: b.name || 'Shared board',
              ownerLabel,
              guestName: meta.name || '',
            }),
          })
        );
        const aj = await ar.json().catch(() => null);
        if (ar.ok && aj && aj.ref) accepted.push({ ref: aj.ref, board: b, already: !!aj.already });
      }
      if (!accepted.length) return json({ ok: false, err: 'Could not save shared board.' }, 500);
      return Response.json({
        ok: true,
        refs: accepted.map((a) => a.ref),
        boards: accepted.map((a) => a.board),
        err: accepted.some((a) => a.already)
          ? 'Shared board already in your list.'
          : 'Shared board added to your boards.',
      });
    }

    if (p === '/api/shared/remove' && req.method === 'POST') {
      const sess = await requireUser(env, req);
      if (!sess || !sess.userId) return json({ ok: false }, 401);
      const stub = env.USER_BOARD.get(env.USER_BOARD.idFromName('user:' + sess.userId));
      const body = await req.text();
      return stub.fetch(
        new Request('https://board/shared-remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-fb-master': '1' },
          body,
        })
      );
    }

    if (p === '/api/guests') {
      const sess = await requireUser(env, req);
      if (!sess || !sess.userId) return json({ ok: false }, 401);
      const board = env.USER_BOARD.get(env.USER_BOARD.idFromName('user:' + sess.userId));
      const body = req.method === 'POST' ? await req.text() : undefined;
      const r = await board.fetch(
        new Request('https://board/guests', {
          method: req.method,
          headers: { 'Content-Type': 'application/json', 'x-fb-master': '1' },
          body,
        })
      );
      if (req.method === 'GET') return r;
      if (!r.ok) return r;
      let data = {};
      try {
        data = await r.json();
      } catch (e) {
        return json({ ok: false }, 500);
      }
      const auth = env.AUTH.get(env.AUTH.idFromName('registry'));
      if (data.created && data.created.key) {
        await auth.fetch(
          new Request('https://auth/invite-put', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              key: data.created.key,
              ownerUserId: sess.userId,
              guestId: data.created.id,
              name: data.created.name,
            }),
          })
        );
      }
      if (data.removed && data.removed.key) {
        await auth.fetch(
          new Request('https://auth/invite-delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: data.removed.key }),
          })
        );
      }
      return Response.json(data.guests || [], { headers: { 'Cache-Control': 'no-store' } });
    }

    /* video call: ICE servers + WebSocket signalling, routed to the board owner's UserBoard */
    if (p === '/api/call' || (p === '/api/ice' && req.method === 'GET')) {
      const who = await resolveBoardPrincipal(env, req, url);
      if (!who) return json({ ok: false }, 401);
      const stub = env.USER_BOARD.get(env.USER_BOARD.idFromName('user:' + who.ownerUserId));
      const fwd = { 'x-fb-master': who.isMaster ? '1' : '0', 'x-fb-key': who.guestKey };
      if (p === '/api/ice') return stub.fetch(new Request('https://board/ice', { headers: fwd }));
      if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
      const h = new Headers(req.headers);
      for (const [k, v] of Object.entries(fwd)) h.set(k, v);
      return stub.fetch(new Request('https://board/call' + url.search, { method: 'GET', headers: h }));
    }

    if (p === '/api/presence') {
      const inviteKey = String(req.headers.get('x-board-key') || url.searchParams.get('key') || '').trim();
      let ownerUserId = null;
      let isMaster = false;
      let guestKey = '';

      if (inviteKey) {
        const auth = env.AUTH.get(env.AUTH.idFromName('registry'));
        const lr = await auth.fetch(
          new Request('https://auth/invite-get?key=' + encodeURIComponent(inviteKey), { method: 'GET' })
        );
        if (!lr.ok) return json({ ok: false }, 401);
        const meta = await lr.json().catch(() => null);
        if (!meta || !meta.ok || !meta.ownerUserId) return json({ ok: false }, 401);
        ownerUserId = meta.ownerUserId;
        guestKey = inviteKey;
        isMaster = false;
      } else {
        const sess = await requireUser(env, req);
        if (!sess || !sess.userId) return json({ ok: false }, 401);
        ownerUserId = sess.userId;
        isMaster = true;
      }

      const stub = env.USER_BOARD.get(env.USER_BOARD.idFromName('user:' + ownerUserId));
      const body = req.method === 'POST' ? await req.text() : undefined;
      const path =
        req.method === 'GET' ? 'https://board/presence' + url.search : 'https://board/presence';
      return stub.fetch(
        new Request(path, {
          method: req.method,
          headers: {
            'Content-Type': 'application/json',
            'x-fb-master': isMaster ? '1' : '0',
            'x-fb-key': guestKey,
          },
          body,
        })
      );
    }

    if (p === '/api/state') {
      const inviteKey = String(req.headers.get('x-board-key') || url.searchParams.get('key') || '').trim();
      let ownerUserId = null;
      let isMaster = false;
      let guestKey = '';

      if (inviteKey) {
        const auth = env.AUTH.get(env.AUTH.idFromName('registry'));
        const lr = await auth.fetch(
          new Request('https://auth/invite-get?key=' + encodeURIComponent(inviteKey), { method: 'GET' })
        );
        if (!lr.ok) return json({ ok: false }, 401);
        const meta = await lr.json().catch(() => null);
        if (!meta || !meta.ok || !meta.ownerUserId) return json({ ok: false }, 401);
        ownerUserId = meta.ownerUserId;
        guestKey = inviteKey;
        isMaster = false;
      } else {
        const sess = await requireUser(env, req);
        if (!sess || !sess.userId) return json({ ok: false }, 401);
        ownerUserId = sess.userId;
        isMaster = true;
      }

      const stub = env.USER_BOARD.get(env.USER_BOARD.idFromName('user:' + ownerUserId));
      const body = req.method === 'POST' ? await req.text() : undefined;
      const r = await stub.fetch(
        new Request('https://board/state', {
          method: req.method,
          headers: {
            'Content-Type': 'application/json',
            'x-fb-master': isMaster ? '1' : '0',
            'x-fb-key': guestKey,
          },
          body,
        })
      );
      if (req.method === 'POST' && r.ok && isMaster) {
        try {
          await authFetch(env, req, '/touch-save', { method: 'POST', body: '{}' });
        } catch (e) {}
      }
      return r;
    }

    if (p === '/calendar.ics' && req.method === 'GET') {
      const inviteKey = String(req.headers.get('x-board-key') || url.searchParams.get('key') || '').trim();
      let ownerUserId = null;
      let isMaster = false;
      let guestKey = '';
      if (inviteKey) {
        const auth = env.AUTH.get(env.AUTH.idFromName('registry'));
        const lr = await auth.fetch(
          new Request('https://auth/invite-get?key=' + encodeURIComponent(inviteKey), { method: 'GET' })
        );
        if (!lr.ok) return new Response('unauthorized', { status: 401 });
        const meta = await lr.json().catch(() => null);
        if (!meta || !meta.ok || !meta.ownerUserId) return new Response('unauthorized', { status: 401 });
        ownerUserId = meta.ownerUserId;
        guestKey = inviteKey;
      } else {
        const sess = await requireUser(env, req);
        if (!sess || !sess.userId) return new Response('unauthorized', { status: 401 });
        ownerUserId = sess.userId;
        isMaster = true;
      }
      const stub = env.USER_BOARD.get(env.USER_BOARD.idFromName('user:' + ownerUserId));
      const r = await stub.fetch(
        new Request('https://board/state', {
          method: 'GET',
          headers: {
            'x-fb-master': isMaster ? '1' : '0',
            'x-fb-key': guestKey,
          },
        })
      );
      if (!r.ok) return new Response('unauthorized', { status: 401 });
      let data = {};
      try {
        data = JSON.parse(await r.text());
      } catch (e) {}
      return new Response(buildICS(data), {
        headers: {
          'Content-Type': 'text/calendar; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Disposition': 'inline; filename=flowboard.ics',
        },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};
