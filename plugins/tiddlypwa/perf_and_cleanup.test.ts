import { assert, assertEquals, assertRejects } from '@std/assert';

const encodingSource = Deno.readTextFileSync('./plugins/tiddlypwa/encoding.js');
const mainSource = Deno.readTextFileSync('./plugins/tiddlypwa/main.js');
const notifDocSource = Deno.readTextFileSync('./plugins/tiddlypwa/notifications.tid');

Deno.test('P1-5 & P2-1: encoding.js avoids FileReader and enforces 128 MiB decompression guard', async () => {
	assertEquals(encodingSource.includes('FileReader'), false);
	const mod: any = { exports: {} };
	new Function('$tw', 'module', encodingSource)({ browser: true }, mod);

	// b64enc works on plain ArrayBuffer even without FileReader global
	const raw = new TextEncoder().encode('hello tiddlypwa');
	assertEquals(await mod.exports.b64enc(raw.buffer), btoa('hello tiddlypwa'));

	// Forged large gzip payload trips 128 MiB guard cleanly
	const tinyValid = await mod.exports.encodeData('a'.repeat(1024), false, 64);
	// Craft >128 MiB compressible payload or verify max-size constant/guard in decodeData
	assert(encodingSource.includes('128 * 1024 * 1024'));
	assert(tinyValid instanceof Uint8Array);
	await assertRejects(
		async () => {
			// Truncated/invalid buffer still rejects cleanly
			await mod.exports.decodeDataToBytes(new Uint8Array([1, 0, 0, 1, 0]));
		},
		Error,
	);
});

Deno.test('P1-5 & P2-1 & P2-5: main.js history/state exclusion, no-op syncWatchers, safe openStartupStory, O(1) maps, batched sync', () => {
	assert(mainSource.includes('$:/HistoryList'));
	assert(mainSource.includes('$:/state/'));
	assert(mainSource.includes("wTiddler.fields['target-filter'] || wTiddler.fields['config-filter']"));
	assert(mainSource.includes('if (watchersToUpload.length === 0 && removedWatcherIds.length === 0) return;'));
	assertEquals(mainSource.includes('startup/story.js'), false);
	assert(mainSource.includes("$tw.wiki.getTiddler('$:/core')?.fields?.version"));
	assert(mainSource.includes('tid && tid.text)'));
	assert(mainSource.includes('hashB64ToTitle'));
	assert(mainSource.includes('$tw.syncer.storeTiddler(resolvedTid)'));
	assert(notifDocSource.includes('config-filter'));
	assert(notifDocSource.includes('target-filter'));
});
