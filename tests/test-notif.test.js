import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleTestNotif, handleDelete, handleQueue, getDonations, nextDonationId } from '../worker.js';
import { mockEnv } from './helpers.js';

test('test notification: lands in the queue so the game can react to it', async () => {
  const env = mockEnv({}, 'ADMINKEY');
  await handleTestNotif(env, 'ADMINKEY');

  const body = await (await handleQueue(env, 'ADMINKEY')).json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].donor_name, 'TestDonor');
  assert.ok(body.data[0].level >= 1, 'carries a tier level like a real donation');
});

test('test notification: does not touch the all-time total or the leaderboard', async () => {
  const env = mockEnv({
    stats:       JSON.stringify({ total: 100000 }),
    leaderboard: JSON.stringify([{ donor_name: 'Budi', total_amount: 100000 }]),
  }, 'ADMINKEY');

  await handleTestNotif(env, 'ADMINKEY');
  await handleTestNotif(env, 'ADMINKEY');

  assert.equal(JSON.parse(env._store.get('stats')).total, 100000);
  assert.deepEqual(JSON.parse(env._store.get('leaderboard')),
    [{ donor_name: 'Budi', total_amount: 100000 }]);
});

test('test notification: deleting it does not subtract from the real total', async () => {
  const env = mockEnv({ stats: JSON.stringify({ total: 100000 }) }, 'ADMINKEY');
  await handleTestNotif(env, 'ADMINKEY');

  const [row] = await getDonations(env, 'ADMINKEY');
  await handleDelete(String(row.id), env, 'ADMINKEY');

  assert.equal(JSON.parse(env._store.get('stats')).total, 100000);
  assert.equal((await getDonations(env, 'ADMINKEY')).length, 0);
});

test('queue: exposes the stored level so dashboard tier edits reach the game', async () => {
  const env = mockEnv({
    donations: JSON.stringify([
      { id: Date.now(), donor_name: 'A', amount: 50000, level: 4, message: '', created_at: 't' },
    ]),
  }, 'ADMINKEY');

  const body = await (await handleQueue(env, 'ADMINKEY')).json();
  assert.equal(body.data[0].level, 4);
});

test('nextDonationId: two donations in the same millisecond get distinct ids', () => {
  const now  = Date.now();
  const used = [{ id: now }, { id: now + 1 }];
  const id   = nextDonationId(used);
  assert.ok(!used.some(d => d.id === id), `id ${id} collides with an existing donation`);
});
