import { h, get, post, subscribe, bytes, rate, pct, dur, bar, level, badge, stateBadge, toast, errToast, confirmDialog, loading, empty, errBox, tabs, debounce } from '../lib.js';
import { lineChart } from '../charts.js';
import { state } from '../main.js';

const RANGES = [['15m', '15 minutes'], ['1h', '1 hour'], ['6h', '6 hours'], ['24h', '24 hours'], ['7d', '7 days']];
const card = (t, ...c) => h('div', { class: 'card' }, h('h3', null, t), ...c);

export async function render(main) {
  let snap = null; const redraws = new Set();
  const t = tabs([['overview', 'Overview'], ['disks', 'Disks'], ['network', 'Network'], ['sensors', 'Sensors'], ['processes', 'Processes'], ['docker', 'Docker']], 'overview', (id, pane) => {
    const fn = { overview, disks, network, sensors, processes, docker }[id];
    const r = fn(pane, () => snap, (f) => { redraws.add(f); return () => redraws.delete(f); });
    return r;
  });
  main.append(h('div', { class: 'page-head' }, h('h1', null, 'Monitoring'), h('span', { class: 'muted small' }, `live · updates every ${(state.refreshMs || 2000) / 1000} s (change in Settings → General)`)), t.el);
  const un = subscribe('monitor', (s) => { snap = s; redraws.forEach((f) => f(s)); });
  return () => { un(); t.destroy(); };
}

function rangeChart(title, key, opts) {
  const host = h('div'); const sel = h('select', { style: { width: 'auto' }, onchange: load }, ...RANGES.map(([v, l]) => h('option', { value: v, selected: v === '1h' }, l)));
  async function load() { try { const data = await get('/monitor/history?range=' + sel.value); host.replaceChildren(lineChart({ ...opts, series: opts.series.map((s) => ({ name: s.name, color: s.color, values: data.filter((d) => d[s.key] !== null && d[s.key] !== undefined).map((d) => ({ t: d.t, v: d[s.key] })) })) })); } catch (e) { host.replaceChildren(errBox(e)); } }
  load(); const iv = setInterval(load, 30000);
  const el = card(title, h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '-34px' } }, sel), host); el.dispose = () => clearInterval(iv); return el;
}

function overview(pane, getSnap, reg) {
  const live = h('div'); const charts = [rangeChart('CPU usage', 'cpu', { series: [{ name: 'CPU %', key: 'cpu' }], max: 100, unit: '%', fmt: (v) => v.toFixed(0) }), rangeChart('Memory usage', 'mem', { series: [{ name: 'RAM %', key: 'mem' }, { name: 'Swap %', key: 'swap', color: '#f0a93b' }], max: 100, unit: '%', fmt: (v) => v.toFixed(0) }), rangeChart('Network traffic', 'rx', { series: [{ name: 'Download', key: 'rx' }, { name: 'Upload', key: 'tx', color: '#2fbf71' }], fmt: (v) => bytes(v, 0) }), rangeChart('Disk I/O', 'disk_read', { series: [{ name: 'Read', key: 'disk_read' }, { name: 'Write', key: 'disk_write', color: '#f0a93b' }], fmt: (v) => bytes(v, 0) })];
  pane.append(live, h('div', { class: 'grid', style: { marginTop: '14px' } }, ...charts.map((c) => h('div', { class: 'span-6' }, c))));
  const draw = (s) => { if (!s) return live.replaceChildren(loading()); const m = s.memory;
    live.replaceChildren(h('div', { class: 'grid' },
      h('div', { class: 'span-6' }, card('CPU', h('div', { class: 'row' }, h('div', { class: 'big' }, pct(s.cpu.usage, 1)), h('span', { class: 'muted small' }, `iowait ${pct(s.cpu.iowait, 1)}`)), bar(s.cpu.usage), h('div', { class: 'small muted', style: { margin: '8px 0' } }, `${s.cpu.model} · ${s.cpu.physicalCores} cores / ${s.cpu.threads} threads · ${s.cpu.freqMhz ? s.cpu.freqMhz + ' MHz' : 'frequency unavailable'} · load ${s.cpu.load.map((l) => l.toFixed(2)).join(' / ')}`),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(70px,1fr))', gap: '6px' } }, ...s.cpu.cores.map((c, i) => h('div', { class: 'small' }, h('div', { class: 'muted' }, 'core ' + i), bar(c), pct(c)))))),
      h('div', { class: 'span-6' }, card('Memory', h('div', { class: 'big' }, `${bytes(m.used)} `, h('span', { class: 'muted', style: { fontSize: '14px' } }, `/ ${bytes(m.total)}`)), bar((m.used / m.total) * 100), h('dl', { class: 'kv', style: { gridTemplateColumns: '110px 1fr', marginTop: '10px' } }, ...[['Available', bytes(m.available)], ['Cached', bytes(m.cached)], ['Buffers', bytes(m.buffers)], ['Free', bytes(m.free)], ['Swap', m.swapTotal ? `${bytes(m.swapUsed)} / ${bytes(m.swapTotal)}` : 'none']].flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]))))));
  };
  draw(getSnap()); const un = reg(draw);
  return () => { un(); charts.forEach((c) => c.dispose()); };
}

function disks(pane, getSnap, reg) {
  const box = h('div'); pane.append(box);
  const draw = (s) => { if (!s) return; box.replaceChildren(h('div', { class: 'card', style: { marginBottom: '14px' } }, h('h3', null, 'Filesystems'), s.disk.mounts.length ? h('div', { class: 'tbl' }, h('table', null, h('thead', null, h('tr', null, ...['Mount', 'Device', 'Type', 'Total', 'Used', 'Free', 'Usage'].map((x) => h('th', null, x)))), h('tbody', null, ...s.disk.mounts.map((m) => h('tr', null, h('td', { class: 'mono' }, m.mount), h('td', { class: 'small' }, m.device), h('td', null, m.fstype), h('td', null, bytes(m.total)), h('td', null, bytes(m.used)), h('td', null, bytes(m.free)), h('td', { style: { minWidth: '140px' } }, bar(m.percent), h('span', { class: 'small ' + level(m.percent) }, pct(m.percent, 1)))))))) : empty('Filesystem list unavailable (the host agent is required).'), s.disk.mounts.some((m) => m.limited) ? h('div', { class: 'small warn' }, 'Showing only the data volume because the host agent is offline.') : null),
    h('div', { class: 'card' }, h('h3', null, 'Disk I/O'), s.disk.devices.length ? h('table', null, h('thead', null, h('tr', null, ...['Device', 'Read', 'Write', 'IOPS', 'Utilization'].map((x) => h('th', null, x)))), h('tbody', null, ...s.disk.devices.map((d) => h('tr', null, h('td', { class: 'mono' }, d.name), h('td', null, rate(d.readBps)), h('td', null, rate(d.writeBps)), h('td', null, d.iops.toFixed(0)), h('td', { style: { minWidth: '120px' } }, bar(d.util), pct(d.util)))))) : empty('No block devices visible.'))); };
  draw(getSnap()); return reg(draw);
}

function network(pane, getSnap, reg) {
  const box = h('div'); const chart = rangeChart('Traffic history (physical interfaces)', 'rx', { series: [{ name: 'Download', key: 'rx' }, { name: 'Upload', key: 'tx', color: '#2fbf71' }], fmt: (v) => bytes(v, 0) }); pane.append(box, h('div', { style: { marginTop: '14px' } }, chart));
  const draw = (s) => { if (!s) return; box.replaceChildren(h('div', { class: 'card' }, h('h3', null, `Interfaces — ↓ ${rate(s.network.rxBps)}  ↑ ${rate(s.network.txBps)}`), h('div', { class: 'tbl' }, h('table', null, h('thead', null, h('tr', null, ...['Interface', 'Status', 'Speed', '↓ Rate', '↑ Rate', 'Received', 'Sent', 'MAC'].map((x) => h('th', null, x)))), h('tbody', null, ...s.network.interfaces.map((i) => h('tr', { style: { opacity: i.virtual || i.loopback ? .65 : 1 } }, h('td', null, i.name, i.virtual ? h('span', { class: 'muted small' }, ' virtual') : ''), h('td', null, stateBadge(i.state === 'up' ? 'running' : i.state === 'unknown' ? 'unknown' : 'failed')), h('td', null, i.speedMbps ? i.speedMbps + ' Mb/s' : '—'), h('td', null, rate(i.rxBps)), h('td', null, rate(i.txBps)), h('td', null, bytes(i.rx)), h('td', null, bytes(i.tx)), h('td', { class: 'mono small' }, i.mac || '—')))))))); };
  draw(getSnap()); const un = reg(draw); return () => { un(); chart.dispose(); };
}

function sensors(pane, getSnap, reg) {
  const box = h('div'); const chart = rangeChart('CPU temperature history', 'temp', { series: [{ name: '°C', key: 'temp', color: '#ef5b5b' }], fmt: (v) => v.toFixed(0), max: 110 }); pane.append(box, h('div', { style: { marginTop: '14px' } }, chart));
  const draw = (s) => { if (!s) return; const t = s.temps; box.replaceChildren(card('Temperature sensors', !t.available ? h('div', { class: 'warnbox' }, 'No temperature sensors are exposed by this host (common on VMs and some SBCs). Values are shown as unavailable rather than guessed.') : h('table', null, h('thead', null, h('tr', null, ...['Source', 'Sensor', 'Temperature', 'Kind'].map((x) => h('th', null, x)))), h('tbody', null, ...t.sensors.map((x) => h('tr', null, h('td', null, x.source), h('td', null, x.label), h('td', { class: x.celsius > 85 ? 'bad' : x.celsius > 70 ? 'warn' : '' }, x.celsius.toFixed(1) + ' °C'), h('td', null, x.kind))))), h('div', { class: 'small muted', style: { marginTop: '8px' } }, `CPU: ${t.cpu !== null ? t.cpu.toFixed(1) + ' °C' : 'unavailable'} · Disk: ${t.disk !== null ? t.disk.toFixed(1) + ' °C' : 'unavailable'}`))); };
  draw(getSnap()); const un = reg(draw); return () => { un(); chart.dispose(); };
}

function processes(pane) {
  let rows = [], sort = 'cpu', dir = -1, q = ''; const box = h('div', { class: 'tbl' }); let timer, loadingNow = false;
  const search = h('input', { type: 'search', placeholder: 'Search name, user, PID, command…', oninput: debounce((e) => { q = e.target.value.toLowerCase(); draw(); }, 120) });
  const info = h('span', { class: 'muted small' });
  const th = (key, label) => h('th', { class: 'sortable', onclick: () => { if (sort === key) dir = -dir; else { sort = key; dir = key === 'name' || key === 'user' ? 1 : -1; } draw(); } }, label + (sort === key ? (dir < 0 ? ' ▼' : ' ▲') : ''));
  function draw() {
    const f = rows.filter((p) => !q || `${p.pid} ${p.name} ${p.user} ${p.cmd}`.toLowerCase().includes(q)).sort((a, b) => (a[sort] > b[sort] ? 1 : a[sort] < b[sort] ? -1 : 0) * dir).slice(0, 400);
    info.textContent = `${f.length} shown of ${rows.length}`;
    box.replaceChildren(h('table', null, h('thead', null, h('tr', null, th('pid', 'PID'), th('name', 'Name'), th('user', 'User'), th('cpu', 'CPU %'), th('mem', 'Mem %'), th('rss', 'RSS'), th('state', 'State'), h('th', null, 'Command'), h('th', null, ''))), h('tbody', null, ...f.map((p) => h('tr', null, h('td', null, p.pid), h('td', null, p.name), h('td', null, p.user), h('td', null, p.cpu.toFixed(1)), h('td', null, p.mem.toFixed(1)), h('td', null, bytes(p.rss, 0)), h('td', null, p.state), h('td', { class: 'mono small trunc', style: { maxWidth: '320px' }, title: p.cmd }, p.cmd || `[${p.name}]`), h('td', null, h('button', { class: 'btn sm danger', onclick: () => killDialog(p, load) }, 'Terminate')))))));
  }
  async function load() { if (loadingNow) return; loadingNow = true; try { rows = await get('/monitor/processes'); draw(); } catch (e) { box.replaceChildren(errBox(e)); } finally { loadingNow = false; } }
  pane.append(h('div', { class: 'toolbar' }, search, h('button', { class: 'btn sm', onclick: load }, 'Refresh'), info, h('span', { class: 'muted small' }, `refreshes every ${Math.max(state.refreshMs || 2000, 3000) / 1000} s`)), h('div', { class: 'card' }, box)); box.append(loading()); load(); timer = setInterval(load, Math.max(state.refreshMs || 2000, 3000));
  return () => clearInterval(timer);
}
async function killDialog(p, done) {
  const sig = h('select', null, h('option', { value: 'TERM' }, 'SIGTERM (graceful)'), h('option', { value: 'KILL' }, 'SIGKILL (force)'), h('option', { value: 'HUP' }, 'SIGHUP'));
  const ok = await confirmDialog({ title: `Terminate process ${p.pid}`, danger: true, confirmText: 'Send signal', message: h('div', { class: 'form' }, h('p', null, `${p.name} (user ${p.user}). Terminating system processes can destabilize the server.`), h('label', null, 'Signal', sig)) });
  if (!ok) return; try { await post(`/monitor/processes/${p.pid}/kill`, { confirm: true, signal: sig.value }); toast('Signal sent', 'ok'); setTimeout(done, 700); } catch (e) { errToast(e); }
}

function docker(pane, getSnap, reg) {
  const box = h('div'); pane.append(box);
  const draw = (s) => { const d = s?.docker; if (!d) return; box.replaceChildren(card('Docker Engine', d.up ? h('dl', { class: 'kv' }, ...[['Version', `${d.version} (API ${d.apiVersion})`], ['Status', badge('running', 'ok')], ['Storage driver', d.driver], ['Root dir', d.rootDir], ['Host OS', d.os], ['Containers', `${d.containers} total · ${d.running} running · ${d.stopped} stopped · ${d.paused} paused`], ['Images', d.images], ['Volumes', d.volumes], ['Networks', d.networks]].flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])) : h('div', { class: 'err' }, 'Docker daemon unreachable: ' + d.error))); };
  draw(getSnap()); return reg(draw);
}
void dur; void empty;
