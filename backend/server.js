// AS ANAMUL VOICE — production-minded starter backend
// Express API + JSON persistence + web admin + Gemini TTS.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TOKEN_SECRET = process.env.TOKEN_SECRET || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts';
const DB_FILE = path.resolve(process.env.DB_FILE || path.join(__dirname, 'data.json'));
const ONLINE_MS = 2 * 60 * 1000;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 86400000;

if (ADMIN_PASSWORD.length < 12) throw new Error('Set ADMIN_PASSWORD to a strong password (at least 12 characters).');
if (TOKEN_SECRET.length < 32) throw new Error('Set TOKEN_SECRET to a random secret of at least 32 characters.');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/admin/api/')) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: '1h' }));

const defaults = () => ({
  keys: [], codes: [], stats: {}, log: [],
  config: {
    appName: 'AS ANAMUL VOICE',
    telegramUrl: 'https://t.me/crackffpanel',
    announcement: '', minVersion: 1,
    maintenance: false, maintenanceMsg: 'অ্যাপ সাময়িক বন্ধ আছে, পরে চেষ্টা করুন',
    voices: [
      { id: 'v1', name: 'Kore', voiceId: 'Kore' },
      { id: 'v2', name: 'Puck', voiceId: 'Puck' },
      { id: 'v3', name: 'Charon', voiceId: 'Charon' }
    ]
  }
});

function loadDb() {
  try {
    if (!fs.existsSync(DB_FILE)) return defaults();
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const base = defaults();
    return {
      ...base, ...parsed,
      keys: Array.isArray(parsed.keys) ? parsed.keys : [],
      codes: Array.isArray(parsed.codes) ? parsed.codes : [],
      stats: parsed.stats && typeof parsed.stats === 'object' ? parsed.stats : {},
      log: Array.isArray(parsed.log) ? parsed.log : [],
      config: { ...base.config, ...(parsed.config || {}) }
    };
  } catch (err) {
    throw new Error(`Cannot read database file ${DB_FILE}: ${err.message}`);
  }
}
let db = loadDb();
let dirty = false;
function save() { dirty = true; }
function flush() {
  if (!dirty) return;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
  fs.renameSync(tmp, DB_FILE);
  dirty = false;
}
const flushTimer = setInterval(() => {
  try { flush(); } catch (err) { console.error('Database save failed:', err.message); }
}, 2000);
flushTimer.unref();

const now = () => Date.now();
const today = () => new Date(Date.now() + 6 * 3600000).toISOString().slice(0, 10);
function day() {
  const date = today();
  return (db.stats[date] ||= { users: [], logins: 0, failed: 0, tts: 0, panel: 0 });
}
function addLog(type, key = '', extra = '') {
  db.log.unshift({ t: now(), type, key: String(key).slice(0, 80), extra: String(extra).slice(0, 180) });
  if (db.log.length > 300) db.log.length = 300;
}
function seen(key, body = {}) {
  key.lastSeen = now();
  if (body.model) key.model = String(body.model).slice(0, 60);
  if (body.android) key.android = String(body.android).slice(0, 20);
  if (body.appVersion) key.appVersion = Number(body.appVersion) || key.appVersion || 0;
  const d = day();
  if (!d.users.includes(key.key)) d.users.push(key.key);
}
const randomHex = (bytes = 4) => crypto.randomBytes(bytes).toString('hex').toUpperCase();
const sign = payload => crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest();
function makeToken(key, device) {
  const payload = Buffer.from(JSON.stringify({ key, device, iat: now(), exp: now() + TOKEN_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload).toString('base64url')}`;
}
function readToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  let supplied;
  try { supplied = Buffer.from(token.slice(dot + 1), 'base64url'); } catch { return null; }
  const expected = sign(payload);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.key || !data.device || !Number.isFinite(data.exp) || data.exp < now()) return null;
    return data;
  } catch { return null; }
}
function keyStatus(key, device) {
  if (!key) return 'INVALID';
  if (key.banned) return 'BANNED';
  if (!device || (key.deviceId && key.deviceId !== device)) return 'DEVICE_LOCKED';
  if (key.expiresAt && key.expiresAt < now()) return 'EXPIRED';
  return 'OK';
}
function gate(req, res, next) {
  if (db.config.maintenance) return res.status(503).json({ ok: false, status: 'MAINTENANCE', message: db.config.maintenanceMsg });
  const version = Number(req.body?.appVersion || req.headers['x-app-version'] || 0);
  if (version && version < Number(db.config.minVersion || 1)) {
    return res.status(426).json({ ok: false, status: 'UPDATE_REQUIRED', telegramUrl: db.config.telegramUrl });
  }
  next();
}
function needKey(req, res, next) {
  const token = readToken(req);
  const key = token && db.keys.find(item => item.key === token.key);
  const status = key ? keyStatus(key, token.device) : 'NEED_LOGIN';
  if (status !== 'OK') return res.status(401).json({ ok: false, status });
  req.licence = key;
  req.tokenDevice = token.device;
  next();
}

// Small in-memory rate limiter. For multi-instance deployment, use a shared limiter.
const buckets = new Map();
function rateLimit({ windowMs = 60000, max = 20, name = 'default' } = {}) {
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const t = now();
    let bucket = buckets.get(key);
    if (!bucket || t - bucket.start >= windowMs) bucket = { start: t, count: 0 };
    bucket.count++;
    buckets.set(key, bucket);
    if (bucket.count > max) return res.status(429).json({ ok: false, status: 'TOO_MANY' });
    next();
  };
}
setInterval(() => {
  const cutoff = now() - 120000;
  for (const [key, value] of buckets) if (value.start < cutoff) buckets.delete(key);
}, 60000).unref();

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'AS ANAMUL VOICE', time: now() }));

// Android app API
app.post('/api/app/verify', rateLimit({ max: 15, name: 'verify' }), gate, (req, res) => {
  const keyText = String(req.body?.key || '').trim();
  const deviceId = String(req.body?.deviceId || '').trim();
  if (!keyText || !deviceId || deviceId.length > 128) {
    return res.status(400).json({ ok: false, status: 'BAD_REQUEST', message: 'Key এবং device তথ্য দিন।' });
  }
  const key = db.keys.find(item => item.key === keyText);
  if (!key) {
    day().failed++;
    addLog('login_fail', keyText.slice(0, 20));
    save();
    return res.status(401).json({ ok: false, status: 'INVALID' });
  }
  const status = keyStatus(key, deviceId);
  if (status !== 'OK' && status !== 'DEVICE_LOCKED') {
    day().failed++;
    addLog(`login_${status.toLowerCase()}`, key.key);
    save();
    return res.status(401).json({ ok: false, status });
  }
  if (key.deviceId && key.deviceId !== deviceId) {
    day().failed++;
    addLog('login_device_locked', key.key);
    save();
    return res.status(401).json({ ok: false, status: 'DEVICE_LOCKED' });
  }
  if (!key.deviceId) key.deviceId = deviceId;
  if (!key.expiresAt) {
    key.activatedAt = now();
    key.expiresAt = now() + Math.max(1, Number(key.days) || 30) * DAY_MS;
  }
  seen(key, req.body);
  key.loginCount = (key.loginCount || 0) + 1;
  day().logins++;
  addLog('login', key.key, `${key.model || ''} / Android ${key.android || '?'}`);
  save();
  res.json({ ok: true, status: 'OK', token: makeToken(key.key, deviceId), expiresAt: key.expiresAt, label: key.label || '' });
});

app.post('/api/app/ping', gate, needKey, (req, res) => {
  seen(req.licence, req.body || {}); save();
  res.json({ ok: true, expiresAt: req.licence.expiresAt });
});
app.post('/api/app/redeem', gate, needKey, (req, res) => {
  const codeText = String(req.body?.code || '').trim();
  const code = db.codes.find(item => item.code === codeText && !item.used);
  if (!code) return res.status(400).json({ ok: false, status: 'BAD_CODE' });
  code.used = true; code.usedBy = req.licence.key; code.usedAt = now();
  req.licence.expiresAt = Math.max(req.licence.expiresAt || now(), now()) + Math.max(1, Number(code.days) || 7) * DAY_MS;
  addLog('redeem', req.licence.key, `+${code.days} দিন`); save();
  res.json({ ok: true, expiresAt: req.licence.expiresAt });
});
app.get('/api/app/config', gate, needKey, (req, res) => {
  seen(req.licence, { appVersion: req.headers['x-app-version'] }); save();
  const config = db.config;
  res.json({ ok: true, appName: config.appName, telegramUrl: config.telegramUrl, announcement: config.announcement,
    minVersion: config.minVersion, voices: config.voices, expiresAt: req.licence.expiresAt });
});
app.post('/api/app/tts', rateLimit({ max: 30, name: 'tts' }), gate, needKey, async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    const voiceId = String(req.body?.voiceId || '').trim();
    const voice = db.config.voices.find(item => item.id === voiceId || item.voiceId === voiceId);
    if (!text || text.length > 500 || !voice) return res.status(400).json({ ok: false, status: 'BAD_REQUEST' });
    if (!GEMINI_API_KEY) return res.status(503).json({ ok: false, status: 'TTS_NOT_CONFIGURED', message: 'সার্ভারে Gemini API key সেট করা হয়নি।' });
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_TTS_MODEL)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice.voiceId } } } }
      }),
      signal: AbortSignal.timeout(60000)
    });
    const result = await response.json().catch(() => ({}));
    const audio = result?.candidates?.[0]?.content?.parts?.find(part => part.inlineData?.data)?.inlineData;
    if (!response.ok || !audio?.data) {
      console.error('Gemini TTS error:', response.status, result?.error?.message || result?.error || 'No audio returned');
      return res.status(502).json({ ok: false, status: 'TTS_FAILED', message: 'Voice service থেকে অডিও পাওয়া যায়নি।' });
    }
    const pcm = Buffer.from(audio.data, 'base64');
    if (!pcm.length || pcm.length > 15 * 1024 * 1024) return res.status(502).json({ ok: false, status: 'TTS_FAILED' });
    // Gemini TTS returns 24 kHz, 16-bit, mono PCM for this model family.
    const wav = Buffer.alloc(44);
    wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVE', 8);
    wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40);
    req.licence.ttsCount = (req.licence.ttsCount || 0) + 1;
    day().tts = (day().tts || 0) + 1;
    addLog('tts', req.licence.key, `${text.length} characters / ${voice.name}`);
    save();
    res.type('audio/wav').send(Buffer.concat([wav, pcm]));
  } catch (err) {
    console.error('TTS request failed:', err.message);
    res.status(502).json({ ok: false, status: 'TTS_FAILED' });
  }
});

// Public key generator website: one free 12h key per device.
// The key is pre-activated with a 12h expiry at mint time (verify() only
// activates keys whose expiresAt is unset, and it clamps days to >= 1,
// so a 12h key must carry its own expiresAt).
app.post('/api/web/mint', rateLimit({ max: 5, name: 'webmint' }), gate, (req, res) => {
  const deviceId = String(req.body?.deviceId || '').trim();
  if (!deviceId || deviceId.length > 128) {
    return res.status(400).json({ ok: false, status: 'BAD_REQUEST', message: 'Device তথ্য দিন।' });
  }
  const t = now();
  const existing = db.keys.find(item => item.label === 'WEB' && item.deviceId === deviceId && !item.banned && (!item.expiresAt || item.expiresAt > t));
  if (existing) {
    return res.json({ ok: true, key: existing.key, expiresAt: existing.expiresAt, label: existing.label || 'WEB', reused: true });
  }
  let keyText;
  do { keyText = `K-${randomHex()}-${randomHex()}`; } while (db.keys.some(item => item.key === keyText));
  const item = { key: keyText, label: 'WEB', days: 1, createdAt: t, activatedAt: t, expiresAt: t + 12 * 60 * 60 * 1000, deviceId, banned: false, loginCount: 0, ttsCount: 0 };
  db.keys.push(item);
  addLog('web_key', keyText, deviceId.slice(0, 40));
  save();
  res.json({ ok: true, key: keyText, expiresAt: item.expiresAt, label: 'WEB', reused: false });
});

// Admin authentication (HTTP Basic; deploy behind HTTPS only)
const adminLimiter = rateLimit({ max: 30, windowMs: 60000, name: 'admin' });
function admin(req, res, next) {
  const header = req.headers.authorization || '';
  const encoded = header.startsWith('Basic ') ? header.slice(6) : '';
  let password = '';
  try { password = Buffer.from(encoded, 'base64').toString('utf8').split(':').slice(1).join(':'); } catch { /* invalid header */ }
  const supplied = Buffer.from(password);
  const expected = Buffer.from(ADMIN_PASSWORD);
  const valid = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  if (!valid) {
    res.set('WWW-Authenticate', 'Basic realm="AS ANAMUL VOICE Admin", charset="UTF-8"');
    return res.status(401).end();
  }
  next();
}
app.use('/admin/api', adminLimiter, admin);
app.get('/admin/api/state', (req, res) => {
  const t = now();
  const online = db.keys.filter(key => key.lastSeen && t - key.lastSeen < ONLINE_MS).map(key => key.key);
  const days = Object.keys(db.stats).sort().slice(-30).map(date => ({ date, users: db.stats[date].users.length,
    logins: db.stats[date].logins, failed: db.stats[date].failed, tts: db.stats[date].tts || 0, panel: db.stats[date].panel || 0 }));
  const todayStats = db.stats[today()];
  res.json({ keys: db.keys, codes: db.codes, config: db.config, log: db.log.slice(0, 80), online, days,
    summary: { total: db.keys.length, active: db.keys.filter(key => !key.banned && (!key.expiresAt || key.expiresAt > t)).length,
      online: online.length, todayUsers: todayStats ? todayStats.users.length : 0, todayLogins: todayStats ? todayStats.logins : 0, serverTime: t } });
});
app.post('/admin/api/visit', (req, res) => { day().panel++; save(); res.json({ ok: true }); });
app.post('/admin/api/keys', (req, res) => {
  const label = String(req.body?.label || '').slice(0, 80);
  const days = Math.min(3650, Math.max(1, Number(req.body?.days) || 30));
  const count = Math.min(100, Math.max(1, Number(req.body?.count) || 1));
  const made = [];
  for (let i = 0; i < count; i++) {
    let keyText;
    do { keyText = `K-${randomHex()}-${randomHex()}`; } while (db.keys.some(item => item.key === keyText));
    const item = { key: keyText, label, days, createdAt: now(), activatedAt: null, expiresAt: null, deviceId: null, banned: false, loginCount: 0, ttsCount: 0 };
    db.keys.push(item); made.push(item);
  }
  addLog('keys_created', '', `${count} key(s)`); save(); res.json(made);
});
app.patch('/admin/api/keys/:key', (req, res) => {
  const key = db.keys.find(item => item.key === req.params.key);
  if (!key) return res.status(404).json({ ok: false, status: 'NOT_FOUND' });
  const body = req.body || {};
  if (typeof body.banned === 'boolean') key.banned = body.banned;
  if (body.resetDevice === true) key.deviceId = null;
  if (Number.isFinite(Number(body.addDays)) && Number(body.addDays) > 0) key.expiresAt = Math.max(key.expiresAt || now(), now()) + Math.min(3650, Number(body.addDays)) * DAY_MS;
  if (typeof body.label === 'string') key.label = body.label.slice(0, 80);
  addLog('key_updated', key.key); save(); res.json(key);
});
app.delete('/admin/api/keys/:key', (req, res) => {
  const before = db.keys.length; db.keys = db.keys.filter(item => item.key !== req.params.key);
  if (db.keys.length === before) return res.status(404).json({ ok: false, status: 'NOT_FOUND' });
  addLog('key_deleted', req.params.key); save(); res.json({ ok: true });
});
app.post('/admin/api/codes', (req, res) => {
  const days = Math.min(3650, Math.max(1, Number(req.body?.days) || 7));
  const count = Math.min(100, Math.max(1, Number(req.body?.count) || 1));
  const made = [];
  for (let i = 0; i < count; i++) {
    let codeText;
    do { codeText = `R-${randomHex(4)}`; } while (db.codes.some(item => item.code === codeText));
    const item = { code: codeText, days, used: false }; db.codes.push(item); made.push(item);
  }
  addLog('codes_created', '', `${count} code(s)`); save(); res.json(made);
});
app.delete('/admin/api/codes/:code', (req, res) => {
  const before = db.codes.length; db.codes = db.codes.filter(item => item.code !== req.params.code);
  if (db.codes.length === before) return res.status(404).json({ ok: false, status: 'NOT_FOUND' });
  save(); res.json({ ok: true });
});
app.put('/admin/api/config', (req, res) => {
  const body = req.body || {}, config = db.config;
  for (const field of ['appName', 'telegramUrl', 'announcement', 'maintenanceMsg']) {
    if (typeof body[field] === 'string') config[field] = body[field].slice(0, field === 'announcement' ? 1000 : 300);
  }
  if (Number.isInteger(Number(body.minVersion)) && Number(body.minVersion) >= 1) config.minVersion = Number(body.minVersion);
  if (typeof body.maintenance === 'boolean') config.maintenance = body.maintenance;
  if (Array.isArray(body.voices)) {
    config.voices = body.voices.slice(0, 30).map((voice, index) => ({
      id: String(voice.id || `v${index + 1}`).slice(0, 40),
      name: String(voice.name || '').slice(0, 60),
      voiceId: String(voice.voiceId || '').slice(0, 60)
    })).filter(voice => voice.name && voice.voiceId);
  }
  addLog('settings_updated'); save(); res.json(config);
});
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.use((err, _req, res, _next) => {
  console.error('Unhandled request error:', err.message);
  res.status(500).json({ ok: false, status: 'SERVER_ERROR' });
});

const server = app.listen(PORT, () => console.log(`AS ANAMUL VOICE backend listening on ${PORT}`));
function shutdown() {
  clearInterval(flushTimer);
  try { flush(); } catch (err) { console.error('Final database save failed:', err.message); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
