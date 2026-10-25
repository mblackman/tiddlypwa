import { decodeBase64Url, encodeBase64Url } from '@std/encoding/base64url';
import { Datastore, PushSubscriptionRow } from './data.d.ts';

const utfenc = new TextEncoder();
const utfdec = new TextDecoder();

export type VapidKeys = {
	publicKeyB64Url: string;
	privateKey: CryptoKey;
	publicKey: CryptoKey;
	jwk: JsonWebKey;
};

/**
 * Decodes either standard Base64 or URL-safe Base64 (with or without padding).
 */
export function decodeBase64Flexible(input: string): Uint8Array {
	const cleaned = input.trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	return decodeBase64Url(cleaned);
}

/**
 * Generates a fresh P-256 ECDSA VAPID keypair.
 */
export async function generateVapidKeys(): Promise<VapidKeys> {
	const keyPair = await crypto.subtle.generateKey(
		{ name: 'ECDSA', namedCurve: 'P-256' },
		true,
		['sign', 'verify'],
	);
	const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
	const jwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
	return {
		publicKeyB64Url: encodeBase64Url(rawPub),
		privateKey: keyPair.privateKey,
		publicKey: keyPair.publicKey,
		jwk,
	};
}

/**
 * Imports a previously generated VAPID keypair from JWK and Base64URL public key.
 */
export async function importVapidKeys(jwk: JsonWebKey, publicKeyB64Url: string): Promise<VapidKeys> {
	const privateKey = await crypto.subtle.importKey(
		'jwk',
		jwk,
		{ name: 'ECDSA', namedCurve: 'P-256' },
		false,
		['sign'],
	);
	const rawPub = decodeBase64Flexible(publicKeyB64Url);
	const publicKey = await crypto.subtle.importKey(
		'raw',
		rawPub as unknown as BufferSource,
		{ name: 'ECDSA', namedCurve: 'P-256' },
		true,
		['verify'],
	);
	return {
		publicKeyB64Url: encodeBase64Url(rawPub),
		privateKey,
		publicKey,
		jwk,
	};
}

/**
 * Loads existing VAPID keys from the SQLite server_config table, or generates and persists new ones.
 */
export async function getOrCreateVapidKeys(db: Datastore): Promise<VapidKeys> {
	const existingJwkStr = db.getServerConfig('vapid_jwk');
	const existingPubStr = db.getServerConfig('vapid_public_key');
	if (existingJwkStr && existingPubStr) {
		try {
			const jwk = JSON.parse(existingJwkStr) as JsonWebKey;
			return await importVapidKeys(jwk, existingPubStr);
		} catch (e) {
			console.warn('Failed to load stored VAPID keys, regenerating:', e);
		}
	}
	const keys = await generateVapidKeys();
	db.transaction(() => {
		db.setServerConfig('vapid_jwk', JSON.stringify(keys.jwk));
		db.setServerConfig('vapid_public_key', keys.publicKeyB64Url);
	});
	return keys;
}

/**
 * Creates an RFC 8292 VAPID Authorization header (`vapid t=<jwt>, k=<pubKey>`).
 */
export async function createVapidAuthHeader(
	endpointUrl: string,
	vapidKeys: VapidKeys,
	subject = 'mailto:noreply@example.com',
	expSeconds?: number,
): Promise<{ authorization: string; jwt: string }> {
	const parsed = new URL(endpointUrl);
	const audience = `${parsed.protocol}//${parsed.host}`;
	const exp = expSeconds ?? (Math.floor(Date.now() / 1000) + 12 * 3600);

	const headerB64 = encodeBase64Url(utfenc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
	const payloadB64 = encodeBase64Url(utfenc.encode(JSON.stringify({ aud: audience, exp, sub: subject })));
	const signingInput = `${headerB64}.${payloadB64}`;

	const sigBytes = new Uint8Array(
		await crypto.subtle.sign(
			{ name: 'ECDSA', hash: 'SHA-256' },
			vapidKeys.privateKey,
			utfenc.encode(signingInput),
		),
	);
	const jwt = `${signingInput}.${encodeBase64Url(sigBytes)}`;
	return {
		authorization: `vapid t=${jwt}, k=${vapidKeys.publicKeyB64Url}`,
		jwt,
	};
}

/**
 * Encrypts a UTF-8 or binary payload according to RFC 8291 (Web Push Message Encryption)
 * using the `aes128gcm` content encoding (RFC 8188).
 */
export async function encryptWebPushPayload(
	plaintext: Uint8Array | string,
	clientP256dhB64: string,
	clientAuthB64: string,
): Promise<Uint8Array> {
	const plainBytes = typeof plaintext === 'string' ? utfenc.encode(plaintext) : plaintext;
	const uaPublic = decodeBase64Flexible(clientP256dhB64);
	const authSecret = decodeBase64Flexible(clientAuthB64);

	if (uaPublic.byteLength !== 65 || uaPublic[0] !== 0x04) {
		throw new Error('Invalid p256dh public key: expected 65-byte uncompressed P-256 point');
	}
	if (authSecret.byteLength !== 16) {
		throw new Error('Invalid auth secret: expected 16 bytes');
	}

	// 1. Import subscriber's P-256 public key for ECDH
	const uaPublicKey = await crypto.subtle.importKey(
		'raw',
		uaPublic as unknown as BufferSource,
		{ name: 'ECDH', namedCurve: 'P-256' },
		false,
		[],
	);

	// 2. Generate ephemeral server ECDH P-256 keypair
	const asKeyPair = await crypto.subtle.generateKey(
		{ name: 'ECDH', namedCurve: 'P-256' },
		true,
		['deriveBits'],
	);
	const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeyPair.publicKey));

	// 3. Compute 32-byte ECDH shared secret
	const ecdhSecret = await crypto.subtle.deriveBits(
		{ name: 'ECDH', public: uaPublicKey },
		asKeyPair.privateKey,
		256,
	);

	// 4. Derive 32-byte IKM via HKDF-SHA-256 with salt = authSecret and info = "WebPush: info\0" || ua_public || as_public
	const infoPrefix = utfenc.encode('WebPush: info\0');
	const keyInfo = new Uint8Array(infoPrefix.byteLength + uaPublic.byteLength + asPublic.byteLength);
	keyInfo.set(infoPrefix, 0);
	keyInfo.set(uaPublic, infoPrefix.byteLength);
	keyInfo.set(asPublic, infoPrefix.byteLength + uaPublic.byteLength);

	const ecdhHkdfKey = await crypto.subtle.importKey('raw', ecdhSecret, 'HKDF', false, ['deriveBits']);
	const ikm = await crypto.subtle.deriveBits(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: authSecret as unknown as BufferSource,
			info: keyInfo,
		},
		ecdhHkdfKey,
		256,
	);

	// 5. Generate 16-byte random salt and derive CEK (16 bytes) and Nonce (12 bytes)
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const ikmKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey', 'deriveBits']);

	const cekInfo = utfenc.encode('Content-Encoding: aes128gcm\0');
	const cek = await crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt, info: cekInfo },
		ikmKey,
		{ name: 'AES-GCM', length: 128 },
		false,
		['encrypt'],
	);

	const nonceInfo = utfenc.encode('Content-Encoding: nonce\0');
	const nonce = new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: 'HKDF', hash: 'SHA-256', salt, info: nonceInfo },
			ikmKey,
			96,
		),
	);

	// 6. Append RFC 8188 final record delimiter (0x02) and encrypt with AES-128-GCM
	const paddedPlaintext = new Uint8Array(plainBytes.byteLength + 1);
	paddedPlaintext.set(plainBytes, 0);
	paddedPlaintext[plainBytes.byteLength] = 0x02;

	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: nonce, tagLength: 128 },
			cek,
			paddedPlaintext,
		),
	);

	// 7. Prepend 86-byte aes128gcm header: salt(16) || rs(4, 4096) || idlen(1, 65) || keyid(65)
	const header = new Uint8Array(86);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, 4096, false);
	header[20] = 65;
	header.set(asPublic, 21);

	const packet = new Uint8Array(header.byteLength + ciphertext.byteLength);
	packet.set(header, 0);
	packet.set(ciphertext, header.byteLength);
	return packet;
}

/**
 * Decrypts an RFC 8291 `aes128gcm` Web Push payload (used in unit tests to verify end-to-end compliance).
 */
export async function decryptWebPushPayload(
	packet: Uint8Array,
	uaPrivateKey: CryptoKey,
	uaPublicBytes: Uint8Array,
	authSecretBytes: Uint8Array,
): Promise<string> {
	if (packet.byteLength < 86 + 17) {
		throw new Error('Packet too short to be a valid aes128gcm payload');
	}
	const salt = packet.slice(0, 16);
	const idlen = packet[20];
	if (idlen !== 65) {
		throw new Error(`Unexpected keyid length: ${idlen}`);
	}
	const asPublic = packet.slice(21, 86);
	const ciphertext = packet.slice(86);

	const asPublicKey = await crypto.subtle.importKey(
		'raw',
		asPublic,
		{ name: 'ECDH', namedCurve: 'P-256' },
		false,
		[],
	);

	const ecdhSecret = await crypto.subtle.deriveBits(
		{ name: 'ECDH', public: asPublicKey },
		uaPrivateKey,
		256,
	);

	const infoPrefix = utfenc.encode('WebPush: info\0');
	const keyInfo = new Uint8Array(infoPrefix.byteLength + uaPublicBytes.byteLength + asPublic.byteLength);
	keyInfo.set(infoPrefix, 0);
	keyInfo.set(uaPublicBytes, infoPrefix.byteLength);
	keyInfo.set(asPublic, infoPrefix.byteLength + uaPublicBytes.byteLength);

	const ecdhHkdfKey = await crypto.subtle.importKey('raw', ecdhSecret, 'HKDF', false, ['deriveBits']);
	const ikm = await crypto.subtle.deriveBits(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: authSecretBytes as unknown as BufferSource,
			info: keyInfo,
		},
		ecdhHkdfKey,
		256,
	);

	const ikmKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey', 'deriveBits']);
	const cek = await crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt, info: utfenc.encode('Content-Encoding: aes128gcm\0') },
		ikmKey,
		{ name: 'AES-GCM', length: 128 },
		false,
		['decrypt'],
	);
	const nonce = new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: 'HKDF', hash: 'SHA-256', salt, info: utfenc.encode('Content-Encoding: nonce\0') },
			ikmKey,
			96,
		),
	);

	const decryptedPadded = new Uint8Array(
		await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: nonce, tagLength: 128 },
			cek,
			ciphertext,
		),
	);

	// Strip trailing 0x00 padding bytes and verify 0x02 delimiter
	let end = decryptedPadded.byteLength - 1;
	while (end >= 0 && decryptedPadded[end] === 0x00) {
		end--;
	}
	if (end < 0 || decryptedPadded[end] !== 0x02) {
		throw new Error('Missing 0x02 record delimiter in decrypted payload');
	}
	return utfdec.decode(decryptedPadded.slice(0, end));
}

export type PushDeliveryResult = {
	endpoint: string;
	ok: boolean;
	status: number;
	expired: boolean;
};

/**
 * Sends an encrypted Web Push message to a single subscription endpoint.
 */
export async function sendWebPushNotification(
	sub: Pick<PushSubscriptionRow, 'endpoint' | 'p256dh' | 'auth'>,
	payload: Record<string, unknown> | string,
	vapidKeys: VapidKeys,
	options: {
		subject?: string;
		ttlSeconds?: number;
		urgency?: 'very-low' | 'low' | 'normal' | 'high';
		fetchFn?: typeof fetch;
	} = {},
): Promise<PushDeliveryResult> {
	const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
	const body = await encryptWebPushPayload(payloadStr, sub.p256dh, sub.auth);
	const { authorization } = await createVapidAuthHeader(
		sub.endpoint,
		vapidKeys,
		options.subject ?? 'mailto:noreply@example.com',
	);

	const fetchImpl = options.fetchFn ?? fetch;
	const resp = await fetchImpl(sub.endpoint, {
		method: 'POST',
		headers: {
			'Authorization': authorization,
			'Content-Encoding': 'aes128gcm',
			'Content-Type': 'application/octet-stream',
			'Content-Length': body.byteLength.toString(),
			'TTL': String(options.ttlSeconds ?? 86400),
			'Urgency': options.urgency ?? 'normal',
		},
		body: body as unknown as BodyInit,
	});

	if (!resp.ok) {
		const errText = await resp.text().catch(() => '');
		console.warn(`Web Push delivery failed (${resp.status}) for ${sub.endpoint}: ${errText}`);
	}

	const expired = resp.status === 404 || resp.status === 410;
	return {
		endpoint: sub.endpoint,
		ok: resp.ok,
		status: resp.status,
		expired,
	};
}

/**
 * Sends a Web Push payload to all subscriptions for a wiki (or a specific target endpoint),
 * automatically pruning expired (404/410) subscriptions from SQLite.
 */
export async function broadcastWikiPush(
	db: Datastore,
	token: string,
	payload: Record<string, unknown> | string,
	vapidKeys: VapidKeys,
	options: {
		targetEndpoint?: string | null;
		subject?: string;
		ttlSeconds?: number;
		urgency?: 'very-low' | 'low' | 'normal' | 'high';
		fetchFn?: typeof fetch;
	} = {},
): Promise<{ sent: number; failed: number; pruned: number }> {
	const allSubs = db.listPushSubscriptions(token);
	const subs = options.targetEndpoint ? allSubs.filter((s) => s.endpoint === options.targetEndpoint) : allSubs;

	let sent = 0;
	let failed = 0;
	let pruned = 0;

	await Promise.all(
		subs.map(async (sub) => {
			try {
				const res = await sendWebPushNotification(sub, payload, vapidKeys, options);
				if (res.ok) {
					sent++;
				} else {
					failed++;
					if (res.expired) {
						db.deletePushSubscription(token, sub.endpoint);
						pruned++;
					}
				}
			} catch (_e) {
				failed++;
			}
		}),
	);

	return { sent, failed, pruned };
}
