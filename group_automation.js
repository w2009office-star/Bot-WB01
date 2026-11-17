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

export const GROUP_SECURITY_MENU =
  `*╭┈───〔 🛡️ MENU KEAMANAN GRUP 〕┈───⊷*\n` +
  `*│* _@nomor bisa tag atau ketik 628xxx_\n` +
  `*│* _👑 VVIP: admin grup kebal kick & demote_\n` +
  `*│* _📥 Link downloader (TikTok, YT, IG, dll) tidak dihapus anti-link_\n` +
  `*╰───────────────────────⊷*\n\n` +
  `*🔒 PROTEKSI CHAT*\n` +
  `• \`.antilink on/off\`\n` +
  `• \`.antivirtek on/off\`\n` +
  `• \`.antibug on/off\`\n` +
  `• \`.antitoxic on/off\`\n` +
  `• \`.antispam on/off\`\n\n` +
  `*🛡️ SELEKSI & ACC MEMBER*\n` +
  `• \`.autoacc on/off\`\n` +
  `• \`.acc @nomor\`\n` +
  `• \`.accsemua\`\n` +
  `• \`.tolaksemua\`\n` +
  `• \`.cekrequest\`\n` +
  `• \`.wajibpp on/off\`\n` +
  `• \`.kode 62\`\n` +
  `• \`.bl @nomor\`\n` +
  `• \`.unbl @nomor\`\n\n` +
  `*👮 MODERASI GRUP*\n` +
  `• \`.kick @nomor\`\n` +
  `• \`.add @nomor\`\n` +
  `• \`.promote @nomor\`\n` +
  `• \`.demote @nomor\`\n` +
  `• \`.del\`\n` +
  `• \`.mute\`\n` +
  `• \`.unmute\`\n` +
  `• \`.link\`\n` +
  `• \`.revoke\`\n` +
  `• \`.ginfo\``;

const VALID_DAYS = ['senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu', 'minggu', 'setiap_hari'];
const EN_TO_ID_DAY = { sunday: 'minggu', monday: 'senin', tuesday: 'selasa', wednesday: 'rabu', thursday: 'kamis', friday: 'jumat', saturday: 'sabtu' };
const GRACE_MINUTES = 2;
const SESSION_MS = 3 * 3600 * 1000;

const botSentMsgIds = new Set();
const groupChatHistory = new Map();
const groupInteractionCooldown = new Map();
const groupSpamTracker = new Map();
const processedJoinLock = new Set();
const joinErrorNoticeAt = new Map();
const pendingPollAt = new Map();

/* ───────────────────────── Helper umum ───────────────────────── */

const logErr = (where, e) => console.error(`[group_automation] ${where}:`, e?.message || e);
const digitsOnly = (v) => String(v ?? '').replace(/\D/g, '');
const jidDigits = (jid) => digitsOnly(String(jid ?? '').split('@')[0].split(':')[0]);
const jidOf = (p) => (typeof p === 'string' ? p : p?.id || p?.jid || '');
const phoneHintOf = (p) => (p && typeof p === 'object' ? p.phoneNumber || p.phone_number || p.pn || '' : '');
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bump = (obj, key) => { if (obj && typeof obj === 'object') obj[key] = (Number(obj[key]) || 0) + 1; };

function isBotJid(sock, jid) {
  const d = jidDigits(jid);
  if (!d) return false;
  return d === jidDigits(sock?.user?.id) || d === jidDigits(sock?.user?.lid);
}

function getContextInfo(unwrapped) {
  if (!unwrapped || typeof unwrapped !== 'object') return null;
  if (unwrapped.extendedTextMessage?.contextInfo) return unwrapped.extendedTextMessage.contextInfo;
  for (const v of Object.values(unwrapped)) {
    if (v && typeof v === 'object' && v.contextInfo) return v.contextInfo;
  }
  return null;
}

function normalizeTime(input) {
  const s = String(input ?? '').trim().toLowerCase().replace(/\s*wib$/, '').replace('.', ':');
  let m = s.match(/^(\d{1,2}):(\d{2})$/) || s.match(/^(\d{2})(\d{2})$/);
  if (!m) {
    const only = s.match(/^(\d{1,2})$/);
    if (only) m = [only[0], only[1], '00'];
  }
  if (!m) return '';
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return '';
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function normalizeDay(input) {
  const s = String(input ?? '').toLowerCase().replace(/[^a-z_]/g, '');
  if (!s) return 'setiap_hari';
  if (['setiaphari', 'setiap_hari', 'harian', 'everyday', 'daily', 'tiaphari', 'semuahari'].includes(s)) return 'setiap_hari';
  if (s === 'ahad') return 'minggu';
  if (s === 'jumaat') return 'jumat';
  return VALID_DAYS.includes(s) ? s : '';
}

function normalizePhone(v) {
  let d = digitsOnly(v);
  if (d.startsWith('0')) d = `62${d.slice(1)}`;
  return d;
}

const splitList = (str) => String(str ?? '').split(/[|;\n]/).map((s) => s.trim()).filter(Boolean);

function buildPoll(items) {
  if (!Array.isArray(items) || items.length < 3) return null;
  const options = [...new Set(items.slice(1).map((o) => o.slice(0, 100)))].slice(0, 12);
  if (options.length < 2) return null;
  return { name: items[0].slice(0, 250), values: options, selectableCount: 1 };
}

function getWibTimeAndDate() {
  const now = new Date();
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now).replace(/^24:/, '00:');
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(now);
  const weekdayEn = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jakarta', weekday: 'long' }).format(now).toLowerCase();
  return { time, date, day: EN_TO_ID_DAY[weekdayEn] || 'senin' };
}

function trackBotMessage(sentMsg) {
  const id = sentMsg?.key?.id;
  if (!id) return;
  botSentMsgIds.add(id);
  if (botSentMsgIds.size > 500) botSentMsgIds.delete(botSentMsgIds.values().next().value);
}

function pushGroupHistory(jid, senderName, text) {
  if (!groupChatHistory.has(jid)) groupChatHistory.set(jid, []);
  const hist = groupChatHistory.get(jid);
  hist.push({ sender: senderName || 'Member', text: String(text ?? '').slice(0, 350) });
  if (hist.length > 10) hist.shift();
}

async function sendMenu(sock, jid, payload, quoted) {
  try {
    await sendNativeInteractiveButtons(sock, jid, payload, quoted);
    return;
  } catch (e) {
    logErr('sendNativeInteractiveButtons', e);
  }
  const cmds = (payload.buttons || []).map((b) => `• \`${b.id}\` — ${b.text}`).join('\n');
  const text = [`*${payload.title}*`, payload.body, cmds && `*Ketik perintah:*\n${cmds}`, payload.footer && `_${payload.footer}_`].filter(Boolean).join('\n\n');
  await sock.sendMessage(jid, { text }, { quoted });
}

/* ───────────────────────── Konfigurasi grup ───────────────────────── */

export function ensureGroupAutoConfig(dbMemory, jid) {
  if (!dbMemory.groupSettings) dbMemory.groupSettings = {};
  if (!dbMemory.groupSettings[jid]) {
    dbMemory.groupSettings[jid] = { antilink: false, antivirtek: true, antibug: true, antitoxic: true, antispam: true, welcome: false };
  }
  const cfg = dbMemory.groupSettings[jid];
  cfg.antilink = Boolean(cfg.antilink);
  cfg.antivirtek = cfg.antivirtek ?? true;
  cfg.antibug = cfg.antibug ?? true;
  cfg.antitoxic = cfg.antitoxic ?? true;
  cfg.antispam = cfg.antispam ?? true;
  cfg.welcome = Boolean(cfg.welcome);
  cfg.goodbye = cfg.goodbye ?? cfg.welcome;
  cfg.welcomeText ||= '👋 Selamat datang @user di *@group*!\n\n📌 *Info Grup:*\n@desc\n\nTotal member sekarang: *@count* orang.';
  cfg.goodbyeText ||= '👋 Sampai jumpa @user, terima kasih sudah pernah bergabung di *@group*.';
  cfg.autoOpenTime ||= '';
  cfg.autoCloseTime ||= '';
  if (!Array.isArray(cfg.activities)) cfg.activities = [];
  cfg.activities = cfg.activities.filter((a) => a && typeof a === 'object');

  if (!cfg.memberFilter || typeof cfg.memberFilter !== 'object') cfg.memberFilter = {};
  const mf = cfg.memberFilter;
  mf.enabled = Boolean(mf.enabled);
  if (!Array.isArray(mf.allowedPrefixes)) mf.allowedPrefixes = ['62'];
  mf.requirePhoto = Boolean(mf.requirePhoto);
  if (!Array.isArray(mf.blacklist)) mf.blacklist = [];

  if (!['bebas', 'reply', 'off'].includes(cfg.interactiveMode)) cfg.interactiveMode = 'bebas';
  if (!cfg.interactiveSession || typeof cfg.interactiveSession !== 'object') {
    cfg.interactiveSession = { active: false, theme: '', lastPrompt: '', expiresAt: 0 };
  }
  if (!cfg.runLog || typeof cfg.runLog !== 'object') cfg.runLog = {};
  return cfg;
}

export async function isSenderGroupAdmin(sock, jid, senderParticipant, senderNum, altNum = '', isOwner = false, prefetchedMeta = null) {
  if (isOwner) return true;
  if (!jid?.endsWith('@g.us')) return false;
  try {
    const meta = prefetchedMeta || (await sock.groupMetadata(jid));
    const wanted = new Set([jidDigits(senderParticipant), digitsOnly(senderNum), digitsOnly(altNum)].filter(Boolean));
    const info = (meta?.participants || []).find((p) => {
      if (senderParticipant && p.id === senderParticipant) return true;
      return [p.id, p.phoneNumber, p.lid, p.jid].some((x) => {
        const d = jidDigits(x);
        return d && wanted.has(d);
      });
    });
    return info?.admin === 'admin' || info?.admin === 'superadmin';
  } catch (e) {
    logErr('isSenderGroupAdmin', e);
    return false;
  }
}

// 👑 VVIP: true jika JID (nomor / LID) adalah admin atau superadmin di metadata grup
export function isJidGroupAdmin(meta, jid) {
  const d = jidDigits(jid);
  if (!d) return false;
  const info = (meta?.participants || []).find((p) => p.id === jid || [p.id, p.phoneNumber, p.lid, p.jid].some((x) => jidDigits(x) === d));
  return info?.admin === 'admin' || info?.admin === 'superadmin';
}

/* ───────────────────────── Penjaga pesan (anti-*) ───────────────────────── */

function pruneSpamTracker(now) {
  for (const [key, hist] of groupSpamTracker) {
    if (!hist.length || now - hist[hist.length - 1] > 10000) groupSpamTracker.delete(key);
  }
}

// 📥 Link dari platform ini dianggap permintaan download (perintah bot / auto-download), bukan spam link
const DOWNLOAD_HOSTS = /^(?:[\w-]+\.)*(tiktok\.com|capcut\.com|youtube\.com|youtu\.be|instagram\.com|facebook\.com|fb\.watch|fb\.com|twitter\.com|x\.com|mediafire\.com|drive\.google\.com|github\.com|open\.spotify\.com)$/i;

// true = pesan berisi link, dan SEMUA link-nya berasal dari platform downloader
function isDownloadLinkMessage(text) {
  const urls = String(text).match(/(?:https?:\/\/|www\.)[^\s<>"]+/gi) || [];
  if (!urls.length) return false;
  return urls.every((u) => {
    try {
      return DOWNLOAD_HOSTS.test(new URL(/^https?:/i.test(u) ? u : `https://${u}`).hostname);
    } catch {
      return false;
    }
  });
}

function detectViolation({ text, lower, cfg, bot, dbMemory, jid, spamKey }) {
  if (cfg.antivirtek || cfg.antibug) {
    const combining = (text.match(/[\u0300-\u036f]/g) || []).length;
    const invisible = (text.match(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g) || []).length;
    if (text.length > 3500 || combining > 25 || invisible > 40) return 'virtek';
  }

  if (cfg.antispam) {
    const key = `${jid}:${spamKey}`;
    const now = Date.now();
    const hist = (groupSpamTracker.get(key) || []).filter((t) => now - t < 5000);
    hist.push(now);
    groupSpamTracker.set(key, hist);
    if (groupSpamTracker.size > 3000) pruneSpamTracker(now);
    if (hist.length > 6) return 'spam';
  }

  if (cfg.antitoxic) {
    const badWords = [...(bot?.badWords || []), ...(dbMemory.learnedWords || [])]
      .map((w) => String(w ?? '').toLowerCase().trim())
      .filter((w) => w.length >= 2);
    if (badWords.some((w) => lower.includes(w))) return 'toxic';
  }

  if (cfg.antilink) {
    // Link downloader (mis. `.tiktok https://vt.tiktok.com/...` atau link yang ditempel langsung)
    // dibiarkan agar bisa diproses bot. Link lain tetap dihapus.
    if (!isDownloadLinkMessage(text)) {
      const blocked = (bot?.blockedDomains || []).map((d) => String(d ?? '').toLowerCase().trim()).filter(Boolean);
      if (/(https?:\/\/|www\.|chat\.whatsapp\.com|wa\.me\/)/i.test(text) || blocked.some((d) => lower.includes(d))) return 'link';
    }
  }
  return null;
}

export async function handleGroupMessageGuard({ sock, jid, msg, rawText, textLower, senderParticipant, senderNum, isSenderAdmin, isOwner = false, bot, dbMemory }) {
  try {
    if (!jid?.endsWith('@g.us') || msg?.key?.fromMe || isOwner) return false;
    const text = typeof rawText === 'string' ? rawText : '';
    if (!text) return false;
    const lower = typeof textLower === 'string' ? textLower : text.toLowerCase();
    const cfg = ensureGroupAutoConfig(dbMemory, jid);

    const violation = detectViolation({ text, lower, cfg, bot, dbMemory, jid, spamKey: senderNum || jidDigits(senderParticipant) });
    if (!violation) return false;

    // 👑 VVIP: admin tidak pernah dihapus pesannya / di-kick oleh sistem anti-*
    if (isSenderAdmin === true || (await isSenderGroupAdmin(sock, jid, senderParticipant, senderNum))) return false;

    await sock.sendMessage(jid, { delete: msg.key }).catch((e) => logErr('hapus pesan (bot harus admin)', e));
    if (violation === 'virtek') {
      bump(bot?.stats, 'totalBlockedVirtek');
      await sock.groupParticipantsUpdate(jid, [senderParticipant], 'remove').catch((e) => logErr('kick pelaku virtek', e));
    } else if (violation === 'toxic') {
      bump(bot?.stats, 'totalDeletedBadWords');
    } else if (violation === 'link') {
      bump(bot?.stats, 'totalDeletedLinks');
    }
    return true;
  } catch (e) {
    logErr('handleGroupMessageGuard', e);
    return false;
  }
}

/* ───────────────────────── Tema & AI ───────────────────────── */

function resolveTodayTheme(cfg) {
  const sess = cfg.interactiveSession;
  if (sess?.active && sess.theme && (!sess.expiresAt || Date.now() < sess.expiresAt)) {
    return { theme: sess.theme, lastPrompt: sess.lastPrompt || '', isLiveSession: true };
  }
  const { day } = getWibTimeAndDate();
  const todayActs = (cfg.activities || []).filter((a) => ['setiap_hari', day].includes(normalizeDay(a.day)));
  if (todayActs.length) {
    return { theme: `${day.toUpperCase()} — ${String(todayActs[0].content || '').replace(/^ai:/i, '').trim()}`, lastPrompt: sess?.lastPrompt || '', isLiveSession: false };
  }
  return { theme: 'Diskusi Belajar & Sharing Komunitas', lastPrompt: '', isLiveSession: false };
}

const formatWelcomeTemplate = (tpl, { userTag, groupName, groupDesc, memberCount }) =>
  String(tpl).replace(/@(user|group|desc|count)\b/gi, (_, k) => {
    switch (k.toLowerCase()) {
      case 'user': return userTag;
      case 'group': return groupName;
      case 'desc': return groupDesc || 'Patuhi aturan grup & saling menghormati.';
      default: return String(memberCount);
    }
  });

async function askAIWithFallback(prompt, systemInstruction, { minLength = 12 } = {}) {
  const usable = (t) => typeof t === 'string' && t.trim().length >= minLength && !/<!doctype|<html/i.test(t);
  try {
    const primary = await panggilServerAISatSet(prompt, systemInstruction);
    if (usable(primary)) return primary.trim();
  } catch (e) {
    logErr('AI utama', e);
  }
  try {
    const combined = `${String(systemInstruction).slice(0, 900)}\n\n${String(prompt).slice(-1800)}`;
    const res = await fetchWithTimeout(`https://text.pollinations.ai/${encodeURIComponent(combined)}?model=openai`, { headers: { 'User-Agent': 'WHUXEN-BOT/1.0' } }, 15000);
    const txt = res?.ok ? await res.text() : '';
    if (usable(txt)) return txt.trim();
  } catch (e) {
    logErr('AI cadangan', e);
  }
  return null;
}

async function generateStudyMaterialAI(topic) {
  const aiText = await askAIWithFallback(
    `Buatkan materi pembuka diskusi grup WhatsApp tema "${topic}": 1) Penjelasan inti ringkas, 2) 2-3 contoh praktis, 3) 1 pertanyaan interaktif di akhir. Bahasa Indonesia santai-edukatif, gunakan *bintang tunggal* untuk bold.`,
    'Kamu adalah mentor sekaligus teman diskusi yang asyik di grup belajar WhatsApp.',
    { minLength: 30 },
  );
  return aiText || `📌 *Topik Hari Ini:* ${topic}\n\n• Yuk kita bedah bareng materi *${topic}*!\n• Tulis jawaban atau pertanyaanmu di bawah pesan ini.\n\n💬 *Tantangan Awal:* Sebutkan 1 hal yang ingin kamu bahas tentang *${topic}*!`;
}

/* ───────────────────────── Join request & welcome ───────────────────────── */

export async function evaluateAndProcessJoinRequest(sock, dbMemory, jid, participant, phoneHint = '') {
  const filter = ensureGroupAutoConfig(dbMemory, jid).memberFilter;
  if (!filter.enabled) return { handled: false };

  const pJid = jidOf(participant);
  if (!pJid) return { handled: false };
  const idDigits = jidDigits(pJid);
  const phoneDigits = pJid.endsWith('@lid') ? digitsOnly(phoneHint || phoneHintOf(participant)) : idDigits;

  const lockKey = `${jid}:${idDigits}`;
  if (processedJoinLock.has(lockKey)) return { handled: false };
  processedJoinLock.add(lockKey);
  setTimeout(() => processedJoinLock.delete(lockKey), 30000);

  let rejectReason = '';
  if ([idDigits, phoneDigits].filter(Boolean).some((n) => filter.blacklist.includes(n))) {
    rejectReason = 'Nomor terdaftar di blacklist grup';
  } else if (filter.allowedPrefixes.length && phoneDigits && !filter.allowedPrefixes.some((p) => phoneDigits.startsWith(p))) {
    rejectReason = `Hanya nomor berawalan ${filter.allowedPrefixes.join('/')} yang diizinkan`;
  } else if (filter.requirePhoto && !(await sock.profilePictureUrl(pJid, 'image').catch(() => null))) {
    rejectReason = 'Wajib memasang foto profil publik sebelum bergabung';
  }

  const action = rejectReason ? 'reject' : 'approve';
  try {
    await sock.groupRequestParticipantsUpdate(jid, [pJid], action);
  } catch (e) {
    logErr(`join request ${action}`, e);
    if (Date.now() - (joinErrorNoticeAt.get(jid) || 0) > 30 * 60 * 1000) {
      joinErrorNoticeAt.set(jid, Date.now());
      await sock.sendMessage(jid, { text: '⚠️ Filter member otomatis gagal memproses permintaan gabung. Pastikan bot adalah *Admin Grup*.' }).catch(() => {});
    }
    return { handled: true, approved: false, error: true };
  }

  const shown = phoneDigits ? `+${phoneDigits}` : `ID:${idDigits}`;
  const text = rejectReason
    ? `🛡️ *FILTER MEMBER OTOMATIS*\n• Nomor: ${shown}\n• Keputusan: ❌ *DITOLAK*\n• Alasan: ${rejectReason}`
    : `🛡️ *FILTER MEMBER OTOMATIS*\n• Nomor: ${shown}\n• Keputusan: ✅ *DISETUJUI OTOMATIS*`;
  await sock.sendMessage(jid, { text }).catch(() => {});
  return { handled: true, approved: !rejectReason };
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
    if (action !== 'add' && action !== 'remove') return;

    const cfg = ensureGroupAutoConfig(dbMemory, jid);
    if ((action === 'add' && !cfg.welcome) || (action === 'remove' && !cfg.goodbye)) return;

    const meta = await sock.groupMetadata(jid).catch(() => null);
    const info = { groupName: meta?.subject || 'Grup Ini', groupDesc: meta?.desc || '', memberCount: meta?.participants?.length || 0 };

    for (const p of participants) {
      const pJid = jidOf(p);
      if (!pJid || isBotJid(sock, pJid)) continue;
      const userTag = `@${jidDigits(pJid)}`;
      if (action === 'add') {
        const text = formatWelcomeTemplate(cfg.welcomeText, { userTag, ...info });
        const ppUrl = await sock.profilePictureUrl(pJid, 'image').catch(() => null);
        const sent = await sock.sendMessage(jid, ppUrl ? { image: { url: ppUrl }, caption: text, mentions: [pJid] } : { text, mentions: [pJid] }).catch(async () => (
          sock.sendMessage(jid, { text, mentions: [pJid] }).catch(() => null)
        ));
        trackBotMessage(sent);
      } else {
        const sent = await sock.sendMessage(jid, { text: formatWelcomeTemplate(cfg.goodbyeText, { userTag, ...info }), mentions: [pJid] }).catch(() => null);
        trackBotMessage(sent);
      }
    }
  } catch (e) {
    logErr('handleGroupParticipantsUpdate', e);
  }
}

/* ───────────────────────── Kegiatan terjadwal ───────────────────────── */

async function executeGroupActivity(sock, jid, activity, dbMemory = null, saveMemory = null) {
  const type = String(activity.type || 'jadwal').toLowerCase();
  const content = String(activity.content || '');
  const dayName = (normalizeDay(activity.day) || 'setiap_hari').toUpperCase();
  const dayLabel = dayName !== 'SETIAP_HARI' ? ` (${dayName})` : '';
  const timeLabel = normalizeTime(activity.time) || activity.time || '';
  const cleanTopic = content.replace(/^ai:/i, '').trim();
  let sentMain = null;
  let promptSummary = cleanTopic;
  let opensSession = false;

  if (type === 'poll' || type === 'polling') {
    const poll = buildPoll(splitList(content));
    if (poll) {
      poll.name = `📊 ${poll.name}`;
      sentMain = await sock.sendMessage(jid, { poll });
      promptSummary = poll.name;
    } else {
      sentMain = await sock.sendMessage(jid, { text: `⚠️ Kegiatan poll *${timeLabel} WIB* tidak valid. Isi harus: Pertanyaan ; Opsi 1 ; Opsi 2 (pemisah ; atau |).` });
    }
  } else if (type === 'materi') {
    opensSession = true;
    if (/absensi/i.test(cleanTopic)) {
      const pollMsg = await sock.sendMessage(jid, { poll: { name: `📋 ABSENSI MEMBER${dayLabel} (${timeLabel} WIB)`, values: ['✅ Hadir & Siap Belajar', '⏳ Menyusul', '🙏 Izin'], selectableCount: 1 } });
      trackBotMessage(pollMsg);
      const motivText = await generateStudyMaterialAI('Motivasi belajar singkat & sapaan hangat untuk member yang absen');
      sentMain = await sock.sendMessage(jid, { text: `🔥 *MOTIVASI & SAPAAN${dayLabel}*\n\n${motivText}\n\n_Ceritain target belajarmu minggu ini di bawah ya!_` });
      promptSummary = motivText;
    } else if (/tanya jawab|interaksi member|free time/i.test(cleanTopic)) {
      const sesiText = await generateStudyMaterialAI(`${cleanTopic} — buat 3 pertanyaan kuis ringan dan pemantik obrolan seru untuk member grup`);
      sentMain = await sock.sendMessage(jid, { text: `💬 *SESI INTERAKTIF${dayLabel}*\n🕒 Pukul: ${timeLabel} WIB\n\n${sesiText}\n\n_Langsung balas pesan ini atau sebut namaku untuk ngobrol bareng!_` });
      promptSummary = sesiText;
    } else {
      const materiText = /^ai:/i.test(content) ? await generateStudyMaterialAI(cleanTopic) : cleanTopic;
      sentMain = await sock.sendMessage(jid, { text: `📚 *MATERI & DISKUSI TEMA*${dayLabel}\n🕒 Pukul: ${timeLabel} WIB\n\n${materiText}\n\n_💬 Jawab pertanyaan di atas atau tanya langsung di chat, aku siap bantu bahas bareng!_` });
      promptSummary = materiText;
    }
  } else {
    sentMain = await sock.sendMessage(jid, { text: `🗓️ *PENGINGAT JADWAL GRUP*${dayLabel}\n⏰ Pukul ${timeLabel} WIB\n\n${content}` });
  }

  trackBotMessage(sentMain);
  pushGroupHistory(jid, 'BOT', String(promptSummary).slice(0, 300));

  if (opensSession && dbMemory) {
    const cfg = ensureGroupAutoConfig(dbMemory, jid);
    cfg.interactiveSession = { active: true, theme: `${dayName !== 'SETIAP_HARI' ? `${dayName} - ` : ''}${cleanTopic}`, lastPrompt: String(promptSummary).slice(0, 500), expiresAt: Date.now() + SESSION_MS };
    if (typeof saveMemory === 'function') await saveMemory();
  }
}

/* ───────────────────────── Interaksi tema (AI) ───────────────────────── */

export async function handleGroupThemeInteraction({ sock, jid, senderParticipant, pushName, rawText, unwrapped, msg, dbMemory, bot }) {
  try {
    if (!jid?.endsWith('@g.us') || typeof rawText !== 'string' || rawText.trim().length < 2) return false;
    if (msg?.key?.fromMe) return false;
    const cfg = ensureGroupAutoConfig(dbMemory, jid);
    const senderName = pushName || 'Member';
    pushGroupHistory(jid, senderName, rawText);
    if (cfg.interactiveMode === 'off') return false;

    const ctxInfo = getContextInfo(unwrapped);
    const isReply = Boolean((ctxInfo?.stanzaId && botSentMsgIds.has(ctxInfo.stanzaId)) || isBotJid(sock, ctxInfo?.participant));
    const botFirst = escapeRegex(String(bot?.userName || 'whuxen').toLowerCase().split(/\s+/)[0]);
    const nameHit = new RegExp(`(^|[^a-z0-9])(${botFirst}|bot|tutor|min|kak bot)([^a-z0-9]|$)`, 'i').test(rawText);
    const isMention = Boolean((ctxInfo?.mentionedJid || []).some((m) => isBotJid(sock, m)) || nameHit);

    const { theme, lastPrompt, isLiveSession } = resolveTodayTheme(cfg);
    if ((cfg.interactiveMode === 'reply' && !isReply && !isMention) || (!isReply && !isMention && !isLiveSession)) return false;
    if (Date.now() - (groupInteractionCooldown.get(jid) || 0) < 4000) return false;
    groupInteractionCooldown.set(jid, Date.now());

    const recentChat = (groupChatHistory.get(jid) || []).map((m) => `${m.sender}: ${m.text}`).join('\n');
    const systemPrompt = `Kamu adalah ${bot?.userName || 'WHUXEN BOT'}, fasilitator aktif di grup belajar WhatsApp. Tema: "${theme}". ${lastPrompt ? `Konteks terakhir: "${lastPrompt.slice(0, 350)}"` : ''} Tanggapi secara akrab & ringkas (maksimal 3-5 kalimat). Jika obrolan tidak nyambung & bukan untukmu, balas tepat: SKIP`;

    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
    const reply = await askAIWithFallback(`Riwayat:\n${recentChat}\n\nPesan terbaru dari ${senderName}: "${rawText}"`, systemPrompt, { minLength: 2 });
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
    if (!reply || /^\W*skip\W*$/i.test(reply)) return false;

    const sent = await sock.sendMessage(jid, { text: reply.slice(0, 1500) }, { quoted: msg });
    trackBotMessage(sent);
    pushGroupHistory(jid, 'BOT', reply);
    return true;
  } catch (e) {
    logErr('handleGroupThemeInteraction', e);
    return false;
  }
}

/* ───────────────────────── Scheduler ───────────────────────── */

const schedulerCtx = { sock: null, dbMemory: null, saveMemory: null };
let schedulerStarted = false;
let tickRunning = false;

const minutesOfDay = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

function isDue(timeStr, nowStr) {
  const t = normalizeTime(timeStr);
  if (!t) return false;
  const diff = minutesOfDay(nowStr) - minutesOfDay(t);
  return diff >= 0 && diff <= GRACE_MINUTES;
}

function activityKey(act) {
  const raw = `${normalizeDay(act.day)}|${normalizeTime(act.time)}|${act.type}|${act.content}`;
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) | 0;
  return `act:${(h >>> 0).toString(36)}`;
}

async function schedulerTick() {
  if (tickRunning) return;
  const { sock, dbMemory, saveMemory } = schedulerCtx;
  if (!sock || !dbMemory) return;
  tickRunning = true;
  try {
    const { time: nowWib, date: todayWib, day: todayDay } = getWibTimeAndDate();
    let dirty = false;

    for (const jid of Object.keys(dbMemory.groupSettings || {})) {
      if (!jid.endsWith('@g.us')) continue;
      try {
        const cfg = ensureGroupAutoConfig(dbMemory, jid);

        const jobs = [
          { key: 'open', time: cfg.autoOpenTime, mode: 'not_announcement', ok: `🔓 *GRUP DIBUKA OTOMATIS* (${nowWib} WIB)\nSemua anggota sekarang dapat mengirim pesan kembali.`, err: `⚠️ Gagal membuka grup otomatis (${nowWib} WIB). Pastikan bot adalah *Admin Grup*.` },
          { key: 'close', time: cfg.autoCloseTime, mode: 'announcement', ok: `🔒 *GRUP DITUTUP OTOMATIS* (${nowWib} WIB)\nSementara hanya admin yang dapat mengirim pesan hingga jadwal buka berikutnya.`, err: `⚠️ Gagal menutup grup otomatis (${nowWib} WIB). Pastikan bot adalah *Admin Grup*.` },
        ];
        for (const job of jobs) {
          const stamp = `${todayWib} ${normalizeTime(job.time)}`;
          if (!job.time || !isDue(job.time, nowWib) || cfg.runLog[job.key] === stamp) continue;
          cfg.runLog[job.key] = stamp;
          dirty = true;
          try {
            await sock.groupSettingUpdate(jid, job.mode);
            await sock.sendMessage(jid, { text: job.ok });
          } catch (e) {
            logErr(`auto ${job.key} grup`, e);
            await sock.sendMessage(jid, { text: job.err }).catch(() => {});
          }
        }

        if (cfg.memberFilter.enabled && Date.now() - (pendingPollAt.get(jid) || 0) >= 60000) {
          pendingPollAt.set(jid, Date.now());
          const pending = await sock.groupRequestParticipantsList(jid).catch(() => []);
          for (const item of pending || []) {
            const target = jidOf(item);
            if (target) await evaluateAndProcessJoinRequest(sock, dbMemory, jid, target, phoneHintOf(item));
          }
        }

        const liveKeys = new Set(['open', 'close']);
        for (const act of cfg.activities) {
          const key = activityKey(act);
          liveKeys.add(key);
          const actDay = normalizeDay(act.day);
          const stamp = `${todayWib} ${normalizeTime(act.time)}`;
          if (!(actDay === 'setiap_hari' || actDay === todayDay) || !isDue(act.time, nowWib) || cfg.runLog[key] === stamp) continue;
          cfg.runLog[key] = stamp;
          dirty = true;
          await executeGroupActivity(sock, jid, act, dbMemory, saveMemory).catch((e) => logErr(`kegiatan ${act.time}`, e));
        }
        for (const k of Object.keys(cfg.runLog)) if (!liveKeys.has(k)) delete cfg.runLog[k];
      } catch (e) {
        logErr(`scheduler grup ${jid}`, e);
      }
    }

    if (dirty && typeof saveMemory === 'function') {
      try { await saveMemory(); } catch (e) { logErr('saveMemory scheduler', e); }
    }
  } catch (e) {
    logErr('schedulerTick', e);
  } finally {
    tickRunning = false;
  }
}

export function startGroupAutomationScheduler(sock, dbMemory, saveMemory = null) {
  schedulerCtx.sock = sock;
  schedulerCtx.dbMemory = dbMemory;
  schedulerCtx.saveMemory = saveMemory;
  if (schedulerStarted) return;
  schedulerStarted = true;
  setInterval(() => { schedulerTick().catch((e) => logErr('scheduler', e)); }, 15 * 1000);
}

/* ───────────────────────── Perintah grup ───────────────────────── */

function parseScheduleFromDesc(desc) {
  const out = [];
  const lines = String(desc ?? '').replace(/[’'`*_~]/g, '').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^[^a-zA-Z]*(senin|selasa|rabu|kamis|jumat|jumaat|sabtu|minggu|ahad)\b/i);
    if (!m) continue;
    const rest = line.slice(m[0].length);
    const timeMatch = rest.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
    const topic = rest
      .replace(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(wib)?/gi, '')
      .replace(/^[\s:()\-–—,.]+/, '')
      .trim();
    if (topic.length < 2) continue;
    out.push({ day: normalizeDay(m[1]), time: timeMatch ? normalizeTime(`${timeMatch[1]}:${timeMatch[2]}`) : '', topic });
  }
  return out;
}

function resolveTarget(unwrapped, param) {
  const ctx = getContextInfo(unwrapped);
  if (ctx?.mentionedJid?.[0]) return ctx.mentionedJid[0];
  const num = normalizePhone(param);
  if (num.length >= 8) return `${num}@s.whatsapp.net`;
  return ctx?.participant || '';
}

const onOff = (p) => {
  const v = String(p || '').toLowerCase();
  if (['on', 'aktif', 'nyala', 'hidup', '1'].includes(v)) return true;
  if (['off', 'mati', 'nonaktif', 'matikan', '0'].includes(v)) return false;
  return null;
};

export async function handleGroupCommand(ctx) {
  const cmd = String(ctx?.cmd || '').toLowerCase();
  if (!ALL_GROUP_COMMANDS.includes(cmd)) return false;
  try {
    return await runGroupCommand({ ...ctx, cmd });
  } catch (e) {
    logErr(`perintah ${cmd}`, e);
    await ctx.sock.sendMessage(ctx.jid, {
      text: `❌ Perintah *${cmd}* gagal dijalankan.\n• Pastikan bot sudah jadi *Admin Grup*, target valid, dan koneksi WhatsApp stabil.\n• Detail: ${String(e?.message || e).slice(0, 120)}`,
    }, { quoted: ctx.msg }).catch(() => {});
    return true;
  }
}

async function runGroupCommand({ sock, jid, isGroup, senderParticipant, senderNum, isOwner, isSenderAdmin, cmd, param: rawParam, unwrapped, msg, dbMemory, saveMemory }) {
  const param = typeof rawParam === 'string' ? rawParam.trim() : '';
  const reply = (text, extra = {}) => sock.sendMessage(jid, { text, ...extra }, { quoted: msg });
  const save = async () => { if (typeof saveMemory === 'function') await saveMemory(); };

  if (['keamanangrup', 'securitymenu'].includes(cmd)) {
    await reply(GROUP_SECURITY_MENU);
    return true;
  }

  if (!(isGroup === true || jid?.endsWith('@g.us'))) {
    await reply('⚠️ Perintah grup hanya bisa digunakan di dalam grup.');
    return true;
  }

  const meta = await sock.groupMetadata(jid).catch(() => null);
  const members = (meta?.participants || []).map((p) => p.id);
  const cfg = ensureGroupAutoConfig(dbMemory, jid);
  const adminStatus = Boolean(isOwner) || isSenderAdmin === true
    || (await isSenderGroupAdmin(sock, jid, senderParticipant, senderNum, '', Boolean(isOwner), meta));

  /* ── Perintah terbuka untuk semua anggota ── */

  if (['ginfo', 'groupsettings', 'gsettings'].includes(cmd)) {
    await sendMenu(sock, jid, {
      title: '🛡️ KEAMANAN & PENGATURAN GRUP',
      body: `📌 *Grup:* ${meta?.subject || 'Grup'}\n• Anti-Link: *${cfg.antilink ? 'ON' : 'OFF'}* | Anti-Virtek: *${cfg.antivirtek ? 'ON' : 'OFF'}*\n• Anti-Toxic: *${cfg.antitoxic ? 'ON' : 'OFF'}* | Anti-Spam: *${cfg.antispam ? 'ON' : 'OFF'}*\n• Welcome: *${cfg.welcome ? 'ON' : 'OFF'}* | Auto ACC: *${cfg.memberFilter.enabled ? 'ON' : 'OFF'}*\n• Wajib PP: *${cfg.memberFilter.requirePhoto ? 'ON' : 'OFF'}* | Kode: *${cfg.memberFilter.allowedPrefixes.join(', ') || 'Semua'}*\n• 👑 VVIP Admin: *AKTIF* (kebal kick & demote)`,
      buttons: [
        { text: '🛡️ Menu Keamanan', id: 'keamanangrup' },
        { text: '🔗 Toggle Anti-Link', id: 'antilink' },
        { text: '⚙️ Panel Otomatisasi', id: 'panelgrup' },
      ],
    }, msg);
    return true;
  }

  if (cmd === 'poll') {
    const poll = buildPoll(splitList(param));
    if (!poll) await reply('⚠️ Contoh: `poll Pertanyaan | Opsi 1 | Opsi 2` (minimal 2 opsi, maksimal 12)');
    else await sock.sendMessage(jid, { poll });
    return true;
  }

  if (!adminStatus) {
    await reply('⛔ Perintah ini khusus Admin Grup atau Owner.');
    return true;
  }

  /* ── Toggle keamanan & welcome ── */

  const toggles = {
    antilink: ['antilink', '🔗 Anti-Link'],
    antivirtek: ['antivirtek', '☣️ Anti-Virtek'],
    antibug: ['antibug', '🐞 Anti-Bug'],
    antitoxic: ['antitoxic', '🤬 Anti-Toxic'],
    antispam: ['antispam', '⚡ Anti-Spam'],
    welcome: ['welcome', '👋 Welcome Masuk'],
    goodbye: ['goodbye', '🚪 Goodbye Keluar'],
  };
  if (toggles[cmd]) {
    const [key, label] = toggles[cmd];
    const explicit = onOff(param);
    cfg[key] = explicit === null ? !cfg[key] : explicit;
    await save();
    await reply(`${label}: *${cfg[key] ? 'ON ✅' : 'OFF ❌'}*`);
    return true;
  }

  /* ── Manajemen grup ── */

  if (cmd === 'tagall' || cmd === 'everyone') {
    if (!members.length) { await reply('⚠️ Gagal mengambil daftar anggota grup.'); return true; }
    const header = param ? `📢 *${param}*\n\n` : '';
    await sock.sendMessage(jid, { text: header + members.map((p) => `@${jidDigits(p)}`).join(' '), mentions: members });
    return true;
  }
  if (cmd === 'hidetag') {
    if (!members.length) { await reply('⚠️ Gagal mengambil daftar anggota grup.'); return true; }
    await sock.sendMessage(jid, { text: param || '📢 Info', mentions: members });
    return true;
  }
  if (cmd === 'link') { await reply(`https://chat.whatsapp.com/${await sock.groupInviteCode(jid)}`); return true; }
  if (cmd === 'revoke') { await sock.groupRevokeInvite(jid); await reply('✅ Link undangan grup berhasil direset.'); return true; }
  if (cmd === 'mute') { await sock.groupSettingUpdate(jid, 'announcement'); await reply('🔒 Grup ditutup untuk anggota biasa.'); return true; }
  if (cmd === 'unmute') { await sock.groupSettingUpdate(jid, 'not_announcement'); await reply('🔓 Grup dibuka untuk semua anggota.'); return true; }
  if (cmd === 'updategname') {
    if (!param) { await reply('⚠️ Contoh: `updategname Nama Grup Baru`'); return true; }
    await sock.groupUpdateSubject(jid, param.slice(0, 100));
    await reply(`✅ Nama grup diubah menjadi *${param.slice(0, 100)}*.`);
    return true;
  }
  if (cmd === 'updategdesc') {
    if (!param) { await reply('⚠️ Contoh: `updategdesc Deskripsi grup baru`'); return true; }
    await sock.groupUpdateDescription(jid, param);
    await reply('✅ Deskripsi grup diperbarui.');
    return true;
  }
  if (cmd === 'leave') { await sock.sendMessage(jid, { text: '👋 Bot keluar dari grup.' }); await sock.groupLeave(jid); return true; }

  if (cmd === 'delete' || cmd === 'del') {
    const q = getContextInfo(unwrapped);
    if (!q?.stanzaId) { await reply('⚠️ Balas (reply) pesan yang ingin dihapus dengan `.del`'); return true; }
    const fromBot = botSentMsgIds.has(q.stanzaId) || isBotJid(sock, q.participant);
    await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: fromBot, id: q.stanzaId, ...(fromBot ? {} : { participant: q.participant }) } });
    return true;
  }

  if (['kick', 'add', 'promote', 'demote'].includes(cmd)) {
    const target = resolveTarget(unwrapped, param);
    if (!target) {
      await reply(`⚠️ Tag, balas pesan, atau ketik nomor anggota untuk perintah \`.${cmd} @nomor\`.`);
      return true;
    }
    if (isBotJid(sock, target)) { await reply('⚠️ Target tidak boleh nomor bot sendiri.'); return true; }

    // 👑 VVIP: admin grup tidak bisa di-kick / di-demote lewat bot (hanya Owner bot yang boleh)
    if ((cmd === 'kick' || cmd === 'demote') && !isOwner) {
      if (!meta) { await reply('⚠️ Gagal memverifikasi status admin target. Coba lagi sebentar.'); return true; }
      if (isJidGroupAdmin(meta, target)) {
        await reply(`👑 *VVIP ADMIN*\n@${jidDigits(target)} adalah admin grup dan dilindungi — tidak bisa di-${cmd}.`, { mentions: [target] });
        return true;
      }
    }

    const apiAction = { kick: 'remove', add: 'add', promote: 'promote', demote: 'demote' }[cmd];
    const res = await sock.groupParticipantsUpdate(jid, [target], apiAction);
    const status = String((Array.isArray(res) && res[0]?.status) || '200');
    const who = `@${jidDigits(target)}`;
    if (status === '200') {
      await reply(`✅ Perintah *${cmd.toUpperCase()}* berhasil dijalankan untuk ${who}.`, { mentions: [target] });
    } else {
      const hints = {
        403: 'ditolak WhatsApp (target admin/pembuat grup, atau privasi akun target membatasi undangan)',
        404: 'nomor tidak ditemukan di WhatsApp',
        409: 'target sudah berada di grup',
      };
      await reply(`❌ Perintah *${cmd.toUpperCase()}* gagal untuk ${who} (kode ${status}): ${hints[status] || 'pastikan bot adalah Admin Grup'}.`, { mentions: [target] });
    }
    return true;
  }

  /* ── Interaksi AI ── */

  if (cmd === 'interaksi') {
    const mode = param.toLowerCase();
    if (!['bebas', 'reply', 'off'].includes(mode)) {
      const cur = resolveTodayTheme(cfg);
      await reply(`💬 *INTERAKSI BOT*\n• Mode: *${cfg.interactiveMode.toUpperCase()}* | Tema: *${cur.theme}*\n• \`interaksi bebas\` / \`reply\` / \`off\` | \`settema <judul>\``);
      return true;
    }
    cfg.interactiveMode = mode;
    await save();
    await reply(`✅ Mode interaksi bot: *${mode.toUpperCase()}*`);
    return true;
  }

  if (cmd === 'settema') {
    if (!param) { await reply('⚠️ Contoh: `settema Bahasa Jepang N5 - Percakapan`'); return true; }
    if (cfg.interactiveMode === 'off') cfg.interactiveMode = 'bebas';
    cfg.interactiveSession = { active: true, theme: param, lastPrompt: `Sesi diskusi manual dengan tema: ${param}`, expiresAt: Date.now() + SESSION_MS };
    await save();
    const opener = await askAIWithFallback(`Sapa member grup WhatsApp dengan ramah dan buka sesi diskusi bertema "${param}". Ajukan 1 pertanyaan pembuka.`, 'Kamu adalah moderator seru di grup WhatsApp.');
    const sent = await reply(`🎯 *SESI DISKUSI TEMA AKTIF (3 JAM)*\n📌 Tema: *${param}*\n\n${opener || `Halo semuanya! Yuk diskusi bareng seputar *${param}*.`}`);
    trackBotMessage(sent);
    return true;
  }

  if (cmd === 'tutupinteraksi') {
    cfg.interactiveSession = { active: false, theme: '', lastPrompt: '', expiresAt: 0 };
    await save();
    await reply('🛑 Sesi diskusi tema aktif telah ditutup.');
    return true;
  }

  /* ── Panel ── */

  if (cmd === 'panelgrup') {
    const cur = resolveTodayTheme(cfg);
    await sendMenu(sock, jid, {
      title: '⚙️ PANEL OTOMATISASI & KEAMANAN GRUP',
      body: `📌 *Grup:* ${meta?.subject || 'Grup'}\n• *Keamanan:* Link(${cfg.antilink ? 'ON' : 'OFF'}) | Virtek(${cfg.antivirtek ? 'ON' : 'OFF'}) | Toxic(${cfg.antitoxic ? 'ON' : 'OFF'}) | Spam(${cfg.antispam ? 'ON' : 'OFF'})\n• *👑 VVIP Admin:* AKTIF\n• *Mode Interaksi:* ${cfg.interactiveMode.toUpperCase()} (${cur.isLiveSession ? 'Sesi Live 🟢' : 'Standby'})\n• *Welcome / Goodbye:* ${cfg.welcome ? 'ON' : 'OFF'} / ${cfg.goodbye ? 'ON' : 'OFF'}\n• *Auto Buka / Tutup:* ${cfg.autoOpenTime || '-'} / ${cfg.autoCloseTime || '-'}\n• *Auto ACC Member:* ${cfg.memberFilter.enabled ? 'ON ✅' : 'OFF ❌'}\n• *Kegiatan Terjadwal:* ${cfg.activities.length} jadwal`,
      footer: 'Ketik .keamanangrup untuk daftar perintah keamanan',
      buttons: [
        { text: '🛡️ Menu Keamanan', id: 'keamanangrup' },
        { text: '🚀 Tes Semua Kegiatan', id: 'tessemuakegiatan' },
        { text: '👋 Toggle Welcome', id: 'welcome' },
      ],
    }, msg);
    return true;
  }

  /* ── Welcome / goodbye ── */

  if (cmd === 'setwelcome' || cmd === 'setgoodbye') {
    const isWel = cmd === 'setwelcome';
    if (!param) { await reply(`⚠️ Contoh: \`${cmd} Halo @user di @group!\`\nVariabel: @user @group @desc @count`); return true; }
    cfg[isWel ? 'welcomeText' : 'goodbyeText'] = param;
    cfg[isWel ? 'welcome' : 'goodbye'] = true;
    await save();
    await reply(`✅ Teks ${isWel ? 'Welcome' : 'Goodbye'} disimpan & diaktifkan.`);
    return true;
  }

  /* ── Buka / tutup otomatis ── */

  if (cmd === 'autobuka' || cmd === 'autotutup') {
    const isOpen = cmd === 'autobuka';
    const field = isOpen ? 'autoOpenTime' : 'autoCloseTime';
    if (!param) { await reply(`⚠️ Contoh: \`${cmd} ${isOpen ? '06:00' : '22:00'}\` atau \`${cmd} off\``); return true; }
    if (onOff(param) === false) {
      cfg[field] = '';
      await save();
      await reply(`✅ Jadwal ${isOpen ? 'buka' : 'tutup'} grup otomatis dimatikan.`);
      return true;
    }
    const cleanTime = normalizeTime(param);
    if (!cleanTime) { await reply('❌ Format jam harus `HH:mm` (24 jam), contoh: `06:30`'); return true; }
    cfg[field] = cleanTime;
    await save();
    await reply(`${isOpen ? '🔓' : '🔒'} Grup diatur *${isOpen ? 'BUKA' : 'TUTUP'} OTOMATIS* setiap pukul *${cleanTime} WIB*.\n_Bot harus menjadi Admin Grup agar jadwal ini berjalan._`);
    return true;
  }

  /* ── Kegiatan terjadwal ── */

  if (cmd === 'syncjadwal') {
    const targetTime = normalizeTime(param) || '19:00';
    const found = parseScheduleFromDesc(meta?.desc);
    if (!found.length) {
      await reply('⚠️ Tidak ditemukan format jadwal `HARI : TOPIK` di deskripsi grup.\nContoh baris: `Senin : Python Dasar` atau `Selasa 20.00 : Desain Web`');
      return true;
    }
    cfg.activities = cfg.activities.filter((a) => a.source !== 'syncjadwal');
    for (const item of found) {
      cfg.activities.push({ day: item.day, time: item.time || targetTime, type: 'materi', content: `ai:${item.topic}`, source: 'syncjadwal' });
    }
    await save();
    await reply(`✅ *${found.length} JADWAL MATERI AI AKTIF!*\n\n${found.map((f) => `• *${f.day.toUpperCase()}* (${f.time || targetTime} WIB) → ${f.topic}`).join('\n')}`);
    return true;
  }

  if (cmd === 'tambahkegiatan') {
    const segs = param.split('|').map((s) => s.trim());
    if (segs.length < 3 || !segs[2]) {
      await reply('⚠️ Format: `tambahkegiatan [hari] <HH:mm> | <materi/poll/jadwal> | <isi>`\nContoh: `tambahkegiatan senin 19:00 | materi | ai:Python Dasar`\nPoll: `tambahkegiatan 20:00 | poll | Pertanyaan ; Opsi 1 ; Opsi 2`');
      return true;
    }
    const tokens = segs[0].toLowerCase().replace(/\bwib\b/g, '').trim().split(/\s+/).filter(Boolean);
    const time = normalizeTime(tokens.pop() || '');
    const day = normalizeDay(tokens.join(''));
    const type = segs[1].toLowerCase();
    const content = segs.slice(2).join(' | ');
    if (!time || !['materi', 'poll', 'polling', 'jadwal'].includes(type)) {
      await reply('❌ Jam harus `HH:mm` dan jenis harus `materi`, `poll`, atau `jadwal`.');
      return true;
    }
    if (!day) { await reply(`❌ Hari tidak dikenal. Pilih: ${VALID_DAYS.join(', ')}`); return true; }
    if ((type === 'poll' || type === 'polling') && !buildPoll(splitList(content))) {
      await reply('❌ Format poll: `Pertanyaan ; Opsi 1 ; Opsi 2` (minimal 2 opsi).');
      return true;
    }
    cfg.activities.push({ day, time, type: type === 'polling' ? 'poll' : type, content });
    await save();
    await reply(`✅ Kegiatan ditambahkan: *${day.toUpperCase()} ${time} WIB* (${(type === 'polling' ? 'poll' : type).toUpperCase()})`);
    return true;
  }

  if (cmd === 'listkegiatan') {
    await reply(cfg.activities.length
      ? `🗓️ *KEGIATAN GRUP*\n\n${cfg.activities.map((a, i) => `*${i + 1}.* [${(normalizeDay(a.day) || 'setiap_hari').toUpperCase()} • ${normalizeTime(a.time) || a.time} WIB] *(${String(a.type || 'jadwal').toUpperCase()})*\n    ${String(a.content || '').slice(0, 80)}`).join('\n\n')}`
      : '📭 Belum ada jadwal kegiatan.');
    return true;
  }

  if (cmd === 'hapuskegiatan') {
    if (param.toLowerCase() === 'semua') {
      cfg.activities = [];
      await save();
      await reply('🗑️ Semua jadwal kegiatan dihapus.');
      return true;
    }
    const idx = parseInt(param, 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= cfg.activities.length) { await reply('⚠️ Masukkan nomor kegiatan yang valid (lihat `listkegiatan`) atau `hapuskegiatan semua`.'); return true; }
    const removed = cfg.activities.splice(idx, 1)[0];
    await save();
    await reply(`🗑️ Kegiatan *[${removed.time} WIB]* dihapus.`);
    return true;
  }

  if (['teskegiatan', 'tessemuakegiatan', 'testsemuakegiatan'].includes(cmd)) {
    if (!cfg.activities.length) { await reply('📭 Belum ada jadwal kegiatan.'); return true; }
    const runAll = cmd !== 'teskegiatan' || ['semua', 'all'].includes(param.toLowerCase());
    if (runAll) {
      await reply(`🚀 *Menjalankan tes ${cfg.activities.length} kegiatan...*`);
      let failed = 0;
      for (let i = 0; i < cfg.activities.length; i++) {
        await executeGroupActivity(sock, jid, cfg.activities[i], dbMemory, saveMemory).catch((e) => { failed++; logErr(`tes kegiatan ${i + 1}`, e); });
        if (i < cfg.activities.length - 1) await new Promise((r) => setTimeout(r, 3500));
      }
      await reply(failed ? `⚠️ Tes selesai, *${failed}* kegiatan gagal dikirim (cek log).` : '✅ *Semua kegiatan berhasil dites!*');
      return true;
    }
    const idx = parseInt(param, 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= cfg.activities.length) { await reply('⚠️ Contoh: `teskegiatan 1` atau `teskegiatan semua`'); return true; }
    await executeGroupActivity(sock, jid, cfg.activities[idx], dbMemory, saveMemory);
    return true;
  }

  /* ── Filter & ACC member ── */

  if (cmd === 'autoapprove' || cmd === 'autoacc') {
    const explicit = onOff(param);
    cfg.memberFilter.enabled = explicit === null ? !cfg.memberFilter.enabled : explicit;
    await save();
    await reply(`🛡️ *Auto ACC Member:* ${cfg.memberFilter.enabled ? 'ON ✅' : 'OFF ❌'}\n• Kode: *${cfg.memberFilter.allowedPrefixes.join(', ') || 'Semua'}* | Wajib PP: *${cfg.memberFilter.requirePhoto ? 'ON' : 'OFF'}*`);
    if (cfg.memberFilter.enabled) {
      const pending = await sock.groupRequestParticipantsList(jid).catch(() => []);
      for (const p of pending || []) {
        const target = jidOf(p);
        if (target) await evaluateAndProcessJoinRequest(sock, dbMemory, jid, target, phoneHintOf(p));
      }
    }
    return true;
  }

  if (cmd === 'acc') {
    const ctx = getContextInfo(unwrapped);
    const rawNum = normalizePhone(param) || jidDigits(ctx?.mentionedJid?.[0] || ctx?.participant);
    const pending = await sock.groupRequestParticipantsList(jid).catch(() => []);
    let targetJid = '';
    if (rawNum && Array.isArray(pending)) {
      const found = pending.find((p) => {
        const pId = jidOf(p);
        const pPhone = normalizePhone(phoneHintOf(p));
        return jidDigits(pId) === rawNum || pPhone === rawNum || jidDigits(pId) === digitsOnly(param);
      });
      if (found) targetJid = jidOf(found);
    }
    if (!targetJid) targetJid = resolveTarget(unwrapped, param);
    if (!targetJid) { await reply('⚠️ Contoh: `.acc @nomor` atau `.acc 628123456789`'); return true; }
    await sock.groupRequestParticipantsUpdate(jid, [targetJid], 'approve');
    await reply(`✅ Permintaan gabung *@${jidDigits(targetJid)}* disetujui.`, { mentions: [targetJid] });
    return true;
  }

  if (cmd === 'wajibpp') {
    const explicit = onOff(param);
    cfg.memberFilter.requirePhoto = explicit === null ? !cfg.memberFilter.requirePhoto : explicit;
    if (cfg.memberFilter.requirePhoto) cfg.memberFilter.enabled = true;
    await save();
    await reply(`✅ Wajib foto profil: *${cfg.memberFilter.requirePhoto ? 'ON ✅' : 'OFF ❌'}*`);
    return true;
  }

  if (cmd === 'kode') {
    if (!param) { await reply('⚠️ Contoh: `.kode 62` (atau `.kode 62,60` / `.kode all`)'); return true; }
    cfg.memberFilter.allowedPrefixes = param.toLowerCase() === 'all' ? [] : param.split(/[,\s]+/).map((p) => digitsOnly(p)).filter(Boolean);
    cfg.memberFilter.enabled = true;
    await save();
    await reply(`✅ Filter awalan nomor: *${cfg.memberFilter.allowedPrefixes.join(', ') || 'Semua Negara'}*`);
    return true;
  }

  if (cmd === 'setfilter') {
    const [subRaw, ...rest] = param.split(/\s+/);
    const sub = (subRaw || '').toLowerCase();
    const val = rest.join(',').trim();
    if (sub === 'prefix' && val) {
      cfg.memberFilter.allowedPrefixes = val.toLowerCase() === 'all' ? [] : val.split(/[,\s]+/).map((p) => digitsOnly(p)).filter(Boolean);
      cfg.memberFilter.enabled = true;
      await save();
      await reply(`✅ Filter prefix: *${cfg.memberFilter.allowedPrefixes.join(', ') || 'Semua Negara'}*`);
    } else if (sub === 'pp' && val) {
      cfg.memberFilter.requirePhoto = onOff(val) === true;
      cfg.memberFilter.enabled = true;
      await save();
      await reply(`✅ Wajib foto profil: *${cfg.memberFilter.requirePhoto ? 'AKTIF' : 'NONAKTIF'}*`);
    } else {
      await reply('⚠️ Gunakan `.kode 62` atau `.wajibpp on/off`');
    }
    return true;
  }

  if (['blacklistmember', 'unblacklistmember', 'bl', 'unbl'].includes(cmd)) {
    const isAdd = cmd === 'blacklistmember' || cmd === 'bl';
    const ctx = getContextInfo(unwrapped);
    const num = normalizePhone(param) || jidDigits(ctx?.mentionedJid?.[0] || ctx?.participant);
    if (!num) { await reply(`⚠️ Contoh: \`.${cmd} @nomor\` atau \`.${cmd} 628123456789\``); return true; }
    // 👑 VVIP: admin grup tidak bisa di-blacklist (hanya Owner bot yang boleh)
    const blJid = normalizePhone(param) ? `${normalizePhone(param)}@s.whatsapp.net` : (ctx?.mentionedJid?.[0] || ctx?.participant || '');
    if (isAdd && !isOwner && isJidGroupAdmin(meta, blJid)) {
      await reply(`👑 *VVIP ADMIN*\n+${num} adalah admin grup dan dilindungi — tidak bisa di-blacklist.`);
      return true;
    }
    if (isAdd && !cfg.memberFilter.blacklist.includes(num)) cfg.memberFilter.blacklist.push(num);
    if (!isAdd) cfg.memberFilter.blacklist = cfg.memberFilter.blacklist.filter((n) => n !== num);
    await save();
    await reply(`${isAdd ? '🚫 Ditambahkan ke' : '✅ Dihapus dari'} blacklist: *+${num}*`);
    return true;
  }

  if (cmd === 'cekrequest') {
    const pending = await sock.groupRequestParticipantsList(jid).catch(() => []);
    if (!pending?.length) { await reply('📭 Tidak ada permintaan bergabung yang menunggu.'); return true; }
    const label = (p) => `+${digitsOnly(phoneHintOf(p)) || jidDigits(jidOf(p))}`;
    await sendMenu(sock, jid, {
      title: `📥 PERMINTAAN GABUNG (${pending.length})`,
      body: pending.map((p, i) => `${i + 1}. ${label(p)}`).join('\n'),
      footer: 'Ketik .acc @nomor untuk terima satu per satu',
      buttons: [{ text: '✅ Terima Semua', id: 'accsemua' }, { text: '❌ Tolak Semua', id: 'tolaksemua' }],
    }, msg);
    return true;
  }

  if (cmd === 'accsemua' || cmd === 'tolaksemua') {
    const pending = await sock.groupRequestParticipantsList(jid).catch(() => []);
    if (!pending?.length) { await reply('📭 Antrean permintaan kosong.'); return true; }
    const targets = pending.map((p) => jidOf(p)).filter(Boolean);
    const act = cmd === 'accsemua' ? 'approve' : 'reject';
    await sock.groupRequestParticipantsUpdate(jid, targets, act);
    await reply(`${act === 'approve' ? '✅ Berhasil menyetujui' : '❌ Berhasil menolak'} *${targets.length}* permintaan.`);
    return true;
  }

  return true;
}
