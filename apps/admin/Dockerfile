# Operator console: API server plus the built web app it serves under /admin.
# Build context is the repository root, because the pnpm workspace lives there.

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.15.1 --activate
WORKDIR /repo

# Dependencies first, from manifests only, so source edits reuse this layer.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/admin/server/package.json apps/admin/server/
COPY apps/admin/web/package.json apps/admin/web/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY apps/admin/server apps/admin/server
COPY apps/admin/web apps/admin/web
RUN pnpm --filter @buzz-community/admin-web build \
 && pnpm --filter @buzz-community/admin-server build
# A self-contained copy of the server with production dependencies only.
RUN pnpm --filter @buzz-community/admin-server deploy --prod --legacy /out

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    STATIC_DIR=/app/web
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/admin/server/dist ./dist
COPY --from=build /repo/apps/admin/web/dist ./web
USER node
EXPOSE 8787
# telemetry.js enables tracing only when a collector is configured.
CMD ["node", "--import", "./dist/telemetry.js", "dist/index.js"]
