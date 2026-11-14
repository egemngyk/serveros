import { db } from '../db.js';
import { bus } from './bus.js';
import { log } from '../logger.js';
import { HttpError, bad } from '../lib/util.js';

const SEV = { info: 0, warning: 1, critical: 2 };

/** Notification provider registry. Add new providers here (e.g. e-mail) without touching callers. */
export const providerTypes = {
  webhook: {
    label: 'Webhook (JSON POST)',
    fields: [{ name: 'url', label: 'URL', type: 'url', secret: false, required: true }, { name: 'authHeader', label: 'Authorization header value (optional)', type: 'password', secret: true }],
    async send(cfg, n) {
      const headers = { 'content-type': 'application/json' };
      if (cfg.authHeader) headers.authorization = cfg.authHeader;
      const r = await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify({ source: 'serveros', ...n }), signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    },
  },
  telegram: {
    label: 'Telegram bot',
    fields: [{ name: 'botToken', label: 'Bot token', type: 'password', secret: true, required: true }, { name: 'chatId', label: 'Chat ID', type: 'text', secret: false, required: true }],
    async send(cfg, n) {
      const r = await fetch(`https://api.telegram.org/bot${encodeURIComponent(cfg.botToken)}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ chat_id: cfg.chatId, text: `[${n.severity.toUpperCase()}] ${n.title}\n${n.body || ''}`.slice(0, 4000) }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    },
  },
  discord: {
    label: 'Discord webhook',
    fields: [{ name: 'webhookUrl', label: 'Webhook URL', type: 'password', secret: true, required: true }],
    async send(cfg, n) {
      const r = await fetch(cfg.webhookUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ content: `**[${n.severity.toUpperCase()}] ${n.title}**\n${n.body || ''}`.slice(0, 1900) }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    },
  },
};

const MASK = '••••••••';

export function listProviders() {
  return db.prepare('SELECT * FROM notification_providers ORDER BY id').all().map((p) => {
    const cfg = JSON.parse(p.config);
    const def = providerTypes[p.type];
    const safe = {};
    for (const f of def?.fields || []) safe[f.name] = f.secret ? (cfg[f.name] ? MASK : '') : cfg[f.name] ?? '';
    return { id: p.id, type: p.type, name: p.name, enabled: !!p.enabled, minSeverity: p.min_severity, config: safe };
  });
}

function cleanConfig(type, input, existing = {}) {
  const def = providerTypes[type];
  if (!def) throw bad('Unknown provider type');
  const out = {};
  for (const f of def.fields) {
    let val = input?.[f.name];
    if (f.secret && val === MASK) val = existing[f.name];
    if (typeof val !== 'string') val = '';
    if (f.required && !val) throw bad(`${f.label} is required`);
    if (f.type === 'url' && val && !/^https?:\/\//i.test(val)) throw bad(`${f.label} must be an http(s) URL`);
    if (f.name === 'webhookUrl' && val && !/^https:\/\//i.test(val)) throw bad('Webhook URL must be https');
    out[f.name] = val.slice(0, 1000);
  }
  return out;
}

export function saveProvider({ id, type, name, enabled = true, minSeverity = 'warning', config }) {
  if (!providerTypes[type]) throw bad('Unknown provider type');
  if (typeof name !== 'string' || !name || name.length > 60) throw bad('Name is required');
  if (!(minSeverity in SEV)) throw bad('Invalid severity');
  if (id) {
    const row = db.prepare('SELECT * FROM notification_providers WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'Provider not found');
    const cfg = cleanConfig(type, config, JSON.parse(row.config));
    db.prepare('UPDATE notification_providers SET type=?, name=?, config=?, enabled=?, min_severity=? WHERE id=?').run(type, name, JSON.stringify(cfg), enabled ? 1 : 0, minSeverity, id);
    return id;
  }
  const cfg = cleanConfig(type, config);
  return db.prepare('INSERT INTO notification_providers (type, name, config, enabled, min_severity) VALUES (?,?,?,?,?)').run(type, name, JSON.stringify(cfg), enabled ? 1 : 0, minSeverity).lastInsertRowid;
}
export function deleteProvider(id) { db.prepare('DELETE FROM notification_providers WHERE id = ?').run(id); }

async function dispatch(n, only) {
  const rows = db.prepare('SELECT * FROM notification_providers WHERE enabled = 1').all().filter((p) => (only ? p.id === only : true));
  const results = [];
  for (const p of rows) {
    if (!only && SEV[n.severity] < SEV[p.min_severity]) continue;
    try { await providerTypes[p.type].send(JSON.parse(p.config), n); results.push({ id: p.id, ok: true }); }
    catch (e) { log.warn('notification provider failed', { provider: p.name, err: e.message }); results.push({ id: p.id, ok: false, error: e.message }); }
  }
  return results;
}
export const testProvider = (id) => dispatch({ severity: 'info', category: 'test', title: 'ServerOS test notification', body: 'Your notification provider is working.' }, id);

export function notify({ severity = 'warning', category, title, body = '', ruleKey = null }) {
  const info = db.prepare('INSERT INTO notifications (ts, severity, category, title, body, rule_key) VALUES (?,?,?,?,?,?)')
    .run(Date.now(), severity, category, String(title).slice(0, 200), String(body).slice(0, 2000), ruleKey);
  const n = { id: info.lastInsertRowid, ts: Date.now(), severity, category, title, body, ruleKey, read: 0 };
  bus.emit('notification', n);
  dispatch(n).catch(() => {});
  return n;
}

export function listNotifications({ limit = 50, offset = 0, unread = false, severity, category, q } = {}) {
  const where = []; const p = [];
  if (unread) where.push('read = 0');
  if (severity && SEV[severity] !== undefined) { where.push('severity = ?'); p.push(severity); }
  if (category) { where.push('category = ?'); p.push(category); }
  if (q) { where.push('(title LIKE ? OR body LIKE ?)'); const t = `%${String(q).replace(/[%_]/g, '')}%`; p.push(t, t); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return {
    unread: db.prepare('SELECT COUNT(*) c FROM notifications WHERE read = 0').get().c,
    unreadCritical: db.prepare("SELECT COUNT(*) c FROM notifications WHERE read = 0 AND severity = 'critical'").get().c,
    total: db.prepare(`SELECT COUNT(*) c FROM notifications ${w}`).get(...p).c,
    categories: db.prepare('SELECT DISTINCT category FROM notifications ORDER BY category').all().map((r) => r.category),
    rows: db.prepare(`SELECT * FROM notifications ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...p, Math.min(limit, 200), offset),
  };
}
export function getNotification(id) {
  const r = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
  if (!r) throw new HttpError(404, 'Notification not found');
  return r;
}
/** ids: 'all' or an array of ids. read=false marks them unread again. */
export function markRead(ids, read = true) {
  const val = read ? 1 : 0;
  if (ids === 'all') return db.prepare('UPDATE notifications SET read = ? WHERE read != ?').run(val, val).changes;
  const st = db.prepare('UPDATE notifications SET read = ? WHERE id = ?');
  return db.transaction(() => ids.reduce((n, id) => n + st.run(val, id).changes, 0))();
}
export function deleteNotifications(ids) {
  const st = db.prepare('DELETE FROM notifications WHERE id = ?');
  return db.transaction(() => ids.reduce((n, id) => n + st.run(id).changes, 0))();
}
export function clearRead() { return db.prepare('DELETE FROM notifications WHERE read = 1').run().changes; }
export function pruneNotifications() { db.prepare('DELETE FROM notifications WHERE ts < ?').run(Date.now() - 90 * 86400000); }

// ------------------------------------------------------------ alert rules
export const listRules = () => db.prepare('SELECT * FROM alert_rules ORDER BY rowid').all().map((r) => ({ ...r, enabled: !!r.enabled }));
export function updateRule(key, { enabled, threshold, duration_s, cooldown_s }) {
  const r = db.prepare('SELECT * FROM alert_rules WHERE key = ?').get(key);
  if (!r) throw new HttpError(404, 'Rule not found');
  const num = (x, d, lo, hi, name) => { if (x === undefined) return d; if (typeof x !== 'number' || !Number.isFinite(x) || x < lo || x > hi) throw bad(`${name} must be between ${lo} and ${hi}`); return x; };
  db.prepare('UPDATE alert_rules SET enabled=?, threshold=?, duration_s=?, cooldown_s=? WHERE key=?').run(
    enabled === undefined ? r.enabled : enabled ? 1 : 0,
    num(threshold, r.threshold, 0, 100000, 'threshold'), Math.round(num(duration_s, r.duration_s, 0, 86400, 'duration_s')), Math.round(num(cooldown_s, r.cooldown_s, 0, 7 * 86400, 'cooldown_s')), key);
}

const lastFired = new Map();
/** Fire an alert for a rule (respects enabled + cooldown). `subject` distinguishes instances (e.g. container id). */
export function fire(ruleKey, subject, { title, body, severity = 'warning', category }) {
  const r = db.prepare('SELECT * FROM alert_rules WHERE key = ?').get(ruleKey);
  if (!r || !r.enabled) return null;
  const k = ruleKey + ':' + subject;
  const now = Date.now();
  if (r.cooldown_s > 0 && now - (lastFired.get(k) || 0) < r.cooldown_s * 1000) return null;
  lastFired.set(k, now);
  return notify({ severity, category: category || r.metric, title, body, ruleKey });
}
export const getRule = (key) => db.prepare('SELECT * FROM alert_rules WHERE key = ?').get(key);
