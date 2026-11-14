import { h, $, icon, clear, get, post, put, setCsrf, setUnauthHandler, subscribe, stopEvents, loading, errBox, toast, errToast, dropdown, ago, modal, busy, badge } from './lib.js';
import { initWM, closeAllWindows } from './wm.js';
import { notifCard } from './notifs.js';
import './mobile.js';

const PAGES = [
  ['home', 'Home', 'home'], ['containers', 'Containers', 'box'], ['images', 'Images', 'layers'], ['volumes', 'Volumes', 'db'], ['networks', 'Networks', 'net'],
  ['stacks', 'Compose / Stacks', 'stack'], ['monitoring', 'Monitoring', 'chart'], ['logs', 'System Logs', 'log'], ['terminal', 'Terminal', 'term'],
  ['files', 'File Manager', 'folder'], ['services', 'System Services', 'server'], ['nginx', 'Nginx', 'globe'], ['settings', 'Settings', 'cog'],
];
const loaders = {
  home: () => import('./pages/home.js'), containers: () => import('./pages/containers.js'), images: () => import('./pages/resources.js'), volumes: () => import('./pages/resources.js'), networks: () => import('./pages/resources.js'),
  stacks: () => import('./pages/stacks.js'), monitoring: () => import('./pages/monitoring.js'), logs: () => import('./pages/logs.js'), terminal: () => import('./pages/terminal.js'),
  files: () => import('./pages/files.js'), services: () => import('./pages/services.js'), nginx: () => import('./pages/nginx.js'), settings: () => import('./pages/settings.js'),
};

const root = $('#app');
export const state = { user: null, caps: null, refreshMs: 2000, theme: localStorage.getItem('serveros.theme') || 'dark' };

setUnauthHandler(() => { if (state.user) { state.user = null; stopEvents(); closeAllWindows(); toast('Your session expired. Please sign in again.', 'error'); boot(); } });

async function boot() {
  clear(root);
  root.append(loading('Starting…'));
  try {
    const st = await get('/auth/status');
    if (st.authenticated) { setCsrf(st.csrf); state.user = st.user; return shell(); }
    return authScreen(st.setupRequired);
  } catch (e) { clear(root); root.append(h('div', { class: 'login' }, h('div', { class: 'card' }, errBox(e), h('button', { class: 'btn', style: { marginTop: '12px' }, onclick: boot }, 'Retry')))); }
}

function authScreen(setup) {
  const user = h('input', { type: 'text', autocomplete: 'username', placeholder: 'Username', required: true });
  const pass = h('input', { type: 'password', autocomplete: setup ? 'new-password' : 'current-password', placeholder: 'Password', required: true });
  const token = h('input', { type: 'text', autocomplete: 'off', placeholder: 'Setup token (from the container log)' });
  const confirm = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Repeat password' });
  const msg = h('div');
  const btn = h('button', { class: 'btn primary', type: 'submit', style: { justifyContent: 'center' } }, setup ? 'Create administrator' : 'Sign in');
  const form = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault(); msg.replaceChildren();
    if (setup && pass.value !== confirm.value) return msg.replaceChildren(h('div', { class: 'err' }, 'Passwords do not match'));
    btn.disabled = true;
    try {
      const r = await post(setup ? '/auth/setup' : '/auth/login', setup ? { username: user.value, password: pass.value, setupToken: token.value } : { username: user.value, password: pass.value });
      setCsrf(r.csrf); state.user = r.user; shell();
    } catch (err) { msg.replaceChildren(h('div', { class: 'err' }, err.message)); btn.disabled = false; }
  } }, user, pass, setup ? confirm : null, setup ? token : null, msg, btn);
  clear(root);
  root.append(h('div', { class: 'login' }, h('div', { class: 'card' },
    h('div', { class: 'brand', style: { padding: 0, marginBottom: '8px' } }, h('div', { class: 'logo' }, icon('server', 18)), 'ServerOS'),
    h('p', { class: 'muted' }, setup ? 'First-run setup: create the administrator account. The setup token is printed in the container log (docker logs serveros). Use a password of at least 12 characters.' : 'Sign in to manage this server.'), form)));
  user.focus();
}

let cleanupPage = null, current = null;
async function shell() {
  clear(root);
  initWM();
  get('/system').then((s) => { state.caps = s.capabilities; state.system = s; updateStatus(); }).catch(() => {});
  get('/settings').then((r) => { state.refreshMs = (r.settings['monitoring.refreshSeconds'] || 2) * 1000; }).catch(() => {});
  get('/auth/prefs/theme').then((r) => { if (r.value && r.value !== state.theme) setTheme(r.value, false); }).catch(() => {});
  const nav = h('nav', { class: 'nav' }, PAGES.map(([id, label, ic]) => h('a', { 'data-page': id, href: '#/' + id, onclick: () => { sidebar.classList.remove('open'); if (location.hash === '#/' + id || (id === 'home' && !location.hash)) route(); } }, icon(ic), label)));
  const sidebar = h('aside', { class: 'sidebar' }, h('div', { class: 'brand' }, h('div', { class: 'logo' }, icon('server', 18)), 'ServerOS'), nav);
  const dockerChip = h('span', { class: 'chip' }, h('span', { class: 'dot' }), h('span', { class: 'lbl' }, 'Docker'));
  const agentChip = h('span', { class: 'chip' }, h('span', { class: 'dot' }), h('span', { class: 'lbl' }, 'Host agent'));
  const hostChip = h('span', { class: 'chip hostchip' }, '…');
  const bellN = h('span', { class: 'n', style: { display: 'none' } });
  const bellBtn = h('button', { class: 'btn icon bell', 'aria-label': 'Notifications' }, icon('bell'), bellN);
  const notifList = h('div', { class: 'notif-list' }); const notifHead = h('b', null, 'Notifications');
  const bell = dropdown(bellBtn, (hide) => { loadNotifs(); return h('div', { class: 'notif-pop' },
    h('div', { class: 'row', style: { padding: '4px 4px 8px' } }, notifHead, h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', onclick: async () => { await post('/notifications/read', { ids: 'all' }); loadNotifs(); } }, icon('check', 14), 'Mark all read'),
      h('a', { class: 'btn sm', href: '#/settings/notifications', onclick: hide }, 'View all')), notifList); });
  async function loadNotifs() {
    try {
      const r = await get('/notifications?limit=15');
      bellN.textContent = r.unread > 99 ? '99+' : r.unread; bellN.style.display = r.unread ? '' : 'none';
      bellN.style.background = r.unreadCritical ? 'var(--bad)' : 'var(--accent)';
      notifHead.textContent = r.unread ? `Notifications · ${r.unread} unread` : 'Notifications';
      notifList.replaceChildren(...(r.rows.length ? r.rows.map((n) => notifCard(n, { compact: true, changed: loadNotifs })) : [h('div', { class: 'empty' }, 'You are all caught up.')]));
    } catch { /* ignore */ }
  }
  loadNotifs();
  subscribe('notification', (n) => { loadNotifs(); toast(`${n.title}${n.body ? ' — ' + n.body.slice(0, 90) : ''}`, n.severity === 'critical' ? 'error' : 'info', 9000); }, 'notifications');
  const themeBtn = h('button', { class: 'btn icon', 'aria-label': 'Toggle theme', onclick: () => setTheme(state.theme === 'dark' ? 'light' : 'dark', true) });
  const refreshTheme = () => themeBtn.replaceChildren(icon(state.theme === 'dark' ? 'sun' : 'moon'));
  window.__refreshTheme = refreshTheme; refreshTheme();
  const userMenu = dropdown(h('button', { class: 'btn' }, icon('user'), h('span', { class: 'lbl' }, state.user.username)), (hide) => [
    h('a', { href: '#/settings/security', onclick: hide }, 'Account & security'),
    h('button', { onclick: async () => { hide(); await post('/auth/logout'); state.user = null; stopEvents(); closeAllWindows(); boot(); } }, 'Sign out')]);
  const header = h('header', { class: 'header' }, h('button', { class: 'btn icon menu-btn', onclick: () => sidebar.classList.toggle('open') }, icon('menu')), hostChip, dockerChip, agentChip, h('span', { class: 'grow' }), bell, themeBtn, userMenu);
  const main = h('main', { class: 'main', id: 'main' });
  const backdrop = h('div', { class: 'backdrop', onclick: () => sidebar.classList.remove('open') });
  root.append(h('div', { class: 'shell' }, sidebar, backdrop, header, main));

  function updateStatus() {
    const c = state.caps; if (!c) return;
    dockerChip.firstChild.className = 'dot ' + (c.docker ? 'ok' : 'bad'); dockerChip.title = c.docker ? 'Docker Engine reachable' : 'Docker Engine unreachable';
    agentChip.firstChild.className = 'dot ' + (c.agent ? 'ok' : 'warn'); agentChip.title = c.agent ? `Host agent v${c.agentVersion}` : (c.agentError || 'Host agent offline');
    hostChip.textContent = c.host ? `${c.host.hostname} · ${c.host.os}` : 'Host details need the agent';
  }
  setInterval(() => get('/system').then((s) => { state.caps = s.capabilities; updateStatus(); }).catch(() => {}), 30000);

  async function route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/');
    const id = PAGES.find((p) => p[0] === parts[0]) ? parts[0] : 'home';
    nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.page === id));
    cleanupPage?.(); cleanupPage = null;
    clear(main); main.append(loading());
    current = id;
    try {
      const mod = await loaders[id]();
      if (current !== id) return;
      clear(main);
      const r = await mod[id === 'images' || id === 'volumes' || id === 'networks' ? id : 'render'](main, { sub: parts[1], state });
      if (current === id) cleanupPage = typeof r === 'function' ? r : null; else if (typeof r === 'function') r();
    } catch (e) { clear(main); main.append(errBox(e)); console.error(e); }
  }
  addEventListener('hashchange', route);
  route();
}

export function setTheme(t, persist) {
  state.theme = t; document.documentElement.dataset.theme = t; localStorage.setItem('serveros.theme', t); window.__refreshTheme?.();
  if (persist) put('/auth/prefs/theme', { value: t }).catch(() => {});
}
void modal; void busy; void badge; void errToast;
boot();
