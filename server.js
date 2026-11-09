require('dotenv').config({ quiet: true });
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const OAuth2Strategy = require('passport-oauth2').Strategy;
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const mail = require('./mail');

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
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'self'"], frameAncestors: ["'none'"] } } }));
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.json({ limit: '8kb' }));

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'wallet.sqlite');
if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT, created_at TEXT NOT NULL, last_login TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS giveaways (id TEXT PRIMARY KEY, title TEXT NOT NULL, prize TEXT NOT NULL, terms TEXT NOT NULL, ends_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, winner_id TEXT REFERENCES users(id));
CREATE TABLE IF NOT EXISTS giveaway_entries (giveaway_id TEXT NOT NULL REFERENCES giveaways(id), user_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, PRIMARY KEY (giveaway_id, user_id));
CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), message TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER);
CREATE TABLE IF NOT EXISTS email_outbox (id TEXT PRIMARY KEY, recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
if (dbPath !== ':memory:') fs.chmodSync(dbPath, 0o600);
class SqliteStore extends session.Store {
  get(sid, cb) { try { const row = db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires > ?').get(sid, Date.now()); cb(null, row ? JSON.parse(row.data) : null); } catch (err) { cb(err); } }
  set(sid, sess, cb = () => {}) { try { const expires = sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 8 * 3600000; db.prepare('INSERT INTO sessions VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data=excluded.data, expires=excluded.expires').run(sid, JSON.stringify(sess), expires); cb(); } catch (err) { cb(err); } }
  destroy(sid, cb = () => {}) { try { db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb(); } catch (err) { cb(err); } }
  touch(sid, sess, cb = () => {}) { try { db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(new Date(sess.cookie.expires).getTime(), sid); cb(); } catch (err) { cb(err); } }
}
db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
app.use(session({ name: 'vaultly.sid', secret, store: new SqliteStore(), resave: false, saveUninitialized: false, cookie: { httpOnly: true, secure: baseUrl.startsWith('https://'), sameSite: 'lax', maxAge: 8 * 3600000 } }));
app.use(passport.initialize());
app.use(passport.session());

function saveUser(provider, profile) {
  const id = `${provider}:${profile.id}`;
  const now = new Date().toISOString();
  const name = String(profile.displayName || profile.username || 'User').slice(0, 100);
  const email = profile.email ? String(profile.email).slice(0, 254) : null;
  db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, email=excluded.email, last_login=excluded.last_login').run(id, provider, String(profile.id), name, email, now, now);
  return { id };
}
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => { try { done(null, db.prepare('SELECT id, provider, provider_id, name, email FROM users WHERE id = ?').get(id) || false); } catch (err) { done(err); } });
const googleEnabled = Boolean(baseUrl && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const discordEnabled = Boolean(baseUrl && process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET);
if (googleEnabled) passport.use('google', new GoogleStrategy({ clientID: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, callbackURL: `${baseUrl}/auth/google/callback`, state: true }, (_access, _refresh, profile, done) => { try { done(null, saveUser('google', { id: profile.id, displayName: profile.displayName, email: profile._json?.email_verified === true ? profile._json.email : null })); } catch (err) { done(err); } }));
if (discordEnabled) {
  const discord = new OAuth2Strategy({ authorizationURL: 'https://discord.com/oauth2/authorize', tokenURL: 'https://discord.com/api/oauth2/token', clientID: process.env.DISCORD_CLIENT_ID, clientSecret: process.env.DISCORD_CLIENT_SECRET, callbackURL: `${baseUrl}/auth/discord/callback`, scope: ['identify', 'email'], state: true }, (_access, _refresh, profile, done) => { try { done(null, saveUser('discord', profile)); } catch (err) { done(err); } });
  discord.userProfile = (token, done) => { fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }).then(async (response) => { if (!response.ok) throw new Error('Discord profile request failed'); const user = await response.json(); if (!/^\d{5,25}$/.test(user.id)) throw new Error('Invalid Discord ID'); done(null, { id: user.id, username: user.global_name || user.username, email: user.verified === true ? user.email : null }); }).catch(done); };
  passport.use('discord', discord);
}
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
app.use('/auth', authLimiter);
for (const [provider, enabled] of [['google', googleEnabled], ['discord', discordEnabled]]) {
  app.get(`/auth/${provider}`, (req, res, next) => enabled ? passport.authenticate(provider, provider === 'google' ? { scope: ['profile', 'email'] } : {})(req, res, next) : res.status(503).send('This sign-in provider has not been configured.'));
  app.get(`/auth/${provider}/callback`, (req, res, next) => enabled ? passport.authenticate(provider, { failureRedirect: '/signin?login=failed' })(req, res, next) : res.status(503).send('This sign-in provider has not been configured.'), (req, res) => { const user = db.prepare('SELECT provider, email FROM users WHERE id = ?').get(req.user.id); const ownerEmail = db.prepare("SELECT value FROM settings WHERE key = 'notification_email'").get()?.value; if (user) mail.notifyLogin(user, ownerEmail).catch(() => console.error('Sign-in notification failed.')); res.redirect('/dashboard'); });
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
app.get('/api/admin', requireUser, requireOwner, (_req, res) => {
  const users = db.prepare('SELECT provider, name, email, created_at, last_login FROM users ORDER BY last_login DESC LIMIT 100').all();
  const settings = db.prepare("SELECT value FROM settings WHERE key = 'support_email'").get();
  const notifications = db.prepare("SELECT value FROM settings WHERE key = 'notification_email'").get();
  res.json({ users, supportEmail: settings?.value || '', notificationEmail: notifications?.value || '', mailConfigured: mail.mailConfigured(), primeConfigured: primeConfigured(), primeAssetsConfigured: primeAssetsConfigured() });
});
app.post('/api/admin/settings', requireUser, requireOwner, csrf, (req, res) => {
  const supportEmail = typeof req.body?.supportEmail === 'string' ? req.body.supportEmail.trim() : '';
  const notificationEmail = typeof req.body?.notificationEmail === 'string' ? req.body.notificationEmail.trim() : '';
  if ((supportEmail && !mail.isEmail(supportEmail)) || (notificationEmail && !mail.isEmail(notificationEmail))) return res.status(400).json({ error: 'Enter valid email addresses.' });
  const upsert = db.prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  db.exec('BEGIN');
  try { upsert.run('support_email', supportEmail); upsert.run('notification_email', notificationEmail); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
  res.json({ ok: true });
});
const emailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false });
app.post('/api/admin/email/test', requireUser, requireOwner, csrf, emailLimiter, async (_req, res) => {
  const email = db.prepare("SELECT value FROM settings WHERE key = 'notification_email'").get()?.value;
  if (!mail.mailConfigured()) return res.status(503).json({ error: 'SMTP is not configured.' });
  if (!mail.isEmail(email)) return res.status(400).json({ error: 'Save an owner notification email first.' });
  try { await mail.sendMail(email, 'Cryply email test', 'Your Cryply SMTP connection accepted this test message.\n'); res.json({ ok: true }); }
  catch (_) { console.error('SMTP test email failed.'); res.status(502).json({ error: 'Email delivery failed. Check the SMTP configuration.' }); }
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
app.get('/api/giveaways', requireUser, (req, res) => {
  const giveaways = db.prepare(`SELECT g.id, g.title, g.prize, g.terms, g.ends_at, g.state,
    (SELECT COUNT(*) FROM giveaway_entries e WHERE e.giveaway_id = g.id) AS entries,
    EXISTS(SELECT 1 FROM giveaway_entries e WHERE e.giveaway_id = g.id AND e.user_id = ?) AS entered,
    (g.winner_id = ?) AS won FROM giveaways g ORDER BY g.created_at DESC LIMIT 100`).all(req.user.id, req.user.id);
  res.json({ giveaways });
});
app.post('/api/giveaways/:id/enter', requireUser, csrf, giveawayLimiter, (req, res) => {
  const giveaway = db.prepare('SELECT state, ends_at FROM giveaways WHERE id = ?').get(req.params.id);
  if (!giveaway) return res.status(404).json({ error: 'Giveaway not found.' });
  if (giveaway.state !== 'open' || giveaway.ends_at <= Date.now()) return res.status(409).json({ error: 'Entries are closed.' });
  const now = Date.now();
  const result = db.prepare("INSERT OR IGNORE INTO giveaway_entries (giveaway_id, user_id, created_at) SELECT id, ?, ? FROM giveaways WHERE id = ? AND state = 'open' AND ends_at > ?").run(req.user.id, now, req.params.id, now);
  if (!result.changes) return res.status(409).json({ error: 'You have already entered or entries are closed.' });
  res.status(201).json({ ok: true });
});
app.get('/api/notifications', requireUser, (req, res) => {
  res.json({ notifications: db.prepare('SELECT id, message, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(req.user.id) });
});
app.post('/api/notifications/:id/read', requireUser, csrf, (req, res) => {
  const result = db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?').run(Date.now(), req.params.id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'Notification not found.' });
  res.json({ ok: true });
});
app.get('/api/admin/giveaways', requireUser, requireOwner, (_req, res) => {
  const giveaways = db.prepare(`SELECT g.id, g.title, g.prize, g.terms, g.ends_at, g.state, u.name AS winner_name,
    (SELECT COUNT(*) FROM giveaway_entries e WHERE e.giveaway_id = g.id) AS entries
    FROM giveaways g LEFT JOIN users u ON u.id = g.winner_id ORDER BY g.created_at DESC LIMIT 100`).all();
  res.json({ giveaways });
});
app.post('/api/admin/giveaways', requireUser, requireOwner, csrf, giveawayLimiter, (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const prize = typeof req.body?.prize === 'string' ? req.body.prize.trim() : '';
  const terms = typeof req.body?.terms === 'string' ? req.body.terms.trim() : '';
  const endsAt = typeof req.body?.endsAt === 'string' ? Date.parse(req.body.endsAt) : NaN;
  if (title.length < 3 || title.length > 100 || !/^(?:0|[1-9]\d{0,5})(?:\.\d{1,8})?$/.test(prize) || Number(prize) <= 0 || terms.length < 10 || terms.length > 1000 || !Number.isFinite(endsAt) || endsAt <= Date.now() || endsAt > Date.now() + 366 * 86400000) return res.status(400).json({ error: 'Provide a title, positive LTC prize, eligibility terms, and a future closing date within one year.' });
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO giveaways (id, title, prize, terms, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, title, prize, terms, endsAt, Date.now());
  res.status(201).json({ id });
});
app.post('/api/admin/giveaways/:id/cancel', requireUser, requireOwner, csrf, giveawayLimiter, (req, res) => {
  const result = db.prepare("UPDATE giveaways SET state = 'cancelled' WHERE id = ? AND state = 'open'").run(req.params.id);
  if (!result.changes) return res.status(409).json({ error: 'Giveaway cannot be cancelled.' });
  res.json({ ok: true });
});
app.post('/api/admin/giveaways/:id/draw', requireUser, requireOwner, csrf, giveawayLimiter, (req, res, next) => {
  let emailQueued = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    const giveaway = db.prepare('SELECT * FROM giveaways WHERE id = ?').get(req.params.id);
    if (!giveaway || giveaway.state !== 'open' || giveaway.ends_at > Date.now()) { db.exec('ROLLBACK'); return res.status(409).json({ error: 'The giveaway must be open and past its closing time.' }); }
    const count = db.prepare('SELECT COUNT(*) AS count FROM giveaway_entries WHERE giveaway_id = ?').get(giveaway.id).count;
    if (!count) { db.exec('ROLLBACK'); return res.status(409).json({ error: 'There are no entries to draw from.' }); }
    const selected = db.prepare('SELECT user_id FROM giveaway_entries WHERE giveaway_id = ? ORDER BY user_id LIMIT 1 OFFSET ?').get(giveaway.id, crypto.randomInt(count));
    const winner = db.prepare('SELECT id, email FROM users WHERE id = ?').get(selected.user_id);
    const message = `You were selected for ${giveaway.title}: ${giveaway.prize} LTC. Prize fulfillment is pending; no payment has been sent.`;
    db.prepare("UPDATE giveaways SET state = 'drawn', winner_id = ? WHERE id = ?").run(winner.id, giveaway.id);
    db.prepare('INSERT INTO notifications (id, user_id, message, created_at) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), winner.id, message, Date.now());
    if (mail.isEmail(winner.email)) { db.prepare('INSERT INTO email_outbox (id, recipient, subject, body, next_attempt, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), winner.email, 'Cryply giveaway result', `${message}\n\nSign in to your dashboard for details.\n`, Date.now(), Date.now()); emailQueued = true; }
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch (_) {} return next(error); }
  if (emailQueued) processEmailQueue().catch(() => console.error('Giveaway email queue failed.'));
  res.json({ ok: true, payout: 'pending', emailQueued });
});
let processingEmail = false;
async function processEmailQueue() {
  if (processingEmail || !mail.mailConfigured()) return;
  processingEmail = true;
  try {
    // Recover abandoned claims after a restart. SMTP acceptance and database writes cannot be atomic,
    // so a crash after acceptance may result in a duplicate notification on retry.
    db.prepare("UPDATE email_outbox SET state = 'pending' WHERE state = 'sending' AND updated_at < ?").run(Date.now() - 300000);
    for (let i = 0; i < 20; i++) {
      const item = db.prepare("SELECT * FROM email_outbox WHERE state = 'pending' AND next_attempt <= ? ORDER BY next_attempt LIMIT 1").get(Date.now());
      if (!item) break;
      const claim = db.prepare("UPDATE email_outbox SET state = 'sending', updated_at = ? WHERE id = ? AND state = 'pending'").run(Date.now(), item.id);
      if (!claim.changes) continue;
      try {
        await mail.sendMail(item.recipient, item.subject, item.body);
        db.prepare("UPDATE email_outbox SET state = 'sent', updated_at = ? WHERE id = ?").run(Date.now(), item.id);
      } catch (_) {
        const attempts = item.attempts + 1;
        db.prepare("UPDATE email_outbox SET state = 'pending', attempts = ?, next_attempt = ?, updated_at = ? WHERE id = ?").run(attempts, Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(attempts - 1, 6)), Date.now(), item.id);
        console.error('Giveaway notification email failed; it will be retried.');
      }
    }
  } finally { processingEmail = false; }
}
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
for (const route of ['/signin', '/signup']) app.get(route, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.html')));
for (const route of ['/dashboard', '/withdraw', '/giveaways', '/buy', '/owner']) app.get(route, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], index: 'index.html', dotfiles: 'deny' }));
app.use((err, _req, res, _next) => { console.error('Request failed:', err.message); res.status(500).json({ error: 'Request failed.' }); });
if (require.main === module) {
  const port = Number(process.env.PORT || 6546);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  app.listen(port, '0.0.0.0', () => console.log(`Cryply listening on port ${port}`));
  processEmailQueue().catch(() => console.error('Giveaway email queue failed.'));
  setInterval(() => processEmailQueue().catch(() => console.error('Giveaway email queue failed.')), 60000).unref();
}
module.exports = { app, db, processEmailQueue };
