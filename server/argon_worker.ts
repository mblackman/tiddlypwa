import * as argon from 'argon2ian';

self.onmessage = (e: MessageEvent<{ pw: Uint8Array; salt: Uint8Array; hash: Uint8Array }>) => {
	try {
		const ok = argon.verify(e.data.pw, e.data.salt, e.data.hash);
		self.postMessage({ ok });
	} catch (_err) {
		self.postMessage({ ok: false });
	}
};

self.postMessage({ ready: true });
