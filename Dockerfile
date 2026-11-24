# Stage 1: Build the default TiddlyWiki app
FROM --platform=$BUILDPLATFORM denoland/deno:2.9.7 AS builder

WORKDIR /build
COPY deno.json deno.lock ./
COPY plugin[s]/ ./plugins/
COPY theme[s]/ ./themes/
COPY tiddler[s]/ ./tiddlers/
COPY tiddlywiki.info ./
COPY server/ ./server/
COPY scripts/ ./scripts/

# Build TiddlyWiki and prepare default app files
RUN deno task build:all

# Stage 2: Production image
FROM denoland/deno:2.9.7

WORKDIR /app

ENV DENO_DIR=/deno-dir

# Cache dependencies before dropping root privileges
COPY deno.json deno.lock ./
COPY server/ ./server/
COPY --from=builder /build/server/default_app/ ./server/default_app/
RUN deno cache --frozen server/run.ts server/argon_worker.ts server/hash-admin-password.ts

# Prepare writable SQLite data directory and permissions for non-root deno user
RUN mkdir -p /data /deno-dir && chown -R root:root /app /deno-dir && chmod -R a+rX /app /deno-dir && chown -R deno:deno /data

# Setup entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER deno

# Default environment configuration
ENV HOST=0.0.0.0
ENV PORT=8000
ENV DB_PATH=/data/pwa.db

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD deno eval --no-lock --allow-net=127.0.0.1 --allow-env=PORT,BASE_PATH "const port = Deno.env.get('PORT') || '8000'; const raw = (Deno.env.get('BASE_PATH') || '').trim().replace(/\/+$/, ''); const bp = raw ? (raw.startsWith('/') ? raw : '/' + raw) : ''; const resp = await fetch('http://127.0.0.1:' + port + bp + '/healthz'); if (!resp.ok) Deno.exit(1);"

VOLUME ["/data"]

ENTRYPOINT ["/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["server/run.ts"]
