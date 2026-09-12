# syntax=docker/dockerfile:1

# Purix — Verification & Governance Layer for AI-Generated Code
#
# Three-stage build: install full workspace deps, build all packages with
# turbo, then assemble a runtime image with only the built dist/ output
# and production dependencies (no TypeScript, no devDependencies, no
# source). Every stage/command in this file was verified by hand in a
# non-Docker sandbox before being written here (pnpm install --frozen-lockfile,
# `pnpm exec turbo run build`, and `pnpm install --prod --frozen-lockfile`
# against a package.json+dist-only tree all confirmed to work) — the
# Dockerfile itself has NOT been build-tested with a real `docker build`,
# since no Docker daemon is available in the environment that authored it.
# Run a real `docker build .` once before relying on this in CI/release.

ARG NODE_VERSION=22.13.0
ARG PNPM_VERSION=9.15.0

# ---------------------------------------------------------------------------
# Stage 1: deps — install the full workspace (including devDependencies),
# using only the package.json/lockfile layer so this stage's Docker cache
# is invalidated by dependency changes, not by source-code edits.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS deps
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY packages/mcp-server/package.json packages/mcp-server/package.json
COPY packages/cli/package.json packages/cli/package.json

# onlyBuiltDependencies in pnpm-workspace.yaml (esbuild, protobufjs,
# @google/genai) need their postinstall scripts to run, which pnpm allows
# by default for packages explicitly listed there.
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Stage 2: build — bring in the real source and compile every package with
# turbo (packages/core has no internal workspace dependency, mcp-server
# depends on core, cli depends on both — turbo's `dependsOn: ["^build"]`
# in turbo.json orders this correctly without needing it spelled out here).
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .
RUN pnpm exec turbo run build

# ---------------------------------------------------------------------------
# Stage 3: runtime — copy over only package.json + built dist/ per package,
# then do a second, production-only install against that trimmed tree. No
# TypeScript, no test files, no devDependencies, no source ship in the
# final image.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runtime
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./

COPY --from=build /app/packages/core/package.json packages/core/package.json
COPY --from=build /app/packages/core/dist packages/core/dist

COPY --from=build /app/packages/mcp-server/package.json packages/mcp-server/package.json
COPY --from=build /app/packages/mcp-server/dist packages/mcp-server/dist

COPY --from=build /app/packages/cli/package.json packages/cli/package.json
COPY --from=build /app/packages/cli/dist packages/cli/dist

RUN pnpm install --prod --frozen-lockfile

# Purix reads/writes project state (.purix/ manifest, sandbox tmp dirs) in
# whatever directory it's run against. Mount your project at /workspace:
#   docker run --rm -v "$PWD":/workspace -w /workspace purix status
WORKDIR /workspace

ENTRYPOINT ["node", "/app/packages/cli/dist/cli.js"]
CMD ["--help"]
