import { DatabaseSync, StatementSync } from 'node:sqlite';
import {
	Datastore,
	File,
	PendingWatcherPatchRow,
	PushSubscriptionRow,
	ScheduledNotificationRow,
	Tiddler,
	WatcherModuleRow,
	Wiki,
} from './data.d.ts';

const sql = String.raw; // For tools/editors

function parseTime(x: number) {
	const time = new Date();
	time.setTime(x);
	return time;
}

type BindParams = Record<string, any>;

function normalizeParams(params?: Record<string, unknown>): BindParams | undefined {
	if (!params) return undefined;
	const out: BindParams = {};
	for (const [k, v] of Object.entries(params)) {
		out[k] = v === undefined ? null : v;
	}
	return out;
}

export class SQLiteDatastore implements Datastore {
	#db: DatabaseSync;
	#changes = 0;
	#txnDepth = 0;
	#savepointSeq = 0;
	#closed = false;

	#getConfigStmt: StatementSync;
	#wikiStmt: StatementSync;
	#wikiPrefixStmt: StatementSync;
	#wikiFileStmt: StatementSync;
	#changedStmt: StatementSync;
	#tiddlerStmt: StatementSync;
	#maxMtimeStmt: StatementSync;
	#insertStmt: StatementSync;
	#updateWithBaseMtimeStmt: StatementSync;
	#updateWithMtimeStmt: StatementSync;

	constructor(path = ':memory:') {
		this.#db = new DatabaseSync(path);
		if (path !== ':memory:') {
			this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
		}
		this.#db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
		this.migrate();

		this.#getConfigStmt = this.#prep(sql`SELECT value FROM server_config WHERE key = :key`);
		this.#wikiStmt = this.#prep(
			sql`SELECT token, authcode, salt, note, watcher_pubkey FROM wikis WHERE token = :token`,
		);
		this.#wikiPrefixStmt = this.#prep(
			sql`SELECT token, authcode, salt, note, watcher_pubkey FROM wikis WHERE substr(token, 1, length(:halftoken)) = :halftoken`,
		);
		this.#wikiFileStmt = this.#prep(sql`
			SELECT files.etag AS etag, rawsize, ctype, body
			FROM files, wikifiles
			WHERE files.etag = wikifiles.etag AND wikifiles.name = :name AND substr(wikifiles.token, 1, length(:halftoken)) = :halftoken
		`);
		this.#changedStmt = this.#prep(sql`
			SELECT thash, iv, ct, sbiv, sbct, mtime, deleted
			FROM tiddlers WHERE mtime > :modsince AND token = :token
			ORDER BY mtime ASC
		`);
		this.#tiddlerStmt = this.#prep(sql`
			SELECT thash, iv, ct, sbiv, sbct, mtime, deleted
			FROM tiddlers WHERE token = :token AND thash = :thash
		`);
		this.#maxMtimeStmt = this.#prep(sql`
			SELECT max(mtime) AS mtime FROM tiddlers WHERE token = :token
		`);
		this.#insertStmt = this.#prep(sql`
			INSERT INTO tiddlers (token, thash, iv, ct, sbiv, sbct, mtime, deleted)
			VALUES (:token, :thash, :iv, :ct, :sbiv, :sbct, :mtime, :deleted)
			ON CONFLICT (token, thash) DO NOTHING
		`);
		this.#updateWithBaseMtimeStmt = this.#prep(sql`
			UPDATE tiddlers SET
				iv = :iv,
				ct = :ct,
				sbiv = :sbiv,
				sbct = :sbct,
				mtime = :mtime,
				deleted = :deleted
			WHERE token = :token AND thash = :thash AND mtime <= :baseMtime
		`);
		this.#updateWithMtimeStmt = this.#prep(sql`
			UPDATE tiddlers SET
				iv = :iv,
				ct = :ct,
				sbiv = :sbiv,
				sbct = :sbct,
				mtime = :mtime,
				deleted = :deleted
			WHERE token = :token AND thash = :thash AND mtime < :clientMtime
		`);
	}

	#prep(queryStr: string): StatementSync {
		const stmt = this.#db.prepare(queryStr);
		stmt.setAllowUnknownNamedParameters(true);
		return stmt;
	}

	get changes(): number {
		return this.#changes;
	}

	execute(queryStr: string): void {
		this.#db.exec(queryStr);
	}

	query<T = unknown[]>(queryStr: string, params?: Record<string, unknown>): T[] {
		const stmt = this.#prep(queryStr);
		const bound = normalizeParams(params);
		if (stmt.columns().length === 0) {
			const info = bound ? stmt.run(bound) : stmt.run();
			this.#changes = Number(info.changes);
			return [];
		}
		(stmt as unknown as { setReturnArrays(enabled: boolean): void }).setReturnArrays(true);
		return (bound ? stmt.all(bound) : stmt.all()) as T[];
	}

	queryEntries<T extends Record<string, unknown> = Record<string, unknown>>(
		queryStr: string,
		params?: Record<string, unknown>,
	): T[] {
		const stmt = this.#prep(queryStr);
		const bound = normalizeParams(params);
		const rows = (bound ? stmt.all(bound) : stmt.all()) as Record<string, unknown>[];
		return rows.map((r) => ({ ...r }) as T);
	}

	transaction(f: () => void): void {
		const depth = this.#txnDepth;
		this.#txnDepth++;
		if (depth === 0) {
			this.#db.exec('BEGIN');
			try {
				f();
				this.#db.exec('COMMIT');
			} catch (err) {
				try {
					this.#db.exec('ROLLBACK');
				} catch (_rbErr) {
					// ignore rollback errors after failure
				}
				throw err;
			} finally {
				this.#txnDepth--;
			}
			return;
		}
		const spName = `sp_${++this.#savepointSeq}`;
		this.#db.exec(`SAVEPOINT ${spName}`);
		try {
			f();
			this.#db.exec(`RELEASE SAVEPOINT ${spName}`);
		} catch (err) {
			try {
				this.#db.exec(`ROLLBACK TO SAVEPOINT ${spName}; RELEASE SAVEPOINT ${spName}`);
			} catch (_rbErr) {
				// ignore rollback errors after failure
			}
			throw err;
		} finally {
			this.#txnDepth--;
		}
	}

	close(_force?: boolean): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#db.close();
	}

	migrate() {
		const ver = this.query<[number]>('PRAGMA user_version')[0][0];
		if (ver < 1) {
			this.execute(sql`
				BEGIN;
				CREATE TABLE wikis (
					token TEXT PRIMARY KEY NOT NULL,
					authcode TEXT,
					salt TEXT,
					note TEXT
				) STRICT;
				CREATE TABLE files (
					etag BLOB PRIMARY KEY NOT NULL,
					rawsize INTEGER NOT NULL,
					ctype TEXT NOT NULL,
					body BLOB NOT NULL
				) STRICT;
				CREATE TABLE wikifiles (
					token TEXT NOT NULL,
					etag BLOB NOT NULL,
					name TEXT NOT NULL,
					FOREIGN KEY(token) REFERENCES wikis(token) ON DELETE CASCADE,
					FOREIGN KEY(etag) REFERENCES files(etag),
					PRIMARY KEY (token, name)
				) STRICT;
				CREATE TRIGGER files_cleanup AFTER DELETE ON wikifiles BEGIN
					DELETE FROM files WHERE etag = OLD.etag AND (SELECT COUNT(*) FROM wikifiles WHERE etag = OLD.etag) = 0;
				END;
				CREATE TABLE tiddlers (
					token TEXT NOT NULL,
					thash BLOB NOT NULL,
					iv BLOB,
					ct BLOB,
					sbiv BLOB,
					sbct BLOB,
					mtime INTEGER NOT NULL,
					deleted INTEGER NOT NULL DEFAULT 0,
					FOREIGN KEY(token) REFERENCES wikis(token) ON DELETE CASCADE,
					PRIMARY KEY (token, thash)
				) STRICT;
				CREATE INDEX idx_tiddlers_token_mtime ON tiddlers (token, mtime);
				PRAGMA user_version = 2;
				COMMIT;
			`);
		} else if (ver < 2) {
			this.execute(sql`
				PRAGMA foreign_keys = OFF;
				BEGIN TRANSACTION;

				DELETE FROM tiddlers WHERE token NOT IN (SELECT token FROM wikis);

				CREATE TABLE tiddlers_new (
					token TEXT NOT NULL,
					thash BLOB NOT NULL,
					iv BLOB,
					ct BLOB,
					sbiv BLOB,
					sbct BLOB,
					mtime INTEGER NOT NULL,
					deleted INTEGER NOT NULL DEFAULT 0,
					FOREIGN KEY(token) REFERENCES wikis(token) ON DELETE CASCADE,
					PRIMARY KEY (token, thash)
				) STRICT;

				INSERT INTO tiddlers_new (token, thash, iv, ct, sbiv, sbct, mtime, deleted)
				SELECT token, thash, iv, ct, sbiv, sbct, mtime, deleted FROM tiddlers;

				DROP TABLE tiddlers;
				ALTER TABLE tiddlers_new RENAME TO tiddlers;

				CREATE INDEX idx_tiddlers_token_mtime ON tiddlers (token, mtime);

				PRAGMA user_version = 2;
				PRAGMA foreign_key_check;
				COMMIT;
				PRAGMA foreign_keys = ON;
			`);
		}

		const verAfterV2 = this.query<[number]>('PRAGMA user_version')[0][0];
		if (verAfterV2 < 3) {
			const wikiCols = this.query<[number, string]>(sql`PRAGMA table_info(wikis)`).map((r) => r[1]);
			const addWatcherPubKeySql = wikiCols.includes('watcher_pubkey')
				? ''
				: 'ALTER TABLE wikis ADD COLUMN watcher_pubkey TEXT;';
			this.execute(sql`
				BEGIN TRANSACTION;

				${addWatcherPubKeySql}

				CREATE TABLE IF NOT EXISTS server_config (
					key TEXT PRIMARY KEY NOT NULL,
					value TEXT NOT NULL
				) STRICT;

				CREATE TABLE IF NOT EXISTS push_subscriptions (
					token TEXT NOT NULL,
					endpoint TEXT NOT NULL,
					p256dh TEXT NOT NULL,
					auth TEXT NOT NULL,
					ua_hint TEXT,
					created_at INTEGER NOT NULL,
					FOREIGN KEY(token) REFERENCES wikis(token) ON DELETE CASCADE,
					PRIMARY KEY (token, endpoint)
				) STRICT;

				CREATE TABLE IF NOT EXISTS watcher_modules (
					token TEXT NOT NULL,
					watcher_id TEXT NOT NULL,
					code_hash TEXT NOT NULL,
					code_source TEXT NOT NULL,
					allowed_hosts TEXT NOT NULL,
					schedule_cron TEXT NOT NULL,
					timezone TEXT NOT NULL DEFAULT 'UTC',
					watched_items TEXT NOT NULL,
					signature TEXT NOT NULL,
					state_json TEXT NOT NULL DEFAULT '{}',
					last_run_at INTEGER NOT NULL DEFAULT 0,
					last_error TEXT,
					FOREIGN KEY(token) REFERENCES wikis(token) ON DELETE CASCADE,
					PRIMARY KEY (token, watcher_id)
				) STRICT;

				CREATE TABLE IF NOT EXISTS pending_watcher_patches (
					patch_id TEXT NOT NULL,
					token TEXT NOT NULL,
					watcher_id TEXT NOT NULL,
					patch_json TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					FOREIGN KEY(token) REFERENCES wikis(token) ON DELETE CASCADE,
					PRIMARY KEY (token, patch_id)
				) STRICT;

				CREATE TABLE IF NOT EXISTS scheduled_notifications (
					token TEXT NOT NULL,
					schedule_id TEXT NOT NULL,
					trigger_at INTEGER NOT NULL,
					payload_json TEXT NOT NULL,
					target_endpoint TEXT,
					created_at INTEGER NOT NULL,
					FOREIGN KEY(token) REFERENCES wikis(token) ON DELETE CASCADE,
					PRIMARY KEY (token, schedule_id)
				) STRICT;

				CREATE INDEX IF NOT EXISTS idx_scheduled_notif_trigger ON scheduled_notifications (trigger_at);

				PRAGMA user_version = 3;
				COMMIT;
			`);
		}

		const verAfterV3 = this.query<[number]>('PRAGMA user_version')[0][0];
		if (verAfterV3 < 4) {
			this.execute(sql`
				BEGIN TRANSACTION;
				INSERT INTO server_config (key, value) VALUES ('tombstone_horizon', '0')
				ON CONFLICT (key) DO NOTHING;
				PRAGMA user_version = 4;
				COMMIT;
			`);
		}
	}

	getServerConfig(key: string): string | undefined {
		const row = this.#getConfigStmt.get({ key }) as { value: string } | undefined;
		return row ? row.value : undefined;
	}

	setServerConfig(key: string, value: string): void {
		this.query(
			sql`INSERT INTO server_config (key, value) VALUES (:key, :value) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
			{ key, value },
		);
	}

	getWiki(token: string): Wiki | undefined {
		const row = this.#wikiStmt.get({ token }) as Wiki | undefined;
		return row ? { ...row } : undefined;
	}

	getWikiByPrefix(halftoken: string): Wiki | undefined {
		const row = this.#wikiPrefixStmt.get({ halftoken }) as Wiki | undefined;
		return row ? { ...row } : undefined;
	}

	listWikis() {
		return this.queryEntries<
			{
				token: string;
				authcode?: string;
				salt?: string;
				note?: string;
				watcher_pubkey?: string;
				tidsize: number;
				appsize: number;
			}
		>(sql`
			SELECT token, authcode, salt, note, watcher_pubkey, (
				SELECT sum(length(thash) + length(iv) + length(ct) + length(sbiv) + length(sbct))
				FROM tiddlers
				WHERE tiddlers.token = wikis.token
			) AS tidsize, (
				SELECT sum(length(body)) FROM files, wikifiles WHERE files.etag = wikifiles.etag AND wikifiles.token = wikis.token
			) AS appsize FROM wikis
		`);
	}

	createWiki(token: string, note?: string) {
		this.query(sql`INSERT INTO wikis (token, note) VALUES (:token, :note)`, { token, note });
	}

	updateWikiAuthcode(token: string, authcode?: string | null) {
		this.query(sql`UPDATE wikis SET authcode = :authcode WHERE token = :token`, { token, authcode });
	}

	updateWikiSalt(token: string, salt: string) {
		this.query(sql`UPDATE wikis SET salt = :salt WHERE token = :token`, { token, salt });
	}

	updateWikiWatcherPubKey(token: string, pubkey?: string | null) {
		this.query(sql`UPDATE wikis SET watcher_pubkey = :pubkey WHERE token = :token`, { token, pubkey });
	}

	deleteWiki(token: string) {
		this.query(sql`DELETE FROM wikis WHERE token = :token`, { token });
	}

	fileExists(etag: Uint8Array): boolean {
		const count = this.query<[number]>(sql`SELECT count(*) FROM files WHERE etag = :etag`, { etag })[0][0];
		return Number(count) > 0;
	}

	storeFile(file: File) {
		this.query(sql`INSERT INTO files (etag, rawsize, ctype, body) VALUES (:etag, :rawsize, :ctype, :body)`, file);
	}

	associateFile(token: string, etag: Uint8Array, name: string) {
		const o = { token, etag, name };
		this.transaction(() => {
			this.query(sql`DELETE FROM wikifiles WHERE token = :token AND etag <> :etag AND name = :name`, o);
			this.query(
				sql`INSERT INTO wikifiles (token, etag, name) VALUES (:token, :etag, :name) ON CONFLICT DO NOTHING`,
				o,
			);
		});
	}

	dissociateFiles(token: string) {
		this.query(sql`DELETE FROM wikifiles WHERE token = :token`, { token });
	}

	dissociateAllFiles() {
		this.query(sql`DELETE FROM wikifiles`);
	}

	getWikiFile(halftoken: string, name: string): File | undefined {
		const row = this.#wikiFileStmt.get({ halftoken, name }) as File | undefined;
		return row ? { ...row } : undefined;
	}

	*tiddlersChangedSince(token: string, since: Date) {
		const rows = this.#changedStmt.all({ modsince: since.getTime(), token }) as Array<{
			thash: Uint8Array;
			iv?: Uint8Array;
			ct?: Uint8Array;
			sbiv?: Uint8Array;
			sbct?: Uint8Array;
			mtime: number;
			deleted: number;
		}>;
		for (const tiddler of rows) {
			yield { ...tiddler, mtime: parseTime(tiddler.mtime), deleted: !!tiddler.deleted };
		}
	}

	getTiddler(token: string, thash: Uint8Array): Tiddler | undefined {
		const row = this.#tiddlerStmt.get({ token, thash }) as {
			thash: Uint8Array;
			iv?: Uint8Array;
			ct?: Uint8Array;
			sbiv?: Uint8Array;
			sbct?: Uint8Array;
			mtime: number;
			deleted: number;
		} | undefined;
		if (!row) return undefined;
		return { ...row, mtime: parseTime(row.mtime), deleted: Boolean(row.deleted) };
	}

	maxMtime(token: string): number {
		const row = this.#maxMtimeStmt.get({ token }) as { mtime: number | null } | undefined;
		return row && row.mtime !== null ? row.mtime : 0;
	}

	getNextMtime(token: string): number {
		const maxMtime = this.maxMtime(token);
		return Math.max(Date.now(), maxMtime + 1);
	}

	upsertTiddler(token: string, tiddler: Tiddler, writeMtimeMs?: number): { success: boolean; conflict?: boolean } {
		const clientMtimeMs = tiddler.mtime.getTime();
		const finalMtimeMs = writeMtimeMs !== undefined ? writeMtimeMs : clientMtimeMs;

		const params = normalizeParams({
			token,
			thash: tiddler.thash,
			iv: tiddler.iv,
			ct: tiddler.ct,
			sbiv: tiddler.sbiv,
			sbct: tiddler.sbct,
			mtime: finalMtimeMs,
			deleted: tiddler.deleted ? 1 : 0,
		})!;

		// Try insert first (handles the common case of new tiddlers).
		this.#changes = Number(this.#insertStmt.run(params).changes);
		if (this.#changes > 0) {
			return { success: true };
		}

		// Row exists - attempt atomic conditional update.
		if (tiddler.baseMtime === null) {
			// Concurrent offline creation collision: row already exists on server.
			return { success: false, conflict: true };
		}
		if (tiddler.baseMtime !== undefined) {
			this.#changes = Number(
				this.#updateWithBaseMtimeStmt.run({
					...params,
					baseMtime: tiddler.baseMtime.getTime(),
				}).changes,
			);
		} else {
			// Backward compatibility: update only if our mtime is strictly newer.
			this.#changes = Number(
				this.#updateWithMtimeStmt.run({
					...params,
					clientMtime: clientMtimeMs,
				}).changes,
			);
		}

		if (this.#changes > 0) {
			return { success: true };
		}
		return { success: false, conflict: true };
	}

	getTombstoneHorizon(): number {
		const raw = this.getServerConfig('tombstone_horizon');
		const n = raw ? Number(raw) : 0;
		return Number.isFinite(n) ? n : 0;
	}

	pruneTombstones(cutoffMs: number): number {
		if (!Number.isFinite(cutoffMs) || cutoffMs <= 0) return 0;
		let pruned = 0;
		this.transaction(() => {
			this.query(sql`DELETE FROM tiddlers WHERE deleted = 1 AND mtime < :cutoffMs`, { cutoffMs });
			pruned = this.#changes;
			const nextHorizon = Math.max(this.getTombstoneHorizon(), cutoffMs);
			this.setServerConfig('tombstone_horizon', String(nextHorizon));
		});
		return pruned;
	}

	upsertPushSubscription(sub: PushSubscriptionRow): void {
		this.query(
			sql`
				INSERT INTO push_subscriptions (token, endpoint, p256dh, auth, ua_hint, created_at)
				VALUES (:token, :endpoint, :p256dh, :auth, :ua_hint, :created_at)
				ON CONFLICT (token, endpoint) DO UPDATE SET
					p256dh = excluded.p256dh,
					auth = excluded.auth,
					ua_hint = excluded.ua_hint,
					created_at = excluded.created_at
			`,
			{
				token: sub.token,
				endpoint: sub.endpoint,
				p256dh: sub.p256dh,
				auth: sub.auth,
				ua_hint: sub.ua_hint ?? null,
				created_at: sub.created_at,
			},
		);
	}

	deletePushSubscription(token: string, endpoint: string): void {
		this.query(sql`DELETE FROM push_subscriptions WHERE token = :token AND endpoint = :endpoint`, { token, endpoint });
	}

	deleteAllPushSubscriptions(token: string): void {
		this.query(sql`DELETE FROM push_subscriptions WHERE token = :token`, { token });
	}

	listPushSubscriptions(token: string): Array<PushSubscriptionRow> {
		return this.queryEntries<PushSubscriptionRow>(
			sql`SELECT token, endpoint, p256dh, auth, ua_hint, created_at FROM push_subscriptions WHERE token = :token ORDER BY created_at ASC`,
			{ token },
		);
	}

	upsertWatcherModule(watcher: Omit<WatcherModuleRow, 'state_json' | 'last_run_at' | 'last_error'>): void {
		this.query(
			sql`
				INSERT INTO watcher_modules (
					token, watcher_id, code_hash, code_source, allowed_hosts, schedule_cron, timezone, watched_items, signature
				) VALUES (
					:token, :watcher_id, :code_hash, :code_source, :allowed_hosts, :schedule_cron, :timezone, :watched_items, :signature
				)
				ON CONFLICT (token, watcher_id) DO UPDATE SET
					code_hash = excluded.code_hash,
					code_source = excluded.code_source,
					allowed_hosts = excluded.allowed_hosts,
					schedule_cron = excluded.schedule_cron,
					timezone = excluded.timezone,
					watched_items = excluded.watched_items,
					signature = excluded.signature
			`,
			watcher,
		);
	}

	deleteWatcherModule(token: string, watcherId: string): void {
		this.query(sql`DELETE FROM watcher_modules WHERE token = :token AND watcher_id = :watcherId`, {
			token,
			watcherId,
		});
	}

	listWatcherModules(token: string): Array<WatcherModuleRow> {
		return this.queryEntries<WatcherModuleRow>(
			sql`
				SELECT token, watcher_id, code_hash, code_source, allowed_hosts, schedule_cron, timezone, watched_items, signature, state_json, last_run_at, last_error
				FROM watcher_modules WHERE token = :token ORDER BY watcher_id ASC
			`,
			{ token },
		);
	}

	getAllWatcherModules(): Array<WatcherModuleRow> {
		return this.queryEntries<WatcherModuleRow>(
			sql`
				SELECT token, watcher_id, code_hash, code_source, allowed_hosts, schedule_cron, timezone, watched_items, signature, state_json, last_run_at, last_error
				FROM watcher_modules ORDER BY token ASC, watcher_id ASC
			`,
		);
	}

	updateWatcherRunState(
		token: string,
		watcherId: string,
		stateJson: string,
		lastRunAt: number,
		lastError: string | null = null,
	): void {
		this.query(
			sql`
				UPDATE watcher_modules
				SET state_json = :stateJson, last_run_at = :lastRunAt, last_error = :lastError
				WHERE token = :token AND watcher_id = :watcherId
			`,
			{ token, watcherId, stateJson, lastRunAt, lastError },
		);
	}

	upsertPendingPatch(patch: PendingWatcherPatchRow): void {
		this.query(
			sql`
				INSERT INTO pending_watcher_patches (patch_id, token, watcher_id, patch_json, created_at)
				VALUES (:patch_id, :token, :watcher_id, :patch_json, :created_at)
				ON CONFLICT (token, patch_id) DO UPDATE SET
					patch_json = excluded.patch_json,
					created_at = excluded.created_at
			`,
			patch,
		);
	}

	listPendingPatches(token: string): Array<PendingWatcherPatchRow> {
		return this.queryEntries<PendingWatcherPatchRow>(
			sql`
				SELECT patch_id, token, watcher_id, patch_json, created_at
				FROM pending_watcher_patches WHERE token = :token ORDER BY created_at ASC
			`,
			{ token },
		);
	}

	deletePendingPatches(token: string, patchIds: string[]): void {
		if (patchIds.length === 0) return;
		this.transaction(() => {
			for (const patchId of patchIds) {
				this.query(sql`DELETE FROM pending_watcher_patches WHERE token = :token AND patch_id = :patchId`, {
					token,
					patchId,
				});
			}
		});
	}

	upsertScheduledNotification(row: ScheduledNotificationRow): void {
		this.query(
			sql`
				INSERT INTO scheduled_notifications (token, schedule_id, trigger_at, payload_json, target_endpoint, created_at)
				VALUES (:token, :schedule_id, :trigger_at, :payload_json, :target_endpoint, :created_at)
				ON CONFLICT (token, schedule_id) DO UPDATE SET
					trigger_at = excluded.trigger_at,
					payload_json = excluded.payload_json,
					target_endpoint = excluded.target_endpoint,
					created_at = excluded.created_at
			`,
			{
				token: row.token,
				schedule_id: row.schedule_id,
				trigger_at: row.trigger_at,
				payload_json: row.payload_json,
				target_endpoint: row.target_endpoint ?? null,
				created_at: row.created_at,
			},
		);
	}

	deleteScheduledNotifications(token: string, scheduleIds: string[]): void {
		if (scheduleIds.length === 0) return;
		this.transaction(() => {
			for (const scheduleId of scheduleIds) {
				this.query(
					sql`DELETE FROM scheduled_notifications WHERE token = :token AND schedule_id = :scheduleId`,
					{ token, scheduleId },
				);
			}
		});
	}

	listDueScheduledNotifications(nowMs: number): Array<ScheduledNotificationRow> {
		return this.queryEntries<ScheduledNotificationRow>(
			sql`
				SELECT token, schedule_id, trigger_at, payload_json, target_endpoint, created_at
				FROM scheduled_notifications WHERE trigger_at <= :nowMs ORDER BY trigger_at ASC
			`,
			{ nowMs },
		);
	}

	listScheduledNotifications(token: string): Array<ScheduledNotificationRow> {
		return this.queryEntries<ScheduledNotificationRow>(
			sql`
				SELECT token, schedule_id, trigger_at, payload_json, target_endpoint, created_at
				FROM scheduled_notifications WHERE token = :token ORDER BY trigger_at ASC
			`,
			{ token },
		);
	}
}
