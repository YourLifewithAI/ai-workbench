# syntax=docker/dockerfile:1
# Multi-stage: build the SPA and runtime, then ship only dist/ and production dependencies (D-60).
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    WORKBENCH_WORKSPACE=/workspace \
    WORKBENCH_PORT=8787 \
    WORKBENCH_BIND=127.0.0.1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY scripts/docker-entrypoint.sh /usr/local/bin/workbench-entrypoint
RUN mkdir -p /workspace && chown -R node:node /workspace /app
USER node
VOLUME ["/workspace"]
# The runtime binds 127.0.0.1 inside the container's network namespace; reach it with `network_mode: host` + Tailscale
# (deploy.md) or `docker exec`. Nothing is EXPOSEd on purpose.
ENTRYPOINT ["workbench-entrypoint"]
CMD ["start"]
