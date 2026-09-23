import { assertEquals, assertMatch } from '@std/assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Global mock for $tw if not already present
if (typeof (globalThis as any).$tw === 'undefined') {
	(globalThis as any).$tw = { browser: true };
}

const { generateQRCodeSvg, QRCode } = require('../plugins/tiddlypwa/qrcode.js');

Deno.test('QR Code: generates valid SVG for basic URL', () => {
	const url = 'https://example.com/app.html';
	const svg = generateQRCodeSvg(url);
	assertMatch(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
	assertMatch(svg, /<rect width="/);
	assertMatch(svg, /<path d="M/);
	assertMatch(svg, /<\/svg>$/);
});

Deno.test('QR Code: generates valid SVG for full pairing URL with token and salt', () => {
	const longToken = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
	const longSalt = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ==';
	const pairUrl = `https://myserver.example.com/a1b2c3d4e5f6g7h8i9j0k/app.html#token=${longToken}&salt=${longSalt}`;

	const svg = generateQRCodeSvg(pairUrl, { margin: 4, ecLevel: 'M' });
	assertMatch(svg, /viewBox="0 0 \d+ \d+"/);
	assertMatch(svg, /fill="#000000"/);

	// Verify that the module count matches QR code version requirements
	const qr = new QRCode(0, 0); // Level M
	qr.addData(pairUrl);
	qr.make();
	const count = qr.getModuleCount();
	assertEquals(count > 21, true); // Must be higher version than version 1 (21x21)
});

Deno.test('QR Code: handles instant-unlock key in fragment', () => {
	const longToken = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
	const longSalt = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ==';
	const basebitsB64 = 'YmFzZWJpdHMzMmJ5dGVzYWxwaGFudW1lcmljZGF0YTEyMzQ1Njc=';
	const pairUrl =
		`https://myserver.example.com/a1b2c3d4e5f6g7h8i9j0k/app.html#token=${longToken}&salt=${longSalt}&key=${basebitsB64}`;

	const svg = generateQRCodeSvg(pairUrl, { margin: 2, ecLevel: 'L' });
	assertMatch(svg, /<svg/);
	assertMatch(svg, /<\/svg>/);
});
