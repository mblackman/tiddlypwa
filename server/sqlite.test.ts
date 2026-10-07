import { assertEquals } from 'https://deno.land/std@0.192.0/testing/asserts.ts';
import { SQLiteDatastore } from './sqlite.ts';

Deno.test('SQLiteDatastore: upsertTiddler respects batchWriteTimeMs', () => {
    const db = new SQLiteDatastore();
    db.createWiki('token1');

    const thash = new Uint8Array([1, 2, 3]);
    const batchWriteTimeMs = 50000;

    const res1 = db.upsertTiddler('token1', {
        thash,
        iv: null, ct: null, sbiv: null, sbct: null,
        mtime: new Date(1000), // Client time
        deleted: false
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
        thash, mtime: new Date(0), deleted: false
    }, initialWriteTime);

    // 2. Attempt to write with a baseMtime older than initialWriteTime
    const res2 = db.upsertTiddler('token2', {
        thash,
        mtime: new Date(20000),
        baseMtime: new Date(5000), // Stale base!
        deleted: false
    }, 20000);

    assertEquals(res2.success, false);
    assertEquals(res2.conflict, true);

    // DB should still hold the initial write time
    const tid = db.getTiddler('token2', thash);
    assertEquals(tid!.mtime.getTime(), initialWriteTime);
});
