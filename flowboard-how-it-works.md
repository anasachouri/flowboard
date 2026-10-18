# FlowBoard, how it's built

FlowBoard is a kanban/productivity app built as **one self-contained HTML file** with no frameworks, no build step, and no external dependencies. Everything, markup, styles, and the client logic, lives in `flowboard.html`. Open it in a browser and it runs, that's the whole install.

Recent user-facing changes are listed in **[CHANGELOG.md](CHANGELOG.md)**.

## The pieces

| File | What it does |
|---|---|
| `flowboard.html` | The entire client: UI, logic, storage, sync |
| `worker.mjs` + `wrangler.jsonc` | Personal Cloudflare Worker + `Board` Durable Object (key + invites) |
| `deploy-online.bat` / `set-key.bat` | Personal deploy + `BOARD_KEY` secret |
| `saas/worker.mjs` + `saas/wrangler.jsonc` | SaaS experiment: `Auth` + per-user `UserBoard` Durable Objects |
| `saas/deploy-saas.bat` | Builds SaaS page (`FLOWBOARD_SAAS=1`) and deploys `flowboard-saas` |
| `flowboard-server.js` | Optional local hotspot sync server |

## Data model

All client state is one JSON object:

```
state = {
  v: 2,
  settings: { dark, work, short, long, every },   // theme + pomodoro durations
  activeBoard: "<board id>",
  updatedAt: 1730000000000,                       // monotonic timestamp for sync
  timer: { mode, taskId, phase, running, ... } | null,  // synced pomodoro/stopwatch
  boards: [ {
    id, name,
    columns: [ { id, name, wip, done } ],          // wip = limit, done = "counts as complete"
    lanes:   [ { id, name, collapsed } ],          // swimlanes
    labels:  [ { id, name } ],
    members: [ { id, name } ],
    tasks:   [ { id, title, desc, color, labels[], assignees[], due, est,
                 impact, effort,                   // 1–5, feeds the Pareto view
                 recur,                            // '', 'd', 'w', 'm'
                 colId, laneId,                    // position on the board
                 subtasks[], attachments[],        // attachment bytes live in IndexedDB
                 timeLog: [ { d, s } ],            // seconds tracked per day
                 createdAt, doneAt } ],
    archive: [ ...tasks ],
    history: [ { d, c: {colId: count} } ]          // daily snapshot, drives the cumulative-flow chart
  } ]
}
```

A task's order in the `tasks` array is its order on the board, drag & drop just splices the array. **Done** columns (`done: true`) additionally **group by `doneAt` day** in the UI.

## Rendering

The UI uses immediate-mode rendering: any change updates `state`, calls `save()`, then `renderBoard()` rebuilds the DOM from scratch. No virtual DOM, no data binding, at kanban scale a full rebuild takes a few milliseconds. For very full columns only the first 200 cards are drawn, with a "Show all" button (`RENDER_CAP`), and a broken task renders as a ⚠ fallback card (`safeCardEl`) instead of blanking the page.

Charts (cumulative flow, throughput, time tracked) are drawn directly on `<canvas>`, no chart library.

## Storage, three layers

1. **localStorage** (`flowboard.v2`), the working copy, read synchronously at startup.
2. **IndexedDB**, two jobs: attachment files as Blobs (much larger quota than localStorage, and backups stay small), and a debounced JSON backup of the whole state. If localStorage's quota ever fills, saves keep flowing to IndexedDB and the app restores from it next launch.
3. **JSON export/import** (⋯ menu), manual backups, also the migration path between devices.

On every load, `repair()` sanitises whatever was stored: missing arrays are recreated, tasks pointing at deleted columns/lanes are remapped to the first one, wrong types are defaulted. Repair also runs on imported files and incoming sync data, so corrupt input can't crash the board.

## Sync, one protocol, three transports (+ SaaS auth)

Sync is deliberately simple: the whole `{updatedAt, boards, timer}` object is shipped around, and **last-write-wins**, whichever save has the newer `updatedAt` replaces the older one. `updatedAt` is monotonic (`max(now, previous+1)`), so a device with a slow clock can still overwrite state it just received.

- **Shared file** (Dropbox/Drive folder): File System Access handle, write on save, poll `lastModified`. Chrome/Edge desktop only.
- **Local server** (hotspot/Wi-Fi): `flowboard-server.js`, `GET/POST /api/state` + board key.
- **Cloudflare personal Worker**: same `/api/state` API, state in one `Board` Durable Object, auth via `BOARD_KEY` or guest invite keys.
- **Cloudflare SaaS Worker** (`saas/`): same client board sync, but session cookie → user id → **that user’s** `UserBoard` DO. Signup → email verify (`noreply@your-domain.example` via Resend) → admin approve → login. Light usage counters (logins/saves) live in the `Auth` DO, not task contents.

Client mode: if `window.FLOWBOARD_SAAS` is set (SaaS deploy injects it), the lock screen is login/signup and fetches use `credentials: 'include'`. Otherwise the classic key unlock UI is used.

## Video calls, WebRTC, signalled through the board's Durable Object

Calls are **peer to peer**. The only server piece is a small signalling room per board inside the same `Board` / `UserBoard` Durable Object that already holds the board:

- `GET /api/call?boardId=…&peerId=…&name=…[&key=…]` upgrades to a **WebSocket** (Hibernation API, so an idle call costs nothing). Auth is the same as `/api/state`: master key or invite key for personal (passed as `?key=` because browsers cannot set headers on WebSockets), session cookie or invite key for SaaS, and invite scopes are enforced per board.
- A socket is chat-only until it sends `call-join`. Messages are tiny JSON: `join` → `hello` (who is in the room, your principal, the chat history), `call-join` → `peers` (who is in the call) and `peer-joined` to the others, `call-leave` / socket close → `peer-left`, `signal {to, data}` is relayed as-is to one peer (SDP offers/answers and ICE candidates), `chat {text}` is stored (`chat:<boardId>`, last 150) and broadcast. The call is capped at `CALL_MAX_PEERS` (6), the room at 24 sockets.
- `GET /api/ice` returns the ICE server list: Cloudflare + Google **STUN** by default, plus short-lived **TURN** credentials from Cloudflare Realtime when the `TURN_KEY_ID` / `TURN_KEY_API_TOKEN` secrets are set (cached in the DO for ~50 min).

On the client (`video call` section in `flowboard.html`): one `RTCPeerConnection` per other participant (mesh), using the W3C **perfect negotiation** pattern so both sides can renegotiate safely (screen share swaps the outgoing video track with `replaceTrack`, a participant without a camera still receives). The presence heartbeat carries `inCall`, which is how everyone else on the board gets the **Join / Not now** banner, the chime and the pulsing header button (a `peer-joined` on an open chat socket triggers an immediate heartbeat so the ring is near-instant). A `#call=<boardId>` link opens that board and shows the Join banner. Media never leaves the browsers, nothing is recorded.

## Security model

**Personal:** Every `/api/state` call must carry the board key (`x-board-key` or `?key=` for beacons). Cloudflare stores the master key as a secret (`set-key.bat`). Guests get scoped invite keys (board ids only). `#key=` in the URL fragment is not sent to servers as a normal query, the app stores it in localStorage.

**SaaS:** Passwords are PBKDF2-SHA256 hashed in the Auth DO. Sessions are HttpOnly `fb_sess` cookies. New users must verify email, then an admin Approves (or Revokes). Each user’s boards are isolated by Durable Object id (`user:<id>`).

Attachments are never uploaded, they stay in each device’s IndexedDB.

## Feature map (where to look in flowboard.html)

Search for these section comments / symbols in the `<script>`:

`state` / `repair` → `attachments` → `filters` / `updateFilterBtn` → `groupByDoneDate` (done-column grouping) → `boards (multi)` → `renderBoard` → `drag & drop` / `releaseTimerTask` → `task modal` → `pomodoro` (`startTimer`, no pause/skip) → `video call` (`startCall`, `makePc`, `onSignal`) → `analytics` → `pareto` → `archive` → `import / export` → `shared-file sync` → `live server sync` (`SAAS`, `apiFetch`, `trySaasAuth`, `openAdmin`) → `theme & events` → `init`.

## Design decisions, briefly

Single file means zero install, works from a USB stick, trivially copyable, the deploy script literally copies it. No dependencies means nothing to update and no supply-chain risk. Last-write-wins instead of merging keeps sync understandable and debuggable. Polling instead of WebSockets keeps the server small and works on the free Cloudflare tier. Personal vs SaaS are **two Workers** so experiments never risk wiping the owner’s private board.

## Extending it

Add a field to tasks: extend `blankTask()`, add the input to the task modal HTML, wire it in `openTask()` (read) and `saveTaskModal()` (write), give it a default in `repair()`, and render it in `cardEl()` if it should show on cards. New chart: add a `<canvas>` to the analytics modal and a `draw…()` function using `setupCanvas()`. Remember old saved states will lack new fields, `repair()` is where you make them safe.

Ship UI to both hosts: edit `flowboard.html`, then `deploy-online.bat` (personal) and/or `saas/deploy-saas.bat` (experiment).
