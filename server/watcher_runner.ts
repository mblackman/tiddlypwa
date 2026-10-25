import { encodeBase64 } from '@std/encoding/base64';
import { decodeBase64Url, encodeBase64Url } from '@std/encoding/base64url';
import { Datastore, WatcherModuleRow } from './data.d.ts';
import { broadcastWikiPush, VapidKeys } from './webpush.ts';

const utfenc = new TextEncoder();
const utfdec = new TextDecoder();

export type WatchedItem = {
	title: string;
	fields: Record<string, string>;
};

export type WatcherSignablePayload = {
	watcherId: string;
	codeHash: string;
	allowedHosts: string;
	scheduleCron: string;
	timezone: string;
	watchedItems: WatchedItem[];
};

export type WatcherHttpCacheEntry = {
	etag?: string;
	lastModified?: string;
};

export type WatcherState = {
	httpCache?: Record<string, WatcherHttpCacheEntry>;
	custom?: Record<string, unknown>;
};

export type WatcherActionPatch = {
	patchTarget?: { title: string; fields: Record<string, string> };
	createTiddler?: { title: string; fields?: Record<string, string>; [k: string]: unknown };
	navigateTo?: string;
	openUrl?: string;
	hookData?: unknown;
};

export type WatcherResultItem = {
	itemTitle?: string;
	notify?: {
		title: string;
		body?: string;
		icon?: string;
		tag?: string;
		navigateTo?: string | null;
		openUrl?: string;
		clickAction?: 'navigate' | 'open-url' | 'none';
		actions?: Array<{ action: string; title: string }>;
		actionPatches?: Record<string, WatcherActionPatch>;
		data?: Record<string, unknown>;
	};
	patchTarget?: { title: string; fields: Record<string, string> };
	createTiddler?: { title: string; fields?: Record<string, string>; [k: string]: unknown };
	actionPatches?: Record<string, WatcherActionPatch>;
};

export type DnsResolverFn = (hostname: string, recordType: 'A' | 'AAAA') => Promise<string[]>;

export type WatcherRunnerOptions = {
	timeoutMs?: number;
	maxResponseBytes?: number;
	maxRedirects?: number;
	fetchFn?: typeof fetch;
	resolveDnsFn?: DnsResolverFn;
	nowMs?: number;
	subject?: string;
	pushFetchFn?: typeof fetch;
};

export async function computeCodeHash(codeSource: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', utfenc.encode(codeSource));
	return encodeBase64Url(new Uint8Array(digest));
}

export function canonicalizeWatchedItems(items: WatchedItem[]): WatchedItem[] {
	return items.map((item) => {
		const sortedFields: Record<string, string> = {};
		const keys = Object.keys(item.fields || {}).sort();
		for (const k of keys) {
			sortedFields[k] = String(item.fields[k] ?? '');
		}
		return {
			title: String(item.title ?? ''),
			fields: sortedFields,
		};
	});
}

export function serializeWatcherSignablePayload(payload: WatcherSignablePayload): Uint8Array {
	return utfenc.encode(
		JSON.stringify({
			watcherId: payload.watcherId,
			codeHash: payload.codeHash,
			allowedHosts: payload.allowedHosts,
			scheduleCron: payload.scheduleCron,
			timezone: payload.timezone,
			watchedItems: canonicalizeWatchedItems(payload.watchedItems),
		}),
	);
}

export async function verifyWatcherSignature(
	pubkeyB64Url: string,
	payload: WatcherSignablePayload,
	signatureB64Url: string,
): Promise<boolean> {
	try {
		const rawPub = decodeBase64Url(pubkeyB64Url);
		const rawSig = decodeBase64Url(signatureB64Url);
		if (rawPub.byteLength !== 32 || rawSig.byteLength !== 64) {
			return false;
		}
		const key = await crypto.subtle.importKey(
			'raw',
			rawPub as unknown as BufferSource,
			{ name: 'Ed25519' },
			false,
			['verify'],
		);
		const message = serializeWatcherSignablePayload(payload);
		return await crypto.subtle.verify(
			{ name: 'Ed25519' },
			key,
			rawSig as unknown as BufferSource,
			message as unknown as BufferSource,
		);
	} catch (_e) {
		return false;
	}
}

function parseIpv4(ip: string): [number, number, number, number] | null {
	const parts = ip.trim().split('.');
	if (parts.length !== 4) return null;
	const nums: number[] = [];
	for (const p of parts) {
		if (!/^\d{1,3}$/.test(p)) return null;
		const n = Number(p);
		if (n < 0 || n > 255) return null;
		nums.push(n);
	}
	return [nums[0], nums[1], nums[2], nums[3]];
}

function isBlockedIpv4Octets([a, b, c, _d]: [number, number, number, number]): boolean {
	if (a === 0) return true; // 0.0.0.0/8
	if (a === 10) return true; // 10.0.0.0/8 RFC 1918
	if (a === 127) return true; // 127.0.0.0/8 Loopback
	if (a === 169 && b === 254) return true; // 169.254.0.0/16 Link-local / Cloud metadata
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC 1918
	if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC 1918
	if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT / Tailscale
	if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, 192.0.2.0/24
	if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 Benchmark
	if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
	if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
	if (a >= 224) return true; // Multicast & Reserved (224.0.0.0/4, 240.0.0.0/4)
	return false;
}

function parseIpv6Groups(rawIp: string): number[] | null {
	let ip = rawIp.trim().toLowerCase();
	if (ip.startsWith('[') && ip.endsWith(']')) {
		ip = ip.slice(1, -1);
	}
	const zoneIdx = ip.indexOf('%');
	if (zoneIdx !== -1) {
		ip = ip.slice(0, zoneIdx);
	}
	if (!ip.includes(':')) return null;

	// Handle embedded IPv4 at the end (e.g. ::ffff:127.0.0.1)
	const lastColon = ip.lastIndexOf(':');
	const tail = ip.slice(lastColon + 1);
	if (tail.includes('.')) {
		const v4 = parseIpv4(tail);
		if (!v4) return null;
		const hi = ((v4[0] << 8) | v4[1]).toString(16);
		const lo = ((v4[2] << 8) | v4[3]).toString(16);
		ip = ip.slice(0, lastColon + 1) + `${hi}:${lo}`;
	}

	const doubleColonParts = ip.split('::');
	if (doubleColonParts.length > 2) return null;

	const parsePart = (part: string): number[] | null => {
		if (!part) return [];
		const segs = part.split(':');
		const out: number[] = [];
		for (const s of segs) {
			if (!/^[0-9a-f]{1,4}$/.test(s)) return null;
			out.push(parseInt(s, 16));
		}
		return out;
	};

	if (doubleColonParts.length === 2) {
		const left = parsePart(doubleColonParts[0]);
		const right = parsePart(doubleColonParts[1]);
		if (!left || !right) return null;
		const missing = 8 - (left.length + right.length);
		if (missing < 1) return null;
		return [...left, ...Array(missing).fill(0), ...right];
	} else {
		const groups = parsePart(ip);
		if (!groups || groups.length !== 8) return null;
		return groups;
	}
}

export function isBlockedIp(ip: string): boolean {
	const v4 = parseIpv4(ip);
	if (v4) {
		return isBlockedIpv4Octets(v4);
	}
	const v6 = parseIpv6Groups(ip);
	if (!v6) {
		// Unparseable IP literal is treated as blocked
		return true;
	}
	const allZeroPrefix6 = v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0;
	// Unspecified :: or Loopback ::1
	if (allZeroPrefix6 && v6[5] === 0 && v6[6] === 0 && (v6[7] === 0 || v6[7] === 1)) {
		return true;
	}
	// IPv4-mapped ::ffff:0:0/96 or IPv4-compatible ::0:0/96
	if (allZeroPrefix6 && (v6[5] === 0xffff || v6[5] === 0)) {
		const a = (v6[6] >> 8) & 0xff;
		const b = v6[6] & 0xff;
		const c = (v6[7] >> 8) & 0xff;
		const d = v6[7] & 0xff;
		return isBlockedIpv4Octets([a, b, c, d]);
	}
	// IPv4-translated 64:ff9b::/96 or 64:ff9b:1::/48
	if (v6[0] === 0x0064 && v6[1] === 0xff9b) {
		const a = (v6[6] >> 8) & 0xff;
		const b = v6[6] & 0xff;
		const c = (v6[7] >> 8) & 0xff;
		const d = v6[7] & 0xff;
		return isBlockedIpv4Octets([a, b, c, d]);
	}
	// Unique Local Address (ULA) fc00::/7
	if ((v6[0] & 0xfe00) === 0xfc00) return true;
	// Link-local fe80::/10
	if ((v6[0] & 0xffc0) === 0xfe80) return true;
	// Site-local deprecated fec0::/10
	if ((v6[0] & 0xffc0) === 0xfec0) return true;
	// Multicast ff00::/8
	if ((v6[0] & 0xff00) === 0xff00) return true;
	// Documentation 2001:db8::/32
	if (v6[0] === 0x2001 && v6[1] === 0x0db8) return true;

	return false;
}

export function parseAllowedHosts(allowedHostsRaw: string): Set<string> {
	const set = new Set<string>();
	for (const part of allowedHostsRaw.split(/[\s,]+/)) {
		const trimmed = part.trim().toLowerCase();
		if (trimmed) set.add(trimmed);
	}
	return set;
}

const defaultResolveDns: DnsResolverFn = async (hostname, recordType) => {
	try {
		return await Deno.resolveDns(hostname, recordType);
	} catch (_e) {
		return [];
	}
};

export async function validateUrlAgainstSsrf(
	rawUrl: string,
	allowedHosts: Set<string>,
	resolveDnsFn: DnsResolverFn = defaultResolveDns,
): Promise<URL> {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch (_e) {
		throw new Error(`Invalid URL: ${rawUrl}`);
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new Error(`Disallowed protocol "${parsed.protocol}" in URL: ${rawUrl}`);
	}
	const hostname = parsed.hostname.toLowerCase();
	if (!allowedHosts.has(hostname)) {
		throw new Error(`Host "${hostname}" is not in allowed-hosts (${[...allowedHosts].join(', ')})`);
	}

	// Check if hostname is already an IP literal
	if (parseIpv4(hostname) || hostname.startsWith('[') || hostname.includes(':')) {
		if (isBlockedIp(hostname)) {
			throw new Error(`SSRF blocked IP address for host "${hostname}"`);
		}
		return parsed;
	}

	const [aRecords, aaaaRecords] = await Promise.all([
		resolveDnsFn(hostname, 'A'),
		resolveDnsFn(hostname, 'AAAA'),
	]);
	const allIps = [...aRecords, ...aaaaRecords];
	if (allIps.length === 0) {
		throw new Error(`DNS resolution returned no A/AAAA records for host "${hostname}"`);
	}
	for (const ip of allIps) {
		if (isBlockedIp(ip)) {
			throw new Error(`SSRF blocked resolved IP "${ip}" for host "${hostname}"`);
		}
	}
	return parsed;
}

export async function safeHostFetch(
	rawUrl: string,
	fetchOpts: { cacheKey?: string; headers?: Record<string, string> } | undefined,
	allowedHosts: Set<string>,
	nextState: WatcherState,
	options?: WatcherRunnerOptions,
): Promise<{ ok: boolean; status: number; notModified: boolean; body: string; headers: Record<string, string> }> {
	const maxRedirects = options?.maxRedirects ?? 3;
	const maxBytes = options?.maxResponseBytes ?? 2 * 1024 * 1024;
	const fetchFn = options?.fetchFn ?? fetch;
	const resolveDnsFn = options?.resolveDnsFn ?? defaultResolveDns;
	const cacheKey = typeof fetchOpts?.cacheKey === 'string' && fetchOpts.cacheKey.trim()
		? fetchOpts.cacheKey.trim()
		: null;

	let currentUrl = rawUrl;
	for (let hop = 0; hop <= maxRedirects; hop++) {
		const validatedUrl = await validateUrlAgainstSsrf(currentUrl, allowedHosts, resolveDnsFn);
		const reqHeaders = new Headers();
		reqHeaders.set('User-Agent', 'TiddlyPWA-Watcher/1.0');
		if (fetchOpts?.headers && typeof fetchOpts.headers === 'object') {
			for (const [k, v] of Object.entries(fetchOpts.headers)) {
				const lower = k.toLowerCase();
				if (lower === 'host' || lower === 'authorization' || lower === 'cookie') continue;
				if (typeof v === 'string') reqHeaders.set(k, v);
			}
		}

		if (cacheKey && nextState.httpCache?.[cacheKey]) {
			const cached = nextState.httpCache[cacheKey];
			if (cached.etag) reqHeaders.set('If-None-Match', cached.etag);
			if (cached.lastModified) reqHeaders.set('If-Modified-Since', cached.lastModified);
		}

		const resp = await fetchFn(validatedUrl.toString(), {
			method: 'GET',
			headers: reqHeaders,
			redirect: 'manual',
		});

		if ([301, 302, 303, 307, 308].includes(resp.status)) {
			const location = resp.headers.get('location');
			try {
				await resp.body?.cancel();
			} catch (_e) {
				// ignore
			}
			if (!location) {
				throw new Error(`Redirect response ${resp.status} missing Location header`);
			}
			if (hop === maxRedirects) {
				throw new Error(`Exceeded maximum redirect hops (${maxRedirects})`);
			}
			currentUrl = new URL(location, validatedUrl).toString();
			continue;
		}

		if (resp.status === 304) {
			try {
				await resp.body?.cancel();
			} catch (_e) {
				// ignore
			}
			return {
				ok: false,
				status: 304,
				notModified: true,
				body: '',
				headers: Object.fromEntries(resp.headers.entries()),
			};
		}

		let bodyBytes = new Uint8Array(0);
		if (resp.body) {
			const reader = resp.body.getReader();
			const chunks: Uint8Array[] = [];
			let total = 0;
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value) {
						total += value.byteLength;
						if (total > maxBytes) {
							await reader.cancel();
							throw new Error(`Response body exceeds maximum size limit (${maxBytes} bytes)`);
						}
						chunks.push(value);
					}
				}
			} finally {
				try {
					reader.releaseLock();
				} catch (_e) {
					// ignore
				}
			}
			bodyBytes = new Uint8Array(total);
			let offset = 0;
			for (const chunk of chunks) {
				bodyBytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
		}

		const bodyText = utfdec.decode(bodyBytes);
		if (cacheKey && resp.status >= 200 && resp.status < 300) {
			const etag = resp.headers.get('etag') || undefined;
			const lastModified = resp.headers.get('last-modified') || undefined;
			if (etag || lastModified) {
				if (!nextState.httpCache) nextState.httpCache = {};
				nextState.httpCache[cacheKey] = {
					...(etag ? { etag } : {}),
					...(lastModified ? { lastModified } : {}),
				};
			}
		}

		return {
			ok: resp.ok,
			status: resp.status,
			notModified: false,
			body: bodyText,
			headers: Object.fromEntries(resp.headers.entries()),
		};
	}

	throw new Error('Failed to fetch URL');
}

export function extractJsonLd(html: string, schemaType?: string): Record<string, unknown>[] {
	if (typeof html !== 'string' || !html) return [];
	const scriptRegex = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
	const collected: Record<string, unknown>[] = [];

	const collectNode = (node: unknown) => {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const item of node) collectNode(item);
			return;
		}
		const obj = node as Record<string, unknown>;
		if (Array.isArray(obj['@graph'])) {
			for (const item of obj['@graph']) collectNode(item);
		}
		if (!schemaType) {
			collected.push(obj);
			return;
		}
		const rawType = obj['@type'];
		const matches = rawType === schemaType ||
			(Array.isArray(rawType) && rawType.includes(schemaType)) ||
			(typeof rawType === 'string' && rawType.endsWith(`/${schemaType}`));
		if (matches) {
			collected.push(obj);
		}
	};

	let match: RegExpExecArray | null;
	while ((match = scriptRegex.exec(html)) !== null) {
		const rawJson = match[1].trim();
		if (!rawJson) continue;
		try {
			const parsed = JSON.parse(rawJson);
			collectNode(parsed);
		} catch (_e) {
			// Ignore malformed JSON-LD blocks
		}
	}
	return collected;
}

export function decodeHtmlEntities(str: string): string {
	if (!str || !str.includes('&')) return str;
	return str
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&apos;/gi, "'")
		.replace(/&#39;/g, "'")
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
			const cp = parseInt(hex, 16);
			return Number.isFinite(cp) ? String.fromCodePoint(cp) : _;
		})
		.replace(/&#(\d+);/g, (_, dec) => {
			const cp = parseInt(dec, 10);
			return Number.isFinite(cp) ? String.fromCodePoint(cp) : _;
		});
}

type HtmlNode = {
	tag: string;
	attrs: Record<string, string>;
	children: Array<HtmlNode | string>;
	parent: HtmlNode | null;
};

const VOID_HTML_TAGS = new Set([
	'area',
	'base',
	'br',
	'col',
	'embed',
	'hr',
	'img',
	'input',
	'link',
	'meta',
	'param',
	'source',
	'track',
	'wbr',
]);

function parseAttrs(attrString: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const attrRegex = /([a-zA-Z0-9_:@.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
	let m: RegExpExecArray | null;
	while ((m = attrRegex.exec(attrString)) !== null) {
		const name = m[1].toLowerCase();
		const val = m[2] ?? m[3] ?? m[4] ?? '';
		attrs[name] = decodeHtmlEntities(val);
	}
	return attrs;
}

function serializeInnerHtml(node: HtmlNode): string {
	let out = '';
	for (const child of node.children) {
		if (typeof child === 'string') {
			out += child;
		} else {
			const attrStr = Object.entries(child.attrs)
				.map(([k, v]) => ` ${k}="${v.replace(/"/g, '&quot;')}"`)
				.join('');
			if (VOID_HTML_TAGS.has(child.tag)) {
				out += `<${child.tag}${attrStr}>`;
			} else {
				out += `<${child.tag}${attrStr}>${serializeInnerHtml(child)}</${child.tag}>`;
			}
		}
	}
	return out;
}

function extractTextContent(node: HtmlNode): string {
	let out = '';
	for (const child of node.children) {
		if (typeof child === 'string') {
			out += decodeHtmlEntities(child);
		} else {
			out += extractTextContent(child);
		}
	}
	return out;
}

function parseSimpleHtmlTree(html: string): HtmlNode {
	const cleaned = html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<!DOCTYPE[^>]*>/gi, '');

	const root: HtmlNode = { tag: '#root', attrs: {}, children: [], parent: null };
	let current: HtmlNode = root;

	const tokenRegex = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)\b([^>]*?)(\/?)>|([^<]+|<)/g;
	let m: RegExpExecArray | null;
	while ((m = tokenRegex.exec(cleaned)) !== null) {
		const fullMatch = m[0];
		if (m[4] !== undefined) {
			current.children.push(m[4]);
			continue;
		}
		const isClosing = fullMatch.startsWith('</');
		const tag = m[1].toLowerCase();
		const attrPart = m[2] || '';
		const selfClosing = m[3] === '/' || VOID_HTML_TAGS.has(tag);

		if (isClosing) {
			let ptr: HtmlNode | null = current;
			while (ptr && ptr !== root) {
				if (ptr.tag === tag) {
					current = ptr.parent || root;
					break;
				}
				ptr = ptr.parent;
			}
		} else {
			const node: HtmlNode = {
				tag,
				attrs: parseAttrs(attrPart),
				children: [],
				parent: current,
			};
			current.children.push(node);
			if (!selfClosing) {
				if (tag === 'script' || tag === 'style') {
					const closeRegex = new RegExp(`([\\s\\S]*?)<\\/${tag}\\s*>`, 'i');
					closeRegex.lastIndex = tokenRegex.lastIndex;
					const sub = cleaned.slice(tokenRegex.lastIndex);
					const closeMatch = closeRegex.exec(sub);
					if (closeMatch) {
						node.children.push(closeMatch[1]);
						tokenRegex.lastIndex += closeMatch.index + closeMatch[0].length;
					}
				} else {
					current = node;
				}
			}
		}
	}
	return root;
}

type CompoundSelector = {
	tag: string | null;
	id: string | null;
	classes: string[];
	attrs: Array<{ name: string; op: string | null; val: string | null }>;
};

type SelectorStep = {
	combinator: 'descendant' | 'child';
	compound: CompoundSelector;
};

function parseCompoundSelector(raw: string): CompoundSelector {
	let rem = raw.trim();
	const attrs: Array<{ name: string; op: string | null; val: string | null }> = [];
	rem = rem.replace(
		/\[\s*([a-zA-Z0-9_:@.-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]]*?)))?\s*\]/g,
		(_, name, op, v1, v2, v3) => {
			attrs.push({
				name: name.toLowerCase(),
				op: op || null,
				val: (v1 ?? v2 ?? v3 ?? '').trim(),
			});
			return '';
		},
	);

	let id: string | null = null;
	rem = rem.replace(/#([a-zA-Z0-9_-]+)/g, (_, idVal) => {
		id = idVal;
		return '';
	});

	const classes: string[] = [];
	rem = rem.replace(/\.([a-zA-Z0-9_-]+)/g, (_, clsVal) => {
		classes.push(clsVal);
		return '';
	});

	const tag = rem.trim() && rem.trim() !== '*' ? rem.trim().toLowerCase() : null;
	return { tag, id, classes, attrs };
}

function parseSelectorChain(selectorStr: string): SelectorStep[] {
	const normalized = selectorStr.trim().replace(/\s*>\s*/g, ' > ').replace(/\s+/g, ' ');
	if (!normalized) return [];
	const parts = normalized.split(' ');
	const steps: SelectorStep[] = [];
	let nextCombinator: 'descendant' | 'child' = 'descendant';
	for (const p of parts) {
		if (p === '>') {
			nextCombinator = 'child';
			continue;
		}
		steps.push({
			combinator: nextCombinator,
			compound: parseCompoundSelector(p),
		});
		nextCombinator = 'descendant';
	}
	return steps;
}

function matchesCompound(node: HtmlNode, comp: CompoundSelector): boolean {
	if (node.tag === '#root') return false;
	if (comp.tag && node.tag !== comp.tag) return false;
	if (comp.id && node.attrs.id !== comp.id) return false;
	if (comp.classes.length > 0) {
		const nodeClasses = new Set((node.attrs.class || '').split(/\s+/).filter(Boolean));
		for (const c of comp.classes) {
			if (!nodeClasses.has(c)) return false;
		}
	}
	for (const attr of comp.attrs) {
		const actual = node.attrs[attr.name];
		if (actual === undefined) return false;
		if (!attr.op) continue;
		const expected = attr.val ?? '';
		if (attr.op === '=' && actual !== expected) return false;
		if (attr.op === '^=' && !actual.startsWith(expected)) return false;
		if (attr.op === '$=' && !actual.endsWith(expected)) return false;
		if (attr.op === '*=' && !actual.includes(expected)) return false;
		if (attr.op === '~=' && !actual.split(/\s+/).includes(expected)) return false;
		if (attr.op === '|=' && actual !== expected && !actual.startsWith(expected + '-')) return false;
	}
	return true;
}

function matchesChain(node: HtmlNode, chain: SelectorStep[]): boolean {
	if (chain.length === 0) return false;
	if (!matchesCompound(node, chain[chain.length - 1].compound)) return false;

	let currNode: HtmlNode | null = node;
	for (let i = chain.length - 1; i >= 1; i--) {
		const combinator = chain[i].combinator;
		const targetComp = chain[i - 1].compound;
		if (combinator === 'child') {
			const parent: HtmlNode | null = currNode?.parent || null;
			if (!parent || !matchesCompound(parent, targetComp)) return false;
			currNode = parent;
		} else {
			let ancestor: HtmlNode | null = currNode?.parent || null;
			let found: HtmlNode | null = null;
			while (ancestor && ancestor.tag !== '#root') {
				if (matchesCompound(ancestor, targetComp)) {
					found = ancestor;
					break;
				}
				ancestor = ancestor.parent;
			}
			if (!found) return false;
			currNode = found;
		}
	}
	return true;
}

export type QueryHtmlElement = {
	tag: string;
	text: string;
	html: string;
	attrs: Record<string, string>;
};

export function queryHtml(html: string, selector: string): QueryHtmlElement[] {
	if (typeof html !== 'string' || !html || typeof selector !== 'string' || !selector.trim()) {
		return [];
	}
	const root = parseSimpleHtmlTree(html);
	const chains = selector
		.split(',')
		.map((s) => parseSelectorChain(s))
		.filter((c) => c.length > 0);
	if (chains.length === 0) return [];

	const results: QueryHtmlElement[] = [];
	const walk = (node: HtmlNode) => {
		if (node.tag !== '#root') {
			if (chains.some((chain) => matchesChain(node, chain))) {
				results.push({
					tag: node.tag,
					text: extractTextContent(node).trim(),
					html: serializeInnerHtml(node).trim(),
					attrs: { ...node.attrs },
				});
			}
		}
		for (const child of node.children) {
			if (typeof child !== 'string') {
				walk(child);
			}
		}
	};
	walk(root);
	return results;
}

export type ParsedXmlFeedItem = {
	title: string;
	link: string;
	id: string;
	pubDate: string;
	summary: string;
	content: string;
};

export type ParsedXmlFeed = {
	feedTitle: string;
	items: ParsedXmlFeedItem[];
};

function stripCdataAndTags(raw: string): string {
	if (!raw) return '';
	const withoutCdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
	return decodeHtmlEntities(withoutCdata.replace(/<[^>]+>/g, '')).trim();
}

function unwrapCdata(raw: string): string {
	if (!raw) return '';
	const withoutCdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
	return decodeHtmlEntities(withoutCdata).trim();
}

function extractXmlTagContent(block: string, tagNames: string[]): string {
	for (const tag of tagNames) {
		const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const re = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i');
		const m = re.exec(block);
		if (m) return m[1];
	}
	return '';
}

export function parseXml(xml: string): ParsedXmlFeed {
	if (typeof xml !== 'string' || !xml.trim()) {
		return { feedTitle: '', items: [] };
	}

	const items: ParsedXmlFeedItem[] = [];
	const isAtom = /<feed\b/i.test(xml) && /<entry\b/i.test(xml);

	if (isAtom) {
		const firstEntryIdx = xml.search(/<entry\b/i);
		const headerPart = firstEntryIdx !== -1 ? xml.slice(0, firstEntryIdx) : xml;
		const feedTitle = stripCdataAndTags(extractXmlTagContent(headerPart, ['title']));

		const entryRegex = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
		let m: RegExpExecArray | null;
		while ((m = entryRegex.exec(xml)) !== null) {
			const block = m[1];
			const title = stripCdataAndTags(extractXmlTagContent(block, ['title']));
			let link = '';
			const altLinkMatch = /<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i.exec(block) ||
				/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i.exec(block);
			if (altLinkMatch) {
				link = decodeHtmlEntities(altLinkMatch[1]);
			} else {
				link = stripCdataAndTags(extractXmlTagContent(block, ['link']));
			}
			const id = stripCdataAndTags(extractXmlTagContent(block, ['id'])) || link || title;
			const pubDate = stripCdataAndTags(extractXmlTagContent(block, ['published', 'updated', 'dc:date']));
			const summary = unwrapCdata(extractXmlTagContent(block, ['summary']));
			const content = unwrapCdata(extractXmlTagContent(block, ['content'])) || summary;
			items.push({ title, link, id, pubDate, summary, content });
		}
		return { feedTitle, items };
	}

	// RSS 2.0 / RSS 1.0
	const firstItemIdx = xml.search(/<item\b/i);
	const headerPart = firstItemIdx !== -1 ? xml.slice(0, firstItemIdx) : xml;
	const feedTitle = stripCdataAndTags(extractXmlTagContent(headerPart, ['title']));

	const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
	let m: RegExpExecArray | null;
	while ((m = itemRegex.exec(xml)) !== null) {
		const block = m[1];
		const title = stripCdataAndTags(extractXmlTagContent(block, ['title']));
		const link = stripCdataAndTags(extractXmlTagContent(block, ['link']));
		const id = stripCdataAndTags(extractXmlTagContent(block, ['guid', 'id'])) || link || title;
		const pubDate = stripCdataAndTags(extractXmlTagContent(block, ['pubDate', 'dc:date', 'published']));
		const summary = unwrapCdata(extractXmlTagContent(block, ['description', 'summary']));
		const content = unwrapCdata(extractXmlTagContent(block, ['content:encoded', 'content'])) || summary;
		items.push({ title, link, id, pubDate, summary, content });
	}
	return { feedTitle, items };
}

// Serial execution queue so at most 1 watcher Worker runs at a time
let watcherQueueTail: Promise<unknown> = Promise.resolve();

function enqueueWatcherTask<T>(fn: () => Promise<T>): Promise<T> {
	const next = watcherQueueTail.then(fn, fn);
	watcherQueueTail = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

export function runSandboxedWatcher(
	codeSource: string,
	watchedItems: WatchedItem[],
	allowedHostsRaw: string,
	currentState: WatcherState,
	options?: WatcherRunnerOptions,
): Promise<{ results: WatcherResultItem[]; nextState: WatcherState }> {
	return enqueueWatcherTask(() =>
		new Promise((resolve, reject) => {
			const timeoutMs = options?.timeoutMs ?? 8_000;
			const allowedHosts = parseAllowedHosts(allowedHostsRaw);
			const nextState: WatcherState = {
				httpCache: currentState?.httpCache ? structuredClone(currentState.httpCache) : {},
				custom: currentState?.custom ? structuredClone(currentState.custom) : {},
			};

			const codeBase64 = encodeBase64(utfenc.encode(codeSource));
			const moduleDataUrl = `data:application/javascript;base64,${codeBase64}`;

			const bootstrapSource = `
const pendingRpcs = new Map();
let nextRpcId = 1;

function callHost(op, args) {
	return new Promise((resolve, reject) => {
		const id = nextRpcId++;
		pendingRpcs.set(id, { resolve, reject });
		self.postMessage({ type: 'rpc', id, op, args });
	});
}

const host = {
	fetch(url, opts) {
		return callHost('fetch', [url, opts]);
	},
	extractJsonLd(html, schemaType) {
		return callHost('extractJsonLd', [html, schemaType]);
	},
	queryHtml(html, selector) {
		return callHost('queryHtml', [html, selector]);
	},
	parseXml(xml) {
		return callHost('parseXml', [xml]);
	},
	getState(key) {
		return callHost('getState', [key]);
	},
	setState(key, value) {
		return callHost('setState', [key, value]);
	},
	matchRegex(str, pattern, flags) {
		if (typeof str !== 'string') return null;
		const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), flags);
		return re.exec(str);
	},
};

self.onmessage = async (evt) => {
	const msg = evt.data;
	if (!msg || typeof msg !== 'object') return;
	if (msg.type === 'rpc_res') {
		const entry = pendingRpcs.get(msg.id);
		if (!entry) return;
		pendingRpcs.delete(msg.id);
		if (msg.error) {
			entry.reject(new Error(msg.error));
		} else {
			entry.resolve(msg.result);
		}
		return;
	}
	if (msg.type === 'start') {
		try {
			const mod = await import(msg.moduleDataUrl);
			if (typeof mod.evaluate !== 'function') {
				throw new Error('Watcher module must export an async function evaluate(items, host)');
			}
			const results = await mod.evaluate(msg.items, host);
			self.postMessage({ type: 'done', results: Array.isArray(results) ? results : [] });
		} catch (err) {
			self.postMessage({ type: 'error', error: String(err?.message || err) });
		}
	}
};
`;
			const bootstrapUrl = `data:application/javascript;base64,${encodeBase64(utfenc.encode(bootstrapSource))}`;

			let settled = false;
			const worker = new Worker(bootstrapUrl, {
				type: 'module',
				deno: {
					permissions: {
						read: false,
						write: false,
						net: false,
						env: false,
						run: false,
						ffi: false,
						sys: false,
						import: false,
					},
				},
			});

			const watchdog = setTimeout(() => {
				if (settled) return;
				settled = true;
				try {
					worker.terminate();
				} catch (_e) {
					// ignore
				}
				reject(new Error(`Watcher execution timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			const finish = (err?: Error, results?: WatcherResultItem[]) => {
				if (settled) return;
				settled = true;
				clearTimeout(watchdog);
				try {
					worker.terminate();
				} catch (_e) {
					// ignore
				}
				if (err) reject(err);
				else resolve({ results: results || [], nextState });
			};

			worker.onerror = (evt) => {
				evt.preventDefault?.();
				finish(new Error(evt.message || 'Unhandled error in watcher worker'));
			};

			worker.onmessage = async (evt) => {
				const msg = evt.data;
				if (!msg || typeof msg !== 'object') return;
				if (msg.type === 'done') {
					finish(undefined, Array.isArray(msg.results) ? msg.results : []);
					return;
				}
				if (msg.type === 'error') {
					finish(new Error(String(msg.error || 'Watcher execution failed')));
					return;
				}
				if (msg.type === 'rpc') {
					const rpcId = msg.id;
					const op = msg.op;
					const args = Array.isArray(msg.args) ? msg.args : [];
					try {
						let result: unknown;
						if (op === 'fetch') {
							result = await safeHostFetch(
								String(args[0] ?? ''),
								args[1] as { cacheKey?: string; headers?: Record<string, string> } | undefined,
								allowedHosts,
								nextState,
								options,
							);
						} else if (op === 'extractJsonLd') {
							result = extractJsonLd(
								String(args[0] ?? ''),
								args[1] !== undefined ? String(args[1]) : undefined,
							);
						} else if (op === 'queryHtml') {
							result = queryHtml(String(args[0] ?? ''), String(args[1] ?? ''));
						} else if (op === 'parseXml') {
							result = parseXml(String(args[0] ?? ''));
						} else if (op === 'getState') {
							const k = String(args[0] ?? '');
							result = nextState.custom?.[k];
						} else if (op === 'setState') {
							const k = String(args[0] ?? '');
							if (!nextState.custom) nextState.custom = {};
							nextState.custom[k] = args[1];
							const serialized = JSON.stringify(nextState);
							if (serialized.length > 65536) {
								throw new Error('Watcher state exceeds 64KB limit');
							}
							result = true;
						} else {
							throw new Error(`Unknown host RPC operation: ${op}`);
						}
						if (!settled) {
							worker.postMessage({ type: 'rpc_res', id: rpcId, result });
						}
					} catch (rpcErr) {
						if (!settled) {
							worker.postMessage({
								type: 'rpc_res',
								id: rpcId,
								error: String((rpcErr as Error)?.message || rpcErr),
							});
						}
					}
				}
			};

			worker.postMessage({
				type: 'start',
				moduleDataUrl,
				items: watchedItems,
			});
		})
	);
}

export async function computeDeterministicPatchId(
	watcherId: string,
	itemTitle: string,
	patchSpec: { patchTarget?: unknown; createTiddler?: unknown },
): Promise<string> {
	const raw = `${watcherId}\0${itemTitle}\0${JSON.stringify(patchSpec)}`;
	const digest = await crypto.subtle.digest('SHA-256', utfenc.encode(raw));
	return encodeBase64Url(new Uint8Array(digest));
}

export type WatcherExecutionSummary = {
	ok: boolean;
	error: string | null;
	results: WatcherResultItem[];
	notificationsSent: number;
	patchesStaged: number;
	lastRunAt: number;
};

export async function executeWatcherModule(
	db: Datastore,
	row: WatcherModuleRow,
	vapidKeys: VapidKeys,
	options?: WatcherRunnerOptions,
): Promise<WatcherExecutionSummary> {
	const nowMs = options?.nowMs ?? Date.now();
	let watchedItems: WatchedItem[] = [];
	try {
		const parsed = JSON.parse(row.watched_items || '[]');
		if (Array.isArray(parsed)) watchedItems = parsed;
	} catch (_e) {
		watchedItems = [];
	}

	let currentState: WatcherState = {};
	try {
		const parsed = JSON.parse(row.state_json || '{}');
		if (parsed && typeof parsed === 'object') currentState = parsed;
	} catch (_e) {
		currentState = {};
	}

	let runOut: { results: WatcherResultItem[]; nextState: WatcherState };
	try {
		runOut = await runSandboxedWatcher(
			row.code_source,
			watchedItems,
			row.allowed_hosts,
			currentState,
			options,
		);
	} catch (err) {
		const errMsg = String((err as Error)?.message || err);
		// Preserve existing state_json so conditional HTTP cache (ETag/Last-Modified) is NOT advanced on failure
		db.updateWatcherRunState(row.token, row.watcher_id, row.state_json || '{}', nowMs, errMsg);
		return {
			ok: false,
			error: errMsg,
			results: [],
			notificationsSent: 0,
			patchesStaged: 0,
			lastRunAt: nowMs,
		};
	}

	const validResults = Array.isArray(runOut.results) ? runOut.results : [];
	const stagedPatches: Array<{ patchId: string; patchJson: string }> = [];

	for (const res of validResults) {
		if (!res || typeof res !== 'object') continue;
		if (res.patchTarget || res.createTiddler) {
			const itemTitle = typeof res.itemTitle === 'string'
				? res.itemTitle
				: (res.patchTarget?.title || res.createTiddler?.title || '');
			const patchSpec = {
				itemTitle,
				...(res.patchTarget ? { patchTarget: res.patchTarget } : {}),
				...(res.createTiddler ? { createTiddler: res.createTiddler } : {}),
			};
			const patchId = await computeDeterministicPatchId(row.watcher_id, itemTitle, {
				patchTarget: res.patchTarget,
				createTiddler: res.createTiddler,
			});
			stagedPatches.push({
				patchId,
				patchJson: JSON.stringify(patchSpec),
			});
		}
	}

	const nextStateJson = JSON.stringify(runOut.nextState);
	db.transaction(() => {
		for (const p of stagedPatches) {
			db.upsertPendingPatch({
				patch_id: p.patchId,
				token: row.token,
				watcher_id: row.watcher_id,
				patch_json: p.patchJson,
				created_at: nowMs,
			});
		}
		db.updateWatcherRunState(row.token, row.watcher_id, nextStateJson, nowMs, null);
	});

	if (stagedPatches.length > 0) {
		try {
			const pushChan = new BroadcastChannel(row.token);
			pushChan.postMessage({ exclude: '' });
			pushChan.close();
		} catch (_e) {
			// ignore BroadcastChannel errors if closed
		}
	}

	let notificationsSent = 0;
	for (const res of validResults) {
		if (!res || typeof res !== 'object' || !res.notify || typeof res.notify !== 'object') continue;
		const notify = res.notify;
		if (typeof notify.title !== 'string' || !notify.title.trim()) continue;
		const actionPatches = res.actionPatches || notify.actionPatches || undefined;
		const hasExplicitNavigateTo = notify.navigateTo !== undefined;
		const hasExplicitOpenUrl = typeof notify.openUrl === 'string' && notify.openUrl.trim().length > 0;
		const navigateTo = notify.clickAction === 'none' || notify.navigateTo === null
			? undefined
			: (hasExplicitNavigateTo
				? (notify.navigateTo || undefined)
				: (hasExplicitOpenUrl
					? undefined
					: ((typeof res.createTiddler?.title === 'string' ? res.createTiddler.title : undefined) ||
						res.itemTitle ||
						undefined)));

		const envelope = {
			mode: 'plain',
			notification: {
				title: notify.title,
				body: notify.body || '',
				icon: notify.icon || undefined,
				tag: notify.tag || `watcher-${row.watcher_id}`,
				actions: Array.isArray(notify.actions) ? notify.actions : undefined,
				data: {
					...(notify.data && typeof notify.data === 'object' ? notify.data : {}),
					watcherId: row.watcher_id,
					itemTitle: res.itemTitle,
					navigateTo,
					openUrl: notify.openUrl || undefined,
					clickAction: notify.clickAction || undefined,
					actionPatches,
				},
			},
		};
		try {
			const pushRes = await broadcastWikiPush(db, row.token, envelope, vapidKeys, {
				targetEndpoint: null,
				subject: options?.subject,
				fetchFn: options?.pushFetchFn ?? options?.fetchFn,
			});
			notificationsSent += pushRes.sent;
		} catch (e) {
			console.error(`Failed to broadcast push notification for watcher ${row.watcher_id}:`, e);
		}
	}

	return {
		ok: true,
		error: null,
		results: validResults,
		notificationsSent,
		patchesStaged: stagedPatches.length,
		lastRunAt: nowMs,
	};
}
