import { h, get, post, put, del, api, bytes, rate, pct, since, when, stateBadge, badge, loading, errBox, empty, tabs, toast, errToast, confirmDialog, busy, download, debounce, bar, subscribe } from './lib.js';
import { openWindow } from './wm.js';
import { lineChart } from './charts.js';
import { createTerminal } from './term.js';
import { openSocket } from './lib.js';
import { createEditor, createDiff } from './editor.js';
import { state } from './main.js';

export function openContainer(id, name, tab) {
  return openWindow({
    key: 'container:' + id, title: name || id.slice(0, 12), width: 900, height: 600,
    render(body, win) {
      let t = null; let cleanup = null;
      const t0 = tabs([['overview', 'Overview'], ['stats', 'Stats'], ['logs', 'Logs'], ['terminal', 'Terminal'], ['inspect', 'Inspect'], ['settings', 'Settings']], tab, (tid, pane) => {
        pane.classList.add('pane'); pane.style.display = 'flex'; pane.style.flexDirection = 'column';
        return ({ overview, stats, logs, terminal, inspect, settings })[tid](id, pane, win);
      });
      body.append(t0.el); t = t0;
      return () => t.destroy();
    },
  });
}

const kv = (rows) => h('dl', { class: 'kv' }, rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v ?? '—')]));

function overview(id, pane, win) {
  const run = async () => {
    pane.replaceChildren(loading());
    try {
      const c = await get('/docker/containers/' + id);
      win.setTitle(c.name);
      const act = (a, label, cls = '') => h('button', { class: 'btn sm ' + cls, onclick: async (e) => { if (['kill'].includes(a) && !(await confirmDialog({ title: 'Kill container', message: `Send SIGKILL to ${c.name}?`, danger: true, confirmText: 'Kill' }))) return; await busy(e.target, async () => post(`/docker/containers/${id}/${a}`, { confirmSelf: c.self && (a === 'stop' || a === 'restart' || a === 'kill') ? await selfOk(c) : false }), `${label} OK`); run(); } }, label);
      pane.replaceChildren(
        h('div', { class: 'row', style: { marginBottom: '12px' } }, stateBadge(c.state), c.health ? stateBadge(c.health) : null, c.privileged ? badge('privileged', 'bad') : null, c.self ? badge('ServerOS itself', 'warn') : null, h('span', { class: 'spacer' }),
          c.running ? [act('stop', 'Stop'), act('restart', 'Restart'), act(c.paused ? 'unpause' : 'pause', c.paused ? 'Unpause' : 'Pause'), act('kill', 'Kill', 'danger')] : act('start', 'Start', 'primary')),
        kv([['Name', c.name], ['Container ID', h('span', { class: 'mono' }, c.id)], ['Image', c.image], ['Created', when(c.created)], ['Started', c.running ? `${when(c.startedAt)} (up ${since(c.startedAt)})` : '—'], ['Status', `${c.state}${c.exitCode && !c.running ? ` (exit ${c.exitCode})` : ''}${c.oomKilled ? ' — OOM killed' : ''}`],
          ['Command', h('code', null, c.command || '—')], ['Restart policy', `${c.restartPolicy.Name}${c.restartPolicy.MaximumRetryCount ? ` (max ${c.restartPolicy.MaximumRetryCount})` : ''} · restarted ${c.restartCount}×`],
          ['Ports', c.ports.length ? c.ports.map((p) => h('div', null, `${p.container} ${p.bindings.length ? '→ ' + p.bindings.join(', ') : '(not published)'}`)) : 'none'],
          ['Networks', c.networks.map((n) => h('div', null, `${n.name} — ${n.ip || 'no IP'}`))],
          ['Mounts', c.mounts.length ? c.mounts.map((m) => h('div', { class: 'mono' }, `${m.type}: ${m.name || m.source} → ${m.destination}${m.rw ? '' : ' (ro)'}`)) : 'none'],
          ['Environment', h('div', null, c.env.length ? c.env.map((e) => h('div', { class: 'mono' }, `${e.key}=${e.value}`, e.masked ? h('span', { class: 'muted' }, '  (masked)') : null)) : 'none')],
          ['Labels', Object.keys(c.labels).length ? h('details', null, h('summary', { class: 'muted' }, `${Object.keys(c.labels).length} labels`), Object.entries(c.labels).map(([k, v]) => h('div', { class: 'mono small' }, `${k}=${v}`))) : 'none']]),
        c.healthLog.length ? h('div', { style: { marginTop: '12px' } }, h('h3', null, 'Recent health checks'), h('pre', { class: 'pre' }, c.healthLog.map((l) => `${l.start}  exit ${l.exitCode}  ${l.output.trim()}`).join('\n'))) : null);
    } catch (e) { pane.replaceChildren(errBox(e)); }
  };
  run();
}
async function selfOk(c) { return c.self ? confirmDialog({ title: 'This is ServerOS itself', message: 'This will interrupt the dashboard. Continue?', danger: true }) : false; }

function stats(id, pane) {
  pane.replaceChildren(loading());
  let alive = true, timer;
  const render = async () => {
    try {
      const s = await get(`/docker/containers/${id}/stats`);
      if (!alive) return;
      const l = s.latest, hist = s.history;
      const mk = (name, key, unit, fmt, max) => h('div', { class: 'card', style: { marginBottom: '10px' } }, h('h3', null, name), lineChart({ series: [{ name, values: hist.map((p) => ({ t: p.t, v: p[key] })) }], unit, fmt, max, height: 110 }));
      pane.replaceChildren(h('div', null,
        l ? h('div', { class: 'grid', style: { marginBottom: '10px' } },
          ...[['CPU', pct(l.cpu, 1)], ['Memory', `${bytes(l.memUsed)}${l.memLimit ? ' / ' + bytes(l.memLimit) : ''}`], ['Network ↓ / ↑', `${rate(l.netRxRate)} / ${rate(l.netTxRate)}`], ['Block I/O R / W', `${bytes(l.blockReadTotal)} / ${bytes(l.blockWriteTotal)}`]].map(([k, v]) => h('div', { class: 'card span-2' }, h('h3', null, k), h('div', { style: { fontSize: '17px', fontWeight: 650 } }, v))), h('div', { class: 'muted small span-12' }, `PIDs: ${l.pids ?? '—'}`))
          : empty('No live stats — the container is not running or stats are still warming up.'),
        hist.length > 1 ? [mk('CPU %', 'cpu', '%', (v) => v.toFixed(0)), mk('Memory', 'mem', '', (v) => bytes(v, 0)), mk('Network ↓', 'rx', '', (v) => bytes(v, 0))] : h('div', { class: 'muted small' }, 'History fills in while this tab is open (kept in memory for ~5 minutes).')));
    } catch (e) { pane.replaceChildren(errBox(e)); }
  };
  // keep the stats hub warm while open
  const unsub = subscribe('containers', () => {}, 'containers');
  render(); timer = setInterval(render, state.refreshMs || 2000);
  return () => { alive = false; clearInterval(timer); unsub(); };
}

function logs(id, pane) {
  let sock = null, paused = false, auto = true, lines = [], search = '', buffered = [];
  const view = h('div', { class: 'logview' });
  const tail = h('select', null, ...['50', '100', '500', '1000', '5000'].map((v) => h('option', { value: v, selected: v === '200' }, `tail ${v}`)));
  tail.value = '100';
  const ts = h('input', { type: 'checkbox', checked: true });
  const q = h('input', { type: 'search', placeholder: 'Search…' });
  const stream = h('select', null, h('option', { value: 'all' }, 'stdout + stderr'), h('option', { value: 'stderr' }, 'stderr only'), h('option', { value: 'stdout' }, 'stdout only'));
  const since = h('select', null, ...[['', 'live'], ['300', 'last 5 min'], ['3600', 'last hour'], ['86400', 'last 24 h']].map(([v, l]) => h('option', { value: v }, l)));
  const pauseBtn = h('button', { class: 'btn sm', onclick: () => { paused = !paused; pauseBtn.textContent = paused ? 'Resume' : 'Pause'; if (!paused) { lines.push(...buffered); buffered = []; draw(); } } }, 'Pause');
  const status = h('span', { class: 'muted small' }, 'connecting…');
  const esc = (t) => t;
  const draw = () => {
    const s = search.toLowerCase();
    const f = lines.filter((l) => (stream.value === 'all' || l.s === stream.value) && (!s || l.m.toLowerCase().includes(s)));
    view.replaceChildren(...f.slice(-3000).map((l) => { const d = h('div', { class: l.s === 'stderr' ? 'err2' : '' }); if (l.t && ts.checked) d.append(h('span', { class: 'ts' }, l.t + ' ')); if (s) { const i = l.m.toLowerCase().indexOf(s); if (i >= 0) { d.append(esc(l.m.slice(0, i)), h('mark', null, l.m.slice(i, i + s.length)), l.m.slice(i + s.length)); return d; } } d.append(l.m); return d; }));
    if (auto) view.scrollTop = view.scrollHeight;
  };
  const connect = () => {
    sock?.close(); lines = []; buffered = []; status.textContent = 'connecting…';
    const sinceTs = since.value ? Math.floor(Date.now() / 1000) - Number(since.value) : '';
    sock = openSocket('/ws/container/logs', { id, tail: sinceTs ? 5000 : tail.value, since: sinceTs, timestamps: ts.checked ? '1' : '0' }, {
      open: () => { status.textContent = 'live'; },
      message: (e) => { const m = JSON.parse(e.data); if (m.type === 'lines') { (paused ? buffered : lines).push(...m.lines); if (!paused) { if (lines.length > 6000) lines.splice(0, lines.length - 5000); drawSoon(); } } else if (m.type === 'end') status.textContent = 'stream ended (container stopped)'; },
      close: (e) => { if (e.code !== 1000) status.textContent = 'reconnecting…'; },
    });
  };
  const drawSoon = debounce(draw, 80);
  q.addEventListener('input', debounce(() => { search = q.value; draw(); }, 150));
  stream.addEventListener('change', draw); ts.addEventListener('change', connect); tail.addEventListener('change', connect); since.addEventListener('change', connect);
  view.addEventListener('scroll', () => { auto = view.scrollTop + view.clientHeight >= view.scrollHeight - 8; autoBox.checked = auto; });
  const autoBox = h('input', { type: 'checkbox', checked: true, onchange: () => { auto = autoBox.checked; if (auto) view.scrollTop = view.scrollHeight; } });
  const dl = h('button', { class: 'btn sm', onclick: async (e) => { await busy(e.target, async () => { const txt = await api(`/docker/containers/${id}/logs?tail=${since.value ? 50000 : 'all'}&download=1&timestamps=${ts.checked ? 1 : 0}`); download(`${id.slice(0, 12)}.log`, txt); }); } }, 'Download');
  pane.append(h('div', { class: 'toolbar' }, q, stream, tail, since, h('label', { class: 'row small' }, ts, 'timestamps'), h('label', { class: 'row small' }, autoBox, 'auto-scroll'), pauseBtn, dl, status), h('div', { style: { flex: 1, minHeight: 0 } }, view));
  connect();
  return () => sock?.close();
}

function terminal(id, pane) {
  pane.replaceChildren(loading('Detecting shells…'));
  let term = null;
  const start = async (shell) => {
    term?.dispose();
    const box = h('div', { style: { flex: 1, minHeight: 0 } });
    const picker = h('select', { onchange: () => start(picker.value) });
    const hdr = h('div', { class: 'toolbar' }, h('span', { class: 'muted small' }, 'Shell:'), picker, h('span', { class: 'muted small' }, 'Interactive TTY — resize the window to resize the terminal'));
    pane.replaceChildren(hdr, box);
    term = createTerminal('/ws/container/terminal', { id, shell }, { onReady: (m) => { picker.replaceChildren(...m.shells.map((s) => h('option', { value: s, selected: s === m.shell }, s))); } });
    box.append(term.el); term.el.style.height = '100%';
  };
  get(`/docker/containers/${id}/shells`).then((r) => { if (!r.shells.length) pane.replaceChildren(h('div', { class: 'warnbox' }, 'No shell (bash/sh/ash/zsh) was found in this container. It is probably a minimal or distroless image, so an interactive terminal is not available.')); else start(r.shells[0]); }).catch((e) => pane.replaceChildren(errBox(e)));
  return () => term?.dispose();
}

function inspect(id, pane) {
  pane.replaceChildren(loading());
  get('/docker/containers/' + id).then((c) => {
    const raw = JSON.stringify(c.raw, null, 2);
    const t = tabs([['struct', 'Structured'], ['raw', 'Raw JSON']], 'struct', (tid, p) => {
      if (tid === 'raw') { p.append(h('div', { class: 'toolbar' }, h('button', { class: 'btn sm', onclick: () => download(`${c.name}-inspect.json`, raw) }, 'Download')), h('pre', { class: 'pre', style: { maxHeight: 'none' } }, raw)); return; }
      const sec = (title, rows) => h('div', { style: { marginBottom: '14px' } }, h('h3', null, title), kv(rows));
      p.style.overflow = 'auto';
      p.append(sec('State', [['Status', c.state], ['PID', c.pid], ['Exit code', c.exitCode], ['OOM killed', String(c.oomKilled)], ['Error', c.error || '—']]),
        sec('Config', [['Image', c.image], ['Image ID', c.imageId], ['Working dir', c.workingDir || '—'], ['User', c.user || 'root'], ['TTY', String(c.tty)], ['Hostname', c.hostname], ['Platform', c.platform], ['Driver', c.driver]]),
        sec('Limits', [['Memory', c.limits.memory ? bytes(c.limits.memory) : 'unlimited'], ['CPUs', c.limits.nanoCpus ? (c.limits.nanoCpus / 1e9).toFixed(2) : 'unlimited'], ['CPU shares', c.limits.cpuShares || 'default']]),
        sec('Networks', c.networks.map((n) => [n.name, `${n.ip || '—'} gw ${n.gateway || '—'} mac ${n.mac || '—'} aliases: ${(n.aliases || []).join(', ') || '—'}`])));
    });
    pane.replaceChildren(t.el);
  }).catch((e) => pane.replaceChildren(errBox(e)));
}

function settings(id, pane, win) {
  pane.replaceChildren(loading());
  get('/docker/containers/' + id).then((c) => {
    const pol = h('select', null, ...['no', 'always', 'unless-stopped', 'on-failure'].map((p) => h('option', { value: p, selected: p === c.restartPolicy.Name }, p)));
    const mem = h('input', { type: 'number', min: 0, placeholder: 'MB (0 = unlimited)', value: c.limits.memory ? Math.round(c.limits.memory / 1048576) : '' });
    const envRows = c.env.map((e) => ({ ...e, orig: e.value }));
    const envBox = h('div', { class: 'form' });
    const drawEnv = () => envBox.replaceChildren(...envRows.map((e, i) => h('div', { class: 'row' }, h('input', { type: 'text', value: e.key, style: { maxWidth: '200px' }, oninput: (ev) => { e.key = ev.target.value; } }), h('input', { type: e.masked && e.keep !== false ? 'password' : 'text', value: e.value, placeholder: e.masked ? 'masked — leave unchanged to keep' : '', oninput: (ev) => { e.value = ev.target.value; e.keep = false; } }), h('button', { class: 'btn icon sm', onclick: () => { envRows.splice(i, 1); drawEnv(); } }, '✕'))), h('button', { class: 'btn sm', onclick: () => { envRows.push({ key: '', value: '', keep: false }); drawEnv(); } }, '+ Add variable'));
    envRows.forEach((e) => { e.keep = e.masked; });
    drawEnv();
    const image = h('input', { type: 'text', value: c.image });
    const removeOld = h('input', { type: 'checkbox' });
    pane.replaceChildren(h('div', { style: { overflow: 'auto' } },
      h('div', { class: 'card', style: { marginBottom: '12px' } }, h('h3', null, 'Live settings (no recreation needed)'), h('div', { class: 'form' },
        h('label', null, 'Restart policy', pol), h('label', null, 'Memory limit', mem),
        h('div', null, h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => { await put(`/docker/containers/${id}/settings`, { restartPolicy: { name: pol.value }, memoryMb: mem.value === '' ? undefined : Number(mem.value) }); }, 'Settings applied')}, 'Apply')))),
      h('div', { class: 'card', style: { marginBottom: '12px' } }, h('h3', null, 'Rename'), h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { const n = prompt('New container name', c.name); if (n && n !== c.name) { try { await post(`/docker/containers/${id}/rename`, { name: n }); toast('Renamed', 'ok'); win.setTitle(n); } catch (e) { errToast(e); } } } }, 'Rename…'))),
      h('div', { class: 'card' }, h('h3', null, 'Environment & image (requires recreation)'),
        h('div', { class: 'warnbox', style: { marginBottom: '10px' } }, 'Docker cannot change environment variables or the image of an existing container. ServerOS will stop the container, rename it to "', c.name, '_old_…" (kept, stopped), create a new container with the same name, mounts, ports and networks, and start it. Named volumes and bind mounts are kept. ', c.composeProject ? h('b', null, 'This container belongs to the Compose project "' + c.composeProject + '" — prefer editing the compose file in Stacks, otherwise the next "up" may revert changes. ') : '', 'Data stored only inside the container filesystem (not in a volume) stays with the old container.'),
        h('div', { class: 'form' }, h('label', null, 'Image', image), envBox, h('label', { class: 'row' }, removeOld, 'Remove the old container after a successful recreate (its filesystem is lost; volumes are never removed)'),
          h('div', null, h('button', { class: 'btn danger', onclick: async (e) => {
            if (!(await confirmDialog({ title: 'Recreate container', message: `Recreate ${c.name}? It will be briefly stopped.`, confirmText: 'Recreate', danger: true, requireText: c.self ? c.name : undefined }))) return;
            await busy(e.target, async () => { const r = await post(`/docker/containers/${id}/recreate`, { image: image.value !== c.image ? image.value : undefined, env: envRows.filter((x) => x.key), removeOld: removeOld.checked, confirmSelf: c.self }); toast(r.oldContainer ? `Recreated. Old container kept as ${r.oldContainer}` : 'Recreated', 'ok'); win.close(); }); } }, 'Recreate with changes')))))); 
  }).catch((e) => pane.replaceChildren(errBox(e)));
}
void del; void createEditor; void createDiff; void bar;
