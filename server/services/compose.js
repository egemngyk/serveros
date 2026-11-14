import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import YAML from 'yaml';
import { config } from '../config.js';
import { HttpError, bad, conflict, notFound, STACK_RE } from '../lib/util.js';

const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
const MAX_FILE = 512 * 1024;
const DESTRUCTIVE_IMPACT = {
  up: 'Creates missing containers and recreates containers whose configuration or image changed. Unchanged containers keep running.',
  down: 'Stops and REMOVES all containers and networks of this project. Named volumes and bind-mounted data are kept (no -v flag).',
  stop: 'Stops all containers of this project. They are not removed.',
  restart: 'Restarts all containers of this project; services are briefly unavailable.',
  pull: 'Downloads newer images for all services. Running containers are not changed until you run "Recreate".',
  recreate: 'Force-recreates all containers of this project with the current configuration. Containers are replaced; volumes are kept. Services are briefly unavailable.',
  start: 'Starts existing stopped containers of this project.',
};
const inRoot = (p, roots) => roots.some((r) => p === r || p.startsWith(r.replace(/\/$/, '') + '/'));

/**
 * Three kinds of projects:
 *  - managed:  created in ServerOS, files in STACKS_DIR (visible in the container, run with the container's docker CLI)
 *  - local external: discovered via container labels, files happen to be visible in the container
 *  - remote external: files live on the host; read/written and run through the host agent (needs the directory in agent "file_roots")
 */
export class ComposeService {
  constructor(env) { this.env = env; }

  dirFor(name) {
    if (!STACK_RE.test(name)) throw bad('Invalid stack name (lowercase letters, digits, - and _)');
    return path.join(config.stacksDir, name);
  }
  fileFor(dir) { for (const n of COMPOSE_NAMES) { const p = path.join(dir, n); if (fs.existsSync(p)) return p; } return null; }
  roots() { return this.env.files.roots(); }

  async available() {
    return new Promise((resolve) => {
      execFile('docker', ['compose', 'version', '--short'], { timeout: 8000 }, (err, out) => resolve(err ? { available: false, error: 'Docker Compose V2 plugin not found in the container' } : { available: true, version: out.trim() }));
    });
  }

  async agentRoots() {
    const info = await this.env.agent.info().catch(() => null);
    if (!info) return [];
    const sel = this.roots();
    return (info.file_roots || []).filter((r) => !sel || sel.some((x) => r === x || r.startsWith(x.replace(/\/$/, '') + '/') || x.startsWith(r.replace(/\/$/, '') + '/')));
  }

  async list() {
    const containers = await this.env.docker.list({ force: true });
    const roots = await this.agentRoots();
    const projects = new Map();
    const dirs = fs.existsSync(config.stacksDir) ? fs.readdirSync(config.stacksDir, { withFileTypes: true }).filter((d) => d.isDirectory() && STACK_RE.test(d.name)) : [];
    for (const d of dirs) {
      const file = this.fileFor(path.join(config.stacksDir, d.name));
      projects.set(d.name, { name: d.name, managed: true, remote: false, dir: path.join(config.stacksDir, d.name), file, services: [], manageable: !!file, self: false });
    }
    for (const c of containers) {
      if (!c.project) continue;
      let p = projects.get(c.project);
      if (!p) {
        const info = await this.env.docker.d.getContainer(c.id).inspect().catch(() => null);
        const wd = info?.Config?.Labels?.['com.docker.compose.project.working_dir'] || null;
        const cf = info?.Config?.Labels?.['com.docker.compose.project.config_files'] || null;
        const files = cf ? cf.split(',') : [];
        const local = !!(wd && files.length && fs.existsSync(wd) && files.every((f) => fs.existsSync(f)));
        const remote = !local && !!(wd && files.length && inRoot(wd, roots) && files.every((f) => inRoot(f, roots)));
        let reason;
        if (!local && !remote) {
          reason = !wd ? 'This project did not record its directory, so it can only be viewed.'
            : roots.length ? `Project directory ${wd} is not inside the permitted file roots. Add it to "file_roots" in /etc/serveros/agent.json on the host and restart serveros-agent.`
              : 'The host agent is not available, so the project files on the host cannot be reached.';
        }
        p = { name: c.project, managed: false, remote, dir: wd, file: cf, services: [], manageable: local || remote, reason, self: false };
        projects.set(c.project, p);
      }
      if (c.self) p.self = true;
      p.services.push({ service: c.service, container: c.name, state: c.state, health: c.health, image: c.image });
    }
    return [...projects.values()].map((p) => {
      const running = p.services.filter((s) => s.state === 'running').length;
      return { ...p, running, total: p.services.length, state: !p.services.length ? 'down' : running === p.services.length ? 'running' : running ? 'partial' : 'stopped' };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  async resolve(name) {
    const p = (await this.list()).find((x) => x.name === name);
    if (!p) throw notFound('Stack not found');
    if (!p.manageable || !p.file || !p.dir) throw conflict(p.reason || 'This stack cannot be managed from here', 'not_manageable');
    return p;
  }

  create(name, content, envContent) {
    const dir = this.dirFor(name);
    if (fs.existsSync(dir)) throw conflict('A stack with this name already exists');
    this.validateYaml(content);
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    fs.writeFileSync(path.join(dir, 'compose.yaml'), content, { mode: 0o640 });
    if (envContent) fs.writeFileSync(path.join(dir, '.env'), envContent, { mode: 0o600 });
    return { name };
  }

  validateYaml(content) {
    if (typeof content !== 'string' || !content.trim()) throw bad('Compose file is empty');
    if (content.length > MAX_FILE) throw bad('Compose file is too large');
    const doc = YAML.parseDocument(content);
    if (doc.errors.length) throw bad('YAML syntax error: ' + doc.errors[0].message);
    const js = doc.toJS();
    if (!js || typeof js !== 'object' || !js.services || typeof js.services !== 'object') throw bad('Compose file must define a "services" section');
    return js;
  }

  agentArgs(p, extra = {}) { return { dir: p.dir, project: p.name, files: p.file.split(','), roots: this.roots(), ...extra }; }
  primary(p) { return p.file.split(',')[0]; }

  async read(name) {
    const p = await this.resolve(name);
    const file = this.primary(p);
    if (p.remote) {
      const f = await this.env.agent.call('fs_read', { path: file, roots: this.roots() });
      let env = '';
      try { env = (await this.env.agent.call('fs_read', { path: path.posix.join(p.dir, '.env'), roots: this.roots() })).content; } catch (e) { if (e.code !== 'not_found') throw e; }
      return { name, file, content: f.content, env, managed: false, remote: true, self: p.self };
    }
    const content = fs.readFileSync(file, 'utf8');
    const envFile = path.join(p.dir, '.env');
    return { name, file, content, env: fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '', managed: p.managed, remote: false, self: p.self };
  }

  async write(name, { content, env }) {
    const p = await this.resolve(name);
    this.validateYaml(content);
    const file = this.primary(p);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (env !== undefined && (typeof env !== 'string' || env.length > MAX_FILE)) throw bad('Invalid env file');
    if (p.remote) {
      const a = this.env.agent; const roots = this.roots();
      await a.call('fs_copy', { from: file, to: `${file}.bak-${stamp}`, roots });
      await a.call('fs_write', { path: file, content, roots });
      if (env !== undefined) {
        const ef = path.posix.join(p.dir, '.env');
        try { await a.call('fs_copy', { from: ef, to: `${ef}.bak-${stamp}`, roots }); } catch (e) { if (e.code !== 'not_found') throw e; }
        await a.call('fs_write', { path: ef, content: env, create: true, roots });
      }
      return { saved: true, backup: `${path.basename(file)}.bak-${stamp}` };
    }
    fs.copyFileSync(file, `${file}.bak-${stamp}`); // never lose the previous version
    fs.writeFileSync(file, content, { mode: 0o640 });
    if (env !== undefined) {
      const ef = path.join(p.dir, '.env');
      if (fs.existsSync(ef)) fs.copyFileSync(ef, `${ef}.bak-${stamp}`);
      if (env.trim()) fs.writeFileSync(ef, env, { mode: 0o600 }); else if (fs.existsSync(ef)) fs.unlinkSync(ef);
    }
    return { saved: true, backup: `${path.basename(file)}.bak-${stamp}` };
  }

  baseArgs(p) { return ['compose', '-p', p.name, '--project-directory', p.dir, ...p.file.split(',').flatMap((f) => ['-f', f])]; }

  async validate(name) {
    const p = await this.resolve(name);
    if (p.remote) {
      const r = await this.env.agent.call('compose_check', this.agentArgs(p, { action: 'config' }), { timeout: 70000 });
      return { valid: r.code === 0, output: (r.stderr || r.stdout || '').trim() };
    }
    return new Promise((resolve) => {
      execFile('docker', [...this.baseArgs(p), 'config', '-q'], { cwd: p.dir, timeout: 30000, maxBuffer: 1 << 20 }, (err, out, errout) => resolve({ valid: !err, output: (errout || out || '').trim() }));
    });
  }

  async impact(name, op) {
    const p = await this.resolve(name);
    if (!DESTRUCTIVE_IMPACT[op]) throw bad('Unknown operation');
    const selfWarn = p.self && op !== 'pull' ? 'WARNING: this stack contains the ServerOS dashboard itself. The operation may stop or recreate it, which cuts this session and aborts the live output. ' : '';
    return { op, description: selfWarn + DESTRUCTIVE_IMPACT[op], destructive: ['down', 'recreate', 'restart', 'stop'].includes(op) || (p.self && op !== 'pull'), self: p.self, containers: p.services.map((s) => `${s.container} (${s.state})`), keepsVolumes: true };
  }

  commandFor(op, services) {
    const svc = (services || []).map((s) => { if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(s)) throw bad('Invalid service name'); return s; });
    switch (op) {
      case 'up': return ['up', '-d', ...svc];
      case 'down': return ['down'];
      case 'stop': return ['stop', ...svc];
      case 'start': return ['start', ...svc];
      case 'restart': return ['restart', ...svc];
      case 'pull': return ['pull', ...svc];
      case 'recreate': return ['up', '-d', '--force-recreate', ...svc];
      default: throw bad('Unknown operation');
    }
  }

  /** Run an operation, streaming output lines to onLine; resolves with the exit code. */
  async run(name, op, services, onLine) {
    const p = await this.resolve(name);
    this.commandFor(op, services); // validate early
    if (p.remote) {
      const s = await this.env.agent.stream('compose', this.agentArgs(p, { op, services: services || [] }));
      onLine('(running on the host through the ServerOS agent)');
      return new Promise((resolve) => {
        let buf = '';
        s.on('data', (b) => { buf += b.toString('utf8'); const parts = buf.split(/\r?\n/); buf = parts.pop(); parts.filter(Boolean).forEach(onLine); });
        s.on('exit', (e) => { if (buf) onLine(buf); resolve(e.code ?? 1); });
        s.on('close', () => resolve(1));
      });
    }
    const args = [...this.baseArgs(p), ...this.commandFor(op, services)];
    onLine(`$ docker ${args.join(' ')}`);
    return new Promise((resolve) => {
      const child = spawn('docker', args, { cwd: p.dir, env: { ...process.env, COMPOSE_ANSI: 'never', COMPOSE_PROGRESS: 'plain' } });
      const feed = (b) => b.toString().split(/\r?\n/).filter(Boolean).forEach(onLine);
      child.stdout.on('data', feed); child.stderr.on('data', feed);
      child.on('error', (e) => { onLine(`error: ${e.message}`); resolve(127); });
      child.on('close', (code) => resolve(code ?? 1));
    });
  }

  async ps(name) {
    const p = await this.resolve(name);
    const parse = (out) => out.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      .map((r) => ({ service: r.Service, name: r.Name, state: r.State, status: r.Status, health: r.Health, image: r.Image }));
    if (p.remote) {
      const r = await this.env.agent.call('compose_check', this.agentArgs(p, { action: 'ps' }), { timeout: 70000 });
      if (r.code !== 0) throw new HttpError(500, (r.stderr || 'docker compose ps failed').trim().slice(0, 500));
      return parse(r.stdout);
    }
    return new Promise((resolve, reject) => {
      execFile('docker', [...this.baseArgs(p), 'ps', '-a', '--format', 'json'], { cwd: p.dir, timeout: 30000, maxBuffer: 4 << 20 }, (err, out, errout) => {
        if (err) return reject(new HttpError(500, (errout || err.message).trim().slice(0, 500)));
        resolve(parse(out));
      });
    });
  }

  /** Stream project logs; returns a stop function. */
  async followLogs(name, { tail = 100 }, onLine, onEnd) {
    const p = await this.resolve(name);
    const n = Math.max(0, Math.min(Number(tail) || 100, 5000));
    if (p.remote) {
      const s = await this.env.agent.stream('compose', this.agentArgs(p, { op: 'logs', tail: n }));
      let buf = '';
      s.on('data', (b) => { buf += b.toString('utf8'); const parts = buf.split(/\r?\n/); buf = parts.pop(); parts.filter(Boolean).forEach(onLine); });
      s.on('close', () => onEnd?.());
      return () => s.close();
    }
    const args = [...this.baseArgs(p), 'logs', '-f', '--no-color', '--timestamps', '--tail', String(n)];
    const child = spawn('docker', args, { cwd: p.dir });
    const feed = (b) => b.toString().split(/\r?\n/).filter(Boolean).forEach(onLine);
    child.stdout.on('data', feed); child.stderr.on('data', feed);
    child.on('close', () => onEnd?.());
    return () => child.kill('SIGTERM');
  }

  /** Remove a stack definition. Containers must be gone; files are moved to trash, never deleted. */
  async remove(name) {
    const p = (await this.list()).find((x) => x.name === name);
    if (!p || !p.managed) throw notFound('Managed stack not found');
    if (p.total > 0) throw conflict('The stack still has containers. Run "Down" first.', 'stack_has_containers');
    const trash = path.join(config.dataDir, 'trash');
    fs.mkdirSync(trash, { recursive: true, mode: 0o700 });
    const dest = path.join(trash, `${name}-${Date.now()}`);
    fs.cpSync(p.dir, dest, { recursive: true });
    fs.rmSync(p.dir, { recursive: true });
    return { movedTo: dest };
  }
}
