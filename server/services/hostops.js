import { getSetting } from './settings.js';
import { config } from '../config.js';
import { conflict, bad, v, DOMAIN_RE } from '../lib/util.js';

/** Dashboard hosts/ports used to detect configuration that may break dashboard accessibility. */
function dashboardMarkers(extraHost) {
  const domains = new Set(getSetting('dashboard.domains') || []);
  if (extraHost) domains.add(String(extraHost).split(':')[0].toLowerCase());
  return { domains: [...domains].filter((d) => d && !/^(localhost|127\.|\d+\.\d+\.\d+\.\d+$)/.test(d)), port: config.hostPort };
}
function referencesDashboard(content, m) {
  if (!content) return false;
  const text = content.replace(/#.*$/gm, '');
  const byDomain = m.domains.some((d) => new RegExp(`server_name[^;]*[\\s]${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s;]`, 'i').test(text));
  const byPort = new RegExp(`proxy_pass\\s+https?://(127\\.0\\.0\\.1|localhost|\\[::1\\]|host\\.docker\\.internal)?:?${m.port}\\b`).test(text);
  return byDomain || byPort;
}

export class NginxService {
  constructor(env) { this.env = env; }
  a(op, args, t) { return this.env.agent.call(op, args, t ? { timeout: t } : undefined); }
  info() { return this.a('nginx_info', {}); }
  status() { return this.a('nginx_status', {}); }
  list() { return this.a('nginx_list', {}); }
  read(path) { return this.a('nginx_read', { path: v.str(path, 'path', { min: 1, max: 512 }) }); }
  backups(path) { return this.a('nginx_backups', { path }); }
  backupRead(name) { return this.a('nginx_backup_read', { name }); }
  service(action) { return this.a('nginx_service', { action: v.oneOf(action, 'action', ['test', 'reload', 'restart', 'start', 'stop']) }, 120000); }

  async guard(path, newContent, acknowledge, host, verb) {
    const m = dashboardMarkers(host);
    let old = null;
    try { old = (await this.read(path)).content; } catch { /* new file */ }
    const had = referencesDashboard(old, m);
    const has = newContent === null ? false : referencesDashboard(newContent, m);
    if (had && !has && !acknowledge) {
      throw conflict(`This change would ${verb} the reverse-proxy configuration that serves the ServerOS dashboard (${m.domains.join(', ') || 'port ' + m.port}). You could lose access to the dashboard. Confirm to proceed.`, 'dashboard_risk');
    }
    return { touchesDashboard: had };
  }

  async apply({ path, content, create, dryRun, reload, expectedSha256, acknowledgeDashboard }, host) {
    v.str(path, 'path', { min: 1, max: 512 }); v.str(content, 'content', { max: 2 * 1024 * 1024 });
    const g = await this.guard(path, content, acknowledgeDashboard, host, 'remove or alter');
    const r = await this.a('nginx_apply', { path, content, create: !!create, dry_run: !!dryRun, reload: !!reload, expected_sha256: expectedSha256 }, 120000);
    return { ...r, touchesDashboard: g.touchesDashboard };
  }
  async rename({ from, to, acknowledgeDashboard }, host) {
    await this.guard(from, null, acknowledgeDashboard, host, 'rename away');
    return this.a('nginx_rename', { from, to });
  }
  async remove({ path, acknowledgeDashboard }, host) {
    await this.guard(path, null, acknowledgeDashboard, host, 'delete');
    return this.a('nginx_delete', { path });
  }
  async toggle({ name, enable, acknowledgeDashboard }, host) {
    if (!enable) await this.guard('sites-available/' + name, null, acknowledgeDashboard, host, 'disable');
    return this.a('nginx_toggle', { name, enable: !!enable });
  }
  async restore({ backup, path, reload }, host) {
    const b = await this.backupRead(backup);
    return this.apply({ path: path || b.path, content: b.content, reload }, host);
  }

  /** Best-effort, read-only summary of server/upstream blocks. The raw file stays the source of truth. */
  async overview() {
    const { files } = await this.list();
    const out = [];
    for (const f of files) {
      if (!['sites-enabled', 'conf.d', 'sites-available', 'main'].includes(f.category) || f.size > 500000) continue;
      if (f.category === 'sites-available' && files.some((x) => x.category === 'sites-enabled' && x.symlink && x.target?.endsWith('/' + f.path.split('/').pop()))) continue;
      let text;
      try { text = (await this.read(f.path)).content; } catch { continue; }
      const clean = text.replace(/#.*$/gm, '');
      const servers = [];
      const re = /\bserver\s*\{/g;
      let m;
      while ((m = re.exec(clean))) {
        let depth = 1, i = re.lastIndex;
        while (i < clean.length && depth) { if (clean[i] === '{') depth++; else if (clean[i] === '}') depth--; i++; }
        const body = clean.slice(re.lastIndex, i);
        const grab = (rx) => [...body.matchAll(rx)].map((x) => x[1].trim());
        servers.push({
          names: (grab(/server_name\s+([^;]+);/g)[0] || '').split(/\s+/).filter(Boolean), listen: grab(/listen\s+([^;]+);/g),
          proxy: [...new Set(grab(/proxy_pass\s+([^;]+);/g))], locations: grab(/location\s+([^{]+)\{/g).slice(0, 30),
          ssl: /ssl_certificate\s/.test(body), certs: grab(/ssl_certificate\s+([^;]+);/g), redirectHttps: /return\s+30[1278]\s+https:\/\//.test(body), root: grab(/\broot\s+([^;]+);/g)[0] || null,
        });
        re.lastIndex = i;
      }
      const upstreams = [...clean.matchAll(/\bupstream\s+(\S+)\s*\{([^}]*)\}/g)].map((x) => ({ name: x[1], servers: [...x[2].matchAll(/server\s+([^;]+);/g)].map((s) => s[1].trim()) }));
      if (servers.length || upstreams.length) out.push({ file: f.path, category: f.category, servers, upstreams });
    }
    return out;
  }
}

export class CertbotService {
  constructor(env) { this.env = env; }
  list() { return this.env.agent.call('certbot_list', {}, { timeout: 120000 }); }
  renewalConf(name) { return this.env.agent.call('certbot_renewal_conf', { cert_name: name }); }
  timers() { return this.env.agent.call('certbot_timer', {}); }
  logs(lines = 300) { return this.env.agent.call('log_read', { source: 'file:certbot', lines }); }
  references(name) { return this.env.agent.call('nginx_references', { cert_name: name }); }
  validateIssue(b) {
    const domains = v.arr(b.domains, 'domains', { max: 20 }).map((d) => v.str(String(d).trim().toLowerCase(), 'domain', { re: DOMAIN_RE }));
    if (!domains.length) throw bad('At least one domain is required');
    const method = v.oneOf(b.method || 'nginx', 'method', ['nginx', 'webroot', 'standalone']);
    return { action: 'issue', domains, method, email: b.email || getSetting('certbot.email') || '', webroot: b.webroot, staging: !!b.staging, cert_name: b.certName || undefined };
  }
  stream(args) { return this.env.agent.stream('certbot', args); }
}

export class SystemdService {
  constructor(env) { this.env = env; }
  list() { return this.env.agent.call('systemd_list', {}, { timeout: 40000 }); }
  show(unit) { return this.env.agent.call('systemd_show', { unit }); }
  action(unit, action, confirmCritical) { return this.env.agent.call('systemd_action', { unit, action, confirm_critical: !!confirmCritical }, { timeout: 130000 }); }
  logs(unit, lines = 200) { return this.env.agent.call('log_read', { source: 'unit:' + unit, lines }); }
}

export class FilesService {
  constructor(env) { this.env = env; }
  roots() { const r = getSetting('files.roots'); return Array.isArray(r) && r.length ? r : undefined; }
  call(op, args, t) { return this.env.agent.call(op, { ...args, roots: this.roots() }, t ? { timeout: t } : undefined); }
  stream(op, args) { return this.env.agent.stream(op, { ...args, roots: this.roots() }); }
}

export class LogsService {
  constructor(env) { this.env = env; }
  async sources() {
    const out = [];
    try { out.push(...(await this.env.agent.call('log_sources', {}, { timeout: 8000 })).map((s) => ({ ...s, group: 'Host' }))); } catch { /* agent offline */ }
    try { for (const c of await this.env.docker.list()) out.push({ id: 'container:' + c.id, label: c.name, kind: 'container', group: 'Containers', state: c.state }); } catch { /* docker offline */ }
    return out;
  }
}
