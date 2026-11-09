'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { readSqlite, toMongo } = require('../scripts/migrate-sqlite-to-mongo');

test('SQLite migration reads a snapshot and maps application data without copying sessions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cryply-migrate-'));
  const file = path.join(dir, 'wallet.sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE users(id TEXT, provider TEXT, provider_id TEXT, name TEXT, email TEXT, created_at TEXT, last_login TEXT);
      CREATE TABLE settings(key TEXT, value TEXT);
      CREATE TABLE giveaways(id TEXT, title TEXT, prize TEXT, terms TEXT, ends_at INTEGER, state TEXT, created_at INTEGER, winner_id TEXT);
      CREATE TABLE giveaway_entries(giveaway_id TEXT, user_id TEXT, created_at INTEGER);
      CREATE TABLE notifications(id TEXT, user_id TEXT, message TEXT, created_at INTEGER, read_at INTEGER);
      CREATE TABLE email_outbox(id TEXT, recipient TEXT, subject TEXT, body TEXT, state TEXT, attempts INTEGER, next_attempt INTEGER, updated_at INTEGER);
      CREATE TABLE sessions(sid TEXT, data TEXT, expires INTEGER);
      CREATE TABLE user_watchlist(user_id TEXT, symbol TEXT);
      INSERT INTO user_watchlist VALUES('google:1','SOL');
      INSERT INTO users VALUES('google:1','google','1','Alice',NULL,'date','date');
      INSERT INTO settings VALUES('support_email','support@example.test');
      INSERT INTO giveaways VALUES('g','Prize','1','Free entry',100,'open',1,NULL);
      INSERT INTO giveaway_entries VALUES('g','google:1',1);
      INSERT INTO notifications VALUES('n','google:1','Message',1,NULL);
      INSERT INTO email_outbox VALUES('m','alice@example.test','Subject','Body','sending',2,1,1);
      INSERT INTO sessions VALUES('s','{"secret":"never copy"}',1);`);
    db.close();
    const data = await readSqlite(file);
    const converted = toMongo(data);
    assert.equal(converted.users[0]._id, 'google:1');
    assert.deepEqual(converted.users[0].watchlist, ['SOL']);
    assert.equal(converted.giveaways[0].entry_count, 1);
    assert.equal(converted.settings[0].supportEmail, 'support@example.test');
    assert.equal(converted.notifications[0]._id, 'n');
    assert.equal(converted.email_outbox[0].state, 'pending');
    assert.equal(converted.sessions, undefined);
    assert.doesNotMatch(JSON.stringify(converted), /never copy/);
    assert.equal(fs.existsSync(file), true);
    const oldDb = new DatabaseSync(file); oldDb.exec('DROP TABLE user_watchlist'); oldDb.close();
    assert.deepEqual((await readSqlite(file)).watchlist, []);

    await assert.rejects(readSqlite(path.join(dir, 'missing.sqlite')), /existing SQLite file/);
  } finally { try { db.close(); } catch (_) {} fs.rmSync(dir, { recursive:true, force:true }); }
});

test('Render fails closed when MongoDB is missing or invalid', () => {
  for (const uri of ['', 'invalid-secret-uri']) {
    const result = spawnSync(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, RENDER: 'true', MONGODB_URI: uri, ALLOW_EPHEMERAL_SQLITE: '' }, encoding:'utf8', timeout:5000 });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /invalid-secret-uri/);
    assert.doesNotMatch(result.stdout, /listening/);
  }
});
