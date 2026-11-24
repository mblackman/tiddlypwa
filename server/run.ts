import * as dotenv from '@std/dotenv';
import { parseArgs } from '@std/cli/parse-args';
import { decodeBase64Url } from '@std/encoding/base64url';
import { SQLiteDatastore } from './sqlite.ts';
import { TiddlyPWASyncApp } from './app.ts';
import { startSchedulerLoop } from './scheduler.ts';

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
	let saltBytes: Uint8Array;
	let hashBytes: Uint8Array;
	try {
		saltBytes = decodeBase64Url(adminpwsalt);
		hashBytes = decodeBase64Url(adminpwhash);
	} catch (_e) {
		console.error('Error: ADMIN_PASSWORD_HASH and ADMIN_PASSWORD_SALT must be valid Base64URL.');
		Deno.exit(1);
	}
	if (saltBytes.byteLength < 16 || (hashBytes.byteLength !== 32 && hashBytes.byteLength !== 64)) {
		console.error(
			'Error: ADMIN_PASSWORD_SALT must decode to >= 16 bytes and ADMIN_PASSWORD_HASH to 32 or 64 bytes.',
		);
		Deno.exit(1);
	}
	const basepath = args.basepath ?? envvar('BASE_PATH') ?? '';
	const vapidSubject = args.vapidsubject ?? envvar('VAPID_SUBJECT') ?? 'mailto:noreply@example.com';
	const dbPath = args.db ?? envvar('DB_PATH') ?? '.data/tiddly.db';
	const lastSlash = dbPath.lastIndexOf('/');
	if (lastSlash > 0) {
		try {
			Deno.mkdirSync(dbPath.slice(0, lastSlash), { recursive: true });
		} catch (_e) {
			// directory may already exist or cannot be created
		}
	}
	const allowCustomAppUpload = envvar('ALLOW_CUSTOM_APP_UPLOAD') === 'true';
	const trustProxy = envvar('TRUST_PROXY') === 'true';
	const db = new SQLiteDatastore(dbPath);
	const app = new TiddlyPWASyncApp(db, adminpwsalt, adminpwhash, basepath, vapidSubject, {
		allowCustomAppUpload,
		trustProxy,
	});
	await app.ensureVapidKeys();
	await app.loadDefaultApp();
	const schedulerIntervalMs = Number(args.schedulerinterval ?? envvar('SCHEDULER_INTERVAL_MS') ?? 30_000);
	startSchedulerLoop(app, schedulerIntervalMs);

	const socketPath = args.socket ?? envvar('SOCKET');
	const port = Number(args.port ?? envvar('PORT') ?? 8000);
	const hostname = args.host ?? envvar('HOST');

	if (socketPath) {
		console.log('Listening on socket:', socketPath);
		await Deno.serve({ path: socketPath }, (req, info) => app.handle(req, info)).finished;
	} else {
		console.log(`Listening on http://${hostname ?? '0.0.0.0'}:${port}`);
		await Deno.serve({ port, hostname }, (req, info) => app.handle(req, info)).finished;
	}
}

if (import.meta.main) await listen(parseArgs(Deno.args));
