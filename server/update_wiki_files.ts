import { SQLiteDatastore } from './sqlite.ts';
import { parseArgs } from '@std/cli/parse-args';
import * as brotli from 'brotli';

export async function updateWikiFiles(dbPath = '.data/tiddly.db', targetToken?: string) {
	const db = new SQLiteDatastore(dbPath);

	const filesToStore = [
		{ name: 'app.html', path: 'output/app/app.html', ctype: 'text/html; charset=utf-8' },
		{ name: 'sw.js', path: 'output/app/sw.js', ctype: 'application/javascript; charset=utf-8' },
	];

	const processedFiles: { name: string; etag: Uint8Array; rawsize: number; ctype: string; compressed: Uint8Array }[] =
		[];

	for (const f of filesToStore) {
		const raw = Deno.readFileSync(f.path);
		const etag = new Uint8Array(await crypto.subtle.digest('SHA-1', raw));
		const compressed = brotli.compress(raw, 4096, 8);
		processedFiles.push({
			name: f.name,
			etag,
			rawsize: raw.length,
			ctype: f.ctype,
			compressed,
		});
	}

	const wikis = targetToken ? [{ token: targetToken }] : db.listWikis();
	if (wikis.length === 0 && targetToken) {
		wikis.push({ token: targetToken });
	}

	db.transaction(() => {
		for (const pf of processedFiles) {
			if (!db.fileExists(pf.etag)) {
				db.storeFile({
					etag: pf.etag,
					rawsize: pf.rawsize,
					ctype: pf.ctype,
					body: pf.compressed,
				});
			}
			for (const w of wikis) {
				db.associateFile(w.token, pf.etag, pf.name);
			}
		}
	});

	db.close(true);

	console.log(`Updated wiki files (${processedFiles.map((p) => p.name).join(', ')}) for ${wikis.length} wiki(s).`);
}

if (import.meta.main) {
	const args = parseArgs(Deno.args);
	const dbPath = args.db ?? '.data/tiddly.db';
	const token = args.token;
	await updateWikiFiles(dbPath, token);
}
