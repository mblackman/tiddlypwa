#!/bin/sh
set -e

run_sync_server() {
	DB_DIR=$(dirname "${DB_PATH:-/data/pwa.db}")
	READ_DIRS="/app,/data,/deno-dir,${DB_DIR}"
	WRITE_DIRS="/data,${DB_DIR}"
	if [ -n "${SOCKET:-}" ]; then
		SOCK_DIR=$(dirname "${SOCKET}")
		READ_DIRS="${READ_DIRS},${SOCK_DIR}"
		WRITE_DIRS="${WRITE_DIRS},${SOCK_DIR}"
	fi
	exec deno run --unstable-worker-options --allow-net --allow-env --allow-read="${READ_DIRS}" --allow-write="${WRITE_DIRS}" server/run.ts "$@"
}

# If no arguments or first argument is 'server/run.ts'
if [ "$#" -eq 0 ] || [ "$1" = "server/run.ts" ]; then
	shift 1 2>/dev/null || true
	run_sync_server "$@"
fi

# If first argument starts with a hyphen (flags to server/run.ts, e.g. --port 8000)
if [ "${1#-}" != "$1" ]; then
	run_sync_server "$@"
fi

# Utility helper to generate admin password hash & salt
if [ "$1" = "hash" ] || [ "$1" = "hash-admin-password" ]; then
	shift
	exec deno run --allow-env server/hash-admin-password.ts "$@"
fi

# If first arg is a known Deno subcommand, delegate to deno
case "$1" in
	add | bench | bundle | cache | compile | completions | coverage | doc | eval | fmt | help | init | info | install | jupyter | lint | lsp | publish | remove | repl | run | serve | task | test | types | uninstall | upgrade | vendor )
		exec deno "$@"
		;;
esac

# Otherwise, execute command as given (e.g., sh, bash)
exec "$@"
