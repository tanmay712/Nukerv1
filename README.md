# Cryply

A preliminary account dashboard with Google and Discord OAuth, a Discord-ID-restricted owner panel, and an owner-only Tatum devnet connectivity check. The former simulated balances and transactions have been removed. Legacy read-only Coinbase Prime routes remain available but are no longer shown in the owner panel.

**Not a production custodial wallet.** Individual customer balances, deposit addresses, ledger/reconciliation, withdrawals, customer onboarding and compliance are not implemented. The interface deliberately disables deposits and withdrawals. Do not accept customer funds or deploy for custody without a proper ledger, provider integration, operational controls, legal review, penetration testing, and independent security audit. Legacy Coinbase Prime portfolio totals are available only to the owner and are not customer balances.

## MongoDB storage

The server uses MongoDB when `MONGODB_URI` is set, with `MONGODB_DB_NAME` (default `cryply`) specifying the database. Users, account watchlists, sessions, settings, giveaways, entries, notifications and the email outbox are stored in MongoDB. Giveaways use transactions and require a MongoDB replica set or sharded cluster (such as an appropriately configured Atlas deployment); a standalone server is not supported. The application refuses to fall back to local SQLite when a MongoDB connection fails. On Render it also refuses to start without `MONGODB_URI` to avoid silent data loss; `ALLOW_EPHEMERAL_SQLITE=1` is an explicit, unsafe test-only override. Other existing local installations without a MongoDB URI continue to use SQLite.

**Verification:** The real MongoDB replica-set integration test in `test/mongo-integration.test.js` passed locally against a disposable MongoDB 8 replica set and is configured to run in CI. It can also run against a disposable replica set with `MONGO_TEST_URI` set. It creates and drops randomly named test databases. Do not point test credentials at a customer database. In environments without a disposable MongoDB replica set that test is skipped. This checkout has not been tested with your MongoDB account. Before deploying, confirm the CI test passes and test connectivity against your own disposable database.

### Render configuration

Add `MONGODB_URI` and `MONGODB_DB_NAME` in Render's environment settings. Keep the URI private: it contains database credentials. Configure MongoDB network access for Render, use a least-privilege database user, TLS, and independent backups. Review the database provider's capacity, availability, network and backup limits; free app hosting still sleeps after inactivity. `PUBLIC_BASE_URL` must be the exact origin in use, and OAuth redirect URLs must match it. MongoDB does not remove the need for `SESSION_SECRET`, Google/Discord credentials, or the owner Discord ID. Render Free blocks outbound SMTP ports 25, 465 and 587, so the current SMTP notifications will not work on those ports there.

### Migrating an existing SQLite database

Data is **not migrated automatically**. If you have existing data, stop both the old SQLite app and the new app to prevent concurrent writes, and make a verified SQLite-aware backup first, including WAL state. Use a fresh, empty, dedicated MongoDB database. Set `MONGODB_URI`, `MONGODB_DB_NAME`, and `SQLITE_MIGRATION_PATH` privately in the environment where the old SQLite file is accessible; run `node scripts/migrate-sqlite-to-mongo.js`. It imports users, their watchlists when present, settings, giveaways, entries, notifications and pending email records inside a MongoDB transaction, and refuses a nonempty destination. It leaves the SQLite source untouched and deliberately does not transfer sessions, so users must sign in again. Verify data and backups before starting the Mongo-backed app. Do not run tests against that database or delete the old SQLite file. Large databases may exceed transaction limits; test the migration against a copy first.

## Individual wallet direction: Tatum

Cryply is moving toward individual customer wallets with Tatum rather than a shared Coinbase Prime portfolio. Tatum functionality includes an owner-only, rate-limited Solana devnet RPC health check and a disabled-by-default experimental test-wallet flow described below. Set `TATUM_API_KEY` privately on the server, restart the service, then sign in as the configured Discord owner and select **Check test connection** in the owner panel. It makes a fixed, read-only `getHealth` RPC request; it does not create a wallet, verify wallet-product access, or enable deposits or withdrawals. Provider connectivity has not been tested with a real account. The free plan has limits and network transactions incur fees.

Production-ready customer wallet creation, signing, backup/recovery, deposits, balances and withdrawals are not implemented; the experimental Solana flow has not been verified against Tatum. Individual addresses alone do not prevent operator transfers: the signing and recovery design must ensure user authorization and not give the operator unilateral control. Design and independently review that model before enabling funds. Confirm product availability and fees, exact network/token support, secure client-side share handling and recovery, settlement monitoring and applicable compliance obligations. Do not deposit real funds. The old Prime API routes remain available for existing read-only configurations but are not used by Tatum.

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

Requires Node.js 22.5 or newer. Run `npm install`, copy `.env.example` to `.env`, and configure values locally (never share secrets in chat or commit them). Run `npm start` for local development. The server listens on the internal `PORT` (default 6546); users access the public domain without a port when a reverse proxy is configured. Without OAuth configuration the dashboard starts, but sign-in is disabled. When MongoDB is not configured outside Render, sessions and user records are stored in `data/wallet.sqlite`; protect and back up the data. See MongoDB storage above for Render.

1. Set `PUBLIC_BASE_URL` to `https://cryply.xyz` for your domain (the value in `.env.example`). Point the DNS record at your server, install a valid TLS certificate, and configure your HTTPS reverse proxy to forward to the app on its internal `PORT`. DNS, TLS, and hosting are not provisioned by this repository. `Caddyfile.example` provides a starting point for Caddy: set its `APP_PORT` to the same value as the app `PORT`, set `TRUST_PROXY=1` on the app when Caddy is the only trusted proxy, and block direct public access to the internal app port using your firewall. Set `PUBLIC_BASE_URL` to the exact public HTTPS origin. For local development only, `http://localhost:6546` is allowed. Create a long random `SESSION_SECRET` (at least 32 characters) and store it securely. Set `NODE_ENV=production` in production.
2. Register Google and Discord OAuth applications. Configure their callback URLs as `<PUBLIC_BASE_URL>/auth/google/callback` and `<PUBLIC_BASE_URL>/auth/discord/callback` respectively, and set their client IDs and secrets in `.env`.
3. Set `OWNER_DISCORD_ID` to the owner's immutable numeric Discord user ID. Only a session authenticated through Discord with this exact ID can use owner endpoints. Google sign-in and matching email addresses never grant owner access. Enable Discord MFA, restrict access to server configuration, and add appropriate operational monitoring.
4. Optionally configure `TATUM_API_KEY` on the server to test Solana devnet connectivity from the owner panel. This check alone does not enable individual wallets or transactions. Coinbase Prime environment variables are optional legacy read-only settings.
5. Set `TRUST_PROXY=1` only when exactly one trusted TLS-terminating proxy is in front of the server. Deploy behind HTTPS and protect database, logs and secrets. The data stores are a starting point, not a scalable or audited production custody system.

Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` and a verified `MAIL_FROM` on the server. SMTP requires TLS or STARTTLS. Set an owner notification email in the owner panel, save it, and use the test button. Successful sign-ins trigger an owner alert and an account alert only when Google or Discord provides a verified email. Discord now requests the `email` scope. Failed or unconfigured email delivery does not block sign-in; sign-in alerts are best-effort. Giveaway winner emails to verified addresses are queued in the configured database and retried while the server is running when SMTP is configured. SMTP acceptance is not guaranteed delivery; a crash after acceptance can result in a duplicate email. SMTP acceptance does not guarantee inbox delivery. Configure SPF, DKIM and DMARC through your email provider.

The owner can set a support email in the panel; it is stored as application metadata and does not affect authentication. Client secrets, API credentials and the owner Discord ID are intentionally configured server-side, not editable through the browser.

## Railway deployment

`railway.toml` contains build, start, healthcheck, and restart settings without secrets. **Railway has deprecated TOML/JSON config-as-code:** existing legacy services can use it only until December 1, 2026, and new services cannot opt in. For a new service, configure `npm ci`, `npm start`, and healthcheck `/` in Railway's service settings, or use Railway's supported Infrastructure as Code workflow. See [Railway's documentation](https://docs.railway.com/config-as-code).

1. Deploy the repository as a Node service. The app binds to `0.0.0.0` and uses Railway's injected `PORT`; do not copy the example's `PORT=6546` into Railway unless deliberately setting a matching target port.
2. Set `MONGODB_URI` and `MONGODB_DB_NAME` to use MongoDB. Alternatively, if intentionally using legacy SQLite, attach a persistent volume at `/data` and set `DB_PATH=/data/wallet.sqlite`. Without a volume SQLite data is lost on replacement. Independently back up the configured database. Neither option is a production custody solution.
3. In Railway's Variables settings, set `NODE_ENV=production`, `PUBLIC_BASE_URL` to your exact HTTPS domain, and a long random `SESSION_SECRET`. Set `TRUST_PROXY=1` only when Railway is the one trusted reverse proxy, and configure OAuth client credentials, `OWNER_DISCORD_ID`, `TATUM_API_KEY`, and SMTP variables as needed. Never commit `.env`, API keys, passwords, or session secrets. Register the exact OAuth callback URLs from Setup above.
4. Connect the custom domain in Railway and follow Railway's DNS instructions. Caddy is not required when Railway terminates HTTPS. Test authentication, SMTP, and provider connectivity against the configured services before use.

Deploying this prototype does not make it safe to accept real customer funds: custody, ledger, deposits, withdrawals, and payout functionality remain disabled.

## Test

Run `npm test`. OAuth sign-in, Coinbase calls and SMTP delivery require your own configured accounts and have not been tested against live services in this checkout.

## Giveaways

Owners signed in through the configured Discord account can create or cancel an LTC giveaway and draw one cryptographically random winner after its closing time. Eligibility terms and prize amounts are displayed, entry is free and limited to one entry per application account (Google and Discord accounts are not linked, so this does not enforce one entry per person). The winner gets a durable dashboard notification; a winner email is queued only when the sign-in provider supplied a verified email. Operators should check applicable giveaway laws and eligibility requirements.

**No prize is funded, deducted, or transferred by this application.** Selection records a pending fulfillment only. Deposits, purchases, withdrawals, customer balances, and custody operations remain disabled until a vetted provider, ledger, reconciliation, compliance and security review are implemented. Configure OAuth and SMTP before using the giveaway flow.

### Solana devnet public-address lookup

Signed-in users can check an existing Solana **devnet** public address on the dashboard. Configure `TATUM_API_KEY` on the server; the key is never sent to the browser. The lookup is authenticated, CSRF-protected and rate-limited. It calls Tatum's fixed Solana devnet RPC endpoint and does not store the address. It does not establish wallet ownership or create, connect, back up or sign for a wallet. Never submit a private key, signing share or recovery phrase. Devnet balances are test assets, not mainnet SOL.

Production-ready individual wallets, verified customer-controlled signing, recovery, deposits, withdrawals, other networks, and purchase functionality remain unimplemented. Before enabling real funds the provider's authority and recovery model needs verification, a secure customer-side key lifecycle and an independent security review. A Tatum key or successful balance lookup does not enable those features.

### Experimental Tatum Solana devnet wallet

`wallet-prototype/solana-devnet.mjs` provides an experimental SDK integration, with a dashboard flow and authenticated per-user client provisioning. It is **disabled by default** and has not been tested against a live Tatum account. It can generate Tatum signing shares, encrypt them in a portable bundle, confirm that a saved bundle was reopened, obtain a Solana address, make a separate encrypted recovery bundle, restore signing shares, and submit a confirmed native SOL transfer with a fixed devnet chain and RPC URL. It is tested only with mocks, not a Tatum account or blockchain. Encrypted bundles use PBKDF2-SHA256 (600,000 rounds) and AES-256-GCM. Loss of a passphrase or all suitable bundles may mean permanent loss of access. The implementation must not be relied on to protect actual funds.

Important limitations and release blockers:

- **Devnet is not a protective boundary around keys.** The same Solana key/address can be used on mainnet. Do not deposit real assets to any address produced by this prototype. The SDK's client token and shares may have capabilities beyond this helper's fixed devnet call.
- The server reserves a per-user MongoDB record before creating a Tatum client, then issues short-lived client sessions. Ambiguous client creation is locked for manual review rather than retried; wallet generation also uses a one-time per-account claim so concurrent tabs cannot start generation twice. Validate Tatum's session scope and authorization model with the provider; a client session token may permit more operations than the devnet UI exposes.
- Generation or recovery can succeed remotely while the response, encryption, or local save fails. Blind retries could create or invalidate wallet state or lose access. An end-to-end enrollment and recovery state machine with explicit re-open/confirmation of saved bundles is required; a UI confirmation must never be treated as proof of a saved backup.
- The SDK sends the client signing share to Tatum's MPC service over HTTPS. Hosting JavaScript on Cryply's own server also means the server operator could change client code. The prototype does **not** prove that the operator or provider cannot move funds unilaterally. Verify Tatum's exact trust, signing, token, recovery and ejection model and independently audit the whole client and deployment before making any such claim.
- Test and implement confirmation UX, transaction fees, durable transaction history, ambiguous broadcasts (never blindly retry), network confirmations, rate limits, abuse controls, customer recovery and support, plus actual balances/deposit tracking. Other chains and tokens are not implemented. SDK support and provider plan access must be verified per asset/network. Purchases require a separate provider.
- Browser CSP/CORS, mobile file download/reopening, dependency and supply-chain review, real-provider integration tests and a real testnet round trip are still needed before enabling this in the app. Never log shares, passphrases, client tokens or provider errors containing them. Real-money deployment requires independent security, operational and legal review.

The dashboard feature is gated by `ENABLE_EXPERIMENTAL_TATUM_DEVNET=1` and `TATUM_API_KEY`; leave the flag unset for customer deployments until the above checks have passed. To rebuild the checked-in browser bundle after changing its source, install development dependencies and run `npm run build:wallet`. The bundle is checked in so Render's existing `npm ci` build can serve it even if development dependencies are omitted. A separate faucet or external devnet wallet is needed to send test SOL to the displayed address. No mainnet assets, purchase provider, or automatic giveaway payouts are implemented.

### Markets workspace

Markets includes an account-specific watchlist for SOL, LTC and USDT. It is a preference list, not a holdings record. Swap and Invest are interface previews; there is no market data, order execution, swap quote or investment product provider connected. Both MongoDB and SQLite support watchlists, and the manual SQLite migration carries them to MongoDB. A supported trading provider and appropriate financial, security and legal controls are required before enabling real transactions.
