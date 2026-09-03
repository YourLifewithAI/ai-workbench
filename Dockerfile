# syntax=docker/dockerfile:1
# Multi-stage (D-60): compile and build once with the toolchain present, then ship only dist/ and the pruned
# production node_modules. better-sqlite3 is a native module; npm ci compiles it with node-gyp, which needs
# python3/make/g++, so those live in the build stage only and never reach the runtime image.
FROM node:22-bookworm-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build \
 && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    WORKBENCH_WORKSPACE=/workspace \
    WORKBENCH_PORT=8787 \
    WORKBENCH_BIND=127.0.0.1
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY scripts/docker-entrypoint.sh /usr/local/bin/workbench-entrypoint
RUN mkdir -p /workspace && chown -R node:node /workspace /app
USER node
VOLUME ["/workspace"]
# The runtime binds 127.0.0.1 inside the container's network namespace; reach it with `network_mode: host` + Tailscale
# (deploy.md) or `docker exec`. Nothing is EXPOSEd on purpose.
ENTRYPOINT ["workbench-entrypoint"]
CMD ["start"]
