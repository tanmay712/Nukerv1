const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const signature = require('cookie-signature');
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'test-secret-which-is-longer-than-32-characters';
process.env.OWNER_DISCORD_ID = '123456789012345678';
const { app, db } = require('../server');
function login(provider, id) {
  const userId = `${provider}:${id}`;
  db.prepare('INSERT OR REPLACE INTO users VALUES (?, ?, ?, ?, ?, ?, ?)').run(userId, provider, id, 'Test user', null, new Date().toISOString(), new Date().toISOString());
  const sid = `${provider}-${id}`;
  const data = { cookie: { originalMaxAge: 28800000, expires: new Date(Date.now() + 28800000).toISOString(), httpOnly: true, path: '/', sameSite: 'lax' }, passport: { user: userId }, csrf: 'a'.repeat(64) };
  db.prepare('INSERT OR REPLACE INTO sessions VALUES (?, ?, ?)').run(sid, JSON.stringify(data), Date.now() + 28800000);
  return `vaultly.sid=${encodeURIComponent('s:' + signature.sign(sid, process.env.SESSION_SECRET))}`;
}
after(() => db.close());
test('unauthenticated requests cannot access owner APIs', async () => {
  assert.equal((await request(app).get('/api/admin')).status, 401);
  assert.equal((await request(app).get('/api/admin/prime')).status, 401);
  assert.equal((await request(app).post('/api/admin/settings').send({supportEmail:'x@example.com'})).status, 401);
});
test('owner requires the configured Discord identity, not a matching Google identity', async () => {
  for (const cookie of [login('google', process.env.OWNER_DISCORD_ID), login('discord', '999999999999999999')]) {
    assert.equal((await request(app).get('/api/admin').set('Cookie', cookie)).status, 403);
    assert.equal((await request(app).get('/api/admin/prime').set('Cookie', cookie)).status, 403);
  }
  const cookie = login('discord', process.env.OWNER_DISCORD_ID);
  assert.equal((await request(app).get('/api/admin').set('Cookie', cookie)).status, 200);
  const me = await request(app).get('/api/session').set('Cookie', cookie);
  assert.equal(me.body.user.owner, true);
});
test('settings require owner session and CSRF token', async () => {
  const owner = login('discord', process.env.OWNER_DISCORD_ID);
  assert.equal((await request(app).post('/api/admin/settings').set('Cookie', owner).send({supportEmail:'support@example.com'})).status, 403);
  assert.equal((await request(app).post('/api/admin/settings').set('Cookie', owner).set('x-csrf-token','a'.repeat(64)).send({supportEmail:'invalid'})).status, 400);
  assert.equal((await request(app).post('/api/admin/settings').set('Cookie', owner).set('x-csrf-token','a'.repeat(64)).send({supportEmail:'support@example.com'})).status, 200);
  assert.equal((await request(app).get('/api/admin').set('Cookie', owner)).body.supportEmail, 'support@example.com');
  assert.equal((await request(app).get('/api/admin/prime').set('Cookie', owner)).status, 503);
});
test('unconfigured providers and removed fake explorer are unavailable', async () => {
  const session = await request(app).get('/api/session');
  assert.deepEqual(session.body.providers, { google: false, discord: false });
  assert.equal((await request(app).get('/auth/discord')).status, 503);
  assert.equal((await request(app).get('/explorer.html')).status, 404);
  const html = await request(app).get('/');
  assert.equal(html.status, 200);
  assert(!html.text.includes('$78'));
});
test('Prime portfolio requests are signed server-side and only exposed to the owner', async () => {
  const crypto = require('node:crypto');
  process.env.COINBASE_PRIME_ACCESS_KEY = 'read-only-key';
  process.env.COINBASE_PRIME_SIGNING_KEY = 'signing-secret';
  process.env.COINBASE_PRIME_PASSPHRASE = 'passphrase';
  process.env.COINBASE_PRIME_PORTFOLIO_ID = '12345678-1234-1234-1234-123456789abc';
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push(url);
    const p = new URL(url).pathname;
    const expected = crypto.createHmac('sha256', 'signing-secret').update(`${options.headers['X-CB-ACCESS-TIMESTAMP']}GET${p}`).digest('base64');
    assert.equal(options.headers['X-CB-ACCESS-SIGNATURE'], expected);
    assert.equal(options.headers['X-CB-ACCESS-KEY'], 'read-only-key');
    return { ok: true, json: async () => p.endsWith('balances') ? { balances: [{ symbol: 'USDT', amount: '2.5', withdrawable_amount: '2', private_field: 'omit' }] } : { wallets: [{ id: 'wallet-1', name: 'Main', secret_field: 'omit' }] } };
  };
  try {
    const owner = login('discord', process.env.OWNER_DISCORD_ID);
    const result = await request(app).get('/api/admin/prime').set('Cookie', owner);
    assert.equal(result.status, 200);
    assert.equal(result.body.balances[0].amount, '2.5');
    assert.equal(result.body.balances[0].private_field, undefined);
    assert.equal(result.body.wallets[0].secret_field, undefined);
    assert.equal(calls.length, 2);
    assert(!JSON.stringify(result.body).includes('signing-secret'));
  } finally {
    global.fetch = originalFetch;
    for (const key of ['COINBASE_PRIME_ACCESS_KEY', 'COINBASE_PRIME_SIGNING_KEY', 'COINBASE_PRIME_PASSPHRASE', 'COINBASE_PRIME_PORTFOLIO_ID']) delete process.env[key];
  }
});
test('email test requires the Discord owner, CSRF, and a saved recipient', async () => {
  const nodemailer = require('nodemailer');
  const original = nodemailer.createTransport;
  const sent = [];
  Object.assign(process.env, { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_SECURE: 'false', SMTP_USER: 'mailer', SMTP_PASSWORD: 'secret', MAIL_FROM: 'noreply@example.test' });
  nodemailer.createTransport = (options) => {
    assert.equal(options.requireTLS, true);
    return { async sendMail(message) { sent.push(message); return {accepted: [message.to], rejected: []}; }, close() {} };
  };
  try {
    const owner = login('discord', process.env.OWNER_DISCORD_ID);
    const other = login('discord', '888888888888888888');
    assert.equal((await request(app).post('/api/admin/email/test').set('Cookie', other).set('x-csrf-token', 'a'.repeat(64))).status, 403);
    assert.equal((await request(app).post('/api/admin/email/test').set('Cookie', owner)).status, 403);
    assert.equal((await request(app).post('/api/admin/email/test').set('Cookie', owner).set('x-csrf-token', 'a'.repeat(64))).status, 400);
    assert.equal((await request(app).post('/api/admin/settings').set('Cookie', owner).set('x-csrf-token', 'a'.repeat(64)).send({supportEmail: 'support@example.test', notificationEmail: 'owner@example.test'})).status, 200);
    assert.equal((await request(app).post('/api/admin/email/test').set('Cookie', owner).set('x-csrf-token', 'a'.repeat(64))).status, 200);
    assert.equal(sent.length, 1); assert.equal(sent[0].to, 'owner@example.test');
  } finally {
    nodemailer.createTransport = original;
    for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM']) delete process.env[key];
  }
});
test('account notifications only use verified emails passed by OAuth and owner alert is separate', async () => {
  const nodemailer = require('nodemailer'), mail = require('../mail');
  const original = nodemailer.createTransport, sent = [];
  Object.assign(process.env, { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465', SMTP_SECURE: 'true', SMTP_USER: 'mailer', SMTP_PASSWORD: 'secret', MAIL_FROM: 'noreply@example.test' });
  nodemailer.createTransport = (options) => { assert.equal(options.secure, true); return { async sendMail(message) { sent.push(message); return { accepted: [message.to], rejected: [] }; }, close() {} }; };
  try {
    await mail.notifyLogin({provider:'discord',email:null}, 'owner@example.test');
    assert.equal(sent.length, 1); assert.equal(sent[0].to, 'owner@example.test');
    await mail.notifyLogin({provider:'google',email:'user@example.test'}, 'owner@example.test');
    assert.equal(sent.length, 3); assert.equal(sent[1].to, 'user@example.test'); assert.equal(sent[2].to, 'owner@example.test');
    assert.equal(mail.isEmail('user@example.test\r\nBcc:evil@example.test'), false);
  } finally {
    nodemailer.createTransport = original;
    for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM']) delete process.env[key];
  }
});
test('giveaway lifecycle enforces access, one entry, random draw, and private persistent alerts', async () => {
  const owner = login('discord', process.env.OWNER_DISCORD_ID);
  const alice = login('google', 'entrant-alice');
  const bob = login('google', 'entrant-bob');
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run('alice@example.test', 'google:entrant-alice');
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run('bob@example.test', 'google:entrant-bob');
  const csrf = 'a'.repeat(64);
  const payload = { title: 'Community prize', prize: '0.001', terms: 'Adults in eligible regions may enter.', endsAt: new Date(Date.now() + 600000).toISOString() };
  assert.equal((await request(app).post('/api/admin/giveaways').set('Cookie', alice).set('x-csrf-token', csrf).send(payload)).status, 403);
  assert.equal((await request(app).post('/api/admin/giveaways').set('Cookie', owner).send(payload)).status, 403);
  assert.equal((await request(app).post('/api/admin/giveaways').set('Cookie', owner).set('x-csrf-token', csrf).send({...payload, prize:'-1'})).status, 400);
  const created = await request(app).post('/api/admin/giveaways').set('Cookie', owner).set('x-csrf-token', csrf).send(payload);
  assert.equal(created.status, 201); const id = created.body.id;
  assert.equal((await request(app).post(`/api/giveaways/${id}/enter`)).status, 401);
  assert.equal((await request(app).post(`/api/giveaways/${id}/enter`).set('Cookie', alice).set('x-csrf-token', csrf)).status, 201);
  assert.equal((await request(app).post(`/api/giveaways/${id}/enter`).set('Cookie', alice).set('x-csrf-token', csrf)).status, 409);
  assert.equal((await request(app).post(`/api/giveaways/${id}/enter`).set('Cookie', bob).set('x-csrf-token', csrf)).status, 201);
  assert.equal((await request(app).post(`/api/admin/giveaways/${id}/draw`).set('Cookie', owner).set('x-csrf-token', csrf)).status, 409);
  db.prepare('UPDATE giveaways SET ends_at = ? WHERE id = ?').run(Date.now() - 1, id);
  assert.equal((await request(app).post(`/api/giveaways/${id}/enter`).set('Cookie', owner).set('x-csrf-token', csrf)).status, 409);
  const draw = await request(app).post(`/api/admin/giveaways/${id}/draw`).set('Cookie', owner).set('x-csrf-token', csrf);
  assert.equal(draw.status, 200); assert.equal(draw.body.payout, 'pending'); assert.equal(draw.body.emailQueued, true);
  assert.equal((await request(app).post(`/api/admin/giveaways/${id}/draw`).set('Cookie', owner).set('x-csrf-token', csrf)).status, 409);
  const a = (await request(app).get('/api/notifications').set('Cookie', alice)).body.notifications;
  const b = (await request(app).get('/api/notifications').set('Cookie', bob)).body.notifications;
  assert.equal(a.length + b.length, 1);
  const winnerCookie = a.length ? alice : bob, loserCookie = a.length ? bob : alice, notice = (a.length ? a : b)[0];
  assert.match(notice.message, /0\.001 LTC/); assert.match(notice.message, /no payment has been sent/);
  assert.equal((await request(app).post(`/api/notifications/${notice.id}/read`).set('Cookie', loserCookie).set('x-csrf-token', csrf)).status, 404);
  assert.equal((await request(app).post(`/api/notifications/${notice.id}/read`).set('Cookie', winnerCookie).set('x-csrf-token', csrf)).status, 200);
  assert.ok((await request(app).get('/api/notifications').set('Cookie', winnerCookie)).body.notifications[0].read_at);
  const mailItem = db.prepare('SELECT * FROM email_outbox').all(); assert.equal(mailItem.length, 1); assert.equal(mailItem[0].state, 'pending');
  const list = await request(app).get('/api/giveaways').set('Cookie', winnerCookie);
  assert.equal(list.body.giveaways.find(g => g.id === id).won, 1);
  assert.equal((await request(app).get('/api/admin/giveaways').set('Cookie', alice)).status, 403);
});
test('giveaways may be cancelled and app routes load without a fake payout', async () => {
  const owner = login('discord', process.env.OWNER_DISCORD_ID), csrf = 'a'.repeat(64);
  const created = await request(app).post('/api/admin/giveaways').set('Cookie', owner).set('x-csrf-token', csrf).send({ title: 'Another giveaway', prize: '1', terms: 'Open to eligible participants.', endsAt: new Date(Date.now() + 600000).toISOString() });
  const id = created.body.id;
  assert.equal((await request(app).post(`/api/admin/giveaways/${id}/cancel`).set('Cookie', owner).set('x-csrf-token', csrf)).status, 200);
  assert.equal((await request(app).post(`/api/giveaways/${id}/enter`).set('Cookie', owner).set('x-csrf-token', csrf)).status, 409);
  for (const route of ['/dashboard', '/withdraw', '/giveaways', '/buy', '/owner']) assert.equal((await request(app).get(route)).status, 200);
});
test('giveaway winner email outbox delivers pending messages and retries failures', async () => {
  const { processEmailQueue } = require('../server');
  const nodemailer = require('nodemailer'), original = nodemailer.createTransport;
  Object.assign(process.env, { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'mailer', SMTP_PASSWORD: 'secret', MAIL_FROM: 'noreply@example.test' });
  const sent = [];
  nodemailer.createTransport = () => ({ async sendMail(message) { sent.push(message); return { accepted: [message.to], rejected: [] }; }, close() {} });
  try {
    await processEmailQueue();
    assert.equal(sent.length, 1);
    assert.equal(db.prepare('SELECT state FROM email_outbox').get().state, 'sent');
    await processEmailQueue(); assert.equal(sent.length, 1);
    db.prepare('INSERT INTO email_outbox (id, recipient, subject, body, next_attempt, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('retry-test', 'retry@example.test', 'Test', 'Test', 0, 0);
    nodemailer.createTransport = () => ({ async sendMail() { throw new Error('offline'); }, close() {} });
    await processEmailQueue();
    const failed = db.prepare('SELECT state, attempts, next_attempt FROM email_outbox WHERE id = ?').get('retry-test');
    assert.equal(failed.state, 'pending'); assert.equal(failed.attempts, 1); assert(failed.next_attempt > Date.now());
  } finally {
    nodemailer.createTransport = original;
    for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM']) delete process.env[key];
  }
});
