import { h, get, post, put, del, stream, badge, stateBadge, toast, errToast, busy, confirmDialog, promptDialog, modal, loading, empty, errBox, tabs, bytes, when, download, openSocket } from '../lib.js';
import { createEditor, createDiff, langFor } from '../editor.js';
import { state } from '../main.js';

export async function render(main, { sub }) {
  main.style.display = 'flex'; main.style.flexDirection = 'column';
  const head = h('div', { class: 'page-head' }, h('h1', null, 'Nginx'));
  main.append(head);
  let info;
  try { info = await get('/nginx/info'); } catch (e) { main.append(errBox(e)); return () => { main.style.display = ''; }; }
  if (!info.info.installed) { main.append(h('div', { class: 'warnbox' }, 'Nginx is not installed on this host (or its binary was not found). Install it on the host; ServerOS manages the host installation, not a container.')); return () => { main.style.display = ''; }; }
  const st = info.status; const chip = h('span', null);
  const paint = (s) => chip.replaceChildren(stateBadge(s.active ? 'active' : 'failed'), ' ', h('span', { class: 'muted small' }, `nginx ${s.version || ''} · ${s.unit || 'no systemd unit detected'}`));
  paint(st); head.append(h('span', { class: 'spacer' }), chip);
  let cleanup = null;
  const t = tabs([['files', 'Configuration'], ['overview', 'Sites overview'], ['ssl', 'SSL / Certbot'], ['service', 'Service & logs']], sub || 'files', (id, pane) => { pane.classList.add('pane'); pane.style.display = 'flex'; pane.style.flexDirection = 'column'; cleanup = ({ files: filesTab, overview: overviewTab, ssl: sslTab, service: serviceTab })[id](pane, paint); return () => cleanup?.(); }, { onSelect: (id) => history.replaceState(null, '', '#/nginx/' + id) });
  main.append(t.el);
  return () => { t.destroy(); main.style.display = ''; main.style.flexDirection = ''; };
}

// ----------------------------------------------------------------- configuration editor
function filesTab(pane, paint) {
  let files = [], cur = null, ed = null, diffD = null, dirty = false;
  const tree = h('div', { class: 'card split-side', style: { width: '270px', flex: 'none', overflow: 'auto', padding: '10px' } });
  const editorHost = h('div', { style: { flex: 1, minHeight: 0, border: '1px solid var(--line)', borderRadius: '10px', position: 'relative' } });
  const out = h('pre', { class: 'pre', style: { display: 'none', maxHeight: '170px', margin: '8px 0 0' } });
  const bar = h('div', { class: 'toolbar' }); const label = h('b', null, 'Select a file');
  const right = h('div', { class: 'split-main', style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } }, h('div', { class: 'row', style: { marginBottom: '8px' } }, label), bar, editorHost, out);
  pane.append(h('div', { class: 'split', style: { display: 'flex', gap: '12px', flex: 1, minHeight: 0 } }, tree, right));
  const show = (text, ok) => { out.style.display = ''; out.textContent = text; out.style.borderColor = ok === undefined ? '' : ok ? 'var(--ok)' : 'var(--bad)'; };

  async function load() {
    try { const r = await get('/nginx/files'); files = r.files; drawTree(); } catch (e) { tree.replaceChildren(errBox(e)); }
  }
  const GROUPS = [['main', 'Main'], ['sites-available', 'sites-available'], ['sites-enabled', 'sites-enabled'], ['conf.d', 'conf.d'], ['snippets', 'snippets'], ['modules', 'modules'], ['other', 'Other']];
  function drawTree() {
    tree.replaceChildren(h('div', { class: 'row', style: { marginBottom: '8px' } }, h('button', { class: 'btn sm', onclick: newFile }, '+ New file'), h('button', { class: 'btn sm', onclick: load }, '↻')),
      ...GROUPS.flatMap(([g, title]) => { const fs = files.filter((f) => f.category === g); if (!fs.length) return []; return [h('div', { class: 'small muted', style: { margin: '10px 0 4px', textTransform: 'uppercase' } }, title), ...fs.map((f) => h('div', { class: 'row', style: { padding: '3px 6px', borderRadius: '8px', background: cur === f.path ? 'var(--accent-bg)' : '', cursor: 'pointer', justifyContent: 'space-between' }, onclick: () => open(f) },
        h('span', { class: 'trunc', title: f.path }, (f.symlink ? '🔗 ' : '') + f.path.split('/').pop(), f.broken ? ' (broken)' : ''),
        g === 'sites-available' ? h('input', { type: 'checkbox', checked: !!f.enabled, title: f.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable', onclick: (e) => { e.stopPropagation(); }, onchange: (e) => toggle(f, e.target.checked, e.target) }) : null))]; }));
  }
  async function guardDirty() { return !dirty || (await confirmDialog({ title: 'Discard unsaved changes?', message: 'You have unsaved changes in the editor.', danger: true, confirmText: 'Discard' })); }
  async function open(f) {
    if (!(await guardDirty())) return;
    try {
      const r = await get('/nginx/file?path=' + encodeURIComponent(f.path));
      cur = f.path; dirty = false; out.style.display = 'none'; label.textContent = f.path + (r.symlink ? `  → ${r.target}` : '');
      ed?.dispose(); diffD?.dispose(); diffD = null; editorHost.replaceChildren();
      ed = await createEditor(editorHost, { value: r.content, language: 'nginx', onDirty: (d) => { dirty = d; unsaved.style.display = d ? '' : 'none'; } });
      ed.sha = r.sha256; ed.editor.addCommand(ed.monaco.KeyMod.CtrlCmd | ed.monaco.KeyCode.KeyS, () => apply(false));
      drawBar(); drawTree();
    } catch (e) { errToast(e); }
  }
  const unsaved = h('span', { class: 'badge warn', style: { display: 'none' } }, 'unsaved');
  function drawBar() {
    bar.replaceChildren(h('button', { class: 'btn', onclick: (e) => busy(e.target, () => apply(true)) }, 'Test only'), h('button', { class: 'btn primary', onclick: (e) => busy(e.target, () => apply(false)) }, 'Save & test'), h('button', { class: 'btn primary', onclick: (e) => busy(e.target, () => apply(false, true)) }, 'Save, test & reload'),
      h('button', { class: 'btn', onclick: showDiff }, 'Diff'), h('button', { class: 'btn', onclick: backups }, 'Backups'), h('button', { class: 'btn', onclick: renameFile }, 'Rename'), h('button', { class: 'btn danger', onclick: removeFile }, 'Delete'), unsaved);
  }
  async function apply(dry, reload) {
    if (!cur) return;
    const body = { path: cur, content: ed.get(), dryRun: !!dry, reload: !!reload, expectedSha256: ed.sha };
    const send = async (ack) => put('/nginx/file', { ...body, acknowledgeDashboard: ack });
    let r;
    try { r = await send(false); } catch (e) {
      if (e.code === 'dashboard_risk') { if (!(await confirmDialog({ title: 'This may break dashboard access', message: e.message, danger: true, confirmText: 'I understand, continue' }))) return; r = await send(true); }
      else if (e.code === 'conflict') { show('✖ ' + e.message + '\nReload the file from the tree to see the latest version.', false); return; } else { show('✖ ' + e.message, false); return; }
    }
    if (!r.applied) { show(`${r.dry_run ? 'TEST ONLY — ' : ''}${r.test.ok ? '✔ Configuration test passed (nothing was saved).' : '✖ Configuration test FAILED. The file was NOT saved and Nginx was NOT reloaded.'}\n\n${r.test.output}`, r.test.ok); return; }
    ed.markSaved(); ed.sha = (await get('/nginx/file?path=' + encodeURIComponent(cur))).sha256;
    let msg = `✔ Saved. Configuration test passed.\n${r.backup ? `Previous version backed up as ${r.backup}\n` : ''}${r.included === false ? '⚠ This file is not included by the active Nginx configuration (e.g. not enabled in sites-enabled), so it has no effect yet.\n' : ''}\n${r.test.output}`;
    if (r.reload) msg += `\n\n${r.reload.ok ? '✔ Nginx reloaded' : '✖ Reload failed'} (${r.reload.command})\n${r.reload.output}`; else msg += '\n\nNginx was not reloaded. Use "Save, test & reload" or Service → Reload to apply.';
    show(msg, !r.reload || r.reload.ok); if (r.reload) { paint(r.reload.status); } load();
  }
  async function showDiff() {
    if (!cur) return; try { const r = await get('/nginx/file?path=' + encodeURIComponent(cur)); const host = h('div', { style: { height: '65vh' } }); let d; modal({ title: `Changes in ${cur} (disk → editor)`, wide: true, body: host, onClose: () => d?.dispose() }); d = await createDiff(host, r.content, ed.get(), 'nginx'); } catch (e) { errToast(e); }
  }
  async function backups() {
    if (!cur) return; try {
      const list = await get('/nginx/backups?path=' + encodeURIComponent(cur));
      const body = h('div', null, list.length ? h('table', null, h('tbody', null, ...list.map((b) => h('tr', null, h('td', null, b.time), h('td', null, bytes(b.size)), h('td', { class: 'nowrap' }, h('button', { class: 'btn sm', onclick: async () => { const bk = await get('/nginx/backups/' + encodeURIComponent(b.name)); const host = h('div', { style: { height: '60vh' } }); let d; modal({ title: `Backup ${b.time} vs current editor`, wide: true, body: host, onClose: () => d?.dispose() }); d = await createDiff(host, bk.content, ed.get(), 'nginx'); } }, 'Diff'), ' ', h('button', { class: 'btn sm', onclick: async () => { const bk = await get('/nginx/backups/' + encodeURIComponent(b.name)); ed.editor.setValue(bk.content); toast('Backup loaded into the editor — review, then Save & test'); document.querySelector('.overlay')?.remove(); } }, 'Load into editor'), ' ', h('button', { class: 'btn sm danger', onclick: async (e) => { if (!(await confirmDialog({ title: 'Restore backup', message: `Overwrite ${cur} with the backup from ${b.time}? The configuration is tested first and rolled back if invalid.`, danger: true, confirmText: 'Restore' }))) return; try { const r = await post('/nginx/restore', { backup: b.name, path: cur, reload: false }); toast(r.applied ? 'Restored (not reloaded)' : 'Restore rejected: configuration test failed', r.applied ? 'ok' : 'error'); document.querySelector('.overlay')?.remove(); if (r.applied) open({ path: cur }); } catch (x) { errToast(x); } } }, 'Restore')))))) : empty('No backups for this file yet. A backup is created on every successful save.'));
      modal({ title: 'Backups of ' + cur, wide: true, body });
    } catch (e) { errToast(e); }
  }
  async function toggle(f, enable, box) {
    try {
      const name = f.path.split('/').pop();
      const call = (ack) => post('/nginx/sites/toggle', { name, enable, acknowledgeDashboard: ack });
      let r; try { r = await call(false); } catch (e) { if (e.code === 'dashboard_risk') { if (!(await confirmDialog({ title: 'This may break dashboard access', message: e.message, danger: true, confirmText: 'Disable anyway' }))) { box.checked = !enable; return; } r = await call(true); } else throw e; }
      if (!r.changed) { box.checked = !enable; show('✖ Configuration test failed — change rolled back.\n\n' + r.test.output, false); return; }
      show(`✔ Site ${enable ? 'enabled' : 'disabled'}. Configuration test passed. Nginx was not reloaded yet — use "Service → Reload".\n\n${r.test.output}`, true); load();
    } catch (e) { box.checked = !enable; errToast(e); }
  }
  async function newFile() {
    const dir = await promptDialog({ title: 'New configuration file', label: 'Path relative to the Nginx config directory', value: 'sites-available/example.conf' }); if (!dir) return;
    const skeleton = 'server {\n    listen 80;\n    server_name example.com;\n\n    location / {\n        proxy_pass http://127.0.0.1:8080;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n    }\n}\n';
    try { const r = await put('/nginx/file', { path: dir, content: skeleton, create: true, dryRun: false }); show(r.applied ? '✔ Created (not enabled / not reloaded).\n' + r.test.output : '✖ Not created: test failed\n' + r.test.output, r.applied); await load(); open({ path: dir }); } catch (e) { errToast(e); }
  }
  async function renameFile() { const n = await promptDialog({ title: 'Rename', label: 'New path (relative)', value: cur }); if (!n || n === cur) return; try { const call = (a) => post('/nginx/rename', { from: cur, to: n, acknowledgeDashboard: a }); try { await call(false); } catch (e) { if (e.code === 'dashboard_risk' && (await confirmDialog({ title: 'May break dashboard access', message: e.message, danger: true }))) await call(true); else throw e; } toast('Renamed', 'ok'); cur = n; dirty = false; await load(); open({ path: n }); } catch (e) { errToast(e); } }
  async function removeFile() {
    if (!cur) return; if (!(await confirmDialog({ title: `Delete ${cur}`, danger: true, confirmText: 'Delete', requireText: cur.split('/').pop(), message: 'The file is deleted (a backup is kept for regular files). If it is enabled via a symlink, only the entry you picked is removed.' }))) return;
    const call = (a) => del(`/nginx/file?path=${encodeURIComponent(cur)}&confirm=true&acknowledgeDashboard=${a}`);
    try { let r; try { r = await call(false); } catch (e) { if (e.code === 'dashboard_risk' && (await confirmDialog({ title: 'May break dashboard access', message: e.message, danger: true }))) r = await call(true); else throw e; } show(`Deleted. ${r.backup ? 'Backup: ' + r.backup + '\n' : ''}Configuration test now: ${r.test.ok ? 'OK' : 'FAILING'}\n${r.test.output}`, r.test.ok); cur = null; dirty = false; ed?.dispose(); ed = null; editorHost.replaceChildren(); bar.replaceChildren(); label.textContent = 'Select a file'; load(); } catch (e) { errToast(e); }
  }
  load();
  const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } }; addEventListener('beforeunload', beforeUnload);
  return () => { removeEventListener('beforeunload', beforeUnload); ed?.dispose(); diffD?.dispose(); };
}

// ----------------------------------------------------------------- overview
function overviewTab(pane) {
  const box = h('div', { style: { overflow: 'auto' } }); pane.append(h('div', { class: 'info', style: { marginBottom: '10px' } }, 'Read-only, best-effort summary derived from your configuration files. Where parsing is uncertain, open the file in the editor — the text is the source of truth.'), box); box.append(loading());
  get('/nginx/overview').then((list) => {
    box.replaceChildren(...(list.length ? list.map((f) => h('div', { class: 'card', style: { marginBottom: '12px' } }, h('h3', null, `${f.file}  (${f.category})`),
      ...f.servers.map((s) => h('div', { style: { padding: '8px 0', borderTop: '1px solid var(--line)' } }, h('div', { class: 'row' }, h('b', null, s.names.join(', ') || '(default server)'), s.ssl ? badge('SSL', 'ok') : badge('HTTP only', 'warn'), s.redirectHttps ? badge('→ HTTPS redirect', 'blue') : null), h('div', { class: 'small muted' }, 'listen: ' + (s.listen.join(' | ') || '—')), s.proxy.length ? h('div', { class: 'small' }, 'proxy → ' + s.proxy.join(', ')) : null, s.root ? h('div', { class: 'small' }, 'root: ' + s.root) : null, s.certs.length ? h('div', { class: 'small mono' }, s.certs.join(', ')) : null, s.locations.length ? h('div', { class: 'small muted' }, 'locations: ' + s.locations.join(' · ')) : null)),
      ...f.upstreams.map((u) => h('div', { style: { padding: '8px 0', borderTop: '1px solid var(--line)' } }, h('b', null, 'upstream ' + u.name), h('div', { class: 'small muted' }, u.servers.join(', ')))))) : [empty('No server or upstream blocks found.')]));
  }).catch((e) => box.replaceChildren(errBox(e)));
}

// ----------------------------------------------------------------- certbot
function sslTab(pane) {
  const box = h('div', { style: { overflow: 'auto' } }); pane.append(box);
  async function load() {
    box.replaceChildren(loading());
    try {
      const r = await get('/certbot');
      box.replaceChildren(h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: () => issue(load) }, '+ Issue certificate'), h('button', { class: 'btn', onclick: () => runStream('Renew all certificates (due ones only)', '/certbot/renew', { confirm: true }, load, true) }, 'Renew now'), h('button', { class: 'btn', onclick: () => runStream('Dry-run renewal', '/certbot/renew', { dryRun: true }, load) }, 'Dry-run renewal'), h('button', { class: 'btn', onclick: logs }, 'Certbot log'), h('span', { class: 'muted small' }, r.timers.length ? 'Auto-renewal timer: ' + r.timers[0].split(/\s{2,}/).slice(0, 2).join(' · ') : 'No certbot renewal timer found — set up auto-renewal on the host.')),
        r.certificates.length ? h('div', { class: 'apps' }, ...r.certificates.map((c) => h('div', { class: 'app' }, h('div', { class: 'top' }, h('div', { class: 'ico' }, '🔒'), h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { class: 'name' }, c.name), h('div', { class: 'small muted trunc' }, c.domains.join(', '))), stateBadge(c.status === 'valid' ? (c.days_left <= 14 ? 'partial' : 'valid') : c.status)),
          h('div', { class: 'metrics' }, h('span', null, 'Expires ', h('b', null, (c.expiry || '').slice(0, 10))), h('span', null, 'Remaining ', h('b', { class: c.days_left <= 7 ? 'bad' : c.days_left <= 14 ? 'warn' : '' }, c.days_left + ' days')), h('span', { style: { gridColumn: '1/3' } }, 'Issuer ', h('b', null, (c.issuer || '—').replace(/^.*CN\s*=\s*/, ''))), h('span', { style: { gridColumn: '1/3', wordBreak: 'break-all' }, class: 'mono' }, c.cert_path), h('span', { style: { gridColumn: '1/3', wordBreak: 'break-all' }, class: 'mono' }, 'key: ' + c.key_path + ' (contents never shown)')),
          h('div', { class: 'actions' }, h('button', { class: 'btn sm', onclick: () => runStream(`Renew ${c.name}`, '/certbot/renew', { certName: c.name, confirm: true, force: false }, load, true) }, 'Renew'), h('button', { class: 'btn sm', onclick: () => runStream(`Dry run ${c.name}`, '/certbot/renew', { certName: c.name, dryRun: true }, load) }, 'Dry run'), h('button', { class: 'btn sm', onclick: () => snippet(c) }, 'Nginx snippet'), h('button', { class: 'btn sm', onclick: async () => { try { const x = await get('/certbot/renewal/' + c.name); modal({ title: 'Renewal configuration', wide: true, body: h('pre', { class: 'pre' }, x.content) }); } catch (e) { errToast(e); } } }, 'Renewal config'),
            h('button', { class: 'btn sm danger', onclick: () => revoke(c, load) }, 'Revoke'), h('button', { class: 'btn sm danger', onclick: () => remove(c, load) }, 'Delete'))))) : empty('No certificates yet.'));
    } catch (e) { box.replaceChildren(errBox(e)); }
  }
  load();
}
function snippet(c) {
  const name = c.name; const t = `listen 443 ssl;\nssl_certificate     /etc/letsencrypt/live/${name}/fullchain.pem;\nssl_certificate_key /etc/letsencrypt/live/${name}/privkey.pem;\n\n# separate server block: redirect HTTP to HTTPS\nserver {\n    listen 80;\n    server_name ${c.domains.join(' ')};\n    return 301 https://$host$request_uri;\n}`;
  modal({ title: 'Nginx snippet for ' + name, wide: true, body: h('div', { class: 'form' }, h('div', { class: 'info' }, 'ServerOS never edits your Nginx files when issuing certificates. Paste this into the relevant server block, then use "Save, test & reload".'), h('pre', { class: 'pre' }, t), h('button', { class: 'btn', onclick: () => navigator.clipboard?.writeText(t).then(() => toast('Copied', 'ok')) }, 'Copy')) });
}
async function runStream(title, path, body, done) {
  const out = h('pre', { class: 'pre', style: { maxHeight: '55vh' } }); const m = modal({ title, wide: true, body: out });
  const need = path === '/certbot/renew' && !body.dryRun || ['/certbot/issue', '/certbot/revoke', '/certbot/delete'].includes(path);
  void need; out.textContent = 'Starting…\n';
  try { await stream(path, body, (x) => { if (x.line !== undefined) { out.textContent += x.line + '\n'; out.scrollTop = out.scrollHeight; } if (x.done) { out.textContent += x.code === 0 ? '\n✔ Finished successfully' : `\n✖ Failed (exit code ${x.code})`; toast(x.code === 0 ? 'Certbot finished' : 'Certbot failed', x.code === 0 ? 'ok' : 'error'); } }); } catch (e) { out.textContent += '\n✖ ' + e.message; errToast(e); }
  done?.(); void m;
}
async function issue(done) {
  const domains = h('input', { type: 'text', placeholder: 'example.com, www.example.com' }); const method = h('select', null, h('option', { value: 'nginx' }, 'Nginx plugin (temporary edits, restored automatically)'), h('option', { value: 'webroot' }, 'Webroot'), h('option', { value: 'standalone' }, 'Standalone (needs port 80 free)')); const webroot = h('input', { type: 'text', placeholder: '/var/www/html' }); const email = h('input', { type: 'text', placeholder: 'admin@example.com' }); const staging = h('input', { type: 'checkbox' });
  try { email.value = (await get('/settings')).settings['certbot.email'] || ''; } catch { /* ignore */ }
  modal({ title: 'Issue certificate', body: h('div', { class: 'form' }, h('label', null, 'Domains (comma separated)', domains), h('label', null, 'Validation method', method), h('label', null, 'Webroot path (webroot method)', webroot), h('label', null, 'E-mail for expiry notices', email), h('label', { class: 'row' }, staging, 'Use Let’s Encrypt staging (testing, untrusted certificate)'), h('div', { class: 'info' }, 'Only the certificate is issued. Your Nginx configuration files are not modified.')),
    actions: (close) => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: async () => { close(); await runStream('Issue certificate', '/certbot/issue', { domains: domains.value.split(/[,\s]+/).filter(Boolean), method: method.value, webroot: webroot.value || undefined, email: email.value.trim() || undefined, staging: staging.checked, confirm: true }, done); } }, 'Issue')] });
}
async function revoke(c, done) { if (!(await confirmDialog({ title: `Revoke ${c.name}`, danger: true, confirmText: 'Revoke', requireText: c.name, message: 'Revocation tells the CA the certificate is compromised/unwanted. This cannot be undone. The certificate files stay on disk until you delete them.' }))) return; runStream('Revoke ' + c.name, '/certbot/revoke', { certName: c.name, confirm: true }, done); }
async function remove(c, done) {
  let refs; try { refs = await get('/certbot/references/' + c.name); } catch (e) { return errToast(e); }
  if (refs.files.length && !(await confirmDialog({ title: 'Certificate is in use', danger: true, confirmText: 'Delete anyway', requireText: c.name, message: h('div', null, h('p', null, 'These Nginx files reference this certificate. Deleting it will make Nginx fail to start/reload until they are fixed:'), h('pre', { class: 'pre' }, refs.files.join('\n'))) }))) return;
  if (!refs.files.length && !(await confirmDialog({ title: `Delete ${c.name}`, danger: true, confirmText: 'Delete', requireText: c.name, message: 'Deletes the certificate and its private key files from /etc/letsencrypt (without revoking). No Nginx file references it.' }))) return;
  runStream('Delete ' + c.name, '/certbot/delete', { certName: c.name, confirm: true, force: refs.files.length > 0 }, done);
}

// ----------------------------------------------------------------- service & logs
function serviceTab(pane, paint) {
  const out = h('pre', { class: 'pre', style: { maxHeight: '180px', display: 'none' } }); const logBox = h('div', { class: 'logview', style: { flex: 1, minHeight: '200px' } });
  let sock = null; const srcSel = h('select', { style: { width: 'auto' }, onchange: tail }, h('option', { value: 'file:nginx_error' }, 'Error log'), h('option', { value: 'file:nginx_access' }, 'Access log'));
  const act = (a, label, cls = '') => h('button', { class: 'btn ' + cls, onclick: async (e) => {
    if (['restart', 'stop'].includes(a) && !(await confirmDialog({ title: `${label} Nginx`, danger: true, confirmText: label, message: a === 'stop' ? 'Stopping Nginx takes every site offline, including the dashboard if it is served through it.' : 'Restart interrupts active connections. Prefer Reload when possible.' }))) return;
    await busy(e.target, async () => { const r = await post('/nginx/service', { action: a }); out.style.display = ''; out.textContent = `${r.refused ? '✖ ' + r.refused + '\n' : r.ok === false ? '✖ failed\n' : '✔ ok\n'}${r.command ? '$ ' + r.command + '\n' : ''}${r.output || ''}`; if (r.status) paint(r.status); }); } }, label);
  pane.append(h('div', { class: 'toolbar' }, act('test', 'Test config (nginx -t)'), act('reload', 'Reload', 'primary'), act('restart', 'Restart'), act('start', 'Start'), act('stop', 'Stop', 'danger')), out, h('div', { class: 'toolbar', style: { marginTop: '12px' } }, srcSel, h('span', { class: 'muted small' }, 'live tail')), logBox);
  function tail() { sock?.close(); logBox.replaceChildren(); sock = openSocket('/ws/logs', { source: srcSel.value, lines: 200 }, { message: (e) => { const m = JSON.parse(e.data); if (m.type === 'lines') { m.lines.forEach((l) => logBox.append(h('div', { class: /\[(error|crit|alert|emerg)\]/.test(l) ? 'err2' : '' }, l))); while (logBox.children.length > 3000) logBox.firstChild.remove(); logBox.scrollTop = logBox.scrollHeight; } else if (m.type === 'error') logBox.append(h('div', { class: 'err2' }, m.message)); } }); }
  tail(); return () => sock?.close();
}
void download; void when; void state; void langFor; void escape;
