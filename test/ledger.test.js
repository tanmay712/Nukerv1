'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { initializeLedger, recordPrototypeEntry, balanceAtoms } = require('../ledger');

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users VALUES ('discord:alice'), ('google:bob');");
  initializeLedger(db);
  return db;
}
function entry(overrides = {}) {
  return { userId: 'discord:alice', asset: 'LTC', direction: 'credit', atoms: '100000000', idempotencyKey: 'test:1', ...overrides };
}

test('prototype journal stores exact atomic-unit amounts and balanced entries', () => {
  const db = setup();
  try {
    const result = recordPrototypeEntry(db, entry({ atoms: '900719925474099312345' }));
    assert.equal(balanceAtoms(db, 'discord:alice'), 900719925474099312345n);
    assert.equal(balanceAtoms(db, 'google:bob'), 0n);
    const lines = db.prepare('SELECT account, delta_atoms FROM prototype_ledger_entries WHERE event_id = ?').all(result.id);
    assert.equal(lines.length, 2);
    assert.equal(lines.reduce((sum, line) => sum + BigInt(line.delta_atoms), 0n), 0n);
    assert.deepEqual(new Set(lines.map(line => line.account)), new Set(['customer', 'clearing']));
  } finally { db.close(); }
});

test('retries are idempotent and conflicting reuse is rejected without side effects', () => {
  const db = setup();
  try {
    const first = recordPrototypeEntry(db, entry());
    const retry = recordPrototypeEntry(db, entry());
    assert.equal(retry.id, first.id); assert.equal(retry.duplicate, true);
    for (const changed of [{ atoms: '5' }, { userId: 'google:bob' }, { direction: 'debit' }]) {
      assert.throws(() => recordPrototypeEntry(db, entry(changed)), /Idempotency key conflict/);
    }
    assert.equal(db.prepare('SELECT count(*) AS n FROM prototype_ledger_events').get().n, 1);
    assert.equal(balanceAtoms(db, 'discord:alice'), 100000000n);
  } finally { db.close(); }
});

test('debits cannot exceed individual balances and failed writes roll back atomically', () => {
  const db = setup();
  try {
    recordPrototypeEntry(db, entry());
    assert.throws(() => recordPrototypeEntry(db, entry({ direction: 'debit', atoms: '100000001', idempotencyKey: 'test:2' })), /Insufficient balance/);
    assert.throws(() => recordPrototypeEntry(db, entry({ userId: 'google:bob', direction: 'debit', atoms: '1', idempotencyKey: 'test:3' })), /Insufficient balance/);
    recordPrototypeEntry(db, entry({ direction: 'debit', atoms: '1', idempotencyKey: 'test:4' }));
    assert.equal(balanceAtoms(db, 'discord:alice'), 99999999n);
    assert.equal(db.prepare('SELECT count(*) AS n FROM prototype_ledger_events').get().n, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM prototype_ledger_entries').get().n, 4);
  } finally { db.close(); }
});

test('invalid amounts, assets, users and idempotency keys are rejected', () => {
  const db = setup();
  try {
    for (const atoms of ['0', '-1', '1.1', '01', '1e3', '', '9'.repeat(31), 1]) assert.throws(() => recordPrototypeEntry(db, entry({ atoms })));
    for (const overrides of [{ asset: 'SOL' }, { asset: 'USDT' }, { userId: 'missing' }, { direction: 'transfer' }, { idempotencyKey: '' }]) assert.throws(() => recordPrototypeEntry(db, entry(overrides)));
    assert.equal(db.prepare('SELECT count(*) AS n FROM prototype_ledger_events').get().n, 0);
  } finally { db.close(); }
});

test('journal entries are append-only and failures cannot leave a partial posting', () => {
  const db = setup();
  try {
    const { id } = recordPrototypeEntry(db, entry());
    assert.throws(() => db.prepare('UPDATE prototype_ledger_events SET atoms = ? WHERE id = ?').run('9', id), /immutable/);
    assert.throws(() => db.prepare('DELETE FROM prototype_ledger_events WHERE id = ?').run(id), /immutable/);
    assert.throws(() => db.prepare('UPDATE prototype_ledger_entries SET delta_atoms = ? WHERE event_id = ?').run('9', id), /immutable/);
    assert.throws(() => db.prepare('DELETE FROM prototype_ledger_entries WHERE event_id = ?').run(id), /immutable/);
    db.exec("CREATE TRIGGER fail_second_entry BEFORE INSERT ON prototype_ledger_entries WHEN NEW.account = 'clearing' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;");
    assert.throws(() => recordPrototypeEntry(db, entry({ idempotencyKey: 'test:failure' })), /simulated failure/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM prototype_ledger_events').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM prototype_ledger_entries').get().n, 2);
    assert.equal(balanceAtoms(db, 'discord:alice'), 100000000n);
  } finally { db.close(); }
});

test('idempotency and journal survive a database reopen', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cryply-ledger-'));
  const file = path.join(dir, 'ledger.sqlite');
  let db;
  try {
    db = new DatabaseSync(file);
    db.exec("CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users VALUES ('discord:alice');");
    initializeLedger(db);
    const original = recordPrototypeEntry(db, entry());
    db.close();
    db = new DatabaseSync(file);
    initializeLedger(db);
    const retry = recordPrototypeEntry(db, entry());
    assert.equal(retry.id, original.id);
    assert.equal(retry.duplicate, true);
    assert.equal(balanceAtoms(db, 'discord:alice'), 100000000n);
  } finally {
    if (db?.isOpen) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a locked database cannot leave a partial write and may be safely retried', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cryply-lock-'));
  const file = path.join(dir, 'ledger.sqlite');
  let first, second;
  try {
    first = new DatabaseSync(file);
    first.exec("CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users VALUES ('discord:alice');");
    initializeLedger(first);
    second = new DatabaseSync(file);
    second.exec('PRAGMA busy_timeout = 0');
    first.exec('BEGIN IMMEDIATE');
    assert.throws(() => recordPrototypeEntry(second, entry()), /locked/);
    first.exec('COMMIT');
    const result = recordPrototypeEntry(second, entry());
    assert.equal(result.duplicate, false);
    assert.equal(balanceAtoms(second, 'discord:alice'), 100000000n);
    assert.equal(second.prepare('SELECT count(*) AS n FROM prototype_ledger_entries').get().n, 2);
  } finally {
    if (second?.isOpen) second.close();
    if (first?.isOpen) first.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
