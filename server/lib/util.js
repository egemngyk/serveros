export class HttpError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code || 'error';
    this.details = details;
  }
}
export const bad = (m, d) => new HttpError(400, m, 'bad_request', d);
export const notFound = (m = 'Not found') => new HttpError(404, m, 'not_found');
export const forbidden = (m = 'Forbidden') => new HttpError(403, m, 'forbidden');
export const conflict = (m, code = 'conflict', d) => new HttpError(409, m, code, d);

/** Wrap async route handlers: returned values are sent as JSON. */
export function wrap(fn) {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .then((r) => { if (r !== undefined && !res.headersSent) res.json(r); })
      .catch(next);
  };
}

export const SENSITIVE_RE = /(pass(word|wd|phrase)?|secret|token|api[_-]?key|private|credential|auth|cookie|session|pwd|salt|signature|bearer)/i;

export function redactObject(o, depth = 0) {
  if (o == null || depth > 6) return o;
  if (Array.isArray(o)) return o.map((x) => redactObject(x, depth + 1));
  if (typeof o === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(o)) out[k] = SENSITIVE_RE.test(k) ? '[redacted]' : redactObject(val, depth + 1);
    return out;
  }
  if (typeof o === 'string' && o.length > 2000) return o.slice(0, 2000) + '…';
  return o;
}

/** ["K=V"] -> [{key, value, masked}] with sensitive values replaced. */
export function maskEnv(list = []) {
  return (list || []).map((e) => {
    const i = e.indexOf('=');
    const key = i < 0 ? e : e.slice(0, i);
    const value = i < 0 ? '' : e.slice(i + 1);
    const masked = SENSITIVE_RE.test(key);
    return { key, value: masked ? '••••••••' : value, masked };
  });
}

export const v = {
  str(x, name, { min = 0, max = 4096, re } = {}) {
    if (typeof x !== 'string') throw bad(`${name} must be a string`);
    if (x.length < min || x.length > max) throw bad(`${name} must be between ${min} and ${max} characters`);
    if (x.includes('\0')) throw bad(`${name} contains invalid characters`);
    if (re && !re.test(x)) throw bad(`${name} has an invalid format`);
    return x;
  },
  int(x, name, { min = -Infinity, max = Infinity } = {}) {
    const n = typeof x === 'string' && x.trim() !== '' ? Number(x) : x;
    if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be an integer between ${min} and ${max}`);
    return n;
  },
  bool: (x) => x === true || x === 'true' || x === '1' || x === 1,
  oneOf(x, name, list) {
    if (!list.includes(x)) throw bad(`${name} must be one of: ${list.join(', ')}`);
    return x;
  },
  arr(x, name, { max = 200 } = {}) {
    if (!Array.isArray(x)) throw bad(`${name} must be an array`);
    if (x.length > max) throw bad(`${name} has too many entries`);
    return x;
  },
  obj(x, name) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw bad(`${name} must be an object`);
    return x;
  },
};

export const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
export const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
export const STACK_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const DOMAIN_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
