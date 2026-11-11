# Agent host: a small supervisor on top of upstream's agent image.
# Build context is the repository root, because the pnpm workspace lives there.
#
# The base is ghcr.io/block/buzz-sprig, which carries buzz-acp (the harness),
# buzz-agent (the model runtime), buzz-dev-mcp (its tools) and the buzz CLI.
# Pinned by digest; community.config.json names the same image.
ARG SPRIG_IMAGE=ghcr.io/block/buzz-sprig:sha-47674dc@sha256:db430909d37e7c9e9622bd299093f4d340c1f6b99524002395c699cc26c8bc85

FROM node:24-alpine AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.15.1 --activate
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/hive/package.json apps/hive/
# The other workspace members are named in the lockfile; their manifests let
# pnpm resolve it without installing anything for them.
COPY apps/admin/server/package.json apps/admin/server/
COPY apps/admin/web/package.json apps/admin/web/
RUN pnpm install --frozen-lockfile --filter @buzz-community/hive
COPY apps/hive apps/hive
RUN pnpm --filter @buzz-community/hive build

FROM ${SPRIG_IMAGE} AS runtime
# Root, so the supervisor can give every agent its own Unix user. Agents never run as root.
USER root
# tini reaps the processes agents' tools leave behind and forwards signals.
RUN apk add --no-cache nodejs tini
COPY --from=build /repo/apps/hive/dist /opt/hive
# Marks the compiled output as ES modules.
COPY --from=build /repo/apps/hive/package.json /opt/hive/package.json
ENV NODE_ENV=production \
    PORT=8790
WORKDIR /opt/hive
EXPOSE 8790
ENTRYPOINT ["/sbin/tini", "--", "node", "/opt/hive/index.js"]
