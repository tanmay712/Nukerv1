'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { validAddress, formatSol, registerSolanaDevnetRoutes } = require('../solana-devnet');

const address = '11111111111111111111111111111111';
test('Solana public addresses require canonical base58 encoding of 32 bytes', () => {
  assert.equal(validAddress(address), true);
  assert.equal(validAddress('So11111111111111111111111111111111111111112'), true);
  for (const bad of ['', '0'.repeat(32), '1'.repeat(31), '1'.repeat(33), 'z'.repeat(44), null, {}, '  ' + address]) assert.equal(validAddress(bad), false);
});
test('test SOL uses exact integer lamport formatting', () => {
  assert.equal(formatSol(0), '0'); assert.equal(formatSol(1), '0.000000001');
  assert.equal(formatSol(1234567890), '1.23456789'); assert.equal(formatSol(2000000000), '2');
});
test('devnet lookup requires auth and csrf, validates input, and never exposes credentials', async () => {
  const app = express(); app.use(express.json());
  const requireUser = (req, res, next) => req.get('x-test-user') ? next() : res.status(401).json({ error: 'Sign in required.' });
  const csrf = (req, res, next) => req.get('x-csrf-token') === 'token' ? next() : res.status(403).json({ error: 'Invalid request token.' });
  registerSolanaDevnetRoutes({ app, requireUser, csrf });
  const url = '/api/devnet/solana/balance';
  const valid = () => request(app).post(url).set('x-test-user', '1').set('x-csrf-token', 'token');
  const oldKey = process.env.TATUM_API_KEY, oldFetch = global.fetch;
  try {
    process.env.TATUM_API_KEY = 'private-api-key';
    let calls = 0;
    global.fetch = async (endpoint, options) => {
      calls++;
      assert.equal(endpoint, 'https://solana-devnet.gateway.tatum.io/');
      assert.equal(options.headers['x-api-key'], 'private-api-key');
      assert.equal(options.redirect, 'error');
      assert.deepEqual(JSON.parse(options.body), { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address, { commitment: 'confirmed' }] });
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: 1234567890, context: { slot: 1 } } }) };
    };
    assert.equal((await request(app).post(url).send({address})).status, 401);
    assert.equal((await request(app).post(url).set('x-test-user', '1').send({address})).status, 403);
    assert.equal((await valid().send({address:'bad'})).status, 400);
    assert.equal((await valid().send({address, privateKey:'no'})).status, 400);
    assert.equal(calls, 0);
    const result = await valid().send({address});
    assert.equal(result.status, 200); assert.deepEqual(result.body, { network:'Solana devnet', address, balanceSol:'1.23456789' });
    assert(!JSON.stringify(result.body).includes('private-api-key'));
    global.fetch = async () => ({ ok: true, json: async () => ({ jsonrpc:'2.0', id:1, result: { value: Number.MAX_SAFE_INTEGER + 1 } }) });
    assert.equal((await valid().send({address})).status, 502);
    global.fetch = async () => { throw new Error('private-api-key'); };
    const failed = await valid().send({address}); assert.equal(failed.status, 502); assert(!JSON.stringify(failed.body).includes('private-api-key'));
    delete process.env.TATUM_API_KEY;
    assert.equal((await valid().send({address})).status, 503);
  } finally {
    global.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.TATUM_API_KEY; else process.env.TATUM_API_KEY = oldKey;
  }
});

test('devnet endpoint limits repeated requests', async () => {
  const app = express(); app.use(express.json());
  registerSolanaDevnetRoutes({ app, requireUser: (_req, _res, next) => next(), csrf: (_req, _res, next) => next() });
  for (let i = 0; i < 30; i++) assert.equal((await request(app).post('/api/devnet/solana/balance').send({address:'bad'})).status, 400);
  assert.equal((await request(app).post('/api/devnet/solana/balance').send({address:'bad'})).status, 429);
});
