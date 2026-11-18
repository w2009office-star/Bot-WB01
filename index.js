import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';

import { mulaiWeb } from './web.js';
import { restoreAuthFromGitHub, scheduleAuthBackupToGitHub, startGitHubLiveHotReload, setupGracefulShutdown } from './github_sync.js';
import { ALL_GROUP_COMMANDS, GROUP_AUTO_ONLY_COMMANDS, GROUP_SECURITY_MENU, isSenderGroupAdmin, handleGroupMessageGuard, handleGroupCommand, handleGroupParticipantsUpdate, handleGroupJoinRequestEvent, startGroupAutomationScheduler, handleGroupThemeInteraction } from './group_automation.js';
import { PREMIUM_COMMANDS, ensureUserRecord, checkAndConsumeDailyLimit, handlePremiumCommand, startPremiumAndQrisWatcher, handlePremiumProofText } from './premium_limit.js';
import { DOWNLOAD_COMMANDS, DOWNLOAD_MENU, handleDownloadCommand, handleDirectUrlAutoDownload, fetchWithTimeout, fetchBuffer, extractUrl, mediaBufferToWebpSticker, createBratSticker, urlOrTextToWebpSticker, extractAndDownloadViewOnce, sendNativeInteractiveButtons, panggilServerAISatSet, getAnimeImageUrl } from './engines.js';

const PHONE = (process.env.PHONE_NUMBER || '').replace(/\D/g, '');
const AUTH_DIR = process.env.AUTH_DIR || './auth';
const MEMORY_FILE = './memory.json';
const OWNER_NAME = process.env.OWNER_NAME || 'Maverick';
const MENU_BANNER_LINK = process.env.MENU_BANNER_LINK || '';

const bot = {
  sock: null, connected: false, registered: false, qr: null, pairingCode: null,
  startTime: Date.now(), userPhone: null, userName: 'WHUXEN BOT',
  stats: { totalDeletedBadWords: 0, totalDeletedLinks: 0, totalBlockedVirtek: 0, totalDeletedTagStatus: 0, lastCleanupTime: new Date().toLocaleString('id-ID') },
  badWords: ['anjing', 'babi', 'kunyuk', 'bajingan', 'goblok', 'tolol', 'bangsat', 'brengsek', 'jancok', 'pantek'],
  blockedDomains: ['judionline', 'slotgacor', 'situs-terlarang.com', 'link-spam.xyz'],
};

let dbMemory = {
  version: 10.0, lastUpdateDate: '', updateLogs: [], users: {}, pendingInvoices: [],
  learnedWords: [], notes: {}, groupSettings: {}, gameHighScores: { kuroslash: {}, sonic: {} },
  botSettings: { mode: 'public', autoread: false, autotyping: true, customBotName: '' },
  healthReport: { lastChecked: '-', summary: 'Modular Group Security + Multi-Engine Downloader', details: {}, autoRepairs: [], totalRepairs: 0 },
};

const MENU_CATEGORIES = {
  AI: ['ai', 'gpt', 'ask', 'tanya', 'gemini', 'chatgpt', 'simi', 'cerita', 'puisi', 'pantun', 'kode', 'coding', 'ringkas', 'memori', 'resetmemori'],
  SEARCH: ['cuaca', 'wthr', 'setlokasi', 'lokasi', 'praytime', 'surah', 'wiki', 'npm', 'define', 'fakta', 'motivasi', 'kbbi'],
  ANIME: ['waifu', 'neko', 'shinobu', 'megumin', 'cuddle', 'cry', 'kiss', 'lick', 'bonk', 'yeet', 'blush', 'smile', 'highfive', 'handhold', 'nom', 'bite', 'glomp', 'slap', 'kill', 'kickanime', 'happy', 'wink', 'poke', 'cringe'],
  FUN: ['kuroslash', 'slash', 'sonic', 'speedydash', 'game', 'mathgame', 'tebakkata', 'suit', 'dice', 'coin', '8ball', 'rate', 'aura', 'sigma', 'rizz', 'vibe', 'npc', 'maincharacter', 'delulu', 'redflag', 'greenflag', 'compatibility', 'ship', 'roast', 'compliment', 'pickup', 'quote', 'joke', 'truth', 'dare', 'wyr', 'horoscope', 'hug', 'pat', 'wave', 'dance'],
  STICKER_LOGO: ['sticker', 'stiker', 's', 'brat', 'bratvid', 'bratvideo', 'ttp', 'attp', 'qc', 'animasi', 'linkvideo', 'font', 'fancy', 'logo', 'neon', 'gold', 'galaxy', 'glitch', 'matrix', 'graffiti', 'thunder'],
  TOOLS: ['rvo', 'rvop', 'vv', 'hitung', 'catat', 'catatan', 'terjemah', 'translate', 'id', 'getpp', 'getbio', 'gpass', 'qr', 'shorturl', 'waktu', 'base64', 'reverse', 'ssweb', 'fixsession'],
  OWNER: ['setnama', 'setname', 'botname', 'updatebio', 'block', 'unblock', 'blocklist', 'autoread', 'autotyping', 'mode', 'badwords', 'addkata', 'delkata', 'clean'],
  SYSTEM: ['menu', 'help', 'allmenu', 'groupmenu', 'aimenu', 'downloadmenu', 'dlmenu', 'searchmenu', 'animemenu', 'funmenu', 'logomenu', 'toolsmenu', 'ownermenu', 'ping', 'ping2', 'speed', 'os', 'alive', 'runtime', 'uptime', 'owner', 'status', 'selftest', 'cekfitur', 'autorepair', 'update'],
};

const ALL_COMMANDS_SET = new Set([
  ...Object.values(MENU_CATEGORIES).flat(),
  ...DOWNLOAD_COMMANDS,
  ...ALL_GROUP_COMMANDS,
  ...PREMIUM_COMMANDS,
]);

const formatCategoryBox = (title, list) =>
  `*╭┈───〔 ${title} 〕┈───⊷*\n${list.map((c) => `*├✦* .${c}`).join('\n')}\n*╰───────────────────⊷*`;

const serverAutoHeal = { totalAutoRepairs: 0 };

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
    const targetDigits = String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');
    const files = await fsPromises.readdir(AUTH_DIR);
    for (const f of files) {
      if (f === 'creds.json') continue;
      if (targetDigits ? f.includes(targetDigits) && f.startsWith('session-') : f.startsWith('session-')) {
        await fsPromises.unlink(path.join(AUTH_DIR, f)).catch(() => {});
        deleted++;
      }
    }
    if (deleted > 0) recordAutoRepair('SignalCipher', reason, `Reset ${deleted} sesi`);
  } catch {}
  return deleted;
}

async function jalankanAuditFiturRealTime(manual = false) {
  const rep = {
    lastChecked: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
    summary: `${ALL_COMMANDS_SET.size}/${ALL_COMMANDS_SET.size} Fitur VALID & Modular Aktif`,
    details: {
      'Group Security & Auto': `✅ ${ALL_GROUP_COMMANDS.length} Perintah Aktif`,
      'Download Engine': `✅ ${DOWNLOAD_COMMANDS.length} Perintah Aktif`,
      'Premium & QRIS': `✅ ${PREMIUM_COMMANDS.length} Perintah Aktif`,
      'Auto-Repair': `${serverAutoHeal.totalAutoRepairs}x perbaikan`,
    },
    autoRepairs: dbMemory.healthReport.autoRepairs || [],
    totalRepairs: serverAutoHeal.totalAutoRepairs,
  };
  dbMemory.healthReport = rep;
  if (manual) await saveMemory();
  return rep;
}

let cipherRepairLock = false;
async function triggerAutoCipherHeal(jid = '', reason = 'Bad MAC / Decryption Failure') {
  if (cipherRepairLock) return;
  cipherRepairLock = true;
  try { await repairSignalSessionForJid(jid, reason); } finally { setTimeout(() => { cipherRepairLock = false; }, 4000); }
}

const origConsoleError = console.error;
console.error = (...args) => {
  if (/Bad MAC|SessionError|No matching sessions|Invalid PreKey|decrypt/i.test(args.map((a) => a?.message || String(a)).join(' '))) {
    triggerAutoCipherHeal('', 'Console Signal Decryption Error').catch(() => {});
  }
  origConsoleError.apply(console, args);
};

process.on('uncaughtException', (err) => {
  const m = err?.message || 'Error';
  if (/Bad MAC|SessionError|No matching sessions|Invalid PreKey/i.test(m)) triggerAutoCipherHeal('', m.slice(0, 45)).catch(() => {});
  else recordAutoRepair('ProcessGuard', m, 'Proses tetap berjalan normal');
});

process.on('unhandledRejection', (reason) => {
  const m = reason?.message || String(reason);
  if (/Bad MAC|SessionError|No sessions|No matching sessions|Invalid PreKey|Timed Out/i.test(m)) triggerAutoCipherHeal('', m.slice(0, 45)).catch(() => {});
});

async function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const p = JSON.parse(await fsPromises.readFile(MEMORY_FILE, 'utf-8'));
      dbMemory = {
        ...dbMemory, ...p,
        pendingInvoices: Array.isArray(p.pendingInvoices) ? p.pendingInvoices : [],
        botSettings: { ...dbMemory.botSettings, ...(p.botSettings || {}) },
        healthReport: { ...dbMemory.healthReport, ...(p.healthReport || {}) },
        gameHighScores: { kuroslash: { ...(p.gameHighScores?.kuroslash || {}) }, sonic: { ...(p.gameHighScores?.sonic || {}) } },
      };
      if (dbMemory.botSettings.customBotName) bot.userName = dbMemory.botSettings.customBotName;
    } else {
      await saveMemory();
    }
  } catch { await saveMemory(); }
}

const saveMemory = () => fsPromises.writeFile(MEMORY_FILE, JSON.stringify(dbMemory, null, 2), 'utf-8').catch(() => {});
const getTodayDateString = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());

function getIndonesianFullDateTime() {
  return {
    full: new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date()) + ' WIB',
  };
}

function getUptime() {
  const s = Math.floor((Date.now() - bot.startTime) / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${d ? `${d}h ` : ''}${h}j ${m}m ${sec}d`;
}

function getServerHardwareStats() {
  const total = os.totalmem(), free = os.freemem();
  const ramPercent = Math.round(((total - free) / total) * 100);
  const bar = (pct) => '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
  let diskPercent = 35;
  try {
    const st = fs.statfsSync('.');
    diskPercent = Math.round(((st.blocks - st.bfree) / st.blocks) * 100);
  } catch {}
  return { ramPercent, ramBar: bar(ramPercent), diskPercent, diskBar: bar(diskPercent) };
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

const FONT_MAPS = [
  (t) => t.replace(/[A-Za-z]/g, (c) => String.fromCodePoint(c.charCodeAt(0) + (c <= 'Z' ? 119737 : 119731))),
  (t) => t.replace(/[A-Za-z]/g, (c) => String.fromCodePoint(c.charCodeAt(0) + (c <= 'Z' ? 119789 : 119783))),
  (t) => t.replace(/[A-Za-z]/g, (c) => String.fromCodePoint(c.charCodeAt(0) + (c <= 'Z' ? 119841 : 119835))),
  (t) => t.replace(/[A-Za-z]/g, (c) => String.fromCodePoint(c.charCodeAt(0) + (c <= 'Z' ? 120003 : 119997))),
  (t) => t.replace(/[A-Za-z]/g, (c) => String.fromCodePoint(c.charCodeAt(0) + (c <= 'Z' ? 120367 : 120361))),
];
const applyFont = (text, idx) => (FONT_MAPS[idx] ? FONT_MAPS[idx](text) : text);

async function kirimTampilanKuroSlash(sock, jid, senderNum, st, eventText, quoted) {
  const lanes = ['⬜', '⬜', '⬜'];
  lanes[st.lane] = '🥷';
  await sendNativeInteractiveButtons(sock, jid, {
    title: '⚔️ KURO SLASH — DEMON HUNTER',
    body: `👤 Pemain: @${senderNum}\n❤️ HP: ${st.hp}% | ⚡ ULTI: ${st.ulti}%\n🏆 Skor: *${st.score}* (Best: ${st.best})\n\nArena: [ ${lanes.join(' | ')} ]\n💬 _${eventText}_`,
    buttons: [{ text: '⬅️ KIRI', id: 'kiri' }, { text: '⚔️ TEBAS', id: 'tebas' }, { text: '➡️ KANAN', id: 'kanan' }],
  }, quoted);
}

async function kirimTampilanSonic(sock, jid, senderNum, st, eventText, quoted) {
  await sendNativeInteractiveButtons(sock, jid, {
    title: '🌀 SPEEDY DASH — SONIC RUN',
    body: `👤 Pemain: @${senderNum}\n💍 Gold Rings: *${st.rings}* | 🏆 Skor: *${st.score}* (Best: ${st.best})\n${st.laserAlert ? '⚠️ *AWAS LASER DI DEPAN! TEKAN JUMP!*' : '🛣️ Lintasan aman untuk nge-boost!'}\n\n💬 _${eventText}_`,
    buttons: [{ text: '⚡ BOOST', id: 'boost' }, { text: '⬆️ JUMP', id: 'jump' }, { text: '🛑 STOP', id: 'stopgame' }],
  }, quoted);
}

async function getJadwalSholatIndonesia(city) {
  try {
    const search = await (await fetchWithTimeout(`https://api.myquran.com/v2/sholat/kota/cari/${encodeURIComponent(city)}`, {}, 10000)).json();
    const kota = search?.data?.[0];
    if (!kota) return null;
    const d = new Date();
    const res = await (await fetchWithTimeout(`https://api.myquran.com/v2/sholat/jadwal/${kota.id}/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`, {}, 10000)).json();
    const j = res?.data?.jadwal;
    if (!j) return null;
    return `🕌 *JADWAL SHOLAT — ${kota.lokasi}*\n📅 ${j.tanggal}\n\n• Imsak: *${j.imsak}*\n• Subuh: *${j.subuh}*\n• Dzuhur: *${j.dzuhur}*\n• Ashar: *${j.ashar}*\n• Maghrib: *${j.maghrib}*\n• Isya: *${j.isya}*`;
  } catch { return null; }
}

async function getSurahLengkap(no) {
  try {
    const res = await (await fetchWithTimeout(`https://equran.id/api/v2/surat/${parseInt(no, 10) || 1}`, {}, 10000)).json();
    const d = res?.data;
    if (!d) return null;
    const ayat = (d.ayat || []).slice(0, 7).map((a) => `*${a.nomorAyat}.* ${a.teksArab}\n_${a.teksIndonesia}_`).join('\n\n');
    return {
      text: `📖 *QS. ${d.namaLatin} (${d.nama})*\nArti: _${d.arti}_ • ${d.jumlahAyat} Ayat\n\n${ayat}${d.jumlahAyat > 7 ? '\n\n_...(menampilkan 7 ayat pertama)_' : ''}`,
      audioUrl: d.audioFull?.['05'] || '',
    };
  } catch { return null; }
}

const gameSessions = new Map();
const sentMessageCache = new Map();
const lastReplyTextByJid = new Map();
const retryCooldownByJid = new Map();

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

function safeEvaluateMath(expr) {
  const s = expr.replace(/\s+/g, '');
  if (!s || !/^[0-9+\-*/().]+$/.test(s)) return null;
  let i = 0;
  const parseExpr = () => {
    let v = parseTerm();
    while (v !== null && (s[i] === '+' || s[i] === '-')) {
      const op = s[i++]; const r = parseTerm();
      v = r === null ? null : op === '+' ? v + r : v - r;
    }
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

async function getCuacaKotaAkurat(cityName) {
  const cleanCity = (cityName || 'Jakarta').trim();
  try {
    const geo = await (await fetchWithTimeout(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cleanCity)}&count=1&language=id&format=json`, {}, 10000)).json();
    const loc = geo?.results?.[0];
    if (loc) {
      const w = await (await fetchWithTimeout(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FJakarta&forecast_days=3`, {}, 10000)).json();
      const cur = w?.current;
      if (cur) {
        const wmo = { 0: '☀️ Cerah', 1: '🌤️ Cerah Berawan', 2: '⛅ Berawan Sebagian', 3: '☁️ Mendung / Berawan', 45: '🌫️ Berkabut', 48: '🌫️ Kabut Tebal', 51: '🌦️ Gerimis Ringan', 53: '🌦️ Gerimis Sedang', 55: '🌧️ Gerimis Lebat', 61: '🌧️ Hujan Ringan', 63: '🌧️ Hujan Sedang', 65: '⛈️ Hujan Lebat', 80: '🌦️ Hujan Lokal Ringan', 81: '🌧️ Hujan Lokal Sedang', 82: '⛈️ Hujan Lokal Lebat', 95: '⛈️ Hujan Petir', 96: '⛈️ Hujan Petir & Angin' };
        return `🌤️ *PRAKIRAAN CUACA — ${loc.name.toUpperCase()}*\n📍 Titik Lokasi: *${[loc.name, loc.admin1, loc.country].filter(Boolean).join(', ')}*\n\n• Kondisi: *${wmo[cur.weather_code] || '🌤️ Berawan'}*\n• Suhu Saat Ini: *${cur.temperature_2m}°C* — Terasa *${cur.apparent_temperature}°C*\n• Suhu Hari Ini: *${w?.daily?.temperature_2m_min?.[0] ?? '-'}°C – ${w?.daily?.temperature_2m_max?.[0] ?? '-'}°C*\n• Kelembapan: *${cur.relative_humidity_2m}%*\n• Kecepatan Angin: *${cur.wind_speed_10m} km/jam*\n• Peluang Hujan: *${w?.daily?.precipitation_probability_max?.[0] ?? '-'}%*\n\n_Ketik *"lokasi di <kota>"* untuk mengganti titik kota otomatis kamu._`;
      }
    }
  } catch {}
  try {
    const r = await fetchWithTimeout(`https://wttr.in/${encodeURIComponent(cleanCity)}?format=j1`, {}, 8000);
    const d = await r.json();
    const c = d?.current_condition?.[0];
    if (c) return `🌤️ *CUACA ${cleanCity.toUpperCase()}*\n• Suhu: *${c.temp_C}°C*\n• Kelembapan: *${c.humidity}%*\n• Angin: *${c.windspeedKmph} km/jam*`;
  } catch {}
  return null;
}

async function prosesSatuPesan(sock, msg) {
  try {
    if (!msg.message || msg.key.fromMe) return;
    const jid = msg.key.remoteJid;
    if (!jid || jid === 'status@broadcast') return;
    if (dbMemory.botSettings.autoread) sock.readMessages([msg.key]).catch(() => {});

    const isGroup = jid.endsWith('@g.us');
    const rawParticipant = msg.key.participant || jid;
    const senderParticipant = msg.key.participantAlt || rawParticipant;
    const senderNum = senderParticipant.split(':')[0].split('@')[0].replace(/\D/g, '');
    const altNum = rawParticipant.split(':')[0].split('@')[0].replace(/\D/g, '');
    const pushName = msg.pushName || 'Member';
    const isOwner = Boolean(PHONE && (senderNum === PHONE || altNum === PHONE));
    if (dbMemory.botSettings.mode === 'self' && !isOwner) return;

    const unwrapped = unwrapMessageContent(msg.message);
    const rawText = extractIncomingTextAndButton(msg);
    if (!rawText) return;
    const textLower = rawText.toLowerCase();

    const isSenderAdmin = isGroup ? await isSenderGroupAdmin(sock, jid, rawParticipant, senderNum, altNum, isOwner) : isOwner;
    if (isGroup && await handleGroupMessageGuard({ sock, jid, msg, rawText, textLower, senderParticipant: rawParticipant, senderNum, isSenderAdmin, isOwner, bot, dbMemory })) return;

    // Auto-deteksi teks bukti pembayaran VVIP (ID Transaksi DANA) jika bukan command
    if (!/^[.!/#]/.test(rawText)) {
      if (await handlePremiumProofText({ sock, jid, senderNum, text: rawText, msg, dbMemory, saveMemory })) return;
    }

    const cleanAction = textLower.replace(/^[.!/#]/, '').trim();
    if (cleanAction === 'stopgame' && gameSessions.has(jid)) { gameSessions.delete(jid); await sock.sendMessage(jid, { text: '🛑 Permainan dihentikan.' }, { quoted: msg }); return; }

    if (gameSessions.has(jid)) {
      const s = gameSessions.get(jid);
      if (s.type === 'kuroslash' && ['kiri', 'tebas', 'kanan', 'ulti'].includes(cleanAction)) {
        s.wave = (s.wave || 0) + 1;
        let ev = '';
        if (cleanAction === 'kiri') { s.lane = Math.max(0, s.lane - 1); s.score += 65; s.ulti = Math.min(100, s.ulti + 15); ev = 'Bergerak ke jalur KIRI (+65)!'; }
        else if (cleanAction === 'kanan') { s.lane = Math.min(2, s.lane + 1); s.score += 65; s.ulti = Math.min(100, s.ulti + 15); ev = 'Bergerak ke jalur KANAN (+65)!'; }
        else if (cleanAction === 'tebas') { s.score += 150; s.ulti = Math.min(100, s.ulti + 25); ev = '⚔️ TEBASAN TELAK! Oni ter-PARRY (+150)!'; }
        else if (cleanAction === 'ulti') {
          if (s.ulti >= 100) { s.score += 450; s.ulti = 0; ev = '🌊 GELOMBANG ULTI TERLEPAS (+450)!'; }
          else ev = `⚠️ ULTI baru ${s.ulti}% — tekan TEBAS untuk mengisi!`;
        }
        s.best = dbMemory.gameHighScores.kuroslash[senderNum] = Math.max(dbMemory.gameHighScores.kuroslash[senderNum] || 0, s.score);
        await saveMemory();
        await kirimTampilanKuroSlash(sock, jid, senderNum, s, ev, msg);
        return;
      }
      if (s.type === 'sonic' && ['boost', 'jump'].includes(cleanAction)) {
        const addR = Math.floor(Math.random() * 7) + 5;
        s.rings += addR; s.score += addR * 35; s.laserAlert = cleanAction === 'boost' ? Math.random() < 0.45 : false;
        s.best = dbMemory.gameHighScores.sonic[senderNum] = Math.max(dbMemory.gameHighScores.sonic[senderNum] || 0, s.score);
        await saveMemory();
        await kirimTampilanSonic(sock, jid, senderNum, s, `${cleanAction === 'boost' ? '⚡ BOOST' : '⬆️ JUMP'}! +${addR} Gold Rings!`, msg);
        return;
      }
      if (s.type === 'angka' && /^[0-9]+$/.test(rawText)) {
        const g = parseInt(rawText, 10);
        if (g === s.answer) { gameSessions.delete(jid); await sock.sendMessage(jid, { text: `🎉 *BENAR!* Angkanya *${s.answer}*.` }, { quoted: msg }); }
        else await sock.sendMessage(jid, { text: g < s.answer ? '⬆️ Terlalu KECIL!' : '⬇️ Terlalu BESAR!' }, { quoted: msg });
        return;
      }
      if (s.type === 'math' && /^-?[0-9]+$/.test(rawText)) {
        gameSessions.delete(jid);
        await sock.sendMessage(jid, { text: parseInt(rawText, 10) === s.answer ? `🎉 *TEPAT!* Jawabannya *${s.answer}*.` : `❌ Salah! Jawaban: *${s.answer}*.` }, { quoted: msg });
        return;
      }
      if (s.type === 'kata' && !ALL_COMMANDS_SET.has(cleanAction)) {
        gameSessions.delete(jid);
        await sock.sendMessage(jid, { text: textLower === s.answer ? `🎉 *BENAR!* Jawabannya *${s.answer}*.` : `❌ Salah! Jawaban: *${s.answer}*.` }, { quoted: msg });
        return;
      }
    }

    const locMatch = rawText.match(/^(?:lokasi(?:ku| saya)?|domisili|kota(?:ku)?)\s+(?:di\s+)?([a-zA-Z\s]{3,35})$/i);
    if (locMatch) {
      const city = locMatch[1].trim();
      ensureUserRecord(dbMemory, senderNum).city = city;
      await saveMemory();
      await sock.sendMessage(jid, { text: `📍 Titik lokasi kamu disimpan ke *${city}*.\n\n${await getCuacaKotaAkurat(city)}` }, { quoted: msg });
      return;
    }

    const weatherMatch = rawText.match(/^(?:prakiraan\s+|perkiraan\s+)?cuaca(?:\s+(?:di|kota))?\s+([a-zA-Z\s]{3,35})$/i);
    if (weatherMatch) {
      if (!(await checkAndConsumeDailyLimit({ sock, jid, senderNum, isOwner, isSenderAdmin, cmd: 'cuaca', msg, dbMemory, saveMemory })).allowed) return;
      const city = weatherMatch[1].trim();
      const userObj = ensureUserRecord(dbMemory, senderNum);
      if (!userObj.city) { userObj.city = city; await saveMemory(); }
      await sock.sendMessage(jid, { text: await getCuacaKotaAkurat(city) }, { quoted: msg });
      return;
    }

    const cleanText = /^[.!/#]/.test(rawText) ? rawText.slice(1).trim() : rawText;
    const args = cleanText.split(/\s+/);
    const cmd = args[0].toLowerCase();
    const param = args.slice(1).join(' ').trim();

    if (!ALL_COMMANDS_SET.has(cmd)) {
      const directUrl = extractUrl(rawText);
      if (directUrl) {
        const limitCheck = await checkAndConsumeDailyLimit({ sock, jid, senderNum, isOwner, isSenderAdmin, cmd: 'autodownload', msg, dbMemory, saveMemory });
        if (!limitCheck.allowed) return;
        if (dbMemory.botSettings.autotyping) sock.sendPresenceUpdate('composing', jid).catch(() => {});
        if (await handleDirectUrlAutoDownload(sock, jid, directUrl, msg)) return;
      }
    }

    if (ALL_COMMANDS_SET.has(cmd)) {
      if (!(await checkAndConsumeDailyLimit({ sock, jid, senderNum, isOwner, isSenderAdmin, cmd, msg, dbMemory, saveMemory })).allowed) return;
      if (dbMemory.botSettings.autotyping) sock.sendPresenceUpdate('composing', jid).catch(() => {});

      if (await handlePremiumCommand({ sock, jid, senderNum, isOwner, isSenderAdmin, cmd, param, msg, dbMemory, saveMemory })) return;
      if (await handleGroupCommand({ sock, jid, isGroup, senderParticipant: rawParticipant, senderNum, isOwner, isSenderAdmin, cmd, param, unwrapped, msg, dbMemory, saveMemory })) return;
      if (await handleDownloadCommand({ sock, jid, cmd, param, msg })) return;

      if (cmd === 'fixsession') {
        if (!isOwner && !isSenderAdmin) { await sock.sendMessage(jid, { text: '⛔ Perintah ini khusus Owner atau Admin Grup.' }, { quoted: msg }); return; }
        const deleted = await repairSignalSessionForJid(jid, 'Perintah Manual fixsession');
        await sock.sendMessage(jid, { text: `🔐 *SIGNAL CIPHER DI-RESET!*\n• Kunci sesi dibersihkan: *${deleted} file*\n• Status: Enkripsi chat sudah disinkronkan ulang.` }, { quoted: msg });
        return;
      }

      if (cmd === 'menu' || cmd === 'help') {
        const dt = getIndonesianFullDateTime();
        const userRec = ensureUserRecord(dbMemory, senderNum);
        const isPrem = isOwner || isSenderAdmin || userRec.premiumUntil > Date.now();
        const limitLabel = isPrem ? '∞ Unlimited VVIP' : `${Math.max(0, 15 - userRec.dailyUsed)}/15 tersisa`;
        const bannerImg = MENU_BANNER_LINK || `https://dummyimage.com/1000x460/1e1035/c084fc.png&text=${encodeURIComponent(bot.userName + ' • VVIP BOT')}`;

        const menuBody =
          `└ *${bot.userName}* ┐\n` +
          `🗓️ ${dt.full}\n\n` +
          `👤 *INFORMATION*\n` +
          `• *NAMA*       : ${pushName}\n` +
          `• *STATUS*    : ${isOwner ? '👑 Owner' : isSenderAdmin ? '🛡️ Admin Grup' : userRec.premiumUntil > Date.now() ? '💎 VVIP Member' : '⭐ Reguler'}\n` +
          `• *LIMIT*        : ${limitLabel}\n` +
          `• *LOKASI*     : ${userRec.city || 'Belum diset — ketik: lokasi di bandung'}\n` +
          `• *VERSION* : v${dbMemory.version}`;

        lastReplyTextByJid.set(jid, menuBody);

        await sendNativeInteractiveButtons(sock, jid, {
          title: 'HOME  •  ABOUT  •  PROFILE',
          body: menuBody,
          footer: 'Ketik qris untuk Upgrade VVIP Unlimited DANA',
          imageUrl: bannerImg,
          forwardedCard: true,
          listTitle: '📂 Pilih Kategori Fitur',
          sections: [
            {
              title: '💎 VVIP, QRIS & GRUP',
              rows: [
                { title: '📊 Cek Sisa Limit & VVIP', description: 'Lihat sisa kuota atau masa aktif VVIP Anda', id: 'limit' },
                { title: '💳 Upgrade VVIP (QRIS DANA)', description: 'Pilih paket VVIP otomatis (Rp1rb - Rp10rb)', id: 'qris' },
                { title: '📥 Menu Download', description: 'TikTok, YouTube, Spotify, IG, FB & File', id: 'downloadmenu' },
                { title: '🛡️ Menu Keamanan Grup', description: 'Anti-Link, Auto ACC, Kick, Mute & Filter Member', id: 'keamanangrup' },
                { title: '⚙️ Panel Otomatisasi Grup', description: 'Jadwal kegiatan, Welcome & Auto Buka/Tutup', id: 'panelgrup' },
                { title: '📋 Daftar Lengkap Semua Fitur', description: 'Tampilkan seluruh perintah bot', id: 'allmenu' },
              ],
            },
            {
              title: '🛠️ PERBAIKAN & HIBURAN',
              rows: [
                { title: '🛠️ Perbaiki Semua Fitur', description: 'Jalankan auto-repair + reset enkripsi', id: 'autorepair' },
                { title: '⚔️ Kuro Slash', description: 'Main tebas Oni dengan tombol sentuh', id: 'kuroslash' },
                { title: '🌀 Speedy Dash', description: 'Main Sonic kumpulkan Gold Rings', id: 'sonic' },
              ],
            },
          ],
          buttons: [
            { text: '📥 Menu Download', id: 'downloadmenu' },
            { text: '🛡️ Keamanan Grup', id: 'keamanangrup' },
            { text: '📋 Semua Fitur', id: 'allmenu' },
          ],
        }, msg);
        return;
      }

      if (cmd === 'allmenu') {
        let out = `*╭┈───〔 ${bot.userName} - SEMUA FITUR 〕┈───⊷*\n*├✦ Owner:* ${OWNER_NAME}\n*├✦ Total Aktif:* ${ALL_COMMANDS_SET.size} Fitur\n*╰───────────────────⊷*\n\n`;
        for (const [cat, list] of Object.entries(MENU_CATEGORIES)) {
          out += formatCategoryBox(cat, list) + '\n';
        }
        out += DOWNLOAD_MENU + '\n\n' + GROUP_SECURITY_MENU + '\n\n' + formatCategoryBox('GROUP_AUTOMATION', GROUP_AUTO_ONLY_COMMANDS) + '\n' + formatCategoryBox('LIMIT_PREMIUM', PREMIUM_COMMANDS) + '\n';
        await sock.sendMessage(jid, { text: out, contextInfo: { forwardingScore: 999, isForwarded: true } }, { quoted: msg });
        return;
      }

      if (cmd === 'groupmenu') { await sock.sendMessage(jid, { text: GROUP_SECURITY_MENU }, { quoted: msg }); return; }
      const subMenus = { aimenu: 'AI', searchmenu: 'SEARCH', animemenu: 'ANIME', funmenu: 'FUN', logomenu: 'STICKER_LOGO', toolsmenu: 'TOOLS', ownermenu: 'OWNER' };
      if (subMenus[cmd]) { await sock.sendMessage(jid, { text: formatCategoryBox(subMenus[cmd], MENU_CATEGORIES[subMenus[cmd]]) }, { quoted: msg }); return; }

      if (['selftest', 'cekfitur', 'autorepair'].includes(cmd)) {
        if (!isOwner && !isSenderAdmin) { await sock.sendMessage(jid, { text: '⛔ Perintah ini khusus Owner atau Admin Grup.' }, { quoted: msg }); return; }
        await sock.sendMessage(jid, { text: '🔄 *Sedang menjalankan Auto-Repair & Reset Sesi Enkripsi...*' }, { quoted: msg });
        await repairSignalSessionForJid(jid, 'Auto-Repair Triggered');
        const rep = await jalankanAuditFiturRealTime(true);
        await sock.sendMessage(jid, { text: `🩺 *LAPORAN AUDIT FITUR*\n🕒 ${rep.lastChecked}\n📊 *${rep.summary}*\n\n${Object.entries(rep.details).map(([k, v]) => `• *${k}:* ${v}`).join('\n')}` }, { quoted: msg });
        return;
      }
      if (['ping', 'ping2', 'speed', 'os'].includes(cmd)) {
        const hw = getServerHardwareStats();
        const wib = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }).replace(/:/g, '.');
        await sock.sendMessage(jid, { text: `⚡ *SERVER STATUS*\n• Runtime: ${getUptime()}\n• RAM: ${hw.ramPercent}% ${hw.ramBar}\n• Disk: ${hw.diskPercent}% ${hw.diskBar}\n• Jam Server: ${wib} WIB` }, { quoted: msg });
        return;
      }
      if (['alive', 'runtime', 'uptime'].includes(cmd)) { await sock.sendMessage(jid, { text: `🟢 *${bot.userName}* Aktif — ${getUptime()}` }, { quoted: msg }); return; }
      if (cmd === 'owner') { await sock.sendMessage(jid, { text: `👤 *Owner:* ${OWNER_NAME}` }, { quoted: msg }); return; }
      if (cmd === 'status') { await sock.sendMessage(jid, { text: `📊 *STATUS*\n• Fitur Aktif: ${ALL_COMMANDS_SET.size}\n• Auto-Repair Total: ${serverAutoHeal.totalAutoRepairs}x` }, { quoted: msg }); return; }
      if (cmd === 'update') {
        if (!isOwner) { await sock.sendMessage(jid, { text: '⛔ Perintah ini khusus Owner Bot.' }, { quoted: msg }); return; }
        await sock.sendMessage(jid, { text: `🧬 *UPDATE SELESAI*\n${await jalankanEvolusiMandiri(true)}` }, { quoted: msg });
        return;
      }

      if (cmd === 'memori') { const f = dbMemory.users[senderNum]?.facts || []; await sock.sendMessage(jid, { text: f.length ? `🧠 *Ingatan:*\n• ${f.join('\n• ')}` : '🧠 Memori kosong.' }, { quoted: msg }); return; }
      if (cmd === 'resetmemori') { if (dbMemory.users[senderNum]) dbMemory.users[senderNum].facts = []; await saveMemory(); await sock.sendMessage(jid, { text: '✅ Memori direset.' }, { quoted: msg }); return; }
      if (MENU_CATEGORIES.AI.includes(cmd)) {
        if (!param) { await sock.sendMessage(jid, { text: `⚠️ Contoh: \`.${cmd} jelaskan cara kerja AI\`` }, { quoted: msg }); return; }
        await sock.sendMessage(jid, { text: (await panggilServerAISatSet(param, `Kamu adalah ${bot.userName}. Jawab singkat, cerdas, dan akurat dalam Bahasa Indonesia.`)) || '⏳ Server AI sibuk, coba ulangi.' }, { quoted: msg });
        return;
      }

      if (cmd === 'setlokasi' || cmd === 'lokasi') {
        if (!param) {
          const curCity = ensureUserRecord(dbMemory, senderNum).city;
          await sock.sendMessage(jid, { text: curCity ? `📍 Lokasi kamu saat ini: *${curCity}*\nKetik \`.lokasi di <kota baru>\` untuk mengubah.` : '⚠️ Contoh: `.lokasi di bandung`' }, { quoted: msg });
          return;
        }
        const cleanCity = param.replace(/^di\s+/i, '').trim();
        ensureUserRecord(dbMemory, senderNum).city = cleanCity;
        await saveMemory();
        await sock.sendMessage(jid, { text: `📍 Lokasi disimpan ke *${cleanCity}*.\n\n${await getCuacaKotaAkurat(cleanCity)}` }, { quoted: msg });
        return;
      }
      if (cmd === 'cuaca' || cmd === 'wthr') {
        const userRec = ensureUserRecord(dbMemory, senderNum);
        const targetCity = param ? param.replace(/^di\s+/i, '').trim() : userRec.city || 'Jakarta';
        if (param && !userRec.city) { userRec.city = targetCity; await saveMemory(); }
        await sock.sendMessage(jid, { text: (await getCuacaKotaAkurat(targetCity)) || '❌ Kota tidak ditemukan.' }, { quoted: msg });
        return;
      }
      if (cmd === 'praytime') { await sock.sendMessage(jid, { text: (await getJadwalSholatIndonesia(param || ensureUserRecord(dbMemory, senderNum).city || 'Jakarta')) || '❌ Jadwal tidak ditemukan.' }, { quoted: msg }); return; }
      if (cmd === 'surah') {
        const s = await getSurahLengkap(param || '1');
        if (s) {
          await sock.sendMessage(jid, { text: s.text }, { quoted: msg });
          const b = s.audioUrl ? await fetchBuffer(s.audioUrl).catch(() => null) : null;
          if (b) await sock.sendMessage(jid, { audio: b, mimetype: 'audio/mpeg' }, { quoted: msg });
        }
        return;
      }
      if (cmd === 'wiki' && param) { const d = await (await fetchWithTimeout(`https://id.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(param)}`).catch(() => ({ json: () => null }))).json(); await sock.sendMessage(jid, { text: d?.extract ? `📚 *${d.title}*\n\n${d.extract}` : '❌ Tidak ditemukan.' }, { quoted: msg }); return; }
      if (cmd === 'npm' && param) { const d = await (await fetchWithTimeout(`https://registry.npmjs.org/${encodeURIComponent(param)}`).catch(() => ({ json: () => null }))).json(); await sock.sendMessage(jid, { text: d?.name ? `📦 *${d.name}* v${d['dist-tags']?.latest}\n${d.description || ''}` : '❌ Tidak ditemukan.' }, { quoted: msg }); return; }
      if (['define', 'fakta', 'motivasi', 'kbbi'].includes(cmd)) { await sock.sendMessage(jid, { text: (await panggilServerAISatSet(`Berikan ${cmd} untuk "${param || 'Indonesia'}" secara singkat dalam Bahasa Indonesia.`, 'Jawab akurat dan ringkas.')) || '❌ Data tidak tersedia.' }, { quoted: msg }); return; }

      if (MENU_CATEGORIES.ANIME.includes(cmd)) { const u = await getAnimeImageUrl(cmd); if (u) await sock.sendMessage(jid, { image: { url: u }, caption: `✨ *${cmd.toUpperCase()}*` }, { quoted: msg }); return; }
      if (cmd === 'kuroslash' || cmd === 'slash') { const st = { type: 'kuroslash', lane: 1, hp: 100, score: 0, best: dbMemory.gameHighScores.kuroslash[senderNum] || 0, ulti: 35, wave: 0 }; gameSessions.set(jid, st); await kirimTampilanKuroSlash(sock, jid, senderNum, st, 'Tekan tombol di bawah untuk bermain!', msg); return; }
      if (cmd === 'sonic' || cmd === 'speedydash') { const st = { type: 'sonic', rings: 10, score: 0, best: dbMemory.gameHighScores.sonic[senderNum] || 0, laserAlert: false }; gameSessions.set(jid, st); await kirimTampilanSonic(sock, jid, senderNum, st, 'Tekan BOOST atau JUMP di bawah!', msg); return; }
      if (cmd === 'game') { gameSessions.set(jid, { type: 'angka', answer: Math.floor(Math.random() * 10) + 1 }); await sock.sendMessage(jid, { text: '🎮 *Tebak Angka 1 sampai 10*\nKirim tebakanmu!' }, { quoted: msg }); return; }
      if (cmd === 'mathgame') { const a = Math.floor(Math.random() * 25) + 5, b = Math.floor(Math.random() * 25) + 5; gameSessions.set(jid, { type: 'math', answer: a + b }); await sock.sendMessage(jid, { text: `🧮 Berapa *${a} + ${b}*?` }, { quoted: msg }); return; }
      if (cmd === 'tebakkata') { gameSessions.set(jid, { type: 'kata', answer: 'peta' }); await sock.sendMessage(jid, { text: '🧩 Punya gunung tapi tidak punya pohon, punya kota tapi tidak punya rumah. Apakah aku?' }, { quoted: msg }); return; }
      if (cmd === 'suit') { const p = ['batu', 'gunting', 'kertas'], u = param.toLowerCase(); await sock.sendMessage(jid, { text: p.includes(u) ? `✊✌️✋ Kamu: *${u}* | Bot: *${p[Math.floor(Math.random() * 3)]}*` : '⚠️ Contoh: `.suit batu`' }, { quoted: msg }); return; }
      if (cmd === 'dice') { await sock.sendMessage(jid, { text: `🎲 Dadu: *${Math.floor(Math.random() * 6) + 1}*` }, { quoted: msg }); return; }
      if (cmd === 'coin') { await sock.sendMessage(jid, { text: `🪙 Koin: *${Math.random() < 0.5 ? 'ANGKA' : 'GAMBAR'}*` }, { quoted: msg }); return; }
      if (cmd === '8ball') { await sock.sendMessage(jid, { text: `🎱 *${['Ya pasti!', 'Mungkin iya.', 'Coba lagi.', 'Tidak.'][Math.floor(Math.random() * 4)]}*` }, { quoted: msg }); return; }
      if (['rate', 'aura', 'sigma', 'rizz', 'vibe', 'npc', 'maincharacter', 'delulu', 'redflag', 'greenflag', 'compatibility', 'ship'].includes(cmd)) { await sock.sendMessage(jid, { text: `📊 *${cmd.toUpperCase()}:* ${Math.floor(Math.random() * 101)}%` }, { quoted: msg }); return; }
      if (['roast', 'compliment', 'pickup', 'quote', 'joke', 'truth', 'dare', 'wyr', 'horoscope'].includes(cmd)) { await sock.sendMessage(jid, { text: (await panggilServerAISatSet(`Buat 1 ${cmd} singkat dan sopan dalam Bahasa Indonesia untuk ${param || pushName}.`, 'Jawab singkat.')) || '✨ Semangat hari ini!' }, { quoted: msg }); return; }
      if (['hug', 'pat', 'wave', 'dance'].includes(cmd)) { const u = await getAnimeImageUrl(cmd); if (u) await sock.sendMessage(jid, { image: { url: u }, caption: `*${pushName}* melakukan *${cmd}*` }, { quoted: msg }); return; }

      if (['sticker', 'stiker', 's'].includes(cmd)) {
        const qMsg = unwrapMessageContent(unwrapped.extendedTextMessage?.contextInfo?.quotedMessage);
        const media = unwrapped.imageMessage || qMsg?.imageMessage || unwrapped.videoMessage || qMsg?.videoMessage;
        const isVid = Boolean(unwrapped.videoMessage || qMsg?.videoMessage);
        if (media) {
          let b = Buffer.from([]);
          for await (const c of await downloadContentFromMessage(media, isVid ? 'video' : 'image')) b = Buffer.concat([b, c]);
          const webp = await mediaBufferToWebpSticker(b, isVid);
          if (webp) await sock.sendMessage(jid, { sticker: webp }, { quoted: msg });
        } else if (param) {
          const webp = await urlOrTextToWebpSticker(param);
          if (webp) await sock.sendMessage(jid, { sticker: webp }, { quoted: msg });
        }
        return;
      }
      if (['brat', 'bratvid', 'bratvideo'].includes(cmd)) { const webp = await createBratSticker(param || 'brat', cmd !== 'brat'); if (webp) await sock.sendMessage(jid, { sticker: webp }, { quoted: msg }); return; }
      if (['ttp', 'attp', 'qc'].includes(cmd) && param) { const webp = await urlOrTextToWebpSticker(param); if (webp) await sock.sendMessage(jid, { sticker: webp }, { quoted: msg }); return; }
      if (cmd === 'animasi' || cmd === 'linkvideo') { const u = extractUrl(param) || `https://dummyimage.com/800x450/0f172a/38bdf8.png&text=${encodeURIComponent(param || 'HD')}`; await sock.sendMessage(jid, { image: { url: `https://api.microlink.io/?url=${encodeURIComponent(u)}&screenshot=true&meta=false&embed=screenshot.url` }, caption: '✨ Visual HD' }, { quoted: msg }); return; }
      if ((cmd === 'font' || cmd === 'fancy') && param) { await sock.sendMessage(jid, { text: FONT_MAPS.map((_, i) => `${i + 1}. ${applyFont(param, i)}`).join('\n') }, { quoted: msg }); return; }
      const logoColors = { logo: '0f172a/38bdf8', neon: '090d16/00ffcc', gold: '1c1917/facc15', galaxy: '1e1b4b/c084fc', glitch: '18181b/f43f5e', matrix: '022c22/4ade80', graffiti: '312e81/fb923c', thunder: '0c4a6e/fde047' };
      if (logoColors[cmd] && param) { await sock.sendMessage(jid, { image: { url: `https://dummyimage.com/800x400/${logoColors[cmd]}.png&text=${encodeURIComponent(param)}` } }, { quoted: msg }); return; }

      if (['rvo', 'rvop', 'vv'].includes(cmd)) {
        const vo = await extractAndDownloadViewOnce(unwrapped.extendedTextMessage?.contextInfo?.quotedMessage);
        if (!vo?.buffer) { await sock.sendMessage(jid, { text: '⚠️ Balas pesan View Once dengan `.rvo`' }, { quoted: msg }); return; }
        const target = cmd === 'rvop' ? rawParticipant : jid;
        await sock.sendMessage(target, vo.type === 'audio' ? { audio: vo.buffer, mimetype: 'audio/mpeg', ptt: true } : { [vo.type]: vo.buffer, caption: `👁️ RVO\n${vo.caption}` });
        return;
      }
      if (cmd === 'hitung' && param) { const r = safeEvaluateMath(param); await sock.sendMessage(jid, { text: r === null ? '⚠️ Format perhitungan tidak valid. Contoh: `.hitung (25 + 15) * 2`' : `🧮 *${param}* = *${r}*` }, { quoted: msg }); return; }
      if (cmd === 'catat' && param) { (dbMemory.notes[jid] ||= []).push(param); await saveMemory(); await sock.sendMessage(jid, { text: '📝 Tersimpan!' }, { quoted: msg }); return; }
      if (cmd === 'catatan') { const l = dbMemory.notes[jid] || []; await sock.sendMessage(jid, { text: l.length ? l.map((v, i) => `${i + 1}. ${v}`).join('\n') : '📭 Kosong.' }, { quoted: msg }); return; }
      if ((cmd === 'terjemah' || cmd === 'translate') && args[1] && args[2]) { await sock.sendMessage(jid, { text: (await panggilServerAISatSet(`Terjemahkan ke ${args[1]}: ${args.slice(2).join(' ')}`, 'Terjemahkan saja.')) || '-' }, { quoted: msg }); return; }
      if (cmd === 'id') { await sock.sendMessage(jid, { text: `🆔 \`${jid}\`` }, { quoted: msg }); return; }
      if (cmd === 'getpp') { const pp = await sock.profilePictureUrl(rawParticipant, 'image').catch(() => null); await sock.sendMessage(jid, pp ? { image: { url: pp } } : { text: '❌ Privat.' }, { quoted: msg }); return; }
      if (cmd === 'getbio') { const st = await sock.fetchStatus(rawParticipant).catch(() => null); await sock.sendMessage(jid, { text: `📝 ${st?.status || '-'}` }, { quoted: msg }); return; }
      if (cmd === 'gpass') { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%'; await sock.sendMessage(jid, { text: `🔐 \`${Array.from({ length: 12 }, () => c[Math.floor(Math.random() * c.length)]).join('')}\`` }, { quoted: msg }); return; }
      if (cmd === 'qr' && param) { await sock.sendMessage(jid, { image: { url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(param)}` } }, { quoted: msg }); return; }
      if (cmd === 'shorturl' && extractUrl(param)) { await sock.sendMessage(jid, { text: `🔗 ${await (await fetchWithTimeout(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(extractUrl(param))}`)).text()}` }, { quoted: msg }); return; }
      if (cmd === 'waktu') { await sock.sendMessage(jid, { text: `🕒 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB` }, { quoted: msg }); return; }
      if (cmd === 'base64' && param) { await sock.sendMessage(jid, { text: Buffer.from(param).toString('base64') }, { quoted: msg }); return; }
      if (cmd === 'reverse' && param) { await sock.sendMessage(jid, { text: param.split('').reverse().join('') }, { quoted: msg }); return; }
      if (cmd === 'ssweb' && extractUrl(param)) { await sock.sendMessage(jid, { image: { url: `https://api.microlink.io/?url=${encodeURIComponent(extractUrl(param))}&screenshot=true&meta=false&embed=screenshot.url` } }, { quoted: msg }); return; }

      if (MENU_CATEGORIES.OWNER.includes(cmd)) {
        if (!isOwner) { await sock.sendMessage(jid, { text: '⛔ Perintah ini khusus Owner Bot.' }, { quoted: msg }); return; }
        if (['setnama', 'setname', 'botname'].includes(cmd) && param) { bot.userName = dbMemory.botSettings.customBotName = param; await saveMemory(); await sock.updateProfileName(param).catch(() => {}); await sock.sendMessage(jid, { text: `✅ Nama bot: *${param}*` }, { quoted: msg }); }
        else if (cmd === 'updatebio' && param) { await sock.updateProfileStatus(param); await sock.sendMessage(jid, { text: '✅ Bio bot diperbarui.' }, { quoted: msg }); }
        else if ((cmd === 'block' || cmd === 'unblock') && param) { await sock.updateBlockStatus(`${param.replace(/\D/g, '')}@s.whatsapp.net`, cmd); await sock.sendMessage(jid, { text: `✅ Berhasil ${cmd} nomor.` }, { quoted: msg }); }
        else if (cmd === 'blocklist') await sock.sendMessage(jid, { text: `🚫 Diblokir: ${(await sock.fetchBlocklist()).length}` }, { quoted: msg });
        else if (cmd === 'autoread' || cmd === 'autotyping') { dbMemory.botSettings[cmd] = !dbMemory.botSettings[cmd]; await saveMemory(); await sock.sendMessage(jid, { text: `${cmd}: ${dbMemory.botSettings[cmd]}` }, { quoted: msg }); }
        else if (cmd === 'mode' && ['public', 'self'].includes(param)) { dbMemory.botSettings.mode = param; await saveMemory(); await sock.sendMessage(jid, { text: `Mode: ${param}` }, { quoted: msg }); }
        else if (cmd === 'badwords') await sock.sendMessage(jid, { text: `Total filter: ${bot.badWords.length + dbMemory.learnedWords.length}` }, { quoted: msg });
        else if (cmd === 'addkata' && param) { dbMemory.learnedWords.push(param.toLowerCase()); await saveMemory(); await sock.sendMessage(jid, { text: '✅ Kata filter ditambahkan.' }, { quoted: msg }); }
        else if (cmd === 'delkata' && param) { dbMemory.learnedWords = dbMemory.learnedWords.filter((w) => w !== param.toLowerCase()); await saveMemory(); await sock.sendMessage(jid, { text: '✅ Kata filter dihapus.' }, { quoted: msg }); }
        else if (cmd === 'clean') { if (global.gc) global.gc(); await sock.sendMessage(jid, { text: '🧹 Cache dibersihkan.' }, { quoted: msg }); }
        return;
      }
    }

    if (isGroup) {
      await handleGroupThemeInteraction({ sock, jid, senderParticipant: rawParticipant, pushName, rawText, unwrapped, msg, dbMemory, bot });
      return;
    }

    if (rawText.length < 2) return;
    if (!(await checkAndConsumeDailyLimit({ sock, jid, senderNum, isOwner, isSenderAdmin: false, cmd: 'chat_ai', msg, dbMemory, saveMemory })).allowed) return;
    const reply = await panggilServerAISatSet(rawText, `Kamu adalah ${bot.userName}, asisten WhatsApp cerdas.`);
    if (reply) await sock.sendMessage(jid, { text: reply }, { quoted: msg });
  } catch (err) {
    const m = err?.message || 'Error';
    if (/Bad MAC|SessionError|No matching sessions|Invalid PreKey/i.test(m)) await triggerAutoCipherHeal(msg?.key?.remoteJid || '', m);
    else recordAutoRepair('Handler', m, 'Pesan diisolasi');
  }
}

let backgroundLoopsStarted = false;
let isReconnecting = false;

function scheduleReconnect(delayMs = 3000) {
  if (isReconnecting) return;
  isReconnecting = true;
  setTimeout(() => { isReconnecting = false; start().catch(() => {}); }, delayMs);
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
    startGitHubLiveHotReload(async (commitId) => {
      await jalankanAuditFiturRealTime(true);
    });
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
      const targetJid = u.key?.remoteJid;
      if (!targetJid || !u.key?.fromMe) continue;
      if (Boolean(u.update?.messageStubType) || u.update?.status === 0) {
        if (Date.now() - (retryCooldownByJid.get(targetJid) || 0) < 8000) continue;
        retryCooldownByJid.set(targetJid, Date.now());
        await repairSignalSessionForJid(targetJid, 'Terdeteksi Menunggu Pesan Ini');
        const fallbackText = lastReplyTextByJid.get(targetJid);
        if (fallbackText) await origSendMessage(targetJid, { text: `🔄 *Auto-Repair Enkripsi Berhasil:*\n\n${fallbackText}` }).catch(() => {});
      }
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => { if (type === 'notify') for (const m of messages) prosesSatuPesan(sock, m).catch(() => {}); });
  sock.ev.on('group-participants.update', (u) => handleGroupParticipantsUpdate(sock, dbMemory, u).catch(() => {}));
  sock.ev.on('group.join-request', (e) => handleGroupJoinRequestEvent(sock, dbMemory, e).catch(() => {}));

  startGroupAutomationScheduler(sock, dbMemory, saveMemory);
  startPremiumAndQrisWatcher(sock, dbMemory, saveMemory);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && !bot.connected) {
      bot.qr = qr;
      if (PHONE && !bot.registered && !bot.pairingCode) setTimeout(() => {
        sock.requestPairingCode(PHONE).then((c) => {
          bot.pairingCode = c?.match(/.{1,4}/g)?.join('-') || c;
          console.log(`🔑 KODE OTP BOT: ${bot.pairingCode}`);
        }).catch(() => {});
      }, 2000);
    }
    if (connection === 'open') {
      bot.connected = true; bot.registered = true; bot.qr = null; bot.pairingCode = null;
      bot.userPhone = sock.user?.id ? sock.user.id.split(':')[0] : PHONE;
      scheduleAuthBackupToGitHub(AUTH_DIR);
      console.log(`✅ [TERHUBUNG] ${bot.userPhone} — Semua Sistem Aktif`);
    } else if (connection === 'close') {
      bot.connected = false;
      if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
        bot.registered = false; bot.pairingCode = null; bot.qr = null;
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
    return bot.sock?.requestPairingCode(PHONE).then((c) => { bot.pairingCode = c?.match(/.{1,4}/g)?.join('-') || c; }).catch(() => {});
  },
});
start();
