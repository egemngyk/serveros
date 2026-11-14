import { Router } from 'express';
import { wrap, v, bad, conflict, STACK_RE } from '../lib/util.js';
import { act, audit } from '../services/audit.js';

export function stackRoutes(env) {
  const r = Router();
  const c = env.compose;
  const nm = (req) => v.str(req.params.name, 'name', { re: STACK_RE });
  r.get('/', wrap(async () => ({ compose: await c.available(), stacks: await c.list() })));
  r.post('/', wrap((req) => act(req, 'stack.create', req.body?.name, () => c.create(v.str(req.body?.name, 'name', { re: STACK_RE }), req.body?.content, req.body?.env))));
  r.get('/:name/file', wrap((req) => c.read(nm(req))));
  r.put('/:name/file', wrap((req) => act(req, 'stack.edit', nm(req), () => c.write(nm(req), { content: req.body?.content, env: req.body?.env }))));
  r.post('/:name/validate', wrap((req) => c.validate(nm(req))));
  r.get('/:name/ps', wrap((req) => c.ps(nm(req))));
  r.get('/:name/impact', wrap((req) => c.impact(nm(req), String(req.query.op))));
  r.post('/:name/run', async (req, res, next) => {
    try {
      const name = nm(req);
      const op = v.oneOf(req.body?.op, 'op', ['up', 'down', 'stop', 'start', 'restart', 'pull', 'recreate']);
      if (['down', 'recreate', 'restart', 'stop'].includes(op) && req.body?.confirm !== true) throw bad('Explicit confirmation required for this operation');
      const proj = await c.resolve(name);
      if (proj.self && op !== 'pull' && req.body?.confirmSelf !== true) throw conflict('This stack contains the ServerOS dashboard itself. Confirm explicitly: the operation may cut your session.', 'self_action');
      res.setHeader('Content-Type', 'application/x-ndjson'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Accel-Buffering', 'no');
      const code = await c.run(name, op, req.body?.services || [], (line) => res.write(JSON.stringify({ line }) + '\n'));
      res.write(JSON.stringify({ done: true, code }) + '\n');
      audit(req, `stack.${op}`, name, code === 0 ? 'ok' : 'error', { exitCode: code });
      res.end();
    } catch (e) { if (res.headersSent) res.end(); else next(e); }
  });
  r.delete('/:name', wrap((req) => { if (req.query.confirm !== 'true') throw bad('Confirmation required'); return act(req, 'stack.remove', nm(req), () => c.remove(nm(req))); }));
  return r;
}
