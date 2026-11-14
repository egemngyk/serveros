import { AgentClient } from './services/agent.js';
import { DockerService } from './services/docker.js';
import { ComposeService } from './services/compose.js';
import { MonitorService } from './services/monitoring.js';
import { NginxService, CertbotService, SystemdService, FilesService, LogsService } from './services/hostops.js';
import { BackupService } from './services/backup.js';

/**
 * An Environment bundles every service for one managed host. Only the local environment exists
 * in this release; remote Docker hosts can be added by registering another Environment implementation
 * (e.g. one backed by a remote Docker endpoint + remote agent) without touching routes or services.
 */
export class LocalEnvironment {
  constructor() {
    this.id = 'local';
    this.name = 'This server';
    this.type = 'local';
    this.agent = new AgentClient();
    this.docker = new DockerService(this);
    this.compose = new ComposeService(this);
    this.monitor = new MonitorService(this);
    this.nginx = new NginxService(this);
    this.certbot = new CertbotService(this);
    this.systemd = new SystemdService(this);
    this.files = new FilesService(this);
    this.logs = new LogsService(this);
    this.backup = new BackupService(this);
  }
  async capabilities() {
    const agent = await this.agent.info();
    const dockerUp = await this.docker.ping();
    const compose = dockerUp ? await this.compose.available() : { available: false };
    return {
      docker: dockerUp, compose,
      agent: !!agent, agentError: agent ? null : this.agent.lastError(), agentVersion: agent?.version,
      host: agent ? { hostname: agent.hostname, os: agent.os, kernel: agent.kernel } : null,
      nginx: agent?.nginx ?? { installed: false }, certbot: agent?.certbot ?? { installed: false }, systemd: !!agent?.systemd,
      terminal: agent ? { user: agent.terminal.user, shells: agent.terminal.shells } : null,
      fileRoots: agent?.file_roots ?? [],
    };
  }
}

const registry = new Map([['local', new LocalEnvironment()]]);
export const getEnvironment = (id = 'local') => registry.get(id);
export const listEnvironments = () => [...registry.values()].map((e) => ({ id: e.id, name: e.name, type: e.type }));
export const localEnv = registry.get('local');
