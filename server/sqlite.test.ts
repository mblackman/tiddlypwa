import { assertEquals } from '@std/assert';
import { SQLiteDatastore } from './sqlite.ts';

Deno.test('SQLiteDatastore: upsertTiddler respects batchWriteTimeMs', () => {
	const db = new SQLiteDatastore();
	db.createWiki('token1');

	const thash = new Uint8Array([1, 2, 3]);
	const batchWriteTimeMs = 50000;

	const res1 = db.upsertTiddler('token1', {
		thash,
		iv: undefined,
		ct: undefined,
		sbiv: undefined,
		sbct: undefined,
		mtime: new Date(1000), // Client time
		deleted: false,
	}, batchWriteTimeMs);

	assertEquals(res1.success, true);

	const tid = db.getTiddler('token1', thash);
	assertEquals(tid!.mtime.getTime(), batchWriteTimeMs);
	assertEquals(db.maxMtime('token1'), batchWriteTimeMs);
});

Deno.test('SQLiteDatastore: upsertTiddler with stale baseMtime is rejected', () => {
	const db = new SQLiteDatastore();
	db.createWiki('token2');

	const thash = new Uint8Array([1, 2, 3]);
	const initialWriteTime = 10000;

	// 1. Initial write
	db.upsertTiddler('token2', {
		thash,
		mtime: new Date(0),
		deleted: false,
	}, initialWriteTime);

	// 2. Attempt to write with a baseMtime older than initialWriteTime
	const res2 = db.upsertTiddler('token2', {
		thash,
		mtime: new Date(20000),
		baseMtime: new Date(5000), // Stale base!
		deleted: false,
	}, 20000);

	assertEquals(res2.success, false);
	assertEquals(res2.conflict, true);

	// DB should still hold the initial write time
	const tid = db.getTiddler('token2', thash);
	assertEquals(tid!.mtime.getTime(), initialWriteTime);
});

Deno.test('P1-5: file-backed SQLiteDatastore uses native WAL mode, foreign_keys, and nested SAVEPOINT rollback', () => {
	const dir = Deno.makeTempDirSync();
	const dbPath = `${dir}/test.db`;
	const db = new SQLiteDatastore(dbPath);
	try {
		const mode = String(db.query('PRAGMA journal_mode')[0][0]).toLowerCase();
		assertEquals(mode, 'wal');
		const fk = db.query('PRAGMA foreign_keys')[0][0];
		assertEquals(fk, 1);

		db.transaction(() => {
			db.createWiki('outer-wiki', 'keep');
			try {
				db.transaction(() => {
					db.createWiki('inner-wiki', 'rollback');
					throw new Error('inner boom');
				});
			} catch (_e) {
				// inner rollback expected
			}
		});
		assertEquals(Boolean(db.getWiki('outer-wiki')), true);
		assertEquals(db.getWiki('inner-wiki'), undefined);

		const jsl = db.query<[number]>('PRAGMA journal_size_limit')[0][0];
		assertEquals(jsl, 67108864);
		const ts = db.query<[number]>('PRAGMA trusted_schema')[0][0];
		assertEquals(ts, 0);
		assertEquals(db.healthCheck(), true);
	} finally {
		db.checkpointAndClose();
		Deno.removeSync(dir, { recursive: true });
	}
});

Deno.test('Batch 4 sqlite: tiddlersChangedPage keyset pagination handles duplicate mtimes with zero skips or duplicates', () => {
	const db = new SQLiteDatastore();
	const tok = 'wiki-keyset-page-token';
	db.createWiki(tok);

	for (let i = 0; i < 45; i++) {
		const thash = new Uint8Array(32);
		thash[0] = (i * 37) & 0xff;
		thash[1] = i;
		const mtimeMs = i < 25 ? 1000 : 1000 + (i % 7);
		db.upsertTiddler(tok, {
			thash,
			ct: new Uint8Array([i]),
			mtime: new Date(mtimeMs),
			deleted: false,
		}, mtimeMs);
	}

	const collected: Array<{ thashHex: string; mtime: number }> = [];
	let cursorMtime = 0;
	let cursorThash: Uint8Array | null = null;
	while (true) {
		const page = db.tiddlersChangedPage(tok, cursorMtime, cursorThash, 2000, 16);
		if (page.length === 0) break;
		for (const item of page) {
			collected.push({ thashHex: Array.from(item.thash).join(','), mtime: item.mtime.getTime() });
		}
		const last = page[page.length - 1];
		cursorMtime = last.mtime.getTime();
		cursorThash = last.thash;
		if (page.length < 16) break;
	}

	assertEquals(collected.length, 45);
	assertEquals(new Set(collected.map((c) => c.thashHex)).size, 45);
});
