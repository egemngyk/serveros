import { config } from './config.js';
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const min = LEVELS[config.logLevel] ?? 20;

function emit(level, msg, meta) {
  if (LEVELS[level] < min) return;
  const rec = { time: new Date().toISOString(), level, msg };
  if (meta) {
    for (const [k, v] of Object.entries(meta)) rec[k] = v instanceof Error ? { message: v.message, stack: v.stack } : v;
  }
  (level === 'error' ? process.stderr : process.stdout).write(JSON.stringify(rec) + '\n');
}

export const log = {
  debug: (m, x) => emit('debug', m, x),
  info: (m, x) => emit('info', m, x),
  warn: (m, x) => emit('warn', m, x),
  error: (m, x) => emit('error', m, x),
};
