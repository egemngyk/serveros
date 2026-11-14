import { h, get, post, put, del, api, bytes, when, ago, badge, stateBadge, toast, errToast, busy, confirmDialog, modal, loading, empty, errBox, tabs, debounce } from '../lib.js';
import { state } from '../main.js';
import { subscribe, icon } from '../lib.js';
import { notifCard } from '../notifs.js';

export async function render(main, { sub }) {
  const t = tabs([['general', 'General'], ['security', 'Security'], ['alerts', 'Alert rules'], ['providers', 'Notification channels'], ['notifications', 'Notification history'], ['audit', 'Audit log'], ['backups', 'Backups'], ['about', 'About']], sub || 'general', (id, pane) => {
    pane.classList.add('pane'); pane.style.overflow = 'auto';
    return ({ general, security, alerts, providers, notifications, audit, backups, about })[id](pane);
  }, { onSelect: (id) => history.replaceState(null, '', '#/settings/' + id) });
  main.style.display = 'flex'; main.style.flexDirection = 'column';
  main.append(h('div', { class: 'page-head' }, h('h1', null, 'Settings')), t.el);
  return () => { t.destroy(); main.style.display = ''; main.style.flexDirection = ''; };
}
const card = (title, ...c) => h('div', { class: 'card', style: { marginBottom: '14px' } }, h('h3', null, title), ...c);
const saveSetting = (key, value) => put('/settings/' + key, { value });

async function general(pane) {
  pane.replaceChildren(loading());
  try {
    const { settings: s, fileRoots } = await get('/settings');
    const domains = h('input', { type: 'text', value: (s['dashboard.domains'] || []).join(', '), placeholder: 'dashboard.example.com' });
    const email = h('input', { type: 'text', value: s['certbot.email'] || '', placeholder: 'admin@example.com' });
    const term = h('input', { type: 'checkbox', checked: s['terminal.hostEnabled'] });
    const rootsAll = h('input', { type: 'checkbox', checked: !Array.isArray(s['files.roots']) });
    const boxes = fileRoots.map((r) => ({ r, el: h('input', { type: 'checkbox', checked: !Array.isArray(s['files.roots']) || s['files.roots'].includes(r) }) }));
    const rate = h('select', { style: { width: 'auto' } }, ...[1, 2, 5, 10, 30, 60].map((v) => h('option', { value: v, selected: v === (s['monitoring.refreshSeconds'] || 2) }, v === 1 ? 'every 1 second' : `every ${v} seconds`)));
    pane.replaceChildren(
      card('Live data refresh rate', h('div', { class: 'form' }, h('label', null, 'How often live data (CPU, memory, disk, network, container cards and stats) is updated', rate), h('div', { class: 'small muted' }, 'Applies immediately to all open pages. Faster = more host CPU use; history is always stored every 10 s regardless of this setting.'), h('div', null, h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => { await saveSetting('monitoring.refreshSeconds', Number(rate.value)); state.refreshMs = Number(rate.value) * 1000; }, 'Saved — applied immediately') }, 'Save')))),
      card('Dashboard', h('div', { class: 'form' }, h('label', null, 'Dashboard domain(s) — used to warn before an Nginx change could cut off dashboard access', domains), h('div', null, h('button', { class: 'btn primary', onclick: (e) => busy(e.target, () => saveSetting('dashboard.domains', domains.value.split(/[,\s]+/).filter(Boolean)), 'Saved') }, 'Save')))),
      card('Certbot', h('div', { class: 'form' }, h('label', null, 'Default e-mail for certificate notices', email), h('div', null, h('button', { class: 'btn primary', onclick: (e) => busy(e.target, () => saveSetting('certbot.email', email.value.trim()), 'Saved') }, 'Save')))),
      card('Host terminal', h('label', { class: 'row' }, term, 'Allow host terminal sessions'), h('div', { class: 'small muted', style: { margin: '6px 0' } }, 'The host terminal is equivalent to shell access to the server. Disable it if you do not need it.'), h('button', { class: 'btn primary', onclick: (e) => busy(e.target, () => saveSetting('terminal.hostEnabled', term.checked), 'Saved') }, 'Save')),
      card('File manager — permitted paths', h('div', { class: 'small muted', style: { marginBottom: '8px' } }, 'The host agent defines the maximum set of directories (agent.json "file_roots"). Here you can restrict the file manager to a subset. Sensitive files (private keys, shadow, …) are always blocked.'),
        fileRoots.length ? h('div', { class: 'form' }, h('label', { class: 'row' }, rootsAll, 'Allow all roots permitted by the agent'), ...boxes.map(({ r, el }) => h('label', { class: 'row' }, el, h('code', null, r))), h('div', null, h('button', { class: 'btn primary', onclick: (e) => busy(e.target, () => saveSetting('files.roots', rootsAll.checked ? null : boxes.filter((b) => b.el.checked).map((b) => b.r)), 'Saved') }, 'Save'))) : h('div', { class: 'warnbox' }, 'The host agent is offline, so no roots are available.')));
  } catch (e) { pane.replaceChildren(errBox(e)); }
}

async function security(pane) {
  const cur = h('input', { type: 'password', autocomplete: 'current-password' }); const n1 = h('input', { type: 'password', autocomplete: 'new-password' }); const n2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const sess = h('div'); const loadS = async () => { try { const l = await get('/auth/sessions'); sess.replaceChildren(h('table', null, h('thead', null, h('tr', null, ...['Started', 'Last active', 'IP', 'Browser', ''].map((x) => h('th', null, x)))), h('tbody', null, ...l.map((s) => h('tr', null, h('td', null, when(s.created_at)), h('td', null, ago(s.last_seen)), h('td', null, s.ip), h('td', { class: 'small trunc', style: { maxWidth: '240px' }, title: s.user_agent }, s.user_agent), h('td', null, s.current ? badge('this session', 'ok') : '')))))); } catch (e) { sess.replaceChildren(errBox(e)); } };
  pane.replaceChildren(card('Change password', h('div', { class: 'form', style: { maxWidth: '420px' } }, h('label', null, 'Current password', cur), h('label', null, 'New password (min. 12 characters)', n1), h('label', null, 'Repeat new password', n2), h('div', null, h('button', { class: 'btn primary', onclick: (e) => { if (n1.value !== n2.value) return toast('Passwords do not match', 'error'); busy(e.target, async () => { const r = await post('/auth/password', { current: cur.value, next: n1.value }); cur.value = n1.value = n2.value = ''; toast(`Password changed. ${r.otherSessionsInvalidated} other session(s) signed out.`, 'ok'); loadS(); }); } }, 'Change password')))),
    card('Sessions', sess, h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn danger', onclick: async (e) => { const r = await busy(e.target, () => post('/auth/sessions/revoke-others')); if (r) { toast(`${r.revoked} session(s) signed out`, 'ok'); loadS(); } } }, 'Sign out all other sessions'))),
    card('Security notes', h('ul', { class: 'small muted' }, h('li', null, 'Access to the Docker socket is root-equivalent on the host. Anyone who can sign in here can effectively administer the server.'), h('li', null, 'Serve the dashboard only over HTTPS. Session cookies are HttpOnly, SameSite=Strict and Secure when HTTPS is detected.'), h('li', null, 'Failed sign-ins are rate limited per user and per IP.'))));
  loadS();
}

async function alerts(pane) {
  pane.replaceChildren(loading());
  try {
    const rules = await get('/alerts/rules');
    pane.replaceChildren(h('div', { class: 'info', style: { marginBottom: '12px' } }, 'Rules create in-app notifications and are sent to enabled notification channels. “Sustained for” avoids alerts on short spikes; “Cooldown” limits repeats.'),
      h('div', { class: 'card tbl' }, h('table', null, h('thead', null, h('tr', null, ...['Enabled', 'Rule', 'Threshold', 'Sustained for (s)', 'Cooldown (s)', ''].map((x) => h('th', null, x)))), h('tbody', null, ...rules.map((r) => {
        const en = h('input', { type: 'checkbox', checked: r.enabled }); const th = h('input', { type: 'number', value: r.threshold, style: { width: '90px' }, disabled: r.metric === 'container' || r.metric === 'docker' || r.metric === 'nginx' || r.metric === 'service' || r.key === 'cert_renew_fail' || r.key === 'iface_down' }); const du = h('input', { type: 'number', value: r.duration_s, style: { width: '90px' } }); const co = h('input', { type: 'number', value: r.cooldown_s, style: { width: '100px' } });
        return h('tr', null, h('td', null, en), h('td', null, r.name, h('div', { class: 'small muted' }, r.kind === 'metric' ? 'metric' : 'event')), h('td', null, th), h('td', null, du), h('td', null, co), h('td', null, h('button', { class: 'btn sm primary', onclick: (e) => busy(e.target, () => put('/alerts/rules/' + r.key, { enabled: en.checked, threshold: Number(th.value), duration_s: Number(du.value), cooldown_s: Number(co.value) }), 'Rule saved') }, 'Save')));
      })))));
  } catch (e) { pane.replaceChildren(errBox(e)); }
}

async function providers(pane) {
  const load = async () => {
    pane.replaceChildren(loading());
    try {
      const { providers: list, types } = await get('/alerts/providers');
      pane.replaceChildren(h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: () => edit(null, types, load) }, '+ Add channel'), h('span', { class: 'muted small' }, 'Available: ' + Object.values(types).map((t) => t.label).join(' · ') + '. Credentials are stored in the application database and never sent back to the browser.')),
        list.length ? h('div', { class: 'card tbl' }, h('table', null, h('thead', null, h('tr', null, ...['Name', 'Type', 'Min. severity', 'Enabled', ''].map((x) => h('th', null, x)))), h('tbody', null, ...list.map((p) => h('tr', null, h('td', null, p.name), h('td', null, types[p.type]?.label), h('td', null, p.minSeverity), h('td', null, p.enabled ? '✔' : '—'), h('td', { class: 'nowrap' }, h('button', { class: 'btn sm', onclick: async (e) => { const r = await busy(e.target, () => post(`/alerts/providers/${p.id}/test`)); if (r) toast(r.results.every((x) => x.ok) ? 'Test notification sent' : 'Test failed: ' + (r.results[0]?.error || 'unknown'), r.results.every((x) => x.ok) ? 'ok' : 'error'); } }, 'Send test'), ' ', h('button', { class: 'btn sm', onclick: () => edit(p, types, load) }, 'Edit'), ' ', h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog({ title: 'Delete channel', message: `Delete ${p.name}?`, danger: true })) { await del('/alerts/providers/' + p.id); load(); } } }, 'Delete'))))))) : empty('No notification channels. In-app notifications always work.'));
    } catch (e) { pane.replaceChildren(errBox(e)); }
  };
  load();
}
function edit(p, types, done) {
  const type = h('select', { disabled: !!p }, ...Object.entries(types).map(([k, t]) => h('option', { value: k, selected: p?.type === k }, t.label))); const name = h('input', { type: 'text', value: p?.name || '' }); const min = h('select', null, ...['info', 'warning', 'critical'].map((s) => h('option', { value: s, selected: (p?.minSeverity || 'warning') === s }, s))); const en = h('input', { type: 'checkbox', checked: p ? p.enabled : true });
  const fields = h('div', { class: 'form' }); let inputs = {};
  const drawF = () => { inputs = {}; fields.replaceChildren(...types[type.value].fields.map((f) => { inputs[f.name] = h('input', { type: f.secret ? 'password' : 'text', value: p?.type === type.value ? p.config[f.name] || '' : '', autocomplete: 'off' }); return h('label', null, f.label, inputs[f.name]); })); }; type.addEventListener('change', drawF); drawF();
  modal({ title: p ? 'Edit channel' : 'Add channel', body: h('div', { class: 'form' }, h('label', null, 'Type', type), h('label', null, 'Name', name), fields, h('label', null, 'Minimum severity', min), h('label', { class: 'row' }, en, 'Enabled')), actions: (close) => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: async () => { try { await post('/alerts/providers', { id: p?.id, type: type.value, name: name.value.trim(), minSeverity: min.value, enabled: en.checked, config: Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])) }); close(); done(); } catch (e) { errToast(e); } } }, 'Save')] });
}

function notifications(pane) {
  const f = { unread: false, severity: '', category: '', q: '' }; let offset = 0; const PAGE = 30; let selected = new Set(); let rows = [];
  const head = h('div', { class: 'toolbar' }); const list = h('div'); const pager = h('div', { class: 'row', style: { marginTop: '10px' } });
  const seg = (label, on, fn) => h('button', { class: 'btn sm' + (on ? ' primary' : ''), onclick: fn }, label);
  const q = h('input', { type: 'search', placeholder: 'Search notifications…', oninput: debounce((e) => { f.q = e.target.value; offset = 0; load(); }, 250) });
  const load = async () => {
    try {
      const p = new URLSearchParams({ limit: PAGE, offset }); if (f.unread) p.set('unread', '1'); if (f.severity) p.set('severity', f.severity); if (f.category) p.set('category', f.category); if (f.q) p.set('q', f.q);
      const r = await get('/notifications?' + p); rows = r.rows; selected = new Set([...selected].filter((id) => rows.some((n) => n.id === id)));
      const cat = h('select', { style: { width: 'auto' }, onchange: (e) => { f.category = e.target.value; offset = 0; load(); } }, h('option', { value: '' }, 'all categories'), ...r.categories.map((c) => h('option', { value: c, selected: f.category === c }, c)));
      const sev = h('select', { style: { width: 'auto' }, onchange: (e) => { f.severity = e.target.value; offset = 0; load(); } }, ...[['', 'any severity'], ['critical', 'critical'], ['warning', 'warning'], ['info', 'info']].map(([v, l]) => h('option', { value: v, selected: f.severity === v }, l)));
      head.replaceChildren(
        h('div', { class: 'row', style: { width: '100%' } }, h('span', { class: 'chip' }, h('span', { class: 'dot ' + (r.unread ? 'warn' : 'ok') }), `${r.unread} unread`), r.unreadCritical ? h('span', { class: 'chip' }, h('span', { class: 'dot bad' }), `${r.unreadCritical} critical`) : null, h('span', { class: 'muted small' }, `${r.total} shown`), h('span', { class: 'spacer' }),
          h('button', { class: 'btn sm', onclick: async () => { await post('/notifications/read', { ids: 'all' }); toast('All marked as read', 'ok'); load(); } }, icon('check', 14), 'Mark all read'),
          h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog({ title: 'Delete read notifications', message: 'All notifications that are marked as read are permanently deleted.', danger: true, confirmText: 'Delete' })) { const x = await api('/notifications/read', { method: 'DELETE' }); toast(`${x.deleted} deleted`, 'ok'); load(); } } }, icon('trash', 14), 'Delete read')),
        h('div', { class: 'row', style: { width: '100%' } }, seg('All', !f.unread, () => { f.unread = false; offset = 0; load(); }), seg('Unread', f.unread, () => { f.unread = true; offset = 0; load(); }), sev, cat, q));
      const bulk = selected.size ? h('div', { class: 'row', style: { margin: '6px 0 10px' } }, h('b', null, `${selected.size} selected`),
        h('button', { class: 'btn sm', onclick: async () => { await post('/notifications/read', { ids: [...selected] }); selected.clear(); load(); } }, 'Mark read'),
        h('button', { class: 'btn sm', onclick: async () => { await post('/notifications/read', { ids: [...selected], read: false }); selected.clear(); load(); } }, 'Mark unread'),
        h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog({ title: 'Delete notifications', message: `Delete ${selected.size} notification(s)?`, danger: true, confirmText: 'Delete' })) { for (const id of selected) await del('/notifications/' + id); selected.clear(); load(); } } }, 'Delete')) : null;
      list.replaceChildren(...(bulk ? [bulk] : []), ...(rows.length ? rows.map((n) => notifCard(n, { changed: () => load(), selectable: true, selected: selected.has(n.id), onSelect: (on) => { on ? selected.add(n.id) : selected.delete(n.id); load(); } })) : [empty(f.unread || f.severity || f.category || f.q ? 'No notifications match these filters.' : 'No notifications yet. Alerts from your alert rules appear here.')]));
      pager.replaceChildren(offset ? h('button', { class: 'btn sm', onclick: () => { offset -= PAGE; load(); } }, '← Newer') : null, offset + PAGE < r.total ? h('button', { class: 'btn sm', onclick: () => { offset += PAGE; load(); } }, 'Older →') : null);
    } catch (e) { list.replaceChildren(errBox(e)); }
  };
  pane.replaceChildren(head, list, pager); list.append(loading()); load();
  return subscribe('notification', () => { if (offset === 0) load(); }, 'notifications');
}

async function audit(pane) {
  let offset = 0; const f = { q: h('input', { type: 'search', placeholder: 'Search target / action / metadata…' }), action: h('input', { type: 'text', placeholder: 'action prefix e.g. container.', style: { width: '190px' } }), result: h('select', null, ...['', 'ok', 'error', 'failed', 'denied'].map((v) => h('option', { value: v }, v || 'any result'))) };
  const box = h('div', { class: 'tbl card' });
  const load = async () => {
    box.replaceChildren(loading());
    try {
      const p = new URLSearchParams({ limit: 100, offset, q: f.q.value, action: f.action.value, result: f.result.value }); for (const [k, v] of [...p]) if (!v) p.delete(k);
      const r = await get('/audit?' + p);
      box.replaceChildren(r.rows.length ? h('table', null, h('thead', null, h('tr', null, ...['Time', 'User', 'Action', 'Target', 'Result', 'IP', 'Details'].map((x) => h('th', null, x)))), h('tbody', null, ...r.rows.map((a) => h('tr', null, h('td', { class: 'nowrap small' }, when(a.ts)), h('td', null, a.user || '—'), h('td', { class: 'mono small' }, a.action), h('td', { class: 'small trunc', style: { maxWidth: '260px' }, title: a.target }, a.target), h('td', null, stateBadge(a.result === 'ok' ? 'running' : a.result === 'partial' ? 'partial' : 'failed'), ' ', a.result), h('td', { class: 'small' }, a.ip || ''), h('td', { class: 'mono small trunc', style: { maxWidth: '260px' }, title: a.meta ? JSON.stringify(a.meta) : '' }, a.meta ? JSON.stringify(a.meta) : ''))))) : empty('No audit records match.'),
        h('div', { class: 'row', style: { marginTop: '10px' } }, offset ? h('button', { class: 'btn sm', onclick: () => { offset -= 100; load(); } }, '← Newer') : null, offset + 100 < r.total ? h('button', { class: 'btn sm', onclick: () => { offset += 100; load(); } }, 'Older →') : null, h('span', { class: 'muted small' }, `${r.total} records · append-only`)));
    } catch (e) { box.replaceChildren(errBox(e)); }
  };
  [f.q, f.action].forEach((i) => i.addEventListener('input', debounce(() => { offset = 0; load(); }, 300))); f.result.addEventListener('change', () => { offset = 0; load(); });
  pane.append(h('div', { class: 'toolbar' }, f.q, f.action, f.result, h('button', { class: 'btn', onclick: load }, 'Refresh')), box); load();
}

async function backups(pane) {
  const box = h('div'); pane.append(box);
  const load = async () => {
    box.replaceChildren(loading());
    try {
      const [{ backups: list, strategy }, { settings }] = [await get('/backups'), await get('/settings')]; const sch = settings['backup.schedule'];
      const vols = await get('/docker/volumes').catch(() => []);
      box.replaceChildren(
        card('What is (and is not) backed up', h('ul', { class: 'small' }, ...strategy.included.map((x) => h('li', null, x))), h('div', { class: 'warnbox' }, ...strategy.notIncluded.map((x) => h('div', null, '• ' + x)))),
        h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: () => createBackup(load) }, 'Create backup'), h('button', { class: 'btn', onclick: () => schedule(sch, load) }, `Schedule: ${sch.enabled ? sch.frequency + ' ' + sch.time : 'off'}`), h('button', { class: 'btn', onclick: () => volumeBackup(vols, load) }, 'Backup Docker volumes…'), h('label', { class: 'btn' }, 'Import archive', h('input', { type: 'file', accept: '.gz,.tgz', style: { display: 'none' }, onchange: async (e) => { const file = e.target.files[0]; if (!file) return; try { await api(`/backups/import?name=${encodeURIComponent(file.name)}`, { method: 'PUT', raw: file }); toast('Archive imported', 'ok'); load(); } catch (x) { errToast(x); } } }))),
        list.length ? h('div', { class: 'card tbl' }, h('table', null, h('thead', null, h('tr', null, ...['Name', 'Created', 'Type', 'Size', 'Contents', ''].map((x) => h('th', null, x)))), h('tbody', null, ...list.map((b) => h('tr', null, h('td', { class: 'small' }, b.name, b.note ? h('div', { class: 'muted' }, b.note) : null), h('td', { class: 'small' }, when(b.created_at)), h('td', null, badge(b.kind, b.kind === 'volume' ? 'blue' : '')), h('td', null, bytes(b.size)), h('td', { class: 'small' }, b.contents.join(', ')), h('td', { class: 'nowrap' }, b.exists ? [h('a', { class: 'btn sm', href: `/api/backups/${b.id}/download` }, 'Download'), ' '] : badge('file missing', 'bad'), b.kind !== 'volume' && b.exists ? [h('button', { class: 'btn sm', onclick: () => restore(b, load) }, 'Restore…'), ' '] : null, h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog({ title: 'Delete backup', message: `Permanently delete ${b.name}?`, danger: true, confirmText: 'Delete' })) { try { await del(`/backups/${b.id}?confirm=true`); load(); } catch (e) { errToast(e); } } } }, 'Delete'))))))) : empty('No backups yet.'));
    } catch (e) { box.replaceChildren(errBox(e)); }
  };
  load();
}
function createBackup(done) {
  const c = { app: h('input', { type: 'checkbox', checked: true }), stacks: h('input', { type: 'checkbox', checked: true }), nginx: h('input', { type: 'checkbox', checked: true }), certbot: h('input', { type: 'checkbox', checked: true }) }; const keys = h('input', { type: 'checkbox' }); const note = h('input', { type: 'text', placeholder: 'optional note' }); const extra = h('textarea', { rows: 3, placeholder: 'Extra directories (one absolute path per line, inside the permitted file roots)' });
  modal({ title: 'Create backup', body: h('div', { class: 'form' }, h('label', { class: 'row' }, c.app, 'Application database, settings and dashboard layouts'), h('label', { class: 'row' }, c.stacks, 'Compose stacks'), h('label', { class: 'row' }, c.nginx, 'Nginx configuration (needs host agent)'), h('label', { class: 'row' }, c.certbot, 'Certbot configuration + public certificates (needs host agent)'), h('label', { class: 'row' }, keys, h('span', null, 'Also include certificate ', h('b', null, 'private keys'), ' (full /etc/letsencrypt)')), h('label', null, 'Extra directories', extra), h('label', null, 'Note', note), h('div', { class: 'info' }, 'The archive is stored in the data directory with owner-only permissions (0600). It contains password hashes and channel credentials — handle it like a secret.')),
    actions: (close) => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: async (e) => { if (keys.checked && !(await confirmDialog({ title: 'Include private keys?', danger: true, confirmText: 'Include keys', message: 'The archive will contain TLS private keys. Store and transfer it securely.' }))) return; e.target.disabled = true; try { const r = await post('/backups', { contents: { app: c.app.checked, stacks: c.stacks.checked, nginx: c.nginx.checked, certbot: c.certbot.checked, extra: extra.value.trim().length > 0 }, includeKeys: keys.checked, confirmKeys: keys.checked, note: note.value, extraPaths: extra.value.split('\n').map((s) => s.trim()).filter(Boolean) }); toast(`Backup created (${bytes(r.size)})${r.warnings.length ? ' — warnings: ' + r.warnings.join('; ') : ''}`, r.warnings.length ? 'info' : 'ok', 9000); close(); done(); } catch (x) { errToast(x); e.target.disabled = false; } } }, 'Create')] });
}
function schedule(s, done) {
  const en = h('input', { type: 'checkbox', checked: s.enabled }); const fr = h('select', null, ...['hourly', 'daily', 'weekly'].map((v) => h('option', { value: v, selected: v === s.frequency }, v))); const tm = h('input', { type: 'text', value: s.time, placeholder: 'HH:MM' }); const keep = h('input', { type: 'number', value: s.retention.keepLast }); const age = h('input', { type: 'number', value: s.retention.maxAgeDays });
  const c = Object.fromEntries(['app', 'stacks', 'nginx', 'certbot'].map((k) => [k, h('input', { type: 'checkbox', checked: s.contents[k] })]));
  modal({ title: 'Scheduled backups', body: h('div', { class: 'form' }, h('label', { class: 'row' }, en, 'Enable scheduled backups'), h('div', { class: 'row grow' }, h('label', null, 'Frequency', fr), h('label', null, 'Time (server time)', tm)), h('div', { class: 'row' }, ...Object.entries(c).map(([k, el]) => h('label', { class: 'row' }, el, k))), h('div', { class: 'row grow' }, h('label', null, 'Keep last N scheduled backups', keep), h('label', null, 'Delete scheduled backups older than (days)', age)), h('div', { class: 'small muted' }, 'Retention only ever removes backups created by the scheduler. Manual and pre-restore backups are never deleted automatically. Private keys are never included in scheduled backups.')),
    actions: (close) => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: async () => { try { await saveSetting('backup.schedule', { enabled: en.checked, frequency: fr.value, time: tm.value, contents: Object.fromEntries(Object.entries(c).map(([k, el]) => [k, el.checked])), retention: { keepLast: Number(keep.value), maxAgeDays: Number(age.value) } }); toast('Schedule saved', 'ok'); close(); done(); } catch (e) { errToast(e); } } }, 'Save')] });
}
function volumeBackup(vols, done) {
  const picked = new Set();
  modal({ title: 'Backup Docker volumes', wide: true, body: h('div', { class: 'form' }, h('div', { class: 'warnbox' }, 'Each volume is archived with a short-lived helper container (busybox) that mounts it read-only. The copy is taken from a LIVE volume: for databases, stop the writing container first, otherwise the copy may be inconsistent. Restore manually: ', h('code', null, 'docker run --rm -v VOLUME:/dst -v /opt/serveros/data/backups/volumes:/b busybox tar xzf /b/FILE.tar.gz -C /dst')), vols.length ? h('div', null, ...vols.map((v) => h('label', { class: 'row' }, h('input', { type: 'checkbox', onchange: (e) => { e.target.checked ? picked.add(v.name) : picked.delete(v.name); } }), h('code', null, v.name), v.containers.length ? badge('used by ' + v.containers.map((c) => c.name).join(', '), 'warn') : null))) : empty('No volumes.')),
    actions: (close) => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: async (e) => { if (!picked.size) return; e.target.disabled = true; try { const r = await post('/backups/volumes', { volumes: [...picked] }); toast(`${r.length} volume archive(s) created`, 'ok'); close(); done(); } catch (x) { errToast(x); e.target.disabled = false; } } }, 'Backup')] });
}
async function restore(b, done) {
  let plan; try { plan = await get(`/backups/${b.id}/inspect`); } catch (e) { return errToast(e); }
  const picks = Object.fromEntries(plan.plan.map((p) => [p.component, h('input', { type: 'checkbox', checked: true })])); const word = h('input', { type: 'text', placeholder: 'Type RESTORE' });
  modal({ title: 'Restore backup', wide: true, body: h('div', { class: 'form' }, h('div', { class: 'info' }, `Archive verified (${plan.fileCount} files, created ${plan.created}). A pre-restore backup of the affected components is created automatically first.`), plan.includesPrivateKeys ? h('div', { class: 'warnbox' }, 'This archive contains private keys.') : null, h('h3', null, 'What will be replaced'), ...plan.plan.map((p) => h('label', { class: 'row', style: { alignItems: 'flex-start' } }, picks[p.component], h('span', null, h('b', null, p.component), h('div', { class: 'small muted' }, p.replaces)))), h('label', null, 'Confirm', word)),
    actions: (close) => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn danger', onclick: async (e) => { e.target.disabled = true; try { const r = await post(`/backups/${b.id}/restore`, { confirm: word.value, components: Object.entries(picks).filter(([, el]) => el.checked).map(([k]) => k) }); toast(r.restarting ? 'Restore complete. ServerOS is restarting — sign in again in a few seconds.' : 'Restore complete', 'ok', 10000); r.results.filter((x) => !x.ok).forEach((x) => toast(`${x.component}: ${x.error || 'failed / rolled back'}`, 'error', 12000)); close(); if (r.restarting) setTimeout(() => location.reload(), 6000); else done(); } catch (x) { errToast(x); e.target.disabled = false; } } }, 'Restore')] });
}

async function about(pane) {
  pane.replaceChildren(loading());
  try {
    const s = await get('/system'); const c = s.capabilities;
    const row = (k, v) => [h('dt', null, k), h('dd', null, v)];
    pane.replaceChildren(card('ServerOS', h('dl', { class: 'kv' }, ...row('Version', s.version), ...row('Environments', s.environments.map((e) => `${e.name} (${e.type})`).join(', ')), ...row('Docker Engine', c.docker ? badge('reachable', 'ok') : badge('unreachable', 'bad')), ...row('Docker Compose', c.compose.available ? 'v' + c.compose.version : badge('unavailable', 'warn')), ...row('Host agent', c.agent ? badge('v' + c.agentVersion, 'ok') : [badge('offline', 'bad'), ' ', c.agentError]), ...row('Host', c.host ? `${c.host.hostname} — ${c.host.os} — kernel ${c.host.kernel}` : '—'), ...row('Nginx', c.nginx.installed ? `${c.nginx.version} (${c.nginx.binary}, unit ${c.nginx.unit || 'n/a'})` : 'not installed'), ...row('Certbot', c.certbot.installed ? c.certbot.binary : 'not installed'), ...row('systemd', c.systemd ? 'available' : 'not available'))),
      card('Features that need the host agent', h('div', { class: 'small muted' }, 'Host terminal, file manager, system services, Nginx, Certbot, host logs, disk list and process termination are executed by the agent (serveros-agent.service). Features that are unavailable are shown as such instead of being faked.')));
  } catch (e) { pane.replaceChildren(errBox(e)); }
}
void state;
