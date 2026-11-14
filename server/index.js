import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { log } from './logger.js';
import { closeDb } from './db.js';
import { HttpError } from './lib/util.js';
import * as auth from './services/auth.js';
import { localEnv as env } from './environments.js';
import { startWatchers } from './services/watchers.js';
import { pruneNotifications } from './services/notifications.js';
import { handleUpgrade } from './ws.js';
import { publicAuth, privateAuth } from './routes/auth.js';
import { dockerRoutes } from './routes/docker.js';
import { stackRoutes } from './routes/stacks.js';
import { monitorRoutes, nginxRoutes, certbotRoutes, systemdRoutes, filesRoutes, logsRoutes } from './routes/host.js';
import { adminRoutes } from './routes/admin.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const nm = path.join(root, 'node_modules');
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// static assets (no auth needed: they contain no secrets; the API is what's protected)
app.use('/vendor/xterm', express.static(path.join(nm, '@xterm/xterm'), { maxAge: '7d' }));
app.use('/vendor/xterm-fit', express.static(path.join(nm, '@xterm/addon-fit/lib'), { maxAge: '7d' }));
app.use('/vendor/monaco', express.static(path.join(nm, 'monaco-editor/min'), { maxAge: '7d' }));
app.use(express.static(path.join(root, 'web'), { maxAge: '1h', index: 'index.html' }));

const json = express.json({ limit: '2mb' });
const api = express.Router();
api.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
// raw-body upload endpoints must not be parsed as JSON
api.use((req, res, next) => (req.path === '/files/upload' || req.path === '/backups/import' ? next() : json(req, res, next)));
api.use('/auth', publicAuth);
api.use(auth.authenticate, auth.csrfProtect);
api.use('/auth', privateAuth);
api.use('/docker', dockerRoutes(env));
api.use('/stacks', stackRoutes(env));
api.use('/monitor', monitorRoutes(env));
api.use('/nginx', nginxRoutes(env));
api.use('/certbot', certbotRoutes(env));
api.use('/services', systemdRoutes(env));
api.use('/files', filesRoutes(env));
api.use('/logs', logsRoutes(env));
api.use('/', adminRoutes(env));
api.use((req, res, next) => next(new HttpError(404, 'Not found', 'not_found')));
app.use('/api', api);

app.get('*', (req, res) => res.sendFile(path.join(root, 'web', 'index.html')));

// central error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let status = err.status || err.statusCode || 500;
  let message = err.message || 'Internal error';
  let code = err.code && typeof err.code === 'string' ? err.code : 'error';
  if (err.type === 'entity.parse.failed') { status = 400; message = 'Invalid JSON body'; code = 'bad_request'; }
  if (err.type === 'entity.too.large') { status = 413; message = 'Request body too large'; }
  if (err.code === 'ENOENT' && err.syscall === 'connect') { status = 503; message = 'Docker Engine is not reachable (is /var/run/docker.sock mounted?)'; code = 'docker_unavailable'; }
  if (err.code === 'EACCES' && err.syscall === 'connect') { status = 503; message = 'No permission to use the Docker socket (check DOCKER_GID in .env)'; code = 'docker_unavailable'; }
  if (code !== 'docker_unavailable' && !(err instanceof HttpError) && !(Number.isInteger(err.statusCode) && err.statusCode < 500) && status >= 500) {
    log.error('request failed', { method: req.method, url: req.originalUrl.split('?')[0], err });
    if (status === 500 && !err.message?.startsWith('Docker')) message = err.json?.message || 'Internal server error';
  }
  if (typeof err.json?.message === 'string') message = err.json.message;
  if (status < 400 || status > 599) status = 500;
  if (res.headersSent) return res.end();
  const body = { error: { code, message } };
  if (err.details) body.error.details = err.details;
  if (err.details?.retryAfter) res.setHeader('Retry-After', err.details.retryAfter);
  res.status(status).json(body);
});

const server = http.createServer(app);
handleUpgrade(server);
server.requestTimeout = 0; // long-lived streaming/upload requests
server.headersTimeout = 30000;

server.listen(config.port, config.host, () => {
  log.info('ServerOS listening', { host: config.host, port: config.port, version: config.version });
  auth.ensureSetupToken();
  env.docker.startBackground();
  env.monitor.start();
  env.backup.startScheduler();
  startWatchers(env);
  setInterval(() => { auth.purgeExpiredSessions(); pruneNotifications(); }, 3600000).unref();
});

function shutdown(sig) {
  log.info('Shutting down', { signal: sig });
  server.close(() => { closeDb(); process.exit(0); });
  setTimeout(() => { closeDb(); process.exit(0); }, 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log.error('unhandledRejection', { err: e instanceof Error ? e : new Error(String(e)) }));
process.on('uncaughtException', (e) => log.error('uncaughtException', { err: e }));
