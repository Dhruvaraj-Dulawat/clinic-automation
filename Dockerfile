# clinic-automation — single-process Node image (target VPS)
# Build: docker build -t clinic-automation . | Run: see docker-compose.yml
#
# D22 — the container runs as NON-ROOT (`USER node`, uid 1000). It previously
# ran as root, so a container escape or a compromised dependency had the full
# privileges of the host daemon's user. Every path the app writes to is owned by
# `node` before the privilege drop, so nothing needs root at runtime.
#
# OPERATIONAL NOTE (D22 follow-through): docker-compose.yml bind-mounts the
# host's ./data over /app/data. A bind mount takes the HOST's ownership, so on
# the VPS the directory must be writable by uid 1000 or SQLite cannot create
# clinic.db:
#     sudo chown -R 1000:1000 ./data
# Verified: `docker compose run --rm app id -u` must print 1000.
FROM node:20-bookworm-slim
WORKDIR /app

# Install deps first (better layer cache). `npm ci` ONLY — the previous
# `npm ci --omit=dev || npm install --omit=dev` silently fell back to a
# non-reproducible resolve, so lockfile drift or a corrupt package-lock.json
# produced a working image built from different versions than the committed
# lockfile. A broken lockfile must fail the build loudly instead.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --chown keeps the tree writable by the unprivileged user we drop to below.
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

# data/ holds SQLite + receipts at runtime (mounted as volume, not baked in).
# Created and chowned HERE, while still root, so the ownership is correct
# before USER node takes effect (and for the non-bind-mount case).
RUN mkdir -p data/receipts && chown -R node:node /app

ENV NODE_ENV=production
EXPOSE 3000

# Drop privileges for the actual application process.
USER node

# Liveness probe for `restart: unless-stopped` / orchestrators. Implemented with
# node itself because the slim image ships no curl or wget; /api/health is the
# unauthenticated endpoint created in src/app.js.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/server.js"]