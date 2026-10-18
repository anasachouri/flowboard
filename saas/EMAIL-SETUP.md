# Email verification setup (Resend)

FlowBoard SaaS sends a **verify link** after signup. From address:

**`FlowBoard <noreply@your-domain.example>`**

Cloudflare’s built-in Email Sending needs a paid Workers plan, so this project uses [Resend](https://resend.com) (free tier is enough for a small experiment).

## 1. Create a Resend account

1. Sign up at https://resend.com  
2. **API Keys** → create a key → copy it  

## 2. Put the key on the Worker

From the `saas/` folder:

```bat
npx wrangler secret put RESEND_API_KEY
```

Paste the key when prompted, then redeploy (`deploy-saas.bat`).

The secret **name** must be exactly `RESEND_API_KEY` (not the key itself). If you paste the `re_…` key as the name, email will fail with “missing RESEND_API_KEY”.

## 3. Send from @your-domain.example

1. In Resend: **Domains** → add `your-domain.example`  
2. Add the DNS records Resend shows (in Cloudflare DNS for that zone)  
3. Wait until the domain status is **Verified**  
4. `FROM_EMAIL` in `wrangler.jsonc` is already `FlowBoard <noreply@your-domain.example>`  

Once verified, your friend receives the verify mail **from `noreply@your-domain.example`**.

Until the domain is verified, Resend will reject sends to other people’s inboxes. (Their test sender `onboarding@resend.dev` only delivers to *your* Resend account email.)

## 4. Avoid red “Could not verify” / phishing warnings

Verify links now open a **Confirm** page first (so email security scanners don’t burn the link). Still:

1. In Resend → **Domains** → `your-domain.example` → turn **off Click tracking** and **Open tracking** (rewritten links often trigger Outlook/McAfee “unsafe” warnings).
2. Add a **DMARC** TXT record if Resend shows it missing (Resend suggests the exact value).
3. Optional reputation: [Google Postmaster Tools](https://postmaster.google.com) → add `your-domain.example`.

If a friend’s link already failed: **Admin console → Verify & approve**.

## Assignment emails

When someone is assigned a task, FlowBoard emails them via the same Resend setup.

**Requirements (one is enough):**
- The assignee has a FlowBoard account and is linked on the board (`user:…` member), **or**
- The member/invite has an **email** set (⋯ → Board members → Set email / invite email field)

Name-only tags with no email and no account cannot receive assign alerts.