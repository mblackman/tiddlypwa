import { assert, assertEquals } from '@std/assert';

const manifestSource = Deno.readTextFileSync('./plugins/web-app-manifest/main.js');
const swSource = Deno.readTextFileSync('./plugins/tiddlypwa/sw.js');
const mainSource = Deno.readTextFileSync('./plugins/tiddlypwa/main.js');

Deno.test('P1-9: web-app-manifest emits absolute id, start_url, scope, short_name, and share_target.action', () => {
	const link = { rel: '', href: '' };
	const _document = {
		head: { appendChild: () => {} },
		body: { appendChild: () => {}, removeChild: () => {} },
		querySelector: () => link,
		createElement: () => ({}),
	};
	const _location = {
		origin: 'https://wiki.example.com',
		pathname: '/half123/app.html',
		href: 'https://wiki.example.com/half123/app.html#token=secret',
	};
	const _tw: any = {
		browser: true,
		wiki: {
			renderTiddler: (_type: string, title: string) => title.endsWith('/name') ? 'My Wiki' : '#ffffff',
			getTiddlersWithTag: () => [],
			getTiddler: () => null,
			addEventListener: () => {},
		},
		rootWidget: { addEventListener: () => {} },
	};
	const _URL = {
		...URL,
		createObjectURL: () => 'blob:manifest',
		revokeObjectURL: () => {},
	};
	// Preserve URL constructor while mocking createObjectURL/revokeObjectURL
	const MockURL: any = function (input: string, base?: string) {
		return new URL(input, base);
	};
	MockURL.createObjectURL = () => 'blob:manifest';
	MockURL.revokeObjectURL = () => {};

	const exports: any = {};
	new Function('$tw', 'document', 'location', 'URL', 'Blob', 'exports', manifestSource)(
		_tw,
		_document,
		_location,
		MockURL,
		Blob,
		exports,
	);
	exports.startup();

	const manifest = JSON.parse(_tw.__tiddlypwa_manifest__);
	assertEquals(manifest.name, 'My Wiki');
	assertEquals(manifest.short_name, 'My Wiki');
	assertEquals(manifest.id, 'https://wiki.example.com/half123/app.html');
	assertEquals(manifest.start_url, 'https://wiki.example.com/half123/app.html');
	assertEquals(manifest.scope, 'https://wiki.example.com/half123/');
	assertEquals(manifest.share_target.action, 'https://wiki.example.com/half123/app.html?share-target=1');
});

Deno.test('P0-6 & P1-1 & P1-2: sw.js scopes cache per tenant, bypasses bootstrap.json, strips ?token=, and drops OPTIONS', async () => {
	const listeners = new Map<string, (evt: any) => void>();
	const store = new Map<string, Map<string, Response>>();
	const deletedCaches: string[] = [];
	const fetchedCalls: Array<{ url: string; method: string }> = [];

	// Seed legacy unscoped cache + older versioned cache + sibling tenant cache
	store.set('tiddlypwa', new Map());
	store.set('tiddlypwa:v1:/tenantA/', new Map());
	store.set('tiddlypwa:v2:/tenantB/', new Map());

	const cachesMock = {
		open: async (name: string) => {
			if (!store.has(name)) store.set(name, new Map());
			const m = store.get(name)!;
			return {
				match: async (req: Request | string) => {
					const u = typeof req === 'string' ? req : req.url;
					return m.get(u);
				},
				put: async (req: Request | string, resp: Response) => {
					const u = typeof req === 'string' ? req : req.url;
					m.set(u, resp);
				},
				keys: async () => [...m.keys()].map((u) => new Request(u)),
			};
		},
		keys: async () => [...store.keys()],
		delete: async (name: string) => {
			deletedCaches.push(name);
			return store.delete(name);
		},
	};

	const selfMock: any = {
		registration: {
			scope: 'https://wiki.example.com/tenantA/',
			showNotification: async () => {},
		},
		location: new URL('https://wiki.example.com/tenantA/sw.js'),
		clients: { claim: async () => {}, openWindow: async () => {}, matchAll: async () => [] },
		addEventListener: (type: string, fn: (evt: any) => void) => listeners.set(type, fn),
	};

	const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method || (input instanceof Request ? input.method : 'GET');
		fetchedCalls.push({ url, method });
		return new Response('<html>app</html>', {
			status: 200,
			headers: { 'content-type': 'text/html; charset=utf-8', etag: '"abc"' },
		});
	};

	new Function('self', 'location', 'caches', 'fetch', 'indexedDB', 'clients', swSource)(
		selfMock,
		selfMock.location,
		cachesMock,
		fetchMock,
		{ open: () => ({}) },
		selfMock.clients,
	);

	// 1. Activate prunes legacy 'tiddlypwa' and stale v1 cache for tenantA, but preserves tenantB
	let activatePromise = Promise.resolve();
	listeners.get('activate')?.({ waitUntil: (p: Promise<any>) => (activatePromise = p) });
	await activatePromise;
	assert(deletedCaches.includes('tiddlypwa'));
	assert(deletedCaches.includes('tiddlypwa:v1:/tenantA/'));
	assertEquals(deletedCaches.includes('tiddlypwa:v2:/tenantB/'), false);

	// 2. Fetch bypasses bootstrap.json and tid.dly completely
	let respondedBootstrap = false;
	listeners.get('fetch')?.({
		request: new Request('https://wiki.example.com/tenantA/bootstrap.json'),
		respondWith: () => (respondedBootstrap = true),
	});
	assertEquals(respondedBootstrap, false);

	// 3. Fetch for app.html?token=SECRET caches under clean URL without query string and issues NO OPTIONS request
	let fetchResponsePromise: Promise<Response> | null = null;
	listeners.get('fetch')?.({
		request: new Request('https://wiki.example.com/tenantA/app.html?token=SECRET123'),
		respondWith: (p: Promise<Response>) => (fetchResponsePromise = p),
	});
	assert(fetchResponsePromise !== null);
	await fetchResponsePromise;
	assertEquals(fetchedCalls.some((c) => c.method === 'OPTIONS'), false);
	const tenantACache = store.get('tiddlypwa:v2:/tenantA/');
	assert(tenantACache !== undefined);
	assert(tenantACache.has('https://wiki.example.com/tenantA/app.html'));
	assertEquals([...tenantACache.keys()].some((k) => k.includes('SECRET123')), false);

	// 4. Default notification icon avoids missing favicon.ico
	assertEquals(swSource.includes("'favicon.ico'"), false);
	assert(mainSource.includes('getScopedCacheName'));
	assert(mainSource.includes('history.replaceState'));
});
