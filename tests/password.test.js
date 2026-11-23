import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleLogin, handleAddAccount, hashPassword, verifyPassword } from '../worker.js';
import { mockEnv, makeReq } from './helpers.js';

test('hashPassword: same password + same salt gives the same hash', async () => {
  const first  = await hashPassword('secret');
  const second = await hashPassword('secret', first.salt);
  assert.equal(second.hash, first.hash);
});

test('hashPassword: a fresh call gets a fresh salt, so hashes differ', async () => {
  const a = await hashPassword('secret');
  const b = await hashPassword('secret');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
});

test('verifyPassword: accepts the right password, rejects the wrong one', async () => {
  const { salt, hash } = await hashPassword('secret');
  assert.equal(await verifyPassword({ salt, hash }, 'secret'), true);
  assert.equal(await verifyPassword({ salt, hash }, 'Secret'), false);
  assert.equal(await verifyPassword({ salt, hash }, ''), false);
  assert.equal(await verifyPassword({ salt, hash }, undefined), false);
});

test('login: an account created through the API can log in', async () => {
  const env = mockEnv({}, 'ADMINKEY');
  const added = await (await handleAddAccount(makeReq({ email: 'a@x', password: 'pass' }), env)).json();

  const body = await (await handleLogin(makeReq({ email: 'a@x', password: 'pass' }), env)).json();
  assert.deepEqual({ ok: body.ok, key: body.key, isAdmin: body.isAdmin },
    { ok: true, key: added.apiKey, isAdmin: false });
});

test('login: a legacy plaintext account still works and is upgraded to a hash', async () => {
  const env = mockEnv({
    accounts: JSON.stringify([{ email: 'old@x', password: 'plain', apiKey: 'k1' }]),
  }, 'ADMINKEY');

  const body = await (await handleLogin(makeReq({ email: 'old@x', password: 'plain' }), env)).json();
  assert.equal(body.ok, true);
  assert.equal(body.key, 'k1');

  const stored = JSON.parse(env._store.get('accounts'))[0];
  assert.equal(stored.password, undefined, 'plaintext field dropped after upgrade');
  assert.equal(typeof stored.hash, 'string');

  // And the upgraded record still authenticates.
  const again = await (await handleLogin(makeReq({ email: 'old@x', password: 'plain' }), env)).json();
  assert.equal(again.ok, true);
});

test('login: email is matched case-insensitively and trimmed', async () => {
  const env = mockEnv({}, 'ADMINKEY');
  await handleAddAccount(makeReq({ email: 'Mixed@Case.com', password: 'pass' }), env);

  const body = await (await handleLogin(makeReq({ email: '  MIXED@case.COM ', password: 'pass' }), env)).json();
  assert.equal(body.ok, true);
});

test('login: admin email is matched case-insensitively, password is not', async () => {
  const env = mockEnv({}, 'ADMINKEY');
  assert.equal((await (await handleLogin(makeReq({ email: 'ADMIN@TEST', password: 'adminpass' }), env)).json()).ok, true);
  assert.equal((await (await handleLogin(makeReq({ email: 'admin@test', password: 'ADMINPASS' }), env)).json()).ok, false);
});

test('login: an empty password never authenticates an account with no stored secret', async () => {
  const env = mockEnv({ accounts: JSON.stringify([{ email: 'broken@x', apiKey: 'k1' }]) }, 'ADMINKEY');
  const res = await handleLogin(makeReq({ email: 'broken@x', password: '' }), env);
  assert.equal(res.status, 401);
});

test('login: a bad body comes back as JSON', async () => {
  const env = mockEnv({}, 'ADMINKEY');
  const res = await handleLogin(new Request('http://t/', { method: 'POST', body: 'not json' }), env);
  assert.match(res.headers.get('Content-Type'), /application\/json/);
  assert.equal((await res.json()).ok, false);
});
