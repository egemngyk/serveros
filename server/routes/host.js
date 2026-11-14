import { Router } from 'express';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { wrap, v, bad, DOMAIN_RE, NAME_RE, HttpError } from '../lib/util.js';
import { act, audit } from '../services/audit.js';
import { T_CTRL } from '../services/agent.js';
import { frame } from '../services/agent.js';

const UNIT = /^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,127}\.service$/;

export function monitorRoutes(env) {
  const r = Router();
  r.get('/snapshot', wrap(() => env.monitor.latest || env.monitor.collect()));
  r.get('/history', wrap((req) => env.monitor.history(String(req.query.range || '1h'))));
  r.get('/processes', wrap(() => env.monitor.processes()));
  r.post('/processes/:pid/kill', wrap((req) => {
    if (req.body?.confirm !== true) throw bad('Confirmation required');
    const pid = v.int(req.params.pid, 'pid', { min: 2 });
    return act(req, 'process.signal', String(pid), () => env.monitor.killProcess(pid, v.oneOf(req.body?.signal || 'TERM', 'signal', ['TERM', 'KILL', 'HUP', 'INT', 'STOP', 'CONT'])), { signal: req.body?.signal || 'TERM' });
  }));
  return r;
}

export function nginxRoutes(env) {
  const r = Router();
  const n = env.nginx;
  const host = (req) => req.get('x-forwarded-host') || req.get('host');
  r.get('/info', wrap(async () => ({ info: await n.info(), status: await n.status() })));
  r.get('/files', wrap(() => n.list()));
  r.get('/file', wrap((req) => n.read(String(req.query.path))));
  r.get('/overview', wrap(() => n.overview()));
  r.put('/file', wrap((req) => act(req, req.body?.dryRun ? 'nginx.validate' : 'nginx.save', req.body?.path, () => n.apply(req.body || {}, host(req)), { reload: !!req.body?.reload, create: !!req.body?.create })));
  r.post('/rename', wrap((req) => act(req, 'nginx.rename', `${req.body?.from} -> ${req.body?.to}`, () => n.rename(req.body || {}, host(req)))));
  r.delete('/file', wrap((req) => {
    if (req.query.confirm !== 'true') throw bad('Confirmation required');
    return act(req, 'nginx.delete', String(req.query.path), () => n.remove({ path: String(req.query.path), acknowledgeDashboard: req.query.acknowledgeDashboard === 'true' }, host(req)));
  }));
  r.post('/sites/toggle', wrap((req) => act(req, req.body?.enable ? 'nginx.enable_site' : 'nginx.disable_site', req.body?.name, () => n.toggle(req.body || {}, host(req)))));
  r.get('/backups', wrap((req) => n.backups(req.query.path ? String(req.query.path) : undefined)));
  r.get('/backups/:name', wrap((req) => n.backupRead(req.params.name)));
  r.post('/restore', wrap((req) => act(req, 'nginx.restore', req.body?.backup, () => n.restore(req.body || {}, host(req)))));
  r.post('/service', wrap((req) => act(req, `nginx.${req.body?.action}`, 'nginx', () => n.service(req.body?.action), {})));
  return r;
}

export function certbotRoutes(env) {
  const r = Router();
  const c = env.certbot;
  const streamAgent = async (req, res, next, action, args, target) => {
    try {
      res.setHeader('Content-Type', 'application/x-ndjson'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Accel-Buffering', 'no');
      let s;
      try { s = await c.stream(args); } catch (e) { audit(req, action, target, 'error', { error: e.message }); throw e; }
      let buf = '';
      s.on('data', (b) => { buf += b.toString('utf8'); const parts = buf.split(/\r?\n/); buf = parts.pop(); for (const l of parts) res.write(JSON.stringify({ line: l }) + '\n'); });
      s.on('exit', (e) => { if (buf) res.write(JSON.stringify({ line: buf }) + '\n'); res.write(JSON.stringify({ done: true, code: e.code }) + '\n'); audit(req, action, target, e.code === 0 ? 'ok' : 'error', { exitCode: e.code }); res.end(); });
      s.on('close', () => { if (!res.writableEnded) res.end(); });
      res.on('close', () => s.close());
    } catch (e) { if (res.headersSent) res.end(); else next(e); }
  };
  r.get('/', wrap(async () => ({ ...(await c.list()), timers: (await c.timers().catch(() => ({ timers: [] }))).timers })));
  r.get('/logs', wrap(() => c.logs(300)));
  r.get('/renewal/:name', wrap((req) => c.renewalConf(v.str(req.params.name, 'name', { re: NAME_RE }))));
  r.get('/references/:name', wrap((req) => c.references(v.str(req.params.name, 'name', { re: NAME_RE }))));
  r.post('/issue', (req, res, next) => { try { const a = c.validateIssue(req.body || {}); if (req.body?.confirm !== true) throw bad('Confirmation required'); streamAgent(req, res, next, 'certbot.issue', a, a.domains.join(',')); } catch (e) { next(e); } });
  r.post('/renew', (req, res, next) => { try { const dry = v.bool(req.body?.dryRun); if (!dry && req.body?.confirm !== true) throw bad('Confirmation required'); streamAgent(req, res, next, dry ? 'certbot.dry_run' : 'certbot.renew', { action: dry ? 'dry_run' : 'renew', cert_name: req.body?.certName, force: v.bool(req.body?.force) }, req.body?.certName || 'all'); } catch (e) { next(e); } });
  r.post('/revoke', (req, res, next) => { try { if (req.body?.confirm !== true) throw bad('Confirmation required'); streamAgent(req, res, next, 'certbot.revoke', { action: 'revoke', cert_name: v.str(req.body?.certName, 'certName', { re: NAME_RE }) }, req.body?.certName); } catch (e) { next(e); } });
  r.post('/delete', (req, res, next) => { try { if (req.body?.confirm !== true) throw bad('Confirmation required'); streamAgent(req, res, next, 'certbot.delete', { action: 'delete', cert_name: v.str(req.body?.certName, 'certName', { re: NAME_RE }), force: v.bool(req.body?.force) }, req.body?.certName); } catch (e) { next(e); } });
  return r;
}

export function systemdRoutes(env) {
  const r = Router();
  const unit = (req) => v.str(req.params.unit, 'unit', { re: UNIT });
  r.get('/', wrap(() => env.systemd.list()));
  r.get('/:unit', wrap((req) => env.systemd.show(unit(req))));
  r.get('/:unit/logs', wrap((req) => env.systemd.logs(unit(req), Math.min(Number(req.query.lines) || 200, 2000))));
  r.post('/:unit/:action', wrap((req) => {
    const action = v.oneOf(req.params.action, 'action', ['start', 'stop', 'restart', 'reload', 'enable', 'disable']);
    return act(req, `service.${action}`, unit(req), () => env.systemd.action(unit(req), action, req.body?.confirmCritical), {});
  }));
  return r;
}

export function filesRoutes(env) {
  const r = Router();
  const f = env.files;
  const p = (x, k = 'path') => v.str(x, k, { min: 1, max: 4096 });
  r.get('/list', wrap((req) => f.call('fs_list', { path: p(req.query.path) })));
  r.get('/stat', wrap((req) => f.call('fs_stat', { path: p(req.query.path) })));
  r.get('/read', wrap((req) => f.call('fs_read', { path: p(req.query.path) })));
  r.put('/write', wrap((req) => act(req, 'file.write', req.body?.path, () => f.call('fs_write', { path: p(req.body?.path), content: req.body?.content, create: !!req.body?.create, expected_sha256: req.body?.expectedSha256 }))));
  r.post('/mkdir', wrap((req) => act(req, 'file.mkdir', req.body?.path, () => f.call('fs_mkdir', { path: p(req.body?.path) }))));
  r.post('/rename', wrap((req) => act(req, 'file.rename', `${req.body?.from} -> ${req.body?.to}`, () => f.call('fs_rename', { from: p(req.body?.from), to: p(req.body?.to) }))));
  r.post('/copy', wrap((req) => act(req, 'file.copy', `${req.body?.from} -> ${req.body?.to}`, () => f.call('fs_copy', { from: p(req.body?.from), to: p(req.body?.to) }), {})));
  r.post('/chmod', wrap((req) => act(req, 'file.chmod', req.body?.path, () => f.call('fs_chmod', { path: p(req.body?.path), mode: String(req.body?.mode) }), { mode: req.body?.mode })));
  r.delete('/', wrap((req) => {
    if (req.query.confirm !== 'true') throw bad('Confirmation required');
    return act(req, 'file.delete', String(req.query.path), () => f.call('fs_delete', { path: p(req.query.path), recursive: req.query.recursive === 'true' }), { recursive: req.query.recursive === 'true' });
  }));
  r.get('/zip-info', wrap((req) => f.call('dir_zip_info', { path: p(req.query.path) }, 120000)));
  r.get('/download-zip', async (req, res, next) => {
    try {
      const path = p(req.query.path);
      const s = await f.stream('dir_zip', { path });
      const name = String(s.header.name || 'folder.zip').replace(/[^\w.\- ]/g, '_');
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      res.setHeader('Cache-Control', 'no-store');
      s.on('data', (b) => { if (!res.write(b)) { s.pause(); res.once('drain', () => s.resume()); } });
      s.on('exit', () => { res.end(); audit(req, 'file.download_zip', path, 'ok', { files: s.header.files, bytes: s.header.size }); });
      s.on('close', () => { if (!res.writableEnded) res.end(); });
      res.on('close', () => s.close());
    } catch (e) { audit(req, 'file.download_zip', String(req.query.path), 'error', { error: e.message }); next(e); }
  });
  r.get('/download', async (req, res, next) => {
    try {
      const path = p(req.query.path);
      const s = await f.stream('file_get', { path });
      const name = String(s.header.name || 'download').replace(/[^\w.\- ]/g, '_');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      if (s.header.size !== undefined) res.setHeader('Content-Length', s.header.size);
      s.on('data', (b) => { if (!res.write(b)) { s.pause(); res.once('drain', () => s.resume()); } });
      s.on('exit', () => { res.end(); audit(req, 'file.download', path, 'ok'); });
      s.on('close', () => { if (!res.writableEnded) res.end(); });
      res.on('close', () => s.close());
    } catch (e) { next(e); }
  });
  r.put('/upload', async (req, res, next) => {
    try {
      const path = p(req.query.path);
      const s = await f.stream('file_put', { path, overwrite: req.query.overwrite === 'true' });
      const done = new Promise((resolve, reject) => { s.on('exit', (e) => (e.code === 0 ? resolve(e) : reject(new HttpError(e.error?.includes('exists') ? 409 : 400, e.error || 'Upload failed')))); s.on('close', () => reject(new HttpError(502, 'Upload connection closed'))); });
      done.catch(() => {});
      for await (const chunk of req) { for (let i = 0; i < chunk.length; i += 262144) s.write(chunk.subarray(i, i + 262144)); }
      s.control({ end: true });
      const result = await done;
      s.close();
      audit(req, 'file.upload', path, 'ok', { size: result.size });
      res.json({ ok: true, size: result.size });
    } catch (e) { audit(req, 'file.upload', String(req.query.path), 'error', { error: e.message }); next(e); }
  });
  return r;
}
void Readable; void pipeline; void T_CTRL; void frame; void DOMAIN_RE;

export function logsRoutes(env) {
  const r = Router();
  r.get('/sources', wrap(() => env.logs.sources()));
  r.get('/read', wrap(async (req) => {
    const source = String(req.query.source || '');
    if (source.startsWith('container:')) {
      const lines = await env.docker.logs(source.slice(10), { tail: Math.min(Number(req.query.lines) || 300, 20000), timestamps: true });
      return { lines: lines.map((l) => `${l.t || ''} ${l.m}`.trim()) };
    }
    return env.agent.call('log_read', { source, lines: Number(req.query.lines) || 300, priority: req.query.priority, since: req.query.since, until: req.query.until });
  }));
  return r;
}
