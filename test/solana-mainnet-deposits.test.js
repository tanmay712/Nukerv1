'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { validSolanaAddress, validEvmAddress, validLitecoinAddress, formatSol, formatUnits, decimalToAtoms, incomingLamports, savedBackupsConfirmed, createRpc, scanWallet, registerSolanaMainnetDepositRoutes, RPC_URL, LITECOIN_RPC_URL, POLYGON_RPC_URL, POLYGON_USDT, POLYGON_TRANSFER_TOPIC } = require('../solana-mainnet-deposits');
const { scanLitecoin, scanPolygonUsdt, evmTopicForAddress } = require('../multi-chain-deposits');

const ADDRESS = '11111111111111111111111111111111';
const SIG = '5'.repeat(64);
const LTC_ADDRESS = `ltc1q${'a'.repeat(40)}`;
const POLYGON_ADDRESS = `0x${'2'.repeat(40)}`;

function fakeCollection(seed = []) {
  const rows = new Map(seed.map((row) => [row._id, { ...row }]));
  const matches = (doc, filter) => Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object' && '$exists' in value) return Object.hasOwn(doc, key) === value.$exists;
    if (value && typeof value === 'object' && '$in' in value) return value.$in.includes(doc[key]);
    return doc[key] === value;
  });
  return {
    rows,
    get docs() { return [...rows.values()].filter((row) => row.tx_hash || row.signature); },
    async findOne(filter) { return [...rows.values()].find((doc) => matches(doc, filter)) || null; },
    async insertOne(doc) { if (rows.has(doc._id)) { const e = new Error('duplicate'); e.code = 11000; throw e; } rows.set(doc._id, { ...doc }); },
    async updateOne(filter, update, options = {}) {
      let doc = [...rows.values()].find((row) => matches(row, filter));
      if (!doc && options.upsert) {
        doc = { ...filter };
        for (const [key, value] of Object.entries(filter)) if (value && typeof value === 'object') delete doc[key];
        rows.set(doc._id || (doc.address && (doc.tx_hash || doc.signature) ? `${doc.chain || ''}:${doc.address}:${doc.tx_hash || doc.signature}:${doc.transfer_index || 0}` : `row-${rows.size}`), doc);
      }
      if (!doc) return { matchedCount: 0, upsertedCount: 0 };
      if (update.$set) Object.assign(doc, update.$set);
      if (update.$setOnInsert && options.upsert) Object.assign(doc, update.$setOnInsert);
      return { matchedCount: 1, upsertedCount: options.upsert ? 1 : 0 };
    },
    find(filter = {}) {
      const results = [...rows.values()].filter((doc) => matches(doc, filter));
      return { sort() { return this; }, limit() { return this; }, async toArray() { return results; }, async *[Symbol.asyncIterator]() { yield* [...rows.values()].filter((doc) => matches(doc, filter)); } };
    },
  };
}

function setup({ wallets = fakeCollection(), deposits = fakeCollection(), sdkFactory, fetchImpl } = {}) {
  const app = express(); app.use(express.json());
  const requireUser = (req, res, next) => { if (!req.get('x-user')) return res.sendStatus(401); req.user = { id: req.get('x-user') }; next(); };
  const csrf = (req, res, next) => req.get('x-csrf-token') === 'csrf' ? next() : res.sendStatus(403);
  const worker = registerSolanaMainnetDepositRoutes({ app, wallets, deposits, requireUser, csrf, sdkFactory, fetchImpl });
  return { app, wallets, deposits, worker };
}
const post = (app, path, body = {}, user = 'alice') => request(app).post(path).set('x-user', user).set('x-csrf-token', 'csrf').send(body);

test('mainnet address validation, exact SOL formatting, and positive net-balance parsing', () => {
  assert.equal(validSolanaAddress(ADDRESS), true);
  assert.equal(validSolanaAddress('not-an-address'), false);
  assert.equal(validEvmAddress(POLYGON_ADDRESS), true);
  assert.equal(validEvmAddress('0xnot-a-polygon-address'), false);
  assert.equal(validLitecoinAddress(LTC_ADDRESS), true);
  assert.equal(formatSol('1234567890'), '1.23456789');
  assert.equal(formatSol('1000000000'), '1');
  assert.equal(formatUnits('123456789', 6), '123.456789');
  assert.equal(decimalToAtoms('1.23456789', 8), '123456789');
  assert.throws(() => decimalToAtoms('0.000000001', 8), /Invalid decimal/);
  const backupDetails = { wallets: ['ED25519', 'SECP256K1'].map((curve) => ({ curve, signingSharePairs: [{ status: 'STORED_CLIENT' }], backupSharePairs: [{ status: 'STORED_CLIENT_BACKUP_SHARE' }] })) };
  assert.equal(savedBackupsConfirmed(backupDetails), true);
  assert.equal(savedBackupsConfirmed({ wallets: [] }), false);
  assert.equal(incomingLamports({ transaction: { message: { accountKeys: [ADDRESS] } }, meta: { err: null, preBalances: [12], postBalances: [1012] } }, ADDRESS), '1000');
  assert.equal(incomingLamports({ transaction: { message: { accountKeys: [{ pubkey: ADDRESS }] } }, meta: { err: null, preBalances: [1000], postBalances: [10] } }, ADDRESS), null);
  assert.equal(incomingLamports({ transaction: { message: { accountKeys: [ADDRESS] } }, meta: { err: { InstructionError: [0, 'failed'] }, preBalances: [0], postBalances: [100] } }, ADDRESS), null);
});

test('Tatum RPC calls are pinned to Solana mainnet, authenticated server-side, and fail closed', async () => {
  let captured;
  const rpc = createRpc('server-key', async (url, options) => {
    captured = { url, options };
    return { ok: true, async json() { return { jsonrpc: '2.0', id: 1, result: 'ok' }; } };
  });
  assert.equal(await rpc('getHealth', []), 'ok');
  assert.equal(captured.url, RPC_URL);
  assert.equal(captured.options.headers['x-api-key'], 'server-key');
  assert.equal(JSON.parse(captured.options.body).method, 'getHealth');
  await assert.rejects(() => createRpc('key', async () => ({ ok: true, async json() { return { jsonrpc: '2.0', id: 1, error: { message: 'secret' } }; } }))('getHealth', []), /Invalid blockchain RPC response/);
});

test('finalized scanner records exact positive SOL once and only advances after transaction resolution', async () => {
  const deposits = fakeCollection();
  let transactionReads = 0;
  const rpc = async (method, params) => {
    if (method === 'getSignaturesForAddress') return [{ signature: SIG, slot: 42, blockTime: 1700000000, err: null }];
    if (method === 'getTransaction') { transactionReads++; return { slot: 42, blockTime: 1700000000, transaction: { message: { accountKeys: [ADDRESS] } }, meta: { err: null, preBalances: [900], postBalances: [1234567890] } }; }
    throw new Error('unexpected method');
  };
  const wallet = { user_id: 'alice', address: ADDRESS, signatureCursor: null };
  await scanWallet({ wallet, deposits, rpc });
  assert.equal(wallet.signatureCursor, SIG);
  assert.equal(deposits.docs.length, 1);
  assert.equal(deposits.docs[0].amount_atoms, '1234566990');
  assert.equal(deposits.docs[0].state, 'finalized');
  assert.equal(transactionReads, 1);
  const retry = { ...wallet };
  await scanWallet({ wallet: retry, deposits, rpc });
  assert.equal(deposits.docs.length, 1);
});

test('ambiguous transaction lookup does not advance the scan cursor', async () => {
  const wallet = { user_id: 'alice', address: ADDRESS, signatureCursor: 'old' };
  const rpc = async (method) => method === 'getSignaturesForAddress' ? [{ signature: SIG, slot: 1, err: null }] : null;
  await assert.rejects(() => scanWallet({ wallet, deposits: fakeCollection(), rpc }), /not available yet/);
  assert.equal(wallet.signatureCursor, 'old');
});

test('mainnet wallet enrollment is disabled by default, authenticated, CSRF-protected, and address-bound to Tatum client', async () => {
  const original = { ...process.env };
  const wallets = fakeCollection();
  let created = 0;
  const sdk = {
    custodian: {
      async createClient({ body }) { assert.deepEqual(body, { isAccountAbstracted: false }); created++; return { id: `mainnet-client-${created}` }; },
      async createClientSession({ path }) { return { clientSessionToken: `token-${path.clientId}` }; },
    },
    initClient({ token }) { return { async getClientDetails() { return { id: token.replace('token-', ''), metadata: { namespaces: { solana: { address: ADDRESS }, bip122: { address: LTC_ADDRESS }, eip155: { address: POLYGON_ADDRESS } } }, wallets: ['ED25519', 'SECP256K1'].map((curve) => ({ curve, signingSharePairs: [{ status: 'STORED_CLIENT' }], backupSharePairs: [{ status: 'STORED_CLIENT_BACKUP_SHARE' }] })) }; } }; },
  };
  const fetchImpl = async (url, options) => {
    const method = JSON.parse(options.body).method;
    const result = url === LITECOIN_RPC_URL && method === 'getblockcount' ? 100 : '0x64';
    return { ok: true, async json() { return { jsonrpc: '2.0', id: 1, result }; } };
  };
  const { app } = setup({ wallets, sdkFactory: async () => sdk, fetchImpl });
  const url = '/api/mainnet/solana/wallet/session';
  try {
    delete process.env.ENABLE_TATUM_SOLANA_MAINNET_DEPOSITS; process.env.TATUM_API_KEY = 'private-key';
    assert.equal((await request(app).get('/api/mainnet/solana/deposits/status').set('x-user', 'alice')).body.enabled, false);
    process.env.ENABLE_TATUM_SOLANA_MAINNET_DEPOSITS = '1';
    assert.equal((await request(app).post(url).send({})).status, 401);
    assert.equal((await request(app).post(url).set('x-user', 'alice').send({})).status, 403);
    assert.equal((await post(app, url, { privateKey: 'must-not-send' })).status, 400);
    const opened = await post(app, url);
    assert.equal(opened.status, 200);
    assert.equal(opened.body.token, 'token-mainnet-client-1');
    assert.equal(JSON.stringify([...wallets.rows.values()]).includes('private-key'), false);
    assert.equal((await post(app, '/api/mainnet/solana/wallet/begin')).status, 200);
    const addresses = { solana: ADDRESS, litecoin: LTC_ADDRESS, polygon: POLYGON_ADDRESS };
    assert.equal((await post(app, '/api/mainnet/solana/wallet/activate', { addresses: { ...addresses, polygon: 'not-an-address' } })).status, 400);
    const activated = await post(app, '/api/mainnet/solana/wallet/activate', { addresses });
    assert.equal(activated.status, 201);
    assert.deepEqual(activated.body.addresses, addresses);
    assert.equal(activated.body.networks.length, 3);
    assert.equal(wallets.rows.get('alice').state, 'active');
    assert.equal((await post(app, '/api/mainnet/solana/wallet/begin')).status, 409);
  } finally {
    for (const key of ['ENABLE_TATUM_SOLANA_MAINNET_DEPOSITS', 'TATUM_API_KEY']) {
      if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    }
  }
});
