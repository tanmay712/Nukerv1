'use strict';

// Mongo-backed application routes. All multi-document giveaway mutations require
// replica-set transactions; no prize or customer funds are transferred.
const crypto = require('node:crypto');

function registerGiveawayRoutes({ app, client, giveaways, entries, users, notifications, outbox, mail, requireUser, requireOwner, csrf, giveawayLimiter }) {
  const publicGiveaway = (g, entered) => ({ id: g._id, title: g.title, prize: g.prize, terms: g.terms, ends_at: g.ends_at, state: g.state, entries: g.entry_count, entered, won: false });
  async function transaction(fn) {
    const session = client.startSession();
    try { return await session.withTransaction(() => fn(session)); }
    finally { await session.endSession(); }
  }
  const conflict = (message) => Object.assign(new Error(message), { status: 409 });

  app.get('/api/giveaways', requireUser, async (req, res) => {
    const list = await giveaways.find({}).sort({ created_at: -1 }).limit(100).toArray();
    const ids = list.map(g => g._id);
    const mine = await entries.find({ giveaway_id: { $in: ids }, user_id: req.user.id }).toArray();
    const entered = new Set(mine.map(e => e.giveaway_id));
    res.json({ giveaways: list.map(g => ({ ...publicGiveaway(g, entered.has(g._id)), won: g.winner_id === req.user.id })) });
  });

  app.post('/api/giveaways/:id/enter', requireUser, csrf, giveawayLimiter, async (req, res) => {
    try {
      await transaction(async (session) => {
        const now = Date.now();
        const result = await giveaways.updateOne({ _id: req.params.id, state: 'open', ends_at: { $gt: now } }, { $inc: { entry_count: 1 } }, { session });
        if (!result.matchedCount) {
          const exists = await giveaways.findOne({ _id: req.params.id }, { session });
          if (!exists) throw Object.assign(new Error('Giveaway not found.'), { status: 404 });
          throw conflict('Entries are closed.');
        }
        await entries.insertOne({ giveaway_id: req.params.id, user_id: req.user.id, created_at: now }, { session });
      });
      res.status(201).json({ ok: true });
    } catch (error) {
      if (error.code === 11000) return res.status(409).json({ error: 'You have already entered.' });
      if (error.status) return res.status(error.status).json({ error: error.message });
      throw error;
    }
  });

  app.get('/api/notifications', requireUser, async (req, res) => {
    const list = await notifications.find({ user_id: req.user.id }).sort({ created_at: -1 }).limit(100).toArray();
    res.json({ notifications: list.map(n => ({ id: n._id, message: n.message, created_at: n.created_at, read_at: n.read_at ?? null })) });
  });
  app.post('/api/notifications/:id/read', requireUser, csrf, async (req, res) => {
    const notice = await notifications.findOne({ _id: req.params.id, user_id: req.user.id });
    if (!notice) return res.status(404).json({ error: 'Notification not found.' });
    await notifications.updateOne({ _id: req.params.id, user_id: req.user.id, read_at: null }, { $set: { read_at: Date.now() } });
    res.json({ ok: true });
  });
  app.get('/api/admin/giveaways', requireUser, requireOwner, async (_req, res) => {
    const list = await giveaways.find({}).sort({ created_at: -1 }).limit(100).toArray();
    const winners = await users.find({ _id: { $in: list.map(g => g.winner_id).filter(Boolean) } }, { projection: { name: 1 } }).toArray();
    const names = new Map(winners.map(w => [w._id, w.name]));
    res.json({ giveaways: list.map(g => ({ ...publicGiveaway(g, false), winner_name: names.get(g.winner_id) || null })) });
  });
  app.post('/api/admin/giveaways', requireUser, requireOwner, csrf, giveawayLimiter, async (req, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const prize = typeof req.body?.prize === 'string' ? req.body.prize.trim() : '';
    const terms = typeof req.body?.terms === 'string' ? req.body.terms.trim() : '';
    const endsAt = typeof req.body?.endsAt === 'string' ? Date.parse(req.body.endsAt) : NaN;
    if (title.length < 3 || title.length > 100 || !/^(?:0|[1-9]\d{0,5})(?:\.\d{1,8})?$/.test(prize) || Number(prize) <= 0 || terms.length < 10 || terms.length > 1000 || !Number.isFinite(endsAt) || endsAt <= Date.now() || endsAt > Date.now() + 366 * 86400000) return res.status(400).json({ error: 'Provide a title, positive LTC prize, eligibility terms, and a future closing date within one year.' });
    const id = crypto.randomUUID();
    await giveaways.insertOne({ _id: id, title, prize, terms, ends_at: endsAt, state: 'open', created_at: Date.now(), winner_id: null, entry_count: 0 });
    res.status(201).json({ id });
  });
  app.post('/api/admin/giveaways/:id/cancel', requireUser, requireOwner, csrf, giveawayLimiter, async (req, res) => {
    const result = await giveaways.updateOne({ _id: req.params.id, state: 'open' }, { $set: { state: 'cancelled' } });
    if (!result.matchedCount) return res.status(409).json({ error: 'Giveaway cannot be cancelled.' });
    res.json({ ok: true });
  });
  app.post('/api/admin/giveaways/:id/draw', requireUser, requireOwner, csrf, giveawayLimiter, async (req, res) => {
    try {
      const emailQueued = await transaction(async (session) => {
        const g = await giveaways.findOne({ _id: req.params.id }, { session });
        if (!g || g.state !== 'open' || g.ends_at > Date.now()) throw conflict('The giveaway must be open and past its closing time.');
        if (!g.entry_count) throw conflict('There are no entries to draw from.');
        const entry = await entries.find({ giveaway_id: g._id }, { session }).sort({ user_id: 1 }).skip(crypto.randomInt(g.entry_count)).limit(1).next();
        if (!entry) throw new Error('Giveaway entries are inconsistent');
        const winner = await users.findOne({ _id: entry.user_id }, { session });
        if (!winner) throw new Error('Giveaway winner not found');
        const message = `You were selected for ${g.title}: ${g.prize} LTC. Prize fulfillment is pending; no payment has been sent.`;
        const result = await giveaways.updateOne({ _id: g._id, state: 'open', ends_at: { $lte: Date.now() } }, { $set: { state: 'drawn', winner_id: winner._id } }, { session });
        if (!result.matchedCount) throw conflict('Giveaway cannot be drawn.');
        await notifications.insertOne({ _id: crypto.randomUUID(), user_id: winner._id, message, created_at: Date.now(), read_at: null }, { session });
        const hasEmail = mail.isEmail(winner.email);
        if (hasEmail) await outbox.insertOne({ _id: crypto.randomUUID(), recipient: winner.email, subject: 'Cryply giveaway result', body: `${message}\n\nSign in to your dashboard for details.\n`, state: 'pending', attempts: 0, next_attempt: Date.now(), updated_at: Date.now() }, { session });
        return hasEmail;
      });
      if (emailQueued) processEmailQueue().catch(() => console.error('Giveaway email queue failed.'));
      res.json({ ok: true, payout: 'pending', emailQueued });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      throw error;
    }
  });

  let processingEmail = false;
  async function processEmailQueue() {
    if (processingEmail || !mail.mailConfigured()) return;
    processingEmail = true;
    try {
      await outbox.updateMany({ state: 'sending', updated_at: { $lt: Date.now() - 300000 } }, { $set: { state: 'pending' } });
      for (let i = 0; i < 20; i++) {
        const claimId = crypto.randomUUID();
        const item = await outbox.findOneAndUpdate({ state: 'pending', next_attempt: { $lte: Date.now() } }, { $set: { state: 'sending', updated_at: Date.now(), claim_id: claimId } }, { sort: { next_attempt: 1 }, returnDocument: 'after' });
        if (!item) break;
        try {
          await mail.sendMail(item.recipient, item.subject, item.body);
          await outbox.updateOne({ _id: item._id, state: 'sending', claim_id: claimId }, { $set: { state: 'sent', updated_at: Date.now() }, $unset: { claim_id: '' } });
        } catch (_) {
          const attempts = item.attempts + 1;
          await outbox.updateOne({ _id: item._id, state: 'sending', claim_id: claimId }, { $set: { state: 'pending', attempts, next_attempt: Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(attempts - 1, 6)), updated_at: Date.now() }, $unset: { claim_id: '' } });
          console.error('Giveaway notification email failed; it will be retried.');
        }
      }
    } finally { processingEmail = false; }
  }
  return { processEmailQueue };
}
module.exports = { registerGiveawayRoutes };
