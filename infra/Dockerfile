# syntax=docker/dockerfile:1

# The build context is the repository root, because the dependency graph spans
# the whole workspace:
#
#   docker build -f infra/Dockerfile -t civora-web .
#
# The final image carries the traced server bundle only, not the workspace.

FROM node:26-alpine AS build

# pnpm is installed explicitly rather than via Corepack so the version is
# pinned in one obvious place and does not depend on what Node ships.
ARG PNPM_VERSION=10.32.1
RUN npm install --global "pnpm@${PNPM_VERSION}" && pnpm --version

WORKDIR /app

# The lockfile must be present in the context; .dockerignore keeps node_modules
# and build output out of it.
COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @civora/web run build

FROM node:26-alpine AS runtime

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

WORKDIR /app

# `output: 'standalone'` emits the server plus only the modules it traced.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public

USER node

EXPOSE 3000

CMD ["node", "apps/web/server.js"]
