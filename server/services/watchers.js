import { bus } from './bus.js';
import { fire, getRule } from './notifications.js';
import { log } from '../logger.js';

/** Event-driven alerts: container crashes/stops, docker daemon, nginx, certs, failed services. */
export function startWatchers(env) {
  const docker = env.docker;

  bus.on('docker.event', async (e) => {
    if (e.Type !== 'container') return;
    const action = (e.Action || '').split(':')[0];
    const name = e.Actor?.Attributes?.name || e.id?.slice(0, 12);
    if (action === 'oom') fire('container_crash', e.id, { title: `Container ${name} ran out of memory`, body: 'The kernel OOM killer terminated a process in this container.', severity: 'critical', category: 'docker' });
    if (action !== 'die') return;
    const code = Number(e.Actor?.Attributes?.exitCode ?? 0);
    if (docker.wasExpected(e.id)) return;
    if (code !== 0) fire('container_crash', e.id, { title: `Container ${name} crashed`, body: `Exited with code ${code}.`, severity: 'critical', category: 'docker' });
    else {
      // exit 0 without a user action: unexpected unless it is a one-shot (restart policy "no" and short-lived is ambiguous, so we still report it)
      fire('container_stop', e.id, { title: `Container ${name} stopped unexpectedly`, body: 'It exited without a stop request from ServerOS.', severity: 'warning', category: 'docker' });
    }
  });

  let downSince = null;
  bus.on('docker.daemon', ({ up }) => { downSince = up ? null : Date.now(); });
  setInterval(() => {
    const r = getRule('docker_down');
    if (downSince && r?.enabled && Date.now() - downSince >= r.duration_s * 1000) fire('docker_down', 'daemon', { title: 'Docker daemon is unreachable', body: 'ServerOS cannot talk to the Docker Engine.', severity: 'critical', category: 'docker' });
  }, 10000).unref();

  const safe = (fn) => () => fn().catch((e) => log.debug('watcher failed', { err: e.message }));

  let nginxDownSince = null;
  setInterval(safe(async () => {
    if (!(await env.agent.info())?.nginx?.installed) return;
    const st = await env.agent.call('nginx_status', {}, { timeout: 8000 });
    const r = getRule('nginx_down');
    if (st.active) { nginxDownSince = null; return; }
    nginxDownSince ??= Date.now();
    if (r?.enabled && Date.now() - nginxDownSince >= r.duration_s * 1000) fire('nginx_down', 'nginx', { title: 'Nginx is not running', body: `Service state: ${st.ActiveState || 'inactive'}`, severity: 'critical', category: 'nginx' });
  }), 30000).unref();

  let failedSeen = new Set();
  setInterval(safe(async () => {
    const info = await env.agent.info();
    if (!info?.systemd) return;
    const failed = await env.agent.call('systemd_failed', {}, { timeout: 15000 });
    for (const u of failed) if (!failedSeen.has(u)) fire('service_failed', u, { title: `Service ${u} failed`, body: 'systemd reports this unit in the failed state.', severity: 'warning', category: 'service' });
    failedSeen = new Set(failed);
  }), 60000).unref();

  let lastRenewCheck = Date.now();
  const certCheck = safe(async () => {
    const info = await env.agent.info();
    if (!info?.certbot?.installed) return;
    const { certificates } = await env.agent.call('certbot_list', {}, { timeout: 120000 });
    const r = getRule('cert_expiry');
    for (const c of certificates) {
      if (r?.enabled && c.days_left !== null && c.days_left <= r.threshold) {
        fire('cert_expiry', c.name, { title: `Certificate ${c.name} ${c.days_left < 0 ? 'has expired' : `expires in ${c.days_left} days`}`, body: `Domains: ${c.domains.join(', ')}`, severity: c.days_left <= 3 ? 'critical' : 'warning', category: 'certificate' });
      }
    }
    try {
      const { lines } = await env.agent.call('log_read', { source: 'file:certbot', lines: 400 }, { timeout: 20000 });
      const bad = lines.filter((l) => /Failed to renew certificate|renewal failure|Attempting to renew cert .* produced an unexpected error/i.test(l));
      if (bad.length && Date.now() - lastRenewCheck > 0) fire('cert_renew_fail', bad[bad.length - 1].slice(0, 80), { title: 'Certificate renewal problem detected', body: bad[bad.length - 1].slice(0, 500), severity: 'warning', category: 'certificate' });
    } catch { /* log unavailable */ }
    lastRenewCheck = Date.now();
  });
  setTimeout(certCheck, 60000).unref();
  setInterval(certCheck, 6 * 3600 * 1000).unref();
}
