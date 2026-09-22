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
	baseMtime?: Date;
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

Deno.test('exact token prefix matching and wildcard rejection', async () => {
	const ds = new SQLiteDatastore();
	const testApp = new TiddlyPWASyncApp(
		ds,
		'q6kQ8SNKeaVVQDbhb7TgyqdTp8KAO31rU-6AGT1xG0o',
		'ZnPOVo2E_oWm71aQ-eOX9U3-gIE2hR6nfksboNcLNPQ',
	);
	// Create wiki with uppercase and underscores
	const tok = 'ABCdef_ghi_jkl_mno_pqr_stu_vwx_yz_1234567890';
	ds.createWiki(tok, 'Test Wiki');

	// Substring match with exact casing matches
	const exactPrefix = tok.slice(0, 21);
	const matchExact = await testApp.handle(new Request(`http://example.com/${exactPrefix}/bootstrap.json`));
	assertEquals(matchExact.status, 200);

	// Underscore wildcards (21 underscores) must NOT match
	const wildcardResp = await testApp.handle(new Request('http://example.com/_____________________/bootstrap.json'));
	assertEquals(wildcardResp.status, 404);

	// Case sensitivity: lowercase must NOT match uppercase
	const lowerPrefix = exactPrefix.toLowerCase();
	const caseMismatch = await testApp.handle(new Request(`http://example.com/${lowerPrefix}/bootstrap.json`));
	assertEquals(caseMismatch.status, 404);

	// Disallowed characters like % must be rejected with 404
	const percentPrefix = '%%%%%%%%%%%%%%%%%%%%%';
	const percentResp = await testApp.handle(new Request(`http://example.com/${percentPrefix}/bootstrap.json`));
	assertEquals(percentResp.status, 404);
});

Deno.test('invalid Date handling in sync rejects cleanly with EPROTO', async () => {
	const tok = await createWiki();
	const resp = await app.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({
				tiddlypwa: 1,
				op: 'sync',
				token: tok,
				authcode: 'test',
				now: 'not-a-valid-date',
				lastSync: new Date(0).toISOString(),
				clientChanges: [{ thash: 'T3dP', ct: '1111' }],
			}),
		}),
	);
	assertEquals(resp.status, 400);
	const body = await resp.json();
	assertEquals(body, { error: 'EPROTO' });
	await deleteWiki(tok);
});

Deno.test('malformed JSON and invalid requests return 400 EPROTO', async () => {
	// Malformed JSON body
	const malformedResp = await app.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: 'not-valid-json{',
		}),
	);
	assertEquals(malformedResp.status, 400);
	assertEquals(await malformedResp.json(), { error: 'EPROTO' });

	// Bad GET to /tid.dly without op=monitor returns 400
	const badGetResp = await app.handle(new Request('http://example.com/tid.dly'));
	assertEquals(badGetResp.status, 400);
	assertEquals(await badGetResp.json(), { error: 'EPROTO' });
});

Deno.test('homePage Content-Length matches exact UTF-8 byte length', async () => {
	const resp = await app.handle(new Request('http://example.com/'));
	assertEquals(resp.status, 200);
	const text = await resp.text();
	const actualBytes = new TextEncoder().encode(text).length;
	assertEquals(Number(resp.headers.get('content-length')), actualBytes);
});

Deno.test('basepath routing works with sub-paths', async () => {
	const baseApp = new TiddlyPWASyncApp(
		new SQLiteDatastore(),
		'q6kQ8SNKeaVVQDbhb7TgyqdTp8KAO31rU-6AGT1xG0o',
		'ZnPOVo2E_oWm71aQ-eOX9U3-gIE2hR6nfksboNcLNPQ',
		'/mywiki',
	);

	// Home page under /mywiki
	const homeResp = await baseApp.handle(new Request('http://example.com/mywiki/'));
	assertEquals(homeResp.status, 200);

	// Home page under /mywiki (no trailing slash)
	const homeNoSlashResp = await baseApp.handle(new Request('http://example.com/mywiki'));
	assertEquals(homeNoSlashResp.status, 200);

	// API endpoint under /mywiki/tid.dly
	const apiResp = await baseApp.handle(
		new Request('http://example.com/mywiki/tid.dly', {
			method: 'POST',
			body: JSON.stringify({ tiddlypwa: 1, op: 'list', atoken: 'test' }),
		}),
	);
	assertEquals(apiResp.status, 200);
	const listData = await apiResp.json();
	assertEquals(Array.isArray(listData.wikis), true);
});

Deno.test('concurrent writes with stale baseMtime trigger conflict and stream canonical version', async () => {
	const tok = await createWiki();
	const sharedThash = 'RG9jdW1lbnQ='; // 'Document'
	const time0 = new Date(1000);
	const time1 = new Date(2000);
	const time2 = new Date(3000);

	// Initial commit: V0 created at time0
	const initRes = await sync(tok, 'test', new Date(), new Date(0), [
		{ thash: sharedThash, ct: 'dmVyc2lvbjA=', mtime: time0 },
	]);
	assertEquals(initRes, { appEtag: null, serverChanges: [] });

	// Device A updates Document to V1 (baseMtime = time0, mtime = time1)
	const devARes = await sync(tok, 'test', new Date(), time0, [
		{ thash: sharedThash, ct: 'dmVyc2lvbjE=', mtime: time1, baseMtime: time0 },
	]);
	assertEquals(devARes, { appEtag: null, serverChanges: [] });

	// Device B concurrently attempts to update Document to V2 based on V0 (baseMtime = time0, mtime = time2)
	// Server must reject Device B's write because existing server mtime (time1) > baseMtime (time0)
	const devBRes = await sync(tok, 'test', new Date(), time0, [
		{ thash: sharedThash, ct: 'dmVyc2lvbjI=', mtime: time2, baseMtime: time0 },
	]);
	assertEquals(devBRes.conflicts, [sharedThash]);
	assertEquals(devBRes.serverChanges.length, 1);
	assertEquals(devBRes.serverChanges[0].thash, sharedThash);
	assertEquals(devBRes.serverChanges[0].ct, 'dmVyc2lvbjE='); // Device A's canonical version is streamed back

	// Verify server SQLite still holds Device A's version (V1)
	const verifyRes = await sync(tok, 'test', new Date(), new Date(0), []);
	assertEquals(verifyRes.serverChanges.length, 1);
	assertEquals(verifyRes.serverChanges[0].ct, 'dmVyc2lvbjE=');

	// Device B resolves conflict and syncs V3 based on Device A's V1 (baseMtime = time1, mtime = new Date(4000))
	const time3 = new Date(4000);
	const devBResolved = await sync(tok, 'test', new Date(), time1, [
		{ thash: sharedThash, ct: 'dmVyc2lvbjM=', mtime: time3, baseMtime: time1 },
	]);
	assertEquals(devBResolved, { appEtag: null, serverChanges: [] });

	// Verify server now has V3
	const finalRes = await sync(tok, 'test', new Date(), time1, []);
	assertEquals(finalRes.serverChanges.length, 1);
	assertEquals(finalRes.serverChanges[0].ct, 'dmVyc2lvbjM=');

	await deleteWiki(tok);
});

Deno.test('fallback conflict detection without baseMtime protects against older writes', async () => {
	const tok = await createWiki();
	const sharedThash = 'VGVzdERvYw==';
	const time1 = new Date(2000);
	const olderTime = new Date(1500);

	// Commit newer version
	await sync(tok, 'test', new Date(), new Date(0), [
		{ thash: sharedThash, ct: 'bmV3ZXI=', mtime: time1 },
	]);

	// Attempt to overwrite with older timestamp and no baseMtime
	const staleRes = await sync(tok, 'test', new Date(), new Date(0), [
		{ thash: sharedThash, ct: 'b2xkZXI=', mtime: olderTime },
	]);
	assertEquals(staleRes.conflicts, [sharedThash]);
	assertEquals(staleRes.serverChanges.length, 1);
	assertEquals(staleRes.serverChanges[0].ct, 'bmV3ZXI=');

	await deleteWiki(tok);
});
