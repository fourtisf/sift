# Build from the repo root: docker build -f server/Dockerfile .
FROM node:22-slim
WORKDIR /app
COPY server/package*.json server/
# --ignore-scripts: better-sqlite3 ships prebuilt linux binaries and loads them at runtime,
# so the node-gyp step (which needs python/g++) is skipped.
RUN cd server && npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY server server
COPY web web
WORKDIR /app/server
# Safe defaults for a first deploy: simulated market, paper trading only.
# DATABASE_PATH points at the Railway volume mounted at /data; the folder is created if missing.
ENV NODE_ENV=production \
    PORT=8787 \
    SOURCE=demo \
    LIVE_TRADING_ENABLED=false \
    DATABASE_PATH=/data/sift.db
EXPOSE 8787
CMD ["node", "--import", "tsx", "src/index.ts"]
