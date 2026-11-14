import { Router } from 'express';
import fs from 'node:fs';
import { wrap, v, bad } from '../lib/util.js';
import { act, audit, queryAudit } from '../services/audit.js';
import * as notif from '../services/notifications.js';
import { allSettings, setSetting } from '../services/settings.js';
import { db } from '../db.js';
import { listEnvironments } from '../environments.js';
import { config } from '../config.js';

export function adminRoutes(env) {
  const r = Router();

  r.get('/system', wrap(async () => ({ version: config.version, environments: listEnvironments(), capabilities: await env.capabilities(), strategy: env.backup.strategy(), hostPort: config.hostPort })));

  // settings
  r.get('/settings', wrap(async () => ({ settings: allSettings(), fileRoots: (await env.agent.info())?.file_roots ?? [] })));
  r.put('/settings/:key', wrap((req) => act(req, 'settings.update', req.params.key, async () => ({ value: setSetting(req.params.key, req.body?.value) }), { key: req.params.key })));

  // dashboard layout (per user)
  r.get('/dashboard/layout', wrap((req) => { const row = db.prepare("SELECT value FROM user_prefs WHERE user_id = ? AND key = 'dashboard.layout'").get(req.user.id); return { layout: row ? JSON.parse(row.value) : null }; }));
  r.put('/dashboard/layout', wrap((req) => {
    const l = v.arr(req.body?.layout, 'layout', { max: 30 });
    const clean = l.map((w) => ({ id: v.str(w.id, 'id', { max: 40 }), visible: !!w.visible, span: v.oneOf(Number(w.span), 'span', [1, 2, 3, 4, 6, 12]) }));
    db.prepare("INSERT INTO user_prefs (user_id, key, value) VALUES (?, 'dashboard.layout', ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value").run(req.user.id, JSON.stringify(clean));
    return { ok: true };
  }));

  // notifications & alerts
  r.get('/notifications', wrap((req) => notif.listNotifications({ limit: Number(req.query.limit) || 50, offset: Number(req.query.offset) || 0, unread: req.query.unread === '1', severity: req.query.severity, category: req.query.category, q: req.query.q })));
  r.post('/notifications/read', wrap((req) => ({ updated: notif.markRead(req.body?.ids === 'all' ? 'all' : v.arr(req.body?.ids, 'ids', { max: 500 }).map((x) => v.int(x, 'id', { min: 1 })), req.body?.read !== false) })));
  r.delete('/notifications/read', wrap(() => ({ deleted: notif.clearRead() })));
  r.get('/notifications/:id', wrap((req) => notif.getNotification(v.int(req.params.id, 'id', { min: 1 }))));
  r.delete('/notifications/:id', wrap((req) => ({ deleted: notif.deleteNotifications([v.int(req.params.id, 'id', { min: 1 })]) })));
  r.get('/alerts/rules', wrap(() => notif.listRules()));
  r.put('/alerts/rules/:key', wrap((req) => act(req, 'alerts.rule_update', req.params.key, async () => { notif.updateRule(req.params.key, req.body || {}); return { ok: true }; }, req.body)));
  r.get('/alerts/providers', wrap(() => ({ providers: notif.listProviders(), types: Object.fromEntries(Object.entries(notif.providerTypes).map(([k, t]) => [k, { label: t.label, fields: t.fields }])) })));
  r.post('/alerts/providers', wrap((req) => act(req, 'alerts.provider_save', req.body?.name, async () => ({ id: notif.saveProvider(req.body || {}) }), { type: req.body?.type })));
  r.delete('/alerts/providers/:id', wrap((req) => act(req, 'alerts.provider_delete', req.params.id, async () => { notif.deleteProvider(Number(req.params.id)); return { ok: true }; })));
  r.post('/alerts/providers/:id/test', wrap(async (req) => ({ results: await notif.testProvider(Number(req.params.id)) })));

  // audit
  r.get('/audit', wrap((req) => queryAudit({ limit: Number(req.query.limit) || 100, offset: Number(req.query.offset) || 0, action: req.query.action, user: req.query.user, result: req.query.result, q: req.query.q, from: req.query.from, to: req.query.to })));

  // backups
  const b = env.backup;
  r.get('/backups', wrap(() => ({ backups: b.list(), strategy: b.strategy() })));
  r.post('/backups', wrap((req) => {
    const c = req.body?.contents || {};
    return act(req, 'backup.create', 'manual', () => b.create({ contents: { app: !!c.app, stacks: !!c.stacks, nginx: !!c.nginx, certbot: !!c.certbot, extra: !!c.extra }, kind: 'manual', note: String(req.body?.note || '').slice(0, 200), includeKeys: req.body?.includeKeys === true && req.body?.confirmKeys === true, extraPaths: Array.isArray(req.body?.extraPaths) ? req.body.extraPaths.slice(0, 20).map(String) : [] }), { contents: c });
  }));
  r.post('/backups/volumes', wrap((req) => {
    const names = v.arr(req.body?.volumes, 'volumes', { max: 50 }).map((x) => v.str(x, 'volume', { max: 128 }));
    if (!names.length) throw bad('Select at least one volume');
    return act(req, 'backup.volumes', names.join(','), () => b.backupVolumes(names));
  }));
  r.put('/backups/import', wrap(async (req) => act(req, 'backup.import', String(req.query.name || ''), () => b.importArchive(req, String(req.query.name || 'import.tar.gz')))));
  r.get('/backups/:id/inspect', wrap((req) => b.inspect(req.params.id)));
  r.post('/backups/:id/restore', wrap((req) => {
    if (req.body?.confirm !== 'RESTORE') throw bad('Type RESTORE to confirm');
    return b.restore(req.params.id, req.body?.components, req);
  }));
  r.get('/backups/:id/download', (req, res, next) => {
    try {
      const bk = b.get(req.params.id);
      if (!fs.existsSync(bk.full)) throw bad('Backup file is missing on disk');
      audit(req, 'backup.download', bk.name, 'ok');
      res.download(bk.full, bk.file.split('/').pop());
    } catch (e) { next(e); }
  });
  r.delete('/backups/:id', wrap((req) => {
    if (req.query.confirm !== 'true') throw bad('Confirmation required');
    return act(req, 'backup.delete', req.params.id, async () => { await b.delete(req.params.id); return { ok: true }; });
  }));
  return r;
}
