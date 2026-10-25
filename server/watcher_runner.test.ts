import { assert, assertEquals, assertRejects } from '@std/assert';
import { encodeBase64Url } from '@std/encoding/base64url';
import { SQLiteDatastore } from './sqlite.ts';
import { TiddlyPWASyncApp } from './app.ts';
import { getOrCreateVapidKeys } from './webpush.ts';
import { matchesCron, tickWatchers } from './scheduler.ts';
import {
	canonicalizeWatchedItems,
	computeCodeHash,
	extractJsonLd,
	isBlockedIp,
	parseAllowedHosts,
	parseXml,
	queryHtml,
	runSandboxedWatcher,
	serializeWatcherSignablePayload,
	validateUrlAgainstSsrf,
	verifyWatcherSignature,
	WatchedItem,
} from './watcher_runner.ts';

async function generateEd25519TestKeyPair() {
	const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
	const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
	return {
		privateKey: kp.privateKey,
		publicKeyB64Url: jwk.x!,
	};
}

async function signWatcherPayload(
	privateKey: CryptoKey,
	payload: {
		watcherId: string;
		codeHash: string;
		allowedHosts: string;
		scheduleCron: string;
		timezone: string;
		watchedItems: WatchedItem[];
	},
): Promise<string> {
	const msg = serializeWatcherSignablePayload(payload);
	const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, msg as unknown as BufferSource);
	return encodeBase64Url(new Uint8Array(sig));
}

Deno.test('SSRF IP validator blocks loopback, RFC1918, metadata, CGNAT, and IPv6 internal ranges', async () => {
	// Blocked IPv4
	assert(isBlockedIp('127.0.0.1'));
	assert(isBlockedIp('127.255.255.254'));
	assert(isBlockedIp('0.0.0.0'));
	assert(isBlockedIp('10.0.0.1'));
	assert(isBlockedIp('10.255.255.255'));
	assert(isBlockedIp('172.16.0.1'));
	assert(isBlockedIp('172.31.255.255'));
	assert(isBlockedIp('192.168.1.1'));
	assert(isBlockedIp('169.254.169.254')); // Cloud metadata
	assert(isBlockedIp('100.64.0.1')); // CGNAT / Tailscale
	assert(isBlockedIp('100.100.100.100'));
	assert(isBlockedIp('224.0.0.1'));

	// Allowed public IPv4
	assert(!isBlockedIp('93.184.216.34'));
	assert(!isBlockedIp('8.8.8.8'));
	assert(!isBlockedIp('172.15.0.1'));
	assert(!isBlockedIp('172.32.0.1'));
	assert(!isBlockedIp('100.63.255.255'));
	assert(!isBlockedIp('100.128.0.1'));

	// Blocked IPv6
	assert(isBlockedIp('::1'));
	assert(isBlockedIp('::'));
	assert(isBlockedIp('0:0:0:0:0:0:0:1'));
	assert(isBlockedIp('::ffff:127.0.0.1'));
	assert(isBlockedIp('::ffff:169.254.169.254'));
	assert(isBlockedIp('::ffff:10.0.0.1'));
	assert(isBlockedIp('fc00::1'));
	assert(isBlockedIp('fd12:3456:789a::1'));
	assert(isBlockedIp('fe80::1'));
	assert(isBlockedIp('ff02::1'));

	// Allowed public IPv6
	assert(!isBlockedIp('2606:2800:220:1:248:1893:25c8:1946'));
	assert(!isBlockedIp('2001:4860:4860::8888'));

	// Host allowlist & DNS resolution checks
	const allowed = parseAllowedHosts('www.kobo.com, feeds.example.com');
	await assertRejects(
		() => validateUrlAgainstSsrf('https://evil.example.com/page', allowed, async () => ['93.184.216.34']),
		Error,
		'not in allowed-hosts',
	);
	await assertRejects(
		() =>
			validateUrlAgainstSsrf(
				'https://www.kobo.com/page',
				allowed,
				async (_, type) => type === 'A' ? ['169.254.169.254'] : [],
			),
		Error,
		'SSRF blocked resolved IP',
	);
	await assertRejects(
		() => validateUrlAgainstSsrf('file:///etc/passwd', allowed, async () => ['93.184.216.34']),
		Error,
		'Disallowed protocol',
	);

	const validUrl = await validateUrlAgainstSsrf(
		'https://www.kobo.com/us/en/ebook/test',
		allowed,
		async (_, type) => (type === 'A' ? ['93.184.216.34'] : []),
	);
	assertEquals(validUrl.hostname, 'www.kobo.com');
});

Deno.test('Host scraping helpers: extractJsonLd, queryHtml, and parseXml', () => {
	const html = `
		<!DOCTYPE html>
		<html>
		<head>
			<script type="application/ld+json">
			{
				"@context": "https://schema.org",
				"@graph": [
					{
						"@type": "Organization",
						"name": "Rakuten Kobo"
					},
					{
						"@type": ["Product", "Book"],
						"name": "Dungeon Meshi, Vol. 14",
						"position": 14,
						"url": "https://www.kobo.com/us/en/ebook/dungeon-meshi-vol-14",
						"workExample": [{ "datePublished": "2026-11-15" }]
					}
				]
			}
			</script>
		</head>
		<body>
			<div id="catalog" class="store-grid">
				<article class="book-card featured" data-vol="14">
					<h2 class="title"><a href="/ebook/vol-14">Dungeon Meshi &amp; Co. Vol. 14</a></h2>
					<span class="price">$12.99</span>
				</article>
				<article class="book-card" data-vol="13">
					<h2 class="title"><a href="/ebook/vol-13">Dungeon Meshi Vol. 13</a></h2>
				</article>
			</div>
		</body>
		</html>
	`;

	const books = extractJsonLd(html, 'Book');
	assertEquals(books.length, 1);
	assertEquals(books[0].name, 'Dungeon Meshi, Vol. 14');
	assertEquals(books[0].position, 14);

	const cards = queryHtml(html, '#catalog article.book-card.featured > h2.title a[href^="/ebook/"]');
	assertEquals(cards.length, 1);
	assertEquals(cards[0].text, 'Dungeon Meshi & Co. Vol. 14');
	assertEquals(cards[0].attrs.href, '/ebook/vol-14');

	const allArticles = queryHtml(html, 'article[data-vol]');
	assertEquals(allArticles.length, 2);
	assertEquals(allArticles[0].attrs['data-vol'], '14');
	assertEquals(allArticles[1].attrs['data-vol'], '13');

	const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
		<rss version="2.0">
			<channel>
				<title>Roaster Drops</title>
				<item>
					<title><![CDATA[Ethiopia Worka Sakaro & Anaerobic]]></title>
					<link>https://roaster.example.com/beans/worka</link>
					<guid>worka-2026</guid>
					<pubDate>Sun, 25 Oct 2026 12:00:00 GMT</pubDate>
					<description><![CDATA[<p>Floral, bergamot, peach.</p>]]></description>
				</item>
			</channel>
		</rss>
	`;
	const parsedRss = parseXml(rssXml);
	assertEquals(parsedRss.feedTitle, 'Roaster Drops');
	assertEquals(parsedRss.items.length, 1);
	assertEquals(parsedRss.items[0].title, 'Ethiopia Worka Sakaro & Anaerobic');
	assertEquals(parsedRss.items[0].link, 'https://roaster.example.com/beans/worka');
	assertEquals(parsedRss.items[0].id, 'worka-2026');

	const atomXml = `<?xml version="1.0" encoding="utf-8"?>
		<feed xmlns="http://www.w3.org/2005/Atom">
			<title>Release Feed</title>
			<entry>
				<title>Release 2.0</title>
				<link rel="alternate" href="https://example.com/releases/2.0"/>
				<id>tag:example.com,2026:2.0</id>
				<published>2026-10-25T10:00:00Z</published>
				<summary>Major release</summary>
			</entry>
		</feed>
	`;
	const parsedAtom = parseXml(atomXml);
	assertEquals(parsedAtom.feedTitle, 'Release Feed');
	assertEquals(parsedAtom.items.length, 1);
	assertEquals(parsedAtom.items[0].title, 'Release 2.0');
	assertEquals(parsedAtom.items[0].link, 'https://example.com/releases/2.0');
	assertEquals(parsedAtom.items[0].pubDate, '2026-10-25T10:00:00Z');
});

Deno.test('Sandboxed Deno Worker enforces zero permissions, watchdog timeout, and UTF-8 safe execution', async () => {
	// 1. Direct network or filesystem access inside worker must fail due to Deno permissions
	const forbiddenNetCode = `
		export async function evaluate() {
			await fetch('https://example.com');
			return [];
		}
	`;
	await assertRejects(
		() => runSandboxedWatcher(forbiddenNetCode, [], 'example.com', {}),
		Error,
	);

	// 2. Infinite synchronous loop is terminated by watchdog timer
	const infiniteLoopCode = `
		export async function evaluate() {
			while (true) {}
			return [];
		}
	`;
	await assertRejects(
		() => runSandboxedWatcher(infiniteLoopCode, [], 'example.com', {}, { timeoutMs: 350 }),
		Error,
		'timed out',
	);

	// 3. UTF-8 watcher script with host.fetch ETag caching, extractJsonLd, and matchRegex
	const utf8WatcherCode = `
		// 日本語コメント & emoji 📚
		export async function evaluate(items, host) {
			const results = [];
			for (const item of items) {
				const resp = await host.fetch(item.fields.url, { cacheKey: item.title });
				if (resp.notModified) continue;
				const books = await host.extractJsonLd(resp.body, 'Book');
				const newest = books
					.map((b) => ({
						volume: Number(host.matchRegex(b.name, /Vol(?:\\.|ume)?\\s*(\\d+)/i)?.[1] || 0),
						title: b.name,
					}))
					.sort((a, b) => b.volume - a.volume)[0];
				if (newest && newest.volume > Number(item.fields.latest || 0)) {
					await host.setState('lastMatched', newest.title);
					results.push({
						itemTitle: item.title,
						notify: {
							title: '📚 New Volume: ' + newest.title,
							body: 'Volume ' + newest.volume + ' is out!',
						},
						patchTarget: {
							title: item.title,
							fields: { latest: String(newest.volume) },
						},
					});
				}
			}
			return results;
		}
	`;

	let fetchCalls = 0;
	const mockFetch: typeof fetch = async (_input, init) => {
		fetchCalls++;
		const hdrs = new Headers(init?.headers);
		if (hdrs.get('if-none-match') === '"etag-v15"') {
			return new Response(null, { status: 304 });
		}
		return new Response(
			`<script type="application/ld+json">{"@type":"Book","name":"Manga Series Vol. 15"}</script>`,
			{
				status: 200,
				headers: { etag: '"etag-v15"' },
			},
		);
	};

	const firstRun = await runSandboxedWatcher(
		utf8WatcherCode,
		[{ title: 'My Manga', fields: { latest: '14', url: 'https://www.kobo.com/series/1' } }],
		'www.kobo.com',
		{},
		{
			fetchFn: mockFetch,
			resolveDnsFn: async (_, type) => (type === 'A' ? ['93.184.216.34'] : []),
		},
	);
	assertEquals(firstRun.results.length, 1);
	assertEquals(firstRun.results[0].notify?.title, '📚 New Volume: Manga Series Vol. 15');
	assertEquals(firstRun.nextState.httpCache?.['My Manga']?.etag, '"etag-v15"');
	assertEquals(firstRun.nextState.custom?.lastMatched, 'Manga Series Vol. 15');

	// Second run with updated state receives 304 Not Modified
	const secondRun = await runSandboxedWatcher(
		utf8WatcherCode,
		[{ title: 'My Manga', fields: { latest: '15', url: 'https://www.kobo.com/series/1' } }],
		'www.kobo.com',
		firstRun.nextState,
		{
			fetchFn: mockFetch,
			resolveDnsFn: async (_, type) => (type === 'A' ? ['93.184.216.34'] : []),
		},
	);
	assertEquals(fetchCalls, 2);
	assertEquals(secondRun.results.length, 0);
});

Deno.test('End-to-end sync_watchers, Ed25519 TOFU & tamper defense, run_watcher, pendingPatches sync, and cron tickWatchers', async () => {
	const db = new SQLiteDatastore(':memory:');
	const app = new TiddlyPWASyncApp(db, '', '');
	const token = 'wiki-watcher-e2e-token-12345678901234567890';
	const authcode = 'wiki-auth-1';
	db.createWiki(token, 'Watcher E2E Wiki');
	db.updateWikiAuthcode(token, authcode);

	await getOrCreateVapidKeys(db);

	let pushDeliveries = 0;
	app.pushFetchFn = async () => {
		pushDeliveries++;
		return new Response(null, { status: 201 });
	};
	app.resolveDnsFn = async (_, type) => (type === 'A' ? ['93.184.216.34'] : []);
	app.watcherFetchFn = async () =>
		new Response(
			`<script type="application/ld+json">{"@type":"Book","name":"Test Manga Vol. 5","position":5,"url":"https://www.kobo.com/book/5"}</script>`,
			{ status: 200, headers: { etag: '"v5-etag"' } },
		);

	// Register a push subscription so watcher notifications have a recipient
	const uaKeyPair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
		'deriveBits',
	])) as CryptoKeyPair;
	const uaPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', uaKeyPair.publicKey));
	const uaAuth = crypto.getRandomValues(new Uint8Array(16));
	db.upsertPushSubscription({
		token,
		endpoint: 'https://push.example.com/sub/watcher-test',
		p256dh: encodeBase64Url(uaPubRaw),
		auth: encodeBase64Url(uaAuth),
		ua_hint: 'DenoTest',
		created_at: Date.now(),
	});

	const { privateKey, publicKeyB64Url } = await generateEd25519TestKeyPair();
	const watcherCode = `
		export async function evaluate(items, host) {
			const results = [];
			for (const item of items) {
				const resp = await host.fetch(item.fields['kobo-series-url'], { cacheKey: item.title });
				if (resp.notModified) continue;
				const books = await host.extractJsonLd(resp.body, 'Book');
				const newest = books[0];
				if (newest && Number(newest.position) > Number(item.fields['latest-volume'] || 0)) {
					results.push({
						itemTitle: item.title,
						notify: {
							title: 'New Volume: ' + newest.name,
							body: 'Vol ' + newest.position,
							actions: [{ action: 'import-vol', title: 'Import' }],
						},
						patchTarget: {
							title: item.title,
							fields: { 'latest-volume': String(newest.position) },
						},
						actionPatches: {
							'import-vol': {
								createTiddler: {
									title: newest.name,
									fields: { 'kobo-url': newest.url },
								},
							},
						},
					});
				}
			}
			return results;
		}
	`;
	const codeHash = await computeCodeHash(watcherCode);
	const watchedItems: WatchedItem[] = canonicalizeWatchedItems([
		{
			title: 'Test Manga',
			fields: {
				'kobo-series-url': 'https://www.kobo.com/series/test',
				'latest-volume': '4',
				title: 'Test Manga',
			},
		},
	]);
	const watcherId = 'mblackman.media-importer.kobo';
	const allowedHosts = 'www.kobo.com';
	const scheduleCron = '0 14 * * *';
	const timezone = 'America/Denver';

	const signature = await signWatcherPayload(privateKey, {
		watcherId,
		codeHash,
		allowedHosts,
		scheduleCron,
		timezone,
		watchedItems,
	});
	assert(
		await verifyWatcherSignature(
			publicKeyB64Url,
			{ watcherId, codeHash, allowedHosts, scheduleCron, timezone, watchedItems },
			signature,
		),
	);

	// 1. Tampered codeSource or watchedItems must be rejected with 401/400
	const tamperedResp = await app.handle(
		new Request('http://localhost/tid.dly', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				tiddlypwa: 1,
				op: 'sync_watchers',
				token,
				authcode,
				watcherPubKey: publicKeyB64Url,
				watchers: [
					{
						watcherId,
						codeHash,
						codeSource: watcherCode,
						allowedHosts: 'www.kobo.com, attacker.example.com', // tampered!
						scheduleCron,
						timezone,
						watchedItems,
						signature,
					},
				],
			}),
		}),
	);
	assertEquals(tamperedResp.status, 401);

	// 2. Valid sync_watchers binds watcher_pubkey (TOFU) and stores watcher
	const syncResp = await app.handle(
		new Request('http://localhost/tid.dly', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				tiddlypwa: 1,
				op: 'sync_watchers',
				token,
				authcode,
				watcherPubKey: publicKeyB64Url,
				watchers: [
					{
						watcherId,
						codeHash,
						codeSource: watcherCode,
						allowedHosts,
						scheduleCron,
						timezone,
						watchedItems,
						signature,
					},
				],
			}),
		}),
	);
	assertEquals(syncResp.status, 200);
	const syncJson = await syncResp.json();
	assertEquals(syncJson, { ok: true, upserted: 1, removed: 0 });

	// 3. Different Ed25519 key attempting to overwrite watchers is rejected (TOFU pin)
	const otherKp = await generateEd25519TestKeyPair();
	const otherSig = await signWatcherPayload(otherKp.privateKey, {
		watcherId,
		codeHash,
		allowedHosts,
		scheduleCron,
		timezone,
		watchedItems,
	});
	const wrongKeyResp = await app.handle(
		new Request('http://localhost/tid.dly', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				tiddlypwa: 1,
				op: 'sync_watchers',
				token,
				authcode,
				watcherPubKey: otherKp.publicKeyB64Url,
				watchers: [
					{
						watcherId,
						codeHash,
						codeSource: watcherCode,
						allowedHosts,
						scheduleCron,
						timezone,
						watchedItems,
						signature: otherSig,
					},
				],
			}),
		}),
	);
	assertEquals(wrongKeyResp.status, 401);

	// 4. Verify cron matching in America/Denver timezone (14:00 MDT = 20:00 UTC in October)
	const oct25At1400Mdt = Date.parse('2026-10-25T20:00:15Z');
	const oct25At1300Mdt = Date.parse('2026-10-25T19:00:15Z');
	assert(matchesCron('0 14 * * *', oct25At1400Mdt, 'America/Denver'));
	assert(!matchesCron('0 14 * * *', oct25At1300Mdt, 'America/Denver'));

	// 5. Run tickWatchers at 14:00 America/Denver
	const vapid = await app.ensureVapidKeys();
	const tickRes = await tickWatchers(db, vapid, {
		nowMs: oct25At1400Mdt,
		fetchFn: app.pushFetchFn,
		watcherFetchFn: app.watcherFetchFn,
		resolveDnsFn: app.resolveDnsFn,
	});
	assertEquals(tickRes.evaluated, 1);
	assertEquals(tickRes.succeeded, 1);
	assertEquals(tickRes.notificationsSent, 1);
	assertEquals(tickRes.patchesStaged, 1);
	assertEquals(pushDeliveries, 1);

	// 6. Client syncs and receives pendingPatches, then acks them
	const syncPullResp = await app.handle(
		new Request('http://localhost/tid.dly', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				tiddlypwa: 1,
				op: 'sync',
				token,
				authcode,
				now: new Date().toISOString(),
				lastSync: new Date(0).toISOString(),
				clientChanges: [],
			}),
		}),
	);
	assertEquals(syncPullResp.status, 200);
	const syncPullData = await syncPullResp.json();
	assertEquals(syncPullData.pendingPatches.length, 1);
	assertEquals(syncPullData.pendingPatches[0].watcherId, watcherId);
	assertEquals(syncPullData.pendingPatches[0].patch.patchTarget, {
		title: 'Test Manga',
		fields: { 'latest-volume': '5' },
	});

	const ackId = syncPullData.pendingPatches[0].patchId;
	const syncAckResp = await app.handle(
		new Request('http://localhost/tid.dly', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				tiddlypwa: 1,
				op: 'sync',
				token,
				authcode,
				now: new Date().toISOString(),
				lastSync: new Date(0).toISOString(),
				clientChanges: [],
				ackPatches: [ackId],
			}),
		}),
	);
	assertEquals(syncAckResp.status, 200);
	const syncAckData = await syncAckResp.json();
	assertEquals(syncAckData.pendingPatches, undefined);

	// 7. Manual op: 'run_watcher' & op: 'list_watchers'
	const runResp = await app.handle(
		new Request('http://localhost/tid.dly', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				tiddlypwa: 1,
				op: 'run_watcher',
				token,
				authcode,
				watcherId,
			}),
		}),
	);
	assertEquals(runResp.status, 200);
	const runJson = await runResp.json();
	assertEquals(runJson.ok, true);

	const listResp = await app.handle(
		new Request('http://localhost/tid.dly', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				tiddlypwa: 1,
				op: 'list_watchers',
				token,
				authcode,
			}),
		}),
	);
	assertEquals(listResp.status, 200);
	const listJson = await listResp.json();
	assertEquals(listJson.watchers.length, 1);
	assertEquals(listJson.watchers[0].watcherId, watcherId);
	assertEquals(listJson.watchers[0].lastError, null);

	db.close(true);
});
