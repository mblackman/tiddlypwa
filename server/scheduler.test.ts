import { assertEquals } from '@std/assert';
import { encodeBase64 } from '@std/encoding/base64';
import { encodeBase64Url } from '@std/encoding/base64url';
import { SQLiteDatastore } from './sqlite.ts';
import { TiddlyPWASyncApp } from './app.ts';
import { decryptWebPushPayload, getOrCreateVapidKeys } from './webpush.ts';
import { tickScheduledNotifications } from './scheduler.ts';

async function generateMockBrowserSubscription() {
	const keyPair = await crypto.subtle.generateKey(
		{ name: 'ECDH', namedCurve: 'P-256' },
		true,
		['deriveBits'],
	);
	const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
	const authBytes = crypto.getRandomValues(new Uint8Array(16));
	return {
		keyPair,
		pubRaw,
		authBytes,
		p256dh: encodeBase64Url(pubRaw),
		auth: encodeBase64Url(authBytes),
	};
}

Deno.test('sync_schedules and tickScheduledNotifications: E2E encrypted broadcast and device-scoped delivery', async () => {
	const db = new SQLiteDatastore(':memory:');
	const sentDeliveries: Array<{ url: string; body: Uint8Array }> = [];
	const mockFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const body = init?.body instanceof Uint8Array ? init.body : new Uint8Array(init?.body as ArrayBuffer);
		sentDeliveries.push({ url, body });
		return Promise.resolve(new Response(null, { status: 201 }));
	}) as typeof fetch;

	const salt = 'dGVzdHNhbHQ=';
	const hash = 'b40b7fb8ff5be8f6bb91f2a7fecce7be0be3de583ba80d98fe9f4d708ef6d39f';
	const app = new TiddlyPWASyncApp(db, salt, hash, '', 'mailto:test@example.com');
	app.pushFetchFn = mockFetch;

	const token = 'wiki_sched_token_12345678901234567890';
	db.createWiki(token, 'Schedule Wiki');
	db.updateWikiAuthcode(token, 'valid_auth');

	const subA = await generateMockBrowserSubscription();
	const subB = await generateMockBrowserSubscription();
	const endpointA = 'https://push.example.net/send/dev-a';
	const endpointB = 'https://push.example.net/send/dev-b';

	db.upsertPushSubscription({
		token,
		endpoint: endpointA,
		p256dh: subA.p256dh,
		auth: subA.auth,
		ua_hint: 'Device A',
		created_at: 1000,
	});
	db.upsertPushSubscription({
		token,
		endpoint: endpointB,
		p256dh: subB.p256dh,
		auth: subB.auth,
		ua_hint: 'Device B',
		created_at: 1001,
	});

	// Simulate client-side this.pushKey encryption
	const pushKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
	const iv1 = crypto.getRandomValues(new Uint8Array(12));
	const plain1 = new TextEncoder().encode(JSON.stringify({
		title: 'Manga Vol. 12 Release',
		body: 'Releases today!',
		tag: 'rule-manga-12',
		data: { navigateTo: 'Manga Vol. 12' },
	}));
	const ct1 = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv1 }, pushKey, plain1));

	const iv2 = crypto.getRandomValues(new Uint8Array(12));
	const plain2 = new TextEncoder().encode(JSON.stringify({
		title: 'Pomodoro Timer Done',
		body: '25m focus session finished',
		tag: 'adhoc-pomodoro',
	}));
	const ct2 = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv2 }, pushKey, plain2));

	// Call op: 'sync_schedules' via app.handle
	const syncResp = await app.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({
				tiddlypwa: 1,
				op: 'sync_schedules',
				token,
				authcode: 'valid_auth',
				upserts: [
					{
						// Tier 2 rule notification: due at t=5000, broadcast to all devices
						scheduleId: 'sched_rule_1',
						triggerAt: 5000,
						payload: { mode: 'encrypted', iv: encodeBase64(iv1), ct: encodeBase64(ct1) },
						targetEndpoint: null,
					},
					{
						// Tier 3 ad-hoc timer: due at t=5500, scoped only to Device A
						scheduleId: 'sched_timer_devA',
						triggerAt: 5500,
						payload: { mode: 'encrypted', iv: encodeBase64(iv2), ct: encodeBase64(ct2) },
						targetEndpoint: endpointA,
					},
					{
						// Future schedule due at t=9000
						scheduleId: 'sched_future',
						triggerAt: 9000,
						payload: { mode: 'encrypted', iv: encodeBase64(iv1), ct: encodeBase64(ct1) },
						targetEndpoint: null,
					},
				],
			}),
		}),
	);
	assertEquals(syncResp.status, 200);
	const syncJson = await syncResp.json();
	assertEquals(syncJson, { ok: true, upserted: 3, removed: 0 });

	// Tick at nowMs = 6000 -> should process sched_rule_1 (2 deliveries: A + B) and sched_timer_devA (1 delivery: A)
	const vapid = await getOrCreateVapidKeys(db);
	const tickRes = await tickScheduledNotifications(db, vapid, {
		nowMs: 6000,
		subject: 'mailto:test@example.com',
		fetchFn: mockFetch,
	});
	assertEquals(tickRes, { processed: 2, sent: 3, failed: 0, pruned: 0 });
	assertEquals(sentDeliveries.length, 3);

	// Verify RFC 8291 outer decryption + client AES-GCM inner decryption on Device A's first delivery
	const devADelivery = sentDeliveries.find((d) => d.url === endpointA)!;
	const outerDecrypted = await decryptWebPushPayload(
		devADelivery.body,
		subA.keyPair.privateKey,
		subA.pubRaw,
		subA.authBytes,
	);
	const envelope = JSON.parse(outerDecrypted);
	assertEquals(envelope.mode, 'encrypted');
	const innerBytes = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: Uint8Array.from(atob(envelope.iv), (c) => c.charCodeAt(0)) },
		pushKey,
		Uint8Array.from(atob(envelope.ct), (c) => c.charCodeAt(0)),
	);
	const innerNotif = JSON.parse(new TextDecoder().decode(innerBytes));
	assertEquals(innerNotif.title, 'Manga Vol. 12 Release');
	assertEquals(innerNotif.data.navigateTo, 'Manga Vol. 12');

	// Verify only sched_future remains in DB
	const remaining = db.listScheduledNotifications(token);
	assertEquals(remaining.length, 1);
	assertEquals(remaining[0].schedule_id, 'sched_future');

	// Cancel sched_future via op: 'sync_schedules' removals
	const cancelResp = await app.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({
				tiddlypwa: 1,
				op: 'sync_schedules',
				token,
				authcode: 'valid_auth',
				removals: ['sched_future'],
			}),
		}),
	);
	assertEquals(cancelResp.status, 200);
	assertEquals(await cancelResp.json(), { ok: true, upserted: 0, removed: 1 });
	assertEquals(db.listScheduledNotifications(token).length, 0);
});

Deno.test('sync_schedules: rejects wrong authcode or malformed payloads', async () => {
	const db = new SQLiteDatastore(':memory:');
	const salt = 'dGVzdHNhbHQ=';
	const hash = 'b40b7fb8ff5be8f6bb91f2a7fecce7be0be3de583ba80d98fe9f4d708ef6d39f';
	const app = new TiddlyPWASyncApp(db, salt, hash);

	const token = 'wiki_sched_err_12345678901234567890';
	db.createWiki(token, 'Schedule Error Wiki');
	db.updateWikiAuthcode(token, 'correct_auth');

	// Wrong authcode
	const badAuth = await app.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({
				tiddlypwa: 1,
				op: 'sync_schedules',
				token,
				authcode: 'wrong_auth',
				upserts: [],
			}),
		}),
	);
	assertEquals(badAuth.status, 401);

	// Invalid payload mode
	const badMode = await app.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({
				tiddlypwa: 1,
				op: 'sync_schedules',
				token,
				authcode: 'correct_auth',
				upserts: [{
					scheduleId: 's1',
					triggerAt: 5000,
					payload: { mode: 'unknown' },
				}],
			}),
		}),
	);
	assertEquals(badMode.status, 400);
});

Deno.test('Tier 2 date parsing: date-only local time + default-time vs full timestamps + offset-minutes', () => {
	// Replicate PWAStorage.prototype.parseRuleTriggerAt logic
	function parseRuleTriggerAt(rawVal: unknown, defaultTimeStr = '09:00', offsetMinutes = 0): number | null {
		if (rawVal === undefined || rawVal === null) return null;
		const str = String(rawVal).trim();
		if (!str) return null;

		let hours = 9;
		let minutes = 0;
		const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(String(defaultTimeStr || '09:00').trim());
		if (timeMatch) {
			const h = Number(timeMatch[1]);
			const m = Number(timeMatch[2]);
			if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
				hours = h;
				minutes = m;
			}
		}

		let baseMs = NaN;
		const isoDateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
		const twDateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(str);
		if (isoDateOnly || twDateOnly) {
			const m = (isoDateOnly || twDateOnly)!;
			const year = Number(m[1]);
			const month = Number(m[2]);
			const day = Number(m[3]);
			const localDate = new Date(year, month - 1, day, hours, minutes, 0, 0);
			baseMs = localDate.getTime();
		} else if (/^\d{10,13}$/.test(str)) {
			const num = Number(str);
			baseMs = str.length === 10 ? num * 1000 : num;
		} else {
			const parsed = new Date(str);
			baseMs = parsed.getTime();
		}

		if (!Number.isFinite(baseMs) || baseMs <= 0) return null;
		const offsetMs = (Number(offsetMinutes) || 0) * 60 * 1000;
		return Math.floor(baseMs + offsetMs);
	}

	// Date-only YYYY-MM-DD at default 09:00 local time
	const expected0900 = new Date(2026, 10, 15, 9, 0, 0, 0).getTime();
	assertEquals(parseRuleTriggerAt('2026-11-15'), expected0900);
	assertEquals(parseRuleTriggerAt('20261115'), expected0900);

	// Custom default-time 14:30 and -30 minute offset (fires at 14:00 local time)
	const expected1400 = new Date(2026, 10, 15, 14, 0, 0, 0).getTime();
	assertEquals(parseRuleTriggerAt('2026-11-15', '14:30', -30), expected1400);

	// Full ISO timestamp ignores default-time and applies offset-minutes directly
	const isoMs = Date.parse('2026-11-15T18:00:00Z');
	assertEquals(parseRuleTriggerAt('2026-11-15T18:00:00Z', '09:00', 15), isoMs + 15 * 60 * 1000);
});
