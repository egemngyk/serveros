CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at INTEGER NOT NULL,
  last_login INTEGER
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE user_prefs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  rule_key TEXT,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_notifications_ts ON notifications(ts);

CREATE TABLE alert_rules (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  metric TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  threshold REAL NOT NULL DEFAULT 0,
  duration_s INTEGER NOT NULL DEFAULT 0,
  cooldown_s INTEGER NOT NULL DEFAULT 1800
);
INSERT INTO alert_rules (key, name, kind, metric, enabled, threshold, duration_s, cooldown_s) VALUES
  ('cpu_high', 'High CPU usage (%)', 'metric', 'cpu', 1, 90, 120, 1800),
  ('mem_high', 'High memory usage (%)', 'metric', 'mem', 1, 90, 120, 1800),
  ('swap_high', 'High swap usage (%)', 'metric', 'swap', 0, 80, 300, 3600),
  ('disk_usage', 'High disk usage (%)', 'metric', 'disk_pct', 1, 85, 0, 21600),
  ('disk_free', 'Low free disk space (GB)', 'metric', 'disk_free_gb', 1, 5, 0, 21600),
  ('iface_down', 'Network interface down', 'event', 'iface', 1, 0, 30, 3600),
  ('container_crash', 'Container crashed', 'event', 'container', 1, 0, 0, 0),
  ('container_stop', 'Container stopped unexpectedly', 'event', 'container', 1, 0, 0, 0),
  ('docker_down', 'Docker daemon unreachable', 'event', 'docker', 1, 0, 20, 600),
  ('nginx_down', 'Nginx is not running', 'event', 'nginx', 1, 0, 60, 3600),
  ('cert_expiry', 'SSL certificate expires soon (days)', 'event', 'cert', 1, 14, 0, 86400),
  ('cert_renew_fail', 'Certificate renewal failed', 'event', 'cert', 1, 0, 0, 86400),
  ('service_failed', 'System service failed', 'event', 'service', 1, 0, 0, 3600);

CREATE TABLE notification_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  min_severity TEXT NOT NULL DEFAULT 'warning'
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user TEXT,
  ip TEXT,
  action TEXT NOT NULL,
  target TEXT,
  result TEXT NOT NULL,
  meta TEXT
);
CREATE INDEX idx_audit_ts ON audit_log(ts);
CREATE INDEX idx_audit_action ON audit_log(action);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

CREATE TABLE metrics (
  ts INTEGER PRIMARY KEY,
  cpu REAL, mem REAL, swap REAL, load1 REAL,
  rx REAL, tx REAL, disk_read REAL, disk_write REAL,
  temp REAL, disk_pct REAL
);

CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  file TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  contents TEXT NOT NULL,
  note TEXT
);

CREATE TABLE hosts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}'
);
INSERT INTO hosts (id, name, type, config) VALUES ('local', 'This server', 'local', '{}');
