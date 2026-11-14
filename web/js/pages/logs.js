import { h, get, openSocket, toast, errToast, download, debounce, loading, errBox, api } from '../lib.js';

export async function render(main) {
  let sources = [], sock = null, paused = false, auto = true, lines = [], buffered = [], search = '';
  const view = h('div', { class: 'logview', style: { flex: 1 } });
  const srcSel = h('select', { style: { minWidth: '240px' } }); const q = h('input', { type: 'search', placeholder: 'Search…' });
  const sev = h('select', null, ...[['', 'any severity'], ['3', 'error and worse'], ['4', 'warning and worse'], ['6', 'info and worse']].map(([v, l]) => h('option', { value: v }, l)));
  const tailSel = h('select', null, ...['200', '500', '1000', '3000'].map((v) => h('option', { value: v }, 'last ' + v)));
  const since = h('input', { type: 'text', placeholder: 'since (e.g. 1 hour ago, 2026-11-07 10:00)', style: { width: '260px' } });
  const status = h('span', { class: 'muted small' });
  const pauseBtn = h('button', { class: 'btn sm', onclick: () => { paused = !paused; pauseBtn.textContent = paused ? 'Resume' : 'Pause'; if (!paused) { lines.push(...buffered); buffered = []; draw(); } } }, 'Pause');
  const autoBox = h('input', { type: 'checkbox', checked: true, onchange: () => { auto = autoBox.checked; if (auto) view.scrollTop = view.scrollHeight; } });
  const draw = () => { const s = search.toLowerCase(); const f = s ? lines.filter((l) => l.toLowerCase().includes(s)) : lines; view.replaceChildren(...f.slice(-4000).map((l) => { const d = h('div', { class: /\b(error|fail|critical|fatal|emerg|alert)\b/i.test(l) ? 'err2' : '' }); const i = s ? l.toLowerCase().indexOf(s) : -1; if (i >= 0) d.append(l.slice(0, i), h('mark', null, l.slice(i, i + s.length)), l.slice(i + s.length)); else d.append(l); return d; })); if (auto) view.scrollTop = view.scrollHeight; };
  const drawSoon = debounce(draw, 80);
  const label = () => sources.find((s) => s.id === srcSel.value)?.label || srcSel.value;
  const connect = () => {
    sock?.close(); lines = []; buffered = []; draw(); if (!srcSel.value) return; status.textContent = 'connecting…';
    sock = openSocket('/ws/logs', { source: srcSel.value, lines: tailSel.value, priority: sev.value, since: since.value.trim() }, {
      open: () => { status.textContent = 'live — ' + label(); },
      message: (e) => { const m = JSON.parse(e.data); if (m.type === 'lines') { (paused ? buffered : lines).push(...m.lines); if (!paused) { if (lines.length > 8000) lines.splice(0, lines.length - 6000); drawSoon(); } } else if (m.type === 'error') status.textContent = m.message; },
      close: (e) => { if (e.code === 1000) status.textContent = 'stream ended'; else status.textContent = 'disconnected — reconnecting…'; },
    });
  };
  view.addEventListener('scroll', () => { auto = view.scrollTop + view.clientHeight >= view.scrollHeight - 8; autoBox.checked = auto; });
  q.addEventListener('input', debounce(() => { search = q.value; draw(); }, 150));
  [srcSel, sev, tailSel].forEach((x) => x.addEventListener('change', connect)); since.addEventListener('change', connect);
  const dl = h('button', { class: 'btn sm', onclick: () => download(`${srcSel.value.replace(/[^\w.-]/g, '_')}.log`, lines.join('\n') + '\n') }, 'Download');
  main.style.display = 'flex'; main.style.flexDirection = 'column';
  main.append(h('div', { class: 'page-head' }, h('h1', null, 'System Logs')), h('div', { class: 'toolbar' }, srcSel, q, sev, tailSel, since), h('div', { class: 'toolbar' }, pauseBtn, h('label', { class: 'row small' }, autoBox, 'auto-scroll'), dl, status), view);
  try {
    sources = await get('/logs/sources');
    if (!sources.length) { view.replaceChildren(h('div', { class: 'warnbox' }, 'No log sources available. The host agent is required for host logs; Docker for container logs.')); return; }
    const groups = {}; for (const s of sources) (groups[s.group] ||= []).push(s);
    for (const [g, list] of Object.entries(groups)) srcSel.append(h('optgroup', { label: g }, ...list.map((s) => h('option', { value: s.id }, s.label))));
    connect();
  } catch (e) { view.replaceChildren(errBox(e)); }
  return () => { sock?.close(); main.style.display = ''; main.style.flexDirection = ''; };
}
void toast; void errToast; void loading; void api;
