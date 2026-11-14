import { h, get, post, put, del, stream, subscribe, openSocket, stateBadge, badge, toast, errToast, busy, confirmDialog, modal, loading, empty, errBox, tabs } from '../lib.js';
import { createEditor } from '../editor.js';
import { openWindow } from '../wm.js';

const SAMPLE = 'services:\n  web:\n    image: nginx:alpine\n    restart: unless-stopped\n    ports:\n      - "127.0.0.1:8081:80"\n';
export async function render(main) {
  const box = h('div'); let alive = true;
  const refresh = async () => {
    try {
      const { compose, stacks } = await get('/stacks');
      box.replaceChildren(!compose.available ? h('div', { class: 'warnbox', style: { marginBottom: '12px' } }, 'Docker Compose V2 is not available in the ServerOS container: ' + (compose.error || '') + ' Stack operations are disabled.') : h('div', { class: 'muted small', style: { marginBottom: '8px' } }, `Docker Compose ${compose.version}`),
        stacks.length ? h('div', { class: 'apps' }, ...stacks.map((s) => h('div', { class: 'app' }, h('div', { class: 'top' }, h('div', { class: 'ico' }, '☰'), h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { class: 'name', onclick: () => s.manageable && openStack(s, refresh) }, s.name), h('div', { class: 'small muted' }, s.managed ? 'managed by ServerOS' : 'discovered (external)')), stateBadge(s.state)),
          h('div', { class: 'small muted' }, `${s.running}/${s.total} services running`), s.reason ? h('div', { class: 'small warn' }, s.reason) : null,
          h('div', { class: 'actions' }, h('button', { class: 'btn sm primary', disabled: !s.manageable || !compose.available, onclick: () => openStack(s, refresh) }, 'Open'), s.manageable && compose.available ? [h('button', { class: 'btn sm', onclick: () => runOp(s.name, 'up', refresh) }, 'Up'), h('button', { class: 'btn sm', onclick: () => runOp(s.name, 'stop', refresh) }, 'Stop')] : null)))) : empty('No stacks yet. Create one or start a Compose project on the host.'));
    } catch (e) { box.replaceChildren(errBox(e)); }
  };
  main.append(h('div', { class: 'page-head' }, h('h1', null, 'Compose / Stacks'), h('span', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: () => createStack(refresh) }, '+ New stack')), box);
  box.append(loading()); await refresh();
  const un = subscribe('docker.event', () => { if (alive) refresh(); }, 'containers');
  return () => { alive = false; un(); };
}

async function createStack(done) {
  const name = h('input', { type: 'text', placeholder: 'my-stack' }); const host = h('div', { style: { height: '340px', border: '1px solid var(--line)', borderRadius: '10px' } }); let ed;
  modal({ title: 'New stack', wide: true, body: h('div', { class: 'form' }, h('label', null, 'Name (lowercase letters, digits, - and _)', name), h('div', { class: 'muted small' }, 'compose.yaml'), host), actions: (close) => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: async () => { try { await post('/stacks', { name: name.value.trim(), content: ed.get() }); toast('Stack created (not started yet)', 'ok'); close(); done(); } catch (e) { errToast(e); } } }, 'Create')] });
  ed = await createEditor(host, { value: SAMPLE, language: 'yaml' });
}

async function runOp(name, op, done, outEl) {
  let impact;
  try { impact = await get(`/stacks/${name}/impact?op=${op}`); } catch (e) { return errToast(e); }
  if (impact.destructive || op === 'up') {
    const ok = await confirmDialog({ title: `${op} — ${name}`, danger: impact.destructive, confirmText: op, requireText: impact.self && op !== 'pull' ? name : undefined, message: h('div', null, h('p', null, impact.description), impact.containers.length ? h('div', { class: 'small muted' }, 'Affected: ' + impact.containers.join(', ')) : null, impact.keepsVolumes ? h('p', { class: 'small' }, 'Volumes are never removed by this operation.') : null) });
    if (!ok) return false;
  }
  const out = outEl || h('pre', { class: 'pre', style: { maxHeight: '320px' } });
  let m; if (!outEl) m = modal({ title: `${op} — ${name}`, wide: true, body: out });
  out.textContent = '';
  try { await stream(`/stacks/${name}/run`, { op, confirm: true, confirmSelf: !!impact.self }, (x) => { if (x.line) { out.textContent += x.line + '\n'; out.scrollTop = out.scrollHeight; } if (x.done) { out.textContent += x.code === 0 ? '\n✔ finished successfully\n' : `\n✖ failed (exit code ${x.code})\n`; toast(x.code === 0 ? `${op} finished` : `${op} failed`, x.code === 0 ? 'ok' : 'error'); } }); } catch (e) { errToast(e); }
  done?.(); void m; return true;
}

function openStack(s, refresh) {
  openWindow({ key: 'stack:' + s.name, title: 'Stack ' + s.name, width: 920, height: 620, render(body, win) {
    let ed = null, logSock = null;
    const t = tabs([['editor', 'compose.yaml'], ['env', '.env'], ['status', 'Status'], ['logs', 'Logs'], ['actions', 'Actions']], 'editor', (id, pane) => {
      pane.style.display = 'flex'; pane.style.flexDirection = 'column';
      if (id === 'editor' || id === 'env') {
        pane.replaceChildren(loading());
        get(`/stacks/${s.name}/file`).then(async (f) => {
          const host = h('div', { style: { flex: 1, minHeight: 0, border: '1px solid var(--line)', borderRadius: '10px' } });
          const dirty = h('span', { class: 'badge warn', style: { display: 'none' } }, 'unsaved');
          const val = h('pre', { class: 'pre', style: { display: 'none', maxHeight: '140px' } });
          const save = h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => { const r = await put(`/stacks/${s.name}/file`, id === 'editor' ? { content: ed.get() } : { content: f.content, env: ed.get() }); ed.markSaved(); toast('Saved (previous version kept as ' + r.backup + ')', 'ok'); if (id === 'editor') validate(); }) }, 'Save');
          const validate = async () => { const r = await post(`/stacks/${s.name}/validate`); val.style.display = ''; val.textContent = r.valid ? '✔ Compose file is valid' : '✖ ' + r.output; };
          pane.replaceChildren(h('div', { class: 'toolbar' }, save, id === 'editor' ? h('button', { class: 'btn', onclick: (e) => busy(e.target, validate) }, 'Validate (docker compose config)') : h('span', { class: 'muted small' }, 'Environment file used for variable substitution. Treat as secret.'), dirty), host, val);
          ed = await createEditor(host, { value: id === 'editor' ? f.content : f.env, language: id === 'editor' ? 'yaml' : 'ini', onDirty: (d) => { dirty.style.display = d ? '' : 'none'; } });
        }).catch((e) => pane.replaceChildren(errBox(e)));
        return () => ed?.dispose();
      }
      if (id === 'status') { const draw = async () => { try { const rows = await get(`/stacks/${s.name}/ps`); pane.replaceChildren(h('div', { class: 'toolbar' }, h('button', { class: 'btn sm', onclick: draw }, 'Refresh')), rows.length ? h('table', null, h('thead', null, h('tr', null, ...['Service', 'Container', 'State', 'Status', 'Image'].map((x) => h('th', null, x)))), h('tbody', null, ...rows.map((r) => h('tr', null, h('td', null, r.service), h('td', null, r.name), h('td', null, stateBadge(r.health || r.state)), h('td', { class: 'small' }, r.status), h('td', { class: 'small' }, r.image))))) : empty('No containers. Run "Up" to create them.')); } catch (e) { pane.replaceChildren(errBox(e)); } }; draw(); return; }
      if (id === 'logs') { const view = h('div', { class: 'logview', style: { flex: 1 } }); pane.replaceChildren(view); logSock = openSocket('/ws/stack/logs', { name: s.name, tail: 200 }, { message: (e) => { const m = JSON.parse(e.data); if (m.type === 'lines') { m.lines.forEach((l) => view.append(h('div', null, l))); while (view.children.length > 4000) view.firstChild.remove(); view.scrollTop = view.scrollHeight; } } }); return () => logSock?.close(); }
      if (id === 'actions') {
        const out = h('pre', { class: 'pre', style: { flex: 1, maxHeight: 'none' } });
        const b = (op, label, cls = '') => h('button', { class: 'btn ' + cls, onclick: (e) => { e.target.disabled = true; runOp(s.name, op, refresh, out).finally(() => { e.target.disabled = false; }); } }, label);
        pane.replaceChildren(h('div', { class: 'toolbar' }, b('up', 'Up (create/update)', 'primary'), b('pull', 'Pull images'), b('recreate', 'Recreate'), b('restart', 'Restart'), b('stop', 'Stop'), b('down', 'Down', 'danger'), s.managed ? h('button', { class: 'btn danger', onclick: async () => { if (!(await confirmDialog({ title: 'Remove stack definition', danger: true, message: 'The stack files are moved to the trash folder in the data directory (not deleted). Containers must be removed first (Down).', confirmText: 'Remove', requireText: s.name }))) return; try { const r = await del(`/stacks/${s.name}?confirm=true`); toast('Moved to ' + r.movedTo, 'ok'); win.close(); refresh(); } catch (e) { errToast(e); } } }, 'Remove definition') : null), out);
      }
    });
    body.append(t.el);
    return () => t.destroy();
  } });
}
void post; void badge;
