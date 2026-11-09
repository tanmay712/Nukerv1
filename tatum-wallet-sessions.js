'use strict';
// Experimental and disabled by default. No wallet shares or provider keys are stored here.
const { rateLimit } = require('express-rate-limit');

function registerTatumWalletSessionRoutes({ app, collection, requireUser, csrf, sdkFactory }) {
  const enabled = () => process.env.ENABLE_EXPERIMENTAL_TATUM_DEVNET === '1' && Boolean(process.env.TATUM_API_KEY);
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
  const getSdk = sdkFactory || (async () => {
    const { TatumWalletsSdk } = await import('@tatumio/wallet-sdk');
    return new TatumWalletsSdk({ apiKey: process.env.TATUM_API_KEY });
  });
  app.get('/api/devnet/wallet/status', requireUser, async (req, res) => {
    if (!enabled()) return res.json({ enabled: false });
    const record = await collection.findOne({ _id: req.user.id });
    res.json({ enabled: true, state: record?.state || 'new' });
  });
  // Permanent claim: after an interrupted or ambiguous generation, do not try
  // to generate a second wallet automatically, even from another browser tab.
  app.post('/api/devnet/wallet/begin', requireUser, csrf, limiter, async (req, res) => {
    if (!enabled()) return res.status(503).json({ error:'Experimental test wallets are disabled.' });
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length) return res.status(400).json({ error:'This request must not contain wallet secrets.' });
    const record = await collection.findOneAndUpdate({ _id:req.user.id, state:'ready', generation:{ $exists:false } }, { $set:{ generation:'claimed' } }, { returnDocument:'after' });
    if (!record) return res.status(409).json({ error:'Wallet generation was already started or needs review. Do not retry; contact support.' });
    return res.json({ ok:true });
  });
  app.post('/api/devnet/wallet/session', requireUser, csrf, limiter, async (req, res) => {
    if (!enabled()) return res.status(503).json({ error: 'Experimental test wallets are disabled.' });
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length) return res.status(400).json({ error: 'This request must not contain wallet secrets.' });
    try {
      const sdk = await getSdk();
      let record = await collection.findOne({ _id: req.user.id });
      if (!record) {
        try {
          await collection.insertOne({ _id: req.user.id, state:'creating', createdAt:new Date() });
        } catch (error) {
          if (error.code === 11000) return res.status(409).json({ error: 'Wallet setup is already in progress. Try again shortly.' });
          throw error;
        }
        // Never retry a failed/ambiguous creation automatically: the provider may
        // have created a client even when our request timed out or was interrupted.
        let created;
        try {
          created = await sdk.custodian.createClient({ body:{ isAccountAbstracted:false }, signal:AbortSignal.timeout(15000) });
          if (typeof created?.id !== 'string' || !created.id || created.id.length > 256) throw new Error('Invalid response');
          const update = await collection.updateOne({ _id:req.user.id, state:'creating' }, { $set:{ state:'ready', clientId:created.id } });
          if (update.matchedCount !== 1) throw new Error('Wallet state changed');
        } catch (_) {
          await collection.updateOne({ _id:req.user.id, state:'creating' }, { $set:{ state:'needs_review' } }).catch(() => {});
          return res.status(503).json({ error: 'Wallet setup could not be confirmed. Do not retry; contact support.' });
        }
        record = { state:'ready', clientId:created.id };
      }
      if (record.state !== 'ready' || typeof record.clientId !== 'string') return res.status(409).json({ error:'Wallet setup needs review. Do not retry; contact support.' });
      const session = await sdk.custodian.createClientSession({ path:{ clientId:record.clientId }, body:{ isAccountAbstracted:false }, signal:AbortSignal.timeout(15000) });
      if (typeof session?.clientSessionToken !== 'string' || !session.clientSessionToken) throw new Error('Invalid response');
      res.json({ clientId:record.clientId, token:session.clientSessionToken });
    } catch (_) { res.status(502).json({ error:'Unable to open a test wallet session. Try again later.' }); }
  });
}
module.exports = { registerTatumWalletSessionRoutes };
