import { assertEquals, assertRejects } from '@std/assert';
import { decodeBase64Url, encodeBase64Url } from '@std/encoding/base64url';
import { SQLiteDatastore } from './sqlite.ts';
import { TiddlyPWASyncApp } from './app.ts';
import {
	broadcastWikiPush,
	createVapidAuthHeader,
	decryptWebPushPayload,
	encryptWebPushPayload,
	generateVapidKeys,
	getOrCreateVapidKeys,
} from './webpush.ts';

const utfenc = new TextEncoder();

async function createMockBrowserSubscription(endpoint = 'https://fcm.googleapis.com/fcm/send/sub-123') {
	const uaKeyPair = await crypto.subtle.generateKey(
		{ name: 'ECDH', namedCurve: 'P-256' },
		true,
		['deriveBits'],
	);
	const uaPubBytes = new Uint8Array(await crypto.subtle.exportKey('raw', uaKeyPair.publicKey));
	const authBytes = crypto.getRandomValues(new Uint8Array(16));
	return {
		endpoint,
		keys: {
			p256dh: encodeBase64Url(uaPubBytes),
			auth: encodeBase64Url(authBytes),
		},
		uaPrivateKey: uaKeyPair.privateKey,
		uaPubBytes,
		authBytes,
	};
}

Deno.test('WebPush: getOrCreateVapidKeys persists and reloads VAPID keypair in SQLite', async () => {
	const db = new SQLiteDatastore();
	const keys1 = await getOrCreateVapidKeys(db);
	assertEquals(decodeBase64Url(keys1.publicKeyB64Url).byteLength, 65);
	assertEquals(decodeBase64Url(keys1.publicKeyB64Url)[0], 0x04);

	const keys2 = await getOrCreateVapidKeys(db);
	assertEquals(keys2.publicKeyB64Url, keys1.publicKeyB64Url);
});

Deno.test('WebPush: createVapidAuthHeader produces valid ES256 JWT verifiable with public key', async () => {
	const vapid = await generateVapidKeys();
	const { authorization, jwt } = await createVapidAuthHeader(
		'https://fcm.googleapis.com/fcm/send/abc',
		vapid,
		'mailto:admin@example.com',
	);
	assertEquals(authorization.startsWith('vapid t='), true);
	assertEquals(authorization.includes(`, k=${vapid.publicKeyB64Url}`), true);

	const parts = jwt.split('.');
	assertEquals(parts.length, 3);
	const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
	const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
	assertEquals(header, { typ: 'JWT', alg: 'ES256' });
	assertEquals(payload.aud, 'https://fcm.googleapis.com');
	assertEquals(payload.sub, 'mailto:admin@example.com');

	const sigValid = await crypto.subtle.verify(
		{ name: 'ECDSA', hash: 'SHA-256' },
		vapid.publicKey,
		decodeBase64Url(parts[2]) as unknown as BufferSource,
		utfenc.encode(`${parts[0]}.${parts[1]}`),
	);
	assertEquals(sigValid, true);
});

Deno.test('WebPush: RFC 8291 aes128gcm payload encryption round-trips cleanly', async () => {
	const sub = await createMockBrowserSubscription();
	const message = JSON.stringify({
		mode: 'encrypted',
		iv: 'dGVzdGl2MTIzNDU2',
		ct: 'c2VjcmV0Y2lwaGVydGV4dA==',
	});

	const encryptedPacket = await encryptWebPushPayload(message, sub.keys.p256dh, sub.keys.auth);
	const decrypted = await decryptWebPushPayload(
		encryptedPacket,
		sub.uaPrivateKey,
		sub.uaPubBytes,
		sub.authBytes,
	);
	assertEquals(decrypted, message);

	// Rejects invalid key lengths
	await assertRejects(
		() => encryptWebPushPayload('hello', encodeBase64Url(new Uint8Array(32)), sub.keys.auth),
		Error,
		'Invalid p256dh public key',
	);
});

Deno.test('WebPush: broadcastWikiPush delivers notifications and prunes 410 Gone endpoints', async () => {
	const db = new SQLiteDatastore();
	db.createWiki('wikitok1');
	const vapid = await getOrCreateVapidKeys(db);

	const subActive = await createMockBrowserSubscription('https://push.example.com/active');
	const subGone = await createMockBrowserSubscription('https://push.example.com/gone');

	db.upsertPushSubscription({
		token: 'wikitok1',
		endpoint: subActive.endpoint,
		p256dh: subActive.keys.p256dh,
		auth: subActive.keys.auth,
		created_at: 1000,
	});
	db.upsertPushSubscription({
		token: 'wikitok1',
		endpoint: subGone.endpoint,
		p256dh: subGone.keys.p256dh,
		auth: subGone.keys.auth,
		created_at: 2000,
	});

	const receivedBodies: Map<string, Uint8Array> = new Map();
	const mockFetch: typeof fetch = async (input, init) => {
		const url = String(input);
		if (url.endsWith('/gone')) {
			return new Response(null, { status: 410 });
		}
		receivedBodies.set(url, new Uint8Array(await new Response(init?.body).arrayBuffer()));
		return new Response(null, { status: 201 });
	};

	const stats = await broadcastWikiPush(
		db,
		'wikitok1',
		{ mode: 'plain', notification: { title: 'Hello Push', body: 'World' } },
		vapid,
		{ fetchFn: mockFetch },
	);

	assertEquals(stats, { sent: 1, failed: 1, pruned: 1 });

	// Verify 410 subscription was automatically removed from SQLite
	const remaining = db.listPushSubscriptions('wikitok1');
	assertEquals(remaining.length, 1);
	assertEquals(remaining[0].endpoint, subActive.endpoint);

	// Verify the active subscription received a valid RFC 8291 packet
	const packet = receivedBodies.get(subActive.endpoint)!;
	const decrypted = JSON.parse(
		await decryptWebPushPayload(packet, subActive.uaPrivateKey, subActive.uaPubBytes, subActive.authBytes),
	);
	assertEquals(decrypted.notification.title, 'Hello Push');
});

Deno.test('App RPC: push_info, push_subscribe, push_test, push_unsubscribe, and sync pendingPatches', async () => {
	const db = new SQLiteDatastore();
	const app = new TiddlyPWASyncApp(
		db,
		'q6kQ8SNKeaVVQDbhb7TgyqdTp8KAO31rU-6AGT1xG0o',
		'ZnPOVo2E_oWm71aQ-eOX9U3-gIE2hR6nfksboNcLNPQ',
	);
	let deliveredCount = 0;
	app.pushFetchFn = () => {
		deliveredCount++;
		return Promise.resolve(new Response(null, { status: 201 }));
	};

	const api = (data: Record<string, unknown>) =>
		app.handle(
			new Request('http://example.com/tid.dly', {
				method: 'POST',
				body: JSON.stringify({ tiddlypwa: 1, ...data }),
			}),
		).then((r) => r.json());

	const { token } = await api({ op: 'create', atoken: 'test' });
	const authcode = 'my-authcode';

	// 1. Subscribe device to push
	const sub = await createMockBrowserSubscription('https://fcm.googleapis.com/fcm/send/dev1');
	const subRes = await api({
		op: 'push_subscribe',
		token,
		authcode,
		subscription: { endpoint: sub.endpoint, keys: sub.keys },
		uaHint: 'DenoTest/1.0',
	});
	assertEquals(subRes.ok, true);
	assertEquals(typeof subRes.vapidPublicKey, 'string');

	// 2. Query push_info
	const infoRes = await api({
		op: 'push_info',
		token,
		authcode,
		endpoint: sub.endpoint,
	});
	assertEquals(infoRes.subscriptionCount, 1);
	assertEquals(infoRes.subscribed, true);

	// Wrong authcode is rejected with EAUTH
	const badAuthRes = await api({
		op: 'push_info',
		token,
		authcode: 'wrong-authcode',
	});
	assertEquals(badAuthRes, { error: 'EAUTH' });

	// 3. Trigger push_test
	const testRes = await api({
		op: 'push_test',
		token,
		authcode,
		endpoint: sub.endpoint,
		payload: { mode: 'encrypted', iv: 'aXY=', ct: 'Y3Q=' },
	});
	assertEquals(testRes, { ok: true, sent: 1, failed: 0, pruned: 0 });
	assertEquals(deliveredCount, 1);

	// 4. Stage a pending watcher patch and verify op: 'sync' delivers and acknowledges it
	db.upsertPendingPatch({
		patch_id: 'patch-001',
		token,
		watcher_id: 'test.watcher',
		patch_json: JSON.stringify({
			patchTarget: { title: 'Tracked Series', fields: { 'latest-volume': '5' } },
		}),
		created_at: 123456,
	});

	const sync1 = await api({
		op: 'sync',
		token,
		authcode,
		now: new Date().toISOString(),
		lastSync: new Date(0).toISOString(),
		clientChanges: [],
	});
	assertEquals(sync1.pendingPatches.length, 1);
	assertEquals(sync1.pendingPatches[0].patchId, 'patch-001');
	assertEquals(sync1.pendingPatches[0].patch.patchTarget.title, 'Tracked Series');

	// Acknowledge patch-001 on next sync
	const sync2 = await api({
		op: 'sync',
		token,
		authcode,
		now: new Date().toISOString(),
		lastSync: new Date(0).toISOString(),
		clientChanges: [],
		ackPatches: ['patch-001'],
	});
	assertEquals(sync2.pendingPatches, undefined);
	assertEquals(db.listPendingPatches(token).length, 0);

	// 5. Unsubscribe device
	const unsubRes = await api({
		op: 'push_unsubscribe',
		token,
		authcode,
		endpoint: sub.endpoint,
	});
	assertEquals(unsubRes, { ok: true });
	assertEquals(db.listPushSubscriptions(token).length, 0);
});

Deno.test('Crypto: deterministic Ed25519 PKCS#8 derivation from HKDF seed signs and verifies', async () => {
	const basebits = crypto.getRandomValues(new Uint8Array(32));
	const basekey = await crypto.subtle.importKey('raw', basebits, 'HKDF', false, ['deriveBits']);
	const edSeed = new Uint8Array(
		await crypto.subtle.deriveBits(
			{
				name: 'HKDF',
				hash: 'SHA-256',
				salt: utfenc.encode('tiddly.pwa.watchers.ed25519'),
				info: new Uint8Array(),
			},
			basekey,
			256,
		),
	);
	const pkcs8Prefix = new Uint8Array([
		0x30,
		0x2e,
		0x02,
		0x01,
		0x00,
		0x30,
		0x05,
		0x06,
		0x03,
		0x2b,
		0x65,
		0x70,
		0x04,
		0x22,
		0x04,
		0x20,
	]);
	const pkcs8 = new Uint8Array(48);
	pkcs8.set(pkcs8Prefix, 0);
	pkcs8.set(edSeed, 16);

	const privKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
	const jwk = await crypto.subtle.exportKey('jwk', privKey);
	const pubKeyBytes = decodeBase64Url(jwk.x!);
	assertEquals(pubKeyBytes.byteLength, 32);

	const pubKey = await crypto.subtle.importKey(
		'raw',
		pubKeyBytes as unknown as BufferSource,
		{ name: 'Ed25519' },
		false,
		['verify'],
	);

	const payload = utfenc.encode('watcherId:codeHash:allowedHosts');
	const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privKey, payload);
	const verified = await crypto.subtle.verify({ name: 'Ed25519' }, pubKey, sig, payload);
	assertEquals(verified, true);
});
