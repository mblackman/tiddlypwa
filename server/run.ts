/// <reference lib="deno.window" />
import * as dotenv from 'https://deno.land/std@0.192.0/dotenv/mod.ts';
import { parse as argparse } from 'https://deno.land/std@0.192.0/flags/mod.ts';
import { serveListener } from 'https://deno.land/std@0.192.0/http/server.ts';
import { SQLiteDatastore } from './sqlite.ts';
import { TiddlyPWASyncApp } from './app.ts';

export async function listen(args: any) {
	if (!('BroadcastChannel' in globalThis)) throw new Error('Run Deno with --unstable-broadcast-channel!');
	const denv = args.dotenv ? await dotenv.load() : {};
	const envvar = (name: string) => Deno.env.get(name) ?? denv[name];
	const adminpwhash = (args.adminpwhash ?? envvar('ADMIN_PASSWORD_HASH'))?.trim();
	const adminpwsalt = (args.adminpwsalt ?? envvar('ADMIN_PASSWORD_SALT'))?.trim();
	const basepath = args.basepath ?? envvar('BASE_PATH') ?? '';
	const db = new SQLiteDatastore(args.db ?? envvar('DB_PATH') ?? '.data/tiddly.db');
	const app = new TiddlyPWASyncApp(db, adminpwsalt, adminpwhash, basepath);
	const listen: any = { port: 8000 };
	if ('port' in args) {
		listen.port = args.port;
	}
	if ('host' in args) {
		listen.hostname = args.host;
	}
	if ('socket' in args) {
		listen.transport = 'unix';
		listen.path = args.socket;
	}
	console.log('Listening:', listen);
	await serveListener(Deno.listen(listen), app.handle.bind(app));
}

if (import.meta.main) await listen(argparse(Deno.args));
