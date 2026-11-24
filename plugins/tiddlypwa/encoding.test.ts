import { assertEquals, assertRejects } from '@std/assert';

const encodingSource = Deno.readTextFileSync('./plugins/tiddlypwa/encoding.js');

function loadEncoding(mockAtob = atob) {
	const _tw = { browser: true };
	const moduleFn = new Function(
		'$tw',
		'module',
		'atob',
		encodingSource.replace('(function () {', '').replace('})();', ''),
	);
	const module: { exports: Record<string, (...args: any[]) => any> } = { exports: {} };
	moduleFn(_tw, module, mockAtob);
	return module.exports;
}

Deno.test('decodeDataToBlob returns correct Blob for binary data', async () => {
	const origBlob = globalThis.Blob;
	globalThis.Blob = class Blob {
		parts: unknown[];
		options: unknown;
		constructor(parts: unknown[], options: unknown) {
			this.parts = parts;
			this.options = options;
		}
	} as unknown as typeof Blob;
	try {
		const mod = loadEncoding((s: string) => s);

		// Create a mock binary buffer
		// Flags: 1 (isBin)
		// Body length: 3
		// Body: [10, 20, 30]
		const buffer = new ArrayBuffer(5 + 3);
		const dw = new DataView(buffer);
		dw.setUint8(0, 1);
		dw.setUint32(1, 3);
		const ui8 = new Uint8Array(buffer);
		ui8.set([10, 20, 30], 5);

		const blob = await mod.decodeDataToBlob(buffer, 'image/png');
		assertEquals(blob.options.type, 'image/png');
		assertEquals(blob.parts[0].length, 3);
		assertEquals(blob.parts[0][0], 10);
	} finally {
		globalThis.Blob = origBlob;
	}
});

Deno.test('decodeDataToBlob rejects gzipped data', async () => {
	const mod = loadEncoding((s: string) => s);

	// Flags: 2 (isGzipped)
	const buffer = new ArrayBuffer(5);
	const dw = new DataView(buffer);
	dw.setUint8(0, 2);

	await assertRejects(
		() => mod.decodeDataToBlob(buffer, 'text/plain'),
		Error,
		'unsupported binary encoding',
	);
});

Deno.test('decodeDataToBytes and encodeBinaryBytes round-trip Uint8Array and sliced views', async () => {
	const mod = loadEncoding();
	const rawBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 255]);
	const encoded = await mod.encodeBinaryBytes(rawBytes, 256);
	assertEquals(encoded.byteLength % 256, 0);

	// Wrap inside a larger ArrayBuffer with non-zero byteOffset to verify ArrayBufferView support
	const outer = new Uint8Array(encoded.byteLength + 16);
	outer.set(encoded, 7);
	const slicedView = outer.subarray(7, 7 + encoded.byteLength);

	const decodedBytes = await mod.decodeDataToBytes(slicedView);
	assertEquals(decodedBytes, rawBytes);

	const blob = await mod.decodeDataToBlob(slicedView, 'image/png');
	assertEquals(blob.type, 'image/png');
	assertEquals(new Uint8Array(await blob.arrayBuffer()), rawBytes);
});
