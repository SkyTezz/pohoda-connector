FROM node:24-slim AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production \
    CONNECTOR_TRANSPORT=http \
    CONNECTOR_HTTP_HOST=0.0.0.0 \
    CONNECTOR_HTTP_PORT=8444 \
    CONNECTOR_SQLITE_PATH=/data/connector.sqlite
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/dist/ dist/
COPY schema/ schema/
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8444
USER node
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8444/v1/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/index.js"]
