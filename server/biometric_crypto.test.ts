import { assertEquals, assertRejects } from '@std/assert';

const utfenc = new TextEncoder();

/**
 * Derives a 256-bit AES-GCM key encrypting key (KEK) from a WebAuthn PRF output secret.
 */
async function derivePrfWrappingKey(prfSecret: Uint8Array, prfSalt: Uint8Array): Promise<CryptoKey> {
	const prfBaseKey = await crypto.subtle.importKey('raw', prfSecret as unknown as BufferSource, 'HKDF', false, [
		'deriveKey',
	]);
	return await crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: prfSalt as unknown as BufferSource,
			info: utfenc.encode('tiddlypwa.biometric.kek') as unknown as BufferSource,
		},
		prfBaseKey,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	);
}

/**
 * Encrypts 32-byte basebits using the PRF wrapping key.
 */
async function wrapBasebits(
	wrappingKey: CryptoKey,
	basebits: Uint8Array,
): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertextBuffer = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv: iv as unknown as BufferSource },
		wrappingKey,
		basebits as unknown as BufferSource,
	);
	return { iv, ciphertext: new Uint8Array(ciphertextBuffer) };
}

/**
 * Decrypts wrapped ciphertext using the PRF wrapping key back to 32-byte basebits.
 */
async function unwrapBasebits(
	wrappingKey: CryptoKey,
	iv: Uint8Array,
	ciphertext: Uint8Array,
): Promise<Uint8Array> {
	const decryptedBuffer = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: iv as unknown as BufferSource },
		wrappingKey,
		ciphertext as unknown as BufferSource,
	);
	return new Uint8Array(decryptedBuffer);
}

Deno.test('Biometric Crypto: wrapping and unwrapping basebits with synthetic PRF secret', async () => {
	// Simulated 32-byte master key material (Argon2id output)
	const originalBasebits = crypto.getRandomValues(new Uint8Array(32));

	// Simulated PRF output from platform authenticator (TouchID / FaceID)
	const simulatedPrfSecret = crypto.getRandomValues(new Uint8Array(32));
	const prfSalt = crypto.getRandomValues(new Uint8Array(32));

	const wrappingKey = await derivePrfWrappingKey(simulatedPrfSecret, prfSalt);
	const { iv, ciphertext } = await wrapBasebits(wrappingKey, originalBasebits);

	// Unwrap on simulated subsequent unlock
	const unwrappedBasebits = await unwrapBasebits(wrappingKey, iv, ciphertext);
	assertEquals(unwrappedBasebits, originalBasebits);
});

Deno.test('Biometric Crypto: tampering with wrapped ciphertext throws authenticated error', async () => {
	const originalBasebits = crypto.getRandomValues(new Uint8Array(32));
	const simulatedPrfSecret = crypto.getRandomValues(new Uint8Array(32));
	const prfSalt = crypto.getRandomValues(new Uint8Array(32));

	const wrappingKey = await derivePrfWrappingKey(simulatedPrfSecret, prfSalt);
	const { iv, ciphertext } = await wrapBasebits(wrappingKey, originalBasebits);

	// Tamper with ciphertext byte
	ciphertext[0] ^= 0xff;

	await assertRejects(
		async () => {
			await unwrapBasebits(wrappingKey, iv, ciphertext);
		},
		DOMException,
	);
});

Deno.test('Biometric Crypto: wrong PRF secret fails authenticated decryption', async () => {
	const originalBasebits = crypto.getRandomValues(new Uint8Array(32));
	const prfSecretA = crypto.getRandomValues(new Uint8Array(32));
	const prfSecretB = crypto.getRandomValues(new Uint8Array(32));
	const prfSalt = crypto.getRandomValues(new Uint8Array(32));

	const keyA = await derivePrfWrappingKey(prfSecretA, prfSalt);
	const keyB = await derivePrfWrappingKey(prfSecretB, prfSalt);

	const { iv, ciphertext } = await wrapBasebits(keyA, originalBasebits);

	await assertRejects(
		async () => {
			await unwrapBasebits(keyB, iv, ciphertext);
		},
		DOMException,
	);
});
