import { Router } from 'express';
import { wrap, v, bad, ID_RE, NAME_RE } from '../lib/util.js';
import { act, audit } from '../services/audit.js';

export function dockerRoutes(env) {
  const r = Router();
  const d = env.docker;
  const id = (req) => v.str(req.params.id, 'id', { re: ID_RE });

  r.get('/overview', wrap(() => d.overview()));
  r.get('/containers', wrap((req) => d.list({ force: req.query.force === '1', withStats: req.query.stats === '1' })));
  r.post('/containers', wrap((req) => act(req, 'container.create', req.body?.name || req.body?.image, () => d.create(req.body || {}), { image: req.body?.image })));
  r.post('/containers/bulk', wrap(async (req) => {
    const ids = v.arr(req.body?.ids, 'ids', { max: 100 }).map((x) => v.str(x, 'id', { re: ID_RE }));
    const action = v.oneOf(req.body?.action, 'action', ['start', 'stop', 'restart', 'pause', 'unpause', 'kill', 'remove']);
    if (['kill', 'remove'].includes(action) && req.body?.confirm !== true) throw bad('Explicit confirmation is required');
    const results = [];
    for (const x of ids) {
      try { await d.action(x, action, { force: v.bool(req.body?.force), confirmSelf: v.bool(req.body?.confirmSelf) }); results.push({ id: x, ok: true }); audit(req, `container.${action}`, x, 'ok', { bulk: true }); }
      catch (e) { results.push({ id: x, ok: false, error: e.message }); audit(req, `container.${action}`, x, 'error', { bulk: true, error: e.message }); }
    }
    return { results };
  }));
  r.get('/containers/:id', wrap((req) => d.inspect(id(req))));
  r.post('/containers/:id/:action', wrap((req) => {
    const action = v.oneOf(req.params.action, 'action', ['start', 'stop', 'restart', 'pause', 'unpause', 'kill']);
    return act(req, `container.${action}`, id(req), () => d.action(id(req), action, { confirmSelf: v.bool(req.body?.confirmSelf) }));
  }));
  r.delete('/containers/:id', wrap((req) => {
    if (req.body?.confirm !== true && req.query.confirm !== 'true') throw bad('Explicit confirmation is required to remove a container');
    return act(req, 'container.remove', id(req), () => d.action(id(req), 'remove', { force: v.bool(req.query.force), confirmSelf: v.bool(req.query.confirmSelf) }), { volumesRemoved: false });
  }));
  r.post('/containers/:id/rename', wrap((req) => act(req, 'container.rename', id(req), () => d.rename(id(req), v.str(req.body?.name, 'name', { re: NAME_RE })), { name: req.body?.name })));
  r.put('/containers/:id/settings', wrap((req) => act(req, 'container.settings', id(req), () => d.updateSettings(id(req), req.body || {}), { keys: Object.keys(req.body || {}) })));
  r.post('/containers/:id/recreate', wrap((req) => act(req, 'container.recreate', id(req), () => d.recreate(id(req), { env: req.body?.env, image: req.body?.image, removeOld: v.bool(req.body?.removeOld), confirmSelf: v.bool(req.body?.confirmSelf) }), { envChanged: !!req.body?.env, image: req.body?.image })));
  r.get('/containers/:id/logs', wrap(async (req, res) => {
    const lines = await d.logs(id(req), { tail: req.query.tail ?? 200, since: req.query.since, until: req.query.until, timestamps: req.query.timestamps !== '0' });
    if (req.query.download === '1') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${String(req.params.id).replace(/[^\w.-]/g, '')}.log"`);
      res.send(lines.map((l) => `${l.t ? l.t + ' ' : ''}${l.m}`).join('\n') + '\n');
      return undefined;
    }
    return { lines };
  }));
  r.get('/containers/:id/stats', wrap((req) => ({ latest: d.stats.latest.get(d.stats.latest.has(id(req)) ? id(req) : [...d.stats.latest.keys()].find((k) => k.startsWith(id(req)))) || null, history: d.statsHistory([...d.stats.history.keys()].find((k) => k.startsWith(id(req))) || id(req)) })));
  r.get('/containers/:id/shells', wrap(async (req) => ({ shells: await d.shells(id(req)) })));

  // images
  r.get('/images', wrap(() => d.images()));
  r.get('/images/unused', wrap(() => d.unusedImages()));
  r.post('/images/pull', async (req, res, next) => {
    try {
      const image = v.str(req.body?.image, 'image', { min: 1, max: 255 });
      res.setHeader('Content-Type', 'application/x-ndjson'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Accel-Buffering', 'no');
      const write = (o) => res.write(JSON.stringify(o) + '\n');
      try { await d.pull(image, (e) => write({ progress: { id: e.id, status: e.status, detail: e.progressDetail, text: e.progress } })); write({ done: true }); audit(req, 'image.pull', image, 'ok'); }
      catch (e) { write({ error: e.message }); audit(req, 'image.pull', image, 'error', { error: e.message }); }
      res.end();
    } catch (e) { if (res.headersSent) res.end(); else next(e); }
  });
  r.post('/images/prune', wrap((req) => {
    if (req.body?.confirm !== true) throw bad('Explicit confirmation required');
    return act(req, 'image.prune', req.body?.ids ? `${req.body.ids.length} images` : 'dangling', () => d.pruneImages({ all: v.bool(req.body?.all), ids: req.body?.ids }));
  }));
  r.get('/images/:id(*)/inspect', wrap((req) => d.imageInspect(req.params.id)));
  r.delete('/images/:id(*)', wrap((req) => act(req, 'image.remove', req.params.id, () => d.imageRemove(req.params.id, { force: v.bool(req.query.force) }))));

  // volumes
  r.get('/volumes', wrap((req) => d.volumes({ usage: req.query.usage === '1' })));
  r.post('/volumes', wrap((req) => act(req, 'volume.create', req.body?.name, () => d.volumeCreate(req.body || {}))));
  r.get('/volumes/:name/inspect', wrap((req) => d.volumeInspect(req.params.name)));
  r.delete('/volumes/:name', wrap((req) => {
    if (req.query.confirm !== 'true') throw bad('Explicit confirmation required: removing a volume permanently deletes its data');
    return act(req, 'volume.remove', req.params.name, () => d.volumeRemove(req.params.name));
  }));

  // networks
  r.get('/networks', wrap(() => d.networks()));
  r.post('/networks', wrap((req) => act(req, 'network.create', req.body?.name, () => d.networkCreate(req.body || {}))));
  r.get('/networks/:id', wrap((req) => d.networkInspect(req.params.id)));
  r.delete('/networks/:id', wrap((req) => act(req, 'network.remove', req.params.id, () => d.networkRemove(req.params.id))));
  return r;
}
