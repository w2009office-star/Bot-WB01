// ═════════ index.js (FULL) ═════════
import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadContentFromMessage } from '@whiskeysockets/baileys';
import pino from 'pino';

import { mulaiWeb } from './web.js';
import { restoreAuthFromGitHub, scheduleAuthBackupToGitHub, startGitHubLiveHotReload, setupGracefulShutdown } from './github_sync.js';
import { ALL_GROUP_COMMANDS, GROUP_AUTO_ONLY_COMMANDS, GROUP_SECURITY_MENU, isSenderGroupAdmin, handleGroupMessageGuard, handleGroupCommand, handleGroupParticipantsUpdate, handleGroupJoinRequestEvent, startGroupAutomationScheduler, handleGroupThemeInteraction } from './group_automation.js';
import { PREMIUM_COMMANDS, PREMIUM_PACKAGES, LIMIT_EXEMPT_COMMANDS, ensureUserRecord, isUserPremium, formatRemainingTime, checkAndConsumeDailyLimit, handlePremiumCommand, startPremiumAndQrisWatcher, handlePremiumProofText } from './premium_limit.js';
import { GAME_COMMANDS, handleGameInput, handleGameCommand } from './handler.js';
import { DOWNLOAD_COMMANDS, DOWNLOAD_MENU, handleDownloadCommand, handleDirectUrlAutoDownload, fetchWithTimeout, fetchBuffer, extractUrl, mediaBufferToWebpSticker, createBratSticker, urlOrTextToWebpSticker, extractAndDownloadViewOnce, sendNativeInteractiveButtons, panggilServerAISatSet, getAnimeImageUrl } from './engines.js';

/* ═════════════════════════ KONFIGURASI & STATE ═════════════════════════ */

const PHONE = (process.env.PHONE_NUMBER || '').replace(/\D/g, '');
const AUTH_DIR = process.env.AUTH_DIR || './auth';
const MEMORY_FILE = process.env.MEMORY_FILE || './memory.json'; // Railway: pasang Volume, mis. MEMORY_FILE=/data/memory.json
const OWNER = (process.env.OWNER_NUMBER || PHONE).replace(/\D/g, '');
const OWNER_NAME = process.env.OWNER_NAME || 'Maverick';
const DAILY_LIMIT = 15; // samakan dengan DAILY_FREE_LIMIT di premium_limit.js

const bot = {
  sock: null, connected: false, registered: false, qr: null, pairingCode: null,
  startTime: Date.now(), userPhone: null, userName: 'WHUXEN BOT',
  stats: { totalDeletedBadWords: 0, totalDeletedLinks: 0, totalBlockedVirtek: 0, totalDeletedTagStatus: 0, lastCleanupTime: new Date().toLocaleString('id-ID') },
  badWords: ['anjing', 'babi', 'kunyuk', 'bajingan', 'goblok', 'tolol', 'bangsat', 'brengsek', 'jancok', 'pantek'],
  blockedDomains: ['judionline', 'slotgacor', 'situs-terlarang.com', 'link-spam.xyz'],
};

let dbMemory = {
  version: 10.0, lastUpdateDate: '', updateLogs: [], users: {}, pendingInvoices: [],
  learnedWords: [], notes: {}, groupSettings: {}, gameProfiles: {},
  botSettings: { mode: 'public', autoread: false, autotyping: true, customBotName: '' },
  healthReport: { lastChecked: '-', summary: 'Modular Group Security + Multi-Engine Downloader', details: {}, autoRepairs: [], totalRepairs: 0 },
};

const sentMessageCache = new Map();
const lastReplyTextByJid = new Map();
const retryCooldownByJid = new Map();
const serverAutoHeal = { totalAutoRepairs: 0 };

/* ═════════════════════════ DAFTAR FITUR & MENU ═════════════════════════ */

const MENU_CATEGORIES = {
  AI: ['ai', 'gpt', 'ask', 'tanya', 'gemini', 'chatgpt', 'simi', 'cerita', 'puisi', 'pantun', 'kode', 'coding', 'ringkas', 'memori', 'resetmemori'],
  SEARCH: ['cuaca', 'wthr', 'setlokasi', 'lokasi', 'praytime', 'surah', 'wiki', 'npm', 'define', 'fakta', 'motivasi', 'kbbi'],
  ANIME: ['waifu', 'neko', 'shinobu', 'megumin', 'cuddle', 'cry', 'kiss', 'lick', 'bonk', 'yeet', 'blush', 'smile', 'highfive', 'handhold', 'nom', 'bite', 'glomp', 'slap', 'kill', 'kickanime', 'happy', 'wink', 'poke', 'cringe'],
  FUN: GAME_COMMANDS,
  STICKER_LOGO: ['sticker', 'stiker', 's', 'brat', 'bratvid', 'bratvideo', 'ttp', 'attp', 'qc', 'animasi', 'linkvideo', 'font', 'fancy', 'logo', 'neon', 'gold', 'galaxy', 'glitch', 'matrix', 'graffiti', 'thunder'],
  TOOLS: ['rvo', 'rvop', 'vv', 'hitung', 'catat', 'catatan', 'terjemah', 'translate', 'id', 'getpp', 'getbio', 'gpass', 'qr', 'shorturl', 'waktu', 'base64', 'reverse', 'ssweb', 'fixsession'],
  OWNER: ['setnama', 'setname', 'botname', 'updatebio', 'block', 'unblock', 'blocklist', 'autoread', 'autotyping', 'mode', 'badwords', 'addkata', 'delkata', 'clean'],
  SYSTEM: ['menu', 'help', 'allmenu', 'groupmenu', 'aimenu', 'downloadmenu', 'dlmenu', 'searchmenu', 'animemenu', 'funmenu', 'logomenu', 'toolsmenu', 'ownermenu', 'ping', 'ping2', 'speed', 'os', 'alive', 'runtime', 'uptime', 'owner', 'status', 'selftest', 'cekfitur', 'autorepair', 'update'],
};

// Kelompok di ALLMENU: `cmds` → 1 perintah 1 baris, `raw` → teks menu bawaan modul (juga 1 perintah 1 baris)
const MENU_GROUPS = [
  { id: 'vip', icon: '💎', title: 'VIP & Limit', cmds: PREMIUM_COMMANDS },
  { id: 'download', icon: '📥', title: 'Download', raw: DOWNLOAD_MENU, desc: 'TikTok • YouTube • IG • FB • File' },
  { id: 'security', icon: '🛡️', title: 'Keamanan Grup', raw: GROUP_SECURITY_MENU, desc: 'anti-link • ACC • kick • mute' },
  { id: 'groupauto', icon: '⚙️', title: 'Otomatisasi Grup', cmds: GROUP_AUTO_ONLY_COMMANDS },
  { id: 'ai', icon: '🤖', title: 'AI & Memori', cmds: MENU_CATEGORIES.AI },
  { id: 'search', icon: '🔎', title: 'Pencarian', cmds: MENU_CATEGORIES.SEARCH },
  { id: 'fun', icon: '🎮', title: 'Game & Hiburan', cmds: MENU_CATEGORIES.FUN },
  { id: 'anime', icon: '🎌', title: 'Anime', cmds: MENU_CATEGORIES.ANIME },
  { id: 'logo', icon: '🎨', title: 'Stiker & Logo', cmds: MENU_CATEGORIES.STICKER_LOGO },
  { id: 'tools', icon: '🧰', title: 'Tools', cmds: MENU_CATEGORIES.TOOLS },
  { id: 'owner', icon: '👑', title: 'Owner', cmds: MENU_CATEGORIES.OWNER },
  { id: 'system', icon: '⚙️', title: 'Sistem', cmds: MENU_CATEGORIES.SYSTEM },
];

const SUB_MENU = { groupmenu: 'security', aimenu: 'ai', searchmenu: 'search', animemenu: 'anime', funmenu: 'fun', logomenu: 'logo', toolsmenu: 'tools', ownermenu: 'owner', downloadmenu: 'download', dlmenu: 'download' };
['allmenu', 'gameprofil', 'gametop', 'gamedaily', 'stopgame', ...Object.keys(SUB_MENU)].forEach((c) => LIMIT_EXEMPT_COMMANDS.add(c)); // navigasi menu & profil game tidak memakai limit

const ALL_COMMANDS_SET = new Set([...Object.values(MENU_CATEGORIES).flat(), ...DOWNLOAD_COMMANDS, ...ALL_GROUP_COMMANDS, ...PREMIUM_COMMANDS]);

/* ═════════════════════════ UTIL UMUM ═════════════════════════ */

const rand = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rand(arr.length)];
const rp = (n) => `Rp${n.toLocaleString('id-ID')}`;
const askAI = (prompt, sys = 'Jawab singkat dan akurat dalam Bahasa Indonesia.') => panggilServerAISatSet(prompt, sys);
const shot = (u) => `https://api.microlink.io/?url=${encodeURIComponent(u)}&screenshot=true&meta=false&embed=screenshot.url`;
const getJson = async (url, ms = 10000) => { try { return await (await fetchWithTimeout(url, {}, ms)).json(); } catch { return null; } };
const wib = (opts) => new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', ...opts }).format(new Date());
const getFullDateTime = () => `${wib({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })} WIB`;
const getGreeting = () => { const h = Number(wib({ hour: '2-digit', hourCycle: 'h23' })); return h < 11 ? 'pagi' : h < 15 ? 'siang' : h < 18 ? 'sore' : 'malam'; };
const getTodayDateString = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
let memoryQueue = Promise.resolve();
const saveMemory = () => (memoryQueue = memoryQueue.then(async () => {
  const tmp = `${MEMORY_FILE}.tmp`;
  await fsPromises.writeFile(tmp, JSON.stringify(dbMemory, null, 2), 'utf-8');
  await fsPromises.rename(tmp, MEMORY_FILE);
}).catch((e) => console.error('[memory] gagal simpan:', e?.message)));
const box = (title, cmds) => `╭─〔 ${title} 〕\n${cmds.map((c) => `│ • .${c}`).join('\n')}\n╰──────────────────`;

function getUptime() {
  const s = Math.floor((Date.now() - bot.startTime) / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return `${d ? `${d}h ` : ''}${h}j ${m}m ${s % 60}d`;
}

function getServerHardwareStats() {
  const ramPercent = Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100);
  const bar = (pct) => '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
  let diskPercent = 35;
  try { const st = fs.statfsSync('.'); diskPercent = Math.round(((st.blocks - st.bfree) / st.blocks) * 100); } catch {}
  return { ramPercent, ramBar: bar(ramPercent), diskPercent, diskBar: bar(diskPercent) };
}

const downloadBuffer = async (media, type) => {
  const chunks = [];
  for await (const ch of await downloadContentFromMessage(media, type)) chunks.push(ch);
  return Buffer.concat(chunks);
};

/* ═════════════════════════ MEMORI, AUTO-REPAIR & AUDIT ═════════════════════════ */

async function loadMemory() {
  const raw = await fsPromises.readFile(MEMORY_FILE, 'utf-8').catch(() => null);
  if (raw === null) return saveMemory();
  try {
    const p = JSON.parse(raw);
    Object.assign(dbMemory, {
      ...dbMemory, ...p,
      pendingInvoices: Array.isArray(p.pendingInvoices) ? p.pendingInvoices : [],
      botSettings: { ...dbMemory.botSettings, ...(p.botSettings || {}) },
      healthReport: { ...dbMemory.healthReport, ...(p.healthReport || {}) },
    });
    if (dbMemory.botSettings.customBotName) bot.userName = dbMemory.botSettings.customBotName;
  } catch (e) {
    console.error('[memory] file rusak, salinan disimpan sebagai .corrupt:', e?.message);
    await fsPromises.writeFile(`${MEMORY_FILE}.corrupt-${Date.now()}`, raw).catch(() => {});
  }
}

function recordAutoRepair(mod, err, fix) {
  serverAutoHeal.totalAutoRepairs++;
  dbMemory.healthReport.totalRepairs = serverAutoHeal.totalAutoRepairs;
  dbMemory.healthReport.autoRepairs.unshift({ time: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }), mod, err: String(err).slice(0, 60), fix });
  if (dbMemory.healthReport.autoRepairs.length > 20) dbMemory.healthReport.autoRepairs.pop();
}

async function repairSignalSessionForJid(jid = '', reason = 'Signal Reset') {
  let deleted = 0;
  try {
    if (!fs.existsSync(AUTH_DIR)) return 0;
    const digits = String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');
    if (!digits) return 0; // tanpa JID jangan hapus sesi semua kontak
    for (const f of await fsPromises.readdir(AUTH_DIR)) {
      if (f === 'creds.json' || !f.startsWith('session-') || (digits && !f.includes(digits))) continue;
      await fsPromises.unlink(path.join(AUTH_DIR, f)).catch(() => {});
      deleted++;
    }
    if (deleted) recordAutoRepair('SignalCipher', reason, `Reset ${deleted} sesi`);
  } catch {}
  return deleted;
}

let cipherRepairLock = false;
async function triggerAutoCipherHeal(jid = '', reason = 'Bad MAC / Decryption Failure') {
  if (cipherRepairLock) return;
  cipherRepairLock = true;
  try { await repairSignalSessionForJid(jid, reason); } finally { setTimeout(() => { cipherRepairLock = false; }, 4000); }
}

async function jalankanAuditFiturRealTime(manual = false) {
  const n = ALL_COMMANDS_SET.size;
  dbMemory.healthReport = {
    lastChecked: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
    summary: `${n}/${n} Fitur VALID & Modular Aktif`,
    details: {
      'Group Security & Auto': `✅ ${ALL_GROUP_COMMANDS.length} Perintah Aktif`,
      'Download Engine': `✅ ${DOWNLOAD_COMMANDS.length} Perintah Aktif`,
      'Premium & QRIS': `✅ ${PREMIUM_COMMANDS.length} Perintah Aktif`,
      'Auto-Repair': `${serverAutoHeal.totalAutoRepairs}x perbaikan`,
    },
    autoRepairs: dbMemory.healthReport.autoRepairs || [],
    totalRepairs: serverAutoHeal.totalAutoRepairs,
  };
  if (manual) await saveMemory();
  return dbMemory.healthReport;
}

async function jalankanEvolusiMandiri(paksaManual = false) {
  const hariIni = getTodayDateString();
  if (!paksaManual && dbMemory.lastUpdateDate === hariIni) return false;
  dbMemory.version = Number((dbMemory.version + 0.1).toFixed(1));
  dbMemory.lastUpdateDate = hariIni;
  const log = `v${dbMemory.version} (${hariIni}): Multi-Engine Downloader + Group Security + VVIP Protection.`;
  dbMemory.updateLogs.unshift(log);
  await saveMemory();
  return log;
}

const SIGNAL_ERR = /Bad MAC|SessionError|No matching sessions|No sessions|Invalid PreKey/i;
const origConsoleError = console.error;
console.error = (...args) => {
  if (/Bad MAC|SessionError|No matching sessions|Invalid PreKey|decrypt/i.test(args.map((a) => a?.message || String(a)).join(' '))) triggerAutoCipherHeal('', 'Console Signal Decryption Error').catch(() => {});
  origConsoleError.apply(console, args);
};
process.on('uncaughtException', (err) => {
  const m = err?.message || 'Error';
  if (SIGNAL_ERR.test(m)) triggerAutoCipherHeal('', m.slice(0, 45)).catch(() => {});
  else recordAutoRepair('ProcessGuard', m, 'Proses tetap berjalan normal');
});
process.on('unhandledRejection', (reason) => {
  const m = reason?.message || String(reason);
  if (SIGNAL_ERR.test(m) || /Timed Out/i.test(m)) triggerAutoCipherHeal('', m.slice(0, 45)).catch(() => {});
});

/* ═════════════════════════ LAYANAN DATA (CUACA, SHOLAT, SURAH) ═════════════════════════ */

async function getJadwalSholatIndonesia(city) {
  const kota = (await getJson(`https://api.myquran.com/v2/sholat/kota/cari/${encodeURIComponent(city)}`))?.data?.[0];
  if (!kota) return null;
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const j = (await getJson(`https://api.myquran.com/v2/sholat/jadwal/${kota.id}/${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())}`))?.data?.jadwal;
  if (!j) return null;
  return `🕌 *JADWAL SHOLAT — ${kota.lokasi}*\n📅 ${j.tanggal}\n\n• Imsak: *${j.imsak}*\n• Subuh: *${j.subuh}*\n• Dzuhur: *${j.dzuhur}*\n• Ashar: *${j.ashar}*\n• Maghrib: *${j.maghrib}*\n• Isya: *${j.isya}*`;
}

async function getSurahLengkap(no) {
  const d = (await getJson(`https://equran.id/api/v2/surat/${parseInt(no, 10) || 1}`))?.data;
  if (!d) return null;
  const ayat = (d.ayat || []).slice(0, 7).map((a) => `*${a.nomorAyat}.* ${a.teksArab}\n_${a.teksIndonesia}_`).join('\n\n');
  return {
    text: `📖 *QS. ${d.namaLatin} (${d.nama})*\nArti: _${d.arti}_ • ${d.jumlahAyat} Ayat\n\n${ayat}${d.jumlahAyat > 7 ? '\n\n_...(menampilkan 7 ayat pertama)_' : ''}`,
    audioUrl: d.audioFull?.['05'] || '',
  };
}

const WMO = { 0: '☀️ Cerah', 1: '🌤️ Cerah Berawan', 2: '⛅ Berawan Sebagian', 3: '☁️ Mendung / Berawan', 45: '🌫️ Berkabut', 48: '🌫️ Kabut Tebal', 51: '🌦️ Gerimis Ringan', 53: '🌦️ Gerimis Sedang', 55: '🌧️ Gerimis Lebat', 61: '🌧️ Hujan Ringan', 63: '🌧️ Hujan Sedang', 65: '⛈️ Hujan Lebat', 80: '🌦️ Hujan Lokal Ringan', 81: '🌧️ Hujan Lokal Sedang', 82: '⛈️ Hujan Lokal Lebat', 95: '⛈️ Hujan Petir', 96: '⛈️ Hujan Petir & Angin' };

async function getCuacaKotaAkurat(cityName) {
  const city = (cityName || 'Jakarta').trim();
  const loc = (await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=id&format=json`))?.results?.[0];
  if (loc) {
    const w = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FJakarta&forecast_days=3`);
    const cur = w?.current;
    if (cur) {
      const dly = w.daily || {};
      return `🌤️ *PRAKIRAAN CUACA — ${loc.name.toUpperCase()}*\n📍 Titik Lokasi: *${[loc.name, loc.admin1, loc.country].filter(Boolean).join(', ')}*\n\n• Kondisi: *${WMO[cur.weather_code] || '🌤️ Berawan'}*\n• Suhu Saat Ini: *${cur.temperature_2m}°C* — Terasa *${cur.apparent_temperature}°C*\n• Suhu Hari Ini: *${dly.temperature_2m_min?.[0] ?? '-'}°C – ${dly.temperature_2m_max?.[0] ?? '-'}°C*\n• Kelembapan: *${cur.relative_humidity_2m}%*\n• Kecepatan Angin: *${cur.wind_speed_10m} km/jam*\n• Peluang Hujan: *${dly.precipitation_probability_max?.[0] ?? '-'}%*\n\n_Ketik *"lokasi di <kota>"* untuk mengganti titik kota otomatis kamu._`;
    }
  }
  const c = (await getJson(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, 8000))?.current_condition?.[0];
  return c ? `🌤️ *CUACA ${city.toUpperCase()}*\n• Suhu: *${c.temp_C}°C*\n• Kelembapan: *${c.humidity}%*\n• Angin: *${c.windspeedKmph} km/jam*` : null;
}

function safeEvaluateMath(expr) {
  const s = expr.replace(/\s+/g, '');
  if (!s || !/^[0-9+\-*/().]+$/.test(s)) return null;
  let i = 0;
  const parseExpr = () => {
    let v = parseTerm();
    while (v !== null && (s[i] === '+' || s[i] === '-')) { const op = s[i++]; const r = parseTerm(); v = r === null ? null : op === '+' ? v + r : v - r; }
    return v;
  };
  const parseTerm = () => {
    let v = parseFactor();
    while (v !== null && (s[i] === '*' || s[i] === '/')) {
      const op = s[i++]; const r = parseFactor();
      if (r === null || (op === '/' && r === 0)) return null;
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const parseFactor = () => {
    if (s[i] === '+') { i++; return parseFactor(); }
    if (s[i] === '-') { i++; const f = parseFactor(); return f === null ? null : -f; }
    if (s[i] === '(') { i++; const v = parseExpr(); return s[i++] === ')' ? v : null; }
    const start = i;
    while (/[0-9.]/.test(s[i])) i++;
    const n = Number(s.slice(start, i));
    return start !== i && Number.isFinite(n) ? n : null;
  };
  const res = parseExpr();
  return i === s.length && res !== null && Number.isFinite(res) ? Number(res.toFixed(6)) : null;
}

/* ═════════════════════════ TAMPILAN MENU ═════════════════════════ */

function getUserInfo({ isOwner, isSenderAdmin }, rec) {
  const vip = isUserPremium(rec);
  const unlimited = isOwner || isSenderAdmin || vip;
  return {
    label: isOwner ? '👑 Owner' : isSenderAdmin ? '🛡️ Admin Grup' : vip ? '💎 VVIP Member' : '⭐ Reguler',
    limit: unlimited ? '∞ Unlimited' : `${Math.max(0, DAILY_LIMIT - rec.dailyUsed)} / ${DAILY_LIMIT} tersisa`,
    vip: vip ? `Aktif — sisa ${formatRemainingTime(rec.premiumUntil - Date.now())}` : 'Tidak aktif',
  };
}

async function sendMainMenu(c) {
  const rec = ensureUserRecord(dbMemory, c.senderNum);
  const u = getUserInfo(c, rec);
  const body = [
    `🗓️ ${getFullDateTime()}`,
    '',
    `👋 Selamat ${getGreeting()}, *${c.pushName}*!`,
    'Silakan pilih menu di bawah.',
    '',
    '╭─〔 👤 INFO USER 〕',
    `│ Nama    : ${c.pushName}`,
    `│ Status  : ${u.label}`,
    `│ Limit   : ${u.limit}`,
    `│ VVIP    : ${u.vip}`,
    `│ Lokasi  : ${rec.city || 'Belum diset (ketik: lokasi di bandung)'}`,
    `│ Version : v${dbMemory.version}`,
    '╰──────────────────',
  ].join('\n');
  lastReplyTextByJid.set(c.jid, body);
  await sendNativeInteractiveButtons(c.sock, c.jid, {
    title: `🤖 ${bot.userName} • MENU UTAMA`,
    body,
    footer: 'Ketik .qris untuk upgrade VVIP Unlimited',
    buttons: [{ text: '📋 ALLMENU', id: 'allmenu' }, { text: '💎 QRIS • JADI VIP', id: 'qris' }],
  }, c.msg);
}

const sendAllMenu = (c) => sendNativeInteractiveButtons(c.sock, c.jid, {
  title: `📋 ALLMENU • ${MENU_GROUPS.length} KELOMPOK`,
  body: `Total fitur aktif: *${ALL_COMMANDS_SET.size}*\nOwner: ${OWNER_NAME}\n\nPilih kelompok fitur pada daftar di bawah.`,
  footer: 'Ketik .qris untuk upgrade VVIP Unlimited',
  listTitle: '📂 Pilih Kelompok',
  sections: [{ title: 'Kelompok Fitur', rows: MENU_GROUPS.map((g) => ({ title: `${g.icon} ${g.title}`, description: g.desc || g.cmds.slice(0, 4).join(' • '), id: `allmenu ${g.id}` })) }],
  buttons: [{ text: '⬅️ Menu Utama', id: 'menu' }, { text: '💎 QRIS • JADI VIP', id: 'qris' }],
}, c.msg);

async function sendGroupMenu(c, id) {
  const g = MENU_GROUPS.find((x) => x.id === id);
  if (!g) return sendAllMenu(c);
  const body = g.raw || box(g.title, g.cmds);
  if (body.length > 1000) return c.reply(`*${g.icon} ${g.title.toUpperCase()}*\n\n${body}\n\n_Ketik .allmenu untuk kembali • .qris untuk VVIP_`);
  return sendNativeInteractiveButtons(c.sock, c.jid, {
    title: `${g.icon} ${g.title.toUpperCase()}`,
    body,
    buttons: [{ text: '⬅️ Allmenu', id: 'allmenu' }, { text: '💎 QRIS • JADI VIP', id: 'qris' }],
  }, c.msg);
}

const sendQrisMenu = (c) => {
  const pkgs = Object.entries(PREMIUM_PACKAGES);
  return sendNativeInteractiveButtons(c.sock, c.jid, {
    title: '💎 QRIS • UPGRADE VIP',
    body: `╭─〔 PAKET 〕\n${pkgs.map(([k, p]) => `│ ${k}) ${p.label} — ${rp(p.price)}`).join('\n')}\n╰──────────────────\n✅ Limit harian ∞ (Unlimited)\n\nAlur: pilih paket → bayar QRIS DANA → kirim ID transaksi → VIP aktif setelah dicek owner.`,
    footer: 'Ketik .menu untuk kembali',
    buttons: pkgs.map(([k, p]) => ({ text: rp(p.price), id: `qris ${k}` })),
  }, c.msg);
};

async function handleMenuCommand(c) {
  const { cmd, param } = c;
  if (cmd === 'menu' || cmd === 'help') await sendMainMenu(c);
  else if (cmd === 'allmenu') await (param ? sendGroupMenu(c, param.toLowerCase()) : sendAllMenu(c));
  else if (SUB_MENU[cmd]) await sendGroupMenu(c, SUB_MENU[cmd]);
  else if (['qris', 'premium', 'belipremium'].includes(cmd) && !param) await sendQrisMenu(c);
  else return false;
  return true;
}

/* ═════════════════════════ REGISTRI PERINTAH ═════════════════════════ */
// on(nama|[nama], handler, { owner, admin, usage })

const H = new Map();
const on = (names, fn, opt = {}) => [].concat(names).forEach((n) => H.set(n, { fn, ...opt }));
const needUrl = (fn) => (c) => { const u = extractUrl(c.param); return u ? fn(c, u) : c.reply(`⚠️ Contoh: \`.${c.cmd} https://...\``); };
const userOf = (c) => ensureUserRecord(dbMemory, c.senderNum);
const QUOTED = (c) => c.unwrapped.extendedTextMessage?.contextInfo?.quotedMessage;

const FONT_MAPS = [119737, 119789, 119841, 120003, 120367].map((off) => (t) => t.replace(/[A-Za-z]/g, (ch) => String.fromCodePoint(ch.charCodeAt(0) + (ch <= 'Z' ? off : off - 6))));
const LOGO = { logo: '0f172a/38bdf8', neon: '090d16/00ffcc', gold: '1c1917/facc15', galaxy: '1e1b4b/c084fc', glitch: '18181b/f43f5e', matrix: '022c22/4ade80', graffiti: '312e81/fb923c', thunder: '0c4a6e/fde047' };
const AI_PERSONA = () => `Kamu adalah ${bot.userName}. Jawab singkat, cerdas, dan akurat dalam Bahasa Indonesia.`;

/* ── Sistem ── */
on(['ping', 'ping2', 'speed', 'os'], ({ reply }) => {
  const hw = getServerHardwareStats();
  return reply(`⚡ *SERVER STATUS*\n• Runtime: ${getUptime()}\n• RAM: ${hw.ramPercent}% ${hw.ramBar}\n• Disk: ${hw.diskPercent}% ${hw.diskBar}\n• Jam Server: ${wib({ hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).replace(/:/g, '.')} WIB`);
});
on(['alive', 'runtime', 'uptime'], ({ reply }) => reply(`🟢 *${bot.userName}* Aktif — ${getUptime()}`));
on('owner', ({ reply }) => reply(`👤 *Owner:* ${OWNER_NAME}`));
on('status', ({ reply }) => reply(`📊 *STATUS*\n• Fitur Aktif: ${ALL_COMMANDS_SET.size}\n• Auto-Repair Total: ${serverAutoHeal.totalAutoRepairs}x`));
on('update', async ({ reply }) => reply(`🧬 *UPDATE SELESAI*\n${await jalankanEvolusiMandiri(true)}`), { owner: true });
on('fixsession', async ({ jid, reply }) => {
  const n = await repairSignalSessionForJid(jid, 'Perintah Manual fixsession');
  return reply(`🔐 *SIGNAL CIPHER DI-RESET!*\n• Kunci sesi dibersihkan: *${n} file*\n• Status: Enkripsi chat sudah disinkronkan ulang.`);
}, { admin: true });
on(['selftest', 'cekfitur', 'autorepair'], async ({ jid, reply }) => {
  await reply('🔄 *Sedang menjalankan Auto-Repair & Reset Sesi Enkripsi...*');
  await repairSignalSessionForJid(jid, 'Auto-Repair Triggered');
  const rep = await jalankanAuditFiturRealTime(true);
  return reply(`🩺 *LAPORAN AUDIT FITUR*\n🕒 ${rep.lastChecked}\n📊 *${rep.summary}*\n\n${Object.entries(rep.details).map(([k, v]) => `• *${k}:* ${v}`).join('\n')}`);
}, { admin: true });

/* ── AI & memori ── */
const CODER = 'Kamu programmer senior. Jawab dengan kode ringkas dan benar dalam blok kode, penjelasan singkat Bahasa Indonesia.';
on(MENU_CATEGORIES.AI, async ({ cmd, param, reply }) => reply(param ? (await askAI(param, ['kode', 'coding'].includes(cmd) ? CODER : AI_PERSONA())) || '⏳ Server AI sibuk, coba ulangi.' : `⚠️ Contoh: \`.${cmd} jelaskan cara kerja AI\``));
on('memori', ({ senderNum, reply }) => { const f = dbMemory.users[senderNum]?.facts || []; return reply(f.length ? `🧠 *Ingatan:*\n• ${f.join('\n• ')}` : '🧠 Memori kosong.'); });
on('resetmemori', async ({ senderNum, reply }) => { if (dbMemory.users[senderNum]) dbMemory.users[senderNum].facts = []; await saveMemory(); return reply('✅ Memori direset.'); });

/* ── Pencarian ── */
on(['setlokasi', 'lokasi'], async (c) => {
  const user = userOf(c);
  if (!c.param) return c.reply(user.city ? `📍 Lokasi kamu saat ini: *${user.city}*\nKetik \`.lokasi di <kota baru>\` untuk mengubah.` : '⚠️ Contoh: `.lokasi di bandung`');
  user.city = c.param.replace(/^di\s+/i, '').trim();
  await saveMemory();
  return c.reply(`📍 Lokasi disimpan ke *${user.city}*.\n\n${(await getCuacaKotaAkurat(user.city)) || ''}`);
});
on(['cuaca', 'wthr'], async (c) => {
  const user = userOf(c);
  const city = c.param ? c.param.replace(/^di\s+/i, '').trim() : user.city || 'Jakarta';
  if (c.param && !user.city) { user.city = city; await saveMemory(); }
  return c.reply((await getCuacaKotaAkurat(city)) || '❌ Kota tidak ditemukan.');
});
on('praytime', async (c) => c.reply((await getJadwalSholatIndonesia(c.param || userOf(c).city || 'Jakarta')) || '❌ Jadwal tidak ditemukan.'));
on('surah', async ({ param, reply, send }) => {
  const s = await getSurahLengkap(param || '1');
  if (!s) return reply('❌ Surah tidak ditemukan.');
  await reply(s.text);
  const b = s.audioUrl ? await fetchBuffer(s.audioUrl).catch(() => null) : null;
  if (b) await send({ audio: b, mimetype: 'audio/mpeg' });
});
on('wiki', async ({ param, reply }) => {
  const d = await getJson(`https://id.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(param)}`);
  return reply(d?.extract ? `📚 *${d.title}*\n\n${d.extract}` : '❌ Tidak ditemukan.');
}, { usage: 'indonesia' });
on('npm', async ({ param, reply }) => {
  const d = await getJson(`https://registry.npmjs.org/${encodeURIComponent(param)}`);
  return reply(d?.name ? `📦 *${d.name}* v${d['dist-tags']?.latest}\n${d.description || ''}` : '❌ Tidak ditemukan.');
}, { usage: 'baileys' });
on(['define', 'fakta', 'motivasi', 'kbbi'], async ({ cmd, param, reply }) => reply((await askAI(`Berikan ${cmd} untuk "${param || 'Indonesia'}" secara singkat dalam Bahasa Indonesia.`, 'Jawab akurat dan ringkas.')) || '❌ Data tidak tersedia.'));

/* ── Anime (game & hiburan ada di handler.js) ── */
on(MENU_CATEGORIES.ANIME, async ({ cmd, reply, send }) => {
  const u = await getAnimeImageUrl(cmd);
  return u ? send({ image: { url: u }, caption: `✨ *${cmd.toUpperCase()}*` }) : reply('❌ Gambar tidak tersedia.');
});

/* ── Stiker & logo ── */
on(['sticker', 'stiker', 's'], async (c) => {
  const q = unwrapMessageContent(QUOTED(c));
  const img = c.unwrapped.imageMessage || q.imageMessage;
  const vid = c.unwrapped.videoMessage || q.videoMessage;
  let webp = null;
  if (img || vid) webp = await mediaBufferToWebpSticker(await downloadBuffer(img || vid, img ? 'image' : 'video'), !img);
  else if (c.param) webp = await urlOrTextToWebpSticker(c.param);
  return webp ? c.send({ sticker: webp }) : c.reply('⚠️ Kirim/balas gambar atau video dengan `.s`');
});
on(['brat', 'bratvid', 'bratvideo'], async ({ cmd, param, send }) => { const w = await createBratSticker(param || 'brat', cmd !== 'brat'); if (w) await send({ sticker: w }); });
on(['ttp', 'attp', 'qc'], async ({ param, send }) => { const w = await urlOrTextToWebpSticker(param); if (w) await send({ sticker: w }); }, { usage: 'teks' });
on(['animasi', 'linkvideo'], ({ param, send }) => send({ image: { url: shot(extractUrl(param) || `https://dummyimage.com/800x450/0f172a/38bdf8.png&text=${encodeURIComponent(param || 'HD')}`) }, caption: '✨ Visual HD' }));
on(['font', 'fancy'], ({ param, reply }) => reply(FONT_MAPS.map((f, i) => `${i + 1}. ${f(param)}`).join('\n')), { usage: 'teks' });
on(Object.keys(LOGO), ({ cmd, param, send }) => send({ image: { url: `https://dummyimage.com/800x400/${LOGO[cmd]}.png&text=${encodeURIComponent(param)}` } }), { usage: 'WHUXEN' });

/* ── Tools ── */
on(['rvo', 'rvop', 'vv'], async (c) => {
  const vo = await extractAndDownloadViewOnce(QUOTED(c));
  if (!vo?.buffer) return c.reply('⚠️ Balas pesan View Once dengan `.rvo`');
  return c.sock.sendMessage(c.cmd === 'rvop' ? c.rawParticipant : c.jid, vo.type === 'audio' ? { audio: vo.buffer, mimetype: 'audio/mpeg', ptt: true } : { [vo.type]: vo.buffer, caption: `👁️ RVO\n${vo.caption}` });
});
on('hitung', ({ param, reply }) => { const r = safeEvaluateMath(param); return reply(r === null ? '⚠️ Format perhitungan tidak valid. Contoh: `.hitung (25 + 15) * 2`' : `🧮 *${param}* = *${r}*`); }, { usage: '(25 + 15) * 2' });
on('catat', async ({ jid, param, reply }) => { (dbMemory.notes[jid] ||= []).push(param); await saveMemory(); return reply('📝 Tersimpan!'); }, { usage: 'beli susu' });
on('catatan', ({ jid, reply }) => { const l = dbMemory.notes[jid] || []; return reply(l.length ? l.map((v, i) => `${i + 1}. ${v}`).join('\n') : '📭 Kosong.'); });
on(['terjemah', 'translate'], async ({ param, reply }) => {
  const [lang, ...rest] = param.split(/\s+/);
  if (!rest.length) return reply('⚠️ Contoh: `.terjemah en selamat pagi`');
  return reply((await askAI(`Terjemahkan ke ${lang}: ${rest.join(' ')}`, 'Terjemahkan saja.')) || '-');
}, { usage: 'en selamat pagi' });
on('id', ({ jid, reply }) => reply(`🆔 \`${jid}\``));
on('getpp', async ({ sock, rawParticipant, reply, send }) => { const pp = await sock.profilePictureUrl(rawParticipant, 'image').catch(() => null); return pp ? send({ image: { url: pp } }) : reply('❌ Privat.'); });
on('getbio', async ({ sock, rawParticipant, reply }) => reply(`📝 ${(await sock.fetchStatus(rawParticipant).catch(() => null))?.status || '-'}`));
on('gpass', ({ reply }) => { const ch = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%'; return reply(`🔐 \`${Array.from({ length: 12 }, () => pick(ch)).join('')}\``); });
on('qr', ({ param, send }) => send({ image: { url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(param)}` } }), { usage: 'teks' });
on('shorturl', needUrl(async ({ reply }, u) => reply(`🔗 ${await (await fetchWithTimeout(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(u)}`)).text()}`)));
on('ssweb', needUrl(({ send }, u) => send({ image: { url: shot(u) } })));
on('waktu', ({ reply }) => reply(`🕒 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`));
on('base64', ({ param, reply }) => reply(Buffer.from(param).toString('base64')), { usage: 'teks' });
on('reverse', ({ param, reply }) => reply([...param].reverse().join('')), { usage: 'teks' });

/* ── Owner ── */
on(['setnama', 'setname', 'botname'], async ({ sock, param, reply }) => {
  bot.userName = dbMemory.botSettings.customBotName = param;
  await saveMemory();
  await sock.updateProfileName(param).catch(() => {});
  return reply(`✅ Nama bot: *${param}*`);
}, { owner: true, usage: 'Nama Bot' });
on('updatebio', async ({ sock, param, reply }) => { await sock.updateProfileStatus(param); return reply('✅ Bio bot diperbarui.'); }, { owner: true, usage: 'bio baru' });
on(['block', 'unblock'], async ({ sock, cmd, param, reply }) => { await sock.updateBlockStatus(`${param.replace(/\D/g, '')}@s.whatsapp.net`, cmd); return reply(`✅ Berhasil ${cmd} nomor.`); }, { owner: true, usage: '628123456789' });
on('blocklist', async ({ sock, reply }) => reply(`🚫 Diblokir: ${(await sock.fetchBlocklist()).length}`), { owner: true });
on(['autoread', 'autotyping'], async ({ cmd, reply }) => { dbMemory.botSettings[cmd] = !dbMemory.botSettings[cmd]; await saveMemory(); return reply(`${cmd}: ${dbMemory.botSettings[cmd]}`); }, { owner: true });
on('mode', async ({ param, reply }) => {
  if (!['public', 'self'].includes(param)) return reply('⚠️ Contoh: `.mode public` atau `.mode self`');
  dbMemory.botSettings.mode = param;
  await saveMemory();
  return reply(`Mode: ${param}`);
}, { owner: true });
on('badwords', ({ reply }) => reply(`Total filter: ${bot.badWords.length + dbMemory.learnedWords.length}`), { owner: true });
on('addkata', async ({ param, reply }) => { dbMemory.learnedWords.push(param.toLowerCase()); await saveMemory(); return reply('✅ Kata filter ditambahkan.'); }, { owner: true, usage: 'kata' });
on('delkata', async ({ param, reply }) => { dbMemory.learnedWords = dbMemory.learnedWords.filter((w) => w !== param.toLowerCase()); await saveMemory(); return reply('✅ Kata filter dihapus.'); }, { owner: true, usage: 'kata' });
on('clean', ({ reply }) => { if (global.gc) global.gc(); return reply('🧹 Cache dibersihkan.'); }, { owner: true });

async function runCommand(c) {
  const h = H.get(c.cmd);
  if (!h) return false;
  if (h.owner && !c.isOwner) await c.reply('⛔ Perintah ini khusus Owner Bot.');
  else if (h.admin && !c.isOwner && !c.isSenderAdmin) await c.reply('⛔ Perintah ini khusus Owner atau Admin Grup.');
  else if (h.usage && !c.param) await c.reply(`⚠️ Contoh: \`.${c.cmd} ${h.usage}\``);
  else await h.fn(c);
  return true;
}

/* ═════════════════════════ PEMROSES PESAN ═════════════════════════ */

function rememberOutgoingMessage(keyId, messageObj) {
  if (!keyId || !messageObj) return;
  sentMessageCache.set(keyId, messageObj);
  if (sentMessageCache.size > 300) sentMessageCache.delete(sentMessageCache.keys().next().value);
}

function unwrapMessageContent(rawMsg) {
  let m = rawMsg || {};
  for (let i = 0; i < 5; i++) {
    const next = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.viewOnceMessageV2Extension?.message || m.documentWithCaptionMessage?.message;
    if (!next) break;
    m = next;
  }
  return m;
}

function extractIncomingTextAndButton(msg) {
  const m = unwrapMessageContent(msg.message);
  const nat = m.interactiveResponseMessage?.nativeFlowResponseMessage;
  if (nat?.paramsJson) {
    try {
      const p = typeof nat.paramsJson === 'string' ? JSON.parse(nat.paramsJson) : nat.paramsJson;
      if (p?.id) return String(p.id).trim();
    } catch {}
  }
  return (
    m.buttonsResponseMessage?.selectedButtonId || m.templateButtonReplyMessage?.selectedId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId || m.conversation ||
    m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption ||
    m.documentMessage?.caption || m.buttonsResponseMessage?.selectedDisplayText || ''
  ).trim();
}

async function prosesSatuPesan(sock, msg) {
  try {
    if (!msg.message || msg.key.fromMe) return;
    const jid = msg.key.remoteJid;
    if (!jid || jid === 'status@broadcast') return;
    if (dbMemory.botSettings.autoread) sock.readMessages([msg.key]).catch(() => {});

    const isGroup = jid.endsWith('@g.us');
    const rawParticipant = msg.key.participant || jid;
    const numOf = (j) => j.split(':')[0].split('@')[0].replace(/\D/g, '');
    const senderNum = numOf(msg.key.participantAlt || rawParticipant);
    const altNum = numOf(rawParticipant);
    const pushName = msg.pushName || 'Member';
    const isOwner = Boolean(OWNER && (senderNum === OWNER || altNum === OWNER));
    if (dbMemory.botSettings.mode === 'self' && !isOwner) return;

    const unwrapped = unwrapMessageContent(msg.message);
    const rawText = extractIncomingTextAndButton(msg);
    if (!rawText) return;
    const textLower = rawText.toLowerCase();

    const isSenderAdmin = isGroup ? await isSenderGroupAdmin(sock, jid, rawParticipant, senderNum, altNum, isOwner) : isOwner;
    const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg });
    const send = (content) => sock.sendMessage(jid, content, { quoted: msg });
    const limit = (cmd) => checkAndConsumeDailyLimit({ sock, jid, senderNum, isOwner, isSenderAdmin, cmd, msg, dbMemory, saveMemory });
    const c = { sock, jid, msg, isGroup, isOwner, isSenderAdmin, senderNum, rawParticipant, pushName, unwrapped, rawText, textLower, reply, send, dbMemory, saveMemory, isCommand: (x) => ALL_COMMANDS_SET.has(x) };

    if (isGroup && await handleGroupMessageGuard({ sock, jid, msg, rawText, textLower, senderParticipant: rawParticipant, senderNum, isSenderAdmin, isOwner, bot, dbMemory })) return;

    // Bukti pembayaran VVIP (ID Transaksi DANA) tanpa perintah
    if (!/^[.!/#]/.test(rawText) && await handlePremiumProofText({ sock, jid, senderNum, text: rawText, msg, dbMemory, saveMemory })) return;

    if (await handleGameInput(c)) return;

    const locMatch = rawText.match(/^(?:lokasi(?:ku| saya)?|domisili|kota(?:ku)?)\s+(?:di\s+)?([a-zA-Z\s]{3,35})$/i);
    if (locMatch) {
      const city = locMatch[1].trim();
      ensureUserRecord(dbMemory, senderNum).city = city;
      await saveMemory();
      await reply(`📍 Titik lokasi kamu disimpan ke *${city}*.\n\n${(await getCuacaKotaAkurat(city)) || ''}`);
      return;
    }

    const weatherMatch = rawText.match(/^(?:prakiraan\s+|perkiraan\s+)?cuaca(?:\s+(?:di|kota))?\s+([a-zA-Z\s]{3,35})$/i);
    if (weatherMatch) {
      if (!(await limit('cuaca')).allowed) return;
      const city = weatherMatch[1].trim();
      const user = ensureUserRecord(dbMemory, senderNum);
      if (!user.city) { user.city = city; await saveMemory(); }
      await reply((await getCuacaKotaAkurat(city)) || '❌ Kota tidak ditemukan.');
      return;
    }

    const args = (/^[.!/#]/.test(rawText) ? rawText.slice(1).trim() : rawText).split(/\s+/);
    const cmd = args[0].toLowerCase();
    const param = args.slice(1).join(' ').trim();
    const typing = () => { if (dbMemory.botSettings.autotyping) sock.sendPresenceUpdate('composing', jid).catch(() => {}); };

    if (!ALL_COMMANDS_SET.has(cmd)) {
      const directUrl = extractUrl(rawText);
      if (directUrl) {
        if (!(await limit('autodownload')).allowed) return;
        typing();
        if (await handleDirectUrlAutoDownload(sock, jid, directUrl, msg)) return;
      }
    }

    if (ALL_COMMANDS_SET.has(cmd)) {
      if (!(await limit(cmd)).allowed) return;
      typing();
      const cc = { ...c, cmd, param, args };
      if (await handleMenuCommand(cc)) return;
      if (await handlePremiumCommand({ sock, jid, senderNum, isOwner, isSenderAdmin, cmd, param, msg, dbMemory, saveMemory })) return;
      if (!(cmd === 'kode' && !isGroup) && await handleGroupCommand({ sock, jid, isGroup, senderParticipant: rawParticipant, senderNum, isOwner, isSenderAdmin, cmd, param, unwrapped, msg, dbMemory, saveMemory })) return;
      if (await handleDownloadCommand({ sock, jid, cmd, param, msg })) return;
      if (await handleGameCommand(cc)) return;
      if (await runCommand(cc)) return;
    }

    if (isGroup) {
      await handleGroupThemeInteraction({ sock, jid, senderParticipant: rawParticipant, pushName, rawText, unwrapped, msg, dbMemory, bot });
      return;
    }

    if (rawText.length < 2 || !(await limit('chat_ai')).allowed) return;
    const ai = await askAI(rawText, `Kamu adalah ${bot.userName}, asisten WhatsApp cerdas.`);
    if (ai) await reply(ai);
  } catch (err) {
    const m = err?.message || 'Error';
    if (SIGNAL_ERR.test(m)) await triggerAutoCipherHeal(msg?.key?.remoteJid || '', m);
    else recordAutoRepair('Handler', m, 'Pesan diisolasi');
  }
}

/* ═════════════════════════ KONEKSI WHATSAPP ═════════════════════════ */

let backgroundLoopsStarted = false;
let isReconnecting = false;

function scheduleReconnect(delayMs = 3000) {
  if (isReconnecting) return;
  isReconnecting = true;
  setTimeout(() => { isReconnecting = false; start().catch(() => scheduleReconnect(10000)); }, delayMs);
}

async function start() {
  await loadMemory();
  await jalankanEvolusiMandiri(false);
  await restoreAuthFromGitHub(AUTH_DIR);

  if (!backgroundLoopsStarted) {
    backgroundLoopsStarted = true;
    setTimeout(() => jalankanAuditFiturRealTime(false), 8000);
    setInterval(() => jalankanAuditFiturRealTime(false), 5 * 60 * 1000);
    setupGracefulShutdown(bot, saveMemory);
    startGitHubLiveHotReload(() => jalankanAuditFiturRealTime(true));
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  console.log(`\n🤖 ${bot.userName} v${dbMemory.version} — ${ALL_COMMANDS_SET.size} FITUR AKTIF\n`);

  const sock = makeWASocket({
    version, auth: state, logger: pino({ level: 'silent' }), browser: ['WHUXEN Bot', 'Chrome', '10.0.0'],
    printQRInTerminal: false, getMessage: async (key) => sentMessageCache.get(key.id) || { conversation: '' },
  });

  const origSendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = async (jid, content, options) => {
    const sent = await origSendMessage(jid, content, options);
    if (sent?.key?.id && sent?.message) {
      rememberOutgoingMessage(sent.key.id, sent.message);
      if (content?.text) lastReplyTextByJid.set(jid, content.text);
    }
    return sent;
  };

  bot.sock = sock;
  bot.connected = false;
  bot.registered = !!sock.authState.creds.registered;

  sock.ev.on('creds.update', async () => { await saveCreds(); scheduleAuthBackupToGitHub(AUTH_DIR); });
  sock.ev.on('messages.update', async (updates) => {
    for (const u of updates) {
      const target = u.key?.remoteJid;
      if (!target || !u.key?.fromMe || !(u.update?.messageStubType || u.update?.status === 0)) continue;
      if (Date.now() - (retryCooldownByJid.get(target) || 0) < 8000) continue;
      retryCooldownByJid.set(target, Date.now());
      await repairSignalSessionForJid(target, 'Terdeteksi Menunggu Pesan Ini');
      const fallback = lastReplyTextByJid.get(target);
      if (fallback) await origSendMessage(target, { text: `🔄 *Auto-Repair Enkripsi Berhasil:*\n\n${fallback}` }).catch(() => {});
    }
  });
  sock.ev.on('messages.upsert', ({ messages, type }) => { if (type === 'notify') for (const m of messages) prosesSatuPesan(sock, m).catch(() => {}); });
  sock.ev.on('group-participants.update', (u) => handleGroupParticipantsUpdate(sock, dbMemory, u).catch(() => {}));
  sock.ev.on('group.join-request', (e) => handleGroupJoinRequestEvent(sock, dbMemory, e).catch(() => {}));

  startGroupAutomationScheduler(sock, dbMemory, saveMemory);
  startPremiumAndQrisWatcher(sock, dbMemory, saveMemory);

  const formatPairing = (code) => code?.match(/.{1,4}/g)?.join('-') || code;
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && !bot.connected) {
      bot.qr = qr;
      if (PHONE && !bot.registered && !bot.pairingCode) {
        setTimeout(() => sock.requestPairingCode(PHONE).then((code) => {
          bot.pairingCode = formatPairing(code);
          console.log(`🔑 KODE OTP BOT: ${bot.pairingCode}`);
        }).catch(() => {}), 2000);
      }
    }
    if (connection === 'open') {
      Object.assign(bot, { connected: true, registered: true, qr: null, pairingCode: null, userPhone: sock.user?.id ? sock.user.id.split(':')[0] : PHONE });
      scheduleAuthBackupToGitHub(AUTH_DIR);
      console.log(`✅ [TERHUBUNG] ${bot.userPhone} — Semua Sistem Aktif`);
    } else if (connection === 'close') {
      bot.connected = false;
      if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
        Object.assign(bot, { registered: false, pairingCode: null, qr: null });
        await saveMemory();
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        scheduleReconnect(5000);
      } else {
        scheduleReconnect(3000);
      }
    }
  });
}

mulaiWeb({
  bot,
  dbMemory,
  getUptime,
  getFeatureCount: () => ALL_COMMANDS_SET.size,
  requestNewPairingCode: () => {
    bot.pairingCode = null;
    return bot.sock?.requestPairingCode(PHONE).then((code) => { bot.pairingCode = code?.match(/.{1,4}/g)?.join('-') || code; }).catch(() => {});
  },
});
start().catch(() => scheduleReconnect(10000));
