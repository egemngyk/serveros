import { db } from '../db.js';
import { redactObject } from '../lib/util.js';
import { log } from '../logger.js';

const ins = db.prepare('INSERT INTO audit_log (ts, user, ip, action, target, result, meta) VALUES (?, ?, ?, ?, ?, ?, ?)');

/** Append an audit record. `who` may be an Express request or {user, ip}. Never throws. */
export function audit(who, action, target = '', result = 'ok', meta = undefined) {
  try {
    const user = who?.user?.username ?? who?.username ?? null;
    const ip = who?.ip ?? null;
    const m = meta === undefined ? null : JSON.stringify(redactObject(meta));
    ins.run(Date.now(), user, ip, action, String(target ?? '').slice(0, 500), result, m && m.length > 8000 ? m.slice(0, 8000) : m);
  } catch (e) {
    log.error('audit write failed', { err: e });
  }
}

/** Run fn and audit success/failure, rethrowing errors. */
export async function act(req, action, target, fn, meta) {
  try {
    const r = await fn();
    audit(req, action, target, 'ok', meta);
    return r;
  } catch (e) {
    audit(req, action, target, 'error', { ...(meta || {}), error: e.message });
    throw e;
  }
}

export function queryAudit({ limit = 100, offset = 0, action, user, result, q, from, to } = {}) {
  const where = [];
  const p = [];
  if (action) { where.push('action LIKE ?'); p.push(action.replace(/[%_]/g, '') + '%'); }
  if (user) { where.push('user = ?'); p.push(user); }
  if (result) { where.push('result = ?'); p.push(result); }
  if (q) { where.push('(target LIKE ? OR action LIKE ? OR meta LIKE ?)'); const t = `%${q.replace(/[%_]/g, '')}%`; p.push(t, t, t); }
  if (from) { where.push('ts >= ?'); p.push(Number(from)); }
  if (to) { where.push('ts <= ?'); p.push(Number(to)); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM audit_log ${w}`).get(...p).c;
  const rows = db.prepare(`SELECT * FROM audit_log ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...p, Math.min(limit, 500), offset);
  return { total, rows: rows.map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null })) };
}
