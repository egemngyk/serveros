import fsp from 'node:fs/promises';
import fs from 'node:fs';
import { config } from '../config.js';
import { db } from '../db.js';
import { bus } from './bus.js';
import { log } from '../logger.js';
import { fire } from './notifications.js';
import { getRule } from './notifications.js';
import { getSetting } from './settings.js';

const HP = config.hostProc;
const HS = config.hostSys;
const rd = (p) => fsp.readFile(p, 'utf8');
const rdq = async (p) => { try { return (await rd(p)).trim(); } catch { return null; } };
const WHOLE_DISK = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+|md\d+)$/;
const RANGES = { '15m': [900, 10], '1h': [3600, 30], '6h': [21600, 180], '24h': [86400, 600], '7d': [604800, 3600] };

function parseKv(text) {
  const o = {};
  for (const l of text.split('\n')) { const m = /^([\w()]+):\s+(\d+)/.exec(l); if (m) o[m[1]] = Number(m[2]) * 1024; }
  return o;
}

export class MonitorService {
  constructor(env) {
    this.env = env;
    this.latest = null;
    this.prevCpu = null;
    this.prevNet = null;
    this.prevDisk = null;
    this.static = null;
    this.diskCache = { ts: 0, data: [] };
    this.dockerCache = { ts: 0, data: null };
    this.lastStore = 0;
    this.timer = null;
    this.state = new Map(); // alert state for metric rules
    this.ifaceState = new Map();
    this.passwd = null;
    this.running = false;
  }

  refreshMs() { return Math.max(1, Number(getSetting('monitoring.refreshSeconds')) || 2) * 1000; }

  start() {
    if (this.timer) return;
    const loop = async () => {
      try { await this.tick(); } catch (e) { log.warn('monitor tick failed', { err: e.message }); }
      this.timer = setTimeout(loop, this.refreshMs()); // re-read every round: setting changes apply immediately
    };
    this.timer = setTimeout(() => {}, 0);
    loop();
    setInterval(() => this.prune(), 3600 * 1000).unref();
  }

  async staticInfo() {
    if (this.static) return this.static;
    const cpuinfo = await rdq(`${HP}/cpuinfo`) || '';
    const model = /model name\s*:\s*(.+)/.exec(cpuinfo)?.[1] || /Hardware\s*:\s*(.+)/.exec(cpuinfo)?.[1] || /Model\s*:\s*(.+)/.exec(cpuinfo)?.[1] || 'Unknown CPU';
    const threads = (cpuinfo.match(/^processor\s*:/gm) || []).length || 1;
    const pairs = new Set();
    let phys = null, core = null;
    for (const l of cpuinfo.split('\n')) {
      if (l.startsWith('physical id')) phys = l.split(':')[1].trim();
      else if (l.startsWith('core id')) { core = l.split(':')[1].trim(); pairs.add(`${phys}:${core}`); }
    }
    const osr = (await rdq(`${config.hostEtc}/os-release`)) || '';
    const pretty = /PRETTY_NAME="?([^"\n]+)"?/.exec(osr)?.[1] || 'Linux';
    const hostname = (await rdq(`${config.hostEtc}/hostname`)) || (await rdq(`${HP}/sys/kernel/hostname`)) || 'unknown';
    const kernel = (await rdq(`${HP}/sys/kernel/osrelease`)) || 'unknown';
    const arch = process.arch === 'x64' ? 'x86_64' : process.arch;
    this.static = { cpuModel: model.trim(), threads, physicalCores: pairs.size || threads, os: pretty, hostname: hostname.trim(), kernel: kernel.trim(), arch };
    return this.static;
  }

  async loadPasswd() {
    if (this.passwd) return this.passwd;
    const map = new Map();
    const txt = await rdq(`${config.hostEtc}/passwd`);
    for (const l of (txt || '').split('\n')) { const p = l.split(':'); if (p.length > 2) map.set(Number(p[2]), p[0]); }
    this.passwd = map;
    return map;
  }

  // ---------------------------------------------------------------- collection
  async collect() {
    const now = Date.now();
    const [stat, mem, load, uptime, diskstats, st, temps, ifaces] = await Promise.all([
      rd(`${HP}/stat`), rd(`${HP}/meminfo`), rd(`${HP}/loadavg`), rd(`${HP}/uptime`), rdq(`${HP}/diskstats`),
      this.staticInfo(), this.temperatures(), this.interfaces(),
    ]);

    // CPU
    const cur = {};
    for (const l of stat.split('\n')) {
      if (!l.startsWith('cpu')) continue;
      const p = l.trim().split(/\s+/);
      const n = p.slice(1).map(Number);
      cur[p[0]] = { idle: n[3] + (n[4] || 0), total: n.slice(0, 8).reduce((a, b) => a + b, 0), iowait: n[4] || 0 };
    }
    const pct = (a, b) => (a && b && b.total > a.total ? Math.max(0, Math.min(100, (1 - (b.idle - a.idle) / (b.total - a.total)) * 100)) : 0);
    const prev = this.prevCpu;
    const cores = Object.keys(cur).filter((k) => k !== 'cpu').sort((a, b) => Number(a.slice(3)) - Number(b.slice(3))).map((k) => round1(pct(prev?.[k], cur[k])));
    const cpuUsage = round1(pct(prev?.cpu, cur.cpu));
    const iowait = prev?.cpu && cur.cpu.total > prev.cpu.total ? round1(((cur.cpu.iowait - prev.cpu.iowait) / (cur.cpu.total - prev.cpu.total)) * 100) : 0;
    this.prevCpu = cur;
    const la = load.trim().split(/\s+/).slice(0, 3).map(Number);
    const freq = await this.cpuFreq();

    // Memory
    const m = parseKv(mem);
    const available = m.MemAvailable ?? (m.MemFree + (m.Cached || 0) + (m.Buffers || 0));
    const memory = {
      total: m.MemTotal, used: m.MemTotal - available, available, free: m.MemFree, buffers: m.Buffers || 0,
      cached: (m.Cached || 0) + (m.SReclaimable || 0), swapTotal: m.SwapTotal || 0, swapUsed: (m.SwapTotal || 0) - (m.SwapFree || 0),
    };

    // Uptime
    const up = Number(uptime.split(' ')[0]);

    // Disk I/O
    const devs = [];
    const curDisk = {};
    for (const l of (diskstats || '').split('\n')) {
      const p = l.trim().split(/\s+/);
      if (p.length < 14 || !WHOLE_DISK.test(p[2])) continue;
      curDisk[p[2]] = { t: now, rs: Number(p[5]), ws: Number(p[9]), rio: Number(p[3]), wio: Number(p[7]), ms: Number(p[12]) };
    }
    let totR = 0, totW = 0;
    for (const [name, c] of Object.entries(curDisk)) {
      const pv = this.prevDisk?.[name];
      if (!pv) { devs.push({ name, readBps: 0, writeBps: 0, iops: 0, util: 0 }); continue; }
      const dt = (c.t - pv.t) / 1000;
      if (dt <= 0) continue;
      const d = { name, readBps: Math.max(0, ((c.rs - pv.rs) * 512) / dt), writeBps: Math.max(0, ((c.ws - pv.ws) * 512) / dt), iops: Math.max(0, (c.rio - pv.rio + c.wio - pv.wio) / dt), util: Math.min(100, Math.max(0, ((c.ms - pv.ms) / (dt * 1000)) * 100)) };
      totR += d.readBps; totW += d.writeBps;
      devs.push(round(d));
    }
    this.prevDisk = curDisk;
    const mounts = await this.mounts();

    // Network
    const net = this.netRates(ifaces, now);

    return {
      ts: now,
      system: { hostname: st.hostname, os: st.os, kernel: st.kernel, arch: st.arch, uptime: up, bootTime: Math.round(now / 1000 - up) },
      cpu: { usage: cpuUsage, iowait, cores, load: la, model: st.cpuModel, threads: st.threads, physicalCores: st.physicalCores, freqMhz: freq },
      memory,
      disk: { mounts, devices: devs, readBps: totR, writeBps: totW },
      network: net,
      temps,
    };
  }

  async cpuFreq() {
    try {
      const dirs = (await fsp.readdir(`${HS}/devices/system/cpu`)).filter((d) => /^cpu\d+$/.test(d));
      const vals = await Promise.all(dirs.map((d) => rdq(`${HS}/devices/system/cpu/${d}/cpufreq/scaling_cur_freq`)));
      const nums = vals.filter(Boolean).map((v) => Number(v) / 1000).filter(Number.isFinite);
      if (nums.length) return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
    } catch { /* ignore */ }
    const ci = (await rdq(`${HP}/cpuinfo`)) || '';
    const m = [...ci.matchAll(/cpu MHz\s*:\s*([\d.]+)/g)].map((x) => Number(x[1]));
    return m.length ? Math.round(m.reduce((a, b) => a + b, 0) / m.length) : null;
  }

  async mounts() {
    if (Date.now() - this.diskCache.ts < 10000) return this.diskCache.data;
    let data = [];
    try { data = await this.env.agent.call('df', {}, { timeout: 5000 }); } catch {
      try { // fallback: only the data volume is visible without the host agent
        const s = await fsp.statfs(config.dataDir);
        const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
        data = [{ device: 'data volume', mount: config.dataDir, fstype: 'container', total, used: total - free, free, percent: round1(((total - free) / total) * 100), limited: true }];
      } catch { data = []; }
    }
    this.diskCache = { ts: Date.now(), data };
    return data;
  }

  async interfaces() {
    const out = [];
    let names = [];
    try { names = await fsp.readdir(`${HS}/class/net`); } catch { return out; }
    await Promise.all(names.map(async (n) => {
      const base = `${HS}/class/net/${n}`;
      const [rx, tx, state, speed, mac, mtu, real] = await Promise.all([
        rdq(`${base}/statistics/rx_bytes`), rdq(`${base}/statistics/tx_bytes`), rdq(`${base}/operstate`), rdq(`${base}/speed`), rdq(`${base}/address`), rdq(`${base}/mtu`),
        fsp.realpath(base).catch(() => ''),
      ]);
      if (rx === null) return;
      const virtual = real.includes('/virtual/');
      const sp = speed && Number(speed) > 0 ? Number(speed) : null;
      out.push({ name: n, rx: Number(rx), tx: Number(tx), state: state || 'unknown', speedMbps: sp, mac, mtu: mtu ? Number(mtu) : null, virtual, loopback: n === 'lo' });
    }));
    return out.sort((a, b) => Number(a.virtual) - Number(b.virtual) || a.name.localeCompare(b.name));
  }

  netRates(ifaces, now) {
    const res = [];
    let rxBps = 0, txBps = 0, rxTotal = 0, txTotal = 0;
    const cur = {};
    for (const i of ifaces) {
      cur[i.name] = { t: now, rx: i.rx, tx: i.tx };
      const pv = this.prevNet?.[i.name];
      const dt = pv ? (now - pv.t) / 1000 : 0;
      const rate = { ...i, rxBps: dt > 0 ? Math.max(0, (i.rx - pv.rx) / dt) : 0, txBps: dt > 0 ? Math.max(0, (i.tx - pv.tx) / dt) : 0 };
      res.push(rate);
      if (!i.virtual && !i.loopback) { rxBps += rate.rxBps; txBps += rate.txBps; rxTotal += i.rx; txTotal += i.tx; }
    }
    this.prevNet = cur;
    return { interfaces: res, rxBps, txBps, rxTotal, txTotal };
  }

  async temperatures() {
    const sensors = [];
    try {
      for (const h of await fsp.readdir(`${HS}/class/hwmon`)) {
        const base = `${HS}/class/hwmon/${h}`;
        const name = (await rdq(`${base}/name`)) || h;
        const files = (await fsp.readdir(base)).filter((f) => /^temp\d+_input$/.test(f));
        for (const f of files) {
          const v = await rdq(`${base}/${f}`);
          if (v === null || !Number.isFinite(Number(v))) continue;
          const label = (await rdq(`${base}/${f.replace('_input', '_label')}`)) || f.replace('_input', '');
          sensors.push({ source: name, label, celsius: Number(v) / 1000, kind: /nvme|drivetemp/.test(name) ? 'disk' : /coretemp|k10temp|cpu|zenpower|x86_pkg/i.test(name) ? 'cpu' : 'other' });
        }
      }
    } catch { /* hwmon unavailable */ }
    try {
      for (const z of await fsp.readdir(`${HS}/class/thermal`)) {
        if (!z.startsWith('thermal_zone')) continue;
        const [type, v] = await Promise.all([rdq(`${HS}/class/thermal/${z}/type`), rdq(`${HS}/class/thermal/${z}/temp`)]);
        if (v === null || !Number.isFinite(Number(v))) continue;
        if (sensors.some((s) => s.source === type && s.label === z)) continue;
        sensors.push({ source: type || z, label: z, celsius: Number(v) / 1000, kind: /cpu|x86_pkg|soc/i.test(type || '') ? 'cpu' : 'other' });
      }
    } catch { /* thermal unavailable */ }
    const cpuS = sensors.filter((s) => s.kind === 'cpu');
    const pkg = cpuS.find((s) => /package|tctl|tdie/i.test(s.label)) || cpuS[0];
    const disks = sensors.filter((s) => s.kind === 'disk');
    return { available: sensors.length > 0, cpu: pkg ? pkg.celsius : null, disk: disks.length ? Math.max(...disks.map((d) => d.celsius)) : null, sensors };
  }

  async dockerSummary() {
    if (Date.now() - this.dockerCache.ts < 5000 && this.dockerCache.data) return this.dockerCache.data;
    let data;
    try { data = await this.env.docker.overview(); } catch (e) { data = { up: false, error: e.message }; }
    this.dockerCache = { ts: Date.now(), data };
    return data;
  }

  // ---------------------------------------------------------------- tick
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const snap = await this.collect();
      snap.docker = await this.dockerSummary();
      snap.refreshSeconds = this.refreshMs() / 1000;
      this.latest = snap;
      bus.emit('monitor', snap);
      if (Date.now() - this.lastStore >= 10000) { this.lastStore = Date.now(); this.store(snap); this.evaluate(snap); } // history + alerts every 10 s regardless of UI refresh rate
    } finally { this.running = false; }
  }

  store(s) {
    const rootMount = s.disk.mounts.find((m) => m.mount === '/') || s.disk.mounts[0];
    const maxPct = s.disk.mounts.length ? Math.max(...s.disk.mounts.map((m) => m.percent)) : null;
    db.prepare('INSERT OR REPLACE INTO metrics (ts, cpu, mem, swap, load1, rx, tx, disk_read, disk_write, temp, disk_pct) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      Math.floor(s.ts / 1000), s.cpu.usage, (s.memory.used / s.memory.total) * 100, s.memory.swapTotal ? (s.memory.swapUsed / s.memory.swapTotal) * 100 : 0,
      s.cpu.load[0], s.network.rxBps, s.network.txBps, s.disk.readBps, s.disk.writeBps, s.temps.cpu, rootMount ? Math.max(rootMount.percent, maxPct ?? 0) : maxPct);
  }

  prune() { db.prepare('DELETE FROM metrics WHERE ts < ?').run(Math.floor(Date.now() / 1000) - 7 * 86400 - 3600); }

  history(range = '1h') {
    const [span, bucket] = RANGES[range] || RANGES['1h'];
    const from = Math.floor(Date.now() / 1000) - span;
    return db.prepare(`SELECT (ts / ?) * ? AS t, AVG(cpu) cpu, AVG(mem) mem, AVG(swap) swap, AVG(load1) load1, AVG(rx) rx, AVG(tx) tx,
      AVG(disk_read) disk_read, AVG(disk_write) disk_write, AVG(temp) temp, MAX(disk_pct) disk_pct FROM metrics WHERE ts >= ? GROUP BY t ORDER BY t`).all(bucket, bucket, from)
      .map((r) => ({ ...r, t: r.t * 1000 }));
  }

  // ---------------------------------------------------------------- alerts (metric rules)
  evaluate(s) {
    const memPct = (s.memory.used / s.memory.total) * 100;
    const swapPct = s.memory.swapTotal ? (s.memory.swapUsed / s.memory.swapTotal) * 100 : 0;
    const worst = s.disk.mounts.filter((m) => !m.limited).sort((a, b) => b.percent - a.percent)[0];
    const lowFree = s.disk.mounts.filter((m) => !m.limited).sort((a, b) => a.free - b.free)[0];
    const checks = [
      ['cpu_high', 'cpu', s.cpu.usage, (v, t) => v >= t, `CPU usage is ${s.cpu.usage.toFixed(0)}%`],
      ['mem_high', 'mem', memPct, (v, t) => v >= t, `Memory usage is ${memPct.toFixed(0)}%`],
      ['swap_high', 'swap', swapPct, (v, t) => v >= t, `Swap usage is ${swapPct.toFixed(0)}%`],
      ['disk_usage', worst?.mount || 'disk', worst?.percent ?? null, (v, t) => v >= t, worst ? `${worst.mount} is ${worst.percent.toFixed(0)}% full` : ''],
      ['disk_free', lowFree?.mount || 'disk', lowFree ? lowFree.free / 1073741824 : null, (v, t) => v <= t, lowFree ? `${lowFree.mount} has only ${(lowFree.free / 1073741824).toFixed(1)} GB free` : ''],
    ];
    const now = Date.now();
    for (const [key, subject, value, cmp, text] of checks) {
      const rule = getRule(key);
      if (!rule || !rule.enabled || value === null) { this.state.delete(key); continue; }
      if (cmp(value, rule.threshold)) {
        const since = this.state.get(key)?.since ?? now;
        this.state.set(key, { since });
        if (now - since >= rule.duration_s * 1000) {
          fire(key, subject, { title: rule.name.replace(/ \(.*\)$/, '') + ' on ' + s.system.hostname, body: `${text} (threshold ${rule.threshold}).`, severity: key === 'disk_free' ? 'critical' : 'warning', category: 'system' });
        }
      } else this.state.delete(key);
    }
    // interface down detection
    const rule = getRule('iface_down');
    if (rule?.enabled) {
      for (const i of s.network.interfaces) {
        if (i.virtual || i.loopback) continue;
        const prevUp = this.ifaceState.get(i.name);
        const up = i.state === 'up' || i.state === 'unknown';
        if (prevUp === 'up' && !up) this.ifaceState.set(i.name, { downSince: now, wasUp: true });
        const st = this.ifaceState.get(i.name);
        if (st && typeof st === 'object') {
          if (up) this.ifaceState.set(i.name, 'up');
          else if (now - st.downSince >= rule.duration_s * 1000) fire('iface_down', i.name, { title: `Network interface ${i.name} is down`, body: `State: ${i.state}`, severity: 'critical', category: 'network' });
        } else this.ifaceState.set(i.name, up ? 'up' : 'down');
      }
    }
  }

  // ---------------------------------------------------------------- processes
  async processes() {
    const users = await this.loadPasswd();
    const meminfo = parseKv(await rd(`${HP}/meminfo`));
    const snap = async () => {
      const map = new Map();
      const ents = (await fsp.readdir(HP)).filter((e) => /^\d+$/.test(e));
      await Promise.all(ents.map(async (pid) => {
        try {
          const [stat, status, cmd] = await Promise.all([rd(`${HP}/${pid}/stat`), rdq(`${HP}/${pid}/status`), fsp.readFile(`${HP}/${pid}/cmdline`).catch(() => Buffer.alloc(0))]);
          const lp = stat.indexOf('('), rp = stat.lastIndexOf(')');
          const f = stat.slice(rp + 2).split(' ');
          const uid = Number(/Uid:\s+(\d+)/.exec(status || '')?.[1] ?? -1);
          map.set(Number(pid), {
            pid: Number(pid), name: stat.slice(lp + 1, rp), state: f[0], ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]), threads: Number(f[17]),
            rss: Number(f[21]) * 4096, uid, user: users.get(uid) || String(uid), cmd: cmd.toString('utf8').replace(/\0/g, ' ').trim().slice(0, 500),
          });
        } catch { /* process vanished */ }
      }));
      return map;
    };
    const t0 = Date.now(); const a = await snap(); await new Promise((r) => setTimeout(r, 500)); const b = await snap();
    const dt = (Date.now() - t0) / 1000;
    const out = [];
    for (const [pid, p] of b) {
      const prev = a.get(pid);
      const cpu = prev ? Math.max(0, ((p.ticks - prev.ticks) / 100 / dt) * 100) : 0;
      out.push({ pid, name: p.name, user: p.user, state: p.state, cpu: round1(cpu), mem: round1((p.rss / meminfo.MemTotal) * 100), rss: p.rss, threads: p.threads, cmd: p.cmd });
    }
    return out;
  }

  async killProcess(pid, signal) { return this.env.agent.call('kill', { pid, signal }); }
}

function round1(n) { return Math.round(n * 10) / 10; }
function round(o) { for (const k of Object.keys(o)) if (typeof o[k] === 'number') o[k] = Math.round(o[k] * 10) / 10; return o; }
