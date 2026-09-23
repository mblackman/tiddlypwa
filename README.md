# TiddlyPWA

[![Docker Build](https://github.com/mblackman/tiddlypwa/actions/workflows/docker.yml/badge.svg)](https://github.com/mblackman/tiddlypwa/actions/workflows/docker.yml)
[![License: 0BSD](https://img.shields.io/badge/License-0BSD-blue.svg)](LICENSE)
[![Deno](https://img.shields.io/badge/Deno-2.x-black?logo=deno)](https://deno.com)

TiddlyPWA turns [TiddlyWiki](https://tiddlywiki.com) into an **offline-first** Progressive Web App with **client-side encrypted** local persistent storage and efficient, zero-knowledge **synchronization** with a lightweight server.

This repository is an actively maintained fork of [Val Packett's TiddlyPWA](https://codeberg.org/valpackett/tiddlypwa) (originally hosted on Codeberg).

## Features

- **Offline-First PWA**: Installable on desktop and mobile browsers. Works completely offline via service worker and IndexedDB caching.
- **Zero-Knowledge Encryption**: All wiki content is encrypted on the client side using AES-GCM before transmission. The sync server stores only encrypted payloads and never possesses your decryption keys or plaintext content.
- **Lightweight Sync Backend**: Backed by embedded SQLite, requiring minimal CPU and memory footprints. Perfect for home servers, NAS, or low-cost VPS instances.
- **Multi-Wiki / Multi-Tenant Support**: Manage multiple independent notebooks using unique sync tokens on a single backend instance without data overlap.
- **Conflict Resolution**: Gracefully detects out-of-order writes and concurrent edits across multiple devices, offering visual banners and resolution workflows.

## Architecture & Design Documentation

Comprehensive technical specifications and architecture documentation are available in the [`docs/`](docs/) directory:

- [**Documentation Hub & Index**](docs/README.md): Reader guide for humans and semantic mapping for AI/LLMs.
- [**System Overview**](docs/architecture/overview.md): High-level topology, component model, runtime lifecycle, and offline PWA behavior.
- [**Cryptography & Security**](docs/architecture/cryptography.md): Zero-knowledge model, Argon2id WASM, HKDF key expansion, 8-key AES-GCM wear-out mitigation, and padding obfuscation.
- [**Synchronization Protocol**](docs/architecture/sync-protocol.md): JSON-RPC wire protocol (`POST /tid.dly`), SSE real-time sync, monotonic delta sync, and multi-tab Web Locks coordination.
- [**Conflict Resolution**](docs/architecture/conflict-resolution.md): 4-way conflict matrix, content-aware deduplication, non-destructive resolution, and IndexedDB transaction decoupling.
- [**Data Models & Schemas**](docs/architecture/data-models.md): SQLite v1/v2 schemas, client IndexedDB stores, and runtime `$:/status` registers.
- [**Development & Operations**](docs/architecture/development-and-operations.md): Deno 2 tooling, standalone HTML compilation, Docker multi-arch containers, and production reverse proxying.

## Quick Start with Docker

The fastest way to deploy the TiddlyPWA sync server is using Docker or Docker Compose.

### 1. Generate Admin Credentials

The sync server uses Argon2 password hashing for admin operations (such as token provisioning). Generate your hash and salt using the container utility:

```shell
docker run -it --rm ghcr.io/mblackman/tiddlypwa:latest hash
```

This will prompt for a password and output:

```text
ADMIN_PASSWORD_HASH=...
ADMIN_PASSWORD_SALT=...
```

### 2. Configure and Run via Docker Compose

A preconfigured [docker-compose.yml](file:///Users/mblackman/workspace/gh/tiddlypwa/docker-compose.yml) is included:

```yaml
services:
  tiddlypwa:
    image: ghcr.io/mblackman/tiddlypwa:latest
    container_name: tiddlypwa
    restart: unless-stopped
    ports:
      - '8000:8000'
    environment:
      - ADMIN_PASSWORD_HASH=${ADMIN_PASSWORD_HASH}
      - ADMIN_PASSWORD_SALT=${ADMIN_PASSWORD_SALT}
      - DB_PATH=/data/pwa.db
    volumes:
      - tiddly_data:/data

volumes:
  tiddly_data:
```

Store your generated hash and salt in a `.env` file next to `docker-compose.yml`:

```env
ADMIN_PASSWORD_HASH=<your-generated-hash>
ADMIN_PASSWORD_SALT=<your-generated-salt>
```

Start the container:

```shell
docker compose up -d
```

### 3. Running with `docker run`

You can also run the container directly without Docker Compose:

```shell
docker run -d \
  --name tiddlypwa \
  --restart unless-stopped \
  -p 8000:8000 \
  -e ADMIN_PASSWORD_HASH="<your-hash>" \
  -e ADMIN_PASSWORD_SALT="<your-salt>" \
  -v tiddly_data:/data \
  ghcr.io/mblackman/tiddlypwa:latest
```

## Local Development

### Prerequisites

- [Deno 2.x](https://deno.com)
- [Node.js](https://nodejs.org) (optional, only needed for compiling TiddlyWiki HTML bundles)

### Running the Server Locally

1. Generate admin credentials:
   ```shell
   deno run --allow-env server/hash-admin-password.ts
   ```

2. Start the sync server:
   ```shell
   deno run --allow-net --allow-env --allow-read --allow-write server/run.ts --port 8000
   ```
   _(Or pass `--dotenv` to automatically load variables from a local `.env` file)_

3. Run the test suite:
   ```shell
   deno test
   ```

### Code Formatting

All code must be formatted using Deno:

```shell
deno fmt
```

### Building the TiddlyWiki Client

To compile the standalone HTML distribution files and service worker (assuming the Paul Rouse [Notebook theme](https://github.com/paul-rouse/Notebook) is checked out locally):

```shell
TIDDLYWIKI_THEME_PATH=$HOME/src/github.com/paul-rouse/Notebook/themes \
TIDDLYWIKI_PLUGIN_PATH=$HOME/src/github.com/paul-rouse/Notebook/plugins \
npx tiddlywiki@5.4.1 --build
```

Compiled assets are written to the `output/` directory.

## Credits & License

- **Original Project**: Created by [Val Packett](https://codeberg.org/valpackett) as [TiddlyPWA on Codeberg](https://codeberg.org/valpackett/tiddlypwa).
- **Fork & Maintainer**: Maintained by [Matt Blackman](https://github.com/mblackman) with focus on Deno 2 modernization, multi-tenancy, and production containerization.
- **License**: Released under the [BSD Zero Clause License (0BSD)](LICENSE).
