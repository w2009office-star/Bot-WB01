/* naze_api.js — klien API naze.dev & Neosantara (diadaptasi dari proyek hitori)
   Variabel: NAZE_API_KEY (nz-…, https://naze.dev/profile) | NEOSANTARA_API_KEY (nsk_…, https://app.neosantara.xyz/api-keys)
   Opsional: NAZE_API_BASE | NEOSANTARA_API_BASE | NEOSANTARA_MODEL
   Tanpa key semua fungsi diam-diam mengembalikan null, jadi bot tetap memakai penyedia lama. */

const NAZE_BASE = () => (process.env.NAZE_API_BASE || 'https://naze.dev/api/v1').replace(/\/+$/, '');
const NEO_BASE = () => (process.env.NEOSANTARA_API_BASE || 'https://api.neosantara.xyz/v1').replace(/\/+$/, '');
const NAZE_KEY = () => (process.env.NAZE_API_KEY || '').trim();
const NEO_KEY = () => (process.env.NEOSANTARA_API_KEY || '').trim();
const NEO_MODEL = () => process.env.NEOSANTARA_MODEL || 'glm-4.7-flash';
const UA = 'Mozilla/5.0 (Linux; Android 15)';

export const nazeEnabled = () => Boolean(NAZE_KEY());
export const neoEnabled = () => Boolean(NEO_KEY());

const scrub = (s) => [NAZE_KEY(), NEO_KEY()].filter(Boolean).reduce((t, k) => t.split(k).join('***'), String(s));
const norm = (s = '') => String(s).toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const pick = (a) => a[Math.floor(Math.random() * a.length)];

async function request(url, init = {}, { ms = 25000, as = 'json' } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return as === 'buffer' ? Buffer.from(await res.arrayBuffer()) : await res.json();
  } catch (e) {
    throw new Error(scrub(e?.name === 'AbortError' ? 'timeout' : e?.message || e));
  } finally {
    clearTimeout(timer);
  }
}

/** GET (query) atau POST FormData ke naze.dev. as: 'json' | 'buffer' */
export function nazeApi(endpoint, params = {}, opts = {}) {
  const key = NAZE_KEY();
  if (!key) return Promise.reject(new Error('NAZE_API_KEY belum diisi'));
  const headers = { 'user-agent': UA, apikey: key };
  if (params instanceof FormData) return request(NAZE_BASE() + endpoint, { method: 'POST', headers, body: params }, { as: 'buffer', ...opts });
  return request(`${NAZE_BASE()}${endpoint}?${new URLSearchParams({ ...params, apikey: key })}`, { headers }, opts);
}

/** Chat OpenAI-compatible Neosantara → objek message {content, reasoning_content?} */
export async function neoChat(model, content, extra = {}) {
  if (!neoEnabled()) throw new Error('NEOSANTARA_API_KEY belum diisi');
  const messages = Array.isArray(content) ? content : [{ role: 'user', content }];
  const j = await request(`${NEO_BASE()}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${NEO_KEY()}` },
    body: JSON.stringify({ model, messages, ...extra }),
  }, { ms: 60000 });
  return j?.choices?.[0]?.message || null;
}

/** Tanya AI lewat Neosantara lalu naze /ai/chat2. null jika tidak ada key / gagal. */
export async function askNaze(prompt, system = '') {
  const attempts = [
    neoEnabled() && (async () => (await neoChat(NEO_MODEL(), [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }]))?.content),
    nazeEnabled() && (async () => (await nazeApi('/ai/chat2', { query: system ? `${system}\n\n${prompt}` : prompt }, { ms: 30000 }))?.result?.message),
  ].filter(Boolean);
  for (const run of attempts) {
    try {
      const t = String((await run()) || '').trim();
      if (t) return t;
    } catch {}
  }
  return null;
}

/* ───────────── Adaptor untuk engines.js (format sama dengan penyedia lama) ───────────── */

export async function nazeTikTok(url) {
  if (!nazeEnabled()) return null;
  const r = (await nazeApi('/download/tiktok', { url }))?.result;
  const d = r?.download;
  if (!d) return null;
  const base = { title: r.desc || 'TikTok', author: r.author?.nickname || '', musicUrl: d.music || '' };
  if (d.type === 'images' && d.images?.length) return { type: 'image', ...base, images: d.images.map((x) => x.url).filter(Boolean) };
  const videoUrl = d.video?.nowm_hd || d.video?.nowm;
  return videoUrl ? { type: 'video', ...base, videoUrl } : null;
}

export async function nazeYouTube(url, audioOnly = false, height = 720) {
  if (!nazeEnabled()) return null;
  const r = (await nazeApi('/download/youtube', audioOnly ? { url } : { url, format: String(height) }, { ms: 60000 }))?.result;
  return r?.download ? { url: r.download, title: r.title } : null;
}

export async function nazeSocial(platform, url) {
  if (!nazeEnabled()) return null;
  if (platform === 'igdl') {
    const media = (await nazeApi('/download/instagram2', { url }))?.result?.media || [];
    const items = media.filter((m) => m?.url).slice(0, 10).map((m) => ({ type: m.type === 'video' ? 'video' : 'image', url: m.url }));
    return items.length ? items : null;
  }
  if (platform === 'fb') {
    const r = (await nazeApi('/download/facebook', { url }))?.result;
    const u = r?.hd || r?.sd;
    return u ? [{ type: 'video', url: u }] : null;
  }
  if (platform === 'mediafire') {
    const r = (await nazeApi('/download/mediafire', { url }))?.result;
    return r?.link ? [{ type: 'document', url: r.link, fileName: r.filename }] : null;
  }
  return null;
}

/* ───────────── Perintah baru (wajib pakai titik/prefix) ───────────── */

const TEXT_RANDOM = {
  bijak: ['/random/bijak', (r) => r.result],
  dare: ['/random/dare', (r) => r.result],
  truth: ['/random/truth', (r) => `_${r.result}_`],
  renungan: ['/random/renungan', (r) => r.result],
  bucin: ['/random/bucin', (r) => r.result],
  quotes: ['/random/quotes', (r) => `_${r.result.quotes}_\n\n*- ${r.result.author}*`],
};
const IMAGE_FORM = { hd: '/tools/remini', remini: '/tools/remini', tohd: '/tools/remini', colorize: '/tools/recolor', recolor: '/tools/recolor', wasted: '/create/wasted', triggered: '/create/triggered' };
const NEO_MODELS = { grok: 'grok-4.1-fast-non-reasoning', glm: 'glm-4.7-flash', claude: 'claude-3-haiku', archipelago: 'archipelago-70b', deepseek: 'deepseek-r1', r1: 'deepseek-r1' };
const QUIZ = {
  tekateki: { ep: '/games/tekateki', title: 'Teka Teki', sec: 60, q: (r) => r.soal, a: (r) => r.jawaban },
  tebaklirik: { ep: '/games/tebaklirik', title: 'Tebak Lirik', sec: 90, q: (r) => r.soal, a: (r) => r.jawaban },
  susunkata: { ep: '/games/susunkata', title: 'Susun Kata', sec: 60, q: (r) => `${r.soal}\nTipe: ${r.tipe}`, a: (r) => r.jawaban },
  tebakkimia: { ep: '/games/tebakkimia', title: 'Tebak Kimia', sec: 60, q: (r) => `Unsur: ${r.unsur}`, a: (r) => r.lambang },
  caklontong: { ep: '/games/caklontong', title: 'Cak Lontong', sec: 60, q: (r) => r.soal, a: (r) => r.jawaban },
  tebaknegara: { ep: '/games/tebaknegara', title: 'Tebak Negara', sec: 60, q: (r) => `Tempat: ${r.tempat}`, a: (r) => r.negara },
  tebakbendera: { ep: '/games/tebakbendera', title: 'Tebak Bendera', sec: 60, q: (r) => `Bendera: ${r.bendera}`, a: (r) => r.negara },
  tebakgambar: { ep: '/games/tebakgambar', title: 'Tebak Gambar', sec: 60, q: (r) => r.deskripsi, a: (r) => r.jawaban, img: (r) => r.img },
};
const SEARCH = ['pinterest', 'pint', 'pixiv', 'gimage', 'tenor', 'ringtone', 'styletext', 'emojimix', 'iqc', 'khodam'];

export const NAZE_COMMANDS = [
  ...Object.keys(TEXT_RANDOM), ...Object.keys(IMAGE_FORM), ...Object.keys(NEO_MODELS), ...Object.keys(QUIZ), ...SEARCH, 'nyerah',
];

const quizzes = new Map();
const isImg = (b) => b?.length > 4 && ((b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x89 && b[1] === 0x50) || b.subarray(0, 4).toString() === 'RIFF');
const done = async (p) => { await p; return true; };

async function sendBuffer(c, buf, caption, deps) {
  const head = buf.subarray(0, 12).toString('latin1');
  if (head.startsWith('GIF8')) return c.send({ sticker: await deps.toSticker(buf, true) });
  if (head.slice(4, 8) === 'ftyp') return c.send({ video: buf, caption });
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return c.send({ sticker: buf });
  return c.send({ image: buf, caption });
}

async function fetchImage(url, referer) {
  const res = await fetch(url, { headers: { 'user-agent': UA, ...(referer ? { referer } : {}) }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!isImg(buf)) throw new Error('bukan gambar');
  return buf;
}

const needKey = (c, which) => c.reply(c.isOwner
  ? which === 'neo' ? '⚠️ Isi variabel NEOSANTARA_API_KEY dulu (https://app.neosantara.xyz/api-keys).' : '⚠️ Isi variabel NAZE_API_KEY dulu (https://naze.dev/profile).'
  : '⚠️ Fitur ini belum diaktifkan owner.');

async function startQuiz(c, name) {
  const g = QUIZ[name];
  if (quizzes.has(c.jid)) return c.reply('⚠️ Masih ada soal yang belum selesai. Jawab atau ketik `.nyerah`.');
  const r = (await nazeApi(g.ep))?.result;
  const answer = g.a(r || {});
  if (!r || !answer) return c.reply('❌ Soal tidak tersedia, coba lagi.');
  const text = `🎮 *${g.title}*\n\n${g.q(r)}\n\n⏱️ ${g.sec} detik • ketik jawabanmu langsung`;
  quizzes.set(c.jid, { answer: String(answer), name, timer: null });
  const s = quizzes.get(c.jid);
  s.timer = setTimeout(() => {
    if (quizzes.get(c.jid) !== s) return;
    quizzes.delete(c.jid);
    c.reply(`⌛ Waktu habis!\nJawaban: *${s.answer}*`).catch(() => {});
  }, g.sec * 1000);
  s.timer.unref?.();
  return g.img ? c.send({ image: { url: g.img(r) }, caption: text }) : c.reply(text);
}

/** Dipanggil untuk SETIAP pesan non-perintah: true bila pesan adalah jawaban benar. */
export async function handleNazeQuizInput(c) {
  const s = quizzes.get(c.jid);
  if (!s || /^[.!/#]/.test(c.rawText)) return false;
  if (norm(c.rawText) !== norm(s.answer)) return false;
  clearTimeout(s.timer);
  quizzes.delete(c.jid);
  await c.reply(`✅ Benar, *${c.pushName}*! Jawaban: *${s.answer}*`);
  return true;
}

/** deps: { imageOf(c) → Buffer|null, toSticker(buf, animated) → webp Buffer } */
export async function handleNazeCommand(c, deps) {
  const { cmd, param } = c;
  const useUsage = (ex) => c.reply(`⚠️ Contoh: \`.${cmd} ${ex}\``);
  try {
    if (cmd === 'nyerah') {
      const s = quizzes.get(c.jid);
      if (!s) return true;
      clearTimeout(s.timer);
      quizzes.delete(c.jid);
      return done(c.reply(`🏳️ Menyerah. Jawaban: *${s.answer}*`));
    }
    if (NEO_MODELS[cmd]) {
      if (!neoEnabled()) return done(needKey(c, 'neo'));
      if (!param) return done(useUsage('halo, apa kabar?'));
      const extra = cmd === 'deepseek' || cmd === 'r1' ? { thinking: { type: 'enabled', budget_tokens: 2048 } } : {};
      const m = await neoChat(NEO_MODELS[cmd], param, extra);
      if (!m?.content) throw new Error('kosong');
      return done(c.reply((m.reasoning_content ? `*Proses mikir:*\n_${m.reasoning_content}_\n\n` : '') + m.content));
    }
    if (!nazeEnabled()) return done(needKey(c, 'naze'));

    if (TEXT_RANDOM[cmd]) {
      const [ep, fmt] = TEXT_RANDOM[cmd];
      return done(c.reply(fmt(await nazeApi(ep))));
    }
    if (QUIZ[cmd]) return done(startQuiz(c, cmd));

    if (IMAGE_FORM[cmd]) {
      const img = await deps.imageOf(c);
      if (!img) return done(c.reply(`⚠️ Kirim/balas *gambar* dengan \`.${cmd}\``));
      await c.reply('⏳ Memproses...');
      const form = new FormData();
      form.append('buffer', new Blob([img], { type: 'image/jpeg' }), 'image.jpg');
      return done(sendBuffer(c, await nazeApi(IMAGE_FORM[cmd], form, { ms: 90000 }), '✅ Selesai', deps));
    }
    switch (cmd) {
      case 'iqc': {
        if (!param) return done(useUsage('teks pesan'));
        return done(c.send({ image: await nazeApi('/create/iqc', { text: param.slice(0, 200) }, { as: 'buffer' }), caption: '✅ Selesai' }));
      }
      case 'styletext': {
        if (!param) return done(useUsage('Whuxen'));
        const list = (await nazeApi('/tools/styletext', { text: param }))?.result || [];
        return done(c.reply(list.map((a) => `*${a.name}*\n${a.result}`).join('\n\n') || '❌ Tidak ada hasil.'));
      }
      case 'emojimix': {
        const [e1, e2] = param.split('+').map((x) => x.trim());
        if (!e1 || !e2) return done(useUsage('😅+🤔'));
        const list = (await nazeApi('/tools/emojimix', { emoji1: e1, emoji2: e2 }))?.result || [];
        if (!list.length) return done(c.reply('❌ Kombinasi emoji tidak ditemukan.'));
        for (const it of list.slice(0, 3)) await c.send({ sticker: await deps.toSticker(await fetchImage(it.url)) });
        return true;
      }
      case 'khodam': {
        if (!param) return done(useUsage('nama kamu'));
        const r = (await nazeApi('/primbon/cekkhodam'))?.result;
        return done(c.reply(`Khodam dari *${param}* adalah *${r?.nama}*\n_${r?.deskripsi || ''}_`));
      }
      case 'pinterest': case 'pint': {
        if (!param) return done(useUsage('hu tao'));
        const it = pick((await nazeApi('/search/pinterest', { query: param }))?.result || []);
        const url = typeof it === 'string' ? it : it?.urls?.original || it?.image || it?.url;
        return done(url ? c.send({ image: await fetchImage(url), caption: `Hasil: ${param}` }) : c.reply('❌ Tidak ditemukan.'));
      }
      case 'pixiv': {
        if (!param) return done(useUsage('hu tao'));
        const it = pick((await nazeApi('/search/pixiv', { query: param }))?.result?.body?.illusts || []);
        if (!it) return done(c.reply('❌ Tidak ditemukan.'));
        return done(c.send({ image: await fetchImage(it.url_big || it.url, 'https://www.pixiv.net'), caption: `Title: ${it.title}\nAuthor: ${it.author_details?.user_name || '-'}` }));
      }
      case 'gimage': {
        if (!param) return done(useUsage('kucing lucu'));
        const it = pick((await nazeApi('/search/google', { query: param }))?.result || []);
        const url = it?.pagemap?.cse_image?.[0]?.src || it?.pagemap?.cse_thumbnail?.[0]?.src || it?.pagemap?.metatags?.[0]?.['og:image'];
        if (!url) return done(c.reply('❌ Tidak ditemukan.'));
        return done(c.send({ image: await fetchImage(url), caption: `${it.title}\n${it.snippet || ''}\n${it.link || ''}` }));
      }
      case 'tenor': {
        if (!param) return done(useUsage('alone'));
        const it = pick((await nazeApi('/search/tenor', { query: param }))?.result || []);
        const mp4 = it?.media?.[0]?.mp4?.url;
        return done(mp4 ? c.send({ video: { url: mp4 }, caption: it.content_description || '', gifPlayback: true }) : c.reply('❌ Tidak ditemukan.'));
      }
      case 'ringtone': {
        if (!param) return done(useUsage('black rover'));
        const r = (await nazeApi('/search/meloboom', { query: param }))?.result;
        const it = pick(r?.data || []);
        const url = it && r?.populated?.media?.[it.media?.audio?.[0]]?.url;
        return done(url ? c.send({ audio: { url }, mimetype: 'audio/mpeg', fileName: `${it.slug || 'ringtone'}.mp3` }) : c.reply('❌ Tidak ditemukan.'));
      }
    }
    return false;
  } catch (e) {
    console.error(`[naze] .${cmd}:`, scrub(e?.message || e));
    await c.reply('❌ Layanan API sedang bermasalah atau limit key habis. Coba lagi nanti.');
    return true;
  }
}
