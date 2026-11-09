'use strict';
require('dotenv').config({ quiet: true });
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { connectMongo } = require('../mongo-foundation');

// Run only with both app instances stopped, against a fresh dedicated database.
async function readSqlite(file) {
  if (!file || file === ':memory:' || !fs.existsSync(file)) throw new Error('Provide an existing SQLite file via SQLITE_MIGRATION_PATH');
  const source = new DatabaseSync(path.resolve(file), { readOnly: true });
  try {
    source.exec('BEGIN');
    const read = (table) => source.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row }));
    const data = { users: read('users'), settings: read('settings'), giveaways: read('giveaways'), entries: read('giveaway_entries'), notifications: read('notifications'), outbox: read('email_outbox') };
    source.exec('COMMIT');
    return data;
  } finally { source.close(); }
}
function toMongo(data) {
  const counts = new Map();
  for (const entry of data.entries) counts.set(entry.giveaway_id, (counts.get(entry.giveaway_id) || 0) + 1);
  const settings = Object.fromEntries(data.settings.map(s => [s.key, s.value]));
  return {
    users: data.users.map(({ id, ...row }) => ({ _id: id, ...row })),
    settings: [{ _id: 'workspace', supportEmail: settings.support_email || '', notificationEmail: settings.notification_email || '' }],
    giveaways: data.giveaways.map(({ id, ...row }) => ({ _id: id, ...row, entry_count: counts.get(id) || 0 })),
    giveaway_entries: data.entries,
    notifications: data.notifications.map(({ id, ...row }) => ({ _id: id, ...row })),
    email_outbox: data.outbox.map(({ id, ...row }) => ({ _id: id, ...row, state: row.state === 'sending' ? 'pending' : row.state })),
  };
}
async function migrate(client, db, data) {
  const documents = toMongo(data);
  const names = [...Object.keys(documents), 'sessions'];
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      for (const name of names) {
        if (await db.collection(name).countDocuments({}, { limit: 1, session })) throw new Error('Destination database is not empty');
      }
      for (const [name, rows] of Object.entries(documents)) {
        if (rows.length) await db.collection(name).insertMany(rows, { session, ordered: true });
      }
    });
  } finally { await session.endSession(); }
  return Object.fromEntries(Object.entries(documents).map(([name, rows]) => [name, rows.length]));
}
async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  const data = await readSqlite(process.env.SQLITE_MIGRATION_PATH);
  const connection = await connectMongo(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME || 'cryply');
  try {
    const hello = await connection.client.db('admin').command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('MongoDB must support replica-set transactions');
    const counts = await migrate(connection.client, connection.db, data);
    console.log('Migration complete. Imported counts:', counts);
    console.log('Sessions were not copied; users must sign in again. The SQLite file was not modified.');
  } finally { await connection.client.close(); }
}
if (require.main === module) main().catch(() => { console.error('Migration failed. Check the source, destination permissions, transaction support, and whether the destination is empty.'); process.exitCode = 1; });
module.exports = { readSqlite, toMongo, migrate };
