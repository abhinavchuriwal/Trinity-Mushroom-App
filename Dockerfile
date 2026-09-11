# Pinned to Node 22 (not 24 — better-sqlite3 hits a GC crash bug on Node 24,
# see README) and Debian (not Alpine) so better-sqlite3's prebuilt binary
# installs cleanly without needing a native compile toolchain.
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
# Overridden per-platform to point at a mounted persistent volume — without
# this, the SQLite file lands on the container's ephemeral filesystem and is
# lost on every redeploy. See the README's Deploying section.
ENV TRINITY_DATA_DIR=/data

EXPOSE 4000

CMD ["node", "server/app.js"]
