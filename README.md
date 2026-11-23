# GCoin Dashboard

Dashboard donasi Saweria untuk game Roblox. Donasi masuk lewat webhook Saweria,
disimpan di Cloudflare KV, lalu diambil server Roblox dari endpoint `/queue`.

## Arsitektur

```
Saweria  ──POST /webhook/<key>──▶  Worker "roblox-api-donation"  ──▶  KV "DB"
                                          ▲                │
Roblox   ──GET  /queue?key=<key>──────────┘                │
                                                           ▼
Browser  ──▶  Vercel (static index.html + rewrite /api, /queue, …)  ──▶  Worker "gcoin-api"  ──▶  Worker "roblox-api-donation"
```

- `worker.js` — seluruh API dan penyimpanan. Dideploy sebagai Worker
  **`roblox-api-donation`** dengan KV namespace di-bind sebagai `DB`.
- `gcoin.js` — Worker **`gcoin-api`**: menyajikan `index.html` di `/`, sisanya
  diteruskan ke `roblox-api-donation` lewat service binding `CORE`.
- `index.html` — dashboard satu file. Dipakai dua kali: di-embed ke `gcoin-api`
  dan disajikan statis oleh Vercel.
- `vercel.json` — hanya rewrite path API ke `gcoin-api`. `/` tidak di-rewrite,
  jadi Vercel menyajikan `index.html` dari repo.

Dashboard memanggil API di origin halaman itu sendiri, jadi versi Vercel dan
versi Worker dua-duanya jalan tanpa konfigurasi tambahan.

## Environment variables (Worker `roblox-api-donation`)

| Nama | Isi |
| --- | --- |
| `API_KEY` | Secret admin. Dipakai di URL webhook dan `?key=` admin. |
| `ADMIN_EMAIL` | Email login admin. |
| `ADMIN_PASS` | Password login admin. |
| `DB` | Binding KV namespace (bukan variable — binding). |

Akun non-admin disimpan di KV key `accounts`, masing-masing dengan `apiKey`
sendiri. Datanya terpisah penuh per akun (`donations:<key>`, `leaderboard:<key>`,
`stats:<key>`, `tier_config:<key>`).

## Cara mengaktifkan kembali

1. **Lepas pause deployment Vercel.** Project `sw-dashboard` berstatus
   `DEPLOYMENT_PAUSED`, jadi `https://sw-dashboard-mocha.vercel.app` menjawab 503
   untuk semua path. Buka Vercel → project `sw-dashboard` → Settings → Resume.
   Ini satu-satunya alasan dashboard mati; backend-nya sendiri masih hidup.
2. **Deploy ulang Worker** supaya perbaikan di `worker.js` terpakai. Tanpa
   wrangler: Cloudflare Dashboard → Workers → `roblox-api-donation` → Edit code
   → paste isi `worker.js` → Deploy. Dengan wrangler:
   ```sh
   npm i -D wrangler
   npx wrangler kv namespace list          # ambil id KV "DB"
   # tulis id itu ke wrangler.toml, lalu:
   npx wrangler deploy
   npx wrangler deploy -c wrangler.gcoin.toml
   ```
3. **Push repo** supaya Vercel menyajikan `index.html` yang baru.
4. **Cek**: login di dashboard, tekan `📡 Test Notification`, pastikan barisnya
   muncul (bertanda `TEST`) dan angka **Total Donasi** tidak berubah.

### Catatan: `workers.dev` diblokir sebagian ISP

Dari jaringan XL Axiata, `gcoin-api.verifmlbb629.workers.dev` di-resolve ke
`blockpage.xlaxiata.id`, jadi worker tidak bisa diakses langsung. Itu sebabnya
dashboard harus lewat Vercel. Worker-nya sendiri normal — terbukti via DNS lain.

## Endpoint

| Method | Path | Akses |
| --- | --- | --- |
| `POST` | `/webhook/<key>` | Saweria, atau "Tambah Donor" di dashboard |
| `GET` | `/queue?key=` | Server Roblox. Donasi 60 detik terakhir, berulang |
| `GET` | `/history?key=` | Dashboard. Maksimum 100 donasi terakhir |
| `POST` | `/history/<id>/delete?key=` | Dashboard |
| `POST` | `/history/<id>/edit?key=` | Dashboard. `{ amount, donor_name }` |
| `GET` | `/leaderboard?key=` | Top 20 donor + total sepanjang waktu |
| `GET`/`POST` | `/config?key=` | Tabel tier dan ambang efek |
| `POST` | `/test-notification?key=` | Donasi uji. Tidak dihitung ke statistik |
| `POST` | `/api/login` | `{ email, password }` → `{ key, isAdmin }` |
| `GET`/`POST` | `/accounts?key=` | **Admin saja** |
| `POST` | `/accounts/delete?key=` | **Admin saja** |

`/queue` sengaja mengirim ulang donasi yang sama selama 60 detik agar semua
server Roblox menerimanya; dedup dilakukan per server berdasarkan `id`.
Poll (15s) < window (60s) < TTL dedup (120s).

## Batas yang diketahui

- **Total sepanjang waktu dihitung berjalan**, bukan dari daftar donasi, karena
  daftar itu dibatasi 100 baris. Saat `stats`/`leaderboard` masih kosong,
  nilainya di-seed dari donasi yang tersisa — riwayat sebelum 100 terakhir
  memang tidak pernah disimpan.
- **KV tidak atomik.** Dua webhook pada saat hampir bersamaan membaca dan menulis
  daftar yang sama, jadi salah satu bisa hilang. Perbaikan sebenarnya adalah
  Durable Objects; dengan volume donasi sekarang risikonya kecil.
- **API key ada di query string**, jadi ikut tercatat di log Vercel dan
  Cloudflare. Rotasi `API_KEY` kalau log pernah dibagikan.
- **Webhook tidak memverifikasi tanda tangan Saweria.** Siapa pun yang tahu URL
  webhook bisa menyuntik donasi. URL itu memang rahasianya.

## Test

```sh
npm test      # node --test, tanpa dependensi
```
