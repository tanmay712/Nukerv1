'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MongoSessionStore, connectMongo, initializeMongo, saveMongoUser, getMongoUser } = require('../mongo-foundation');

function collection() {
  const docs = new Map(), indexes = [];
  const match = (filter, doc) => doc && (!filter.expiresAt || doc.expiresAt > filter.expiresAt.$gt);
  return {
    docs, indexes,
    async createIndex(keys, options) { indexes.push({ keys, options }); },
    async findOne(filter) { const doc = docs.get(filter._id); return match(filter, doc) ? structuredClone(doc) : null; },
    async updateOne(filter, update, options = {}) {
      let doc = docs.get(filter._id);
      if (!doc) {
        if (!options.upsert) return;
        doc = { _id: filter._id, ...structuredClone(update.$setOnInsert || {}) };
      } else if (!match(filter, doc)) return;
      const set = structuredClone(update.$set);
      if (set['data.cookie']) { doc.data.cookie = set['data.cookie']; delete set['data.cookie']; }
      docs.set(filter._id, { ...doc, ...set });
    },
    async deleteOne(filter) { docs.delete(filter._id); },
  };
}
const call = (store, method, ...args) => new Promise((resolve, reject) => store[method](...args, (error, result) => error ? reject(error) : resolve(result)));

test('Mongo sessions persist, expire immediately at read time, and cannot be resurrected by touch', async () => {
  const c = collection();
  const store = new MongoSessionStore(c);
  const value = { cookie: { expires: new Date(Date.now() + 100000).toISOString() }, passport: { user: 'google:42' }, csrf: 'secret' };
  await call(store, 'set', 'sid', value);
  assert.deepEqual(await call(store, 'get', 'sid'), value);
  const next = { ...value, cookie: { expires: new Date(Date.now() + 200000).toISOString() } };
  await call(store, 'touch', 'sid', next);
  assert.equal(c.docs.get('sid').expiresAt.toISOString(), next.cookie.expires);
  assert.equal((await call(store, 'get', 'sid')).cookie.expires, next.cookie.expires);
  c.docs.get('sid').expiresAt = new Date(Date.now() - 1000);
  assert.equal(await call(store, 'get', 'sid'), null);
  await call(store, 'touch', 'sid', next);
  assert.equal(await call(store, 'get', 'sid'), null);
  await call(store, 'destroy', 'sid');
  assert.equal(c.docs.size, 0);
  await assert.rejects(call(store, 'set', 'bad', { cookie: { expires: 'not-a-date' } }), /Invalid session expiry/);
});

test('Mongo setup creates an expiration index and a user listing index', async () => {
  const collections = { users: collection(), sessions: collection() };
  const stores = await initializeMongo({ collection: (name) => collections[name] });
  assert(stores.sessionStore instanceof MongoSessionStore);
  assert.deepEqual(collections.sessions.indexes, [{ keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } }]);
  assert.deepEqual(collections.users.indexes[0].keys, { last_login: -1 });
});

test('Mongo users preserve creation time and provider identity across sign-ins', async () => {
  const users = collection();
  assert.deepEqual(await saveMongoUser(users, 'discord', { id: '123456', username: 'First', email: 'u@example.test' }), { id: 'discord:123456' });
  const first = users.docs.get('discord:123456').created_at;
  await saveMongoUser(users, 'discord', { id: '123456', username: 'Second' });
  const result = await getMongoUser(users, 'discord:123456');
  assert.deepEqual(result, { id: 'discord:123456', provider: 'discord', provider_id: '123456', name: 'Second', email: null });
  assert.equal(users.docs.get('discord:123456').created_at, first);
  assert.equal(await getMongoUser(users, 'missing'), null);
  await assert.rejects(saveMongoUser(users, '$bad', { id: 'x' }), /Invalid user identity/);
  await assert.rejects(saveMongoUser(users, 'google', { id: { $ne: null } }), /Invalid user identity/);
});

test('connection failures do not leak URI secrets and close the client', async () => {
  let closed = false;
  class BrokenClient {
    async connect() { throw new Error('mongodb://secret@example.test'); }
    async close() { closed = true; }
  }
  await assert.rejects(connectMongo('mongodb://secret@example.test', 'cryply', { MongoClient: BrokenClient }), (error) => {
    assert.equal(error.message, 'MongoDB connection or initialization failed');
    return true;
  });
  assert.equal(closed, true);
  await assert.rejects(connectMongo('https://example.test', 'cryply'), /connection string/);
  await assert.rejects(connectMongo('mongodb://example.test', 'bad/name'), /database name/);
});
