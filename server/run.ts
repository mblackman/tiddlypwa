import * as dotenv from '@std/dotenv';
import { parseArgs } from '@std/cli/parse-args';
import { SQLiteDatastore } from './sqlite.ts';
import { TiddlyPWASyncApp } from './app.ts';

export async function listen(args: any) {
	const denv = args.dotenv ? await dotenv.load() : {};
	const envvar = (name: string) => Deno.env.get(name) ?? denv[name];
	const adminpwhash = (args.adminpwhash ?? envvar('ADMIN_PASSWORD_HASH'))?.trim();
	const adminpwsalt = (args.adminpwsalt ?? envvar('ADMIN_PASSWORD_SALT'))?.trim();
	const basepath = args.basepath ?? envvar('BASE_PATH') ?? '';
	const db = new SQLiteDatastore(args.db ?? envvar('DB_PATH') ?? '.data/tiddly.db');
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
