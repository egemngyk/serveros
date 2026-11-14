import { h, get, post, del, stream, api, bytes, when, badge, toast, errToast, busy, confirmDialog, modal, loading, empty, errBox, stateBadge } from '../lib.js';

const head = (title, ...actions) => h('div', { class: 'page-head' }, h('h1', null, title), h('span', { class: 'spacer' }), ...actions);
const jsonModal = (title, obj) => modal({ title, wide: true, body: h('pre', { class: 'pre', style: { maxHeight: '65vh' } }, JSON.stringify(obj, null, 2)) });
const usedBy = (cs) => h('div', null, cs.map((c) => h('div', { class: 'small' }, `${c.name} `, stateBadge(c.state))));

export async function images(main) {
  const box = h('div', { class: 'tbl' });
  const refresh = async () => {
    try {
      const list = await get('/docker/images');
      box.replaceChildren(list.length ? h('table', null, h('thead', null, h('tr', null, ...['Tags', 'ID', 'Size', 'Created', 'Used by', ''].map((x) => h('th', null, x)))),
        h('tbody', null, ...list.map((i) => h('tr', null, h('td', null, i.tags.length ? i.tags.map((t) => h('div', null, t)) : badge('dangling', 'warn')), h('td', { class: 'mono' }, i.shortId), h('td', null, bytes(i.size)), h('td', null, when(i.created)), h('td', null, i.containers.length ? usedBy(i.containers) : h('span', { class: 'muted' }, 'unused')),
          h('td', { class: 'nowrap' }, h('button', { class: 'btn sm', onclick: async () => jsonModal(i.tags[0] || i.shortId, await get(`/docker/images/${encodeURIComponent(i.id)}/inspect`).catch((e) => ({ error: e.message }))) }, 'Inspect'), ' ',
            h('button', { class: 'btn sm danger', onclick: async () => {
              if (!(await confirmDialog({ title: 'Remove image', danger: true, confirmText: 'Remove', message: h('div', null, h('p', null, `Remove ${i.tags[0] || i.shortId}?`), i.containers.length ? h('div', { class: 'warnbox' }, 'Used by: ' + i.containers.map((c) => c.name).join(', ') + '. Docker will refuse to remove it while containers use it.') : h('p', { class: 'muted' }, 'No containers use this image.')) }))) return;
              try { await del(`/docker/images/${encodeURIComponent(i.tags[0] || i.id)}`); toast('Image removed', 'ok'); refresh(); } catch (e) { errToast(e); } } }, 'Remove'))))) ) : empty('No images.'));
    } catch (e) { box.replaceChildren(errBox(e)); }
  };
  const pullBtn = h('button', { class: 'btn primary', onclick: () => pullDialog(refresh) }, 'Pull image');
  const pruneBtn = h('button', { class: 'btn', onclick: () => pruneDialog(refresh) }, 'Clean up unused…');
  main.append(head('Images', pruneBtn, pullBtn), h('div', { class: 'card' }, box)); box.append(loading()); await refresh();
}

function pullDialog(done) {
  const input = h('input', { type: 'text', placeholder: 'e.g. nginx:alpine or ghcr.io/org/app:1.2' }); const out = h('pre', { class: 'pre', style: { display: 'none', maxHeight: '240px' } }); const bar = h('div', { class: 'small muted' });
  modal({ title: 'Pull image', body: h('div', { class: 'form' }, h('label', null, 'Image reference', input), bar, out),
    actions: (close) => [h('button', { class: 'btn', onclick: close }, 'Close'), h('button', { class: 'btn primary', onclick: async (e) => {
      e.target.disabled = true; out.style.display = ''; out.textContent = ''; const layers = {};
      try { await stream('/docker/images/pull', { image: input.value.trim() }, (m) => {
        if (m.error) { out.textContent += 'ERROR: ' + m.error + '\n'; return; }
        if (m.done) { toast('Image pulled', 'ok'); out.textContent += 'Done.\n'; done(); return; }
        const p = m.progress; if (p.id) { layers[p.id] = p.text ? `${p.id}: ${p.status} ${p.text}` : `${p.id}: ${p.status}`; out.textContent = Object.values(layers).join('\n'); } else out.textContent += p.status + '\n';
        const tot = Object.values(layers).length; const doneN = Object.values(layers).filter((l) => /complete|exists/i.test(l)).length; bar.textContent = tot ? `${doneN}/${tot} layers complete` : '';
      }); } catch (err) { errToast(err); } e.target.disabled = false; } }, 'Pull')] });
  input.focus();
}

function pruneDialog(done) {
  const body = h('div', null, loading()); const picked = new Set();
  modal({ title: 'Clean up unused images', wide: true, body, actions: (close) => [h('button', { class: 'btn', onclick: close }, 'Close'), h('button', { class: 'btn danger', id: 'pr', onclick: async (e) => { if (!picked.size) return; if (!(await confirmDialog({ title: 'Remove images', danger: true, message: `Remove ${picked.size} unused image(s)? They can be pulled again.`, confirmText: 'Remove' }))) return; await busy(e.target, async () => { const r = await post('/docker/images/prune', { ids: [...picked], confirm: true }); toast(`Removed ${r.removed.length}${r.errors.length ? `, ${r.errors.length} failed` : ''}`, r.errors.length ? 'error' : 'ok'); close(); done(); }); } }, 'Remove selected')] });
  get('/docker/images/unused').then((list) => {
    if (!list.length) return body.replaceChildren(empty('No unused images.'));
    body.replaceChildren(h('p', { class: 'muted' }, 'These images are not used by any container (running or stopped). Select the ones to remove.'), h('div', { class: 'tbl' }, h('table', null, h('tbody', null, ...list.map((i) => h('tr', null, h('td', null, h('input', { type: 'checkbox', onchange: (e) => { e.target.checked ? picked.add(i.id) : picked.delete(i.id); } })), h('td', null, i.tags.join(', ') || 'dangling'), h('td', { class: 'mono' }, i.shortId), h('td', null, bytes(i.size))))))));
  }).catch((e) => body.replaceChildren(errBox(e)));
}

export async function volumes(main) {
  const box = h('div', { class: 'tbl' }); let usage = false;
  const refresh = async () => {
    try {
      const list = await get('/docker/volumes' + (usage ? '?usage=1' : ''));
      box.replaceChildren(list.length ? h('table', null, h('thead', null, h('tr', null, ...['Name', 'Driver', 'Mountpoint', 'Size', 'Used by', ''].map((x) => h('th', null, x)))),
        h('tbody', null, ...list.map((v) => h('tr', null, h('td', { class: 'mono' }, v.name), h('td', null, v.driver), h('td', { class: 'mono small trunc', style: { maxWidth: '260px' }, title: v.mountpoint }, v.mountpoint), h('td', null, v.size !== null && v.size >= 0 ? bytes(v.size) : usage ? 'n/a' : '—'), h('td', null, v.containers.length ? usedBy(v.containers) : h('span', { class: 'muted' }, 'unused')),
          h('td', { class: 'nowrap' }, h('button', { class: 'btn sm', onclick: async () => jsonModal(v.name, await get(`/docker/volumes/${encodeURIComponent(v.name)}/inspect`).catch((e) => ({ error: e.message }))) }, 'Inspect'), ' ',
            h('button', { class: 'btn sm danger', disabled: v.containers.length > 0, title: v.containers.length ? 'In use — remove the containers first' : '', onclick: async () => { if (!(await confirmDialog({ title: 'Delete volume', danger: true, confirmText: 'Delete data', requireText: v.name, message: 'This permanently deletes ALL data stored in this volume. It cannot be undone.' }))) return; try { await del(`/docker/volumes/${encodeURIComponent(v.name)}?confirm=true`); toast('Volume removed', 'ok'); refresh(); } catch (e) { errToast(e); } } }, 'Delete'))))) ) : empty('No volumes.'));
    } catch (e) { box.replaceChildren(errBox(e)); }
  };
  main.append(head('Volumes', h('button', { class: 'btn', onclick: (e) => { usage = true; busy(e.target, refresh); } }, 'Calculate sizes'), h('button', { class: 'btn primary', onclick: () => createVolume(refresh) }, 'Create volume')), h('div', { class: 'info', style: { marginBottom: '12px' } }, 'Removing a container never removes its volumes. Volume data is not part of the application backup — see Settings → Backups for the separate volume backup.'), h('div', { class: 'card' }, box)); box.append(loading()); await refresh();
}
function createVolume(done) {
  const name = h('input', { type: 'text', placeholder: 'volume-name' });
  modal({ title: 'Create volume', body: h('label', { class: 'form' }, 'Name', name), actions: (close) => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: async () => { try { await post('/docker/volumes', { name: name.value.trim() }); toast('Volume created', 'ok'); close(); done(); } catch (e) { errToast(e); } } }, 'Create')] });
}

export async function networks(main) {
  const box = h('div', { class: 'tbl' });
  const refresh = async () => {
    try {
      const list = await get('/docker/networks');
      box.replaceChildren(h('table', null, h('thead', null, h('tr', null, ...['Name', 'Driver', 'Scope', 'Subnet / Gateway', 'Containers', ''].map((x) => h('th', null, x)))),
        h('tbody', null, ...list.map((n) => h('tr', null, h('td', null, n.name, n.builtin ? [' ', badge('built-in')] : '', n.internal ? [' ', badge('internal', 'warn')] : ''), h('td', null, n.driver), h('td', null, n.scope), h('td', { class: 'mono small' }, n.ipam.map((i) => `${i.subnet || '—'} / ${i.gateway || '—'}`).join(', ') || '—'), h('td', null, n.containers),
          h('td', { class: 'nowrap' }, h('button', { class: 'btn sm', onclick: () => networkDetail(n) }, 'Inspect'), ' ', h('button', { class: 'btn sm danger', disabled: n.builtin || n.containers > 0, onclick: async () => { if (!(await confirmDialog({ title: 'Remove network', danger: true, message: `Remove network ${n.name}?`, confirmText: 'Remove' }))) return; try { await del(`/docker/networks/${n.id}`); toast('Network removed', 'ok'); refresh(); } catch (e) { errToast(e); } } }, 'Remove')))))));
    } catch (e) { box.replaceChildren(errBox(e)); }
  };
  main.append(head('Networks', h('button', { class: 'btn primary', onclick: () => createNetwork(refresh) }, 'Create network')), h('div', { class: 'card' }, box)); box.append(loading()); await refresh();
}
async function networkDetail(n) {
  const body = h('div', null, loading()); modal({ title: `Network ${n.name}`, wide: true, body });
  try { const d = await get(`/docker/networks/${n.id}`); body.replaceChildren(h('dl', { class: 'kv' }, ...[['ID', d.Id], ['Driver', d.Driver], ['Scope', d.Scope], ['Internal', String(d.Internal)], ['IPv6', String(d.EnableIPv6)], ['Subnets', (d.IPAM?.Config || []).map((c) => `${c.Subnet} gw ${c.Gateway || '—'}`).join(', ') || '—']].flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])), h('h3', { style: { margin: '14px 0 6px' } }, 'Connected containers'), d.ContainersList.length ? h('table', null, h('tbody', null, ...d.ContainersList.map((c) => h('tr', null, h('td', null, c.name), h('td', { class: 'mono' }, c.ipv4 || '—'), h('td', { class: 'mono' }, c.mac || ''))))) : empty('None'), h('details', { style: { marginTop: '12px' } }, h('summary', null, 'Raw JSON'), h('pre', { class: 'pre' }, JSON.stringify(d, null, 2)))); } catch (e) { body.replaceChildren(errBox(e)); }
}
function createNetwork(done) {
  const f = { name: h('input', { type: 'text' }), driver: h('select', null, ...['bridge', 'macvlan', 'ipvlan', 'overlay'].map((d) => h('option', null, d))), subnet: h('input', { type: 'text', placeholder: '172.30.0.0/24 (optional)' }), gateway: h('input', { type: 'text', placeholder: 'optional' }), internal: h('input', { type: 'checkbox' }) };
  modal({ title: 'Create network', body: h('div', { class: 'form' }, h('label', null, 'Name', f.name), h('label', null, 'Driver', f.driver), h('label', null, 'Subnet', f.subnet), h('label', null, 'Gateway', f.gateway), h('label', { class: 'row' }, f.internal, 'Internal (no external access)')), actions: (close) => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: async () => { try { await post('/docker/networks', { name: f.name.value.trim(), driver: f.driver.value, subnet: f.subnet.value.trim() || undefined, gateway: f.gateway.value.trim() || undefined, internal: f.internal.checked }); toast('Network created', 'ok'); close(); done(); } catch (e) { errToast(e); } } }, 'Create')] });
}
void api;
