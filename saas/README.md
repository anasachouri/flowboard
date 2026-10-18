# FlowBoard SaaS experiment

Separate from your **personal** board (Worker name `flowboard`). This is a free multi-account trial on Worker **`flowboard-saas`**.

See also: [../CHANGELOG.md](../CHANGELOG.md) · [../README.md](../README.md)

## What you get

- Anyone can **sign up** with email + password (8+ characters)
- New accounts must **verify email**, then stay **pending** until an admin Approves them
- Each account gets **isolated** boards (cannot see others’ tasks)
- Any logged-in user: **⋯ → Change password**, login screen has **Forgot password?** (Resend reset link)
- **First signup is admin** (auto-approved + verified), `ADMIN_EMAIL` in `wrangler.jsonc` is always admin (cannot revoke/delete that account). Non-admins never see Admin console.
- Admin: header **Admin console**, approve pending (verified) users, revoke/restore, unverified users wait for email click
- Verification emails sent via **Resend** from **`noreply@your-domain.example`** (`RESEND_API_KEY` Worker secret, see [EMAIL-SETUP.md](EMAIL-SETUP.md))
- Your personal `https://flowboard.*.workers.dev` is **unchanged**

## Deploy

```bat
deploy-saas.bat
```

This script:

1. Copies `../flowboard.html` into `public/index.html`
2. Injects `<script>window.FLOWBOARD_SAAS=1</script>`
3. Writes `Cache-Control: no-store` headers
4. Runs `wrangler deploy` for **`flowboard-saas` only**

Typical URL: `https://flowboard-saas.<your-subdomain>.workers.dev`  
Custom domain: **`https://your-domain.example`** (after following [DOMAIN-SETUP.md](DOMAIN-SETUP.md))

### First-time checklist

1. Add a **Resend** API key (see [EMAIL-SETUP.md](EMAIL-SETUP.md)), required to send verification emails
2. You log in as admin (`ADMIN_EMAIL` / first account)
3. Friend signs up → clicks verify link in email → status becomes **PENDING**
4. You: **Admin console** → **Approve**
5. When you improve `flowboard.html`, run `deploy-saas.bat` again

## Architecture (short)

| Piece | Role |
|-------|------|
| `Auth` Durable Object | Users, password hashes, sessions, verify tokens, usage counters |
| `UserBoard` Durable Object | One board state blob per user id |
| Cookie `fb_sess` | HttpOnly session (30 days) |
| `/api/auth/signup` · `/login` · `/logout` · `/verify` · `/resend-verify` | Account API |
| `/api/me` · `/api/state` | Session + board sync |
| `/api/admin/users` · `/approve` · `/revoke` · `/restore` | Admin only |
| Resend (`RESEND_API_KEY`) | Transactional verify emails |

## Notes

- Cloudflare free tier is enough for Workers, email uses free Resend (Cloudflare Email Sending needs Workers Paid)
- Passwords: PBKDF2-SHA256, never stored in plaintext
- Usage stats are **counts only** (logins, saves, feature use), never task titles or notes. See **⋯ → My usage** and Admin console totals.
- Attachments stay in each browser (same as personal deploy)
- SaaS login starts a **fresh** server board for new accounts, it does not upload your personal localStorage Main board
