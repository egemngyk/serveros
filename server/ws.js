import { WebSocketServer } from 'ws';
import { lookupSession, originAllowed } from './services/auth.js';
import { audit } from './services/audit.js';
import { bus } from './services/bus.js';
import { localEnv as env } from './environments.js';
import { getSetting } from './services/settings.js';
import { ID_RE } from './lib/util.js';
import { log } from './logger.js';
import { T_DATA } from './services/agent.js';

const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
const hostTerms = new Map(); // username -> count
const ALIVE = new WeakMap();

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function closeWith(ws, code, reason) { try { ws.close(code, reason); } catch { /* ignore */ } }

export function handleUpgrade(server) {
  server.on('upgrade', (req, socket, head) => {
    const reject = (code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return reject(400, 'Bad Request'); }
    if (!url.pathname.startsWith('/ws/')) return reject(404, 'Not Found');
    // Origin validation (mandatory for browsers) + authenticated session
    if (!req.headers.origin || !originAllowed({ get: (h) => req.headers[h.toLowerCase()] })) return reject(403, 'Forbidden');
    const found = lookupSession(req.headers.cookie);
    if (!found) return reject(401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = found.user; ws.sessionCookie = req.headers.cookie; ws.ip = req.socket.remoteAddress;
      route(ws, url).catch((e) => { log.warn('ws handler error', { path: url.pathname, err: e.message }); send(ws, { type: 'error', message: e.message }); closeWith(ws, 1011, 'error'); });
    });
  });
  // periodic session re-validation + heartbeat
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!lookupSession(ws.sessionCookie)) { closeWith(ws, 4001, 'session expired'); continue; }
      if (ALIVE.get(ws) === false) { ws.terminate(); continue; }
      ALIVE.set(ws, false); try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30000).unref();
}

async function route(ws, url) {
  ALIVE.set(ws, true);
  ws.on('pong', () => ALIVE.set(ws, true));
  const q = url.searchParams;
  switch (url.pathname) {
    case '/ws/events': return events(ws);
    case '/ws/container/logs': return containerLogs(ws, q);
    case '/ws/container/terminal': return containerTerminal(ws, q);
    case '/ws/host/terminal': return hostTerminal(ws, q);
    case '/ws/logs': return systemLogs(ws, q);
    case '/ws/stack/logs': return stackLogs(ws, q);
    default: return closeWith(ws, 4404, 'unknown endpoint');
  }
}

// ---------------------------------------------------------------- events (monitoring, containers, notifications)
function events(ws) {
  const topics = new Set();
  let statsRef = false;
  const listeners = [];
  const on = (ev, fn) => { bus.on(ev, fn); listeners.push([ev, fn]); };
  on('monitor', (snap) => { if (topics.has('monitor')) send(ws, { topic: 'monitor', data: snap }); });
  on('notification', (n) => { if (topics.has('notifications')) send(ws, { topic: 'notification', data: n }); });
  on('docker.event', (e) => { if (topics.has('containers') && e.Type === 'container') send(ws, { topic: 'docker.event', data: { action: e.Action, id: e.id } }); });
  let timer = null;
  const pushContainers = async () => {
    try { send(ws, { topic: 'containers', data: await env.docker.list({ withStats: true }) }); } catch (e) { send(ws, { topic: 'containers', error: e.message }); }
  };
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type !== 'sub' || !Array.isArray(m.topics)) return;
    for (const t of m.topics) if (['monitor', 'containers', 'notifications'].includes(t)) topics.add(t);
    if (topics.has('monitor') && env.monitor.latest) send(ws, { topic: 'monitor', data: env.monitor.latest });
    if (topics.has('containers') && !timer) {
      env.docker.stats.acquire(); statsRef = true;
      const loop = async () => { await pushContainers(); if (ws.readyState === 1) timer = setTimeout(loop, env.monitor.refreshMs()); };
      loop();
    }
  });
  ws.on('close', () => {
    for (const [ev, fn] of listeners) bus.off(ev, fn);
    clearTimeout(timer);
    if (statsRef) env.docker.stats.release();
  });
}

// ---------------------------------------------------------------- container logs
async function containerLogs(ws, q) {
  const id = q.get('id');
  if (!ID_RE.test(id || '')) return closeWith(ws, 4400, 'bad id');
  const stop = await env.docker.followLogs(id, { tail: q.get('tail') ?? 100, since: q.get('since') || undefined, timestamps: q.get('timestamps') !== '0' },
    (lines) => send(ws, { type: 'lines', lines }), () => { send(ws, { type: 'end' }); closeWith(ws, 1000, 'stream ended'); });
  ws.on('close', stop);
}

// ---------------------------------------------------------------- container terminal
async function containerTerminal(ws, q) {
  const id = q.get('id');
  if (!ID_RE.test(id || '')) return closeWith(ws, 4400, 'bad id');
  const shells = await env.docker.shells(id);
  if (!shells.length) { send(ws, { type: 'error', message: 'No shell (bash/sh/ash/zsh) was found in this container. It may be a minimal/distroless image.' }); return closeWith(ws, 4501, 'no shell'); }
  const shell = q.get('shell') && shells.includes(q.get('shell')) ? q.get('shell') : shells[0];
  const cols = clamp(q.get('cols'), 80, 10, 500), rows = clamp(q.get('rows'), 24, 2, 300);
  const t = await env.docker.openTerminal(id, shell, cols, rows);
  audit({ username: ws.user.username, ip: ws.ip }, 'terminal.container.open', id, 'ok', { shell });
  send(ws, { type: 'ready', shell, shells });
  t.stream.on('data', (b) => { if (ws.readyState === 1) ws.send(b, { binary: true }); });
  t.stream.on('end', () => { send(ws, { type: 'exit' }); closeWith(ws, 1000, 'exited'); });
  t.stream.on('error', () => closeWith(ws, 1011, 'stream error'));
  ws.on('message', (data, isBinary) => {
    if (isBinary) return t.stream.write(data);
    try { const m = JSON.parse(data.toString()); if (m.type === 'resize') t.resize(clamp(m.cols, 80, 10, 500), clamp(m.rows, 24, 2, 300)); else if (m.type === 'input') t.stream.write(String(m.data)); } catch { /* ignore */ }
  });
  ws.on('close', () => { try { t.stream.end(); t.stream.destroy(); } catch { /* ignore */ } audit({ username: ws.user.username, ip: ws.ip }, 'terminal.container.close', id, 'ok'); });
}

// ---------------------------------------------------------------- host terminal (via host agent PTY)
async function hostTerminal(ws, q) {
  if (!getSetting('terminal.hostEnabled')) { send(ws, { type: 'error', message: 'The host terminal is disabled in Settings.' }); return closeWith(ws, 4403, 'disabled'); }
  const cur = hostTerms.get(ws.user.username) || 0;
  if (cur >= 6) { send(ws, { type: 'error', message: 'Too many open host terminals for this user.' }); return closeWith(ws, 4429, 'limit'); }
  const cols = clamp(q.get('cols'), 80, 10, 500), rows = clamp(q.get('rows'), 24, 2, 300);
  let s;
  try { s = await env.agent.stream('pty', { cols, rows, shell: q.get('shell') || undefined }); }
  catch (e) { send(ws, { type: 'error', message: e.message }); return closeWith(ws, 4503, 'agent'); }
  hostTerms.set(ws.user.username, cur + 1);
  const started = Date.now();
  audit({ username: ws.user.username, ip: ws.ip }, 'terminal.host.open', 'host', 'ok', { shell: s.header.shell, asUser: s.header.user }); // input is never recorded
  send(ws, { type: 'ready', shell: s.header.shell, user: s.header.user });
  s.on('data', (b) => { if (ws.readyState === 1) ws.send(b, { binary: true }); });
  s.on('exit', (e) => { send(ws, { type: 'exit', code: e.code }); closeWith(ws, 1000, 'exited'); });
  s.on('close', () => closeWith(ws, 1000, 'closed'));
  ws.on('message', (data, isBinary) => {
    if (isBinary) return s.write(data);
    try { const m = JSON.parse(data.toString()); if (m.type === 'resize') s.control({ resize: true, cols: clamp(m.cols, 80, 10, 500), rows: clamp(m.rows, 24, 2, 300) }); else if (m.type === 'input') s.write(String(m.data)); } catch { /* ignore */ }
  });
  ws.on('close', () => {
    s.close();
    hostTerms.set(ws.user.username, Math.max(0, (hostTerms.get(ws.user.username) || 1) - 1));
    audit({ username: ws.user.username, ip: ws.ip }, 'terminal.host.close', 'host', 'ok', { seconds: Math.round((Date.now() - started) / 1000) });
  });
}

// ---------------------------------------------------------------- system logs
async function systemLogs(ws, q) {
  const source = q.get('source') || '';
  if (source.startsWith('container:')) {
    const id = source.slice(10);
    if (!ID_RE.test(id)) return closeWith(ws, 4400, 'bad id');
    const stop = await env.docker.followLogs(id, { tail: q.get('lines') ?? 200, timestamps: true }, (lines) => send(ws, { type: 'lines', lines: lines.map((l) => `${l.t || ''} ${l.m}`.trim()) }), () => closeWith(ws, 1000, 'ended'));
    return ws.on('close', stop);
  }
  const s = await env.agent.stream('log_follow', { source, lines: Number(q.get('lines')) || 200, priority: q.get('priority') || undefined, since: q.get('since') || undefined });
  let rest = '';
  s.on('data', (b) => {
    const text = rest + b.toString('utf8');
    const parts = text.split('\n');
    rest = parts.pop();
    if (parts.length) send(ws, { type: 'lines', lines: parts });
  });
  s.on('exit', () => closeWith(ws, 1000, 'ended'));
  s.on('close', () => closeWith(ws, 1000, 'closed'));
  ws.on('close', () => s.close());
}

async function stackLogs(ws, q) {
  const name = q.get('name') || '';
  const stop = await env.compose.followLogs(name, { tail: q.get('tail') }, (line) => send(ws, { type: 'lines', lines: [line] }), () => closeWith(ws, 1000, 'ended'));
  ws.on('close', stop);
}

function clamp(v, d, lo, hi) { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d; }
void T_DATA;
