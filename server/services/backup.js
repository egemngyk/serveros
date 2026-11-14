import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from '../db.js';
import { config, toHostDataPath } from '../config.js';
import { HttpError, bad, conflict, notFound } from '../lib/util.js';
import { getSetting, internalGet, internalSet } from './settings.js';
import { notify } from './notifications.js';
import { audit } from './audit.js';
import { log } from '../logger.js';

const sh = promisify(execFile);
const DIR = path.join(config.dataDir, 'backups');
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(DIR, 'volumes'), { recursive: true, mode: 0o700 });

const sha256File = (p) => new Promise((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); });
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out); else if (e.isFile()) out.push(path.relative(base, p));
  }
  return out;
}

export class BackupService {
  constructor(env) { this.env = env; this.busy = false; }

  list() {
    return db.prepare('SELECT * FROM backups ORDER BY created_at DESC').all().map((b) => ({ ...b, contents: JSON.parse(b.contents), exists: fs.existsSync(path.join(DIR, b.file)) }));
  }
  get(id) { const b = db.prepare('SELECT * FROM backups WHERE id = ?').get(id); if (!b) throw notFound('Backup not found'); return { ...b, contents: JSON.parse(b.contents), full: path.join(DIR, b.file) }; }

  strategy() {
    return {
      included: ['Application database (users, settings, alert rules, notification providers, dashboard layouts, audit log, metrics, backup metadata)', 'Compose stacks directory', 'Nginx configuration (via host agent)', 'Certbot configuration and PUBLIC certificate material (private keys only if explicitly requested)'],
      notIncluded: ['Docker volume data is NOT part of these archives. Use "Volume backup" (separate archives) or your own snapshot tooling.', 'Docker images (they can be pulled again) and container filesystem layers.'],
      volumeNote: 'Volume archives are taken from a live volume. For databases, stop the container first for a consistent copy.',
    };
  }

  async create({ contents, kind = 'manual', note = '', includeKeys = false, extraPaths = [] }) {
    if (this.busy) throw conflict('Another backup or restore is in progress', 'busy');
    this.busy = true;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `serveros-${kind === 'pre-restore' ? 'prerestore-' : ''}${stamp}`;
    const work = fs.mkdtempSync(path.join(config.dataDir, 'tmp-backup-'));
    const included = []; const warnings = [];
    try {
      if (contents.app) {
        fs.mkdirSync(path.join(work, 'app'));
        await db.backup(path.join(work, 'app', 'serveros.db'));
        const dump = (sql) => JSON.stringify(db.prepare(sql).all(), null, 2);
        fs.writeFileSync(path.join(work, 'app', 'settings.json'), dump('SELECT key, value FROM settings'));
        fs.writeFileSync(path.join(work, 'app', 'dashboard-layouts.json'), dump("SELECT user_id, value FROM user_prefs WHERE key = 'dashboard.layout'"));
        fs.writeFileSync(path.join(work, 'app', 'alert-rules.json'), dump('SELECT * FROM alert_rules'));
        included.push('app');
      }
      if (contents.stacks && fs.existsSync(config.stacksDir)) { fs.cpSync(config.stacksDir, path.join(work, 'stacks'), { recursive: true }); included.push('stacks'); }
      const agentJobs = [['nginx', 'nginx'], ['certbot', 'certbot']].filter(([k]) => contents[k]);
      if (contents.extra && extraPaths.length) agentJobs.push(['extra', 'extra']);
      if (agentJobs.length) {
        fs.mkdirSync(path.join(work, 'host'));
        for (const [key, kindName] of agentJobs) {
          const dest = toHostDataPath(path.join(work, 'host', `${key}.tar.gz`));
          if (!dest) { warnings.push(`${key}: HOST_DATA_DIR is not configured`); continue; }
          try {
            await this.env.agent.call('host_archive', { kind: kindName, dest, include_keys: key === 'certbot' && includeKeys, paths: extraPaths, roots: undefined }, { timeout: 300000 });
            included.push(key + (key === 'certbot' && includeKeys ? '(+private keys)' : ''));
          } catch (e) { warnings.push(`${key}: ${e.message}`); }
        }
      }
      if (!included.length) throw bad('Nothing could be backed up' + (warnings.length ? ': ' + warnings.join('; ') : ''));
      const files = {};
      for (const rel of walk(work)) files[rel] = await sha256File(path.join(work, rel));
      fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify({ format: 1, app: 'serveros', version: config.version, created: new Date().toISOString(), kind, contents: included, includesPrivateKeys: includeKeys && included.some((i) => i.includes('private')), files }, null, 2));
      const file = `${name}.tar.gz`;
      const out = path.join(DIR, file);
      await sh('tar', ['-czf', out, '-C', work, '.'], { maxBuffer: 1 << 24 });
      fs.chmodSync(out, 0o600);
      const stat = fs.statSync(out);
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO backups (id, name, file, kind, created_at, size, sha256, contents, note) VALUES (?,?,?,?,?,?,?,?,?)').run(id, name, file, kind, Date.now(), stat.size, await sha256File(out), JSON.stringify(included), [note, ...warnings].filter(Boolean).join(' | ') || null);
      return { id, name, size: stat.size, contents: included, warnings };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
      this.busy = false;
    }
  }

  async delete(id) {
    const b = this.get(id);
    fs.rmSync(b.full, { force: true });
    db.prepare('DELETE FROM backups WHERE id = ?').run(id);
  }

  /** Validate an archive without applying anything; returns what a restore would replace. */
  async inspect(id) {
    const b = this.get(id);
    if (b.kind === 'volume') throw bad('Volume archives are restored manually (see documentation).');
    const { stdout } = await sh('tar', ['-tzvf', b.full], { maxBuffer: 1 << 25 });
    const names = (await sh('tar', ['-tzf', b.full], { maxBuffer: 1 << 25 })).stdout.split('\n').filter(Boolean);
    for (const n of names) if (n.startsWith('/') || n.split('/').includes('..')) throw bad(`Archive contains an unsafe path: ${n}`);
    if (/^[lhbcps]/m.test(stdout.split('\n').filter((l) => /^[bcp]/.test(l)).join('\n'))) throw bad('Archive contains special device entries');
    const tmp = fs.mkdtempSync(path.join(config.dataDir, 'tmp-inspect-'));
    try {
      await sh('tar', ['-xzf', path.join(DIR, b.file), '-C', tmp, './manifest.json']);
      const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'));
      if (manifest.app !== 'serveros') throw bad('Not a ServerOS backup');
      const actual = await sha256File(b.full);
      if (b.sha256 && actual !== b.sha256) throw new HttpError(422, 'Archive checksum does not match the recorded value (file modified or corrupted)', 'checksum_mismatch');
      const plan = [];
      for (const c of manifest.contents) {
        const key = c.replace(/\(.*\)/, '');
        if (key === 'app') plan.push({ component: 'app', replaces: 'The application database: users, passwords, settings, alert rules, providers, audit log and metrics are REPLACED. The app restarts afterwards and you will have to sign in again with the restored accounts.' });
        if (key === 'stacks') { const cur = fs.existsSync(config.stacksDir) ? fs.readdirSync(config.stacksDir) : []; plan.push({ component: 'stacks', replaces: `Files in ${config.stacksDir} that exist in the archive are overwritten. Existing stacks: ${cur.join(', ') || 'none'}.` }); }
        if (key === 'nginx') plan.push({ component: 'nginx', replaces: 'Files in the Nginx configuration directory that exist in the archive are overwritten (files not in the archive are kept). The configuration is validated and rolled back automatically if invalid.' });
        if (key === 'certbot') plan.push({ component: 'certbot', replaces: c.includes('private') ? 'Full /etc/letsencrypt including PRIVATE KEYS is overwritten.' : 'Certbot renewal configuration and hooks are overwritten. Certificates themselves are not re-created.' });
      }
      return { id, name: b.name, created: manifest.created, size: b.size, verified: true, includesPrivateKeys: !!manifest.includesPrivateKeys, plan, fileCount: names.length };
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  async restore(id, components, req) {
    const info = await this.inspect(id);
    const b = this.get(id);
    const want = new Set(components?.length ? components : info.plan.map((p) => p.component));
    const available = new Set(info.plan.map((p) => p.component));
    for (const w of want) if (!available.has(w)) throw bad(`Component not present in archive: ${w}`);
    // 1. pre-restore backup of everything that will be replaced
    const pre = await this.create({ contents: { app: want.has('app'), stacks: want.has('stacks'), nginx: want.has('nginx'), certbot: want.has('certbot') }, kind: 'pre-restore', note: `Automatic backup before restoring ${b.name}`, includeKeys: false }).catch((e) => { throw new HttpError(500, `Pre-restore backup failed, nothing was changed: ${e.message}`, 'pre_restore_failed'); });
    this.busy = true;
    const tmp = fs.mkdtempSync(path.join(config.dataDir, 'tmp-restore-'));
    const results = [];
    let restartApp = false;
    try {
      await sh('tar', ['-xzf', b.full, '-C', tmp], { maxBuffer: 1 << 24 });
      const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'));
      for (const [rel, hash] of Object.entries(manifest.files || {})) if ((await sha256File(path.join(tmp, rel))) !== hash) throw new HttpError(422, `Integrity check failed for ${rel}`, 'integrity');
      if (want.has('stacks') && fs.existsSync(path.join(tmp, 'stacks'))) { fs.cpSync(path.join(tmp, 'stacks'), config.stacksDir, { recursive: true, force: true }); results.push({ component: 'stacks', ok: true }); }
      for (const key of ['nginx', 'certbot']) {
        if (!want.has(key)) continue;
        const src = toHostDataPath(path.join(tmp, 'host', `${key}.tar.gz`));
        // the agent reads from the (host-visible) data directory, so stage inside it
        const staged = path.join(config.dataDir, `staged-${key}.tar.gz`);
        fs.copyFileSync(path.join(tmp, 'host', `${key}.tar.gz`), staged); fs.chmodSync(staged, 0o600);
        try { const r = await this.env.agent.call('host_restore', { kind: key, src: toHostDataPath(staged) }, { timeout: 300000 }); results.push({ component: key, ok: r.restored !== false, detail: r }); }
        catch (e) { results.push({ component: key, ok: false, error: e.message }); }
        finally { fs.rmSync(staged, { force: true }); }
        void src;
      }
      if (want.has('app')) {
        const dest = path.join(config.dataDir, 'restore-pending');
        fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
        fs.copyFileSync(path.join(tmp, 'app', 'serveros.db'), path.join(dest, 'serveros.db'));
        results.push({ component: 'app', ok: true, detail: 'Database staged; the application restarts now.' });
        restartApp = true;
      }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); this.busy = false; }
    audit(req, 'backup.restore', b.name, results.every((r) => r.ok) ? 'ok' : 'partial', { results, preRestore: pre.id });
    if (restartApp) setTimeout(() => { log.warn('Restarting to apply restored database'); process.exit(0); }, 1500);
    return { results, preRestoreBackup: pre, restarting: restartApp };
  }

  async importArchive(readable, filename) {
    const safe = path.basename(filename || 'import').replace(/[^A-Za-z0-9._-]/g, '_');
    const tmp = path.join(DIR, `.import-${Date.now()}.tmp`);
    await new Promise((res, rej) => { const w = fs.createWriteStream(tmp, { mode: 0o600 }); readable.pipe(w); w.on('finish', res); w.on('error', rej); readable.on('error', rej); });
    try {
      const names = (await sh('tar', ['-tzf', tmp], { maxBuffer: 1 << 25 })).stdout.split('\n').filter(Boolean);
      if (names.some((n) => n.startsWith('/') || n.split('/').includes('..'))) throw bad('Archive contains unsafe paths');
      const t = fs.mkdtempSync(path.join(config.dataDir, 'tmp-import-'));
      try {
        await sh('tar', ['-xzf', tmp, '-C', t, './manifest.json']);
        const m = JSON.parse(fs.readFileSync(path.join(t, 'manifest.json'), 'utf8'));
        if (m.app !== 'serveros' || m.format !== 1) throw bad('Not a ServerOS backup');
        const file = `imported-${Date.now()}-${safe}`.replace(/\.tar\.gz$/, '') + '.tar.gz';
        fs.renameSync(tmp, path.join(DIR, file));
        const id = crypto.randomUUID();
        db.prepare('INSERT INTO backups (id, name, file, kind, created_at, size, sha256, contents, note) VALUES (?,?,?,?,?,?,?,?,?)').run(id, file.replace('.tar.gz', ''), file, 'imported', Date.now(), fs.statSync(path.join(DIR, file)).size, await sha256File(path.join(DIR, file)), JSON.stringify(m.contents || []), 'Imported archive');
        return { id };
      } finally { fs.rmSync(t, { recursive: true, force: true }); }
    } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  }

  // ---- Docker volume data: a separate strategy using a helper container
  async backupVolumes(names) {
    const host = config.hostDataDir;
    if (!host) throw bad('HOST_DATA_DIR is not configured; volume backups need to know the host path of the data directory');
    const vols = new Set((await this.env.docker.volumes()).map((x) => x.name));
    const out = [];
    const helper = 'busybox:stable';
    try { await this.env.docker.d.getImage(helper).inspect(); } catch { await this.env.docker.pullAwait(helper); }
    for (const n of names) {
      if (!vols.has(n)) throw notFound(`Volume not found: ${n}`);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = `volume-${n}-${stamp}.tar.gz`;
      const c = await this.env.docker.d.createContainer({ Image: helper, Cmd: ['tar', '-czf', `/backup/${file}`, '-C', '/src', '.'], HostConfig: { Binds: [`${n}:/src:ro`, `${path.posix.join(host, 'backups', 'volumes')}:/backup`], AutoRemove: false, NetworkMode: 'none' }, User: '0:0' });
      try {
        await c.start();
        const r = await c.wait();
        if (r.StatusCode !== 0) throw new HttpError(500, `Volume archive failed for ${n} (exit ${r.StatusCode})`);
      } finally { await c.remove({ force: true, v: false }).catch(() => {}); }
      const p = path.join(DIR, 'volumes', file);
      fs.chmodSync(p, 0o600);
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO backups (id, name, file, kind, created_at, size, sha256, contents, note) VALUES (?,?,?,?,?,?,?,?,?)').run(id, file.replace('.tar.gz', ''), path.join('volumes', file), 'volume', Date.now(), fs.statSync(p).size, await sha256File(p), JSON.stringify([`volume:${n}`]), 'Live copy of the volume; stop writers first for consistency.');
      out.push({ id, volume: n, file });
    }
    return out;
  }

  // ---- retention + scheduler
  applyRetention() {
    const s = getSetting('backup.schedule');
    const rows = db.prepare("SELECT * FROM backups WHERE kind = 'scheduled' ORDER BY created_at DESC").all();
    const cutoff = Date.now() - s.retention.maxAgeDays * 86400000;
    rows.forEach((b, i) => { if (i >= s.retention.keepLast || b.created_at < cutoff) { fs.rmSync(path.join(DIR, b.file), { force: true }); db.prepare('DELETE FROM backups WHERE id = ?').run(b.id); } });
  }

  startScheduler() {
    setInterval(async () => {
      const s = getSetting('backup.schedule');
      if (!s.enabled || this.busy) return;
      const last = internalGet('backup.lastScheduled', 0);
      const now = new Date();
      const [hh, mm] = s.time.split(':').map(Number);
      const due = s.frequency === 'hourly' ? now.getTime() - last >= 3600000
        : s.frequency === 'daily' ? now.getTime() - last >= 23 * 3600000 && (now.getHours() > hh || (now.getHours() === hh && now.getMinutes() >= mm))
          : now.getTime() - last >= 6.9 * 86400000 && now.getHours() >= hh;
      if (!due) return;
      internalSet('backup.lastScheduled', now.getTime());
      try {
        const r = await this.create({ contents: s.contents, kind: 'scheduled', note: 'Scheduled backup' });
        audit({ username: 'scheduler' }, 'backup.create', r.name, 'ok', { scheduled: true });
        this.applyRetention();
      } catch (e) {
        audit({ username: 'scheduler' }, 'backup.create', 'scheduled', 'error', { error: e.message });
        notify({ severity: 'critical', category: 'backup', title: 'Scheduled backup failed', body: e.message });
      }
    }, 60000).unref();
  }
}
