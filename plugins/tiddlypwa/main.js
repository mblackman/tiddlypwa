/*\
title: $:/plugins/valpackett/tiddlypwa/main.js
type: application/javascript
module-type: syncadaptor

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/
/// <reference types="npm:tw5-typed" />
// deno-lint-ignore-file no-window-prefix
(function () {
	'use strict';

	if (!$tw.browser) return;

	// Do this early to make it work on login screen too
	if ('serviceWorker' in navigator) {
		navigator.serviceWorker.onmessage = (evt) => {
			if (evt.data.op == 'refresh') {
				$tw.wiki.addTiddler({ title: '$:/status/TiddlyPWAUpdateAvailable', text: 'yes' });
			}
		};
	}

	// Patch this to make upgrading core by drag&drop reflect the version number in generated html
	$tw.utils.extractVersionInfo = () => $tw.wiki.getTiddler('$:/core').fields.version;
	Object.defineProperty($tw, 'version', { get: $tw.utils.extractVersionInfo });

	// Patch this to direct all plugins into the app wiki saving process
	// (It gets called on a lot of junk that's not plugin info, so just detect actual plugins)
	$tw.wiki.doesPluginInfoRequireReload = (x) => typeof x === 'object' && 'tiddlers' in x;

	// As of mid 2023 only Firefox has this natively
	if (typeof ReadableStream === 'function' && !ReadableStream.prototype[Symbol.asyncIterator]) {
		ReadableStream.prototype[Symbol.asyncIterator] = async function* () {
			const reader = this.getReader();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) return;
					yield value;
				}
			} finally {
				reader.releaseLock();
			}
		};
	}

	const knownErrors = {
		EAUTH: 'Wrong password, salt, and/or sync token',
		EPROTO: 'Protocol incompatibility',
		ETIMESYNC: 'The current time is too different between the server and the device',
	};

	const utfenc = new TextEncoder('utf-8');
	const { b64enc, b64dec, encodeData, decodeData } = require('$:/plugins/valpackett/tiddlypwa/encoding.js');
	const { BootstrapModal } = require('$:/plugins/valpackett/tiddlypwa/bootstrap.js');

	function adb(req) {
		return new Promise((resolve, reject) => {
			req.onerror = (evt) => {
				if (typeof evt.preventDefault === 'function') {
					evt.preventDefault();
				}
				reject(evt.target.error);
			};
			req.onsuccess = (evt) => resolve(evt.target.result);
		});
	}

	// WARNING! DO NOT INTERMIX WITH OTHER AWAITS!
	async function* adbiter(req) {
		let res, rej;
		let cursor = await new Promise((resolve, reject) => {
			res = resolve;
			rej = reject;
			req.onerror = (evt) => rej(evt.target.error);
			req.onsuccess = (evt) => res(evt.target.result);
		});
		while (cursor) {
			yield cursor.value;
			cursor.continue();
			cursor = await new Promise((resolve, reject) => {
				res = resolve;
				rej = reject;
			});
		}
	}

	function formatBytes(bytes) {
		const sizes = ['bytes', '~KiB', '~MiB', '~GiB', '~TiB'];
		const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
		if (i >= sizes.length) return 'too much';
		return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[i];
	}

	function arrayEq(a, b) {
		const av = new Uint8Array(a);
		const bv = new Uint8Array(b);
		if (av.byteLength !== bv.byteLength) return false;
		return av.every((val, i) => val === bv[i]);
	}

	function isCurrentUrl(url) {
		return url === `${location.origin}${location.pathname}${location.search}`;
	}

	const knownFields = new Set(['created', 'creator', 'modified', 'modifier', 'tags', 'text', 'title', 'type', 'uri']);

	// Certain tiddlers must NEVER use _is_skinny lazy-loading
	function mustEagerLoad(tid) {
		// XXX: for now it really is just kinda more trouble than it's worth :(
		if (location.hash !== '##lazy') return true;
		// e.g. $:/DefaultTiddlers
		if (tid.title.startsWith('$:')) return true;
		// e.g. $:/tags/Macro, $:/tags/ManifestIcon
		for (const t of $tw.Tiddler.fieldModules.tags.parse(tid.tags) || []) {
			if (typeof t === 'string' && t.startsWith('$:')) return true;
		}
		// e.g. se-type from the Section Editor plugin https://codeberg.org/valpackett/tiddlypwa/issues/23
		// (Actually that case is about core not firing lazyLoad when a custom viewtemplate is used,
		//  but we can imagine other kinds of custom-field-having tiddlers needing content always loaded)
		for (const k of Object.keys(tid)) if (!knownFields.has(k)) return true;
		return false;
	}

	class FetchError extends Error {
		constructor(cause) {
			super('fetch failed');
			this.cause = cause;
			this.name = 'FetchError';
		}
	}

	class PWAStorage {
		supportsLazyLoading = true;
		modal = new BootstrapModal();

		constructor(options) {
			this.wiki = options.wiki;
			this.tiddlersInFile = new Set(this.wiki.getTiddlers({ includeSystem: true }));
			this.logger = new $tw.utils.Logger('tiddlypwa-storage');
			this.monitorTimeout = 2000;
			this.modifiedQueue = new Set();
			this.deletedQueue = new Set();
			this.changesChannel = new BroadcastChannel(`tiddlypwa-changes:${location.pathname}`);
			this.changesChannel.onmessage = (evt) => {
				this.logger.log('Change from another tab');
				if (evt.data.del) {
					this.deletedQueue.add(evt.data.title);
				} else {
					this.modifiedQueue.add(evt.data.title);
				}
				$tw.syncer.syncFromServer(); // "server" being our local DB
				clearTimeout(this.tabChangesReflTimer);
				this.tabChangesReflTimer = setTimeout(() => {
					this.reflectSyncServers();
					this.reflectStorageInfo();
				}, 2000);
			};
			this.serversChannel = new BroadcastChannel(`tiddlypwa-servers:${location.pathname}`);
			this.serversChannel.onmessage = (_evt) => {
				this.reflectSyncServers();
			};
			this.sessionChannel = new BroadcastChannel(`tiddlypwa-session:${location.pathname}`);
			this.sessionChannel.onmessage = (evt) => {
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWARemembered', text: evt.data ? 'yes' : 'no' });
			};

			this.wiki.addTiddler({ title: '$:/status/TiddlyPWAOrigin', text: location.origin });

			this.wiki.addTiddler({ title: '$:/status/TiddlyPWAOnline', text: navigator.onLine ? 'yes' : 'no' });
			window.addEventListener(
				'offline',
				(_evt) => this.wiki.addTiddler({ title: '$:/status/TiddlyPWAOnline', text: 'no' }),
			);
			window.addEventListener(
				'online',
				(_evt) => {
					this.wiki.addTiddler({ title: '$:/status/TiddlyPWAOnline', text: 'yes' });
					if (this.db) {
						this.backgroundSync();
						this.startRealtimeMonitor();
					}
				},
			);

			document.addEventListener('visibilitychange', (_evt) => {
				if (document.visibilityState === 'visible') this.backgroundSync();
			});

			$tw.rootWidget.addEventListener('tiddlypwa-remember', (_evt) => {
				if (!confirm('Are you sure you want to remember the password?')) {
					return;
				}
				this.db.transaction('session', 'readwrite').objectStore('session').put({
					enckeys: this.enckeys,
					mackey: this.mackey,
				})
					.onsuccess = (
						_evt,
					) => {
						this.wiki.addTiddler({ title: '$:/status/TiddlyPWARemembered', text: 'yes' });
						$tw.notifier.display('$:/plugins/valpackett/tiddlypwa/notif-remembered');
						this.sessionChannel.postMessage(true);
					};
			});

			$tw.rootWidget.addEventListener('tiddlypwa-forget', (_evt) => {
				this.db.transaction('session', 'readwrite').objectStore('session').openCursor().onsuccess = (evt) => {
					const cursor = evt.target.result;
					if (cursor) {
						cursor.delete();
						cursor.continue();
					}
				};
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWARemembered', text: 'no' });
				this.sessionChannel.postMessage(false);
			});

			$tw.rootWidget.addEventListener('tiddlypwa-enable-persistence', (_evt) => {
				navigator.storage.persist().then(() => this.reflectStorageInfo());
			});

			$tw.rootWidget.addEventListener('tiddlypwa-drop-db', (_evt) => {
				this.dropDb();
			});

			$tw.rootWidget.addEventListener('tiddlypwa-add-sync-server', (evt) => {
				const url = evt?.paramObject?.url;
				const token = evt?.paramObject?.token;
				if (!url || !token) {
					alert('A sync server must have a URL and a token!');
					return;
				}
				try {
					new URL(url, document.location);
				} catch (_e) {
					alert('The URL must be valid!');
					return;
				}
				adb(
					this.db.transaction('syncservers', 'readwrite').objectStore('syncservers').put({
						url,
						token,
						lastSync: new Date(0),
					}),
				).then((_x) => {
					this.reflectSyncServers();
					this.serversChannel.postMessage(true);
					this.backgroundSync();
				}).catch((e) => {
					this.logger.alert('Failed to save the sync server!', e);
				});
			});

			$tw.rootWidget.addEventListener('tiddlypwa-delete-sync-server', (evt) => {
				const key = evt?.paramObject?.key;
				adb(
					this.db.transaction('syncservers', 'readwrite').objectStore('syncservers').delete(parseInt(key)),
				).then((_x) => {
					this.reflectSyncServers();
					this.serversChannel.postMessage(true);
				}).catch((e) => {
					this.logger.alert('Failed to delete the sync server!', e);
				});
			});

			$tw.rootWidget.addEventListener('tiddlypwa-open-save-dialog', (evt) => {
				$tw.modal.display('$:/plugins/valpackett/tiddlypwa/sync-dialog', {});
			});

			$tw.rootWidget.addEventListener('tiddlypwa-upload-app-wiki', (evt) => {
				this.uploadAppWiki(evt.paramObject);
			});

			$tw.rootWidget.addEventListener('tiddlypwa-browser-refresh', (_evt) => {
				location.reload(); // tm-browser-refresh passes 'true' which skips the serviceworker. silly!
			});

			$tw.rootWidget.addEventListener('tiddlypwa-browser-refresh-force', (_evt) => {
				$tw.syncer.isDirty = () => false; // skip the onbeforeunload
				location.reload(); // tm-browser-refresh passes 'true' which skips the serviceworker. silly!
			});

			$tw.rootWidget.addEventListener('tiddlypwa-sync-cancel', (_evt) => {
				this.syncAbort.abort();
			});

			$tw.rootWidget.addEventListener('tiddlypwa-sync-all', (_evt) => {
				this.sync(true);
			});

			$tw.rootWidget.addEventListener('tiddlypwa-sync', (_evt) => {
				this.sync(false);
			});
		}

		firstChange() {
			return new Promise((resolve) => {
				const wiki = this.wiki;
				// This relies on the sequential ordering of handlers inside the event implementation
				this.wiki.addEventListener('change', /* not arrow */ function () {
					wiki.removeEventListener('change', this);
					resolve();
				});
			});
		}

		missingFeaturesWarning() {
			const crit = [
				!isSecureContext &&
				'The app is not loaded from a secure context (HTTPS)! Cannot continue due to unavailable features. Please use a secure server.',
				typeof WebAssembly !== 'object' && 'WebAssembly is unavailable, we cannot unlock the wiki without it.',
				typeof indexedDB !== 'object' &&
				'IndexedDB is unavailable, we cannot even store anything here.',
				typeof DecompressionStream !== 'function' &&
				'Compression Streams are unavailable, we cannot unlock the wiki without that. Please upgrade your browser.',
				!this.db && 'Could not create a database. Are you in private browsing mode? TiddlyPWA does not work there.',
			].filter((x) => !!x);
			// Don't really have tests for non-critical features right now as Compression Streams are already a huge support bound
			return [crit.length > 0, crit.map((x) => `<p class=tiddlypwa-form-error>${x}</p>`).join('\n')];
		}

		async initServiceWorker() {
			try {
				const reg = await navigator.serviceWorker.register('sw.js');
				await reg.update();
			} catch (e) {
				console.error(e);
				if (!navigator.onLine) return;
				if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
				$tw.wiki.addTiddler({ title: '$:/status/TiddlyPWAWorkerError', text: e.message });
				$tw.notifier.display('$:/plugins/valpackett/tiddlypwa/notif-sw-error');
			}
		}

		async _startRealtimeMonitor() {
			const servers = await adb(
				this.db.transaction('syncservers').objectStore('syncservers').getAll(),
			);
			if (servers.length === 0) {
				this.wiki.addTiddler({
					title: '$:/status/TiddlyPWARealtime',
					text: `no sync servers`,
				});
				return;
			}
			const server = servers[~~(Math.random() * servers.length)];
			const url = new URL(server.url, document.location);
			const bareUrl = url;
			this.wiki.addTiddler({
				title: '$:/status/TiddlyPWARealtime',
				text: `connecting to ${bareUrl}`,
			});
			url.searchParams.set('op', 'monitor');
			url.searchParams.set('token', server.token);
			url.searchParams.set('browserToken', this.browserToken);
			this.monitorStream = new EventSource(url.href);
			this.monitorStream.onopen = (_e) => {
				this.monitorTimeout = 2000;
				this.wiki.addTiddler({
					title: '$:/status/TiddlyPWARealtime',
					text: `connected to ${bareUrl}`,
				});
			};
			this.monitorStream.addEventListener('sync', (_evt) => this.backgroundSync());
			await new Promise((resolve) => {
				this.monitorStream.onerror = resolve;
			});
			this.wiki.addTiddler({
				title: '$:/status/TiddlyPWARealtime',
				text: `disconnected from ${url}`,
			});
			this.monitorStream.close();
			this.startedMonitor = false;
			if (navigator.onLine) this.startRealtimeMonitor();
		}

		startRealtimeMonitor() {
			if (this.startedMonitor) return;
			this.startedMonitor = true;
			if (this.monitorTimeout < 60000) this.monitorTimeout *= 2;
			clearTimeout(this.monitorTimer);
			this.monitorTimer = setTimeout(() => {
				this.wiki.addTiddler({
					title: '$:/status/TiddlyPWARealtime',
					text: `possibly another tab is currently responsible for the connection`,
				});
				navigator.locks.request(
					`tiddlypwa-realtime:${location.pathname}`,
					(_lck) => this._startRealtimeMonitor(),
				);
			}, this.monitorTimeout);
		}

		async reflectSyncServers() {
			this.startRealtimeMonitor();
			for (const tidname of this.wiki.getTiddlersWithTag('$:/temp/TiddlyPWAServer')) {
				this.wiki.deleteTiddler(tidname);
			}
			let cnt = 0;
			await new Promise((resolve) =>
				this.db.transaction('syncservers').objectStore('syncservers').openCursor().onsuccess = (evt) => {
					const cursor = evt.target.result;
					if (!cursor) {
						return resolve();
					}
					const { url, token, lastSync } = cursor.value;
					this.wiki.addTiddler({
						title: '$:/temp/TiddlyPWAServers/' + cursor.key,
						tags: ['$:/temp/TiddlyPWAServer'],
						key: cursor.key,
						url,
						token,
						lastSync: lastSync?.getTime() === 0 ? 'never' : lastSync?.toLocaleString(),
					});
					cnt++;
					cursor.continue();
				}
			);
			this.wiki.addTiddler({ title: '$:/status/TiddlyPWAServerCount', text: cnt.toString() });
		}

		async reflectStorageInfo() {
			this.wiki.addTiddler({
				title: '$:/status/TiddlyPWAStoragePersisted',
				text: (navigator.storage?.persist) ? (await navigator.storage.persisted() ? 'yes' : 'no') : 'unavail',
			});
			const formatEstimate = ({ usage, quota }) =>
				`${formatBytes(usage)} of ${formatBytes(quota)} (${(usage / quota * 100).toFixed(2)}%)`;
			this.wiki.addTiddler({
				title: '$:/status/TiddlyPWAStorageQuota',
				text: (navigator.storage?.estimate) ? formatEstimate(await navigator.storage.estimate()) : 'unavail',
			});
		}

		isReady() {
			return this.ready;
		}

		async parseEncryptedTiddler({ thash, iv, ct }) {
			return JSON.parse(
				await decodeData(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, this.enckey(thash), ct)),
			);
		}

		async decryptRawTiddler(record) {
			if (!record || record.deleted || !record.ct || !record.iv) return null;
			try {
				const tid = await this.parseEncryptedTiddler(record);
				if (record.sbiv && record.sbct) {
					tid.text = await decodeData(
						await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.sbiv }, this.enckey(record.thash), record.sbct),
					);
				}
				return tid;
			} catch (e) {
				this.logger.alert('Failed to decrypt conflicting tiddler payload', e);
				return null;
			}
		}

		tiddlersAreEqual(a, b) {
			if (!a || !b) return false;
			if ((a.text || '') !== (b.text || '')) return false;
			const ignored = new Set(['modified', 'created', 'revision']);
			const keysA = Object.keys(a).filter((k) => !ignored.has(k));
			const keysB = Object.keys(b).filter((k) => !ignored.has(k));
			if (keysA.length !== keysB.length) return false;
			return keysA.every((k) => a[k] === b[k]);
		}

		formatConflictTitle(baseTitle, date) {
			const cleanBase = baseTitle.replace(/\s*\(Conflict\s+[^)]+\)$/, '');
			const pad = (n) => String(n).padStart(2, '0');
			const d = date instanceof Date ? date : new Date(date);
			const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${
				pad(d.getMinutes())
			}:${pad(d.getSeconds())}`;
			let candidate = `${cleanBase} (Conflict ${dateStr})`;
			let counter = 2;
			while (this.wiki.tiddlerExists(candidate)) {
				candidate = `${cleanBase} (Conflict ${dateStr} ${counter++})`;
			}
			return candidate;
		}

		createConflictTiddler(sourceTid, originalTitle, source, date) {
			const conflictTitle = this.formatConflictTitle(originalTitle, date);
			const originalTags = $tw.utils.parseStringArray(sourceTid.tags || '');
			const newTags = Array.from(new Set([...originalTags, '$:/tags/TiddlyPWA/Conflict']));
			const d = date instanceof Date ? date : new Date(date);

			const conflictFields = {
				...sourceTid,
				title: conflictTitle,
				tags: $tw.utils.stringifyList(newTags),
				'tiddlypwa-conflict-of': originalTitle,
				'tiddlypwa-conflict-source': source,
				'tiddlypwa-conflict-date': d.toISOString(),
			};
			return new $tw.Tiddler(conflictFields);
		}

		async initialRead() {
			this.storyListHash = await this.titlehash('$:/StoryList');
			const toDecrypt = await adb(this.db.transaction('tiddlers').objectStore('tiddlers').getAll());
			this.logger.log('Titles to read: ', toDecrypt.length);
			console.time('initial decrypt');
			let cur = 0;
			const toAdd = [];
			for (const { thash, iv, ct, sbiv, sbct, deleted } of toDecrypt) {
				try {
					if (deleted) continue;
					// not isReady yet, can safely addTiddler
					const tid = await this.parseEncryptedTiddler({ thash, ct, iv });
					if (sbiv && sbct) {
						if (mustEagerLoad(tid)) {
							tid.text = await decodeData(
								await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sbiv }, this.enckey(thash), sbct),
							);
						} else tid._is_skinny = true; // Lazy-load separate body
					}
					toAdd.push(tid);
					if (cur % 100 == 0) {
						this.modal.setFeedback(`<p>Decrypting tiddlers… (${Math.round(100 * cur / toDecrypt.length)}%)</p>`);
					}
					cur += 1;
				} catch (e) {
					this.logger.log('Title decryption failed for:', await b64enc(thash));
					console.error(e);
					return false;
				}
			}
			console.timeEnd('initial decrypt');
			console.time('initial add');
			this.modal.setFeedback(`<p>Loading tiddlers…</p>`);
			// Waiting for one change event prevents unlocking before the adding is actually done
			const themHandlers = toAdd.length > 0 ? this.firstChange() : Promise.resolve();
			// Adds are batched all together SYNCHRONOUSLY to prevent event handlers from running on every add!
			// storeTiddler is basically addTiddler but store info to prevent syncer from creating save tasks later
			for (const tid of toAdd) $tw.syncer.storeTiddler(tid);
			await themHandlers; // ha
			console.timeEnd('initial add');
			this.ready = true;
			setTimeout(() => {
				try {
					$tw.__update_tiddlypwa_manifest__();
				} catch (e) {
					console.error(e);
				}
			}, 300);
			this.openStartupStory(); // Old $:/DefaultTiddlers has been used
			this.backgroundSync();
			return true;
		}

		openStartupStory() {
			// XXX: TW core should export openStartupTiddlers
			const aEL = $tw.rootWidget.addEventListener;
			$tw.rootWidget.addEventListener = () => {};
			require('$:/core/modules/startup/story.js').startup();
			$tw.rootWidget.addEventListener = aEL;
		}

		initDb(db) {
			db.createObjectStore('metadata', { autoIncrement: true });
			db.createObjectStore('session', { autoIncrement: true });
			db.createObjectStore('syncservers', { autoIncrement: true });
			db.createObjectStore('tiddlers', { keyPath: 'thash' });
		}

		dropDb() {
			const instdesc = `(origin: ${location.origin}; path: ${location.pathname})`;
			if (!confirm(`Are you sure you want to DELETE the local data for this instance ${instdesc} of TiddlyPWA?`)) {
				return;
			}
			if (this.db) {
				this.db.close();
				this.db = undefined;
			}
			$tw.syncer.isDirty = () => false; // skip the onbeforeunload
			adb(indexedDB.deleteDatabase(`tiddlypwa:${location.pathname}`)).then((_) => location.reload())
				.catch((e) => this.logger.alert('Failed to delete database!', e));
		}

		async _getStatus() {
			if (!this.browserToken) {
				this.browserToken = await b64enc(crypto.getRandomValues(new Uint8Array(12)));
			}
			if (!this.db) {
				const req = indexedDB.open(`tiddlypwa:${location.pathname}`, 1);
				req.onupgradeneeded = (evt) => {
					this.initDb(evt.target.result);
				};
				try {
					this.db = await adb(req);
				} catch (e) {
					console.error(e);
				}
			}
			const freshDb = !this.db ||
				await new Promise((resolve) =>
					this.db.transaction('tiddlers').objectStore('tiddlers').openCursor().onsuccess = (evt) =>
						resolve(!evt.target.result)
				);
			if (this.db && !this.salt) {
				const meta = await adb(this.db.transaction('metadata').objectStore('metadata').getAll());
				if (meta.length > 0) {
					this.salt = meta[meta.length - 1].salt;
				}
			}
			if (this.db && !this.enckeys) {
				const ses = await adb(this.db.transaction('session').objectStore('session').getAll());
				if (ses.length > 0) {
					this.enckeys = ses[ses.length - 1].enckeys;
					this.mackey = ses[ses.length - 1].mackey;
				}
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWARemembered', text: ses.length > 0 ? 'yes' : 'no' });
			}
			if (!this.enckeys) {
				let bootstrapEndpoint;
				const [weAreScrewed, missingWarning] = this.missingFeaturesWarning();
				const seemsLikeDocs = $tw.wiki.getTiddlersWithTag('TiddlyPWA Docs').length > 0;
				if (freshDb) {
					this.modal.setFeedback(
						'<p>No wiki data found in the browser storage for this URL. Wait a second, looking around the server..</p>',
					);
					const giveUp = new AbortController();
					this.modal.showGiveUpButtonDelayed(6900, () => giveUp.abort());
					this.modal.showModalDelayed(seemsLikeDocs ? 6900 : 1000);
					try {
						const resp = await fetch('bootstrap.json', {
							signal: giveUp.signal,
							cache: 'no-store',
						});
						const { state, endpoint, salt } = await resp.json();
						if (
							(endpoint && typeof endpoint !== 'string') || (state && typeof state !== 'string') ||
							(salt && typeof salt !== 'string')
						) {
							alert('Something is weird with the server! Unexpected types in bootstrap.json');
						}
						bootstrapEndpoint = endpoint && { url: endpoint };
						this.modal.abortGiveUpButton();
						this.modal.setFeedback('');
						let askToken = true, askSalt = true;
						if (state === 'docs') {
							this.modal.close();
							delete this.modal;
							if (this.db) {
								this.db.close();
								await adb(indexedDB.deleteDatabase(`tiddlypwa:${location.pathname}`));
							}
							this.db = undefined;
							$tw.syncer.isDirty = () => false; // skip the onbeforeunload
							this.wiki.addTiddler({ title: '$:/status/TiddlyPWADocsMode', text: 'yes' });
							return;
						}
						if (weAreScrewed) {
							this.modal.setBody('<p>Oops…</p>');
							this.modal.setFeedback(missingWarning);
							this.modal.showForm(true);
							return;
						}
						if (state === 'localonly') {
							this.modal.setBody(`
								<p>Welcome to your new local-only wiki!</p>
								<p>This wiki is not hosted on a sync server and will not automatically start to synchronize your data. However, you can always add sync servers later in the settings!</p>
								<p><strong>Make up a strong password</strong> to protect the content of the wiki.</p>
							`);
							askToken = false;
							this.modal.setFresh();
							this.wiki.addTiddler({ title: '$:/status/TiddlyPWAWasLocalOnly', text: 'yes' });
						} else if (state === 'fresh') {
							this.modal.setBody(`
								<p>Welcome to your new synchronized wiki!</p>
								<p>Paste the token given to you by the administrator of the sync server <code>${endpoint}</code> and <strong>make up a strong password</strong>.</p>
								<p>The password will be used to encrypt your data, hiding the content from the server and, if you choose not to use the "remember password" option, against unauthorized users of this device.</p>
								<p>You will have to use that password to open this wiki on all synchronized devices/browsers.</p>
							`);
							this.modal.setFresh();
						} else if (state === 'existing') {
							this.modal.setBody(`
								<p>Welcome back to your synchronized wiki!</p>
								<p>Log in using your credentials below. You are using the sync server <code>${endpoint}</code>.</p>
							`);
							askSalt = false;
							this.salt = b64dec(salt);
							// XXX: upstream: we should be able to await syncFromServer
							this.afterSyncOnceHook = async () => {
								await this.firstChange(); // Assume the changes will come batched, because well, we queue them up synchronously
								this.openStartupStory();
							};
						} else {
							this.modal.setBody(`
								<p>We are not quite sure what happened on the sync server...</p>
								<p>Try to log in using your credentials below anyway?</p>
							`);
						}
						if (askToken) {
							if (!bootstrapEndpoint) {
								alert(`This sync server is misconfigured: no endpoint found while state is '${state}'.`);
							}
							this.modal.addTokenInput((e) => bootstrapEndpoint.token = e.target.value.trim());
						}
						if (askSalt) {
							this.modal.addSaltInput((e) => {
								const saltText = e.target.value.trim();
								if (saltText.length == 0) {
									this.salt = null;
									this.modal.setFeedback('');
								} else if (saltText.length < 16) {
									this.salt = null;
									this.modal.setFeedback('<p class=tiddlypwa-form-error>The salt is too short</p>');
								} else {
									try {
										this.salt = b64dec(saltText);
									} catch (_e) {
										this.salt = null;
										this.modal.setFeedback('<p class=tiddlypwa-form-error>Could not decode the salt</p>');
									}
								}
							});
						}
						this.modal.showForm();
					} catch (e) {
						console.error(e);
						this.modal.abortGiveUpButton();
						this.modal.setBody(`
							<p>Oops, looks like there is no information about the current server to be found!</p>
							<p>Oh well, synchronization can be set up later in the settings.</p>
						`);
						this.modal.showForm();
					}
				} else {
					this.modal.setBody('<p>Welcome back! Please enter your password.</p>');
					this.modal.showForm();
				}
				const AW = require('$:/plugins/valpackett/tiddlypwa/argon2ian.js').ArgonWorker;
				const argon = new AW();
				await argon.ready;
				let checked = false;
				while (!checked) {
					const password = await this.modal.formSubmitted();
					this.modal.setFeedback('<p>Please wait…</p>');
					if (!this.salt) this.salt = crypto.getRandomValues(new Uint8Array(32));
					console.time('hash');
					const basebits = await argon.hash(utfenc.encode(password), this.salt, { m: 1 << 17, t: 2 });
					console.timeEnd('hash');
					const basekey = await crypto.subtle.importKey('raw', basebits, 'HKDF', false, ['deriveKey']);
					// fun: https://soatok.blog/2021/11/17/understanding-hkdf/ (but we don't have any randomness to shove into info)
					// not fun: https://soatok.blog/2020/12/24/cryptographic-wear-out-for-symmetric-encryption/
					// realistically 4 billion encryptions is already actually *a lot* for a notes app even with really heavy use lol
					// but by having just 8 keys we get to 34 billion which is Better
					this.enckeys = await Promise.all(
						[...Array(8).keys()].map((i) =>
							crypto.subtle.deriveKey(
								{
									name: 'HKDF',
									hash: 'SHA-256',
									salt: utfenc.encode('tiddly.pwa.tiddlers.' + i),
									info: new Uint8Array(),
								},
								basekey,
								{ name: 'AES-GCM', length: 256 },
								false,
								['encrypt', 'decrypt'],
							)
						),
					);
					this.mackey = await crypto.subtle.deriveKey(
						{ name: 'HKDF', hash: 'SHA-256', salt: utfenc.encode('tiddly.pwa.titles'), info: new Uint8Array() },
						basekey,
						{ name: 'HMAC', hash: 'SHA-256' },
						false,
						['sign'],
					);
					checked = await this.initialRead();
					if (!checked) {
						this.modal.setFeedback('<p class=tiddlypwa-form-error>Wrong password!</p>');
					}
				}
				argon.terminate();
				if (freshDb) {
					this.db.transaction('metadata', 'readwrite').objectStore('metadata').put({ salt: this.salt });
				}
				if (bootstrapEndpoint) {
					const { url, token } = bootstrapEndpoint;
					await adb(
						this.db.transaction('syncservers', 'readwrite').objectStore('syncservers').put({
							url,
							token,
							lastSync: new Date(0),
						}),
					);
					this.backgroundSync();
				}
			} else {
				this.modal.setBody('<p>Welcome back!</p>');
				this.modal.showFormDelayed(500, true);
				await this.initialRead();
			}
			await this.reflectSyncServers();
			await this.reflectStorageInfo();
			this.wiki.addTiddler({
				title: '$:/status/TiddlyPWASalt',
				text: await b64enc(this.salt),
			});
			this.modal.close();
			delete this.modal;
			this.initServiceWorker(); // don't await
			if (freshDb && navigator.storage) navigator.storage.persist().then(() => this.reflectStorageInfo());
		}

		getStatus(cb) {
			this._getStatus().then((_) =>
				cb(
					null, // err
					false, // isLoggedIn
					null, // username
					false, // isReadOnly
					false, // isAnonymous
				)
			).catch((e) => {
				console.error(e);
				cb(e);
			});
		}

		getTiddlerInfo(_tiddler) {
			return {};
		}

		getTiddlerRevision(_title) {
			return null;
		}

		getUpdatedTiddlers(_syncer, cb) {
			const chg = {
				modifications: [...this.modifiedQueue],
				deletions: [...this.deletedQueue],
			};
			this.logger.log('Reflecting updates to wiki runtime');
			this.modifiedQueue.clear();
			this.deletedQueue.clear();
			cb(null, chg);
		}

		titlehash(x) {
			// keyed (hmac) because sync servers don't need to be able to compare contents between different users
			return crypto.subtle.sign('HMAC', this.mackey, utfenc.encode(x));
		}

		/** @param {ArrayBuffer} thash */
		enckey(thash) {
			return this.enckeys[new DataView(thash).getUint8(0) % this.enckeys.length];
		}

		async _saveTiddler(tiddler) {
			const thash = await this.titlehash(tiddler.fields.title);
			const key = this.enckey(thash);
			const isBin = this.wiki.isBinaryTiddler(tiddler.fields.title);
			const isSepBody = tiddler.fields.text && (isBin || tiddler.fields.text.length > 256);
			const json = JSON.stringify(
				Object.keys(tiddler.fields).reduce((o, k) => {
					if (k === 'text' && isSepBody) return o;
					o[k] = tiddler.getFieldString(k);
					return o;
				}, Object.create(null)),
			);
			// "if you use nonces longer than 12 bytes, they get hashed into 12 bytes anyway" - soatok.blog
			const iv = crypto.getRandomValues(new Uint8Array(12));
			const ct = await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv },
				key,
				await encodeData(json, false, 256),
			);
			let sbiv, sbct;
			if (isSepBody) {
				sbiv = crypto.getRandomValues(new Uint8Array(12));
				sbct = await crypto.subtle.encrypt(
					{ name: 'AES-GCM', iv: sbiv },
					key,
					await encodeData(tiddler.fields.text, isBin, 256),
				);
			}
			await adb(
				this.db.transaction('tiddlers', 'readwrite').objectStore('tiddlers').put({
					thash, // The title hash is the primary key
					iv,
					ct,
					sbiv,
					sbct,
					mtime: new Date(), // Has to be unencrypted for sync conflict resolution
					// also, *not* using the tiddler's modified field allows for importing tiddlers last modified in the past
				}),
			);
			await this.reflectStorageInfo();
		}

		saveTiddler(tiddler, cb) {
			if (tiddler.fields._is_skinny) {
				// This probably has prevented data loss in the Section Editor case #23
				return cb(null, '', 1);
			}
			if (tiddler.fields.title === '$:/Import') {
				// For some reason this is not in the default $:/config/SyncFilter but no one would want this actually stored.
				return cb(null, '', 1);
			}
			if (
				(tiddler.fields.type === 'application/json' && tiddler.fields['plugin-type']) ||
				(tiddler.fields.type === 'application/javascript' && tiddler.fields['module-type'])
			) {
				$tw.syncer.isDirty = () => true; // make the UI insist on a save which would be the app save
				return cb(null, '', 1);
			}
			this._saveTiddler(tiddler).then((_) => {
				cb(null, '', 1);
				if (tiddler.fields.title !== '$:/StoryList') {
					this.changesChannel.postMessage({ title: tiddler.fields.title });
					this.backgroundSync();
				}
			}).catch((e) => {
				console.error(e);
				cb(e);
			});
		}

		async _loadTiddler(title) {
			const thash = await this.titlehash(title);
			const obj = await adb(this.db.transaction('tiddlers').objectStore('tiddlers').get(thash));
			if (obj.deleted) return null;
			const tid = await this.parseEncryptedTiddler(obj);
			if (obj.sbiv && obj.sbct) {
				tid.text = await decodeData(
					await crypto.subtle.decrypt({ name: 'AES-GCM', iv: obj.sbiv }, this.enckey(thash), obj.sbct),
				);
			}
			return tid;
		}

		loadTiddler(title, cb) {
			this._loadTiddler(title).then((tiddler) => {
				cb(null, tiddler);
				if (title === $tw.syncer.titleSyncFilter) {
					// XXX: syncer should itself monitor for changes and recompile
					$tw.syncer.filterFn = this.wiki.compileFilter(tiddler.text);
				}
			}).catch((e) => {
				console.error(e);
				cb(e);
			});
		}

		async _deleteTiddler(title) {
			const thash = await this.titlehash(title);
			await adb(
				this.db.transaction('tiddlers', 'readwrite').objectStore('tiddlers').put({
					thash,
					iv: undefined,
					ct: undefined,
					sbiv: undefined,
					sbct: undefined,
					mtime: new Date(),
					deleted: true,
				}),
			);
			await this.reflectStorageInfo();
		}

		deleteTiddler(title, cb, _options) {
			this._deleteTiddler(title).then((_) => {
				cb(null);
				this.changesChannel.postMessage({ title, del: true });
				this.backgroundSync();
				if (this.tiddlersInFile.has(title)) {
					this.logger.alert(
						`You have deleted the tiddler <code>${title}</code> which was in the app wiki file. If you want it gone, you must also save the app wiki; conversely, you can refresh the page to restore it.`,
					);
				}
			}).catch((e) => {
				console.error(e);
				cb(e);
			});
		}

		async uploadAppWiki(variables) {
			if (!this.wiki.getTiddler('$:/core') || !this.wiki.getTiddler('$:/plugins/valpackett/tiddlypwa')) {
				this.logger.alert(
					'You have deleted the TiddlyPWA plugin and tried to save the app HTML to the server! Refusing to self-destruct.',
				);
				return;
			}
			this.wiki.addTiddler({ title: '$:/status/TiddlyPWAUploadResult', text: 'Upload in progress.' });
			this.wiki.addTiddler({ title: '$:/status/TiddlyPWAUploading', text: 'yes' });
			const apphtml = $tw.wiki.renderTiddler(
				'text/plain',
				$tw.wiki.getTiddlerText('$:/config/SaveWikiButton/Template', '$:/core/save/all'),
				{ variables },
			);
			const swjs = $tw.wiki.renderTiddler('text/plain', '$:/plugins/valpackett/tiddlypwa/sw.js', {});
			try {
				const servers = (variables.uploadUrl && variables.uploadToken)
					? [{ url: variables.uploadUrl, token: variables.uploadToken }]
					: await adb(
						this.db.transaction('syncservers').objectStore('syncservers').getAll(),
					);
				const resps = await Promise.all(servers.map(async ({ url, token }) => {
					const resp = await fetch(url, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({
							tiddlypwa: 1,
							op: 'uploadapp',
							token,
							authcode: this.mackey && await b64enc(await this.titlehash(token)),
							browserToken: this.browserToken,
							files: {
								'app.html': {
									body: apphtml,
									ctype: 'text/html;charset=utf-8',
								},
								'sw.js': {
									body: swjs,
									ctype: 'application/javascript',
								},
							},
						}),
					});
					return [url, resp];
				}));
				const urls = [];
				for (const [url, resp] of resps) {
					if (!resp.ok) {
						try {
							const { error } = await resp.json();
							urls.push(`${url}: ${knownErrors[error] || error}`);
						} catch (_e) {
							urls.push(`${url}: Server returned error ${resp.status}`);
						}
						continue;
					}
					const href = new URL((await resp.json()).urlprefix + 'app.html', new URL(url, document.location)).href;
					const isCurrent = isCurrentUrl(href);
					urls.push(
						href + (isCurrent ? ' {{$:/plugins/valpackett/tiddlypwa/cur-page-reload}}' : ''),
					);
					if (isCurrent) {
						// This makes sure we instantly reload into the new version!
						// The ServiceWorker will refetch from the server in the background again,
						// so this should not cause any trouble. E.g. a concurrent update that
						// happened in between upload and refresh would arrive as a new refresh prompt.
						// The ETag is generated in a way that matches the reference server (assuming Brotli is working).
						// If the ETag is different, sync will notice the mismatch and request the worker to reload.
						try {
							const cache = await caches.open('tiddlypwa');
							for (const req of await cache.keys()) {
								if (req.url === href) {
									cache.put(
										req,
										new Response(apphtml, {
											headers: {
												'content-type': 'text/html;charset=utf-8',
												'etag': `"${await b64enc(await crypto.subtle.digest('SHA-1', utfenc.encode(apphtml)))}-b"`,
											},
										}),
									);
								}
							}
						} catch (e) {
							this.logger.alert('Failed to update local cache!');
							console.error(e);
						}
					}
				}
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWAUploadResult', text: 'Uploaded:\n\n* ' + urls.join('\n* ') });
			} catch (e) {
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWAUploadResult', text: 'Upload error: ' + e });
				console.error(e);
			} finally {
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWAUploading', text: 'no' });
			}
		}

		async _syncOneUnlocked({ url, token, lastSync = new Date(0) }, all = false) {
			this.logger.log('sync started', url, lastSync, all);
			this.wiki.addTiddler({ title: '$:/status/TiddlyPWASyncingWith', text: url });
			const changes = [];
			const it = adbiter(this.db.transaction('tiddlers').objectStore('tiddlers').openCursor());
			for await (const tid of it) if (all || tid.mtime > lastSync) changes.push(tid);
			const clientChanges = [];
			const localChangesByHash = new Map();
			let newestChg = new Date(0);
			for (const tid of changes) {
				const { thash, iv, ct, sbiv, sbct, mtime, deleted } = tid;
				if (arrayEq(thash, this.storyListHash)) continue;
				if (mtime > newestChg) {
					newestChg = mtime;
				}
				const b64hash = await b64enc(thash);
				const tidjson = {
					thash: b64hash,
					ct: ct && (await b64enc(ct)),
					iv: iv && (await b64enc(iv)),
					sbct: sbct && (await b64enc(sbct)),
					sbiv: sbiv && (await b64enc(sbiv)),
					mtime,
					deleted,
				};
				clientChanges.push(tidjson);
				localChangesByHash.set(b64hash, tid);
				this.logger.log('local change', tidjson.thash);
			}
			this.syncAbort = new AbortController();
			const resp = await fetch(url, {
				signal: this.syncAbort.signal,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					tiddlypwa: 1,
					op: 'sync',
					token,
					browserToken: this.browserToken,
					authcode: await b64enc(await this.titlehash(token)),
					salt: await b64enc(this.salt),
					now: new Date(), // only for a desync check
					lastSync,
					clientChanges,
				}),
			}).catch((e) => {
				throw new FetchError(e); // so silly that fetch throws inconsistent stuff across browsers
			});
			if (!resp.ok) {
				throw new Error(
					await resp
						.json()
						.then(({ error }) => knownErrors[error] || error)
						.catch((_e) => 'Server returned error ' + resp.status),
				);
			}
			const { serverChanges, appEtag } = await resp.json();
			const toDecrypt = [];
			const titleHashesToDelete = new Set();
			const idbWrites = [];
			const conflictTiddlersToAdd = [];

			for (const { thash, iv, ct, sbiv, sbct, mtime, deleted } of serverChanges) {
				const dhash = b64dec(thash);
				if (!dhash || arrayEq(dhash, this.storyListHash)) continue;
				const remotetid = {
					thash: dhash.buffer,
					ct: ct && b64dec(ct).buffer,
					iv: iv && b64dec(iv).buffer,
					sbct: sbct && b64dec(sbct).buffer,
					sbiv: sbiv && b64dec(sbiv).buffer,
					mtime: new Date(mtime),
					deleted: !!deleted,
				};
				this.logger.log('remote change', thash);

				const ourtid = localChangesByHash.get(thash);
				if (ourtid) {
					const ourMtime = ourtid.mtime instanceof Date ? ourtid.mtime : new Date(ourtid.mtime);
					this.logger.log('conflict detected:', thash, 'server:', remotetid.mtime, 'local:', ourMtime);

					if (ourtid.deleted && remotetid.deleted) {
						// Both deleted: no-op, retain deletion
						idbWrites.push(remotetid);
						titleHashesToDelete.add(thash);
					} else if (!ourtid.deleted && !remotetid.deleted) {
						// Both edited concurrently
						const ourDecrypted = await this.decryptRawTiddler(ourtid);
						const remoteDecrypted = await this.decryptRawTiddler(remotetid);

						if (this.tiddlersAreEqual(ourDecrypted, remoteDecrypted)) {
							this.logger.log('False conflict suppressed (identical payload):', thash);
							idbWrites.push(remotetid);
							toDecrypt.push(remotetid);
						} else {
							const originalTitle = ourDecrypted?.title || remoteDecrypted?.title || 'Untitled';
							if (ourMtime.getTime() > remotetid.mtime.getTime()) {
								// Local is newer: Local remains canonical, preserve remote copy
								this.logger.log('Local is newer; keeping local canonical and saving remote conflict copy');
								if (remoteDecrypted) {
									conflictTiddlersToAdd.push(
										this.createConflictTiddler(remoteDecrypted, originalTitle, 'remote', remotetid.mtime),
									);
								}
							} else {
								// Server is newer (or equal): Remote is canonical, preserve local copy
								this.logger.log('Server is newer; applying server canonical and preserving local conflict copy');
								if (ourDecrypted) {
									conflictTiddlersToAdd.push(
										this.createConflictTiddler(ourDecrypted, originalTitle, 'local', ourMtime),
									);
								}
								idbWrites.push(remotetid);
								toDecrypt.push(remotetid);
							}
						}
					} else if (!ourtid.deleted && remotetid.deleted) {
						// Local edit vs Remote delete
						const ourDecrypted = await this.decryptRawTiddler(ourtid);
						const originalTitle = ourDecrypted?.title || 'Untitled';
						if (remotetid.mtime.getTime() > ourMtime.getTime()) {
							// Remote delete is newer: Apply deletion, preserve local edits in conflict copy
							this.logger.log('Remote delete is newer; preserving local edit in conflict copy');
							if (ourDecrypted) {
								conflictTiddlersToAdd.push(
									this.createConflictTiddler(ourDecrypted, originalTitle, 'local', ourMtime),
								);
							}
							idbWrites.push(remotetid);
							titleHashesToDelete.add(thash);
						} else {
							// Local edit is newer: Local edit resurrects tiddler
							this.logger.log('Local edit is newer than remote delete; resurrecting local');
						}
					} else if (ourtid.deleted && !remotetid.deleted) {
						// Local delete vs Remote edit
						const remoteDecrypted = await this.decryptRawTiddler(remotetid);
						const originalTitle = remoteDecrypted?.title || 'Untitled';
						if (remotetid.mtime.getTime() > ourMtime.getTime()) {
							// Remote edit is newer: Remote edit resurrects tiddler
							this.logger.log('Remote edit is newer than local delete; applying remote edit');
							idbWrites.push(remotetid);
							toDecrypt.push(remotetid);
						} else {
							// Local delete is newer: Delete wins, preserve remote edit in conflict copy
							this.logger.log('Local delete is newer than remote edit; preserving remote edit in conflict copy');
							if (remoteDecrypted) {
								conflictTiddlersToAdd.push(
									this.createConflictTiddler(remoteDecrypted, originalTitle, 'remote', remotetid.mtime),
								);
							}
						}
					}
				} else {
					// Normal non-conflicting change from server
					idbWrites.push(remotetid);
					if (remotetid.deleted) {
						titleHashesToDelete.add(thash);
					} else {
						toDecrypt.push(remotetid);
					}
				}

				if (remotetid.mtime > newestChg) {
					newestChg = remotetid.mtime;
				}
			}

			// Batch commit canonical updates to IndexedDB in one synchronous transaction
			if (idbWrites.length > 0) {
				const txn = this.db.transaction('tiddlers', 'readwrite');
				const store = txn.objectStore('tiddlers');
				for (const tid of idbWrites) {
					store.put(tid);
				}
				await new Promise((resolve, reject) => {
					txn.oncomplete = resolve;
					txn.onerror = () => reject(txn.error);
				});
			}

			// Add conflict copies to wiki runtime (which triggers syncer save and server replication)
			for (const conflictTid of conflictTiddlersToAdd) {
				this.wiki.addTiddler(conflictTid);
			}
			if (conflictTiddlersToAdd.length > 0) {
				this.wiki.addTiddler({
					title: '$:/status/TiddlyPWAConflictsCount',
					text: String(this.wiki.filterTiddlers('[tag[$:/tags/TiddlyPWA/Conflict]]').length),
				});
				if ($tw.notifier) {
					$tw.notifier.display('$:/plugins/valpackett/tiddlypwa/notif-conflict');
				}
			}
			for (const title of $tw.wiki.allTitles()) {
				if (titleHashesToDelete.has(await b64enc(await this.titlehash(title)))) {
					this.deletedQueue.add(title);
					this.changesChannel.postMessage({ title, del: true });
				}
			}
			for (const x of toDecrypt) {
				const { title } = await this.parseEncryptedTiddler(x);
				// isReady, so only go through the syncer mechanism here, even though that results in double decryption
				if (title !== '$:/StoryList') {
					this.modifiedQueue.add(title);
					this.changesChannel.postMessage({ title });
				}
			}
			if (appEtag && navigator.serviceWorker.controller) {
				const cache = await caches.open('tiddlypwa');
				for (const req of await cache.keys()) {
					if (!isCurrentUrl(req.url)) continue;
					const resp = await cache.match(req);
					const cachedEtag = resp.headers.get('etag');
					if (!cachedEtag || cachedEtag === appEtag) continue;
					navigator.serviceWorker.controller.postMessage({ op: 'update', url: req.url });
				}
			}
			this.logger.log('sync done', url);
			if (lastSync > newestChg) {
				newestChg = lastSync;
			}
			return newestChg;
		}

		async _syncManyUnlocked(all) {
			let hadSuccess = false;
			const servers = [];
			await new Promise((resolve) =>
				this.db.transaction('syncservers').objectStore('syncservers').openCursor().onsuccess = (evt) => {
					const cursor = evt.target.result;
					if (!cursor) {
						return resolve();
					}
					servers.push([cursor.key, cursor.value]);
					cursor.continue();
				}
			);
			for (const [key, server] of servers) {
				try {
					server.lastSync = await this._syncOneUnlocked(server, all);
					await adb(this.db.transaction('syncservers', 'readwrite').objectStore('syncservers').put(server, key));
					hadSuccess = true;
					this.hadFetchError = false;
				} catch (e) {
					if (e.name === 'AbortError') {
						/* Not an error */
					} else if (e.name === 'FetchError') {
						if (!this.hadFetchError) {
							this.logger.alert(`Could not sync with server "${server.url}"! You might be offline (or the server is).`);
							console.error(e);
							this.hadFetchError = true;
						}
					} else {
						this.logger.alert(`Could not sync with server "${server.url}"!`, e);
						console.error(e);
					}
				}
			}
			$tw.syncer.syncFromServer(); // "server" being our local DB that we just updated, actually
			await this.reflectSyncServers();
			await this.reflectStorageInfo();
			this.wiki.addTiddler({ title: '$:/status/TiddlyPWASyncing', text: 'no' });
			$tw.utils.removeClass(document.body, 'tiddlypwa-syncing');
			this.isSyncing = false;
			if (this.afterSyncOnceHook && hadSuccess) {
				this.afterSyncOnceHook();
				delete this.afterSyncOnceHook;
			}
			if (this.wantResync) {
				this.wantResync = false;
				this.backgroundSync();
			}
		}

		sync(all) {
			if (this.isSyncing) {
				this.wantResync = true;
				return;
			}
			this.isSyncing = true;
			$tw.utils.addClass(document.body, 'tiddlypwa-syncing');
			this.wiki.addTiddler({ title: '$:/status/TiddlyPWASyncing', text: 'yes' });
			return navigator.locks.request(`tiddlypwa:${location.pathname}`, (_lck) => this._syncManyUnlocked(all));
		}

		backgroundSync() {
			if (!navigator.onLine || !this.isReady()) return;
			// debounced to handle multiple saves in quick succession
			clearTimeout(this.syncTimer);
			this.syncTimer = setTimeout(() => this.sync(false), 1000);
		}
	}

	exports.adaptorClass = PWAStorage;
})();
