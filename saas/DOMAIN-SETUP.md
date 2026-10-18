# Custom domain for the SaaS Worker

Optional. The SaaS Worker works on its workers.dev address without any of this.

1. Register a domain anywhere and add it as a zone on Cloudflare (point the registrar's nameservers at Cloudflare).
2. In `wrangler.jsonc`, uncomment `routes` and put your domain and its `www` variant in the two patterns.
3. Set `FROM_EMAIL` to an address on that domain and verify the domain in Resend (see EMAIL-SETUP.md).
4. Run `deploy-saas.bat`. Cloudflare attaches the custom domain to the Worker. DNS can take a few minutes the first time.

The personal Worker is not affected by any of this.
