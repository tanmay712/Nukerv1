'use strict';

// Public-address lookups only. The server never accepts private keys or signing shares.
const { rateLimit } = require('express-rate-limit');
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ENDPOINT = 'https://solana-devnet.gateway.tatum.io/';

function validAddress(address) {
  if (typeof address !== 'string' || address.length < 32 || address.length > 44) return false;
  let value = 0n;
  for (const char of address) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return false;
    value = value * 58n + BigInt(digit);
  }
  let bytes = 0;
  for (let n = value; n > 0n; n >>= 8n) bytes++;
  const zeros = address.match(/^1*/)[0].length;
  return zeros + bytes === 32;
}

function formatSol(lamports) {
  const n = BigInt(lamports);
  const whole = n / 1000000000n;
  const fraction = (n % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

function registerSolanaDevnetRoutes({ app, requireUser, csrf }) {
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
  app.post('/api/devnet/solana/balance', requireUser, csrf, limiter, async (req, res) => {
    if (!validAddress(req.body?.address) || Object.keys(req.body || {}).some(key => key !== 'address')) {
      return res.status(400).json({ error: 'Enter a valid Solana public address only. Never enter a private key or recovery phrase.' });
    }
    if (!process.env.TATUM_API_KEY) return res.status(503).json({ error: 'The Solana devnet connection is not configured.' });
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.TATUM_API_KEY },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [req.body.address, { commitment: 'confirmed' }] }),
        signal: AbortSignal.timeout(10000), redirect: 'error',
      });
      if (!response.ok) throw new Error('RPC unavailable');
      const data = await response.json();
      const lamports = data?.result?.value;
      if (data?.jsonrpc !== '2.0' || data.id !== 1 || data.error || !Number.isSafeInteger(lamports) || lamports < 0) throw new Error('Invalid RPC response');
      res.json({ network: 'Solana devnet', address: req.body.address, balanceSol: formatSol(lamports) });
    } catch (_) { res.status(502).json({ error: 'Unable to retrieve the devnet balance. Try again later.' }); }
  });
}
module.exports = { validAddress, formatSol, registerSolanaDevnetRoutes };
