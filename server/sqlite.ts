/// <reference lib="deno.window" />

import { Datastore, File, Tiddler, Wiki } from './data.d.ts';
import { DB } from 'https://deno.land/x/sqlite@v3.9.0/mod.ts';

const sql = String.raw; // For tools/editors

function parseTime(x: number) {
	const time = new Date();
	time.setTime(x);
	return time;
}

export class SQLiteDatastore extends DB implements Datastore {
	// Unlike the constructor, this runs before other fields (prepared queries)
	#_ = (() => {
		this.execute('PRAGMA foreign_keys = ON;');
		this.migrate();
	})();

	migrate() {
		const ver = this.query('PRAGMA user_version')[0][0] as number;
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
					thash BLOB PRIMARY KEY NOT NULL,
					iv BLOB,
					ct BLOB,
					sbiv BLOB,
					sbct BLOB,
					mtime INTEGER NOT NULL,
					deleted INTEGER NOT NULL DEFAULT 0,
					token TEXT NOT NULL,
					FOREIGN KEY(token) REFERENCES wikis(token) ON DELETE CASCADE
				) STRICT;
				PRAGMA user_version = 1;
				COMMIT;
			`);
		}
	}

	#wikiQuery = this.prepareQuery<[], Wiki>(
		sql`SELECT token, authcode, salt, note FROM wikis WHERE token = :token`,
	);
	getWiki(token: string) {
		const rows = this.#wikiQuery.allEntries({ token });
		if (rows.length < 1) return;
		return rows[0];
	}

	#wikiQueryPrefix = this.prepareQuery<[], Wiki>(
		sql`SELECT token, authcode, salt, note FROM wikis WHERE token LIKE :halftoken || '%'`,
	);
	getWikiByPrefix(halftoken: string) {
		const rows = this.#wikiQueryPrefix.allEntries({ halftoken });
		if (rows.length < 1) return;
		return rows[0];
	}

	listWikis() {
		return this.queryEntries<
			{ token: string; authcode?: string; salt?: string; note?: string; tidsize: number; appsize: number }
		>(sql`
			SELECT token, authcode, salt, note, (
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

	updateWikiAuthcode(token: string, authcode?: string) {
		this.query(sql`UPDATE wikis SET authcode = :authcode WHERE token = :token`, { token, authcode });
	}

	updateWikiSalt(token: string, salt: string) {
		this.query(sql`UPDATE wikis SET salt = :salt WHERE token = :token`, { token, salt });
	}

	deleteWiki(token: string) {
		this.query(sql`DELETE FROM wikis WHERE token = :token`, { token });
	}

	fileExists(etag: Uint8Array) {
		return this.query<[boolean]>(sql`SELECT count(*) FROM files WHERE etag = :etag`, { etag })[0][0];
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

	#wikiFileQuery = this.prepareQuery<[], File>(sql`
		SELECT files.etag AS etag, rawsize, ctype, body
		FROM files, wikifiles
		WHERE files.etag = wikifiles.etag AND wikifiles.name = :name AND wikifiles.token LIKE :halftoken || '%'
	`);
	getWikiFile(halftoken: string, name: string) {
		const rows = this.#wikiFileQuery.allEntries({ halftoken, name });
		if (rows.length < 1) return;
		return rows[0];
	}

	#changedQuery = this.prepareQuery<
		[],
		{
			thash: Uint8Array;
			iv?: Uint8Array;
			ct?: Uint8Array;
			sbiv?: Uint8Array;
			sbct?: Uint8Array;
			mtime: number;
			deleted: number;
		}
	>(sql`
		SELECT thash, iv, ct, sbiv, sbct, mtime, deleted
		FROM tiddlers WHERE mtime > :modsince AND token = :token
	`);
	*tiddlersChangedSince(token: string, since: Date) {
		for (const tiddler of this.#changedQuery.iterEntries({ modsince: since.getTime(), token })) {
			yield { ...tiddler, mtime: parseTime(tiddler.mtime), deleted: !!tiddler.deleted };
		}
	}

	#upsertQuery = this.prepareQuery(sql`
		INSERT INTO tiddlers (thash, iv, ct, sbiv, sbct, mtime, deleted, token)
		VALUES (:thash, :iv, :ct, :sbiv, :sbct, :mtime, :deleted, :token)
		ON CONFLICT (thash) DO UPDATE SET
		iv = excluded.iv,
		ct = excluded.ct,
		sbiv = excluded.sbiv,
		sbct = excluded.sbct,
		mtime = excluded.mtime,
		deleted = excluded.deleted
		WHERE excluded.mtime > mtime
		AND token = excluded.token
	`);
	upsertTiddler(token: string, tiddler: Tiddler) {
		this.#upsertQuery.execute({ ...tiddler, mtime: tiddler.mtime.getTime(), token });
	}
}
