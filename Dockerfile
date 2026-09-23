# Stage 1: Build the default TiddlyWiki app
FROM denoland/deno:2.9.7 AS builder

WORKDIR /build
COPY deno.json deno.lock ./
COPY plugins/ ./plugins/
COPY tiddlers/ ./tiddlers/
COPY tiddlywiki.info ./
COPY server/ ./server/
COPY scripts/ ./scripts/

# Build TiddlyWiki and prepare default app files
RUN deno task build:all

# Stage 2: Production image
FROM denoland/deno:2.9.7

WORKDIR /app

# Prepare SQLite data directory
RUN mkdir -p /data

# Cache dependencies
COPY deno.json deno.lock ./
COPY server/ ./server/
COPY --from=builder /build/server/default_app/ ./server/default_app/
RUN deno cache server/run.ts server/hash-admin-password.ts

# Setup entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Default environment configuration
ENV HOST=0.0.0.0
ENV PORT=8000
ENV DB_PATH=/data/pwa.db

EXPOSE 8000

VOLUME ["/data"]

ENTRYPOINT ["/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["server/run.ts"]
