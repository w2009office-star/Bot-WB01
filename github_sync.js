import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);
const env = (key, fallback = '') => process.env[key] || fallback;
const TOKEN = env('GITHUB_TOKEN');
const REPO = env('GITHUB_REPO');
const BRANCH = env('GITHUB_BRANCH', 'main');
const BACKUP_BRANCH = env('GITHUB_BACKUP_BRANCH', 'session-backup');
const BACKUP_FILE = 'auth_backup.json';
const BACKUP_DELAY_MS = 5000;
const enabled = Boolean(TOKEN && REPO);

const warn = (where, e) => console.warn(`[github_sync] ${where}:`, e?.message || e);
const credsPath = (dir) => path.join(dir, 'creds.json');
const sha1 = (text) => crypto.createHash('sha1').update(text).digest('hex');

const gh = (endpoint, method = 'GET', body) => fetch(`https://api.github.com/repos/${REPO}/${endpoint}`, {
  method,
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'WHUXEN-BOT',
  },
  ...(body && { body: JSON.stringify(body) }),
});

/* ── Pulihkan sesi ── */

let restoreDone = false;

async function restoreFrom(ref, authDir) {
  try {
    const res = await gh(`contents/${BACKUP_FILE}?ref=${ref}`);
    if (!res.ok) return false;
    const creds = Buffer.from((await res.json()).content || '', 'base64').toString('utf-8');
    JSON.parse(creds);
    await fsPromises.mkdir(authDir, { recursive: true });
    await fsPromises.writeFile(credsPath(authDir), creds);
    console.log(`✅ [AUTH RESTORE] Sesi WhatsApp dipulihkan dari GitHub (${ref})`);
    return true;
  } catch (e) {
    warn(`restore ${ref}`, e);
    return false;
  }
}

export async function restoreAuthFromGitHub(authDir = './auth') {
  const first = !restoreDone;
  restoreDone = true; // setelah logout, jangan pulihkan sesi lama lagi
  if (fs.existsSync(credsPath(authDir))) return true;
  if (!first || !enabled) return false;
  for (const ref of new Set([BACKUP_BRANCH, BRANCH])) {
    if (await restoreFrom(ref, authDir)) return true;
  }
  return false;
}

/* ── Backup sesi ── */

let timer = null;
let chain = Promise.resolve();
let backupDir = './auth';
let branchReady = false;
let lastHash = '';
let lastSha = '';

async function ensureBackupBranch() {
  if (branchReady || BACKUP_BRANCH === BRANCH) return;
  if (!(await gh(`git/ref/heads/${BACKUP_BRANCH}`)).ok) {
    const base = await (await gh(`git/ref/heads/${BRANCH}`)).json();
    const res = await gh('git/refs', 'POST', { ref: `refs/heads/${BACKUP_BRANCH}`, sha: base.object?.sha });
    if (!res.ok) throw new Error(`gagal membuat branch ${BACKUP_BRANCH} (HTTP ${res.status})`);
  }
  branchReady = true;
}

const currentSha = async () => (await (await gh(`contents/${BACKUP_FILE}?ref=${BACKUP_BRANCH}`)).json().catch(() => ({}))).sha;

const putBackup = (raw, sha) => gh(`contents/${BACKUP_FILE}`, 'PUT', {
  message: 'chore: sync whatsapp session [skip ci]',
  content: Buffer.from(raw).toString('base64'),
  branch: BACKUP_BRANCH,
  ...(sha && { sha }),
});

async function backupNow() {
  const raw = await fsPromises.readFile(credsPath(backupDir), 'utf-8').catch(() => '');
  const hash = sha1(raw);
  if (!raw || hash === lastHash) return;
  JSON.parse(raw);
  await ensureBackupBranch();
  let res = await putBackup(raw, lastSha || (await currentSha()));
  if (!res.ok) res = await putBackup(raw, await currentSha());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  lastHash = hash;
  lastSha = (await res.json()).content?.sha || '';
}

const safeBackup = () => (chain = chain.then(() => backupNow().catch((e) => warn('backup', e))));

export function scheduleAuthBackupToGitHub(authDir = './auth') {
  if (!enabled) return;
  backupDir = authDir;
  timer ??= setTimeout(() => { timer = null; safeBackup(); }, BACKUP_DELAY_MS);
}

export async function flushAuthBackup() {
  if (!enabled || !timer) return;
  clearTimeout(timer);
  timer = null;
  await safeBackup();
}

/* ── Hot reload kode ── */

const git = (...args) => exec('git', args, { timeout: 20000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).then((r) => r.stdout.trim());

async function pullIfUpdated(onCodeUpdated) {
  if (!fs.existsSync('.git')) return;
  await git('fetch', 'origin', BRANCH);
  const [local, remote] = await Promise.all([git('rev-parse', 'HEAD'), git('rev-parse', `origin/${BRANCH}`)]);
  if (local === remote) return;
  await git('pull', '--ff-only', 'origin', BRANCH);
  console.log(`🔄 [LIVE UPDATE] Kode baru ditarik (${remote.slice(0, 7)})`);
  await onCodeUpdated?.(remote.slice(0, 7));
}

export function startGitHubLiveHotReload(onCodeUpdated) {
  let busy = false;
  let lastError = '';
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await pullIfUpdated(onCodeUpdated);
      lastError = '';
    } catch (e) {
      if (e.message !== lastError) warn('hot-reload', e);
      lastError = e.message;
    } finally {
      busy = false;
    }
  }, 60 * 1000);
}

/* ── Shutdown ── */

export function setupGracefulShutdown(botRef, saveMemoryFn) {
  let closing = false;
  const step = (fn) => Promise.resolve().then(fn).catch((e) => warn('shutdown', e));
  const cleanExit = async () => {
    if (closing) return;
    closing = true;
    await Promise.race([
      Promise.all([step(() => saveMemoryFn?.()), step(flushAuthBackup)]),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]);
    await step(() => botRef?.sock?.ws?.close());
    process.exit(0);
  };
  ['SIGTERM', 'SIGINT'].forEach((signal) => process.on(signal, cleanExit));
}
