import { assert, assertEquals } from '@std/assert';

const encodingSource = Deno.readTextFileSync('./plugins/tiddlypwa/encoding.js');
const mainSource = Deno.readTextFileSync('./plugins/tiddlypwa/main.js');

function createHarness() {
	const encMod: any = { exports: {} };
	new Function('$tw', 'module', encodingSource)({ browser: true }, encMod);

	const tiddlersStore = new Map<string, any>();
	const syncServersStore = new Map<number, any>();
	const metadataStore = new Map<string, any>();
	const toIdbKey = (k: any): string => {
		if (k instanceof ArrayBuffer) return new Uint8Array(k).join(',');
		if (ArrayBuffer.isView(k)) return new Uint8Array(k.buffer, k.byteOffset, k.byteLength).join(',');
		return String(k);
	};
	const storeFor = (name: string): Map<any, any> => {
		if (name === 'tiddlers') return tiddlersStore;
		if (name === 'syncservers') return syncServersStore as any;
		return metadataStore;
	};
	const makeReq = <T>(val: T) => {
		const req: any = { result: val };
		queueMicrotask(() => req.onsuccess?.({ target: req }));
		return req;
	};
	const mockDb: any = {
		transaction: (names: string | string[]) => {
			const storeName = Array.isArray(names) ? names[0] : names;
			const map = storeFor(storeName);
			const txn: any = {};
			queueMicrotask(() => txn.oncomplete?.({ target: txn }));
			txn.objectStore = () => ({
				get: (k: any) => makeReq(map.get(storeName === 'syncservers' ? Number(k) : toIdbKey(k))),
				getAll: () => makeReq([...map.values()]),
				put: (v: any, k?: any) => {
					const key = storeName === 'syncservers' ? (k !== undefined ? Number(k) : 1) : toIdbKey(k ?? v.thash);
					map.set(key, v);
					return makeReq(key);
				},
				delete: (k: any) => {
					map.delete(storeName === 'syncservers' ? Number(k) : toIdbKey(k));
					return makeReq(undefined);
				},
				openCursor: () => {
					const req: any = {};
					const entries = [...map.entries()];
					let idx = 0;
					const step = () => {
						if (idx >= entries.length) {
							req.result = null;
							req.onsuccess?.({ target: req });
							return;
						}
						const [k, v] = entries[idx++];
						req.result = {
							key: k,
							value: v,
							continue: () => queueMicrotask(step),
							update: (nv: any) => map.set(k, nv),
						};
						req.onsuccess?.({ target: req });
					};
					queueMicrotask(step);
					return req;
				},
			});
			return txn;
		},
		close() {},
	};

	const wikiMap = new Map<string, any>();
	const statusHistory: Array<{ title: string; text: string }> = [];
	const deletedTiddlers: string[] = [];

	class MockTiddler {
		fields: Record<string, any>;
		constructor(fields: Record<string, any>) {
			this.fields = { ...fields };
		}
		getFieldString(name: string) {
			const v = this.fields[name];
			if (v === undefined || v === null) return '';
			if (Array.isArray(v)) return v.join(' ');
			return String(v);
		}
		isDraft() {
			return Boolean(this.fields['draft.of']);
		}
	}

	const $tw: any = {
		browser: true,
		Tiddler: MockTiddler,
		config: { contentTypeInfo: { 'text/vnd.tiddlywiki': { encoding: 'utf8' } } },
		utils: {
			Logger: class {
				log() {}
				alert() {}
			},
			domMaker: () => ({
				children: [],
				style: {},
				setAttribute() {},
				appendChild() {},
				insertBefore() {},
				removeChild() {},
				querySelector: () => null,
				querySelectorAll: () => [],
			}),
			addClass: (el: any, cls: string) => el?.classList?.add?.(cls),
			removeClass: (el: any, cls: string) => el?.classList?.remove?.(cls),
			toggleClass() {},
			htmlEncode: (s: string) => String(s),
			parseStringArray: (v: any) => Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(' ') : [],
			getPassword: () => '',
		},
		hooks: { invokeHook: () => {} },
		syncer: {
			storeTiddler: (f: any) => wikiMap.set(f.title, new MockTiddler(f)),
			syncFromServer: () => {},
			updateDirtyStatus: () => {},
			processTaskQueue: () => {},
		},
		wiki: {
			addEventListener() {},
			getTiddler: (t: string) => wikiMap.get(t),
			isBinaryTiddler: () => false,
			tiddlerExists: (t: string) => wikiMap.has(t),
			isShadowTiddler: () => false,
			addTiddler: (t: any) => {
				const fields = t instanceof MockTiddler ? t.fields : t;
				wikiMap.set(fields.title, new MockTiddler(fields));
				if (String(fields.title).startsWith('$:/status/TiddlyPWA')) {
					statusHistory.push({ title: fields.title, text: String(fields.text ?? '') });
				}
			},
			deleteTiddler: (t: string) => {
				deletedTiddlers.push(t);
				wikiMap.delete(t);
			},
			getTiddlers: () => [...wikiMap.keys()],
			getTiddlersWithTag: (tag: string) =>
				[...wikiMap.values()].filter((t) => Array.isArray(t.fields.tags) && t.fields.tags.includes(tag)).map((t) =>
					t.fields.title
				),
			filterTiddlers: () => [],
			allTitles: () => [...wikiMap.keys()],
			getTiddlerText: (_t: string, d = '') => d,
			getTiddlerData: () => ({}),
		},
		rootWidget: { addEventListener() {} },
		modules: { titles: {} },
	};

	const bodyClasses = new Set<string>();
	const _document = {
		body: {
			classList: {
				add: (c: string) => bodyClasses.add(c),
				remove: (c: string) => bodyClasses.delete(c),
			},
		},
		addEventListener() {},
		querySelector: () => null,
	};
	const _window = { addEventListener() {} };
	const _navigator = { onLine: true, locks: { request: async (_n: string, fn: any) => await fn({}) } };

	const mainMod: any = { exports: {} };
	new Function(
		'$tw',
		'require',
		'document',
		'window',
		'navigator',
		'location',
		'BroadcastChannel',
		'indexedDB',
		'exports',
		mainSource,
	)(
		$tw,
		(id: string) => {
			if (id.endsWith('/encoding.js')) return encMod.exports;
			if (id.endsWith('/argon2ian.js')) return { ArgonWorker: class {} };
			if (id.endsWith('/bootstrap.js')) return { BootstrapModal: class {} };
			return {};
		},
		_document,
		_window,
		_navigator,
		new URL('https://example.com/half/app.html'),
		class {
			postMessage() {}
		},
		{ open: () => ({}) },
		mainMod.exports,
	);

	const adaptor = new mainMod.exports.adaptorClass({ wiki: $tw.wiki });
	adaptor.db = mockDb;
	adaptor.browserToken = 'browser-1';
	adaptor.salt = new Uint8Array(16).fill(7);
	return {
		adaptor,
		enc: encMod.exports,
		$tw,
		wikiMap,
		tiddlersStore,
		syncServersStore,
		bodyClasses,
		statusHistory,
		deletedTiddlers,
		_navigator,
	};
}

async function initCrypto(adaptor: any) {
	const raw = new Uint8Array(32).fill(5);
	await adaptor.deriveKeysFromBasebits(raw.buffer);
}

Deno.test('P0-4: Multi-server sync tracks serverSyncState per server and sends explicit baseMtime: null', async () => {
	const { adaptor, $tw, tiddlersStore, enc } = createHarness();
	await initCrypto(adaptor);
	adaptor.storyListHash = await adaptor.titlehash('$:/StoryList');

	const server1 = { url: 'https://s1.example.com/tid.dly', token: 'token-s1', lastSync: new Date(0) };
	const server2 = { url: 'https://s2.example.com/tid.dly', token: 'token-s2', lastSync: new Date(0) };

	await adaptor._saveTiddler(
		new $tw.Tiddler({
			title: 'MultiNote',
			text: 'hello',
			tags: [],
		}),
	);
	const rawRec = [...tiddlersStore.values()][0];
	const localMtimeMs = rawRec.mtime.getTime();
	const thashB64 = await enc.b64enc(rawRec.thash);

	const sentBodies: Array<{ url: string; body: any }> = [];
	const origFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const body = JSON.parse(String(init?.body));
		sentBodies.push({ url, body });
		// Server 1 has a clock BEHIND the client (localMtimeMs - 5000); Server 2 is ahead (+ 2000)
		const srvTime = url.includes('s1.') ? localMtimeMs - 5000 : localMtimeMs + 2000;
		return new Response(
			JSON.stringify({
				serverChanges: [],
				successes: body.clientChanges.map((c: any) => ({ thash: c.thash, mtime: srvTime })),
			}),
			{
				status: 200,
				headers: { 'content-type': 'application/json', 'x-server-time': new Date(srvTime).toISOString() },
			},
		);
	}) as any;

	try {
		await adaptor._syncOneUnlocked(server1, false);
		assertEquals(sentBodies[0].body.clientChanges[0].baseMtime, null);
		const afterS1 = [...tiddlersStore.values()][0];
		assert(afterS1.mtime.getTime() >= localMtimeMs, 'Slower server1 clock must not lower local mtime');

		// Syncing Server 2 STILL sees MultiNote as dirty and sends baseMtime: null (not Server 1's baseMtime!)
		await adaptor._syncOneUnlocked(server2, false);
		assertEquals(sentBodies[1].body.clientChanges.length, 1);
		assertEquals(sentBodies[1].body.clientChanges[0].baseMtime, null);

		// Re-syncing Server 1 sees NO dirty changes now that both servers have synced this edit
		await adaptor._syncOneUnlocked(server1, false);
		assertEquals(sentBodies[2].body.clientChanges.length, 0);
	} finally {
		globalThis.fetch = origFetch;
	}
	assertEquals(thashB64.length > 0, true);
});

Deno.test('P2-6 & P1-4: Tombstone keeps bundled app tiddler deleted across initialRead and watcher patch fails safely', async () => {
	const { adaptor, wikiMap, deletedTiddlers } = createHarness();
	await initCrypto(adaptor);
	wikiMap.set('BundledDoc', { fields: { title: 'BundledDoc', text: 'bundled' } });
	adaptor.tiddlersInFile = new Set(['BundledDoc']);

	// Store a tombstone in IDB matching BundledDoc
	await adaptor._deleteTiddler('BundledDoc');
	const ok = await adaptor.initialRead();
	assertEquals(ok, true);
	assert(deletedTiddlers.includes('BundledDoc'));
	assertEquals(wikiMap.has('BundledDoc'), false);

	// Watcher patch durability: if _saveTiddler fails, patchId must NOT enter ackedPatchIds
	adaptor._saveTiddler = async () => {
		throw new Error('IDB QuotaExceededError');
	};
	await adaptor.applyPendingWatcherPatches([
		{
			patchId: 'patch-fail-1',
			patch: { createTiddler: { title: 'WatcherCreated', text: 'x' } },
		},
	]);
	assertEquals(adaptor.ackedPatchIds.has('patch-fail-1'), false);
});

Deno.test('P1-9: updateSyncUiStatus surfaces local-only, offline, dirty, error, syncing, and synced states', () => {
	const { adaptor, wikiMap, bodyClasses, _navigator } = createHarness();
	adaptor.updateSyncUiStatus({ syncing: false, serverCount: 0, unsyncedCount: 0 });
	assertEquals(wikiMap.get('$:/status/TiddlyPWASyncState')?.fields.text, 'local-only');
	assert(bodyClasses.has('tiddlypwa-sync-state-local-only'));

	_navigator.onLine = false;
	adaptor.updateSyncUiStatus({ syncing: false, serverCount: 1, unsyncedCount: 2 });
	assertEquals(wikiMap.get('$:/status/TiddlyPWASyncState')?.fields.text, 'offline');
	assertEquals(wikiMap.get('$:/status/TiddlyPWAUnsyncedCount')?.fields.text, '2');

	_navigator.onLine = true;
	adaptor.updateSyncUiStatus({ syncing: false, serverCount: 1, unsyncedCount: 1, error: 'HTTP 503' });
	assertEquals(wikiMap.get('$:/status/TiddlyPWASyncState')?.fields.text, 'error');
	assertEquals(wikiMap.get('$:/status/TiddlyPWALastSyncError')?.fields.text, 'HTTP 503');

	// Local save while previous error remains set preserves error indicator
	adaptor.updateSyncUiStatus({ syncing: false, serverCount: 1, unsyncedCount: 2 });
	assertEquals(wikiMap.get('$:/status/TiddlyPWASyncState')?.fields.text, 'error');

	// Successful sync retry clears error even if offline edits remain pending
	adaptor.updateSyncUiStatus({ syncing: false, serverCount: 1, unsyncedCount: 3, error: '' });
	assertEquals(wikiMap.get('$:/status/TiddlyPWASyncState')?.fields.text, 'dirty');

	adaptor.updateSyncUiStatus({ syncing: false, serverCount: 1, unsyncedCount: 0, error: '' });
	assertEquals(wikiMap.get('$:/status/TiddlyPWASyncState')?.fields.text, 'synced');
	assertEquals(wikiMap.get('$:/status/TiddlyPWALastSyncError')?.fields.text, '');
});
