import os from 'node:os';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import Docker from 'dockerode';
import { config } from '../config.js';
import { HttpError, bad, conflict, maskEnv, SENSITIVE_RE, NAME_RE } from '../lib/util.js';
import { bus } from './bus.js';
import { log } from '../logger.js';

const SELF_ID = (os.hostname() || '').slice(0, 12);
const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]{0,254}$/;

/** Split a docker multiplexed log buffer into {s, text} chunks. */
function demuxBuffer(buf) {
  const out = [];
  let o = 0;
  while (o + 8 <= buf.length) {
    const type = buf[o];
    const len = buf.readUInt32BE(o + 4);
    if (o + 8 + len > buf.length) break;
    out.push({ s: type === 2 ? 'stderr' : 'stdout', text: buf.subarray(o + 8, o + 8 + len).toString('utf8') });
    o += 8 + len;
  }
  return out;
}

const TS_RE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s?/;
function toLines(chunks, withTs) {
  const lines = [];
  for (const c of chunks) {
    for (const l of c.text.split('\n')) {
      if (l === '') continue;
      let t = null, m = l;
      if (withTs) { const r = TS_RE.exec(l); if (r) { t = r[1]; m = l.slice(r[0].length); } }
      lines.push({ t, s: c.s, m });
    }
  }
  return lines;
}

// ------------------------------------------------------------------ stats hub
class StatsHub {
  constructor(svc) {
    this.svc = svc;
    this.streams = new Map();
    this.latest = new Map();
    this.history = new Map();
    this.refs = 0;
    this.timer = null;
    this.idleTimer = null;
  }
  acquire() {
    this.refs += 1;
    clearTimeout(this.idleTimer);
    if (!this.timer) { this.timer = setInterval(() => this.reconcile().catch(() => {}), 5000); this.reconcile().catch(() => {}); }
  }
  release() {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs === 0) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.stop(), 15000);
    }
  }
  stop() {
    clearInterval(this.timer); this.timer = null;
    for (const [, s] of this.streams) { try { s.destroy(); } catch { /* ignore */ } }
    this.streams.clear();
  }
  async reconcile() {
    const list = await this.svc.d.listContainers();
    const running = new Set(list.map((c) => c.Id));
    for (const id of running) if (!this.streams.has(id)) this.open(id);
    for (const [id, s] of this.streams) {
      if (!running.has(id)) { try { s.destroy(); } catch { /* ignore */ } this.streams.delete(id); this.latest.delete(id); }
    }
  }
  open(id) {
    this.streams.set(id, { destroy() {} });
    this.svc.d.getContainer(id).stats({ stream: true }, (err, stream) => {
      if (err || !stream) { this.streams.delete(id); return; }
      this.streams.set(id, stream);
      const rl = readline.createInterface({ input: stream });
      let prev = null;
      rl.on('line', (line) => {
        let s;
        try { s = JSON.parse(line); } catch { return; }
        const m = this.compute(s, prev);
        prev = { t: Date.now(), rx: m.netRxTotal, tx: m.netTxTotal, br: m.blockReadTotal, bw: m.blockWriteTotal };
        this.latest.set(id, m);
        let h = this.history.get(id);
        if (!h) { h = []; this.history.set(id, h); }
        h.push({ t: m.t, cpu: m.cpu, mem: m.memUsed, rx: m.netRxRate, tx: m.netTxRate });
        if (h.length > 150) h.shift();
      });
      stream.on('end', () => { this.streams.delete(id); });
      stream.on('error', () => { this.streams.delete(id); });
    });
  }
  compute(s, prev) {
    const now = Date.now();
    const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage || 0) - (s.precpu_stats?.cpu_usage?.total_usage || 0);
    const sysDelta = (s.cpu_stats?.system_cpu_usage || 0) - (s.precpu_stats?.system_cpu_usage || 0);
    const ncpu = s.cpu_stats?.online_cpus || s.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
    const cpu = sysDelta > 0 && cpuDelta >= 0 ? (cpuDelta / sysDelta) * ncpu * 100 : 0;
    const ms = s.memory_stats || {};
    const cache = ms.stats?.inactive_file ?? ms.stats?.total_inactive_file ?? ms.stats?.cache ?? 0;
    const memUsed = Math.max(0, (ms.usage || 0) - cache);
    let rx = 0, tx = 0;
    for (const n of Object.values(s.networks || {})) { rx += n.rx_bytes || 0; tx += n.tx_bytes || 0; }
    let br = 0, bw = 0;
    for (const e of s.blkio_stats?.io_service_bytes_recursive || []) {
      const op = String(e.op || '').toLowerCase();
      if (op === 'read') br += e.value; else if (op === 'write') bw += e.value;
    }
    const dt = prev ? (now - prev.t) / 1000 : 0;
    return {
      t: now, cpu: Math.round(cpu * 100) / 100, memUsed, memLimit: ms.limit || 0,
      memPercent: ms.limit ? Math.round((memUsed / ms.limit) * 1000) / 10 : 0,
      netRxTotal: rx, netTxTotal: tx, netRxRate: dt > 0 ? Math.max(0, (rx - prev.rx) / dt) : 0, netTxRate: dt > 0 ? Math.max(0, (tx - prev.tx) / dt) : 0,
      blockReadTotal: br, blockWriteTotal: bw, pids: s.pids_stats?.current ?? null,
    };
  }
}

// ------------------------------------------------------------------ service
export class DockerService {
  constructor(env) {
    this.env = env;
    this.d = new Docker({ socketPath: config.dockerSocket });
    this.meta = new Map();
    this.cache = { ts: 0, data: null };
    this.expected = new Map();
    this.stats = new StatsHub(this);
    this.up = null;
    this.eventsStarted = false;
  }

  // ---- lifecycle / monitoring
  async ping() { try { await this.d.ping(); return true; } catch { return false; } }

  startBackground() {
    if (this.eventsStarted) return;
    this.eventsStarted = true;
    const watchPing = async () => {
      const ok = await this.ping();
      if (this.up !== ok) { bus.emit('docker.daemon', { up: ok, previous: this.up }); this.up = ok; }
    };
    watchPing();
    setInterval(watchPing, 10000).unref();
    this.followEvents();
  }

  followEvents(delay = 1000) {
    this.d.getEvents({ filters: { type: ['container', 'image', 'volume', 'network'] } }, (err, stream) => {
      if (err || !stream) { setTimeout(() => this.followEvents(Math.min(delay * 2, 30000)), delay).unref(); return; }
      const rl = readline.createInterface({ input: stream });
      rl.on('line', (line) => {
        let e;
        try { e = JSON.parse(line); } catch { return; }
        if (e.Type === 'container') {
          this.cache.ts = 0;
          if (['start', 'die', 'destroy', 'restart', 'health_status', 'rename'].includes(e.Action?.split(':')[0])) this.meta.delete(e.id);
        }
        bus.emit('docker.event', e);
      });
      const retry = () => { rl.close(); setTimeout(() => this.followEvents(1000), 1000).unref(); };
      stream.on('end', retry);
      stream.on('error', retry);
    });
  }

  expect(id) { this.expected.set(id, Date.now()); }
  wasExpected(id) { const t = this.expected.get(id); return !!t && Date.now() - t < 60000; }

  // ---- overview
  async overview() {
    const [info, ver, vols, nets] = await Promise.all([this.d.info(), this.d.version(), this.d.listVolumes().catch(() => ({ Volumes: [] })), this.d.listNetworks().catch(() => [])]);
    return {
      up: true, version: ver.Version, apiVersion: ver.ApiVersion, os: info.OperatingSystem, kernel: info.KernelVersion, driver: info.Driver,
      containers: info.Containers, running: info.ContainersRunning, paused: info.ContainersPaused, stopped: info.ContainersStopped,
      images: info.Images, volumes: (vols.Volumes || []).length, networks: nets.length, ncpu: info.NCPU, memTotal: info.MemTotal, rootDir: info.DockerRootDir,
    };
  }

  // ---- containers
  summarize(c) {
    const status = c.Status || '';
    const hm = /\((healthy|unhealthy|health: starting)\)/.exec(status);
    const labels = c.Labels || {};
    return {
      id: c.Id, shortId: c.Id.slice(0, 12), name: (c.Names?.[0] || '').replace(/^\//, ''), image: c.Image, imageId: c.ImageID,
      state: c.State, status, created: c.Created, command: c.Command,
      health: hm ? (hm[1] === 'health: starting' ? 'starting' : hm[1]) : null,
      ports: (c.Ports || []).map((p) => ({ ip: p.IP || null, private: p.PrivatePort, public: p.PublicPort || null, type: p.Type })),
      networks: Object.keys(c.NetworkSettings?.Networks || {}),
      mounts: (c.Mounts || []).map((m) => ({ type: m.Type, source: m.Source, name: m.Name, destination: m.Destination, rw: m.RW })),
      project: labels['com.docker.compose.project'] || null, service: labels['com.docker.compose.service'] || null,
      self: !!SELF_ID && c.Id.startsWith(SELF_ID),
    };
  }

  async getMeta(id) {
    let m = this.meta.get(id);
    if (!m) {
      try {
        const i = await this.d.getContainer(id).inspect();
        m = { startedAt: i.State.StartedAt, restart: i.HostConfig?.RestartPolicy?.Name || 'no', finishedAt: i.State.FinishedAt, exitCode: i.State.ExitCode };
      } catch { m = {}; }
      this.meta.set(id, m);
    }
    return m;
  }

  async list({ force = false, withStats = false } = {}) {
    if (force || !this.cache.data || Date.now() - this.cache.ts > 1500) {
      const raw = await this.d.listContainers({ all: true });
      const out = await Promise.all(raw.map(async (c) => {
        const s = this.summarize(c);
        const m = await this.getMeta(c.Id);
        s.startedAt = ['running', 'paused'].includes(s.state) ? m.startedAt : null;
        s.restartPolicy = m.restart;
        s.exitCode = s.state === 'exited' ? m.exitCode : null;
        return s;
      }));
      for (const id of this.meta.keys()) if (!raw.find((c) => c.Id === id)) this.meta.delete(id);
      this.cache = { ts: Date.now(), data: out };
    }
    if (!withStats) return this.cache.data;
    return this.cache.data.map((c) => ({ ...c, stats: this.stats.latest.get(c.id) || null }));
  }

  async inspect(id) {
    const i = await this.d.getContainer(id).inspect();
    return this.sanitizeInspect(i);
  }

  sanitizeInspect(i) {
    const raw = JSON.parse(JSON.stringify(i));
    const mask = (arr) => (arr || []).map((e) => { const k = e.split('=')[0]; return SENSITIVE_RE.test(k) ? `${k}=••••••••` : e; });
    if (raw.Config) raw.Config.Env = mask(raw.Config.Env);
    return {
      id: i.Id, shortId: i.Id.slice(0, 12), name: i.Name.replace(/^\//, ''), image: i.Config.Image, imageId: i.Image,
      created: i.Created, startedAt: i.State.StartedAt, finishedAt: i.State.FinishedAt,
      state: i.State.Status, running: i.State.Running, paused: i.State.Paused, restarting: i.State.Restarting, oomKilled: i.State.OOMKilled,
      exitCode: i.State.ExitCode, error: i.State.Error, pid: i.State.Pid, health: i.State.Health?.Status || null,
      healthLog: (i.State.Health?.Log || []).slice(-5).map((l) => ({ start: l.Start, exitCode: l.ExitCode, output: String(l.Output || '').slice(0, 500) })),
      restartCount: i.RestartCount, restartPolicy: i.HostConfig?.RestartPolicy || { Name: 'no' },
      command: [...(i.Config.Entrypoint || []), ...(i.Config.Cmd || [])].join(' '), workingDir: i.Config.WorkingDir, user: i.Config.User,
      tty: i.Config.Tty, platform: i.Platform, driver: i.Driver, hostname: i.Config.Hostname,
      env: maskEnv(i.Config.Env),
      labels: i.Config.Labels || {},
      ports: Object.entries(i.NetworkSettings?.Ports || {}).map(([k, v]) => ({ container: k, bindings: (v || []).map((b) => `${b.HostIp || '0.0.0.0'}:${b.HostPort}`) })),
      mounts: (i.Mounts || []).map((m) => ({ type: m.Type, source: m.Source, name: m.Name, destination: m.Destination, mode: m.Mode, rw: m.RW })),
      networks: Object.entries(i.NetworkSettings?.Networks || {}).map(([n, v]) => ({ name: n, ip: v.IPAddress, gateway: v.Gateway, mac: v.MacAddress, aliases: v.Aliases })),
      limits: { memory: i.HostConfig?.Memory || 0, nanoCpus: i.HostConfig?.NanoCpus || 0, cpuShares: i.HostConfig?.CpuShares || 0 },
      privileged: !!i.HostConfig?.Privileged,
      composeProject: i.Config.Labels?.['com.docker.compose.project'] || null,
      self: !!SELF_ID && i.Id.startsWith(SELF_ID),
      raw,
    };
  }

  async action(id, act, { force = false, confirmSelf = false } = {}) {
    const c = this.d.getContainer(id);
    const info = await c.inspect();
    const self = !!SELF_ID && info.Id.startsWith(SELF_ID);
    if (self && ['stop', 'kill', 'restart', 'remove', 'pause'].includes(act) && !confirmSelf) {
      throw conflict('This is the ServerOS container itself. This action will interrupt the dashboard. Confirm explicitly to continue.', 'self_action');
    }
    if (['stop', 'kill', 'restart', 'remove', 'pause'].includes(act)) this.expect(info.Id);
    switch (act) {
      case 'start': await c.start(); break;
      case 'stop': await c.stop({ t: 10 }); break;
      case 'restart': await c.restart({ t: 10 }); break;
      case 'pause': await c.pause(); break;
      case 'unpause': await c.unpause(); break;
      case 'kill': await c.kill(); break;
      case 'remove': await c.remove({ force: !!force, v: false }); break; // never removes volumes
      default: throw bad('Unknown action');
    }
    this.cache.ts = 0;
    this.meta.delete(info.Id);
    return { id: info.Id, name: info.Name.replace(/^\//, ''), action: act };
  }

  async rename(id, name) {
    if (!NAME_RE.test(name)) throw bad('Invalid container name');
    await this.d.getContainer(id).rename({ name });
    this.cache.ts = 0;
  }

  async create(spec) {
    const image = String(spec.image || '');
    if (!IMAGE_RE.test(image)) throw bad('Invalid image reference');
    const name = spec.name ? String(spec.name) : undefined;
    if (name && !NAME_RE.test(name)) throw bad('Invalid container name');
    const env = (spec.env || []).filter((e) => e.key).map((e) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.key)) throw bad(`Invalid environment variable name: ${e.key}`);
      return `${e.key}=${e.value ?? ''}`;
    });
    const exposed = {}, bindings = {};
    for (const p of spec.ports || []) {
      const c = Number(p.container), h = Number(p.host), proto = p.proto === 'udp' ? 'udp' : 'tcp';
      if (!Number.isInteger(c) || c < 1 || c > 65535 || !Number.isInteger(h) || h < 1 || h > 65535) throw bad('Ports must be between 1 and 65535');
      const ip = p.ip || '';
      if (ip && !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) throw bad('Invalid bind IP address');
      exposed[`${c}/${proto}`] = {};
      (bindings[`${c}/${proto}`] ||= []).push({ HostIp: ip, HostPort: String(h) });
    }
    const binds = (spec.volumes || []).filter((x) => x.source && x.target).map((x) => {
      if (!String(x.target).startsWith('/')) throw bad('Volume target must be an absolute path');
      if (!(String(x.source).startsWith('/') || NAME_RE.test(String(x.source)))) throw bad('Volume source must be an absolute path or a volume name');
      if (/[:\0]/.test(x.target) || (String(x.source).startsWith('/') && /[:\0]/.test(x.source))) throw bad('Volume paths must not contain ":"');
      return `${x.source}:${x.target}${x.readOnly ? ':ro' : ''}`;
    });
    const restart = ['no', 'always', 'unless-stopped', 'on-failure'].includes(spec.restart) ? spec.restart : 'no';
    const cmd = spec.cmd ? String(spec.cmd).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((s) => s.replace(/^["']|["']$/g, '')) : undefined;
    let pulled = false;
    try { await this.d.getImage(image).inspect(); } catch (e) {
      if (e.statusCode !== 404) throw e;
      if (!spec.pull) throw new HttpError(404, `Image "${image}" is not present locally. Enable "pull if missing" or pull it first.`, 'image_missing');
      await this.pullAwait(image);
      pulled = true;
    }
    const opts = {
      Image: image, name, Env: env, Cmd: cmd, ExposedPorts: exposed, Tty: !!spec.tty, OpenStdin: !!spec.tty,
      HostConfig: { PortBindings: bindings, Binds: binds, RestartPolicy: { Name: restart, MaximumRetryCount: restart === 'on-failure' ? 5 : 0 }, NetworkMode: spec.network || undefined },
    };
    const c = await this.d.createContainer(opts);
    if (spec.start !== false) await c.start();
    this.cache.ts = 0;
    return { id: c.id, pulled };
  }

  async updateSettings(id, { restartPolicy, memoryMb }) {
    const upd = {};
    if (restartPolicy) {
      const name = restartPolicy.name;
      if (!['no', 'always', 'unless-stopped', 'on-failure'].includes(name)) throw bad('Invalid restart policy');
      upd.RestartPolicy = { Name: name, MaximumRetryCount: name === 'on-failure' ? Math.min(Number(restartPolicy.maxRetries) || 5, 100) : 0 };
    }
    if (memoryMb !== undefined && memoryMb !== null) {
      const mb = Number(memoryMb);
      if (!Number.isFinite(mb) || mb < 0 || mb > 1048576) throw bad('Invalid memory limit');
      if (mb === 0) { upd.Memory = 0; upd.MemorySwap = -1; } else { upd.Memory = Math.round(mb * 1048576); upd.MemorySwap = Math.round(mb * 2 * 1048576); }
    }
    if (!Object.keys(upd).length) throw bad('Nothing to update');
    await this.d.getContainer(id).update(upd);
    this.meta.delete((await this.d.getContainer(id).inspect()).Id);
    this.cache.ts = 0;
  }

  /** Recreate with changed env/image. The old container is renamed and kept (stopped) unless removeOld is set. */
  async recreate(id, { env, image, removeOld = false, confirmSelf = false }) {
    const old = await this.d.getContainer(id).inspect();
    if (SELF_ID && old.Id.startsWith(SELF_ID) && !confirmSelf) throw conflict('Refusing to recreate the ServerOS container itself.', 'self_action');
    const name = old.Name.replace(/^\//, '');
    const cfg = old.Config, hc = old.HostConfig;
    if (image && !IMAGE_RE.test(image)) throw bad('Invalid image reference');
    let newEnv = cfg.Env || [];
    if (Array.isArray(env)) {
      const orig = Object.fromEntries((cfg.Env || []).map((e) => { const i = e.indexOf('='); return [e.slice(0, i), e.slice(i + 1)]; }));
      newEnv = env.filter((e) => e.key).map((e) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.key)) throw bad(`Invalid environment variable name: ${e.key}`);
        return `${e.key}=${e.keep ? orig[e.key] ?? '' : e.value ?? ''}`;
      });
    }
    const binds = [...(hc.Binds || [])];
    const bound = new Set(binds.map((b) => b.split(':')[1]));
    const explicit = new Set((hc.Mounts || []).map((m) => m.Target));
    for (const m of old.Mounts || []) {
      if (m.Type === 'volume' && m.Name && !bound.has(m.Destination) && !explicit.has(m.Destination)) binds.push(`${m.Name}:${m.Destination}${m.RW ? '' : ':ro'}`);
    }
    const nets = old.NetworkSettings?.Networks || {};
    const mode = hc.NetworkMode && nets[hc.NetworkMode] ? hc.NetworkMode : Object.keys(nets)[0];
    const epFor = (n) => ({ Aliases: (nets[n].Aliases || []).filter((a) => !old.Id.startsWith(a)), IPAMConfig: nets[n].IPAMConfig || undefined });
    const createOpts = {
      name, Image: image || cfg.Image, Cmd: cfg.Cmd, Entrypoint: cfg.Entrypoint, Env: newEnv, WorkingDir: cfg.WorkingDir, User: cfg.User,
      Labels: cfg.Labels, ExposedPorts: cfg.ExposedPorts, Tty: cfg.Tty, OpenStdin: cfg.OpenStdin, StopSignal: cfg.StopSignal, Healthcheck: cfg.Healthcheck,
      HostConfig: { ...hc, Binds: binds },
      NetworkingConfig: mode && !['host', 'none'].includes(mode) && nets[mode] ? { EndpointsConfig: { [mode]: epFor(mode) } } : undefined,
    };
    if (image) { try { await this.d.getImage(image).inspect(); } catch (e) { if (e.statusCode === 404) await this.pullAwait(image); else throw e; } }
    const wasRunning = old.State.Running;
    const oldName = `${name}_old_${Date.now().toString(36)}`;
    const oc = this.d.getContainer(old.Id);
    this.expect(old.Id);
    if (wasRunning) await oc.stop({ t: 10 });
    await oc.rename({ name: oldName });
    let created;
    try {
      created = await this.d.createContainer(createOpts);
      for (const n of Object.keys(nets)) {
        if (n === mode || ['host', 'none'].includes(n)) continue;
        await this.d.getNetwork(n).connect({ Container: created.id, EndpointConfig: epFor(n) });
      }
      if (wasRunning) await created.start();
    } catch (e) {
      if (created) await created.remove({ force: true, v: false }).catch(() => {});
      await oc.rename({ name }).catch(() => {});
      if (wasRunning) await oc.start().catch(() => {});
      throw new HttpError(500, `Recreate failed and was rolled back: ${e.message}`, 'recreate_failed');
    }
    if (removeOld) await oc.remove({ v: false }).catch(() => {});
    this.cache.ts = 0;
    return { id: created.id, oldContainer: removeOld ? null : oldName };
  }

  // ---- logs
  async logs(id, { tail = 200, since, until, timestamps = true } = {}) {
    const c = this.d.getContainer(id);
    const info = await c.inspect();
    const t = tail === 'all' ? 'all' : Math.max(1, Math.min(Number(tail) || 200, 200000));
    const opts = { stdout: true, stderr: true, tail: t, timestamps: !!timestamps };
    if (since) opts.since = Number(since);
    if (until) opts.until = Number(until);
    const buf = await c.logs(opts);
    const chunks = info.Config.Tty ? [{ s: 'stdout', text: buf.toString('utf8') }] : demuxBuffer(buf);
    return toLines(chunks, !!timestamps);
  }

  /** Follow logs; calls onLines(lines[]) and returns stop(). */
  async followLogs(id, { tail = 100, since, timestamps = true } = {}, onLines, onEnd) {
    const c = this.d.getContainer(id);
    const info = await c.inspect();
    const opts = { follow: true, stdout: true, stderr: true, tail: Math.max(0, Math.min(Number(tail) || 0, 5000)), timestamps: !!timestamps };
    if (since) opts.since = Number(since);
    const stream = await c.logs(opts);
    let stopped = false;
    const emit = (text, s) => { const l = toLines([{ s, text }], !!timestamps); if (l.length) onLines(l); };
    if (info.Config.Tty) {
      stream.on('data', (b) => emit(b.toString('utf8'), 'stdout'));
    } else {
      const out = new PassThrough(), err = new PassThrough();
      this.d.modem.demuxStream(stream, out, err);
      out.on('data', (b) => emit(b.toString('utf8'), 'stdout'));
      err.on('data', (b) => emit(b.toString('utf8'), 'stderr'));
    }
    stream.on('end', () => { if (!stopped) onEnd?.(); });
    stream.on('error', () => { if (!stopped) onEnd?.(); });
    return () => { stopped = true; try { stream.destroy(); } catch { /* ignore */ } };
  }

  // ---- exec / terminal
  async shells(id) {
    const c = this.d.getContainer(id);
    try {
      const exec = await c.exec({ Cmd: ['sh', '-c', 'for s in /bin/bash /bin/sh /bin/ash /bin/zsh /usr/bin/bash /bin/dash; do [ -x "$s" ] && echo "$s"; done'], AttachStdout: true, AttachStderr: true, Tty: false });
      const text = await new Promise((resolve, reject) => {
        exec.start({ Tty: false }, (err, stream) => {
          if (err) return reject(err);
          let out = '';
          const so = new PassThrough(), se = new PassThrough();
          so.on('data', (b) => { out += b.toString(); });
          this.d.modem.demuxStream(stream, so, se);
          stream.on('end', () => resolve(out));
          stream.on('error', reject);
        });
      });
      return [...new Set(text.split('\n').map((s) => s.trim()).filter(Boolean))];
    } catch (e) {
      log.debug('shell detection failed', { err: e.message });
      return [];
    }
  }

  async openTerminal(id, shell, cols, rows) {
    const c = this.d.getContainer(id);
    const exec = await c.exec({ Cmd: [shell], AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true, Env: ['TERM=xterm-256color'] });
    const stream = await new Promise((resolve, reject) => exec.start({ hijack: true, stdin: true, Tty: true }, (e, s) => (e ? reject(e) : resolve(s))));
    await exec.resize({ h: rows, w: cols }).catch(() => {});
    return { stream, resize: (cc, rr) => exec.resize({ h: rr, w: cc }).catch(() => {}), exec };
  }

  statsHistory(id) { return this.stats.history.get(id) || []; }

  // ---- images
  async images() {
    const [imgs, conts] = await Promise.all([this.d.listImages({ all: false }), this.d.listContainers({ all: true })]);
    const used = new Map();
    for (const c of conts) { (used.get(c.ImageID) || used.set(c.ImageID, []).get(c.ImageID)).push({ id: c.Id.slice(0, 12), name: c.Names[0].replace(/^\//, ''), state: c.State }); }
    return imgs.map((i) => ({
      id: i.Id, shortId: i.Id.replace('sha256:', '').slice(0, 12), tags: (i.RepoTags || []).filter((t) => t !== '<none>:<none>'), digests: i.RepoDigests || [],
      size: i.Size, created: i.Created, dangling: !(i.RepoTags || []).filter((t) => t !== '<none>:<none>').length, containers: used.get(i.Id) || [],
    })).sort((a, b) => b.created - a.created);
  }
  async imageInspect(id) { const i = await this.d.getImage(id).inspect(); return i; }
  async imageRemove(id, { force = false } = {}) {
    const all = await this.images();
    const img = all.find((i) => i.id === id || i.shortId === id || i.tags.includes(id));
    if (img?.containers.length && !force) throw conflict(`Image is used by ${img.containers.length} container(s): ${img.containers.map((c) => c.name).join(', ')}`, 'image_in_use', { containers: img.containers });
    if (img?.containers.some((c) => c.state === 'running') && force) throw conflict('Refusing to force-remove an image used by a running container', 'image_in_use');
    return this.d.getImage(id).remove({ force: !!force });
  }
  async unusedImages() { return (await this.images()).filter((i) => !i.containers.length); }
  async pruneImages({ all = false, ids } = {}) {
    if (Array.isArray(ids)) {
      const unused = new Set((await this.unusedImages()).map((i) => i.id));
      const removed = []; const errors = [];
      for (const id of ids) {
        if (!unused.has(id)) { errors.push({ id, error: 'not unused' }); continue; }
        try { await this.d.getImage(id).remove({ force: false }); removed.push(id); } catch (e) { errors.push({ id, error: e.message }); }
      }
      return { removed, errors };
    }
    const r = await this.d.pruneImages({ filters: { dangling: { false: !!all, true: !all } } });
    return { deleted: r.ImagesDeleted || [], reclaimed: r.SpaceReclaimed };
  }
  pullAwait(image) {
    return new Promise((resolve, reject) => {
      this.d.pull(image, (err, stream) => {
        if (err) return reject(err);
        this.d.modem.followProgress(stream, (e) => (e ? reject(e) : resolve()));
      });
    });
  }
  pull(image, onProgress) {
    if (!IMAGE_RE.test(image)) throw bad('Invalid image reference');
    return new Promise((resolve, reject) => {
      this.d.pull(image, (err, stream) => {
        if (err) return reject(err);
        this.d.modem.followProgress(stream, (e, out) => (e ? reject(e) : resolve(out)), onProgress);
      });
    });
  }

  // ---- volumes
  async volumes({ usage = false } = {}) {
    const [vols, conts] = await Promise.all([this.d.listVolumes(), this.d.listContainers({ all: true })]);
    let sizes = {};
    if (usage) {
      const df = await this.d.df().catch(() => null);
      for (const v of df?.Volumes || []) sizes[v.Name] = v.UsageData || null;
    }
    const users = new Map();
    for (const c of conts) for (const m of c.Mounts || []) if (m.Type === 'volume' && m.Name) (users.get(m.Name) || users.set(m.Name, []).get(m.Name)).push({ id: c.Id.slice(0, 12), name: c.Names[0].replace(/^\//, ''), state: c.State });
    return (vols.Volumes || []).map((v) => ({
      name: v.Name, driver: v.Driver, mountpoint: v.Mountpoint, created: v.CreatedAt, labels: v.Labels || {}, scope: v.Scope,
      size: sizes[v.Name]?.Size ?? null, refCount: sizes[v.Name]?.RefCount ?? null, containers: users.get(v.Name) || [],
    })).sort((a, b) => a.name.localeCompare(b.name));
  }
  async volumeCreate({ name, driver = 'local', labels }) {
    if (!NAME_RE.test(name || '')) throw bad('Invalid volume name');
    if (!/^[a-z0-9_.-]{1,64}$/.test(driver)) throw bad('Invalid driver');
    return this.d.createVolume({ Name: name, Driver: driver, Labels: labels || {} });
  }
  async volumeRemove(name) {
    const v = (await this.volumes()).find((x) => x.name === name);
    if (v?.containers.length) throw conflict(`Volume is used by: ${v.containers.map((c) => c.name).join(', ')}. Remove those containers first.`, 'volume_in_use', { containers: v.containers });
    return this.d.getVolume(name).remove({ force: false });
  }
  volumeInspect(name) { return this.d.getVolume(name).inspect(); }

  // ---- networks
  async networks() {
    const list = await this.d.listNetworks();
    return list.map((n) => ({
      id: n.Id, shortId: n.Id.slice(0, 12), name: n.Name, driver: n.Driver, scope: n.Scope, internal: n.Internal, created: n.Created,
      ipam: (n.IPAM?.Config || []).map((c) => ({ subnet: c.Subnet, gateway: c.Gateway })),
      containers: Object.keys(n.Containers || {}).length, builtin: ['bridge', 'host', 'none'].includes(n.Name),
    })).sort((a, b) => a.name.localeCompare(b.name));
  }
  async networkInspect(id) {
    const n = await this.d.getNetwork(id).inspect();
    return { ...n, ContainersList: Object.entries(n.Containers || {}).map(([cid, c]) => ({ id: cid.slice(0, 12), name: c.Name, ipv4: c.IPv4Address, ipv6: c.IPv6Address, mac: c.MacAddress })) };
  }
  async networkCreate({ name, driver = 'bridge', subnet, gateway, internal = false }) {
    if (!NAME_RE.test(name || '')) throw bad('Invalid network name');
    if (!['bridge', 'overlay', 'macvlan', 'ipvlan'].includes(driver)) throw bad('Unsupported driver');
    const opts = { Name: name, Driver: driver, Internal: !!internal, CheckDuplicate: true };
    if (subnet) {
      if (!/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(subnet)) throw bad('Invalid subnet (use CIDR notation)');
      opts.IPAM = { Config: [{ Subnet: subnet, ...(gateway ? { Gateway: gateway } : {}) }] };
      if (gateway && !/^[0-9a-fA-F:.]+$/.test(gateway)) throw bad('Invalid gateway');
    }
    return this.d.createNetwork(opts);
  }
  async networkRemove(id) {
    const n = await this.d.getNetwork(id).inspect();
    if (['bridge', 'host', 'none'].includes(n.Name)) throw conflict('Built-in networks cannot be removed', 'builtin');
    const used = Object.values(n.Containers || {}).map((c) => c.Name);
    if (used.length) throw conflict(`Network has connected containers: ${used.join(', ')}`, 'network_in_use', { containers: used });
    return this.d.getNetwork(id).remove();
  }
}
