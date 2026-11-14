import { h, get, loading, errBox, toast } from '../lib.js';
import { createTerminal } from '../term.js';
import { state } from '../main.js';

export async function render(main) {
  const tabsBar = h('div', { class: 'tabs' }); const area = h('div', { style: { flex: 1, minHeight: 0, position: 'relative' } });
  let sessions = [], n = 0, active = null;
  main.style.display = 'flex'; main.style.flexDirection = 'column';
  const caps = state.caps || (await get('/system')).capabilities;
  main.append(h('div', { class: 'page-head' }, h('h1', null, 'Host Terminal'), h('span', { class: 'muted small' }, caps?.terminal ? `Runs on the host as "${caps.terminal.user}". Input is never recorded; opening and closing sessions is audited.` : '')));
  if (!caps?.agent) { main.append(h('div', { class: 'warnbox' }, 'The host agent is not reachable, so the host terminal is unavailable. ', caps?.agentError || '')); return () => { main.style.display = ''; }; }
  main.append(tabsBar, area);
  const select = (s) => { active = s; sessions.forEach((x) => { x.el.style.display = x === s ? '' : 'none'; x.tab.classList.toggle('active', x === s); }); setTimeout(() => { s.term.fit(); s.term.focus(); }, 30); };
  const add = () => {
    const id = ++n; const term = createTerminal('/ws/host/terminal', {}, { onExit: () => { tab.title = 'session ended'; } });
    const el = h('div', { style: { position: 'absolute', inset: 0 } }, term.el); term.el.style.height = '100%'; area.append(el);
    const tab = h('button', { onclick: () => select(s) }, `Shell ${id} `, h('span', { class: 'muted', onclick: (e) => { e.stopPropagation(); close(s); } }, '✕'));
    const s = { id, term, el, tab }; sessions.push(s); tabsBar.insertBefore(tab, plus); select(s);
  };
  const close = (s) => { s.term.dispose(); s.el.remove(); s.tab.remove(); sessions = sessions.filter((x) => x !== s); if (active === s && sessions.length) select(sessions[sessions.length - 1]); };
  const plus = h('button', { onclick: add, title: 'New session' }, '＋'); tabsBar.append(plus);
  add();
  const onResize = () => active?.term.fit(); addEventListener('resize', onResize);
  return () => { removeEventListener('resize', onResize); sessions.forEach((s) => s.term.dispose()); main.style.display = ''; main.style.flexDirection = ''; };
}
void loading; void errBox; void toast;
