# Vaultly

A preliminary account dashboard with Google and Discord OAuth, a Discord-ID-restricted owner panel, and a server-side **read-only** Coinbase Prime portfolio view. The former simulated balances and transactions have been removed.

**Not a production custodial wallet.** Individual customer balances, deposit addresses, ledger/reconciliation, withdrawals, customer onboarding and compliance are not implemented. The interface deliberately disables deposits and withdrawals. Do not accept customer funds or deploy for custody without a proper ledger, provider integration, operational controls, legal review, penetration testing, and independent security audit. Coinbase Prime portfolio totals are shown only to the owner and are not customer balances.

## Setup

Requires Node.js 22.5 or newer. Run `npm install`, copy `.env.example` to `.env`, and configure values locally (never share secrets in chat or commit them). Run `npm start` for local development. The server listens on the internal `PORT` (default 6546); users access the public domain without a port when a reverse proxy is configured. Without OAuth configuration the dashboard starts, but sign-in is disabled. Sessions and user records are stored in `data/wallet.sqlite`; protect and back up this directory.

1. Set `PUBLIC_BASE_URL` to `https://crypto.definescloud.site` for your domain (the value in `.env.example`). Point the DNS record at your server, install a valid TLS certificate, and configure your HTTPS reverse proxy to forward to the app on its internal `PORT`. DNS, TLS, and hosting are not provisioned by this repository. `Caddyfile.example` provides a starting point for Caddy: set its `APP_PORT` to the same value as the app `PORT`, set `TRUST_PROXY=1` on the app when Caddy is the only trusted proxy, and block direct public access to the internal app port using your firewall. Set `PUBLIC_BASE_URL` to the exact public HTTPS origin. For local development only, `http://localhost:6546` is allowed. Create a long random `SESSION_SECRET` (at least 32 characters) and store it securely. Set `NODE_ENV=production` in production.
2. Register Google and Discord OAuth applications. Configure their callback URLs as `<PUBLIC_BASE_URL>/auth/google/callback` and `<PUBLIC_BASE_URL>/auth/discord/callback` respectively, and set their client IDs and secrets in `.env`.
3. Set `OWNER_DISCORD_ID` to the owner's immutable numeric Discord user ID. Only a session authenticated through Discord with this exact ID can use owner endpoints. Google sign-in and matching email addresses never grant owner access. Enable Discord MFA, restrict access to server configuration, and add appropriate operational monitoring.
4. Configure the Coinbase Prime portfolio ID and a **read-only** Prime API key, signing key and passphrase as environment variables. These are used only on the server to call the portfolio balances and wallets endpoints. Portfolio listings currently show the first page only. Confirm the portfolio supports the intended asset/network with Coinbase before enabling any future transfers.
5. Set `TRUST_PROXY=1` only when exactly one trusted TLS-terminating proxy is in front of the server. Deploy behind HTTPS and protect database, logs and secrets. The built-in SQLite session store and local user database are a starting point, not a scalable or audited production setup.

Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` and a verified `MAIL_FROM` on the server. SMTP requires TLS or STARTTLS. Set an owner notification email in the owner panel, save it, and use the test button. Successful sign-ins trigger an owner alert and an account alert only when Google or Discord provides a verified email. Discord now requests the `email` scope. Failed or unconfigured email delivery does not block sign-in; sign-in alerts are best-effort. Giveaway winner emails to verified addresses are queued in SQLite and retried while the server is running when SMTP is configured. SMTP acceptance is not guaranteed delivery; a crash after acceptance can result in a duplicate email. SMTP acceptance does not guarantee inbox delivery. Configure SPF, DKIM and DMARC through your email provider.

The owner can set a support email in the panel; it is stored as application metadata and does not affect authentication. Client secrets, API credentials and the owner Discord ID are intentionally configured server-side, not editable through the browser.

## Test

Run `npm test`. OAuth sign-in, Coinbase calls and SMTP delivery require your own configured accounts and have not been tested against live services in this checkout.

## Giveaways

Owners signed in through the configured Discord account can create or cancel an LTC giveaway and draw one cryptographically random winner after its closing time. Eligibility terms and prize amounts are displayed, entry is free and limited to one entry per application account (Google and Discord accounts are not linked, so this does not enforce one entry per person). The winner gets a durable dashboard notification; a winner email is queued only when the sign-in provider supplied a verified email. Operators should check applicable giveaway laws and eligibility requirements.

**No prize is funded, deducted, or transferred by this application.** Selection records a pending fulfillment only. Deposits, purchases, withdrawals, customer balances, and custody operations remain disabled until a vetted provider, ledger, reconciliation, compliance and security review are implemented. Configure OAuth and SMTP before using the giveaway flow.
