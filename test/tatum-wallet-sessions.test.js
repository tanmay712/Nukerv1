'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { registerTatumWalletSessionRoutes } = require('../tatum-wallet-sessions');

function fakeCollection() {
  const records = new Map();
  return { records, async findOne({ _id }) { return records.get(_id) || null; },
    async insertOne(doc) { if (records.has(doc._id)) { const e = new Error('duplicate'); e.code=11000; throw e; } records.set(doc._id, {...doc}); },
    async findOneAndUpdate(filter, update) { const doc=records.get(filter._id); if (!doc || doc.state !== filter.state || Object.hasOwn(doc, 'generation')) return null; Object.assign(doc, update.$set); return {...doc}; },
    async updateOne(filter, update) { const doc=records.get(filter._id); if (!doc || doc.state !== filter.state) return {matchedCount:0}; Object.assign(doc, update.$set); return {matchedCount:1}; } };
}
function setup(collection, sdk) {
  const app=express(); app.use(express.json());
  const requireUser=(req,res,next) => { if (!req.get('x-user')) return res.sendStatus(401); req.user={id:req.get('x-user')}; next(); };
  const csrf=(req,res,next) => req.get('x-csrf-token') === 'csrf' ? next() : res.sendStatus(403);
  registerTatumWalletSessionRoutes({app, collection, requireUser, csrf, sdkFactory:async () => sdk}); return app;
}
test('wallet sessions default off, require authentication and CSRF, and isolate clients', async () => {
  const original = {...process.env}, collection=fakeCollection(); let creates=0, sessions=0;
  const sdk={custodian:{
    async createClient({body}) { assert.deepEqual(body,{isAccountAbstracted:false}); creates++; return {id:`client-${creates}`,clientApiKey:'never-save-api-key'}; },
    async createClientSession({path}) { sessions++; return {clientSessionToken:`token-for-${path.clientId}`}; }
  }};
  const app=setup(collection,sdk), url='/api/devnet/wallet/session';
  const post=(user='alice') => request(app).post(url).set('x-user',user).set('x-csrf-token','csrf');
  try {
    delete process.env.ENABLE_EXPERIMENTAL_TATUM_DEVNET; process.env.TATUM_API_KEY='secret';
    assert.equal((await post().send({})).status,503);
    process.env.ENABLE_EXPERIMENTAL_TATUM_DEVNET='1';
    assert.equal((await request(app).post(url).send({})).status,401);
    assert.equal((await request(app).post(url).set('x-user','alice').send({})).status,403);
    assert.equal((await post().send({share:'secret'})).status,400);
    const a=await post().send({}); assert.equal(a.status,200); assert.equal(a.body.clientId,'client-1');
    assert.equal(a.body.token,'token-for-client-1');
    assert(!JSON.stringify([...collection.records.values()]).includes('never-save-api-key'));
    assert(!JSON.stringify([...collection.records.values()]).includes('token-for'));
    assert.equal((await post().send({})).body.clientId,'client-1');
    assert.equal((await post('bob').send({})).body.clientId,'client-2');
    assert.equal(creates,2); assert.equal(sessions,3);
  } finally { for (const k of ['ENABLE_EXPERIMENTAL_TATUM_DEVNET','TATUM_API_KEY']) { if (original[k] === undefined) delete process.env[k]; else process.env[k]=original[k]; } }
});
test('ambiguous provider creation fails closed and does not create twice', async () => {
  const old=process.env.ENABLE_EXPERIMENTAL_TATUM_DEVNET, key=process.env.TATUM_API_KEY;
  process.env.ENABLE_EXPERIMENTAL_TATUM_DEVNET='1'; process.env.TATUM_API_KEY='secret';
  let calls=0; const collection=fakeCollection();
  const app=setup(collection,{custodian:{async createClient(){ calls++; throw new Error('sensitive'); }}});
  try {
    const post=() => request(app).post('/api/devnet/wallet/session').set('x-user','alice').set('x-csrf-token','csrf').send({});
    const first=await post(); assert.equal(first.status,503); assert(!JSON.stringify(first.body).includes('sensitive'));
    assert.equal((await post()).status,409); assert.equal(calls,1); assert.equal(collection.records.get('alice').state,'needs_review');
  } finally { if (old===undefined) delete process.env.ENABLE_EXPERIMENTAL_TATUM_DEVNET; else process.env.ENABLE_EXPERIMENTAL_TATUM_DEVNET=old; if (key===undefined) delete process.env.TATUM_API_KEY; else process.env.TATUM_API_KEY=key; }
});

test('concurrent setup creates no duplicate provider clients', async () => {
  const old=process.env.ENABLE_EXPERIMENTAL_TATUM_DEVNET, key=process.env.TATUM_API_KEY;
  process.env.ENABLE_EXPERIMENTAL_TATUM_DEVNET='1'; process.env.TATUM_API_KEY='secret';
  let release, started; const waiting = new Promise(resolve => { release=resolve; });
  const entered = new Promise(resolve => { started=resolve; }); let created=0;
  const app=setup(fakeCollection(),{custodian:{
    async createClient(){ created++; started(); await waiting; return {id:'one'}; },
    async createClientSession(){ return {clientSessionToken:'token'}; }
  }});
  try {
    const post=() => request(app).post('/api/devnet/wallet/session').set('x-user','alice').set('x-csrf-token','csrf').send({});
    const first=post().then(r => r); await entered;
    const second=await post(); assert.equal(second.status,409);
    release(); assert.equal((await first).status,200); assert.equal(created,1);
  } finally { release(); if (old===undefined) delete process.env.ENABLE_EXPERIMENTAL_TATUM_DEVNET; else process.env.ENABLE_EXPERIMENTAL_TATUM_DEVNET=old; if (key===undefined) delete process.env.TATUM_API_KEY; else process.env.TATUM_API_KEY=key; }
});


test('wallet generation can be claimed only once across concurrent tabs', async () => {
  const old=process.env.ENABLE_EXPERIMENTAL_TATUM_DEVNET, key=process.env.TATUM_API_KEY;
  process.env.ENABLE_EXPERIMENTAL_TATUM_DEVNET='1'; process.env.TATUM_API_KEY='secret';
  const collection=fakeCollection(); await collection.insertOne({_id:'alice', state:'ready', clientId:'client'});
  const app=setup(collection,{});
  try {
    const post=() => request(app).post('/api/devnet/wallet/begin').set('x-user','alice').set('x-csrf-token','csrf').send({});
    const results=await Promise.all([post(),post()]);
    assert.deepEqual(results.map(result => result.status).sort(), [200,409]);
    assert.equal(collection.records.get('alice').generation,'claimed');
  } finally { if (old===undefined) delete process.env.ENABLE_EXPERIMENTAL_TATUM_DEVNET; else process.env.ENABLE_EXPERIMENTAL_TATUM_DEVNET=old; if (key===undefined) delete process.env.TATUM_API_KEY; else process.env.TATUM_API_KEY=key; }
});
