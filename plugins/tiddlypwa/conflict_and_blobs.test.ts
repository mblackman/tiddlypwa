// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertNotEquals } from '@std/assert';

const encodingSource = Deno.readTextFileSync('./plugins/tiddlypwa/encoding.js');
const bootstrapSource = Deno.readTextFileSync('./plugins/tiddlypwa/bootstrap.js');
const mainSource = Deno.readTextFileSync('./plugins/tiddlypwa/main.js');

export function createTestHarness() {
	const tiddlers = new Map<string, any>();
	const rootListeners = new Map<string, Array<(evt: any) => any>>();
	const wikiListeners = new Map<string, Array<(chg: any) => any>>();
	const idbStores: Record<string, Map<string, any>> = {
		metadata: new Map(),
		session: new Map(),
		syncservers: new Map(),
		tiddlers: new Map(),
	};
	const blobUrls = new Map<string, Blob>();
	const revokedUrls: string[] = [];
	let blobSeq = 1;

	function toKey(k: any): string {
		if (k instanceof ArrayBuffer) return Array.from(new Uint8Array(k)).join(',');
		if (ArrayBuffer.isView(k)) return Array.from(new Uint8Array(k.buffer, k.byteOffset, k.byteLength)).join(',');
		return String(k);
	}

	function makeReq(executor: () => any) {
		const req: any = { onsuccess: null, onerror: null, result: undefined, error: null };
		queueMicrotask(() => {
			try {
				req.result = executor();
				req.onsuccess?.({ target: req });
			} catch (err) {
				req.error = err;
				req.onerror?.({ target: req });
			}
		});
		return req;
	}

	const mockDb: any = {
		transaction(name: string) {
			const storeMap = idbStores[name];
			const txn: any = { oncomplete: null, onerror: null, error: null };
			let scheduled = false;
			const scheduleComplete = () => {
				if (scheduled) return;
				scheduled = true;
				setTimeout(() => txn.oncomplete?.({ target: txn }), 0);
			};
			txn.objectStore = () => ({
				get(k: any) {
					scheduleComplete();
					return makeReq(() => {
						const v = storeMap.get(toKey(k));
						return v ? structuredClone(v) : undefined;
					});
				},
				put(val: any, k?: any) {
					scheduleComplete();
					return makeReq(() => {
						const key = k !== undefined ? toKey(k) : (val.thash ? toKey(val.thash) : String(storeMap.size + 1));
						storeMap.set(key, structuredClone(val));
						return key;
					});
				},
				delete(k: any) {
					scheduleComplete();
					return makeReq(() => {
						storeMap.delete(toKey(k));
					});
				},
				getAll() {
					scheduleComplete();
					return makeReq(() => [...storeMap.values()].map((v) => structuredClone(v)));
				},
				openCursor() {
					scheduleComplete();
					const vals = [...storeMap.entries()];
					let idx = 0;
					const req: any = { onsuccess: null, onerror: null };
					const next = () => {
						queueMicrotask(() => {
							if (idx >= vals.length) {
								req.onsuccess?.({ target: { result: null } });
								return;
							}
							const [k, v] = vals[idx++];
							const cursor = {
								key: k,
								value: structuredClone(v),
								update(nextVal: any) {
									storeMap.set(k, structuredClone(nextVal));
								},
								delete() {
									storeMap.delete(k);
								},
								continue: next,
							};
							req.onsuccess?.({ target: { result: cursor } });
						});
					};
					next();
					return req;
				},
			});
			return txn;
		},
		close() {},
	};

	class MockTiddler {
		fields: Record<string, any>;
		constructor(fields: Record<string, any>) {
			this.fields = { ...fields };
		}
		getFieldString(name: string) {
			const v = this.fields[name];
			if (v === undefined || v === null) return '';
			if (Array.isArray(v)) return v.map((x) => (/\s/.test(x) ? `[[${x}]]` : x)).join(' ');
			if (v instanceof Date) return v.toISOString();
			return String(v);
		}
		isDraft() {
			return Boolean(this.fields['draft.of']);
		}
	}

	const $tw: any = {
		browser: true,
		Tiddler: MockTiddler,
		config: {
			contentTypeInfo: {
				'image/png': { encoding: 'base64' },
				'text/vnd.tiddlywiki': { encoding: 'utf8' },
			},
		},
		utils: {
			Logger: class {
				log() {}
				alert() {}
			},
			domMaker: (_tag: string, opts: any = {}) => ({
				children: [] as any[],
				style: {},
				className: opts.class || '',
				innerHTML: opts.innerHTML || '',
				textContent: opts.text || '',
				setAttribute() {},
				appendChild(c: any) {
					this.children.push(c);
				},
				insertBefore() {},
				removeChild() {},
				querySelector() {
					return null;
				},
				querySelectorAll() {
					return [];
				},
			}),
			addClass() {},
			removeClass() {},
			toggleClass() {},
			htmlEncode: (s: string) =>
				String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
			parseStringArray: (val: any) => {
				if (Array.isArray(val)) return val.slice();
				if (typeof val !== 'string' || !val.trim()) return [];
				const out: string[] = [];
				const re = /\[\[([^\]]+)\]\]|(\S+)/g;
				let m: RegExpExecArray | null;
				while ((m = re.exec(val)) !== null) out.push(m[1] ?? m[2]);
				return out;
			},
			stringifyList: (arr: any) => {
				if (!Array.isArray(arr)) return String(arr || '');
				return arr.map((x) => (/\s/.test(String(x)) ? `[[${x}]]` : String(x))).join(' ');
			},
		},
		hooks: { invokeHook() {} },
		modules: { titles: {} },
		rootWidget: {
			addEventListener(type: string, fn: (evt: any) => any) {
				const arr = rootListeners.get(type) || [];
				arr.push(fn);
				rootListeners.set(type, arr);
			},
			dispatch(type: string, evt: any) {
				for (const fn of rootListeners.get(type) || []) fn(evt);
			},
		},
		wiki: {
			allTitles: () => [...tiddlers.keys()],
			getTiddlers: () => [...tiddlers.keys()],
			getTiddler: (title: string) => tiddlers.get(title),
			tiddlerExists: (title: string) => tiddlers.has(title),
			isShadowTiddler: () => false,
			isBinaryTiddler: (title: string) => {
				const t = tiddlers.get(title);
				return Boolean(t && $tw.config.contentTypeInfo[t.fields.type]?.encoding === 'base64');
			},
			getTiddlerText: (title: string, def = '') => tiddlers.get(title)?.fields?.text ?? def,
			getTiddlerData: () => ({}),
			getTiddlersWithTag: (tag: string) =>
				[...tiddlers.values()]
					.filter((t) => $tw.utils.parseStringArray(t.fields.tags).includes(tag))
					.map((t) => t.fields.title),
			findDraft: (title: string) => (tiddlers.has(`Draft of '${title}'`) ? `Draft of '${title}'` : undefined),
			filterTiddlers: (f: string) => {
				if (f.includes('$:/tags/TiddlyPWA/Conflict')) {
					return $tw.wiki.getTiddlersWithTag('$:/tags/TiddlyPWA/Conflict');
				}
				return [];
			},
			addTiddler(t: any) {
				const tid = t instanceof MockTiddler ? t : new MockTiddler(t);
				tiddlers.set(tid.fields.title, tid);
				for (const fn of wikiListeners.get('change') || []) {
					fn({ [tid.fields.title]: { modified: true } });
				}
			},
			deleteTiddler(title: string) {
				tiddlers.delete(title);
			},
			addEventListener(type: string, fn: any) {
				const arr = wikiListeners.get(type) || [];
				arr.push(fn);
				wikiListeners.set(type, arr);
			},
			removeEventListener(type: string, fn: any) {
				const arr = wikiListeners.get(type) || [];
				wikiListeners.set(type, arr.filter((x) => x !== fn));
			},
			renderTiddler: () => '',
		},
		syncer: {
			tiddlerInfo: {} as Record<string, any>,
			storeTiddler(fields: any) {
				$tw.wiki.addTiddler(fields);
			},
			syncFromServer() {},
			updateDirtyStatus() {},
			isDirty: () => false,
		},
		modal: { display() {} },
		notifier: { display() {} },
		__update_tiddlypwa_manifest__() {},
	};

	const encMod: any = { exports: {} };
	new Function('$tw', 'module', encodingSource)($tw, encMod);
	const bootMod: any = { exports: {} };
	const mockDoc: any = {
		body: {
			firstChild: null,
			insertBefore() {},
			appendChild() {},
			removeChild() {},
		},
		addEventListener() {},
		getElementById: () => null,
		querySelector: () => null,
		createElement: () => ({
			style: { setProperty() {} },
			appendChild() {},
			querySelector: () => null,
		}),
	};
	const mockLoc = {
		origin: 'https://wiki.example.com',
		pathname: '/w/app.html',
		search: '',
		hash: '',
		href: 'https://wiki.example.com/w/app.html',
	};
	new Function('$tw', 'module', 'document', 'location', bootstrapSource)($tw, bootMod, mockDoc, mockLoc);

	const mainMod: any = { exports: {} };
	const channels: any[] = [];
	class MockBroadcastChannel {
		onmessage: any = null;
		constructor(_name: string) {
			channels.push(this);
		}
		postMessage() {}
		close() {}
	}
	const mockRequire = (id: string) => {
		if (id.endsWith('/encoding.js')) return encMod.exports;
		if (id.endsWith('/bootstrap.js')) return bootMod.exports;
		return {};
	};
	const origCreate = URL.createObjectURL;
	const origRevoke = URL.revokeObjectURL;
	const mockURL = Object.assign(
		function (u: string, b?: string) {
			return new URL(u, b);
		},
		{
			createObjectURL: (blob: Blob) => {
				const url = `blob:https://wiki.example.com/test-${blobSeq++}`;
				blobUrls.set(url, blob);
				return url;
			},
			revokeObjectURL: (url: string) => {
				revokedUrls.push(url);
				blobUrls.delete(url);
			},
		},
	);

	// Provide globalThis.URL hooks during construction/execution
	const mockNavigator = {
		onLine: false,
		locks: { request: (_name: string, fn: any) => fn({}) },
	};
	new Function(
		'$tw',
		'require',
		'exports',
		'document',
		'location',
		'navigator',
		'BroadcastChannel',
		'URL',
		'confirm',
		'alert',
		mainSource,
	)(
		$tw,
		mockRequire,
		mainMod.exports,
		mockDoc,
		mockLoc,
		mockNavigator,
		MockBroadcastChannel,
		mockURL,
		() => true,
		() => {},
	);

	// Restore globals if touched
	URL.createObjectURL = origCreate;
	URL.revokeObjectURL = origRevoke;

	const adaptor = new mainMod.exports.adaptorClass({ wiki: $tw.wiki });
	adaptor.db = mockDb;
	adaptor.ready = true;
	adaptor.isSyncing = false;
	adaptor.salt = crypto.getRandomValues(new Uint8Array(32));

	return {
		$tw,
		adaptor,
		enc: encMod.exports,
		idbStores,
		blobUrls,
		revokedUrls,
		tiddlers,
		mockURL,
		toKey,
	};
}

Deno.test('P0-1: Binary blob lifecycle preserves conflict payload, suppresses identical blobs, and hydrates export', async () => {
	const h = createTestHarness();
	const origCreate = URL.createObjectURL;
	const origRevoke = URL.revokeObjectURL;
	URL.createObjectURL = h.mockURL.createObjectURL;
	URL.revokeObjectURL = h.mockURL.revokeObjectURL;
	try {
		await h.adaptor.deriveKeysFromBasebits(new Uint8Array(32).fill(7));

		// 1. Seed a binary image tiddler into IDB (1x1 PNG bytes)
		const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
		const pngB64 = btoa(String.fromCharCode(...pngBytes));
		await h.adaptor._saveTiddler(
			new h.$tw.Tiddler({
				title: 'Photo.png',
				type: 'image/png',
				text: pngB64,
				tags: ['Media'],
			}),
		);

		// 2. Load via initialRead -> must hydrate as blob: _canonical_uri, NOT base64 text
		h.tiddlers.clear();
		const ok = await h.adaptor.initialRead();
		assertEquals(ok, true);
		const loaded = h.$tw.wiki.getTiddler('Photo.png');
		assert(loaded.fields._canonical_uri?.startsWith('blob:'), 'Expected initialRead to produce blob: _canonical_uri');
		assertEquals(loaded.fields.text, undefined);

		// 3. _loadTiddler must also return blob: _canonical_uri for binary tiddlers
		const reloaded = await h.adaptor._loadTiddler('Photo.png');
		assert(reloaded._canonical_uri?.startsWith('blob:'), 'Expected _loadTiddler to produce blob: _canonical_uri');

		// 4. tiddlersAreEqual must treat identical binary payloads with different blob: URLs as equal
		const thash = await h.adaptor.titlehash('Photo.png');
		const idbRec = h.idbStores.tiddlers.get(h.toKey(thash));
		const recCopyA = await h.adaptor.decryptRawTiddler(idbRec);
		const recCopyB = await h.adaptor.decryptRawTiddler(idbRec);
		assertNotEquals(recCopyA._canonical_uri, recCopyB._canonical_uri);
		assertEquals(h.adaptor.tiddlersAreEqual(recCopyA, recCopyB), true);

		// 5. Creating a conflict copy of a binary tiddler must save valid sbiv/sbct under its new thash
		const altPngBytes = new Uint8Array([137, 80, 78, 71, 99, 88, 77, 66, 1, 2, 3, 4]);
		const altIv = crypto.getRandomValues(new Uint8Array(12));
		const altMetaIv = crypto.getRandomValues(new Uint8Array(12));
		const altMetaCt = await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: altMetaIv },
			h.adaptor.enckey(thash),
			await h.enc.encodeData(JSON.stringify({ title: 'Photo.png', type: 'image/png', tags: 'Media' }), false, 256),
		);
		const altSbCt = await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: altIv },
			h.adaptor.enckey(thash),
			await h.enc.encodeBinaryBytes(altPngBytes, 256),
		);
		const altDecrypted = await h.adaptor.decryptRawTiddler({
			thash,
			iv: altMetaIv,
			ct: altMetaCt,
			sbiv: altIv,
			sbct: altSbCt,
		});
		const conflictTid = h.adaptor.createConflictTiddler(altDecrypted, 'Photo.png', 'local', new Date());
		h.$tw.wiki.addTiddler(conflictTid);
		await h.adaptor._saveTiddler(conflictTid);

		const conflictHash = await h.adaptor.titlehash(conflictTid.fields.title);
		const conflictRec = h.idbStores.tiddlers.get(h.toKey(conflictHash));
		assert(conflictRec?.sbiv && conflictRec?.sbct, 'Conflict binary tiddler must persist sbiv/sbct');

		// 6. Resolving conflict via tiddlypwa-resolve-conflict (keep-conflict) must write altPngBytes into Photo.png
		h.$tw.rootWidget.dispatch('tiddlypwa-resolve-conflict', {
			paramObject: { conflictTitle: conflictTid.fields.title, action: 'keep-conflict' },
		});
		const resolvedTid = h.$tw.wiki.getTiddler('Photo.png');
		await h.adaptor._saveTiddler(resolvedTid);
		const resolvedFromIdb = await h.adaptor._loadTiddler('Photo.png');
		const resolvedBlob = h.blobUrls.get(resolvedFromIdb._canonical_uri);
		assert(resolvedBlob, 'Resolved binary tiddler must have registered blob');
		assertEquals(new Uint8Array(await resolvedBlob.arrayBuffer()), altPngBytes);

		// 7. Single-file export hydration temporarily converts blob: URLs back into base64 text
		const exportedText = h.adaptor.hydrateWikiBlobsTemporarily(() => h.$tw.wiki.getTiddler('Photo.png').fields.text);
		assertEquals(exportedText, btoa(String.fromCharCode(...altPngBytes)));
		assertEquals(h.$tw.wiki.getTiddler('Photo.png').fields._canonical_uri?.startsWith('blob:'), true);
	} finally {
		URL.createObjectURL = origCreate;
		URL.revokeObjectURL = origRevoke;
	}
});

Deno.test('P0-8: Custom fields are preserved on conflict resolution and checked on draft collision', async () => {
	const h = createTestHarness();
	await h.adaptor.deriveKeysFromBasebits(new Uint8Array(32).fill(9));

	// Canonical tiddler with custom fields
	h.$tw.wiki.addTiddler({
		title: 'Task A',
		text: 'Same body',
		tags: ['Task'],
		due: '20261201',
		priority: 'low',
	});
	// Conflict tiddler with modified custom fields and tags
	h.$tw.wiki.addTiddler({
		title: 'Task A (Conflict 2026-11-23 12:00:00)',
		text: 'Same body',
		tags: ['Task', 'Urgent', '$:/tags/TiddlyPWA/Conflict'],
		due: '20261124',
		priority: 'high',
		'custom-note': 'keep me',
		'tiddlypwa-conflict-of': 'Task A',
		'tiddlypwa-conflict-source': 'remote',
		'tiddlypwa-conflict-date': '2026-11-23T12:00:00.000Z',
	});

	h.$tw.rootWidget.dispatch('tiddlypwa-resolve-conflict', {
		paramObject: {
			conflictTitle: 'Task A (Conflict 2026-11-23 12:00:00)',
			action: 'keep-conflict',
		},
	});

	const updated = h.$tw.wiki.getTiddler('Task A');
	assertEquals(updated.fields.due, '20261124');
	assertEquals(updated.fields.priority, 'high');
	assertEquals(updated.fields['custom-note'], 'keep me');
	assertEquals(updated.fields['tiddlypwa-conflict-of'], undefined);
	assertEquals(h.$tw.utils.parseStringArray(updated.fields.tags), ['Task', 'Urgent']);
	assertEquals(h.$tw.wiki.tiddlerExists('Task A (Conflict 2026-11-23 12:00:00)'), false);

	// Draft collision when ONLY a custom field changed on remote
	h.$tw.wiki.addTiddler({
		title: "Draft of 'Task A'",
		'draft.of': 'Task A',
		'draft.title': 'Task A',
		text: 'Same body',
		tags: ['Task', 'Urgent'],
		due: '20261124',
		priority: 'high',
		'custom-note': 'keep me',
	});
	const remoteUpdate = {
		title: 'Task A',
		text: 'Same body',
		tags: 'Task Urgent',
		due: '20261231', // changed on another device!
		priority: 'high',
		'custom-note': 'keep me',
	};
	h.adaptor.checkDraftCollision('Task A', remoteUpdate, new Date('2026-11-23T13:00:00Z'));
	const conflicts = h.$tw.wiki.getTiddlersWithTag('$:/tags/TiddlyPWA/Conflict');
	assertEquals(conflicts.length, 1);
	const conflictCopy = h.$tw.wiki.getTiddler(conflicts[0]);
	assertEquals(conflictCopy.fields.due, '20261231');
});
