# Development, Build & Operations Guide

This guide covers setting up a local development environment, compiling the standalone TiddlyWiki client bundles, containerizing the sync server, and running a production-hardened deployment.

---

## 1. Local Development Environment

### Prerequisites

- **Deno 2.x**: The modern runtime for the server, test suite, and formatting.
- **Node.js 18+ & npm**: Required only when compiling the TiddlyWiki client HTML bundles (`tiddlywiki.info`).

### 1.1 Code Formatting & Linting

All code in the repository is formatted according to Deno's opinionated rules defined in [`deno.json`](file:///Users/mblackman/workspace/gh/tiddlypwa/deno.json):

```json
{
	"fmt": {
		"useTabs": true,
		"lineWidth": 120,
		"singleQuote": true,
		"proseWrap": "preserve"
	},
	"lint": {
		"rules": {
			"exclude": ["no-explicit-any"]
		}
	}
}
```

Format the entire codebase:

```shell
deno fmt
```

Check formatting and lint rules in CI:

```shell
deno fmt --check
deno lint
```

### 1.2 Automated Test Suite

The server test suite ([`server/app.test.ts`](file:///Users/mblackman/workspace/gh/tiddlypwa/server/app.test.ts)) tests delta sync, multi-tenant isolation, large blob storage, and SQLite schema migrations:

```shell
deno test
```

Tests run in-memory against a fresh `SQLiteDatastore` instance and execute in under 1 second.

---

## 2. Compiling the Standalone Client HTML

TiddlyPWA builds standalone HTML bundles via the TiddlyWiki CLI as configured in [`tiddlywiki.info`](file:///Users/mblackman/workspace/gh/tiddlypwa/tiddlywiki.info):

```json
{
	"description": "TiddlyPWA",
	"plugins": ["notebook-mobile"],
	"themes": [
		"tiddlywiki/vanilla",
		"tiddlywiki/snowwhite",
		"notebook"
	],
	"build": {
		"index": [
			"--render",
			"$:/core/save/all",
			"index.html",
			"text/plain",
			"",
			"--render",
			"$:/bootstrap.json",
			"bootstrap.json",
			"text/plain",
			"",
			"bootState",
			"docs",
			"--render",
			"$:/core/save/all",
			"app/app.html",
			"text/plain",
			"",
			"publishFilter",
			"-[tag:[TiddlyPWA Docs]] -[[$:/DefaultTiddlers]]",
			"--render",
			"$:/plugins/valpackett/tiddlypwa/sw.js",
			"app/sw.js",
			"text/plain",
			"--render",
			"$:/bootstrap.json",
			"app/bootstrap.json",
			"text/plain",
			"",
			"bootState",
			"localonly"
		]
	}
}
```

### Build Outputs (`output/`)

1. **`output/index.html`**: Documentation and installer site containing the introductory guides.
2. **`output/bootstrap.json`**: Initializer declaring `{ "state": "docs" }`.
3. **`output/app/app.html`**: The clean standalone wiki application stripped of documentation tiddlers.
4. **`output/app/sw.js`**: The compiled Service Worker bundle.
5. **`output/app/bootstrap.json`**: Standalone offline configuration declaring `{ "state": "localonly" }`.

### Executing the Build

Assuming the [Paul Rouse Notebook theme](https://github.com/paul-rouse/Notebook) is checked out locally:

```shell
TIDDLYWIKI_THEME_PATH=$HOME/src/github.com/paul-rouse/Notebook/themes \
TIDDLYWIKI_PLUGIN_PATH=$HOME/src/github.com/paul-rouse/Notebook/plugins \
npx tiddlywiki@5.3.5 --build
```

---

## 3. Containerization Architecture

The production Docker container is defined in [`Dockerfile`](file:///Users/mblackman/workspace/gh/tiddlypwa/Dockerfile) and automated via [`docker-entrypoint.sh`](file:///Users/mblackman/workspace/gh/tiddlypwa/docker-entrypoint.sh).

### 3.1 Dockerfile Design

- **Base Image**: `denoland/deno:2.9.7`
- **Volume Mount**: `/data` (holds the SQLite database file)
- **Process Supervision**: Uses `tini` as `PID 1` to handle signal propagation (`SIGTERM`) and reap zombie child processes.
- **Dependency Caching**: Explicitly pre-caches `deno.json`, `deno.lock`, and server entrypoints during the image build step.

### 3.2 Entrypoint Dispatch (`docker-entrypoint.sh`)

The container entrypoint multiplexes commands:

- **Default (`server/run.ts`)**: Boots the Deno sync server.
- **Hash Utility (`docker run ... hash`)**: Executes `server/hash-admin-password.ts` to interactively generate admin password salts and hashes.
- **Deno CLI Passthrough (`docker run ... test / fmt`)**: Delegates directly to the Deno CLI.

---

## 4. Production Deployment & Operations

### 4.1 Environment Configuration Reference

| Environment Variable  | CLI Flag Equivalent | Default Value                                | Description                                             |
| :-------------------- | :------------------ | :------------------------------------------- | :------------------------------------------------------ |
| `ADMIN_PASSWORD_HASH` | `--adminpwhash`     | _(Required for admin)_                       | Base64URL encoded Argon2 admin password hash            |
| `ADMIN_PASSWORD_SALT` | `--adminpwsalt`     | _(Required for admin)_                       | Base64URL encoded Argon2 admin salt                     |
| `DB_PATH`             | `--db`              | `.data/tiddly.db` (`/data/pwa.db` in Docker) | Absolute or relative filesystem path to SQLite database |
| `HOST`                | `--host`            | `0.0.0.0`                                    | Network interface to bind to                            |
| `PORT`                | `--port`            | `8000`                                       | TCP port to listen on                                   |
| `SOCKET`              | `--socket`          | _(None)_                                     | Filesystem path for Unix Domain Socket binding          |
| `BASE_PATH`           | `--basepath`        | `""` (root)                                  | Path prefix when running behind a reverse proxy subpath |

### 4.2 Step-by-Step Production Setup

#### 1. Generate Admin Credentials

```shell
docker run -it --rm ghcr.io/mblackman/tiddlypwa:latest hash
```

Enter a strong password. Note the resulting outputs:

```text
ADMIN_PASSWORD_HASH=...
ADMIN_PASSWORD_SALT=...
```

#### 2. Compose Deployment (`docker-compose.yml`)

```yaml
services:
  tiddlypwa:
    image: ghcr.io/mblackman/tiddlypwa:latest
    container_name: tiddlypwa
    restart: unless-stopped
    ports:
      - '127.0.0.1:8000:8000'
    environment:
      - ADMIN_PASSWORD_HASH=${ADMIN_PASSWORD_HASH}
      - ADMIN_PASSWORD_SALT=${ADMIN_PASSWORD_SALT}
      - DB_PATH=/data/pwa.db
    volumes:
      - tiddly_data:/data

volumes:
  tiddly_data:
```

#### 3. Run Container

```shell
docker compose up -d
```

---

## 5. Reverse Proxy Configuration (Nginx & Caddy)

> [!IMPORTANT]
> TiddlyPWA **requires HTTPS** in production. Modern Web APIs including [WebCrypto](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API), [Service Workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API), and the [Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) are strictly restricted to Secure Contexts (`https://` or `localhost`).

### 5.1 Nginx Reverse Proxy

Key requirements for Nginx:

- **SSE Buffering Disabled**: Must disable proxy buffering on `/tid.dly` to ensure real-time Server-Sent Events stream immediately.
- **Pass Through Headers**: Forward `Host`, `X-Real-IP`, and `X-Forwarded-For`.

```nginx
server {
    listen 443 ssl http2;
    server_name notes.example.com;

    ssl_certificate /etc/letsencrypt/live/notes.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/notes.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Disable buffering for Server-Sent Events (SSE)
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

### 5.2 Caddy Reverse Proxy

Caddy handles automatic HTTPS provisioning and stream flushing natively:

```caddy
notes.example.com {
    reverse_proxy 127.0.0.1:8000 {
        # Flush SSE buffers immediately
        flush_interval -1
    }
}
```
