import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { downloadContentFromMessage } from '@whiskeysockets/baileys';

const execFileAsync = promisify(execFile);

/* Opsional (env): YTDLP_BIN, YTDLP_COOKIES, YTDLP_PROXY, COBALT_API, COBALT_KEY */
const YTDLP = process.env.YTDLP_BIN || 'yt-dlp';
const MB = 1024 * 1024;
const MAX_BYTES = 1900 * MB;          // batas dokumen WhatsApp (±2GB)
const VIDEO_INLINE_MAX = 60 * MB;     // di atas ini video dikirim sebagai dokumen
const MAX_PARALLEL = 3;
const YT_TIMEOUT = 3 * 3600 * 1000;   // yt-dlp boleh berjalan hingga 3 jam (tanpa batas durasi video)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const lastPlaySession = new Map(); // jid → { url, title }
const lastSearch = new Map();      // jid → hasil .yts

export const DOWNLOAD_COMMANDS = [
  'tiktok', 'tt', 'ttmp3', 'ttslide', 'capcut',
  'ytmp4', 'ytmp3', 'ytdl', 'video', 'play', 'play2', 'song', 'spotify', 'yts',
  'igdl', 'fb', 'twitter', 'mediafire', 'gdrive', 'gitclone', 'tts',
  'downloadmenu', 'dlmenu',
];

/* ───────────────────────── Menu (satu sumber kebenaran) ───────────────────────── */

// Baris: [pemakaian, keterangan]. Kata pertama pemakaian HARUS ada di DOWNLOAD_COMMANDS.
const MENU_SECTIONS = [
  ['🎵 MUSIK & YOUTUBE', [
    ['play <judul>', 'audio + kartu info (alias .song)'],
    ['play2 <judul>', 'versi video'],
    ['spotify <judul/link>', 'cari & kirim audio'],
    ['ytmp3 <link/judul/angka>', 'audio MP3'],
    ['ytmp4 <link/judul/angka> [360|480|720|1080]', 'video (alias .ytdl, .video)'],
    ['yts <judul>', 'cari, lalu `.ytmp3 2` untuk hasil ke-2'],
  ]],
  ['📱 SOSIAL MEDIA', [
    ['tiktok <link>', 'video & slide (alias .tt)'],
    ['ttmp3 <link>', 'audio TikTok'],
    ['ttslide <link>', 'foto slide TikTok'],
    ['capcut <link>'],
    ['igdl <link>', 'Instagram'],
    ['fb <link>', 'Facebook'],
    ['twitter <link>', 'Twitter / X'],
  ]],
  ['📁 FILE & SUARA', [
    ['mediafire <link>'],
    ['gdrive <link>'],
    ['gitclone <link repo>', 'unduh repo GitHub (.zip)'],
    ['tts [en|id|ja...] <teks>', 'teks jadi suara'],
  ]],
];

// Validasi otomatis: setiap perintah di menu wajib terdaftar.
{
  const bad = MENU_SECTIONS.flatMap(([, rows]) => rows.map(([u]) => u.split(' ')[0])).filter((c) => !DOWNLOAD_COMMANDS.includes(c));
  if (bad.length) console.warn('[download] Menu memuat perintah yang tidak terdaftar:', bad.join(', '));
}

const sec = (title, rows) => `*${title}*\n${rows.map(([u, d]) => `• \`.${u}\`${d ? ` — ${d}` : ''}`).join('\n')}`;
export const DOWNLOAD_MENU = [
  '*╭┈───〔 📥 MENU DOWNLOAD 〕┈───⊷*\n' +
  '*│* Chat pribadi: tempel link langsung otomatis terunduh\n' +
  '*│* Grup: link WAJIB diawali perintah (mis. `.tiktok <link>`), link polos dihapus\n' +
  '*│* Reaksi ⏳ → ✅ menandakan proses selesai\n' +
  '*╰───────────────────────⊷*',
  ...MENU_SECTIONS.map(([title, rows]) => sec(title, rows)),
].join('\n\n');

/* ───────────────────────── Helper jaringan ───────────────────────── */

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

/** Unduh file lengkap dengan nama file & content-type asli. */
export async function fetchFile(url, referer = '', { maxBytes = MAX_BYTES, rejectHtml = false } = {}) {
  const headers = { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) };
  const res = await fetchWithTimeout(url, { headers, redirect: 'follow' }, 30000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (rejectHtml && contentType.includes('text/html')) throw new Error('NOT_A_FILE');
  if (Number(res.headers.get('content-length') || 0) > maxBytes) throw new Error('FILE_TOO_BIG');
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error('FILE_TOO_BIG');
  const cd = res.headers.get('content-disposition') || '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
  let fileName = '';
  if (m) { try { fileName = decodeURIComponent(m[1]); } catch { fileName = m[1]; } }
  return { buffer, contentType, fileName };
}

export const fetchBuffer = async (url, referer = '') => (await fetchFile(url, referer)).buffer;

export function extractUrl(text = '') {
  const m = String(text).match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/i);
  return m ? m[0].replace(/[.,!?)]+$/, '') : '';
}

const safeName = (s = 'file', max = 80) => String(s).replace(/[\\/:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || 'file';

const EXT_MIME = {
  mp4: 'video/mp4', mp3: 'audio/mpeg', m4a: 'audio/mp4', zip: 'application/zip', rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed', pdf: 'application/pdf', apk: 'application/vnd.android.package-archive',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', txt: 'text/plain',
};
const mimeFor = (name = '', fallback = '') => EXT_MIME[path.extname(name).slice(1).toLowerCase()] || fallback || 'application/octet-stream';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const absTikwm = (u = '') => (u.startsWith('/') ? `https://www.tikwm.com${u}` : u);
const say = (sock, jid, msg, text) => sock.sendMessage(jid, { text }, { quoted: msg });
const fail = async (sock, jid, msg, text) => { await say(sock, jid, msg, text); return false; };

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

/* ───────────────────────── Antrian & cache ───────────────────────── */

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
  if (!val?.buffer || val.buffer.length > 20 * MB) return;
  mediaCache.set(key, val);
  while (mediaCache.size > 15) mediaCache.delete(mediaCache.keys().next().value);
}

/* ───────────────────────── Engine: yt-dlp ───────────────────────── */

let ytdlpOk;
let ytdlpCheckedAt = 0;
let lastYtError = '';

async function hasYtdlp() {
  if (ytdlpOk === true) return true;
  if (ytdlpOk === false && Date.now() - ytdlpCheckedAt < 60000) return false; // cek ulang tiap 1 menit
  try {
    await execFileAsync(YTDLP, ['--version'], { timeout: 8000 });
    ytdlpOk = true;
  } catch {
    ytdlpOk = false;
    lastYtError = 'yt-dlp tidak terpasang / tidak ada di PATH';
    console.error('[yt-dlp]', lastYtError);
  }
  ytdlpCheckedAt = Date.now();
  return ytdlpOk;
}

/** Ubah pesan error yt-dlp menjadi alasan singkat yang bisa dimengerti. */
function ytErrorHint(raw = lastYtError) {
  const e = String(raw || '');
  if (!e) return '';
  if (/tidak terpasang/i.test(e)) return 'yt-dlp belum terpasang di server.';
  if (/sign in to confirm|not a bot|cookies|login required/i.test(e)) return 'YouTube meminta verifikasi login (bot check). Set `YTDLP_COOKIES` ke file cookies.txt atau pakai `YTDLP_PROXY`.';
  if (/age|confirm your age|inappropriate/i.test(e)) return 'Video dibatasi usia (butuh cookies akun).';
  if (/private|members-only|membership/i.test(e)) return 'Video privat / khusus member.';
  if (/unavailable|removed|not available|blocked|copyright|country/i.test(e)) return 'Video tidak tersedia / diblokir di wilayah server.';
  if (/ffmpeg|ffprobe/i.test(e)) return 'ffmpeg belum terpasang di server.';
  if (/requested format|n challenge|js runtime|deno|signature/i.test(e)) return 'yt-dlp sudah usang atau butuh JS runtime. Jalankan `yt-dlp -U` dan pasang `deno`.';
  if (/max-filesize|larger than/i.test(e)) return 'File melebihi batas ±1.9GB WhatsApp.';
  if (/timed out|timeout|connection|network/i.test(e)) return 'Koneksi ke YouTube timeout.';
  return '';
}
const ytFailText = (what = 'video YouTube') => {
  const hint = ytErrorHint();
  return `❌ Gagal mengunduh ${what}.${hint ? `\nℹ️ ${hint}` : '\nCoba lagi, atau pakai resolusi lebih rendah, mis. `.ytmp4 <link> 360`.'}`;
};

// Urutan klien YouTube yang dicoba (null = bawaan yt-dlp). Berhenti di yang pertama berhasil.
const YT_CLIENTS = [null, 'tv,web_safari', 'android_vr', 'ios', 'mweb'];
const isYouTubeUrl = (u = '') => /(^|\/\/|\.)(youtube\.com|youtu\.be)/i.test(u);

async function ytdlpOnce(url, { audio, height, signal }, client) {
  const base = `ytdlp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const tmp = (f = '') => path.join(os.tmpdir(), f);
  const mine = async () => (await fsPromises.readdir(os.tmpdir())).filter((f) => f.startsWith(`${base}.`));
  const h = `height<=${height}`;
  const args = [
    '--no-playlist', '--no-warnings', '--no-simulate', '--no-part', '--no-mtime',
    '--print', 'after_move:%(title)s',
    '--max-filesize', `${Math.floor(MAX_BYTES / MB)}M`,
    '--socket-timeout', '15', '--retries', '3', '--concurrent-fragments', '4',
    '-o', tmp(`${base}.%(ext)s`),
    ...(process.env.YTDLP_COOKIES ? ['--cookies', process.env.YTDLP_COOKIES] : []),
    ...(process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : []),
    ...(client ? ['--extractor-args', `youtube:player_client=${client}`] : []),
    ...(audio
      ? ['-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '128K']
      : ['-f', `bv*[${h}][ext=mp4]+ba[ext=m4a]/b[${h}][ext=mp4]/bv*[${h}]+ba/b[${h}]/bv*+ba/b`, '--merge-output-format', 'mp4']),
    url,
  ];
  try {
    const { stdout, stderr } = await execFileAsync(YTDLP, args, { timeout: YT_TIMEOUT, maxBuffer: 10 * MB, signal });
    let best = null;
    for (const f of await mine()) {
      const st = await fsPromises.stat(tmp(f)).catch(() => null);
      if (st && (!best || st.size > best.size)) best = { f, size: st.size };
    }
    if (!best || best.size < 1024) {
      lastYtError = String(stderr || '').trim().split('\n').pop() || 'Tidak ada file yang dihasilkan';
      return null;
    }
    return {
      buffer: await fsPromises.readFile(tmp(best.f)),
      title: stdout.trim().split('\n').filter(Boolean)[0] || 'Media',
      ext: path.extname(best.f).slice(1),
    };
  } catch (e) {
    const err = String(e?.stderr || e?.message || '').trim().split('\n').filter(Boolean).slice(-2).join(' | ');
    lastYtError = err || 'yt-dlp gagal';
    console.error(`[yt-dlp${client ? `:${client}` : ''}]`, lastYtError.slice(0, 300));
    return null;
  } finally {
    for (const f of await mine().catch(() => [])) await fsPromises.unlink(tmp(f)).catch(() => {});
  }
}

async function ytdlp(url, { audio = false, height = 720, signal } = {}) {
  if (!(await hasYtdlp())) return null;
  const clients = isYouTubeUrl(url) ? YT_CLIENTS : [null];
  for (const client of clients) {
    if (signal?.aborted) return null;
    const r = await ytdlpOnce(url, { audio, height, signal }, client);
    if (r) return r;
    // Kesalahan permanen → tidak perlu coba klien lain
    if (/private|unavailable|removed|max-filesize|larger than|ffmpeg|tidak terpasang/i.test(lastYtError)) break;
  }
  return null;
}

/** Pencarian cadangan lewat yt-dlp (kalau scraping HTML YouTube gagal / kena consent page). */
async function searchViaYtdlp(query) {
  if (!(await hasYtdlp())) return [];
  try {
    const { stdout } = await execFileAsync(YTDLP, [
      '--no-warnings', '--flat-playlist', '-J',
      ...(process.env.YTDLP_COOKIES ? ['--cookies', process.env.YTDLP_COOKIES] : []),
      ...(process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : []),
      `ytsearch6:${query}`,
    ], { timeout: 30000, maxBuffer: 10 * MB });
    return (JSON.parse(stdout)?.entries || [])
      .filter((e) => e?.id)
      .slice(0, 6)
      .map((e) => ({
        id: e.id,
        title: e.title || 'YouTube Video',
        duration: fmtDuration(e.duration),
        channel: e.channel || e.uploader || '',
        views: e.view_count ? `${Number(e.view_count).toLocaleString('id-ID')} x ditonton` : '',
        thumb: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
        url: `https://youtu.be/${e.id}`,
      }));
  } catch {
    return [];
  }
}

function fmtDuration(sec) {
  if (!sec && sec !== 0) return 'LIVE';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/* ───────────────────────── Engine: API cadangan ───────────────────────── */

async function cobaltResolve(url, { audio = false, height = 720 } = {}) {
  const base = (process.env.COBALT_API || '').replace(/\/$/, '');
  if (!base) return null;
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json', ...(process.env.COBALT_KEY ? { Authorization: `Api-Key ${process.env.COBALT_KEY}` } : {}) };
  const r = await fetchJson(`${base}/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url, downloadMode: audio ? 'audio' : 'auto', audioFormat: 'mp3', videoQuality: String(height) }),
  }, 20000);
  if (['tunnel', 'redirect'].includes(r?.status) && r.url) return { url: r.url, title: r.filename || '' };
  if (r?.status === 'picker' && Array.isArray(r.picker)) return { picker: r.picker };
  return null;
}

const siputzx = (name, url, timeout = 15000) => fetchJson(`https://api.siputzx.my.id/api/d/${name}?url=${encodeURIComponent(url)}`, {}, timeout);
const IMG_RX = /\.(jpg|jpeg|png|webp)(\?|$)/i;
const kindOf = (u) => (IMG_RX.test(u) ? 'image' : 'video');

/* ───────────────────────── Downloader ───────────────────────── */

export async function downloadTikTok(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const json = await fetchJson('https://www.tikwm.com/api/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': UA },
        body: new URLSearchParams({ url, hd: '1' }),
      });
      const d = json?.data;
      if (!d) {
        if (/limit/i.test(json?.msg || '')) { await sleep(1300); continue; }
        break;
      }
      const musicUrl = absTikwm(d.music || d.music_info?.play || '');
      const author = d.author?.nickname || d.author?.unique_id || '';
      if (Array.isArray(d.images) && d.images.length) return { type: 'image', title: d.title || 'TikTok Slide', author, images: d.images.map(absTikwm), musicUrl };
      const videoUrl = absTikwm(d.hdplay || d.play || d.wmplay || '');
      if (videoUrl) return { type: 'video', title: d.title || 'TikTok Video', author, videoUrl, musicUrl };
      break;
    } catch {
      if (attempt === 0) await sleep(500);
    }
  }
  const y = await ytdlp(url);
  return y?.buffer ? { type: 'video', title: y.title, author: '', videoBuffer: y.buffer, musicUrl: '' } : null;
}

export async function downloadCapCut(url) {
  try {
    const j = await siputzx('capcut', url);
    const vUrl = j?.data?.videoUrl || j?.data?.url || j?.result?.url;
    if (vUrl) return { url: vUrl, title: j?.data?.title || j?.result?.title || 'CapCut Template' };
  } catch {}
  try {
    const html = await (await fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, 12000)).text();
    const m = html.match(/"video_url":"(https:[^"]+)"/) || html.match(/property="og:video"\s+content="([^"]+)"/);
    if (m?.[1]) return { url: m[1].replace(/\\u002F/g, '/').replace(/&amp;/g, '&'), title: 'CapCut Video' };
  } catch {}
  const y = await ytdlp(url);
  return y?.buffer ? { buffer: y.buffer, title: y.title || 'CapCut Video' } : null;
}

async function scrapeYouTube(query) {
  try {
    const res = await fetchWithTimeout(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=id`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'id,en;q=0.8', Cookie: 'CONSENT=YES+1; SOCS=CAI' },
    });
    const match = (await res.text()).match(/var ytInitialData = (\{.*?\});<\/script>/s);
    if (!match) return [];
    const sections = JSON.parse(match[1])?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
    return sections
      .flatMap((s) => s.itemSectionRenderer?.contents || [])
      .map((i) => i.videoRenderer)
      .filter((v) => v?.videoId)
      .slice(0, 6)
      .map((v) => ({
        id: v.videoId,
        title: v.title?.runs?.[0]?.text || 'YouTube Video',
        duration: v.lengthText?.simpleText || 'LIVE',
        channel: v.ownerText?.runs?.[0]?.text || '',
        views: v.viewCountText?.simpleText || '',
        thumb: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
        url: `https://youtu.be/${v.videoId}`,
      }));
  } catch {
    return [];
  }
}

export async function searchYouTube(query) {
  const r = await scrapeYouTube(query);
  return r.length ? r : searchViaYtdlp(query);
}

const ytId = (u = '') => (u.match(/(?:youtu\.be\/|v=|shorts\/|embed\/|live\/)([\w-]{11})/) || [])[1] || u;

/** Tanpa batas durasi: video/audio berapa pun panjangnya, selama ≤ MAX_BYTES. */
export async function downloadYouTube(url, audioOnly = false, { height = 720 } = {}) {
  const key = `${ytId(url)}|${audioOnly ? 'a' : `v${height}`}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  lastYtError = '';
  const y = await ytdlp(url, { audio: audioOnly, height });
  let out = y?.buffer ? { buffer: y.buffer, title: y.title } : null;

  out ||= await raceFirst([
    async () => {
      const r = await siputzx(audioOnly ? 'ytmp3' : 'ytmp4', url, 20000);
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

/** → { items:[{type,url?|buffer?,fileName?}], url, filename, isImage } */
export async function downloadSocialMedia(url, platform = '') {
  const p = platform.toLowerCase();
  let items = null;

  if (p === 'gdrive') {
    const id = (url.match(/\/d\/([\w-]+)/) || url.match(/[?&]id=([\w-]+)/) || [])[1];
    if (id) items = [{ type: 'document', url: `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`, fileName: `gdrive_${id}`, rejectHtml: true }];
  } else if (p === 'mediafire') {
    items = await raceFirst([
      async () => {
        const j = await siputzx('mediafire', url);
        const f = Array.isArray(j?.data) ? j.data[0] : (j?.data || j?.result);
        const dl = f?.downloadLink || f?.url || f?.link;
        return dl ? [{ type: 'document', url: dl, fileName: f?.fileName || f?.filename || f?.name }] : null;
      },
      async () => {
        const html = await (await fetchWithTimeout(url, { headers: { 'User-Agent': UA } })).text();
        const m = html.match(/href="((?:https?:)?\/\/download\d*\.mediafire\.com[^"]+)"/i);
        if (!m) return null;
        const link = m[1].startsWith('//') ? `https:${m[1]}` : m[1];
        return [{ type: 'document', url: link, fileName: decodeURIComponent(link.split('/').pop().split('?')[0]) }];
      },
    ]);
  } else {
    const apiName = { igdl: 'igdl', fb: 'facebook', twitter: 'twitter' }[p];
    items = await raceFirst([
      async () => {
        if (!apiName) return null;
        const j = await siputzx(apiName, url);
        const list = Array.isArray(j?.data) ? j.data : [j?.data || j?.result].filter(Boolean);
        const out = list
          .map((x) => (typeof x === 'string' ? x : x?.url || x?.hd || x?.sd || x?.downloadLink || ''))
          .filter(Boolean)
          .slice(0, 10)
          .map((u) => ({ type: kindOf(u), url: u }));
        return out.length ? out : null;
      },
      async (signal) => {
        const y = await ytdlp(url, { signal });
        return y?.buffer ? [{ type: 'video', buffer: y.buffer, title: y.title }] : null;
      },
      async () => {
        const c = await cobaltResolve(url);
        if (c?.url) return [{ type: kindOf(c.url), url: c.url }];
        return c?.picker?.slice(0, 10).map((x) => ({ type: x.type === 'photo' ? 'image' : 'video', url: x.url })) || null;
      },
    ]);
  }

  if (!items?.length) return null;
  return { items, url: items[0].url, filename: items[0].fileName, isImage: items[0].type === 'image' };
}

/* ───────────────────────── Pengiriman media ───────────────────────── */

const react = (sock, jid, msg, emoji) => sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }).catch(() => {});

async function sendItem(sock, jid, item, msg, caption = '') {
  const q = { quoted: msg };
  let { buffer, type, fileName, mimetype } = item;

  if (!buffer && item.url) {
    const f = await fetchFile(item.url, item.referer || '', { rejectHtml: !!item.rejectHtml }).catch((err) => ({ err }));
    if (f.buffer) {
      ({ buffer } = f);
      fileName ||= f.fileName;
      mimetype ||= f.contentType;
    } else if (f.err?.message === 'FILE_TOO_BIG' || type === 'document') {
      await say(sock, jid, msg, `📦 File terlalu besar untuk dikirim lewat WhatsApp.\n🔗 ${item.url}`);
      return true;
    } else { // biarkan WhatsApp mengambil langsung dari URL
      await sock.sendMessage(jid, { [type]: { url: item.url }, ...(caption && type !== 'audio' ? { caption } : {}) }, q);
      return true;
    }
  }
  if (!buffer) return false;

  if (type === 'video' && buffer.length > VIDEO_INLINE_MAX) {
    type = 'document';
    fileName ||= `${safeName(item.title || 'video')}.mp4`;
    mimetype = 'video/mp4';
  }
  const cap = caption ? { caption } : {};
  const name = safeName(fileName || 'file', 120);
  const content = {
    image: { image: buffer, ...cap },
    video: { video: buffer, mimetype: 'video/mp4', ...cap },
    audio: { audio: buffer, mimetype: 'audio/mpeg', ptt: !!item.ptt, ...(fileName ? { fileName } : {}) },
  }[type] || { document: buffer, fileName: name, mimetype: mimeFor(name, mimetype), ...cap };
  await sock.sendMessage(jid, content, q);
  return true;
}

async function sendItems(sock, jid, items, msg, caption = '') {
  // Unduh semua item bersamaan (cepat untuk slide/carousel), kirim berurutan
  await Promise.all(items.map(async (it) => {
    if (it.buffer || !it.url) return;
    const f = await fetchFile(it.url, it.referer || '', { rejectHtml: !!it.rejectHtml }).catch(() => null);
    if (f?.buffer) {
      it.buffer = f.buffer;
      it.fileName ||= f.fileName;
      it.mimetype ||= f.contentType;
    }
  }));
  let sent = 0;
  for (let i = 0; i < items.length; i++) {
    if (await sendItem(sock, jid, items[i], msg, i === 0 ? caption : '').catch(() => false)) sent++;
  }
  return sent > 0;
}

/* ───────────────────────── Deteksi platform ───────────────────────── */

const PLATFORMS = [
  ['tiktok', /(^|\/\/|\.)tiktok\.com/],
  ['capcut', /(^|\/\/|\.)capcut\.com/],
  ['youtube', /(^|\/\/|\.)youtube\.com\/(watch|shorts|live|embed)|(^|\/\/)youtu\.be\//],
  ['igdl', /(^|\/\/|\.)instagram\.com\/(p|reel|reels|tv|stories)\//],
  ['fb', /(^|\/\/|\.)facebook\.com|(^|\/\/)fb\.watch|(^|\/\/)fb\.com/],
  ['twitter', /(^|\/\/|\.)(twitter|x)\.com\/[^/]+\/status\//],
  ['mediafire', /(^|\/\/|\.)mediafire\.com/],
  ['gdrive', /(^|\/\/)drive\.google\.com|(^|\/\/)docs\.google\.com\/uc/],
];
const detectPlatform = (url = '') => PLATFORMS.find(([, rx]) => rx.test(url.toLowerCase()))?.[0] || null;

/* ───────────────────────── Handler terpadu ───────────────────────── */

async function runTikTok(sock, jid, url, msg, mode = 'auto') {
  const res = await downloadTikTok(url);
  if (!res) return fail(sock, jid, msg, '❌ Gagal mengunduh TikTok. Pastikan link publik & coba lagi.');
  const title = (res.title || '').slice(0, 300);

  if (mode === 'audio') {
    if (!res.musicUrl) return fail(sock, jid, msg, '❌ Audio tidak tersedia untuk video ini.');
    return sendItems(sock, jid, [{ type: 'audio', url: res.musicUrl, referer: 'https://www.tiktok.com/', fileName: `${safeName(res.title || 'tiktok')}.mp3` }], msg);
  }
  if (res.type === 'image') {
    const items = res.images.slice(0, 10).map((u) => ({ type: 'image', url: u, referer: 'https://www.tiktok.com/' }));
    return sendItems(sock, jid, items, msg, `🖼️ *TikTok Slide* (${items.length} foto)\n${title.slice(0, 200)}`);
  }
  if (mode === 'slide') return fail(sock, jid, msg, 'ℹ️ Link ini video biasa, bukan slide. Pakai `.tiktok` untuk video.');
  const item = res.videoBuffer
    ? { type: 'video', buffer: res.videoBuffer, title: res.title }
    : { type: 'video', url: res.videoUrl, referer: 'https://www.tiktok.com/', title: res.title };
  return sendItems(sock, jid, [item], msg, `🎬 *TikTok*${res.author ? ` — ${res.author}` : ''}\n${title}`);
}

async function runGeneric(sock, jid, platform, url, msg, { height = 480 } = {}) {
  if (platform === 'tiktok') return runTikTok(sock, jid, url, msg);

  if (platform === 'capcut') {
    const cc = await downloadCapCut(url);
    if (!cc) return fail(sock, jid, msg, '❌ Video CapCut tidak ditemukan atau privat.');
    const item = cc.buffer ? { type: 'video', buffer: cc.buffer } : { type: 'video', url: cc.url, referer: 'https://www.capcut.com/' };
    return sendItems(sock, jid, [item], msg, `🎬 *${cc.title || 'CapCut'}*`);
  }

  if (platform === 'youtube') {
    const yt = await downloadYouTube(url, false, { height });
    if (!yt?.buffer) return fail(sock, jid, msg, ytFailText('video YouTube'));
    return sendItems(sock, jid, [{ type: 'video', buffer: yt.buffer, title: yt.title }], msg, `🎬 *${yt.title || 'YouTube'}*`);
  }

  const res = await downloadSocialMedia(url, platform);
  if (!res?.items?.length) return fail(sock, jid, msg, '❌ Tautan gagal diunduh. Pastikan konten publik.');
  return sendItems(sock, jid, res.items, msg, ['mediafire', 'gdrive'].includes(platform) ? '' : '✅ Berhasil diunduh');
}

/** Jalankan dengan slot antrian + reaksi ⏳ → ✅/❌ */
const withReaction = (sock, jid, msg, fn, onError) => withSlot(async () => {
  await react(sock, jid, msg, '⏳');
  let ok = false;
  try { ok = await fn(); } catch (e) { await onError?.(e); }
  await react(sock, jid, msg, ok ? '✅' : '❌');
  return true;
});

export async function handleDirectUrlAutoDownload(sock, jid, url, msg) {
  const platform = detectPlatform(url);
  if (!platform) return false;
  return withReaction(sock, jid, msg, () => runGeneric(sock, jid, platform, url, msg));
}

/* ───────────────────────── Perintah download ───────────────────────── */

async function resolveYouTubeTarget(jid, param) {
  const text = (param || '').trim();
  const link = extractUrl(text);

  if (link && /open\.spotify\.com/i.test(link)) { // Spotify → judul via oEmbed → cari di YouTube
    try {
      const j = await fetchJson(`https://open.spotify.com/oembed?url=${encodeURIComponent(link)}`, {}, 10000);
      if (j?.title) return (await searchYouTube(`${j.title} audio`))[0] || null;
    } catch {}
    return null;
  }
  if (link) return { url: link, title: '' };
  if (/^[1-6]$/.test(text) && lastSearch.get(jid)?.[Number(text) - 1]) return lastSearch.get(jid)[Number(text) - 1];
  if (text) return (await searchYouTube(text))[0] || null;
  return lastPlaySession.get(jid) || null;
}

const TT = 'https://vt.tiktok.com/...';
const NEED_URL = {
  tiktok: TT, tt: TT, ttmp3: TT, ttslide: TT, capcut: 'https://www.capcut.com/tv2/...',
  igdl: 'https://www.instagram.com/reel/...', fb: 'https://fb.watch/...', twitter: 'https://x.com/user/status/...',
  mediafire: 'https://www.mediafire.com/file/...', gdrive: 'https://drive.google.com/file/d/...',
};
const NEED_TEXT = { play: 'komang raim laode', play2: 'komang raim laode', song: 'komang raim laode', spotify: 'komang raim laode', yts: 'lofi chill', tts: 'halo semuanya' };
const HELP = (cmd, ex) => `⚠️ Contoh: \`.${cmd} ${ex}\``;

export async function handleDownloadCommand({ sock, jid, cmd, param = '', msg }) {
  if (!DOWNLOAD_COMMANDS.includes(cmd)) return false;
  param = String(param || '').trim();
  const reply = (text) => say(sock, jid, msg, text);

  if (cmd === 'downloadmenu' || cmd === 'dlmenu') { await reply(DOWNLOAD_MENU); return true; }

  // Validasi cepat sebelum masuk antrian
  if (NEED_URL[cmd] && !extractUrl(param)) { await reply(HELP(cmd, NEED_URL[cmd])); return true; }
  if (NEED_TEXT[cmd] && !param) { await reply(HELP(cmd, NEED_TEXT[cmd])); return true; }
  if (cmd === 'gitclone' && !/github\.com\/[^/\s]+\/[^/\s]+/i.test(param)) { await reply(HELP(cmd, 'https://github.com/user/repo')); return true; }

  return withReaction(sock, jid, msg, () => dispatch({ sock, jid, cmd, param, msg, reply }), (e) =>
    reply(e?.message === 'FILE_TOO_BIG' ? '📦 File terlalu besar untuk WhatsApp (maks ±1.9GB).' : '❌ Terjadi kesalahan saat memproses. Coba lagi sebentar.'));
}

async function dispatch({ sock, jid, cmd, param, msg, reply }) {
  const failMsg = async (text) => { await reply(text); return false; };

  if (['tiktok', 'tt', 'ttmp3', 'ttslide'].includes(cmd)) {
    return runTikTok(sock, jid, extractUrl(param), msg, { ttmp3: 'audio', ttslide: 'slide' }[cmd] || 'auto');
  }
  if (['capcut', 'igdl', 'fb', 'twitter', 'mediafire', 'gdrive'].includes(cmd)) return runGeneric(sock, jid, cmd, extractUrl(param), msg);

  if (['ytmp4', 'ytmp3', 'ytdl', 'video'].includes(cmd)) {
    const hMatch = param.match(/\b(144|240|360|480|720|1080)p?\b\s*$/);
    const height = hMatch ? Number(hMatch[1]) : 720;
    const t = await resolveYouTubeTarget(jid, hMatch ? param.slice(0, hMatch.index).trim() : param);
    if (!t?.url) return failMsg(HELP(cmd, 'https://youtu.be/... atau judul lagu'));
    const isAud = cmd === 'ytmp3';
    const yt = await downloadYouTube(t.url, isAud, { height });
    if (!yt?.buffer) return failMsg(ytFailText(isAud ? 'audio YouTube' : 'video YouTube'));
    lastPlaySession.set(jid, { url: t.url, title: yt.title });
    const name = safeName(yt.title || t.title || 'media');
    const item = isAud ? { type: 'audio', buffer: yt.buffer, fileName: `${name}.mp3` } : { type: 'video', buffer: yt.buffer, title: name };
    return sendItems(sock, jid, [item], msg, isAud ? '' : `🎬 *${yt.title || t.title}*\n_${height}p_`);
  }

  if (['play', 'play2', 'song', 'spotify'].includes(cmd)) {
    const t = await resolveYouTubeTarget(jid, param);
    if (!t?.url) return failMsg('❌ Lagu tidak ditemukan.');
    const asVideo = cmd === 'play2';
    lastPlaySession.set(jid, { url: t.url, title: t.title || param });
    const card = `🎵 *${t.title || param}*\n${t.channel ? `👤 ${t.channel}\n` : ''}${t.duration ? `⏱️ ${t.duration}` : ''}${t.views ? `  •  👁️ ${t.views}` : ''}\n⏳ _Mengirim ${asVideo ? 'video' : 'audio'}..._`;
    // Kartu info dikirim paralel dengan proses unduh agar terasa cepat
    const cardP = (t.thumb ? sock.sendMessage(jid, { image: { url: t.thumb }, caption: card }, { quoted: msg }).catch(() => reply(card)) : reply(card)).catch(() => {});
    const [, yt] = await Promise.all([cardP, downloadYouTube(t.url, !asVideo, { height: 480 })]);
    if (!yt?.buffer) return failMsg(ytFailText(`${asVideo ? 'video' : 'audio'} *${t.title || param}*`));
    const name = safeName(yt.title || t.title || 'lagu');
    const item = asVideo ? { type: 'video', buffer: yt.buffer, title: name } : { type: 'audio', buffer: yt.buffer, fileName: `${name}.mp3` };
    return sendItems(sock, jid, [item], msg, asVideo ? `🎬 *${name}*` : '');
  }

  if (cmd === 'yts') {
    const list = await searchYouTube(param);
    if (!list.length) return failMsg('❌ Tidak ditemukan.');
    lastSearch.set(jid, list);
    await reply(`${list.map((v, i) => `*${i + 1}. ${v.title}*\n⏱️ ${v.duration}${v.channel ? ` • ${v.channel}` : ''}\n🔗 ${v.url}`).join('\n\n')}\n\n_Balas dengan_ \`.ytmp3 <angka>\` _atau_ \`.ytmp4 <angka>\``);
    return true;
  }

  if (cmd === 'gitclone') {
    const m = param.match(/github\.com\/([^/\s]+)\/([^/\s?#]+)(?:\/tree\/([^\s?#]+))?/i);
    const [owner, repo] = [m[1], m[2].replace(/\.git$/i, '')];
    let branch = m[3];
    let sizeKb = 0;
    try {
      const info = await fetchJson(`https://api.github.com/repos/${owner}/${repo}`, { headers: { 'User-Agent': 'WHUXEN-BOT', Accept: 'application/vnd.github+json' } }, 10000);
      branch ||= info.default_branch;
      sizeKb = info.size || 0;
    } catch (e) {
      if (/404/.test(String(e?.message))) return failMsg('❌ Repo tidak ditemukan atau privat.');
    }
    branch ||= 'HEAD';
    const zipUrl = `https://codeload.github.com/${owner}/${repo}/zip/${branch === 'HEAD' ? 'HEAD' : `refs/heads/${branch}`}`;
    if (sizeKb * 1024 > MAX_BYTES) return failMsg(`📦 Repo terlalu besar untuk WhatsApp.\n🔗 ${zipUrl}`);
    return sendItems(sock, jid, [{ type: 'document', url: zipUrl, fileName: `${repo}-${branch}.zip`, mimetype: 'application/zip' }], msg, `📦 *${owner}/${repo}* (${branch})`);
  }

  if (cmd === 'tts') { // .tts [kode-bahasa] teks
    const LANGS = ['id', 'en', 'ja', 'ko', 'ar', 'es', 'fr', 'de', 'hi', 'ru', 'pt', 'zh', 'zh-CN', 'th', 'tr', 'ms', 'jw', 'su'];
    const lm = param.match(/^([a-z]{2}(?:-[A-Z]{2})?)\s+([\s\S]+)/);
    const [lang, text] = lm && LANGS.includes(lm[1]) ? [lm[1], lm[2]] : ['id', param];
    const chunks = []; // pecah ≤180 karakter (batas Google TTS)
    let cur = '';
    for (const w of text.replace(/\s+/g, ' ').trim().split(' ')) {
      if (`${cur} ${w}`.trim().length > 180) { if (cur) chunks.push(cur); cur = w.slice(0, 180); } else cur = `${cur} ${w}`.trim();
    }
    if (cur) chunks.push(cur);
    const parts = await Promise.all(chunks.slice(0, 8).map((c) =>
      fetchBuffer(`https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(c)}&tl=${lang}&client=tw-ob`).catch(() => null)));
    const good = parts.filter(Boolean);
    if (!good.length) return failMsg('❌ Gagal membuat suara. Coba lagi.');
    return sendItems(sock, jid, [{ type: 'audio', buffer: Buffer.concat(good), ptt: true }], msg);
  }

  return true;
}

/* ───────────────────────── Stiker, ViewOnce, AI & UI ───────────────────────── */

export async function mediaBufferToWebpSticker(buffer, isVideo = false) {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const inPath = path.join(os.tmpdir(), `in_${id}.${isVideo ? 'mp4' : 'png'}`);
  const outPath = path.join(os.tmpdir(), `out_${id}.webp`);
  const fit = 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000';
  try {
    await fsPromises.writeFile(inPath, buffer);
    await execFileAsync('ffmpeg', isVideo
      ? ['-y', '-i', inPath, '-t', '6', '-vf', `fps=12,${fit}`, '-loop', '0', '-an', '-vsync', '0', outPath]
      : ['-y', '-i', inPath, '-vf', fit, outPath]);
    return await fsPromises.readFile(outPath);
  } catch {
    return null;
  } finally {
    await Promise.all([inPath, outPath].map((f) => fsPromises.unlink(f).catch(() => {})));
  }
}

export async function createBratSticker(text, isVideo = false) {
  try {
    return await mediaBufferToWebpSticker(await fetchBuffer(`https://api.siputzx.my.id/api/m/brat?text=${encodeURIComponent(text)}${isVideo ? '&isVideo=true' : ''}`), isVideo);
  } catch {
    return null;
  }
}

export async function urlOrTextToWebpSticker(input) {
  try {
    const imgUrl = extractUrl(input) || `https://dummyimage.com/512x512/ffffff/000000.png&text=${encodeURIComponent(input.slice(0, 60))}`;
    return await mediaBufferToWebpSticker(await fetchBuffer(imgUrl), false);
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
    const nativeButtons = [
      ...(sections.length ? [{ name: 'single_select', buttonParamsJson: JSON.stringify({ title: listTitle, sections }) }] : []),
      ...buttons.map((b) => ({ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: b.text, id: b.id }) })),
    ];
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
    const lines = (rows) => rows.join('\n');
    const fallback = [
      title && `*${title}*`, body,
      lines(sections.flatMap((s) => s.rows || []).map((r) => `• \`.${r.id}\` — ${r.title}`)),
      lines(buttons.map((b) => `• \`.${b.id}\` — ${b.text}`)),
      footer && `_${footer}_`,
    ].filter(Boolean).join('\n\n');
    await sock.sendMessage(jid, { text: fallback }, { quoted });
  }
}

export async function panggilServerAISatSet(prompt, systemInstruction = 'Jawab singkat dan akurat dalam Bahasa Indonesia.') {
  try {
    const res = await fetchWithTimeout(`https://text.pollinations.ai/${encodeURIComponent(`${systemInstruction}\n\nPertanyaan: ${prompt}`)}?model=openai`, {
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
    const res = await fetchJson(`https://api.waifu.pics/sfw/${encodeURIComponent(category === 'kickanime' ? 'kick' : category)}`, {}, 10000);
    return res?.url || null;
  } catch {
    return null;
  }
}
