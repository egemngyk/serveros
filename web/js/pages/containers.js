import { h, get, post, del, api, subscribe, bytes, pct, since, stateBadge, badge, toast, errToast, busy, confirmDialog, modal, loading, empty, errBox, debounce } from '../lib.js';
import { openContainer } from '../containerWindow.js';

export async function render(main) {
  let list = [], filter = '', stateF = 'all', sel = new Set();
  const box = h('div', { class: 'tbl' });
  const search = h('input', { type: 'search', placeholder: 'Filter by name, image or project…', oninput: debounce((e) => { filter = e.target.value.toLowerCase(); draw(); }, 120) });
  const stateSel = h('select', { onchange: (e) => { stateF = e.target.value; draw(); } }, ...['all', 'running', 'exited', 'paused'].map((s) => h('option', { value: s }, s)));
  const bulk = h('div', { class: 'toolbar' });
  main.append(h('div', { class: 'page-head' }, h('h1', null, 'Containers'), h('span', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: () => createDialog(reload) }, '+ Create container')), h('div', { class: 'toolbar' }, search, stateSel), bulk, h('div', { class: 'card' }, box));

  const doBulk = async (action) => {
    const names = list.filter((c) => sel.has(c.id)).map((c) => c.name);
    const danger = ['kill', 'remove'].includes(action);
    if (!(await confirmDialog({ title: `${action[0].toUpperCase() + action.slice(1)} ${names.length} container(s)`, message: h('div', null, h('p', null, names.join(', ')), action === 'remove' ? h('p', null, 'Containers are removed. Volumes are never deleted automatically.') : null), danger, confirmText: action, requireText: danger && names.length > 1 ? String(names.length) : undefined, detail: danger && names.length > 1 ? h('div', { class: 'small muted' }, `Type ${names.length} to confirm`) : null }))) return;
    const selfIn = list.some((c) => sel.has(c.id) && c.self);
    try { const r = await post('/docker/containers/bulk', { ids: [...sel], action, confirm: true, confirmSelf: selfIn ? await confirmDialog({ title: 'ServerOS itself', message: 'Your selection contains the ServerOS container. Continue?', danger: true }) : false }); const failed = r.results.filter((x) => !x.ok); toast(failed.length ? `${failed.length} failed: ${failed[0].error}` : 'Done', failed.length ? 'error' : 'ok'); sel.clear(); reload(); } catch (e) { errToast(e); }
  };
  function draw() {
    const rows = list.filter((c) => (stateF === 'all' || c.state === stateF) && (!filter || `${c.name} ${c.image} ${c.project || ''}`.toLowerCase().includes(filter)));
    bulk.replaceChildren(sel.size ? h('span', { class: 'row' }, h('b', null, `${sel.size} selected`), ...['start', 'stop', 'restart', 'pause', 'unpause', 'kill', 'remove'].map((a) => h('button', { class: 'btn sm ' + (['kill', 'remove'].includes(a) ? 'danger' : ''), onclick: () => doBulk(a) }, a))) : '');
    if (!rows.length) { box.replaceChildren(empty(list.length ? 'No containers match the filter.' : 'No containers on this Docker host.')); return; }
    const all = h('input', { type: 'checkbox', checked: rows.every((c) => sel.has(c.id)), onchange: (e) => { rows.forEach((c) => (e.target.checked ? sel.add(c.id) : sel.delete(c.id))); draw(); } });
    box.replaceChildren(h('table', null, h('thead', null, h('tr', null, h('th', null, all), ...['Name', 'State', 'Image', 'CPU', 'Memory', 'Ports', 'Uptime', ''].map((t) => h('th', null, t)))),
      h('tbody', null, ...rows.map((c) => { const s = c.stats; return h('tr', null,
        h('td', null, h('input', { type: 'checkbox', checked: sel.has(c.id), onchange: (e) => { e.target.checked ? sel.add(c.id) : sel.delete(c.id); draw(); } })),
        h('td', null, h('a', { href: '#', onclick: (e) => { e.preventDefault(); openContainer(c.id, c.name); } }, c.name), c.project ? h('div', { class: 'small muted' }, 'stack: ' + c.project) : null, c.self ? badge('ServerOS', 'warn') : null),
        h('td', null, stateBadge(c.health || c.state)), h('td', { class: 'trunc', style: { maxWidth: '220px' }, title: c.image }, c.image),
        h('td', null, c.state === 'running' && s ? pct(s.cpu, 1) : '—'), h('td', null, c.state === 'running' && s ? bytes(s.memUsed, 0) : '—'),
        h('td', { class: 'small' }, [...new Set(c.ports.filter((p) => p.public).map((p) => `${p.public}→${p.private}`))].join(', ') || '—'), h('td', null, c.state === 'running' ? since(c.startedAt) : '—'),
        h('td', { class: 'nowrap' }, c.state === 'running' ? h('button', { class: 'btn sm', onclick: (e) => busy(e.target, () => post(`/docker/containers/${c.id}/restart`, { confirmSelf: c.self }), 'Restarted') }, 'Restart') : h('button', { class: 'btn sm primary', onclick: (e) => busy(e.target, () => post(`/docker/containers/${c.id}/start`), 'Started') }, 'Start'))); }))));
  }
  async function reload() { try { list = await get('/docker/containers?force=1&stats=1'); sel = new Set([...sel].filter((id) => list.some((c) => c.id === id))); draw(); } catch (e) { box.replaceChildren(errBox(e)); } }
  box.append(loading()); await reload();
  const un = subscribe('containers', (l) => { if (Array.isArray(l)) { list = l; draw(); } });
  const un2 = subscribe('docker.event', () => {}, 'containers');
  return () => { un(); un2(); };
}

function createDialog(done) {
  const f = { image: h('input', { type: 'text', placeholder: 'nginx:alpine', required: true }), name: h('input', { type: 'text', placeholder: 'optional' }), cmd: h('input', { type: 'text', placeholder: 'optional command override' }), restart: h('select', null, ...['unless-stopped', 'always', 'on-failure', 'no'].map((v) => h('option', { value: v }, v))), network: h('input', { type: 'text', placeholder: 'default bridge' }), pull: h('input', { type: 'checkbox', checked: true }), start: h('input', { type: 'checkbox', checked: true }) };
  const rows = (cols) => { const box = h('div', { class: 'form' }); const data = []; const addRow = () => { const r = cols.map(([k, ph, w]) => h('input', { type: 'text', placeholder: ph, style: { width: w } })); data.push(r); box.insertBefore(h('div', { class: 'row' }, ...r), btn); }; const btn = h('button', { class: 'btn sm', type: 'button', onclick: addRow }, '+ Add'); box.append(btn); return { box, get: () => data.map((r) => Object.fromEntries(r.map((i, n) => [cols[n][0], i.value.trim()]))).filter((o) => Object.values(o).some(Boolean)) }; };
  const ports = rows([['host', 'host port', '100px'], ['container', 'container port', '120px'], ['ip', 'bind IP (e.g. 127.0.0.1)', '170px']]);
  const vols = rows([['source', 'host path or volume', '200px'], ['target', '/container/path', '180px']]);
  const env = rows([['key', 'KEY', '160px'], ['value', 'value', '220px']]);
  const err = h('div');
  modal({ title: 'Create container', wide: true, body: h('div', { class: 'form' }, h('div', { class: 'row grow' }, h('label', null, 'Image', f.image), h('label', null, 'Name', f.name)), h('div', { class: 'row grow' }, h('label', null, 'Restart policy', f.restart), h('label', null, 'Network', f.network), h('label', null, 'Command', f.cmd)), h('label', null, 'Port mappings', ports.box), h('label', null, 'Volumes (bind mounts or named volumes)', vols.box), h('label', null, 'Environment', env.box), h('label', { class: 'row' }, f.pull, 'Pull image if missing'), h('label', { class: 'row' }, f.start, 'Start after creating'), err),
    actions: (close) => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: async (e) => {
      err.replaceChildren(); e.target.disabled = true;
      try { await post('/docker/containers', { image: f.image.value.trim(), name: f.name.value.trim() || undefined, cmd: f.cmd.value.trim() || undefined, restart: f.restart.value, network: f.network.value.trim() || undefined, pull: f.pull.checked, start: f.start.checked, ports: ports.get().map((p) => ({ host: p.host, container: p.container, ip: p.ip })), volumes: vols.get(), env: env.get() }); toast('Container created', 'ok'); close(); done(); }
      catch (x) { err.replaceChildren(h('div', { class: 'err' }, x.message)); e.target.disabled = false; } } }, 'Create')] });
}
void del; void api;
