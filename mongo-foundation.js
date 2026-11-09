'use strict';

// MongoDB connection and session/user storage for the Mongo-backed application.
const { MongoClient } = require('mongodb');
const session = require('express-session');

function sessionExpiry(value, now = Date.now()) {
  const expiry = value?.cookie?.expires == null ? now + 8 * 60 * 60 * 1000 : new Date(value.cookie.expires).getTime();
  if (!Number.isFinite(expiry)) throw new Error('Invalid session expiry');
  return new Date(expiry);
}

class MongoSessionStore extends session.Store {
  constructor(collection) {
    super();
    this.collection = collection;
  }
  get(sid, callback) {
    this.collection.findOne({ _id: sid, expiresAt: { $gt: new Date() } })
      .then((doc) => callback(null, doc ? doc.data : null), callback);
  }
  set(sid, value, callback = () => {}) {
    let expiresAt;
    try { expiresAt = sessionExpiry(value); } catch (error) { callback(error); return; }
    this.collection.updateOne({ _id: sid }, { $set: { data: value, expiresAt } }, { upsert: true })
      .then(() => callback(null), callback);
  }
  destroy(sid, callback = () => {}) {
    this.collection.deleteOne({ _id: sid }).then(() => callback(null), callback);
  }
  touch(sid, value, callback = () => {}) {
    let expiresAt;
    try { expiresAt = sessionExpiry(value); } catch (error) { callback(error); return; }
    // A stale request must not bring an expired session back to life.
    this.collection.updateOne({ _id: sid, expiresAt: { $gt: new Date() } }, { $set: { expiresAt, 'data.cookie': value.cookie } })
      .then(() => callback(null), callback);
  }
}

async function initializeMongo(db) {
  const users = db.collection('users');
  const sessions = db.collection('sessions');
  await sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await users.createIndex({ last_login: -1 });
  return { users, sessions, sessionStore: new MongoSessionStore(sessions) };
}

async function connectMongo(uri, databaseName, options = {}) {
  if (typeof uri !== 'string' || !/^mongodb(?:\+srv)?:\/\//.test(uri)) throw new Error('A MongoDB connection string is required');
  if (typeof databaseName !== 'string' || !/^[A-Za-z0-9_-]{1,63}$/.test(databaseName)) throw new Error('A valid MongoDB database name is required');
  const Client = options.MongoClient || MongoClient;
  const client = new Client(uri, { serverSelectionTimeoutMS: 10000, maxPoolSize: 10 });
  try {
    await client.connect();
    const db = client.db(databaseName);
    const stores = await initializeMongo(db);
    return { client, db, ...stores };
  } catch (_) {
    await client.close().catch(() => {});
    // Driver errors can include hostnames, connection details, or credentials.
    throw new Error('MongoDB connection or initialization failed');
  }
}

async function saveMongoUser(users, provider, profile) {
  if (!['google', 'discord'].includes(provider) || typeof profile?.id !== 'string' || !profile.id || profile.id.length > 256) throw new Error('Invalid user identity');
  const id = `${provider}:${profile.id}`;
  const now = new Date().toISOString();
  const name = String(profile.displayName || profile.username || 'User').slice(0, 100);
  const email = profile.email ? String(profile.email).slice(0, 254) : null;
  await users.updateOne({ _id: id }, {
    $set: { provider, provider_id: profile.id, name, email, last_login: now },
    $setOnInsert: { created_at: now },
  }, { upsert: true });
  return { id };
}

async function getMongoUser(users, id) {
  const user = await users.findOne({ _id: id }, { projection: { provider: 1, provider_id: 1, name: 1, email: 1 } });
  if (!user) return null;
  return { id: user._id, provider: user.provider, provider_id: user.provider_id, name: user.name, email: user.email };
}

module.exports = { MongoSessionStore, connectMongo, initializeMongo, saveMongoUser, getMongoUser };
