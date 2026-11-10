'use strict';

const { decimalToAtoms, storeDeposit, POLYGON_USDT, POLYGON_TRANSFER_TOPIC, POLYGON_CONFIRMATIONS, LITECOIN_CONFIRMATIONS, MAX_POLYGON_BLOCKS_PER_SCAN, MAX_LITECOIN_BLOCKS_PER_SCAN } = require('./solana-mainnet-deposits');

function hexNumber(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new Error('Invalid hexadecimal block number');
  const result = BigInt(value);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Block height exceeds safe integer precision');
  return Number(result);
}

function evmTopicForAddress(address) { return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`; }
function matchesEvmTransfer(log, address, contract) {
  return log && log.removed !== true && typeof log.address === 'string' && log.address.toLowerCase() === contract.toLowerCase() &&
    Array.isArray(log.topics) && log.topics.length >= 3 && log.topics[0].toLowerCase() === POLYGON_TRANSFER_TOPIC &&
    log.topics[2].toLowerCase() === evmTopicForAddress(address);
}

async function scanPolygonUsdt({ wallet, deposits, rpc, contract = POLYGON_USDT }) {
  const address = wallet.addresses?.polygon;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address || '') || !/^0x[0-9a-fA-F]{40}$/.test(contract)) throw new Error('Invalid Polygon address or token contract');
  const latest = hexNumber(await rpc('eth_blockNumber', []));
  const safeHeight = latest - POLYGON_CONFIRMATIONS;
  if (safeHeight < 0) return wallet.polygonBlockCursor || null;
  if (!Number.isSafeInteger(wallet.polygonBlockCursor)) wallet.polygonBlockCursor = safeHeight;
  let processed = 0;
  while (wallet.polygonBlockCursor < safeHeight && processed < MAX_POLYGON_BLOCKS_PER_SCAN) {
    const from = wallet.polygonBlockCursor + 1;
    const to = Math.min(safeHeight, from + 1999);
    const logs = await rpc('eth_getLogs', [{
      fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`,
      address: contract, topics: [POLYGON_TRANSFER_TOPIC, null, evmTopicForAddress(address)],
    }]);
    if (!Array.isArray(logs)) throw new Error('Invalid Polygon log response');
    for (const log of logs) {
      if (!matchesEvmTransfer(log, address, contract)) throw new Error('Polygon returned a log outside the pinned USDT filter');
      if (typeof log.data !== 'string' || !/^0x[0-9a-f]+$/i.test(log.data)) throw new Error('Invalid Polygon token amount');
      const atoms = BigInt(log.data).toString();
      if (atoms === '0') continue;
      const blockHeight = hexNumber(log.blockNumber);
      const transferIndex = hexNumber(log.logIndex);
      if (blockHeight < from || blockHeight > to || typeof log.transactionHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(log.transactionHash)) throw new Error('Invalid Polygon log metadata');
      await storeDeposit(deposits, {
        user_id: wallet.user_id, chain: 'polygon-pos', asset: 'USDT', address,
        tx_hash: log.transactionHash.toLowerCase(), transfer_index: transferIndex,
        amount_atoms: atoms, decimals: 6, block_height: blockHeight, block_time: null, state: 'confirmed',
      });
    }
    wallet.polygonBlockCursor = to;
    processed += to - from + 1;
  }
  return wallet.polygonBlockCursor;
}

function addressesFromScript(script) {
  if (Array.isArray(script?.addresses)) return script.addresses.filter((value) => typeof value === 'string');
  return typeof script?.address === 'string' ? [script.address] : [];
}

async function scanLitecoin({ wallet, deposits, rpc }) {
  const address = wallet.addresses?.litecoin;
  if (typeof address !== 'string' || address.length < 26 || address.length > 90) throw new Error('Invalid enrolled Litecoin address');
  const tip = await rpc('getblockcount', []);
  if (!Number.isSafeInteger(tip) || tip < 0) throw new Error('Invalid Litecoin block height');
  const safeHeight = tip - (LITECOIN_CONFIRMATIONS - 1);
  if (safeHeight < 0) return wallet.litecoinBlockCursor || null;
  if (!Number.isSafeInteger(wallet.litecoinBlockCursor)) wallet.litecoinBlockCursor = tip;
  let scanned = 0;
  while (wallet.litecoinBlockCursor < safeHeight && scanned < MAX_LITECOIN_BLOCKS_PER_SCAN) {
    const height = wallet.litecoinBlockCursor + 1;
    const hash = await rpc('getblockhash', [height]);
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) throw new Error('Invalid Litecoin block hash');
    const block = await rpc('getblock', [hash, 2]);
    if (!block || block.hash?.toLowerCase() !== hash.toLowerCase() || block.height !== height || !Array.isArray(block.tx)) throw new Error('Invalid verbose Litecoin block');
    for (const tx of block.tx) {
      if (typeof tx?.txid !== 'string' || !/^[0-9a-f]{64}$/i.test(tx.txid) || !Array.isArray(tx.vout)) throw new Error('Invalid Litecoin transaction');
      for (let index = 0; index < tx.vout.length; index++) {
        const output = tx.vout[index];
        if (!addressesFromScript(output?.scriptPubKey).includes(address)) continue;
        const atoms = decimalToAtoms(output.value, 8);
        if (atoms === '0') continue;
        const n = Number.isSafeInteger(output.n) ? output.n : index;
        await storeDeposit(deposits, {
          user_id: wallet.user_id, chain: 'litecoin', asset: 'LTC', address,
          tx_hash: tx.txid.toLowerCase(), transfer_index: n, amount_atoms: atoms,
          decimals: 8, block_height: height, block_time: Number.isSafeInteger(block.time) ? block.time : null,
          state: 'confirmed',
        });
      }
    }
    wallet.litecoinBlockCursor = height;
    scanned++;
  }
  return wallet.litecoinBlockCursor;
}

module.exports = { hexNumber, evmTopicForAddress, matchesEvmTransfer, scanPolygonUsdt, addressesFromScript, scanLitecoin };
