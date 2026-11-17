import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { downloadContentFromMessage } from '@whiskeysockets/baileys';

const execFileAsync = promisify(execFile);
const lastPlaySession = new Map();

export const DOWNLOAD_COMMANDS = [
  'tiktok', 'tt', 'ttmp3', 'ttslide', 'capcut',
  'ytmp4', 'ytmp3', 'ytdl', 'video', 'play', 'play2', 'song', 'spotify', 'yts',
  'igdl', 'fb', 'twitter', 'mediafire', 'gdrive', 'gitclone', 'tts',
  'downloadmenu', 'dlmenu',
];

export const DOWNLOAD_MENU =
  `*╭┈───〔 📥 MENU DOWNLOAD 〕┈───⊷*\n` +
  `*│* _Tempel link langsung di chat juga otomatis terunduh_\n` +
  `*╰───────────────────────⊷*\n\n` +
  `*🎵 MUSIK & YOUTUBE*\n` +
  `• \`.play <judul>\`\n` +
  `• \`.spotify <judul>\`\n` +
  `• \`.ytmp3 <link>\`\n` +
  `• \`.ytmp4 <link>\`\n` +
  `• \`.yts <judul>\`\n\n` +
  `*📱 SOSIAL MEDIA*\n` +
  `• \`.tiktok <link>\`\n` +
  `• \`.ttmp3 <link>\`\n` +
  `• \`.ttslide <link>\`\n` +
  `• \`.capcut <link>\`\n` +
  `• \`.igdl <link>\`\n` +
  `• \`.fb <link>\`\n` +
  `• \`.twitter <link>\`\n\n` +
  `*📁 FILE & SUARA*\n` +
  `• \`.mediafire <link>\`\n` +
  `• \`.gdrive <link>\`\n` +
  `• \`.gitclone <link>\`\n` +
  `• \`.tts <teks>\``;

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

export async function fetchBuffer(url, referer = '') {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    ...(referer ? { Referer: referer } : {}),
  };
  const res = await fetchWithTimeout(url, { headers }, 25000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export function extractUrl(text = '') {
  const m = String(text).match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/i);
  return m ? m[0].replace(/[.,!?)]+$/, '') : '';
}

/* ───────────────────────── Downloader Engines ───────────────────────── */

export async function downloadTikTok(url) {
  try {
    const res = await fetchWithTimeout('https://www.tikwm.com/api/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': 'Mozilla/5.0',
      },
      body: new URLSearchParams({ url, hd: '1' }),
    }, 15000);
    const json = await res.json();
    const d = json?.data;
    if (!d) return null;
    if (Array.isArray(d.images) && d.images.length) {
      return {
        type: 'image',
        title: d.title || 'TikTok Slide',
        images: d.images,
        musicUrl: d.music || d.music_info?.play || '',
      };
    }
    return {
      type: 'video',
      title: d.title || 'TikTok Video',
      videoUrl: d.hdplay || d.play || d.wmplay || '',
      musicUrl: d.music || d.music_info?.play || '',
    };
  } catch {
    return null;
  }
}

export async function downloadCapCut(url) {
  try {
    const api = await fetchWithTimeout(`https://api.siputzx.my.id/api/d/capcut?url=${encodeURIComponent(url)}`, {}, 15000);
    const j = await api.json();
    const vUrl = j?.data?.videoUrl || j?.data?.url || j?.result?.url;
    if (vUrl) return { url: vUrl, title: j?.data?.title || j?.result?.title || 'CapCut Template' };
  } catch {}
  try {
    const html = await (await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 12000)).text();
    const m = html.match(/"video_url":"(https:[^"]+)"/) || html.match(/property="og:video"\s+content="([^"]+)"/);
    if (m?.[1]) return { url: m[1].replace(/\\u002F/g, '/'), title: 'CapCut Video' };
  } catch {}
  return null;
}

export async function searchYouTube(query) {
  try {
    const html = await (await fetchWithTimeout(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    }, 15000)).text();
    const match = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
    if (!match) return [];
    const data = JSON.parse(match[1]);
    const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];
    const results = [];
    for (const item of contents) {
      const v = item.videoRenderer;
      if (!v?.videoId) continue;
      results.push({
        id: v.videoId,
        title: v.title?.runs?.[0]?.text || 'YouTube Video',
        duration: v.lengthText?.simpleText || '-',
        url: `https://youtu.be/${v.videoId}`,
      });
      if (results.length >= 6) break;
    }
    return results;
  } catch {
    return [];
  }
}

export async function downloadYouTube(url, audioOnly = false) {
  const endpoints = [
    async () => {
      const type = audioOnly ? 'ytmp3' : 'ytmp4';
      const r = await (await fetchWithTimeout(`https://api.siputzx.my.id/api/d/${type}?url=${encodeURIComponent(url)}`, {}, 20000)).json();
      const dl = r?.data?.dl || r?.data?.url || r?.result?.url;
      if (!dl) return null;
      const buffer = await fetchBuffer(dl);
      return { buffer, title: r?.data?.title || r?.result?.title || 'YouTube Media' };
    },
    async () => {
      const r = await (await fetchWithTimeout('https://api.cobalt.tools/api/json', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, isAudioOnly: audioOnly, aFormat: 'mp3', vQuality: '720' }),
      }, 20000)).json();
      if (!r?.url) return null;
      const buffer = await fetchBuffer(r.url);
      return { buffer, title: 'YouTube Media' };
    },
  ];

  for (const fn of endpoints) {
    try {
      const out = await fn();
      if (out?.buffer?.length > 1024) return out;
    } catch {}
  }
  return null;
}

export async function downloadSocialMedia(url, platform = '') {
  const p = platform.toLowerCase();
  try {
    if (p === 'gdrive') {
      const m = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
      if (m?.[1]) {
        return { url: `https://drive.google.com/uc?export=download&id=${m[1]}`, filename: `gdrive_${m[1]}`, isImage: false };
      }
    }
    const apiMap = {
      igdl: `https://api.siputzx.my.id/api/d/igdl?url=${encodeURIComponent(url)}`,
      fb: `https://api.siputzx.my.id/api/d/facebook?url=${encodeURIComponent(url)}`,
      twitter: `https://api.siputzx.my.id/api/d/twitter?url=${encodeURIComponent(url)}`,
      mediafire: `https://api.siputzx.my.id/api/d/mediafire?url=${encodeURIComponent(url)}`,
    };
    if (apiMap[p]) {
      const j = await (await fetchWithTimeout(apiMap[p], {}, 18000)).json();
      const first = Array.isArray(j?.data) ? j.data[0] : (j?.data || j?.result);
      const dlUrl = first?.url || first?.hd || first?.sd || first?.downloadLink || '';
      if (dlUrl) {
        return {
          url: dlUrl,
          filename: first?.fileName || first?.filename || `${p}_file`,
          isImage: /\.(jpg|jpeg|png|webp)(\?|$)/i.test(dlUrl),
        };
      }
    }
  } catch {}
  return null;
}

/* ───────────────────────── Unified Download Handlers ───────────────────────── */

export async function handleDirectUrlAutoDownload(sock, jid, url, msg) {
  const lower = url.toLowerCase();
  if (/tiktok\.com/i.test(lower)) {
    const res = await downloadTikTok(url);
    if (!res) return false;
    if (res.type === 'image') {
      for (const u of res.images.slice(0, 8)) {
        const b = await fetchBuffer(u, 'https://www.tiktok.com/').catch(() => null);
        if (b) await sock.sendMessage(jid, { image: b }, { quoted: msg });
      }
    } else if (res.videoUrl) {
      const vBuf = await fetchBuffer(res.videoUrl, 'https://www.tiktok.com/').catch(() => null);
      await sock.sendMessage(jid, vBuf ? { video: vBuf, caption: `🎬 *TikTok*\n${res.title || ''}` } : { video: { url: res.videoUrl }, caption: `🎬 *TikTok*\n${res.title || ''}` }, { quoted: msg });
    }
    return true;
  }
  if (/capcut\.com/i.test(lower)) {
    const cc = await downloadCapCut(url);
    if (!cc?.url) return false;
    const vBuf = await fetchBuffer(cc.url, 'https://www.capcut.com/').catch(() => null);
    await sock.sendMessage(jid, vBuf ? { video: vBuf, caption: `🎬 *${cc.title || 'CapCut'}*` } : { video: { url: cc.url }, caption: `🎬 *${cc.title || 'CapCut'}*` }, { quoted: msg });
    return true;
  }
  if (/youtube\.com\/(watch|shorts)|youtu\.be\//i.test(lower)) {
    const yt = await downloadYouTube(url, false);
    if (!yt?.buffer) return false;
    await sock.sendMessage(jid, { video: yt.buffer, caption: `🎬 *${yt.title || 'YouTube'}*` }, { quoted: msg });
    return true;
  }
  const pf = [
    [/instagram\.com/i, 'igdl'],
    [/facebook\.com|fb\.watch/i, 'fb'],
    [/twitter\.com|x\.com/i, 'twitter'],
    [/mediafire\.com/i, 'mediafire'],
    [/drive\.google\.com/i, 'gdrive'],
  ].find(([rx]) => rx.test(lower));
  if (pf) {
    const res = await downloadSocialMedia(url, pf[1]);
    if (!res?.url) return false;
    const buf = await fetchBuffer(res.url).catch(() => null);
    if (!buf) await sock.sendMessage(jid, { text: `🔗 *Link Unduhan:* ${res.url}` }, { quoted: msg });
    else if (pf[1] === 'mediafire' || pf[1] === 'gdrive') await sock.sendMessage(jid, { document: buf, fileName: res.filename || 'file', mimetype: 'application/octet-stream' }, { quoted: msg });
    else await sock.sendMessage(jid, res.isImage ? { image: buf } : { video: buf }, { quoted: msg });
    return true;
  }
  return false;
}

export async function handleDownloadCommand({ sock, jid, cmd, param, msg }) {
  if (!DOWNLOAD_COMMANDS.includes(cmd)) return false;

  if (cmd === 'downloadmenu' || cmd === 'dlmenu') {
    await sock.sendMessage(jid, { text: DOWNLOAD_MENU }, { quoted: msg });
    return true;
  }

  if (['tiktok', 'tt', 'ttmp3', 'ttslide'].includes(cmd)) {
    const u = extractUrl(param);
    if (!u) { await sock.sendMessage(jid, { text: `⚠️ Contoh: \`.${cmd} https://vt.tiktok.com/...\`` }, { quoted: msg }); return true; }
    const res = await downloadTikTok(u);
    if (!res) { await sock.sendMessage(jid, { text: '❌ Gagal mengunduh TikTok.' }, { quoted: msg }); return true; }
    if (cmd === 'ttmp3' && res.musicUrl) {
      const buf = await fetchBuffer(res.musicUrl, 'https://www.tiktok.com/').catch(() => null);
      if (buf) await sock.sendMessage(jid, { audio: buf, mimetype: 'audio/mpeg' }, { quoted: msg });
    } else if (res.type === 'image') {
      for (const imgU of res.images.slice(0, 8)) {
        const b = await fetchBuffer(imgU, 'https://www.tiktok.com/').catch(() => null);
        if (b) await sock.sendMessage(jid, { image: b }, { quoted: msg });
      }
    } else if (res.videoUrl) {
      const vBuf = await fetchBuffer(res.videoUrl, 'https://www.tiktok.com/').catch(() => null);
      await sock.sendMessage(jid, vBuf ? { video: vBuf, caption: `🎬 *TikTok HD*\n${res.title}` } : { video: { url: res.videoUrl }, caption: `🎬 *TikTok HD*\n${res.title}` }, { quoted: msg });
    }
    return true;
  }

  if (cmd === 'capcut') {
    const u = extractUrl(param);
    if (!u) { await sock.sendMessage(jid, { text: '⚠️ Contoh: `.capcut https://www.capcut.com/tv2/...`' }, { quoted: msg }); return true; }
    const cc = await downloadCapCut(u);
    if (!cc?.url) { await sock.sendMessage(jid, { text: '❌ Video CapCut tidak ditemukan atau privat.' }, { quoted: msg }); return true; }
    const vBuf = await fetchBuffer(cc.url, 'https://www.capcut.com/').catch(() => null);
    await sock.sendMessage(jid, vBuf ? { video: vBuf, caption: `🎬 *${cc.title}*` } : { video: { url: cc.url }, caption: `🎬 *${cc.title}*` }, { quoted: msg });
    return true;
  }

  if (['ytmp4', 'ytmp3', 'ytdl', 'video'].includes(cmd)) {
    const u = extractUrl(param) || lastPlaySession.get(jid)?.url;
    if (!u) { await sock.sendMessage(jid, { text: `⚠️ Contoh: \`.${cmd} https://youtu.be/...\`` }, { quoted: msg }); return true; }
    const isAud = cmd === 'ytmp3';
    const yt = await downloadYouTube(u, isAud);
    await sock.sendMessage(jid, yt?.buffer ? (isAud ? { audio: yt.buffer, mimetype: 'audio/mpeg' } : { video: yt.buffer, caption: `🎬 *${yt.title}*` }) : { text: '❌ Gagal mengunduh media YouTube.' }, { quoted: msg });
    return true;
  }

  if (['play', 'play2', 'song', 'spotify'].includes(cmd)) {
    if (!param) { await sock.sendMessage(jid, { text: `⚠️ Contoh: \`.${cmd} komang raim laode\`` }, { quoted: msg }); return true; }
    let trackUrl = extractUrl(param);
    let trackTitle = param;
    let trackDuration = '';
    if (!trackUrl) {
      const list = await searchYouTube(param);
      if (!list?.length) { await sock.sendMessage(jid, { text: '❌ Lagu tidak ditemukan.' }, { quoted: msg }); return true; }
      ({ url: trackUrl, title: trackTitle, duration: trackDuration } = list[0]);
    }
    lastPlaySession.set(jid, { url: trackUrl, title: trackTitle });
    await sock.sendMessage(jid, { text: `🎵 *Memutar:* ${trackTitle}${trackDuration ? ` — ${trackDuration}` : ''}\n⏳ _Mengirim audio..._` }, { quoted: msg });
    const ytAudio = await downloadYouTube(trackUrl, true);
    await sock.sendMessage(jid, ytAudio?.buffer ? { audio: ytAudio.buffer, mimetype: 'audio/mpeg', ptt: false } : { text: `❌ Gagal mengambil file audio untuk *${trackTitle}*.` }, { quoted: msg });
    return true;
  }

  if (cmd === 'yts') {
    if (!param) { await sock.sendMessage(jid, { text: '⚠️ Contoh: `.yts lofi chill`' }, { quoted: msg }); return true; }
    const list = await searchYouTube(param);
    await sock.sendMessage(jid, { text: list.length ? list.map((v, i) => `${i + 1}. *${v.title}* — ${v.duration}\n🔗 ${v.url}`).join('\n\n') : '❌ Tidak ditemukan.' }, { quoted: msg });
    return true;
  }

  if (['igdl', 'fb', 'twitter', 'mediafire', 'gdrive'].includes(cmd)) {
    const u = extractUrl(param);
    if (!u) { await sock.sendMessage(jid, { text: `⚠️ Contoh: \`.${cmd} https://...\`` }, { quoted: msg }); return true; }
    const res = await downloadSocialMedia(u, cmd);
    if (!res?.url) { await sock.sendMessage(jid, { text: '❌ Tautan gagal diunduh.' }, { quoted: msg }); return true; }
    const buf = await fetchBuffer(res.url).catch(() => null);
    if (!buf) await sock.sendMessage(jid, { text: `🔗 ${res.url}` }, { quoted: msg });
    else if (cmd === 'mediafire' || cmd === 'gdrive') await sock.sendMessage(jid, { document: buf, fileName: res.filename, mimetype: 'application/octet-stream' }, { quoted: msg });
    else await sock.sendMessage(jid, res.isImage ? { image: buf } : { video: buf }, { quoted: msg });
    return true;
  }

  if (cmd === 'gitclone') {
    const m = param.match(/github\.com\/([^/]+)\/([^/\s]+)/i);
    if (!m) { await sock.sendMessage(jid, { text: '⚠️ Contoh: `.gitclone https://github.com/user/repo`' }, { quoted: msg }); return true; }
    await sock.sendMessage(jid, { document: { url: `https://github.com/${m[1]}/${m[2].replace(/\.git$/, '')}/archive/refs/heads/main.zip` }, fileName: `${m[2]}.zip`, mimetype: 'application/zip' }, { quoted: msg });
    return true;
  }

  if (cmd === 'tts') {
    if (!param) { await sock.sendMessage(jid, { text: '⚠️ Contoh: `.tts halo semuanya`' }, { quoted: msg }); return true; }
    const buf = await fetchBuffer(`https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(param.slice(0, 200))}&tl=id&client=tw-ob`).catch(() => null);
    if (buf) await sock.sendMessage(jid, { audio: buf, mimetype: 'audio/mpeg', ptt: true }, { quoted: msg });
    return true;
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
    let buffer = Buffer.from([]);
    for await (const chunk of await downloadContentFromMessage(media, type)) {
      buffer = Buffer.concat([buffer, chunk]);
    }
    return { type, buffer, caption: media.caption || '' };
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
    const res = await (await fetchWithTimeout(`https://api.waifu.pics/sfw/${encodeURIComponent(clean)}`, {}, 10000)).json();
    return res?.url || null;
  } catch {
    return null;
  }
}
