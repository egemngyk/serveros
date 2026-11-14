# Security model

## The honest part
* **Mounting `/var/run/docker.sock` gives root-equivalent control of the host** (anyone able to start a container can mount `/` and read/write everything). The `:ro` mount flag does **not** make Docker operations safe. Anyone who can sign in to ServerOS can therefore administer the server. Treat the dashboard like an SSH root login.
* The **host agent runs as root** (it must, to manage Nginx/Certbot/systemd and to provide a host terminal). Its protection is: Unix socket only (`root:serveros`, 0660), a 256-bit shared secret, a fixed whitelist of operations, strict argument validation, argv-only subprocesses (no shell), path confinement and deny-lists. A compromise of the ServerOS container, or a stolen admin session, is still a compromise of the host.
* The **host terminal** is a PTY as `terminal_user` (default root). Disable it in Settings or set `terminal_user` to an unprivileged account if you do not need root.

## What is NOT done (by design)
`privileged: true`, host network mode, mounting `/` or `/etc`, exposing the Docker API over TCP, mounting private key directories into the container. The container runs as UID 10001, read-only rootfs, `cap_drop: ALL`, `no-new-privileges`.

## Authentication & sessions
Argon2id (19 MiB, t=2), min. 12 character passwords, no default credentials, one-time setup token printed to the log, constant-ish time login for unknown users, per-user (5) and per-IP (20) failure lockouts with exponential back-off, random 256-bit session ids stored hashed (SHA-256), HttpOnly + SameSite=Strict (+ Secure over HTTPS) cookies, absolute (24 h) and idle (4 h) expiry (configurable), logout, password change invalidates other sessions.

## Request protection
CSRF: per-session token header on every state-changing request plus Origin validation. WebSockets: authenticated session cookie, mandatory Origin check, periodic session re-validation (closed with 4001 on expiry). Strict CSP, `nosniff`, `X-Frame-Options: DENY`. All inputs validated; container names, image refs, stack names, unit names, domains, signals, paths are matched against allow-patterns.

## Host operations
* **Nginx:** operations confined to the detected config directory; symlinks leaving it are refused; saves are staged → `nginx -t` → automatically rolled back on failure → backup → optional reload; the dashboard's own proxy config is detected and needs explicit acknowledgement before it is changed/removed.
* **Certbot:** fixed argument construction, domains regex-validated, private key contents are never read or returned (only paths), deletion checks Nginx references.
* **systemd:** unit name regex; `stop`/`disable` of critical units (sshd, docker, networking, dbus, systemd-*, the agent …) is blocked; restart needs explicit confirmation.
* **Files:** only inside agent `file_roots` (further restrictable in Settings); `privkey*.pem`, `/etc/shadow`, SSH host/user keys, `/etc/letsencrypt/{archive,keys,accounts}`, `/etc/serveros` are always denied; atomic writes; size limits; conflict detection via SHA-256.
* **Backups:** `0600`, private keys opt-in and never scheduled, restore archives validated (no absolute paths, `..`, escaping symlinks, device nodes) and checksum-verified.

## Audit & logging
Every administrative action (logins incl. failures, container/image/volume/network/stack operations, Nginx saves/reloads, Certbot, file writes, service actions, backups/restores, settings changes, terminal open/close) is stored with time, user, IP, action, target, result and redacted metadata. Terminal **input is never recorded**. Values of keys that look secret (`password`, `token`, `secret`, `key`, …) are redacted. The table is append-only (triggers). Structured JSON logs go to stdout.

## Deployment checklist
1. Serve only over HTTPS; keep `127.0.0.1` binding; set `COOKIE_SECURE=true`.
2. Restrict access at the proxy as well (IP allow-list / VPN / mTLS) if possible.
3. Keep `agent.json` `file_roots` minimal; consider an unprivileged `terminal_user`.
4. Configure a notification channel and check the alert rules.
5. Take a backup, then test a restore on a non-production host.
