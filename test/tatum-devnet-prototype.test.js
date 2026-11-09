'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
if (!global.crypto) global.crypto = webcrypto;
const publicAddress = '11111111111111111111111111111111';

test('prototype encrypts Tatum shares and gates testnet signing on saved bundle and approval', async () => {
  const { createEncryptedSigningBundle, confirmSavedSigningBundle, sendTestSol } = await import('../wallet-prototype/solana-devnet.mjs');
  const { WalletChain } = await import('@tatumio/wallet-sdk');
  let generates = 0, confirms = 0, sends = 0;
  const client = {
    async getClientDetails() { return { id:'client-a', wallets:[], metadata:{ namespaces:{ solana:{ address: publicAddress } } } }; },
    async generateWallet() { generates++; return { ED25519: { id:'ed-id', share:'ed-secret' }, SECP256K1: { id:'secp-id', share:'secp-secret' } }; },
    async updateSigningSharePairs(options) { confirms++; assert.deepEqual(options.body, { signingSharePairIds: ['secp-id', 'ed-id'], status:'STORED_CLIENT' }); },
    async sendAssets(options) { sends++; assert.deepEqual(options.body, { share:'ed-secret', chain: WalletChain.SOLANA_DEVNET, to:publicAddress, token:'NATIVE', amount:'0.000000001', rpcUrl:'https://solana-devnet.gateway.tatum.io/', sponsorGas:false }); return { transactionHash:'test-hash' }; }
  };
  const passphrase = 'long secret passphrase';
  await assert.rejects(createEncryptedSigningBundle({ client, clientId:'client-a', passphrase:'short' }));
  assert.equal(generates, 0);
  const savedBundle = await createEncryptedSigningBundle({ client, clientId:'client-a', passphrase });
  assert(!savedBundle.includes('ed-secret')); assert(!savedBundle.includes('secp-secret')); assert(!savedBundle.includes(passphrase));
  await assert.rejects(confirmSavedSigningBundle({client, clientId:'client-a', passphrase:'wrong password here', savedBundle}));
  await assert.rejects(confirmSavedSigningBundle({client, clientId:'client-b', passphrase, savedBundle}));
  const altered = JSON.parse(savedBundle); altered.iv = 'AAAAAAAAAAAAAAAA';
  await assert.rejects(confirmSavedSigningBundle({client, clientId:'client-a', passphrase, savedBundle:JSON.stringify(altered)}));
  assert.equal(confirms, 0);
  await confirmSavedSigningBundle({client, clientId:'client-a', passphrase, savedBundle});
  assert.equal(confirms, 1);
  const options = {client, clientId:'client-a', passphrase, savedBundle, to:publicAddress, amount:'0.000000001'};
  await assert.rejects(sendTestSol({...options, confirmed:false}));
  await assert.rejects(sendTestSol({...options, confirmed:true, to:'invalid'}));
  await assert.rejects(sendTestSol({...options, confirmed:true, amount:'0'}));
  await assert.rejects(sendTestSol({...options, confirmed:true, amount:'0.0000000001'}));
  assert.equal(sends, 0);
  assert.deepEqual(await sendTestSol({...options, confirmed:true}), { transactionHash:'test-hash', network:'Solana devnet' });
  assert.equal(sends, 1);
});

test('real Tatum SDK request shapes stay on fixed testnet in prototype (mock transport)', async () => {
  const { TatumWalletsSdk, WalletChain } = await import('@tatumio/wallet-sdk');
  const { createEncryptedSigningBundle, confirmSavedSigningBundle, getDevnetAddress, sendTestSol } = await import('../wallet-prototype/solana-devnet.mjs');
  const calls = [];
  const sdk = new TatumWalletsSdk({ fetch: async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
    assert.equal(options.headers.authorization, 'Bearer test-session');
    let data;
    if (path === '/api/v3/clients/me') data = { id:'client-a', wallets:[], metadata:{ namespaces:{ solana:{ address:publicAddress } } } };
    else if (path === '/v1/generate') data = { ED25519:{ id:'ed', share:'ed-share' }, SECP256K1:{ id:'secp', share:'secp-share' } };
    else if (path === '/api/v3/clients/me/signing-share-pairs') data = {};
    else if (path === '/v1/assets/send') data = { transactionHash:'mock-hash' };
    else throw new Error('Unexpected SDK endpoint');
    return new Response(JSON.stringify(data), { status: 200, headers:{ 'Content-Type':'application/json' } });
  }});
  const client = sdk.initClient({ token:'test-session' });
  const passphrase = 'another long passphrase';
  const savedBundle = await createEncryptedSigningBundle({client, clientId:'client-a', passphrase});
  await confirmSavedSigningBundle({client, clientId:'client-a', passphrase, savedBundle});
  assert.deepEqual(await getDevnetAddress({client, clientId:'client-a'}), {address:publicAddress, network:'Solana devnet'});
  await sendTestSol({client, clientId:'client-a', passphrase, savedBundle, to:publicAddress, amount:'1', confirmed:true});
  const send = calls.find(call => call.url.endsWith('/v1/assets/send'));
  assert.equal(send.body.chain, WalletChain.SOLANA_DEVNET);
  assert.equal(send.body.rpcUrl, 'https://solana-devnet.gateway.tatum.io/');
  assert.equal(send.body.share, 'ed-share');
  assert(calls.some(call => call.url === 'https://mpc-client.portalhq.io/v1/generate'));
  assert(calls.some(call => call.url === 'https://api.portalhq.io/api/v3/clients/me/signing-share-pairs'));
});

test('prototype creates distinct encrypted recovery shares and restores signing shares', async () => {
  const { createEncryptedSigningBundle, createEncryptedRecoveryBundle, confirmSavedRecoveryBundle, recoverSigningBundle, confirmSavedSigningBundle } = await import('../wallet-prototype/solana-devnet.mjs');
  const sign = { ED25519:{id:'ed',share:'original-ed'}, SECP256K1:{id:'secp',share:'original-secp'} };
  const backup = { ED25519:{id:'back-ed',share:'backup-ed'}, SECP256K1:{id:'back-secp',share:'backup-secp'} };
  let updates = 0, recoveries = 0;
  const client = {
    async getClientDetails() { return {id:'client', wallets:[]}; },
    async generateWallet() { return sign; },
    async backupWallet({body}) { assert.deepEqual(JSON.parse(body.generateResponse), sign); return backup; },
    async updateBackupSharePairs({body}) { updates++; assert.deepEqual(body, { backupSharePairIds:['back-secp','back-ed'], status:'STORED_CLIENT_BACKUP_SHARE' }); },
    async recoverWallet({body}) { recoveries++; assert.deepEqual(JSON.parse(body.backupResponse), backup); return sign; },
    async updateSigningSharePairs() {}
  };
  const clientId = 'client', passphrase = 'long backup passphrase';
  const signed = await createEncryptedSigningBundle({client, clientId, passphrase});
  const recovery = await createEncryptedRecoveryBundle({client, clientId, passphrase, savedSigningBundle:signed});
  assert(!recovery.includes('backup-ed')); assert(!recovery.includes('original-ed'));
  await assert.rejects(confirmSavedRecoveryBundle({client, clientId, passphrase, savedRecoveryBundle:signed}));
  assert.equal(updates, 0);
  await confirmSavedRecoveryBundle({client, clientId, passphrase, savedRecoveryBundle:recovery});
  const restored = await recoverSigningBundle({client, clientId, passphrase, savedRecoveryBundle:recovery});
  assert.equal(recoveries, 1);
  await confirmSavedSigningBundle({client, clientId, passphrase, savedBundle:restored});
});

test('prototype refuses duplicate wallet generation and never retries ambiguous sends', async () => {
  const { createEncryptedSigningBundle, sendTestSol } = await import('../wallet-prototype/solana-devnet.mjs');
  let generated = 0, sends = 0;
  const client = {
    async getClientDetails() { return {id:'client', wallets:[]}; },
    async generateWallet() { generated++; return {ED25519:{id:'e',share:'s'}, SECP256K1:{id:'k',share:'t'}}; },
    async sendAssets() { sends++; throw new Error('sensitive provider error'); }
  };
  const clientId='client', passphrase='correct horse battery staple';
  const savedBundle=await createEncryptedSigningBundle({client, clientId, passphrase});
  client.getClientDetails = async () => ({id:'client', wallets:[{id:'existing'}]});
  await assert.rejects(createEncryptedSigningBundle({client, clientId, passphrase}), /already has a wallet/);
  assert.equal(generated, 1);
  await assert.rejects(sendTestSol({client, clientId, passphrase, savedBundle, to:publicAddress, amount:'1', confirmed:true}), error => {
    assert.match(error.message, /status unknown/); assert(!error.message.includes('sensitive')); return true;
  });
  assert.equal(sends, 1);
});
