import { createHash, timingSafeEqual } from 'node:crypto';
import { brotliCompress, constants as zlibConstants } from 'node:zlib';
import { decodeBase64Url, encodeBase64Url } from '@std/encoding/base64url';
import { decodeBase64, encodeBase64 } from '@std/encoding/base64';
import * as brotli from 'brotli';
import { renderHomePage } from './pages.ts';
import { Datastore, Tiddler, Wiki } from './data.d.ts';
import { broadcastWikiPush, decodeBase64Flexible, getOrCreateVapidKeys, VapidKeys } from './webpush.ts';
import {
	canonicalizeWatchedItems,
	computeCodeHash,
	DnsResolverFn,
	executeWatcherModule,
	validatePublicEndpointUrl,
	verifyWatcherSignature,
	WatchedItem,
} from './watcher_runner.ts';

const utfenc = new TextEncoder();

// Pending: https://github.com/denoland/deno/issues/19160

function route(methods: string[], pathname: string, skipIf?: (groups: Record<string, string | undefined>) => boolean) {
	const pat = new URLPattern({ pathname });
	const methodSet = new Set(methods);
	const allow = methods.join(', ');
	return function (orig: any, _context: ClassMethodDecoratorContext) {
		return function (this: any, req: Request, ...extraArgs: unknown[]) {
			const match = pat.exec(req.url);
			if (!match) return null;
			if (skipIf && skipIf(match.pathname.groups)) return null;
			if (!methodSet.has(req.method)) return new Response(null, { status: 405, headers: { allow } });
			return orig.apply(this, [req, match.pathname.groups, ...extraArgs]);
		};
	};
}

function adminAuth(orig: any, _context: ClassMethodDecoratorContext) {
	return async function (this: any, data: Record<string, unknown>) {
		if (typeof data.atoken !== 'string') {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		const app = this as TiddlyPWASyncApp;
		if (app.isAdminVerifySaturated()) {
			return Response.json(
				{ error: 'ERATELIMIT' },
				{ headers: { ...respHdrs, 'retry-after': '1' }, status: 429 },
			);
		}
		if (!(await app.adminPasswordCorrect(data.atoken))) {
			return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
		}
		return orig.apply(this, [data]);
	};
}

function getWiki(error: string) {
	return function (orig: any, _context: ClassMethodDecoratorContext) {
		return function (this: any, data: Record<string, unknown>, ...args: unknown[]) {
			if (typeof data.token !== 'string') {
				return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
			}
			const wiki = (this as TiddlyPWASyncApp).db.getWiki(data.token);
			if (!wiki) {
				return Response.json({ error }, { headers: respHdrs, status: 401 });
			}
			return orig.apply(this, [{ ...data, wiki }, ...args]);
		};
	};
}

const respHdrs = {
	'access-control-allow-origin': '*',
	'access-control-expose-headers': 'x-server-time',
};

function stripWeak(x: string | null) {
	return x && (x.startsWith('W/') ? x.slice(2) : x);
}

function constantTimeEqual(a: string, b: string): boolean {
	const da = createHash('sha256').update(a).digest();
	const db = createHash('sha256').update(b).digest();
	return timingSafeEqual(da, db) && a.length === b.length;
}

function isValidAuthcode(authcode: unknown): authcode is string {
	return typeof authcode === 'string' && authcode.length >= 1 && authcode.length <= 256;
}

function supportsEncoding(headers: Headers, enc: string): boolean {
	return !!headers.get('accept-encoding')?.split(',').find((x) => x.trim().split(';')[0] === enc);
}

function processEtag(etag: Uint8Array, headers: Headers): [boolean, string] {
	const supportsBrotli = supportsEncoding(headers, 'br');
	return [supportsBrotli, '"' + encodeBase64Url(etag) + (supportsBrotli ? '-b' : '-x') + '"'];
}

function notifyMonitors(token: string, browserToken: string) {
	const chan = new BroadcastChannel(token);
	chan.postMessage({ exclude: browserToken });
	chan.close();
}

// ReadableStreamDefaultControllerCallback is deprecated
type CtrlCb<R> = (controller: ReadableStreamDefaultController<R>) => void | PromiseLike<void>;

function streamsponse(start: CtrlCb<string>, init: ResponseInit | undefined) {
	return new Response(new ReadableStream({ start }).pipeThrough(new TextEncoderStream()), init);
}

const ALLOWED_APP_FILENAMES: Record<string, string> = {
	'app.html': 'text/html; charset=utf-8',
	'sw.js': 'application/javascript; charset=utf-8',
};

const ADMIN_OPS = new Set(['list', 'create', 'delete', 'reauth', 'resetapp', 'resetallapps']);
const ADMIN_RATE_LIMIT_MAX = 5;
const ADMIN_GLOBAL_RATE_LIMIT_MAX = 30;
const ADMIN_RATE_LIMIT_WINDOW_MS = 60_000;
const ADMIN_FAILURES_MAX_KEYS = 4096;
const ADMIN_VERIFY_MAX_INFLIGHT = 4;

export class TiddlyPWASyncApp {
	db: Datastore;
	adminpwsalt: Uint8Array;
	adminpwhash: Uint8Array;
	basepath: string;
	vapidSubject: string;
	allowCustomAppUpload: boolean;
	trustProxy: boolean;
	defaultAppVersion = '5.4.1';
	vapidKeys?: VapidKeys;
	pushFetchFn?: typeof fetch;
	watcherFetchFn?: typeof fetch;
	resolveDnsFn?: DnsResolverFn;
	watcherTimeoutMs?: number;
	#adminFailures: Map<string, { count: number; resetAt: number }> = new Map();
	#adminGlobalFailures: { count: number; resetAt: number } = { count: 0, resetAt: 0 };
	#adminVerifyInFlight = 0;
	#monitorTickets: Map<string, { token: string; browserToken: string; expiresAt: number }> = new Map();

	constructor(
		db: Datastore,
		adminpwsalt: string,
		adminpwhash: string,
		basepath: string = '',
		vapidSubject: string = 'mailto:noreply@example.com',
		options?: { allowCustomAppUpload?: boolean; trustProxy?: boolean },
	) {
		this.db = db;
		this.adminpwsalt = decodeBase64Url(adminpwsalt);
		this.adminpwhash = decodeBase64Url(adminpwhash);
		this.basepath = basepath.endsWith('/') ? basepath.slice(0, -1) : basepath;
		this.vapidSubject = vapidSubject;
		this.allowCustomAppUpload = options?.allowCustomAppUpload ?? false;
		this.trustProxy = options?.trustProxy ?? false;
	}

	async ensureVapidKeys(): Promise<VapidKeys> {
		if (!this.vapidKeys) {
			this.vapidKeys = await getOrCreateVapidKeys(this.db);
		}
		return this.vapidKeys;
	}

	defaultAppFiles: Map<string, { etag: string; rawsize: number; ctype: string; body: Uint8Array }> = new Map();

	async loadDefaultApp(dir = 'server/default_app') {
		for (const name of ['app.html', 'sw.js']) {
			try {
				const meta = JSON.parse(await Deno.readTextFile(`${dir}/${name}.meta.json`));
				const body = await Deno.readFile(`${dir}/${name}.br`);
				this.defaultAppFiles.set(name, { etag: meta.etag, rawsize: meta.rawsize, ctype: meta.ctype, body });
				if (name === 'app.html' && typeof meta.version === 'string' && meta.version) {
					this.defaultAppVersion = meta.version;
				}
			} catch (e) {
				console.error('Failed to load default app file:', name, e);
				// Default app files not available - new wikis will 404 until app is uploaded
			}
		}
		await this.upgradeStoredWikiCorePlugins();
	}

	async upgradeStoredWikiCorePlugins() {
		const defaultApp = this.defaultAppFiles.get('app.html');
		const defaultSw = this.defaultAppFiles.get('sw.js');
		if (!defaultApp) return;

		const storeTag = '<script class="tiddlywiki-tiddler-store" type="application/json">';
		let defaultPlugins: Map<string, Record<string, unknown>>;
		try {
			const defaultHtml = new TextDecoder().decode(brotli.decompress(defaultApp.body));
			const sIdx = defaultHtml.indexOf(storeTag);
			const eIdx = sIdx !== -1 ? defaultHtml.indexOf('</script>', sIdx) : -1;
			if (sIdx === -1 || eIdx === -1) return;
			const store = JSON.parse(defaultHtml.slice(sIdx + storeTag.length, eIdx)) as Record<string, unknown>[];
			defaultPlugins = new Map();
			for (const title of ['$:/plugins/mblackman/tiddlypwa', '$:/plugins/mblackman/web-app-manifest']) {
				const found = store.find((t) => t.title === title);
				if (found) defaultPlugins.set(title, found);
			}
			if (defaultPlugins.size === 0) return;
		} catch (e) {
			console.warn('Could not parse default app store for plugin upgrade:', e);
			return;
		}

		const wikis = this.db.listWikis();
		if (wikis.length === 0) return;

		const legacyTitles = new Set(['$:/plugins/valpackett/tiddlypwa', '$:/plugins/valpackett/web-app-manifest']);

		for (const wiki of wikis) {
			try {
				const appFile = this.db.getWikiFile(wiki.token, 'app.html');
				if (!appFile) continue;
				const html = new TextDecoder().decode(brotli.decompress(appFile.body));
				const sIdx = html.indexOf(storeTag);
				const eIdx = sIdx !== -1 ? html.indexOf('</script>', sIdx) : -1;
				if (sIdx === -1 || eIdx === -1) continue;

				const store = JSON.parse(html.slice(sIdx + storeTag.length, eIdx)) as Record<string, unknown>[];
				let changed = false;
				const nextStore: Record<string, unknown>[] = [];
				const seenBuiltin = new Set<string>();

				for (const tid of store) {
					const title = typeof tid.title === 'string' ? tid.title : '';
					if (legacyTitles.has(title)) {
						changed = true;
						continue;
					}
					const targetPlugin = defaultPlugins.get(title);
					if (targetPlugin) {
						seenBuiltin.add(title);
						if (tid.text !== targetPlugin.text || tid.version !== targetPlugin.version) {
							nextStore.push(targetPlugin);
							changed = true;
						} else {
							nextStore.push(tid);
						}
					} else {
						nextStore.push(tid);
					}
				}

				for (const [title, targetPlugin] of defaultPlugins) {
					if (!seenBuiltin.has(title)) {
						nextStore.push(targetPlugin);
						changed = true;
					}
				}

				if (changed) {
					const serializedStore = '[\n' +
						nextStore.map((t) => JSON.stringify(t).replace(/</g, '\\u003c')).join(',\n') +
						'\n]';
					const newHtml = html.slice(0, sIdx + storeTag.length) + serializedStore + html.slice(eIdx);
					const utf = utfenc.encode(newHtml);
					const etag = new Uint8Array(await crypto.subtle.digest('SHA-1', utf));
					const compressed = brotli.compress(utf, 4096, 8);
					this.db.transaction(() => {
						if (!this.db.fileExists(etag)) {
							this.db.storeFile({
								etag,
								rawsize: utf.length,
								ctype: appFile.ctype,
								body: compressed,
							});
						}
						this.db.associateFile(wiki.token, etag, 'app.html');
						if (defaultSw) {
							const swEtag = decodeBase64Url(defaultSw.etag);
							if (!this.db.fileExists(swEtag)) {
								this.db.storeFile({
									etag: swEtag,
									rawsize: defaultSw.rawsize,
									ctype: defaultSw.ctype,
									body: defaultSw.body,
								});
							}
							this.db.associateFile(wiki.token, swEtag, 'sw.js');
						}
					});
				}
			} catch (e) {
				console.warn(`Failed to upgrade core plugins for wiki ${wiki.token.slice(0, 8)}:`, e);
			}
		}
	}

	isAdminVerifySaturated(): boolean {
		return this.#adminVerifyInFlight >= ADMIN_VERIFY_MAX_INFLIGHT;
	}

	async adminPasswordCorrect(atoken: string): Promise<boolean> {
		if (
			this.adminpwsalt.length < 8 ||
			(this.adminpwhash.length !== 32 && this.adminpwhash.length !== 64)
		) {
			return false;
		}
		this.#adminVerifyInFlight++;
		let worker: Worker | null = null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			worker = new Worker(new URL('./argon_worker.ts', import.meta.url).href, {
				type: 'module',
				deno: { permissions: 'none' },
			});
			const w = worker;
			const payload = {
				pw: utfenc.encode(atoken),
				salt: this.adminpwsalt,
				hash: this.adminpwhash,
			};
			return await new Promise<boolean>((resolve) => {
				let settled = false;
				const done = (ok: boolean) => {
					if (settled) return;
					settled = true;
					if (timer !== undefined) clearTimeout(timer);
					resolve(ok);
				};
				timer = setTimeout(() => done(false), 5000);
				w.onerror = (evt) => {
					evt.preventDefault?.();
					done(false);
				};
				w.onmessage = (evt) => {
					const msg = evt.data as { ready?: boolean; ok?: boolean } | null;
					if (msg?.ready) {
						w.postMessage(payload);
						return;
					}
					done(Boolean(msg?.ok));
				};
			});
		} catch (_e) {
			return false;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			try {
				worker?.terminate();
			} catch (_e) {
				// ignore
			}
			this.#adminVerifyInFlight--;
		}
	}

	@getWiki('EAUTH')
	handleSync(
		{ wiki, token, browserToken, authcode, salt, now, clientChanges, lastSync, ackPatches }: Record<string, unknown>,
		headers: Headers,
	) {
		if (
			typeof token !== 'string' || !isValidAuthcode(authcode) || typeof now !== 'string' ||
			typeof lastSync !== 'string' || (salt && typeof salt !== 'string') ||
			!Array.isArray(clientChanges) ||
			(ackPatches !== undefined && (!Array.isArray(ackPatches) || !ackPatches.every((p) => typeof p === 'string')))
		) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		const nowDate = new Date(now);
		const modsince = new Date(lastSync);
		if (!Number.isFinite(nowDate.getTime()) || !Number.isFinite(modsince.getTime())) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		if (Math.abs(nowDate.getTime() - Date.now()) > 60000) {
			return Response.json({ error: 'ETIMESYNC' }, { headers: respHdrs, status: 400 });
		}
		if ((wiki as Wiki).authcode && !constantTimeEqual(authcode, (wiki as Wiki).authcode!)) {
			return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
		}

		const decodedChanges: Tiddler[] = [];
		const seenThashes = new Set<string>();
		try {
			for (const change of clientChanges) {
				if (!change || typeof change !== 'object' || typeof change.thash !== 'string') {
					return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
				}
				const { thash, iv, ct, sbiv, sbct, mtime, deleted, baseMtime } = change;
				const decodedThash = decodeBase64(thash);
				const canonicalThash = encodeBase64(decodedThash);
				if (seenThashes.has(canonicalThash)) {
					return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
				}
				seenThashes.add(canonicalThash);
				const itemMtime = mtime ? new Date(mtime) : new Date(0);
				if (!Number.isFinite(itemMtime.getTime())) {
					return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
				}
				let itemBaseMtime: Date | null | undefined;
				if (baseMtime === null) {
					itemBaseMtime = null;
				} else if (baseMtime !== undefined) {
					itemBaseMtime = new Date(baseMtime);
					if (!Number.isFinite(itemBaseMtime.getTime())) {
						return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
					}
				}
				decodedChanges.push({
					thash: decodedThash,
					iv: iv ? decodeBase64(iv) : undefined,
					ct: ct ? decodeBase64(ct) : undefined,
					sbiv: sbiv ? decodeBase64(sbiv) : undefined,
					sbct: sbct ? decodeBase64(sbct) : undefined,
					mtime: itemMtime,
					deleted: Boolean(deleted),
					baseMtime: itemBaseMtime,
				});
			}
		} catch (_e) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}

		// assuming here that the browser would use the same Accept-Encoding as when requesting the page
		const apphtml = this.db.getWikiFile(token, 'app.html');
		const [_, appEtag] = apphtml ? processEtag(apphtml.etag, headers) : [null, null];

		const snapshotMaxMtime = this.db.maxMtime(token);
		const tombstoneHorizon = this.db.getWikiTombstoneHorizon(token);
		const tombstoneReset = modsince.getTime() > 0 && modsince.getTime() < tombstoneHorizon;
		const effectiveSince = tombstoneReset ? new Date(0) : modsince;
		const effectiveServerTimeMs = Math.max(snapshotMaxMtime, tombstoneReset ? tombstoneHorizon : 0);
		const serverTimeDate = effectiveServerTimeMs > 0 ? new Date(effectiveServerTimeMs) : new Date(0);

		return streamsponse((ctrl) => {
			ctrl.enqueue(`{"appEtag":${JSON.stringify(appEtag)},"serverChanges":[`);

			let hasWritten = false;
			const conflicts: string[] = [];
			const successes: { thash: string; mtime: string }[] = [];
			let pendingPatches: Array<{ patchId: string; watcherId: string; patch: unknown; createdAt: number }> = [];

			this.db.transaction(() => {
				const freshWiki = this.db.getWiki(token);
				if (!freshWiki || (freshWiki.authcode && !constantTimeEqual(authcode, freshWiki.authcode))) {
					throw new Error('EAUTH');
				}
				if (!freshWiki.authcode) this.db.bindWikiAuthcodeIfUnset(token, authcode);
				if (!freshWiki.salt && typeof salt === 'string' && salt.length > 0) {
					this.db.bindWikiSaltIfUnset(token, salt);
				}
				if (Array.isArray(ackPatches) && ackPatches.length > 0) {
					this.db.deletePendingPatches(token, ackPatches as string[]);
				}
				let firstWritten = false;
				const streamedHashes = new Set<string>();

				for (
					const { thash, iv, ct, sbiv, sbct, mtime, deleted } of this.db.tiddlersChangedSince(token, effectiveSince)
				) {
					const b64hash = thash ? encodeBase64(thash) : null;
					if (b64hash) streamedHashes.add(b64hash);
					ctrl.enqueue(
						(firstWritten ? '\n,' : '\n') + JSON.stringify({
							thash: b64hash,
							iv: iv ? encodeBase64(iv) : null,
							ct: ct ? encodeBase64(ct) : null,
							sbiv: sbiv ? encodeBase64(sbiv) : null,
							sbct: sbct ? encodeBase64(sbct) : null,
							mtime,
							deleted,
						}),
					);
					if (!firstWritten) firstWritten = true;
				}
				const batchWriteTimeMs = Math.max(Date.now(), this.db.maxMtime(token) + 1);
				for (const change of decodedChanges) {
					const res = this.db.upsertTiddler(token, change, batchWriteTimeMs);
					if (res.conflict) {
						const b64hash = encodeBase64(change.thash);
						conflicts.push(b64hash);
						if (!streamedHashes.has(b64hash)) {
							const existingTid = this.db.getTiddler(token, change.thash);
							if (existingTid) {
								streamedHashes.add(b64hash);
								ctrl.enqueue(
									(firstWritten ? '\n,' : '\n') + JSON.stringify({
										thash: b64hash,
										iv: existingTid.iv ? encodeBase64(existingTid.iv) : null,
										ct: existingTid.ct ? encodeBase64(existingTid.ct) : null,
										sbiv: existingTid.sbiv ? encodeBase64(existingTid.sbiv) : null,
										sbct: existingTid.sbct ? encodeBase64(existingTid.sbct) : null,
										mtime: existingTid.mtime,
										deleted: existingTid.deleted,
									}),
								);
								if (!firstWritten) firstWritten = true;
							}
						}
					} else if (res.success) {
						hasWritten = true;
						successes.push({ thash: encodeBase64(change.thash), mtime: new Date(batchWriteTimeMs).toISOString() });
					}
				}
				const rawPatches = this.db.listPendingPatches(token);
				if (rawPatches.length > 0) {
					pendingPatches = rawPatches.map((row) => {
						let parsed: unknown = null;
						try {
							parsed = JSON.parse(row.patch_json);
						} catch (_e) {
							parsed = null;
						}
						return {
							patchId: row.patch_id,
							watcherId: row.watcher_id,
							patch: parsed,
							createdAt: row.created_at,
						};
					});
				}
			});
			let trailer = '\n]';
			if (tombstoneReset) trailer += ',"tombstoneReset":true';
			if (conflicts.length > 0) trailer += `,"conflicts":${JSON.stringify(conflicts)}`;
			if (successes.length > 0) trailer += `,"successes":${JSON.stringify(successes)}`;
			if (pendingPatches.length > 0) trailer += `,"pendingPatches":${JSON.stringify(pendingPatches)}`;
			trailer += '}';
			ctrl.enqueue(trailer);
			ctrl.close();
			if (hasWritten && typeof browserToken === 'string') notifyMonitors(token, browserToken);
		}, {
			headers: { ...respHdrs, 'content-type': 'application/json', 'x-server-time': serverTimeDate.toISOString() },
		});
	}

	@getWiki('EAUTH')
	handleVerifyAuth({ wiki, token, authcode }: Record<string, unknown>) {
		if (typeof token !== 'string' || !isValidAuthcode(authcode)) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		const storedAuthcode = (wiki as Wiki).authcode;
		if (storedAuthcode && !constantTimeEqual(authcode, storedAuthcode)) {
			return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
		}
		return Response.json({ ok: true, hasAuthcode: Boolean(storedAuthcode) }, { headers: respHdrs, status: 200 });
	}

	@adminAuth
	handleList(_: unknown): Response | Promise<Response> {
		return Response.json({ wikis: this.db.listWikis() }, { headers: respHdrs, status: 200 });
	}

	@adminAuth
	handleCreate({ note }: Record<string, unknown>): Response | Promise<Response> {
		if (note !== undefined && typeof note !== 'string') {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		const token = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
		this.db.createWiki(token, note);
		return Response.json({ token }, { headers: respHdrs, status: 201 });
	}

	@adminAuth
	@getWiki('EEXIST')
	handleDelete({ token }: Record<string, unknown>): Response | Promise<Response> {
		this.db.deleteWiki(token as string);
		return Response.json({}, { headers: respHdrs, status: 200 });
	}

	@adminAuth
	@getWiki('EEXIST')
	handleReauth({ token }: Record<string, unknown>): Response | Promise<Response> {
		this.db.clearWikiAuth(token as string);
		return Response.json({}, { headers: respHdrs, status: 200 });
	}

	@getWiki('EAUTH')
	async handlePushInfo({ wiki, token, authcode, endpoint }: Record<string, unknown>) {
		if (typeof token !== 'string' || !isValidAuthcode(authcode)) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		if ((wiki as Wiki).authcode && !constantTimeEqual(authcode, (wiki as Wiki).authcode!)) {
			return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
		}
		const vapid = await this.ensureVapidKeys();
		const subs = this.db.listPushSubscriptions(token);
		const subscribed = typeof endpoint === 'string' && endpoint.length > 0
			? subs.some((s) => s.endpoint === endpoint)
			: subs.length > 0;
		return Response.json(
			{
				vapidPublicKey: vapid.publicKeyB64Url,
				subscriptionCount: subs.length,
				subscribed,
			},
			{ headers: respHdrs, status: 200 },
		);
	}

	@getWiki('EAUTH')
	async handlePushSubscribe({ wiki, token, authcode, subscription, uaHint }: Record<string, unknown>) {
		if (
			typeof token !== 'string' || !isValidAuthcode(authcode) ||
			typeof subscription !== 'object' || !subscription ||
			(uaHint !== undefined && typeof uaHint !== 'string')
		) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		if ((wiki as Wiki).authcode && !constantTimeEqual(authcode, (wiki as Wiki).authcode!)) {
			return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
		}
		const subObj = subscription as Record<string, unknown>;
		const endpoint = subObj.endpoint;
		const keys = subObj.keys as Record<string, unknown> | undefined;
		if (
			typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 2048 ||
			typeof keys !== 'object' || !keys ||
			typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string'
		) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		const p256dh = keys.p256dh;
		const auth = keys.auth;
		try {
			await validatePublicEndpointUrl(endpoint, {
				resolveDnsFn: this.resolveDnsFn,
				skipDns: Boolean(this.pushFetchFn && !this.resolveDnsFn),
			});
			const p256dhBytes = decodeBase64Flexible(p256dh);
			const authBytes = decodeBase64Flexible(auth);
			if (p256dhBytes.byteLength !== 65 || p256dhBytes[0] !== 0x04 || authBytes.byteLength !== 16) {
				return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
			}
		} catch (_e) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}

		let authFailed = false;
		this.db.transaction(() => {
			const freshWiki = this.db.getWiki(token);
			if (!freshWiki || (freshWiki.authcode && !constantTimeEqual(authcode, freshWiki.authcode))) {
				authFailed = true;
				return;
			}
			if (!freshWiki.authcode) this.db.bindWikiAuthcodeIfUnset(token, authcode);
			this.db.upsertPushSubscription({
				token,
				endpoint,
				p256dh,
				auth,
				ua_hint: typeof uaHint === 'string' ? uaHint.slice(0, 255) : null,
				created_at: Date.now(),
			});
		});
		if (authFailed) {
			return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
		}

		const vapid = await this.ensureVapidKeys();
		return Response.json(
			{ ok: true, vapidPublicKey: vapid.publicKeyB64Url },
			{ headers: respHdrs, status: 200 },
		);
	}

	@getWiki('EAUTH')
	handlePushUnsubscribe({ wiki, token, authcode, endpoint, all }: Record<string, unknown>) {
		if (typeof token !== 'string' || !isValidAuthcode(authcode)) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		if ((wiki as Wiki).authcode && !constantTimeEqual(authcode, (wiki as Wiki).authcode!)) {
			return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
		}
		if (all === true) {
			this.db.deleteAllPushSubscriptions(token);
		} else if (typeof endpoint === 'string' && endpoint.length > 0) {
			this.db.deletePushSubscription(token, endpoint);
		} else {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		return Response.json({ ok: true }, { headers: respHdrs, status: 200 });
	}

	@getWiki('EAUTH')
	async handlePushTest({ wiki, token, authcode, endpoint, payload }: Record<string, unknown>) {
		if (
			typeof token !== 'string' || !isValidAuthcode(authcode) ||
			(endpoint !== undefined && typeof endpoint !== 'string')
		) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		if ((wiki as Wiki).authcode && !constantTimeEqual(authcode, (wiki as Wiki).authcode!)) {
			return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
		}
		let envelope: Record<string, unknown>;
		if (
			payload && typeof payload === 'object' &&
			(payload as Record<string, unknown>).mode === 'encrypted' &&
			typeof (payload as Record<string, unknown>).iv === 'string' &&
			typeof (payload as Record<string, unknown>).ct === 'string'
		) {
			envelope = {
				mode: 'encrypted',
				iv: (payload as Record<string, unknown>).iv,
				ct: (payload as Record<string, unknown>).ct,
			};
		} else {
			envelope = {
				mode: 'plain',
				notification: {
					title: 'TiddlyPWA Push Active',
					body: 'Push notifications are configured and working on this device.',
					tag: 'tiddlypwa-test',
				},
			};
		}

		const vapid = await this.ensureVapidKeys();
		const res = await broadcastWikiPush(this.db, token, envelope, vapid, {
			targetEndpoint: typeof endpoint === 'string' ? endpoint : null,
			subject: this.vapidSubject,
			fetchFn: this.pushFetchFn,
			resolveDnsFn: this.resolveDnsFn,
		});
		return Response.json({ ok: true, ...res }, { headers: respHdrs, status: 200 });
	}

	@getWiki('EAUTH')
	handleSyncSchedules({ wiki, token, authcode, upserts, removals }: Record<string, unknown>) {
		if (
			typeof token !== 'string' || !isValidAuthcode(authcode) ||
			(upserts !== undefined && !Array.isArray(upserts)) ||
			(removals !== undefined && !Array.isArray(removals))
		) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		if ((wiki as Wiki).authcode && !constantTimeEqual(authcode, (wiki as Wiki).authcode!)) {
			return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
		}
		const upsertList = Array.isArray(upserts) ? upserts : [];
		const removalList = Array.isArray(removals) ? removals : [];
		if (upsertList.length > 500 || removalList.length > 500) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}

		const validUpserts: Array<{
			scheduleId: string;
			triggerAt: number;
			payloadJson: string;
			targetEndpoint: string | null;
		}> = [];
		for (const item of upsertList) {
			if (typeof item !== 'object' || !item) {
				return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
			}
			const rec = item as Record<string, unknown>;
			const scheduleId = rec.scheduleId;
			const triggerAt = rec.triggerAt;
			const payload = rec.payload;
			const targetEndpoint = rec.targetEndpoint;
			if (
				typeof scheduleId !== 'string' || scheduleId.length === 0 || scheduleId.length > 255 ||
				typeof triggerAt !== 'number' || !Number.isFinite(triggerAt) || triggerAt <= 0 ||
				typeof payload !== 'object' || !payload ||
				(targetEndpoint !== undefined && targetEndpoint !== null &&
					(typeof targetEndpoint !== 'string' || targetEndpoint.length > 2048))
			) {
				return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
			}
			const pObj = payload as Record<string, unknown>;
			if (pObj.mode === 'encrypted') {
				if (typeof pObj.iv !== 'string' || typeof pObj.ct !== 'string') {
					return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
				}
			} else if (pObj.mode === 'plain') {
				if (typeof pObj.notification !== 'object' || !pObj.notification) {
					return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
				}
			} else {
				return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
			}
			const payloadJson = JSON.stringify(payload);
			if (payloadJson.length > 8192) {
				return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
			}
			validUpserts.push({
				scheduleId,
				triggerAt: Math.floor(triggerAt),
				payloadJson,
				targetEndpoint: typeof targetEndpoint === 'string' && targetEndpoint.length > 0 ? targetEndpoint : null,
			});
		}

		const validRemovals: string[] = [];
		for (const id of removalList) {
			if (typeof id !== 'string' || id.length === 0 || id.length > 255) {
				return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
			}
			validRemovals.push(id);
		}

		const nowMs = Date.now();
		let authFailed = false;
		this.db.transaction(() => {
			const freshWiki = this.db.getWiki(token);
			if (!freshWiki || (freshWiki.authcode && !constantTimeEqual(authcode, freshWiki.authcode))) {
				authFailed = true;
				return;
			}
			if (!freshWiki.authcode) this.db.bindWikiAuthcodeIfUnset(token, authcode);
			if (validRemovals.length > 0) {
				this.db.deleteScheduledNotifications(token, validRemovals);
			}
			for (const u of validUpserts) {
				this.db.upsertScheduledNotification({
					token,
					schedule_id: u.scheduleId,
					trigger_at: u.triggerAt,
					payload_json: u.payloadJson,
					target_endpoint: u.targetEndpoint,
					created_at: nowMs,
				});
			}
		});
		if (authFailed) {
			return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
		}

		return Response.json(
			{ ok: true, upserted: validUpserts.length, removed: validRemovals.length },
			{ headers: respHdrs, status: 200 },
		);
	}

	@getWiki('EAUTH')
	async handleSyncWatchers(
		{ wiki, token, authcode, watcherPubKey, watchers, removedWatcherIds }: Record<string, unknown>,
	) {
		if (
			typeof token !== 'string' || !isValidAuthcode(authcode) ||
			(watcherPubKey !== undefined && typeof watcherPubKey !== 'string') ||
			(watchers !== undefined && !Array.isArray(watchers)) ||
			(removedWatcherIds !== undefined && !Array.isArray(removedWatcherIds))
		) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		if ((wiki as Wiki).authcode && !constantTimeEqual(authcode, (wiki as Wiki).authcode!)) {
			return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
		}

		const watcherList = Array.isArray(watchers) ? watchers : [];
		const removalList = Array.isArray(removedWatcherIds) ? removedWatcherIds : [];
		if (watcherList.length > 50 || removalList.length > 100) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}

		const existingPubKey = (wiki as Wiki).watcher_pubkey;
		if (typeof watcherPubKey === 'string' && watcherPubKey.length > 0) {
			try {
				const decodedPub = decodeBase64Url(watcherPubKey);
				if (decodedPub.byteLength !== 32) {
					return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
				}
			} catch (_e) {
				return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
			}
			if (existingPubKey && !constantTimeEqual(existingPubKey, watcherPubKey)) {
				return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
			}
		}

		const effectivePubKey = existingPubKey || (typeof watcherPubKey === 'string' ? watcherPubKey : '');
		if (watcherList.length > 0 && !effectivePubKey) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}

		const validRemovals: string[] = [];
		for (const id of removalList) {
			if (typeof id !== 'string' || id.length === 0 || id.length > 255) {
				return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
			}
			validRemovals.push(id);
		}

		const validWatchers: Array<{
			watcher_id: string;
			code_hash: string;
			code_source: string;
			allowed_hosts: string;
			schedule_cron: string;
			timezone: string;
			watched_items: string;
			signature: string;
		}> = [];

		for (const item of watcherList) {
			if (typeof item !== 'object' || !item) {
				return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
			}
			const rec = item as Record<string, unknown>;
			const watcherId = rec.watcherId;
			const codeHash = rec.codeHash;
			const codeSource = rec.codeSource;
			const allowedHosts = rec.allowedHosts ?? '';
			const scheduleCron = rec.scheduleCron;
			const timezone = typeof rec.timezone === 'string' && rec.timezone.trim() ? rec.timezone.trim() : 'UTC';
			const watchedItemsRaw = rec.watchedItems;
			const signature = rec.signature;

			if (
				typeof watcherId !== 'string' || watcherId.length === 0 || watcherId.length > 255 ||
				typeof codeHash !== 'string' || codeHash.length === 0 || codeHash.length > 128 ||
				typeof codeSource !== 'string' || codeSource.length === 0 || codeSource.length > 131072 ||
				typeof allowedHosts !== 'string' || allowedHosts.length > 2048 ||
				typeof scheduleCron !== 'string' || scheduleCron.length === 0 || scheduleCron.length > 128 ||
				timezone.length > 128 ||
				!Array.isArray(watchedItemsRaw) || watchedItemsRaw.length > 500 ||
				typeof signature !== 'string' || signature.length === 0 || signature.length > 256
			) {
				return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
			}

			const watchedItems: WatchedItem[] = [];
			for (const wi of watchedItemsRaw) {
				if (typeof wi !== 'object' || !wi) {
					return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
				}
				const wObj = wi as Record<string, unknown>;
				if (typeof wObj.title !== 'string' || typeof wObj.fields !== 'object' || !wObj.fields) {
					return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
				}
				const cleanFields: Record<string, string> = {};
				for (const [fk, fv] of Object.entries(wObj.fields as Record<string, unknown>)) {
					if (typeof fk === 'string') {
						cleanFields[fk] = String(fv ?? '');
					}
				}
				watchedItems.push({ title: wObj.title, fields: cleanFields });
			}

			const canonicalItems = canonicalizeWatchedItems(watchedItems);
			const watchedItemsJson = JSON.stringify(canonicalItems);
			if (watchedItemsJson.length > 262144) {
				return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
			}

			const actualHash = await computeCodeHash(codeSource);
			if (actualHash !== codeHash) {
				return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
			}

			const sigOk = await verifyWatcherSignature(
				effectivePubKey,
				{
					watcherId,
					codeHash,
					allowedHosts,
					scheduleCron,
					timezone,
					watchedItems: canonicalItems,
				},
				signature,
			);
			if (!sigOk) {
				return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
			}

			validWatchers.push({
				watcher_id: watcherId,
				code_hash: codeHash,
				code_source: codeSource,
				allowed_hosts: allowedHosts,
				schedule_cron: scheduleCron,
				timezone,
				watched_items: watchedItemsJson,
				signature,
			});
		}

		let authFailed = false;
		let protoFailed = false;
		this.db.transaction(() => {
			const freshWiki = this.db.getWiki(token);
			if (!freshWiki || (freshWiki.authcode && !constantTimeEqual(authcode, freshWiki.authcode))) {
				authFailed = true;
				return;
			}
			if (freshWiki.watcher_pubkey) {
				if (
					(typeof watcherPubKey === 'string' && watcherPubKey.length > 0 &&
						!constantTimeEqual(freshWiki.watcher_pubkey, watcherPubKey)) ||
					!constantTimeEqual(freshWiki.watcher_pubkey, effectivePubKey)
				) {
					authFailed = true;
					return;
				}
			} else if (validWatchers.length > 0 && !effectivePubKey) {
				protoFailed = true;
				return;
			}
			if (!freshWiki.authcode) {
				this.db.bindWikiAuthcodeIfUnset(token, authcode);
			}
			if (!freshWiki.watcher_pubkey && effectivePubKey) {
				this.db.bindWikiWatcherPubKeyIfUnset(token, effectivePubKey);
			}
			for (const remId of validRemovals) {
				this.db.deleteWatcherModule(token, remId);
			}
			for (const w of validWatchers) {
				this.db.upsertWatcherModule({
					token,
					...w,
				});
			}
		});
		if (authFailed) {
			return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
		}
		if (protoFailed) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}

		return Response.json(
			{ ok: true, upserted: validWatchers.length, removed: validRemovals.length },
			{ headers: respHdrs, status: 200 },
		);
	}

	@getWiki('EAUTH')
	handleListWatchers({ wiki, token, authcode }: Record<string, unknown>) {
		if (typeof token !== 'string' || !isValidAuthcode(authcode)) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		if ((wiki as Wiki).authcode && !constantTimeEqual(authcode, (wiki as Wiki).authcode!)) {
			return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
		}
		const rows = this.db.listWatcherModules(token);
		return Response.json(
			{
				ok: true,
				watchers: rows.map((r) => ({
					watcherId: r.watcher_id,
					codeHash: r.code_hash,
					allowedHosts: r.allowed_hosts,
					scheduleCron: r.schedule_cron,
					timezone: r.timezone,
					lastRunAt: r.last_run_at,
					lastError: r.last_error || null,
				})),
			},
			{ headers: respHdrs, status: 200 },
		);
	}

	@getWiki('EAUTH')
	async handleRunWatcher({ wiki, token, authcode, watcherId }: Record<string, unknown>) {
		if (
			typeof token !== 'string' || !isValidAuthcode(authcode) ||
			typeof watcherId !== 'string' || watcherId.length === 0
		) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		if ((wiki as Wiki).authcode && !constantTimeEqual(authcode, (wiki as Wiki).authcode!)) {
			return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
		}

		const rows = this.db.listWatcherModules(token);
		const row = rows.find((r) => r.watcher_id === watcherId);
		if (!row) {
			return Response.json({ error: 'EEXIST' }, { headers: respHdrs, status: 404 });
		}

		const pubkey = (wiki as Wiki).watcher_pubkey;
		if (!pubkey) {
			return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
		}

		const actualHash = await computeCodeHash(row.code_source);
		if (actualHash !== row.code_hash) {
			return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
		}

		let watchedItems: WatchedItem[] = [];
		try {
			const parsed = JSON.parse(row.watched_items || '[]');
			if (Array.isArray(parsed)) watchedItems = parsed;
		} catch (_e) {
			watchedItems = [];
		}

		const sigOk = await verifyWatcherSignature(
			pubkey,
			{
				watcherId: row.watcher_id,
				codeHash: row.code_hash,
				allowedHosts: row.allowed_hosts,
				scheduleCron: row.schedule_cron,
				timezone: row.timezone || 'UTC',
				watchedItems,
			},
			row.signature,
		);
		if (!sigOk) {
			return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
		}

		const vapid = await this.ensureVapidKeys();
		const summary = await executeWatcherModule(this.db, row, vapid, {
			subject: this.vapidSubject,
			fetchFn: this.watcherFetchFn,
			pushFetchFn: this.pushFetchFn,
			resolveDnsFn: this.resolveDnsFn,
			timeoutMs: this.watcherTimeoutMs,
		});

		return Response.json(
			{
				ok: summary.ok,
				error: summary.error,
				results: summary.results,
				notificationsSent: summary.notificationsSent,
				patchesStaged: summary.patchesStaged,
				lastRunAt: summary.lastRunAt,
			},
			{ headers: respHdrs, status: 200 },
		);
	}

	@adminAuth
	@getWiki('EEXIST')
	handleResetApp({ token }: Record<string, unknown>): Response | Promise<Response> {
		this.db.dissociateFiles(token as string);
		return Response.json({}, { headers: respHdrs, status: 200 });
	}

	#compressBrotliAsync(utf: Uint8Array): Promise<Uint8Array> {
		return new Promise<Uint8Array>((resolve, reject) => {
			brotliCompress(
				utf,
				{ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 8 } },
				(err, out) => {
					if (err) reject(err);
					else resolve(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
				},
			);
		});
	}

	#getClientIp(req: Request, info?: Deno.ServeHandlerInfo): string {
		if (this.trustProxy) {
			const xff = req.headers.get('x-forwarded-for');
			if (xff) {
				const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
				if (parts.length > 0) return parts[parts.length - 1].slice(0, 64);
			}
			const xRealIp = req.headers.get('x-real-ip')?.trim();
			if (xRealIp) return xRealIp.slice(0, 64);
			const cf = req.headers.get('cf-connecting-ip')?.trim();
			if (cf) return cf.slice(0, 64);
		}
		const remote = info?.remoteAddr as Deno.NetAddr | undefined;
		return (remote?.hostname || 'local').slice(0, 64);
	}

	#checkAdminRateLimit(clientIp: string): Response | null {
		const now = Date.now();
		if (this.#adminGlobalFailures.resetAt <= now) {
			this.#adminGlobalFailures = { count: 0, resetAt: 0 };
		} else if (this.#adminGlobalFailures.count >= ADMIN_GLOBAL_RATE_LIMIT_MAX) {
			const retryAfter = String(Math.max(1, Math.ceil((this.#adminGlobalFailures.resetAt - now) / 1000)));
			return Response.json(
				{ error: 'ERATELIMIT' },
				{ headers: { ...respHdrs, 'retry-after': retryAfter }, status: 429 },
			);
		}
		const entry = this.#adminFailures.get(clientIp);
		if (!entry) return null;
		if (entry.resetAt <= now) {
			this.#adminFailures.delete(clientIp);
			return null;
		}
		if (entry.count >= ADMIN_RATE_LIMIT_MAX) {
			const retryAfter = String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000)));
			return Response.json(
				{ error: 'ERATELIMIT' },
				{ headers: { ...respHdrs, 'retry-after': retryAfter }, status: 429 },
			);
		}
		return null;
	}

	#recordAdminAttempt(clientIp: string, failedAuth: boolean): void {
		const now = Date.now();
		if (!failedAuth) {
			this.#adminFailures.delete(clientIp);
			return;
		}
		if (this.#adminGlobalFailures.resetAt <= now) {
			this.#adminGlobalFailures = { count: 1, resetAt: now + ADMIN_RATE_LIMIT_WINDOW_MS };
		} else {
			this.#adminGlobalFailures.count++;
		}
		if (!this.#adminFailures.has(clientIp) && this.#adminFailures.size >= ADMIN_FAILURES_MAX_KEYS) {
			for (const [k, v] of this.#adminFailures) {
				if (v.resetAt <= now) this.#adminFailures.delete(k);
			}
			if (this.#adminFailures.size >= ADMIN_FAILURES_MAX_KEYS) {
				const oldest = this.#adminFailures.keys().next().value;
				if (oldest !== undefined) this.#adminFailures.delete(oldest);
			}
		}
		const prev = this.#adminFailures.get(clientIp);
		if (!prev || prev.resetAt <= now) {
			this.#adminFailures.set(clientIp, { count: 1, resetAt: now + ADMIN_RATE_LIMIT_WINDOW_MS });
		} else {
			prev.count++;
		}
	}

	@adminAuth
	handleResetAllApps(_: unknown): Response | Promise<Response> {
		this.db.dissociateAllFiles();
		return Response.json({}, { headers: respHdrs, status: 200 });
	}
	@getWiki('EAUTH')
	async handleUploadApp(
		{ wiki, token, authcode, browserToken, files }: {
			wiki: Wiki;
			token: string;
			authcode: unknown;
			browserToken: unknown;
			files: unknown;
		},
	) {
		if (!this.allowCustomAppUpload) {
			return Response.json({ error: 'EFORBIDDEN' }, { headers: respHdrs, status: 403 });
		}
		if (typeof files !== 'object' || !files) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		const fileEntries = Object.entries(files);
		if (fileEntries.length === 0 || fileEntries.length > 20) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		let totalBytes = 0;
		for (const [filename, value] of fileEntries) {
			if (
				typeof filename !== 'string' || !Object.hasOwn(ALLOWED_APP_FILENAMES, filename) ||
				typeof value !== 'object' || !value ||
				typeof (value as any).body !== 'string' || typeof (value as any).ctype !== 'string' ||
				(value as any).body.length > 25 * 1024 * 1024
			) {
				return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
			}
			totalBytes += (value as any).body.length;
			if (totalBytes > 50 * 1024 * 1024) {
				return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
			}
		}
		const storedAuth = (wiki as Wiki).authcode;
		if (storedAuth) {
			if (typeof authcode !== 'string' || authcode.length === 0 || !constantTimeEqual(authcode, storedAuth)) {
				return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
			}
		} else if (this.db.maxMtime(token) > 0 || Boolean((wiki as Wiki).salt)) {
			return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
		}
		const uploads = await Promise.all(
			fileEntries.map(async ([filename, value]) => {
				const { body } = value as any;
				const utf = utfenc.encode(body);
				const etag = new Uint8Array(await crypto.subtle.digest('SHA-1', utf));
				const exists = this.db.fileExists(etag);
				const compressed = exists ? null : await this.#compressBrotliAsync(utf);
				return { filename, etag, utf, ctype: ALLOWED_APP_FILENAMES[filename], compressed };
			}),
		);
		this.db.transaction(() => {
			for (const { filename, etag, utf, ctype, compressed } of uploads) {
				if (compressed && !this.db.fileExists(etag)) {
					this.db.storeFile({
						etag,
						rawsize: utf.length,
						ctype,
						body: compressed,
					});
				}
				this.db.associateFile(token, etag, filename);
			}
		});
		if (typeof browserToken === 'string') notifyMonitors(token, browserToken);
		return Response.json({ urlprefix: token.slice(0, token.length / 2) + '/' }, { headers: respHdrs, status: 200 });
	}

	@getWiki('EAUTH')
	handleMonitorTicket({ wiki, token, authcode, browserToken }: Record<string, unknown>) {
		if (
			typeof token !== 'string' || !isValidAuthcode(authcode) ||
			typeof browserToken !== 'string' || browserToken.length === 0 || browserToken.length > 128
		) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		if ((wiki as Wiki).authcode && !constantTimeEqual(authcode, (wiki as Wiki).authcode!)) {
			return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
		}
		const now = Date.now();
		if (this.#monitorTickets.size >= 1000) {
			for (const [k, v] of this.#monitorTickets) {
				if (v.expiresAt <= now) this.#monitorTickets.delete(k);
			}
			if (this.#monitorTickets.size >= 1000) {
				const oldest = this.#monitorTickets.keys().next().value;
				if (oldest !== undefined) this.#monitorTickets.delete(oldest);
			}
		}
		const ticket = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
		this.#monitorTickets.set(ticket, { token, browserToken, expiresAt: now + 30_000 });
		return Response.json({ ticket }, { headers: { ...respHdrs, 'cache-control': 'no-store' }, status: 200 });
	}

	handleMonitor(query: URLSearchParams, pingIntervalMs = 25000) {
		const token = query.get('token');
		const halftoken = query.get('halftoken');
		const authcode = query.get('authcode');
		const ticket = query.get('ticket');
		const browserToken = query.get('browserToken');
		if (!browserToken || (!token && !halftoken && !ticket)) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		let wikiToken: string;
		if (ticket) {
			const entry = this.#monitorTickets.get(ticket);
			this.#monitorTickets.delete(ticket);
			if (
				!entry || entry.expiresAt <= Date.now() ||
				!constantTimeEqual(entry.browserToken, browserToken) ||
				!this.db.getWiki(entry.token)
			) {
				return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
			}
			wikiToken = entry.token;
		} else if (token) {
			const wiki = this.db.getWiki(token);
			if (!wiki) {
				return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
			}
			if (wiki.authcode && (!authcode || !constantTimeEqual(authcode, wiki.authcode))) {
				return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
			}
			wikiToken = token;
		} else {
			if (
				!halftoken || halftoken.length < 21 || !/^[A-Za-z0-9_-]+$/.test(halftoken) ||
				!authcode
			) {
				return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
			}
			const wiki = this.db.getWikiByPrefix(halftoken);
			if (!wiki || !wiki.authcode || !constantTimeEqual(authcode, wiki.authcode)) {
				return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
			}
			wikiToken = wiki.token;
		}
		let pushChan: BroadcastChannel;
		let pingTimer: ReturnType<typeof setInterval> | undefined;
		return new Response(
			new ReadableStream({
				start(ctrl) {
					ctrl.enqueue('event: hi\ndata: 1\n\n'); // seems to ensure the 'open' event is fired?
					pushChan = new BroadcastChannel(wikiToken);
					pushChan.onmessage = (evt) => {
						try {
							if (evt.data.exclude !== browserToken) ctrl.enqueue('event: sync\ndata: 1\n\n');
						} catch {
							clearInterval(pingTimer);
							pushChan.close();
						}
					};
					if (pingIntervalMs > 0) {
						pingTimer = setInterval(() => {
							try {
								ctrl.enqueue(': keepalive\n\n');
							} catch {
								clearInterval(pingTimer);
								pushChan.close();
							}
						}, pingIntervalMs);
					}
				},
				cancel() {
					pushChan.close();
					if (pingTimer !== undefined) clearInterval(pingTimer);
				},
			}).pipeThrough(new TextEncoderStream()),
			{
				headers: {
					...respHdrs,
					'content-type': 'text/event-stream',
					'cache-control': 'no-store',
				},
			},
		);
	}

	preflightResp(methods: string) {
		return new Response(null, {
			headers: {
				...respHdrs,
				'access-control-allow-methods': methods,
				'access-control-allow-headers': '*',
				'access-control-max-age': '86400',
			},
			status: 204,
		});
	}

	@route(['GET', 'HEAD', 'OPTIONS'], '/:halftoken/:filename', (g) => g.filename === 'tid.dly')
	handleAppFile(req: Request, { halftoken, filename }: Record<string, string>) {
		if (!halftoken || halftoken.length < 21 || !/^[A-Za-z0-9_-]+$/.test(halftoken)) {
			return Response.json({ error: 'EEXIST' }, { headers: respHdrs, status: 404 });
		}
		const wiki = this.db.getWikiByPrefix(halftoken);
		if (!wiki) {
			return Response.json({ error: 'EEXIST' }, { headers: respHdrs, status: 404 });
		}
		if (req.method === 'OPTIONS') {
			return this.preflightResp('GET, HEAD, OPTIONS');
		}
		if (filename === 'bootstrap.json') {
			return Response.json({
				endpoint: this.basepath + '/tid.dly',
				state: wiki.salt ? 'existing' : 'fresh',
				salt: wiki.salt,
			}, { headers: { ...respHdrs, 'cache-control': 'no-store' } });
		}
		let file = this.db.getWikiFile(halftoken, filename);
		if (!file) {
			const defaultFile = this.defaultAppFiles.get(filename);
			if (defaultFile) {
				file = {
					etag: decodeBase64Url(defaultFile.etag),
					rawsize: defaultFile.rawsize,
					ctype: defaultFile.ctype,
					body: defaultFile.body,
				};
			} else {
				return Response.json({ error: 'EEXIST' }, { headers: respHdrs, status: 404 });
			}
		}
		const [supportsBrotli, etagstr] = processEtag(file.etag, req.headers);
		// if we decompress and Deno recompresses to something else (gzip) it'll mark the ETag as a weak validator
		const headers = new Headers({
			'content-type': file.ctype,
			'vary': 'Accept-Encoding',
			'cache-control': 'no-cache',
			'etag': etagstr,
			'x-content-type-options': 'nosniff',
			'referrer-policy': 'no-referrer',
			'x-frame-options': 'SAMEORIGIN',
			'cross-origin-opener-policy': 'same-origin',
		});
		if (stripWeak(req.headers.get('if-none-match')) === etagstr) {
			return new Response(null, { status: 304, headers });
		}
		let body: Uint8Array | null = null;
		if (supportsBrotli) {
			headers.set('content-encoding', 'br');
			headers.set('content-length', file.body.length.toString());
			if (req.method !== 'HEAD') {
				body = file.body;
			}
		} else {
			headers.set('content-length', file.rawsize.toString());
			if (req.method !== 'HEAD') {
				body = brotli.decompress(file.body);
			}
		}
		return new Response(body as unknown as BodyInit, { headers });
	}

	@route(['GET', 'POST', 'OPTIONS'], '{/:halftoken}?/tid.dly')
	async handleApiEndpoint(req: Request, _groups?: Record<string, string | undefined>, info?: Deno.ServeHandlerInfo) {
		if (req.method === 'OPTIONS') {
			return this.preflightResp('POST, GET, OPTIONS');
		}
		if (req.method === 'POST') {
			let data: any;
			try {
				data = await req.json();
			} catch (_e) {
				return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
			}
			if (typeof data !== 'object' || !data || data.tiddlypwa !== 1 || !data.op) {
				return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
			}
			if (ADMIN_OPS.has(data.op)) {
				const clientIp = this.#getClientIp(req, info);
				const blocked = this.#checkAdminRateLimit(clientIp);
				if (blocked) return blocked;
				let resp: Response;
				if (data.op === 'list') resp = await this.handleList(data);
				else if (data.op === 'create') resp = await this.handleCreate(data);
				else if (data.op === 'delete') resp = await this.handleDelete(data);
				else if (data.op === 'reauth') resp = await this.handleReauth(data);
				else if (data.op === 'resetapp') resp = await this.handleResetApp(data);
				else resp = await this.handleResetAllApps(data);
				if (resp.status === 401) {
					this.#recordAdminAttempt(clientIp, true);
				} else if (resp.status !== 400 && resp.status !== 429) {
					this.#recordAdminAttempt(clientIp, false);
				}
				return resp;
			}
			if (data.op === 'sync') return this.handleSync(data, req.headers);
			if (data.op === 'verify_auth') return this.handleVerifyAuth(data);
			if (data.op === 'monitor_ticket') return this.handleMonitorTicket(data);
			if (data.op === 'uploadapp') return await this.handleUploadApp(data);
			if (data.op === 'push_info') return await this.handlePushInfo(data);
			if (data.op === 'push_subscribe') return await this.handlePushSubscribe(data);
			if (data.op === 'push_unsubscribe') return this.handlePushUnsubscribe(data);
			if (data.op === 'push_test') return await this.handlePushTest(data);
			if (data.op === 'sync_schedules') return this.handleSyncSchedules(data);
			if (data.op === 'sync_watchers') return await this.handleSyncWatchers(data);
			if (data.op === 'list_watchers') return this.handleListWatchers(data);
			if (data.op === 'run_watcher') return await this.handleRunWatcher(data);
		}
		if (req.method === 'GET') {
			const query = new URL(req.url).searchParams;
			if (query.get('op') === 'monitor') return this.handleMonitor(query);
		}
		return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
	}

	@route(['GET', 'HEAD'], '/')
	handleHomePage(req: Request) {
		const html = renderHomePage(this.defaultAppVersion);
		const headers = new Headers({
			'content-type': 'text/html;charset=utf-8',
			'content-length': utfenc.encode(html).length.toString(),
			'cache-control': 'no-cache',
			'x-content-type-options': 'nosniff',
			'x-frame-options': 'SAMEORIGIN',
			'referrer-policy': 'no-referrer',
			'cross-origin-opener-policy': 'same-origin',
			'content-security-policy':
				"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';",
		});
		return new Response(req.method === 'HEAD' ? null : html, { headers });
	}

	async handle(req: Request, info?: Deno.ServeHandlerInfo): Promise<Response> {
		let effectiveReq = req;
		if (this.basepath) {
			const url = new URL(req.url);
			if (url.pathname === this.basepath || url.pathname.startsWith(this.basepath + '/')) {
				const strippedPath = url.pathname.slice(this.basepath.length) || '/';
				url.pathname = strippedPath;
				effectiveReq = new Request(url.toString(), req);
			}
		}
		return this.handleAppFile(effectiveReq, {/* XXX: decorators 2 don't affect types.. */}) ||
			await this.handleApiEndpoint(effectiveReq, undefined, info) ||
			this.handleHomePage(effectiveReq) ||
			Response.json({}, { headers: respHdrs, status: 404 });
	}
}
