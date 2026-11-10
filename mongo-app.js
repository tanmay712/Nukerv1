require('dotenv').config({ quiet: true });
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const OAuth2Strategy = require('passport-oauth2').Strategy;
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const crypto = require('node:crypto');
const { saveMongoUser, getMongoUser } = require('./mongo-foundation');
const { registerGiveawayRoutes } = require('./mongo-giveaways');
const { registerSolanaDevnetRoutes } = require('./solana-devnet');
const { registerTatumWalletSessionRoutes } = require('./tatum-wallet-sessions');
const { registerSolanaMainnetDepositRoutes } = require('./solana-mainnet-deposits');
const { registerWatchlistRoutes } = require('./watchlist');
const path = require('node:path');
const mail = require('./mail');

async function createMongoApp({ client, db, users, sessionStore }) {
const app = express();
const production = process.env.NODE_ENV === 'production';
const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
if (baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch (_) { throw new Error('PUBLIC_BASE_URL must be an absolute URL'); }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('PUBLIC_BASE_URL must be an HTTPS origin (HTTP is allowed only on localhost)');
}
if (production && (!baseUrl || !process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) throw new Error('Production requires PUBLIC_BASE_URL and a SESSION_SECRET of at least 32 characters');
const secret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET is not configured; development sessions will reset on restart.');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'", ...((process.env.ENABLE_EXPERIMENTAL_TATUM_DEVNET === '1' || process.env.ENABLE_TATUM_MAINNET_DEPOSITS === '1' || process.env.ENABLE_TATUM_SOLANA_MAINNET_DEPOSITS === '1') ? ["https://api.portalhq.io", "https://mpc-client.portalhq.io"] : [])], objectSrc: ["'none'"], baseUri: ["'self'"], frameAncestors: ["'none'"] } } }));
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.json({ limit: '8kb' }));

const settings = db.collection('settings');
const giveaways = db.collection('giveaways');
const entries = db.collection('giveaway_entries');
const notifications = db.collection('notifications');
const outbox = db.collection('email_outbox');
const mainnetWallets = db.collection('tatum_mainnet_wallets');
const mainnetDeposits = db.collection('mainnet_deposits');
await mainnetWallets.createIndex({ state: 1, 'addresses.solana': 1 });
await mainnetDeposits.createIndex({ chain: 1, address: 1, tx_hash: 1, transfer_index: 1 }, { unique: true });
await mainnetDeposits.createIndex({ user_id: 1, block_time: -1, block_height: -1 });
await entries.createIndex({ giveaway_id: 1, user_id: 1 }, { unique: true });
await giveaways.createIndex({ created_at: -1 });
await notifications.createIndex({ user_id: 1, created_at: -1 });
await outbox.createIndex({ state: 1, next_attempt: 1 });
app.use(session({ name: 'vaultly.sid', secret, store: sessionStore, resave: false, saveUninitialized: false, cookie: { httpOnly: true, secure: baseUrl.startsWith('https://'), sameSite: 'lax', maxAge: 8 * 3600000 } }));
app.use(passport.initialize());
app.use(passport.session());

const saveUser = (provider, profile) => saveMongoUser(users, provider, profile);
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => { getMongoUser(users, id).then((user) => done(null, user || false), done); });
const googleEnabled = Boolean(baseUrl && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const discordEnabled = Boolean(baseUrl && process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET);
if (googleEnabled) passport.use('google', new GoogleStrategy({ clientID: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, callbackURL: `${baseUrl}/auth/google/callback`, state: true }, (_access, _refresh, profile, done) => { saveUser('google', { id: String(profile.id), displayName: profile.displayName, email: profile._json?.email_verified === true ? profile._json.email : null }).then((user) => done(null, user), done); }));
if (discordEnabled) {
  const discord = new OAuth2Strategy({ authorizationURL: 'https://discord.com/oauth2/authorize', tokenURL: 'https://discord.com/api/oauth2/token', clientID: process.env.DISCORD_CLIENT_ID, clientSecret: process.env.DISCORD_CLIENT_SECRET, callbackURL: `${baseUrl}/auth/discord/callback`, scope: ['identify', 'email'], state: true }, (_access, _refresh, profile, done) => { saveUser('discord', profile).then((user) => done(null, user), done); });
  discord.userProfile = (token, done) => { fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }).then(async (response) => { if (!response.ok) throw new Error('Discord profile request failed'); const user = await response.json(); if (!/^\d{5,25}$/.test(user.id)) throw new Error('Invalid Discord ID'); done(null, { id: user.id, username: user.global_name || user.username, email: user.verified === true ? user.email : null }); }).catch(done); };
  passport.use('discord', discord);
}
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
app.use('/auth', authLimiter);
for (const [provider, enabled] of [['google', googleEnabled], ['discord', discordEnabled]]) {
  app.get(`/auth/${provider}`, (req, res, next) => enabled ? passport.authenticate(provider, provider === 'google' ? { scope: ['profile', 'email'] } : {})(req, res, next) : res.status(503).send('This sign-in provider has not been configured.'));
  app.get(`/auth/${provider}/callback`, (req, res, next) => enabled ? passport.authenticate(provider, { failureRedirect: '/signin?login=failed' })(req, res, next) : res.status(503).send('This sign-in provider has not been configured.'), async (req, res) => { const owner = await settings.findOne({ _id: 'workspace' }); mail.notifyLogin(req.user, owner?.notificationEmail).catch(() => console.error('Sign-in notification failed.')); res.redirect('/dashboard'); });
}
const isOwner = (user) => Boolean(user && user.provider === 'discord' && /^\d{5,25}$/.test(process.env.OWNER_DISCORD_ID || '') && user.provider_id === process.env.OWNER_DISCORD_ID);
const requireUser = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Sign in required.' });
const requireOwner = (req, res, next) => isOwner(req.user) ? next() : res.status(403).json({ error: 'Owner access required.' });
function csrf(req, res, next) {
  const token = req.get('x-csrf-token') || '';
  const expected = req.session.csrf || '';
  if (!expected || Buffer.byteLength(token) !== Buffer.byteLength(expected) || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return res.status(403).json({ error: 'Invalid request token.' });
  next();
}
app.get('/api/session', (req, res) => {
  if (req.user && !req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString('hex');
  res.json({ user: req.user ? { name: req.user.name, provider: req.user.provider, owner: isOwner(req.user), verifiedEmail: mail.isEmail(req.user.email) } : null, csrf: req.user ? req.session.csrf : null, providers: { google: googleEnabled, discord: discordEnabled } });
});
app.post('/api/logout', requireUser, csrf, (req, res, next) => req.logout((err) => { if (err) return next(err); req.session.destroy(() => { res.clearCookie('vaultly.sid', { path: '/' }); res.json({ ok: true }); }); }));
app.get('/api/admin', requireUser, requireOwner, async (_req, res) => {
  const userList = await users.find({}, { projection: { _id: 0, provider: 1, name: 1, email: 1, created_at: 1, last_login: 1 } }).sort({ last_login: -1 }).limit(100).toArray();
  const config = await settings.findOne({ _id: 'workspace' });
  res.json({ users: userList, supportEmail: config?.supportEmail || '', notificationEmail: config?.notificationEmail || '', mailConfigured: mail.mailConfigured(), tatumConfigured: Boolean(process.env.TATUM_API_KEY), primeConfigured: primeConfigured(), primeAssetsConfigured: primeAssetsConfigured() });
});
app.post('/api/admin/settings', requireUser, requireOwner, csrf, async (req, res) => {
  const supportEmail = typeof req.body?.supportEmail === 'string' ? req.body.supportEmail.trim() : '';
  const notificationEmail = typeof req.body?.notificationEmail === 'string' ? req.body.notificationEmail.trim() : '';
  if ((supportEmail && !mail.isEmail(supportEmail)) || (notificationEmail && !mail.isEmail(notificationEmail))) return res.status(400).json({ error: 'Enter valid email addresses.' });
  await settings.updateOne({ _id: 'workspace' }, { $set: { supportEmail, notificationEmail } }, { upsert: true });
  res.json({ ok: true });
});
const emailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false });
app.post('/api/admin/email/test', requireUser, requireOwner, csrf, emailLimiter, async (_req, res) => {
  const email = (await settings.findOne({ _id: 'workspace' }))?.notificationEmail;
  if (!mail.mailConfigured()) return res.status(503).json({ error: 'SMTP is not configured.' });
  if (!mail.isEmail(email)) return res.status(400).json({ error: 'Save an owner notification email first.' });
  try { await mail.sendMail(email, 'Cryply email test', 'Your Cryply SMTP connection accepted this test message.\n'); res.json({ ok: true }); }
  catch (_) { console.error('SMTP test email failed.'); res.status(502).json({ error: 'Email delivery failed. Check the SMTP configuration.' }); }
});
registerWatchlistRoutes({ app, requireUser, csrf,
  getWatchlist: async (id) => (await users.findOne({ _id:id }, { projection:{ watchlist:1 } }))?.watchlist || [],
  setWatchlist: async (id, symbol, saved) => { await users.updateOne({ _id:id }, saved ? { $addToSet:{ watchlist:symbol } } : { $pull:{ watchlist:symbol } }); },
});
registerSolanaDevnetRoutes({ app, requireUser, csrf });
registerTatumWalletSessionRoutes({ app, collection: db.collection('tatum_wallet_clients'), requireUser, csrf });
const mainnetDepositsWorker = registerSolanaMainnetDepositRoutes({ app, wallets: mainnetWallets, deposits: mainnetDeposits, requireUser, csrf });

// This diagnostic only checks an RPC connection; it never creates wallets or moves funds.
const tatumCheckLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
app.post('/api/admin/tatum/check', requireUser, requireOwner, csrf, tatumCheckLimiter, async (_req, res) => {
  if (!process.env.TATUM_API_KEY) return res.status(503).json({ error: 'Tatum API key is not configured.' });
  try {
    const response = await fetch('https://solana-devnet.gateway.tatum.io/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.TATUM_API_KEY },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    if (!response.ok) throw new Error('RPC unavailable');
    const data = await response.json();
    if (data.jsonrpc !== '2.0' || data.id !== 1 || data.result !== 'ok' || data.error) throw new Error('Unexpected RPC response');
    res.json({ ok: true, network: 'Solana devnet' });
  } catch (_) { res.status(502).json({ error: 'Tatum test connection failed. Check the server key, plan and provider status.' }); }
});

const isPrimeId = (value) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value || '');
function primeAuthConfigured() { return Boolean(process.env.COINBASE_PRIME_ACCESS_KEY && process.env.COINBASE_PRIME_SIGNING_KEY && process.env.COINBASE_PRIME_PASSPHRASE); }
function primeConfigured() { return primeAuthConfigured() && isPrimeId(process.env.COINBASE_PRIME_PORTFOLIO_ID); }
function primeAssetsConfigured() { return primeAuthConfigured() && isPrimeId(process.env.COINBASE_PRIME_ENTITY_ID); }
async function primeGetPath(requestPath) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', process.env.COINBASE_PRIME_SIGNING_KEY).update(`${timestamp}GET${requestPath}`).digest('base64');
  const response = await fetch(`https://api.prime.coinbase.com${requestPath}`, { headers: { 'X-CB-ACCESS-KEY': process.env.COINBASE_PRIME_ACCESS_KEY, 'X-CB-ACCESS-PASSPHRASE': process.env.COINBASE_PRIME_PASSPHRASE, 'X-CB-ACCESS-SIGNATURE': signature, 'X-CB-ACCESS-TIMESTAMP': timestamp, Accept: 'application/json' }, signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) throw new Error('Prime request failed');
  return response.json();
}
app.get('/api/admin/prime', requireUser, requireOwner, async (_req, res) => {
  if (!primeConfigured()) return res.status(503).json({ error: 'Coinbase Prime is not configured.' });
  try {
    const portfolioPath = `/v1/portfolios/${process.env.COINBASE_PRIME_PORTFOLIO_ID}`;
    const [balances, wallets] = await Promise.all([primeGetPath(`${portfolioPath}/balances`), primeGetPath(`${portfolioPath}/wallets`)]);
    // Return only fields needed by the owner dashboard, never API credentials.
    res.json({ balances: Array.isArray(balances.balances) ? balances.balances.map(({ symbol, amount, withdrawable_amount }) => ({ symbol, amount, withdrawable_amount })) : [], wallets: Array.isArray(wallets.wallets) ? wallets.wallets.map(({ id, name, symbol, type, primary_address }) => ({ id, name, symbol, type, primary_address })) : [], pagination: wallets.pagination || null });
  } catch (_) { res.status(502).json({ error: 'Unable to retrieve Coinbase Prime data. Check server configuration and provider availability.' }); }
});

// Read-only provider metadata. Presence in this list does not enable custody, deposits or withdrawals.
app.get('/api/admin/prime/assets', requireUser, requireOwner, async (_req, res) => {
  if (!primeAssetsConfigured()) return res.status(503).json({ error: 'Coinbase Prime entity and read-only credentials are not configured.' });
  try {
    const response = await primeGetPath(`/v1/entities/${process.env.COINBASE_PRIME_ENTITY_ID}/assets`);
    if (!Array.isArray(response.assets)) throw new Error('Unexpected Prime asset response');
    const wanted = new Set(['SOL', 'LTC', 'USDT']);
    const assets = response.assets.filter((asset) => typeof asset?.symbol === 'string' && wanted.has(asset.symbol.toUpperCase())).map((asset) => ({
      symbol: asset.symbol,
      name: typeof asset.name === 'string' ? asset.name : '',
      decimalPrecision: typeof asset.decimal_precision === 'string' ? asset.decimal_precision : null,
      networks: Array.isArray(asset.networks) ? asset.networks.map((entry) => ({
        name: typeof entry?.name === 'string' ? entry.name : '',
        networkId: typeof entry?.network?.id === 'string' ? entry.network.id : null,
        networkType: typeof entry?.network?.type === 'string' ? entry.network.type : null,
        scopedSymbol: typeof entry?.network_scoped_symbol === 'string' ? entry.network_scoped_symbol : null,
        tradingSupported: typeof entry?.trading_supported === 'boolean' ? entry.trading_supported : null,
        vaultSupported: typeof entry?.vault_supported === 'boolean' ? entry.vault_supported : null,
        custodySupported: typeof entry?.prime_custody_supported === 'boolean' ? entry.prime_custody_supported : null,
      })) : [],
    }));
    res.json({ assets });
  } catch (_) { res.status(502).json({ error: 'Unable to retrieve Coinbase Prime asset metadata. Check configuration and provider availability.' }); }
});

// Giveaway prizes are recorded for manual fulfillment only; no customer or owner balance is changed.
const giveawayLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
const { processEmailQueue } = registerGiveawayRoutes({ app, client, giveaways, entries, users, notifications, outbox, mail, requireUser, requireOwner, csrf, giveawayLimiter });
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
for (const route of ['/signin', '/signup']) app.get(route, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.html')));
for (const route of ['/dashboard', '/withdraw', '/giveaways', '/buy', '/owner', '/trade', '/swap', '/invest']) app.get(route, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], index: 'index.html', dotfiles: 'deny' }));
app.use((err, _req, res, _next) => { console.error('Request failed.'); res.status(500).json({ error: 'Request failed.' }); });
return { app, processEmailQueue, processMainnetDeposits: mainnetDepositsWorker.processDeposits };
}
module.exports = { createMongoApp };
