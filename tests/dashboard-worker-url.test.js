import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const worker = 'https://gcoin-api.verifmlbb629.workers.dev';

function resolveWorker(saved) {
  const localStorage = new Map(saved ? [['gcoin_url', saved]] : []);
  return runInNewContext(`${script.split('// ── Tiers')[0]}\ngetWorkerUrl();`, {
    localStorage: { getItem: key => localStorage.get(key) ?? null },
  });
}

test('dashboard defaults to the GCoin Cloudflare Worker', () => {
  assert.equal(resolveWorker(), worker);
});

test('a saved legacy proxy URL no longer routes requests through Vercel', () => {
  assert.equal(resolveWorker('https://sw-dashboard-mocha.vercel.app/'), worker);
});

test('a custom Worker URL is preserved', () => {
  assert.equal(resolveWorker('https://custom.example.com/'), 'https://custom.example.com');
});
