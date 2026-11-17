import http from 'http';
import crypto from 'crypto';
import { fetchWithTimeout } from './engines.js'; // sesuaikan: file yang meng-export fetchWithTimeout

export const PREMIUM_COMMANDS = ['limit', 'ceklimit', 'premium', 'belipremium', 'qris', 'cekstatus', 'konfirmasi', 'accprem', 'addprem', 'delprem'];

const DAILY_FREE_LIMIT = 15;
const DANA_NUMBER = process.env.DANA_NUMBER || '085811980122';
const OWNER_NUMBER = (process.env.OWNER_NUMBER || '').replace(/\D/g, '');
const STATIC_QRIS_URL = process.env.QRIS_IMAGE_URL || '';
const STATIC_QRIS_PAYLOAD = process.env.QRIS_STATIC_STRING || '';
const PAKASIR_SLUG = process.env.PAKASIR_SLUG || '';
const PAKASIR_API_KEY = process.env.PAKASIR_API_KEY || '';
const WEBHOOK_PORT = Number(process.env.QRIS_WEBHOOK_PORT || 3099);
const WEBHOOK_SECRET = process.env.QRIS_WEBHOOK_SECRET || '';
const INVOICE_TTL = 30 * 60 * 1000;
const MANUAL_WINDOW = 6 * 3600 * 1000;
const PAID_RX = /^(completed|paid|success|settlement)$/i;
const rp = (n) => `Rp ${Number(n).toLocaleString('id-ID')}`;

export const PREMIUM_PACKAGES = {
  1: { days: 2, price: 1000, label: '2 Hari' },
  2: { days: 14, price: 5000, label: '2 Minggu' },
  3: { days: 30, price: 10000, label: '1 Bulan' },
};

export const LIMIT_EXEMPT_COMMANDS = new Set([
  'menu', 'help', 'limit', 'ceklimit', 'premium', 'belipremium', 'qris', 'cekstatus', 'konfirmasi', 'owner',
]);

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

/* ───────────── Aktivasi premium ───────────── */

let currentSockRef = null;

export async function activatePremiumForNumber(sock, dbMemory, saveMemory, targetNum, days = 2, source = 'QRIS') {
  const cleanNum = String(targetNum).replace(/\D/g, '');
  if (!cleanNum) return null;

  const user = ensureUserRecord(dbMemory, cleanNum);
  const base = user.premiumUntil > Date.now() ? user.premiumUntil : Date.now();
  user.premiumUntil = base + days * 86400000;
  user.dailyUsed = 0;
  if (Array.isArray(dbMemory.pendingInvoices)) dbMemory.pendingInvoices = dbMemory.pendingInvoices.filter((i) => i.phone !== cleanNum);
  await saveMemory();

  const expText = new Date(user.premiumUntil).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  await (sock || currentSockRef)?.sendMessage(`${cleanNum}@s.whatsapp.net`, {
    text:
      `🎉 *PEMBAYARAN DITERIMA (${source})!*\n\n` +
      `Akun *+${cleanNum}* kini *PREMIUM UNLIMITED*.\n` +
      `• Durasi: *${days} Hari*\n• Berlaku hingga: *${expText} WIB*\n• Limit harian: *∞*\n\n` +
      `_Setelah masa aktif habis, akun kembali ke mode reguler._`,
  }).catch(() => {});
  return user.premiumUntil;
}

/** Atomik: invoice dihapus SEBELUM await → mustahil aktif dua kali. */
async function settleInvoice(dbMemory, saveMemory, orderId, source) {
  const list = dbMemory.pendingInvoices || [];
  const inv = list.find((i) => i.orderId === orderId);
  if (!inv) return null;
  dbMemory.pendingInvoices = list.filter((i) => i.orderId !== orderId);
  await activatePremiumForNumber(currentSockRef, dbMemory, saveMemory, inv.phone, inv.days, source);
  return inv;
}

/** Sumber kebenaran pembayaran otomatis: tanya langsung ke Pakasir (server-to-server). */
async function verifyPakasir(inv) {
  if (!PAKASIR_SLUG || !PAKASIR_API_KEY || inv?.gatewayMode !== 'PAKASIR') return false;
  const url = `https://app.pakasir.com/api/transactiondetail?project=${encodeURIComponent(PAKASIR_SLUG)}&amount=${inv.amount}&order_id=${encodeURIComponent(inv.orderId)}&api_key=${encodeURIComponent(PAKASIR_API_KEY)}`;
  const res = await fetchWithTimeout(url, {}, 10000).catch(() => null);
  const d = res?.ok ? await res.json().catch(() => null) : null;
  const t = d?.transaction || d || {};
  return PAID_RX.test(String(t.status || '')) && (!t.order_id || t.order_id === inv.orderId);
}

/* ───────────── Pembuatan invoice ───────────── */

const qrUrl = (data) => `https://api.qrserver.com/v1/create-qr-code/?size=450x450&data=${encodeURIComponent(data)}`;

async function createQrisInvoice(dbMemory, saveMemory, senderNum, notifyJid, pkg) {
  dbMemory.pendingInvoices = (dbMemory.pendingInvoices || []).filter((i) => i.phone !== senderNum);

  let code;
  do { code = Math.floor(Math.random() * 899) + 101; }
  while (dbMemory.pendingInvoices.some((i) => i.amount === pkg.price + code));

  const orderId = `PREM-${senderNum.slice(-4)}-${Date.now().toString().slice(-6)}`;
  let qrisImageUrl = '';
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
      if (qr) { qrisImageUrl = qrUrl(qr); gatewayMode = 'PAKASIR'; }
    } catch {}
  }

  if (!qrisImageUrl) qrisImageUrl = STATIC_QRIS_URL || (STATIC_QRIS_PAYLOAD ? qrUrl(STATIC_QRIS_PAYLOAD) : '');

  const invoice = {
    orderId,
    phone: senderNum,
    notifyJid,
    amount: gatewayMode === 'PAKASIR' ? pkg.price : pkg.price + code,
    days: pkg.days,
    gatewayMode,
    manual: gatewayMode !== 'PAKASIR',
    ref: '',
    createdAt: Date.now(),
    expiresAt: Date.now() + INVOICE_TTL,
  };
  dbMemory.pendingInvoices.push(invoice);
  await saveMemory();
  return { invoice, qrisImageUrl };
}

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
    } catch {} finally { busy = false; }
  }, 12000);

  setInterval(async () => {
    try {
      if (!dbMemory.users) return;
      const now = Date.now();
      let changed = false;
      for (const [phone, u] of Object.entries(dbMemory.users)) {
        if (u.premiumUntil && now >= u.premiumUntil) {
          u.premiumUntil = 0;
          u.dailyUsed = 0;
          u.dailyDate = getWibDateKey();
          changed = true;
          await currentSockRef?.sendMessage(`${phone}@s.whatsapp.net`, {
            text:
              `⏳ *MASA AKTIF PREMIUM BERAKHIR*\n\nAkun *+${phone}* kembali ke *Mode Reguler* (${DAILY_FREE_LIMIT}x/hari).\n` +
              `Ketik *\`.qris\`* untuk memperpanjang.`,
          }).catch(() => {});
        }
      }
      if (changed) await saveMemory();
    } catch {}
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
        // payload webhook TIDAK dipercaya; wajib lolos verifikasi API Pakasir
        if (inv && (await verifyPakasir(inv))) {
          await settleInvoice(dbMemory, saveMemory, orderId, 'Webhook Pakasir');
          return out(200, { ok: true });
        }
      } catch {}
      out(200, { ok: false });
    });
  }).listen(WEBHOOK_PORT, () => console.log(`💳 Webhook aktif :${WEBHOOK_PORT}/webhook/qris`));
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
      await send(`💎 *STATUS: PREMIUM AKTIF*\n• Limit Harian: *∞ Unlimited*\n• Sisa Masa Aktif: *${formatRemainingTime(user.premiumUntil - Date.now())}*`);
      return true;
    }
    await send(
      `📊 *INFO LIMIT HARIAN*\n• Terpakai: *${user.dailyUsed}/${DAILY_FREE_LIMIT}*\n` +
      `• Sisa: *${Math.max(0, DAILY_FREE_LIMIT - user.dailyUsed)}x*\n• Status: *Reguler*\n\nKetik *\`.qris\`* untuk Premium.`
    );
    return true;
  }

  if (['premium', 'belipremium', 'qris'].includes(cmd)) {
    const pkg = PREMIUM_PACKAGES[Number(param)];
    if (!pkg) {
      await send(
        `💳 *PILIH PAKET PREMIUM*\n\n` +
        Object.entries(PREMIUM_PACKAGES).map(([k, p]) => `${k}️⃣ \`.qris ${k}\` — ${rp(p.price)} *(${p.label})*`).join('\n') +
        `\n\n_Contoh:_ \`.qris 3\``
      );
      return true;
    }
    const { invoice, qrisImageUrl } = await createQrisInvoice(dbMemory, saveMemory, senderNum, jid, pkg);
    const caption =
      `💳 *PEMBAYARAN PREMIUM (${pkg.label})*\n\n` +
      `• ID Transaksi: \`${invoice.orderId}\`\n` +
      `• Total Transfer: *${rp(invoice.amount)}* _(harus persis)_\n` +
      (invoice.manual
        ? `• DANA: *${DANA_NUMBER}*\n\nSetelah transfer, kirim:\n\`.konfirmasi <6 digit terakhir ID transaksi DANA>\`\nOwner memverifikasi mutasi, lalu Premium aktif.\n⏱️ Tagihan berlaku 30 menit.`
        : `\n✅ Premium aktif *otomatis* setelah pembayaran terverifikasi (±1 menit).\n⏱️ Tagihan berlaku 30 menit.`);
    await sock.sendMessage(jid, qrisImageUrl ? { image: { url: qrisImageUrl }, caption } : { text: caption }, { quoted: msg });
    return true;
  }

  if (cmd === 'konfirmasi') {
    const ref = param.replace(/\D/g, '');
    const inv = (dbMemory.pendingInvoices || []).find((i) => i.phone === senderNum && i.manual);
    if (!inv) { await send('📭 Tidak ada tagihan manual aktif. Ketik `.qris` dulu.'); return true; }
    if (inv.ref) { await send('⏳ Bukti sudah dikirim, menunggu verifikasi owner.'); return true; }
    if (ref.length < 6) { await send('⚠️ Contoh: `.konfirmasi 123456` (6+ digit terakhir ID transaksi DANA)'); return true; }
    dbMemory.usedRefs ||= {};
    if (dbMemory.usedRefs[ref]) { await send('⛔ Referensi ini sudah pernah dipakai.'); return true; }
    dbMemory.usedRefs[ref] = inv.orderId;
    inv.ref = ref;
    inv.expiresAt = Date.now() + MANUAL_WINDOW;
    await saveMemory();
    if (OWNER_NUMBER) {
      await sock.sendMessage(`${OWNER_NUMBER}@s.whatsapp.net`, {
        text:
          `🔔 *KONFIRMASI BAYAR*\n+${senderNum}\nNominal: ${rp(inv.amount)}\nRef DANA: ${ref}\nPaket: ${inv.days} hari\n\n` +
          `Cocokkan dengan mutasi DANA, lalu:\n\`.accprem ${inv.orderId}\``,
      }).catch(() => {});
    }
    await send('⏳ Bukti diterima, menunggu verifikasi owner.');
    return true;
  }

  if (cmd === 'cekstatus') {
    if (isUserPremium(user)) { await send(`✅ Akun *+${senderNum}* PREMIUM AKTIF (${formatRemainingTime(user.premiumUntil - Date.now())}).`); return true; }
    const inv = (dbMemory.pendingInvoices || []).find((i) => i.phone === senderNum);
    await send(inv
      ? `⏳ Tagihan \`${inv.orderId}\` *${rp(inv.amount)}* (${inv.days} hari) ${inv.ref ? 'menunggu verifikasi owner' : 'menunggu pembayaran'}.`
      : '📭 Tidak ada tagihan aktif. Ketik `.qris` untuk melihat paket.');
    return true;
  }

  if ((cmd === 'accprem' || cmd === 'addprem') && isOwner) {
    if (/^PREM-/i.test(param)) {
      const inv = await settleInvoice(dbMemory, saveMemory, param.split(/\s+/)[0], 'Verifikasi Owner');
      await send(inv ? `✅ +${inv.phone} aktif Premium ${inv.days} hari.` : '❌ Invoice tidak ditemukan / sudah diproses.');
      return true;
    }
    const [t, d] = param.split(/\s+/);
    const target = (t || '').replace(/\D/g, '');
    const days = Number(d) || 2;
    if (!target) { await send('⚠️ Contoh: `.accprem PREM-1234-567890` atau `.addprem 628123456789 30`'); return true; }
    await activatePremiumForNumber(sock, dbMemory, saveMemory, target, days, 'Verifikasi Owner');
    await send(`✅ Nomor *+${target}* diaktifkan Premium *${days} hari*.`);
    return true;
  }

  if (cmd === 'delprem' && isOwner) {
    const target = param.replace(/\D/g, '');
    if (!target) return true;
    ensureUserRecord(dbMemory, target).premiumUntil = 0;
    await saveMemory();
    await send(`🗑️ Premium *+${target}* dinonaktifkan.`);
    return true;
  }

  return true;
}
