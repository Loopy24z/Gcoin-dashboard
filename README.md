# GCoin Dashboard

Dashboard donasi Saweria untuk game Roblox. Donasi masuk lewat webhook Saweria,
disimpan di Cloudflare KV, lalu diambil server Roblox dari endpoint `/queue`.

## Arsitektur

```
Saweria  ──POST /webhook/<key>──▶  Worker "roblox-api-donation"  ──▶  KV "DB"
                                          ▲
Roblox   ──GET  /queue?key=<key>──────────┤
                                          │
Browser  ──▶  GitHub Pages (index.html)  ─┘   (API dipanggil cross-origin)
```

- `worker.js` — seluruh API dan penyimpanan. Dideploy sebagai Worker
  **`roblox-api-donation`** dengan KV namespace di-bind sebagai `DB`.
- `index.html` — dashboard satu file, disajikan GitHub Pages dari `main`.
- `gcoin.js` — Worker **`gcoin-api`**: opsional. Menyajikan `index.html` di `/`
  dan meneruskan sisanya ke `roblox-api-donation` lewat service binding `CORE`.
  Berguna kalau mau dashboard dan API satu origin.
- `vercel.json` — tinggalan deployment Vercel. Tidak dipakai lagi; aman dihapus
  kalau Vercel tidak akan dipakai lagi.

Dashboard tidak hardcode alamat API. Saat start ia menguji
`GET {origin}/queue`: kalau origin halaman ikut melayani API (Worker, dev
server, host dengan rewrite) jawabannya `401` dan origin itu yang dipakai;
kalau host-nya statis seperti GitHub Pages jawabannya `404` dan `WORKER_URL`
yang dipakai. Bisa ditimpa manual di **Pengaturan → Worker Base URL**.

Pemanggilan cross-origin itu jalan karena Worker mengirim
`Access-Control-Allow-Origin: *`.

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

Alamatnya: <https://loopy24z.github.io/Gcoin-dashboard/>

1. **Merge ke `main`.** GitHub Pages menyajikan `main`, jadi selama perbaikan
   masih di branch, yang tampil tetap versi lama.
2. **Deploy ulang Worker** supaya perbaikan di `worker.js` terpakai. Tanpa
   wrangler: Cloudflare Dashboard → Workers → `roblox-api-donation` → Edit code
   → paste isi `worker.js` → Deploy. Dengan wrangler:
   ```sh
   npm i -D wrangler
   npx wrangler kv namespace list          # ambil id KV "DB"
   # tulis id itu ke wrangler.toml, lalu:
   npx wrangler deploy
   ```
3. **Samakan `WORKER_URL`** di `index.html` kalau nama Worker-nya berubah. Itu
   satu-satunya alamat yang masih hardcode, dipakai saat host-nya statis.
4. **Cek**: login, tekan `📡 Test Notification`, pastikan barisnya muncul
   (bertanda `TEST`) dan angka **Total Donasi** tidak berubah.

### Jalan lokal

```sh
npm test                 # 68 tes, tanpa dependensi
```

Untuk menjalankan dashboard sendiri, deploy `gcoin.js` (`wrangler.gcoin.toml`)
atau buka `index.html` lewat host statis apa pun — probe di atas yang mengurus
sisanya.

### Catatan: `workers.dev` kadang diblokir ISP

Dari jaringan XL Axiata, `*.workers.dev` dan `*.pages.dev` kadang di-resolve ke
IP blokir (`10.255.38.90` / `blockpage.xlaxiata.id`), kadang normal. Dashboard
di GitHub Pages memanggil Worker cross-origin, jadi kalau panelnya gagal memuat
padahal halamannya terbuka, resolver DNS yang jadi tersangka pertama — bukan
kodenya. Coba DNS lain (1.1.1.1 / 8.8.8.8).

Solusi permanen: pasang **custom domain** pada Worker di Cloudflare. Domainnya
tidak kena blokir, dan dashboard tinggal diarahkan ke situ lewat
**Pengaturan → Worker Base URL**.

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
- **API key ada di query string**, jadi ikut tercatat di log Cloudflare dan
  di Referer saat dipanggil cross-origin. Rotasi `API_KEY` kalau log pernah
  dibagikan.
- **Webhook tidak memverifikasi tanda tangan Saweria.** Siapa pun yang tahu URL
  webhook bisa menyuntik donasi. URL itu memang rahasianya.

## Test

```sh
npm test      # node --test, tanpa dependensi
```
