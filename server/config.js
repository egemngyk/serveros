const env = process.env;

function parseTrust(v) {
  if (v === undefined || v === '') return 'loopback, linklocal, uniquelocal';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

export const config = {
  version: '1.0.0',
  port: Number(env.PORT || 8080),
  host: env.HOST || '0.0.0.0',
  dataDir: env.DATA_DIR || '/data',
  hostDataDir: env.HOST_DATA_DIR || '',
  stacksDir: env.STACKS_DIR || '/opt/serveros/stacks',
  dockerSocket: env.DOCKER_SOCKET || '/var/run/docker.sock',
  agentSocket: env.AGENT_SOCKET || '/run/serveros/agent.sock',
  agentTokenFile: env.AGENT_TOKEN_FILE || '/run/secrets/serveros-agent-token',
  hostProc: env.HOST_PROC || '/host/proc',
  hostSys: env.HOST_SYS || '/host/sys',
  hostEtc: env.HOST_ETC || '/host/etc',
  cookieSecure: env.COOKIE_SECURE || 'auto',
  trustProxy: parseTrust(env.TRUST_PROXY),
  allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  hostPort: Number(env.HOST_PORT || 8080),
  logLevel: env.LOG_LEVEL || 'info',
};

/** Map a path inside the container's /data to the path on the host (needed by the host agent). */
export function toHostDataPath(p) {
  if (!config.hostDataDir) return null;
  if (p !== config.dataDir && !p.startsWith(config.dataDir + '/')) return null;
  return config.hostDataDir + p.slice(config.dataDir.length);
}
