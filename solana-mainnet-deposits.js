'use strict';

// Tatum mainnet receive-address enrollment and deposit activity for SOL,
// Litecoin, and USDT on Polygon PoS. This records chain events for display only;
// it never credits an app balance and never signs or submits transactions.
const { rateLimit } = require('express-rate-limit');
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const RPC_URL = 'https://solana-mainnet.gateway.tatum.io/';
const LITECOIN_RPC_URL = 'https://litecoin-mainnet.gateway.tatum.io/';
const POLYGON_RPC_URL = 'https://polygon-mainnet.gateway.tatum.io/';
const POLYGON_USDT = '0xc2132D05D31c914a87C6611C10748AaCb4E0FfB8';
const POLYGON_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const PAGE_SIZE = 100;
const MAX_PAGES_PER_SCAN = 20;
const POLYGON_CONFIRMATIONS = 128;
const LITECOIN_CONFIRMATIONS = 6;
const MAX_POLYGON_BLOCKS_PER_SCAN = 20000;
const MAX_LITECOIN_BLOCKS_PER_SCAN = 12;

function validSolanaAddress(address) {
  if (typeof address !== 'string' || address.length < 32 || address.length > 44) return false;
  let value = 0n;
  for (const char of address) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return false;
    value = value * 58n + BigInt(digit);
  }
  let bytes = 0;
  for (let n = value; n > 0n; n >>= 8n) bytes++;
  return address.match(/^1*/)[0].length + bytes === 32;
}

function validEvmAddress(address) { return typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address); }
function validLitecoinAddress(address) {
  return typeof address === 'string' && address.length >= 26 && address.length <= 90 &&
    (/^ltc1[ac-hj-np-z02-9]+$/i.test(address) || /^[LM3][1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address));
}
function getNamespaceAddress(details, names) {
  for (const name of names) {
    const address = details?.metadata?.namespaces?.[name]?.address;
    if (typeof address === 'string') return address;
  }
  return null;
}
function formatUnits(atoms, decimals) {
  if (typeof atoms !== 'string' || !/^\d+$/.test(atoms) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('Invalid atomic-unit amount');
  const n = BigInt(atoms), divisor = 10n ** BigInt(decimals);
  const whole = n / divisor;
  const fraction = (n % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
function decimalToAtoms(value, decimals) {
  if (typeof value !== 'string' || !new RegExp(`^(?:0|[1-9]\\d*)(?:\\.\\d{1,${decimals}})?$`).test(value)) throw new Error('Invalid decimal chain amount');
  const [whole, fraction = ''] = value.split('.');
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')).toString();
}

function formatSol(lamports) {
  if (typeof lamports !== 'string' || !/^\d+$/.test(lamports)) throw new Error('Invalid lamport amount');
  const amount = BigInt(lamports);
  const whole = amount / 1_000_000_000n;
  const fraction = (amount % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function incomingLamports(transaction, address) {
  if (!transaction || transaction.meta?.err || !Array.isArray(transaction.meta?.preBalances) || !Array.isArray(transaction.meta?.postBalances)) return null;
  const keys = transaction.transaction?.message?.accountKeys;
  if (!Array.isArray(keys)) return null;
  const index = keys.findIndex((key) => (typeof key === 'string' ? key : key?.pubkey?.toString?.() || key?.pubkey) === address);
  if (index < 0 || index >= transaction.meta.preBalances.length || index >= transaction.meta.postBalances.length) return null;
  const before = transaction.meta.preBalances[index], after = transaction.meta.postBalances[index];
  if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after)) throw new Error('RPC balance exceeds safe integer precision; refusing to record an inexact amount');
  if (after <= before) return null;
  return (BigInt(after) - BigInt(before)).toString();
}

function savedBackupsConfirmed(details) {
  if (!Array.isArray(details?.wallets)) return false;
  return ['ED25519', 'SECP256K1'].every((curve) => {
    const wallet = details.wallets.find((entry) => entry?.curve === curve);
    return Boolean(wallet &&
      wallet.signingSharePairs?.some((pair) => pair?.status === 'STORED_CLIENT') &&
      wallet.backupSharePairs?.some((pair) => pair?.status === 'STORED_CLIENT_BACKUP_SHARE'));
  });
}

function createRpc(apiKey, fetchImpl = fetch, endpoint = RPC_URL) {
  if (!apiKey) throw new Error('Tatum API key is not configured');
  let id = 0;
  return async (method, params) => {
    const currentId = ++id;
    const response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ jsonrpc: '2.0', id: currentId, method, params }),
    });
    if (!response.ok) throw new Error('Blockchain RPC request failed');
    let body;
    if (typeof response.text === 'function') {
      // Litecoin Core reports native-coin outputs as JSON decimals. Preserve
      // their lexical digits before parsing so satoshis are never float-summed.
      const raw = await response.text();
      body = JSON.parse(raw.replace(/("value"\s*:\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, '$1"$2"'));
    } else body = await response.json();
    if (body?.jsonrpc !== '2.0' || body.id !== currentId || body.error || !Object.hasOwn(body, 'result')) throw new Error('Invalid blockchain RPC response');
    return body.result;
  };
}

async function storeDeposit(deposits, row) {
  const key = { chain: row.chain, address: row.address, tx_hash: row.tx_hash, transfer_index: row.transfer_index };
  try { await deposits.updateOne(key, { $setOnInsert: { ...row, created_at: Date.now() } }, { upsert: true }); }
  catch (error) { if (error.code !== 11000) throw error; }
}

async function scanWallet({ wallet, deposits, rpc }) {
  const address = wallet.addresses?.solana || wallet.address;
  if (!validSolanaAddress(address)) throw new Error('Invalid enrolled address');
  let before;
  let cursorFound = !wallet.signatureCursor;
  let exhausted = false;
  let pages = 0;
  let signatures = [];
  while (pages < MAX_PAGES_PER_SCAN) {
    const config = { commitment: 'finalized', limit: PAGE_SIZE };
    if (before) config.before = before;
    const page = await rpc('getSignaturesForAddress', [address, config]);
    if (!Array.isArray(page)) throw new Error('Invalid Solana signature response');
    pages++;
    if (!page.length) { exhausted = true; break; }
    for (const item of page) {
      if (!item || typeof item.signature !== 'string') throw new Error('Invalid Solana signature item');
      if (wallet.signatureCursor && item.signature === wallet.signatureCursor) { cursorFound = true; break; }
      signatures.push(item);
    }
    if (cursorFound) break;
    before = page[page.length - 1].signature;
    if (page.length < PAGE_SIZE) { exhausted = true; break; }
  }

  // Resolve and persist before advancing the cursor. A provider timeout or
  // missing transaction therefore causes a safe retry rather than a lost event.
  for (const item of signatures) {
    if (item.err) continue;
    const tx = await rpc('getTransaction', [item.signature, { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    if (!tx) throw new Error('Finalized transaction is not available yet');
    const lamports = incomingLamports(tx, address);
    if (!lamports) continue;
    const slot = Number.isSafeInteger(item.slot) ? item.slot : (Number.isSafeInteger(tx.slot) ? tx.slot : null);
    const blockTime = Number.isSafeInteger(item.blockTime) ? item.blockTime : (Number.isSafeInteger(tx.blockTime) ? tx.blockTime : null);
    await storeDeposit(deposits, { user_id: wallet.user_id, chain: 'solana', asset: 'SOL', address, tx_hash: item.signature, transfer_index: 0, amount_atoms: lamports, decimals: 9, block_height: slot, block_time: blockTime, state: 'finalized' });
  }
  if (signatures.length) {
    const newest = signatures[0].signature;
    const oldest = signatures[signatures.length - 1].signature;
    // If caught up, anchor at the newest signature. If a bounded catch-up page
    // is still behind the old cursor, move the cursor back in small safe steps.
    const nextCursor = cursorFound || exhausted ? newest : oldest;
    wallet.signatureCursor = nextCursor;
    return nextCursor;
  }
  return wallet.signatureCursor || null;
}

function publicDeposit(row) {
  return { asset: row.asset, chain: row.chain, amount: formatUnits(row.amount_atoms, row.decimals), txHash: row.tx_hash, transferIndex: row.transfer_index, blockHeight: row.block_height, blockTime: row.block_time, state: row.state };
}

function registerSolanaMainnetDepositRoutes({ app, wallets, deposits, requireUser, csrf, sdkFactory, fetchImpl = fetch }) {
  const { scanLitecoin, scanPolygonUsdt, hexNumber } = require('./multi-chain-deposits');
  const enabled = () => (process.env.ENABLE_TATUM_MAINNET_DEPOSITS === '1' || process.env.ENABLE_TATUM_SOLANA_MAINNET_DEPOSITS === '1') && Boolean(process.env.TATUM_API_KEY);
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false });
  const getSdk = sdkFactory || (async () => {
    const { TatumWalletsSdk } = await import('@tatumio/wallet-sdk');
    return new TatumWalletsSdk({ apiKey: process.env.TATUM_API_KEY });
  });
  async function makeSession(userId) {
    const record = await wallets.findOne({ _id: userId });
    if (!record || record.state !== 'ready' || typeof record.clientId !== 'string') throw new Error('Wallet is not ready');
    const sdk = await getSdk();
    const session = await sdk.custodian.createClientSession({ path: { clientId: record.clientId }, body: { isAccountAbstracted: false }, signal: AbortSignal.timeout(15000) });
    if (typeof session?.clientSessionToken !== 'string' || !session.clientSessionToken) throw new Error('Invalid provider session');
    return { record, sdk, token: session.clientSessionToken };
  }
  app.get('/api/mainnet/solana/deposits/status', requireUser, limiter, async (req, res) => {
    if (!enabled()) return res.json({ enabled: false, assets: [] });
    const wallet = await wallets.findOne({ _id: req.user.id });
    const history = await deposits.find({ user_id: req.user.id, state: { $in: ['finalized', 'confirmed'] } }).sort({ block_time: -1, block_height: -1, created_at: -1 }).limit(50).toArray();
    res.json({ enabled: true, state: wallet?.state || 'new', generation: wallet?.generation || null, addresses: wallet?.addresses || null, deposits: history.map(publicDeposit) });
  });
  app.post('/api/mainnet/solana/wallet/session', requireUser, csrf, limiter, async (req, res) => {
    if (!enabled()) return res.status(503).json({ error: 'Solana mainnet deposit tracking is disabled.' });
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length) return res.status(400).json({ error: 'This request must not contain wallet secrets.' });
    let record = await wallets.findOne({ _id: req.user.id });
    if (!record) {
      try { await wallets.insertOne({ _id: req.user.id, state: 'creating', network: 'solana-mainnet', created_at: Date.now() }); }
      catch (error) { if (error.code === 11000) return res.status(409).json({ error: 'Mainnet wallet setup is already in progress.' }); throw error; }
      try {
        const sdk = await getSdk();
        const created = await sdk.custodian.createClient({ body: { isAccountAbstracted: false }, signal: AbortSignal.timeout(15000) });
        if (typeof created?.id !== 'string' || !created.id || created.id.length > 256) throw new Error('Invalid provider response');
        const update = await wallets.updateOne({ _id: req.user.id, state: 'creating' }, { $set: { state: 'ready', clientId: created.id } });
        if (update.matchedCount !== 1) throw new Error('Wallet state changed');
        record = { _id: req.user.id, state: 'ready', clientId: created.id };
      } catch (_) {
        await wallets.updateOne({ _id: req.user.id, state: 'creating' }, { $set: { state: 'needs_review' } }).catch(() => {});
        return res.status(503).json({ error: 'Mainnet wallet setup could not be confirmed. Do not retry; contact support.' });
      }
    }
    if (record.state !== 'ready' || !record.clientId) return res.status(409).json({ error: 'Mainnet wallet setup needs review. Do not retry.' });
    try {
      const sdk = await getSdk();
      const session = await sdk.custodian.createClientSession({ path: { clientId: record.clientId }, body: { isAccountAbstracted: false }, signal: AbortSignal.timeout(15000) });
      if (typeof session?.clientSessionToken !== 'string' || !session.clientSessionToken) throw new Error('Invalid provider session');
      res.json({ clientId: record.clientId, token: session.clientSessionToken });
    } catch (_) { res.status(502).json({ error: 'Unable to open the mainnet wallet session.' }); }
  });
  app.post('/api/mainnet/solana/wallet/begin', requireUser, csrf, limiter, async (req, res) => {
    if (!enabled()) return res.status(503).json({ error: 'Solana mainnet deposit tracking is disabled.' });
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length) return res.status(400).json({ error: 'This request must not contain wallet secrets.' });
    const result = await wallets.updateOne({ _id: req.user.id, state: 'ready', address: { $exists: false }, generation: { $exists: false } }, { $set: { generation: 'claimed', generation_at: Date.now() } });
    if (!result.matchedCount) return res.status(409).json({ error: 'Wallet generation was already started or needs review. Do not retry.' });
    res.json({ ok: true });
  });
  app.post('/api/mainnet/solana/wallet/activate', requireUser, csrf, limiter, async (req, res) => {
    if (!enabled()) return res.status(503).json({ error: 'Solana mainnet deposit tracking is disabled.' });
    const addresses = req.body?.addresses;
    if (!addresses || !validSolanaAddress(addresses.solana) || !validLitecoinAddress(addresses.litecoin) || !validEvmAddress(addresses.polygon)) return res.status(400).json({ error: 'Enter the verified SOL, Litecoin, and Polygon addresses from this Tatum wallet.' });
    const wallet = await wallets.findOne({ _id: req.user.id });
    if (!wallet || wallet.state !== 'ready' || wallet.generation !== 'claimed' || wallet.addresses) return res.status(409).json({ error: 'Wallet is not ready for address activation.' });
    try {
      const { sdk, token, record } = await makeSession(req.user.id);
      const client = sdk.initClient({ token });
      const details = await client.getClientDetails({ signal: AbortSignal.timeout(15000) });
      const providerAddresses = {
        solana: getNamespaceAddress(details, ['solana']),
        litecoin: getNamespaceAddress(details, ['bip122', 'litecoin']),
        polygon: getNamespaceAddress(details, ['eip155', 'polygon']),
      };
      if (details?.id !== record.clientId || providerAddresses.solana !== addresses.solana || providerAddresses.litecoin !== addresses.litecoin || providerAddresses.polygon?.toLowerCase() !== addresses.polygon.toLowerCase()) return res.status(400).json({ error: 'One or more addresses do not match this Tatum wallet.' });
      if (!savedBackupsConfirmed(details)) return res.status(409).json({ error: 'Tatum has not confirmed saved signing and recovery shares for both wallet curves.' });
      const ltcRpc = createRpc(process.env.TATUM_API_KEY, fetchImpl, LITECOIN_RPC_URL);
      const polygonRpc = createRpc(process.env.TATUM_API_KEY, fetchImpl, POLYGON_RPC_URL);
      const [litecoinBlockCursor, polygonBlockCursor] = await Promise.all([ltcRpc('getblockcount', []), polygonRpc('eth_blockNumber', [])]);
      const polygonStart = hexNumber(polygonBlockCursor);
      if (!Number.isSafeInteger(litecoinBlockCursor) || litecoinBlockCursor < 0) throw new Error('Invalid Litecoin chain height');
      const activation = await wallets.updateOne({ _id: req.user.id, state: 'ready', generation: 'claimed', addresses: { $exists: false } }, { $set: { address: addresses.solana, addresses, litecoinBlockCursor, polygonBlockCursor: polygonStart, state: 'active', activated_at: Date.now(), signatureCursor: null } });
      if (!activation.matchedCount) return res.status(409).json({ error: 'Wallet addresses have already been activated.' });
      res.status(201).json({ ok: true, addresses, networks: ['Solana mainnet', 'Litecoin mainnet', 'Polygon PoS USDT'] });
    } catch (_) { res.status(502).json({ error: 'Could not verify wallet addresses or Tatum mainnet access. Do not deposit until setup succeeds.' }); }
  });
  app.get('/api/mainnet/solana/deposits', requireUser, limiter, async (req, res) => {
    if (!enabled()) return res.status(503).json({ error: 'Solana mainnet deposit tracking is disabled.' });
    try {
      const wallet = await wallets.findOne({ _id: req.user.id });
      if (!wallet || wallet.state !== 'active' || !wallet.addresses) return res.json({ deposits: [], scanWarnings: [] });
      const apiKey = process.env.TATUM_API_KEY;
      const scans = [
        ['SOL', () => scanWallet({ wallet, deposits, rpc: createRpc(apiKey, fetchImpl) }), 'signatureCursor'],
        ['LTC', () => scanLitecoin({ wallet, deposits, rpc: createRpc(apiKey, fetchImpl, LITECOIN_RPC_URL) }), 'litecoinBlockCursor'],
        ['USDT Polygon', () => scanPolygonUsdt({ wallet, deposits, rpc: createRpc(apiKey, fetchImpl, POLYGON_RPC_URL) }), 'polygonBlockCursor'],
      ];
      const scanWarnings = [];
      for (const [asset, scan, cursorField] of scans) {
        try {
          await scan();
          await wallets.updateOne({ _id: req.user.id, state: 'active' }, { $set: { [cursorField]: wallet[cursorField], last_scanned_at: Date.now() } });
        } catch (_) { scanWarnings.push(asset); }
      }
      const history = await deposits.find({ user_id: req.user.id, state: { $in: ['finalized', 'confirmed'] } }).sort({ block_time: -1, block_height: -1, created_at: -1 }).limit(50).toArray();
      res.json({ deposits: history.map(publicDeposit), scanWarnings });
    } catch (_) { res.status(502).json({ error: 'Could not refresh deposit history. Please retry shortly.' }); }
  });
  return {
    enabled,
    async processDeposits() {
      if (!enabled()) return;
      const apiKey = process.env.TATUM_API_KEY;
      const cursor = wallets.find({ state: 'active', addresses: { $exists: true } });
      for await (const wallet of cursor) {
        const scans = [
          ['Solana', () => scanWallet({ wallet, deposits, rpc: createRpc(apiKey, fetchImpl) }), 'signatureCursor'],
          ['Litecoin', () => scanLitecoin({ wallet, deposits, rpc: createRpc(apiKey, fetchImpl, LITECOIN_RPC_URL) }), 'litecoinBlockCursor'],
          ['Polygon', () => scanPolygonUsdt({ wallet, deposits, rpc: createRpc(apiKey, fetchImpl, POLYGON_RPC_URL) }), 'polygonBlockCursor'],
        ];
        for (const [network, scan, cursorField] of scans) {
          try {
            await scan();
            await wallets.updateOne({ _id: wallet._id, state: 'active' }, { $set: { [cursorField]: wallet[cursorField], last_scanned_at: Date.now() } });
          } catch (_) { console.error(`${network} mainnet deposit scan failed.`); }
        }
      }
    },
  };
}

module.exports = { validSolanaAddress, validEvmAddress, validLitecoinAddress, getNamespaceAddress, formatSol, formatUnits, decimalToAtoms, incomingLamports, savedBackupsConfirmed, storeDeposit, createRpc, scanWallet, registerSolanaMainnetDepositRoutes, RPC_URL, LITECOIN_RPC_URL, POLYGON_RPC_URL, POLYGON_USDT, POLYGON_TRANSFER_TOPIC, POLYGON_CONFIRMATIONS, LITECOIN_CONFIRMATIONS, MAX_POLYGON_BLOCKS_PER_SCAN, MAX_LITECOIN_BLOCKS_PER_SCAN };
