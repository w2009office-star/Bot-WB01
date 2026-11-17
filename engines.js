import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { downloadContentFromMessage } from '@whiskeysockets/baileys';

const execFileAsync = promisify(execFile);

/* ───────────────────────── Konfigurasi ─────────────────────────
 * Opsional (environment variable):
 *   YTDLP_BIN      → path yt-dlp (default: "yt-dlp")
 *   YTDLP_COOKIES  → path cookies.txt (membantu YouTube/IG yang minta login)
 *   COBALT_API     → URL instance cobalt v10 milik sendiri (mis. https://cobalt.domainmu.com)
 *   COBALT_KEY     → API key cobalt (jika instance memakainya)
 */
const YTDLP = process.env.YTDLP_BIN || 'yt-dlp';
const MAX_BYTES = 95 * 1024 * 1024;          // batas aman dokumen WhatsApp
const VIDEO_INLINE_MAX = 60 * 1024 * 1024;   // di atas ini video dikirim sebagai dokumen
const MAX_PARALLEL = 3;                      // unduhan bersamaan (agar bot tidak berat)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const lastPlaySession = new Map();   // jid → { url, title }
const lastSearch = new Map();        // jid → hasil .yts (untuk pilih angka)

export const DOWNLOAD_COMMANDS = [
  'tiktok', 'tt', 'ttmp3', 'ttslide', 'capcut',
  'ytmp4', 'ytmp3', 'ytdl', 'video', 'play', 'play2', 'song', 'spotify', 'yts',
  'igdl', 'fb', 'twitter', 'mediafire', 'gdrive', 'gitclone', 'tts',
  'downloadmenu', 'dlmenu',
];

export const DOWNLOAD_MENU =
  `*╭┈───〔 📥 MENU DOWNLOAD 〕┈───⊷*\n` +
  `*│* _Tempel link langsung di chat juga otomatis terunduh_\n` +
  `*│* _Reaksi ⏳ → ✅ menandakan proses selesai_\n` +
  `*╰───────────────────────⊷*\n\n` +
  `*🎵 MUSIK & YOUTUBE*\n` +
  `• \`.play <judul>\` — audio + kartu info\n` +
  `• \`.play2 <judul>\` — versi video\n` +
  `• \`.spotify <judul/link>\`\n` +
  `• \`.ytmp3 <link/judul/angka>\`\n` +
  `• \`.ytmp4 <link/judul> [360|480|720|1080]\`\n` +
  `• \`.yts <judul>\` — lalu \`.ytmp3 2\` untuk pilih hasil ke-2\n\n` +
  `*📱 SOSIAL MEDIA*\n` +
  `• \`.tiktok <link>\` (video & slide)\n` +
  `• \`.ttmp3 <link>\`\n` +
  `• \`.ttslide <link>\`\n` +
  `• \`.capcut <link>\`\n` +
  `• \`.igdl <link>\`\n` +
  `• \`.fb <link>\`\n` +
  `• \`.twitter <link>\`\n\n` +
  `*📁 FILE & SUARA*\n` +
  `• \`.mediafire <link>\`\n` +
  `• \`.gdrive <link>\`\n` +
  `• \`.gitclone <link repo>\`\n` +
  `• \`.tts [en|id|ja...] <teks>\``;

/* ───────────────────────── Network & URL Helper ───────────────────────── */

export async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const res = await fetchWithTimeout(url, options, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Unduh file lengkap dengan nama file & content-type asli (batas ukuran dijaga). */
export async function fetchFile(url, referer = '', { maxBytes = MAX_BYTES, rejectHtml = false } = {}) {
  const headers = { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) };
  const res = await fetchWithTimeout(url, { headers, redirect: 'follow' }, 30000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (rejectHtml && contentType.includes('text/html')) throw new Error('NOT_A_FILE');
  const len = Number(res.headers.get('content-length') || 0);
  if (len > maxBytes) throw new Error('FILE_TOO_BIG');
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error('FILE_TOO_BIG');
  const cd = res.headers.get('content-disposition') || '';
  let fileName = '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
  if (m) { try { fileName = decodeURIComponent(m[1]); } catch { fileName = m[1]; } }
  return { buffer, contentType, fileName };
}

export async function fetchBuffer(url, referer = '') {
  return (await fetchFile(url, referer)).buffer;
}

export function extractUrl(text = '') {
  const m = String(text).match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/i);
  return m ? m[0].replace(/[.,!?)]+$/, '') : '';
}

const safeName = (s = 'file', max = 80) =>
  String(s).replace(/[\\/:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || 'file';

const EXT_MIME = {
  mp4: 'video/mp4', mp3: 'audio/mpeg', m4a: 'audio/mp4', zip: 'application/zip', rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed', pdf: 'application/pdf', apk: 'application/vnd.android.package-archive',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', txt: 'text/plain',
};
const mimeFor = (name = '', fallback = 'application/octet-stream') =>
  EXT_MIME[path.extname(name).slice(1).toLowerCase()] ||
  (fallback && fallback !== 'application/octet-stream' ? fallback : 'application/octet-stream');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const absTikwm = (u = '') => (u && u.startsWith('/') ? `https://www.tikwm.com${u}` : u);

/** Jalankan beberapa engine bersamaan, ambil yang pertama berhasil, batalkan sisanya. */
async function raceFirst(tasks) {
  const ac = new AbortController();
  try {
    return await Promise.any(tasks.map(async (t) => {
      const r = await t(ac.signal);
      if (!r) throw new Error('empty');
      return r;
    }));
  } catch {
    return null;
  } finally {
    ac.abort();
  }
}

/* ───────────────────────── Antrian & Cache ───────────────────────── */

let active = 0;
const waiting = [];
async function withSlot(fn) {
  if (active >= MAX_PARALLEL) await new Promise((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}

const mediaCache = new Map(); // LRU kecil untuk hasil YouTube ≤ 20MB
function cacheGet(key) {
  const v = mediaCache.get(key);
  if (v) { mediaCache.delete(key); mediaCache.set(key, v); }
  return v;
}
function cacheSet(key, val) {
  if (!val?.buffer || val.buffer.length > 20 * 1024 * 1024) return;
  mediaCache.set(key, val);
  while (mediaCache.size > 15) mediaCache.delete(mediaCache.keys().next().value);
}

/* ───────────────────────── Engine: yt-dlp (lokal, paling stabil) ───────────────────────── */

let ytdlpOk;
async function hasYtdlp() {
  if (ytdlpOk === undefined) {
    try { await execFileAsync(YTDLP, ['--version'], { timeout: 8000 }); ytdlpOk = true; } catch { ytdlpOk = false; }
  }
  return ytdlpOk;
}

async function ytdlp(url, { audio = false, height = 720, maxMB = 90, maxDuration = 0, signal } = {}) {
  if (!(await hasYtdlp())) return null;
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const base = `ytdlp_${id}`;
  const args = [
    '--no-playlist', '--no-warnings', '--no-simulate', '--no-part',
    '--print', 'after_move:%(title)s',
    '--max-filesize', `${maxMB}M`,
    '--socket-timeout', '15', '--retries', '2', '--concurrent-fragments', '4',
    '-o', path.join(os.tmpdir(), `${base}.%(ext)s`),
  ];
  if (maxDuration) args.push('--match-filter', `duration<=?${maxDuration}`);
  if (process.env.YTDLP_COOKIES) args.push('--cookies', process.env.YTDLP_COOKIES);
  if (audio) {
    args.push('-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '128K');
  } else {
    args.push(
      '-f', `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]/b[height<=${height}][ext=mp4]/bv*[height<=${height}]+ba/b[height<=${height}]/b`,
      '--merge-output-format', 'mp4',
    );
  }
  args.push(url);

  try {
    const { stdout } = await execFileAsync(YTDLP, args, { timeout: 150000, maxBuffer: 10 * 1024 * 1024, signal });
    const title = stdout.trim().split('\n').filter(Boolean)[0] || 'Media';
    const files = (await fsPromises.readdir(os.tmpdir())).filter((f) => f.startsWith(`${base}.`));
    if (!files.length) return null;
    let best = null;
    for (const f of files) {
      const st = await fsPromises.stat(path.join(os.tmpdir(), f)).catch(() => null);
      if (st && (!best || st.size > best.size)) best = { f, size: st.size };
    }
    if (!best || best.size < 1024) return null;
    const buffer = await fsPromises.readFile(path.join(os.tmpdir(), best.f));
    return { buffer, title, ext: path.extname(best.f).slice(1) };
  } catch {
    return null;
  } finally {
    try {
      for (const f of await fsPromises.readdir(os.tmpdir())) {
        if (f.startsWith(`${base}.`)) await fsPromises.unlink(path.join(os.tmpdir(), f)).catch(() => {});
      }
    } catch {}
  }
}

/* ───────────────────────── Engine: API cadangan ───────────────────────── */

async function cobaltResolve(url, { audio = false, height = 720 } = {}) {
  const base = (process.env.COBALT_API || '').replace(/\/$/, '');
  if (!base) return null;
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (process.env.COBALT_KEY) headers.Authorization = `Api-Key ${process.env.COBALT_KEY}`;
  const r = await fetchJson(base + '/', {
    method: 'POST',
    headers,
    body: JSON.stringify({ url, downloadMode: audio ? 'audio' : 'auto', audioFormat: 'mp3', videoQuality: String(height) }),
  }, 20000);
  if (['tunnel', 'redirect'].includes(r?.status) && r.url) return { url: r.url, title: r.filename || '' };
  if (r?.status === 'picker' && Array.isArray(r.picker)) return { picker: r.picker };
  return null;
}

/* ───────────────────────── Downloader Engines ───────────────────────── */

export async function downloadTikTok(url) {
  // Engine 1: tikwm (ada retry saat kena rate limit)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const json = await fetchJson('https://www.tikwm.com/api/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': UA },
        body: new URLSearchParams({ url, hd: '1' }),
      }, 15000);
      const d = json?.data;
      if (!d) {
        if (/limit/i.test(json?.msg || '')) { await sleep(1300); continue; }
        break;
      }
      const musicUrl = absTikwm(d.music || d.music_info?.play || '');
      const author = d.author?.nickname || d.author?.unique_id || '';
      if (Array.isArray(d.images) && d.images.length) {
        return { type: 'image', title: d.title || 'TikTok Slide', author, images: d.images.map(absTikwm), musicUrl };
      }
      const videoUrl = absTikwm(d.hdplay || d.play || d.wmplay || '');
      if (videoUrl) return { type: 'video', title: d.title || 'TikTok Video', author, videoUrl, musicUrl };
      break;
    } catch {
      if (attempt === 0) await sleep(500);
    }
  }
  // Engine 2: yt-dlp
  const y = await ytdlp(url, { height: 720 });
  if (y?.buffer) return { type: 'video', title: y.title, author: '', videoBuffer: y.buffer, musicUrl: '' };
  return null;
}

export async function downloadCapCut(url) {
  try {
    const j = await fetchJson(`https://api.siputzx.my.id/api/d/capcut?url=${encodeURIComponent(url)}`, {}, 15000);
    const vUrl = j?.data?.videoUrl || j?.data?.url || j?.result?.url;
    if (vUrl) return { url: vUrl, title: j?.data?.title || j?.result?.title || 'CapCut Template' };
  } catch {}
  try {
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, 12000);
    const html = await res.text();
    const m = html.match(/"video_url":"(https:[^"]+)"/) || html.match(/property="og:video"\s+content="([^"]+)"/);
    if (m?.[1]) return { url: m[1].replace(/\\u002F/g, '/').replace(/&amp;/g, '&'), title: 'CapCut Video' };
  } catch {}
  const y = await ytdlp(url);
  if (y?.buffer) return { buffer: y.buffer, title: y.title || 'CapCut Video' };
  return null;
}

export async function searchYouTube(query) {
  try {
    const res = await fetchWithTimeout(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=id`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'id,en;q=0.8' },
    }, 15000);
    const html = await res.text();
    const match = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
    if (!match) return [];
    const data = JSON.parse(match[1]);
    const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
    const results = [];
    for (const sec of sections) {
      for (const item of sec.itemSectionRenderer?.contents || []) {
        const v = item.videoRenderer;
        if (!v?.videoId) continue;
        results.push({
          id: v.videoId,
          title: v.title?.runs?.[0]?.text || 'YouTube Video',
          duration: v.lengthText?.simpleText || 'LIVE',
          channel: v.ownerText?.runs?.[0]?.text || '',
          views: v.viewCountText?.simpleText || '',
          thumb: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
          url: `https://youtu.be/${v.videoId}`,
        });
        if (results.length >= 6) return results;
      }
    }
    return results;
  } catch {
    return [];
  }
}

const ytId = (u = '') => (u.match(/(?:youtu\.be\/|v=|shorts\/|embed\/)([\w-]{11})/) || [])[1] || u;

export async function downloadYouTube(url, audioOnly = false, { height = 720, maxDuration = 0 } = {}) {
  const key = `${ytId(url)}|${audioOnly ? 'a' : 'v' + height}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  // 1) yt-dlp lokal (paling stabil)
  const y = await ytdlp(url, { audio: audioOnly, height, maxDuration });
  if (y?.buffer) {
    const out = { buffer: y.buffer, title: y.title };
    cacheSet(key, out);
    return out;
  }

  // 2) API cadangan — dijalankan bersamaan, ambil tercepat
  const type = audioOnly ? 'ytmp3' : 'ytmp4';
  const out = await raceFirst([
    async () => {
      const r = await fetchJson(`https://api.siputzx.my.id/api/d/${type}?url=${encodeURIComponent(url)}`, {}, 20000);
      const dl = r?.data?.dl || r?.data?.url || r?.result?.url;
      if (!dl) return null;
      const f = await fetchFile(dl, '', { rejectHtml: true });
      return f.buffer.length > 1024 ? { buffer: f.buffer, title: r?.data?.title || r?.result?.title || 'YouTube Media' } : null;
    },
    async () => {
      const c = await cobaltResolve(url, { audio: audioOnly, height });
      if (!c?.url) return null;
      const f = await fetchFile(c.url, '', { rejectHtml: true });
      return f.buffer.length > 1024 ? { buffer: f.buffer, title: c.title || 'YouTube Media' } : null;
    },
  ]);
  if (out) cacheSet(key, out);
  return out;
}

const IMG_RX = /\.(jpg|jpeg|png|webp)(\?|$)/i;

/**
 * Mengembalikan { items:[{type,url?|buffer?,fileName?}], url, filename, isImage }
 * (url/filename/isImage = item pertama, agar kompatibel dengan kode lama)
 */
export async function downloadSocialMedia(url, platform = '') {
  const p = platform.toLowerCase();
  let items = null;

  if (p === 'gdrive') {
    const m = url.match(/\/d\/([\w-]+)/) || url.match(/[?&]id=([\w-]+)/);
    if (m?.[1]) {
      items = [{
        type: 'document',
        url: `https://drive.usercontent.google.com/download?id=${m[1]}&export=download&confirm=t`,
        fileName: `gdrive_${m[1]}`,
        rejectHtml: true,
      }];
    }
  } else if (p === 'mediafire') {
    items = await raceFirst([
      async () => {
        const j = await fetchJson(`https://api.siputzx.my.id/api/d/mediafire?url=${encodeURIComponent(url)}`, {}, 15000);
        const f = Array.isArray(j?.data) ? j.data[0] : (j?.data || j?.result);
        const dl = f?.downloadLink || f?.url || f?.link;
        return dl ? [{ type: 'document', url: dl, fileName: f?.fileName || f?.filename || f?.name }] : null;
      },
      async () => {
        const html = await (await fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, 15000)).text();
        const m = html.match(/href="((?:https?:)?\/\/download\d*\.mediafire\.com[^"]+)"/i);
        if (!m) return null;
        const link = m[1].startsWith('//') ? `https:${m[1]}` : m[1];
        return [{ type: 'document', url: link, fileName: decodeURIComponent(link.split('/').pop().split('?')[0]) }];
      },
    ]);
  } else {
    const apiMap = {
      igdl: 'instagram', fb: 'facebook', twitter: 'twitter',
    };
    const apiName = {
      igdl: 'igdl', fb: 'facebook', twitter: 'twitter',
    }[p];
    items = await raceFirst([
      async () => {
        if (!apiName) return null;
        const j = await fetchJson(`https://api.siputzx.my.id/api/d/${apiName}?url=${encodeURIComponent(url)}`, {}, 15000);
        const list = Array.isArray(j?.data) ? j.data : [j?.data || j?.result].filter(Boolean);
        const out = list
          .map((x) => {
            const u = typeof x === 'string' ? x : (x?.url || x?.hd || x?.sd || x?.downloadLink || '');
            return u ? { type: IMG_RX.test(u) ? 'image' : 'video', url: u } : null;
          })
          .filter(Boolean)
          .slice(0, 10);
        return out.length ? out : null;
      },
      async (signal) => {
        const y = await ytdlp(url, { height: 720, signal });
        return y?.buffer ? [{ type: 'video', buffer: y.buffer, title: y.title }] : null;
      },
      async () => {
        const c = await cobaltResolve(url);
        if (c?.url) return [{ type: IMG_RX.test(c.url) ? 'image' : 'video', url: c.url }];
        if (c?.picker) return c.picker.slice(0, 10).map((x) => ({ type: x.type === 'photo' ? 'image' : 'video', url: x.url }));
        return null;
      },
    ]);
    void apiMap;
  }

  if (!items?.length) return null;
  return { items, url: items[0].url, filename: items[0].fileName, isImage: items[0].type === 'image' };
}

/* ───────────────────────── Pengiriman Media ───────────────────────── */

async function react(sock, jid, msg, emoji) {
  try { await sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }); } catch {}
}

async function sendItem(sock, jid, item, msg, caption = '') {
  const q = { quoted: msg };
  let { buffer, type, fileName, mimetype } = item;

  if (!buffer && item.url) {
    const f = await fetchFile(item.url, item.referer || '', { rejectHtml: !!item.rejectHtml }).catch((e) => ({ err: e }));
    if (f?.buffer) {
      buffer = f.buffer;
      fileName = fileName || f.fileName;
      mimetype = mimetype || f.contentType;
    } else if (f?.err?.message === 'FILE_TOO_BIG' || type === 'document') {
      await sock.sendMessage(jid, { text: `📦 File terlalu besar untuk dikirim lewat WhatsApp.\n🔗 ${item.url}` }, q);
      return true;
    } else {
      // Fallback: biarkan WhatsApp mengambil langsung dari URL
      await sock.sendMessage(jid, { [type]: { url: item.url }, ...(caption && type !== 'audio' ? { caption } : {}) }, q);
      return true;
    }
  }
  if (!buffer) return false;

  if (type === 'video' && buffer.length > VIDEO_INLINE_MAX) {
    type = 'document';
    fileName = fileName || `${safeName(item.title || 'video')}.mp4`;
    mimetype = 'video/mp4';
  }

  switch (type) {
    case 'image':
      await sock.sendMessage(jid, { image: buffer, ...(caption ? { caption } : {}) }, q);
      break;
    case 'video':
      await sock.sendMessage(jid, { video: buffer, mimetype: 'video/mp4', ...(caption ? { caption } : {}) }, q);
      break;
    case 'audio':
      await sock.sendMessage(jid, { audio: buffer, mimetype: 'audio/mpeg', ptt: !!item.ptt, ...(fileName ? { fileName } : {}) }, q);
      break;
    default: {
      const name = safeName(fileName || 'file', 120);
      await sock.sendMessage(jid, { document: buffer, fileName: name, mimetype: mimeFor(name, mimetype), ...(caption ? { caption } : {}) }, q);
    }
  }
  return true;
}

async function sendItems(sock, jid, items, msg, caption = '') {
  // Unduh semua item bersamaan (cepat untuk slide/carousel), kirim berurutan
  await Promise.all(items.map(async (it) => {
    if (it.buffer || !it.url) return;
    const f = await fetchFile(it.url, it.referer || '', { rejectHtml: !!it.rejectHtml }).catch(() => null);
    if (f?.buffer) {
      it.buffer = f.buffer;
      it.fileName = it.fileName || f.fileName;
      it.mimetype = it.mimetype || f.contentType;
    }
  }));
  let sent = 0;
  for (let i = 0; i < items.length; i++) {
    const ok = await sendItem(sock, jid, items[i], msg, i === 0 ? caption : '').catch(() => false);
    if (ok) sent++;
  }
  return sent > 0;
}

/* ───────────────────────── Deteksi Platform ───────────────────────── */

function detectPlatform(url = '') {
  const u = url.toLowerCase();
  if (/(^|\/\/|\.)tiktok\.com/.test(u)) return 'tiktok';
  if (/(^|\/\/|\.)capcut\.com/.test(u)) return 'capcut';
  if (/(^|\/\/|\.)youtube\.com\/(watch|shorts|live)|(^|\/\/)youtu\.be\//.test(u) || /music\.youtube\.com\/watch/.test(u)) return 'youtube';
  if (/(^|\/\/|\.)instagram\.com\/(p|reel|reels|tv|stories)\//.test(u)) return 'igdl';
  if (/(^|\/\/|\.)facebook\.com|(^|\/\/)fb\.watch|(^|\/\/)fb\.com/.test(u)) return 'fb';
  if (/(^|\/\/|\.)(twitter|x)\.com\/[^/]+\/status\//.test(u)) return 'twitter';
  if (/(^|\/\/|\.)mediafire\.com/.test(u)) return 'mediafire';
  if (/(^|\/\/)drive\.google\.com|(^|\/\/)docs\.google\.com\/uc/.test(u)) return 'gdrive';
  return null;
}

/* ───────────────────────── Handler Terpadu ───────────────────────── */

async function runTikTok(sock, jid, url, msg, mode = 'auto') {
  const res = await downloadTikTok(url);
  if (!res) { await sock.sendMessage(jid, { text: '❌ Gagal mengunduh TikTok. Pastikan link publik & coba lagi.' }, { quoted: msg }); return false; }
  const cap = `🎬 *TikTok*${res.author ? ` — ${res.author}` : ''}\n${(res.title || '').slice(0, 300)}`;

  if (mode === 'audio') {
    if (!res.musicUrl) { await sock.sendMessage(jid, { text: '❌ Audio tidak tersedia untuk video ini.' }, { quoted: msg }); return false; }
    return sendItems(sock, jid, [{ type: 'audio', url: res.musicUrl, referer: 'https://www.tiktok.com/', fileName: `${safeName(res.title || 'tiktok')}.mp3` }], msg);
  }
  if (res.type === 'image') {
    const items = res.images.slice(0, 10).map((u) => ({ type: 'image', url: u, referer: 'https://www.tiktok.com/' }));
    return sendItems(sock, jid, items, msg, `🖼️ *TikTok Slide* (${items.length} foto)\n${(res.title || '').slice(0, 200)}`);
  }
  if (mode === 'slide') {
    await sock.sendMessage(jid, { text: 'ℹ️ Link ini video biasa, bukan slide. Pakai `.tiktok` untuk video.' }, { quoted: msg });
    return false;
  }
  const item = res.videoBuffer
    ? { type: 'video', buffer: res.videoBuffer, title: res.title }
    : { type: 'video', url: res.videoUrl, referer: 'https://www.tiktok.com/', title: res.title };
  return sendItems(sock, jid, [item], msg, cap);
}

async function runGeneric(sock, jid, platform, url, msg, { height = 480 } = {}) {
  if (platform === 'tiktok') return runTikTok(sock, jid, url, msg);

  if (platform === 'capcut') {
    const cc = await downloadCapCut(url);
    if (!cc) { await sock.sendMessage(jid, { text: '❌ Video CapCut tidak ditemukan atau privat.' }, { quoted: msg }); return false; }
    const item = cc.buffer ? { type: 'video', buffer: cc.buffer } : { type: 'video', url: cc.url, referer: 'https://www.capcut.com/' };
    return sendItems(sock, jid, [item], msg, `🎬 *${cc.title || 'CapCut'}*`);
  }

  if (platform === 'youtube') {
    const yt = await downloadYouTube(url, false, { height, maxDuration: 3600 });
    if (!yt?.buffer) { await sock.sendMessage(jid, { text: '❌ Gagal mengunduh video YouTube (mungkin terlalu panjang/besar atau dibatasi).' }, { quoted: msg }); return false; }
    return sendItems(sock, jid, [{ type: 'video', buffer: yt.buffer, title: yt.title }], msg, `🎬 *${yt.title || 'YouTube'}*`);
  }

  const res = await downloadSocialMedia(url, platform);
  if (!res?.items?.length) { await sock.sendMessage(jid, { text: '❌ Tautan gagal diunduh. Pastikan konten publik.' }, { quoted: msg }); return false; }
  return sendItems(sock, jid, res.items, msg, platform === 'mediafire' || platform === 'gdrive' ? '' : '✅ Berhasil diunduh');
}

export async function handleDirectUrlAutoDownload(sock, jid, url, msg) {
  const platform = detectPlatform(url);
  if (!platform) return false;
  return withSlot(async () => {
    await react(sock, jid, msg, '⏳');
    try {
      const ok = await runGeneric(sock, jid, platform, url, msg, { height: 480 });
      await react(sock, jid, msg, ok ? '✅' : '❌');
      return true; // sudah ditangani (walau gagal, pesan error sudah dikirim)
    } catch {
      await react(sock, jid, msg, '❌');
      return false;
    }
  });
}

/* ───────────────────────── Resolusi Target YouTube ───────────────────────── */

async function resolveYouTubeTarget(jid, param) {
  const text = (param || '').trim();
  let link = extractUrl(text);

  // Spotify → ambil judul via oEmbed lalu cari di YouTube
  if (link && /open\.spotify\.com/i.test(link)) {
    try {
      const j = await fetchJson(`https://open.spotify.com/oembed?url=${encodeURIComponent(link)}`, {}, 10000);
      if (j?.title) {
        const list = await searchYouTube(`${j.title} audio`);
        if (list[0]) return list[0];
      }
    } catch {}
    return null;
  }
  if (link) return { url: link, title: '' };

  // Angka → pilih dari hasil .yts terakhir
  if (/^[1-6]$/.test(text) && lastSearch.get(jid)?.[Number(text) - 1]) return lastSearch.get(jid)[Number(text) - 1];

  if (text) {
    const list = await searchYouTube(text);
    return list[0] || null;
  }
  const last = lastPlaySession.get(jid);
  return last ? { url: last.url, title: last.title } : null;
}

const HELP = (cmd, ex) => `⚠️ Contoh: \`.${cmd} ${ex}\``;

export async function handleDownloadCommand({ sock, jid, cmd, param = '', msg }) {
  if (!DOWNLOAD_COMMANDS.includes(cmd)) return false;
  param = String(param || '').trim();
  const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg });

  if (cmd === 'downloadmenu' || cmd === 'dlmenu') { await reply(DOWNLOAD_MENU); return true; }

  // Validasi cepat sebelum masuk antrian
  const needUrl = {
    tiktok: 'https://vt.tiktok.com/...', tt: 'https://vt.tiktok.com/...', ttmp3: 'https://vt.tiktok.com/...',
    ttslide: 'https://vt.tiktok.com/...', capcut: 'https://www.capcut.com/tv2/...',
    igdl: 'https://www.instagram.com/reel/...', fb: 'https://fb.watch/...', twitter: 'https://x.com/user/status/...',
    mediafire: 'https://www.mediafire.com/file/...', gdrive: 'https://drive.google.com/file/d/...',
  };
  if (needUrl[cmd] && !extractUrl(param)) { await reply(HELP(cmd, needUrl[cmd])); return true; }
  if (['play', 'play2', 'song', 'spotify', 'yts', 'tts'].includes(cmd) && !param) {
    await reply(HELP(cmd, cmd === 'tts' ? 'halo semuanya' : cmd === 'yts' ? 'lofi chill' : 'komang raim laode')); return true;
  }
  if (cmd === 'gitclone' && !/github\.com\/[^/\s]+\/[^/\s]+/i.test(param)) { await reply(HELP(cmd, 'https://github.com/user/repo')); return true; }

  return withSlot(async () => {
    await react(sock, jid, msg, '⏳');
    let ok = false;
    try {
      ok = await dispatch({ sock, jid, cmd, param, msg, reply });
    } catch (e) {
      const m = String(e?.message || '');
      await reply(m === 'FILE_TOO_BIG' ? '📦 File terlalu besar untuk WhatsApp (maks ±95MB).' : '❌ Terjadi kesalahan saat memproses. Coba lagi sebentar.');
    }
    await react(sock, jid, msg, ok ? '✅' : '❌');
    return true;
  });
}

async function dispatch({ sock, jid, cmd, param, msg, reply }) {
  /* TikTok */
  if (['tiktok', 'tt', 'ttmp3', 'ttslide'].includes(cmd)) {
    const mode = cmd === 'ttmp3' ? 'audio' : cmd === 'ttslide' ? 'slide' : 'auto';
    return runTikTok(sock, jid, extractUrl(param), msg, mode);
  }

  if (cmd === 'capcut') return runGeneric(sock, jid, 'capcut', extractUrl(param), msg);

  /* YouTube: ytmp3 / ytmp4 / ytdl / video */
  if (['ytmp4', 'ytmp3', 'ytdl', 'video'].includes(cmd)) {
    const hMatch = param.match(/\b(144|240|360|480|720|1080)p?\b\s*$/);
    const height = hMatch ? Number(hMatch[1]) : 720;
    const clean = hMatch ? param.slice(0, hMatch.index).trim() : param;
    const t = await resolveYouTubeTarget(jid, clean);
    if (!t?.url) { await reply(HELP(cmd, 'https://youtu.be/... atau judul lagu')); return false; }
    const isAud = cmd === 'ytmp3';
    const yt = await downloadYouTube(t.url, isAud, { height, maxDuration: 3600 });
    if (!yt?.buffer) { await reply('❌ Gagal mengunduh media YouTube (terlalu panjang/besar atau dibatasi). Coba resolusi lebih rendah, mis. `.ytmp4 <link> 360`.'); return false; }
    lastPlaySession.set(jid, { url: t.url, title: yt.title });
    const name = safeName(yt.title || t.title || 'media');
    return sendItems(sock, jid, [isAud
      ? { type: 'audio', buffer: yt.buffer, fileName: `${name}.mp3` }
      : { type: 'video', buffer: yt.buffer, title: name }], msg, `🎬 *${yt.title || t.title}*\n_${height}p_`);
  }

  /* Play / Spotify */
  if (['play', 'play2', 'song', 'spotify'].includes(cmd)) {
    const t = await resolveYouTubeTarget(jid, param);
    if (!t?.url) { await reply('❌ Lagu tidak ditemukan.'); return false; }
    const asVideo = cmd === 'play2';
    lastPlaySession.set(jid, { url: t.url, title: t.title || param });

    const card = `🎵 *${t.title || param}*\n` +
      (t.channel ? `👤 ${t.channel}\n` : '') +
      (t.duration ? `⏱️ ${t.duration}` : '') +
      (t.views ? `  •  👁️ ${t.views}` : '') +
      `\n⏳ _Mengirim ${asVideo ? 'video' : 'audio'}..._`;
    // Kartu info dikirim paralel dengan proses unduh agar terasa cepat
    const cardP = (t.thumb
      ? sock.sendMessage(jid, { image: { url: t.thumb }, caption: card }, { quoted: msg }).catch(() => reply(card))
      : reply(card)).catch(() => {});
    const dlP = downloadYouTube(t.url, !asVideo, { height: 480, maxDuration: 1800 });
    const [, yt] = await Promise.all([cardP, dlP]);

    if (!yt?.buffer) { await reply(`❌ Gagal mengambil ${asVideo ? 'video' : 'audio'} untuk *${t.title || param}* (durasi maks 30 menit).`); return false; }
    const name = safeName(yt.title || t.title || 'lagu');
    return sendItems(sock, jid, [asVideo
      ? { type: 'video', buffer: yt.buffer, title: name }
      : { type: 'audio', buffer: yt.buffer, fileName: `${name}.mp3` }], msg, asVideo ? `🎬 *${name}*` : '');
  }

  /* Pencarian YouTube */
  if (cmd === 'yts') {
    const list = await searchYouTube(param);
    if (!list.length) { await reply('❌ Tidak ditemukan.'); return false; }
    lastSearch.set(jid, list);
    await reply(
      list.map((v, i) => `*${i + 1}. ${v.title}*\n⏱️ ${v.duration}${v.channel ? ` • ${v.channel}` : ''}\n🔗 ${v.url}`).join('\n\n') +
      '\n\n_Balas dengan_ `.ytmp3 <angka>` _atau_ `.ytmp4 <angka>`',
    );
    return true;
  }

  /* Instagram / Facebook / Twitter / Mediafire / GDrive */
  if (['igdl', 'fb', 'twitter', 'mediafire', 'gdrive'].includes(cmd)) {
    return runGeneric(sock, jid, cmd, extractUrl(param), msg);
  }

  /* GitHub clone */
  if (cmd === 'gitclone') {
    const m = param.match(/github\.com\/([^/\s]+)\/([^/\s?#]+)(?:\/tree\/([^\s?#]+))?/i);
    const owner = m[1];
    const repo = m[2].replace(/\.git$/i, '');
    let branch = m[3];
    let sizeKb = 0;
    try {
      const info = await fetchJson(`https://api.github.com/repos/${owner}/${repo}`, { headers: { 'User-Agent': 'WHUXEN-BOT', Accept: 'application/vnd.github+json' } }, 10000);
      branch = branch || info.default_branch || 'HEAD';
      sizeKb = info.size || 0;
    } catch (e) {
      if (/404/.test(String(e?.message))) { await reply('❌ Repo tidak ditemukan atau privat.'); return false; }
      branch = branch || 'HEAD';
    }
    const zipUrl = `https://codeload.github.com/${owner}/${repo}/zip/${branch === 'HEAD' ? 'HEAD' : `refs/heads/${branch}`}`;
    if (sizeKb * 1024 > MAX_BYTES) { await reply(`📦 Repo terlalu besar untuk WhatsApp.\n🔗 ${zipUrl}`); return false; }
    return sendItems(sock, jid, [{ type: 'document', url: zipUrl, fileName: `${repo}-${branch}.zip`, mimetype: 'application/zip' }], msg, `📦 *${owner}/${repo}* (${branch})`);
  }

  /* Text-to-Speech: .tts [kode-bahasa] teks */
  if (cmd === 'tts') {
    let lang = 'id';
    let text = param;
    const lm = param.match(/^([a-z]{2}(?:-[A-Z]{2})?)\s+([\s\S]+)/);
    if (lm && ['id', 'en', 'ja', 'ko', 'ar', 'es', 'fr', 'de', 'hi', 'ru', 'pt', 'zh', 'zh-CN', 'th', 'tr', 'ms', 'jw', 'su'].includes(lm[1])) {
      lang = lm[1]; text = lm[2];
    }
    // Pecah per ≤180 karakter (batas Google TTS) lalu gabungkan
    const chunks = [];
    let cur = '';
    for (const w of text.replace(/\s+/g, ' ').trim().split(' ')) {
      if ((cur + ' ' + w).trim().length > 180) { if (cur) chunks.push(cur); cur = w.slice(0, 180); } else cur = (cur + ' ' + w).trim();
    }
    if (cur) chunks.push(cur);
    const parts = await Promise.all(chunks.slice(0, 8).map((c) =>
      fetchBuffer(`https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(c)}&tl=${lang}&client=tw-ob`).catch(() => null)));
    const good = parts.filter(Boolean);
    if (!good.length) { await reply('❌ Gagal membuat suara. Coba lagi.'); return false; }
    return sendItems(sock, jid, [{ type: 'audio', buffer: Buffer.concat(good), ptt: true }], msg);
  }

  return true;
}

/* ───────────────────────── Sticker, ViewOnce, AI & UI Helpers ───────────────────────── */

export async function mediaBufferToWebpSticker(buffer, isVideo = false) {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const inPath = path.join(os.tmpdir(), `in_${id}.${isVideo ? 'mp4' : 'png'}`);
  const outPath = path.join(os.tmpdir(), `out_${id}.webp`);
  try {
    await fsPromises.writeFile(inPath, buffer);
    const args = isVideo
      ? ['-y', '-i', inPath, '-t', '6', '-vf', 'fps=12,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000', '-loop', '0', '-an', '-vsync', '0', outPath]
      : ['-y', '-i', inPath, '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000', outPath];
    await execFileAsync('ffmpeg', args);
    return await fsPromises.readFile(outPath);
  } catch {
    return null;
  } finally {
    await fsPromises.unlink(inPath).catch(() => {});
    await fsPromises.unlink(outPath).catch(() => {});
  }
}

export async function createBratSticker(text, isVideo = false) {
  try {
    const endpoint = isVideo
      ? `https://api.siputzx.my.id/api/m/brat?text=${encodeURIComponent(text)}&isVideo=true`
      : `https://api.siputzx.my.id/api/m/brat?text=${encodeURIComponent(text)}`;
    const buf = await fetchBuffer(endpoint);
    return await mediaBufferToWebpSticker(buf, isVideo);
  } catch {
    return null;
  }
}

export async function urlOrTextToWebpSticker(input) {
  try {
    const url = extractUrl(input);
    const imgUrl = url || `https://dummyimage.com/512x512/ffffff/000000.png&text=${encodeURIComponent(input.slice(0, 60))}`;
    const buf = await fetchBuffer(imgUrl);
    return await mediaBufferToWebpSticker(buf, false);
  } catch {
    return null;
  }
}

export async function extractAndDownloadViewOnce(quotedMessage) {
  try {
    let m = quotedMessage || {};
    for (let i = 0; i < 4; i++) {
      const next = m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.viewOnceMessageV2Extension?.message || m.ephemeralMessage?.message;
      if (!next) break;
      m = next;
    }
    const type = m.imageMessage ? 'image' : m.videoMessage ? 'video' : m.audioMessage ? 'audio' : null;
    if (!type) return null;
    const media = m[`${type}Message`];
    const chunks = [];
    for await (const chunk of await downloadContentFromMessage(media, type)) chunks.push(chunk);
    return { type, buffer: Buffer.concat(chunks), caption: media.caption || '' };
  } catch {
    return null;
  }
}

export async function sendNativeInteractiveButtons(sock, jid, payload, quoted) {
  const { title = '', body = '', footer = '', buttons = [], sections = [], listTitle = 'Menu' } = payload || {};
  try {
    const nativeButtons = [];
    if (sections.length) {
      nativeButtons.push({
        name: 'single_select',
        buttonParamsJson: JSON.stringify({ title: listTitle, sections }),
      });
    }
    for (const b of buttons) {
      nativeButtons.push({
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({ display_text: b.text, id: b.id }),
      });
    }
    await sock.sendMessage(jid, {
      viewOnceMessage: {
        message: {
          interactiveMessage: {
            header: title ? { title, hasMediaAttachment: false } : undefined,
            body: { text: body },
            footer: footer ? { text: footer } : undefined,
            nativeFlowMessage: { buttons: nativeButtons },
          },
        },
      },
    }, { quoted });
  } catch {
    const btnLines = buttons.map((b) => `• \`.${b.id}\` — ${b.text}`).join('\n');
    const secLines = sections.flatMap((s) => s.rows || []).map((r) => `• \`.${r.id}\` — ${r.title}`).join('\n');
    const fallback = [title && `*${title}*`, body, secLines, btnLines, footer && `_${footer}_`].filter(Boolean).join('\n\n');
    await sock.sendMessage(jid, { text: fallback }, { quoted });
  }
}

export async function panggilServerAISatSet(prompt, systemInstruction = 'Jawab singkat dan akurat dalam Bahasa Indonesia.') {
  try {
    const full = `${systemInstruction}\n\nPertanyaan: ${prompt}`;
    const res = await fetchWithTimeout(`https://text.pollinations.ai/${encodeURIComponent(full)}?model=openai`, {
      headers: { 'User-Agent': 'WHUXEN-BOT/1.0' },
    }, 18000);
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return text && !/<!doctype|<html/i.test(text) ? text : null;
  } catch {
    return null;
  }
}

export async function getAnimeImageUrl(category = 'waifu') {
  try {
    const clean = category === 'kickanime' ? 'kick' : category;
    const res = await fetchJson(`https://api.waifu.pics/sfw/${encodeURIComponent(clean)}`, {}, 10000);
    return res?.url || null;
  } catch {
    return null;
  }
}
