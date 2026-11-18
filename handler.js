// ═════════ handler.js (ganti seluruh isi file; berisi semua game) ═════════
import { sendNativeInteractiveButtons, getAnimeImageUrl, panggilServerAISatSet } from './engines.js';

/* ═════════════════════════ UTIL ═════════════════════════ */

const rand = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rand(a.length)];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const bar = (f, n = 10) => { const k = Math.round(clamp(f, 0, 1) * n); return '█'.repeat(k) + '░'.repeat(n - k); };
const dayStr = (ms = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(ms);
const hash01 = (str) => { let h = 2166136261; for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 10007) / 10007; };

/* ═════════════════════════ PROFIL, EMOSI & PROGRES ═════════════════════════ */

const LVL = (xp) => Math.floor(Math.sqrt(xp / 40)) + 1;
const RANKS = [[1, 'Pemula 🌱'], [3, 'Petarung ⚔️'], [5, 'Pendekar 🥋'], [8, 'Ahli 🔥'], [12, 'Master 💎'], [18, 'Legenda 👑']];
const rankOf = (lv) => RANKS.filter(([m]) => lv >= m).pop()[1];
const NAMES = { kuro: 'Kuro Slash', sonic: 'Speedy Dash', angka: 'Tebak Angka', math: 'Math Rush', kata: 'Tebak Kata', suit: 'Suit Duel', dice: 'Dadu Duel', coin: 'Koin Beruntun' };
const ACH = [
  ['Langkah Pertama 🌱', (p) => p.played >= 1],
  ['Pemenang Sejati 🏅', (p) => p.wins >= 10],
  ['Api Tak Padam 🔥', (p) => p.bestStreak >= 5],
  ['Veteran 🎖️', (p) => p.played >= 50],
  ['Penebar Kehangatan 🤗', (p) => p.kind >= 10],
  ['Legenda 👑', (p) => LVL(p.xp) >= 18],
];

const FEEL = {
  win: ['Mantap! Insting kamu tajam. 🔥', 'Kerja bagus — itu bukan kebetulan, itu skill. 💪', 'Kamu makin jago! Aku mulai khawatir. 😅'],
  comeback: ['Akhirnya bangkit! Kamu tidak menyerah, dan itu yang membuatmu hebat. 💪', 'Comeback manis! Kekalahan tadi ternyata cuma pemanasan. 🌅'],
  streak: { 3: '🔥 *3 kemenangan beruntun!* Kamu lagi on fire.', 5: '⚡ *5 beruntun!* Fokusmu luar biasa.', 10: '👑 *10 beruntun!* Level dewa.' },
  lose: ['Kalah itu data, bukan akhir. Ada pola yang bisa kamu baca di ronde berikutnya. 🧠', 'Tidak apa-apa. Pemain terbaik pun belajar dari ronde seperti ini. 🌱'],
  near: ['Tinggal selangkah lagi! Kamu hampir sampai. 🤏', 'Beda tipis banget! Ronde berikutnya pasti lebih dekat. 🎯'],
  frustrated: ['Aku lihat kamu sudah berjuang keras. 💙 Istirahat sebentar juga strategi. Kesulitan kuturunkan sedikit supaya tetap seru (*mode santai* aktif).'],
  draw: ['Imbang! Kita sama kuat — penasaran siapa yang menang di ronde berikutnya? 😏'],
  pb: ['🏆 *REKOR PRIBADI BARU!* Kamu melampaui dirimu sendiri.'],
  rest: '💧 Sudah banyak ronde barusan! Minum dulu & regangkan badan — progresmu aman, game ini tetap di sini.',
  back: ['👋 Kangen! Kamu kembali setelah {d} hari. Progresmu masih utuh.'],
};

function profile(c) {
  const all = (c.dbMemory.gameProfiles ||= {});
  const p = (all[c.senderNum] ||= { xp: 0, played: 0, wins: 0, streak: 0, bestStreak: 0, lossStreak: 0, lastDay: '', daily: 0, lastDaily: '', recent: [], best: {}, ach: [], rps: {}, kind: 0, rd: { day: '', cmds: [] } });
  p.name = c.pushName;
  return p;
}

function intro(c) { // sapaan hangat saat kembali setelah beberapa hari
  const p = profile(c), today = dayStr();
  let line = '';
  if (p.lastDay && p.lastDay !== today) {
    const d = Math.round((new Date(today) - new Date(p.lastDay)) / 864e5);
    if (d >= 2) line = `${pick(FEEL.back).replace('{d}', d)}\n\n`;
  }
  p.lastDay = today;
  return line;
}

function statusLine(p) {
  const lv = LVL(p.xp), lo = 40 * (lv - 1) ** 2, hi = 40 * lv * lv;
  return `⭐ Lv.${lv} ${rankOf(lv)}\n${bar((p.xp - lo) / (hi - lo))} ${p.xp - lo}/${hi - lo} XP • 🔥 Streak ${p.streak}`;
}

function levelUpLines(p, before, lines) {
  const lv = LVL(p.xp);
  if (lv > before) lines.push(`🎉 *LEVEL UP!* Kamu sekarang Lv.${lv} — ${rankOf(lv)}`);
  for (const [name, ok] of ACH) if (!p.ach.includes(name) && ok(p)) { p.ach.push(name); lines.push(`🎖️ *Pencapaian baru:* ${name}`); }
}

async function finish(c, game, { win = false, draw = false, close = false, score = 0, xp = 10 }) {
  const p = profile(c), before = LVL(p.xp), lines = [];
  p.played++;
  if (draw) {
    xp = Math.max(4, Math.round(xp * 0.6));
    lines.push(pick(FEEL.draw));
  } else if (win) {
    const wasLosing = p.lossStreak >= 2, crit = Math.random() < 0.15; // hadiah kejutan acak
    p.wins++; p.streak++; p.lossStreak = 0; p.bestStreak = Math.max(p.bestStreak, p.streak);
    xp = Math.round(xp * (1 + Math.min(p.streak, 5) * 0.1) * (crit ? 2 : 1));
    if (crit) lines.push('🎁 *BONUS KEJUTAN!* XP x2');
    lines.push(pick(wasLosing ? FEEL.comeback : FEEL.win));
    if (FEEL.streak[p.streak]) lines.push(FEEL.streak[p.streak]);
  } else {
    p.streak = 0; p.lossStreak++;
    xp = Math.max(3, Math.round(xp * 0.4)); // usaha tetap dihargai
    lines.push(pick(p.lossStreak >= 3 ? FEEL.frustrated : close ? FEEL.near : FEEL.lose));
  }
  const prev = p.best[game] || 0;
  if (score > prev) { p.best[game] = score; if (prev) lines.push(pick(FEEL.pb)); }
  p.xp += xp;
  levelUpLines(p, before, lines);
  p.recent = [...p.recent, Date.now()].filter((t) => Date.now() - t < 36e5).slice(-12);
  if (p.recent.length >= 8) { lines.push(FEEL.rest); p.recent = []; }
  await c.saveMemory();
  return { text: `${lines.join('\n')}\n✨ +${xp} XP`, status: statusLine(p) };
}

async function addXp(c, p, xp) { // XP ringan di luar game utama (hiburan harian)
  const before = LVL(p.xp), lines = [];
  p.xp += xp;
  levelUpLines(p, before, lines);
  await c.saveMemory();
  return lines;
}

/* ═════════════════════════ SESI & TAMPILAN ═════════════════════════ */

const sessions = new Map();
const TTL = 10 * 60 * 1000;
const key = (c) => `${c.jid}|${c.senderNum}`;
const AGAIN = { kuro: 'kuroslash', sonic: 'sonic', angka: 'game', math: 'mathgame', kata: 'tebakkata', suit: 'suit', dice: 'dice', coin: 'coin', wyr: 'wyr' };
const BTN = {
  again: (type) => ({ text: '🔁 MAIN LAGI', id: AGAIN[type] }),
  profile: { text: '🏆 PROFIL', id: 'gameprofil' },
  menu: { text: '🎮 MENU GAME', id: 'allmenu fun' },
};

function open(c, s) {
  if (sessions.size > 500) for (const [k, v] of sessions) if (Date.now() - v.t > TTL) sessions.delete(k);
  const full = { ...s, t: Date.now() };
  sessions.set(key(c), full);
  return full;
}

const ui = (c, title, body, buttons) => sendNativeInteractiveButtons(c.sock, c.jid, { title, body: body.slice(0, 1000), buttons }, c.msg);

async function endGame(c, type, title, summary, result) {
  const f = await finish(c, type, result);
  sessions.delete(key(c));
  return ui(c, title, `${summary}\n\n${f.text}\n\n${f.status}`, [BTN.again(type), BTN.profile, BTN.menu]);
}

const quit = (c, s, text = '') => {
  sessions.delete(key(c));
  return ui(c, '🛑 PERMAINAN DIHENTIKAN', `${text}\nTanpa penalti — progresmu aman.`.trim(), [BTN.again(s.type), BTN.profile, BTN.menu]);
};

const newSession = (c, s) => {
  const p = profile(c);
  return { session: open(c, { ...s, assist: p.lossStreak >= 3 }), p, head: intro(c) };
};

/* ═════════════════════════ GAME ═════════════════════════ */

const G = {};

/* ── ⚔️ Kuro Slash: baca pola serangan, PARRY untuk menang ── */
const LANES = ['KIRI', 'TENGAH', 'KANAN'];
const ONI = [['Oni Kecil', '👹'], ['Oni Bertanduk', '👺'], ['Oni Bayangan', '🥷'], ['Oni Raja', '👑']];
const spawn = (wave) => { const [name, emoji] = ONI[Math.min(wave - 1, ONI.length - 1)]; const hp = 30 + wave * 14; return { name, emoji, hp, max: hp }; };
const danger = (s) => {
  if (s.calm >= 2) return { lanes: [0, 1, 2], text: '🔥 *OTORI MENGAMUK!* Semua jalur bahaya — TEBAS untuk PARRY!' };
  if (Math.random() < 0.4) { const safe = rand(3); return { lanes: [0, 1, 2].filter((x) => x !== safe), text: `⚠️ *SAPUAN!* Hanya jalur *${LANES[safe]}* yang aman!` }; }
  const l = rand(3);
  return { lanes: [l], text: `⚠️ Oni akan menebas jalur *${LANES[l]}*!` };
};
const arena = (s) => [0, 1, 2].map((i) => { const hot = s.threat.lanes.includes(i); return i === s.lane ? (hot ? '🥷💢' : '🥷') : hot ? '⚠️' : '⬜'; }).join(' | ');
const kuroView = (c, s, log = '', head = '') => ui(c, `⚔️ KURO SLASH — GELOMBANG ${s.wave}`,
  `${head}${s.enemy.emoji} ${s.enemy.name}  ${bar(s.enemy.hp / s.enemy.max)} ${Math.max(0, s.enemy.hp)}/${s.enemy.max}\n❤️ ${bar(s.hp / 100)} ${Math.max(0, s.hp)}%\n⚡ ULTI ${s.ulti}%${s.ulti >= 100 ? ' — *SIAP!*' : ''}  🔥 Combo x${s.combo}\n\n[ ${arena(s)} ]\n${s.threat.text}${log ? `\n\n💬 _${log}_` : ''}`,
  [{ text: '⬅️ KIRI', id: 'kiri' }, { text: s.ulti >= 100 ? '🌊 ULTI' : '⚔️ TEBAS', id: 'tebas' }, { text: '➡️ KANAN', id: 'kanan' }]);
const kuroEnd = (c, s) => endGame(c, 'kuro', '⚔️ KURO SLASH — GAME OVER', `${s.enemy.emoji} ${s.enemy.name} menang di gelombang *${s.wave}*.\n🏆 Skor: *${s.score}*`, { win: s.wave >= 4, close: s.wave === 3, score: s.score, xp: 10 + s.wave * 6 });

G.kuro = {
  start(c) {
    const { session: s, head } = newSession(c, { type: 'kuro', hp: 100, lane: 1, ulti: 20, score: 0, wave: 1, combo: 0, calm: 0 });
    s.enemy = spawn(1); s.threat = danger(s);
    return kuroView(c, s, s.assist ? 'Mode santai aktif 💙 — baca pola, lalu pilih langkahmu!' : 'Baca pola serangannya lalu pilih langkahmu!', head);
  },
  async input(c, s, act) {
    if (!['kiri', 'kanan', 'tebas', 'ulti'].includes(act)) return false;
    if (act === 'ulti' && s.ulti < 100) { await kuroView(c, s, `ULTI baru ${s.ulti}% — isi dengan PARRY & menghindar!`); return true; }
    const e = s.enemy;
    const useUlti = s.ulti >= 100 && (act === 'tebas' || act === 'ulti');
    if (act === 'kiri') s.lane = Math.max(0, s.lane - 1);
    if (act === 'kanan') s.lane = Math.min(2, s.lane + 1);
    const hot = s.threat.lanes.includes(s.lane);
    const dmgIn = Math.round((12 + s.wave * 4) * (s.assist ? 0.7 : 1));
    let log;
    if (useUlti) { e.hp = 0; s.ulti = 0; s.score += 300; s.combo++; log = '🌊 GELOMBANG ULTI menghancurkan musuh! (+300)'; }
    else if (act === 'tebas' && hot) { const d = 22 + rand(14) + s.combo * 2; e.hp -= d; s.ulti = Math.min(100, s.ulti + 25); s.combo++; s.score += 120 + s.combo * 10; s.calm = 0; log = `⚔️ PARRY SEMPURNA! Counter ${d} dmg`; }
    else if (act === 'tebas') { s.combo = 0; s.calm++; s.ulti = Math.min(100, s.ulti + 5); log = 'Tebasanmu hanya mengenai angin...'; }
    else if (hot) { s.hp -= dmgIn; s.combo = 0; s.calm++; log = `💥 Terkena serangan! -${dmgIn} HP`; }
    else { s.combo++; s.calm++; s.score += 60; s.ulti = Math.min(100, s.ulti + 15); log = 'Menghindar dengan mulus! (+60)'; }
    if (s.threat.lanes.length === 3) s.calm = 0;
    if (s.hp <= 0) { await kuroEnd(c, s); return true; }
    if (e.hp <= 0) { s.hp = Math.min(100, s.hp + 10); s.wave++; s.score += 200; log += ` ${e.name} tumbang! +10 HP`; s.enemy = spawn(s.wave); }
    s.threat = danger(s);
    await kuroView(c, s, log);
    return true;
  },
  stop: (c, s) => kuroEnd(c, s),
};

/* ── 🌀 Speedy Dash: balas cepat sebelum waktu habis ── */
const OBS = [{ e: '⚡', n: 'Laser', need: 'jump' }, { e: '🕳️', n: 'Lubang', need: 'jump' }, { e: '🧱', n: 'Tembok', need: 'boost' }, { e: '🌀', n: 'Pusaran', need: 'boost' }];
const sonicWin = (s) => Math.round(clamp(15 - s.speed * 1.2, 7, 15) + (s.assist ? 4 : 0));
const sonicNext = (s) => { s.obs = pick(OBS); s.deadline = Date.now() + (sonicWin(s) + 3) * 1000; };
const sonicView = (c, s, log = '', head = '') => ui(c, '🌀 SPEEDY DASH — SONIC RUN',
  `${head}${'❤️'.repeat(s.lives)}${'🖤'.repeat(s.maxLives - s.lives)}  💍 ${s.rings}  🚀 Kecepatan ${s.speed}\n📍 Jarak: ${s.dist} rintangan • 🏆 ${s.score}\n\n${s.obs.e} *${s.obs.n} di depan!*\n_Legenda: ⚡🕳️ = JUMP • 🧱🌀 = BOOST_\n⏱️ Balas dalam ${sonicWin(s)} detik!${log ? `\n\n💬 _${log}_` : ''}`,
  [{ text: '⬆️ JUMP', id: 'jump' }, { text: '⚡ BOOST', id: 'boost' }, { text: '🛑 STOP', id: 'stopgame' }]);
const sonicEnd = (c, s) => endGame(c, 'sonic', '🌀 SPEEDY DASH — SELESAI', `📍 Jarak tempuh: *${s.dist}* rintangan\n💍 Ring: *${s.rings}* • 🏆 Skor: *${s.score}*`, { win: s.dist >= 12, close: s.dist >= 9, score: s.score, xp: 8 + s.dist * 2 });

G.sonic = {
  start(c) {
    const { session: s, head } = newSession(c, { type: 'sonic', rings: 0, score: 0, dist: 0, speed: 1, perfect: 0 });
    s.lives = s.maxLives = s.assist ? 4 : 3;
    sonicNext(s);
    return sonicView(c, s, s.assist ? 'Mode santai aktif 💙 — waktu lebih longgar!' : 'Lari! Baca rintangan & balas dengan cepat!', head);
  },
  async input(c, s, act) {
    if (!['jump', 'boost'].includes(act)) return false;
    const late = Date.now() > s.deadline, ok = !late && act === s.obs.need;
    let log;
    s.dist++;
    if (ok) {
      s.perfect++;
      if (s.perfect % 4 === 0) s.speed = Math.min(7, s.speed + 1);
      const gain = 3 + s.speed;
      s.rings += gain; s.score += Math.round(50 * s.speed * (1 + s.perfect * 0.05));
      log = `✅ ${act === 'boost' ? '⚡ BOOST' : '⬆️ JUMP'} sempurna! +${gain} 💍`;
      if (Math.random() < 0.15) { s.rings += 10; s.score += 100; log += ' 🎁 RING SHOWER +10!'; }
    } else {
      s.lives--; s.perfect = 0; s.speed = Math.max(1, s.speed - 1);
      log = late ? '⏱️ Terlambat! Kamu menabrak.' : `💥 Salah aksi! ${s.obs.n} butuh ${s.obs.need.toUpperCase()}.`;
    }
    if (s.lives <= 0) { await sonicEnd(c, s); return true; }
    sonicNext(s);
    await sonicView(c, s, log);
    return true;
  },
  stop: (c, s) => sonicEnd(c, s),
};

/* ── 🎯 Tebak Angka: panas-dingin dengan kesempatan terbatas ── */
const angkaMax = (p) => (p.wins < 3 ? 10 : p.wins < 8 ? 25 : p.wins < 15 ? 50 : 100);
const angkaView = (c, s, log = '', head = '') => ui(c, `🎯 TEBAK ANGKA 1–${s.max}`,
  `${head}🎟️ Kesempatan: ${'🟢'.repeat(s.left)}${'⚫'.repeat(s.tries - s.left)}\n📏 Rentang: ${s.lo} – ${s.hi}${log ? `\n\n💬 ${log}` : ''}\n\n_Ketik angka tebakanmu!_`,
  [{ text: '💡 PETUNJUK', id: 'petunjuk' }, { text: '🛑 STOP', id: 'stopgame' }]);

G.angka = {
  start(c) {
    const p = profile(c), asked = parseInt(c.param, 10);
    const max = asked >= 5 && asked <= 1000 ? asked : angkaMax(p);
    const { session: s, head } = newSession(c, { type: 'angka', max, ans: rand(max) + 1, lo: 1, hi: max, hints: 0 });
    s.tries = s.left = Math.ceil(Math.log2(max)) + 2 + (s.assist ? 2 : 0);
    return angkaView(c, s, s.assist ? 'Mode santai aktif 💙 — kesempatan ekstra!' : 'Aku sudah memikirkan satu angka... bisa kamu tebak?', head);
  },
  async input(c, s, act) {
    if (act === 'petunjuk') {
      if (s.hints >= 2 || s.left <= 1) { await angkaView(c, s, 'Petunjuk tidak tersedia lagi.'); return true; }
      s.hints++; s.left--;
      const mid = Math.floor((s.lo + s.hi) / 2);
      await angkaView(c, s, s.hints === 1 ? `💡 Angkanya *${s.ans % 2 ? 'ganjil' : 'genap'}*.` : s.ans > mid ? `💡 Angkanya *lebih besar dari ${mid}*.` : `💡 Angkanya *${mid} atau kurang*.`);
      return true;
    }
    if (!/^\d+$/.test(act)) return false;
    const g = parseInt(act, 10);
    if (g < 1 || g > s.max) { await angkaView(c, s, `Angka harus di antara 1 dan ${s.max}.`); return true; }
    if (g === s.ans) {
      await endGame(c, 'angka', '🎯 TEBAK ANGKA — BENAR!', `🎉 Angkanya *${s.ans}*! Ditebak dengan sisa *${s.left}* kesempatan.`, { win: true, score: s.left * 100 + s.max, xp: 8 + s.left * 3 + Math.round(s.max / 10) });
      return true;
    }
    s.left--;
    if (g < s.ans) s.lo = Math.max(s.lo, g + 1); else s.hi = Math.min(s.hi, g - 1);
    const d = Math.abs(g - s.ans) / s.max;
    const heat = d <= 0.05 ? '🔥 PANAS BANGET!' : d <= 0.15 ? '🌡️ Hangat...' : d <= 0.35 ? '🧊 Dingin.' : '❄️ Beku!';
    if (s.left <= 0) {
      await endGame(c, 'angka', '🎯 TEBAK ANGKA — KESEMPATAN HABIS', `Angkanya adalah *${s.ans}*.`, { win: false, close: d <= 0.1, score: 0, xp: 8 });
      return true;
    }
    await angkaView(c, s, `${heat} ${g < s.ans ? '⬆️ Terlalu kecil' : '⬇️ Terlalu besar'}`);
    return true;
  },
  stop: (c, s) => quit(c, s, `Angkanya adalah *${s.ans}*.`),
};

/* ── 🧮 Math Rush: 5 soal berwaktu, makin cepat makin tinggi skor ── */
const MQ = [
  () => { const a = rand(15) + 2, b = rand(15) + 2; return rand(2) ? [`${a} + ${b}`, a + b] : [`${a + b} − ${b}`, a]; },
  () => { const a = rand(8) + 2, b = rand(8) + 2; return [`${a} × ${b}`, a * b]; },
  () => { const a = rand(40) + 10, b = rand(40) + 10, k = rand(9) + 2; return [`(${a} + ${b}) − ${k}`, a + b - k]; },
  () => { const a = rand(9) + 3, b = rand(9) + 3, k = rand(20) + 5; return [`${a} × ${b} + ${k}`, a * b + k]; },
];
const mathLimit = (s) => (s.assist ? 30 : 20);
const mathNext = (s) => { s.n++; s.q = MQ[rand(s.tier + 1)](); s.at = Date.now(); };
const mathView = (c, s, log = '', head = '') => ui(c, `🧮 MATH RUSH — SOAL ${s.n}/${s.total}`,
  `${head}✅ ${s.ok} benar • 🔥 Beruntun ${s.streak} • 🏆 ${s.score}\n\n*${s.q[0]} = ?*\n⏱️ ${mathLimit(s)} detik — makin cepat, makin besar poinnya!${log ? `\n\n💬 ${log}` : ''}`,
  [{ text: '🛑 STOP', id: 'stopgame' }]);

G.math = {
  start(c) {
    const p = profile(c);
    const { session: s, head } = newSession(c, { type: 'math', total: 5, n: 0, ok: 0, score: 0, streak: 0, tier: Math.min(3, Math.floor(LVL(p.xp) / 3)) });
    mathNext(s);
    return mathView(c, s, s.assist ? 'Mode santai aktif 💙 — waktu lebih longgar!' : 'Siap? Jawab dengan angka!', head);
  },
  async input(c, s, act) {
    if (!/^-?\d+$/.test(act)) return false;
    const secs = (Date.now() - s.at) / 1000, late = secs > mathLimit(s) + 3, right = parseInt(act, 10) === s.q[1];
    let log;
    if (right && !late) {
      s.ok++; s.streak++;
      const pts = 100 + Math.max(0, Math.round((mathLimit(s) - secs) * 5)) + s.streak * 10;
      s.score += pts;
      log = `✅ Benar! +${pts}${secs < 5 ? ' ⚡ Secepat kilat!' : ''}`;
    } else {
      s.streak = 0;
      log = right ? `⏱️ Benar, tapi terlambat (jawaban *${s.q[1]}*).` : `❌ Jawaban yang benar: *${s.q[1]}*. ${pick(['Tidak apa-apa, lanjut!', 'Satu soal tidak menentukan segalanya.', 'Fokus ke soal berikutnya! 💪'])}`;
    }
    if (s.n >= s.total) {
      await endGame(c, 'math', '🧮 MATH RUSH — SELESAI', `${log}\n\n🎯 Akurasi: *${s.ok}/${s.total}* • 🏆 Skor: *${s.score}*`, { win: s.ok >= 3, close: s.ok === 2, score: s.score, xp: 8 + s.ok * 4 });
      return true;
    }
    mathNext(s);
    await mathView(c, s, log);
    return true;
  },
  stop: (c, s) => quit(c, s, `Skor sementara: *${s.score}*.`),
};

/* ── 🔤 Tebak Kata: gaya hangman dengan petunjuk ── */
const WORDS = [
  ['harimau', 'Hewan'], ['kucing', 'Hewan'], ['jerapah', 'Hewan'], ['kelinci', 'Hewan'], ['gajah', 'Hewan'],
  ['komputer', 'Benda'], ['telepon', 'Benda'], ['payung', 'Benda'], ['kacamata', 'Benda'], ['sepeda', 'Benda'],
  ['rendang', 'Makanan'], ['martabak', 'Makanan'], ['bakso', 'Makanan'], ['gudeg', 'Makanan'], ['serabi', 'Makanan'],
  ['jakarta', 'Tempat'], ['pelabuhan', 'Tempat'], ['gunung', 'Tempat'], ['pantai', 'Tempat'], ['perpustakaan', 'Tempat'],
  ['pelangi', 'Alam'], ['matahari', 'Alam'], ['bintang', 'Alam'], ['samudra', 'Alam'],
  ['dokter', 'Profesi'], ['petani', 'Profesi'], ['pilot', 'Profesi'], ['nelayan', 'Profesi'],
  ['internet', 'Teknologi'], ['aplikasi', 'Teknologi'], ['robot', 'Teknologi'], ['kamera', 'Teknologi'],
];
const maskOf = (s) => [...s.word].map((ch) => (s.got.has(ch) ? ch.toUpperCase() : '_')).join(' ');
const solved = (s) => [...s.word].every((ch) => s.got.has(ch));
const kataView = (c, s, log = '', head = '') => ui(c, '🔤 TEBAK KATA',
  `${head}📂 Kategori: *${s.cat}* (${s.word.length} huruf)\n\n*${maskOf(s)}*\n\n${'❤️'.repeat(s.lives)}${'🖤'.repeat(s.maxLives - s.lives)}\n❌ Salah: ${s.wrong.join(' ').toUpperCase() || '-'}\n💡 Petunjuk tersisa: ${2 - s.hints}${log ? `\n\n💬 ${log}` : ''}\n\n_Ketik 1 huruf atau tebak seluruh kata!_`,
  [{ text: '💡 PETUNJUK', id: 'petunjuk' }, { text: '🛑 STOP', id: 'stopgame' }]);
const kataWin = (c, s) => endGame(c, 'kata', '🔤 TEBAK KATA — BENAR!', `🎉 Katanya *${s.word.toUpperCase()}*!`, { win: true, score: Math.max(0, s.lives * 50 + s.word.length * 10 - s.hints * 20), xp: Math.max(6, 10 + s.lives * 2 - s.hints * 2) });
const kataLose = (c, s) => endGame(c, 'kata', '🔤 TEBAK KATA — NYARIS!', `Katanya adalah *${s.word.toUpperCase()}*.`, { win: false, close: [...s.word].filter((ch) => !s.got.has(ch)).length <= 2, score: 0, xp: 8 });

G.kata = {
  start(c) {
    const [word, cat] = pick(WORDS);
    const { session: s, head } = newSession(c, { type: 'kata', word, cat, got: new Set(), wrong: [], hints: 0 });
    s.lives = s.maxLives = s.assist ? 8 : 6;
    return kataView(c, s, s.assist ? 'Mode santai aktif 💙 — nyawa ekstra!' : 'Tebak huruf demi huruf!', head);
  },
  async input(c, s, act) {
    let log;
    if (act === 'petunjuk') {
      const left = [...new Set(s.word)].filter((ch) => !s.got.has(ch));
      if (s.hints >= 2 || left.length <= 1) { await kataView(c, s, 'Petunjuk tidak tersedia lagi.'); return true; }
      const ch = pick(left);
      s.got.add(ch); s.hints++;
      log = `💡 Satu huruf terbuka: *${ch.toUpperCase()}*`;
    } else if (/^[a-z]$/.test(act)) {
      if (s.got.has(act) || s.wrong.includes(act)) { await kataView(c, s, `Huruf *${act.toUpperCase()}* sudah ditebak.`); return true; }
      if (s.word.includes(act)) { s.got.add(act); log = `✅ Ada huruf *${act.toUpperCase()}*!`; }
      else { s.wrong.push(act); s.lives--; log = `❌ Tidak ada huruf *${act.toUpperCase()}*.`; }
    } else if (/^[a-z]{2,}$/.test(act) && act.length === s.word.length && !c.isCommand(act)) {
      if (act === s.word) { await kataWin(c, s); return true; }
      s.lives--; log = `❌ Bukan *${act.toUpperCase()}*.`;
    } else return false;
    if (solved(s)) { await kataWin(c, s); return true; }
    if (s.lives <= 0) { await kataLose(c, s); return true; }
    await kataView(c, s, log);
    return true;
  },
  stop: (c, s) => quit(c, s, `Katanya adalah *${s.word.toUpperCase()}*.`),
};

/* ── ✊ Suit Duel: bot belajar kebiasaanmu, jangan mudah ditebak ── */
const MOVES = ['batu', 'gunting', 'kertas'];
const EMO = { batu: '✊', gunting: '✌️', kertas: '✋' };
const BEATS = { batu: 'gunting', gunting: 'kertas', kertas: 'batu' };
const counterOf = (m) => MOVES.find((k) => BEATS[k] === m);
const suitView = (c, s, log = '', head = '') => ui(c, `✊✌️✋ SUIT DUEL — RONDE ${s.round + 1}`,
  `${head}🧑 ${s.me}  ⚔️  ${s.bot} 🤖  _(duluan 2 menang)_${log ? `\n\n${log}` : '\n\nPilih senjatamu!'}`,
  MOVES.map((m) => ({ text: `${EMO[m]} ${m.toUpperCase()}`, id: m })));

async function suitPlay(c, s, move) {
  const p = profile(c);
  const fav = MOVES.reduce((a, b) => ((p.rps[a] || 0) >= (p.rps[b] || 0) ? a : b));
  const learned = MOVES.some((m) => (p.rps[m] || 0) > 2);
  const read = learned && Math.random() < (s.assist ? 0.2 : 0.45);
  const bot = read ? counterOf(fav) : pick(MOVES);
  p.rps[move] = (p.rps[move] || 0) + 1;
  s.round++;
  let verdict;
  if (move === bot) verdict = '🤝 Seri!';
  else if (BEATS[move] === bot) { s.me++; verdict = pick(['🎉 Kamu menang ronde ini!', '😮 Kamu bikin aku ragu!']); }
  else { s.bot++; verdict = read ? `😏 Aku membaca polamu — kamu sering memilih *${fav.toUpperCase()}*.` : '🤖 Aku menang ronde ini!'; }
  const log = `${EMO[move]} vs ${EMO[bot]}\n${verdict}`;
  if (s.me >= 2 || s.bot >= 2) {
    await endGame(c, 'suit', '✊✌️✋ SUIT DUEL — SELESAI', `${log}\n\nSkor akhir: 🧑 ${s.me} — ${s.bot} 🤖`, { win: s.me > s.bot, close: s.me === 1, score: s.me * 100 - s.bot * 20 + 20, xp: 10 + s.me * 4 });
    return true;
  }
  await suitView(c, s, log);
  return true;
}

G.suit = {
  async start(c) {
    const { session: s, head } = newSession(c, { type: 'suit', me: 0, bot: 0, round: 0 });
    const first = c.param.toLowerCase();
    if (MOVES.includes(first)) return suitPlay(c, s, first);
    return suitView(c, s, s.assist ? 'Mode santai aktif 💙 — aku lebih sulit membaca polamu.' : '', head);
  },
  input: async (c, s, act) => (MOVES.includes(act) ? suitPlay(c, s, act) : false),
  stop: (c, s) => quit(c, s, `Skor sementara: 🧑 ${s.me} — ${s.bot} 🤖`),
};

/* ── 🎲 Dadu Duel: lempar, tahan, atau ulang dengan berani ── */
const FACE = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const roll2 = () => [rand(6), rand(6)];
const total = ([a, b]) => a + b + 2 + (a === b ? 2 : 0);
const showRoll = (r) => `${FACE[r[0]]} ${FACE[r[1]]} = *${total(r)}*${r[0] === r[1] ? ' (kembar +2 ✨)' : ''}`;
const diceBoard = (s) => `Ronde ${Math.min(s.round + 1, 3)}/3 • 🧑 ${s.me} — ${s.bot} 🤖 • 🔁 Ulang: ${s.rerolls}`;
const diceRollBtn = [{ text: '🎲 LEMPAR', id: 'lempar' }, { text: '🛑 STOP', id: 'stopgame' }];

async function diceResolve(c, s, note = '') {
  let br = roll2(), botNote = '';
  if (!s.assist && total(br) <= 6 && s.botRerolls > 0) { s.botRerolls--; br = roll2(); botNote = '\n🤖 Bot melempar ulang!'; }
  const mine = total(s.mine), theirs = total(br);
  let verdict;
  if (mine > theirs) { s.me++; verdict = '🎉 Kamu menang ronde ini!'; }
  else if (mine < theirs) { s.bot++; verdict = '🤖 Bot menang ronde ini.'; }
  else verdict = '🤝 Seri ronde ini.';
  s.round++; s.phase = 'roll';
  const log = `${note}Kamu: ${showRoll(s.mine)}\nBot: ${showRoll(br)}${botNote}\n${verdict}`;
  if (s.round >= 3) {
    await endGame(c, 'dice', '🎲 DADU DUEL — SELESAI', `${log}\n\nSkor akhir: 🧑 ${s.me} — ${s.bot} 🤖`, { win: s.me > s.bot, draw: s.me === s.bot, close: s.bot - s.me === 1, score: s.me * 100 + 50, xp: 10 + s.me * 4 });
    return true;
  }
  await ui(c, '🎲 DADU DUEL', `${log}\n\n${diceBoard(s)}`, diceRollBtn);
  return true;
}

G.dice = {
  start(c) {
    const { session: s, head } = newSession(c, { type: 'dice', me: 0, bot: 0, round: 0, rerolls: 2, botRerolls: 1, phase: 'roll' });
    return ui(c, '🎲 DADU DUEL', `${head}Menang 2 dari 3 ronde! Kamu punya *2x lempar ulang* — gunakan dengan bijak.\nKembar memberi bonus +2.${s.assist ? '\n\nMode santai aktif 💙 — bot tidak akan melempar ulang.' : ''}\n\n${diceBoard(s)}`, diceRollBtn);
  },
  async input(c, s, act) {
    if (s.phase === 'roll' && act === 'lempar') {
      s.mine = roll2(); s.phase = 'decide';
      const btns = [{ text: '✅ TAHAN', id: 'tahan' }, ...(s.rerolls > 0 ? [{ text: `🔁 ULANG (${s.rerolls})`, id: 'ulang' }] : []), { text: '🛑 STOP', id: 'stopgame' }];
      await ui(c, '🎲 DADU DUEL', `Lemparanmu: ${showRoll(s.mine)}\n\nTahan hasil ini atau berani lempar ulang? (hasil ulang *wajib* dipakai)\n\n${diceBoard(s)}`, btns);
      return true;
    }
    if (s.phase === 'decide' && act === 'tahan') return diceResolve(c, s);
    if (s.phase === 'decide' && act === 'ulang' && s.rerolls > 0) {
      const before = total(s.mine);
      s.rerolls--; s.mine = roll2();
      const after = total(s.mine);
      return diceResolve(c, s, after > before ? '🎯 Lempar ulang jitu!\n' : after < before ? '😬 Lempar ulang malah turun — berani tapi berisiko!\n' : '😐 Lempar ulang hasilnya sama.\n');
    }
    return false;
  },
  stop: (c, s) => quit(c, s, `Skor sementara: 🧑 ${s.me} — ${s.bot} 🤖`),
};

/* ── 🪙 Koin Beruntun: ambil XP atau pertaruhkan streak ── */
const coinView = (c, s, log = '', head = '') => ui(c, '🪙 KOIN BERUNTUN',
  `${head}🔥 Streak: *${s.streak}* • 🎁 Pot: *${s.pot} XP*${log ? `\n\n${log}` : ''}\n\nTebak sisi koin! Salah = pot hangus. *Ambil* kapan saja.\n_XP hanya poin game, bukan uang. Koin selalu 50:50 — lemparan lalu tidak memengaruhi berikutnya._`,
  [{ text: '🪙 ANGKA', id: 'angka' }, { text: '🖼️ GAMBAR', id: 'gambar' }, { text: '💰 AMBIL', id: 'ambil' }]);

async function coinCash(c, s) {
  await endGame(c, 'coin', '🪙 KOIN BERUNTUN — DIAMBIL', `💰 Kamu mengambil pot *${s.pot} XP* dengan streak *${s.streak}*. Keputusan yang bijak!`, { win: true, score: s.streak * 100, xp: s.pot });
  return true;
}
async function coinFlip(c, s, guess) {
  const res = rand(2) ? 'angka' : 'gambar';
  if (res !== guess) {
    await endGame(c, 'coin', '🪙 KOIN BERUNTUN — MELESET', `Koin mendarat *${res.toUpperCase()}*. Streak berakhir di *${s.streak}*.`, { win: false, close: s.streak >= 4, score: s.streak * 100, xp: 6 + s.streak });
    return true;
  }
  s.streak++; s.pot += 4 * s.streak;
  if (s.streak >= 8) return coinCash(c, s);
  await coinView(c, s, `✅ Koin mendarat *${res.toUpperCase()}*! Tebakanmu benar.`);
  return true;
}

G.coin = {
  start(c) {
    const { session: s, head } = newSession(c, { type: 'coin', streak: 0, pot: 0 });
    const first = c.param.toLowerCase();
    return ['angka', 'gambar'].includes(first) ? coinFlip(c, s, first) : coinView(c, s, '', head);
  },
  async input(c, s, act) {
    if (act === 'ambil') {
      if (s.streak < 1) { await coinView(c, s, 'Belum ada yang bisa diambil — tebak dulu!'); return true; }
      return coinCash(c, s);
    }
    return ['angka', 'gambar'].includes(act) ? coinFlip(c, s, act) : false;
  },
  stop: (c, s) => (s.streak >= 1 ? coinCash(c, s) : quit(c, s)),
};

/* ── 🤔 Would You Rather: pilihan yang mengungkap sifat ── */
const WYR = [
  ['Berani mencoba hal baru walau mungkin gagal', 'Tetap di jalur yang sudah pasti aman', 'kamu tipe yang berani mengambil risiko demi tumbuh 🚀', 'kamu tipe yang menghargai stabilitas dan ketenangan 🛡️'],
  ['Punya sedikit teman tapi sangat dekat', 'Punya banyak kenalan di mana-mana', 'kamu menghargai kedalaman hubungan 💞', 'kamu menikmati energi dan keberagaman orang 🌍'],
  ['Tahu masa depanmu', 'Bisa mengubah masa lalumu', 'kamu ingin kendali atas apa yang akan datang 🔮', 'kamu masih membawa pelajaran dari masa lalu ⏪'],
  ['Sukses besar tapi sendirian', 'Hidup biasa tapi dikelilingi orang tercinta', 'ambisimu besar dan kamu siap berkorban 🏔️', 'kebahagiaanmu ada pada kebersamaan 🏡'],
  ['Selalu jujur walau menyakitkan', 'Berbohong kecil demi menjaga perasaan', 'kamu memegang teguh kejujuran ⚖️', 'kamu mengutamakan perasaan orang lain 🤗'],
];
G.wyr = {
  start(c) {
    const { session: s, head } = newSession(c, { type: 'wyr', q: pick(WYR) });
    return ui(c, '🤔 WOULD YOU RATHER', `${head}Pilih salah satu:\n\n🅰️ ${s.q[0]}\n\n🅱️ ${s.q[1]}`, [{ text: '🅰️ A', id: 'opsia' }, { text: '🅱️ B', id: 'opsib' }, { text: '🔁 BARU', id: 'wyr' }]);
  },
  async input(c, s, act) {
    if (!['opsia', 'opsib'].includes(act)) return false;
    const a = act === 'opsia';
    sessions.delete(key(c));
    await ui(c, '🤔 PILIHANMU', `Kamu memilih *${a ? 'A' : 'B'}*: ${s.q[a ? 0 : 1]}\n\n🧠 Menurutku, ${s.q[a ? 2 : 3]}\n_(Hanya tebakan seru — bukan penilaian sungguhan!)_`, [{ text: '🔁 PERTANYAAN BARU', id: 'wyr' }, BTN.profile, BTN.menu]);
    return true;
  },
  stop: (c) => { sessions.delete(key(c)); return c.reply('🛑 Selesai.'); },
};

/* ═════════════════════════ HIBURAN HARIAN ═════════════════════════ */

/* ── 🔮 8ball: jawaban konsisten per hari ── */
const BALL = {
  yes: ['Ya, tanpa ragu! ✅', 'Semua tanda mengarah ke ya. 🌟', 'Tentu saja — percaya pada dirimu.'],
  maybe: ['Mungkin… tergantung usahamu. ⚖️', 'Kabut tebal, tanya lagi saat hatimu tenang. 🌫️', 'Peluangnya seimbang — kamu yang menentukan.'],
  no: ['Sepertinya belum saatnya. 🌧️', 'Jawabannya tidak, tapi ada jalan lain. 🛤️', 'Bukan sekarang — dan itu bukan akhir.'],
};
const ball = (c) => {
  if (!c.param) return ui(c, '🔮 BOLA KRISTAL', 'Tanyakan sesuatu dengan menulis:\n`.8ball apakah hari ini hariku?`', [BTN.profile, BTN.menu]);
  const h = hash01(`${dayStr()}|${c.param.toLowerCase()}|${c.senderNum}`);
  const pool = BALL[h < 0.4 ? 'yes' : h < 0.7 ? 'maybe' : 'no'];
  return ui(c, '🔮 BOLA KRISTAL', `❓ _${c.param}_\n\n🔮 ${pool[Math.floor(h * 1000) % pool.length]}\n🎯 Keyakinan: *${55 + Math.floor(h * 40)}%*\n\n_Pertanyaan yang sama hari ini menghasilkan jawaban yang sama._`, [{ text: '🔮 TANYA LAGI', id: '8ball' }, BTN.profile, BTN.menu]);
};

/* ── 📊 Rate: hasil konsisten sepanjang hari (ritual harian) ── */
const RATE = ['rate', 'aura', 'sigma', 'rizz', 'vibe', 'npc', 'maincharacter', 'delulu', 'redflag', 'greenflag', 'compatibility', 'ship'];
const LABEL = { rate: '⭐ RATE', aura: '✨ AURA', sigma: '🗿 SIGMA', rizz: '😏 RIZZ', vibe: '🌈 VIBE', npc: '🤖 NPC-LEVEL', maincharacter: '🎬 MAIN CHARACTER', delulu: '🦄 DELULU', redflag: '🚩 RED FLAG', greenflag: '🟢 GREEN FLAG', compatibility: '💞 KECOCOKAN', ship: '🚢 SHIP' };
const TIER_POS = ['masih pemanasan 🌱', 'lumayan, ada potensi ✨', 'solid di level menengah 😎', 'tinggi banget! 🔥', 'LEGENDARIS 👑'];
const TIER_NEG = ['aman & terkendali ✅', 'ada sedikit catatan 🤏', 'mulai waspada ⚠️', 'cukup mencolok 🚩', 'alarm berbunyi! 🚨'];
const NEGATIVE = ['npc', 'delulu', 'redflag'];

async function rate(c) {
  const p = profile(c), today = dayStr(), duo = ['compatibility', 'ship'].includes(c.cmd);
  let subject = c.param || c.pushName, seed = `${c.senderNum}|${subject.toLowerCase()}`;
  if (duo) {
    const names = c.param.split(/\s*(?:&|\bx\b|\bdan\b|,)\s*/i).filter(Boolean);
    const [a, b] = names.length >= 2 ? names : [c.pushName, names[0] || 'seseorang'];
    subject = `${a} 💞 ${b}`;
    seed = [a, b].map((x) => x.toLowerCase().trim()).sort().join('+');
  }
  const pct = Math.floor(hash01(`${today}|${c.cmd}|${seed}`) * 101);
  const tier = (NEGATIVE.includes(c.cmd) ? TIER_NEG : TIER_POS)[Math.min(4, Math.floor(pct / 20.01))];
  if (p.rd.day !== today) p.rd = { day: today, cmds: [] };
  let bonus = '';
  if (!p.rd.cmds.includes(c.cmd)) { p.rd.cmds.push(c.cmd); bonus = (await addXp(c, p, 2)).join('\n'); }
  return ui(c, `${LABEL[c.cmd]} • ${subject}`, `${bar(pct / 100)} *${pct}%*\n→ ${tier}\n\n_Hasil ini tetap sama sepanjang hari — kembali besok untuk hasil baru!_${bonus ? `\n${bonus}` : ''}`, [BTN.profile, BTN.menu]);
}

/* ── 🎭 Hiburan berbasis AI dengan cadangan lokal ── */
const FUN = {
  roast: { emo: '🔥', prompt: (t) => `Buat 1 roasting ringan, lucu, dan sopan (tanpa SARA/menghina fisik) untuk ${t}.`, fb: ['Kamu itu seperti WiFi gratisan — semua orang butuh tapi sering lemot. 😂', 'Semangatmu 100%, sayangnya baterainya 3%. 🔋', 'Kamu tuh konsisten: konsisten bilang "5 menit lagi". ⏰'] },
  compliment: { emo: '💖', prompt: (t) => `Buat 1 pujian tulus, hangat, dan spesifik untuk ${t}.`, fb: ['Kehadiranmu bikin suasana jadi lebih hangat. ☀️', 'Kamu lebih kuat dari yang kamu kira. 💪', 'Cara kamu peduli ke orang lain itu langka dan berharga. 🌷'] },
  pickup: { emo: '😘', prompt: (t) => `Buat 1 gombalan lucu dan sopan untuk ${t}.`, fb: ['Kamu pasti kopi, soalnya bikin aku melek dan semangat. ☕', 'Kamu itu seperti sinyal — makin dekat makin bikin tenang. 📶', 'Boleh pinjam senyummu? Hari ini aku kehabisan semangat. 😄'] },
  quote: { emo: '📜', prompt: () => 'Buat 1 kutipan motivasi singkat dan bermakna.', fb: ['Langkah kecil yang konsisten mengalahkan lompatan besar yang sesekali.', 'Kamu tidak harus hebat untuk memulai, tapi harus memulai untuk jadi hebat.', 'Jatuh itu wajar; bangun adalah pilihan.'] },
  joke: { emo: '😂', prompt: () => 'Buat 1 lelucon pendek yang lucu dan ramah semua umur.', fb: ['Kenapa programmer tidak suka alam? Karena banyak bug-nya. 🐛', 'Apa bedanya kamu dan kalender? Kalender punya tanggal, kamu punya... kesabaran. 😅', 'Kenapa ayam menyeberang jalan? Karena ada diskon di seberang. 🐔'] },
  truth: { emo: '😇', prompt: () => 'Buat 1 pertanyaan truth yang seru, sopan, dan tidak menyinggung.', fb: ['Hal paling konyol apa yang pernah kamu lakukan demi gengsi?', 'Apa kebiasaan anehmu yang jarang orang tahu?', 'Kapan terakhir kali kamu tertawa sampai sakit perut, dan kenapa?', 'Apa mimpi kecil yang belum berani kamu ceritakan?'] },
  dare: { emo: '😈', prompt: () => 'Buat 1 tantangan dare yang seru, aman, dan sopan.', fb: ['Kirim stiker paling absurdmu ke grup sekarang! 🎭', 'Ceritakan sesuatu yang membanggakan tentang dirimu dalam 1 kalimat. 🌟', 'Tulis pantun spontan untuk orang di atas pesanmu! 🎤', 'Ganti nama panggilanmu jadi hewan favorit selama 10 menit. 🐧'] },
  horoscope: { emo: '🔮', prompt: (t) => `Buat ramalan zodiak singkat, positif, dan menghibur untuk ${t}. Sebutkan ini hanya hiburan.`, fb: ['Hari ini energimu stabil — cocok memulai hal yang tertunda. ✨ (hanya hiburan)', 'Kesempatan kecil datang lewat obrolan santai. Peka ya! 🌙 (hanya hiburan)', 'Waktu yang baik untuk bersyukur dan merapikan rencana. 🍀 (hanya hiburan)'] },
};
const FUN_CMDS = Object.keys(FUN);

async function fun(c) {
  const f = FUN[c.cmd], p = profile(c);
  if (c.cmd === 'horoscope' && !c.param) return ui(c, `${f.emo} HOROSKOP`, 'Sebutkan zodiakmu: `.horoscope leo`', [BTN.menu]);
  const sys = `Kamu adalah teman bermain yang hangat dan lucu. Jawab 1-3 kalimat Bahasa Indonesia.${p.lossStreak >= 2 ? ' Pemain sedang kurang beruntung, beri nuansa menyemangati.' : ''}`;
  const ai = await panggilServerAISatSet(f.prompt(c.param || c.pushName), sys);
  const text = ai && ai.length >= 8 ? ai : pick(f.fb);
  const btns = c.cmd === 'truth' || c.cmd === 'dare'
    ? [{ text: '😇 TRUTH', id: 'truth' }, { text: '😈 DARE', id: 'dare' }, { text: '🎮 MENU GAME', id: 'allmenu fun' }]
    : [{ text: '🔁 LAGI', id: c.cmd }, BTN.profile, BTN.menu];
  return ui(c, `${f.emo} ${c.cmd.toUpperCase()}`, text, btns);
}

/* ── 🤗 Aksi anime: tebar kehangatan ── */
const ACT = { hug: 'memeluk', pat: 'mengelus kepala', wave: 'melambaikan tangan ke', dance: 'mengajak berdansa' };
const WARM = ['Dunia terasa lebih hangat. 💞', 'Satu aksi kecil, dampak besar. 🌸', 'Kebaikan memang menular. ✨'];
async function warmth(c) {
  const p = profile(c), ctx = c.unwrapped.extendedTextMessage?.contextInfo;
  const jid = ctx?.mentionedJid?.[0] || ctx?.participant;
  const label = jid ? `@${jid.split('@')[0].split(':')[0]}` : c.param || 'semuanya';
  p.kind++;
  const lines = await addXp(c, p, 1);
  const caption = `*${c.pushName}* ${ACT[c.cmd]} *${label}* 💞\n_${pick(WARM)}_\n🤗 Total kehangatanmu: *${p.kind}*${lines.length ? `\n${lines.join('\n')}` : ''}`;
  const url = await getAnimeImageUrl(c.cmd);
  return c.send(url ? { image: { url }, caption, mentions: jid ? [jid] : [] } : { text: caption, mentions: jid ? [jid] : [] });
}

/* ═════════════════════════ PROFIL, PERINGKAT & BONUS HARIAN ═════════════════════════ */

const profilCard = (c) => {
  const p = profile(c), lv = LVL(p.xp), next = 40 * lv * lv - p.xp;
  const records = Object.entries(NAMES).map(([k, n]) => `• ${n}: ${p.best[k] || 0}`).join('\n');
  return ui(c, `🏆 PROFIL GAME — ${p.name}`,
    `${statusLine(p)}\n🎯 Target: ${next} XP lagi menuju Lv.${lv + 1}\n\n🎮 Main: ${p.played} • 🏅 Menang: ${p.wins} (${p.played ? Math.round((p.wins / p.played) * 100) : 0}%)\n🔥 Rekor streak: ${p.bestStreak} • 🎁 Harian: ${p.daily} hari\n🤗 Kehangatan: ${p.kind}\n\n🥇 *Rekor Skor*\n${records}\n\n🎖️ ${p.ach.length ? p.ach.join(', ') : 'Belum ada pencapaian — mulai main!'}`,
    [{ text: '🏅 PERINGKAT', id: 'gametop' }, { text: '🎁 BONUS HARIAN', id: 'gamedaily' }, BTN.menu]);
};

const topBoard = (c) => {
  const rows = Object.entries(c.dbMemory.gameProfiles || {}).sort((a, b) => b[1].xp - a[1].xp);
  const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
  const mine = rows.findIndex(([n]) => n === c.senderNum) + 1;
  return ui(c, '🏅 PERINGKAT GAME',
    `${rows.slice(0, 5).map(([, p], i) => `${medals[i]} ${p.name || 'Pemain'} — Lv.${LVL(p.xp)} (${p.xp} XP)`).join('\n') || 'Belum ada pemain.'}\n\n📍 Posisimu: ${mine ? `#${mine}` : 'belum masuk — ayo main!'}`,
    [BTN.profile, { text: '🎁 BONUS HARIAN', id: 'gamedaily' }, BTN.menu]);
};

async function daily(c) {
  const p = profile(c), today = dayStr();
  if (p.lastDaily === today) return ui(c, '🎁 BONUS HARIAN', `Bonus hari ini sudah kamu ambil. 🌙\n🔥 Streak harian: *${p.daily}* hari — kembali besok!`, [BTN.profile, BTN.menu]);
  p.daily = p.lastDaily === dayStr(Date.now() - 864e5) ? p.daily + 1 : 1;
  p.lastDaily = today;
  const bonus = 30 + 10 * Math.min(p.daily - 1, 6);
  const lines = await addXp(c, p, bonus);
  return ui(c, '🎁 BONUS HARIAN', `✨ +${bonus} XP!\n🔥 Streak harian: *${p.daily}* hari${p.daily === 1 ? ' — awal yang bagus!' : ' — konsistensimu keren!'}${lines.length ? `\n${lines.join('\n')}` : ''}\n\n${statusLine(p)}`, [{ text: '🎮 MAIN SEKARANG', id: 'allmenu fun' }, BTN.profile]);
}

/* ═════════════════════════ PINTU MASUK ═════════════════════════ */

export const GAME_COMMANDS = [
  'kuroslash', 'slash', 'sonic', 'speedydash', 'game', 'mathgame', 'tebakkata', 'suit', 'dice', 'coin', '8ball',
  ...RATE, ...FUN_CMDS, 'wyr', ...Object.keys(ACT), 'gameprofil', 'gametop', 'gamedaily', 'stopgame',
];

const CMD = {};
const on = (names, fn) => [].concat(names).forEach((n) => { CMD[n] = fn; });
on(['kuroslash', 'slash'], (c) => G.kuro.start(c));
on(['sonic', 'speedydash'], (c) => G.sonic.start(c));
on('game', (c) => G.angka.start(c));
on('mathgame', (c) => G.math.start(c));
on('tebakkata', (c) => G.kata.start(c));
on('suit', (c) => G.suit.start(c));
on('dice', (c) => G.dice.start(c));
on('coin', (c) => G.coin.start(c));
on('wyr', (c) => G.wyr.start(c));
on('8ball', ball);
on(RATE, rate);
on(FUN_CMDS, fun);
on(Object.keys(ACT), warmth);
on('gameprofil', profilCard);
on('gametop', topBoard);
on('gamedaily', daily);
on('stopgame', (c) => c.reply('ℹ️ Tidak ada game yang sedang berjalan. Ketik `.allmenu` lalu pilih Game & Hiburan.'));

/** Dipanggil untuk setiap pesan: memproses tombol/jawaban game yang sedang berjalan. */
export async function handleGameInput(c) {
  const k = key(c), s = sessions.get(k);
  if (!s) return false;
  if (Date.now() - s.t > TTL) { sessions.delete(k); return false; }
  s.t = Date.now();
  const act = c.textLower.replace(/^[.!/#]/, '').trim();
  const g = G[s.type];
  if (act === 'stopgame') { await g.stop(c, s); return true; }
  return Boolean(await g.input(c, s, act));
}

export async function handleGameCommand(c) {
  const fn = CMD[c.cmd];
  if (!fn) return false;
  await fn(c);
  return true;
}
