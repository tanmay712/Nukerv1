'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRpc, storeDeposit, formatUnits, LITECOIN_RPC_URL, POLYGON_RPC_URL, POLYGON_USDT, POLYGON_TRANSFER_TOPIC } = require('../solana-mainnet-deposits');
const { scanLitecoin, scanPolygonUsdt, evmTopicForAddress } = require('../multi-chain-deposits');

const ltcAddress = `ltc1q${'a'.repeat(40)}`;
const evmAddress = `0x${'2'.repeat(40)}`;
function depositStore() {
  const records = new Map();
  return { records, async updateOne(filter, update) {
    const key = `${filter.chain}:${filter.address}:${filter.tx_hash}:${filter.transfer_index}`;
    if (!records.has(key)) records.set(key, { ...filter, ...update.$setOnInsert });
  } };
}

test('Litecoin scanner uses mainnet blocks, six-confirmation depth, exact satoshis, and a resumable cursor', async () => {
  const deposits = depositStore(), calls = [];
  const wallet = { user_id: 'alice', addresses: { litecoin: ltcAddress }, litecoinBlockCursor: 100 };
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'getblockcount') return 106;
    if (method === 'getblockhash') return 'a'.repeat(64);
    if (method === 'getblock') return { hash: 'a'.repeat(64), height: 101, time: 1700000000, tx: [{ txid: 'b'.repeat(64), vout: [{ n: 0, value: '1.23456789', scriptPubKey: { addresses: [ltcAddress] } }, { n: 1, value: '2.0', scriptPubKey: { addresses: ['not-the-deposit-address'] } }] }] };
    throw new Error(`unexpected method ${method}`);
  };
  await scanLitecoin({ wallet, deposits, rpc });
  assert.equal(wallet.litecoinBlockCursor, 101);
  assert.equal(deposits.records.size, 1);
  const event = [...deposits.records.values()][0];
  assert.equal(event.amount_atoms, '123456789');
  assert.equal(formatUnits(event.amount_atoms, event.decimals), '1.23456789');
  assert.equal(event.state, 'confirmed');
  assert.deepEqual(calls.map((call) => call.method), ['getblockcount', 'getblockhash', 'getblock']);
});

test('Litecoin scan does not advance on malformed block data', async () => {
  const wallet = { user_id: 'alice', addresses: { litecoin: ltcAddress }, litecoinBlockCursor: 10 };
  const rpc = async (method) => method === 'getblockcount' ? 20 : method === 'getblockhash' ? 'c'.repeat(64) : { hash: 'd'.repeat(64), height: 11, tx: [] };
  await assert.rejects(() => scanLitecoin({ wallet, deposits: depositStore(), rpc }), /Invalid verbose Litecoin block/);
  assert.equal(wallet.litecoinBlockCursor, 10);
});

test('Polygon PoS scanner pins USDT contract and Transfer topic, waits 128 blocks, and stores raw token units', async () => {
  const deposits = depositStore(), calls = [];
  const wallet = { user_id: 'alice', addresses: { polygon: evmAddress }, polygonBlockCursor: 100 };
  const txHash = `0x${'a'.repeat(64)}`;
  const transfer = { address: POLYGON_USDT, topics: [POLYGON_TRANSFER_TOPIC, `0x${'0'.repeat(64)}`, evmTopicForAddress(evmAddress)], data: `0x${(1234567n).toString(16).padStart(64, '0')}`, blockNumber: '0x65', logIndex: '0x2', transactionHash: txHash };
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_blockNumber') return '0xe5'; // 229 - 128 confirmations = safe block 101
    if (method === 'eth_getLogs') return [transfer];
    throw new Error(`unexpected method ${method}`);
  };
  await scanPolygonUsdt({ wallet, deposits, rpc });
  assert.equal(wallet.polygonBlockCursor, 101);
  assert.equal(calls[0].method, 'eth_blockNumber');
  assert.equal(calls[1].params[0].address, POLYGON_USDT);
  assert.equal(calls[1].params[0].topics[0], POLYGON_TRANSFER_TOPIC);
  assert.equal(deposits.records.size, 1);
  const event = [...deposits.records.values()][0];
  assert.equal(event.asset, 'USDT');
  assert.equal(event.amount_atoms, '1234567');
  assert.equal(formatUnits(event.amount_atoms, 6), '1.234567');
  assert.equal(event.state, 'confirmed');
});

test('Polygon address filter rejects unrelated logs and does not move cursor on invalid provider data', async () => {
  const deposits = depositStore();
  const wallet = { user_id: 'alice', addresses: { polygon: evmAddress }, polygonBlockCursor: 100 };
  const unrelated = { address: POLYGON_USDT, topics: [POLYGON_TRANSFER_TOPIC, `0x${'0'.repeat(64)}`, evmTopicForAddress(`0x${'3'.repeat(40)}`)], data: '0x01', blockNumber: '0x65', logIndex: '0x0', transactionHash: `0x${'b'.repeat(64)}` };
  const rpc = async (method) => method === 'eth_blockNumber' ? '0xe5' : [unrelated];
  await assert.rejects(() => scanPolygonUsdt({ wallet, deposits, rpc }), /outside the pinned USDT filter/);
  assert.equal(wallet.polygonBlockCursor, 100);
  assert.equal(deposits.records.size, 0);
});

test('RPC JSON parser preserves Litecoin decimal values as strings and pins chain endpoints', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, async text() { return '{"jsonrpc":"2.0","id":1,"result":{"value":0.00000001}}'; } };
  };
  const ltc = createRpc('key', fetchImpl, LITECOIN_RPC_URL);
  const polygon = createRpc('key', fetchImpl, POLYGON_RPC_URL);
  assert.equal((await ltc('getblock', [] )).value, '0.00000001');
  assert.equal(calls[0].url, LITECOIN_RPC_URL);
  assert.equal(calls[0].options.headers['x-api-key'], 'key');
  assert.equal((await polygon('eth_blockNumber', [] )).value, '0.00000001');
  assert.equal(calls[1].url, POLYGON_RPC_URL);
});
