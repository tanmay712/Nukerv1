'use strict';
require('dotenv').config({ quiet: true });

async function startMongo() {
  const { connectMongo } = require('./mongo-foundation');
  const { createMongoApp } = require('./mongo-app');
  const connection = await connectMongo(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME || 'cryply');
  try {
    // Transactions protect giveaway entries, draws, and notifications from partial writes.
    const hello = await connection.client.db('admin').command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('MongoDB must support replica-set transactions');
    const { app, processEmailQueue } = await createMongoApp(connection);
    const port = Number(process.env.PORT || 6546);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
    app.listen(port, '0.0.0.0', () => console.log(`Cryply listening on port ${port}`));
    processEmailQueue().catch(() => console.error('Giveaway email queue failed.'));
    setInterval(() => processEmailQueue().catch(() => console.error('Giveaway email queue failed.')), 60000).unref();
  } catch (error) {
    await connection.client.close();
    throw error;
  }
}

if (require.main === module) {
  if (process.env.MONGODB_URI) {
    startMongo().catch(() => { console.error('MongoDB startup failed. Check server configuration, permissions, connectivity and replica-set support.'); process.exitCode = 1; });
  } else if (process.env.RENDER && process.env.ALLOW_EPHEMERAL_SQLITE !== '1') {
    console.error('MONGODB_URI is required on Render; refusing to start with ephemeral SQLite.');
    process.exitCode = 1;
  } else {
    require('./sqlite-server').startServer();
  }
} else {
  // Retain the existing local SQLite test/development interface.
  module.exports = require('./sqlite-server');
}
