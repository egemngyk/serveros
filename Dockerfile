# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi \
    && npm cache clean --force

# Docker CLI + Compose V2 plugin (static binaries) for stack management
FROM docker:27-cli AS dockercli

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends tini tar gzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
RUN groupadd -r -g 10001 serveros && useradd -r -u 10001 -g serveros -d /app -s /usr/sbin/nologin serveros \
    && mkdir -p /data && chown serveros:serveros /data
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY web ./web
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 HOME=/tmp DOCKER_CONFIG=/tmp/.docker
USER serveros
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["tini", "--"]
CMD ["node", "server/index.js"]
