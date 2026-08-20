# Papra Server Dockerfile
# Multi-stage build optimized for production and aarch64 support
# Supports both amd64 and arm64/aarch64 architectures
# Uses Node.js 26 LTS.
#
# NOTE: deliberately Debian-based (node:*-slim), NOT Alpine (node:*-alpine).
# Alpine's musl libc crashes with SIGBUS when run under proot-based runtimes
# (udocker on Android/Termux uses ptrace-based syscall emulation) — this
# matches how papra-hq's own official image is built (apps/papra-server/Dockerfile
# uses node:*-slim too), and is required for this image to run on-device.

# =============================================================================
# Build stage - Build the application
# =============================================================================
FROM --platform=$TARGETPLATFORM node:26-slim AS builder
# Set build arguments
ARG BUILDPLATFORM
ARG TARGETPLATFORM

# Install build dependencies
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y python3 make g++ build-essential ca-certificates openssl git && \
    rm -rf /var/lib/apt/lists/* && \
    update-ca-certificates && \
    npm install -g pnpm

# Create app directory
WORKDIR /app
ENV PNPM_CONFIG_STRICT_PEER_DEPENDENCIES=false

# Copy package files for better layer caching
# NOTE: papra-client's package.json is needed here too — it's a sibling app,
# not a dependency of app-server, so it's invisible to the app-server install
# filter unless explicitly listed.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/papra-server/package.json ./apps/papra-server/
COPY apps/papra-client/package.json ./apps/papra-client/
COPY packages/ ./packages/

# Install dependencies
# Using --ignore-scripts to avoid postinstall issues
# Note: Using without --frozen-lockfile for now due to network/timeouts
RUN pnpm config set fetch-timeout 300000
RUN pnpm install --filter=@papra/app-server... --filter=@papra/app-client... --frozen-lockfile --network-concurrency=4

# Copy all source files
COPY . .

# Build the server and all scripts
RUN cd apps/papra-server && \
    pnpm build && \
    pnpm esbuild --bundle src/scripts/migrate-up.script.ts --platform=node --packages=external --format=esm --outfile=dist/scripts/migrate-up.script.js --minify --alias:@papra/std=../../packages/std/src/index.ts

# Build the client — this is what was missing. Without it, the server has
# nothing to serve at "/" and serveStatic falls back to a bare JSON error for
# every page (`root path './public' is not found`). Vite's default output dir
# is "dist", which is renamed to "public" on copy below to match what the
# server's servePublicDir config actually looks for.
RUN cd apps/papra-client && pnpm build

# =============================================================================
# Runtime stage - Minimal production image
# =============================================================================
FROM --platform=$TARGETPLATFORM node:26-slim AS runtime
# Set target platform (automatically uses build platform if not specified)
ARG TARGETPLATFORM

# Install runtime dependencies
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y ca-certificates openssl && \
    rm -rf /var/lib/apt/lists/* && \
    update-ca-certificates

# Create non-root user for security
RUN groupadd -g 1001 nodejs && \
    useradd -u 1001 -g nodejs -s /usr/sbin/nologin -M nodejs

# Create app directory and set permissions
WORKDIR /app
RUN mkdir -p /app/apps/papra-server/data && \
    mkdir -p /app/apps/papra-server/local-documents && \
    mkdir -p /app/apps/papra-server/ingestion && \
    chown -R nodejs:nodejs /app

# Copy built files and dependencies from builder
COPY --from=builder --chown=nodejs:nodejs /app/apps/papra-server/dist ./apps/papra-server/dist
COPY --from=builder --chown=nodejs:nodejs /app/apps/papra-server/node_modules ./apps/papra-server/node_modules
COPY --from=builder --chown=nodejs:nodejs /app/packages ./packages
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./
COPY --from=builder --chown=nodejs:nodejs /app/pnpm-workspace.yaml ./
# The client build — this is what makes servePublicDir actually have
# something to serve. Server source resolves this as root: './public',
# relative to process.cwd() — and CWD here is "/app" (WORKDIR, never
# changed), NOT "/app/apps/papra-server". So this has to land at exactly
# "/app/public", not nested under apps/papra-server, or serveStatic still
# won't find it despite the file technically being in the image.
COPY --from=builder --chown=nodejs:nodejs /app/apps/papra-client/dist ./public

# Switch to non-root user
# Rebuild any native modules (.node addons) against the
# runtime image's libc to avoid SIGILL on first use
# (e.g. @libsql/client).
RUN npm install -g pnpm && pnpm rebuild --filter=@papra/app-server...

# Environment variables
ENV NODE_ENV=production
ENV PORT=1221
ENV SERVER_HOSTNAME=0.0.0.0
ENV NODE_OPTIONS="--experimental-sqlite"

# Expose port
EXPOSE 1221

# Health check (node-based — no wget on slim by default)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:1221/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Run migrations, then the server. This is what was missing before — the
# migrate-up script was being built (see builder stage above) but nothing
# ever actually ran it, so every fresh container started against an empty
# database ("no such table: auth_sessions" etc). Matches papra-hq's own
# "start:with-migrations" package.json script (migrate:up:prod && start),
# just spelled out directly since this image doesn't have that script's
# workspace context at runtime. Deliberately NOT changing WORKDIR here (it
# stays "/app", same as before) — absolute paths instead, so nothing about
# how the app resolves its own relative paths (e.g. the default sqlite file
# location) changes as a side effect of this fix.
CMD ["sh", "-c", "node /app/apps/papra-server/dist/scripts/migrate-up.script.js && node /app/apps/papra-server/dist/index.js"]
