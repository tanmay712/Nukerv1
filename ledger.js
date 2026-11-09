'use strict';

// Experimental journal only. This module is intentionally not connected to HTTP,
// Coinbase, or the app database. It must not be used for customer funds.
const crypto = require('node:crypto');

const MAX_ATOMS = 10n ** 30n - 1n;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;

function initializeLedger(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS prototype_ledger_events (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id),
      asset TEXT NOT NULL CHECK (asset = 'LTC'),
      direction TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
      atoms TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS prototype_ledger_entries (
      event_id TEXT NOT NULL REFERENCES prototype_ledger_events(id),
      account TEXT NOT NULL CHECK (account IN ('customer', 'clearing')),
      delta_atoms TEXT NOT NULL,
      PRIMARY KEY (event_id, account)
    );
    CREATE INDEX IF NOT EXISTS prototype_ledger_user_history
      ON prototype_ledger_events(user_id, created_at, id);
    CREATE TRIGGER IF NOT EXISTS prototype_ledger_events_no_update
      BEFORE UPDATE ON prototype_ledger_events BEGIN SELECT RAISE(ABORT, 'ledger events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS prototype_ledger_events_no_delete
      BEFORE DELETE ON prototype_ledger_events BEGIN SELECT RAISE(ABORT, 'ledger events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS prototype_ledger_entries_no_update
      BEFORE UPDATE ON prototype_ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS prototype_ledger_entries_no_delete
      BEFORE DELETE ON prototype_ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;
  `);
}

function validate({ userId, asset, direction, atoms, idempotencyKey }) {
  if (typeof userId !== 'string' || !idPattern.test(userId)) throw new Error('Invalid user ID');
  if (typeof idempotencyKey !== 'string' || !idPattern.test(idempotencyKey)) throw new Error('Invalid idempotency key');
  if (asset !== 'LTC') throw new Error('Only prototype LTC entries are supported');
  if (!['credit', 'debit'].includes(direction)) throw new Error('Invalid direction');
  // Require canonical string integers. Never accept floating-point amounts.
  if (typeof atoms !== 'string' || !/^[1-9][0-9]{0,29}$/.test(atoms) || BigInt(atoms) > MAX_ATOMS) throw new Error('Invalid amount in atomic units');
}

function balanceAtoms(db, userId, asset = 'LTC') {
  if (typeof userId !== 'string' || !idPattern.test(userId) || asset !== 'LTC') throw new Error('Invalid account');
  const entries = db.prepare(`SELECT e.delta_atoms FROM prototype_ledger_entries e
    JOIN prototype_ledger_events j ON j.id = e.event_id
    WHERE j.user_id = ? AND j.asset = ? AND e.account = 'customer'`).all(userId, asset);
  // SQLite's SUM() coerces decimal strings to numbers. Sum with BigInt instead.
  return entries.reduce((total, entry) => total + BigInt(entry.delta_atoms), 0n);
}

function recordPrototypeEntry(db, input) {
  validate(input);
  const { userId, asset, direction, atoms, idempotencyKey } = input;
  const amount = BigInt(atoms);
  db.exec('BEGIN IMMEDIATE');
  try {
    const prior = db.prepare('SELECT * FROM prototype_ledger_events WHERE idempotency_key = ?').get(idempotencyKey);
    if (prior) {
      if (prior.user_id !== userId || prior.asset !== asset || prior.direction !== direction || prior.atoms !== atoms) throw new Error('Idempotency key conflict');
      db.exec('COMMIT');
      return { id: prior.id, duplicate: true };
    }
    if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) throw new Error('Unknown user');
    const existing = balanceAtoms(db, userId, asset);
    if (direction === 'debit' && existing < amount) throw new Error('Insufficient balance');
    if (direction === 'credit' && existing + amount > MAX_ATOMS) throw new Error('Balance exceeds prototype limit');
    const delta = direction === 'credit' ? amount : -amount;
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO prototype_ledger_events (id, idempotency_key, user_id, asset, direction, atoms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, idempotencyKey, userId, asset, direction, atoms, Date.now());
    const insert = db.prepare('INSERT INTO prototype_ledger_entries (event_id, account, delta_atoms) VALUES (?, ?, ?)');
    insert.run(id, 'customer', delta.toString());
    insert.run(id, 'clearing', (-delta).toString());
    db.exec('COMMIT');
    return { id, duplicate: false };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { initializeLedger, recordPrototypeEntry, balanceAtoms };
