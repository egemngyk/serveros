import { loadScript } from './lib.js';
let ready = null;

export function loadMonaco() {
  if (ready) return ready;
  ready = (async () => {
    await loadScript('/vendor/monaco/vs/loader.js');
    self.MonacoEnvironment = { getWorkerUrl: () => '/monaco-worker.js' };
    await new Promise((res) => { window.require.config({ paths: { vs: '/vendor/monaco/vs' } }); window.require(['vs/editor/editor.main'], res); });
    const m = window.monaco;
    m.languages.register({ id: 'nginx' });
    m.languages.setMonarchTokensProvider('nginx', { tokenizer: { root: [[/#.*$/, 'comment'], [/\$[a-zA-Z_]\w*/, 'variable'], [/"[^"]*"|'[^']*'/, 'string'], [/\b(server|location|upstream|http|events|stream|if|map|geo|types|limit_except)\b(?=[^;{]*\{)/, 'keyword'], [/^\s*[a-z_][\w]*/, 'type'], [/\b\d+[kKmMgGsdhw]?\b/, 'number'], [/[{};]/, 'delimiter']] } });
    return m;
  })();
  return ready;
}
export const themeName = () => (document.documentElement.dataset.theme === 'light' ? 'vs' : 'vs-dark');

export function langFor(path) {
  const p = path.toLowerCase();
  if (/(\.ya?ml)$/.test(p)) return 'yaml'; if (/\.json$/.test(p)) return 'json'; if (/\.(sh|bash)$/.test(p)) return 'shell'; if (/\.(conf|cnf|ini|service|timer|env)$|\/\.env$/.test(p)) return /nginx|sites-|conf\.d|snippets/.test(p) ? 'nginx' : 'ini';
  if (/\.md$/.test(p)) return 'markdown'; if (/\.(js|mjs)$/.test(p)) return 'javascript'; if (/\.py$/.test(p)) return 'python'; if (/\.html?$/.test(p)) return 'html'; if (/\.css$/.test(p)) return 'css'; if (/\.xml$/.test(p)) return 'xml';
  if (/nginx|sites-(available|enabled)|snippets|conf\.d/.test(p)) return 'nginx';
  return 'plaintext';
}

/** Create an editor in `host`. Returns {editor, get, set, dirty, onDirty, dispose, diff()} */
export async function createEditor(host, { value = '', language = 'plaintext', readOnly = false, onDirty } = {}) {
  const monaco = await loadMonaco();
  const editor = monaco.editor.create(host, { value, language, theme: themeName(), automaticLayout: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, readOnly, tabSize: 2, renderWhitespace: 'selection', wordWrap: 'off', find: { addExtraSpaceOnTop: false } });
  let original = value;
  const api = {
    editor, monaco,
    get: () => editor.getValue(),
    set(v, lang) { original = v; editor.setValue(v); if (lang) monaco.editor.setModelLanguage(editor.getModel(), lang); onDirty?.(false); },
    get original() { return original; },
    markSaved() { original = editor.getValue(); onDirty?.(false); },
    get dirty() { return editor.getValue() !== original; },
    dispose() { editor.dispose(); },
  };
  editor.onDidChangeModelContent(() => onDirty?.(api.dirty));
  return api;
}

export async function createDiff(host, original, modified, language) {
  const monaco = await loadMonaco();
  const diff = monaco.editor.createDiffEditor(host, { theme: themeName(), automaticLayout: true, readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false });
  diff.setModel({ original: monaco.editor.createModel(original, language), modified: monaco.editor.createModel(modified, language) });
  return { diff, dispose() { const m = diff.getModel(); diff.dispose(); m?.original.dispose(); m?.modified.dispose(); } };
}
