import { h, get, post, put, del, api, bytes, when, badge, toast, errToast, busy, confirmDialog, promptDialog, modal, loading, empty, errBox, debounce } from '../lib.js';
import { createEditor, langFor } from '../editor.js';
import { state } from '../main.js';

export async function render(main) {
  let cwd = localStorage.getItem('serveros.cwd') || '', items = [], roots = [], clipboard = null, q = '', showHidden = localStorage.getItem('serveros.showHidden') === '1';
  const box = h('div', { class: 'tbl' }); const crumbs = h('div', { class: 'row small', style: { flexWrap: 'wrap' } });
  const search = h('input', { type: 'search', placeholder: 'Filter…', oninput: debounce((e) => { q = e.target.value.toLowerCase(); draw(); }, 100) });
  const hiddenBox = h('input', { type: 'checkbox', checked: showHidden, onchange: (e) => { showHidden = e.target.checked; localStorage.setItem('serveros.showHidden', showHidden ? '1' : '0'); draw(); } });
  const zipHere = h('button', { class: 'btn', style: { display: 'none' }, onclick: () => zipDownload(cwd, cwd.split('/').filter(Boolean).pop() || 'folder') }, 'Download folder (ZIP)');
  const fileInput = h('input', { type: 'file', multiple: true, style: { display: 'none' }, onchange: async (e) => { for (const f of e.target.files) await upload(f); e.target.value = ''; load(cwd); } });
  const pasteBtn = h('button', { class: 'btn sm', style: { display: 'none' }, onclick: async () => { const dest = cwd + '/' + clipboard.name; try { await post(clipboard.cut ? '/files/rename' : '/files/copy', { from: clipboard.path, to: dest }); toast(clipboard.cut ? 'Moved' : 'Copied', 'ok'); if (clipboard.cut) clipboard = null; pasteBtn.style.display = 'none'; load(cwd); } catch (e) { errToast(e); } } }, 'Paste');
  main.append(h('div', { class: 'page-head' }, h('h1', null, 'File Manager'), h('span', { class: 'spacer' }), search, h('label', { class: 'row small', style: { whiteSpace: 'nowrap' } }, hiddenBox, 'Show hidden files'), pasteBtn, zipHere,
    h('button', { class: 'btn', onclick: async () => { const n = await promptDialog({ title: 'New folder', label: 'Folder name' }); if (n) try { await post('/files/mkdir', { path: join(cwd, n) }); load(cwd); } catch (e) { errToast(e); } } }, 'New folder'),
    h('button', { class: 'btn', onclick: async () => { const n = await promptDialog({ title: 'New file', label: 'File name' }); if (n) { try { await put('/files/write', { path: join(cwd, n), content: '', create: true }); load(cwd); edit(join(cwd, n)); } catch (e) { errToast(e); } } } }, 'New file'),
    h('button', { class: 'btn primary', onclick: () => fileInput.click() }, 'Upload'), fileInput), h('div', { class: 'card' }, crumbs, box));
  main.addEventListener('dragover', (e) => e.preventDefault()); main.addEventListener('drop', async (e) => { e.preventDefault(); for (const f of e.dataTransfer.files) await upload(f); load(cwd); });

  const join = (a, b) => (a.endsWith('/') ? a : a + '/') + b;
  async function upload(file) {
    const t = toastProgress(file.name);
    try { await api(`/files/upload?path=${encodeURIComponent(join(cwd, file.name))}&overwrite=false`, { method: 'PUT', raw: file }); t(`Uploaded ${file.name}`, 'ok'); }
    catch (e) { if (e.status === 409 && (await confirmDialog({ title: 'Overwrite file?', message: `${file.name} already exists.`, danger: true, confirmText: 'Overwrite' }))) { try { await api(`/files/upload?path=${encodeURIComponent(join(cwd, file.name))}&overwrite=true`, { method: 'PUT', raw: file }); t(`Uploaded ${file.name}`, 'ok'); } catch (e2) { t(e2.message, 'error'); } } else t(e.message, 'error'); }
  }
  const toastProgress = (name) => { toast(`Uploading ${name}…`); return (m, t) => toast(m, t); };

  function draw() {
    crumbs.replaceChildren(h('a', { href: '#', onclick: (e) => { e.preventDefault(); load(''); } }, 'Roots'), ...(cwd ? cwd.split('/').filter(Boolean).flatMap((p, i, a) => [' / ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); load('/' + a.slice(0, i + 1).join('/')); } }, p)]) : []));
    if (!cwd) { box.replaceChildren(roots.length ? h('table', null, h('tbody', null, ...roots.map((r) => h('tr', null, h('td', null, h('a', { href: '#', onclick: (e) => { e.preventDefault(); load(r); } }, '📁 ' + r)))))) : empty('No permitted directories. The host agent must be running and configured with file roots.')); return; }
    zipHere.style.display = cwd ? '' : 'none';
    const hiddenCount = items.filter((i) => i.name.startsWith('.')).length;
    const rows = items.filter((i) => (showHidden || !i.name.startsWith('.')) && (!q || i.name.toLowerCase().includes(q))).sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
    const parent = cwd.replace(/\/[^/]*$/, '') || '/';
    box.replaceChildren(!showHidden && hiddenCount ? h('div', { class: 'small muted', style: { marginBottom: '6px' } }, `${hiddenCount} hidden item(s) not shown — enable “Show hidden files” to see them.`) : null, h('table', null, h('thead', null, h('tr', null, ...['Name', 'Size', 'Modified', 'Mode', 'Owner', ''].map((x) => h('th', null, x)))), h('tbody', null,
      !roots.includes(cwd) ? h('tr', null, h('td', { colspan: 6 }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); load(roots.some((r) => parent.startsWith(r)) ? parent : ''); } }, '⬑ ..'))) : null,
      ...rows.map((i) => h('tr', null,
        h('td', null, i.type === 'dir' ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); load(i.path); } }, '📁 ' + i.name) : h('a', { href: '#', onclick: (e) => { e.preventDefault(); edit(i.path); } }, '📄 ' + i.name), i.symlink ? h('span', { class: 'muted small' }, ' → ' + i.target) : null),
        h('td', null, i.type === 'dir' ? '—' : bytes(i.size)), h('td', { class: 'small' }, when(i.mtime)), h('td', { class: 'mono small' }, i.mode), h('td', { class: 'small' }, `${i.owner}:${i.group}`),
        h('td', { class: 'nowrap' }, i.type === 'dir' ? [h('button', { class: 'btn sm', onclick: () => zipDownload(i.path, i.name) }, 'ZIP'), ' '] : null, i.type === 'file' ? [h('button', { class: 'btn sm', onclick: () => edit(i.path) }, 'Edit'), ' ', h('a', { class: 'btn sm', href: '/api/files/download?path=' + encodeURIComponent(i.path) }, 'Download'), ' '] : null,
          h('button', { class: 'btn sm', onclick: async () => { const n = await promptDialog({ title: 'Rename / move', label: 'New full path', value: i.path }); if (n && n !== i.path) try { await post('/files/rename', { from: i.path, to: n }); load(cwd); } catch (e) { errToast(e); } } }, 'Rename'), ' ',
          h('button', { class: 'btn sm', onclick: () => { clipboard = { path: i.path, name: i.name, cut: false }; pasteBtn.style.display = ''; toast('Copied — open a folder and press Paste'); } }, 'Copy'), ' ',
          h('button', { class: 'btn sm', onclick: () => { clipboard = { path: i.path, name: i.name, cut: true }; pasteBtn.style.display = ''; toast('Cut — open a folder and press Paste'); } }, 'Move'), ' ',
          h('button', { class: 'btn sm', onclick: async () => { const m = await promptDialog({ title: 'Change permissions', label: 'Octal mode', value: i.mode }); if (m) try { await post('/files/chmod', { path: i.path, mode: m }); load(cwd); } catch (e) { errToast(e); } } }, 'Chmod'), ' ',
          h('button', { class: 'btn sm danger', onclick: async () => {
            const rec = i.type === 'dir';
            if (!(await confirmDialog({ title: `Delete ${i.name}`, danger: true, confirmText: 'Delete', message: rec ? 'This folder and everything inside it will be permanently deleted.' : 'This file will be permanently deleted.', requireText: rec ? i.name : undefined }))) return;
            try { await del(`/files?path=${encodeURIComponent(i.path)}&confirm=true&recursive=${rec}`); toast('Deleted', 'ok'); load(cwd); } catch (e) { if (e.code === 'not_empty') errToast(e); else errToast(e); } } }, 'Delete')))))));
  }
  async function load(path) {
    cwd = path; if (path) localStorage.setItem('serveros.cwd', path); else localStorage.removeItem('serveros.cwd');
    if (!path) { try { roots = (await get('/settings')).fileRoots; const s = (await get('/settings')).settings['files.roots']; if (Array.isArray(s) && s.length) roots = roots.filter((r) => s.some((x) => r === x || r.startsWith(x + '/') || x.startsWith(r + '/'))).length ? s : roots; } catch (e) { box.replaceChildren(errBox(e)); return; } draw(); return; }
    box.replaceChildren(loading());
    try { const r = await get('/files/list?path=' + encodeURIComponent(path)); items = r.items; roots = r.roots; cwd = r.path; draw(); } catch (e) { box.replaceChildren(errBox(e), h('button', { class: 'btn', style: { marginTop: '10px' }, onclick: () => load('') }, 'Back to roots')); }
  }
  roots = (state.caps?.fileRoots) || [];
  box.append(loading()); await load(cwd);
}

async function zipDownload(path, name) {
  try {
    const info = await get('/files/zip-info?path=' + encodeURIComponent(path));
    if (info.size > 500 * 1048576 && !(await confirmDialog({ title: 'Large folder', message: `${name} contains ${info.files} files (about ${bytes(info.size)} before compression). Download as ZIP?`, confirmText: 'Download' }))) return;
    const a = h('a', { href: '/api/files/download-zip?path=' + encodeURIComponent(path), download: name + '.zip' });
    document.body.append(a); a.click(); a.remove();
    toast(`Preparing ${name}.zip — ${info.files} files, ${bytes(info.size)} (the ZIP is streamed, nothing is stored on the server)`, 'ok', 6000);
  } catch (e) { errToast(e); }
}

export function edit(path) {
  const host = h('div', { style: { height: '60vh', border: '1px solid var(--line)', borderRadius: '10px' } }); const dirty = h('span', { class: 'badge warn', style: { display: 'none' } }, 'unsaved changes'); let ed, sha;
  const save = h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => { const r = await put('/files/write', { path, content: ed.get(), expectedSha256: sha }); sha = undefined; ed.markSaved(); toast('Saved', 'ok'); }) }, 'Save');
  const m = modal({ title: path, wide: true, body: h('div', { class: 'form' }, h('div', { class: 'row' }, save, dirty, h('span', { class: 'muted small' }, 'Ctrl/Cmd+S to save · Ctrl/Cmd+F to find · Ctrl/Cmd+H to replace')), host), onClose: () => ed?.dispose() });
  get('/files/read?path=' + encodeURIComponent(path)).then(async (f) => { sha = f.sha256; ed = await createEditor(host, { value: f.content, language: langFor(path), onDirty: (d) => { dirty.style.display = d ? '' : 'none'; } }); ed.editor.addCommand(ed.monaco.KeyMod.CtrlCmd | ed.monaco.KeyCode.KeyS, () => save.click()); })
    .catch((e) => { host.replaceChildren(errBox(e)); });
  void m;
}
void badge;
