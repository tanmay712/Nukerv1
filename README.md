# Cryply

A preliminary account dashboard with Google and Discord OAuth, a Discord-ID-restricted owner panel, and an owner-only Tatum devnet connectivity check. The former simulated balances and transactions have been removed. Legacy read-only Coinbase Prime routes remain available but are no longer shown in the owner panel.

**Not a production custodial wallet.** Individual customer balances, deposit addresses, ledger/reconciliation, withdrawals, customer onboarding and compliance are not implemented. The interface deliberately disables deposits and withdrawals. Do not accept customer funds or deploy for custody without a proper ledger, provider integration, operational controls, legal review, penetration testing, and independent security audit. Legacy Coinbase Prime portfolio totals are available only to the owner and are not customer balances.

## Individual wallet direction: Tatum

Cryply is moving toward individual customer wallets with Tatum rather than a shared Coinbase Prime portfolio. The only Tatum functionality currently implemented is an owner-only, rate-limited Solana devnet RPC health check. Set `TATUM_API_KEY` privately on the server, restart the service, then sign in as the configured Discord owner and select **Check test connection** in the owner panel. It makes a fixed, read-only `getHealth` RPC request; it does not create a wallet, verify wallet-product access, or enable deposits or withdrawals. Provider connectivity has not been tested with a real account. The free plan has limits and network transactions incur fees.

No Tatum SDK wallet creation, customer signing, backup/recovery, deposits, balances or withdrawals are implemented. Individual addresses alone do not prevent operator transfers: the signing and recovery design must ensure user authorization and not give the operator unilateral control. Design and independently review that model before enabling funds. Confirm product availability and fees, exact network/token support, secure client-side share handling and recovery, settlement monitoring and applicable compliance obligations. Do not deposit real funds. The old Prime API routes remain available for existing read-only configurations but are not used by Tatum.

## Legacy shared-custody research

The candidate assets are SOL on Solana, LTC on Litecoin, and USDT on Polygon. These are **candidates, not enabled assets**. Legacy Prime credentials and `COINBASE_PRIME_ENTITY_ID` may be used with the existing owner-only API route to query Prime's entity asset catalogue; that catalogue is no longer shown in the owner panel. The catalogue is informational and does not prove that any specific deposit or withdrawal is permitted, nor does it enable transactions. Prime product and network support can differ; verify the exact asset, network, wallet type and deposit/withdrawal capabilities with Coinbase before allowing any transfers.

For a shared portfolio, the provider's portfolio totals must never be presented as customer balances. Launch requires, at minimum, a transactional per-customer ledger, secure deposit attribution, confirmations and reorg handling, withdrawal holds and authorization, idempotency, reconciliation with Prime, fraud controls, backups, operational monitoring, legal/compliance review, and independent security testing. None of those funds flows is implemented here. Do not deposit customer funds.

## Experimental ledger groundwork

`ledger.js` is an isolated, test-only prototype for LTC accounting. It is **not connected to the running app, Coinbase, customer balances, deposits, or withdrawals**, and no API can post ledger entries. It uses exact integer atomic-unit strings, atomic paired postings, per-user balance checks, idempotency keys, and append-only database triggers. The tests use synthetic entries, not funds. The clearing account is an internal placeholder, not proof of assets held at Coinbase. It is not a production-ready double-entry accounting system or a custody solution.

Before any live integration, verify your Prime account is approved for your customer-custody model and intended asset/network. Coinbase documents unique deposit addresses for attribution, but the default deposit instruction is shared for a wallet and must not be treated as unique per user. Address generation can require enhanced due diligence. Never display a shared address as a customer-specific address. See [Prime deposits](https://docs.cdp.coinbase.com/prime/concepts/transactions/deposits).

Still needed: provider-specific address assignment and transaction ingestion, durable deduplication and confirmations/reorg handling, complete reconciliation and exception handling, secure withdrawal reservations and approvals, support for fees, audit trails, independent backups, monitoring, operational recovery, regulatory review and a security audit. Do not accept customer funds or enable transfers until those controls are implemented and independently reviewed.

## Pages

The public landing page is at `/`. The separate `/signin` and `/signup` pages use the same Google and Discord OAuth providers; users return to `/dashboard` after signing in. `/withdraw`, `/giveaways`, `/buy`, and `/owner` remain available from the dashboard. Sign-in requires the provider configuration below.

## Setup

Requires Node.js 22.5 or newer. Run `npm install`, copy `.env.example` to `.env`, and configure values locally (never share secrets in chat or commit them). Run `npm start` for local development. The server listens on the internal `PORT` (default 6546); users access the public domain without a port when a reverse proxy is configured. Without OAuth configuration the dashboard starts, but sign-in is disabled. Sessions and user records are stored in `data/wallet.sqlite`; protect and back up this directory.

1. Set `PUBLIC_BASE_URL` to `https://cryply.xyz` for your domain (the value in `.env.example`). Point the DNS record at your server, install a valid TLS certificate, and configure your HTTPS reverse proxy to forward to the app on its internal `PORT`. DNS, TLS, and hosting are not provisioned by this repository. `Caddyfile.example` provides a starting point for Caddy: set its `APP_PORT` to the same value as the app `PORT`, set `TRUST_PROXY=1` on the app when Caddy is the only trusted proxy, and block direct public access to the internal app port using your firewall. Set `PUBLIC_BASE_URL` to the exact public HTTPS origin. For local development only, `http://localhost:6546` is allowed. Create a long random `SESSION_SECRET` (at least 32 characters) and store it securely. Set `NODE_ENV=production` in production.
2. Register Google and Discord OAuth applications. Configure their callback URLs as `<PUBLIC_BASE_URL>/auth/google/callback` and `<PUBLIC_BASE_URL>/auth/discord/callback` respectively, and set their client IDs and secrets in `.env`.
3. Set `OWNER_DISCORD_ID` to the owner's immutable numeric Discord user ID. Only a session authenticated through Discord with this exact ID can use owner endpoints. Google sign-in and matching email addresses never grant owner access. Enable Discord MFA, restrict access to server configuration, and add appropriate operational monitoring.
4. Optionally configure `TATUM_API_KEY` on the server to test Solana devnet connectivity from the owner panel. This check alone does not enable individual wallets or transactions. Coinbase Prime environment variables are optional legacy read-only settings.
5. Set `TRUST_PROXY=1` only when exactly one trusted TLS-terminating proxy is in front of the server. Deploy behind HTTPS and protect database, logs and secrets. The built-in SQLite session store and local user database are a starting point, not a scalable or audited production setup.

Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` and a verified `MAIL_FROM` on the server. SMTP requires TLS or STARTTLS. Set an owner notification email in the owner panel, save it, and use the test button. Successful sign-ins trigger an owner alert and an account alert only when Google or Discord provides a verified email. Discord now requests the `email` scope. Failed or unconfigured email delivery does not block sign-in; sign-in alerts are best-effort. Giveaway winner emails to verified addresses are queued in SQLite and retried while the server is running when SMTP is configured. SMTP acceptance is not guaranteed delivery; a crash after acceptance can result in a duplicate email. SMTP acceptance does not guarantee inbox delivery. Configure SPF, DKIM and DMARC through your email provider.

The owner can set a support email in the panel; it is stored as application metadata and does not affect authentication. Client secrets, API credentials and the owner Discord ID are intentionally configured server-side, not editable through the browser.

## Railway deployment

`railway.toml` contains build, start, healthcheck, and restart settings without secrets. **Railway has deprecated TOML/JSON config-as-code:** existing legacy services can use it only until December 1, 2026, and new services cannot opt in. For a new service, configure `npm ci`, `npm start`, and healthcheck `/` in Railway's service settings, or use Railway's supported Infrastructure as Code workflow. See [Railway's documentation](https://docs.railway.com/config-as-code).

1. Deploy the repository as a Node service. The app binds to `0.0.0.0` and uses Railway's injected `PORT`; do not copy the example's `PORT=6546` into Railway unless deliberately setting a matching target port.
2. Attach a persistent Railway volume at `/data` and set `DB_PATH=/data/wallet.sqlite` as a service variable. Without the volume, the SQLite database, users, sessions, giveaways and queued email may be lost when the container is replaced. Back it up independently; use a single replica because the SQLite store is not designed for multiple replicas. Volumes may incur charges and do not constitute a production custody solution.
3. In Railway's Variables settings, set `NODE_ENV=production`, `PUBLIC_BASE_URL` to your exact HTTPS domain, and a long random `SESSION_SECRET`. Set `TRUST_PROXY=1` only when Railway is the one trusted reverse proxy, and configure OAuth client credentials, `OWNER_DISCORD_ID`, `TATUM_API_KEY`, and SMTP variables as needed. Never commit `.env`, API keys, passwords, or session secrets. Register the exact OAuth callback URLs from Setup above.
4. Connect the custom domain in Railway and follow Railway's DNS instructions. Caddy is not required when Railway terminates HTTPS. Test authentication, SMTP, and provider connectivity against the configured services before use.

Deploying this prototype does not make it safe to accept real customer funds: custody, ledger, deposits, withdrawals, and payout functionality remain disabled.

## Test

Run `npm test`. OAuth sign-in, Coinbase calls and SMTP delivery require your own configured accounts and have not been tested against live services in this checkout.

## Giveaways

Owners signed in through the configured Discord account can create or cancel an LTC giveaway and draw one cryptographically random winner after its closing time. Eligibility terms and prize amounts are displayed, entry is free and limited to one entry per application account (Google and Discord accounts are not linked, so this does not enforce one entry per person). The winner gets a durable dashboard notification; a winner email is queued only when the sign-in provider supplied a verified email. Operators should check applicable giveaway laws and eligibility requirements.

**No prize is funded, deducted, or transferred by this application.** Selection records a pending fulfillment only. Deposits, purchases, withdrawals, customer balances, and custody operations remain disabled until a vetted provider, ledger, reconciliation, compliance and security review are implemented. Configure OAuth and SMTP before using the giveaway flow.
