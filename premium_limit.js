import http from 'http';
import { fetchWithTimeout } from './engines.js';

export const PREMIUM_COMMANDS = [
  'limit',
  'ceklimit',
  'premium',
  'belipremium',
  'qris',
  'cekstatus',
  'accprem',
  'addprem',
  'delprem',
];

const DAILY_FREE_LIMIT = 15;
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const BASE_PRICE = Number(process.env.PREMIUM_PRICE || 10000);
const STATIC_QRIS_URL = process.env.QRIS_IMAGE_URL || '';
const STATIC_QRIS_PAYLOAD = process.env.QRIS_STATIC_STRING || '';
const PAKASIR_SLUG = process.env.PAKASIR_SLUG || '';
const PAKASIR_API_KEY = process.env.PAKASIR_API_KEY || '';
const WEBHOOK_PORT = Number(process.env.QRIS_WEBHOOK_PORT || 3099);

// Daftar perintah gratis yang tetap bisa diakses saat limit habis
export const LIMIT_EXEMPT_COMMANDS = new Set([
  'menu',
  'help',
  'limit',
  'ceklimit',
  'premium',
  'belipremium',
  'qris',
  'cekstatus',
  'owner',
]);

function getWibDateKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
}

export function ensureUserRecord(dbMemory, senderNum) {
  if (!dbMemory.users) dbMemory.users = {};
  if (!dbMemory.users[senderNum]) {
    dbMemory.users[senderNum] = {
      facts: [],
      city: '',
      dailyDate: getWibDateKey(),
      dailyUsed: 0,
      premiumUntil: 0,
    };
  }
  const u = dbMemory.users[senderNum];
  const today = getWibDateKey();
  if (u.dailyDate !== today) {
    u.dailyDate = today;
    u.dailyUsed = 0;
  }
  if (typeof u.premiumUntil !== 'number') u.premiumUntil = 0;
  return u;
}

export function isUserPremium(user) {
  return Boolean(user && user.premiumUntil && user.premiumUntil > Date.now());
}

export function formatRemainingTime(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  return `${days} hari ${hours} jam ${mins} menit`;
}

// ============================================================
// CEK & POTONG LIMIT HARIAN (15x/HARI SELAIN ADMIN & PREMIUM)
// ============================================================
export async function checkAndConsumeDailyLimit({
  sock,
  jid,
  senderNum,
  isOwner,
  isSenderAdmin,
  cmd,
  msg,
  dbMemory,
  saveMemory,
}) {
  if (!senderNum) return { allowed: true };
  if (isOwner || isSenderAdmin) return { allowed: true, role: 'Admin/Owner' };
  if (LIMIT_EXEMPT_COMMANDS.has(cmd)) return { allowed: true, role: 'Gratis' };

  const user = ensureUserRecord(dbMemory, senderNum);
  if (isUserPremium(user)) {
    return { allowed: true, role: 'Premium' };
  }

  if (user.dailyUsed >= DAILY_FREE_LIMIT) {
    await sock.sendMessage(
      jid,
      {
        text:
          `⛔ *LIMIT HARIAN HABIS (${user.dailyUsed}/${DAILY_FREE_LIMIT})*\n\n` +
          `Pengguna reguler dibatasi maksimal *${DAILY_FREE_LIMIT}x penggunaan per hari* (reset pukul 00:00 WIB).\n\n` +
          `💎 *UPGRADE PREMIUM (UNLIMITED 1 MINGGU)*\n` +
          `• Harga: *Rp ${BASE_PRICE.toLocaleString('id-ID')} / 7 Hari*\n` +
          `• Ketik *\`qris\`* atau *\`belipremium\`* untuk memunculkan kode QRIS.\n` +
          `• Setelah pembayaran masuk, Premium *otomatis aktif 1 minggu* ke nomor kamu!`,
      },
      { quoted: msg }
    );
    return { allowed: false };
  }

  user.dailyUsed += 1;
  await saveMemory();
  return { allowed: true, remaining: DAILY_FREE_LIMIT - user.dailyUsed };
}

// ============================================================
// AKTIVASI PREMIUM 7 HARI (1 MINGGU) OTOMATIS
// ============================================================
export async function activatePremiumForNumber(sock, dbMemory, saveMemory, targetNum, days = 7, source = 'QRIS') {
  const cleanNum = String(targetNum).replace(/\D/g, '');
  if (!cleanNum) return null;

  const user = ensureUserRecord(dbMemory, cleanNum);
  const baseTime = user.premiumUntil > Date.now() ? user.premiumUntil : Date.now();
  user.premiumUntil = baseTime + days * 24 * 60 * 60 * 1000;
  user.dailyUsed = 0;

  if (Array.isArray(dbMemory.pendingInvoices)) {
    dbMemory.pendingInvoices = dbMemory.pendingInvoices.filter((inv) => inv.phone !== cleanNum);
  }
  await saveMemory();

  const expText = new Date(user.premiumUntil).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const userJid = `${cleanNum}@s.whatsapp.net`;

  if (sock) {
    await sock.sendMessage(userJid, {
      text:
        `🎉 *PEMBAYARAN DITERIMA (${source})!*\n\n` +
        `Status akun *+${cleanNum}* sekarang telah ditingkatkan ke *PREMIUM UNLIMITED*.\n` +
        `• Masa Aktif: *${days} Hari (1 Minggu)*\n` +
        `• Berlaku Hingga: *${expText} WIB*\n` +
        `• Limit Harian: *∞ Tanpa Batas*\n\n` +
        `_Setelah 1 minggu, akun akan otomatis kembali ke mode reguler (15 limit/hari)._`,
    }).catch(() => {});
  }

  return user.premiumUntil;
}

// ============================================================
// PEMBUATAN TAGIHAN QRIS OTOMATIS
// ============================================================
async function createQrisInvoice(dbMemory, saveMemory, senderNum, notifyJid) {
  if (!Array.isArray(dbMemory.pendingInvoices)) dbMemory.pendingInvoices = [];

  // Hapus invoice lama milik nomor yang sama
  dbMemory.pendingInvoices = dbMemory.pendingInvoices.filter((i) => i.phone !== senderNum);

  const uniqueCode = Math.floor(Math.random() * 899) + 101; // 101 - 999
  const totalAmount = BASE_PRICE + uniqueCode;
  const orderId = `PREM-${senderNum.slice(-4)}-${Date.now().toString().slice(-6)}`;

  let qrisImageUrl = '';
  let gatewayMode = 'UNIQUE_NOMINAL';

  // Jalur 1: Gateway Pakasir (QRIS Dinamis Otomatis)
  if (PAKASIR_SLUG && PAKASIR_API_KEY) {
    try {
      const res = await fetchWithTimeout(
        'https://app.pakasir.com/api/transactioncreate/qris',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: PAKASIR_SLUG,
            order_id: orderId,
            amount: BASE_PRICE,
            api_key: PAKASIR_API_KEY,
          }),
        },
        12000
      );
      const data = await res.json();
      const qrStr = data?.payment?.payment_number || data?.qr_string;
      if (qrStr) {
        qrisImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=450x450&data=${encodeURIComponent(qrStr)}`;
        gatewayMode = 'PAKASIR';
      }
    } catch {}
  }

  // Jalur 2: Static QRIS Image atau QRIS String dari .env
  if (!qrisImageUrl) {
    if (STATIC_QRIS_URL) {
      qrisImageUrl = STATIC_QRIS_URL;
    } else if (STATIC_QRIS_PAYLOAD) {
      qrisImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=450x450&data=${encodeURIComponent(STATIC_QRIS_PAYLOAD)}`;
    } else {
      const fallbackText = `QRIS-WHUXEN|ORDER:${orderId}|NOMOR:${senderNum}|NOMINAL:${totalAmount}`;
      qrisImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=450x450&data=${encodeURIComponent(fallbackText)}`;
    }
  }

  const invoice = {
    orderId,
    phone: senderNum,
    notifyJid,
    amount: gatewayMode === 'PAKASIR' ? BASE_PRICE : totalAmount,
    gatewayMode,
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 60 * 1000, // Berlaku 30 menit
  };

  dbMemory.pendingInvoices.push(invoice);
  await saveMemory();
  return { invoice, qrisImageUrl };
}

// ============================================================
// PENGAWAS OTOMATIS: CEK PEMBAYARAN QRIS & AUTO-EXPIRE 7 HARI
// ============================================================
let paymentWatcherStarted = false;
let currentSockRef = null;

export function startPremiumAndQrisWatcher(sock, dbMemory, saveMemory) {
  currentSockRef = sock;
  if (paymentWatcherStarted) return;
  paymentWatcherStarted = true;

  // 1. Cek status pembayaran QRIS setiap 12 detik
  setInterval(async () => {
    try {
      if (!Array.isArray(dbMemory.pendingInvoices) || !dbMemory.pendingInvoices.length) return;
      const now = Date.now();

      // Bersihkan tagihan kadaluarsa (> 30 menit)
      const beforeLen = dbMemory.pendingInvoices.length;
      dbMemory.pendingInvoices = dbMemory.pendingInvoices.filter((inv) => inv.expiresAt > now);
      if (dbMemory.pendingInvoices.length !== beforeLen) await saveMemory();

      if (PAKASIR_SLUG && PAKASIR_API_KEY) {
        for (const inv of [...dbMemory.pendingInvoices]) {
          if (inv.gatewayMode !== 'PAKASIR') continue;
          const url = `https://app.pakasir.com/api/transactiondetail?project=${encodeURIComponent(PAKASIR_SLUG)}&amount=${inv.amount}&order_id=${encodeURIComponent(inv.orderId)}&api_key=${encodeURIComponent(PAKASIR_API_KEY)}`;
          const res = await fetchWithTimeout(url, {}, 10000).catch(() => null);
          const data = res ? await res.json().catch(() => null) : null;
          const status = data?.transaction?.status || data?.status || '';
          if (/completed|paid|success|settlement/i.test(status)) {
            await activatePremiumForNumber(currentSockRef, dbMemory, saveMemory, inv.phone, 7, 'QRIS Otomatis');
          }
        }
      }
    } catch {}
  }, 12 * 1000);

  // 2. Cek masa aktif Premium 1 minggu setiap 60 detik (auto-revert ke mode semula)
  setInterval(async () => {
    try {
      if (!dbMemory.users) return;
      const now = Date.now();
      let changed = false;

      for (const [phone, u] of Object.entries(dbMemory.users)) {
        if (u.premiumUntil && u.premiumUntil > 0 && now >= u.premiumUntil) {
          u.premiumUntil = 0;
          u.dailyUsed = 0;
          u.dailyDate = getWibDateKey();
          changed = true;

          if (currentSockRef) {
            await currentSockRef.sendMessage(`${phone}@s.whatsapp.net`, {
              text:
                `⏳ *MASA PREMIUM 1 MINGGU TELAH BERAKHIR*\n\n` +
                `Akun *+${phone}* telah kembali ke *Mode Reguler* (limit ${DAILY_FREE_LIMIT}x penggunaan/hari).\n` +
                `Ketik *\`qris\`* kapan saja jika ingin memperpanjang Premium kembali.`,
            }).catch(() => {});
          }
        }
      }

      if (changed) await saveMemory();
    } catch {}
  }, 60 * 1000);

  // 3. Server Webhook HTTP untuk Notifikasi Mutasi QRIS / Gateway (POST /webhook/qris)
  try {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url?.startsWith('/webhook/qris')) {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', async () => {
          try {
            const payload = JSON.parse(body || '{}');
            const paidAmount = Number(String(payload.amount || payload.nominal || 0).replace(/\D/g, ''));
            const orderId = String(payload.order_id || payload.orderId || '');
            const textNotif = String(payload.text || payload.message || '');

            const matched = (dbMemory.pendingInvoices || []).find(
              (inv) =>
                (orderId && inv.orderId === orderId) ||
                (paidAmount > 0 && inv.amount === paidAmount) ||
                (textNotif && textNotif.includes(String(inv.amount)))
            );

            if (matched) {
              await activatePremiumForNumber(currentSockRef, dbMemory, saveMemory, matched.phone, 7, 'Webhook QRIS');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, activated: matched.phone }));
              return;
            }
          } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, message: 'No matching invoice' }));
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('QRIS Auto-Premium Listener Active');
    });
    server.listen(WEBHOOK_PORT, () => {
      console.log(`💳 QRIS Webhook Listener aktif di port ${WEBHOOK_PORT} (/webhook/qris)`);
    });
  } catch {}
}

// ============================================================
// HANDLER PERINTAH LIMIT & PREMIUM QRIS
// ============================================================
export async function handlePremiumCommand({
  sock,
  jid,
  senderNum,
  isOwner,
  isSenderAdmin,
  cmd,
  param,
  msg,
  dbMemory,
  saveMemory,
}) {
  if (!PREMIUM_COMMANDS.includes(cmd)) return false;

  const user = ensureUserRecord(dbMemory, senderNum);

  if (cmd === 'limit' || cmd === 'ceklimit') {
    if (isOwner || isSenderAdmin) {
      await sock.sendMessage(
        jid,
        { text: `👑 *STATUS AKUN:* Admin / Owner\n• Limit Harian: *∞ Unlimited*` },
        { quoted: msg }
      );
      return true;
    }

    if (isUserPremium(user)) {
      const sisa = formatRemainingTime(user.premiumUntil - Date.now());
      await sock.sendMessage(
        jid,
        {
          text:
            `💎 *STATUS AKUN: PREMIUM AKTIF*\n` +
            `• Limit Harian: *∞ Unlimited*\n` +
            `• Sisa Masa Aktif: *${sisa}*`,
        },
        { quoted: msg }
      );
      return true;
    }

    const sisaLimit = Math.max(0, DAILY_FREE_LIMIT - user.dailyUsed);
    await sock.sendMessage(
      jid,
      {
        text:
          `📊 *INFO LIMIT HARIAN*\n` +
          `• Terpakai Hari Ini: *${user.dailyUsed}/${DAILY_FREE_LIMIT}*\n` +
          `• Sisa Kuota: *${sisaLimit}x penggunaan*\n` +
          `• Status: *Reguler*\n\n` +
          `Ketik *\`qris\`* untuk upgrade *Premium Unlimited 1 Minggu*.`,
      },
      { quoted: msg }
    );
    return true;
  }

  if (cmd === 'premium' || cmd === 'belipremium' || cmd === 'qris') {
    const { invoice, qrisImageUrl } = await createQrisInvoice(dbMemory, saveMemory, senderNum, jid);
    const caption =
      `💳 *PEMBAYARAN PREMIUM QRIS (1 MINGGU)*\n\n` +
      `• Nomor Terdaftar: *+${senderNum}*\n` +
      `• ID Transaksi: \`${invoice.orderId}\`\n` +
      `• Total Transfer: *Rp ${invoice.amount.toLocaleString('id-ID')}*\n` +
      `  _(Harap transfer sesuai nominal persis agar sistem otomatis mendeteksi)_\n` +
      `• Durasi Aktif: *7 Hari (1 Minggu)*\n\n` +
      `✅ Setelah uang masuk, status *Premium Unlimited* otomatis aktif ke nomor *+${senderNum}* dan otomatis kembali ke mode semula setelah 7 hari.`;

    await sock.sendMessage(
      jid,
      {
        image: { url: qrisImageUrl },
        caption,
      },
      { quoted: msg }
    );
    return true;
  }

  if (cmd === 'cekstatus') {
    if (isUserPremium(user)) {
      await sock.sendMessage(
        jid,
        { text: `✅ Akun *+${senderNum}* sudah *PREMIUM AKTIF* (${formatRemainingTime(user.premiumUntil - Date.now())}).` },
        { quoted: msg }
      );
      return true;
    }
    const inv = (dbMemory.pendingInvoices || []).find((i) => i.phone === senderNum);
    await sock.sendMessage(
      jid,
      {
        text: inv
          ? `⏳ Tagihan \`${inv.orderId}\` sebesar *Rp ${inv.amount.toLocaleString('id-ID')}* masih menunggu pembayaran masuk.`
          : `📭 Tidak ada tagihan QRIS aktif. Ketik *\`qris\`* untuk membuat pembayaran.`,
      },
      { quoted: msg }
    );
    return true;
  }

  if ((cmd === 'accprem' || cmd === 'addprem') && isOwner) {
    const parts = param.split(/\s+/);
    const target = (parts[0] || '').replace(/\D/g, '');
    const days = Number(parts[1]) || 7;
    if (!target) {
      await sock.sendMessage(jid, { text: '⚠️ Contoh: `accprem 628123456789` atau `addprem 628123456789 7`' }, { quoted: msg });
      return true;
    }
    await activatePremiumForNumber(sock, dbMemory, saveMemory, target, days, 'Verifikasi Owner');
    await sock.sendMessage(jid, { text: `✅ Nomor *+${target}* berhasil diaktifkan Premium selama *${days} hari*.` }, { quoted: msg });
    return true;
  }

  if (cmd === 'delprem' && isOwner) {
    const target = param.replace(/\D/g, '');
    if (!target) return true;
    const u = ensureUserRecord(dbMemory, target);
    u.premiumUntil = 0;
    await saveMemory();
    await sock.sendMessage(jid, { text: `🗑️ Premium nomor *+${target}* telah dinonaktifkan.` }, { quoted: msg });
    return true;
  }

  return true;
}
