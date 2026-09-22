/*\
title: $:/plugins/valpackett/tiddlypwa/sw.js
type: application/javascript

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/
/// <reference no-default-lib="true" />
/// <reference types="npm:@types/serviceworker" />
const CACHE = 'tiddlypwa';

async function fromNetCaching(req, cacheResp) {
	try {
		// "preflight" for letting the server wake up if it's on a free service that suspends instances:
		await fetch(req.url, { method: 'OPTIONS', cache: 'no-cache' }).catch(() => {});
		const response = await fetch(new Request(req), { cache: 'no-cache' });
		if (response.ok) {
			const changed = cacheResp && (await response.clone().text() !== await cacheResp.text());
			const cache = await caches.open(CACHE);
			await cache.put(req, response.clone());
			if (changed) {
				for (const client of await clients.matchAll()) {
					client.postMessage({ op: 'refresh' });
				}
			}
		}
		return response;
	} catch (e) {
		if (cacheResp) return cacheResp;
		throw e;
	}
}

async function fromCache(evt) {
	const cache = await caches.open(CACHE);
	const response = await cache.match(evt.request);
	if (response) {
		evt.waitUntil(fromNetCaching(evt.request, response.clone()));
		return response;
	} else {
		return await fromNetCaching(evt.request);
	}
}

self.addEventListener('message', (evt) =>
	evt.waitUntil(async function () {
		if (evt.data.op === 'update') {
			const cache = await caches.open(CACHE);
			for (const req of await cache.keys()) {
				if (req.url === evt.data.url) {
					await fromNetCaching(req, await cache.match(req));
				}
			}
		}
	}()));

self.addEventListener('fetch', (evt) => {
	if (evt.request.destination === 'document' && evt.request.method === 'GET') {
		evt.respondWith(fromCache(evt));
	}
});

self.addEventListener('activate', (evt) => {
	evt.waitUntil(clients.claim());
});

self.addEventListener('install', (evt) => {
	skipWaiting();
	evt.waitUntil(async function () {
		const clientList = await clients.matchAll({ includeUncontrolled: true });
		if (clientList.length > 0 && clientList[0].url) {
			const u = new URL(clientList[0].url);
			u.hash = '';
			await fromNetCaching(new Request(u.href));
		}
	}());
});
