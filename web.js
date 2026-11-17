import http from 'http';

export function mulaiWeb({
  bot,
  dbMemory,
  getUptime = () => '-',
  getFeatureCount = () => 0,
  requestNewPairingCode = null,
} = {}) {
  const port = Number(process.env.PORT || 3000);
  const DURATION_MS = 60 * 1000;

  let trackedToken = '';
  let expiresAt = Date.now() + DURATION_MS;

  function syncTokenTimer() {
    const currentToken = `${bot.pairingCode || ''}|${bot.qr || ''}`;
    if (currentToken !== '|' && currentToken !== trackedToken) {
      trackedToken = currentToken;
      expiresAt = Date.now() + DURATION_MS;
    }
    if (!bot.connected && Date.now() >= expiresAt) {
      expiresAt = Date.now() + DURATION_MS;
      if (typeof requestNewPairingCode === 'function') {
        Promise.resolve(requestNewPairingCode()).catch(() => {});
      }
    }
    return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  }

  http.createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0];

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    if (urlPath === '/api/refresh-pairing') {
      bot.pairingCode = null;
      trackedToken = '';
      expiresAt = Date.now() + DURATION_MS;
      if (typeof requestNewPairingCode === 'function') {
        await Promise.resolve(requestNewPairingCode()).catch(() => {});
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const remainingSeconds = syncTokenTimer();
    const payload = {
      bot: bot.userName || 'WHUXEN BOT',
      version: dbMemory?.version ?? 1.0,
      connected: Boolean(bot.connected),
      registered: Boolean(bot.registered),
      phone: bot.userPhone || (process.env.PHONE_NUMBER || '').replace(/\D/g, '') || '-',
      pairingCode: bot.pairingCode || null,
      qr: bot.qr || null,
      remainingSeconds,
      uptime: getUptime(),
      features: getFeatureCount(),
      stats: bot.stats || { totalBlockedVirtek: 0, totalDeletedLinks: 0, totalDeletedBadWords: 0 },
    };

    if (urlPath === '/status' || urlPath === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }

    const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>${payload.bot} — Live Panel</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    body { background: #090d16; color: #f1f5f9; min-height: 100vh; display: flex; justify-content: center; padding: 16px 12px 28px; }
    .container { width: 100%; max-width: 460px; }
    .header { background: linear-gradient(135deg, #1e1b4b, #3b0764); border: 1px solid #4c1d95; border-radius: 18px; padding: 18px; text-align: center; margin-bottom: 14px; box-shadow: 0 10px 25px rgba(0,0,0,0.4); }
    .header h1 { font-size: 21px; font-weight: 800; color: #fff; margin-bottom: 4px; }
    .meta { font-size: 12px; color: #c4b5fd; margin-bottom: 10px; }
    .badge { display: inline-flex; align-items: center; gap: 6px; padding: 5px 14px; border-radius: 999px; font-size: 12px; font-weight: 700; }
    .online { background: rgba(16,185,129,0.18); color: #34d399; border: 1px solid rgba(52,211,153,0.4); }
    .offline { background: rgba(245,158,11,0.18); color: #fbbf24; border: 1px solid rgba(251,191,36,0.4); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; animation: pulse 1.2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 16px; padding: 16px; margin-bottom: 14px; }
    .auth-card { border-color: #6d28d9; background: #13112b; text-align: center; }
    .timer-row { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #cbd5e1; margin-bottom: 6px; }
    .timer-val { font-weight: 800; color: #38bdf8; }
    .progress-bg { width: 100%; height: 7px; background: #090d16; border-radius: 999px; overflow: hidden; margin-bottom: 14px; border: 1px solid #1e293b; }
    .progress-fill { height: 100%; width: 100%; background: linear-gradient(90deg, #38bdf8, #8b5cf6); transition: width 0.4s linear; }
    .section-label { font-size: 11px; font-weight: 700; letter-spacing: 0.9px; color: #94a3b8; margin-bottom: 8px; text-transform: uppercase; }
    .otp-box { font-size: 28px; font-weight: 800; letter-spacing: 4px; color: #38bdf8; background: #090d16; padding: 12px 10px; border-radius: 12px; border: 1.5px dashed #38bdf8; margin-bottom: 10px; user-select: all; }
    .btn-row { display: flex; gap: 8px; justify-content: center; margin-bottom: 16px; }
    .btn { border: none; padding: 9px 14px; border-radius: 10px; font-size: 12px; font-weight: 700; cursor: pointer; color: #fff; }
    .btn-copy { background: #7c3aed; }
    .btn-refresh { background: #1e293b; border: 1px solid #334155; }
    .qr-box { background: #090d16; border: 1px solid #1e293b; border-radius: 14px; padding: 14px; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 224px; }
    .qr-box img { width: 200px; height: 200px; border-radius: 10px; background: #fff; padding: 8px; }
    .qr-wait { font-size: 12px; color: #94a3b8; }
    .hint { font-size: 11.5px; color: #94a3b8; margin-top: 12px; line-height: 1.45; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .stat-box { background: #090d16; border: 1px solid #1e293b; border-radius: 12px; padding: 11px; }
    .stat-title { font-size: 11px; color: #94a3b8; margin-bottom: 4px; }
    .stat-val { font-size: 14px; font-weight: 700; color: #f8fafc; word-break: break-all; }
    .hidden { display: none !important; }
    .footer { text-align: center; font-size: 11px; color: #64748b; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 id="botTitle">🤖 ${payload.bot}</h1>
      <div class="meta" id="botMeta">Versi ${payload.version} • ${payload.features} Fitur Aktif</div>
      <div id="statusBadge" class="badge ${payload.connected ? 'online' : 'offline'}">
        <span class="dot"></span>
        <span id="statusText">${payload.connected ? 'TERHUBUNG' : 'MENUNGGU KONEKSI'}</span>
      </div>
    </div>

    <div id="pairingCard" class="card auth-card ${payload.connected ? 'hidden' : ''}">
      <div class="timer-row">
        <span>Masa Berlaku Real-Time</span>
        <span class="timer-val" id="timerText">${payload.remainingSeconds} detik</span>
      </div>
      <div class="progress-bg">
        <div class="progress-fill" id="progressFill" style="width:${Math.round((payload.remainingSeconds / 60) * 100)}%"></div>
      </div>

      <div class="section-label">1. Kode OTP Pairing</div>
      <div class="otp-box" id="otpText">${payload.pairingCode || 'MEMUAT OTP...'}</div>
      <div class="btn-row">
        <button class="btn btn-copy" id="copyBtn" onclick="copyOtp()">📋 Salin Kode OTP</button>
        <button class="btn btn-refresh" onclick="refreshAuth()">🔄 Perbarui Kode</button>
      </div>

      <div class="section-label">2. Scan QR Code</div>
      <div class="qr-box">
        <img id="qrImg" class="${payload.qr ? '' : 'hidden'}" src="${payload.qr ? `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=6&data=${encodeURIComponent(payload.qr)}` : ''}" alt="QR WhatsApp" />
        <div id="qrWait" class="qr-wait ${payload.qr ? 'hidden' : ''}">Menunggu sinyal QR dari WhatsApp...</div>
      </div>

      <p class="hint">Buka WhatsApp → Perangkat Tertaut → Tautkan Perangkat → Pilih scan QR atau masukkan kode OTP di atas.</p>
    </div>

    <div class="card">
      <div class="section-label">Status Sistem Real-Time</div>
      <div class="grid">
        <div class="stat-box"><div class="stat-title">Nomor Bot</div><div class="stat-val" id="statPhone">+${payload.phone}</div></div>
        <div class="stat-box"><div class="stat-title">Waktu Aktif</div><div class="stat-val" id="statUptime">${payload.uptime}</div></div>
        <div class="stat-box"><div class="stat-title">Virtek Diblokir</div><div class="stat-val" id="statVirtek">${payload.stats.totalBlockedVirtek || 0}</div></div>
        <div class="stat-box"><div class="stat-title">Link & Toxic Dihapus</div><div class="stat-val" id="statClean">${(payload.stats.totalDeletedLinks || 0) + (payload.stats.totalDeletedBadWords || 0)}</div></div>
      </div>
    </div>

    <div class="footer">Sinkronisasi real-time aktif setiap 1 detik</div>
  </div>

  <script>
    let lastQrValue = ${JSON.stringify(payload.qr || '')};

    function copyOtp() {
      const txt = (document.getElementById('otpText')?.innerText || '').trim();
      if (!txt || txt.includes('MEMUAT')) return;
      const btn = document.getElementById('copyBtn');
      const done = () => {
        btn.innerText = '✅ Tersalin';
        setTimeout(() => { btn.innerText = '📋 Salin Kode OTP'; }, 2000);
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(txt).then(done).catch(() => fallbackCopy(txt, done));
      } else {
        fallbackCopy(txt, done);
      }
    }

    function fallbackCopy(text, cb) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); cb(); } catch (e) {}
      document.body.removeChild(ta);
    }

    async function refreshAuth() {
      document.getElementById('otpText').innerText = 'MEMPERBARUI...';
      try { await fetch('/api/refresh-pairing'); } catch (e) {}
    }

    async function pollRealtime() {
      try {
        const res = await fetch('/api/status', { cache: 'no-store' });
        if (!res.ok) return;
        const d = await res.json();

        document.getElementById('botTitle').innerText = '🤖 ' + d.bot;
        document.getElementById('botMeta').innerText = 'Versi ' + d.version + ' • ' + d.features + ' Fitur Aktif';
        document.getElementById('statPhone').innerText = '+' + d.phone;
        document.getElementById('statUptime').innerText = d.uptime;
        document.getElementById('statVirtek').innerText = d.stats?.totalBlockedVirtek || 0;
        document.getElementById('statClean').innerText = (d.stats?.totalDeletedLinks || 0) + (d.stats?.totalDeletedBadWords || 0);

        const badge = document.getElementById('statusBadge');
        const statusText = document.getElementById('statusText');
        const pairingCard = document.getElementById('pairingCard');

        if (d.connected) {
          badge.className = 'badge online';
          statusText.innerText = 'TERHUBUNG';
          pairingCard.classList.add('hidden');
        } else {
          badge.className = 'badge offline';
          statusText.innerText = 'MENUNGGU KONEKSI';
          pairingCard.classList.remove('hidden');

          document.getElementById('timerText').innerText = d.remainingSeconds + ' detik';
          document.getElementById('progressFill').style.width = Math.max(0, Math.min(100, (d.remainingSeconds / 60) * 100)) + '%';
          document.getElementById('otpText').innerText = d.pairingCode || 'MEMUAT OTP...';

          const qrImg = document.getElementById('qrImg');
          const qrWait = document.getElementById('qrWait');
          if (d.qr) {
            if (d.qr !== lastQrValue) {
              lastQrValue = d.qr;
              qrImg.src = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=6&data=' + encodeURIComponent(d.qr);
            }
            qrImg.classList.remove('hidden');
            qrWait.classList.add('hidden');
          } else {
            lastQrValue = '';
            qrImg.classList.add('hidden');
            qrWait.classList.remove('hidden');
          }
        }
      } catch (e) {}
    }

    setInterval(pollRealtime, 1000);
  </script>
</body>
</html>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }).listen(port, () => console.log(`🌐 Web APK Real-Time aktif di port ${port}`));
}

export default mulaiWeb;
