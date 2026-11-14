import { db } from '../db.js';
import { bad } from '../lib/util.js';

const DEFAULTS = {
  'dashboard.domains': [],
  'files.roots': null,
  'terminal.hostEnabled': true,
  'certbot.email': '',
  'monitoring.refreshSeconds': 2,
  'session.ttlHours': 24,
  'session.idleMinutes': 240,
  'backup.schedule': {
    enabled: false, frequency: 'daily', time: '03:00',
    contents: { app: true, stacks: true, nginx: true, certbot: true },
    retention: { keepLast: 7, maxAgeDays: 30 },
  },
};

const VALIDATORS = {
  'dashboard.domains': (x) => {
    if (!Array.isArray(x) || x.length > 20 || !x.every((d) => typeof d === 'string' && /^[a-z0-9.*-]{1,253}$/i.test(d))) throw bad('dashboard.domains must be a list of host names');
    return x.map((d) => d.toLowerCase());
  },
  'files.roots': (x) => {
    if (x === null) return null;
    if (!Array.isArray(x) || x.length > 30 || !x.every((d) => typeof d === 'string' && d.startsWith('/') && d.length < 512)) throw bad('files.roots must be a list of absolute paths');
    return x;
  },
  'monitoring.refreshSeconds': (x) => { if (!Number.isInteger(x) || x < 1 || x > 60) throw bad('Refresh rate must be 1-60 seconds'); return x; },
  'terminal.hostEnabled': (x) => { if (typeof x !== 'boolean') throw bad('must be boolean'); return x; },
  'certbot.email': (x) => { if (typeof x !== 'string' || (x && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))) throw bad('invalid e-mail'); return x; },
  'session.ttlHours': (x) => { if (!Number.isInteger(x) || x < 1 || x > 720) throw bad('session.ttlHours must be 1-720'); return x; },
  'session.idleMinutes': (x) => { if (!Number.isInteger(x) || x < 5 || x > 10080) throw bad('session.idleMinutes must be 5-10080'); return x; },
  'backup.schedule': (x) => {
    if (!x || typeof x !== 'object') throw bad('invalid schedule');
    const f = ['hourly', 'daily', 'weekly'];
    if (!f.includes(x.frequency)) throw bad('frequency must be hourly, daily or weekly');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(x.time || '')) throw bad('time must be HH:MM');
    const r = x.retention || {};
    if (!Number.isInteger(r.keepLast) || r.keepLast < 1 || r.keepLast > 365) throw bad('retention.keepLast must be 1-365');
    if (!Number.isInteger(r.maxAgeDays) || r.maxAgeDays < 1 || r.maxAgeDays > 3650) throw bad('retention.maxAgeDays must be 1-3650');
    const c = x.contents || {};
    return {
      enabled: !!x.enabled, frequency: x.frequency, time: x.time,
      contents: { app: !!c.app, stacks: !!c.stacks, nginx: !!c.nginx, certbot: !!c.certbot },
      retention: { keepLast: r.keepLast, maxAgeDays: r.maxAgeDays },
    };
  },
};

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return DEFAULTS[key];
  try { return JSON.parse(row.value); } catch { return DEFAULTS[key]; }
}

export function setSetting(key, value) {
  if (!(key in VALIDATORS)) throw bad(`Unknown setting: ${key}`);
  const val = VALIDATORS[key](value);
  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(key, JSON.stringify(val), Date.now());
  return val;
}

export function allSettings() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = getSetting(k);
  return out;
}

export function internalGet(key, dflt) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return dflt;
  try { return JSON.parse(row.value); } catch { return dflt; }
}
export function internalSet(key, value) {
  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(key, JSON.stringify(value), Date.now());
}
