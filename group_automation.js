import { fetchWithTimeout, sendNativeInteractiveButtons, panggilServerAISatSet } from './engines.js';

export const GROUP_SECURITY_COMMANDS = [
  'antilink', 'antivirtek', 'antibug', 'antitoxic', 'antispam',
  'autoacc', 'autoapprove', 'acc', 'accsemua', 'tolaksemua', 'cekrequest',
  'wajibpp', 'kode', 'setfilter', 'bl', 'unbl', 'blacklistmember', 'unblacklistmember',
  'kick', 'add', 'promote', 'demote', 'del', 'delete',
  'mute', 'unmute', 'link', 'revoke', 'ginfo', 'keamanangrup', 'securitymenu',
];

export const GROUP_AUTO_ONLY_COMMANDS = [
  'groupsettings', 'gsettings', 'tagall', 'everyone', 'hidetag', 'updategname', 'updategdesc',
  'poll', 'leave', 'welcome', 'goodbye', 'setwelcome', 'setgoodbye', 'autobuka', 'autotutup',
  'tambahkegiatan', 'syncjadwal', 'listkegiatan', 'hapuskegiatan', 'teskegiatan',
  'tessemuakegiatan', 'testsemuakegiatan', 'interaksi', 'settema', 'tutupinteraksi', 'panelgrup',
];

export const ALL_GROUP_COMMANDS = [...GROUP_SECURITY_COMMANDS, ...GROUP_AUTO_ONLY_COMMANDS];
export const GROUP_AUTO_COMMANDS = ALL_GROUP_COMMANDS;

const menuSection = (title, cmds) => `*${title}*\n${cmds.map((c) => `• \`.${c}\``).join('\n')}`;
export const GROUP_SECURITY_MENU = [
  `*╭┈───〔 🛡️ MENU KEAMANAN GRUP 〕┈───⊷*\n*│* _@nomor bisa tag atau ketik 628xxx_\n*│* _👑 VVIP: admin grup kebal kick & demote_\n*│* _📥 Link downloader hanya lolos jika diawali perintah (mis. .tiktok <link>)_\n*╰───────────────────────⊷*`,
  menuSection('🔒 PROTEKSI CHAT', ['antilink', 'antivirtek', 'antibug', 'antitoxic', 'antispam'].map((c) => `${c} on/off`)),
  menuSection('🛡️ SELEKSI & ACC MEMBER', ['autoacc on/off', 'acc @nomor', 'accsemua', 'tolaksemua', 'cekrequest', 'wajibpp on/off', 'kode 62', 'bl @nomor', 'unbl @nomor']),
  menuSection('👮 MODERASI GRUP', ['kick @nomor', 'add @nomor', 'promote @nomor', 'demote @nomor', 'del', 'mute', 'unmute', 'link', 'revoke', 'ginfo']),
].join('\n\n');

const VALID_DAYS = ['senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu', 'minggu', 'setiap_hari'];
const EN_TO_ID_DAY = { sunday: 'minggu', monday: 'senin', tuesday: 'selasa', wednesday: 'rabu', thursday: 'kamis', friday: 'jumat', saturday: 'sabtu' };
const GRACE_MINUTES = 2;
const SESSION_MS = 3 * 3600 * 1000;
const BOT_ADMIN_HINT = 'Pastikan bot adalah *Admin Grup*.';

const botSentMsgIds = new Set();
const groupChatHistory = new Map();
const groupInteractionCooldown = new Map();
const groupSpamTracker = new Map();
const processedJoinLock = new Set();
const joinErrorNoticeAt = new Map();
const pendingPollAt = new Map();

/* ───────────── Helper umum ───────────── */

const logErr = (where, e) => console.error(`[group_automation] ${where}:`, e?.message || e);
const digitsOnly = (v) => String(v ?? '').replace(/\D/g, '');
const jidDigits = (jid) => digitsOnly(String(jid ?? '').split('@')[0].split(':')[0]);
const jidOf = (p) => (typeof p === 'string' ? p : p?.id || p?.jid || '');
const phoneHintOf = (p) => (p && typeof p === 'object' ? p.phoneNumber || p.phone_number || p.pn || '' : '');
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const splitList = (s) => String(s ?? '').split(/[|;\n]/).map((x) => x.trim()).filter(Boolean);
const parsePrefixes = (v) => (v.toLowerCase() === 'all' ? [] : v.split(/[,\s]+/).map(digitsOnly).filter(Boolean));
const pickIndex = (param, list) => { const i = parseInt(param, 10) - 1; return i >= 0 && i < list.length ? i : -1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bump = (obj, key) => { if (obj && typeof obj === 'object') obj[key] = (Number(obj[key]) || 0) + 1; };
const ON = (v) => (v ? 'ON' : 'OFF');
const minutesOfDay = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

const onOff = (p) => {
  const v = String(p || '').toLowerCase();
  if (['on', 'aktif', 'nyala', 'hidup', '1'].includes(v)) return true;
  if (['off', 'mati', 'nonaktif', 'matikan', '0'].includes(v)) return false;
  return null;
};

function isBotJid(sock, jid) {
  const d = jidDigits(jid);
  return Boolean(d) && (d === jidDigits(sock?.user?.id) || d === jidDigits(sock?.user?.lid));
}

function getContextInfo(u) {
  if (!u || typeof u !== 'object') return null;
  return u.extendedTextMessage?.contextInfo || Object.values(u).find((v) => v && typeof v === 'object' && v.contextInfo)?.contextInfo || null;
}

function normalizeTime(input) {
  const s = String(input ?? '').trim().toLowerCase().replace(/\s*wib$/, '').replace('.', ':');
  const m = s.match(/^(\d{1,2}):(\d{2})$/) || s.match(/^(\d{2})(\d{2})$/) || s.match(/^(\d{1,2})$/)?.concat('00');
  if (!m) return '';
  const [h, mi] = [Number(m[1]), Number(m[2])];
  return h > 23 || mi > 59 ? '' : `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function normalizeDay(input) {
  const s = String(input ?? '').toLowerCase().replace(/[^a-z_]/g, '');
  if (!s || ['setiaphari', 'setiap_hari', 'harian', 'everyday', 'daily', 'tiaphari', 'semuahari'].includes(s)) return 'setiap_hari';
  const alias = { ahad: 'minggu', jumaat: 'jumat' }[s] || s;
  return VALID_DAYS.includes(alias) ? alias : '';
}

function normalizePhone(v) {
  const d = digitsOnly(v);
  return d.startsWith('0') ? `62${d.slice(1)}` : d;
}

function buildPoll(items) {
  if (!Array.isArray(items) || items.length < 3) return null;
  const values = [...new Set(items.slice(1).map((o) => o.slice(0, 100)))].slice(0, 12);
  return values.length < 2 ? null : { name: items[0].slice(0, 250), values, selectableCount: 1 };
}

function getWibTimeAndDate() {
  const now = new Date();
  const fmt = (locale, opts) => new Intl.DateTimeFormat(locale, { timeZone: 'Asia/Jakarta', ...opts }).format(now);
  const time = fmt('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).replace(/^24:/, '00:');
  return { time, date: fmt('en-CA'), day: EN_TO_ID_DAY[fmt('en-US', { weekday: 'long' }).toLowerCase()] || 'senin' };
}

function trackBotMessage(sent) {
  const id = sent?.key?.id;
  if (!id) return;
  botSentMsgIds.add(id);
  if (botSentMsgIds.size > 500) botSentMsgIds.delete(botSentMsgIds.values().next().value);
}

function pushGroupHistory(jid, sender, text) {
  const hist = groupChatHistory.get(jid) || [];
  groupChatHistory.set(jid, hist);
  hist.push({ sender: sender || 'Member', text: String(text ?? '').slice(0, 350) });
  if (hist.length > 10) hist.shift();
}

async function sendMenu(sock, jid, payload, quoted) {
  try {
    return await sendNativeInteractiveButtons(sock, jid, payload, quoted);
  } catch (e) {
    logErr('sendNativeInteractiveButtons', e);
  }
  const cmds = (payload.buttons || []).map((b) => `• \`${b.id}\` — ${b.text}`).join('\n');
  const text = [`*${payload.title}*`, payload.body, cmds && `*Ketik perintah:*\n${cmds}`, payload.footer && `_${payload.footer}_`].filter(Boolean).join('\n\n');
  await sock.sendMessage(jid, { text }, { quoted });
}

/* ───────────── Konfigurasi grup ───────────── */

export function ensureGroupAutoConfig(db, jid) {
  db.groupSettings ||= {};
  const cfg = (db.groupSettings[jid] ||= { antilink: false, antivirtek: true, antibug: true, antitoxic: true, antispam: true, welcome: false });
  cfg.antilink = Boolean(cfg.antilink);
  for (const k of ['antivirtek', 'antibug', 'antitoxic', 'antispam']) cfg[k] ??= true;
  cfg.welcome = Boolean(cfg.welcome);
  cfg.goodbye ??= cfg.welcome;
  cfg.welcomeText ||= '👋 Selamat datang @user di *@group*!\n\n📌 *Info Grup:*\n@desc\n\nTotal member sekarang: *@count* orang.';
  cfg.goodbyeText ||= '👋 Sampai jumpa @user, terima kasih sudah pernah bergabung di *@group*.';
  cfg.autoOpenTime ||= '';
  cfg.autoCloseTime ||= '';
  cfg.activities = (Array.isArray(cfg.activities) ? cfg.activities : []).filter((a) => a && typeof a === 'object');

  const mf = (cfg.memberFilter = cfg.memberFilter && typeof cfg.memberFilter === 'object' ? cfg.memberFilter : {});
  mf.enabled = Boolean(mf.enabled);
  mf.requirePhoto = Boolean(mf.requirePhoto);
  if (!Array.isArray(mf.allowedPrefixes)) mf.allowedPrefixes = ['62'];
  if (!Array.isArray(mf.blacklist)) mf.blacklist = [];

  if (!['bebas', 'reply', 'off'].includes(cfg.interactiveMode)) cfg.interactiveMode = 'bebas';
  if (!cfg.interactiveSession || typeof cfg.interactiveSession !== 'object') cfg.interactiveSession = { active: false, theme: '', lastPrompt: '', expiresAt: 0 };
  if (!cfg.runLog || typeof cfg.runLog !== 'object') cfg.runLog = {};
  return cfg;
}

// 👑 VVIP: true jika JID (nomor / LID) adalah admin/superadmin di metadata grup
export function isJidGroupAdmin(meta, jid) {
  const d = jidDigits(jid);
  if (!d) return false;
  const info = (meta?.participants || []).find((p) => p.id === jid || [p.id, p.phoneNumber, p.lid, p.jid].some((x) => jidDigits(x) === d));
  return info?.admin === 'admin' || info?.admin === 'superadmin';
}

export async function isSenderGroupAdmin(sock, jid, senderParticipant, senderNum, altNum = '', isOwner = false, prefetchedMeta = null) {
  if (isOwner) return true;
  if (!jid?.endsWith('@g.us')) return false;
  try {
    const meta = prefetchedMeta || (await sock.groupMetadata(jid));
    const wanted = new Set([jidDigits(senderParticipant), digitsOnly(senderNum), digitsOnly(altNum)].filter(Boolean));
    const info = (meta?.participants || []).find((p) => (senderParticipant && p.id === senderParticipant) || [p.id, p.phoneNumber, p.lid, p.jid].some((x) => wanted.has(jidDigits(x))));
    return info?.admin === 'admin' || info?.admin === 'superadmin';
  } catch (e) {
    logErr('isSenderGroupAdmin', e);
    return false;
  }
}

/* ───────────── Penjaga pesan (anti-*) ───────────── */

// 📥 Platform yang boleh didownload bot
const DOWNLOAD_HOSTS = /^(?:[\w-]+\.)*(tiktok\.com|capcut\.com|youtube\.com|youtu\.be|instagram\.com|facebook\.com|fb\.watch|fb\.com|twitter\.com|x\.com|mediafire\.com|drive\.google\.com|github\.com|open\.spotify\.com)$/i;
// Pesan harus diawali perintah bot (mis. `.tiktok`, `!ig`, `/yt`)
const COMMAND_PREFIX = /^\s*[.!#/]\s*[a-z]/i;

// Lolos hanya jika: ada PERINTAH di awal pesan DAN semua link berasal dari platform downloader.
// Link tanpa perintah (mis. "Tiktok https://vt.tiktok.com/xxx") tetap dianggap link biasa → dihapus.
function isDownloadRequest(text) {
  const urls = text.match(/(?:https?:\/\/|www\.)[^\s<>"]+/gi) || [];
  if (!urls.length || !COMMAND_PREFIX.test(text)) return false;
  return urls.every((u) => {
    try { return DOWNLOAD_HOSTS.test(new URL(/^https?:/i.test(u) ? u : `https://${u}`).hostname); } catch { return false; }
  });
}

function detectViolation({ text, lower, cfg, bot, dbMemory, jid, spamKey }) {
  if (cfg.antivirtek || cfg.antibug) {
    const count = (re) => (text.match(re) || []).length;
    if (text.length > 3500 || count(/[\u0300-\u036f]/g) > 25 || count(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g) > 40) return 'virtek';
  }

  if (cfg.antispam) {
    const key = `${jid}:${spamKey}`;
    const now = Date.now();
    const hist = (groupSpamTracker.get(key) || []).filter((t) => now - t < 5000);
    hist.push(now);
    groupSpamTracker.set(key, hist);
    if (groupSpamTracker.size > 3000) {
      for (const [k, h] of groupSpamTracker) if (!h.length || now - h[h.length - 1] > 10000) groupSpamTracker.delete(k);
    }
    if (hist.length > 6) return 'spam';
  }

  const norm = (arr) => arr.map((w) => String(w ?? '').toLowerCase().trim());
  if (cfg.antitoxic && norm([...(bot?.badWords || []), ...(dbMemory.learnedWords || [])]).some((w) => w.length >= 2 && lower.includes(w))) return 'toxic';

  if (cfg.antilink && !isDownloadRequest(text)) {
    if (/(https?:\/\/|www\.|chat\.whatsapp\.com|wa\.me\/)/i.test(text) || norm(bot?.blockedDomains || []).some((d) => d && lower.includes(d))) return 'link';
  }
  return null;
}

export async function handleGroupMessageGuard({ sock, jid, msg, rawText, textLower, senderParticipant, senderNum, isSenderAdmin, isOwner = false, bot, dbMemory }) {
  try {
    if (!jid?.endsWith('@g.us') || msg?.key?.fromMe || isOwner) return false;
    const text = typeof rawText === 'string' ? rawText : '';
    if (!text) return false;
    const cfg = ensureGroupAutoConfig(dbMemory, jid);
    const violation = detectViolation({ text, lower: typeof textLower === 'string' ? textLower : text.toLowerCase(), cfg, bot, dbMemory, jid, spamKey: senderNum || jidDigits(senderParticipant) });
    if (!violation) return false;

    // 👑 VVIP: admin tidak pernah dihapus pesannya / di-kick oleh sistem anti-*
    if (isSenderAdmin === true || (await isSenderGroupAdmin(sock, jid, senderParticipant, senderNum))) return false;

    await sock.sendMessage(jid, { delete: msg.key }).catch((e) => logErr('hapus pesan (bot harus admin)', e));
    const stat = { virtek: 'totalBlockedVirtek', toxic: 'totalDeletedBadWords', link: 'totalDeletedLinks' }[violation];
    if (stat) bump(bot?.stats, stat);
    if (violation === 'virtek') await sock.groupParticipantsUpdate(jid, [senderParticipant], 'remove').catch((e) => logErr('kick pelaku virtek', e));
    return true;
  } catch (e) {
    logErr('handleGroupMessageGuard', e);
    return false;
  }
}

/* ───────────── Tema & AI ───────────── */

function resolveTodayTheme(cfg) {
  const sess = cfg.interactiveSession;
  if (sess?.active && sess.theme && (!sess.expiresAt || Date.now() < sess.expiresAt)) return { theme: sess.theme, lastPrompt: sess.lastPrompt || '', isLiveSession: true };
  const { day } = getWibTimeAndDate();
  const act = cfg.activities.find((a) => ['setiap_hari', day].includes(normalizeDay(a.day)));
  return {
    theme: act ? `${day.toUpperCase()} — ${String(act.content || '').replace(/^ai:/i, '').trim()}` : 'Diskusi Belajar & Sharing Komunitas',
    lastPrompt: act ? sess?.lastPrompt || '' : '',
    isLiveSession: false,
  };
}

const formatWelcomeTemplate = (tpl, v) =>
  String(tpl).replace(/@(user|group|desc|count)\b/gi, (_, k) => ({ user: v.userTag, group: v.groupName, desc: v.groupDesc || 'Patuhi aturan grup & saling menghormati.', count: String(v.memberCount) })[k.toLowerCase()]);

async function askAIWithFallback(prompt, system, { minLength = 12 } = {}) {
  const usable = (t) => typeof t === 'string' && t.trim().length >= minLength && !/<!doctype|<html/i.test(t);
  const attempts = [
    ['AI utama', () => panggilServerAISatSet(prompt, system)],
    ['AI cadangan', async () => {
      const q = encodeURIComponent(`${String(system).slice(0, 900)}\n\n${String(prompt).slice(-1800)}`);
      const res = await fetchWithTimeout(`https://text.pollinations.ai/${q}?model=openai`, { headers: { 'User-Agent': 'WHUXEN-BOT/1.0' } }, 15000);
      return res?.ok ? res.text() : '';
    }],
  ];
  for (const [label, run] of attempts) {
    try {
      const t = await run();
      if (usable(t)) return t.trim();
    } catch (e) {
      logErr(label, e);
    }
  }
  return null;
}

async function generateStudyMaterialAI(topic) {
  return (await askAIWithFallback(
    `Buatkan materi pembuka diskusi grup WhatsApp tema "${topic}": 1) Penjelasan inti ringkas, 2) 2-3 contoh praktis, 3) 1 pertanyaan interaktif di akhir. Bahasa Indonesia santai-edukatif, gunakan *bintang tunggal* untuk bold.`,
    'Kamu adalah mentor sekaligus teman diskusi yang asyik di grup belajar WhatsApp.',
    { minLength: 30 },
  )) || `📌 *Topik Hari Ini:* ${topic}\n\n• Yuk kita bedah bareng materi *${topic}*!\n• Tulis jawaban atau pertanyaanmu di bawah pesan ini.\n\n💬 *Tantangan Awal:* Sebutkan 1 hal yang ingin kamu bahas tentang *${topic}*!`;
}

/* ───────────── Join request & welcome ───────────── */

export async function evaluateAndProcessJoinRequest(sock, dbMemory, jid, participant, phoneHint = '') {
  const filter = ensureGroupAutoConfig(dbMemory, jid).memberFilter;
  const pJid = jidOf(participant);
  if (!filter.enabled || !pJid) return { handled: false };

  const idDigits = jidDigits(pJid);
  const phoneDigits = pJid.endsWith('@lid') ? digitsOnly(phoneHint || phoneHintOf(participant)) : idDigits;
  const lockKey = `${jid}:${idDigits}`;
  if (processedJoinLock.has(lockKey)) return { handled: false };
  processedJoinLock.add(lockKey);
  setTimeout(() => processedJoinLock.delete(lockKey), 30000);

  let reason = '';
  if ([idDigits, phoneDigits].some((n) => n && filter.blacklist.includes(n))) reason = 'Nomor terdaftar di blacklist grup';
  else if (filter.allowedPrefixes.length && phoneDigits && !filter.allowedPrefixes.some((p) => phoneDigits.startsWith(p))) reason = `Hanya nomor berawalan ${filter.allowedPrefixes.join('/')} yang diizinkan`;
  else if (filter.requirePhoto && !(await sock.profilePictureUrl(pJid, 'image').catch(() => null))) reason = 'Wajib memasang foto profil publik sebelum bergabung';

  const action = reason ? 'reject' : 'approve';
  try {
    await sock.groupRequestParticipantsUpdate(jid, [pJid], action);
  } catch (e) {
    logErr(`join request ${action}`, e);
    if (Date.now() - (joinErrorNoticeAt.get(jid) || 0) > 30 * 60 * 1000) {
      joinErrorNoticeAt.set(jid, Date.now());
      await sock.sendMessage(jid, { text: `⚠️ Filter member otomatis gagal memproses permintaan gabung. ${BOT_ADMIN_HINT}` }).catch(() => {});
    }
    return { handled: true, approved: false, error: true };
  }

  const decision = reason ? `❌ *DITOLAK*\n• Alasan: ${reason}` : '✅ *DISETUJUI OTOMATIS*';
  await sock.sendMessage(jid, { text: `🛡️ *FILTER MEMBER OTOMATIS*\n• Nomor: ${phoneDigits ? `+${phoneDigits}` : `ID:${idDigits}`}\n• Keputusan: ${decision}` }).catch(() => {});
  return { handled: true, approved: !reason };
}

const pendingRequests = (sock, jid) => sock.groupRequestParticipantsList(jid).catch(() => []);

async function processPendingRequests(sock, dbMemory, jid) {
  for (const p of (await pendingRequests(sock, jid)) || []) {
    const target = jidOf(p);
    if (target) await evaluateAndProcessJoinRequest(sock, dbMemory, jid, target, phoneHintOf(p));
  }
}

export async function handleGroupJoinRequestEvent(sock, dbMemory, event) {
  try {
    const act = String(event?.action || 'created').toLowerCase();
    if (!event?.id || !event?.participant || !['created', 'request', 'requested'].includes(act)) return;
    await evaluateAndProcessJoinRequest(sock, dbMemory, event.id, event.participant, event.participantPn || '');
  } catch (e) {
    logErr('handleGroupJoinRequestEvent', e);
  }
}

export async function handleGroupParticipantsUpdate(sock, dbMemory, update) {
  try {
    const { id: jid, participants, action } = update || {};
    if (!jid?.endsWith('@g.us') || !Array.isArray(participants)) return;
    if (action === 'request') {
      for (const p of participants) await evaluateAndProcessJoinRequest(sock, dbMemory, jid, jidOf(p), phoneHintOf(p));
      return;
    }
    const isAdd = action === 'add';
    if (!isAdd && action !== 'remove') return;
    const cfg = ensureGroupAutoConfig(dbMemory, jid);
    if (!(isAdd ? cfg.welcome : cfg.goodbye)) return;

    const meta = await sock.groupMetadata(jid).catch(() => null);
    const info = { groupName: meta?.subject || 'Grup Ini', groupDesc: meta?.desc || '', memberCount: meta?.participants?.length || 0 };

    for (const p of participants) {
      const pJid = jidOf(p);
      if (!pJid || isBotJid(sock, pJid)) continue;
      const text = formatWelcomeTemplate(isAdd ? cfg.welcomeText : cfg.goodbyeText, { userTag: `@${jidDigits(pJid)}`, ...info });
      const ppUrl = isAdd ? await sock.profilePictureUrl(pJid, 'image').catch(() => null) : null;
      const plain = { text, mentions: [pJid] };
      const sent = await sock.sendMessage(jid, ppUrl ? { image: { url: ppUrl }, caption: text, mentions: [pJid] } : plain)
        .catch(() => (ppUrl ? sock.sendMessage(jid, plain).catch(() => null) : null));
      trackBotMessage(sent);
    }
  } catch (e) {
    logErr('handleGroupParticipantsUpdate', e);
  }
}

/* ───────────── Kegiatan terjadwal ───────────── */

async function executeGroupActivity(sock, jid, activity, dbMemory = null, saveMemory = null) {
  const type = String(activity.type || 'jadwal').toLowerCase();
  const content = String(activity.content || '');
  const dayName = (normalizeDay(activity.day) || 'setiap_hari').toUpperCase();
  const dayLabel = dayName !== 'SETIAP_HARI' ? ` (${dayName})` : '';
  const timeLabel = normalizeTime(activity.time) || activity.time || '';
  const topic = content.replace(/^ai:/i, '').trim();
  const say = (text) => sock.sendMessage(jid, { text });
  let sentMain;
  let summary = topic;
  let opensSession = false;

  if (type === 'poll' || type === 'polling') {
    const poll = buildPoll(splitList(content));
    if (poll) {
      poll.name = `📊 ${poll.name}`;
      sentMain = await sock.sendMessage(jid, { poll });
      summary = poll.name;
    } else {
      sentMain = await say(`⚠️ Kegiatan poll *${timeLabel} WIB* tidak valid. Isi harus: Pertanyaan ; Opsi 1 ; Opsi 2 (pemisah ; atau |).`);
    }
  } else if (type === 'materi') {
    opensSession = true;
    const head = `🕒 Pukul: ${timeLabel} WIB`;
    if (/absensi/i.test(topic)) {
      trackBotMessage(await sock.sendMessage(jid, { poll: { name: `📋 ABSENSI MEMBER${dayLabel} (${timeLabel} WIB)`, values: ['✅ Hadir & Siap Belajar', '⏳ Menyusul', '🙏 Izin'], selectableCount: 1 } }));
      summary = await generateStudyMaterialAI('Motivasi belajar singkat & sapaan hangat untuk member yang absen');
      sentMain = await say(`🔥 *MOTIVASI & SAPAAN${dayLabel}*\n\n${summary}\n\n_Ceritain target belajarmu minggu ini di bawah ya!_`);
    } else if (/tanya jawab|interaksi member|free time/i.test(topic)) {
      summary = await generateStudyMaterialAI(`${topic} — buat 3 pertanyaan kuis ringan dan pemantik obrolan seru untuk member grup`);
      sentMain = await say(`💬 *SESI INTERAKTIF${dayLabel}*\n${head}\n\n${summary}\n\n_Langsung balas pesan ini atau sebut namaku untuk ngobrol bareng!_`);
    } else {
      summary = /^ai:/i.test(content) ? await generateStudyMaterialAI(topic) : topic;
      sentMain = await say(`📚 *MATERI & DISKUSI TEMA*${dayLabel}\n${head}\n\n${summary}\n\n_💬 Jawab pertanyaan di atas atau tanya langsung di chat, aku siap bantu bahas bareng!_`);
    }
  } else {
    sentMain = await say(`🗓️ *PENGINGAT JADWAL GRUP*${dayLabel}\n⏰ Pukul ${timeLabel} WIB\n\n${content}`);
  }

  trackBotMessage(sentMain);
  pushGroupHistory(jid, 'BOT', String(summary).slice(0, 300));

  if (opensSession && dbMemory) {
    ensureGroupAutoConfig(dbMemory, jid).interactiveSession = {
      active: true,
      theme: `${dayName !== 'SETIAP_HARI' ? `${dayName} - ` : ''}${topic}`,
      lastPrompt: String(summary).slice(0, 500),
      expiresAt: Date.now() + SESSION_MS,
    };
    if (typeof saveMemory === 'function') await saveMemory();
  }
}

/* ───────────── Interaksi tema (AI) ───────────── */

export async function handleGroupThemeInteraction({ sock, jid, pushName, rawText, unwrapped, msg, dbMemory, bot }) {
  try {
    if (!jid?.endsWith('@g.us') || typeof rawText !== 'string' || rawText.trim().length < 2 || msg?.key?.fromMe) return false;
    const cfg = ensureGroupAutoConfig(dbMemory, jid);
    const senderName = pushName || 'Member';
    pushGroupHistory(jid, senderName, rawText);
    if (cfg.interactiveMode === 'off') return false;

    const ctx = getContextInfo(unwrapped);
    const isReply = Boolean((ctx?.stanzaId && botSentMsgIds.has(ctx.stanzaId)) || isBotJid(sock, ctx?.participant));
    const botFirst = escapeRegex(String(bot?.userName || 'whuxen').toLowerCase().split(/\s+/)[0]);
    const nameHit = new RegExp(`(^|[^a-z0-9])(${botFirst}|bot|tutor|min|kak bot)([^a-z0-9]|$)`, 'i').test(rawText);
    const isMention = Boolean((ctx?.mentionedJid || []).some((m) => isBotJid(sock, m)) || nameHit);

    const { theme, lastPrompt, isLiveSession } = resolveTodayTheme(cfg);
    if (!isReply && !isMention && (cfg.interactiveMode === 'reply' || !isLiveSession)) return false;
    if (Date.now() - (groupInteractionCooldown.get(jid) || 0) < 4000) return false;
    groupInteractionCooldown.set(jid, Date.now());

    const recent = (groupChatHistory.get(jid) || []).map((m) => `${m.sender}: ${m.text}`).join('\n');
    const system = `Kamu adalah ${bot?.userName || 'WHUXEN BOT'}, fasilitator aktif di grup belajar WhatsApp. Tema: "${theme}". ${lastPrompt ? `Konteks terakhir: "${lastPrompt.slice(0, 350)}"` : ''} Tanggapi secara akrab & ringkas (maksimal 3-5 kalimat). Jika obrolan tidak nyambung & bukan untukmu, balas tepat: SKIP`;

    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
    const reply = await askAIWithFallback(`Riwayat:\n${recent}\n\nPesan terbaru dari ${senderName}: "${rawText}"`, system, { minLength: 2 });
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
    if (!reply || /^\W*skip\W*$/i.test(reply)) return false;

    trackBotMessage(await sock.sendMessage(jid, { text: reply.slice(0, 1500) }, { quoted: msg }));
    pushGroupHistory(jid, 'BOT', reply);
    return true;
  } catch (e) {
    logErr('handleGroupThemeInteraction', e);
    return false;
  }
}

/* ───────────── Scheduler ───────────── */

const schedulerCtx = { sock: null, dbMemory: null, saveMemory: null };
let schedulerStarted = false;
let tickRunning = false;

function isDue(timeStr, nowStr) {
  const t = normalizeTime(timeStr);
  const diff = t ? minutesOfDay(nowStr) - minutesOfDay(t) : -1;
  return diff >= 0 && diff <= GRACE_MINUTES;
}

function activityKey(a) {
  const raw = `${normalizeDay(a.day)}|${normalizeTime(a.time)}|${a.type}|${a.content}`;
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) | 0;
  return `act:${(h >>> 0).toString(36)}`;
}

async function schedulerTick() {
  const { sock, dbMemory, saveMemory } = schedulerCtx;
  if (tickRunning || !sock || !dbMemory) return;
  tickRunning = true;
  try {
    const { time: nowWib, date: today, day: todayDay } = getWibTimeAndDate();
    let dirty = false;
    // Tandai jadwal sudah dijalankan (sekali per hari/jam) → true bila baru
    const claim = (cfg, key, time) => {
      const stamp = `${today} ${normalizeTime(time)}`;
      if (!time || !isDue(time, nowWib) || cfg.runLog[key] === stamp) return false;
      cfg.runLog[key] = stamp;
      return dirty = true;
    };

    for (const jid of Object.keys(dbMemory.groupSettings || {})) {
      if (!jid.endsWith('@g.us')) continue;
      try {
        const cfg = ensureGroupAutoConfig(dbMemory, jid);

        const jobs = [
          ['open', cfg.autoOpenTime, 'not_announcement', 'membuka', `🔓 *GRUP DIBUKA OTOMATIS* (${nowWib} WIB)\nSemua anggota sekarang dapat mengirim pesan kembali.`],
          ['close', cfg.autoCloseTime, 'announcement', 'menutup', `🔒 *GRUP DITUTUP OTOMATIS* (${nowWib} WIB)\nSementara hanya admin yang dapat mengirim pesan hingga jadwal buka berikutnya.`],
        ];
        for (const [key, time, mode, verb, ok] of jobs) {
          if (!claim(cfg, key, time)) continue;
          try {
            await sock.groupSettingUpdate(jid, mode);
            await sock.sendMessage(jid, { text: ok });
          } catch (e) {
            logErr(`auto ${key} grup`, e);
            await sock.sendMessage(jid, { text: `⚠️ Gagal ${verb} grup otomatis (${nowWib} WIB). ${BOT_ADMIN_HINT}` }).catch(() => {});
          }
        }

        if (cfg.memberFilter.enabled && Date.now() - (pendingPollAt.get(jid) || 0) >= 60000) {
          pendingPollAt.set(jid, Date.now());
          await processPendingRequests(sock, dbMemory, jid);
        }

        const liveKeys = new Set(['open', 'close']);
        for (const act of cfg.activities) {
          const key = activityKey(act);
          liveKeys.add(key);
          const d = normalizeDay(act.day);
          if ((d === 'setiap_hari' || d === todayDay) && claim(cfg, key, act.time)) {
            await executeGroupActivity(sock, jid, act, dbMemory, saveMemory).catch((e) => logErr(`kegiatan ${act.time}`, e));
          }
        }
        for (const k of Object.keys(cfg.runLog)) if (!liveKeys.has(k)) delete cfg.runLog[k];
      } catch (e) {
        logErr(`scheduler grup ${jid}`, e);
      }
    }

    if (dirty && typeof saveMemory === 'function') await saveMemory().catch((e) => logErr('saveMemory scheduler', e));
  } catch (e) {
    logErr('schedulerTick', e);
  } finally {
    tickRunning = false;
  }
}

export function startGroupAutomationScheduler(sock, dbMemory, saveMemory = null) {
  Object.assign(schedulerCtx, { sock, dbMemory, saveMemory });
  if (schedulerStarted) return;
  schedulerStarted = true;
  setInterval(() => schedulerTick().catch((e) => logErr('scheduler', e)), 15 * 1000);
}

/* ───────────── Perintah grup ───────────── */

function parseScheduleFromDesc(desc) {
  const out = [];
  for (const line of String(desc ?? '').replace(/[’'`*_~]/g, '').split(/\r?\n/)) {
    const m = line.match(/^[^a-zA-Z]*(senin|selasa|rabu|kamis|jumat|jumaat|sabtu|minggu|ahad)\b/i);
    if (!m) continue;
    const rest = line.slice(m[0].length);
    const t = rest.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
    const topic = rest.replace(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(wib)?/gi, '').replace(/^[\s:()\-–—,.]+/, '').trim();
    if (topic.length >= 2) out.push({ day: normalizeDay(m[1]), time: t ? normalizeTime(`${t[1]}:${t[2]}`) : '', topic });
  }
  return out;
}

function resolveTarget(unwrapped, param) {
  const ctx = getContextInfo(unwrapped);
  if (ctx?.mentionedJid?.[0]) return ctx.mentionedJid[0];
  const num = normalizePhone(param);
  return num.length >= 8 ? `${num}@s.whatsapp.net` : ctx?.participant || '';
}

export async function handleGroupCommand(ctx) {
  const cmd = String(ctx?.cmd || '').toLowerCase();
  if (!ALL_GROUP_COMMANDS.includes(cmd)) return false;
  try {
    return await runGroupCommand({ ...ctx, cmd });
  } catch (e) {
    logErr(`perintah ${cmd}`, e);
    await ctx.sock.sendMessage(ctx.jid, { text: `❌ Perintah *${cmd}* gagal dijalankan.\n• ${BOT_ADMIN_HINT} Target harus valid dan koneksi WhatsApp stabil.\n• Detail: ${String(e?.message || e).slice(0, 120)}` }, { quoted: ctx.msg }).catch(() => {});
    return true;
  }
}

const TOGGLES = {
  antilink: '🔗 Anti-Link', antivirtek: '☣️ Anti-Virtek', antibug: '🐞 Anti-Bug', antitoxic: '🤬 Anti-Toxic',
  antispam: '⚡ Anti-Spam', welcome: '👋 Welcome Masuk', goodbye: '🚪 Goodbye Keluar',
};

const JOIN_HINTS = {
  403: 'ditolak WhatsApp (target admin/pembuat grup, atau privasi akun target membatasi undangan)',
  404: 'nomor tidak ditemukan di WhatsApp',
  409: 'target sudah berada di grup',
};

async function runGroupCommand({ sock, jid, isGroup, senderParticipant, senderNum, isOwner, isSenderAdmin, cmd, param: rawParam, unwrapped, msg, dbMemory, saveMemory }) {
  const param = typeof rawParam === 'string' ? rawParam.trim() : '';
  const reply = (text, extra = {}) => sock.sendMessage(jid, { text, ...extra }, { quoted: msg });
  const save = async () => { if (typeof saveMemory === 'function') await saveMemory(); };
  const done = async (text, extra) => { await reply(text, extra); return true; };

  if (['keamanangrup', 'securitymenu'].includes(cmd)) return done(GROUP_SECURITY_MENU);
  if (!(isGroup === true || jid?.endsWith('@g.us'))) return done('⚠️ Perintah grup hanya bisa digunakan di dalam grup.');

  const meta = await sock.groupMetadata(jid).catch(() => null);
  const members = (meta?.participants || []).map((p) => p.id);
  const cfg = ensureGroupAutoConfig(dbMemory, jid);
  const mf = cfg.memberFilter;
  const adminStatus = Boolean(isOwner) || isSenderAdmin === true || (await isSenderGroupAdmin(sock, jid, senderParticipant, senderNum, '', false, meta));
  const setOnOff = (obj, key) => { const v = onOff(param); obj[key] = v === null ? !obj[key] : v; return obj[key]; };

  /* ── Terbuka untuk semua anggota ── */

  if (['ginfo', 'groupsettings', 'gsettings'].includes(cmd)) {
    await sendMenu(sock, jid, {
      title: '🛡️ KEAMANAN & PENGATURAN GRUP',
      body: `📌 *Grup:* ${meta?.subject || 'Grup'}\n• Anti-Link: *${ON(cfg.antilink)}* | Anti-Virtek: *${ON(cfg.antivirtek)}*\n• Anti-Toxic: *${ON(cfg.antitoxic)}* | Anti-Spam: *${ON(cfg.antispam)}*\n• Welcome: *${ON(cfg.welcome)}* | Auto ACC: *${ON(mf.enabled)}*\n• Wajib PP: *${ON(mf.requirePhoto)}* | Kode: *${mf.allowedPrefixes.join(', ') || 'Semua'}*\n• 👑 VVIP Admin: *AKTIF* (kebal kick & demote)`,
      buttons: [{ text: '🛡️ Menu Keamanan', id: 'keamanangrup' }, { text: '🔗 Toggle Anti-Link', id: 'antilink' }, { text: '⚙️ Panel Otomatisasi', id: 'panelgrup' }],
    }, msg);
    return true;
  }

  if (cmd === 'poll') {
    const poll = buildPoll(splitList(param));
    if (poll) await sock.sendMessage(jid, { poll });
    else await reply('⚠️ Contoh: `poll Pertanyaan | Opsi 1 | Opsi 2` (minimal 2 opsi, maksimal 12)');
    return true;
  }

  if (!adminStatus) return done('⛔ Perintah ini khusus Admin Grup atau Owner.');

  /* ── Toggle ── */

  if (TOGGLES[cmd]) {
    const state = setOnOff(cfg, cmd);
    await save();
    return done(`${TOGGLES[cmd]}: *${state ? 'ON ✅' : 'OFF ❌'}*`);
  }

  /* ── Aksi sederhana ── */

  const needMembers = ['tagall', 'everyone', 'hidetag'].includes(cmd);
  if (needMembers) {
    if (!members.length) return done('⚠️ Gagal mengambil daftar anggota grup.');
    const text = cmd === 'hidetag' ? param || '📢 Info' : (param ? `📢 *${param}*\n\n` : '') + members.map((p) => `@${jidDigits(p)}`).join(' ');
    await sock.sendMessage(jid, { text, mentions: members });
    return true;
  }

  const simple = {
    link: async () => `https://chat.whatsapp.com/${await sock.groupInviteCode(jid)}`,
    revoke: async () => { await sock.groupRevokeInvite(jid); return '✅ Link undangan grup berhasil direset.'; },
    mute: async () => { await sock.groupSettingUpdate(jid, 'announcement'); return '🔒 Grup ditutup untuk anggota biasa.'; },
    unmute: async () => { await sock.groupSettingUpdate(jid, 'not_announcement'); return '🔓 Grup dibuka untuk semua anggota.'; },
    tutupinteraksi: async () => { cfg.interactiveSession = { active: false, theme: '', lastPrompt: '', expiresAt: 0 }; await save(); return '🛑 Sesi diskusi tema aktif telah ditutup.'; },
  };
  if (simple[cmd]) return done(await simple[cmd]());

  if (cmd === 'updategname' || cmd === 'updategdesc') {
    const isName = cmd === 'updategname';
    if (!param) return done(`⚠️ Contoh: \`${cmd} ${isName ? 'Nama Grup Baru' : 'Deskripsi grup baru'}\``);
    if (isName) await sock.groupUpdateSubject(jid, param.slice(0, 100));
    else await sock.groupUpdateDescription(jid, param);
    return done(isName ? `✅ Nama grup diubah menjadi *${param.slice(0, 100)}*.` : '✅ Deskripsi grup diperbarui.');
  }

  if (cmd === 'leave') {
    await sock.sendMessage(jid, { text: '👋 Bot keluar dari grup.' });
    await sock.groupLeave(jid);
    return true;
  }

  if (cmd === 'delete' || cmd === 'del') {
    const q = getContextInfo(unwrapped);
    if (!q?.stanzaId) return done('⚠️ Balas (reply) pesan yang ingin dihapus dengan `.del`');
    const fromBot = botSentMsgIds.has(q.stanzaId) || isBotJid(sock, q.participant);
    await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: fromBot, id: q.stanzaId, ...(fromBot ? {} : { participant: q.participant }) } });
    return true;
  }

  if (['kick', 'add', 'promote', 'demote'].includes(cmd)) {
    const target = resolveTarget(unwrapped, param);
    if (!target) return done(`⚠️ Tag, balas pesan, atau ketik nomor anggota untuk perintah \`.${cmd} @nomor\`.`);
    if (isBotJid(sock, target)) return done('⚠️ Target tidak boleh nomor bot sendiri.');
    const who = `@${jidDigits(target)}`;
    const mentions = { mentions: [target] };

    // 👑 VVIP: admin grup tidak bisa di-kick / di-demote lewat bot (hanya Owner)
    if ((cmd === 'kick' || cmd === 'demote') && !isOwner) {
      if (!meta) return done('⚠️ Gagal memverifikasi status admin target. Coba lagi sebentar.');
      if (isJidGroupAdmin(meta, target)) return done(`👑 *VVIP ADMIN*\n${who} adalah admin grup dan dilindungi — tidak bisa di-${cmd}.`, mentions);
    }

    const res = await sock.groupParticipantsUpdate(jid, [target], cmd === 'kick' ? 'remove' : cmd);
    const status = String((Array.isArray(res) && res[0]?.status) || '200');
    return done(status === '200'
      ? `✅ Perintah *${cmd.toUpperCase()}* berhasil dijalankan untuk ${who}.`
      : `❌ Perintah *${cmd.toUpperCase()}* gagal untuk ${who} (kode ${status}): ${JOIN_HINTS[status] || 'pastikan bot adalah Admin Grup'}.`, mentions);
  }

  /* ── Interaksi AI ── */

  if (cmd === 'interaksi') {
    const mode = param.toLowerCase();
    if (!['bebas', 'reply', 'off'].includes(mode)) {
      return done(`💬 *INTERAKSI BOT*\n• Mode: *${cfg.interactiveMode.toUpperCase()}* | Tema: *${resolveTodayTheme(cfg).theme}*\n• \`interaksi bebas\` / \`reply\` / \`off\` | \`settema <judul>\``);
    }
    cfg.interactiveMode = mode;
    await save();
    return done(`✅ Mode interaksi bot: *${mode.toUpperCase()}*`);
  }

  if (cmd === 'settema') {
    if (!param) return done('⚠️ Contoh: `settema Bahasa Jepang N5 - Percakapan`');
    if (cfg.interactiveMode === 'off') cfg.interactiveMode = 'bebas';
    cfg.interactiveSession = { active: true, theme: param, lastPrompt: `Sesi diskusi manual dengan tema: ${param}`, expiresAt: Date.now() + SESSION_MS };
    await save();
    const opener = await askAIWithFallback(`Sapa member grup WhatsApp dengan ramah dan buka sesi diskusi bertema "${param}". Ajukan 1 pertanyaan pembuka.`, 'Kamu adalah moderator seru di grup WhatsApp.');
    trackBotMessage(await reply(`🎯 *SESI DISKUSI TEMA AKTIF (3 JAM)*\n📌 Tema: *${param}*\n\n${opener || `Halo semuanya! Yuk diskusi bareng seputar *${param}*.`}`));
    return true;
  }

  /* ── Panel ── */

  if (cmd === 'panelgrup') {
    const cur = resolveTodayTheme(cfg);
    await sendMenu(sock, jid, {
      title: '⚙️ PANEL OTOMATISASI & KEAMANAN GRUP',
      body: `📌 *Grup:* ${meta?.subject || 'Grup'}\n• *Keamanan:* Link(${ON(cfg.antilink)}) | Virtek(${ON(cfg.antivirtek)}) | Toxic(${ON(cfg.antitoxic)}) | Spam(${ON(cfg.antispam)})\n• *👑 VVIP Admin:* AKTIF\n• *Mode Interaksi:* ${cfg.interactiveMode.toUpperCase()} (${cur.isLiveSession ? 'Sesi Live 🟢' : 'Standby'})\n• *Welcome / Goodbye:* ${ON(cfg.welcome)} / ${ON(cfg.goodbye)}\n• *Auto Buka / Tutup:* ${cfg.autoOpenTime || '-'} / ${cfg.autoCloseTime || '-'}\n• *Auto ACC Member:* ${mf.enabled ? 'ON ✅' : 'OFF ❌'}\n• *Kegiatan Terjadwal:* ${cfg.activities.length} jadwal`,
      footer: 'Ketik .keamanangrup untuk daftar perintah keamanan',
      buttons: [{ text: '🛡️ Menu Keamanan', id: 'keamanangrup' }, { text: '🚀 Tes Semua Kegiatan', id: 'tessemuakegiatan' }, { text: '👋 Toggle Welcome', id: 'welcome' }],
    }, msg);
    return true;
  }

  /* ── Welcome / goodbye ── */

  if (cmd === 'setwelcome' || cmd === 'setgoodbye') {
    const k = cmd === 'setwelcome' ? 'welcome' : 'goodbye';
    if (!param) return done(`⚠️ Contoh: \`${cmd} Halo @user di @group!\`\nVariabel: @user @group @desc @count`);
    cfg[`${k}Text`] = param;
    cfg[k] = true;
    await save();
    return done(`✅ Teks ${k === 'welcome' ? 'Welcome' : 'Goodbye'} disimpan & diaktifkan.`);
  }

  /* ── Buka / tutup otomatis ── */

  if (cmd === 'autobuka' || cmd === 'autotutup') {
    const isOpen = cmd === 'autobuka';
    const field = isOpen ? 'autoOpenTime' : 'autoCloseTime';
    if (!param) return done(`⚠️ Contoh: \`${cmd} ${isOpen ? '06:00' : '22:00'}\` atau \`${cmd} off\``);
    if (onOff(param) === false) {
      cfg[field] = '';
      await save();
      return done(`✅ Jadwal ${isOpen ? 'buka' : 'tutup'} grup otomatis dimatikan.`);
    }
    const t = normalizeTime(param);
    if (!t) return done('❌ Format jam harus `HH:mm` (24 jam), contoh: `06:30`');
    cfg[field] = t;
    await save();
    return done(`${isOpen ? '🔓' : '🔒'} Grup diatur *${isOpen ? 'BUKA' : 'TUTUP'} OTOMATIS* setiap pukul *${t} WIB*.\n_Bot harus menjadi Admin Grup agar jadwal ini berjalan._`);
  }

  /* ── Kegiatan terjadwal ── */

  if (cmd === 'syncjadwal') {
    const defTime = normalizeTime(param) || '19:00';
    const found = parseScheduleFromDesc(meta?.desc);
    if (!found.length) return done('⚠️ Tidak ditemukan format jadwal `HARI : TOPIK` di deskripsi grup.\nContoh baris: `Senin : Python Dasar` atau `Selasa 20.00 : Desain Web`');
    cfg.activities = cfg.activities.filter((a) => a.source !== 'syncjadwal');
    for (const f of found) cfg.activities.push({ day: f.day, time: f.time || defTime, type: 'materi', content: `ai:${f.topic}`, source: 'syncjadwal' });
    await save();
    return done(`✅ *${found.length} JADWAL MATERI AI AKTIF!*\n\n${found.map((f) => `• *${f.day.toUpperCase()}* (${f.time || defTime} WIB) → ${f.topic}`).join('\n')}`);
  }

  if (cmd === 'tambahkegiatan') {
    const segs = param.split('|').map((s) => s.trim());
    if (segs.length < 3 || !segs[2]) return done('⚠️ Format: `tambahkegiatan [hari] <HH:mm> | <materi/poll/jadwal> | <isi>`\nContoh: `tambahkegiatan senin 19:00 | materi | ai:Python Dasar`\nPoll: `tambahkegiatan 20:00 | poll | Pertanyaan ; Opsi 1 ; Opsi 2`');
    const tokens = segs[0].toLowerCase().replace(/\bwib\b/g, '').trim().split(/\s+/).filter(Boolean);
    const time = normalizeTime(tokens.pop() || '');
    const day = normalizeDay(tokens.join(''));
    const type = segs[1].toLowerCase() === 'polling' ? 'poll' : segs[1].toLowerCase();
    const content = segs.slice(2).join(' | ');
    if (!time || !['materi', 'poll', 'jadwal'].includes(type)) return done('❌ Jam harus `HH:mm` dan jenis harus `materi`, `poll`, atau `jadwal`.');
    if (!day) return done(`❌ Hari tidak dikenal. Pilih: ${VALID_DAYS.join(', ')}`);
    if (type === 'poll' && !buildPoll(splitList(content))) return done('❌ Format poll: `Pertanyaan ; Opsi 1 ; Opsi 2` (minimal 2 opsi).');
    cfg.activities.push({ day, time, type, content });
    await save();
    return done(`✅ Kegiatan ditambahkan: *${day.toUpperCase()} ${time} WIB* (${type.toUpperCase()})`);
  }

  if (cmd === 'listkegiatan') {
    return done(cfg.activities.length
      ? `🗓️ *KEGIATAN GRUP*\n\n${cfg.activities.map((a, i) => `*${i + 1}.* [${(normalizeDay(a.day) || 'setiap_hari').toUpperCase()} • ${normalizeTime(a.time) || a.time} WIB] *(${String(a.type || 'jadwal').toUpperCase()})*\n    ${String(a.content || '').slice(0, 80)}`).join('\n\n')}`
      : '📭 Belum ada jadwal kegiatan.');
  }

  if (cmd === 'hapuskegiatan') {
    if (param.toLowerCase() === 'semua') {
      cfg.activities = [];
      await save();
      return done('🗑️ Semua jadwal kegiatan dihapus.');
    }
    const i = pickIndex(param, cfg.activities);
    if (i < 0) return done('⚠️ Masukkan nomor kegiatan yang valid (lihat `listkegiatan`) atau `hapuskegiatan semua`.');
    const [removed] = cfg.activities.splice(i, 1);
    await save();
    return done(`🗑️ Kegiatan *[${removed.time} WIB]* dihapus.`);
  }

  if (['teskegiatan', 'tessemuakegiatan', 'testsemuakegiatan'].includes(cmd)) {
    const acts = cfg.activities;
    if (!acts.length) return done('📭 Belum ada jadwal kegiatan.');
    if (cmd !== 'teskegiatan' || ['semua', 'all'].includes(param.toLowerCase())) {
      await reply(`🚀 *Menjalankan tes ${acts.length} kegiatan...*`);
      let failed = 0;
      for (const [i, act] of acts.entries()) {
        await executeGroupActivity(sock, jid, act, dbMemory, saveMemory).catch((e) => { failed++; logErr(`tes kegiatan ${i + 1}`, e); });
        if (i < acts.length - 1) await sleep(3500);
      }
      return done(failed ? `⚠️ Tes selesai, *${failed}* kegiatan gagal dikirim (cek log).` : '✅ *Semua kegiatan berhasil dites!*');
    }
    const i = pickIndex(param, acts);
    if (i < 0) return done('⚠️ Contoh: `teskegiatan 1` atau `teskegiatan semua`');
    await executeGroupActivity(sock, jid, acts[i], dbMemory, saveMemory);
    return true;
  }

  /* ── Filter & ACC member ── */

  if (cmd === 'autoapprove' || cmd === 'autoacc') {
    setOnOff(mf, 'enabled');
    await save();
    await reply(`🛡️ *Auto ACC Member:* ${mf.enabled ? 'ON ✅' : 'OFF ❌'}\n• Kode: *${mf.allowedPrefixes.join(', ') || 'Semua'}* | Wajib PP: *${ON(mf.requirePhoto)}*`);
    if (mf.enabled) await processPendingRequests(sock, dbMemory, jid);
    return true;
  }

  if (cmd === 'acc') {
    const ctx = getContextInfo(unwrapped);
    const num = normalizePhone(param) || jidDigits(ctx?.mentionedJid?.[0] || ctx?.participant);
    const pending = await pendingRequests(sock, jid);
    const found = num && Array.isArray(pending)
      ? pending.find((p) => jidDigits(jidOf(p)) === num || normalizePhone(phoneHintOf(p)) === num || jidDigits(jidOf(p)) === digitsOnly(param))
      : null;
    const target = (found && jidOf(found)) || resolveTarget(unwrapped, param);
    if (!target) return done('⚠️ Contoh: `.acc @nomor` atau `.acc 628123456789`');
    await sock.groupRequestParticipantsUpdate(jid, [target], 'approve');
    return done(`✅ Permintaan gabung *@${jidDigits(target)}* disetujui.`, { mentions: [target] });
  }

  if (cmd === 'wajibpp') {
    if (setOnOff(mf, 'requirePhoto')) mf.enabled = true;
    await save();
    return done(`✅ Wajib foto profil: *${mf.requirePhoto ? 'ON ✅' : 'OFF ❌'}*`);
  }

  if (cmd === 'kode' || (cmd === 'setfilter' && /^prefix\s+\S/i.test(param))) {
    const val = cmd === 'kode' ? param : param.replace(/^prefix\s+/i, '');
    if (!val) return done('⚠️ Contoh: `.kode 62` (atau `.kode 62,60` / `.kode all`)');
    mf.allowedPrefixes = parsePrefixes(val);
    mf.enabled = true;
    await save();
    return done(`✅ Filter awalan nomor: *${mf.allowedPrefixes.join(', ') || 'Semua Negara'}*`);
  }

  if (cmd === 'setfilter') {
    const m = param.match(/^pp\s+(\S+)/i);
    if (!m) return done('⚠️ Gunakan `.kode 62` atau `.wajibpp on/off`');
    mf.requirePhoto = onOff(m[1]) === true;
    mf.enabled = true;
    await save();
    return done(`✅ Wajib foto profil: *${mf.requirePhoto ? 'AKTIF' : 'NONAKTIF'}*`);
  }

  if (['blacklistmember', 'unblacklistmember', 'bl', 'unbl'].includes(cmd)) {
    const isAdd = cmd === 'blacklistmember' || cmd === 'bl';
    const ctx = getContextInfo(unwrapped);
    const typed = normalizePhone(param);
    const num = typed || jidDigits(ctx?.mentionedJid?.[0] || ctx?.participant);
    if (!num) return done(`⚠️ Contoh: \`.${cmd} @nomor\` atau \`.${cmd} 628123456789\``);
    // 👑 VVIP: admin grup tidak bisa di-blacklist (hanya Owner)
    const blJid = typed ? `${typed}@s.whatsapp.net` : ctx?.mentionedJid?.[0] || ctx?.participant || '';
    if (isAdd && !isOwner && isJidGroupAdmin(meta, blJid)) return done(`👑 *VVIP ADMIN*\n+${num} adalah admin grup dan dilindungi — tidak bisa di-blacklist.`);
    mf.blacklist = isAdd ? [...new Set([...mf.blacklist, num])] : mf.blacklist.filter((n) => n !== num);
    await save();
    return done(`${isAdd ? '🚫 Ditambahkan ke' : '✅ Dihapus dari'} blacklist: *+${num}*`);
  }

  if (cmd === 'cekrequest') {
    const pending = await pendingRequests(sock, jid);
    if (!pending?.length) return done('📭 Tidak ada permintaan bergabung yang menunggu.');
    await sendMenu(sock, jid, {
      title: `📥 PERMINTAAN GABUNG (${pending.length})`,
      body: pending.map((p, i) => `${i + 1}. +${digitsOnly(phoneHintOf(p)) || jidDigits(jidOf(p))}`).join('\n'),
      footer: 'Ketik .acc @nomor untuk terima satu per satu',
      buttons: [{ text: '✅ Terima Semua', id: 'accsemua' }, { text: '❌ Tolak Semua', id: 'tolaksemua' }],
    }, msg);
    return true;
  }

  if (cmd === 'accsemua' || cmd === 'tolaksemua') {
    const targets = ((await pendingRequests(sock, jid)) || []).map(jidOf).filter(Boolean);
    if (!targets.length) return done('📭 Antrean permintaan kosong.');
    const approve = cmd === 'accsemua';
    await sock.groupRequestParticipantsUpdate(jid, targets, approve ? 'approve' : 'reject');
    return done(`${approve ? '✅ Berhasil menyetujui' : '❌ Berhasil menolak'} *${targets.length}* permintaan.`);
  }

  return true;
}
