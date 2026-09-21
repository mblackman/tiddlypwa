#!/bin/sh
set -e

# If no arguments or first argument is 'server/run.ts'
if [ "$#" -eq 0 ] || [ "$1" = "server/run.ts" ]; then
	shift 1 2>/dev/null || true
	exec deno run --allow-net --allow-env --allow-read --allow-write server/run.ts "$@"
fi

# If first argument starts with a hyphen (flags to server/run.ts, e.g. --port 8000)
if [ "${1#-}" != "$1" ]; then
	exec deno run --allow-net --allow-env --allow-read --allow-write server/run.ts "$@"
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
