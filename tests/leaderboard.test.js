import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleWebhook, handleDelete, handleEditAmount, handleLeaderboard, bumpLeaderboard,
} from '../worker.js';
import { mockEnv, makeReq } from './helpers.js';

const boardOf = (env, key = 'leaderboard') =>
  JSON.parse(env._store.get(key)).reduce((m, r) => ({ ...m, [r.donor_name]: r.total_amount }), {});

test('leaderboard: a donor total survives their old donations aging past the 100 cap', async () => {
  // The board already credits Budi 900.000; the donations list no longer holds
  // any of it. Recomputing from the capped list reset him to the new amount.
  const env = mockEnv({
    donations:   JSON.stringify([]),
    leaderboard: JSON.stringify([{ donor_name: 'Budi', total_amount: 900000 }]),
    stats:       JSON.stringify({ total: 900000 }),
  }, 'ADMINKEY');

  await handleWebhook(makeReq({ donatur: 'Budi', amount_raw: 50000 }), env, 'ADMINKEY');

  assert.equal(boardOf(env).Budi, 950000);
});

test('leaderboard: deleting a donation debits only that donor', async () => {
  const env = mockEnv({
    donations:   JSON.stringify([{ id: 111, donor_name: 'Ani', amount: 2000 }]),
    leaderboard: JSON.stringify([
      { donor_name: 'Ani',  total_amount: 5000 },
      { donor_name: 'Budi', total_amount: 7000 },
    ]),
    stats: JSON.stringify({ total: 12000 }),
  }, 'ADMINKEY');

  await handleDelete('111', env, 'ADMINKEY');

  assert.deepEqual(boardOf(env), { Ani: 3000, Budi: 7000 });
});

test('leaderboard: a donor dropping to zero leaves the board', async () => {
  const env = mockEnv({
    donations:   JSON.stringify([{ id: 111, donor_name: 'Ani', amount: 5000 }]),
    leaderboard: JSON.stringify([{ donor_name: 'Ani', total_amount: 5000 }]),
    stats:       JSON.stringify({ total: 5000 }),
  }, 'ADMINKEY');

  await handleDelete('111', env, 'ADMINKEY');

  assert.deepEqual(JSON.parse(env._store.get('leaderboard')), []);
});

test('leaderboard: renaming a donation moves the whole amount between donors', async () => {
  const env = mockEnv({
    donations:   JSON.stringify([{ id: 222, donor_name: 'Typo', amount: 3000 }]),
    leaderboard: JSON.stringify([
      { donor_name: 'Typo', total_amount: 3000 },
      { donor_name: 'Ani',  total_amount: 1000 },
    ]),
    stats: JSON.stringify({ total: 4000 }),
  }, 'ADMINKEY');

  await handleEditAmount('222', makeReq({ donor_name: 'Ani', amount: 3000 }), env, 'ADMINKEY');

  assert.deepEqual(boardOf(env), { Ani: 4000 });
  assert.equal(JSON.parse(env._store.get('stats')).total, 4000, 'grand total unchanged by a rename');
});

test('leaderboard: a rename that also changes the amount moves the new amount', async () => {
  const env = mockEnv({
    donations:   JSON.stringify([{ id: 222, donor_name: 'Typo', amount: 3000 }]),
    leaderboard: JSON.stringify([{ donor_name: 'Typo', total_amount: 3000 }]),
    stats:       JSON.stringify({ total: 3000 }),
  }, 'ADMINKEY');

  await handleEditAmount('222', makeReq({ donor_name: 'Ani', amount: 5000 }), env, 'ADMINKEY');

  assert.deepEqual(boardOf(env), { Ani: 5000 });
  assert.equal(JSON.parse(env._store.get('stats')).total, 5000);
});

test('leaderboard: the stored board keeps every donor, the response shows the top 20', async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ donor_name: `D${i}`, total_amount: (i + 1) * 100 }));
  const env  = mockEnv({ leaderboard: JSON.stringify(many), stats: JSON.stringify({ total: 1 }) }, 'ADMINKEY');

  // A tiny donor still on the stored board gets credited, not restarted.
  await handleWebhook(makeReq({ donatur: 'D0', amount_raw: 50 }), env, 'ADMINKEY');

  assert.equal(boardOf(env).D0, 150);
  assert.equal(JSON.parse(env._store.get('leaderboard')).length, 25);

  const body = await (await handleLeaderboard(env, 'ADMINKEY')).json();
  assert.equal(body.data.length, 20);
  assert.equal(body.data[0].donor_name, 'D24', 'response is sorted highest first');
});

test('bumpLeaderboard: cold start seeds from the donations that remain', async () => {
  const env = mockEnv({}, 'ADMINKEY');
  await bumpLeaderboard(env, 'ADMINKEY', [{ name: 'A', delta: 1000 }], [
    { donor_name: 'A', amount: 1000 },
    { donor_name: 'B', amount: 4000 },
  ]);
  // Seeded, not seeded-then-double-counted.
  assert.deepEqual(boardOf(env), { B: 4000, A: 1000 });
});
