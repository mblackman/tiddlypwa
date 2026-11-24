/*\
title: $:/plugins/mblackman/tiddlypwa/encoding.js
type: application/javascript
module-type: library

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/
/// <reference types="npm:tw5-typed" />
(function () {
	'use strict';

	if (!$tw.browser) return;

	const utfenc = new TextEncoder('utf-8');
	const utfdec = new TextDecoder('utf-8');
	const MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024;

	function toUint8(data) {
		if (data instanceof Uint8Array) return data;
		if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		if (data instanceof ArrayBuffer) return new Uint8Array(data);
		return null;
	}

	module.exports.b64encSync = function (data) {
		if (!data) {
			return null;
		}
		const bytes = toUint8(data);
		if (!bytes) {
			throw new TypeError('Expected ArrayBuffer or ArrayBufferView');
		}
		if (typeof bytes.toBase64 === 'function') {
			return bytes.toBase64();
		}
		const CHUNK = 0x8000;
		let bin = '';
		for (let i = 0; i < bytes.length; i += CHUNK) {
			bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
		}
		return btoa(bin);
	};

	module.exports.b64enc = async function (data) {
		return module.exports.b64encSync(data);
	};

	module.exports.b64urlEnc = async function (data) {
		const b64 = await module.exports.b64enc(data);
		if (!b64) return null;
		return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	};

	module.exports.b64dec = function (base64) {
		const norm = String(base64).replace(/-/g, '+').replace(/_/g, '/');
		const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4);
		if (typeof Uint8Array.fromBase64 === 'function') {
			return Uint8Array.fromBase64(padded);
		}
		return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
	};

	module.exports.encodeBinaryBytes = async function (bytes, padTo = 256) {
		const u8 = toUint8(bytes);
		if (!u8) {
			throw new TypeError('Expected binary ArrayBuffer or ArrayBufferView');
		}
		const reslen = 5 + u8.byteLength;
		const rem = reslen % padTo;
		const totalLen = rem === 0 ? reslen : reslen + (padTo - rem);
		const result = new Uint8Array(totalLen);
		const dw = new DataView(result.buffer);
		dw.setUint8(0, 1); // flags: isBin = 1
		dw.setUint32(1, u8.byteLength);
		result.set(u8, 5);
		return result;
	};

	module.exports.encodeData = async function (str, unBase64, padTo = 256) {
		if (unBase64 && (str instanceof Uint8Array || ArrayBuffer.isView(str) || str instanceof ArrayBuffer)) {
			return module.exports.encodeBinaryBytes(str, padTo);
		}
		let flags = 0;
		let bodylen = 0;
		let chunks = null;
		let rawBytes = null;
		if (unBase64) {
			flags |= 1;
			str = atob(str);
			bodylen = str.length;
		} else if (str.length > 512) {
			flags |= 1 << 1;
			chunks = [];
			const rdr = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
			for await (const chunk of rdr) {
				chunks.push(chunk);
				bodylen += chunk.length;
			}
		} else {
			rawBytes = utfenc.encode(str);
			bodylen = rawBytes.length;
		}
		const reslen = 5 + bodylen;
		const rem = reslen % padTo;
		const totalLen = rem === 0 ? reslen : reslen + (padTo - rem);
		const result = new Uint8Array(totalLen);
		if (chunks) {
			let ptr = 5;
			for (const chunk of chunks) {
				result.set(chunk, ptr);
				ptr += chunk.length;
			}
		} else if (unBase64) {
			for (let i = 0; i < str.length; i++) result[5 + i] = str.charCodeAt(i);
		} else if (rawBytes) {
			result.set(rawBytes, 5);
		}
		const dw = new DataView(result.buffer);
		dw.setUint8(0, flags);
		dw.setUint32(1, bodylen);
		return result;
	};

	module.exports.decodeData = async function (bin) {
		const buf = ArrayBuffer.isView(bin) ? bin.buffer : bin;
		const byteOffset = ArrayBuffer.isView(bin) ? bin.byteOffset : 0;
		const byteLength = ArrayBuffer.isView(bin) ? bin.byteLength : bin.byteLength;
		const dw = new DataView(buf, byteOffset, byteLength);
		const flags = dw.getUint8(0);
		const isBin = flags & 1;
		const isGzipped = flags & (1 << 1);
		const bodylen = dw.getUint32(1);
		if (5 + bodylen > byteLength) {
			throw new Error('corrupt encoded payload');
		}
		const body = new Uint8Array(buf, byteOffset + 5, bodylen);
		if (isGzipped) {
			if (isBin) throw new Error('unsupported encoding');
			let str = '';
			let totalBytes = 0;
			const rdr = new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'));
			for await (const chunk of rdr) {
				totalBytes += chunk.byteLength;
				if (totalBytes > MAX_DECOMPRESSED_BYTES) {
					throw new Error('Compressed payload exceeds 128 MiB limit');
				}
				str += utfdec.decode(chunk, { stream: true });
			}
			str += utfdec.decode();
			return str;
		}
		return isBin ? module.exports.b64enc(body) : utfdec.decode(body);
	};

	module.exports.decodeDataToBytes = async function (bin) {
		const buf = ArrayBuffer.isView(bin) ? bin.buffer : bin;
		const byteOffset = ArrayBuffer.isView(bin) ? bin.byteOffset : 0;
		const byteLength = ArrayBuffer.isView(bin) ? bin.byteLength : bin.byteLength;
		const dw = new DataView(buf, byteOffset, byteLength);
		const flags = dw.getUint8(0);
		const isGzipped = flags & (1 << 1);
		if (isGzipped) {
			throw new Error('unsupported binary encoding');
		}
		const bodylen = dw.getUint32(1);
		if (5 + bodylen > byteLength) {
			throw new Error('corrupt binary encoding');
		}
		return new Uint8Array(buf, byteOffset + 5, bodylen).slice();
	};

	module.exports.decodeDataToBlob = async function (bin, mimeType) {
		const body = await module.exports.decodeDataToBytes(bin);
		return new Blob([body], { type: mimeType });
	};
})();
