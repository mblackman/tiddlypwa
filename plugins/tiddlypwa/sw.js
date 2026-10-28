/*\
title: $:/plugins/mblackman/tiddlypwa/sw.js
type: application/javascript

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/
/// <reference no-default-lib="true" />
/// <reference types="npm:@types/serviceworker" />
const CACHE = 'tiddlypwa';

function stripWeakEtag(x) {
	return x && (x.startsWith('W/') ? x.slice(2) : x);
}

function getPushDbName() {
	const scopeUrl = new URL('.', self.registration ? self.registration.scope : self.location.href);
	return `tiddlypwa-push:${scopeUrl.pathname}`;
}

function openPushDb() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(getPushDbName(), 1);
		req.onupgradeneeded = (evt) => {
			const db = evt.target.result;
			if (!db.objectStoreNames.contains('state')) {
				db.createObjectStore('state');
			}
		};
		req.onsuccess = (evt) => resolve(evt.target.result);
		req.onerror = (evt) => reject(evt.target.error);
	});
}

async function readPushState(key) {
	const db = await openPushDb();
	try {
		return await new Promise((resolve, reject) => {
			const txn = db.transaction('state', 'readonly');
			const req = txn.objectStore('state').get(key);
			req.onsuccess = (evt) => resolve(evt.target.result);
			req.onerror = (evt) => reject(evt.target.error);
		});
	} finally {
		db.close();
	}
}

async function appendPendingClick(clickEvent) {
	const db = await openPushDb();
	try {
		await new Promise((resolve, reject) => {
			const txn = db.transaction('state', 'readwrite');
			const store = txn.objectStore('state');
			const getReq = store.get('pendingClicks');
			getReq.onsuccess = () => {
				const existing = Array.isArray(getReq.result) ? getReq.result : [];
				existing.push(clickEvent);
				// Cap queue at 50 entries to prevent unbounded growth
				if (existing.length > 50) existing.splice(0, existing.length - 50);
				store.put(existing, 'pendingClicks');
			};
			txn.oncomplete = () => resolve();
			txn.onerror = () => reject(txn.error);
		});
	} finally {
		db.close();
	}
}

function b64ToBytes(b64) {
	const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
	const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
	const bin = atob(padded);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

async function decryptPushEnvelope(ivB64, ctB64) {
	const record = await readPushState('pushKey');
	const pushKey = record?.key || record;
	if (!pushKey) return null;
	const iv = b64ToBytes(ivB64);
	const ct = b64ToBytes(ctB64);
	const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, pushKey, ct);
	return JSON.parse(new TextDecoder().decode(plainBuf));
}

async function fromNetCaching(req, cacheResp) {
	try {
		const etagOld = cacheResp ? stripWeakEtag(cacheResp.headers.get('etag')) : null;
		let response;
		if (etagOld) {
			// Background revalidation of a cached copy: a conditional request lets the server answer 304
			// instead of re-sending (and us re-writing) the whole multi-megabyte app file on every launch.
			// Setting If-None-Match bypasses the HTTP cache, so a 304 reaches us as-is.
			response = await fetch(req.url, {
				headers: { 'if-none-match': etagOld },
				cache: 'no-store',
				credentials: 'same-origin',
			});
			if (response.status === 304) return cacheResp;
		} else {
			// "preflight" for letting the server wake up if it's on a free service that suspends instances:
			await fetch(req.url, { method: 'OPTIONS', cache: 'no-cache' }).catch(() => {});
			response = await fetch(new Request(req), { cache: 'no-cache' });
		}
		if (response.ok) {
			const ctype = response.headers.get('content-type') || '';
			if (
				(req.mode === 'navigate' || req.destination === 'document' || req.url.endsWith('.html')) &&
				!ctype.includes('text/html')
			) {
				return cacheResp || response;
			}
			const etagNew = stripWeakEtag(response.headers.get('etag'));
			const changed = cacheResp && etagNew && etagOld && etagNew !== etagOld;
			if (!cacheResp || changed || !etagNew) {
				const cache = await caches.open(CACHE);
				await cache.put(req, response.clone());
			}
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
	const response = await cache.match(evt.request, { ignoreSearch: true });
	if (response) {
		// Only the headers (ETag) are needed for revalidation, so pass a body-less copy: an unread
		// clone() of a multi-megabyte response would make the browser buffer the whole body twice.
		const headersOnly = new Response(null, { status: response.status, headers: response.headers });
		evt.waitUntil(fromNetCaching(evt.request, headersOnly).catch(() => {}));
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
	const url = new URL(evt.request.url);
	if (evt.request.method === 'GET' && url.origin === location.origin && !url.pathname.endsWith('/tid.dly')) {
		evt.respondWith(fromCache(evt));
	}
});

self.addEventListener('push', (evt) => {
	evt.waitUntil(async function () {
		let envelope = null;
		if (evt.data) {
			try {
				envelope = evt.data.json();
			} catch (_e) {
				envelope = {
					mode: 'plain',
					notification: {
						title: 'TiddlyPWA',
						body: evt.data.text(),
					},
				};
			}
		}
		if (!envelope) return;

		let notif = null;
		if (envelope.mode === 'encrypted' && envelope.iv && envelope.ct) {
			try {
				notif = await decryptPushEnvelope(envelope.iv, envelope.ct);
			} catch (e) {
				console.warn('Failed to decrypt TiddlyPWA push payload in Service Worker:', e);
			}
			if (!notif) {
				notif = {
					title: 'TiddlyPWA Reminder',
					body: 'Open your wiki to view this notification.',
					tag: 'tiddlypwa-encrypted-fallback',
					data: { fallback: true },
				};
			}
		} else if (envelope.notification && typeof envelope.notification === 'object') {
			notif = envelope.notification;
		} else if (envelope.title) {
			notif = envelope;
		}

		if (!notif || !notif.title) return;

		const notifData = {
			...(typeof notif.data === 'object' && notif.data ? notif.data : {}),
			actionPatches: notif.actionPatches || notif.data?.actionPatches || undefined,
			navigateTo: notif.navigateTo || notif.data?.navigateTo || undefined,
			openUrl: notif.openUrl || notif.data?.openUrl || undefined,
			clickAction: notif.clickAction || notif.data?.clickAction || undefined,
		};

		await self.registration.showNotification(String(notif.title), {
			body: notif.body ? String(notif.body) : '',
			icon: notif.icon || 'favicon.ico',
			badge: notif.badge || undefined,
			tag: notif.tag || undefined,
			renotify: Boolean(notif.renotify),
			requireInteraction: Boolean(notif.requireInteraction),
			actions: Array.isArray(notif.actions) ? notif.actions : [],
			data: notifData,
		});
	}());
});

self.addEventListener('notificationclick', (evt) => {
	evt.notification.close();
	evt.waitUntil(async function () {
		const action = evt.action || 'default';
		const data = evt.notification.data || {};
		const actionSpec = data.actionPatches && typeof data.actionPatches === 'object'
			? data.actionPatches[action]
			: undefined;

		const clickEvent = {
			id: (typeof crypto.randomUUID === 'function')
				? crypto.randomUUID()
				: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
			clickedAt: Date.now(),
			action,
			tag: evt.notification.tag || '',
			data,
		};

		try {
			await appendPendingClick(clickEvent);
		} catch (e) {
			console.warn('Failed to persist pending notification click:', e);
		}

		// If the clicked action specifies an external URL to open directly, open it
		const clickAction = actionSpec?.clickAction || (action === 'default' ? data.clickAction : undefined);
		const externalUrl = actionSpec?.openUrl ||
			(action === 'open-url' && (data.openUrl || data.url)) ||
			(action === 'default' && clickAction !== 'navigate' && clickAction !== 'none' &&
					data.openUrl && (clickAction === 'open-url' || !data.navigateTo)
				? data.openUrl
				: null);

		if (externalUrl) {
			await clients.openWindow(externalUrl);
			return;
		}

		const scopeHref = self.registration ? self.registration.scope : self.location.origin + '/';
		const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
		for (const client of windowClients) {
			if (client.url && client.url.startsWith(scopeHref)) {
				if (typeof client.focus === 'function') {
					await client.focus().catch(() => {});
				}
				client.postMessage({ op: 'push-click', clickEvent });
				return;
			}
		}

		// Find cached app URL if present, otherwise open scope root or app.html
		let targetAppUrl = scopeHref;
		try {
			const cache = await caches.open(CACHE);
			for (const req of await cache.keys()) {
				if (req.url.startsWith(scopeHref) && (req.url.endsWith('.html') || req.url === scopeHref)) {
					targetAppUrl = req.url;
					break;
				}
			}
		} catch (_e) {
			// Fallback to scopeHref
		}
		await clients.openWindow(targetAppUrl);
	}());
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
			try {
				const cache = await caches.open(CACHE);
				const cached = await cache.match(u.href);
				await fromNetCaching(new Request(u.href), cached);
			} catch (_err) {
				// Network or DNS failure during install must not transition worker to redundant state
			}
		}
	}());
});
