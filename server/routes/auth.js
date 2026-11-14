import { Router } from 'express';
import { wrap, bad } from '../lib/util.js';
import * as auth from '../services/auth.js';
import { db } from '../db.js';
import { csrfProtect, authenticate, lookupSession } from '../services/auth.js';

export const publicAuth = Router();
export const privateAuth = Router();

publicAuth.get('/status', wrap((req) => {
  const found = lookupSession(req.headers.cookie);
  return { setupRequired: auth.setupRequired(), authenticated: !!found, user: found?.user ?? null, csrf: found ? auth.getCsrf(found.session.id) : null };
}));

publicAuth.post('/setup', csrfOrigin, wrap(async (req, res) => {
  const user = await auth.createInitialAdmin(req, req.body || {});
  const s = auth.createSession(req, user.id);
  auth.setSessionCookie(req, res, s.token, s.maxAge);
  return { user, csrf: s.csrf };
}));

publicAuth.post('/login', csrfOrigin, wrap((req, res) => auth.login(req, res, req.body || {})));

// Origin check for unauthenticated unsafe requests (no session CSRF token exists yet)
function csrfOrigin(req, res, next) {
  if (!auth.originAllowed(req)) return res.status(403).json({ error: { code: 'bad_origin', message: 'Cross-origin request blocked' } });
  next();
}

privateAuth.post('/logout', wrap((req, res) => { auth.logout(req, res); return { ok: true }; }));
privateAuth.post('/password', wrap((req) => auth.changePassword(req, { current: req.body?.current, next: req.body?.next })));
privateAuth.get('/sessions', wrap((req) => auth.listSessions(req.user.id, req.session.id)));
privateAuth.post('/sessions/revoke-others', wrap((req) => ({ revoked: auth.revokeOtherSessions(req.user.id, req.session.id) })));
privateAuth.get('/prefs/:key', wrap((req) => {
  const row = db.prepare('SELECT value FROM user_prefs WHERE user_id = ? AND key = ?').get(req.user.id, req.params.key);
  return { value: row ? JSON.parse(row.value) : null };
}));
privateAuth.put('/prefs/:key', wrap((req) => {
  if (!['theme', 'dashboard.layout', 'windows'].includes(req.params.key)) throw bad('Unknown preference');
  const val = JSON.stringify(req.body?.value ?? null);
  if (val.length > 100000) throw bad('Preference too large');
  db.prepare('INSERT INTO user_prefs (user_id, key, value) VALUES (?,?,?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value').run(req.user.id, req.params.key, val);
  return { ok: true };
}));
void csrfProtect; void authenticate;
