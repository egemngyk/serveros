import { h, icon, get, put, post, subscribe, bytes, rate, pct, dur, bar, level, badge, stateBadge, since, toast, errToast, busy, confirmDialog, loading, empty, errBox } from '../lib.js';
import { sparkline } from '../charts.js';
import { openContainer } from '../containerWindow.js';

const DEFAULT = [['cpu', 1], ['memory', 1], ['disk', 1], ['network', 1], ['uptime', 2], ['docker', 2], ['health', 2], ['containers', 12]].map(([id, span]) => ({ id, visible: true, span }));
const TITLES = { cpu: 'CPU', memory: 'Memory', disk: 'Disk', network: 'Network', uptime: 'System', docker: 'Docker', health: 'Health', containers: 'Applications' };
const SPANS = [[1, '¼'], [2, '½'], [3, '¾'], [12, 'Full']];
const SPAN_MAP = { 1: 3, 2: 6, 3: 9, 4: 12, 6: 6, 12: 12 };

export async function render(main) {
  let layout = DEFAULT, editing = false, snap = null, containers = null;
  try { const r = await get('/dashboard/layout'); if (r.layout) { layout = r.layout; for (const d of DEFAULT) if (!layout.find((x) => x.id === d.id)) layout.push(d); } } catch { /* defaults */ }
  const cpuHist = [], netHist = [];
  const grid = h('div', { class: 'grid' });
  const editBtn = h('button', { class: 'btn', onclick: () => { editing = !editing; editBtn.textContent = editing ? 'Done' : 'Customize'; if (!editing) put('/dashboard/layout', { layout }).then(() => toast('Layout saved', 'ok')).catch(errToast); draw(); } }, 'Customize');
  main.append(h('div', { class: 'page-head' }, h('h1', null, 'Home'), h('span', { class: 'spacer' }), h('button', { class: 'btn', style: { display: 'none' }, id: 'reset', onclick: () => { layout = DEFAULT.map((x) => ({ ...x })); draw(); } }, 'Reset'), editBtn), grid);

  const W = {
    cpu: () => card('CPU', snap ? [h('div', { class: 'big' }, pct(snap.cpu.usage)), bar(snap.cpu.usage), h('div', { class: 'small muted', style: { marginTop: '6px' } }, `${snap.cpu.threads} threads · load ${snap.cpu.load.map((l) => l.toFixed(2)).join(' ')}`), sparkline(cpuHist, { w: 200 })] : null),
    memory: () => { const m = snap?.memory; return card('Memory', m && [h('div', { class: 'big' }, pct((m.used / m.total) * 100)), bar((m.used / m.total) * 100), h('div', { class: 'small muted', style: { marginTop: '6px' } }, `${bytes(m.used)} of ${bytes(m.total)}`)]); },
    disk: () => { const d = snap?.disk.mounts; const top = d && [...d].sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : 0))[0]; return card('Disk', d && (top ? [h('div', { class: 'big' }, pct(top.percent)), bar(top.percent), h('div', { class: 'small muted', style: { marginTop: '6px' } }, `${top.mount}: ${bytes(top.used)} of ${bytes(top.total)}`), h('div', { class: 'small muted' }, `I/O ↓ ${rate(snap.disk.readBps)} ↑ ${rate(snap.disk.writeBps)}`)] : h('div', { class: 'muted' }, 'Unavailable'))); },
    network: () => card('Network', snap && [h('div', { class: 'big', style: { fontSize: '18px' } }, `↓ ${rate(snap.network.rxBps)}`), h('div', { class: 'big', style: { fontSize: '18px' } }, `↑ ${rate(snap.network.txBps)}`), h('div', { class: 'small muted' }, `Total ↓ ${bytes(snap.network.rxTotal)} ↑ ${bytes(snap.network.txTotal)}`), sparkline(netHist, { w: 200, color: '#2fbf71' })]),
    uptime: () => card('System', snap && h('dl', { class: 'kv', style: { gridTemplateColumns: '90px 1fr' } }, ...[['Host', snap.system.hostname], ['OS', snap.system.os], ['Kernel', snap.system.kernel], ['Uptime', dur(snap.system.uptime)], ['Booted', new Date(snap.system.bootTime * 1000).toLocaleString()], ['Temp', snap.temps.cpu !== null ? `${snap.temps.cpu.toFixed(0)} °C` : 'unavailable']].flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]))),
    docker: () => { const d = snap?.docker; return card('Docker', d && (d.up ? h('dl', { class: 'kv', style: { gridTemplateColumns: '110px 1fr' } }, ...[['Engine', `v${d.version} · API ${d.apiVersion}`], ['Status', badge('running', 'ok')], ['Running', d.running], ['Stopped', d.stopped], ['Paused', d.paused], ['Images', d.images], ['Volumes', d.volumes], ['Networks', d.networks]].flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])) : h('div', null, badge('unreachable', 'bad'), h('div', { class: 'small muted' }, d.error)))); },
    health: () => card('Health', snap && h('div', { style: { display: 'grid', gap: '8px' } }, ...healthRows(snap, containers))),
    containers: () => h('div', { class: 'card' }, h('h3', null, 'Applications'), containers === null ? loading() : containers.length ? h('div', { class: 'apps' }, ...containers.map(appCard)) : empty('No containers yet. Create one from the Containers page.')),
  };

  function draw() {
    document.getElementById('reset').style.display = editing ? '' : 'none';
    grid.replaceChildren();
    layout.forEach((w, i) => {
      if (!w.visible && !editing) return;
      const body = W[w.id]?.(); if (!body) return;
      const wrap = h('div', { class: `span-${w.span}`, style: { gridColumn: `span ${SPAN_MAP[w.span] || 6}`, opacity: w.visible ? 1 : .4 }, 'data-i': i }, body);
      if (editing) {
        wrap.classList.add('widget-edit'); wrap.draggable = true;
        wrap.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(i)); wrap.classList.add('drag'); });
        wrap.addEventListener('dragend', () => wrap.classList.remove('drag'));
        wrap.addEventListener('dragover', (e) => e.preventDefault());
        wrap.addEventListener('drop', (e) => { e.preventDefault(); const from = Number(e.dataTransfer.getData('text/plain')); const [m] = layout.splice(from, 1); layout.splice(i, 0, m); draw(); });
        const sel = h('select', { style: { width: 'auto' }, onchange: (e) => { w.span = Number(e.target.value); draw(); } }, ...SPANS.map(([v, l]) => h('option', { value: v, selected: v === w.span || (w.span === 4 && v === 12) }, l)));
        const move = (d) => { const j = i + d; if (j < 0 || j >= layout.length) return; [layout[i], layout[j]] = [layout[j], layout[i]]; draw(); };
        wrap.prepend(h('div', { class: 'row', style: { marginBottom: '6px', justifyContent: 'space-between' } }, h('b', null, '⠿ ' + TITLES[w.id]), h('span', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => move(-1), 'aria-label': 'Move up' }, '↑'), h('button', { class: 'btn sm', onclick: () => move(1), 'aria-label': 'Move down' }, '↓'), sel, h('button', { class: 'btn sm', onclick: () => { w.visible = !w.visible; draw(); } }, w.visible ? 'Hide' : 'Show'))));
      }
      grid.append(wrap);
    });
  }

  function appCard(c) {
    const s = c.stats, on = c.state === 'running';
    const act = (a, label, cls = '') => h('button', { class: 'btn sm ' + cls, onclick: async (e) => { if (c.self && !(await confirmDialog({ title: 'ServerOS itself', message: 'This will interrupt the dashboard.', danger: true }))) return; busy(e.target, () => post(`/docker/containers/${c.id}/${a}`, { confirmSelf: c.self }), `${label}: ${c.name}`); } }, label);
    const ports = c.ports.filter((p) => p.public).map((p) => `${p.public}→${p.private}`).filter((v, i, a) => a.indexOf(v) === i);
    return h('div', { class: 'app' + (on ? '' : ' off') },
      h('div', { class: 'top' }, h('div', { class: 'ico' }, c.name.slice(0, 1).toUpperCase()), h('div', { style: { minWidth: 0, flex: 1 } }, h('div', { class: 'name trunc', onclick: () => openContainer(c.id, c.name) }, c.name), h('div', { class: 'small muted trunc', title: c.image }, c.image)), stateBadge(c.health || c.state)),
      h('div', { class: 'metrics' }, h('span', null, 'CPU ', h('b', null, on && s ? pct(s.cpu, 1) : '—')), h('span', null, 'Memory ', h('b', null, on && s ? bytes(s.memUsed, 0) : '—')), h('span', null, 'Net ', h('b', null, on && s ? `↓${bytes(s.netRxRate, 0)}/s ↑${bytes(s.netTxRate, 0)}/s` : '—')), h('span', null, 'Uptime ', h('b', null, on ? since(c.startedAt) : '—')), h('span', { style: { gridColumn: '1/3' } }, 'Ports ', h('b', null, ports.join(', ') || 'none'))),
      h('div', { class: 'actions' }, on ? [act('stop', 'Stop'), act('restart', 'Restart')] : act('start', 'Start', 'primary'), h('button', { class: 'btn sm', onclick: () => openContainer(c.id, c.name) }, 'Details'), h('button', { class: 'btn sm', onclick: () => openContainer(c.id, c.name, 'terminal') }, 'Terminal'), h('button', { class: 'btn sm', onclick: () => openContainer(c.id, c.name, 'logs') }, 'Logs')));
  }

  draw();
  const u1 = subscribe('monitor', (s) => { snap = s; cpuHist.push(s.cpu.usage); netHist.push(s.network.rxBps + s.network.txBps); if (cpuHist.length > 60) cpuHist.shift(); if (netHist.length > 60) netHist.shift(); if (!editing) draw(); });
  const u2 = subscribe('containers', (list) => { containers = list; if (!editing) draw(); });
  return () => { u1(); u2(); };
}

function card(title, body) { return h('div', { class: 'card', style: { height: '100%' } }, h('h3', null, title), body || loading('')); }
function healthRows(s, containers) {
  const rows = []; const add = (ok, text) => rows.push(h('div', { class: 'row small' }, h('span', { class: 'dot ' + ok }), text));
  add(level(s.cpu.usage) === 'bad' ? 'bad' : level(s.cpu.usage) === 'warn' ? 'warn' : 'ok', `CPU ${pct(s.cpu.usage)}`);
  const mp = (s.memory.used / s.memory.total) * 100; add(level(mp) === 'bad' ? 'bad' : level(mp) === 'warn' ? 'warn' : 'ok', `Memory ${pct(mp)}`);
  const worst = [...s.disk.mounts].sort((a, b) => b.percent - a.percent)[0]; if (worst) add(level(worst.percent) === 'bad' ? 'bad' : level(worst.percent) === 'warn' ? 'warn' : 'ok', `Disk ${worst.mount} ${pct(worst.percent)}`);
  add(s.docker?.up ? 'ok' : 'bad', s.docker?.up ? 'Docker running' : 'Docker unreachable');
  if (containers) { const bad = containers.filter((c) => c.health === 'unhealthy' || (c.state === 'exited' && c.exitCode)); add(bad.length ? 'warn' : 'ok', bad.length ? `${bad.length} container(s) need attention` : 'All containers OK'); }
  return rows;
}
void icon; void errBox;
