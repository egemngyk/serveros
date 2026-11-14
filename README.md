# ServerOS

Self-hosted, CasaOS-inspired server management platform. It runs **inside Docker** and manages the **Ubuntu host** it is deployed on:
Docker (containers, images, volumes, networks, Compose stacks), live host monitoring, Nginx + Certbot, systemd services, host terminal,
file manager, system logs, backup/restore, alerts and an append-only audit log.

Everything you see in the UI is backed by a real implementation. Features the host cannot support are shown as *unavailable* — never faked.

## Architecture in one minute

```
 Browser ──HTTPS──> your existing Nginx ──> 127.0.0.1:8080 ┐
                                                            │
        ┌───────────────── ServerOS container (non-root, read-only rootfs, no capabilities) ─────────────────┐
        │ Node.js backend + static UI                                                                         │
        │  • Docker Engine API  ── /var/run/docker.sock                                                       │
        │  • /host/proc, /host/sys (read-only)  ── CPU, RAM, disk I/O, network, temperatures, processes       │
        │  • Unix socket + token ── ServerOS host agent                                                       │
        └─────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                            │
        serveros-agent.service (root, on the host, Python, no dependencies)
          whitelisted operations only: nginx / certbot / systemctl / journalctl / file manager / PTY / archive
```

The container itself is **not** an unrestricted root shell. Everything that needs host root privileges goes through the agent,
which exposes a fixed list of validated operations (no "run command"). See `docs/SECURITY.md`.

## Requirements
* Ubuntu host with Docker Engine + Docker Compose V2, `python3` (preinstalled on Ubuntu)
* Nginx / Certbot are optional (their pages show "not installed" otherwise)

## Install
```bash
git clone <this repo> serveros && cd serveros     # or unpack the archive
sudo ./install.sh                                  # host agent, directories, .env  (does not touch existing services)
docker compose up -d --build
docker logs serveros 2>&1 | grep setupToken        # first-run setup token
```
Open `http://127.0.0.1:8080` (use an SSH tunnel) or put it behind HTTPS (below), enter the setup token and create the
administrator (min. 12 character password). There are no default credentials; the setup endpoint is disabled once an admin exists.

### HTTPS reverse proxy (recommended / required for internet exposure)
The port is bound to `127.0.0.1` only. Copy `deploy/nginx-example.conf` into your Nginx setup **manually** (ServerOS never replaces your config),
adjust the domain, issue a certificate (Nginx → SSL / Certbot, or your own Certbot), test and reload.
Then set Settings → General → *Dashboard domain* so ServerOS can warn before an Nginx change could lock you out of the dashboard,
and set `COOKIE_SECURE=true` in `.env`.

## Configuration (`.env`)
| Variable | Meaning |
|---|---|
| `SERVEROS_PORT` | host port bound on 127.0.0.1 (default 8080) |
| `SERVEROS_DATA` | persistent data dir (database, backups) — default `/opt/serveros/data` |
| `STACKS_DIR` | Compose stacks, mounted at the **same path** in host and container |
| `DOCKER_GID` / `AGENT_GID` | group ids granting access to docker.sock / agent socket (written by `install.sh`) |
| `COOKIE_SECURE` | `auto` (default), `true`, `false` |
| `ALLOWED_ORIGINS` | extra browser origins accepted for CSRF/WebSocket checks (normally empty) |

Agent configuration: `/etc/serveros/agent.json` (see `agent/agent.json.example`). Notably `file_roots` (the maximum set of directories the
file manager may touch), `terminal_user` (default `root`; set a normal user to run host terminals unprivileged) and `protected_units`.
After editing: `sudo systemctl restart serveros-agent`.

## File manager, notifications, phones
* **Folders as ZIP:** every folder has a *ZIP* button (and the current folder can be downloaded from the header). The archive is streamed from the host, never stored; symlinks and sensitive files (private keys etc.) are skipped. Limits: 8 GiB / 200 000 files (`max_zip_bytes`, `max_zip_files` in `agent.json`).
* **Hidden files:** the *Show hidden files* switch (remembered per browser) toggles dotfiles.
* **Notifications:** bell menu and Settings → Notification history show severity, details dialog (full message, time, rule, link to the related page), per-item *mark read/unread*, delete, bulk actions, filters (unread / severity / category / search).
* **Phones:** responsive layout — drawer navigation, tables turn into cards, dialogs become bottom sheets, container windows are full-screen panels with a task bar, the terminal gets an on-screen key bar (Esc, Tab, Ctrl, arrows, …). The page can be added to the home screen (web app manifest).

## Live refresh rate
Settings → General → *Live data refresh rate* (1 / 2 / 5 / 10 / 30 / 60 s, default 2 s). It applies immediately to every open page. Stored history is always sampled every 10 s.

## Compose stacks living outside ServerOS
Projects you started yourself (`docker compose up` somewhere on the host) are discovered from container labels. To view/edit/run them from ServerOS,
their directory must be inside `file_roots` in `/etc/serveros/agent.json` (default: `/home /opt /srv /var/www /etc/nginx /tmp` — add e.g. `/root` if your projects live there), then `sudo systemctl restart serveros-agent`.
They are then read, saved (with a `.bak-<time>` copy) and executed on the host through the agent (`docker compose` must be installed on the host).
The stack that contains the ServerOS dashboard itself requires an extra confirmation because stopping/recreating it cuts your session.

## Git / GitHub
The repository is ready to push: `.gitignore` excludes `.env`, data, databases and archives (nothing secret is committed), `.gitattributes` forces LF line endings
(important for `install.sh`), and `.github/workflows/ci.yml` runs syntax checks and a Docker build on every push.
```bash
git remote add origin git@github.com:<you>/serveros.git
git push -u origin main
```
No license file is included — add the one you want (e.g. MIT) before publishing.

## Data persistence
* Application state lives in the SQLite database `${SERVEROS_DATA}/serveros.db` (WAL, migrations in `server/migrations`). Container recreation or image updates never touch it.
* Monitoring history: 10 s samples, kept 7 days (hourly pruning). Notifications: 90 days. Audit log: append-only (database triggers reject UPDATE/DELETE).

## Backups
Settings → Backups.
* **Included:** application database/settings/layouts, Compose stacks, Nginx configuration, Certbot configuration + *public* certificates. Private keys only if you explicitly tick the option (never in scheduled backups).
* **Not included:** Docker volume data and images. Volume data has its own, separate flow (*Backup Docker volumes*): each volume is archived by a short-lived helper container mounted read-only. For databases stop the container first.
* Archives are `0600`, contain a manifest with SHA-256 checksums, and can be downloaded/imported.
* **Restore** validates the archive (paths, symlinks, checksums), shows what will be replaced, takes an automatic *pre-restore* backup, requires typing `RESTORE`, and rolls Nginx back automatically if the restored config does not pass `nginx -t`. Restoring the application database restarts ServerOS (the old database is kept as `pre-restore-db-*`).
* Retention (keep last N / max age) applies only to *scheduled* backups.

Restore a volume archive manually:
```bash
docker run --rm -v VOLUME:/dst -v /opt/serveros/data/backups/volumes:/b busybox tar xzf /b/FILE.tar.gz -C /dst
```

## Upgrade
```bash
cd serveros && git pull            # or replace the files with the new release
sudo ./install.sh                  # updates the agent; keeps token, agent.json and .env
docker compose up -d --build       # database migrations run automatically at start
```
Take a backup first (Settings → Backups). Rolling back = checking out the previous version and `docker compose up -d --build`
(migrations are additive; restore the pre-upgrade backup if a downgrade needs an older schema).

## Recovery
* **Lost admin password:** stop ServerOS, then `sqlite3 ${SERVEROS_DATA}/serveros.db "DELETE FROM users;"` (sessions cascade) and start it again — a new first-run setup token is printed.
* **Locked out by an Nginx change:** edit on the host (`/etc/nginx`), `nginx -t && systemctl reload nginx`; ServerOS keeps a timestamped backup of every file it changed in `/var/lib/serveros-agent/nginx-backups`.
* **Agent not reachable:** `systemctl status serveros-agent`, `journalctl -u serveros-agent`; the UI shows the reason in the header chip and Settings → About.
* **Bad restore:** the pre-restore archive is listed under Backups (kind `pre-restore`) and in `/var/lib/serveros-agent/pre-restore`.

## Uninstall
```bash
docker compose down                       # data stays in ${SERVEROS_DATA}
sudo systemctl disable --now serveros-agent
sudo rm -f /etc/systemd/system/serveros-agent.service && sudo systemctl daemon-reload
sudo rm -rf /usr/local/lib/serveros /etc/serveros /var/lib/serveros-agent /run/serveros   # agent, token, agent backups
# optional, deletes ALL ServerOS data and backups:
# sudo rm -rf /opt/serveros
```
Your other containers, Nginx and Certbot configuration are never modified by installing or removing ServerOS.

## Development notes
* Backend: Node.js 20+, Express, ws, dockerode, better-sqlite3, argon2. No build step; the UI is plain ES modules (Monaco and xterm.js are served from `node_modules`).
* `npm install && DATA_DIR=./data STACKS_DIR=./stacks node server/index.js` runs it locally (Docker/agent features need a Docker socket / agent).
* Multi-host: `server/environments.js` bundles all services per host (`Environment`); routes only talk to the environment object, so remote Docker hosts can be added as another implementation.
* Not verified on a live host in this repository's build environment: Docker, Nginx, Certbot, systemd and PTY integrations were written against their documented APIs/CLIs. Run through the checklist in `docs/SECURITY.md` and try each page on a non-production host first.
