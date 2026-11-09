'use strict';
const { MongoClient } = require('mongodb');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const client = new MongoClient('mongodb://127.0.0.1:27017/?directConnection=true', { serverSelectionTimeoutMS: 2000 });
  try {
    for (let i = 0; ; i++) {
      try { await client.connect(); break; }
      catch (err) { if (i >= 29) throw err; await delay(1000); }
    }
    await client.db('admin').command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27017' }] } });
    for (let i = 0; ; i++) {
      const hello = await client.db('admin').command({ hello: 1 });
      if (hello.isWritablePrimary) break;
      if (i >= 59) throw new Error('Replica set did not become primary');
      await delay(1000);
    }
  } finally { await client.close(); }
}
main().catch(err => { console.error(err.message); process.exitCode = 1; });
