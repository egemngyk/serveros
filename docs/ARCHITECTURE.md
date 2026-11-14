# Architecture notes

| Area | Decision |
|---|---|
| Backend | Node.js (ESM) + Express; services in `server/services`, thin route modules in `server/routes`, central error handler, structured JSON logging, hand-rolled validators (`lib/util.js`) |
| Frontend | Dependency-free ES modules, no build step (small attack surface, nothing to compile); Monaco (config editor, diff) and xterm.js served from `node_modules` |
| Database | SQLite via better-sqlite3, WAL, forward-only SQL migrations (`server/migrations`), restore swaps the DB file before it is opened |
| Host access | `Environment` object per host (`server/environments.js`): Docker (dockerode + `docker compose` CLI), monitoring (/proc, /sys), `AgentClient` (Unix socket, JSON-lines + length-prefixed frames for streams) |
| Why an agent | Docker socket access does not provide Nginx/Certbot/systemd/PTY. Instead of a privileged container, a small whitelisted root helper on the host owns those operations. |
| Realtime | One `/ws/events` socket (monitor snapshot every 2 s, container list+stats, notifications) with ref-counted Docker stats streams that stop when nobody listens; dedicated sockets for logs/terminals. Metrics are stored every 10 s and downsampled at query time. |
| Docker stats | One streaming `stats` connection per running container, opened only while a client is subscribed |
| Alerts | Metric rules evaluated every 10 s (with "sustained for" and cooldown); event rules from Docker events and periodic probes; providers (webhook, Telegram, Discord) registered in `services/notifications.js` |
| Containers & recreation | Environment/image changes recreate the container: old one is renamed and kept (stopped) unless the user opts to remove it; volumes are never removed automatically |
| Multi-host (future) | Add another Environment implementation (remote Docker endpoint + remote agent) and register it in `environments.js` |
| Known limits | Docker volume contents are backed up by a separate helper-container flow, not in the main archive. Process CPU% is sampled over 0.5 s. Host network interface IP addresses are not shown (only state/traffic). |
