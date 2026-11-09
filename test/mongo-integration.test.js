'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const signature = require('cookie-signature');
const { MongoClient } = require('mongodb');
const { initializeMongo, saveMongoUser } = require('../mongo-foundation');
const { createMongoApp } = require('../mongo-app');
const { migrate } = require('../scripts/migrate-sqlite-to-mongo');

// Must be a disposable replica set, never an actual customer database.
test('MongoDB real integration: session persistence, access, atomic giveaways, and migration', { skip: !process.env.MONGO_TEST_URI, timeout: 60000 }, async () => {
  process.env.SESSION_SECRET = 'test-secret-at-least-32-characters-long';
  process.env.OWNER_DISCORD_ID = '123456789012345678';
  delete process.env.PUBLIC_BASE_URL;
  const client = new MongoClient(process.env.MONGO_TEST_URI, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const suffix = crypto.randomBytes(8).toString('hex');
  const db = client.db(`cryply_test_${suffix}`), target = client.db(`cryply_migrate_test_${suffix}`);
  try {
    const stores = await initializeMongo(db);
    const { app, processEmailQueue } = await createMongoApp({ client, db, ...stores });
    const login = async (provider, id, email) => {
      const user = await saveMongoUser(stores.users, provider, { id, username: id, email });
      const sid = `${provider}-${id}`;
      const data = { cookie: { originalMaxAge: 28800000, expires: new Date(Date.now() + 28800000).toISOString(), httpOnly: true, path: '/', sameSite: 'lax' }, passport: { user: user.id }, csrf: 'a'.repeat(64) };
      await new Promise((resolve, reject) => stores.sessionStore.set(sid, data, err => err ? reject(err) : resolve()));
      return `vaultly.sid=${encodeURIComponent('s:' + signature.sign(sid, process.env.SESSION_SECRET))}`;
    };
    const owner = await login('discord', process.env.OWNER_DISCORD_ID, 'owner@example.test');
    const alice = await login('google', 'alice', 'alice@example.test');
    const bob = await login('google', 'bob', 'bob@example.test');
    const csrf = 'a'.repeat(64);
    assert.equal((await request(app).post('/api/devnet/solana/balance').send({ address:'1'.repeat(32) })).status, 401);
    assert.equal((await request(app).post('/api/devnet/solana/balance').set('Cookie', alice).send({ address:'1'.repeat(32) })).status, 403);
    assert.equal((await request(app).post('/api/devnet/solana/balance').set('Cookie', alice).set('x-csrf-token', csrf).send({ address:'bad' })).status, 400);
    assert.equal((await request(app).get('/api/devnet/wallet/status')).status, 401);
    assert.equal((await request(app).post('/api/devnet/wallet/session').set('Cookie', alice).send({})).status, 403);
    const previousFlag = process.env.ENABLE_EXPERIMENTAL_TATUM_DEVNET, previousTatum = process.env.TATUM_API_KEY;
    try {
      process.env.ENABLE_EXPERIMENTAL_TATUM_DEVNET = '1'; process.env.TATUM_API_KEY = 'test';
      await db.collection('tatum_wallet_clients').insertOne({ _id:'google:alice', state:'needs_review' });
      assert.equal((await request(app).get('/api/devnet/wallet/status').set('Cookie', alice)).body.state, 'needs_review');
      assert.equal((await request(app).get('/api/devnet/wallet/status').set('Cookie', bob)).body.state, 'new');
      assert.equal((await request(app).post('/api/devnet/wallet/session').set('Cookie', alice).set('x-csrf-token', csrf).send({})).status, 409);
      await db.collection('tatum_wallet_clients').insertOne({ _id:'google:bob', state:'ready', clientId:'mock-client' });
      const claim = () => request(app).post('/api/devnet/wallet/begin').set('Cookie', bob).set('x-csrf-token', csrf).send({});
      assert.deepEqual((await Promise.all([claim(), claim()])).map(response => response.status).sort(), [200,409]);
    } finally {
      if (previousFlag === undefined) delete process.env.ENABLE_EXPERIMENTAL_TATUM_DEVNET; else process.env.ENABLE_EXPERIMENTAL_TATUM_DEVNET = previousFlag;
      if (previousTatum === undefined) delete process.env.TATUM_API_KEY; else process.env.TATUM_API_KEY = previousTatum;
    }
    assert.equal((await request(app).get('/api/watchlist')).status, 401);
    assert.equal((await request(app).post('/api/watchlist/SOL').set('Cookie', alice).send({ saved:true })).status, 403);
    const watch = (cookie, symbol, saved) => request(app).post(`/api/watchlist/${symbol}`).set('Cookie', cookie).set('x-csrf-token', csrf).send({saved});
    assert.equal((await watch(alice, 'FAKE', true)).status, 400);
    assert.deepEqual((await Promise.all([watch(alice, 'SOL', true), watch(alice, 'LTC', true), watch(alice, 'SOL', true)])).map(r => r.status), [200,200,200]);
    assert.deepEqual((await request(app).get('/api/watchlist').set('Cookie', alice)).body.assets, ['SOL','LTC']);
    assert.deepEqual((await request(app).get('/api/watchlist').set('Cookie', bob)).body.assets, []);
    assert.equal((await watch(alice, 'SOL', false)).status, 200);
    assert.deepEqual((await request(app).get('/api/watchlist').set('Cookie', alice)).body.assets, ['LTC']);
    for (const route of ['/trade','/swap','/invest']) assert.equal((await request(app).get(route)).status, 200);
    assert.equal((await request(app).get('/api/admin')).status, 401);
    assert.equal((await request(app).get('/api/admin').set('Cookie', alice)).status, 403);
    assert.equal((await request(app).get('/api/session').set('Cookie', owner)).body.user.owner, true);
    assert.equal((await request(app).post('/api/admin/settings').set('Cookie', owner).send({supportEmail:'support@example.test'})).status, 403);
    assert.equal((await request(app).post('/api/admin/settings').set('Cookie', owner).set('x-csrf-token', csrf).send({supportEmail:'support@example.test'})).status, 200);
    assert.equal((await request(app).get('/api/admin').set('Cookie', owner)).body.supportEmail, 'support@example.test');
    const recreatedStore = (await initializeMongo(db)).sessionStore;
    assert.equal((await new Promise((resolve, reject) => recreatedStore.get('google-alice', (err, value) => err ? reject(err) : resolve(value)))).passport.user, 'google:alice');
    const payload = { title: 'Test giveaway', prize:'0.001', terms:'Free entry for eligible users.', endsAt:new Date(Date.now() + 600000).toISOString() };
    const created = await request(app).post('/api/admin/giveaways').set('Cookie', owner).set('x-csrf-token', csrf).send(payload);
    assert.equal(created.status, 201);
    const id = created.body.id;
    const enter = (cookie) => request(app).post(`/api/giveaways/${id}/enter`).set('Cookie', cookie).set('x-csrf-token', csrf);
    const results = await Promise.all([enter(alice), enter(alice), enter(bob)]);
    assert.deepEqual(results.map(x => x.status).sort(), [201,201,409]);
    assert.equal((await db.collection('giveaways').findOne({ _id:id })).entry_count, 2);
    assert.equal((await db.collection('giveaway_entries').countDocuments({ giveaway_id:id })), 2);
    assert.equal((await request(app).post(`/api/admin/giveaways/${id}/draw`).set('Cookie', owner).set('x-csrf-token', csrf)).status, 409);
    await db.collection('giveaways').updateOne({ _id:id }, { $set:{ ends_at:Date.now() - 1 } });
    const draw = () => request(app).post(`/api/admin/giveaways/${id}/draw`).set('Cookie', owner).set('x-csrf-token', csrf);
    const draws = await Promise.all([draw(), draw()]);
    assert.deepEqual(draws.map(x => x.status).sort(), [200,409]);
    assert.equal(await db.collection('notifications').countDocuments({}), 1);
    assert.equal(await db.collection('email_outbox').countDocuments({}), 1);
    const notice = await db.collection('notifications').findOne({});
    const winningCookie = notice.user_id === 'google:alice' ? alice : bob;
    const losingCookie = winningCookie === alice ? bob : alice;
    assert.equal((await request(app).post(`/api/notifications/${notice._id}/read`).set('Cookie', losingCookie).set('x-csrf-token', csrf)).status, 404);
    assert.equal((await request(app).post(`/api/notifications/${notice._id}/read`).set('Cookie', winningCookie).set('x-csrf-token', csrf)).status, 200);
    assert.equal((await request(app).get('/api/giveaways').set('Cookie', winningCookie)).body.giveaways[0].won, true);
    const nodemailer = require('nodemailer');
    const originalTransport = nodemailer.createTransport;
    Object.assign(process.env, { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'user', SMTP_PASSWORD: 'test', MAIL_FROM: 'sender@example.test' });
    try {
      nodemailer.createTransport = () => ({ async sendMail() { throw new Error('offline'); }, close() {} });
      await processEmailQueue();
      let item = await db.collection('email_outbox').findOne({});
      assert.equal(item.state, 'pending'); assert.equal(item.attempts, 1); assert(item.next_attempt > Date.now());
      await db.collection('email_outbox').updateOne({ _id: item._id }, { $set: { next_attempt: 0 } });
      let sent = 0;
      nodemailer.createTransport = () => ({ async sendMail(message) { sent++; return { accepted:[message.to], rejected:[] }; }, close() {} });
      await processEmailQueue(); await processEmailQueue();
      item = await db.collection('email_outbox').findOne({});
      assert.equal(item.state, 'sent'); assert.equal(sent, 1);
    } finally {
      nodemailer.createTransport = originalTransport;
      for (const key of ['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASSWORD','MAIL_FROM']) delete process.env[key];
    }
    const migrationData = { users:[{ id:'google:old', provider:'google', provider_id:'old', name:'Old', email:null, created_at:'x', last_login:'x' }], settings:[{ key:'support_email',value:'help@example.test' }], giveaways:[], entries:[], notifications:[], outbox:[] };
    const imported = await migrate(client, target, migrationData);
    assert.equal(imported.users, 1);
    assert.equal((await target.collection('users').findOne({ _id:'google:old' })).name, 'Old');
    await assert.rejects(migrate(client, target, migrationData), /not empty/);
    assert.equal(await target.collection('users').countDocuments({}), 1);
    const rollback = client.db(`cryply_migrate_rollback_${suffix}`);
    try {
      const duplicate = { ...migrationData, users:[migrationData.users[0], migrationData.users[0]] };
      await assert.rejects(migrate(client, rollback, duplicate));
      assert.equal(await rollback.collection('users').countDocuments({}), 0);
      assert.equal(await rollback.collection('settings').countDocuments({}), 0);
    } finally { await rollback.dropDatabase(); }
  } finally {
    await db.dropDatabase(); await target.dropDatabase(); await client.close();
  }
});
