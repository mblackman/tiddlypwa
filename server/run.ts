import * as dotenv from '@std/dotenv';
import { parseArgs } from '@std/cli/parse-args';
import { SQLiteDatastore } from './sqlite.ts';
import { TiddlyPWASyncApp } from './app.ts';

export async function listen(args: any) {
	const denv = args.dotenv ? await dotenv.load() : {};
	const envvar = (name: string) => Deno.env.get(name) ?? denv[name];
	const adminpwhash = (args.adminpwhash ?? envvar('ADMIN_PASSWORD_HASH'))?.trim();
	const adminpwsalt = (args.adminpwsalt ?? envvar('ADMIN_PASSWORD_SALT'))?.trim();
	if (!adminpwhash || !adminpwsalt) {
		console.error('Error: ADMIN_PASSWORD_HASH and ADMIN_PASSWORD_SALT must be configured.');
		console.error('Generate them using: deno run --allow-env server/hash-admin-password.ts');
		Deno.exit(1);
	}
	const basepath = args.basepath ?? envvar('BASE_PATH') ?? '';
	const dbPath = args.db ?? envvar('DB_PATH') ?? '.data/tiddly.db';
	const lastSlash = dbPath.lastIndexOf('/');
	if (lastSlash > 0) {
		try {
			Deno.mkdirSync(dbPath.slice(0, lastSlash), { recursive: true });
		} catch (_e) {
			// directory may already exist or cannot be created
		}
	}
	const db = new SQLiteDatastore(dbPath);
	const app = new TiddlyPWASyncApp(db, adminpwsalt, adminpwhash, basepath);

	const socketPath = args.socket ?? envvar('SOCKET');
	const port = Number(args.port ?? envvar('PORT') ?? 8000);
	const hostname = args.host ?? envvar('HOST');

	if (socketPath) {
		console.log('Listening on socket:', socketPath);
		await Deno.serve({ path: socketPath }, (req) => app.handle(req)).finished;
	} else {
		console.log(`Listening on http://${hostname ?? '0.0.0.0'}:${port}`);
		await Deno.serve({ port, hostname }, (req) => app.handle(req)).finished;
	}
}

if (import.meta.main) await listen(parseArgs(Deno.args));
