'use strict';
// Watchlists are preferences, not balances or evidence of asset ownership.
const { rateLimit } = require('express-rate-limit');
const assets = ['SOL', 'LTC', 'USDT'];
function registerWatchlistRoutes({ app, requireUser, csrf, getWatchlist, setWatchlist }) {
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders:'draft-8', legacyHeaders:false });
  app.get('/api/watchlist', requireUser, async (req, res) => {
    const saved = await getWatchlist(req.user.id);
    res.json({ assets:assets.filter(symbol => saved.includes(symbol)) });
  });
  app.post('/api/watchlist/:symbol', requireUser, csrf, limiter, async (req, res) => {
    const { symbol } = req.params;
    if (!assets.includes(symbol) || !req.body || Array.isArray(req.body) || Object.keys(req.body).length !== 1 || typeof req.body.saved !== 'boolean') return res.status(400).json({ error:'Invalid watchlist selection.' });
    await setWatchlist(req.user.id, symbol, req.body.saved);
    res.json({ symbol, saved:req.body.saved });
  });
}
module.exports = { registerWatchlistRoutes };
