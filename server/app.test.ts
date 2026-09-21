// deno-lint-ignore-file no-explicit-any
import { assertEquals } from '@std/assert';
import { SQLiteDatastore } from './sqlite.ts';
import { TiddlyPWASyncApp } from './app.ts';

const app = new TiddlyPWASyncApp(
	new SQLiteDatastore(),
	'q6kQ8SNKeaVVQDbhb7TgyqdTp8KAO31rU-6AGT1xG0o',
	'ZnPOVo2E_oWm71aQ-eOX9U3-gIE2hR6nfksboNcLNPQ',
);

const api = (data: any) =>
	app.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({ tiddlypwa: 1, ...data }),
		}),
	).then((x) => x.json());

const _page = (path: string) => app.handle(new Request('http://example.com/' + path));

const createWiki = () => api({ op: 'create', atoken: 'test' }).then((x) => x.token as string);
const deleteWiki = (token: string) => api({ op: 'delete', atoken: 'test', token });
const _uploadAppFile = (token: string, body: string, extra?: Record<string, unknown>, file = 'app.html') =>
	api({
		op: 'uploadapp',
		token,
		files: {
			[file]: {
				body,
				ctype: 'text/html',
				...extra,
			},
		},
	});

type tidjson = {
	thash: string;
	iv?: string;
	ct?: string;
	sbiv?: string;
	sbct?: string;
	mtime?: Date;
	deleted?: boolean;
};
const sync = (token: string, authcode: string, now: Date, lastSync: Date, clientChanges: Array<tidjson>) =>
	api({ op: 'sync', token, authcode, now, lastSync, clientChanges });

Deno.test('basic syncing works', async () => {
	const tok = await createWiki();
	const s1date = new Date();
	// Basic write, with and without an mtime
	assertEquals(
		await sync(tok, 'test', s1date, new Date(0), [
			{ thash: 'T3dP', ct: '1111' },
			{ thash: 'VXdV', ct: '11111111', mtime: new Date(69) },
		]),
		{ appEtag: null, serverChanges: [] },
	);
	// Wrong authtok
	assertEquals(await sync(tok, 'wrong', new Date(), new Date(), []), { error: 'EAUTH' });
	// Basic reads
	assertEquals(await sync(tok, 'test', new Date(), new Date(0), []), {
		appEtag: null,
		serverChanges: [
			{
				thash: 'VXdV',
				iv: null,
				ct: '11111111',
				sbiv: null,
				sbct: null,
				mtime: new Date(69).toISOString(),
				deleted: false,
			},
			{
				thash: 'T3dP',
				iv: null,
				ct: '1111',
				sbiv: null,
				sbct: null,
				mtime: s1date.toISOString(),
				deleted: false,
			},
		],
	});
	assertEquals(await sync(tok, 'test', new Date(), new Date(420), []), {
		appEtag: null,
		serverChanges: [
			{
				thash: 'T3dP',
				iv: null,
				ct: '1111',
				sbiv: null,
				sbct: null,
				mtime: s1date.toISOString(),
				deleted: false,
			},
		],
	});
	await deleteWiki(tok);
});

Deno.test('syncing a ton of tiddlers works', async () => {
	const tok = await createWiki();
	const s1date = new Date();
	assertEquals(
		await sync(
			tok,
			'test',
			s1date,
			new Date(0),
			[...Array(20).keys()].map((_, i) => ({ thash: btoa(i.toString()), ct: 'T3dp' })),
		),
		{ appEtag: null, serverChanges: [] },
	);
	assertEquals(await sync(tok, 'test', new Date(), new Date(420), []), {
		appEtag: null,
		serverChanges: [...Array(20).keys()].map((_, i) => (
			{
				thash: btoa(i.toString()),
				iv: null,
				ct: 'T3dp',
				sbiv: null,
				sbct: null,
				mtime: s1date.toISOString(),
				deleted: false,
			}
		)),
	});
	await deleteWiki(tok);
});

Deno.test('storing large data works', async () => {
	const tok = await createWiki();
	const s1date = new Date();
	const bigdata = Array(5592407).join('A') + '==';
	assertEquals(
		await sync(tok, 'test', s1date, new Date(0), [
			{ thash: 'T3dP', ct: bigdata },
		]),
		{ appEtag: null, serverChanges: [] },
	);
	assertEquals(await sync(tok, 'test', new Date(), new Date(420), []), {
		appEtag: null,
		serverChanges: [
			{
				thash: 'T3dP',
				iv: null,
				ct: bigdata,
				sbiv: null,
				sbct: null,
				mtime: s1date.toISOString(),
				deleted: false,
			},
		],
	});
	await deleteWiki(tok);
});

Deno.test('multi-tenant isolation with identical thash', async () => {
	const tok1 = await createWiki();
	const tok2 = await createWiki();
	const sharedThash = 'VGVzdFRpZGRsZXI='; // Base64 for 'TestTiddler'
	const time1 = new Date(1000);
	const time2 = new Date(2000);

	// Sync identical thash with different content to tok1
	assertEquals(
		await sync(tok1, 'test', new Date(), new Date(0), [
			{ thash: sharedThash, ct: 'd2lraTExMTE=', mtime: time1 },
		]),
		{ appEtag: null, serverChanges: [] },
	);

	// Sync identical thash with different content to tok2
	assertEquals(
		await sync(tok2, 'test', new Date(), new Date(0), [
			{ thash: sharedThash, ct: 'd2lraTIyMjI=', mtime: time2 },
		]),
		{ appEtag: null, serverChanges: [] },
	);

	// Verify tok1 receives only its own data
	const res1 = await sync(tok1, 'test', new Date(), new Date(0), []);
	assertEquals(res1.serverChanges.length, 1);
	assertEquals(res1.serverChanges[0].thash, sharedThash);
	assertEquals(res1.serverChanges[0].ct, 'd2lraTExMTE=');

	// Verify tok2 receives only its own data
	const res2 = await sync(tok2, 'test', new Date(), new Date(0), []);
	assertEquals(res2.serverChanges.length, 1);
	assertEquals(res2.serverChanges[0].thash, sharedThash);
	assertEquals(res2.serverChanges[0].ct, 'd2lraTIyMjI=');

	// Deleting tok1 should not affect tok2's tiddler
	await deleteWiki(tok1);
	const res2AfterDelete = await sync(tok2, 'test', new Date(), new Date(0), []);
	assertEquals(res2AfterDelete.serverChanges.length, 1);
	assertEquals(res2AfterDelete.serverChanges[0].ct, 'd2lraTIyMjI=');

	await deleteWiki(tok2);
});

Deno.test('schema migration from version 1 to 2 preserves data and allows multi-tenancy', () => {
	// Create an in-memory DB and manually set up v1 schema
	const ds = new SQLiteDatastore();
	// Reset DB to test migration specifically
	ds.execute('PRAGMA foreign_keys = OFF;');
	ds.execute('DROP TABLE IF EXISTS tiddlers;');
	ds.execute('DROP TABLE IF EXISTS wikifiles;');
	ds.execute('DROP TABLE IF EXISTS files;');
	ds.execute('DROP TABLE IF EXISTS wikis;');

	ds.execute(`
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
		PRAGMA foreign_keys = ON;
	`);

	// Insert v1 data
	ds.createWiki('wiki1');
	const testHash = new Uint8Array([1, 2, 3, 4]);
	const testCt = new Uint8Array([5, 6, 7, 8]);
	ds.query(
		'INSERT INTO tiddlers (thash, ct, mtime, deleted, token) VALUES (:thash, :ct, :mtime, :deleted, :token)',
		{ thash: testHash, ct: testCt, mtime: 1234567, deleted: 0, token: 'wiki1' },
	);

	// Run migration
	ds.migrate();

	// Verify user_version is now 2
	const ver = ds.query('PRAGMA user_version')[0][0] as number;
	assertEquals(ver, 2);

	// Verify migrated row exists
	const rows = [...ds.tiddlersChangedSince('wiki1', new Date(0))];
	assertEquals(rows.length, 1);
	assertEquals(rows[0].thash, testHash);
	assertEquals(rows[0].ct, testCt);

	// Verify multi-tenant insert on v2 now works for another wiki with the SAME thash
	ds.createWiki('wiki2');
	const testCt2 = new Uint8Array([9, 10, 11, 12]);
	ds.upsertTiddler('wiki2', {
		thash: testHash,
		ct: testCt2,
		mtime: new Date(2345678),
		deleted: false,
	});

	const wiki2Rows = [...ds.tiddlersChangedSince('wiki2', new Date(0))];
	assertEquals(wiki2Rows.length, 1);
	assertEquals(wiki2Rows[0].ct, testCt2);
});
