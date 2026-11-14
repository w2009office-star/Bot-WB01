import fs from 'fs';
import fsPromises from 'fs/promises';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadContentFromMessage,
} from '@whiskeysockets/baileys';
import pino from 'pino';

import {
  restoreAuthFromGitHub,
  scheduleAuthBackupToGitHub,
  startGitHubLiveHotReload,
  setupGracefulShutdown,
} from './github_sync.js';

import {
  SPOTIFY_LIVE_BUTTON_IDS,
  handleSpotifyLiveButton,
} from './spotify_live.js';

import {
  GROUP_AUTO_COMMANDS,
  handleGroupParticipantsUpdate,
  handleGroupJoinRequestEvent,
  startGroupAutomationScheduler,
  handleGroupAutomationCommand,
  handleGroupThemeInteraction,
} from './group_automation.js';

import {
  PREMIUM_COMMANDS,
  ensureUserRecord,
  checkAndConsumeDailyLimit,
  handlePremiumCommand,
  startPremiumAndQrisWatcher,
} from './premium_limit.js';

import {
  fetchWithTimeout,
  fetchBuffer,
  extractUrl,
  downloadTikTok,
  downloadCapCut,
  searchYouTube,
  downloadYouTube,
  downloadSocialMedia,
  mediaBufferToWebpSticker,
  createBratSticker,
  urlOrTextToWebpSticker,
  extractAndDownloadViewOnce,
  sendNativeInteractiveButtons,
  panggilServerAISatSet,
  getAnimeImageUrl,
} from './engines.js';

import {
  initFeatures,
  serverAutoHeal,
  recordAutoRepair,
  repairSignalSessionForJid,
  jalankanAudit209FiturRealTime,
  MENU_CATEGORIES,
  ALL_COMMANDS_SET,
  formatCategoryBox,
  getUptime,
  getTodayDateString,
  getIndonesianFullDateTime,
  getServerHardwareStats,
  getCuacaIndonesia,
  getJadwalSholatIndonesia,
  getSurahLengkap,
  FONT_MAPS,
  applyFont,
  kirimTampilanKuroSlash,
  kirimTampilanSonic,
  mulaiWeb,
} from './features.js';

// ============================================================
// PENYADAP REAL-TIME ERROR DEKRIPSI ("MENUNGGU PESAN INI" / BAD MAC)
// ============================================================
let cipherRepairLock = false;
async function triggerAutoCipherHeal(jid = '', reason = 'Bad MAC / Decryption Failure') {
  if (cipherRepairLock) return;
  cipherRepairLock = true;
  try {
    await repairSignalSessionForJid(jid, reason);
  } finally {
    setTimeout(() => {
      cipherRepairLock = false;
    }, 4000);
  }
}

const origConsoleError = console.error;
console.error = (...args) => {
  const joined = args.map((a) => (a?.message ? a.message : String(a))).join(' ');
  if (/Bad MAC|SessionError|No matching sessions|Invalid PreKey|decrypt/i.test(joined)) {
    triggerAutoCipherHeal('', 'Console Signal Decryption Error').catch(() => {});
  }
  origConsoleError.apply(console, args);
};

process.on('uncaughtException', (err) => {
  const msg = err?.message || 'Error';
  if (/Bad MAC|SessionError|No matching sessions|Invalid PreKey/i.test(msg)) {
    triggerAutoCipherHeal('', msg.slice(0, 45)).catch(() => {});
    return;
  }
  recordAutoRepair('ProcessGuard', msg, 'Proses tetap berjalan normal');
});

process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  if (/Bad MAC|SessionError|No sessions|No matching sessions|Invalid PreKey|Timed Out/i.test(msg)) {
    triggerAutoCipherHeal('', msg.slice(0, 45)).catch(() => {});
  }
});

const PHONE = (process.env.PHONE_NUMBER || '').replace(/\D/g, '');
const AUTH_DIR = process.env.AUTH_DIR || './auth';
const MEMORY_FILE = './memory.json';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const OWNER_NAME = process.env.OWNER_NAME || 'Maverick';
const BOT_CODE_TAG = process.env.BOT_CODE_TAG || 'WhuxenXDev';
const MENU_BANNER_LINK = process.env.MENU_BANNER_LINK || '';

const bot = {
  sock: null,
  connected: false,
  registered: false,
  qr: null,
  pairingCode: null,
  startTime: Date.now(),
  userPhone: null,
  userName: 'WHUXEN BOT',
  stats: {
    totalDeletedBadWords: 0,
    totalDeletedLinks: 0,
    totalBlockedVirtek: 0,
    lastCleanupTime: new Date().toLocaleString('id-ID'),
  },
  badWords: ['anjing', 'babi', 'kunyuk', 'bajingan', 'goblok', 'tolol', 'bangsat', 'brengsek', 'jancok', 'pantek'],
  blockedDomains: ['judionline', 'slotgacor', 'situs-terlarang.com', 'link-spam.xyz'],
};

let dbMemory = {
  version: 9.6,
  lastUpdateDate: '',
  updateLogs: [],
  users: {},
  pendingInvoices: [],
  learnedWords: [],
  notes: {},
  groupSettings: {},
  gameHighScores: { kuroslash: {}, sonic: {} },
  botSettings: { mode: 'public', autoread: false, autotyping: true, customBotName: '' },
  healthReport: { lastChecked: '-', summary: '209/209 Fitur Valid + Auto Link + Cuaca Kota + Limit QRIS', details: {}, autoRepairs: [], totalRepairs: 0 },
};

async function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const parsed = JSON.parse(await fsPromises.readFile(MEMORY_FILE, 'utf-8'));
      dbMemory = {
        ...dbMemory,
        ...parsed,
        pendingInvoices: Array.isArray(parsed.pendingInvoices) ? parsed.pendingInvoices : [],
        botSettings: { ...dbMemory.botSettings, ...(parsed.botSettings || {}) },
        healthReport: { ...dbMemory.healthReport, ...(parsed.healthReport || {}) },
        gameHighScores: {
          kuroslash: { ...(parsed.gameHighScores?.kuroslash || {}) },
          sonic: { ...(parsed.gameHighScores?.sonic || {}) },
        },
      };
      if (dbMemory.botSettings.customBotName) bot.userName = dbMemory.botSettings.customBotName;
    }
  } catch {
    await saveMemory();
  }
}

async function saveMemory() {
  try {
    await fsPromises.writeFile(MEMORY_FILE, JSON.stringify(dbMemory, null, 2), 'utf-8');
  } catch {}
}

async function jalankanEvolusiMandiri(paksaManual = false) {
  const hariIni = getTodayDateString();
  if (!paksaManual && dbMemory.lastUpdateDate === hariIni) return false;
  serverAutoHeal.isUpdating = true;
  serverAutoHeal.updateProgressText = '🔄 SEDANG UPDATE SISTEM DI LAYAR BELAKANG...';
  dbMemory.version = Number((dbMemory.version + 0.1).toFixed(1));
  dbMemory.lastUpdateDate = hariIni;
  const log = `v${dbMemory.version} (${hariIni}): 209 Fitur Valid + Simple Play + Auto Link + Cuaca Kota User + Limit QRIS 7-Hari.`;
  dbMemory.updateLogs.unshift(log);
  await saveMemory();
  serverAutoHeal.isUpdating = false;
  serverAutoHeal.updateProgressText = `✅ ${serverAutoHeal.validCount}/209 Fitur VALID & Group Auto Aktif`;
  return log;
}

const gameSessions = new Map();
const userCooldowns = new Map();
const antiFloodTracker = new Map();
const lastPlaySession = new Map();
const sentMessageCache = new Map();
const lastReplyTextByJid = new Map();
const retryCooldownByJid = new Map();

function rememberOutgoingMessage(keyId, messageObj) {
  if (!keyId || !messageObj) return;
  sentMessageCache.set(keyId, messageObj);
  if (sentMessageCache.size > 300) {
    const oldestKey = sentMessageCache.keys().next().value;
    sentMessageCache.delete(oldestKey);
  }
}

initFeatures({
  bot,
  dbMemory,
  saveMemory,
  jalankanEvolusiMandiri,
  AUTH_DIR,
  PHONE,
  GEMINI_API_KEY,
  OWNER_NAME,
  userCooldowns,
  antiFloodTracker,
});

// Daftarkan perintah tambahan ke ALL_COMMANDS_SET
['spotifylive', 'splive', 'play', 'play2', 'song', 'spotify', 'setlokasi', 'lokasi'].forEach((c) =>
  ALL_COMMANDS_SET.add(c)
);
GROUP_AUTO_COMMANDS.forEach((c) => ALL_COMMANDS_SET.add(c));
PREMIUM_COMMANDS.forEach((c) => ALL_COMMANDS_SET.add(c));

function getGroupConfig(jid) {
  if (!dbMemory.groupSettings[jid]) {
    dbMemory.groupSettings[jid] = { antilink: false, antivirtek: true, antibug: true, antitoxic: true, antispam: true, welcome: false };
  }
  return dbMemory.groupSettings[jid];
}

function unwrapMessageContent(rawMsg) {
  let m = rawMsg || {};
  for (let i = 0; i < 5; i++) {
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    else if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    else if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    else if (m.viewOnceMessageV2Extension?.message) m = m.viewOnceMessageV2Extension.message;
    else if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;
    else break;
  }
  return m;
}

function extractIncomingTextAndButton(msg) {
  const m = unwrapMessageContent(msg.message);
  const nativeResponse = m.interactiveResponseMessage?.nativeFlowResponseMessage;
  if (nativeResponse?.paramsJson) {
    try {
      const parsed = typeof nativeResponse.paramsJson === 'string' ? JSON.parse(nativeResponse.paramsJson) : nativeResponse.paramsJson;
      if (parsed?.id) return String(parsed.id).trim();
    } catch {}
  }
  if (m.buttonsResponseMessage?.selectedButtonId) return String(m.buttonsResponseMessage.selectedButtonId).trim();
  if (m.templateButtonReplyMessage?.selectedId) return String(m.templateButtonReplyMessage.selectedId).trim();
  if (m.listResponseMessage?.singleSelectReply?.selectedRowId) return String(m.listResponseMessage.singleSelectReply?.selectedRowId).trim();

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    ''
  ).trim();
}

async function mintaKodePairing(sock, phone) {
  try {
    if (!phone || sock.authState.creds.registered) return;
    const code = await sock.requestPairingCode(phone);
    bot.pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
    console.log(`🔑 KODE OTP BOT: ${bot.pairingCode}`);
  } catch {
    bot.pairingCode = 'Gagal memuat OTP';
  }
}

// ============================================================
// HELPER CUACA SESUAI TITIK KOTA USER
// ============================================================
async function getCuacaKotaAkurat(cityName) {
  const cleanCity = (cityName || 'Jakarta').trim();
  try {
    const geoRes = await fetchWithTimeout(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cleanCity)}&count=1&language=id&format=json`,
      {},
      10000
    );
    const geo = await geoRes.json();
    const loc = geo?.results?.[0];
    if (loc) {
      const wRes = await fetchWithTimeout(
        `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FJakarta&forecast_days=3`,
        {},
        10000
      );
      const w = await wRes.json();
      const cur = w?.current;
      if (cur) {
        const wmoMap = {
          0: '☀️ Cerah',
          1: '🌤️ Cerah Berawan',
          2: '⛅ Berawan Sebagian',
          3: '☁️ Mendung / Berawan',
          45: '🌫️ Berkabut',
          48: '🌫️ Kabut Tebal',
          51: '🌦️ Gerimis Ringan',
          53: '🌦️ Gerimis Sedang',
          55: '🌧️ Gerimis Lebat',
          61: '🌧️ Hujan Ringan',
          63: '🌧️ Hujan Sedang',
          65: '⛈️ Hujan Lebat',
          80: '🌦️ Hujan Lokal Ringan',
          81: '🌧️ Hujan Lokal Sedang',
          82: '⛈️ Hujan Lokal Lebat',
          95: '⛈️ Hujan Petir',
          96: '⛈️ Hujan Petir & Angin',
        };
        const kondisi = wmoMap[cur.weather_code] || '🌤️ Berawan';
        const region = [loc.name, loc.admin1, loc.country].filter(Boolean).join(', ');
        const rainChance = w?.daily?.precipitation_probability_max?.[0] ?? '-';
        const minT = w?.daily?.temperature_2m_min?.[0] ?? '-';
        const maxT = w?.daily?.temperature_2m_max?.[0] ?? '-';

        return (
          `🌤️ *PRAKIRAAN CUACA — ${loc.name.toUpperCase()}*\n` +
          `📍 Titik Lokasi: *${region}*\n\n` +
          `• Kondisi: *${kondisi}*\n` +
          `• Suhu Saat Ini: *${cur.temperature_2m}°C* (Terasa ${cur.apparent_temperature}°C)\n` +
          `• Suhu Hari Ini: *${minT}°C – ${maxT}°C*\n` +
          `• Kelembapan: *${cur.relative_humidity_2m}%*\n` +
          `• Kecepatan Angin: *${cur.wind_speed_10m} km/jam*\n` +
          `• Peluang Hujan: *${rainChance}%*\n\n` +
          `_Ketik *"lokasi di <kota>"* untuk mengganti titik kota otomatis kamu._`
        );
      }
    }
  } catch {}

  return await getCuacaIndonesia(cleanCity);
}

// ============================================================
// HELPER DOWNLOAD LINK LANGSUNG (TANPA PERINTAH)
// ============================================================
async function handleDirectUrlAutoDownload(sock, jid, url, msg) {
  const lower = url.toLowerCase();

  // 1. TikTok
  if (/tiktok\.com/i.test(lower)) {
    const res = await downloadTikTok(url);
    if (!res) return false;
    if (res.type === 'image') {
      for (const imgU of res.images.slice(0, 8)) {
        const b = await fetchBuffer(imgU, 'https://www.tiktok.com/').catch(() => null);
        if (b) await sock.sendMessage(jid, { image: b }, { quoted: msg });
      }
    } else if (res.videoUrl) {
      const vBuf = await fetchBuffer(res.videoUrl, 'https://www.tiktok.com/').catch(() => null);
      await sock.sendMessage(
        jid,
        vBuf
          ? { video: vBuf, caption: `🎬 *TikTok*\n${res.title || ''}` }
          : { video: { url: res.videoUrl }, caption: `🎬 *TikTok*\n${res.title || ''}` },
        { quoted: msg }
      );
    }
    return true;
  }

  // 2. CapCut
  if (/capcut\.com/i.test(lower)) {
    const cc = await downloadCapCut(url);
    if (!cc?.url) return false;
    const vBuf = await fetchBuffer(cc.url, 'https://www.capcut.com/').catch(() => null);
    await sock.sendMessage(
      jid,
      vBuf
        ? { video: vBuf, caption: `🎬 *${cc.title || 'CapCut'}*` }
        : { video: { url: cc.url }, caption: `🎬 *${cc.title || 'CapCut'}*` },
      { quoted: msg }
    );
    return true;
  }

  // 3. YouTube / Shorts
  if (/youtube\.com\/(watch|shorts)|youtu\.be\//i.test(lower)) {
    const yt = await downloadYouTube(url, false);
    if (!yt?.buffer) return false;
    await sock.sendMessage(jid, { video: yt.buffer, caption: `🎬 *${yt.title || 'YouTube'}*` }, { quoted: msg });
    return true;
  }

  // 4. Instagram, Facebook, Twitter/X, MediaFire, Google Drive
  const platformMap = [
    { regex: /instagram\.com/i, type: 'igdl' },
    { regex: /facebook\.com|fb\.watch/i, type: 'fb' },
    { regex: /twitter\.com|x\.com/i, type: 'twitter' },
    { regex: /mediafire\.com/i, type: 'mediafire' },
    { regex: /drive\.google\.com/i, type: 'gdrive' },
  ];

  const foundPlatform = platformMap.find((p) => p.regex.test(lower));
  if (foundPlatform) {
    const res = await downloadSocialMedia(url, foundPlatform.type);
    if (!res?.url) return false;
    const buf = await fetchBuffer(res.url).catch(() => null);
    if (buf) {
      if (foundPlatform.type === 'mediafire' || foundPlatform.type === 'gdrive') {
        await sock.sendMessage(
          jid,
          { document: buf, fileName: res.filename || 'file', mimetype: 'application/octet-stream' },
          { quoted: msg }
        );
      } else if (res.isImage) {
        await sock.sendMessage(jid, { image: buf }, { quoted: msg });
      } else {
        await sock.sendMessage(jid, { video: buf }, { quoted: msg });
      }
    } else {
      await sock.sendMessage(jid, { text: `🔗 *Link Unduhan:* ${res.url}` }, { quoted: msg });
    }
    return true;
  }

  return false;
}

// ============================================================
// EKSEKUTOR SELURUH 209 FITUR VALID, PLAY SIMPEL, AUTO-LINK & LIMIT QRIS
// ============================================================
async function prosesSatuPesan(sock, msg) {
  try {
    if (!msg.message || msg.key.fromMe) return;
    const jid = msg.key.remoteJid;
    if (!jid || jid === 'status@broadcast') return;

    if (dbMemory.botSettings.autoread) sock.readMessages([msg.key]).catch(() => {});

    const isGroup = jid.endsWith('@g.us');
    const senderParticipant = msg.key.participant || jid;
    const senderNum = senderParticipant.split(':')[0].replace(/\D/g, '');
    const pushName = msg.pushName || 'Member';
    const isOwner = Boolean(PHONE && senderNum === PHONE);

    if (dbMemory.botSettings.mode === 'self' && !isOwner) return;

    const unwrapped = unwrapMessageContent(msg.message);
    const rawText = extractIncomingTextAndButton(msg);
    if (!rawText) return;
    const textLower = rawText.toLowerCase();

    // Cek status Admin Grup
    let isSenderAdmin = isOwner;
    if (isGroup) {
      try {
        const meta = await sock.groupMetadata(jid);
        const sInfo = meta.participants.find(
          (p) => p.id === senderParticipant || p.id.split(':')[0].replace(/\D/g, '') === senderNum
        );
        if (sInfo?.admin === 'admin' || sInfo?.admin === 'superadmin') isSenderAdmin = true;
      } catch {}
    }

    // Proteksi Grup
    if (isGroup) {
      const gCfg = getGroupConfig(jid);

      if (!isSenderAdmin && (gCfg.antivirtek || gCfg.antibug) && (rawText.length > 3500 || (rawText.match(/[\u0300-\u036f]/g) || []).length > 25)) {
        await sock.sendMessage(jid, { delete: msg.key }).catch(() => {});
        bot.stats.totalBlockedVirtek++;
        await sock.groupParticipantsUpdate(jid, [senderParticipant], 'remove').catch(() => {});
        return;
      }

      const allBadWords = [...bot.badWords, ...dbMemory.learnedWords];
      if (!isSenderAdmin && gCfg.antitoxic && allBadWords.some((w) => textLower.includes(w))) {
        await sock.sendMessage(jid, { delete: msg.key }).catch(() => {});
        bot.stats.totalDeletedBadWords++;
        return;
      }
      if (!isSenderAdmin && gCfg.antilink && /(https?:\/\/|chat\.whatsapp\.com|wa\.me\/)/i.test(rawText)) {
        await sock.sendMessage(jid, { delete: msg.key }).catch(() => {});
        bot.stats.totalDeletedLinks++;
        return;
      }
    }

    const cleanAction = textLower.replace(/^[.!/#]/, '').trim();

    // Kontrol Tombol Spotify Live (jika ada sesi lama)
    if (SPOTIFY_LIVE_BUTTON_IDS.has(cleanAction)) {
      await handleSpotifyLiveButton(sock, jid, cleanAction, msg);
      return;
    }

    // Kontrol Sentuh Game di Dalam Chat
    if (cleanAction === 'stopgame' && gameSessions.has(jid)) {
      gameSessions.delete(jid);
      await sock.sendMessage(jid, { text: '🛑 Permainan dihentikan.' }, { quoted: msg });
      return;
    }

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
          else { ev = `⚠️ ULTI baru ${s.ulti}% (tekan ⚔️ TEBAS untuk mengisi)!`; }
        }
        dbMemory.gameHighScores.kuroslash[senderNum] = Math.max(dbMemory.gameHighScores.kuroslash[senderNum] || 0, s.score);
        s.best = dbMemory.gameHighScores.kuroslash[senderNum];
        await saveMemory();
        await kirimTampilanKuroSlash(sock, jid, senderNum, s, ev, msg);
        return;
      }
      if (s.type === 'sonic' && ['boost', 'jump'].includes(cleanAction)) {
        const addR = Math.floor(Math.random() * 7) + 5;
        s.rings += addR;
        s.score += addR * 35;
        s.laserAlert = cleanAction === 'boost' ? Math.random() < 0.45 : false;
        dbMemory.gameHighScores.sonic[senderNum] = Math.max(dbMemory.gameHighScores.sonic[senderNum] || 0, s.score);
        s.best = dbMemory.gameHighScores.sonic[senderNum];
        await saveMemory();
        await kirimTampilanSonic(sock, jid, senderNum, s, `${cleanAction === 'boost' ? '⚡ BOOST' : '⬆️ JUMP'}! +${addR} Gold Rings!`, msg);
        return;
      }
      if (s.type === 'angka' && /^[0-9]+$/.test(rawText)) {
        const g = parseInt(rawText, 10);
        if (g === s.answer) { gameSessions.delete(jid); await sock.sendMessage(jid, { text: `🎉 *BENAR!* Angkanya *${s.answer}*.` }, { quoted: msg }); }
        else { await sock.sendMessage(jid, { text: g < s.answer ? '⬆️ Terlalu KECIL!' : '⬇️ Terlalu BESAR!' }, { quoted: msg }); }
        return;
      }
      if (s.type === 'math' && /^-?[0-9]+$/.test(rawText)) {
        const g = parseInt(rawText, 10);
        gameSessions.delete(jid);
        await sock.sendMessage(jid, { text: g === s.answer ? `🎉 *TEPAT!* Jawabannya *${s.answer}*.` : `❌ Salah! Jawaban: *${s.answer}*.` }, { quoted: msg });
        return;
      }
      if (s.type === 'kata' && !ALL_COMMANDS_SET.has(cleanAction)) {
        gameSessions.delete(jid);
        await sock.sendMessage(jid, { text: textLower === s.answer ? `🎉 *BENAR!* Jawabannya *${s.answer}*.` : `❌ Salah! Jawaban: *${s.answer}*.` }, { quoted: msg });
        return;
      }
    }

    // ============================================================
    // DETEKSI LOKASI KOTA USER NATURAL ("lokasi di bandung", dll)
    // ============================================================
    const locMatch = rawText.match(/^(?:lokasi(?:ku| saya)?|domisili|kota(?:ku)?)\s+(?:di\s+)?([a-zA-Z\s]{3,35})$/i);
    if (locMatch) {
      const city = locMatch[1].trim();
      const userObj = ensureUserRecord(dbMemory, senderNum);
      userObj.city = city;
      await saveMemory();
      const cuacaText = await getCuacaKotaAkurat(city);
      await sock.sendMessage(
        jid,
        { text: `📍 Titik lokasi kamu disimpan ke *${city}*.\n\n${cuacaText}` },
        { quoted: msg }
      );
      return;
    }

    // Deteksi pertanyaan cuaca natural ("cuaca di bandung", "perkiraan cuaca bandung")
    const naturalWeatherMatch = rawText.match(/^(?:prakiraan\s+|perkiraan\s+)?cuaca(?:\s+(?:di|kota))?\s+([a-zA-Z\s]{3,35})$/i);
    if (naturalWeatherMatch) {
      const limitCheck = await checkAndConsumeDailyLimit({
        sock,
        jid,
        senderNum,
        isOwner,
        isSenderAdmin,
        cmd: 'cuaca',
        msg,
        dbMemory,
        saveMemory,
      });
      if (!limitCheck.allowed) return;

      const city = naturalWeatherMatch[1].trim();
      const userObj = ensureUserRecord(dbMemory, senderNum);
      if (!userObj.city) {
        userObj.city = city;
        await saveMemory();
      }
      const cuacaText = await getCuacaKotaAkurat(city);
      await sock.sendMessage(jid, { text: cuacaText }, { quoted: msg });
      return;
    }

    const hasPrefix = /^[.!/#]/.test(rawText);
    const cleanText = hasPrefix ? rawText.slice(1).trim() : rawText;
    const args = cleanText.split(/\s+/);
    const cmd = args[0].toLowerCase();
    const param = args.slice(1).join(' ').trim();

    // ============================================================
    // DOWNLOAD LANGSUNG OTOMATIS SAAT USER MENGIRIM LINK TANPA PERINTAH
    // ============================================================
    if (!ALL_COMMANDS_SET.has(cmd)) {
      const directUrl = extractUrl(rawText);
      if (
        directUrl &&
        /(tiktok\.com|instagram\.com|capcut\.com|youtube\.com\/(watch|shorts)|youtu\.be\/|facebook\.com|fb\.watch|twitter\.com|x\.com|mediafire\.com|drive\.google\.com)/i.test(
          directUrl
        )
      ) {
        const limitCheck = await checkAndConsumeDailyLimit({
          sock,
          jid,
          senderNum,
          isOwner,
          isSenderAdmin,
          cmd: 'autodownload',
          msg,
          dbMemory,
          saveMemory,
        });
        if (!limitCheck.allowed) return;

        if (dbMemory.botSettings.autotyping) sock.sendPresenceUpdate('composing', jid).catch(() => {});
        const downloaded = await handleDirectUrlAutoDownload(sock, jid, directUrl, msg);
        if (downloaded) return;
      }
    }

    if (ALL_COMMANDS_SET.has(cmd)) {
      // CEK LIMIT 15x/HARI (SELAIN ADMIN, OWNER, & PREMIUM AKTIF)
      const limitCheck = await checkAndConsumeDailyLimit({
        sock,
        jid,
        senderNum,
        isOwner,
        isSenderAdmin,
        cmd,
        msg,
        dbMemory,
        saveMemory,
      });
      if (!limitCheck.allowed) return;

      if (dbMemory.botSettings.autotyping) sock.sendPresenceUpdate('composing', jid).catch(() => {});

      // HANDLER LIMIT & PREMIUM QRIS
      const handledPremium = await handlePremiumCommand({
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
      });
      if (handledPremium) return;

      // HANDLER OTOMATISASI GRUP
      const handledGroupAuto = await handleGroupAutomationCommand({
        sock,
        jid,
        isGroup,
        senderParticipant,
        senderNum,
        isOwner,
        cmd,
        param,
        msg,
        dbMemory,
        saveMemory,
      });
      if (handledGroupAuto) return;

      // FITUR KHUSUS: RESET KUNCI ENKRIPSI
      if (cmd === 'fixsession') {
        const deleted = await repairSignalSessionForJid(jid, 'Perintah Manual fixsession');
        await sock.sendMessage(
          jid,
          { text: `🔐 *SIGNAL CIPHER DI-RESET!*\n• Kunci sesi dibersihkan: *${deleted} file*\n• Status: Enkripsi chat sudah disinkronkan ulang.` },
          { quoted: msg }
        );
        return;
      }

      // 1. MENU UTAMA
      if (cmd === 'menu' || cmd === 'help') {
        const dt = getIndonesianFullDateTime();
        const userRec = ensureUserRecord(dbMemory, senderNum);
        const isPrem = isOwner || isSenderAdmin || userRec.premiumUntil > Date.now();
        const limitLabel = isPrem ? '∞ Unlimited' : `${Math.max(0, 15 - userRec.dailyUsed)}/15 tersisa`;

        const bannerImg =
          MENU_BANNER_LINK ||
          `https://dummyimage.com/1000x460/1e1035/c084fc.png&text=${encodeURIComponent(bot.userName + ' • 209 VALID FEATURES')}`;

        const menuBody =
          `└ *${bot.userName}* ┐\n` +
          `🗓️ ${dt.full}\n\n` +
          `👤 *INFORMATION*\n` +
          `• *NAMA*       : ${pushName}\n` +
          `• *STATUS*    : ${isOwner ? '👑 Owner' : isSenderAdmin ? '🛡️ Admin Grup' : userRec.premiumUntil > Date.now() ? '💎 Premium' : '⭐ Reguler'}\n` +
          `• *LIMIT*        : ${limitLabel}\n` +
          `• *LOKASI*     : ${userRec.city || 'Belum diset (ketik: lokasi di bandung)'}\n` +
          `• *VERSION* : v${dbMemory.version}`;

        lastReplyTextByJid.set(jid, menuBody);

        await sendNativeInteractiveButtons(
          sock,
          jid,
          {
            title: 'HOME  •  ABOUT  •  PROFILE',
            body: menuBody,
            footer: `Ketik qris untuk Premium Unlimited 1 Minggu`,
            imageUrl: bannerImg,
            forwardedCard: true,
            listTitle: '📂 Pilih Kategori (209 Fitur)',
            sections: [
              {
                title: '💎 LIMIT, QRIS & OTOMATISASI GRUP',
                rows: [
                  { title: '📊 Cek Sisa Limit Harian', description: 'Lihat sisa kuota harian atau masa aktif Premium', id: 'limit' },
                  { title: '💳 Beli Premium QRIS (1 Minggu)', description: 'Aktivasi otomatis Unlimited selama 7 hari', id: 'qris' },
                  { title: '🛡️ Panel Otomatisasi Grup', description: 'Welcome, Buka/Tutup, Kegiatan & ACC Member', id: 'panelgrup' },
                  { title: '📋 Daftar Lengkap Semua Fitur', description: 'Tampilkan seluruh perintah bot', id: 'allmenu' },
                ],
              },
              {
                title: '🛠️ PERBAIKAN & HIBURAN',
                rows: [
                  { title: '🛠️ Perbaiki Semua 209 Fitur', description: 'Jalankan auto-repair + reset enkripsi', id: 'autorepair' },
                  { title: '⚔️ Kuro Slash (Tombol Asli)', description: 'Main tebas Oni dengan tombol sentuh', id: 'kuroslash' },
                  { title: '🌀 Speedy Dash (Tombol Asli)', description: 'Main Sonic kumpulkan Gold Rings', id: 'sonic' },
                ],
              },
            ],
            buttons: [
              { text: '📊 Cek Limit', id: 'limit' },
              { text: '💳 QRIS Premium', id: 'qris' },
              { text: '📋 Semua Fitur', id: 'allmenu' },
            ],
          },
          msg
        );
        return;
      }

      if (cmd === 'allmenu') {
        let out =
          `*╭┈───〔 ${bot.userName} - SEMUA FITUR 〕┈───⊷*\n` +
          `*├✦ Owner:* ${OWNER_NAME}\n` +
          `*├✦ Total Aktif:* ${ALL_COMMANDS_SET.size} Fitur\n` +
          `*╰───────────────────⊷*\n\n`;
        for (const [cat, list] of Object.entries(MENU_CATEGORIES)) {
          out += formatCategoryBox(cat, list) + '\n';
        }
        out += formatCategoryBox('GROUP_AUTOMATION', GROUP_AUTO_COMMANDS) + '\n';
        out += formatCategoryBox('LIMIT_PREMIUM', PREMIUM_COMMANDS) + '\n';
        await sock.sendMessage(jid, { text: out, contextInfo: { forwardingScore: 999, isForwarded: true } }, { quoted: msg });
        return;
      }

      const subMenus = {
        aimenu: 'AI', downloadmenu: 'DOWNLOAD', searchmenu: 'SEARCH', animemenu: 'ANIME',
        funmenu: 'FUN', groupmenu: 'GROUP', logomenu: 'STICKER_LOGO', toolsmenu: 'TOOLS', ownermenu: 'OWNER',
      };
      if (subMenus[cmd]) {
        await sock.sendMessage(jid, { text: formatCategoryBox(subMenus[cmd], MENU_CATEGORIES[subMenus[cmd]]) }, { quoted: msg });
        return;
      }

      // 2. AUTO-REPAIR & REAL-TIME SELF-TEST
      if (cmd === 'selftest' || cmd === 'cekfitur' || cmd === 'autorepair') {
        await sock.sendMessage(jid, { text: '🔄 *Sedang menjalankan Auto-Repair & Reset Sesi Enkripsi...*' }, { quoted: msg });
        await repairSignalSessionForJid(jid, 'Auto-Repair Triggered');
        const rep = await jalankanAudit209FiturRealTime(true);
        const details = Object.entries(rep.details).map(([k, v]) => `• *${k}:* ${v}`).join('\n');
        await sock.sendMessage(jid, { text: `🩺 *LAPORAN AUDIT FITUR*\n🕒 ${rep.lastChecked}\n📊 *${rep.summary}*\n\n${details}` }, { quoted: msg });
        return;
      }

      if (['ping', 'ping2', 'speed', 'os'].includes(cmd)) {
        const hw = getServerHardwareStats();
        const wib = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }).replace(/:/g, '.');
        await sock.sendMessage(
          jid,
          {
            text:
              `⚡ *SERVER STATUS*\n` +
              `• Runtime: ${getUptime()}\n` +
              `• RAM: ${hw.ramPercent}% ${hw.ramBar}\n` +
              `• Disk: ${hw.diskPercent}% ${hw.diskBar}\n` +
              `• Jam Server: ${wib} WIB`,
          },
          { quoted: msg }
        );
        return;
      }

      if (['alive', 'runtime', 'uptime'].includes(cmd)) {
        await sock.sendMessage(jid, { text: `🟢 *${bot.userName}* Aktif (${getUptime()})` }, { quoted: msg });
        return;
      }
      if (cmd === 'owner') { await sock.sendMessage(jid, { text: `👤 *Owner:* ${OWNER_NAME}` }, { quoted: msg }); return; }
      if (cmd === 'status') {
        await sock.sendMessage(jid, { text: `📊 *STATUS*\n• Fitur Aktif: ${ALL_COMMANDS_SET.size}\n• Auto-Repair Total: ${serverAutoHeal.totalAutoRepairs}x` }, { quoted: msg });
        return;
      }
      if (cmd === 'update') {
        const log = await jalankanEvolusiMandiri(true);
        await sock.sendMessage(jid, { text: `🧬 *UPDATE SELESAI*\n${log}` }, { quoted: msg });
        return;
      }

      // 3. AI (28 FITUR VALID)
      if (cmd === 'memori') {
        const f = dbMemory.users[senderNum]?.facts || [];
        await sock.sendMessage(jid, { text: f.length ? `🧠 *Ingatan:*\n• ${f.join('\n• ')}` : '🧠 Memori kosong.' }, { quoted: msg });
        return;
      }
      if (cmd === 'resetmemori') {
        if (dbMemory.users[senderNum]) dbMemory.users[senderNum].facts = [];
        await saveMemory();
        await sock.sendMessage(jid, { text: '✅ Memori direset.' }, { quoted: msg });
        return;
      }
      if (MENU_CATEGORIES.AI.includes(cmd)) {
        if (!param) { await sock.sendMessage(jid, { text: `⚠️ Contoh: \`${cmd} jelaskan cara kerja AI\`` }, { quoted: msg }); return; }
        const reply = await panggilServerAISatSet(param, `Kamu adalah ${bot.userName} (${cmd.toUpperCase()}). Jawab singkat, cerdas, dan akurat dalam Bahasa Indonesia.`);
        await sock.sendMessage(jid, { text: reply || '⏳ Server AI sibuk, coba ulangi.' }, { quoted: msg });
        return;
      }

      // 4. DOWNLOADER & PLAY AUDIO SIMPEL
      if (['tiktok', 'tt', 'ttmp3', 'ttslide'].includes(cmd)) {
        const u = extractUrl(param);
        if (!u) { await sock.sendMessage(jid, { text: `⚠️ Contoh: \`${cmd} https://vt.tiktok.com/...\`` }, { quoted: msg }); return; }
        const res = await downloadTikTok(u);
        if (!res) { await sock.sendMessage(jid, { text: '❌ Gagal mengunduh TikTok.' }, { quoted: msg }); return; }
        if (cmd === 'ttmp3' && res.musicUrl) {
          const buf = await fetchBuffer(res.musicUrl, 'https://www.tiktok.com/').catch(() => null);
          if (buf) await sock.sendMessage(jid, { audio: buf, mimetype: 'audio/mpeg' }, { quoted: msg });
          return;
        }
        if (res.type === 'image') {
          for (const imgU of res.images.slice(0, 8)) {
            const b = await fetchBuffer(imgU, 'https://www.tiktok.com/').catch(() => null);
            if (b) await sock.sendMessage(jid, { image: b }, { quoted: msg });
          }
        } else if (res.videoUrl) {
          const vBuf = await fetchBuffer(res.videoUrl, 'https://www.tiktok.com/').catch(() => null);
          await sock.sendMessage(jid, vBuf ? { video: vBuf, caption: `🎬 *TikTok HD*\n${res.title}` } : { video: { url: res.videoUrl }, caption: `🎬 *TikTok HD*\n${res.title}` }, { quoted: msg });
        }
        return;
      }

      if (cmd === 'capcut') {
        const u = extractUrl(param);
        if (!u) { await sock.sendMessage(jid, { text: '⚠️ Contoh: `capcut https://www.capcut.com/tv2/...`' }, { quoted: msg }); return; }
        const cc = await downloadCapCut(u);
        if (cc?.url) {
          const vBuf = await fetchBuffer(cc.url, 'https://www.capcut.com/').catch(() => null);
          await sock.sendMessage(jid, vBuf ? { video: vBuf, caption: `🎬 *${cc.title}*` } : { video: { url: cc.url }, caption: `🎬 *${cc.title}*` }, { quoted: msg });
        } else {
          await sock.sendMessage(jid, { text: '❌ Video CapCut tidak ditemukan atau privat.' }, { quoted: msg });
        }
        return;
      }

      if (['ytmp4', 'ytmp3', 'ytdl', 'video'].includes(cmd)) {
        const u = extractUrl(param) || lastPlaySession.get(jid)?.url;
        if (!u) { await sock.sendMessage(jid, { text: `⚠️ Contoh: \`${cmd} https://youtu.be/...\`` }, { quoted: msg }); return; }
        const isAud = cmd === 'ytmp3';
        const yt = await downloadYouTube(u, isAud);
        if (yt?.buffer) {
          await sock.sendMessage(jid, isAud ? { audio: yt.buffer, mimetype: 'audio/mpeg' } : { video: yt.buffer, caption: `🎬 *${yt.title}*` }, { quoted: msg });
        } else {
          await sock.sendMessage(jid, { text: '❌ Gagal mengunduh media YouTube.' }, { quoted: msg });
        }
        return;
      }

      // PLAY AUDIO SIMPEL & CEPAT (LANGSUNG KIRIM MP3)
      if (['play', 'play2', 'song', 'spotify', 'spotifylive', 'splive'].includes(cmd)) {
        if (!param) {
          await sock.sendMessage(jid, { text: `⚠️ Contoh: \`play komang raim laode\`` }, { quoted: msg });
          return;
        }
        const directUrl = extractUrl(param);
        let trackUrl = directUrl;
        let trackTitle = param;
        let trackDuration = '';

        if (!trackUrl) {
          const list = await searchYouTube(param);
          if (!list || !list.length) {
            await sock.sendMessage(jid, { text: '❌ Lagu tidak ditemukan.' }, { quoted: msg });
            return;
          }
          trackUrl = list[0].url;
          trackTitle = list[0].title;
          trackDuration = list[0].duration || '';
        }

        lastPlaySession.set(jid, { url: trackUrl, title: trackTitle });
        await sock.sendMessage(
          jid,
          { text: `🎵 *Memutar:* ${trackTitle}${trackDuration ? ` (${trackDuration})` : ''}\n⏳ _Mengirim audio..._` },
          { quoted: msg }
        );

        const ytAudio = await downloadYouTube(trackUrl, true);
        if (ytAudio?.buffer) {
          await sock.sendMessage(
            jid,
            {
              audio: ytAudio.buffer,
              mimetype: 'audio/mpeg',
              ptt: false,
            },
            { quoted: msg }
          );
        } else {
          await sock.sendMessage(
            jid,
            { text: `❌ Gagal mengambil file audio untuk *${trackTitle}*. Coba judul lain atau ulangi sebentar.` },
            { quoted: msg }
          );
        }
        return;
      }

      if (cmd === 'yts') {
        if (!param) return;
        const list = await searchYouTube(param);
        await sock.sendMessage(jid, { text: list.length ? list.map((v, i) => `${i + 1}. *${v.title}* (${v.duration})\n🔗 ${v.url}`).join('\n\n') : '❌ Tidak ditemukan.' }, { quoted: msg });
        return;
      }

      if (['igdl', 'fb', 'twitter', 'mediafire', 'gdrive'].includes(cmd)) {
        const u = extractUrl(param);
        if (!u) { await sock.sendMessage(jid, { text: `⚠️ Contoh: \`${cmd} https://...\`` }, { quoted: msg }); return; }
        const res = await downloadSocialMedia(u, cmd);
        if (res?.url) {
          const buf = await fetchBuffer(res.url).catch(() => null);
          if (buf) {
            if (cmd === 'mediafire' || cmd === 'gdrive') await sock.sendMessage(jid, { document: buf, fileName: res.filename, mimetype: 'application/octet-stream' }, { quoted: msg });
            else if (res.isImage) await sock.sendMessage(jid, { image: buf }, { quoted: msg });
            else await sock.sendMessage(jid, { video: buf }, { quoted: msg });
          } else {
            await sock.sendMessage(jid, { text: `🔗 ${res.url}` }, { quoted: msg });
          }
        } else {
          await sock.sendMessage(jid, { text: '❌ Tautan gagal diunduh.' }, { quoted: msg });
        }
        return;
      }

      if (cmd === 'gitclone') {
        const m = param.match(/github\.com\/([^/]+)\/([^/\s]+)/i);
        if (!m) return;
        await sock.sendMessage(jid, { document: { url: `https://github.com/${m[1]}/${m[2].replace(/\.git$/, '')}/archive/refs/heads/main.zip` }, fileName: `${m[2]}.zip`, mimetype: 'application/zip' }, { quoted: msg });
        return;
      }

      if (cmd === 'tts' && param) {
        const buf = await fetchBuffer(`https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(param.slice(0, 200))}&tl=id&client=tw-ob`).catch(() => null);
        if (buf) await sock.sendMessage(jid, { audio: buf, mimetype: 'audio/mpeg', ptt: true }, { quoted: msg });
        return;
      }

      // 5. SEARCH, LOKASI KOTA USER & ISLAMI
      if (cmd === 'setlokasi' || cmd === 'lokasi') {
        if (!param) {
          const curCity = ensureUserRecord(dbMemory, senderNum).city;
          await sock.sendMessage(
            jid,
            { text: curCity ? `📍 Lokasi kamu saat ini: *${curCity}*\nKetik \`lokasi di <kota baru>\` untuk mengubah.` : '⚠️ Contoh: `lokasi di bandung`' },
            { quoted: msg }
          );
          return;
        }
        const cleanCity = param.replace(/^di\s+/i, '').trim();
        const userRec = ensureUserRecord(dbMemory, senderNum);
        userRec.city = cleanCity;
        await saveMemory();
        const c = await getCuacaKotaAkurat(cleanCity);
        await sock.sendMessage(jid, { text: `📍 Lokasi disimpan ke *${cleanCity}*.\n\n${c}` }, { quoted: msg });
        return;
      }

      if (cmd === 'cuaca' || cmd === 'wthr') {
        const userRec = ensureUserRecord(dbMemory, senderNum);
        const targetCity = param ? param.replace(/^di\s+/i, '').trim() : userRec.city || 'Jakarta';
        if (param && !userRec.city) {
          userRec.city = targetCity;
          await saveMemory();
        }
        const c = await getCuacaKotaAkurat(targetCity);
        await sock.sendMessage(jid, { text: c || '❌ Kota tidak ditemukan.' }, { quoted: msg });
        return;
      }

      if (cmd === 'praytime') {
        const userRec = ensureUserRecord(dbMemory, senderNum);
        const j = await getJadwalSholatIndonesia(param || userRec.city || 'Jakarta');
        await sock.sendMessage(jid, { text: j || '❌ Jadwal tidak ditemukan.' }, { quoted: msg });
        return;
      }
      if (cmd === 'surah') {
        const s = await getSurahLengkap(param || '1');
        if (s) {
          await sock.sendMessage(jid, { text: s.text }, { quoted: msg });
          if (s.audioUrl) {
            const b = await fetchBuffer(s.audioUrl).catch(() => null);
            if (b) await sock.sendMessage(jid, { audio: b, mimetype: 'audio/mpeg' }, { quoted: msg });
          }
        }
        return;
      }
      if (cmd === 'wiki' && param) {
        const r = await fetchWithTimeout(`https://id.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(param)}`).catch(() => null);
        const d = r ? await r.json() : null;
        await sock.sendMessage(jid, { text: d?.extract ? `📚 *${d.title}*\n\n${d.extract}` : '❌ Tidak ditemukan.' }, { quoted: msg });
        return;
      }
      if (cmd === 'npm' && param) {
        const r = await fetchWithTimeout(`https://registry.npmjs.org/${encodeURIComponent(param)}`).catch(() => null);
        const d = r ? await r.json() : null;
        await sock.sendMessage(jid, { text: d?.name ? `📦 *${d.name}* v${d['dist-tags']?.latest}\n${d.description || ''}` : '❌ Tidak ditemukan.' }, { quoted: msg });
        return;
      }
      if (['define', 'fakta', 'motivasi', 'kbbi'].includes(cmd)) {
        const ans = await panggilServerAISatSet(`Berikan ${cmd} untuk "${param || 'Indonesia'}" secara singkat dalam Bahasa Indonesia.`, 'Jawab akurat dan ringkas.');
        await sock.sendMessage(jid, { text: ans || '❌ Data tidak tersedia.' }, { quoted: msg });
        return;
      }

      // 6. ANIME (10 FITUR VALID)
      if (MENU_CATEGORIES.ANIME.includes(cmd)) {
        const imgUrl = await getAnimeImageUrl(cmd);
        if (imgUrl) await sock.sendMessage(jid, { image: { url: imgUrl }, caption: `✨ *${cmd.toUpperCase()}*` }, { quoted: msg });
        return;
      }

      // 7. FUN & GAME
      if (cmd === 'kuroslash' || cmd === 'slash') {
        const st = { type: 'kuroslash', lane: 1, hp: 100, score: 0, best: dbMemory.gameHighScores.kuroslash[senderNum] || 0, ulti: 35, wave: 0 };
        gameSessions.set(jid, st);
        await kirimTampilanKuroSlash(sock, jid, senderNum, st, 'Tekan tombol di bawah untuk bermain!', msg);
        return;
      }
      if (cmd === 'sonic' || cmd === 'speedydash') {
        const st = { type: 'sonic', rings: 10, score: 0, best: dbMemory.gameHighScores.sonic[senderNum] || 0, laserAlert: false };
        gameSessions.set(jid, st);
        await kirimTampilanSonic(sock, jid, senderNum, st, 'Tekan BOOST atau JUMP di bawah!', msg);
        return;
      }
      if (cmd === 'game') {
        gameSessions.set(jid, { type: 'angka', answer: Math.floor(Math.random() * 10) + 1 });
        await sock.sendMessage(jid, { text: '🎮 *Tebak Angka (1-10)*\nKirim tebakanmu!' }, { quoted: msg });
        return;
      }
      if (cmd === 'mathgame') {
        const a = Math.floor(Math.random() * 25) + 5;
        const b = Math.floor(Math.random() * 25) + 5;
        gameSessions.set(jid, { type: 'math', answer: a + b });
        await sock.sendMessage(jid, { text: `🧮 Berapa *${a} + ${b}*?` }, { quoted: msg });
        return;
      }
      if (cmd === 'tebakkata') {
        gameSessions.set(jid, { type: 'kata', answer: 'peta' });
        await sock.sendMessage(jid, { text: '🧩 Punya gunung tapi tidak punya pohon, punya kota tapi tidak punya rumah. Apakah aku?' }, { quoted: msg });
        return;
      }
      if (cmd === 'suit') {
        const p = ['batu', 'gunting', 'kertas'];
        const u = param.toLowerCase();
        if (!p.includes(u)) { await sock.sendMessage(jid, { text: '⚠️ Contoh: `suit batu`' }, { quoted: msg }); return; }
        const b = p[Math.floor(Math.random() * 3)];
        await sock.sendMessage(jid, { text: `✊✌️✋ Kamu: *${u}* | Bot: *${b}*` }, { quoted: msg });
        return;
      }
      if (cmd === 'dice') { await sock.sendMessage(jid, { text: `🎲 Dadu: *${Math.floor(Math.random() * 6) + 1}*` }, { quoted: msg }); return; }
      if (cmd === 'coin') { await sock.sendMessage(jid, { text: `🪙 Koin: *${Math.random() < 0.5 ? 'ANGKA' : 'GAMBAR'}*` }, { quoted: msg }); return; }
      if (cmd === '8ball') { await sock.sendMessage(jid, { text: `🎱 *${['Ya pasti!', 'Mungkin iya.', 'Coba lagi.', 'Tidak.'][Math.floor(Math.random() * 4)]}*` }, { quoted: msg }); return; }
      if (['rate', 'aura', 'sigma', 'rizz', 'vibe', 'npc', 'maincharacter', 'delulu', 'redflag', 'greenflag', 'compatibility', 'ship'].includes(cmd)) {
        await sock.sendMessage(jid, { text: `📊 *${cmd.toUpperCase()}:* ${Math.floor(Math.random() * 101)}%` }, { quoted: msg });
        return;
      }
      if (['roast', 'compliment', 'pickup', 'quote', 'joke', 'truth', 'dare', 'wyr', 'horoscope'].includes(cmd)) {
        const ans = await panggilServerAISatSet(`Buat 1 ${cmd} singkat dan sopan dalam Bahasa Indonesia untuk ${param || pushName}.`, 'Jawab singkat.');
        await sock.sendMessage(jid, { text: ans || '✨ Semangat hari ini!' }, { quoted: msg });
        return;
      }
      if (['hug', 'pat', 'wave', 'dance'].includes(cmd)) {
        const u = await getAnimeImageUrl(cmd);
        if (u) await sock.sendMessage(jid, { image: { url: u }, caption: `*${pushName}* melakukan *${cmd}*` }, { quoted: msg });
        return;
      }

      // 8. GROUP & KEAMANAN
      if (MENU_CATEGORIES.GROUP.includes(cmd)) {
        if (!isGroup) { await sock.sendMessage(jid, { text: '⚠️ Khusus di dalam grup.' }, { quoted: msg }); return; }
        const meta = await sock.groupMetadata(jid);
        const parts = meta.participants.map((p) => p.id);
        const gCfg = getGroupConfig(jid);
        if (cmd === 'ginfo' || cmd === 'groupsettings' || cmd === 'gsettings') {
          await sendNativeInteractiveButtons(
            sock,
            jid,
            {
              title: '🛡️ PENGATURAN GRUP',
              body: `Grup: *${meta.subject}*\nAnti-Link: ${gCfg.antilink ? 'ON' : 'OFF'} | Anti-Virtek: ${gCfg.antivirtek ? 'ON' : 'OFF'} | Anti-Toxic: ${gCfg.antitoxic ? 'ON' : 'OFF'}`,
              buttons: [
                { text: '🔗 Toggle Anti-Link', id: 'antilink' },
                { text: '☣️ Toggle Anti-Virtek', id: 'antivirtek' },
                { text: '🤬 Toggle Anti-Toxic', id: 'antitoxic' },
              ],
            },
            msg
          );
          return;
        }
        if (cmd === 'tagall' || cmd === 'everyone') { await sock.sendMessage(jid, { text: parts.map((p) => `@${p.split('@')[0]}`).join(' '), mentions: parts }); return; }
        if (cmd === 'hidetag') { await sock.sendMessage(jid, { text: param || '📢 Info', mentions: parts }); return; }
        if (cmd === 'link') { await sock.sendMessage(jid, { text: `https://chat.whatsapp.com/${await sock.groupInviteCode(jid)}` }); return; }
        if (cmd === 'revoke') { await sock.groupRevokeInvite(jid); await sock.sendMessage(jid, { text: '✅ Link direset.' }); return; }
        if (cmd === 'mute') { await sock.groupSettingUpdate(jid, 'announcement'); return; }
        if (cmd === 'unmute') { await sock.groupSettingUpdate(jid, 'not_announcement'); return; }
        if (cmd === 'updategname' && param) { await sock.groupUpdateSubject(jid, param); return; }
        if (cmd === 'updategdesc' && param) { await sock.groupUpdateDescription(jid, param); return; }
        if (cmd === 'poll') {
          const p = param.split('|').map((s) => s.trim()).filter(Boolean);
          if (p.length >= 3) await sock.sendMessage(jid, { poll: { name: p[0], values: p.slice(1), selectableCount: 1 } });
          return;
        }
        if (cmd === 'delete') {
          const q = unwrapped.extendedTextMessage?.contextInfo;
          if (q?.stanzaId) await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: false, id: q.stanzaId, participant: q.participant } });
          return;
        }
        if (['kick', 'add', 'promote', 'demote'].includes(cmd)) {
          const target = unwrapped.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || unwrapped.extendedTextMessage?.contextInfo?.participant;
          if (target) await sock.groupParticipantsUpdate(jid, [target], { kick: 'remove', add: 'add', promote: 'promote', demote: 'demote' }[cmd]);
          return;
        }
        if (cmd === 'antilink') { gCfg.antilink = !gCfg.antilink; await saveMemory(); await sock.sendMessage(jid, { text: `Anti-Link: ${gCfg.antilink ? 'ON' : 'OFF'}` }); return; }
        if (cmd === 'antivirtek' || cmd === 'antibug') { gCfg.antivirtek = !gCfg.antivirtek; await saveMemory(); await sock.sendMessage(jid, { text: `Anti-Virtek: ${gCfg.antivirtek ? 'ON' : 'OFF'}` }); return; }
        if (cmd === 'antitoxic') { gCfg.antitoxic = !gCfg.antitoxic; await saveMemory(); await sock.sendMessage(jid, { text: `Anti-Toxic: ${gCfg.antitoxic ? 'ON' : 'OFF'}` }); return; }
        if (cmd === 'antispam') { gCfg.antispam = !gCfg.antispam; await saveMemory(); await sock.sendMessage(jid, { text: `Anti-Spam: ${gCfg.antispam ? 'ON' : 'OFF'}` }); return; }
        if (cmd === 'leave') { await sock.groupLeave(jid); return; }
      }

      // 9. STICKER, BRAT, BRATVID & LOGO
      if (['sticker', 'stiker', 's'].includes(cmd)) {
        const qMsg = unwrapMessageContent(unwrapped.extendedTextMessage?.contextInfo?.quotedMessage);
        const imgMsg = unwrapped.imageMessage || qMsg?.imageMessage;
        const vidMsg = unwrapped.videoMessage || qMsg?.videoMessage;
        if (imgMsg) {
          const st = await downloadContentFromMessage(imgMsg, 'image');
          let b = Buffer.from([]);
          for await (const c of st) b = Buffer.concat([b, c]);
          const webp = await mediaBufferToWebpSticker(b, false);
          if (webp) await sock.sendMessage(jid, { sticker: webp }, { quoted: msg });
          return;
        }
        if (vidMsg) {
          const st = await downloadContentFromMessage(vidMsg, 'video');
          let b = Buffer.from([]);
          for await (const c of st) b = Buffer.concat([b, c]);
          const webp = await mediaBufferToWebpSticker(b, true);
          if (webp) await sock.sendMessage(jid, { sticker: webp }, { quoted: msg });
          return;
        }
        if (param) {
          const webp = await urlOrTextToWebpSticker(param);
          if (webp) await sock.sendMessage(jid, { sticker: webp }, { quoted: msg });
        }
        return;
      }

      if (['brat', 'bratvid', 'bratvideo'].includes(cmd)) {
        const txt = param || 'brat';
        const webp = await createBratSticker(txt, cmd !== 'brat');
        if (webp) await sock.sendMessage(jid, { sticker: webp }, { quoted: msg });
        return;
      }
      if (['ttp', 'attp', 'qc'].includes(cmd) && param) {
        const webp = await urlOrTextToWebpSticker(param);
        if (webp) await sock.sendMessage(jid, { sticker: webp }, { quoted: msg });
        return;
      }
      if (cmd === 'animasi' || cmd === 'linkvideo') {
        const u = extractUrl(param) || `https://dummyimage.com/800x450/0f172a/38bdf8.png&text=${encodeURIComponent(param || 'HD')}`;
        await sock.sendMessage(jid, { image: { url: `https://api.microlink.io/?url=${encodeURIComponent(u)}&screenshot=true&meta=false&embed=screenshot.url` }, caption: '✨ Visual HD' }, { quoted: msg });
        return;
      }
      if ((cmd === 'font' || cmd === 'fancy') && param) {
        await sock.sendMessage(jid, { text: FONT_MAPS.map((_, i) => `${i + 1}. ${applyFont(param, i)}`).join('\n') }, { quoted: msg });
        return;
      }
      if (['logo', 'neon', 'gold', 'galaxy', 'glitch', 'matrix', 'graffiti', 'thunder'].includes(cmd) && param) {
        const colors = { logo: '0f172a/38bdf8', neon: '090d16/00ffcc', gold: '1c1917/facc15', galaxy: '1e1b4b/c084fc', glitch: '18181b/f43f5e', matrix: '022c22/4ade80', graffiti: '312e81/fb923c', thunder: '0c4a6e/fde047' };
        await sock.sendMessage(jid, { image: { url: `https://dummyimage.com/800x400/${colors[cmd]}.png&text=${encodeURIComponent(param)}` } }, { quoted: msg });
        return;
      }

      // 10. TOOLS & RVO
      if (['rvo', 'rvop', 'vv'].includes(cmd)) {
        const qRaw = unwrapped.extendedTextMessage?.contextInfo?.quotedMessage;
        const vo = await extractAndDownloadViewOnce(qRaw);
        if (!vo?.buffer) { await sock.sendMessage(jid, { text: '⚠️ Balas pesan View Once dengan `.rvo`' }, { quoted: msg }); return; }
        const target = cmd === 'rvop' ? senderParticipant : jid;
        if (vo.type === 'image') await sock.sendMessage(target, { image: vo.buffer, caption: `👁️ RVO\n${vo.caption}` });
        else if (vo.type === 'video') await sock.sendMessage(target, { video: vo.buffer, caption: `👁️ RVO\n${vo.caption}` });
        else if (vo.type === 'audio') await sock.sendMessage(target, { audio: vo.buffer, mimetype: 'audio/mpeg', ptt: true });
        return;
      }
      if (cmd === 'hitung' && param && /^[0-9+\-*/().\s]+$/.test(param)) {
        await sock.sendMessage(jid, { text: `🧮 *${param}* = *${Function(`"use strict"; return (${param})`)()}*` }, { quoted: msg });
        return;
      }
      if (cmd === 'catat' && param) {
        if (!dbMemory.notes[jid]) dbMemory.notes[jid] = [];
        dbMemory.notes[jid].push(param);
        await saveMemory();
        await sock.sendMessage(jid, { text: '📝 Tersimpan!' }, { quoted: msg });
        return;
      }
      if (cmd === 'catatan') {
        const l = dbMemory.notes[jid] || [];
        await sock.sendMessage(jid, { text: l.length ? l.map((v, i) => `${i + 1}. ${v}`).join('\n') : '📭 Kosong.' }, { quoted: msg });
        return;
      }
      if ((cmd === 'terjemah' || cmd === 'translate') && args[1] && args[2]) {
        const t = await panggilServerAISatSet(`Terjemahkan ke ${args[1]}: ${args.slice(2).join(' ')}`, 'Terjemahkan saja.');
        await sock.sendMessage(jid, { text: t || '-' }, { quoted: msg });
        return;
      }
      if (cmd === 'id') { await sock.sendMessage(jid, { text: `🆔 \`${jid}\`` }, { quoted: msg }); return; }
      if (cmd === 'getpp') {
        const pp = await sock.profilePictureUrl(senderParticipant, 'image').catch(() => null);
        await sock.sendMessage(jid, pp ? { image: { url: pp } } : { text: '❌ Privat.' }, { quoted: msg });
        return;
      }
      if (cmd === 'getbio') {
        const st = await sock.fetchStatus(senderParticipant).catch(() => null);
        await sock.sendMessage(jid, { text: `📝 ${st?.status || '-'}` }, { quoted: msg });
        return;
      }
      if (cmd === 'gpass') {
        const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
        await sock.sendMessage(jid, { text: `🔐 \`${Array.from({ length: 12 }, () => c[Math.floor(Math.random() * c.length)]).join('')}\`` }, { quoted: msg });
        return;
      }
      if (cmd === 'qr' && param) { await sock.sendMessage(jid, { image: { url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(param)}` } }, { quoted: msg }); return; }
      if (cmd === 'shorturl' && extractUrl(param)) {
        const s = await (await fetchWithTimeout(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(extractUrl(param))}`)).text();
        await sock.sendMessage(jid, { text: `🔗 ${s}` }, { quoted: msg });
        return;
      }
      if (cmd === 'waktu') { await sock.sendMessage(jid, { text: `🕒 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB` }, { quoted: msg }); return; }
      if (cmd === 'base64' && param) { await sock.sendMessage(jid, { text: Buffer.from(param).toString('base64') }, { quoted: msg }); return; }
      if (cmd === 'reverse' && param) { await sock.sendMessage(jid, { text: param.split('').reverse().join('') }, { quoted: msg }); return; }
      if (cmd === 'ssweb' && extractUrl(param)) {
        await sock.sendMessage(jid, { image: { url: `https://api.microlink.io/?url=${encodeURIComponent(extractUrl(param))}&screenshot=true&meta=false&embed=screenshot.url` } }, { quoted: msg });
        return;
      }

      // 11. OWNER
      if (['setnama', 'setname', 'botname'].includes(cmd) && param) {
        bot.userName = param;
        dbMemory.botSettings.customBotName = param;
        await saveMemory();
        await sock.updateProfileName(param).catch(() => {});
        await sock.sendMessage(jid, { text: `✅ Nama bot: *${param}*` }, { quoted: msg });
        return;
      }
      if (cmd === 'updatebio' && param) { await sock.updateProfileStatus(param); return; }
      if ((cmd === 'block' || cmd === 'unblock') && param) { await sock.updateBlockStatus(`${param.replace(/\D/g, '')}@s.whatsapp.net`, cmd); return; }
      if (cmd === 'blocklist') { const l = await sock.fetchBlocklist(); await sock.sendMessage(jid, { text: `🚫 Diblokir: ${l.length}` }); return; }
      if (cmd === 'autoread') { dbMemory.botSettings.autoread = !dbMemory.botSettings.autoread; await saveMemory(); await sock.sendMessage(jid, { text: `AutoRead: ${dbMemory.botSettings.autoread}` }); return; }
      if (cmd === 'autotyping') { dbMemory.botSettings.autotyping = !dbMemory.botSettings.autotyping; await saveMemory(); await sock.sendMessage(jid, { text: `AutoTyping: ${dbMemory.botSettings.autotyping}` }); return; }
      if (cmd === 'mode' && (param === 'public' || param === 'self')) { dbMemory.botSettings.mode = param; await saveMemory(); await sock.sendMessage(jid, { text: `Mode: ${param}` }); return; }
      if (cmd === 'badwords') { await sock.sendMessage(jid, { text: `Total filter: ${bot.badWords.length + dbMemory.learnedWords.length}` }); return; }
      if (cmd === 'addkata' && param) { dbMemory.learnedWords.push(param.toLowerCase()); await saveMemory(); return; }
      if (cmd === 'delkata' && param) { dbMemory.learnedWords = dbMemory.learnedWords.filter((w) => w !== param.toLowerCase()); await saveMemory(); return; }
      if (cmd === 'clean') { if (global.gc) global.gc(); await sock.sendMessage(jid, { text: '🧹 Cache dibersihkan.' }); return; }
    }

    // Obrolan Interaktif Tematik di Grup
    if (isGroup) {
      await handleGroupThemeInteraction({
        sock,
        jid,
        senderParticipant,
        pushName,
        rawText,
        unwrapped,
        msg,
        dbMemory,
        bot,
      });
      return;
    }

    // Obrolan AI Bebas di Chat Pribadi (juga mengikuti limit 15x/hari)
    if (rawText.length < 2) return;
    const chatLimit = await checkAndConsumeDailyLimit({
      sock,
      jid,
      senderNum,
      isOwner,
      isSenderAdmin: false,
      cmd: 'chat_ai',
      msg,
      dbMemory,
      saveMemory,
    });
    if (!chatLimit.allowed) return;

    const reply = await panggilServerAISatSet(rawText, `Kamu adalah ${bot.userName}, asisten WhatsApp cerdas.`);
    if (reply) await sock.sendMessage(jid, { text: reply }, { quoted: msg });
  } catch (err) {
    const msg = err?.message || 'Error';
    if (/Bad MAC|SessionError|No matching sessions|Invalid PreKey/i.test(msg)) {
      await triggerAutoCipherHeal(msg?.key?.remoteJid || '', msg);
    } else {
      recordAutoRepair('Handler', msg, 'Pesan diisolasi');
    }
  }
}

let backgroundLoopsStarted = false;

async function start() {
  await loadMemory();
  await jalankanEvolusiMandiri(false);

  // Pulihkan sesi WhatsApp otomatis kalau folder ./auth terhapus saat redeploy GitHub
  await restoreAuthFromGitHub(AUTH_DIR);

  if (!backgroundLoopsStarted) {
    backgroundLoopsStarted = true;
    setTimeout(() => jalankanAudit209FiturRealTime(false), 8000);
    setInterval(() => jalankanAudit209FiturRealTime(false), 5 * 60 * 1000);

    setupGracefulShutdown(bot, saveMemory);
    startGitHubLiveHotReload(async (commitId) => {
      serverAutoHeal.updateProgressText = `✅ Live Update GitHub (${commitId}) berhasil tanpa putus WA`;
      await jalankanAudit209FiturRealTime(true);
    });
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`\n🤖 ${bot.userName} v${dbMemory.version} — ${ALL_COMMANDS_SET.size} FITUR + AUTO LINK + CUACA KOTA + LIMIT QRIS\n`);

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['WHUXEN Bot', 'Chrome', '9.6.0'],
    printQRInTerminal: false,
    getMessage: async (key) => sentMessageCache.get(key.id) || { conversation: '' },
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

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    scheduleAuthBackupToGitHub(AUTH_DIR);
  });

  sock.ev.on('messages.update', async (updates) => {
    for (const u of updates) {
      const targetJid = u.key?.remoteJid;
      if (!targetJid || !u.key?.fromMe) continue;

      const hasRetryOrDecryptError =
        Boolean(u.update?.messageStubType) ||
        (typeof u.update?.status === 'number' && u.update.status === 0);

      if (hasRetryOrDecryptError) {
        const lastAttempt = retryCooldownByJid.get(targetJid) || 0;
        if (Date.now() - lastAttempt < 8000) continue;
        retryCooldownByJid.set(targetJid, Date.now());

        await repairSignalSessionForJid(targetJid, 'Terdeteksi Menunggu Pesan Ini (Retry Receipt)');
        const fallbackText = lastReplyTextByJid.get(targetJid);
        if (fallbackText) {
          await origSendMessage(targetJid, {
            text: `🔄 *Auto-Repair Enkripsi Berhasil:*\n\n${fallbackText}`,
          }).catch(() => {});
        }
      }
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      prosesSatuPesan(sock, msg).catch(() => {});
    }
  });

  // Welcome Masuk, Keluar & Join Request via Participants Update
  sock.ev.on('group-participants.update', (update) => {
    handleGroupParticipantsUpdate(sock, dbMemory, update).catch(() => {});
  });

  // Saring & ACC Member Masuk Otomatis
  sock.ev.on('group.join-request', (event) => {
    handleGroupJoinRequestEvent(sock, dbMemory, event).catch(() => {});
  });

  // Scheduler Buka/Tutup Grup, Kegiatan Otomatis & Sweeper ACC Member
  startGroupAutomationScheduler(sock, dbMemory, saveMemory);

  // Pengawas Pembayaran QRIS Otomatis & Auto-Expire Premium 7 Hari
  startPremiumAndQrisWatcher(sock, dbMemory, saveMemory);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && !bot.connected) {
      bot.qr = qr;
      if (PHONE && !bot.registered && !bot.pairingCode) {
        setTimeout(() => mintaKodePairing(sock, PHONE), 2000);
      }
    }
    if (connection === 'open') {
      bot.connected = true;
      bot.registered = true;
      bot.qr = null;
      bot.pairingCode = null;
      bot.userPhone = sock.user?.id ? sock.user.id.split(':')[0] : PHONE;
      scheduleAuthBackupToGitHub(AUTH_DIR);
      console.log(`✅ [TERHUBUNG] ${bot.userPhone} — Semua Sistem Aktif`);
    } else if (connection === 'close') {
      bot.connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      setTimeout(start, 3000);
    }
  });
}

mulaiWeb();
start();
