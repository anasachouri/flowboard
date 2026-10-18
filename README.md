# FlowBoard

A kanban board that fits in one HTML file. Pomodoro timer, Pareto prioritisation, live sync between your devices, invite links, video calls and chat. No framework, no build step, no dependencies, no account needed. Open the file and it runs. Put it on a free Cloudflare account and it runs from anywhere, with HTTPS, for you and the people you invite.

Author: Dr Anas Achouri

## Why

Most task tools are either too heavy or lock your data in. FlowBoard is the opposite: a single file you can copy to a USB stick, read in full, and host yourself for free. It was built for one person and a small team doing focused sprints, and it stays that size on purpose.

## What it does

- Unlimited boards, columns, swimlanes, labels, subtasks and attachments. WIP limits per column. Done columns group tasks by the day they were finished.
- Pomodoro and stopwatch per task. Time is logged to the task as you go, with daily totals and charts.
- Pareto view: give tasks an impact and an effort score and it ranks the best value for effort.
- Analytics: cumulative flow, throughput and time tracked, drawn on canvas with no chart library.
- Search, filters, recurring tasks, undo, keyboard shortcuts, dark mode, works on phones.
- Live sync between your laptop and phone through a Cloudflare Worker, with last write wins and an offline queue.
- Invite links: give a friend their own private link to one board. Revoke any time. Presence shows who is on the board.
- Video calls: click the camera button, everyone on the board gets a ring and a Join banner. Peer to peer WebRTC, screen share, up to six people. Nothing is recorded and no media touches the server.
- Chat per board for links and notes, kept on the server (last 150 messages), with or without a call.
- Deadlines export to any calendar app as an .ics feed. JSON backup and restore. CSV export.

## Three ways to run it

### 1. Just the file

Open `flowboard.html` in a browser. Everything is stored in that browser (localStorage plus IndexedDB for attachments). Export a JSON backup from the menu now and then.

### 2. Your own private board online, free

You need a free Cloudflare account and Node.js.

1. Run `deploy-online.bat`. Log in to Cloudflare when the browser opens. Note the printed URL.
2. Run `set-key.bat` and choose a strong board key.
3. Open `https://flowboard.<your-subdomain>.workers.dev/#key=YOUR-KEY` on each device.

Board data lives in a Durable Object on your account. Invite friends from the menu (Board members, then Invite links) instead of sharing the master key.

### 3. A small SaaS for friends

The `saas` folder is a second Worker with email and password accounts, email verification, an admin console to approve people, per user boards, shared boards and the same calls and chat. See `saas/README.md`. It uses Resend for email and needs an API key.

## Video calls and chat

Calls and chat work on any live synced board (option 2 or 3). The Worker only relays the WebRTC handshake over a WebSocket on the board's Durable Object. Audio and video go directly between browsers. STUN is used by default, which works on most networks. If a call stays on "connecting", one side is behind a strict NAT. Create a TURN key in Cloudflare (Realtime, TURN) and set two secrets:

```
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
```

## How it is built

Read `flowboard-how-it-works.md`. Short version: one `state` object, immediate mode rendering that rebuilds the DOM on every change, three storage layers, one sync protocol with several transports, and a Durable Object per board for sync, presence, call signalling and chat.

## Privacy

Attachments never leave the device they were added on. Task content is never used for analytics. The SaaS counts feature usage (how many pomodoros, how many exports) and nothing else.

## Licence

MIT. Use it, change it, ship it. See `LICENSE`.

## Contributing

Issues and pull requests are welcome. Keep the single file philosophy: no build step, no runtime dependencies, nothing that would stop the HTML file from working on its own.
