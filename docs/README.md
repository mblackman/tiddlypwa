# TiddlyPWA Documentation Hub

Welcome to the technical architecture and design documentation for **TiddlyPWA**.

TiddlyPWA transforms [TiddlyWiki](https://tiddlywiki.com) into an offline-first, client-side encrypted Progressive Web App (PWA) with zero-knowledge synchronization backed by a lightweight Deno server and SQLite datastore.

---

## Documentation Index

| Document                                                                   | Focus Areas                                                                                                    | Primary Audiences                        |
| :------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------- | :--------------------------------------- |
| [**System Overview**](architecture/overview.md)                            | High-level topology, component model, runtime lifecycle, and offline PWA behavior                              | All Developers, Architects, LLMs         |
| [**Cryptography & Security**](architecture/cryptography.md)                | Zero-knowledge threat model, Argon2id WASM, HKDF key derivation, 8x AES-GCM wear-out mitigation, block padding | Security Auditors, Core Devs, LLMs       |
| [**Sync Protocol & Realtime**](architecture/sync-protocol.md)              | JSON-RPC wire protocol, Server-Sent Events, monotonic clock checks, multi-tab election                         | Backend/Frontend Devs, Integrators, LLMs |
| [**Conflict Resolution**](architecture/conflict-resolution.md)             | 4-way conflict matrix, content deduplication, non-destructive resolution, IDB async decoupling                 | Core Devs, UI Engineers, LLMs            |
| [**Data Models & Schemas**](architecture/data-models.md)                   | SQLite v1/v2 schemas, IndexedDB stores, runtime `$:/status` registers, entity relationships                    | Database Devs, Maintainers, LLMs         |
| [**Development & Operations**](architecture/development-and-operations.md) | Deno 2 tooling, standalone HTML compilation, Docker multi-arch containers, reverse proxies                     | DevOps, SREs, Contributors, LLMs         |

---

## Navigation Guide for Humans

- **New Contributors**: Begin with the [System Overview](architecture/overview.md) to build a mental model of the client-server boundary, followed by [Development & Operations](architecture/development-and-operations.md) to set up your local Deno environment and run tests.
- **Security & Cryptography Auditors**: Review [Cryptography & Security](architecture/cryptography.md) for the mathematical parameters (Argon2id, HKDF, AES-GCM-256), nonce collision bounds, and zero-knowledge guarantees.
- **Backend & Protocol Engineers**: Explore [Sync Protocol & Realtime](architecture/sync-protocol.md) and [Data Models & Schemas](architecture/data-models.md) to understand multi-tenant isolation, SQLite migration versioning, and real-time SSE broadcasts.
- **Frontend & PWA Specialists**: Read [Conflict Resolution](architecture/conflict-resolution.md) and [System Overview](architecture/overview.md) to examine the Service Worker cache layer, Web App Manifest generation, and non-destructive conflict handling.

---

## Machine-Readable Reference for LLMs

If you are an LLM agent reviewing or modifying this codebase, use the following operational invariants and semantic file maps.

### Core Architectural Invariants

1. **Zero-Knowledge Backend**:
   - The server **never** receives, generates, stores, or verifies plaintext tiddler titles, body text, tags, or fields.
   - Title indexing uses keyed HMAC-SHA-256 (`thash = HMAC(title, mackey)`).
   - The server only inspects unencrypted metadata: `mtime` (ISO date/timestamp) and `deleted` (boolean).
2. **Deterministic Multi-Tenant Scoping**:
   - Every wiki is identified by a 32-byte URL-safe base64 `token`.
   - SQLite tables `tiddlers` and `wikifiles` enforce composite primary keys `(token, thash)` and `(token, name)` with `FOREIGN KEY (token) REFERENCES wikis(token) ON DELETE CASCADE`.
   - The server must never allow cross-tenant data leakage, even when two independent wikis store tiddlers with identical titles.
3. **Cryptographic Wear-out Mitigation**:
   - Client derives 8 distinct AES-GCM-256 keys via HKDF.
   - The active key for a tiddler is determined by `enckeys[DataView(thash).getUint8(0) % 8]`.
   - Plaintexts are padded to 256-byte boundaries (`encodeData`) to prevent ciphertext length leakage.
4. **Non-Destructive Conflict Preservation**:
   - When a remote change collides with a local dirty change, content equality is verified first to suppress false conflicts.
   - If divergent, Last-Write-Wins (LWW) selects the canonical version, but the superseded version is **always preserved** as a new tiddler tagged `$:/tags/TiddlyPWA/Conflict` with `tiddlypwa-conflict-of` referencing the original title.
5. **Decoupled IndexedDB Transactions**:
   - WebCrypto operations (`crypto.subtle.decrypt` / `encrypt`) are asynchronous and must never be awaited within an open IndexedDB transaction callback (which causes premature transaction auto-commit).
   - Decrypt payloads into memory _first_, then perform synchronous batch writes in a single IndexedDB transaction.

### Semantic Codebase Map

| File Path                             | Component           | Responsibility                                                                                                                 |
| :------------------------------------ | :------------------ | :----------------------------------------------------------------------------------------------------------------------------- |
| `plugins/tiddlypwa/main.js`           | Client / Core       | Implements `PWAStorage` (`syncadaptor`), IndexedDB lifecycle, crypto initialization, sync coordinator, and conflict resolution |
| `plugins/tiddlypwa/bootstrap.js`      | Client / UI         | First-boot modal dialog, master password prompt, token/salt ingestion, and bootstrap discovery                                 |
| `plugins/tiddlypwa/encoding.js`       | Client / Crypto     | Binary/text serialization, Gzip compression via `CompressionStream`, and 256-byte block padding                                |
| `plugins/tiddlypwa/argon2ian.js`      | Client / Crypto     | WebAssembly worker bridge for Argon2id key stretching (`m=131072, t=2`)                                                        |
| `plugins/tiddlypwa/sw.js`             | Client / PWA        | Stale-While-Revalidate service worker for app HTML and asset caching                                                           |
| `plugins/tiddlypwa/saver.js`          | Client / TiddlyWiki | High-priority TiddlyWiki saver triggering local DB save and modal export                                                       |
| `plugins/tiddlypwa/kill-put-saver.js` | Client / TiddlyWiki | Neutralizes built-in `$:/core/modules/savers/put.js` network probing                                                           |
| `plugins/tiddlypwa/filters.js`        | Client / TiddlyWiki | Filter operator `[is[tiddlypwa]]` distinguishing stored vs file-baked tiddlers                                                 |
| `plugins/web-app-manifest/main.js`    | Client / PWA        | Dynamic Web App Manifest generation, icon parsing, and Blob URL injection                                                      |
| `server/app.ts`                       | Server / HTTP       | Main `TiddlyPWASyncApp` handler, route dispatching, JSON-RPC handling, and SSE stream controller                               |
| `server/sqlite.ts`                    | Server / DB         | `SQLiteDatastore` implementation, schema migration (v1 -> v2), prepared queries, and LWW upserts                               |
| `server/run.ts`                       | Server / CLI        | Entrypoint runner supporting CLI flags (`--port`, `--host`, `--db`, `--dotenv`), environment variables, and Unix sockets       |
| `server/hash-admin-password.ts`       | Server / Admin      | CLI utility generating Argon2 salt and hash for `ADMIN_PASSWORD_*` credentials                                                 |
| `server/pages.ts`                     | Server / UI         | Self-contained single-file HTML/CSS/JS control panel served at `/`                                                             |
| `tiddlywiki.info`                     | Build / Pipeline    | TiddlyWiki CLI configuration defining build targets (`index.html`, `app/app.html`, `sw.js`, `bootstrap.json`)                  |
| `Dockerfile`                          | Deploy / Docker     | Minimal Deno 2 container image with `tini` process reaper, `/data` volume, and entrypoint delegation                           |
| `docker-entrypoint.sh`                | Deploy / Docker     | Container entrypoint script multiplexing between server execution, password hashing, and arbitrary Deno subcommands            |

### Error Codes Catalog

| Code        | HTTP Status        | Description                                                                | Client Action                             |
| :---------- | :----------------- | :------------------------------------------------------------------------- | :---------------------------------------- |
| `EAUTH`     | `401 Unauthorized` | Invalid admin token, incorrect sync token, or mismatched `authcode`        | Prompt user for credentials; prevent sync |
| `EPROTO`    | `400 Bad Request`  | Malformed JSON-RPC payload, missing required fields, or unrecognized `op`  | Log error; abort operation                |
| `ETIMESYNC` | `400 Bad Request`  | Client `now` differs from server clock by more than 60,000 ms (60 seconds) | Alert user to calibrate system clock      |
| `EEXIST`    | `404 Not Found`    | Requested wiki token or app file does not exist                            | Verify server URL and token               |
