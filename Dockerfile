FROM denoland/deno:2.9.7

WORKDIR /app

# Prepare SQLite data directory
RUN mkdir -p /data

# Cache dependencies
COPY deno.json deno.lock ./
COPY server/ ./server/
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
