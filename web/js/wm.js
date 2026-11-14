import { h, icon, clear, put, get } from './lib.js';

/** Desktop-like window manager. Windows are draggable, resizable, minimizable, maximizable, z-ordered. */
const wins = new Map();
let z = 10, layer, bar, savedPos = {}, saveTimer;
const isMobile = () => matchMedia('(max-width: 900px)').matches;

export function initWM() {
  layer = h('div', { id: 'wm' }); bar = h('div', { class: 'taskbar' });
  document.body.append(layer, bar);
  get('/auth/prefs/windows').then((r) => { savedPos = r.value || {}; }).catch(() => {});
}
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => put('/auth/prefs/windows', { value: savedPos }).catch(() => {}), 1500);
}
function focusWin(w) {
  for (const x of wins.values()) x.el.classList.toggle('focus', x === w);
  w.el.style.zIndex = ++z; w.el.classList.remove('min'); renderBar();
}
function renderBar() {
  document.body.classList.toggle('has-wins', wins.size > 0);
  clear(bar);
  for (const w of wins.values()) bar.append(h('button', { onclick: () => { w.el.classList.contains('min') ? focusWin(w) : (w.el.classList.add('min'), renderBar()); }, style: { opacity: w.el.classList.contains('min') ? .6 : 1 } }, w.title));
}

/** open({key, title, render(body, win) -> cleanup, width, height}). Re-focuses if already open. */
export function openWindow({ key, title, render, width = 860, height = 560 }) {
  if (wins.has(key)) { const w = wins.get(key); focusWin(w); return w; }
  const box = layer.getBoundingClientRect();
  const sp = savedPos[key.split(':')[0]];
  const n = wins.size;
  const W = Math.min(sp?.w || width, box.width - 20), H = Math.min(sp?.h || height, box.height - 20);
  const el = h('div', { class: 'win', style: { width: W + 'px', height: H + 'px', left: Math.max(0, Math.min(sp?.x ?? 40 + n * 28, box.width - W)) + 'px', top: Math.max(0, Math.min(sp?.y ?? 30 + n * 28, box.height - H)) + 'px' } });
  const w = { key, title, el, cleanup: null };
  const titleEl = h('div', { class: 't' }, title);
  const btn = (cls, ic, fn, label) => h('button', { class: cls, onclick: (e) => { e.stopPropagation(); fn(); }, 'aria-label': label }, icon(ic, 14));
  const tb = h('div', { class: 'tb', ondblclick: () => toggleMax() }, titleEl,
    btn('', 'min', () => { el.classList.add('min'); renderBar(); }, 'Minimize'),
    btn('mx', 'max', () => toggleMax(), 'Maximize / restore'),
    btn('x', 'x', () => close(), 'Close'));
  const body = h('div', { class: 'wb' });
  const rz = h('div', { class: 'rz' });
  el.append(tb, body, rz);
  layer.append(el);
  const toggleMax = () => { if (isMobile()) return; el.classList.toggle('max'); };
  const close = () => { w.cleanup?.(); el.remove(); wins.delete(key); renderBar(); };
  w.close = close; w.setTitle = (t) => { w.title = t; titleEl.textContent = t; renderBar(); };
  el.addEventListener('mousedown', () => focusWin(w));

  // drag
  tb.addEventListener('mousedown', (e) => {
    if (isMobile() || el.classList.contains('max') || e.target.closest('button')) return;
    const sx = e.clientX, sy = e.clientY, ox = el.offsetLeft, oy = el.offsetTop;
    const mv = (ev) => { const b = layer.getBoundingClientRect(); el.style.left = Math.max(-W / 2, Math.min(b.width - 80, ox + ev.clientX - sx)) + 'px'; el.style.top = Math.max(0, Math.min(b.height - 40, oy + ev.clientY - sy)) + 'px'; };
    const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); remember(); };
    addEventListener('mousemove', mv); addEventListener('mouseup', up); e.preventDefault();
  });
  // resize
  rz.addEventListener('mousedown', (e) => {
    const sx = e.clientX, sy = e.clientY, ow = el.offsetWidth, oh = el.offsetHeight;
    const mv = (ev) => { el.style.width = Math.max(360, ow + ev.clientX - sx) + 'px'; el.style.height = Math.max(240, oh + ev.clientY - sy) + 'px'; };
    const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); remember(); };
    addEventListener('mousemove', mv); addEventListener('mouseup', up); e.preventDefault(); e.stopPropagation();
  });
  const remember = () => { if (el.classList.contains('max')) return; savedPos[key.split(':')[0]] = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }; persist(); };

  wins.set(key, w);
  w.cleanup = render(body, w);
  focusWin(w);
  return w;
}
export const closeAllWindows = () => { for (const w of [...wins.values()]) w.close(); };
