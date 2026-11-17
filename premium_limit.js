import http from 'http';
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';

export const PREMIUM_COMMANDS = ['limit', 'ceklimit', 'premium', 'belipremium', 'qris', 'cekstatus', 'konfirmasi', 'accprem', 'addprem', 'delprem', 'listprem'];

const DAILY_FREE_LIMIT = 15;
const DANA_NUMBER = process.env.DANA_NUMBER || '085811980122';
const OWNER_NUMBER = (process.env.OWNER_NUMBER || '').replace(/\D/g, '');
const PAKASIR_SLUG = process.env.PAKASIR_SLUG || '';
const PAKASIR_API_KEY = process.env.PAKASIR_API_KEY || '';
const WEBHOOK_PORT = Number(process.env.QRIS_WEBHOOK_PORT || 3099);
const WEBHOOK_SECRET = process.env.QRIS_WEBHOOK_SECRET || '';
const INVOICE_TTL = 5 * 60 * 1000; // tagihan berlaku 5 menit
const MAX_TRIES = 3;
const PLAIN_MIN_LEN = 5; // hanya untuk ID yang dikirim tanpa perintah (anti salah deteksi chat biasa)
const PAID_RX = /^(completed|paid|success|settlement)$/i;
const rp = (n) => `Rp ${Number(n).toLocaleString('id-ID')}`;

// Taruh 3 gambar QR di ./assets/ (atau folder env QRIS_DIR): qris_1 (Rp1.000), qris_2 (Rp5.000), qris_3 (Rp10.000) — .png/.jpg/.jpeg/.webp
const QR_DIR = process.env.QRIS_DIR ? path.resolve(process.env.QRIS_DIR) : path.join(process.cwd(), 'assets');

export const PREMIUM_PACKAGES = {
  1: { days: 2, price: 1000, label: '2 Hari', img: 'qris_1' },
  2: { days: 14, price: 5000, label: '2 Minggu', img: 'qris_2' },
  3: { days: 30, price: 10000, label: '1 Bulan', img: 'qris_3' },
};

export const LIMIT_EXEMPT_COMMANDS = new Set([
  'menu', 'help', 'limit', 'ceklimit', 'premium', 'belipremium', 'qris', 'cekstatus', 'konfirmasi', 'owner',
]);

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: ac.signal }); } finally { clearTimeout(t); }
}

function getWibDateKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
}

export function ensureUserRecord(dbMemory, senderNum) {
  dbMemory.users ||= {};
  dbMemory.users[senderNum] ||= { facts: [], city: '', dailyDate: getWibDateKey(), dailyUsed: 0, premiumUntil: 0 };
  const u = dbMemory.users[senderNum];
  const today = getWibDateKey();
  if (u.dailyDate !== today) { u.dailyDate = today; u.dailyUsed = 0; }
  if (typeof u.premiumUntil !== 'number') u.premiumUntil = 0;
  return u;
}

export const isUserPremium = (user) => Boolean(user && user.premiumUntil && user.premiumUntil > Date.now());

export function formatRemainingTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 86400)} hari ${Math.floor((s % 86400) / 3600)} jam ${Math.floor((s % 3600) / 60)} menit`;
}

const fmtWib = (ts) => new Date(ts).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
const tierOf = (d = 0) => (d >= 30 ? '👑 PLATINUM' : d >= 14 ? '🥇 GOLD' : '🥈 SILVER');
const bar = (ms, days) => {
  const f = Math.max(0, Math.min(10, Math.round((ms / (Math.max(days, 1) * 86400000)) * 10)));
  return `${'🟩'.repeat(f)}${'⬜'.repeat(10 - f)}`;
};

/* ───────────── Limit harian ───────────── */

export async function checkAndConsumeDailyLimit({ sock, jid, senderNum, isOwner, isSenderAdmin, cmd, msg, dbMemory, saveMemory }) {
  if (!senderNum) return { allowed: true };
  if (isOwner || isSenderAdmin) return { allowed: true, role: 'Admin/Owner' };
  if (LIMIT_EXEMPT_COMMANDS.has(cmd)) return { allowed: true, role: 'Gratis' };

  const user = ensureUserRecord(dbMemory, senderNum);
  if (isUserPremium(user)) return { allowed: true, role: 'Premium' };

  if (user.dailyUsed >= DAILY_FREE_LIMIT) {
    await sock.sendMessage(jid, {
      text:
        `⛔ *LIMIT HARIAN HABIS (${user.dailyUsed}/${DAILY_FREE_LIMIT})*\n\n` +
        `Pengguna reguler dibatasi *${DAILY_FREE_LIMIT}x per hari* (reset 00:00 WIB).\n\n` +
        `💎 *UPGRADE PREMIUM UNLIMITED*\n• Ketik *\`.qris\`* untuk memilih paket.`,
    }, { quoted: msg });
    return { allowed: false };
  }
  user.dailyUsed += 1;
  await saveMemory();
  return { allowed: true, remaining: DAILY_FREE_LIMIT - user.dailyUsed };
}

/* ───────────── Aktivasi premium (tersimpan di database) ───────────── */

let currentSockRef = null;

export async function activatePremiumForNumber(sock, dbMemory, saveMemory, targetNum, days = 2, source = 'QRIS', opts = {}) {
  const cleanNum = String(targetNum).replace(/\D/g, '');
  if (!cleanNum) return null;
  const s = sock || currentSockRef;

  const user = ensureUserRecord(dbMemory, cleanNum);
  const now = Date.now();
  const base = user.premiumUntil > now ? user.premiumUntil : now;
  user.premiumUntil = base + days * 86400000;
  user.premiumSince = user.premiumSince && base > now ? user.premiumSince : now;
  user.premiumTotalDays = (user.premiumTotalDays || 0) + days;
  user.dailyUsed = 0;
  user.remindSent = false;

  dbMemory.premiumLog ||= [];
  dbMemory.premiumLog.push({ phone: cleanNum, days, source, ref: opts.ref || '', at: now, until: user.premiumUntil });
  if (dbMemory.premiumLog.length > 1000) dbMemory.premiumLog = dbMemory.premiumLog.slice(-1000);
  if (Array.isArray(dbMemory.pendingInvoices)) dbMemory.pendingInvoices = dbMemory.pendingInvoices.filter((i) => i.phone !== cleanNum);
  await saveMemory();

  const name = (opts.pushName || '').trim();
  const text =
    `🎉 *SELAMAT${name ? `, ${name.toUpperCase()}` : ''}! ANDA RESMI MENJADI MEMBER VIP* 🎉\n\n` +
    `Keputusan yang cerdas. Mulai detik ini Anda berada di barisan pengguna *eksklusif* yang menikmati semuanya tanpa hambatan. ✨\n\n` +
    `╭───〔 💎 KARTU MEMBER VIP 〕───\n` +
    `│ 🏅 Level: *${tierOf(user.premiumTotalDays)}*\n` +
    `│ 📱 Nomor: *+${cleanNum}*\n` +
    `│ ⏳ Durasi: *${days} Hari*\n` +
    `│ 📅 Aktif s/d: *${fmtWib(user.premiumUntil)} WIB*\n` +
    `│ ♾️ Limit: *Tanpa Batas*\n` +
    `│ ✅ Verifikasi: *${source}*\n` +
    `╰──────────────────────\n\n` +
    `🎁 *Yang langsung Anda dapatkan:*\n` +
    `• 🚀 Download sepuasnya, tanpa antre limit\n` +
    `• ⚡ Prioritas penuh di semua fitur\n` +
    `• 🧠 Bebas berkarya tanpa rasa khawatir kehabisan kuota\n` +
    `• 💙 Dukungan Anda membuat bot ini terus berkembang\n\n` +
    `Terima kasih sudah percaya. Anda layak mendapatkan pengalaman terbaik. Ketik *\`.menu\`* dan nikmati semua fitur sekarang! 🔥\n` +
    `_Cek masa aktif kapan saja dengan_ *\`.limit\`*`;

  const targets = [...new Set([opts.notifyJid, `${cleanNum}@s.whatsapp.net`].filter(Boolean))];
  for (const t of targets) {
    try {
      await s.sendMessage(t, { text }, t === opts.notifyJid && opts.quoted ? { quoted: opts.quoted } : undefined);
      break;
    } catch (e) {
      console.error('[premium] gagal kirim ucapan ke', t, e?.message);
    }
  }
  return user.premiumUntil;
}

/** Atomik: invoice dihapus SEBELUM await → mustahil aktif dua kali. */
async function settleInvoice(dbMemory, saveMemory, orderId, source, opts = {}) {
  const list = dbMemory.pendingInvoices || [];
  const inv = list.find((i) => i.orderId === orderId);
  if (!inv) return null;
  dbMemory.pendingInvoices = list.filter((i) => i.orderId !== orderId);
  try {
    await activatePremiumForNumber(currentSockRef, dbMemory, saveMemory, inv.phone, inv.days, source, { notifyJid: inv.notifyJid, ...opts });
  } catch (e) {
    dbMemory.pendingInvoices.push(inv);
    throw e;
  }
  return inv;
}

async function verifyPakasir(inv) {
  if (!PAKASIR_SLUG || !PAKASIR_API_KEY || inv?.gatewayMode !== 'PAKASIR') return false;
  const url = `https://app.pakasir.com/api/transactiondetail?project=${encodeURIComponent(PAKASIR_SLUG)}&amount=${inv.amount}&order_id=${encodeURIComponent(inv.orderId)}&api_key=${encodeURIComponent(PAKASIR_API_KEY)}`;
  const res = await fetchWithTimeout(url, {}, 10000).catch(() => null);
  const d = res?.ok ? await res.json().catch(() => null) : null;
  const t = d?.transaction || d || {};
  return PAID_RX.test(String(t.status || '')) && (!t.order_id || t.order_id === inv.orderId);
}

/* ───────────── Invoice + QR ───────────── */

const qrUrl = (data) => `https://api.qrserver.com/v1/create-qr-code/?size=450x450&data=${encodeURIComponent(data)}`;

async function loadQrFile(pkg) {
  for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
    const buffer = await fsPromises.readFile(path.join(QR_DIR, `${pkg.img}.${ext}`)).catch(() => null);
    if (buffer?.length) return buffer;
  }
  console.warn(`[premium] file QR tidak ditemukan: ${path.join(QR_DIR, pkg.img)}.png`);
  return null;
}

async function createQrisInvoice(dbMemory, saveMemory, senderNum, notifyJid, pkg) {
  dbMemory.pendingInvoices = (dbMemory.pendingInvoices || []).filter((i) => i.phone !== senderNum);

  const orderId = `PREM-${senderNum.slice(-4)}-${Date.now().toString().slice(-6)}`;
  let qrImage = null;
  let gatewayMode = 'MANUAL';

  if (PAKASIR_SLUG && PAKASIR_API_KEY) {
    try {
      const res = await fetchWithTimeout('https://app.pakasir.com/api/transactioncreate/qris', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: PAKASIR_SLUG, order_id: orderId, amount: pkg.price, api_key: PAKASIR_API_KEY }),
      }, 12000);
      const data = await res.json();
      const qr = data?.payment?.payment_number || data?.qr_string;
      if (qr) { qrImage = { url: qrUrl(qr) }; gatewayMode = 'PAKASIR'; }
    } catch {}
  }

  if (!qrImage) {
    const buffer = await loadQrFile(pkg);
    if (buffer) qrImage = { buffer };
  }

  const invoice = {
    orderId,
    phone: senderNum,
    notifyJid,
    amount: pkg.price,
    days: pkg.days,
    gatewayMode,
    manual: gatewayMode !== 'PAKASIR',
    tries: 0,
    createdAt: Date.now(),
    expiresAt: Date.now() + INVOICE_TTL,
  };
  dbMemory.pendingInvoices.push(invoice);
  await saveMemory();
  return { invoice, qrImage };
}

const activeInvoice = (dbMemory, phone) =>
  (dbMemory.pendingInvoices || []).find((i) => i.phone === phone && i.manual && i.expiresAt > Date.now());

/* ───────────── Watcher, auto-expire, webhook ───────────── */

let watcherStarted = false;

export function startPremiumAndQrisWatcher(sock, dbMemory, saveMemory) {
  currentSockRef = sock;
  if (watcherStarted) return;
  watcherStarted = true;

  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      if (!Array.isArray(dbMemory.pendingInvoices) || !dbMemory.pendingInvoices.length) return;
      const now = Date.now();
      const before = dbMemory.pendingInvoices.length;
      dbMemory.pendingInvoices = dbMemory.pendingInvoices.filter((i) => i.expiresAt > now);
      if (dbMemory.pendingInvoices.length !== before) await saveMemory();
      for (const inv of [...dbMemory.pendingInvoices]) {
        if (inv.gatewayMode === 'PAKASIR' && (await verifyPakasir(inv))) await settleInvoice(dbMemory, saveMemory, inv.orderId, 'QRIS Otomatis');
      }
    } catch (e) { console.error('[premium] watcher:', e?.message); } finally { busy = false; }
  }, 12000);

  setInterval(async () => {
    try {
      if (!dbMemory.users) return;
      const now = Date.now();
      let changed = false;
      for (const [phone, u] of Object.entries(dbMemory.users)) {
        if (u.premiumUntil && !u.remindSent && u.premiumUntil - now < 86400000 && u.premiumUntil > now) {
          u.remindSent = true; changed = true;
          await currentSockRef?.sendMessage(`${phone}@s.whatsapp.net`, { text: `🔔 *VIP Anda tinggal kurang dari 24 jam.*\nPerpanjang sekarang agar akses tanpa batas tidak terputus: *\`.qris\`* 💎` }).catch(() => {});
        }
        if (u.premiumUntil && now >= u.premiumUntil) {
          u.premiumUntil = 0;
          u.dailyUsed = 0;
          u.dailyDate = getWibDateKey();
          changed = true;
          await currentSockRef?.sendMessage(`${phone}@s.whatsapp.net`, {
            text:
              `⏳ *MASA VIP ANDA TELAH BERAKHIR*\n\n` +
              `Terima kasih sudah menjadi bagian VIP, semoga setiap fiturnya bermanfaat. 💙\n` +
              `Akun *+${phone}* kembali ke Mode Reguler (${DAILY_FREE_LIMIT}x/hari).\n\n` +
              `Sudah terbiasa tanpa batas? Lanjutkan kenyamanannya, ketik *\`.qris\`* dan kembali ke level VIP dalam hitungan menit. 🚀`,
          }).catch(() => {});
        }
      }
      if (changed) await saveMemory();
    } catch (e) { console.error('[premium] expire:', e?.message); }
  }, 60000);

  if (!WEBHOOK_SECRET) {
    console.warn('[premium] QRIS_WEBHOOK_SECRET kosong → webhook mati (polling Pakasir tetap jalan)');
    return;
  }
  const safeEq = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  http.createServer((req, res) => {
    const out = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    let u;
    try { u = new URL(req.url || '/', 'http://x'); } catch { return out(400, { ok: false }); }
    if (req.method !== 'POST' || u.pathname !== '/webhook/qris') return out(404, { ok: false });
    if (!safeEq(u.searchParams.get('secret') || req.headers['x-webhook-secret'] || '', WEBHOOK_SECRET)) return out(401, { ok: false });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => {
      try {
        const orderId = String(JSON.parse(body || '{}').order_id || '');
        const inv = (dbMemory.pendingInvoices || []).find((i) => i.orderId === orderId);
        if (inv && (await verifyPakasir(inv))) {
          await settleInvoice(dbMemory, saveMemory, orderId, 'Webhook Pakasir');
          return out(200, { ok: true });
        }
      } catch {}
      out(200, { ok: false });
    });
  }).listen(WEBHOOK_PORT, () => console.log(`💳 Webhook aktif :${WEBHOOK_PORT}/webhook/qris`));
}

/* ───────────── Verifikasi bukti (ID transaksi) ───────────── */

const HOW_TO_ID =
  `📍 *Cara cek ID Transaksi:*\n` +
  `DANA → *Aktivitas/Riwayat* → pilih transaksi → *Rincian/Detail Transaksi* → salin *ID Transaksi*`;

const normRef = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

/** ID dianggap lama jika sama persis, atau potongan (≥4 karakter) dari ID yang pernah dipakai. */
const isOldRef = (used, ref) => Object.keys(used).some((r) =>
  r === ref || (Math.min(r.length, ref.length) >= 4 && (r.endsWith(ref) || ref.endsWith(r))));

async function processProof({ sock, jid, senderNum, rawRef, msg, dbMemory, saveMemory }) {
  const send = (text) => sock.sendMessage(jid, { text }, { quoted: msg });
  const ref = normRef(rawRef);
  const inv = activeInvoice(dbMemory, senderNum);

  if (!inv) {
    await send('📭 Tidak ada tagihan aktif (berlaku 5 menit sejak dibuat). Ketik `.qris` untuk membuat tagihan baru.');
    return true;
  }
  if (!ref || !/\d/.test(ref)) {
    await send(`⚠️ ID tidak terbaca. Kirim ID Transaksi DANA persis seperti di aplikasi.\n\n${HOW_TO_ID}`);
    return true;
  }
  if (inv.tries >= MAX_TRIES) {
    await send('⛔ Percobaan habis. Buat tagihan baru dengan `.qris`.');
    return true;
  }

  dbMemory.usedRefs ||= {};
  if (isOldRef(dbMemory.usedRefs, ref)) {
    inv.tries += 1;
    await saveMemory();
    await send(`⛔ ID ini sudah pernah dipakai (bukan bukti terbaru). Sisa percobaan: ${MAX_TRIES - inv.tries}\n\n${HOW_TO_ID}`);
    return true;
  }

  dbMemory.usedRefs[ref] = { orderId: inv.orderId, phone: senderNum, at: Date.now() };
  let done = null;
  try {
    done = await settleInvoice(dbMemory, saveMemory, inv.orderId, 'ID Transaksi DANA', { quoted: msg, ref, pushName: msg?.pushName });
  } catch (e) {
    console.error('[premium] gagal aktivasi:', e?.message);
  }
  if (!done) {
    delete dbMemory.usedRefs[ref];
    await send('❌ Gagal memproses, silakan kirim ulang ID Anda.');
    return true;
  }
  await saveMemory();

  if (OWNER_NUMBER) {
    await sock.sendMessage(`${OWNER_NUMBER}@s.whatsapp.net`, {
      text:
        `🔔 *VIP AKTIF OTOMATIS*\n+${senderNum}\nNominal: ${rp(done.amount)}\nPaket: ${done.days} hari\nID DANA: ${ref}\n\n` +
        `Cocokkan dengan mutasi DANA. Jika palsu:\n\`.delprem ${senderNum}\``,
    }).catch(() => {});
  }
  return true;
}

/**
 * Panggil dari handler pesan untuk pesan BUKAN perintah (mis. member hanya menempel ID tanpa ".konfirmasi").
 * Contoh: if (!isCommand && await handlePremiumProofText({ sock, jid, senderNum, text, msg, dbMemory, saveMemory })) return;
 */
export async function handlePremiumProofText({ sock, jid, senderNum, text = '', msg, dbMemory, saveMemory }) {
  const t = String(text || '').trim();
  if (!t || /^[.!/#]/.test(t) || /\s/.test(t)) return false;
  if (!/^[A-Za-z0-9-]+$/.test(t) || !/\d/.test(t) || normRef(t).length < PLAIN_MIN_LEN) return false;
  if (!activeInvoice(dbMemory, senderNum)) return false;
  return processProof({ sock, jid, senderNum, rawRef: t, msg, dbMemory, saveMemory });
}

/* ───────────── Handler perintah ───────────── */

export async function handlePremiumCommand({ sock, jid, senderNum, isOwner, isSenderAdmin, cmd, param = '', msg, dbMemory, saveMemory }) {
  if (!PREMIUM_COMMANDS.includes(cmd)) return false;
  param = String(param || '').trim();
  const user = ensureUserRecord(dbMemory, senderNum);
  const send = (text) => sock.sendMessage(jid, { text }, { quoted: msg });

  if (cmd === 'limit' || cmd === 'ceklimit') {
    if (isOwner || isSenderAdmin) { await send('👑 *STATUS AKUN:* Admin / Owner\n• Limit Harian: *∞ Unlimited*'); return true; }
    if (isUserPremium(user)) {
      const left = user.premiumUntil - Date.now();
      await send(
        `💎 *STATUS: MEMBER VIP AKTIF* ${tierOf(user.premiumTotalDays).split(' ')[0]}\n\n` +
        `Anda sedang menikmati akses penuh tanpa batas. Pilihan yang tepat! ✨\n\n` +
        `🏅 Level: *${tierOf(user.premiumTotalDays)}*\n` +
        `♾️ Limit Harian: *Tanpa Batas*\n` +
        `📅 Berlaku s/d: *${fmtWib(user.premiumUntil)} WIB*\n` +
        `⏳ Sisa: *${formatRemainingTime(left)}*\n` +
        `${bar(left, user.premiumTotalDays)}\n\n` +
        `${left < 2 * 86400000 ? '⚠️ Masa VIP hampir habis. Perpanjang sekarang agar akses Anda tidak terputus: *`.qris`*' : '_Nikmati setiap fiturnya, Anda sudah di level yang tepat._ 🔥'}`
      );
      return true;
    }
    await send(
      `📊 *INFO LIMIT HARIAN*\n• Terpakai: *${user.dailyUsed}/${DAILY_FREE_LIMIT}*\n` +
      `• Sisa: *${Math.max(0, DAILY_FREE_LIMIT - user.dailyUsed)}x*\n• Status: *Reguler*\n\nKetik *\`.qris\`* untuk VIP.`
    );
    return true;
  }

  if (['premium', 'belipremium', 'qris'].includes(cmd)) {
    const pkg = PREMIUM_PACKAGES[Number(param)];
    if (!pkg) {
      await send(
        `💳 *PILIH PAKET VIP*\n\n` +
        Object.entries(PREMIUM_PACKAGES).map(([k, p]) => `${k}️⃣ \`.qris ${k}\` — ${rp(p.price)} *(${p.label})*`).join('\n') +
        `\n\n_Contoh:_ \`.qris 3\``
      );
      return true;
    }
    const { invoice, qrImage } = await createQrisInvoice(dbMemory, saveMemory, senderNum, jid, pkg);
    const caption =
      `💳 *PEMBAYARAN VIP (${pkg.label})*\n\n` +
      `• ID Invoice: \`${invoice.orderId}\`\n` +
      `• Total Bayar: *${rp(invoice.amount)}*\n` +
      (invoice.manual
        ? `• Bayar lewat QR di atas *(khusus DANA)* atau transfer ke DANA *${DANA_NUMBER}*\n\n` +
          `Setelah bayar, langsung kirim *ID Transaksi* DANA ke chat ini (boleh tanpa perintah), atau:\n\`.konfirmasi <ID Transaksi>\`\n\n${HOW_TO_ID}\n\n` +
          `✅ VIP aktif *otomatis* setelah ID diterima.\n⏱️ Tagihan berlaku *5 menit* (sampai ${fmtWib(invoice.expiresAt)} WIB).`
        : `\n✅ VIP aktif *otomatis* setelah pembayaran terverifikasi (±1 menit).\n⏱️ Tagihan berlaku *5 menit*.`);
    await sock.sendMessage(jid, qrImage ? { image: qrImage.buffer || { url: qrImage.url }, caption } : { text: caption }, { quoted: msg });
    return true;
  }

  if (cmd === 'konfirmasi') {
    return processProof({ sock, jid, senderNum, rawRef: param, msg, dbMemory, saveMemory });
  }

  if (cmd === 'cekstatus') {
    if (isUserPremium(user)) {
      await send(`✅ *+${senderNum}* adalah member *VIP ${tierOf(user.premiumTotalDays)}*\n📅 Aktif s/d *${fmtWib(user.premiumUntil)} WIB*\n⏳ Sisa *${formatRemainingTime(user.premiumUntil - Date.now())}*\n\nTerima kasih sudah menjadi bagian eksklusif kami 💙`);
      return true;
    }
    const inv = activeInvoice(dbMemory, senderNum);
    await send(inv
      ? `⏳ Tagihan \`${inv.orderId}\` *${rp(inv.amount)}* (${inv.days} hari) menunggu pembayaran.\nKirim ID Transaksi setelah bayar. Berlaku sampai ${fmtWib(inv.expiresAt)} WIB.`
      : '📭 Tidak ada tagihan aktif. Ketik `.qris` untuk melihat paket.');
    return true;
  }

  if ((cmd === 'accprem' || cmd === 'addprem') && isOwner) {
    if (/^PREM-/i.test(param)) {
      const inv = await settleInvoice(dbMemory, saveMemory, param.split(/\s+/)[0], 'Verifikasi Owner', { quoted: msg }).catch(() => null);
      await send(inv ? `✅ +${inv.phone} aktif VIP ${inv.days} hari.` : '❌ Invoice tidak ditemukan / sudah diproses.');
      return true;
    }
    const [t, d] = param.split(/\s+/);
    const target = (t || '').replace(/\D/g, '');
    const days = Number(d) || 2;
    if (!target) { await send('⚠️ Contoh: `.accprem PREM-1234-567890` atau `.addprem 628123456789 30`'); return true; }
    await activatePremiumForNumber(sock, dbMemory, saveMemory, target, days, 'Verifikasi Owner');
    await send(`✅ Nomor *+${target}* diaktifkan VIP *${days} hari*.`);
    return true;
  }

  if (cmd === 'delprem' && isOwner) {
    const target = param.replace(/\D/g, '');
    if (!target) return true;
    const u = ensureUserRecord(dbMemory, target);
    u.premiumUntil = 0;
    await saveMemory();
    await send(`🗑️ VIP *+${target}* dinonaktifkan.`);
    return true;
  }

  if (cmd === 'listprem' && isOwner) {
    const now = Date.now();
    const rows = Object.entries(dbMemory.users || {})
      .filter(([, u]) => u.premiumUntil > now)
      .sort((a, b) => b[1].premiumUntil - a[1].premiumUntil)
      .map(([p, u], i) => `${i + 1}. +${p} — ${formatRemainingTime(u.premiumUntil - now)} (s/d ${fmtWib(u.premiumUntil)})`);
    await send(rows.length ? `💎 *MEMBER VIP AKTIF (${rows.length})*\n\n${rows.join('\n')}` : '📭 Belum ada member VIP aktif.');
    return true;
  }

  return true;
}
