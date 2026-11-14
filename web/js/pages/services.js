import { h, get, post, stateBadge, badge, toast, errToast, busy, confirmDialog, modal, loading, empty, errBox, debounce, openSocket } from '../lib.js';

export async function render(main) {
  let list = [], q = '', stateF = 'all';
  const box = h('div', { class: 'tbl' });
  const search = h('input', { type: 'search', placeholder: 'Search services…', oninput: debounce((e) => { q = e.target.value.toLowerCase(); draw(); }, 120) });
  const sf = h('select', { onchange: (e) => { stateF = e.target.value; draw(); } }, ...['all', 'active', 'inactive', 'failed', 'enabled', 'disabled'].map((v) => h('option', { value: v }, v)));
  main.append(h('div', { class: 'page-head' }, h('h1', null, 'System Services'), h('span', { class: 'spacer' }), h('button', { class: 'btn', onclick: load }, 'Refresh')), h('div', { class: 'toolbar' }, search, sf), h('div', { class: 'card' }, box));
  const act = async (u, action, extra = {}) => {
    const needsConfirm = ['stop', 'disable', 'restart'].includes(action);
    if (needsConfirm && !(await confirmDialog({ title: `${action} ${u.name}`, danger: action !== 'restart', confirmText: action, message: u.critical ? `${u.name} is a critical system service. ${action === 'restart' ? 'Restarting it may interrupt SSH, networking or Docker (and this dashboard).' : 'This action is blocked for critical services.'}` : `${action} ${u.name}?` }))) return;
    try { const r = await post(`/services/${encodeURIComponent(u.name)}/${action}`, { confirmCritical: u.critical && action === 'restart', ...extra }); toast(r.ok ? `${action} OK — now ${r.active}` : `${action} failed: ${r.output}`, r.ok ? 'ok' : 'error'); load(); } catch (e) { errToast(e); }
  };
  function draw() {
    const f = list.filter((u) => (!q || `${u.name} ${u.description}`.toLowerCase().includes(q)) && (stateF === 'all' || (stateF === 'enabled' ? u.enabled === 'enabled' : stateF === 'disabled' ? u.enabled === 'disabled' : u.active === stateF)));
    box.replaceChildren(f.length ? h('table', null, h('thead', null, h('tr', null, ...['Service', 'Description', 'Active', 'Sub', 'Enabled', 'Load', ''].map((x) => h('th', null, x)))),
      h('tbody', null, ...f.slice(0, 500).map((u) => h('tr', null, h('td', null, h('a', { href: '#', onclick: (e) => { e.preventDefault(); details(u); } }, u.name), u.critical ? [' ', badge('critical', 'warn')] : ''), h('td', { class: 'small trunc', style: { maxWidth: '280px' }, title: u.description }, u.description), h('td', null, stateBadge(u.active)), h('td', { class: 'small' }, u.sub), h('td', { class: 'small' }, u.enabled || '—'), h('td', { class: 'small' }, u.load),
        h('td', { class: 'nowrap' }, ...(u.active === 'active' ? [h('button', { class: 'btn sm', onclick: () => act(u, 'restart') }, 'Restart'), ' ', h('button', { class: 'btn sm', onclick: () => act(u, 'reload') }, 'Reload'), ' ', h('button', { class: 'btn sm danger', disabled: u.critical, onclick: () => act(u, 'stop') }, 'Stop')] : [h('button', { class: 'btn sm primary', onclick: () => act(u, 'start') }, 'Start')]), ' ', u.enabled === 'enabled' ? h('button', { class: 'btn sm', disabled: u.critical, onclick: () => act(u, 'disable') }, 'Disable') : u.enabled === 'disabled' ? h('button', { class: 'btn sm', onclick: () => act(u, 'enable') }, 'Enable') : null))))) : empty('No services match.'));
  }
  async function load() { try { list = await get('/services'); draw(); } catch (e) { box.replaceChildren(errBox(e)); } }
  box.append(loading()); await load();
}

async function details(u) {
  const body = h('div', null, loading());
  modal({ title: u.name, wide: true, body });
  try {
    const [d, l] = await Promise.all([get(`/services/${encodeURIComponent(u.name)}`), get(`/services/${encodeURIComponent(u.name)}/logs?lines=200`)]);
    const p = d.properties;
    body.replaceChildren(h('dl', { class: 'kv' }, ...[['Description', p.Description], ['Load / Active / Sub', `${p.LoadState} / ${p.ActiveState} / ${p.SubState}`], ['Unit file', `${p.FragmentPath || '—'} (${p.UnitFileState || '—'})`], ['Main PID', p.MainPID], ['Started', p.ActiveEnterTimestamp || '—'], ['Memory', p.MemoryCurrent && p.MemoryCurrent !== '[not set]' ? `${(Number(p.MemoryCurrent) / 1048576).toFixed(1)} MB` : '—'], ['Restart', `${p.Restart} · ${p.NRestarts || 0} restarts`], ['Result', p.Result], ['ExecStart', h('code', null, p.ExecStart)]].flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      h('h3', { style: { margin: '14px 0 6px' } }, 'Status'), h('pre', { class: 'pre', style: { maxHeight: '160px' } }, d.status_text), h('h3', { style: { margin: '14px 0 6px' } }, 'Recent journal'), h('pre', { class: 'pre' }, l.lines.join('\n') || 'No entries'));
  } catch (e) { body.replaceChildren(errBox(e)); }
}
void busy; void openSocket;
