/// <reference lib="deno.window" />
/// <reference lib="deno.unstable" />
import * as base64 from 'https://deno.land/std@0.192.0/encoding/base64url.ts';
import * as base64nourl from 'https://deno.land/std@0.192.0/encoding/base64.ts';
import * as argon from 'https://deno.land/x/argon2ian@2.0.0/src/argon2.ts';
import * as brotli from 'https://deno.land/x/brotli@0.1.7/mod.ts';
import { homePage } from './pages.ts';
import { Datastore, Wiki } from './data.d.ts';

const utfenc = new TextEncoder();

// Pending: https://github.com/denoland/deno/issues/19160

function route(methods: string[], pathname: string) {
	const pat = new URLPattern({ pathname });
	const methodSet = new Set(methods);
	const allow = methods.join(', ');
	return function (orig: any, context: ClassMethodDecoratorContext) {
		return function (this: any, req: Request) {
			const match = pat.exec(req.url);
			if (!match) return null;
			if (!methodSet.has(req.method)) return new Response(null, { status: 405, headers: { allow } });
			return orig.apply(this, [req, match.pathname.groups]);
		};
	};
}

function adminAuth(orig: any, context: ClassMethodDecoratorContext) {
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
	return function (orig: any, context: ClassMethodDecoratorContext) {
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
	return [supportsBrotli, '"' + base64.encode(etag.buffer as ArrayBuffer) + (supportsBrotli ? '-b' : '-x') + '"'];
}

function notifyMonitors(token: string, browserToken: string) {
	const chan = new BroadcastChannel(token);
	chan.postMessage({ exclude: browserToken });
	// chan.close(); // -> Uncaught (in promise) BadResource: Bad resource ID ?!
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
		this.adminpwsalt = base64.decode(adminpwsalt);
		this.adminpwhash = base64.decode(adminpwhash);
		this.basepath = basepath;
	}

	adminPasswordCorrect(atoken: string) {
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
		if (Math.abs(new Date(now).getTime() - new Date().getTime()) > 60000) {
			return Response.json({ error: 'ETIMESYNC' }, { headers: respHdrs, status: 400 });
		}
		if ((wiki as Wiki).authcode && authcode !== (wiki as Wiki).authcode) {
			return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
		}
		const modsince = new Date(lastSync);

		// assuming here that the browser would use the same Accept-Encoding as when requesting the page
		const apphtml = this.db.getWikiFile(token, 'app.html');
		const [_, appEtag] = apphtml ? processEtag(apphtml.etag, headers) : [null, null];

		return streamsponse((ctrl) => {
			ctrl.enqueue(`{"appEtag":${JSON.stringify(appEtag)},"serverChanges":[`);

			this.db.transaction(() => {
				if (!(wiki as Wiki).authcode && authcode) this.db.updateWikiAuthcode(token, authcode);
				if (!(wiki as Wiki).salt && salt) this.db.updateWikiSalt(token, salt as string);
				let firstWritten = false;
				for (const { thash, iv, ct, sbiv, sbct, mtime, deleted } of this.db.tiddlersChangedSince(token, modsince)) {
					// console.log('ServHas', base64nourl.encode(thash as Uint8Array), mtime, modsince, mtime < modsince);
					ctrl.enqueue(
						(firstWritten ? '\n,' : '\n') + JSON.stringify({
							thash: thash ? base64nourl.encode(thash.buffer as ArrayBuffer) : null,
							iv: iv ? base64nourl.encode(iv.buffer as ArrayBuffer) : null,
							ct: ct ? base64nourl.encode(ct.buffer as ArrayBuffer) : null,
							sbiv: sbiv ? base64nourl.encode(sbiv.buffer as ArrayBuffer) : null,
							sbct: sbct ? base64nourl.encode(sbct.buffer as ArrayBuffer) : null,
							mtime,
							deleted,
						}),
					);
					if (!firstWritten) firstWritten = true;
				}
				// console.log('ClntChg', clientChanges);
				for (const { thash, iv, ct, sbiv, sbct, mtime, deleted } of clientChanges) {
					this.db.upsertTiddler(token, {
						thash: base64nourl.decode(thash),
						iv: iv && base64nourl.decode(iv),
						ct: ct && base64nourl.decode(ct),
						sbiv: sbiv && base64nourl.decode(sbiv),
						sbct: sbct && base64nourl.decode(sbct),
						mtime: new Date(mtime || now),
						deleted: deleted || false,
					});
				}
			});
			ctrl.enqueue('\n]}');
			ctrl.close();
			if (clientChanges.length > 0 && typeof browserToken === 'string') notifyMonitors(token, browserToken);
		}, {
			headers: { ...respHdrs, 'content-type': 'application/json' },
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
		const token = base64.encode(crypto.getRandomValues(new Uint8Array(32)).buffer);
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

	handleMonitor(query: URLSearchParams) {
		const token = query.get('token');
		const browserToken = query.get('browserToken');
		if (!token || !browserToken) {
			return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
		}
		if (!this.db.getWiki(token)) {
			return Response.json({ error: 'EAUTH' }, { headers: respHdrs, status: 401 });
		}
		let pushChan: BroadcastChannel;
		return new Response(
			new ReadableStream({
				start(ctrl) {
					ctrl.enqueue('event: hi\ndata: 1\n\n'); // seems to ensure the 'open' event is fired?
					pushChan = new BroadcastChannel(token);
					pushChan.onmessage = (evt) => {
						if (evt.data.exclude !== browserToken) ctrl.enqueue('event: sync\ndata: 1\n\n');
					};
				},
				cancel() {
					pushChan.close();
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
		const wiki = this.db.getWikiByPrefix(halftoken);
		if (!wiki || halftoken.length < 21) {
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
		const file = this.db.getWikiFile(halftoken, filename);
		if (!file) {
			return Response.json({ error: 'EEXIST' }, { headers: respHdrs, status: 404 });
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
		let body;
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
		return new Response(body, { headers });
	}

	@route(['GET', 'POST', 'OPTIONS'], '/tid.dly')
	async handleApiEndpoint(req: Request) {
		if (req.method === 'OPTIONS') {
			return this.preflightResp('POST, GET, OPTIONS');
		}
		if (req.method === 'POST') {
			const data = await req.json();
			if (typeof data !== 'object' || data.tiddlypwa !== 1 || !data.op) {
				return Response.json({ error: 'EPROTO' }, { headers: respHdrs, status: 400 });
			}
			if (data.op === 'sync') return this.handleSync(data, req.headers);
			if (data.op === 'list') return this.handleList(data);
			if (data.op === 'create') return this.handleCreate(data);
			if (data.op === 'delete') return this.handleDelete(data);
			if (data.op === 'reauth') return this.handleReauth(data);
			if (data.op === 'uploadapp') return await this.handleUploadApp(data);
		}
		if (req.method === 'GET') {
			const query = new URL(req.url).searchParams;
			if (query.get('op') === 'monitor') return this.handleMonitor(query);
		}
		return Response.json({ error: 'EPROTO' });
	}

	@route(['GET', 'HEAD'], '/')
	handleHomePage(req: Request) {
		const headers = new Headers({
			'content-type': 'text/html;charset=utf-8',
			'content-length': homePage.length.toString(),
			'cache-control': 'no-cache',
			'x-content-type-options': 'nosniff',
			'x-frame-options': 'SAMEORIGIN',
			'content-security-policy':
				"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';",
		});
		return new Response(req.method === 'HEAD' ? null : homePage, { headers });
	}

	async handle(req: Request): Promise<Response> {
		return this.handleAppFile(req, {/* XXX: decorators 2 don't affect types.. */}) ||
			await this.handleApiEndpoint(req) ||
			this.handleHomePage(req) ||
			Response.json({}, { headers: respHdrs, status: 404 });
	}
}
