import { assertEquals, assert } from 'https://deno.land/std@0.192.0/testing/asserts.ts';
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
	);

Deno.test('x-server-time header returns 1970 for empty database', async () => {
    const createRes = await api({ op: 'create', atoken: 'test' });
    const { token } = await createRes.json();

    const syncResp = await api({ op: 'sync', token, authcode: 'test', now: new Date(), lastSync: new Date(0), clientChanges: [] });
    assertEquals(syncResp.headers.get('x-server-time'), new Date(0).toISOString());

    await api({ op: 'delete', atoken: 'test', token });
});

Deno.test('x-server-time header returns maxMtime BEFORE transaction starts', async () => {
    const createRes = await api({ op: 'create', atoken: 'test' });
    const { token } = await createRes.json();

    // 1. Write a tiddler
    const writeResp = await api({ op: 'sync', token, authcode: 'test', now: new Date(), lastSync: new Date(0), clientChanges: [
        { thash: 'T3dP', ct: '1111' }
    ] });
    
    // x-server-time for this request should still be 1970 because the maxMtime before this transaction was 0
    assertEquals(writeResp.headers.get('x-server-time'), new Date(0).toISOString());

    const writeJson = await writeResp.json();
    const serverTimeMs = new Date(writeJson.successes[0].mtime).getTime();

    // 2. Read the tiddler
    const readResp = await api({ op: 'sync', token, authcode: 'test', now: new Date(), lastSync: new Date(0), clientChanges: [] });
    const readJson = await readResp.json();
    
    // x-server-time should now be the time of the tiddler we wrote!
    assertEquals(new Date(readResp.headers.get('x-server-time')!).getTime(), serverTimeMs);
    assertEquals(readJson.serverChanges.length, 1);

    await api({ op: 'delete', atoken: 'test', token });
});
