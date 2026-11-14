#!/usr/bin/env bash
# ServerOS installer. Idempotent. Does NOT touch existing Docker containers, Nginx or Certbot configuration.
#   sudo ./install.sh            prepare host + install agent + write .env
#   sudo ./install.sh --start    additionally run "docker compose up -d --build"
set -euo pipefail
cd "$(dirname "$0")"

[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo ./install.sh" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required on the host (apt install python3)" >&2; exit 1; }
command -v docker  >/dev/null || { echo "Docker Engine is required" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || echo "WARNING: 'docker compose' (V2) not found on the host; you need it to start ServerOS."

DATA=${SERVEROS_DATA:-/opt/serveros/data}
STACKS=${STACKS_DIR:-/opt/serveros/stacks}

echo "==> Group and directories"
getent group serveros >/dev/null || groupadd --system serveros
AGENT_GID=$(getent group serveros | cut -d: -f3)
install -d -m 0750 -o 10001 -g 10001 "$DATA" "$STACKS" "$DATA/backups" "$DATA/backups/volumes"
install -d -m 0750 /etc/serveros /usr/local/lib/serveros
install -d -m 0700 /var/lib/serveros-agent

echo "==> Agent token (kept if it already exists)"
if [ ! -s /etc/serveros/agent.token ]; then
  python3 -c "import secrets;print(secrets.token_hex(32))" > /etc/serveros/agent.token
fi
chown root:serveros /etc/serveros/agent.token && chmod 0640 /etc/serveros/agent.token
chown root:serveros /etc/serveros && chmod 0750 /etc/serveros

echo "==> Agent configuration (never overwritten)"
if [ ! -f /etc/serveros/agent.json ]; then
  sed -e "s#/opt/serveros/data#$DATA#" agent/agent.json.example > /etc/serveros/agent.json
  chmod 0640 /etc/serveros/agent.json; chown root:serveros /etc/serveros/agent.json
fi

echo "==> Agent service"
install -m 0755 agent/serveros-agent.py /usr/local/lib/serveros/serveros-agent.py
install -m 0644 agent/serveros-agent.service /etc/systemd/system/serveros-agent.service
systemctl daemon-reload
systemctl enable serveros-agent.service >/dev/null
systemctl restart serveros-agent.service
sleep 1
systemctl is-active --quiet serveros-agent.service && echo "agent: active" || { echo "agent failed to start:"; journalctl -u serveros-agent -n 20 --no-pager; exit 1; }

echo "==> .env"
if [ ! -f .env ]; then
  cp .env.example .env
  DOCKER_GID=$(stat -c %g /var/run/docker.sock)
  sed -i -e "s/^DOCKER_GID=.*/DOCKER_GID=$DOCKER_GID/" -e "s/^AGENT_GID=.*/AGENT_GID=$AGENT_GID/" -e "s#^SERVEROS_DATA=.*#SERVEROS_DATA=$DATA#" -e "s#^STACKS_DIR=.*#STACKS_DIR=$STACKS#" .env
  echo ".env created"
else
  echo ".env exists — left unchanged (check DOCKER_GID=$(stat -c %g /var/run/docker.sock) and AGENT_GID=$AGENT_GID)"
fi

echo
echo "Host preparation finished. Existing containers and Nginx configuration were not modified."
if [ "${1:-}" = "--start" ]; then
  docker compose up -d --build
  echo "Started. Find the first-run setup token with:  docker logs serveros 2>&1 | grep setupToken"
else
  echo "Next:  docker compose up -d --build"
  echo "Then:  docker logs serveros 2>&1 | grep setupToken     # token for creating the administrator"
  echo "Then put your HTTPS reverse proxy in front of 127.0.0.1:8080 (see deploy/nginx-example.conf)."
fi
