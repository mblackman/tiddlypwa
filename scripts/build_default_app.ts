import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { encodeBase64Url } from '@std/encoding/base64url';

function extractCoreVersion(appHtml: string): string {
	const match = appHtml.match(/"title"\s*:\s*"\$:\/core"[^}]*"version"\s*:\s*"([^"]+)"/) ||
		appHtml.match(/"version"\s*:\s*"([0-9]+\.[0-9]+\.[0-9]+[^"]*)"[^}]*"title"\s*:\s*"\$:\/core"/);
	return match?.[1] || '5.4.1';
}

const files = [
	{ src: 'output/app/app.html', name: 'app.html', ctype: 'text/html; charset=utf-8' },
	{ src: 'output/app/sw.js', name: 'sw.js', ctype: 'application/javascript; charset=utf-8' },
];

await Deno.mkdir('server/default_app', { recursive: true });

for (const f of files) {
	const raw = await Deno.readFile(f.src);
	const etag = encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-1', raw)));
	const compressedBuf = brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 8 } });
	const compressed = new Uint8Array(compressedBuf.buffer, compressedBuf.byteOffset, compressedBuf.byteLength);
	const meta: Record<string, unknown> = {
		etag,
		rawsize: raw.length,
		ctype: f.ctype,
	};
	if (f.name === 'app.html') {
		meta.version = extractCoreVersion(new TextDecoder().decode(raw));
	}
	await Deno.writeFile(`server/default_app/${f.name}.br`, compressed);
	await Deno.writeTextFile(
		`server/default_app/${f.name}.meta.json`,
		JSON.stringify(meta),
	);
	console.log(`${f.name}: ${raw.length} bytes -> ${compressed.length} bytes (br), etag=${etag}`);
}
