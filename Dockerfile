# Embassy Run — build and run the game with its relay in one container.
#
# The build stage fetches and builds the pinned FriendSDK commit (it is UNLICENSED, so it is
# never vendored into this repository) and produces the static bundle. The runtime stage
# carries only what `npm start` needs.
#
# Node 22.18+ is required, not optional: the server imports the shared simulation as
# TypeScript and depends on Node's native type stripping, which is off by default before then.

FROM node:22-bookworm-slim AS build
WORKDIR /app

# git is needed to fetch the pinned SDK commit during setup.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The checks use Playwright, the server never does. Without this, building the image would
# download a Chromium build that is only ever dead weight in it.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
COPY scripts ./scripts
COPY server ./server
COPY games ./games
COPY tsconfig.json ./

# Fetches, builds, packs and installs FriendSDK, then bundles the game into .build/game.
# Afterwards drop the dev dependencies: serving needs only the SDK, react and ws.
RUN npm run setup \
 && npm run build \
 && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.build ./.build
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/server ./server
COPY --from=build /app/games ./games

# Career standings are written here; the compose file mounts a volume over it.
ENV RF_DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

# Run unprivileged. /data is the only path it writes.
USER node
EXPOSE 8080

# The relay keeps match state in memory, so a healthy process is the whole health check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "scripts/serve.mjs"]
