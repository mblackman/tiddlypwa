import * as brotli from 'brotli';
import { encodeBase64Url } from '@std/encoding/base64url';

const files = [
	{ src: 'output/app/app.html', name: 'app.html', ctype: 'text/html; charset=utf-8' },
	{ src: 'output/app/sw.js', name: 'sw.js', ctype: 'application/javascript; charset=utf-8' },
];

await Deno.mkdir('server/default_app', { recursive: true });

for (const f of files) {
	const raw = await Deno.readFile(f.src);
	const etag = encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-1', raw)));
	const compressed = brotli.compress(raw, 4096, 8);
	await Deno.writeFile(`server/default_app/${f.name}.br`, compressed);
	await Deno.writeTextFile(
		`server/default_app/${f.name}.meta.json`,
		JSON.stringify({
			etag,
			rawsize: raw.length,
			ctype: f.ctype,
		}),
	);
	console.log(`${f.name}: ${raw.length} bytes → ${compressed.length} bytes (br), etag=${etag}`);
}
