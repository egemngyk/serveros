import net from 'node:net';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { HttpError } from '../lib/util.js';

export const T_DATA = 0, T_CTRL = 1, T_EXIT = 2;

export function frame(type, payload) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '');
  const h = Buffer.alloc(5);
  h[0] = type;
  h.writeUInt32BE(p.length, 1);
  return Buffer.concat([h, p]);
}

function unavailable(msg) { return new HttpError(503, msg, 'agent_unavailable'); }

function mapError(e) {
  return new HttpError(e?.status || 400, e?.message || 'Agent error', e?.code || 'agent_error', e?.details);
}

export class AgentClient {
  constructor() { this._info = null; this._infoAt = 0; }

  token() {
    try { return fs.readFileSync(config.agentTokenFile, 'utf8').trim(); } catch { return null; }
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const t = this.token();
      if (!t) return reject(unavailable('Host agent is not configured (token file is missing). Run install.sh on the host.'));
      const s = net.createConnection(config.agentSocket);
      s.once('connect', () => resolve({ s, t }));
      s.once('error', (e) => reject(unavailable(`Host agent is unreachable (${e.code || e.message}). Is serveros-agent running?`)));
    });
  }

  async call(op, args = {}, { timeout = 60000 } = {}) {
    const { s, t } = await this._connect();
    return new Promise((resolve, reject) => {
      let buf = '';
      let settled = false;
      const done = (fn, val) => { if (settled) return; settled = true; clearTimeout(timer); s.destroy(); fn(val); };
      const timer = setTimeout(() => done(reject, new HttpError(504, `Host agent operation timed out: ${op}`, 'agent_timeout')), timeout);
      s.setEncoding('utf8');
      s.on('data', (d) => {
        buf += d;
        const i = buf.indexOf('\n');
        if (i < 0) return;
        try {
          const r = JSON.parse(buf.slice(0, i));
          if (r.ok) done(resolve, r.data);
          else done(reject, mapError(r.error));
        } catch { done(reject, new HttpError(502, 'Invalid response from host agent', 'agent_error')); }
      });
      s.on('error', (e) => done(reject, unavailable(`Host agent connection error: ${e.message}`)));
      s.on('close', () => done(reject, new HttpError(502, 'Host agent closed the connection', 'agent_error')));
      s.write(JSON.stringify({ token: t, op, args }) + '\n');
    });
  }

  /** Open a streaming operation. Resolves to an emitter: 'data'(Buffer) 'exit'({code}) 'close'. */
  async stream(op, args = {}) {
    const { s, t } = await this._connect();
    const ev = new EventEmitter();
    ev.write = (data) => { if (!s.destroyed) s.write(frame(T_DATA, data)); };
    ev.control = (obj) => { if (!s.destroyed) s.write(frame(T_CTRL, JSON.stringify(obj))); };
    ev.close = () => s.destroy();
    ev.pause = () => s.pause();
    ev.resume = () => s.resume();
    let buf = Buffer.alloc(0);
    let headerDone = false;
    return new Promise((resolve, reject) => {
      s.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!headerDone) {
          const i = buf.indexOf(10);
          if (i < 0) return;
          let hdr;
          try { hdr = JSON.parse(buf.subarray(0, i).toString()); } catch { s.destroy(); return reject(new HttpError(502, 'Invalid agent response', 'agent_error')); }
          buf = buf.subarray(i + 1);
          headerDone = true;
          if (!hdr.ok) { s.destroy(); return reject(mapError(hdr.error)); }
          ev.header = hdr;
          resolve(ev);
        }
        while (buf.length >= 5) {
          const len = buf.readUInt32BE(1);
          if (buf.length < 5 + len) break;
          const type = buf[0];
          const payload = buf.subarray(5, 5 + len);
          buf = buf.subarray(5 + len);
          if (type === T_DATA) ev.emit('data', payload);
          else if (type === T_CTRL) { try { ev.emit('control', JSON.parse(payload.toString())); } catch { /* ignore */ } }
          else if (type === T_EXIT) { try { ev.emit('exit', JSON.parse(payload.toString())); } catch { ev.emit('exit', { code: -1 }); } }
        }
      });
      s.on('close', () => { if (!headerDone) reject(unavailable('Host agent closed the connection')); ev.emit('close'); });
      s.on('error', (e) => { if (!headerDone) reject(unavailable(`Host agent connection error: ${e.message}`)); });
      s.write(JSON.stringify({ token: t, op, args }) + '\n');
    });
  }

  /** Cached ping; returns null when the agent is not reachable. */
  async info({ force = false } = {}) {
    if (!force && this._infoAt && Date.now() - this._infoAt < 10000) return this._info;
    try { this._info = await this.call('ping', {}, { timeout: 5000 }); } catch (e) { this._info = null; this._err = e.message; }
    this._infoAt = Date.now();
    return this._info;
  }
  lastError() { return this._err; }
  async require() {
    const i = await this.info();
    if (!i) throw unavailable(this._err || 'Host agent is not available');
    return i;
  }
}
