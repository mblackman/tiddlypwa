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
	} finally {
		db.close(true);
		Deno.removeSync(dir, { recursive: true });
	}
});
