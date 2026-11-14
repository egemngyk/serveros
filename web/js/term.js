import { h, loadScript, openSocket } from './lib.js';

/** Interactive terminal bound to a websocket endpoint. Returns {el, dispose, fit}. */
export function createTerminal(path, params, { onReady, onExit } = {}) {
  const host = h('div', { class: 'term' }); let ctrl = false; let sock;
  const send = (d) => sock?.json({ type: 'input', data: d });
  const ctrlBtn = h('button', { onclick: () => { ctrl = !ctrl; ctrlBtn.classList.toggle('on', ctrl); term?.focus(); } }, 'Ctrl');
  const key = (label, seq) => h('button', { onclick: () => { send(seq); term?.focus(); } }, label);
  const keys = h('div', { class: 'termkeys' }, key('Esc', '\x1b'), key('Tab', '\t'), ctrlBtn, key('↑', '\x1b[A'), key('↓', '\x1b[B'), key('←', '\x1b[D'), key('→', '\x1b[C'), key('Home', '\x1b[H'), key('End', '\x1b[F'), key('|', '|'), key('/', '/'), key('~', '~'), key('-', '-'), key('^C', '\x03'), key('^D', '\x04'));
  const wrap = h('div', { class: 'termwrap' }, host, keys);
  let term, fit, ro, disposed = false;
  const status = (m) => term?.write(`\r\n\x1b[90m[${m}]\x1b[0m\r\n`);
  const boot = async () => {
    await loadScript('/vendor/xterm/lib/xterm.js'); await loadScript('/vendor/xterm-fit/addon-fit.js');
    if (disposed) return;
    term = new window.Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', theme: { background: '#0b0e13' }, scrollback: 5000, convertEol: false });
    fit = new window.FitAddon.FitAddon(); term.loadAddon(fit); term.open(host);
    const doFit = () => { try { fit.fit(); } catch { /* hidden */ } };
    doFit();
    ro = new ResizeObserver(() => { doFit(); sock?.json({ type: 'resize', cols: term.cols, rows: term.rows }); }); ro.observe(host);
    let first = true;
    sock = openSocket(path, () => ({ ...(typeof params === 'function' ? params() : params), cols: term.cols, rows: term.rows }), {
      open: () => { if (!first) status('reconnected — new session'); first = false; },
      message: (e) => {
        if (typeof e.data === 'string') { const m = JSON.parse(e.data); if (m.type === 'ready') onReady?.(m); else if (m.type === 'error') status('error: ' + m.message); else if (m.type === 'exit') { status('session ended'); onExit?.(m); } }
        else term.write(new Uint8Array(e.data));
      },
      close: (e) => { if (!disposed && e.code !== 1000) status(`disconnected (${e.code}) — reconnecting…`); },
      giveUp: () => status('could not reconnect'),
    }, { reconnect: true });
    term.onData((d) => { if (ctrl && d.length === 1) { const c = d.toUpperCase().charCodeAt(0); if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64); ctrl = false; ctrlBtn.classList.remove('on'); } sock.json({ type: 'input', data: d }); });
    term.focus();
  };
  boot().catch((e) => host.append(h('div', { class: 'err' }, e.message)));
  return { el: wrap, fit: () => { try { fit?.fit(); } catch { /* ignore */ } }, focus: () => term?.focus(), dispose() { disposed = true; ro?.disconnect(); sock?.close(); term?.dispose(); } };
}
