// ---------- DOM helper (text is always set via text nodes; no innerHTML with data)
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'indeterminate') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  add(el, kids);
  return el;
}
export function add(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const $ = (sel, root = document) => root.querySelector(sel);

const ICONS = {
  home: 'M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z', box: 'M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v9', layers: 'M12 2l10 5-10 5L2 7zM2 12l10 5 10-5M2 17l10 5 10-5',
  db: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  net: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18', stack: 'M3 3h18v6H3zM3 15h18v6H3zM7 6h.01M7 18h.01',
  chart: 'M3 3v18h18M7 15l4-4 3 3 5-6', log: 'M5 3h14v18H5zM9 8h6M9 12h6M9 16h4', term: 'M4 4h16v16H4zM8 9l3 3-3 3M13 15h4', folder: 'M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  cog: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.3l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2.2-1.3L14 3h-4l-.4 2.4a7 7 0 0 0-2.2 1.3l-2.3-.9-2 3.4 2 1.5a7 7 0 0 0 0 2.6l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2.2 1.3L10 21h4l.4-2.4a7 7 0 0 0 2.2-1.3l2.3.9 2-3.4-2-1.5c.1-.4.1-.9.1-1.3z',
  server: 'M3 4h18v7H3zM3 13h18v7H3zM7 7.5h.01M7 16.5h.01', globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18', bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4',
  alert: 'M12 3l10 18H2zM12 10v5M12 18v.01', check: 'M5 12l5 5 9-10', undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', more: 'M5 12h.01M12 12h.01M19 12h.01',
  menu: 'M3 6h18M3 12h18M3 18h18', play: 'M6 4l14 8-14 8z', stop: 'M5 5h14v14H5z', refresh: 'M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3', x: 'M6 6l12 12M18 6L6 18', min: 'M5 19h14', max: 'M5 5h14v14H5z', plus: 'M12 5v14M5 12h14', pause: 'M7 5v14M17 5v14',
  save: 'M5 3h12l4 4v14H5zM8 3v6h8V3M8 21v-7h8v7', upload: 'M12 16V4M7 9l5-5 5 5M4 20h16', download: 'M12 4v12M7 11l5 5 5-5M4 20h16', edit: 'M4 20h4L19 9l-4-4L4 16z', file: 'M6 3h9l4 4v14H6zM14 3v5h5', lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4', shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 4-6 8-6s8 2 8 6', sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5', moon: 'M20 14A8 8 0 1 1 10 4a6.5 6.5 0 0 0 10 10z', info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5v.01', search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5', link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
};
export function icon(name, size) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  if (size) { s.setAttribute('width', size); s.setAttribute('height', size); }
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name] || ICONS.info);
  s.append(p);
  return s;
}

// ---------- formatting
export const bytes = (n, d = 1) => { if (n === null || n === undefined || isNaN(n)) return '—'; const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; let i = 0; n = Number(n); while (Math.abs(n) >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n.toFixed(i ? d : 0)} ${u[i]}`; };
export const rate = (n) => (n === null || n === undefined ? '—' : bytes(n) + '/s');
export const pct = (n, d = 0) => (n === null || n === undefined || isNaN(n) ? '—' : `${Number(n).toFixed(d)}%`);
export function dur(sec) { if (sec === null || sec === undefined || isNaN(sec)) return '—'; sec = Math.max(0, Math.floor(sec)); const d = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60); return d ? `${d}d ${hh}h` : hh ? `${hh}h ${m}m` : m ? `${m}m ${sec % 60}s` : `${sec}s`; }
export const since = (iso) => { if (!iso || iso.startsWith('0001')) return '—'; return dur((Date.now() - new Date(iso).getTime()) / 1000); };
export const when = (t) => (t ? new Date(typeof t === 'number' && t < 1e12 ? t * 1000 : t).toLocaleString() : '—');
export const ago = (t) => dur((Date.now() - (typeof t === 'number' ? t : new Date(t).getTime())) / 1000) + ' ago';
export const level = (p) => (p >= 90 ? 'bad' : p >= 75 ? 'warn' : '');
export function bar(p) { return h('div', { class: 'bar' }, h('i', { class: level(p), style: { width: Math.max(0, Math.min(100, p || 0)) + '%' } })); }

// ---------- API
let csrf = '';
export const setCsrf = (t) => { csrf = t || ''; };
let onUnauth = () => {};
export const setUnauthHandler = (f) => { onUnauth = f; };
export class ApiError extends Error { constructor(status, message, code, details) { super(message); this.status = status; this.code = code; this.details = details; } }

async function parseError(r) {
  let body = null; try { body = await r.json(); } catch { /* not json */ }
  return new ApiError(r.status, body?.error?.message || `Request failed (${r.status})`, body?.error?.code, body?.error?.details);
}
export async function api(path, { method = 'GET', body, raw, signal, headers } = {}) {
  const opts = { method, credentials: 'same-origin', signal, headers: { ...(headers || {}) } };
  if (method !== 'GET') opts.headers['X-CSRF-Token'] = csrf;
  if (raw !== undefined) { opts.body = raw; opts.headers['Content-Type'] = 'application/octet-stream'; }
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch('/api' + path, opts);
  if (r.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/auth/status')) onUnauth();
  if (!r.ok) throw await parseError(r);
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r.text();
}
export const get = (p) => api(p);
export const post = (p, body) => api(p, { method: 'POST', body: body ?? {} });
export const put = (p, body) => api(p, { method: 'PUT', body });
export const del = (p) => api(p, { method: 'DELETE' });

/** POST that streams NDJSON; calls onMsg for every parsed line. Resolves when finished. */
export async function stream(path, body, onMsg, signal) {
  const r = await fetch('/api' + path, { method: 'POST', credentials: 'same-origin', signal, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body ?? {}) });
  if (r.status === 401) onUnauth();
  if (!r.ok) throw await parseError(r);
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n'); buf = parts.pop();
    for (const p of parts) if (p.trim()) { try { onMsg(JSON.parse(p)); } catch { /* ignore */ } }
  }
}

// ---------- WebSocket
export function wsUrl(path, params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}${q.toString() ? '?' + q : ''}`;
}
/** Reconnecting JSON socket. handlers: {message, open, close(ev), giveUp}. */
export function openSocket(path, params, handlers, { reconnect = true } = {}) {
  let ws, closed = false, tries = 0, timer;
  const connect = () => {
    ws = new WebSocket(wsUrl(path, typeof params === 'function' ? params() : params));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { tries = 0; handlers.open?.(ws); };
    ws.onmessage = (e) => handlers.message?.(e);
    ws.onclose = (e) => {
      handlers.close?.(e);
      if (closed || !reconnect || e.code === 4001 || (e.code >= 4400 && e.code < 4600) || e.code === 1000) { if (e.code === 4001) onUnauth(); return; }
      tries++; if (tries > 8) { handlers.giveUp?.(); return; }
      timer = setTimeout(connect, Math.min(1000 * 2 ** tries, 15000));
    };
  };
  connect();
  return { send: (d) => ws?.readyState === 1 && ws.send(d), json: (o) => ws?.readyState === 1 && ws.send(JSON.stringify(o)), get ws() { return ws; }, close() { closed = true; clearTimeout(timer); try { ws?.close(); } catch { /* ignore */ } } };
}

// shared event socket (monitoring / containers / notifications)
const listeners = new Map();
let evSock = null;
const topicsWanted = new Set();
export function subscribe(topic, fn, serverTopic = topic) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(fn);
  topicsWanted.add(serverTopic);
  if (!evSock) {
    evSock = openSocket('/ws/events', {}, {
      open: () => evSock.json({ type: 'sub', topics: [...topicsWanted] }),
      message: (e) => { try { const m = JSON.parse(e.data); listeners.get(m.topic)?.forEach((f) => f(m.data, m)); } catch { /* ignore */ } },
    });
  } else evSock.json({ type: 'sub', topics: [...topicsWanted] });
  return () => listeners.get(topic)?.delete(fn);
}
export function stopEvents() { evSock?.close(); evSock = null; listeners.clear(); topicsWanted.clear(); }

// ---------- UI primitives
let toasts;
export function toast(msg, type = 'info', ms = 4500) {
  if (!toasts) { toasts = h('div', { class: 'toasts' }); document.body.append(toasts); }
  const t = h('div', { class: 'toast ' + type }, msg);
  toasts.append(t);
  setTimeout(() => t.remove(), type === 'error' ? ms * 1.6 : ms);
}
export const errToast = (e) => toast(e?.message || String(e), 'error');

export function modal({ title, body, actions, wide, onClose }) {
  const close = () => { ov.remove(); onClose?.(); };
  const ov = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === ov && !wide) close(); } },
    h('div', { class: 'modal' + (wide ? ' wide' : '') },
      h('header', null, h('h2', { class: 'grow', style: { flex: 1 } }, title), h('button', { class: 'btn icon sm', onclick: close, 'aria-label': 'Close' }, icon('x'))),
      h('div', { class: 'body' }, body),
      actions ? h('footer', null, actions(close)) : null));
  document.body.append(ov);
  return { close, el: ov };
}

/** Confirmation dialog. `requireText` forces typing a phrase. Resolves true/false. */
export function confirmDialog({ title, message, confirmText = 'Confirm', danger = false, requireText, detail }) {
  return new Promise((resolve) => {
    const input = requireText ? h('input', { type: 'text', placeholder: `Type "${requireText}" to confirm`, autocomplete: 'off' }) : null;
    let done = false;
    const finish = (v, close) => { if (done) return; done = true; close(); resolve(v); };
    const btn = h('button', { class: 'btn ' + (danger ? 'danger' : 'primary') }, confirmText);
    if (input) { btn.disabled = true; input.addEventListener('input', () => { btn.disabled = input.value !== requireText; }); }
    modal({
      title, body: h('div', { class: 'form' }, h('div', null, message), detail || null, input),
      actions: (close) => [h('button', { class: 'btn', onclick: () => finish(false, close) }, 'Cancel'), (btn.onclick = () => finish(true, close), btn)],
      onClose: () => { if (!done) { done = true; resolve(false); } },
    });
    input?.focus();
  });
}
export function promptDialog({ title, label, value = '', placeholder = '', confirmText = 'OK', type = 'text' }) {
  return new Promise((resolve) => {
    const input = h('input', { type, value, placeholder });
    let done = false;
    const ok = (close) => { done = true; close(); resolve(input.value); };
    modal({ title, body: h('label', { class: 'form' }, label, input), actions: (close) => [h('button', { class: 'btn', onclick: () => { done = true; close(); resolve(null); } }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => ok(close) }, confirmText)], onClose: () => { if (!done) resolve(null); } });
    input.focus(); input.select();
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { done = true; document.querySelector('.overlay')?.remove(); resolve(input.value); } });
  });
}

export const loading = (t = 'Loading…') => h('div', { class: 'loading' }, h('span', { class: 'spinner' }), t);
export const empty = (t) => h('div', { class: 'empty' }, t);
export const errBox = (e) => h('div', { class: 'err' }, e?.message || String(e));
export const badge = (text, kind = '') => h('span', { class: 'badge ' + kind }, text);
export const stateBadge = (s) => badge(s, { running: 'ok', healthy: 'ok', active: 'ok', valid: 'ok', paused: 'warn', restarting: 'warn', starting: 'warn', partial: 'warn', exited: '', created: '', unhealthy: 'bad', failed: 'bad', dead: 'bad', expired: 'bad', invalid: 'bad' }[s] ?? '');

/** Run async fn with a button disabled + toast on failure/success. */
export async function busy(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try { const r = await fn(); if (okMsg) toast(okMsg, 'ok'); return r; } catch (e) { errToast(e); return undefined; } finally { if (btn) btn.disabled = false; }
}

export function tabs(items, initial, render, { onSelect } = {}) {
  const body = h('div', { class: 'fill grow', style: { flex: 1, minHeight: 0 } });
  const bar = h('div', { class: 'tabs' });
  let cleanup = null, cur = null;
  const select = (id) => {
    cur = id;
    for (const b of bar.children) b.classList.toggle('active', b.dataset.id === id);
    if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
    clear(body);
    const r = render(id, body);
    cleanup = typeof r === 'function' ? r : null; // async renderers return a Promise — ignore it
    onSelect?.(id);
  };
  for (const [id, label] of items) bar.append(h('button', { 'data-id': id, onclick: () => select(id) }, label));
  const root = h('div', { class: 'fill', style: { flex: 1, minHeight: 0 } }, bar, body);
  queueMicrotask(() => select(initial || items[0][0]));
  return { el: root, select, destroy: () => { if (typeof cleanup === 'function') cleanup(); }, get current() { return cur; } };
}

export function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return res();
    const s = document.createElement('script'); s.src = src; s.dataset.src = src; s.onload = res; s.onerror = () => rej(new Error('Failed to load ' + src)); document.head.append(s);
  });
}
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export function download(name, text) { const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: name }); document.body.append(a); a.click(); a.remove(); }
export function dropdown(button, items) {
  const wrap = h('div', { class: 'dd' }, button);
  let menu = null;
  const hide = () => { menu?.remove(); menu = null; document.removeEventListener('pointerdown', outside); };
  const outside = (e) => { if (!wrap.contains(e.target)) hide(); };
  button.addEventListener('click', () => { if (menu) return hide(); menu = h('div', { class: 'menu' }, typeof items === 'function' ? items(hide) : items); wrap.append(menu); document.addEventListener('pointerdown', outside); });
  return wrap;
}
