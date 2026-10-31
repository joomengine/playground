FROM node:26.12.1-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node relay/server.mjs relay/public-network.mjs relay/image-validation.mjs relay/config.container.json ./relay/
COPY --chown=node:node src/public-assets.mjs ./src/
COPY --chown=node:node config/public-assets.json ./config/

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "--input-type=module", "-e", "const r = await fetch('http://127.0.0.1:8787/healthz'); process.exit(r.ok ? 0 : 1)"]

CMD ["node", "relay/server.mjs", "--config", "relay/config.container.json", "--registry", "config/public-assets.json"]
