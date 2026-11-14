import { h, icon, post, del, modal, badge, ago, when, toast, errToast } from './lib.js';

const SEV = { critical: ['alert', 'Critical', 'bad'], warning: ['alert', 'Warning', 'warn'], info: ['info', 'Info', 'blue'] };
// where to look into a problem, by notification category
const LINKS = { docker: ['#/containers', 'Open Containers'], certificate: ['#/nginx/ssl', 'Open SSL / Certbot'], nginx: ['#/nginx/service', 'Open Nginx service'], service: ['#/services', 'Open System Services'], system: ['#/monitoring', 'Open Monitoring'], network: ['#/monitoring', 'Open Monitoring'], backup: ['#/settings/backups', 'Open Backups'], cpu: ['#/monitoring', 'Open Monitoring'], mem: ['#/monitoring', 'Open Monitoring'], disk_pct: ['#/monitoring', 'Open Monitoring'] };

export const sevInfo = (s) => SEV[s] || SEV.info;

/** Compact, touch-friendly notification card. handlers: {changed(), open(n)} */
export function notifCard(n, { changed, compact = false, selectable, selected, onSelect } = {}) {
  const [ic, , kind] = sevInfo(n.severity);
  const toggle = async (e) => { e.stopPropagation(); try { await post('/notifications/read', { ids: [n.id], read: !n.read }); n.read = n.read ? 0 : 1; changed?.(); } catch (x) { errToast(x); } };
  const open = async () => { showDetail(n, changed); if (!n.read) { try { await post('/notifications/read', { ids: [n.id] }); n.read = 1; changed?.(); } catch { /* ignore */ } } };
  return h('div', { class: `notif ${n.read ? '' : 'unread'}`, onclick: open, role: 'button', tabindex: 0, onkeydown: (e) => { if (e.key === 'Enter') open(); } },
    selectable ? h('input', { type: 'checkbox', checked: selected, onclick: (e) => e.stopPropagation(), onchange: (e) => onSelect?.(e.target.checked) }) : null,
    h('div', { class: `ic ${n.severity}` }, icon(ic, 18)),
    h('div', { class: 'nb' },
      h('div', { class: 'row', style: { gap: '6px', flexWrap: 'nowrap' } }, h('b', { class: 'trunc', style: { flex: 1 } }, n.title), !n.read ? h('span', { class: 'udot', title: 'Unread' }) : null, h('span', { class: 'small muted nowrap' }, ago(n.ts))),
      n.body ? h('p', null, n.body) : null,
      h('div', { class: 'row', style: { gap: '6px', marginTop: '4px' } }, badge(n.category), compact ? null : badge(sevInfo(n.severity)[1], kind), h('span', { class: 'spacer' }),
        h('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); open(); } }, icon('eye', 14), 'Details'),
        h('button', { class: 'btn sm', onclick: toggle, title: n.read ? 'Mark as unread' : 'Mark as read' }, icon(n.read ? 'undo' : 'check', 14), n.read ? 'Unread' : 'Mark read'))));
}

export function showDetail(n, changed) {
  const [ic, label, kind] = sevInfo(n.severity);
  const link = LINKS[n.category] || (n.rule_key && LINKS[n.rule_key]);
  const m = modal({
    title: 'Notification', 
    body: h('div', { class: 'form' },
      h('div', { class: 'row', style: { alignItems: 'flex-start', flexWrap: 'nowrap' } }, h('div', { class: `ic ${n.severity}`, style: { width: '40px', height: '40px', borderRadius: '12px', display: 'grid', placeItems: 'center', flex: 'none' } }, icon(ic, 22)), h('div', null, h('h2', { style: { fontSize: '17px' } }, n.title), h('div', { class: 'row', style: { marginTop: '6px' } }, badge(label, kind), badge(n.category), badge(n.read ? 'read' : 'unread', n.read ? '' : 'blue')))),
      n.body ? h('div', { class: 'pre', style: { fontFamily: 'inherit', fontSize: '13.5px' } }, n.body) : h('div', { class: 'muted' }, 'No further details were recorded.'),
      h('dl', { class: 'kv', style: { gridTemplateColumns: '110px 1fr' } }, ...[['Time', `${when(n.ts)} (${ago(n.ts)})`], ['Alert rule', n.rule_key || '—'], ['ID', '#' + n.id]].flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      link ? h('a', { class: 'btn', href: link[0], onclick: () => m.close() }, icon('link', 14), link[1]) : null),
    actions: (close) => [
      h('button', { class: 'btn danger', onclick: async () => { try { await del('/notifications/' + n.id); toast('Notification deleted', 'ok'); close(); changed?.(true); } catch (e) { errToast(e); } } }, icon('trash', 14), 'Delete'),
      h('button', { class: 'btn', onclick: async () => { try { await post('/notifications/read', { ids: [n.id], read: !n.read }); n.read = n.read ? 0 : 1; close(); changed?.(); } catch (e) { errToast(e); } } }, n.read ? 'Mark as unread' : 'Mark as read'),
      h('button', { class: 'btn primary', onclick: close }, 'Close')],
  });
}
