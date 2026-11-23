/**
 * Saweria Donation Worker — loofyjo24
 *
 * Environment variables (set di Cloudflare dashboard → Workers → Settings → Variables):
 *   API_KEY      — secret key untuk Saweria webhook & Roblox queue
 *   ADMIN_EMAIL  — email login dashboard
 *   ADMIN_PASS   — password login dashboard
 *   DB           — KV namespace binding (buat KV namespace bernama "DB")
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const fail = (msg, status = 400) =>
  new Response(msg, { status, headers: CORS });

// The dashboard calls res.json() on these replies, so validation errors have to
// be JSON too — a plain-text body made the UI show a JSON parse error instead of
// the actual reason the request was rejected.
const failJson = (error, status = 400) => json({ ok: false, error }, status);

// ── Tenant routing helpers ───────────────────────────────────────────────
export function nsKey(prefix, key, env) {
  return key === env.API_KEY ? prefix : `${prefix}:${key}`;
}

export function keyMatches(key, env, accounts) {
  if (!key) return false;
  if (key === env.API_KEY) return true;
  return accounts.some(a => a.apiKey === key);
}

export function generateApiKey(accounts, env) {
  const existing = new Set([env.API_KEY, ...accounts.map(a => a.apiKey)]);
  let key;
  do { key = crypto.randomUUID().replace(/-/g, ''); } while (existing.has(key));
  return key;
}

async function isValidKey(key, env) {
  if (!key) return false;
  if (key === env.API_KEY) return true;
  return keyMatches(key, env, await getAccounts(env));
}

async function resolveTenantKey(url, env) {
  const key = url.searchParams.get('key');
  return (await isValidKey(key, env)) ? key : null;
}

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { headers: CORS });

    // POST /webhook/{key}  ← Saweria kirim donasi ke sini (admin atau akun)
    const wh = path.match(/^\/webhook\/(.+)$/);
    if (wh && method === 'POST') {
      const key = wh[1];
      if (!(await isValidKey(key, env))) return fail('Unauthorized', 401);
      return handleWebhook(request, env, key);
    }

    // GET /queue?key=  ← Roblox ambil donasi pending
    if (path === '/queue' && method === 'GET') {
      const key = await resolveTenantKey(url, env);
      if (!key) return fail('Unauthorized', 401);
      return handleQueue(env, key);
    }

    // GET /leaderboard?key=
    if (path === '/leaderboard' && method === 'GET') {
      const key = await resolveTenantKey(url, env);
      if (!key) return fail('Unauthorized', 401);
      return handleLeaderboard(env, key);
    }

    // GET /history?key=
    if (path === '/history' && method === 'GET') {
      const key = await resolveTenantKey(url, env);
      if (!key) return fail('Unauthorized', 401);
      return handleHistory(env, key);
    }

    // POST /history/{id}/delete?key=
    const del = path.match(/^\/history\/(\d+)\/delete$/);
    if (del && method === 'POST') {
      const key = await resolveTenantKey(url, env);
      if (!key) return fail('Unauthorized', 401);
      return handleDelete(del[1], env, key);
    }

    // POST /history/{id}/edit?key=  ← edit amount/nama donasi
    const edit = path.match(/^\/history\/(\d+)\/edit$/);
    if (edit && method === 'POST') {
      const key = await resolveTenantKey(url, env);
      if (!key) return fail('Unauthorized', 401);
      return handleEditAmount(edit[1], request, env, key);
    }

    // POST /test-notification?key=
    if (path === '/test-notification' && method === 'POST') {
      const key = await resolveTenantKey(url, env);
      if (!key) return fail('Unauthorized', 401);
      return handleTestNotif(env, key);
    }

    // POST /api/login  ← dashboard login
    if (path === '/api/login' && method === 'POST') {
      return handleLogin(request, env);
    }

    // GET /accounts?key=  ← list akun (admin only)
    if (path === '/accounts' && method === 'GET') {
      const key = await resolveTenantKey(url, env);
      if (!key) return fail('Unauthorized', 401);
      if (key !== env.API_KEY) return fail('Admin only', 403);
      return handleListAccounts(env);
    }

    // POST /accounts?key=  ← tambah akun (admin only)
    if (path === '/accounts' && method === 'POST') {
      const key = await resolveTenantKey(url, env);
      if (!key) return fail('Unauthorized', 401);
      if (key !== env.API_KEY) return fail('Admin only', 403);
      return handleAddAccount(request, env);
    }

    // POST /accounts/delete?key=  ← hapus akun (admin only)
    if (path === '/accounts/delete' && method === 'POST') {
      const key = await resolveTenantKey(url, env);
      if (!key) return fail('Unauthorized', 401);
      if (key !== env.API_KEY) return fail('Admin only', 403);
      return handleDeleteAccount(request, env);
    }

    // GET /config?key=  ← ambil tier config (Roblox & dashboard)
    if (path === '/config' && method === 'GET') {
      const key = await resolveTenantKey(url, env);
      if (!key) return fail('Unauthorized', 401);
      return handleGetConfig(env, key);
    }

    // POST /config?key=  ← simpan tier config dari dashboard
    if (path === '/config' && method === 'POST') {
      const key = await resolveTenantKey(url, env);
      if (!key) return fail('Unauthorized', 401);
      return handleSetConfig(request, env, key);
    }

    return fail('Not Found', 404);
  },
};

// ── Webhook ────────────────────────────────────────────────────────────
export async function handleWebhook(request, env, key) {
  let body;
  try { body = await request.json(); } catch { return fail('Invalid JSON'); }

  // Log only the shape, never the payload: donor names and messages are personal
  // data and these logs are retained by Cloudflare.
  console.log('[webhook] body keys:', Object.keys(body).join(','));

  const name   = String(body.donatur || body.donator_name || body.donor_name || body.name || 'Anonymous');
  const amount = Number(body.amount_raw ?? body.nominal ?? body.amount ?? 0);
  const msg    = body.pesan || body.message || '';
  const time   = body.created_at || body.created_on || body.paid_at || new Date().toISOString();

  if (!Number.isFinite(amount) || amount <= 0) {
    return fail(`No usable amount in webhook (keys: ${Object.keys(body).join(',')})`);
  }

  const cfg       = await getConfig(env, key);
  const level     = levelForAmount(amount, cfg.tiers);
  const donations = await getDonations(env, key);
  donations.unshift({
    id:         nextDonationId(donations),
    donor_name: name,
    amount,
    level,
    message:    msg,
    status:     'pending',
    created_at: time,
  });

  if (donations.length > 100) donations.splice(100);
  await env.DB.put(nsKey('donations', key, env), JSON.stringify(donations));
  await bumpLeaderboard(env, key, [{ name, delta: amount }], donations);
  await bumpTotal(env, key, amount, donations);
  return json({ ok: true });
}

// Ids double as the queue's delivery-window timestamp, so they stay millisecond
// based — but two donations landing in the same millisecond used to collide,
// which broke per-id delete/edit and duplicated DOM ids in the dashboard.
export function nextDonationId(donations) {
  let id = Date.now();
  const taken = new Set(donations.map(d => Number(d.id)));
  while (taken.has(id)) id++;
  return id;
}

// ── Queue ──────────────────────────────────────────────────────────────
// Donasi dikirim ke SEMUA server Roblox yang polling dalam jendela waktu ini,
// bukan "sekali ambil". Roblox men-dedup sendiri (per-server, by id), jadi tiap
// server tetap menampilkan tiap donasi sekali. Poll (15s) < window < dedup TTL (120s).
// Tanpa ini, satu donasi cuma sampai ke server yang polling paling cepat.
const QUEUE_WINDOW_MS = 60_000;

export async function handleQueue(env, key) {
  const donations = await getDonations(env, key);
  const cutoff    = Date.now() - QUEUE_WINDOW_MS;
  const recent    = donations.filter(d => Number(d.id) >= cutoff);

  // `level` is included so the tier table edited in the dashboard is what the
  // game reacts to. Roblox can still compute it locally from the pasted Lua.
  return json({
    data: recent.map(({ id, donor_name, amount, message, created_at, level }) => ({
      id, donor_name, donorName: donor_name, amount, message, created_at,
      level: Number(level) || 0,
    })),
  });
}

// ── Leaderboard ────────────────────────────────────────────────────────
export async function handleLeaderboard(env, key) {
  const raw = await env.DB.get(nsKey('leaderboard', key, env));
  const board = raw ? JSON.parse(raw) : [];
  // The stored board keeps every donor so running totals survive; only the
  // response is trimmed to the top 20 the dashboard shows.
  const data = [...board]
    .sort((a, b) => (Number(b.total_amount) || 0) - (Number(a.total_amount) || 0))
    .slice(0, 20);
  const statsRaw = await env.DB.get(nsKey('stats', key, env));
  const total = statsRaw
    ? (Number(JSON.parse(statsRaw).total) || 0)
    : board.reduce((s, r) => s + (Number(r.total_amount) || 0), 0);
  return json({ data, total });
}

// ── History ────────────────────────────────────────────────────────────
export async function handleHistory(env, key) {
  const donations = await getDonations(env, key);
  return json({ data: donations });
}

// ── Delete ─────────────────────────────────────────────────────────────
export async function handleDelete(id, env, key) {
  const donations = await getDonations(env, key);
  const idx = donations.findIndex(d => String(d.id) === String(id));
  if (idx === -1) return failJson('Donasi tidak ditemukan', 404);
  // Test rows were never added to the total or the leaderboard, so removing one
  // must not subtract from them either.
  const removedAmount = donations[idx].is_test ? 0 : (Number(donations[idx].amount) || 0);
  const removedName   = donations[idx].donor_name;
  donations.splice(idx, 1);
  await env.DB.put(nsKey('donations', key, env), JSON.stringify(donations));
  await bumpLeaderboard(env, key, [{ name: removedName, delta: -removedAmount }], donations);
  await bumpTotal(env, key, -removedAmount, donations);
  return json({ ok: true });
}

// ── Edit Entry ─────────────────────────────────────────────────────────
export async function handleEditAmount(id, request, env, key) {
  let body;
  try { body = await request.json(); } catch { return failJson('Invalid JSON'); }

  const donations = await getDonations(env, key);
  const idx = donations.findIndex(d => String(d.id) === String(id));
  if (idx === -1) return failJson('Donasi tidak ditemukan', 404);

  const isTest    = donations[idx].is_test === true;
  const oldAmount = Number(donations[idx].amount) || 0;
  const oldName   = donations[idx].donor_name;

  let amountDelta = 0;
  let newAmount   = oldAmount;
  if (body.amount !== undefined) {
    newAmount = Number(body.amount);
    if (!Number.isFinite(newAmount) || newAmount <= 0) return failJson('Amount tidak valid');
    amountDelta = newAmount - oldAmount;
    donations[idx].amount = newAmount;
    // The tier config may have changed since the donation arrived, so re-derive
    // the level instead of leaving a stale one attached to a new amount.
    const cfg = await getConfig(env, key);
    donations[idx].level = levelForAmount(newAmount, cfg.tiers);
  }

  let newName = oldName;
  if (body.donor_name !== undefined && String(body.donor_name).trim()) {
    newName = String(body.donor_name).trim();
    donations[idx].donor_name = newName;
  }

  // A rename moves the whole donation between donors on the leaderboard, so
  // debit the old name in full and credit the new one in full. Test rows are
  // outside the totals entirely, so they contribute nothing either way.
  let adjustments = [];
  if (!isTest) {
    adjustments = newName === oldName
      ? [{ name: newName, delta: amountDelta }]
      : [{ name: oldName, delta: -oldAmount }, { name: newName, delta: newAmount }];
  }

  await env.DB.put(nsKey('donations', key, env), JSON.stringify(donations));
  await bumpLeaderboard(env, key, adjustments, donations);
  await bumpTotal(env, key, isTest ? 0 : amountDelta, donations);
  return json({ ok: true });
}

// ── Test Notif ─────────────────────────────────────────────────────────
// A test donation has to reach the Roblox queue to be worth anything, so it is
// stored like a real one — but it is NOT counted in the all-time total or the
// leaderboard. Every test press used to add a permanent Rp 25.000 to the real
// figures, and deleting the row afterwards did not take it back out.
const TEST_AMOUNT = 25000;

export async function handleTestNotif(env, key) {
  const cfg       = await getConfig(env, key);
  const donations = await getDonations(env, key);
  donations.unshift({
    id:         nextDonationId(donations),
    donor_name: 'TestDonor',
    amount:     TEST_AMOUNT,
    level:      levelForAmount(TEST_AMOUNT, cfg.tiers),
    message:    'Test notification dari dashboard',
    status:     'pending',
    is_test:    true,
    created_at: new Date().toISOString(),
  });
  if (donations.length > 100) donations.splice(100);
  await env.DB.put(nsKey('donations', key, env), JSON.stringify(donations));
  return json({ ok: true });
}

// ── Passwords ──────────────────────────────────────────────────────────
// Account passwords used to sit in KV as plaintext, so anything that could read
// the namespace read every user's password — and people reuse passwords. They
// are now stored as a PBKDF2-SHA256 hash with a per-account random salt.
// Records written before this change still carry a `password` field; they are
// accepted once and rewritten as a hash on the next successful login.
const PBKDF2_ITERATIONS = 100_000;

const toHex = (bytes) =>
  [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

const fromHex = (hex) =>
  new Uint8Array((hex.match(/.{1,2}/g) || []).map(h => parseInt(h, 16)));

export async function hashPassword(password, saltHex) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    material, 256,
  );
  return { salt: toHex(salt), hash: toHex(new Uint8Array(bits)) };
}

// Compare without leaking how many leading characters matched.
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(account, password) {
  if (typeof password !== 'string' || !password) return false;
  if (account.hash && account.salt) {
    const { hash } = await hashPassword(password, account.salt);
    return timingSafeEqual(hash, account.hash);
  }
  // Legacy plaintext record.
  return typeof account.password === 'string' && timingSafeEqual(account.password, password);
}

// ── Login ──────────────────────────────────────────────────────────────
export async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return failJson('Invalid JSON'); }

  const email    = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = body.password;

  // Cek akun utama (env vars) — admin
  const adminEmail = String(env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (email && adminEmail && email === adminEmail &&
      timingSafeEqual(String(password ?? ''), String(env.ADMIN_PASS ?? ''))) {
    return json({ ok: true, key: env.API_KEY, isAdmin: true });
  }

  // Cek akun tambahan (KV) — bukan admin, pakai apiKey sendiri
  const accounts = await getAccounts(env);
  for (const account of accounts) {
    if (String(account.email || '').trim().toLowerCase() !== email) continue;
    if (!(await verifyPassword(account, password))) break;

    // Upgrade a legacy plaintext record now that the password is known good.
    if (account.password !== undefined) {
      const { salt, hash } = await hashPassword(password);
      delete account.password;
      account.salt = salt;
      account.hash = hash;
      await env.DB.put('accounts', JSON.stringify(accounts));
    }
    return json({ ok: true, key: account.apiKey, isAdmin: false });
  }

  return json({ ok: false, error: 'Email atau password salah' }, 401);
}

// ── Accounts ───────────────────────────────────────────────────────────
export async function getAccounts(env) {
  const raw = await env.DB.get('accounts');
  const accounts = raw ? JSON.parse(raw) : [];
  let changed = false;
  for (const a of accounts) {
    if (!a.apiKey) { a.apiKey = generateApiKey(accounts, env); changed = true; }
  }
  if (changed) await env.DB.put('accounts', JSON.stringify(accounts));
  return accounts;
}

export async function handleListAccounts(env) {
  const accounts = await getAccounts(env);
  // Jangan kirim password ke frontend
  return json({ data: accounts.map(a => ({ email: a.email, apiKey: a.apiKey })) });
}

export async function handleAddAccount(request, env) {
  let body;
  try { body = await request.json(); } catch { return failJson('Invalid JSON'); }

  const email    = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password)   return failJson('Email dan password wajib diisi');
  if (!email.includes('@'))  return failJson('Email tidak valid');
  if (password.length < 4)   return failJson('Password minimal 4 karakter');

  const accounts = await getAccounts(env);
  if (accounts.some(a => String(a.email || '').trim().toLowerCase() === email)) {
    return failJson('Email sudah terdaftar');
  }
  if (email === String(env.ADMIN_EMAIL || '').trim().toLowerCase()) {
    return failJson('Email itu dipakai akun admin');
  }

  const apiKey = generateApiKey(accounts, env);
  const { salt, hash } = await hashPassword(password);
  accounts.push({ email, salt, hash, apiKey });
  await env.DB.put('accounts', JSON.stringify(accounts));
  return json({ ok: true, apiKey });
}

export async function handleDeleteAccount(request, env) {
  let body;
  try { body = await request.json(); } catch { return failJson('Invalid JSON'); }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email) return failJson('Email wajib diisi');

  const sameEmail = a => String(a.email || '').trim().toLowerCase() === email;
  const accounts  = await getAccounts(env);
  const acct      = accounts.find(sameEmail);
  if (!acct) return failJson('Akun tidak ditemukan', 404);
  await env.DB.put('accounts', JSON.stringify(accounts.filter(a => !sameEmail(a))));

  if (acct.apiKey) {
    await env.DB.delete(nsKey('donations', acct.apiKey, env));
    await env.DB.delete(nsKey('leaderboard', acct.apiKey, env));
    await env.DB.delete(nsKey('tier_config', acct.apiKey, env));
    // The running total was left behind on delete, so re-creating an account
    // that happened to get the same key inherited a stale all-time figure.
    await env.DB.delete(nsKey('stats', acct.apiKey, env));
  }
  return json({ ok: true });
}

// ── Helpers ────────────────────────────────────────────────────────────
export async function getDonations(env, key) {
  const raw = await env.DB.get(nsKey('donations', key, env));
  return raw ? JSON.parse(raw) : [];
}

// ── Running all-time total ───────────────────────────────────────────────
// The donations list is capped at 100, so it can't hold the true all-time
// total (summing it made the dashboard total shrink as old donations aged out).
// Keep a separate counter: +amount on donation, -amount on delete, adjusted on
// edit. On cold start seed from whatever donations remain — history before the
// last 100 was never stored, so this recalibrates and stays accurate from here.
const realDonations = (donations) => donations.filter(d => d.is_test !== true);

async function bumpTotal(env, key, delta, donationsAfter) {
  const raw = await env.DB.get(nsKey('stats', key, env));
  let total = raw
    ? (Number(JSON.parse(raw).total) || 0) + delta
    : realDonations(donationsAfter).reduce((s, d) => s + (Number(d.amount) || 0), 0);
  if (total < 0) total = 0;
  await env.DB.put(nsKey('stats', key, env), JSON.stringify({ total }));
}

// ── Running per-donor leaderboard ────────────────────────────────────────
// Same problem as the all-time total: the donations list is capped at 100, so
// recomputing the board from it made each donor's lifetime total shrink as
// their older donations aged out. The board is now its own running tally —
// credited on donation, debited on delete, moved on rename — and keeps EVERY
// donor, not just the visible top 20, so a donor who drops off the board and
// later returns resumes from their real total instead of restarting.
const MAX_LEADERBOARD_ENTRIES = 2000;

export async function bumpLeaderboard(env, key, adjustments, donationsAfter) {
  const dbKey = nsKey('leaderboard', key, env);
  const raw   = await env.DB.get(dbKey);
  const totals = {};

  if (raw) {
    for (const r of JSON.parse(raw)) {
      totals[r.donor_name] = (totals[r.donor_name] || 0) + (Number(r.total_amount) || 0);
    }
    for (const { name, delta } of adjustments) {
      totals[name] = (totals[name] || 0) + delta;
    }
  } else {
    // Cold start: seed from the donations that remain. History beyond the cap
    // was never stored, so this recalibrates once and stays accurate from here.
    for (const d of realDonations(donationsAfter)) {
      totals[d.donor_name] = (totals[d.donor_name] || 0) + (Number(d.amount) || 0);
    }
  }

  const board = Object.entries(totals)
    .filter(([, amount]) => amount > 0)
    .map(([donor_name, total_amount]) => ({ donor_name, total_amount }))
    .sort((a, b) => b.total_amount - a.total_amount)
    .slice(0, MAX_LEADERBOARD_ENTRIES);

  await env.DB.put(dbKey, JSON.stringify(board));
}

// ── Config ─────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  tiers: [
    { name: 'Kilat',   minRp: 1,       level: 1, effect: 'Partikel',           color: '#6b7194' },
    { name: 'Api',     minRp: 50000,   level: 4, effect: 'Nuke',               color: '#f97316' },
    { name: 'Badai',   minRp: 150000,  level: 6, effect: 'Spesial',            color: '#a855f7' },
    { name: 'Legenda', minRp: 500000,  level: 7, effect: 'Blackhole + Hammer', color: '#00d4c8' },
  ],
  effectMinRp: { Nuke: 50000, Hammer: 500000, Blackhole: 1000000 },
};

export async function handleGetConfig(env, key) {
  return json(await getConfig(env, key));
}

// A config POST with no usable tier list used to be stored as-is, and every
// later webhook then threw on it — one bad save silently broke donations for
// that tenant. Validate here and reject instead.
export async function handleSetConfig(request, env, key) {
  let body;
  try { body = await request.json(); } catch { return failJson('Invalid JSON'); }

  if (!Array.isArray(body?.tiers) || body.tiers.length === 0) {
    return failJson('Config harus punya minimal satu tier');
  }

  const tiers = body.tiers.map(t => ({
    name:   String(t?.name ?? 'Tier'),
    minRp:  Number(t?.minRp) || 0,
    level:  Number(t?.level) || 1,
    effect: String(t?.effect ?? '-'),
    color:  /^#[0-9a-fA-F]{6}$/.test(String(t?.color)) ? String(t.color) : '#6b7194',
  }));

  const src = body.effectMinRp ?? {};
  const effectMinRp = {
    Nuke:      Number(src.Nuke)      || 0,
    Hammer:    Number(src.Hammer)    || 0,
    Blackhole: Number(src.Blackhole) || 0,
  };

  await env.DB.put(nsKey('tier_config', key, env), JSON.stringify({ tiers, effectMinRp }));
  return json({ ok: true });
}

export async function getConfig(env, key) {
  const raw = await env.DB.get(nsKey('tier_config', key, env));
  if (!raw) return DEFAULT_CONFIG;
  try {
    const cfg = JSON.parse(raw);
    // Fall back rather than hand a malformed tier list to levelForAmount —
    // stored configs predate the validation above.
    if (!Array.isArray(cfg?.tiers) || cfg.tiers.length === 0) return DEFAULT_CONFIG;
    return { ...DEFAULT_CONFIG, ...cfg };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function levelForAmount(amount, tiers) {
  if (!Array.isArray(tiers)) return 0;
  const sorted = [...tiers].sort((a, b) => (Number(b.minRp) || 0) - (Number(a.minRp) || 0));
  for (const t of sorted) {
    if (amount >= (Number(t.minRp) || 0)) return Number(t.level) || 1;
  }
  return 0;
}

