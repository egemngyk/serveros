import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import argon2 from 'argon2';
import { db } from '../db.js';
import { config } from '../config.js';
import { HttpError, bad } from '../lib/util.js';
import { audit } from './audit.js';
import { getSetting } from './settings.js';
import { log } from '../logger.js';

const COOKIE = 'sid';
const ARGON = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
let DUMMY_HASH = null;
argon2.hash('dummy-password-for-timing', ARGON).then((h) => { DUMMY_HASH = h; });

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
  }
  return out;
}

export function isSecureRequest(req) {
  if (config.cookieSecure === 'true') return true;
  if (config.cookieSecure === 'false') return false;
  return !!req.secure;
}

// ---------------------------------------------------------------- rate limiting
const attempts = new Map();
const WINDOW = 15 * 60 * 1000;
function limiterCheck(key) {
  const a = attempts.get(key);
  if (a && a.lockUntil > Date.now()) {
    throw new HttpError(429, 'Too many failed attempts. Try again later.', 'rate_limited', { retryAfter: Math.ceil((a.lockUntil - Date.now()) / 1000) });
  }
}
function limiterFail(key, max) {
  const now = Date.now();
  let a = attempts.get(key);
  if (!a || now - a.last > WINDOW) a = { fails: 0, last: now, lockUntil: 0 };
  a.fails += 1; a.last = now;
  if (a.fails >= max) {
    const level = Math.floor(a.fails / max);
    a.lockUntil = now + Math.min(WINDOW * 2 ** (level - 1), 24 * 3600 * 1000);
  }
  attempts.set(key, a);
}
setInterval(() => { const now = Date.now(); for (const [k, a] of attempts) if (now - a.last > 24 * 3600 * 1000 && a.lockUntil < now) attempts.delete(k); }, 3600 * 1000).unref();

// ---------------------------------------------------------------- setup
const setupTokenFile = path.join(config.dataDir, 'setup-token');
export const userCount = () => db.prepare('SELECT COUNT(*) c FROM users').get().c;
export const setupRequired = () => userCount() === 0;

export function ensureSetupToken() {
  if (!setupRequired()) { try { fs.unlinkSync(setupTokenFile); } catch { /* ignore */ } return null; }
  let t;
  try { t = fs.readFileSync(setupTokenFile, 'utf8').trim(); } catch { /* none */ }
  if (!t) {
    t = crypto.randomBytes(18).toString('base64url');
    fs.writeFileSync(setupTokenFile, t + '\n', { mode: 0o600 });
  }
  log.warn('FIRST-RUN SETUP REQUIRED. Open the dashboard and enter this setup token to create the administrator', { setupToken: t, file: setupTokenFile });
  return t;
}

function validateCredentials(username, password) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) throw bad('Username must be 3-32 characters: letters, digits, dot, dash, underscore');
  validatePassword(password);
}
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12) throw bad('Password must be at least 12 characters');
  if (password.length > 256) throw bad('Password is too long');
  if (/^(.)\1+$/.test(password)) throw bad('Password is too weak');
}

export async function createInitialAdmin(req, { username, password, setupToken }) {
  if (!setupRequired()) throw new HttpError(409, 'Setup has already been completed', 'setup_done');
  limiterCheck('setup:' + req.ip);
  let expected = '';
  try { expected = fs.readFileSync(setupTokenFile, 'utf8').trim(); } catch { /* ignore */ }
  const a = Buffer.from(String(setupToken || ''));
  const b = Buffer.from(expected);
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    limiterFail('setup:' + req.ip, 5);
    audit(req, 'auth.setup', username, 'denied', { reason: 'bad setup token' });
    throw new HttpError(403, 'Invalid setup token. See the container log (docker logs serveros).', 'bad_setup_token');
  }
  validateCredentials(username, password);
  const hash = await argon2.hash(password, ARGON);
  const info = db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)').run(username, hash, 'admin', Date.now());
  try { fs.unlinkSync(setupTokenFile); } catch { /* ignore */ }
  audit({ username, ip: req.ip }, 'auth.setup', username, 'ok');
  return db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(info.lastInsertRowid);
}

// ---------------------------------------------------------------- sessions
export function createSession(req, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  const ttl = getSetting('session.ttlHours') * 3600 * 1000;
  db.prepare('INSERT INTO sessions (id, user_id, csrf, created_at, last_seen, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sha(token), userId, csrf, now, now, now + ttl, req.ip, String(req.get('user-agent') || '').slice(0, 200));
  return { token, csrf, maxAge: ttl };
}

export function setSessionCookie(req, res, token, maxAge) {
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: isSecureRequest(req), path: '/', maxAge });
}
export function clearSessionCookie(req, res) {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'strict', secure: isSecureRequest(req), path: '/' });
}

/** Look up a session from a raw cookie header; refreshes idle timer. Returns {user, session} or null. */
export function lookupSession(cookieHeader) {
  const token = parseCookies(cookieHeader)[COOKIE];
  if (!token) return null;
  const id = sha(token);
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!s) return null;
  const now = Date.now();
  const idle = getSetting('session.idleMinutes') * 60 * 1000;
  if (s.expires_at < now || now - s.last_seen > idle) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return null;
  }
  if (now - s.last_seen > 60000) db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').run(now, id);
  const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(s.user_id);
  if (!user) return null;
  return { user, session: { id, csrf: s.csrf, createdAt: s.created_at, expiresAt: s.expires_at } };
}

export async function login(req, res, { username, password }) {
  if (typeof username !== 'string' || typeof password !== 'string' || username.length > 64 || password.length > 256) throw bad('Invalid credentials');
  const uKey = 'user:' + username.toLowerCase();
  const iKey = 'ip:' + req.ip;
  limiterCheck(uKey); limiterCheck(iKey);
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  let ok = false;
  if (user) ok = await argon2.verify(user.password_hash, password).catch(() => false);
  else if (DUMMY_HASH) await argon2.verify(DUMMY_HASH, password).catch(() => false); // constant-ish timing
  if (!ok) {
    limiterFail(uKey, 5); limiterFail(iKey, 20);
    audit({ username, ip: req.ip }, 'auth.login', username, 'failed');
    throw new HttpError(401, 'Invalid username or password', 'invalid_credentials');
  }
  attempts.delete(uKey);
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), user.id);
  const s = createSession(req, user.id);
  setSessionCookie(req, res, s.token, s.maxAge);
  audit({ username: user.username, ip: req.ip }, 'auth.login', user.username, 'ok');
  return { user: { id: user.id, username: user.username, role: user.role }, csrf: s.csrf };
}

export function logout(req, res) {
  if (req.session) db.prepare('DELETE FROM sessions WHERE id = ?').run(req.session.id);
  clearSessionCookie(req, res);
  audit(req, 'auth.logout', req.user?.username, 'ok');
}

export async function changePassword(req, { current, next }) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  limiterCheck('pw:' + req.user.id);
  if (!(await argon2.verify(row.password_hash, String(current || '')).catch(() => false))) {
    limiterFail('pw:' + req.user.id, 5);
    audit(req, 'auth.password_change', req.user.username, 'failed');
    throw new HttpError(403, 'Current password is incorrect', 'invalid_credentials');
  }
  validatePassword(next);
  if (next === current) throw bad('New password must differ from the current one');
  const hash = await argon2.hash(next, ARGON);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  const removed = db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(req.user.id, req.session.id).changes;
  audit(req, 'auth.password_change', req.user.username, 'ok', { otherSessionsInvalidated: removed });
  return { otherSessionsInvalidated: removed };
}

export function listSessions(userId, currentId) {
  return db.prepare('SELECT id, created_at, last_seen, expires_at, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY last_seen DESC').all(userId)
    .map((s) => ({ ...s, id: s.id.slice(0, 16), current: s.id === currentId, _full: s.id }))
    .map(({ _full, ...s }) => s);
}
export function revokeOtherSessions(userId, currentId) {
  return db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, currentId).changes;
}
export function purgeExpiredSessions() { db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); }

// ---------------------------------------------------------------- middleware
function originAllowed(req) {
  const origin = req.get('origin');
  if (!origin) return true; // non-browser or same-origin GET; unsafe methods also require the CSRF header
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (config.allowedOrigins.includes(origin)) return true;
  const host = req.get('x-forwarded-host') || req.get('host');
  return u.host === host;
}
export { originAllowed };

export function authenticate(req, res, next) {
  const found = lookupSession(req.headers.cookie);
  if (!found) return next(new HttpError(401, 'Authentication required', 'unauthenticated'));
  req.user = found.user;
  req.session = found.session;
  next();
}

export function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!originAllowed(req)) return next(new HttpError(403, 'Cross-origin request blocked', 'bad_origin'));
  const sent = String(req.get('x-csrf-token') || '');
  const a = Buffer.from(sent);
  const b = Buffer.from(req.session?.csrf || '');
  if (!b.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return next(new HttpError(403, 'Invalid CSRF token', 'bad_csrf'));
  next();
}

export function getCsrf(sessionId) {
  return db.prepare('SELECT csrf FROM sessions WHERE id = ?').get(sessionId)?.csrf;
}
