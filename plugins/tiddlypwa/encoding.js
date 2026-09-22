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

	module.exports.b64enc = async function (data) {
		if (!data) {
			return null;
		}

		return (await new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result);
			reader.onerror = (err) => reject(err);
			reader.readAsDataURL(new Blob([data]));
		})).split(',', 2)[1];
	};

	module.exports.b64dec = function (base64) {
		return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
	};

	module.exports.encodeData = async function (str, unBase64, padTo) {
		let flags = 0, bodylen;
		if (unBase64) {
			flags |= 1;
			str = atob(str);
		}
		// If unBase64, the decode is *more compact* (and we now have the exact length)
		// otherwise UTF-8 == can be up to 3x theoretically
		const resbuflen = 5 + (unBase64 ? str.length : 3 * str.length);
		const result = new Uint8Array(resbuflen + (padTo - (resbuflen % padTo)));
		if (str.length > 512 && /* assume binary == not well compressible */ !unBase64) {
			flags |= 1 << 1;
			let ptr = 5;
			const rdr = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
			for await (const chunk of rdr) {
				result.set(chunk, ptr);
				ptr += chunk.length;
			}
			bodylen = ptr - 5;
		} else if (unBase64) {
			for (let i = 0; i < str.length; i++) result[5 + i] = str.charCodeAt(i);
			bodylen = str.length;
		} else {
			bodylen = utfenc.encodeInto(str, result.subarray(5, 5 + 3 * str.length)).written;
		}
		const dw = new DataView(result.buffer);
		dw.setUint8(0, flags);
		dw.setUint32(1, bodylen);
		const reslen = 5 + bodylen;
		return result.subarray(0, reslen + (padTo - (reslen % padTo)));
	};

	module.exports.decodeData = async function (bin) {
		const dw = new DataView(bin);
		const flags = dw.getUint8(0);
		const isBin = flags & 1;
		const isGzipped = flags & (1 << 1);
		const bodylen = dw.getUint32(1);
		const body = new Uint8Array(bin, 5, bodylen);
		if (isGzipped) {
			if (isBin) throw new Error('unsupported encoding');
			let str = '';
			const rdr = new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'));
			for await (const chunk of rdr) str += utfdec.decode(chunk, { stream: true });
			str += utfdec.decode();
			return str;
		}
		return isBin ? module.exports.b64enc(body) : utfdec.decode(body);
	};
})();
