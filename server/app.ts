import { decodeBase64Url, encodeBase64Url } from '@std/encoding/base64url';
import { decodeBase64, encodeBase64 } from '@std/encoding/base64';
import * as argon from 'argon2ian';
import * as brotli from 'brotli';
import { homePage } from './pages.ts';
import { Datastore, Tiddler, Wiki } from './data.d.ts';

const utfenc = new TextEncoder();

// Pending: https://github.com/denoland/deno/issues/19160

function route(methods: string[], pathname: string) {
	const pat = new URLPattern({ pathname });
	const methodSet = new Set(methods);
	const allow = methods.join(', ');
	return function (orig: any, _context: ClassMethodDecoratorContext) {
		return function (this: any, req: Request) {
			const match = pat.exec(req.url);
			if (!match) return null;
			if (!methodSet.has(req.method)) return new Response(null, { status: 405, headers: { allow } });
			return orig.apply(this, [req, match.pathname.groups]);
		};
	};
}

function adminAuth(orig: any, _context: ClassMethodDecoratorContext) {
	return function (this: any, data: Record<string, unknown>) {
		if (typeof data.atoken !== 'string') {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		if (!(this as TiddlyPWASyncApp).adminPasswordCorrect(data.atoken)) {
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

const respHdrs = { 'access-control-allow-origin': '*' };

function stripWeak(x: string | null) {
	return x && (x.startsWith('W/') ? x.slice(2) : x);
}

function supportsEncoding(headers: Headers, enc: string): boolean {
	return !!headers.get('accept-encoding')?.split(',').find((x) => x.trim().split(';')[0] === enc);
}

function processEtag(etag: Uint8Array, headers: Headers): [boolean, string] {
	const supportsBrotli = supportsEncoding(headers, 'br');
	return [supportsBrotli, '"' + encodeBase64Url(etag) + (supportsBrotli ? '-b' : '-x') + '"'];
}

const monitorChannels = new Map<string, BroadcastChannel>();
function notifyMonitors(token: string, browserToken: string) {
	let chan = monitorChannels.get(token);
	if (!chan) {
		chan = new BroadcastChannel(token);
		monitorChannels.set(token, chan);
	}
	chan.postMessage({ exclude: browserToken });
}

// ReadableStreamDefaultControllerCallback is deprecated
type CtrlCb<R> = (controller: ReadableStreamDefaultController<R>) => void | PromiseLike<void>;

function streamsponse(start: CtrlCb<string>, init: ResponseInit | undefined) {
	return new Response(new ReadableStream({ start }).pipeThrough(new TextEncoderStream()), init);
}

export class TiddlyPWASyncApp {
	db: Datastore;
	adminpwsalt: Uint8Array;
	adminpwhash: Uint8Array;
	basepath: string;

	constructor(db: Datastore, adminpwsalt: string, adminpwhash: string, basepath: string = '') {
		this.db = db;
		this.adminpwsalt = decodeBase64Url(adminpwsalt);
		this.adminpwhash = decodeBase64Url(adminpwhash);
		this.basepath = basepath.endsWith('/') ? basepath.slice(0, -1) : basepath;
	}

	defaultAppFiles: Map<string, { etag: string; rawsize: number; ctype: string; body: Uint8Array }> = new Map();

	async loadDefaultApp(dir = 'server/default_app') {
		for (const name of ['app.html', 'sw.js']) {
			try {
				const meta = JSON.parse(await Deno.readTextFile(`${dir}/${name}.meta.json`));
				const body = await Deno.readFile(`${dir}/${name}.br`);
				this.defaultAppFiles.set(name, { etag: meta.etag, rawsize: meta.rawsize, ctype: meta.ctype, body });
			} catch {
				// Default app files not available — new wikis will 404 until app is uploaded
			}
		}
	}

	adminPasswordCorrect(atoken: string) {
		if (this.adminpwsalt.length === 0 || this.adminpwhash.length === 0) return false;
		return argon.verify(utfenc.encode(atoken), this.adminpwsalt, this.adminpwhash);
	}

	@getWiki('EAUTH')
	handleSync(
		{ wiki, token, browserToken, authcode, salt, now, clientChanges, lastSync }: Record<string, unknown>,
		headers: Headers,
	) {
		if (
			typeof token !== 'string' || typeof authcode !== 'string' || typeof now !== 'string' ||
			typeof lastSync !== 'string' || (salt && typeof salt !== 'string') ||
			!Array.isArray(clientChanges)
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
		if ((wiki as Wiki).authcode && authcode !== (wiki as Wiki).authcode) {
			return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
		}

		const decodedChanges: Tiddler[] = [];
		try {
			for (const change of clientChanges) {
				if (!change || typeof change !== 'object' || typeof change.thash !== 'string') {
					return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
				}
				const { thash, iv, ct, sbiv, sbct, mtime, deleted, baseMtime } = change;
				const itemMtime = mtime ? new Date(mtime) : nowDate;
				if (!Number.isFinite(itemMtime.getTime())) {
					return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
				}
				let itemBaseMtime: Date | undefined;
				if (baseMtime !== undefined && baseMtime !== null) {
					itemBaseMtime = new Date(baseMtime);
					if (!Number.isFinite(itemBaseMtime.getTime())) {
						return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
					}
				}
				decodedChanges.push({
					thash: decodeBase64(thash),
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

		return streamsponse((ctrl) => {
			ctrl.enqueue(`{"appEtag":${JSON.stringify(appEtag)},"serverChanges":[`);

			let hasWritten = false;
			const conflicts: string[] = [];

			this.db.transaction(() => {
				if (!(wiki as Wiki).authcode && authcode) this.db.updateWikiAuthcode(token, authcode);
				if (!(wiki as Wiki).salt && salt) this.db.updateWikiSalt(token, salt as string);
				let firstWritten = false;
				const streamedHashes = new Set<string>();

				for (const { thash, iv, ct, sbiv, sbct, mtime, deleted } of this.db.tiddlersChangedSince(token, modsince)) {
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
				for (const change of decodedChanges) {
					const res = this.db.upsertTiddler(token, change);
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
					}
				}
			});
			if (conflicts.length > 0) {
				ctrl.enqueue(`\n],"conflicts":${JSON.stringify(conflicts)}}`);
			} else {
				ctrl.enqueue('\n]}');
			}
			ctrl.close();
			if (hasWritten && typeof browserToken === 'string') notifyMonitors(token, browserToken);
		}, {
			headers: { ...respHdrs, 'content-type': 'application/json', 'x-server-time': nowDate.toISOString() },
		});
	}

	@adminAuth
	handleList(_: unknown) {
		return Response.json({ wikis: this.db.listWikis() }, { headers: respHdrs, status: 200 });
	}

	@adminAuth
	handleCreate({ note }: Record<string, unknown>) {
		if (note !== undefined && typeof note !== 'string') {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		const token = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
		this.db.createWiki(token, note);
		return Response.json({ token }, { headers: respHdrs, status: 201 });
	}

	@adminAuth
	@getWiki('EEXIST')
	handleDelete({ token }: Record<string, unknown>) {
		this.db.deleteWiki(token as string);
		return Response.json({}, { headers: respHdrs, status: 200 });
	}

	@adminAuth
	@getWiki('EEXIST')
	handleReauth({ token }: Record<string, unknown>) {
		this.db.updateWikiAuthcode(token as string, undefined);
		return Response.json({}, { headers: respHdrs, status: 200 });
	}

	@adminAuth
	@getWiki('EEXIST')
	handleResetApp({ token }: Record<string, unknown>) {
		this.db.dissociateFiles(token as string);
		return Response.json({}, { headers: respHdrs, status: 200 });
	}

	@adminAuth
	handleResetAllApps(_: unknown) {
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
		if (typeof files !== 'object' || !files) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		for (const [filename, value] of Object.entries(files)) {
			if (
				typeof filename !== 'string' || typeof value !== 'object' || !value ||
				typeof (value as any).body !== 'string' || typeof (value as any).ctype !== 'string'
			) {
				return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
			}
		}
		if ((wiki as Wiki).authcode && authcode !== (wiki as Wiki).authcode) {
			return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
		}
		const uploads = await Promise.all(
			Object.entries(files).map(async ([filename, value]) => {
				const { body, ctype } = value as any;
				const utf = utfenc.encode(body);
				const etag = new Uint8Array(await crypto.subtle.digest('SHA-1', utf));
				return { filename, etag, utf, ctype };
			}),
		);
		this.db.transaction(() => {
			for (const { filename, etag, utf, ctype } of uploads) {
				if (!this.db.fileExists(etag)) {
					this.db.storeFile({
						etag,
						rawsize: utf.length,
						ctype,
						body: brotli.compress(utf, 4096, 8),
					});
				}
				this.db.associateFile(token, etag, filename);
			}
		});
		if (typeof browserToken === 'string') notifyMonitors(token, browserToken);
		return Response.json({ urlprefix: token.slice(0, token.length / 2) + '/' }, { headers: respHdrs, status: 200 });
	}

	handleMonitor(query: URLSearchParams, pingIntervalMs = 25000) {
		const token = query.get('token');
		const browserToken = query.get('browserToken');
		if (!token || !browserToken) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		if (!this.db.getWiki(token)) {
			return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
		}
		let pushChan: BroadcastChannel;
		let pingTimer: ReturnType<typeof setInterval> | undefined;
		return new Response(
			new ReadableStream({
				start(ctrl) {
					ctrl.enqueue('event: hi\ndata: 1\n\n'); // seems to ensure the 'open' event is fired?
					pushChan = new BroadcastChannel(token);
					pushChan.onmessage = (evt) => {
						if (evt.data.exclude !== browserToken) ctrl.enqueue('event: sync\ndata: 1\n\n');
					};
					if (pingIntervalMs > 0) {
						pingTimer = setInterval(() => {
							try {
								ctrl.enqueue(': keepalive\n\n');
							} catch {
								clearInterval(pingTimer);
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

	@route(['GET', 'HEAD', 'OPTIONS'], '/:halftoken/:filename')
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
			}, { headers: respHdrs });
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

	@route(['GET', 'POST', 'OPTIONS'], '/tid.dly')
	async handleApiEndpoint(req: Request) {
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
			if (data.op === 'sync') return this.handleSync(data, req.headers);
			if (data.op === 'list') return this.handleList(data);
			if (data.op === 'create') return this.handleCreate(data);
			if (data.op === 'delete') return this.handleDelete(data);
			if (data.op === 'reauth') return this.handleReauth(data);
			if (data.op === 'resetapp') return this.handleResetApp(data);
			if (data.op === 'resetallapps') return this.handleResetAllApps(data);
			if (data.op === 'uploadapp') return await this.handleUploadApp(data);
		}
		if (req.method === 'GET') {
			const query = new URL(req.url).searchParams;
			if (query.get('op') === 'monitor') return this.handleMonitor(query);
		}
		return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
	}

	@route(['GET', 'HEAD'], '/')
	handleHomePage(req: Request) {
		const headers = new Headers({
			'content-type': 'text/html;charset=utf-8',
			'content-length': new TextEncoder().encode(homePage).length.toString(),
			'cache-control': 'no-cache',
			'x-content-type-options': 'nosniff',
			'x-frame-options': 'SAMEORIGIN',
			'content-security-policy':
				"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';",
		});
		return new Response(req.method === 'HEAD' ? null : homePage, { headers });
	}

	async handle(req: Request): Promise<Response> {
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
			await this.handleApiEndpoint(effectiveReq) ||
			this.handleHomePage(effectiveReq) ||
			Response.json({}, { headers: respHdrs, status: 404 });
	}
}
