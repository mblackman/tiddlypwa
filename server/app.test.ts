// deno-lint-ignore-file no-explicit-any
import { brotliDecompressSync } from 'node:zlib';
import { assertEquals } from '@std/assert';
import { SQLiteDatastore } from './sqlite.ts';
import { TiddlyPWASyncApp } from './app.ts';

const app = new TiddlyPWASyncApp(
	new SQLiteDatastore(),
	'q6kQ8SNKeaVVQDbhb7TgyqdTp8KAO31rU-6AGT1xG0o',
	'ZnPOVo2E_oWm71aQ-eOX9U3-gIE2hR6nfksboNcLNPQ',
	'',
	undefined,
	{ allowCustomAppUpload: true },
);
await app.loadDefaultApp();

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
const resetApp = (token: string) => api({ op: 'resetapp', atoken: 'test', token });
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
const sync = async (token: string, authcode: string, now: Date, lastSync: Date, clientChanges: Array<tidjson>) => {
	const res = await api({ op: 'sync', token, authcode, now, lastSync, clientChanges });
	delete res.successes;
	return res;
};

Deno.test('basic syncing works', async () => {
	const tok = await createWiki();
	const s1date = new Date();
	// Basic write, with and without an mtime
	const res = await api({
		op: 'sync',
		token: tok,
		authcode: 'test',
		now: s1date,
		lastSync: new Date(0),
		clientChanges: [
			{ thash: 'T3dP', ct: '1111' },
			{ thash: 'VXdV', ct: '11111111', mtime: new Date(69) },
		],
	});
	assertEquals(
		res,
		{
			appEtag: null,
			serverChanges: [],
			successes: [{ thash: 'T3dP', mtime: res.successes![0].mtime }, { thash: 'VXdV', mtime: res.successes![1].mtime }],
		},
	);
	const t3mtime = res.successes![0].mtime;
	const vxmtime = res.successes![1].mtime;

	// Wrong authtok
	assertEquals(await sync(tok, 'wrong', new Date(), new Date(), []), { error: 'EAUTH' });
	// Basic reads
	const readRes = await sync(tok, 'test', new Date(), new Date(0), []);
	assertEquals(readRes.serverChanges.length, 2);
	assertEquals(readRes.serverChanges.find((c: any) => c.thash === 'T3dP'), {
		thash: 'T3dP',
		iv: null,
		ct: '1111',
		sbiv: null,
		sbct: null,
		mtime: t3mtime,
		deleted: false,
	});
	assertEquals(readRes.serverChanges.find((c: any) => c.thash === 'VXdV'), {
		thash: 'VXdV',
		iv: null,
		ct: '11111111',
		sbiv: null,
		sbct: null,
		mtime: vxmtime,
		deleted: false,
	});

	const read420Res = await sync(tok, 'test', new Date(), new Date(420), []);
	assertEquals(read420Res.serverChanges.length, 2);
	await deleteWiki(tok);
});

Deno.test('syncing a ton of tiddlers works', async () => {
	const tok = await createWiki();
	const s1date = new Date();
	const writeRes = await api({
		op: 'sync',
		token: tok,
		authcode: 'test',
		now: s1date,
		lastSync: new Date(0),
		clientChanges: [...Array(20).keys()].map((_, i) => ({ thash: btoa(i.toString()), ct: 'T3dp' })),
	});
	assertEquals(writeRes.serverChanges, []);
	assertEquals(writeRes.successes?.length, 20);

	const readRes = await sync(tok, 'test', new Date(), new Date(420), []);
	assertEquals(readRes.serverChanges.length, 20);
	await deleteWiki(tok);
});

Deno.test('storing large data works', async () => {
	const tok = await createWiki();
	const s1date = new Date();
	const bigdata = Array(5592407).join('A') + '==';
	const writeRes = await api({
		op: 'sync',
		token: tok,
		authcode: 'test',
		now: s1date,
		lastSync: new Date(0),
		clientChanges: [{ thash: 'T3dP', ct: bigdata }],
	});
	assertEquals(writeRes.serverChanges, []);
	assertEquals(writeRes.successes?.length, 1);

	const readRes = await sync(tok, 'test', new Date(), new Date(420), []);
	assertEquals(readRes.serverChanges.length, 1);
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

	// Verify user_version is now 5
	const ver = ds.query('PRAGMA user_version')[0][0] as number;
	assertEquals(ver, 5);

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
	const initResRaw = await api({
		op: 'sync',
		token: tok,
		authcode: 'test',
		now: new Date(),
		lastSync: new Date(0),
		clientChanges: [
			{ thash: sharedThash, ct: 'dmVyc2lvbjA=', mtime: time0 },
		],
	});
	const time0_server = new Date(initResRaw.successes![0].mtime);

	// Device A updates Document to V1
	const devAResRaw = await api({
		op: 'sync',
		token: tok,
		authcode: 'test',
		now: new Date(),
		lastSync: time0_server,
		clientChanges: [
			{ thash: sharedThash, ct: 'dmVyc2lvbjE=', mtime: time1, baseMtime: time0_server },
		],
	});
	const time1_server = new Date(devAResRaw.successes![0].mtime);

	// Device B concurrently attempts to update Document to V2 based on V0 (baseMtime = time0_server)
	// Server must reject Device B's write because existing server mtime (time1_server) > baseMtime (time0_server)
	const devBRes = await sync(tok, 'test', new Date(), time0_server, [
		{ thash: sharedThash, ct: 'dmVyc2lvbjI=', mtime: time2, baseMtime: time0_server },
	]);
	assertEquals(devBRes.conflicts, [sharedThash]);
	assertEquals(devBRes.serverChanges.length, 1);
	assertEquals(devBRes.serverChanges[0].thash, sharedThash);
	assertEquals(devBRes.serverChanges[0].ct, 'dmVyc2lvbjE='); // Device A's canonical version is streamed back

	// Verify server SQLite still holds Device A's version (V1)
	const verifyRes = await sync(tok, 'test', new Date(), new Date(0), []);
	assertEquals(verifyRes.serverChanges.length, 1);
	assertEquals(verifyRes.serverChanges[0].ct, 'dmVyc2lvbjE=');

	// Device B resolves conflict and syncs V3 based on Device A's V1 (baseMtime = time1_server)
	const time3 = new Date(4000);
	const devBResolved = await api({
		op: 'sync',
		token: tok,
		authcode: 'test',
		now: new Date(),
		lastSync: time1_server,
		clientChanges: [
			{ thash: sharedThash, ct: 'dmVyc2lvbjM=', mtime: time3, baseMtime: time1_server },
		],
	});
	assertEquals(devBResolved.serverChanges, []);

	// Verify server now has V3
	const finalRes = await sync(tok, 'test', new Date(), time1_server, []);
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

Deno.test('wiki asset serving: Brotli encoding and fallback decompression', async () => {
	const tok = await createWiki();
	const testHtml = '<!doctype html><html><head><title>Test Wiki</title></head><body><h1>Hello World</h1></body></html>';
	const uploadRes = await _uploadAppFile(tok, testHtml, {}, 'app.html');
	const prefix = uploadRes.urlprefix; // e.g. "halftoken/"

	// 1. Request with Accept-Encoding: br (like Firefox)
	const brReq = new Request(`http://example.com/${prefix}app.html`, {
		headers: { 'Accept-Encoding': 'gzip, deflate, br, zstd' },
	});
	const brResp = await app.handle(brReq);
	assertEquals(brResp.status, 200);
	assertEquals(brResp.headers.get('content-encoding'), 'br');
	const brBytes = new Uint8Array(await brResp.arrayBuffer());
	const decompressed = brotliDecompressSync(brBytes);
	assertEquals(new TextDecoder().decode(decompressed), testHtml);

	// 2. Request without br (fallback to uncompressed)
	const noBrReq = new Request(`http://example.com/${prefix}app.html`, {
		headers: { 'Accept-Encoding': 'gzip, deflate' },
	});
	const noBrResp = await app.handle(noBrReq);
	assertEquals(noBrResp.status, 200);
	assertEquals(noBrResp.headers.get('content-encoding'), null);
	const rawText = await noBrResp.text();
	assertEquals(rawText, testHtml);

	await deleteWiki(tok);
});

Deno.test('wiki asset serving: unseeded wiki falls back to bundled default app', async () => {
	const tok = await createWiki();
	const prefix = tok.slice(0, tok.length / 2);

	// 1. Request app.html with br
	const brReq = new Request(`http://example.com/${prefix}/app.html`, {
		headers: { 'Accept-Encoding': 'gzip, deflate, br' },
	});
	const brResp = await app.handle(brReq);
	if (brResp.status === 404) {
		console.log('BRRESP 404!', await brResp.clone().text());
	}
	assertEquals(brResp.status, 200);
	assertEquals(brResp.headers.get('content-encoding'), 'br');
	const brBytes = new Uint8Array(await brResp.arrayBuffer());
	const decompressed = brotliDecompressSync(brBytes);
	const text = new TextDecoder().decode(decompressed);
	assertEquals(text.includes('$:/plugins/mblackman/tiddlypwa'), true);

	// 2. Request sw.js
	const swReq = new Request(`http://example.com/${prefix}/sw.js`);
	const swResp = await app.handle(swReq);
	assertEquals(swResp.status, 200);
	const swText = await swResp.text();
	assertEquals(swText.includes('$:/plugins/mblackman/tiddlypwa/sw.js'), true);

	// 3. ETag 304 caching
	const etag = brResp.headers.get('etag');
	const cacheReq = new Request(`http://example.com/${prefix}/app.html`, {
		headers: { 'Accept-Encoding': 'gzip, deflate, br', 'If-None-Match': etag! },
	});
	const cacheResp = await app.handle(cacheReq);
	assertEquals(cacheResp.status, 304);

	await deleteWiki(tok);
});

Deno.test('wiki asset serving: resetapp reverts custom app back to bundled default', async () => {
	const tok = await createWiki();
	const prefix = tok.slice(0, tok.length / 2);
	const customHtml = '<!doctype html><html><body><h1>Custom Plugin Theme</h1></body></html>';

	// 1. Upload custom app
	await _uploadAppFile(tok, customHtml, {}, 'app.html');
	const customReq = new Request(`http://example.com/${prefix}/app.html`);
	const customResp = await app.handle(customReq);
	assertEquals(customResp.status, 200);
	assertEquals(await customResp.text(), customHtml);

	// 2. Reset app
	const resetRes = await resetApp(tok);
	assertEquals(resetRes, {});

	// 3. Verify it now serves the bundled default again
	const defaultReq = new Request(`http://example.com/${prefix}/app.html`);
	const defaultResp = await app.handle(defaultReq);
	assertEquals(defaultResp.status, 200);
	const defaultText = await defaultResp.text();
	assertEquals(defaultText.includes('$:/plugins/mblackman/tiddlypwa'), true);

	await deleteWiki(tok);
});

Deno.test('monitor stream sends periodic keepalive comments and handles cancellation', async () => {
	const tok = await createWiki();
	const query = new URLSearchParams({ token: tok, browserToken: 'testbrowser' });
	// Use a 20ms interval for fast test execution
	const resp = app.handleMonitor(query, 20);
	assertEquals(resp.status, 200);
	assertEquals(resp.headers.get('content-type'), 'text/event-stream');

	const reader = resp.body!.getReader();
	const decoder = new TextDecoder();
	let chunks = '';

	// Read initial 'hi' event and at least one keepalive comment
	while (!chunks.includes(': keepalive')) {
		const { value, done } = await reader.read();
		if (done) break;
		chunks += decoder.decode(value, { stream: true });
	}

	assertEquals(chunks.includes('event: hi\ndata: 1\n\n'), true);
	assertEquals(chunks.includes(': keepalive\n\n'), true);

	// Cancel stream and verify clean shutdown
	await reader.cancel();
	await deleteWiki(tok);
});

Deno.test('wiki asset serving: rejects uploads exceeding limits or malformed input', async () => {
	const tok = await createWiki();

	// Empty files object
	const emptyRes = await api({ op: 'uploadapp', token: tok, files: {} });
	assertEquals(emptyRes.error, 'EPROTO');

	// Too many files (> 20)
	const tooManyFiles: Record<string, unknown> = {};
	for (let i = 0; i < 21; i++) {
		tooManyFiles[`file_${i}.txt`] = { body: 'content', ctype: 'text/plain' };
	}
	const tooManyRes = await api({ op: 'uploadapp', token: tok, files: tooManyFiles });
	assertEquals(tooManyRes.error, 'EPROTO');

	// Invalid empty filename
	const emptyNameRes = await api({
		op: 'uploadapp',
		token: tok,
		files: { '': { body: 'content', ctype: 'text/plain' } },
	});
	assertEquals(emptyNameRes.error, 'EPROTO');

	await deleteWiki(tok);
});

Deno.test('P0-2: op verify_auth validates authcode without creating tiddlers', async () => {
	const tok = await createWiki();

	// Before any authcode is stored on server, verify_auth reports hasAuthcode: false
	const freshRes = await app.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({ tiddlypwa: 1, op: 'verify_auth', token: tok, authcode: 'first-code' }),
		}),
	);
	assertEquals(freshRes.status, 200);
	assertEquals(await freshRes.json(), { ok: true, hasAuthcode: false });

	// Bind authcode via sync
	await sync(tok, 'real-authcode', new Date(), new Date(0), []);

	// Matching authcode succeeds
	const okRes = await app.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({ tiddlypwa: 1, op: 'verify_auth', token: tok, authcode: 'real-authcode' }),
		}),
	);
	assertEquals(okRes.status, 200);
	assertEquals(await okRes.json(), { ok: true, hasAuthcode: true });

	// Wrong authcode is rejected with 401 EAUTH
	const badRes = await app.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({ tiddlypwa: 1, op: 'verify_auth', token: tok, authcode: 'wrong-authcode' }),
		}),
	);
	assertEquals(badRes.status, 401);
	assertEquals(await badRes.json(), { error: 'EAUTH' });

	await deleteWiki(tok);
});

Deno.test('Piece 3: uploadapp allowlists app filenames, enforces ctypes, and respects allowCustomAppUpload', async () => {
	const tok = await createWiki();
	const prefix = tok.slice(0, tok.length / 2);

	// Reject arbitrary filenames
	for (const badName of ['evil.html', '../app.html', 'shell.svg']) {
		const res = await api({
			op: 'uploadapp',
			token: tok,
			files: { [badName]: { body: '<svg/>', ctype: 'image/svg+xml' } },
		});
		assertEquals(res.error, 'EPROTO');
	}

	// Enforce canonical content-type even if client passes spoofed ctype
	const okRes = await api({
		op: 'uploadapp',
		token: tok,
		files: {
			'app.html': { body: '<!doctype html><html>ok</html>', ctype: 'application/x-evil' },
			'sw.js': { body: '// sw', ctype: 'text/html' },
		},
	});
	assertEquals(okRes.urlprefix, `${prefix}/`);

	const htmlResp = await app.handle(new Request(`http://example.com/${prefix}/app.html`));
	assertEquals(htmlResp.status, 200);
	assertEquals(htmlResp.headers.get('content-type'), 'text/html; charset=utf-8');
	assertEquals(htmlResp.headers.get('x-content-type-options'), 'nosniff');
	assertEquals(htmlResp.headers.get('referrer-policy'), 'no-referrer');
	assertEquals(htmlResp.headers.get('x-frame-options'), 'SAMEORIGIN');

	const swResp = await app.handle(new Request(`http://example.com/${prefix}/sw.js`));
	assertEquals(swResp.status, 200);
	assertEquals(swResp.headers.get('content-type'), 'application/javascript; charset=utf-8');
	assertEquals(swResp.headers.get('x-content-type-options'), 'nosniff');

	// Disabled custom uploads returns 403 EFORBIDDEN
	const lockedApp = new TiddlyPWASyncApp(
		new SQLiteDatastore(),
		'q6kQ8SNKeaVVQDbhb7TgyqdTp8KAO31rU-6AGT1xG0o',
		'ZnPOVo2E_oWm71aQ-eOX9U3-gIE2hR6nfksboNcLNPQ',
		'',
		undefined,
		{ allowCustomAppUpload: false },
	);
	const created: any = await lockedApp.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({ tiddlypwa: 1, op: 'create', atoken: 'test' }),
		}),
	).then((r) => r.json());
	const blockedResp = await lockedApp.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({
				tiddlypwa: 1,
				op: 'uploadapp',
				token: created.token,
				files: { 'app.html': { body: '<html/>', ctype: 'text/html' } },
			}),
		}),
	);
	assertEquals(blockedResp.status, 403);
	assertEquals(await blockedResp.json(), { error: 'EFORBIDDEN' });

	await deleteWiki(tok);
});

Deno.test('Piece 3: monitor endpoint supports halftoken + authcode without exposing full token', async () => {
	const tok = await createWiki();
	const half = tok.slice(0, Math.floor(tok.length / 2));

	// Before authcode is set on wiki, halftoken monitor is rejected
	const unauth = app.handleMonitor(new URLSearchParams({ halftoken: half, authcode: 'abc', browserToken: 'b1' }), 20);
	assertEquals(unauth.status, 401);

	await sync(tok, 'monitor-secret', new Date(), new Date(0), []);

	// Wrong authcode is rejected
	const bad = app.handleMonitor(new URLSearchParams({ halftoken: half, authcode: 'wrong', browserToken: 'b1' }), 20);
	assertEquals(bad.status, 401);

	// Valid halftoken + authcode streams SSE events
	const ok = app.handleMonitor(
		new URLSearchParams({ halftoken: half, authcode: 'monitor-secret', browserToken: 'b1' }),
		20,
	);
	assertEquals(ok.status, 200);
	const reader = ok.body!.getReader();
	const first = new TextDecoder().decode((await reader.read()).value);
	assertEquals(first.includes('event: hi'), true);
	await reader.cancel();

	await deleteWiki(tok);
});

Deno.test('Piece 3: admin homePage includes viewport meta, #token links, no ?token= links, and dynamic version', async () => {
	const resp = await app.handle(new Request('http://example.com/'));
	assertEquals(resp.status, 200);
	const html = await resp.text();
	assertEquals(html.includes('<meta name="viewport"'), true);
	assertEquals(html.includes('#token='), true);
	assertEquals(html.includes('?token='), false);
	assertEquals(html.includes("if (!bytes) return '0 B'"), true);
});

Deno.test('P1-6: admin authentication rate-limits repeated failed attempts per IP with 429 ERATELIMIT', async () => {
	const rlApp = new TiddlyPWASyncApp(
		new SQLiteDatastore(),
		'q6kQ8SNKeaVVQDbhb7TgyqdTp8KAO31rU-6AGT1xG0o',
		'ZnPOVo2E_oWm71aQ-eOX9U3-gIE2hR6nfksboNcLNPQ',
		'',
		undefined,
		{ trustProxy: true },
	);
	const badReq = (ip: string, atoken = 'wrong') =>
		rlApp.handle(
			new Request('http://example.com/tid.dly', {
				method: 'POST',
				headers: { 'x-forwarded-for': ip },
				body: JSON.stringify({ tiddlypwa: 1, op: 'list', atoken }),
			}),
		);

	for (let i = 0; i < 5; i++) {
		const res = await badReq('198.51.100.10');
		assertEquals(res.status, 401);
	}
	const locked = await badReq('198.51.100.10');
	assertEquals(locked.status, 429);
	assertEquals(locked.headers.has('retry-after'), true);
	assertEquals(await locked.json(), { error: 'ERATELIMIT' });

	// Different IP is still allowed and valid auth succeeds
	const otherOk = await badReq('198.51.100.11', 'test');
	assertEquals(otherOk.status, 200);
});

Deno.test('Batch 1 security: default allowCustomAppUpload=false, reauth blocks unauthenticated uploadapp, COOP/noopener/no-store headers', async () => {
	const defaultApp = new TiddlyPWASyncApp(
		new SQLiteDatastore(),
		'q6kQ8SNKeaVVQDbhb7TgyqdTp8KAO31rU-6AGT1xG0o',
		'ZnPOVo2E_oWm71aQ-eOX9U3-gIE2hR6nfksboNcLNPQ',
	);
	const { token: tok1 } = await defaultApp.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({ tiddlypwa: 1, op: 'create', atoken: 'test' }),
		}),
	).then((r) => r.json());
	const blockedDefault = await defaultApp.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({
				tiddlypwa: 1,
				op: 'uploadapp',
				token: tok1,
				authcode: 'abc',
				files: { 'app.html': { body: '<html/>', ctype: 'text/html' } },
			}),
		}),
	);
	assertEquals(blockedDefault.status, 403);
	assertEquals(await blockedDefault.json(), { error: 'EFORBIDDEN' });

	// With allowCustomAppUpload enabled, initialized wiki without authcode is still rejected
	const uploadEnabledApp = new TiddlyPWASyncApp(
		new SQLiteDatastore(),
		'q6kQ8SNKeaVVQDbhb7TgyqdTp8KAO31rU-6AGT1xG0o',
		'ZnPOVo2E_oWm71aQ-eOX9U3-gIE2hR6nfksboNcLNPQ',
		'',
		undefined,
		{ allowCustomAppUpload: true },
	);
	const { token: tok2 } = await uploadEnabledApp.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({ tiddlypwa: 1, op: 'create', atoken: 'test' }),
		}),
	).then((r) => r.json());
	await uploadEnabledApp.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({
				tiddlypwa: 1,
				op: 'sync',
				token: tok2,
				authcode: 'secret-auth',
				salt: 'c2FsdA==',
				now: new Date().toISOString(),
				lastSync: new Date(0).toISOString(),
				clientChanges: [{ thash: 'T3dP', ct: '1111' }],
			}),
		}),
	).then((r) => r.json());
	const unauthUpload = await uploadEnabledApp.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({
				tiddlypwa: 1,
				op: 'uploadapp',
				token: tok2,
				files: { 'app.html': { body: '<html/>', ctype: 'text/html' } },
			}),
		}),
	);
	assertEquals(unauthUpload.status, 401);
	assertEquals(await unauthUpload.json(), { error: 'EAUTH' });

	// Security headers on admin homepage and bootstrap.json
	const homeResp = await defaultApp.handle(new Request('http://example.com/'));
	assertEquals(homeResp.headers.get('cross-origin-opener-policy'), 'same-origin');
	assertEquals(homeResp.headers.get('referrer-policy'), 'no-referrer');
	const homeHtml = await homeResp.text();
	assertEquals(homeHtml.includes("'noopener,noreferrer'"), true);
	assertEquals(homeHtml.includes('noopener noreferrer'), true);

	const half = tok1.slice(0, Math.floor(tok1.length / 2));
	const bootResp = await defaultApp.handle(new Request(`http://example.com/${half}/bootstrap.json`));
	assertEquals(bootResp.headers.get('cache-control'), 'no-store');
});

Deno.test('Batch 2 reauth & auth validation: reauth clears salt/watcher_pubkey/watchers and rejects empty authcode & duplicate thash', async () => {
	const db = new SQLiteDatastore();
	const testApp = new TiddlyPWASyncApp(
		db,
		'q6kQ8SNKeaVVQDbhb7TgyqdTp8KAO31rU-6AGT1xG0o',
		'ZnPOVo2E_oWm71aQ-eOX9U3-gIE2hR6nfksboNcLNPQ',
	);
	const { token } = await testApp.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({ tiddlypwa: 1, op: 'create', atoken: 'test' }),
		}),
	).then((r) => r.json());
	const half = token.slice(0, Math.floor(token.length / 2));

	// Reject empty authcode
	const emptyAuth = await testApp.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({
				tiddlypwa: 1,
				op: 'sync',
				token,
				authcode: '',
				now: new Date().toISOString(),
				lastSync: new Date(0).toISOString(),
				clientChanges: [],
			}),
		}),
	);
	assertEquals(emptyAuth.status, 400);
	assertEquals(await emptyAuth.json(), { error: 'EPROTO' });

	// Reject duplicate thash in single sync batch
	const dupRes = await testApp.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({
				tiddlypwa: 1,
				op: 'sync',
				token,
				authcode: 'auth-one',
				salt: 'c2FsdDE=',
				now: new Date().toISOString(),
				lastSync: new Date(0).toISOString(),
				clientChanges: [
					{ thash: 'T3dP', ct: '1111', baseMtime: null },
					{ thash: 'T3dP', ct: '2222', baseMtime: null },
				],
			}),
		}),
	);
	assertEquals(dupRes.status, 400);
	assertEquals(await dupRes.json(), { error: 'EPROTO' });

	// Initial pairing sets authcode and salt
	await testApp.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({
				tiddlypwa: 1,
				op: 'sync',
				token,
				authcode: 'auth-one',
				salt: 'c2FsdDE=',
				now: new Date().toISOString(),
				lastSync: new Date(0).toISOString(),
				clientChanges: [],
			}),
		}),
	).then((r) => r.json());

	db.updateWikiWatcherPubKey(token, 'pubkey1');
	db.upsertWatcherModule({
		token,
		watcher_id: 'w1',
		code_hash: 'h1',
		code_source: 'export async function evaluate() { return []; }',
		allowed_hosts: 'example.com',
		schedule_cron: '0 * * * *',
		timezone: 'UTC',
		watched_items: '[]',
		signature: 'sig1',
	});

	const bootBefore = await testApp.handle(new Request(`http://example.com/${half}/bootstrap.json`)).then((r) =>
		r.json()
	);
	assertEquals(bootBefore.state, 'existing');
	assertEquals(bootBefore.salt, 'c2FsdDE=');

	// Reauth clears authcode, salt, watcher_pubkey, and watcher_modules
	await testApp.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({ tiddlypwa: 1, op: 'reauth', atoken: 'test', token }),
		}),
	).then((r) => r.json());
	assertEquals(db.listWatcherModules(token).length, 0);

	const bootCleared = await testApp.handle(new Request(`http://example.com/${half}/bootstrap.json`)).then((r) =>
		r.json()
	);
	assertEquals(bootCleared.state, 'fresh');
	assertEquals(bootCleared.salt, null);

	// Re-pair with new authcode and new salt
	await testApp.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({
				tiddlypwa: 1,
				op: 'sync',
				token,
				authcode: 'auth-two',
				salt: 'c2FsdDI=',
				now: new Date().toISOString(),
				lastSync: new Date(0).toISOString(),
				clientChanges: [],
			}),
		}),
	).then((r) => r.json());

	const bootAfter = await testApp.handle(new Request(`http://example.com/${half}/bootstrap.json`)).then((r) =>
		r.json()
	);
	assertEquals(bootAfter.state, 'existing');
	assertEquals(bootAfter.salt, 'c2FsdDI=');
});

Deno.test('Batch 3 auth & proxy: trustProxy rightmost XFF, malformed hash safety, list authcode omission, monitor auth & ticket', async () => {
	// 1. Default trustProxy=false ignores spoofed X-Forwarded-For
	const directApp = new TiddlyPWASyncApp(
		new SQLiteDatastore(),
		'q6kQ8SNKeaVVQDbhb7TgyqdTp8KAO31rU-6AGT1xG0o',
		'ZnPOVo2E_oWm71aQ-eOX9U3-gIE2hR6nfksboNcLNPQ',
	);
	for (let i = 0; i < 5; i++) {
		const res = await directApp.handle(
			new Request('http://example.com/tid.dly', {
				method: 'POST',
				headers: { 'x-forwarded-for': `203.0.113.${i + 1}` },
				body: JSON.stringify({ tiddlypwa: 1, op: 'list', atoken: 'wrong' }),
			}),
		);
		assertEquals(res.status, 401);
	}
	const directBlocked = await directApp.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			headers: { 'x-forwarded-for': '203.0.113.99' },
			body: JSON.stringify({ tiddlypwa: 1, op: 'list', atoken: 'wrong' }),
		}),
	);
	assertEquals(directBlocked.status, 429);

	// 2. trustProxy=true uses rightmost X-Forwarded-For entry (cannot bypass by prepending spoofed IPs)
	const proxyApp = new TiddlyPWASyncApp(
		new SQLiteDatastore(),
		'q6kQ8SNKeaVVQDbhb7TgyqdTp8KAO31rU-6AGT1xG0o',
		'ZnPOVo2E_oWm71aQ-eOX9U3-gIE2hR6nfksboNcLNPQ',
		'',
		undefined,
		{ trustProxy: true },
	);
	for (let i = 0; i < 5; i++) {
		const res = await proxyApp.handle(
			new Request('http://example.com/tid.dly', {
				method: 'POST',
				headers: { 'x-forwarded-for': `198.51.100.${i + 1}, 203.0.113.50` },
				body: JSON.stringify({ tiddlypwa: 1, op: 'list', atoken: 'wrong' }),
			}),
		);
		assertEquals(res.status, 401);
	}
	const proxyBlocked = await proxyApp.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			headers: { 'x-forwarded-for': '198.51.100.250, 203.0.113.50' },
			body: JSON.stringify({ tiddlypwa: 1, op: 'list', atoken: 'wrong' }),
		}),
	);
	assertEquals(proxyBlocked.status, 429);

	// 3. Malformed admin hash length fails cleanly with 401 instead of throwing
	const badHashApp = new TiddlyPWASyncApp(new SQLiteDatastore(), 'dGVzdHNhbHQ=', 'AQID');
	const badHashRes = await badHashApp.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({ tiddlypwa: 1, op: 'list', atoken: 'test' }),
		}),
	);
	assertEquals(badHashRes.status, 401);

	// 4. op: 'list' does not leak authcode
	const listApp = new TiddlyPWASyncApp(
		new SQLiteDatastore(),
		'q6kQ8SNKeaVVQDbhb7TgyqdTp8KAO31rU-6AGT1xG0o',
		'ZnPOVo2E_oWm71aQ-eOX9U3-gIE2hR6nfksboNcLNPQ',
	);
	const { token } = await listApp.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({ tiddlypwa: 1, op: 'create', atoken: 'test' }),
		}),
	).then((r) => r.json());
	await listApp.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({
				tiddlypwa: 1,
				op: 'sync',
				token,
				authcode: 'super-secret-authcode',
				salt: 'c2FsdA==',
				now: new Date().toISOString(),
				lastSync: new Date(0).toISOString(),
				clientChanges: [],
			}),
		}),
	).then((r) => r.json());

	const listRes = await listApp.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({ tiddlypwa: 1, op: 'list', atoken: 'test' }),
		}),
	).then((r) => r.json());
	assertEquals(listRes.wikis.length, 1);
	assertEquals(listRes.wikis[0].authcode, undefined);
	assertEquals(listRes.wikis[0].hasAuthcode, true);

	// 5. Monitor requires authcode once wiki.authcode is set, and single-use monitor_ticket works
	const unauthTokenMon = listApp.handleMonitor(new URLSearchParams({ token, browserToken: 'b1' }), 20);
	assertEquals(unauthTokenMon.status, 401);

	const wrongAuthMon = listApp.handleMonitor(
		new URLSearchParams({ token, authcode: 'wrong', browserToken: 'b1' }),
		20,
	);
	assertEquals(wrongAuthMon.status, 401);

	const ticketResp = await listApp.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({
				tiddlypwa: 1,
				op: 'monitor_ticket',
				token,
				authcode: 'super-secret-authcode',
				browserToken: 'b1',
			}),
		}),
	);
	assertEquals(ticketResp.status, 200);
	const { ticket } = await ticketResp.json();
	assertEquals(typeof ticket, 'string');

	const monOk = listApp.handleMonitor(new URLSearchParams({ ticket, browserToken: 'b1' }), 20);
	assertEquals(monOk.status, 200);
	const reader = monOk.body!.getReader();
	const chunk = new TextDecoder().decode((await reader.read()).value);
	assertEquals(chunk.includes('event: hi'), true);
	await reader.cancel();

	// Reusing the same single-use ticket must be rejected
	const replayMon = listApp.handleMonitor(new URLSearchParams({ ticket, browserToken: 'b1' }), 20);
	assertEquals(replayMon.status, 401);
});

Deno.test('Batch 4 limits & streaming: pre-auth 413 body limit, payload bounds, and >40 tiddler keyset streaming', async () => {
	// 1. Pre-auth 413 body size ceiling (with and without Content-Length)
	const cappedApp = new TiddlyPWASyncApp(
		new SQLiteDatastore(),
		'q6kQ8SNKeaVVQDbhb7TgyqdTp8KAO31rU-6AGT1xG0o',
		'ZnPOVo2E_oWm71aQ-eOX9U3-gIE2hR6nfksboNcLNPQ',
		'',
		undefined,
		{ maxBodyBytes: 512 },
	);
	const bigPayload = JSON.stringify({ tiddlypwa: 1, op: 'list', atoken: 'x'.repeat(1024) });
	const clResp = await cappedApp.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			headers: { 'content-length': String(bigPayload.length) },
			body: bigPayload,
		}),
	);
	assertEquals(clResp.status, 413);
	assertEquals(await clResp.json(), { error: 'ETOOLARGE' });

	const streamBody = new ReadableStream<Uint8Array>({
		start(ctrl) {
			const bytes = new TextEncoder().encode(bigPayload);
			ctrl.enqueue(bytes.subarray(0, 300));
			ctrl.enqueue(bytes.subarray(300));
			ctrl.close();
		},
	});
	const streamResp = await cappedApp.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: streamBody,
		}),
	);
	assertEquals(streamResp.status, 413);
	assertEquals(await streamResp.json(), { error: 'ETOOLARGE' });

	// 2. Payload validation bounds (note, thash, iv, ackPatches, push_test)
	const tok = await createWiki();
	const longNote = await api({ op: 'create', atoken: 'test', note: 'n'.repeat(1025) });
	assertEquals(longNote.error, 'EPROTO');

	const tooManyChanges = await api({
		op: 'sync',
		token: tok,
		authcode: 'test',
		now: new Date(),
		lastSync: new Date(0),
		clientChanges: Array.from({ length: 5001 }, () => ({ thash: 'AAAA' })),
	});
	assertEquals(tooManyChanges.error, 'EPROTO');

	const oversizedThash = await api({
		op: 'sync',
		token: tok,
		authcode: 'test',
		now: new Date(),
		lastSync: new Date(0),
		clientChanges: [{ thash: btoa('x'.repeat(65)), ct: 'AAAA' }],
	});
	assertEquals(oversizedThash.error, 'EPROTO');

	const oversizedIv = await api({
		op: 'sync',
		token: tok,
		authcode: 'test',
		now: new Date(),
		lastSync: new Date(0),
		clientChanges: [{ thash: 'AAAA', iv: btoa('x'.repeat(65)), ct: 'AAAA' }],
	});
	assertEquals(oversizedIv.error, 'EPROTO');

	const tooManyAck = await api({
		op: 'sync',
		token: tok,
		authcode: 'test',
		now: new Date(),
		lastSync: new Date(0),
		clientChanges: [],
		ackPatches: Array.from({ length: 501 }, (_, i) => `p${i}`),
	});
	assertEquals(tooManyAck.error, 'EPROTO');

	const oversizedPush = await api({
		op: 'push_test',
		token: tok,
		authcode: 'test',
		payload: { mode: 'encrypted', iv: 'AAAA', ct: 'a'.repeat(9000) },
	});
	assertEquals(oversizedPush.error, 'EPROTO');

	// 3. Multi-page keyset streaming (> 40 tiddlers across pages of 16)
	const batch = Array.from({ length: 42 }, (_, i) => ({
		thash: btoa(`tid_${String(i).padStart(3, '0')}`),
		ct: btoa(`body_${i}`),
		baseMtime: null,
	}));
	const writeRes = await api({
		op: 'sync',
		token: tok,
		authcode: 'test',
		now: new Date(),
		lastSync: new Date(0),
		clientChanges: batch,
	});
	assertEquals(writeRes.successes?.length, 42);

	const readRes = await sync(tok, 'test', new Date(), new Date(0), []);
	assertEquals(readRes.serverChanges.length, 42);
	assertEquals(new Set(readRes.serverChanges.map((c: any) => c.thash)).size, 42);

	await deleteWiki(tok);
});
