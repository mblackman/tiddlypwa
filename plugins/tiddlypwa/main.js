/*\
title: $:/plugins/mblackman/tiddlypwa/main.js
type: application/javascript
module-type: syncadaptor

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/
/// <reference types="npm:tw5-typed" />
(function () {
	'use strict';

	if (!$tw.browser) return;

	// Do this early to make it work on login screen too
	if ('serviceWorker' in navigator) {
		navigator.serviceWorker.addEventListener('message', (evt) => {
			if (evt.data?.op == 'refresh') {
				$tw.wiki.addTiddler({ title: '$:/status/TiddlyPWAUpdateAvailable', text: 'yes' });
			} else if (evt.data?.op === 'push-click') {
				$tw.syncadaptor?.handleServiceWorkerPushClick?.(evt.data.clickEvent);
			}
		});
	}

	// Patch this to make upgrading core by drag&drop reflect the version number in generated html
	$tw.utils.extractVersionInfo = () => $tw.wiki.getTiddler('$:/core')?.fields?.version || '';
	Object.defineProperty($tw, 'version', { get: $tw.utils.extractVersionInfo });

	// Allow re-importing/updating a plugin with the same version number during drag&drop imports,
	// while still suppressing older versions.
	if ($tw.modules?.titles?.['$:/core/modules/upgraders/plugins.js']) {
		try {
			const pluginUpgrader = require('$:/core/modules/upgraders/plugins.js');
			const origUpgrade = pluginUpgrader.upgrade;
			if (typeof origUpgrade === 'function') {
				pluginUpgrader.upgrade = function (wiki, titles, tiddlers) {
					const origCheckVersions = $tw.utils.checkVersions;
					$tw.utils.checkVersions = (vA, vB) => $tw.utils.compareVersions(vA, vB) === 1;
					try {
						return origUpgrade.call(this, wiki, titles, tiddlers);
					} finally {
						$tw.utils.checkVersions = origCheckVersions;
					}
				};
			}
		} catch (e) {
			console.warn('Could not patch plugin upgrader:', e);
		}
	}

	// Patch this to direct all actual plugins into the app wiki saving process,
	// while ignoring internal pseudo-plugins ($:/temp/info-plugin) and import payloads.
	const origDoesPluginRequireReload = $tw.wiki.doesPluginRequireReload;
	$tw.wiki.doesPluginRequireReload = function (title) {
		if (title === '$:/temp/info-plugin' || (typeof title === 'string' && title.startsWith('$:/temp/'))) {
			return false;
		}
		const tiddler = this.getTiddler(title);
		if (tiddler && tiddler.fields.type === 'application/json' && tiddler.fields['plugin-type']) {
			if (tiddler.fields['plugin-type'] === 'import' || tiddler.fields['plugin-type'] === 'info') {
				return false;
			}
			// In TiddlyPWA, plugins, themes, and languages cannot be synced via IndexedDB/server;
			// they must be saved into the app HTML file. Thus all genuine plugins require reload.
			return true;
		}
		if (tiddler && tiddler.fields.type === 'application/javascript' && tiddler.fields['module-type']) {
			if (tiddler.fields['module-type'] === 'pwa-watcher') {
				return false;
			}
			return true;
		}
		return origDoesPluginRequireReload ? origDoesPluginRequireReload.call(this, title) : false;
	};

	$tw.wiki.doesPluginInfoRequireReload = (x) => {
		if (!x || typeof x !== 'object' || !('tiddlers' in x)) return false;
		if (x['plugin-type'] === 'import' || x['plugin-type'] === 'info') return false;
		return true;
	};

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
	const { b64enc, b64encSync, b64urlEnc, b64dec, encodeData, encodeBinaryBytes, decodeData, decodeDataToBytes } =
		require(
			'$:/plugins/mblackman/tiddlypwa/encoding.js',
		);
	const { BootstrapModal } = require('$:/plugins/mblackman/tiddlypwa/bootstrap.js');

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
			const nextPromise = new Promise((resolve, reject) => {
				res = resolve;
				rej = reject;
			});
			cursor.continue();
			cursor = await nextPromise;
		}
	}

	function formatBytes(bytes) {
		if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '0 bytes';
		const sizes = ['bytes', '~KiB', '~MiB', '~GiB', '~TiB'];
		const i = Math.min(sizes.length - 1, Math.max(0, Math.floor(Math.log(bytes) / Math.log(1024))));
		return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[i];
	}

	function arrayEq(a, b) {
		const av = new Uint8Array(a);
		const bv = new Uint8Array(b);
		if (av.byteLength !== bv.byteLength) return false;
		return av.every((val, i) => val === bv[i]);
	}

	function isCurrentUrl(url) {
		try {
			const u = new URL(url, location.origin);
			return u.origin === location.origin && u.pathname === location.pathname;
		} catch (_e) {
			return url === `${location.origin}${location.pathname}${location.search}`;
		}
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

	function isDraftTiddler(tid) {
		if (!tid) return false;
		if (typeof tid.isDraft === 'function' && tid.isDraft()) return true;
		const fields = tid.fields || tid;
		if (fields['draft.of']) return true;
		if (typeof fields.title === 'string' && fields.title.startsWith("Draft of '")) return true;
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
		// Resolved once stored tiddlers are loaded (or interactive UI is needed); boot-gate.js waits on it
		// before letting the core "story" and "render" startup tasks run.
		bootReleased = false;
		bootGate = new Promise((resolve) => {
			this._resolveBootGate = resolve;
		});

		releaseBoot() {
			if (this.bootReleased) return;
			this.bootReleased = true;
			this._resolveBootGate();
		}

		constructor(options) {
			this.wiki = options.wiki;
			this.tiddlersInFile = new Set(this.wiki.getTiddlers({ includeSystem: true }));
			this.logger = new $tw.utils.Logger('tiddlypwa-storage');
			this.monitorTimeout = 2000;
			this.modifiedQueue = new Set();
			this.deletedQueue = new Set();
			this.ackedPatchIds = new Set();
			this.appliedPatchIds = new Set();
			this.blobRegistry = new Map();
			this.titleBlobUrls = new Map();
			this.savedBlobSha = new Map();
			this.titleToHashB64 = new Map();
			this.hashB64ToTitle = new Map();
			this.titleToHashBuf = new Map();
			this.storageInfoTimer = null;
			this.lastSyncError = '';
			this.lastServerCount = 0;
			this.lastUnsyncedCount = 0;
			this.syncedRuleSchedules = new Map();
			this.ruleSchedulesLoaded = false;
			this.syncedWatchers = new Map();
			this.watchersLoaded = false;
			this.changesChannel = new BroadcastChannel(`tiddlypwa-changes:${location.pathname}`);
			this.changesChannel.onmessage = async (evt) => {
				this.logger.log('Change from another tab');
				if (evt.data.del) {
					this.deletedQueue.add(evt.data.title);
				} else {
					const changedTitle = evt.data.title;
					const draftTitle = this.wiki.findDraft?.(changedTitle) || `Draft of '${changedTitle}'`;
					if (changedTitle && this.wiki.tiddlerExists(draftTitle) && this.db && this.mackey && this.enckeys) {
						try {
							const remoteTid = await this._loadTiddler(changedTitle);
							if (remoteTid) {
								this.checkDraftCollision(changedTitle, remoteTid, new Date());
							}
						} catch (e) {
							console.warn('Could not check cross-tab draft collision:', e);
						}
					}
					this.modifiedQueue.add(changedTitle);
				}
				$tw.syncer.syncFromServer(); // "server" being our local DB
				this.backgroundSync();
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
				const payload = typeof evt.data === 'object' && evt.data !== null
					? evt.data
					: { remembered: Boolean(evt.data), biometric: false };
				this.wiki.addTiddler({
					title: '$:/status/TiddlyPWARemembered',
					text: payload.remembered ? 'yes' : 'no',
				});
				this.wiki.addTiddler({
					title: '$:/status/TiddlyPWABiometricConfigured',
					text: payload.biometric ? 'yes' : 'no',
				});
				if (!payload.biometric) {
					this.biometricSession = null;
				}
			};

			this.wiki.addEventListener('change', (changes) => {
				if (changes['$:/temp/TiddlyPWAPairIncludeKey']) {
					this.updatePairUrl();
				}
				if (changes['$:/SiteTitle'] || changes['$:/SiteSubtitle'] || changes['$:/palette']) {
					this.reflectSplashCache();
				}
				if (this.isReady()) {
					const hasRelevantChange = Object.keys(changes).some((title) =>
						title !== '$:/StoryList' &&
						title !== '$:/HistoryList' &&
						!title.startsWith('$:/state/') &&
						!title.startsWith('$:/status/') &&
						!title.startsWith('$:/temp/') &&
						!title.startsWith("Draft of '")
					);
					if (hasRelevantChange) {
						this.scheduleNotificationRuleSync();
						this.scheduleWatcherSync();
					}
				}
			});

			this.wiki.addTiddler({ title: '$:/status/TiddlyPWAOrigin', text: location.origin });

			this.wiki.addTiddler({ title: '$:/status/TiddlyPWAOnline', text: navigator.onLine ? 'yes' : 'no' });
			globalThis.addEventListener(
				'offline',
				(_evt) => {
					this.wiki.addTiddler({ title: '$:/status/TiddlyPWAOnline', text: 'no' });
					this.updateSyncUiStatus();
				},
			);
			globalThis.addEventListener(
				'online',
				(_evt) => {
					this.wiki.addTiddler({ title: '$:/status/TiddlyPWAOnline', text: 'yes' });
					this.updateSyncUiStatus();
					if (this.db) {
						clearTimeout(this.wakeTimer);
						this.wakeTimer = setTimeout(() => {
							this.backgroundSync();
							this.startRealtimeMonitor();
						}, 1500);
					}
				},
			);

			const flushPendingSync = () => {
				if (!this.isReady() || !navigator.onLine) return;
				try {
					$tw.syncer?.processTaskQueue?.();
				} catch (_e) { /* ignore syncer flush error during teardown */ }
				clearTimeout(this.ruleSyncTimer);
				this.syncNotificationRules().catch(() => {});
				if (this.syncTimer || ($tw.syncer && Object.keys($tw.syncer.taskQueue || {}).length > 0)) {
					clearTimeout(this.syncTimer);
					this.syncTimer = null;
					this.sync(false);
				}
			};
			document.addEventListener('visibilitychange', (_evt) => {
				if (document.visibilityState === 'visible') {
					clearTimeout(this.visibilityTimer);
					this.visibilityTimer = setTimeout(() => {
						this.backgroundSync();
						if (this.db && this.startedMonitor && this.monitorStream?.readyState === EventSource.CLOSED) {
							this.startRealtimeMonitor();
						}
					}, 1000);
				} else if (document.visibilityState === 'hidden') {
					flushPendingSync();
				}
			});
			globalThis.addEventListener('pagehide', flushPendingSync);

			$tw.rootWidget.addEventListener('tiddlypwa-remember', (_evt) => {
				if (!confirm('Are you sure you want to remember the password?')) {
					return;
				}
				this.db.transaction('session', 'readwrite').objectStore('session').put({
					enckeys: this.enckeys,
					mackey: this.mackey,
					pushKey: this.pushKey,
					watcherSignKey: this.watcherSignKey,
					watcherPubKeyB64: this.watcherPubKeyB64,
				})
					.onsuccess = (
						_evt,
					) => {
						this.wiki.addTiddler({ title: '$:/status/TiddlyPWARemembered', text: 'yes' });
						this.wiki.addTiddler({ title: '$:/status/TiddlyPWABiometricConfigured', text: 'no' });
						this.biometricSession = null;
						$tw.notifier.display('$:/plugins/mblackman/tiddlypwa/notif-remembered');
						this.sessionChannel.postMessage({ remembered: true, biometric: false });
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
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWABiometricConfigured', text: 'no' });
				this.biometricSession = null;
				this.sessionChannel.postMessage({ remembered: false, biometric: false });
			});

			$tw.rootWidget.addEventListener('tiddlypwa-enable-biometrics', async (_evt) => {
				if (!this.basebits) {
					this.wiki.addTiddler({
						title: '$:/status/TiddlyPWABiometricNotice',
						text: 'Please log in with your master password (without Remember Password) before enabling biometrics.',
					});
					return;
				}
				if (!window.PublicKeyCredential || !window.isSecureContext) {
					this.wiki.addTiddler({
						title: '$:/status/TiddlyPWABiometricNotice',
						text: 'WebAuthn biometrics is not supported in this browser or context (HTTPS is required).',
					});
					return;
				}
				try {
					const prfSalt = crypto.getRandomValues(new Uint8Array(32));
					const credential = await navigator.credentials.create({
						publicKey: {
							challenge: crypto.getRandomValues(new Uint8Array(32)),
							rp: { name: 'TiddlyPWA', id: window.location.hostname },
							user: {
								id: crypto.getRandomValues(new Uint8Array(16)),
								name: 'tiddlypwa-user',
								displayName: 'TiddlyPWA User',
							},
							pubKeyCredParams: [
								{ alg: -7, type: 'public-key' },
								{ alg: -257, type: 'public-key' },
							],
							authenticatorSelection: {
								authenticatorAttachment: 'platform',
								userVerification: 'required',
								residentKey: 'preferred',
							},
							extensions: {
								prf: {
									eval: {
										first: prfSalt,
									},
								},
							},
						},
					});
					const extResults = credential?.getClientExtensionResults ? credential.getClientExtensionResults() : null;
					const prfOutput = extResults?.prf?.results?.first;
					if (!prfOutput) {
						this.wiki.addTiddler({
							title: '$:/status/TiddlyPWABiometricNotice',
							text: 'Your device or authenticator does not support the WebAuthn PRF extension for hardware encryption.',
						});
						return;
					}
					const prfBaseKey = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
					const wrappingKey = await crypto.subtle.deriveKey(
						{
							name: 'HKDF',
							hash: 'SHA-256',
							salt: prfSalt,
							info: utfenc.encode('tiddlypwa.biometric.kek'),
						},
						prfBaseKey,
						{ name: 'AES-GCM', length: 256 },
						false,
						['encrypt'],
					);
					const iv = crypto.getRandomValues(new Uint8Array(12));
					const ciphertextBuffer = await crypto.subtle.encrypt(
						{ name: 'AES-GCM', iv },
						wrappingKey,
						this.basebits,
					);
					const sessionRecord = {
						mode: 'biometric_prf',
						credId: credential.rawId,
						prfSalt,
						iv,
						ciphertext: ciphertextBuffer,
						createdAt: new Date(),
					};
					const sessionStore = this.db.transaction('session', 'readwrite').objectStore('session');
					sessionStore.clear();
					await adb(sessionStore.put(sessionRecord));
					this.biometricSession = sessionRecord;
					this.wiki.addTiddler({ title: '$:/status/TiddlyPWABiometricConfigured', text: 'yes' });
					this.wiki.addTiddler({ title: '$:/status/TiddlyPWARemembered', text: 'no' });
					this.sessionChannel.postMessage({ remembered: false, biometric: true });
					this.wiki.addTiddler({
						title: '$:/status/TiddlyPWABiometricNotice',
						text: 'Biometric Unlock is now enabled on this device.',
					});
				} catch (e) {
					console.error('Failed to enable biometrics:', e);
					this.wiki.addTiddler({
						title: '$:/status/TiddlyPWABiometricNotice',
						text: 'Failed to enable biometrics: ' + (e.message || e),
					});
				}
			});

			$tw.rootWidget.addEventListener('tiddlypwa-disable-biometrics', async (_evt) => {
				const sessionStore = this.db.transaction('session', 'readwrite').objectStore('session');
				sessionStore.clear();
				this.biometricSession = null;
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWABiometricConfigured', text: 'no' });
				this.sessionChannel.postMessage({ remembered: false, biometric: false });
				this.wiki.addTiddler({
					title: '$:/status/TiddlyPWABiometricNotice',
					text: 'Biometric Unlock has been disabled.',
				});
			});

			$tw.rootWidget.addEventListener('tiddlypwa-refresh-pair-url', async (_evt) => {
				await this.updatePairUrl();
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
					this.logger.alert('A sync server must have a URL and a token!');
					return;
				}
				try {
					new URL(url, document.location);
				} catch (_e) {
					this.logger.alert('The URL must be valid!');
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

			$tw.rootWidget.addEventListener('tiddlypwa-open-save-dialog', (_evt) => {
				$tw.modal.display('$:/plugins/mblackman/tiddlypwa/sync-dialog', {});
			});

			$tw.rootWidget.addEventListener('tiddlypwa-upload-app-wiki', (evt) => {
				this.uploadAppWiki(evt.paramObject);
			});

			// Override core's tm-browser-refresh listener so any core refresh buttons or shortcuts
			// reload through the Service Worker instead of calling location.reload(true).
			$tw.rootWidget.addEventListener('tm-browser-refresh', (_evt) => {
				location.reload();
				return false;
			});

			$tw.rootWidget.addEventListener('tiddlypwa-browser-refresh', (_evt) => {
				location.reload(); // tm-browser-refresh passes 'true' which skips the serviceworker. silly!
			});

			$tw.rootWidget.addEventListener('tiddlypwa-browser-refresh-force', (_evt) => {
				this.appWikiDirty = false;
				$tw.syncer.isDirty = () => false; // skip the onbeforeunload
				location.reload(); // tm-browser-refresh passes 'true' which skips the serviceworker. silly!
			});

			$tw.rootWidget.addEventListener('tiddlypwa-sync-cancel', (_evt) => {
				this.syncAbort?.abort();
			});

			$tw.rootWidget.addEventListener('tiddlypwa-sync-all', (_evt) => {
				this.sync(true);
			});

			$tw.rootWidget.addEventListener('tiddlypwa-sync', (_evt) => {
				this.sync(false);
			});

			$tw.rootWidget.addEventListener('tiddlypwa-enable-push', (_evt) => {
				this.enablePushNotifications();
			});

			$tw.rootWidget.addEventListener('tiddlypwa-disable-push', (_evt) => {
				this.disablePushNotifications();
			});

			$tw.rootWidget.addEventListener('tiddlypwa-test-push', (_evt) => {
				this.sendTestPushNotification();
			});

			$tw.rootWidget.addEventListener('tm-pwa-schedule-notification', (evt) => {
				this.scheduleAdhocNotification(evt?.paramObject || {});
			});

			$tw.rootWidget.addEventListener('tm-pwa-cancel-notification', (evt) => {
				this.cancelAdhocNotification(evt?.paramObject || {});
			});

			$tw.rootWidget.addEventListener('tm-pwa-run-watcher', (evt) => {
				const watcherId = evt?.paramObject?.watcherId || evt?.paramObject?.['watcher-id'] || evt?.param;
				this.runWatcherNow(watcherId);
			});

			$tw.rootWidget.addEventListener('tiddlypwa-run-watcher', (evt) => {
				const watcherId = evt?.paramObject?.watcherId || evt?.paramObject?.['watcher-id'] || evt?.param;
				this.runWatcherNow(watcherId);
			});

			$tw.rootWidget.addEventListener('tiddlypwa-refresh-watchers', (_evt) => {
				this.syncWatchers().then(() => this.refreshServerWatchers()).catch((e) =>
					console.warn('Failed to refresh watchers:', e)
				);
			});

			$tw.rootWidget.addEventListener('tiddlypwa-resolve-conflict', (evt) => {
				this.resolveConflict(evt?.paramObject || {});
			});

			$tw.rootWidget.addEventListener('tiddlypwa-open-conflicts', (_evt) => {
				this.openConflictsView();
			});

			$tw.rootWidget.addEventListener('tiddlypwa-export-single-file', (evt) => {
				this.exportSingleFile(evt?.paramObject || {});
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
			this.reflectPushStatus();
			try {
				const reg = await navigator.serviceWorker.register('sw.js');
				this.swRegistration = reg;
				await this.reflectPushStatus();
				try {
					await reg.update();
				} catch (_updateErr) {
					// Update check failure (e.g. temporary DNS failure or offline) is non-fatal;
					// existing active worker continues to serve offline content.
				}
			} catch (e) {
				console.error(e);
				if (!navigator.onLine) return;
				if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
				$tw.wiki.addTiddler({ title: '$:/status/TiddlyPWAWorkerError', text: e.message });
				$tw.notifier.display('$:/plugins/mblackman/tiddlypwa/notif-sw-error');
			}
		}

		getPushDbName() {
			const scopeUrl = new URL('.', location.href);
			return `tiddlypwa-push:${scopeUrl.pathname}`;
		}

		getScopedCacheName() {
			const scopeUrl = new URL('.', location.href);
			return `tiddlypwa:v2:${scopeUrl.pathname}`;
		}

		openPushDb() {
			return new Promise((resolve, reject) => {
				const req = indexedDB.open(this.getPushDbName(), 1);
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

		async persistPushKeyForServiceWorker() {
			if (!this.pushKey || typeof indexedDB !== 'object') return;
			try {
				const db = await this.openPushDb();
				try {
					await new Promise((resolve, reject) => {
						const txn = db.transaction('state', 'readwrite');
						txn.objectStore('state').put({ key: this.pushKey }, 'pushKey');
						txn.oncomplete = () => resolve();
						txn.onerror = () => reject(txn.error);
					});
				} finally {
					db.close();
				}
			} catch (e) {
				console.warn('Could not persist pushKey for Service Worker:', e);
			}
		}

		async reflectPushStatus() {
			const supported = typeof window !== 'undefined' &&
				'serviceWorker' in navigator &&
				'PushManager' in window &&
				'Notification' in window &&
				window.isSecureContext;
			this.wiki.addTiddler({
				title: '$:/status/TiddlyPWAPushSupported',
				text: supported ? 'yes' : 'no',
			});
			if (!supported) {
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWAPushPermission', text: 'unsupported' });
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWAPushSubscribed', text: 'no' });
				return;
			}
			this.wiki.addTiddler({
				title: '$:/status/TiddlyPWAPushPermission',
				text: Notification.permission,
			});
			try {
				const reg = this.swRegistration || await navigator.serviceWorker.getRegistration();
				const sub = reg?.pushManager ? await reg.pushManager.getSubscription() : null;
				this.pushEndpoint = sub?.endpoint || null;
				this.wiki.addTiddler({
					title: '$:/status/TiddlyPWAPushSubscribed',
					text: sub ? 'yes' : 'no',
				});
				if (sub && !this.syncedPushSubOnce && this.db && this.mackey) {
					this.syncedPushSubOnce = true;
					this.persistPushKeyForServiceWorker();
					const servers = await adb(this.db.transaction('syncservers').objectStore('syncservers').getAll());
					const subJson = sub.toJSON();
					for (const server of servers) {
						fetch(server.url, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								tiddlypwa: 1,
								op: 'push_subscribe',
								token: server.token,
								authcode: await b64enc(await this.titlehash(server.token)),
								subscription: subJson,
								uaHint: navigator.userAgent,
							}),
						}).catch(() => {});
					}
				}
			} catch (e) {
				console.warn('Failed to query push subscription state:', e);
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWAPushSubscribed', text: 'no' });
			}
		}

		async encryptPushNotification(notifObj) {
			if (!this.pushKey) return null;
			const iv = crypto.getRandomValues(new Uint8Array(12));
			const plainBytes = utfenc.encode(JSON.stringify(notifObj));
			const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.pushKey, plainBytes);
			return {
				mode: 'encrypted',
				iv: await b64enc(iv),
				ct: await b64enc(ct),
			};
		}

		async enablePushNotifications() {
			if (!this.db) return;
			this.wiki.addTiddler({ title: '$:/status/TiddlyPWAPushResult', text: 'Enabling push notifications…' });
			try {
				const servers = await adb(this.db.transaction('syncservers').objectStore('syncservers').getAll());
				if (servers.length === 0) {
					this.wiki.addTiddler({
						title: '$:/status/TiddlyPWAPushResult',
						text: 'Please add a sync server first.',
					});
					return;
				}
				const perm = await Notification.requestPermission();
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWAPushPermission', text: perm });
				if (perm !== 'granted') {
					this.wiki.addTiddler({
						title: '$:/status/TiddlyPWAPushResult',
						text: 'Notification permission was not granted.',
					});
					return;
				}

				const primaryServer = servers[0];
				const infoResp = await fetch(primaryServer.url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						tiddlypwa: 1,
						op: 'push_info',
						token: primaryServer.token,
						authcode: await b64enc(await this.titlehash(primaryServer.token)),
					}),
				});
				if (!infoResp.ok) {
					throw new Error(`Server returned status ${infoResp.status} on push_info`);
				}
				const { vapidPublicKey } = await infoResp.json();
				if (!vapidPublicKey) {
					throw new Error('Server did not return a VAPID public key');
				}

				const vapidKeyBytes = b64dec(vapidPublicKey);
				const reg = this.swRegistration || await navigator.serviceWorker.ready;
				let existingSub = await reg.pushManager.getSubscription();
				if (existingSub && existingSub.options?.applicationServerKey) {
					const existingKey = new Uint8Array(existingSub.options.applicationServerKey);
					if (!arrayEq(existingKey, vapidKeyBytes)) {
						await existingSub.unsubscribe().catch(() => {});
						existingSub = null;
					}
				}
				const sub = existingSub || await reg.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: vapidKeyBytes,
				});
				const subJson = sub.toJSON();
				this.pushEndpoint = sub.endpoint;

				await this.persistPushKeyForServiceWorker();

				for (const server of servers) {
					const subResp = await fetch(server.url, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							tiddlypwa: 1,
							op: 'push_subscribe',
							token: server.token,
							authcode: await b64enc(await this.titlehash(server.token)),
							subscription: subJson,
							uaHint: navigator.userAgent,
						}),
					});
					if (!subResp.ok) {
						throw new Error(`Failed to register subscription with ${server.url}`);
					}
				}

				await this.reflectPushStatus();
				this.scheduleNotificationRuleSync();
				this.scheduleWatcherSync();
				this.wiki.addTiddler({
					title: '$:/status/TiddlyPWAPushResult',
					text: 'Push notifications enabled on this device.',
				});
			} catch (e) {
				console.error('Failed to enable push notifications:', e);
				this.wiki.addTiddler({
					title: '$:/status/TiddlyPWAPushResult',
					text: 'Error enabling push notifications: ' + (e.message || e),
				});
			}
		}

		async disablePushNotifications() {
			if (!this.db) return;
			this.wiki.addTiddler({ title: '$:/status/TiddlyPWAPushResult', text: 'Disabling push notifications…' });
			try {
				const reg = this.swRegistration || await navigator.serviceWorker.getRegistration();
				const sub = reg?.pushManager ? await reg.pushManager.getSubscription() : null;
				const endpoint = sub?.endpoint || this.pushEndpoint;

				const servers = await adb(this.db.transaction('syncservers').objectStore('syncservers').getAll());
				for (const server of servers) {
					if (!endpoint) continue;
					await fetch(server.url, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							tiddlypwa: 1,
							op: 'push_unsubscribe',
							token: server.token,
							authcode: await b64enc(await this.titlehash(server.token)),
							endpoint,
						}),
					}).catch((e) => console.warn('Unsubscribe server error:', e));
				}

				if (sub) {
					await sub.unsubscribe();
				}
				this.pushEndpoint = null;
				await this.reflectPushStatus();
				this.wiki.addTiddler({
					title: '$:/status/TiddlyPWAPushResult',
					text: 'Push notifications disabled on this device.',
				});
			} catch (e) {
				console.error('Failed to disable push notifications:', e);
				this.wiki.addTiddler({
					title: '$:/status/TiddlyPWAPushResult',
					text: 'Error disabling push notifications: ' + (e.message || e),
				});
			}
		}

		async sendTestPushNotification() {
			if (!this.db) return;
			this.wiki.addTiddler({ title: '$:/status/TiddlyPWAPushResult', text: 'Sending test push notification…' });
			try {
				const servers = await adb(this.db.transaction('syncservers').objectStore('syncservers').getAll());
				if (servers.length === 0) {
					this.wiki.addTiddler({
						title: '$:/status/TiddlyPWAPushResult',
						text: 'No sync server configured.',
					});
					return;
				}
				await this.persistPushKeyForServiceWorker();
				const payload = await this.encryptPushNotification({
					title: 'TiddlyPWA Push Active',
					body: 'End-to-end encrypted push notification verified on this device!',
					tag: 'tiddlypwa-test',
				});
				const primaryServer = servers[0];
				const resp = await fetch(primaryServer.url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						tiddlypwa: 1,
						op: 'push_test',
						token: primaryServer.token,
						authcode: await b64enc(await this.titlehash(primaryServer.token)),
						endpoint: this.pushEndpoint || undefined,
						payload: payload || undefined,
					}),
				});
				if (!resp.ok) {
					throw new Error(`Server returned status ${resp.status}`);
				}
				const res = await resp.json();
				this.wiki.addTiddler({
					title: '$:/status/TiddlyPWAPushResult',
					text: res.sent > 0
						? `Test notification sent (${res.sent} delivered).`
						: `Push test completed with 0 active deliveries (failed: ${res.failed || 0}).`,
				});
			} catch (e) {
				console.error('Failed to send test push notification:', e);
				this.wiki.addTiddler({
					title: '$:/status/TiddlyPWAPushResult',
					text: 'Error sending test push: ' + (e.message || e),
				});
			}
		}

		parseRuleTriggerAt(rawVal, defaultTimeStr = '09:00', offsetMinutes = 0) {
			if (rawVal === undefined || rawVal === null) return null;
			const str = String(rawVal).trim();
			if (!str) return null;

			let hours = 9;
			let minutes = 0;
			const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(String(defaultTimeStr || '09:00').trim());
			if (timeMatch) {
				const h = Number(timeMatch[1]);
				const m = Number(timeMatch[2]);
				if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
					hours = h;
					minutes = m;
				}
			}

			let baseMs = NaN;
			const isoDateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
			const twDateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(str);
			if (isoDateOnly || twDateOnly) {
				const m = isoDateOnly || twDateOnly;
				const year = Number(m[1]);
				const month = Number(m[2]);
				const day = Number(m[3]);
				const localDate = new Date(year, month - 1, day, hours, minutes, 0, 0);
				baseMs = localDate.getTime();
			} else if (/^\d{14,17}$/.test(str)) {
				const parsed = $tw.utils.parseDate(str);
				if (parsed instanceof Date && !Number.isNaN(parsed.getTime())) {
					// Projectify and TW end-of-day dates use local 23:59:59.999 as a date-only sentinel.
					// If the timestamp has a specific time of day (not 23:59:59.999), fire at that exact time!
					const isEndOfDaySentinel = parsed.getHours() === 23 &&
						parsed.getMinutes() === 59 &&
						parsed.getSeconds() === 59 &&
						parsed.getMilliseconds() === 999;
					if (!isEndOfDaySentinel) {
						return Math.floor(parsed.getTime());
					}
					if (Number(offsetMinutes) === 0 && defaultTimeStr && String(defaultTimeStr).trim() !== '23:59') {
						const localDate = new Date(
							parsed.getFullYear(),
							parsed.getMonth(),
							parsed.getDate(),
							hours,
							minutes,
							0,
							0,
						);
						return Math.floor(localDate.getTime());
					}
					baseMs = parsed.getTime();
				}
			} else if (/^\d{10,13}$/.test(str)) {
				const num = Number(str);
				baseMs = str.length === 10 ? num * 1000 : num;
			} else {
				const parsed = new Date(str);
				baseMs = parsed.getTime();
			}

			if (!Number.isFinite(baseMs) || baseMs <= 0) return null;
			const offsetMs = (Number(offsetMinutes) || 0) * 60 * 1000;
			return Math.floor(baseMs + offsetMs);
		}

		async loadPersistedRuleSchedules() {
			if (this.ruleSchedulesLoaded || typeof indexedDB !== 'object') return;
			this.ruleSchedulesLoaded = true;
			try {
				const db = await this.openPushDb();
				try {
					const stored = await new Promise((resolve, reject) => {
						const txn = db.transaction('state', 'readonly');
						const req = txn.objectStore('state').get('ruleSchedules');
						req.onsuccess = () => resolve(req.result);
						req.onerror = () => reject(req.error);
					});
					if (stored && typeof stored === 'object') {
						for (const [k, v] of Object.entries(stored)) {
							if (typeof k === 'string' && typeof v === 'string') {
								this.syncedRuleSchedules.set(k, v);
							}
						}
					}
				} finally {
					db.close();
				}
			} catch (e) {
				console.warn('Could not load persisted rule schedules:', e);
			}
		}

		async savePersistedRuleSchedules() {
			if (typeof indexedDB !== 'object') return;
			try {
				const obj = Object.fromEntries(this.syncedRuleSchedules.entries());
				const db = await this.openPushDb();
				try {
					await new Promise((resolve, reject) => {
						const txn = db.transaction('state', 'readwrite');
						txn.objectStore('state').put(obj, 'ruleSchedules');
						txn.oncomplete = () => resolve();
						txn.onerror = () => reject(txn.error);
					});
				} finally {
					db.close();
				}
			} catch (e) {
				console.warn('Could not save persisted rule schedules:', e);
			}
		}

		scheduleNotificationRuleSync(delayMs = 250) {
			if (!this.isReady() || !navigator.onLine) return;
			clearTimeout(this.ruleSyncTimer);
			this.ruleSyncTimer = setTimeout(() => {
				this.syncNotificationRules().catch((e) => console.warn('Failed to sync notification rules:', e));
			}, delayMs);
		}

		async syncNotificationRules() {
			if (!this.isReady() || !this.db || !this.pushKey || !this.mackey) return;
			const servers = await adb(this.db.transaction('syncservers').objectStore('syncservers').getAll());
			if (servers.length === 0) return;

			await this.loadPersistedRuleSchedules();

			const ruleTitles = this.wiki.filterTiddlers(
				'[all[tiddlers+shadows]tag[$:/tags/NotificationRule]!has[draft.of]]',
			);
			const nextMap = new Map();
			const upserts = [];
			const nowMs = Date.now();

			for (const ruleTitle of ruleTitles) {
				const ruleTiddler = this.wiki.getTiddler(ruleTitle);
				if (!ruleTiddler) continue;
				if (ruleTiddler.fields.disabled === 'yes' || ruleTiddler.fields.enabled === 'no') continue;

				const filter = ruleTiddler.fields.filter;
				if (typeof filter !== 'string' || !filter.trim()) continue;
				const ruleId = ruleTiddler.fields['rule-id'] || ruleTitle;
				const dateField = ruleTiddler.fields['date-field'] || 'due';
				const defaultTime = ruleTiddler.fields['default-time'] || '09:00';
				const offsetMinutes = Number(ruleTiddler.fields['offset-minutes'] || 0);
				const titleTemplate = ruleTiddler.fields['notify-title'] || ruleTiddler.fields['title-template'] ||
					'{{!!title}}';
				const bodyTemplate = ruleTiddler.fields['notify-body'] || ruleTiddler.fields['body-template'] || '';
				const tagTemplate = ruleTiddler.fields['notify-tag'] || ruleTiddler.fields['tag-template'] || '';
				const navTemplate = ruleTiddler.fields['navigate-to'];
				const openUrlTemplate = ruleTiddler.fields['open-url'];
				const urlField = ruleTiddler.fields['url-field'];
				const clickAction = ruleTiddler.fields['click-action'];
				let ruleActions;
				const rawRuleActions = ruleTiddler.fields['actions-json'] ?? ruleTiddler.fields.actions;
				if (typeof rawRuleActions === 'string' && rawRuleActions.trim()) {
					try {
						const parsed = JSON.parse(rawRuleActions);
						if (Array.isArray(parsed)) ruleActions = parsed;
					} catch (_e) {
						// Ignore invalid JSON actions
					}
				}
				const actionsSig = ruleActions ? JSON.stringify(ruleActions) : '';

				let matchedTitles = [];
				try {
					matchedTitles = this.wiki.filterTiddlers(filter);
				} catch (e) {
					console.warn(`Invalid filter in NotificationRule ${ruleTitle}:`, e);
					continue;
				}

				for (const targetTitle of matchedTitles) {
					const targetTiddler = this.wiki.getTiddler(targetTitle);
					if (!targetTiddler || isDraftTiddler(targetTiddler)) continue;
					const rawDate = targetTiddler.getFieldString(dateField);
					const triggerAt = this.parseRuleTriggerAt(rawDate, defaultTime, offsetMinutes);
					if (!triggerAt || triggerAt <= nowMs - 60000) continue;

					const renderedTitle = this.wiki.renderText(
						'text/plain',
						'text/vnd.tiddlywiki',
						titleTemplate,
						{ variables: { currentTiddler: targetTitle } },
					).trim() || targetTitle;
					const renderedBody = bodyTemplate
						? this.wiki.renderText(
							'text/plain',
							'text/vnd.tiddlywiki',
							bodyTemplate,
							{ variables: { currentTiddler: targetTitle } },
						).trim()
						: '';
					const renderedTag = tagTemplate
						? this.wiki.renderText(
							'text/plain',
							'text/vnd.tiddlywiki',
							tagTemplate,
							{ variables: { currentTiddler: targetTitle } },
						).trim()
						: '';
					const renderedOpenUrl = openUrlTemplate
						? this.wiki.renderText(
							'text/plain',
							'text/vnd.tiddlywiki',
							openUrlTemplate,
							{ variables: { currentTiddler: targetTitle } },
						).trim()
						: (urlField ? (targetTiddler.getFieldString(urlField) || '').trim() : '');
					const renderedNav = navTemplate !== undefined
						? this.wiki.renderText(
							'text/plain',
							'text/vnd.tiddlywiki',
							navTemplate,
							{ variables: { currentTiddler: targetTitle } },
						).trim()
						: (renderedOpenUrl ? '' : targetTitle);

					const scheduleId = await b64urlEnc(
						await this.titlehash(`rule:${ruleId}\0${targetTitle}\0${triggerAt}`),
					);
					const contentSig =
						`${triggerAt}\0${renderedTitle}\0${renderedBody}\0${renderedTag}\0${renderedNav}\0${renderedOpenUrl}\0${
							clickAction || ''
						}\0${actionsSig}`;
					nextMap.set(scheduleId, contentSig);

					if (this.syncedRuleSchedules.get(scheduleId) !== contentSig) {
						const payload = await this.encryptPushNotification({
							title: renderedTitle,
							body: renderedBody,
							tag: renderedTag || `rule-${scheduleId.slice(0, 12)}`,
							actions: ruleActions,
							data: {
								navigateTo: renderedNav || undefined,
								tiddlerTitle: targetTitle,
								openUrl: renderedOpenUrl || undefined,
								clickAction: clickAction || undefined,
								ruleTitle,
								ruleId,
							},
						});
						if (payload) {
							upserts.push({
								scheduleId,
								triggerAt,
								payload,
								targetEndpoint: null,
							});
						}
					}
				}
			}

			const removals = [];
			for (const oldId of this.syncedRuleSchedules.keys()) {
				if (!nextMap.has(oldId)) {
					removals.push(oldId);
				}
			}

			if (upserts.length === 0 && removals.length === 0) return;

			let allSucceeded = true;
			for (const server of servers) {
				try {
					const resp = await fetch(server.url, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							tiddlypwa: 1,
							op: 'sync_schedules',
							token: server.token,
							authcode: await b64enc(await this.titlehash(server.token)),
							upserts: upserts.length > 0 ? upserts : undefined,
							removals: removals.length > 0 ? removals : undefined,
						}),
					});
					if (!resp.ok) {
						allSucceeded = false;
					}
				} catch (e) {
					allSucceeded = false;
					console.warn('Error syncing notification rules with server:', e);
				}
			}

			if (allSucceeded) {
				this.syncedRuleSchedules = nextMap;
				await this.savePersistedRuleSchedules();
			}
		}

		async computeAdhocScheduleId(rawId) {
			const idStr = typeof rawId === 'string' && rawId.trim().length > 0
				? rawId.trim()
				: await b64urlEnc(crypto.getRandomValues(new Uint8Array(12)));
			if (this.mackey) {
				return await b64urlEnc(await this.titlehash('adhoc:' + idStr));
			}
			return idStr;
		}

		async scheduleAdhocNotification(paramObject = {}) {
			if (!this.db || !this.pushKey || !this.mackey) return;
			try {
				const servers = await adb(this.db.transaction('syncservers').objectStore('syncservers').getAll());
				if (servers.length === 0) return;

				let triggerAt = NaN;
				const rawTriggerAt = paramObject.triggerAt ?? paramObject['trigger-at'] ?? paramObject.fireAt ??
					paramObject['fire-at'];
				const rawDelaySeconds = paramObject.delaySeconds ?? paramObject['delay-seconds'];
				const rawDelayMinutes = paramObject.delayMinutes ?? paramObject['delay-minutes'];
				if (rawTriggerAt !== undefined) {
					const raw = rawTriggerAt;
					if (/^\d{10,13}$/.test(String(raw).trim())) {
						const n = Number(String(raw).trim());
						triggerAt = String(raw).trim().length === 10 ? n * 1000 : n;
					} else if (/^\d{14,17}$/.test(String(raw).trim())) {
						const d = $tw.utils.parseDate(String(raw).trim());
						triggerAt = d instanceof Date ? d.getTime() : NaN;
					} else {
						triggerAt = new Date(raw).getTime();
					}
				} else if (rawDelaySeconds !== undefined) {
					triggerAt = Date.now() + Number(rawDelaySeconds) * 1000;
				} else if (rawDelayMinutes !== undefined) {
					triggerAt = Date.now() + Number(rawDelayMinutes) * 60 * 1000;
				}
				if (!Number.isFinite(triggerAt) || triggerAt <= 0) {
					console.warn('tm-pwa-schedule-notification: missing or invalid triggerAt / delaySeconds');
					return;
				}

				const rawId = paramObject.id ?? paramObject.scheduleId ?? paramObject['schedule-id'];
				const scheduleId = await this.computeAdhocScheduleId(rawId);
				const title = paramObject.title || 'TiddlyWiki Reminder';
				const body = paramObject.body || '';
				const tag = paramObject.tag || `adhoc-${scheduleId.slice(0, 12)}`;
				const scope = paramObject.scope === 'all' ? 'all' : 'device';
				const targetEndpoint = scope === 'all' ? null : (this.pushEndpoint || null);
				const navTarget = paramObject.navigateTo ?? paramObject['navigate-to'] ?? paramObject.tiddlerTitle ??
					paramObject['tiddler-title'];
				const openUrl = paramObject.openUrl ?? paramObject['open-url'];
				const clickAction = paramObject.clickAction ?? paramObject['click-action'];
				let actions;
				const rawActions = paramObject.actions ?? paramObject['actions-json'];
				if (Array.isArray(rawActions)) {
					actions = rawActions;
				} else if (typeof rawActions === 'string' && rawActions.trim()) {
					try {
						const parsed = JSON.parse(rawActions);
						if (Array.isArray(parsed)) actions = parsed;
					} catch (_e) {
						// Ignore invalid JSON actions
					}
				}

				let hookData;
				const rawHookData = paramObject.hookData ?? paramObject['hook-data'];
				if (rawHookData && typeof rawHookData === 'object') {
					hookData = rawHookData;
				} else if (typeof rawHookData === 'string' && rawHookData.trim()) {
					try {
						hookData = JSON.parse(rawHookData);
					} catch (_e) {
						hookData = rawHookData;
					}
				}

				const payload = await this.encryptPushNotification({
					title,
					body,
					tag,
					actions,
					data: {
						navigateTo: navTarget || undefined,
						tiddlerTitle: (paramObject.tiddlerTitle ?? paramObject['tiddler-title'] ?? navTarget) || undefined,
						openUrl: openUrl || undefined,
						clickAction: clickAction || undefined,
						hookData: hookData !== undefined ? hookData : undefined,
						scheduleId: rawId || scheduleId,
					},
				});
				if (!payload) return;

				for (const server of servers) {
					await fetch(server.url, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							tiddlypwa: 1,
							op: 'sync_schedules',
							token: server.token,
							authcode: await b64enc(await this.titlehash(server.token)),
							upserts: [{
								scheduleId,
								triggerAt: Math.floor(triggerAt),
								payload,
								targetEndpoint,
							}],
						}),
					});
				}
				this.wiki.addTiddler({
					title: '$:/status/TiddlyPWAPushResult',
					text: this.pushEndpoint
						? `Scheduled "${title}" for ${new Date(triggerAt).toLocaleTimeString()}.`
						: `Scheduled "${title}", but Push Notifications are not enabled on this device yet! Click "Enable Push Notifications on This Device" first.`,
				});
			} catch (e) {
				console.error('Failed to schedule ad-hoc notification:', e);
			}
		}

		async cancelAdhocNotification(paramObject = {}) {
			const rawId = paramObject.id ?? paramObject.scheduleId ?? paramObject['schedule-id'];
			if (!this.db || !this.mackey || !rawId) return;
			try {
				const servers = await adb(this.db.transaction('syncservers').objectStore('syncservers').getAll());
				if (servers.length === 0) return;
				const scheduleId = await this.computeAdhocScheduleId(rawId);
				for (const server of servers) {
					await fetch(server.url, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							tiddlypwa: 1,
							op: 'sync_schedules',
							token: server.token,
							authcode: await b64enc(await this.titlehash(server.token)),
							removals: [scheduleId],
						}),
					});
				}
			} catch (e) {
				console.error('Failed to cancel ad-hoc notification:', e);
			}
		}

		async loadPersistedWatchers() {
			if (this.watchersLoaded || typeof indexedDB !== 'object') return;
			this.watchersLoaded = true;
			try {
				const db = await this.openPushDb();
				try {
					const stored = await new Promise((resolve, reject) => {
						const txn = db.transaction('state', 'readonly');
						const req = txn.objectStore('state').get('syncedWatchers');
						req.onsuccess = () => resolve(req.result);
						req.onerror = () => reject(req.error);
					});
					if (stored && typeof stored === 'object') {
						for (const [k, v] of Object.entries(stored)) {
							if (typeof k === 'string' && typeof v === 'string') {
								this.syncedWatchers.set(k, v);
							}
						}
					}
				} finally {
					db.close();
				}
			} catch (e) {
				console.warn('Could not load persisted watchers:', e);
			}
		}

		async savePersistedWatchers() {
			if (typeof indexedDB !== 'object') return;
			try {
				const obj = Object.fromEntries(this.syncedWatchers.entries());
				const db = await this.openPushDb();
				try {
					await new Promise((resolve, reject) => {
						const txn = db.transaction('state', 'readwrite');
						txn.objectStore('state').put(obj, 'syncedWatchers');
						txn.oncomplete = () => resolve();
						txn.onerror = () => reject(txn.error);
					});
				} finally {
					db.close();
				}
			} catch (e) {
				console.warn('Could not save persisted watchers:', e);
			}
		}

		scheduleWatcherSync() {
			if (!this.isReady() || !navigator.onLine) return;
			clearTimeout(this.watcherSyncTimer);
			this.watcherSyncTimer = setTimeout(() => {
				this.syncWatchers().catch((e) => console.warn('Failed to sync pwa-watchers:', e));
			}, 1500);
		}

		async syncWatchers() {
			if (!this.isReady() || !this.db || !this.mackey || !this.watcherSignKey || !this.watcherPubKeyB64) {
				return;
			}
			const servers = await adb(this.db.transaction('syncservers').objectStore('syncservers').getAll());
			if (servers.length === 0) return;

			await this.loadPersistedWatchers();

			const watcherTitles = this.wiki.filterTiddlers(
				'[all[tiddlers+shadows]module-type[pwa-watcher]!has[draft.of]]',
			);
			const nextMap = new Map();
			const watchersToUpload = [];
			const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

			for (const wTitle of watcherTitles) {
				const wTiddler = this.wiki.getTiddler(wTitle);
				if (!wTiddler) continue;
				if (wTiddler.fields.disabled === 'yes' || wTiddler.fields.enabled === 'no') continue;

				const codeSource = wTiddler.fields.text || '';
				if (!codeSource.trim()) continue;

				const watcherId = String(wTiddler.fields['watcher-id'] || wTitle).trim();
				const allowedHosts = String(wTiddler.fields['allowed-hosts'] || '').trim();
				const scheduleCron = String(wTiddler.fields['schedule-cron'] || '0 * * * *').trim();
				const timezone = String(wTiddler.fields.timezone || browserTimezone).trim() || 'UTC';
				const targetFilter = String(wTiddler.fields['target-filter'] || wTiddler.fields['config-filter'] || '').trim();
				const rawWatchedFields = $tw.utils.parseStringArray(wTiddler.fields['watched-fields'] || 'title') || ['title'];
				const sortedFieldNames = [...new Set(rawWatchedFields.length > 0 ? rawWatchedFields : ['title'])].sort();

				const watchedItems = [];
				if (targetFilter) {
					let matchedTitles = [];
					try {
						matchedTitles = this.wiki.filterTiddlers(targetFilter);
					} catch (e) {
						console.warn(`Invalid target-filter in pwa-watcher ${wTitle}:`, e);
						continue;
					}
					for (const itemTitle of matchedTitles) {
						const itemTid = this.wiki.getTiddler(itemTitle);
						if (!itemTid || isDraftTiddler(itemTid)) continue;
						const fields = {};
						for (const fName of sortedFieldNames) {
							fields[fName] = String(itemTid.getFieldString(fName) ?? '');
						}
						watchedItems.push({
							title: String(itemTitle),
							fields,
						});
					}
				}

				const codeHash = await b64urlEnc(await crypto.subtle.digest('SHA-256', utfenc.encode(codeSource)));
				const canonicalPayload = JSON.stringify({
					watcherId,
					codeHash,
					allowedHosts,
					scheduleCron,
					timezone,
					watchedItems,
				});
				const sigBuf = await crypto.subtle.sign(
					{ name: 'Ed25519' },
					this.watcherSignKey,
					utfenc.encode(canonicalPayload),
				);
				const signature = await b64urlEnc(sigBuf);

				nextMap.set(watcherId, signature);
				if (this.syncedWatchers.get(watcherId) !== signature) {
					watchersToUpload.push({
						watcherId,
						codeHash,
						codeSource,
						allowedHosts,
						scheduleCron,
						timezone,
						watchedItems,
						signature,
					});
				}
			}

			const removedWatcherIds = [];
			for (const oldId of this.syncedWatchers.keys()) {
				if (!nextMap.has(oldId)) {
					removedWatcherIds.push(oldId);
				}
			}

			if (watchersToUpload.length === 0 && removedWatcherIds.length === 0) return;

			let allSucceeded = true;
			for (const server of servers) {
				try {
					const resp = await fetch(server.url, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							tiddlypwa: 1,
							op: 'sync_watchers',
							token: server.token,
							authcode: await b64enc(await this.titlehash(server.token)),
							watcherPubKey: this.watcherPubKeyB64,
							watchers: watchersToUpload.length > 0 ? watchersToUpload : undefined,
							removedWatcherIds: removedWatcherIds.length > 0 ? removedWatcherIds : undefined,
						}),
					});
					if (!resp.ok) {
						allSucceeded = false;
					}
				} catch (e) {
					allSucceeded = false;
					console.warn('Error syncing pwa-watchers with server:', e);
				}
			}

			if (allSucceeded) {
				this.syncedWatchers = nextMap;
				await this.savePersistedWatchers();
			}
			await this.refreshServerWatchers();
		}

		async refreshServerWatchers() {
			if (!this.db || !this.mackey) return;
			try {
				for (const tidname of this.wiki.getTiddlersWithTag('$:/temp/TiddlyPWAWatcher')) {
					this.wiki.deleteTiddler(tidname);
				}
				const servers = await adb(this.db.transaction('syncservers').objectStore('syncservers').getAll());
				if (servers.length === 0) {
					this.wiki.addTiddler({ title: '$:/status/TiddlyPWAWatcherCount', text: '0' });
					return;
				}
				const primaryServer = servers[0];
				const resp = await fetch(primaryServer.url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						tiddlypwa: 1,
						op: 'list_watchers',
						token: primaryServer.token,
						authcode: await b64enc(await this.titlehash(primaryServer.token)),
					}),
				});
				if (!resp.ok) return;
				const { watchers } = await resp.json();
				const list = Array.isArray(watchers) ? watchers : [];
				for (const w of list) {
					this.wiki.addTiddler({
						title: '$:/temp/TiddlyPWAWatchers/' + w.watcherId,
						tags: ['$:/temp/TiddlyPWAWatcher'],
						'watcher-id': w.watcherId,
						'schedule-cron': w.scheduleCron || '',
						timezone: w.timezone || 'UTC',
						'allowed-hosts': w.allowedHosts || '',
						'last-run': w.lastRunAt && w.lastRunAt > 0 ? new Date(w.lastRunAt).toLocaleString() : 'never',
						'last-error': w.lastError || '',
					});
				}
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWAWatcherCount', text: String(list.length) });
			} catch (e) {
				console.warn('Could not refresh server watcher list:', e);
			}
		}

		async runWatcherNow(watcherId) {
			if (!this.db || !this.mackey || !watcherId) return;
			this.wiki.addTiddler({
				title: '$:/status/TiddlyPWAPushResult',
				text: `Running watcher "${watcherId}" on server…`,
			});
			try {
				await this.syncWatchers();
				const servers = await adb(this.db.transaction('syncservers').objectStore('syncservers').getAll());
				if (servers.length === 0) return;
				const primaryServer = servers[0];
				const resp = await fetch(primaryServer.url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						tiddlypwa: 1,
						op: 'run_watcher',
						token: primaryServer.token,
						authcode: await b64enc(await this.titlehash(primaryServer.token)),
						watcherId: String(watcherId),
					}),
				});
				const res = await resp.json();
				if (!resp.ok || !res.ok) {
					throw new Error(res.error || `Server returned status ${resp.status}`);
				}
				await this.refreshServerWatchers();
				if (res.patchesStaged > 0) {
					this.backgroundSync();
				}
				this.wiki.addTiddler({
					title: '$:/status/TiddlyPWAPushResult',
					text: `Watcher "${watcherId}" finished: ${res.notificationsSent || 0} notification(s) sent, ${
						res.patchesStaged || 0
					} patch(es) staged.`,
				});
			} catch (e) {
				console.error('Failed to run watcher on server:', e);
				await this.refreshServerWatchers();
				this.wiki.addTiddler({
					title: '$:/status/TiddlyPWAPushResult',
					text: `Watcher "${watcherId}" error: ` + (e.message || e),
				});
			}
		}

		applySingleWatcherPatchSpec(spec) {
			const savedTiddlers = [];
			if (!spec || typeof spec !== 'object') return savedTiddlers;
			if (spec.patchTarget && typeof spec.patchTarget === 'object') {
				const targetTitle = spec.patchTarget.title;
				if (typeof targetTitle === 'string' && targetTitle.length > 0) {
					const existing = this.wiki.getTiddler(targetTitle);
					const baseFields = existing ? existing.fields : { title: targetTitle, created: new Date() };
					const nextFields = {
						...baseFields,
						...(typeof spec.patchTarget.fields === 'object' ? spec.patchTarget.fields : {}),
						title: targetTitle,
						modified: new Date(),
					};
					const tid = new $tw.Tiddler(nextFields);
					this.wiki.addTiddler(tid);
					savedTiddlers.push(tid);
				}
			}
			if (spec.createTiddler && typeof spec.createTiddler === 'object') {
				const newTitle = spec.createTiddler.title;
				if (typeof newTitle === 'string' && newTitle.length > 0) {
					const existing = this.wiki.getTiddler(newTitle);
					const extraFields = typeof spec.createTiddler.fields === 'object' && spec.createTiddler.fields
						? spec.createTiddler.fields
						: spec.createTiddler;
					const nextFields = {
						...(existing ? existing.fields : { created: new Date() }),
						...extraFields,
						title: newTitle,
						modified: new Date(),
					};
					delete nextFields.fields;
					const tid = new $tw.Tiddler(nextFields);
					this.wiki.addTiddler(tid);
					savedTiddlers.push(tid);
				}
			}
			return savedTiddlers;
		}

		recordAppliedPatchId(patchId) {
			if (this.appliedPatchIds.has(patchId)) return;
			this.appliedPatchIds.add(patchId);
			if (this.appliedPatchIds.size > 1000) {
				const oldest = this.appliedPatchIds.values().next().value;
				if (oldest !== undefined) this.appliedPatchIds.delete(oldest);
			}
		}

		async applyPendingWatcherPatches(pendingPatches) {
			if (!Array.isArray(pendingPatches) || pendingPatches.length === 0) return;
			for (const entry of pendingPatches) {
				if (!entry || typeof entry.patchId !== 'string') continue;
				if (this.appliedPatchIds.has(entry.patchId)) {
					this.ackedPatchIds.add(entry.patchId);
					continue;
				}
				try {
					if (entry.patch && typeof entry.patch === 'object') {
						const savedTiddlers = this.applySingleWatcherPatchSpec(entry.patch);
						for (const tid of savedTiddlers) {
							await this._saveTiddler(tid);
						}
					}
					this.recordAppliedPatchId(entry.patchId);
					this.ackedPatchIds.add(entry.patchId);
					if (entry.patch && typeof entry.patch === 'object') {
						try {
							$tw.hooks.invokeHook('th-pwa-watcher-action', entry);
						} catch (e) {
							console.error('Error in th-pwa-watcher-action hook:', e);
						}
					}
				} catch (e) {
					console.error('Failed to persist pending watcher patch:', entry.patchId, e);
				}
			}
		}

		handleServiceWorkerPushClick(clickEvent) {
			if (!clickEvent) return;
			if (this.isReady()) {
				this.drainPendingPushClicks();
				this.sync(false);
			}
		}

		async drainPendingPushClicks(runAfterSync = false) {
			if (!this.isReady() || typeof indexedDB !== 'object') return;
			let clicks = [];
			try {
				const db = await this.openPushDb();
				try {
					clicks = await new Promise((resolve, reject) => {
						const txn = db.transaction('state', 'readwrite');
						const store = txn.objectStore('state');
						const getReq = store.get('pendingClicks');
						let result = [];
						getReq.onsuccess = () => {
							result = Array.isArray(getReq.result) ? getReq.result : [];
							if (result.length > 0) {
								store.delete('pendingClicks');
							}
						};
						txn.oncomplete = () => resolve(result);
						txn.onerror = () => reject(txn.error);
					});
				} finally {
					db.close();
				}
			} catch (e) {
				console.warn('Failed to drain pending push clicks:', e);
				return;
			}

			if (Array.isArray(this.deferredPushClicks) && this.deferredPushClicks.length > 0 && runAfterSync) {
				clicks = [...this.deferredPushClicks, ...clicks];
				this.deferredPushClicks = [];
			}

			for (const click of clicks) {
				const action = click.action || 'default';
				const data = click.data || {};
				const actionSpec = data.actionPatches && typeof data.actionPatches === 'object'
					? data.actionPatches[action]
					: null;
				const navTitle = actionSpec?.navigateTo || data.navigateTo || data.tiddlerTitle;

				// If the target tiddler was created on another device and hasn't synced to this device yet,
				// defer the click action until the ongoing sync completes so navigation and "Mark Done" succeed.
				if (
					!runAfterSync &&
					navigator.onLine &&
					typeof navTitle === 'string' &&
					navTitle.length > 0 &&
					!this.wiki.tiddlerExists(navTitle) &&
					!this.wiki.isShadowTiddler(navTitle)
				) {
					if (!this.deferredPushClicks) this.deferredPushClicks = [];
					this.deferredPushClicks.push(click);
					continue;
				}

				if (actionSpec) {
					this.applySingleWatcherPatchSpec(actionSpec);
				}
				if (typeof navTitle === 'string' && navTitle.length > 0) {
					try {
						const story = new $tw.Story({ wiki: this.wiki });
						story.navigateTiddler(navTitle);
					} catch (e) {
						console.warn('Could not navigate to notification target tiddler:', e);
					}
				}
				try {
					$tw.hooks.invokeHook('th-pwa-notification-action', {
						...click,
						navigateTo: navTitle || null,
						openUrl: actionSpec?.openUrl || data.openUrl || null,
						clickAction: actionSpec?.clickAction || data.clickAction || null,
						hookData: actionSpec?.hookData ?? data.hookData ?? null,
					});
				} catch (e) {
					console.error('Error in th-pwa-notification-action hook:', e);
				}
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
			const bareUrl = new URL(server.url, document.location).href;
			this.wiki.addTiddler({
				title: '$:/status/TiddlyPWARealtime',
				text: `connecting to ${bareUrl}`,
			});
			url.searchParams.set('op', 'monitor');
			const authcode = this.mackey ? await b64enc(await this.titlehash(server.token)).catch(() => null) : null;
			const hasSyncedBefore = server.lastSync && new Date(server.lastSync).getTime() > 0;
			if (hasSyncedBefore && authcode) {
				url.searchParams.set('halftoken', server.token.slice(0, Math.floor(server.token.length / 2)));
				url.searchParams.set('authcode', authcode);
				this.monitorUsingHalftoken = true;
			} else {
				url.searchParams.set('token', server.token);
				this.monitorUsingHalftoken = false;
			}
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
				text: `disconnected from ${bareUrl}`,
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

		getServerSyncKey(server) {
			return `${server?.url || ''}|${server?.token || ''}`;
		}

		getBaseMtimeForServer(tid, serverKey) {
			const state = tid?.serverSyncState;
			if (state && typeof state === 'object') {
				if (Object.hasOwn(state, serverKey)) {
					return state[serverKey]?.baseMtime ?? null;
				}
				if (Object.keys(state).length > 0) {
					return null;
				}
			}
			return tid?.baseMtime ?? null;
		}

		isTiddlerDirtyForServer(tid, serverKey) {
			const mtimeMs = tid?.mtime instanceof Date ? tid.mtime.getTime() : 0;
			const state = tid?.serverSyncState;
			if (state && typeof state === 'object') {
				if (Object.hasOwn(state, serverKey)) {
					const entry = state[serverKey];
					return entry?.syncedLocalMtime == null || mtimeMs !== entry.syncedLocalMtime;
				}
				if (Object.keys(state).length > 0) {
					return true;
				}
			}
			return tid?.baseMtime === null ||
				(tid?.baseMtime instanceof Date && mtimeMs !== tid.baseMtime.getTime());
		}

		maxServerBaseMtimeMs(tid) {
			let maxMs = 0;
			if (tid?.baseMtime instanceof Date) {
				maxMs = tid.baseMtime.getTime();
			}
			const state = tid?.serverSyncState;
			if (state && typeof state === 'object') {
				for (const entry of Object.values(state)) {
					const bm = entry?.baseMtime;
					const ms = bm instanceof Date ? bm.getTime() : (bm ? new Date(bm).getTime() : 0);
					if (Number.isFinite(ms) && ms > maxMs) maxMs = ms;
				}
			}
			return maxMs;
		}

		updateSyncUiStatus({ syncing, error, serverCount, unsyncedCount } = {}) {
			if (serverCount !== undefined) this.lastServerCount = Number(serverCount) || 0;
			if (unsyncedCount !== undefined) this.lastUnsyncedCount = Number(unsyncedCount) || 0;
			if (error !== undefined) this.lastSyncError = error ? String(error) : '';

			const isOnline = typeof navigator === 'undefined' || navigator.onLine !== false;
			const isSyncingNow = syncing !== undefined ? Boolean(syncing) : Boolean(this.isSyncing);
			let state = 'synced';
			if (isSyncingNow) {
				state = 'syncing';
			} else if (this.lastServerCount <= 0) {
				state = 'local-only';
			} else if (!isOnline) {
				state = 'offline';
			} else if (this.lastSyncError) {
				state = 'error';
			} else if (this.lastUnsyncedCount > 0) {
				state = 'dirty';
			}

			this.wiki.addTiddler({ title: '$:/status/TiddlyPWASyncState', text: state });
			this.wiki.addTiddler({ title: '$:/status/TiddlyPWALastSyncError', text: this.lastSyncError });
			this.wiki.addTiddler({ title: '$:/status/TiddlyPWAUnsyncedCount', text: String(this.lastUnsyncedCount) });

			if (typeof document !== 'undefined' && document.body) {
				for (const cls of ['local-only', 'offline', 'syncing', 'dirty', 'error', 'synced']) {
					$tw.utils.removeClass(document.body, `tiddlypwa-sync-state-${cls}`);
				}
				$tw.utils.addClass(document.body, `tiddlypwa-sync-state-${state}`);
			}
			return state;
		}

		async refreshUnsyncedCount(overrides = {}) {
			if (!this.db) {
				return this.updateSyncUiStatus({ ...overrides, serverCount: 0, unsyncedCount: 0 });
			}
			const [servers, tiddlers] = await Promise.all([
				adb(this.db.transaction('syncservers').objectStore('syncservers').getAll()).catch(() => []),
				adb(this.db.transaction('tiddlers').objectStore('tiddlers').getAll()).catch(() => []),
			]);
			const serverKeys = servers.map((s) => this.getServerSyncKey(s));
			let unsyncedCount = 0;
			if (serverKeys.length > 0) {
				for (const tid of tiddlers) {
					if (this.storyListHash && arrayEq(tid.thash, this.storyListHash)) continue;
					if (serverKeys.some((sk) => this.isTiddlerDirtyForServer(tid, sk))) {
						unsyncedCount++;
					}
				}
			}
			return this.updateSyncUiStatus({
				...overrides,
				serverCount: serverKeys.length,
				unsyncedCount,
			});
		}

		async reflectSyncServers() {
			this.startRealtimeMonitor();
			for (const tidname of this.wiki.getTiddlersWithTag('$:/temp/TiddlyPWAServer')) {
				this.wiki.deleteTiddler(tidname);
			}
			let cnt = 0;
			await new Promise((resolve) =>
				this.db.transaction('syncservers', 'readwrite').objectStore('syncservers').openCursor().onsuccess = (evt) => {
					const cursor = evt.target.result;
					if (!cursor) {
						return resolve();
					}
					let { url, token, lastSync } = cursor.value;
					if (typeof url === 'string' && typeof token === 'string' && token.length >= 2) {
						const halftoken = token.slice(0, Math.floor(token.length / 2));
						try {
							const parsedUrl = new URL(url, document.location);
							const dupSuffix = `/${halftoken}/tid.dly`;
							if (halftoken && parsedUrl.pathname.endsWith(dupSuffix)) {
								parsedUrl.pathname = parsedUrl.pathname.slice(0, -dupSuffix.length) + '/tid.dly';
								url = parsedUrl.href;
								cursor.update({ ...cursor.value, url });
							}
						} catch (_e) {
							// Leave invalid URLs as-is
						}
					}
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
			await this.refreshUnsyncedCount({ serverCount: cnt });
			await this.updatePairUrl();
		}

		reflectStorageInfo(immediate = false) {
			clearTimeout(this.storageInfoTimer);
			if (immediate) {
				this.storageInfoTimer = null;
				return this._reflectStorageInfoNow();
			}
			this.storageInfoTimer = setTimeout(() => {
				this.storageInfoTimer = null;
				this._reflectStorageInfoNow().catch(() => {});
			}, 2000);
			return Promise.resolve();
		}

		async _reflectStorageInfoNow() {
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

		reflectSplashCache() {
			try {
				const rawTitle = this.wiki.getTiddlerText('$:/SiteTitle', '').trim();
				const rawSub = this.wiki.getTiddlerText('$:/SiteSubtitle', '').trim();
				const title = rawTitle ? this.wiki.renderText('text/plain', 'text/vnd.tiddlywiki', rawTitle).trim() : '';
				const subtitle = rawSub ? this.wiki.renderText('text/plain', 'text/vnd.tiddlywiki', rawSub).trim() : '';
				const paletteName = this.wiki.getTiddlerText('$:/palette', '').trim();
				const paletteTid = paletteName ? this.wiki.getTiddler(paletteName) : null;
				const paletteData = paletteName ? this.wiki.getTiddlerData(paletteName, {}) : {};
				const cleanColor = (val) => {
					if (!val || typeof val !== 'string') return '';
					const v = val.trim();
					if (v.includes('<<') || v.includes('{{')) return '';
					return v;
				};
				const cache = {
					title: (title && title !== 'My TiddlyWiki') ? title : 'TiddlyPWA',
					subtitle: (subtitle && subtitle !== 'a reusable non-linear personal web notebook')
						? subtitle
						: 'Encrypted offline-first personal wiki',
					bg: cleanColor(paletteData['page-background']),
					surface: cleanColor(paletteData['tiddler-background']),
					fg: cleanColor(paletteData['foreground']),
					muted: cleanColor(paletteData['muted-foreground']),
					accent: cleanColor(paletteData['primary']),
					colorScheme: cleanColor(paletteTid?.fields?.['color-scheme']),
				};
				localStorage.setItem(`tiddlypwa-splash:${location.pathname}`, JSON.stringify(cache));
			} catch (_e) {
				// Ignore localStorage quota or private browsing errors
			}
		}

		isReady() {
			return this.ready;
		}

		isBinaryContentType(type) {
			return Boolean(type && $tw.config?.contentTypeInfo?.[type]?.encoding === 'base64');
		}

		revokeBlobUrlIfUnreferenced(blobUrl) {
			if (!blobUrl || !blobUrl.startsWith('blob:')) return;
			for (const activeUrl of this.titleBlobUrls.values()) {
				if (activeUrl === blobUrl) return;
			}
			this.blobRegistry.delete(blobUrl);
			try {
				URL.revokeObjectURL(blobUrl);
			} catch (_e) {
				// Ignore revoke failures in restricted environments
			}
		}

		bindBlobTitle(title, blobUrl) {
			if (!title || !blobUrl || !blobUrl.startsWith('blob:')) return;
			const prevUrl = this.titleBlobUrls.get(title);
			this.titleBlobUrls.set(title, blobUrl);
			if (prevUrl && prevUrl !== blobUrl) {
				this.revokeBlobUrlIfUnreferenced(prevUrl);
			}
		}

		releaseBlobForTitle(title) {
			if (!title) return;
			const prevUrl = this.titleBlobUrls.get(title);
			if (prevUrl) {
				this.titleBlobUrls.delete(title);
				this.revokeBlobUrlIfUnreferenced(prevUrl);
			}
		}

		revokeTempBlob(tid) {
			const uri = tid?._canonical_uri || tid?.fields?._canonical_uri;
			if (uri && typeof uri === 'string' && uri.startsWith('blob:')) {
				this.revokeBlobUrlIfUnreferenced(uri);
			}
		}

		async registerBinaryBlob(title, decryptedBuf, mimeType) {
			const rawBytes = await decodeDataToBytes(decryptedBuf);
			const sha256B64 = await b64enc(await crypto.subtle.digest('SHA-256', rawBytes));
			const effectiveMime = mimeType || 'application/octet-stream';
			if (title) {
				const prevUrl = this.titleBlobUrls.get(title);
				const prevEntry = prevUrl ? this.blobRegistry.get(prevUrl) : null;
				if (prevEntry && prevEntry.sha256B64 === sha256B64 && prevEntry.mimeType === effectiveMime) {
					return prevUrl;
				}
			}
			const blobUrl = URL.createObjectURL(new Blob([rawBytes], { type: effectiveMime }));
			this.blobRegistry.set(blobUrl, { rawBytes, mimeType: effectiveMime, sha256B64 });
			if (title) {
				this.bindBlobTitle(title, blobUrl);
			}
			return blobUrl;
		}

		updateConflictCount() {
			this.wiki.addTiddler({
				title: '$:/status/TiddlyPWAConflictsCount',
				text: String(this.wiki.filterTiddlers('[tag[$:/tags/TiddlyPWA/Conflict]]').length),
			});
		}

		openConflictsView() {
			this.wiki.addTiddler({ title: '$:/state/tab-1749438307', text: '$:/plugins/mblackman/tiddlypwa/config' });
			this.wiki.addTiddler({
				title: '$:/state/tab--84302341',
				text: '$:/plugins/mblackman/tiddlypwa/config-conflicts',
			});
			try {
				const story = new $tw.Story({ wiki: this.wiki });
				if (this.wiki.tiddlerExists('$:/ControlPanel') || this.wiki.isShadowTiddler('$:/ControlPanel')) {
					story.navigateTiddler('$:/ControlPanel');
				} else {
					story.navigateTiddler('$:/plugins/mblackman/tiddlypwa/config-conflicts');
				}
			} catch (_e) {
				this.wiki.addTiddler({
					title: '$:/StoryList',
					text: '',
					list: ['$:/ControlPanel'],
				});
			}
		}

		resolveConflict({ conflictTitle, action } = {}) {
			if (!conflictTitle) return;
			const conflictTid = this.wiki.getTiddler(conflictTitle);
			if (!conflictTid) {
				this.updateConflictCount();
				return;
			}
			if (action === 'keep-conflict') {
				const origTitle = conflictTid.fields['tiddlypwa-conflict-of'];
				if (origTitle) {
					const nextFields = Object.create(null);
					for (const [k, v] of Object.entries(conflictTid.fields)) {
						if (
							k === 'title' ||
							k === 'tiddlypwa-conflict-of' ||
							k === 'tiddlypwa-conflict-source' ||
							k === 'tiddlypwa-conflict-date'
						) {
							continue;
						}
						nextFields[k] = v;
					}
					const cleanTags = $tw.utils.parseStringArray(conflictTid.fields.tags || '').filter(
						(t) => t !== '$:/tags/TiddlyPWA/Conflict',
					);
					if (cleanTags.length > 0) {
						nextFields.tags = cleanTags;
					} else {
						delete nextFields.tags;
					}
					nextFields.title = origTitle;
					nextFields.modified = new Date();
					if (typeof nextFields._canonical_uri === 'string' && nextFields._canonical_uri.startsWith('blob:')) {
						this.bindBlobTitle(origTitle, nextFields._canonical_uri);
					} else {
						this.releaseBlobForTitle(origTitle);
					}
					this.wiki.addTiddler(new $tw.Tiddler(nextFields));
					const draftTitle = this.wiki.findDraft?.(origTitle) || `Draft of '${origTitle}'`;
					if (this.wiki.tiddlerExists(draftTitle)) {
						this.wiki.deleteTiddler(draftTitle);
					}
				}
			}
			this.wiki.deleteTiddler(conflictTitle);
			this.releaseBlobForTitle(conflictTitle);
			this.updateConflictCount();
		}

		checkDraftCollision(title, fullTid, mtime) {
			if (!title || !fullTid) return false;
			const draftTitle = this.wiki.findDraft?.(title) || `Draft of '${title}'`;
			if (!this.wiki.tiddlerExists(draftTitle)) return false;
			const baseTid = this.wiki.getTiddler(title);
			const baseIsFull = baseTid && !baseTid.fields._is_skinny;
			const changedVsBase = !baseIsFull || !this.tiddlersAreEqual(baseTid.fields, fullTid);
			const draftTid = this.wiki.getTiddler(draftTitle);
			const draftFields = draftTid?.fields || {};
			const changedVsDraft = !this.tiddlersAreEqual(draftFields, fullTid, { checkDraftTitle: true });
			if (changedVsBase && changedVsDraft) {
				const conflictTid = this.createConflictTiddler(fullTid, title, 'remote', mtime || new Date());
				if (
					typeof conflictTid.fields._canonical_uri === 'string' && conflictTid.fields._canonical_uri.startsWith('blob:')
				) {
					this.bindBlobTitle(conflictTid.fields.title, conflictTid.fields._canonical_uri);
				}
				this.wiki.addTiddler(conflictTid);
				this.updateConflictCount();
				this.wiki.deleteTiddler('$:/temp/HideConflictBanner');
				this.logger.log(
					`Notice: "${title}" was updated on another device while you have a draft open! A remote conflict copy "${conflictTid.fields.title}" has been preserved.`,
				);
				return true;
			}
			return false;
		}

		hydrateWikiBlobsTemporarily(fn) {
			const origGetTiddler = this.wiki.getTiddler;
			const hydrated = new Map();
			for (const title of this.wiki.allTitles()) {
				const tid = origGetTiddler.call(this.wiki, title);
				const uri = tid?.fields?._canonical_uri;
				if (typeof uri === 'string' && uri.startsWith('blob:') && this.blobRegistry.has(uri)) {
					const entry = this.blobRegistry.get(uri);
					const nextFields = { ...tid.fields, text: b64encSync(entry.rawBytes) };
					delete nextFields._canonical_uri;
					hydrated.set(title, new $tw.Tiddler(nextFields));
				}
			}
			this.wiki.getTiddler = function (title) {
				return hydrated.get(title) || origGetTiddler.call(this, title);
			};
			try {
				return fn();
			} finally {
				this.wiki.getTiddler = origGetTiddler;
			}
		}

		exportSingleFile(variables = {}) {
			if (!$tw.saverHandler?.saveWiki) return;
			this.hydrateWikiBlobsTemporarily(() => {
				$tw.saverHandler.saveWiki({
					wiki: this.wiki,
					method: 'download',
					downloadType: 'text/plain',
					variables,
				});
			});
		}

		ensureSaverHydrationWrapper() {
			if (this.wrappedSaverHandler || !$tw.saverHandler?.saveWiki) return;
			this.wrappedSaverHandler = true;
			const origSaveWiki = $tw.saverHandler.saveWiki.bind($tw.saverHandler);
			const self = this;
			$tw.saverHandler.saveWiki = function (options = {}) {
				if (options.method === 'download') {
					return self.hydrateWikiBlobsTemporarily(() => origSaveWiki(options));
				}
				return origSaveWiki(options);
			};
		}

		async parseEncryptedTiddler({ thash, iv, ct }) {
			return JSON.parse(
				await decodeData(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, this.enckey(thash), ct)),
			);
		}

		async decryptRawTiddler(record, { registerForTitle = false } = {}) {
			if (!record || record.deleted || !record.ct || !record.iv) return null;
			try {
				const tid = await this.parseEncryptedTiddler(record);
				if (record.sbiv && record.sbct) {
					const decryptedBuf = await crypto.subtle.decrypt(
						{ name: 'AES-GCM', iv: record.sbiv },
						this.enckey(record.thash),
						record.sbct,
					);
					if (this.isBinaryContentType(tid.type)) {
						tid._canonical_uri = await this.registerBinaryBlob(
							registerForTitle ? tid.title : null,
							decryptedBuf,
							tid.type,
						);
					} else {
						tid.text = await decodeData(decryptedBuf);
					}
				}
				return tid;
			} catch (e) {
				this.logger.alert('Failed to decrypt conflicting tiddler payload', e);
				return null;
			}
		}

		tiddlersAreEqual(a, b, { checkDraftTitle = false } = {}) {
			if (!a || !b) return false;
			if (checkDraftTitle && a['draft.title'] && b.title && a['draft.title'] !== b.title) {
				return false;
			}
			const uriA = a._canonical_uri;
			const uriB = b._canonical_uri;
			const bothBlobs = typeof uriA === 'string' && uriA.startsWith('blob:') &&
				typeof uriB === 'string' && uriB.startsWith('blob:');
			if (bothBlobs) {
				const entryA = this.blobRegistry.get(uriA);
				const entryB = this.blobRegistry.get(uriB);
				if (entryA && entryB) {
					if (entryA.sha256B64 !== entryB.sha256B64) return false;
				} else if (uriA !== uriB) {
					return false;
				}
			}
			if ((a.text || '') !== (b.text || '')) return false;
			const ignored = new Set([
				'modified',
				'created',
				'revision',
				'revision-tag',
				'text',
				'title',
				'draft.of',
				'draft.title',
			]);
			if (bothBlobs) ignored.add('_canonical_uri');
			const normVal = (k, v) => {
				if (k === 'tags') return Array.isArray(v) ? $tw.utils.stringifyList(v) : String(v ?? '');
				if (v instanceof Date) return v.toISOString();
				return String(v ?? '');
			};
			const keysA = Object.keys(a).filter((k) => !ignored.has(k) && a[k] !== undefined && a[k] !== '');
			const keysB = Object.keys(b).filter((k) => !ignored.has(k) && b[k] !== undefined && b[k] !== '');
			if (keysA.length !== keysB.length) return false;
			return keysA.every((k) => normVal(k, a[k]) === normVal(k, b[k]));
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
			const decryptOne = async ({ thash, iv, ct, sbiv, sbct }) => {
				// not isReady yet, can safely addTiddler
				const tid = await this.parseEncryptedTiddler({ thash, ct, iv });
				if (isDraftTiddler(tid)) {
					this.db.transaction('tiddlers', 'readwrite').objectStore('tiddlers').delete(thash);
					return null;
				}
				if (sbiv && sbct) {
					if (mustEagerLoad(tid)) {
						const decryptedBuf = await crypto.subtle.decrypt(
							{ name: 'AES-GCM', iv: sbiv },
							this.enckey(thash),
							sbct,
						);
						if (this.isBinaryContentType(tid.type)) {
							const blobUrl = await this.registerBinaryBlob(tid.title, decryptedBuf, tid.type);
							tid._canonical_uri = blobUrl;
							const entry = this.blobRegistry.get(blobUrl);
							if (entry) this.savedBlobSha.set(await b64enc(thash), entry.sha256B64);
						} else {
							tid.text = await decodeData(decryptedBuf);
						}
					} else tid._is_skinny = true; // Lazy-load separate body
				}
				if (tid?.title) {
					this.registerTitleHash(tid.title, thash, await b64enc(thash));
				}
				return tid;
			};
			const records = toDecrypt.filter((r) => !r.deleted);
			if (records.length > 0) {
				this.modal?.setProgress?.(
					0,
					`Decrypting ${records.length.toLocaleString()} ${records.length === 1 ? 'tiddler' : 'tiddlers'}…`,
				);
			} else {
				this.modal?.setProgress?.(100, 'Preparing workspace…');
			}
			const toAdd = [];
			// Decrypt the first record alone so a wrong key fails fast, then decrypt the rest concurrently
			// in batches: WebCrypto and DecompressionStream work happens off the main thread, so keeping
			// several operations in flight avoids paying a full round trip per tiddler.
			const BATCH = 32;
			for (let i = 0; i < records.length;) {
				const batch = records.slice(i, i === 0 ? 1 : i + BATCH);
				try {
					for (const tid of await Promise.all(batch.map(decryptOne))) if (tid) toAdd.push(tid);
				} catch (e) {
					this.logger.log('Title decryption failed in batch starting with:', await b64enc(batch[0].thash));
					console.error(e);
					return false;
				}
				i += batch.length;
				const pct = Math.round(100 * i / records.length);
				this.modal?.setProgress?.(pct, 'Decrypting tiddlers…');
			}
			console.timeEnd('initial decrypt');
			console.time('initial add');
			this.modal?.setProgress?.(100, 'Loading tiddlers…');
			// Waiting for one change event prevents unlocking before the adding is actually done
			const themHandlers = toAdd.length > 0 ? this.firstChange() : Promise.resolve();
			// Adds are batched all together SYNCHRONOUSLY to prevent event handlers from running on every add!
			// storeTiddler is basically addTiddler but store info to prevent syncer from creating save tasks later
			for (const tid of toAdd) $tw.syncer.storeTiddler(tid);
			const deletedRecords = toDecrypt.filter((r) => r.deleted);
			if (deletedRecords.length > 0 && this.tiddlersInFile.size > 0) {
				const deletedHashes = new Set(await Promise.all(deletedRecords.map((r) => b64enc(r.thash))));
				for (const fileTitle of this.tiddlersInFile) {
					const fileTid = this.wiki.getTiddler(fileTitle);
					const isBundledRuntime = fileTitle === '$:/core' ||
						!!fileTid?.fields?.['plugin-type'] ||
						!!fileTid?.fields?.['module-type'] ||
						(fileTitle.startsWith('$:/') && fileTid?.fields?.type === 'application/javascript');
					if (isBundledRuntime) continue;
					if (deletedHashes.has(await b64enc(await this.titlehash(fileTitle)))) {
						if ($tw.syncer?.tiddlerInfo) {
							delete $tw.syncer.tiddlerInfo[fileTitle];
						}
						this.wiki.deleteTiddler(fileTitle);
					}
				}
			}
			this.wiki.addTiddler({
				title: '$:/status/TiddlyPWAConflictsCount',
				text: String(this.wiki.filterTiddlers('[tag[$:/tags/TiddlyPWA/Conflict]]').length),
			});
			// If the page was already rendered from the app file (boot gate released early), the old
			// $:/DefaultTiddlers has been used, so reopen the startup story within this same change batch.
			// Otherwise the core "story" startup task will open the right tiddlers when the gate is released.
			if (this.bootReleased) this.openStartupStory();
			await themHandlers; // ha
			console.timeEnd('initial add');
			this.ready = true;
			// Let the core "story" and "render" startup tasks run now, rendering the page once with real content.
			this.releaseBoot();
			setTimeout(() => {
				try {
					$tw.__update_tiddlypwa_manifest__();
				} catch (e) {
					console.error(e);
				}
			}, 300);
			// Not needed to show the wiki, so keep them off the unlock path
			this.persistPushKeyForServiceWorker()
				.then(() => this.drainPendingPushClicks())
				.catch((e) => console.error(e));
			this.scheduleNotificationRuleSync();
			this.scheduleWatcherSync();
			this.backgroundSync();
			return true;
		}

		openStartupStory() {
			const defaultTiddlersFilter = this.wiki.getTiddlerText('$:/DefaultTiddlers', '');
			const list = defaultTiddlersFilter ? this.wiki.filterTiddlers(defaultTiddlersFilter) : [];
			if (list.length > 0) {
				this.wiki.addTiddler({
					title: '$:/StoryList',
					text: '',
					list,
				});
			}
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
			Promise.all([
				adb(indexedDB.deleteDatabase(`tiddlypwa:${location.pathname}`)),
				adb(indexedDB.deleteDatabase(this.getPushDbName())).catch(() => {}),
				typeof caches !== 'undefined' ? caches.delete(this.getScopedCacheName()).catch(() => {}) : Promise.resolve(),
			]).then((_) => location.reload())
				.catch((e) => this.logger.alert('Failed to delete database!', e));
		}

		async deriveKeysFromBasebits(basebits) {
			const basekey = await crypto.subtle.importKey('raw', basebits, 'HKDF', false, ['deriveKey', 'deriveBits']);
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
			this.pushKey = await crypto.subtle.deriveKey(
				{ name: 'HKDF', hash: 'SHA-256', salt: utfenc.encode('tiddly.pwa.push'), info: new Uint8Array() },
				basekey,
				{ name: 'AES-GCM', length: 256 },
				false,
				['encrypt', 'decrypt'],
			);
			try {
				const edSeed = new Uint8Array(
					await crypto.subtle.deriveBits(
						{
							name: 'HKDF',
							hash: 'SHA-256',
							salt: utfenc.encode('tiddly.pwa.watchers.ed25519'),
							info: new Uint8Array(),
						},
						basekey,
						256,
					),
				);
				const pkcs8Prefix = new Uint8Array([
					0x30,
					0x2e,
					0x02,
					0x01,
					0x00,
					0x30,
					0x05,
					0x06,
					0x03,
					0x2b,
					0x65,
					0x70,
					0x04,
					0x22,
					0x04,
					0x20,
				]);
				const pkcs8 = new Uint8Array(48);
				pkcs8.set(pkcs8Prefix, 0);
				pkcs8.set(edSeed, 16);
				const tempKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
				const jwk = await crypto.subtle.exportKey('jwk', tempKey);
				this.watcherPubKeyB64 = jwk.x;
				this.watcherSignKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
			} catch (e) {
				console.warn('Ed25519 WebCrypto key derivation unavailable in this browser:', e);
				this.watcherPubKeyB64 = null;
				this.watcherSignKey = null;
			}
		}

		async unlockWithBiometrics(sessionRecord) {
			const assertion = await navigator.credentials.get({
				publicKey: {
					challenge: crypto.getRandomValues(new Uint8Array(32)),
					rpId: window.location.hostname,
					allowCredentials: [{
						id: sessionRecord.credId,
						type: 'public-key',
					}],
					userVerification: 'required',
					extensions: {
						prf: {
							eval: {
								first: sessionRecord.prfSalt,
							},
						},
					},
				},
			});
			const extResults = assertion?.getClientExtensionResults ? assertion.getClientExtensionResults() : null;
			const prfOutput = extResults?.prf?.results?.first;
			if (!prfOutput) {
				throw new Error('Authenticator did not return PRF key material');
			}
			const prfBaseKey = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
			const wrappingKey = await crypto.subtle.deriveKey(
				{
					name: 'HKDF',
					hash: 'SHA-256',
					salt: sessionRecord.prfSalt,
					info: utfenc.encode('tiddlypwa.biometric.kek'),
				},
				prfBaseKey,
				{ name: 'AES-GCM', length: 256 },
				false,
				['decrypt'],
			);
			const decryptedBuffer = await crypto.subtle.decrypt(
				{ name: 'AES-GCM', iv: sessionRecord.iv },
				wrappingKey,
				sessionRecord.ciphertext,
			);
			const basebits = new Uint8Array(decryptedBuffer);
			this.basebits = basebits;
			await this.deriveKeysFromBasebits(basebits);
			const verified = await this.initialRead();
			if (!verified) {
				throw new Error('Biometric key verification failed');
			}
			return true;
		}

		async updatePairUrl() {
			if (!this.db) return;
			let servers = [];
			try {
				servers = await adb(this.db.transaction('syncservers').objectStore('syncservers').getAll());
			} catch (e) {
				console.warn('Could not read syncservers for pairing url', e);
			}
			if (servers.length === 0) {
				this.wiki.addTiddler({ title: '$:/temp/TiddlyPWAPairUrl', text: '' });
				return;
			}
			const primaryServer = servers[0];
			const appUrl = new URL(location.pathname, location.origin).href;
			const includeKey = this.wiki.getTiddlerText('$:/temp/TiddlyPWAPairIncludeKey') === 'yes';
			const params = new URLSearchParams();
			params.set('token', primaryServer.token);
			if (this.salt) {
				params.set('salt', await b64enc(this.salt));
			}
			if (includeKey && this.basebits) {
				params.set('key', await b64enc(this.basebits));
			}
			const pairUrl = appUrl + '#' + params.toString();
			this.wiki.addTiddler({ title: '$:/temp/TiddlyPWAPairUrl', text: pairUrl });
		}

		async verifyAuthWithServer(url, token) {
			if (!url || !token || !this.mackey) return { ok: true };
			try {
				const authcode = await b64enc(await this.titlehash(token));
				const resp = await fetch(url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						tiddlypwa: 1,
						op: 'verify_auth',
						token,
						authcode,
					}),
				});
				if (resp.status === 401) {
					return { ok: false, reason: 'EAUTH' };
				}
				if (!resp.ok) {
					return { ok: false, reason: `HTTP ${resp.status}` };
				}
				return { ok: true };
			} catch (e) {
				return { ok: false, reason: 'NETWORK', error: e };
			}
		}

		async _getStatus() {
			if (!this.browserToken) {
				this.browserToken = await b64enc(crypto.getRandomValues(new Uint8Array(12)));
			}
			let pairToken = null;
			let pairSalt = null;
			let pairKey = null;
			let searchToken = null;
			let isPaired = false;
			if (location.search && location.search.length > 1) {
				try {
					const searchParams = new URLSearchParams(location.search);
					if (searchParams.has('token')) {
						searchToken = searchParams.get('token');
						searchParams.delete('token');
						const remaining = searchParams.toString();
						history.replaceState(
							null,
							'',
							location.pathname + (remaining ? '?' + remaining : '') + location.hash,
						);
					}
				} catch (e) {
					console.error('Failed to scrub URL search token param', e);
				}
			}
			if (location.hash.startsWith('#') && location.hash.length > 1) {
				try {
					const hashParams = new URLSearchParams(location.hash.slice(1));
					if (hashParams.has('token')) pairToken = hashParams.get('token');
					if (hashParams.has('salt')) pairSalt = hashParams.get('salt');
					if (hashParams.has('key')) pairKey = hashParams.get('key');
					if (pairToken || pairSalt || pairKey) {
						isPaired = true;
						history.replaceState(null, '', location.pathname + location.search);
					}
				} catch (e) {
					console.error('Failed to parse URL hash pairing params', e);
				}
			}
			this.wiki.addTiddler({
				title: '$:/status/TiddlyPWABiometricAvailable',
				text: (typeof window !== 'undefined' && window.PublicKeyCredential && window.isSecureContext) ? 'yes' : 'no',
			});
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
					const lastSession = ses[ses.length - 1];
					if (lastSession.mode === 'biometric_prf') {
						this.biometricSession = lastSession;
						this.wiki.addTiddler({ title: '$:/status/TiddlyPWABiometricConfigured', text: 'yes' });
					} else if (lastSession.enckeys && lastSession.mackey) {
						this.enckeys = lastSession.enckeys;
						this.mackey = lastSession.mackey;
						this.pushKey = lastSession.pushKey || null;
						this.watcherSignKey = lastSession.watcherSignKey || null;
						this.watcherPubKeyB64 = lastSession.watcherPubKeyB64 || null;
					}
				}
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWARemembered', text: this.enckeys ? 'yes' : 'no' });
			}
			if (pairKey && !this.enckeys) {
				try {
					const rawKey = b64dec(pairKey);
					if (rawKey && rawKey.byteLength === 32) {
						this.basebits = rawKey;
						if (pairSalt) {
							this.salt = b64dec(pairSalt);
						}
						await this.deriveKeysFromBasebits(this.basebits);
						let pairServerUrl = null;
						if (pairToken) {
							pairServerUrl = new URL('/tid.dly', document.location).href;
							try {
								const bResp = await fetch('bootstrap.json', { cache: 'no-store' });
								if (bResp.ok) {
									const bData = await bResp.json();
									if (typeof bData.endpoint === 'string' && bData.endpoint) {
										pairServerUrl = new URL(bData.endpoint, document.location).href;
									}
								}
							} catch (_e) {
								// Fallback to /tid.dly
							}
						}
						let authOk = true;
						if (freshDb && pairToken && pairServerUrl) {
							const authRes = await this.verifyAuthWithServer(pairServerUrl, pairToken);
							if (!authRes.ok && authRes.reason === 'EAUTH') {
								authOk = false;
							}
						}
						const ok = authOk && await this.initialRead();
						if (ok) {
							this.logger.log('Unlocked directly via instant-pairing key');
							this.modal.close();
							delete this.modal;
							if (freshDb && this.salt) {
								await adb(
									this.db.transaction('metadata', 'readwrite').objectStore('metadata').put({ salt: this.salt }),
								);
							}
							if (pairToken && pairServerUrl) {
								const tx = this.db.transaction('syncservers', 'readwrite');
								const store = tx.objectStore('syncservers');
								const existingServers = await adb(store.getAll());
								const existingKeys = await adb(store.getAllKeys());
								for (let i = 0; i < existingServers.length; i++) {
									if (existingServers[i].token === pairToken) {
										await adb(store.delete(existingKeys[i]));
									}
								}
								await adb(
									store.put({
										url: pairServerUrl,
										token: pairToken,
										lastSync: new Date(0),
									}),
								);
								this.backgroundSync();
							}
							this.afterUnlock(freshDb);
							return;
						} else {
							this.enckeys = null;
							this.mackey = null;
							this.basebits = null;
						}
					}
				} catch (e) {
					console.error('Instant pairing key failed:', e);
					this.enckeys = null;
					this.mackey = null;
					this.basebits = null;
				}
			}
			if (this.biometricSession && !this.enckeys) {
				let bioUnlocked = false;
				// Waiting on the user from here on: let the page render behind the prompt meanwhile
				this.releaseBoot();
				await new Promise((resolve) => {
					const doBiometric = async () => {
						this.modal.setProgress(null, 'Authenticating with biometrics…');
						try {
							await this.unlockWithBiometrics(this.biometricSession);
							bioUnlocked = true;
							this.modal.close();
							delete this.modal;
							resolve();
						} catch (e) {
							console.warn('Biometric unlock failed or cancelled:', e);
							const isCancel = e?.name === 'NotAllowedError' || e?.name === 'AbortError';
							const msg = isCancel
								? 'Biometric unlock was cancelled. Please use password.'
								: `Biometric unlock failed (${
									$tw.utils.htmlEncode(e?.message || 'hardware error')
								}). Please use password.`;
							this.modal.setFeedback(`<p class="tiddlypwa-form-error">${msg}</p>`);
							this.modal.clearBiometricPrompt();
							this.modal.showForm();
							resolve();
						}
					};
					this.modal.showBiometricPrompt(
						doBiometric,
						() => {
							this.modal.showForm();
							resolve();
						},
					);
				});
				if (bioUnlocked) {
					this.afterUnlock(false);
					return;
				}
			}
			if (!this.enckeys) {
				let bootstrapEndpoint;
				let serverState = null;
				const [weAreScrewed, missingWarning] = this.missingFeaturesWarning();
				const seemsLikeDocs = $tw.wiki.getTiddlersWithTag('TiddlyPWA Docs').length > 0;
				if (freshDb) {
					this.modal.setProgress(null, 'Checking sync server…');
					const giveUp = new AbortController();
					this.modal.showGiveUpButtonDelayed(6900, () => giveUp.abort());
					if (seemsLikeDocs) {
						this.modal.showModalDelayed(6900);
					}
					try {
						const resp = await fetch('bootstrap.json', {
							signal: giveUp.signal,
							cache: 'no-store',
						});
						const { state, endpoint, salt } = await resp.json();
						serverState = state;
						if (
							(endpoint && typeof endpoint !== 'string') || (state && typeof state !== 'string') ||
							(salt && typeof salt !== 'string')
						) {
							this.modal.setFeedback(
								'<p class="tiddlypwa-form-error">Server returned unexpected types in bootstrap.json.</p>',
							);
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
						const safeEndpointHtml = $tw.utils.htmlEncode(endpoint || '');
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
								<p>Paste the token given to you by the administrator of the sync server <code>${safeEndpointHtml}</code> and <strong>make up a strong password</strong>.</p>
								<p>The password will be used to encrypt your data, hiding the content from the server and, if you choose not to use the "remember password" option, against unauthorized users of this device.</p>
								<p>You will have to use that password to open this wiki on all synchronized devices/browsers.</p>
							`);
							this.modal.setFresh();
						} else if (state === 'existing') {
							this.modal.setBody(`
								<p>Welcome back to your synchronized wiki!</p>
								<p>Log in using your credentials below. You are using the sync server <code>${safeEndpointHtml}</code>.</p>
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
						if (isPaired) {
							this.modal.setPairedNotice(
								'📱 <strong>Device Paired</strong>: Sync server and token configured from pairing link. Enter your master password below.',
							);
						}
						if (pairToken) {
							if (!bootstrapEndpoint) bootstrapEndpoint = {};
							bootstrapEndpoint.token = pairToken;
						}
						if (pairSalt) {
							try {
								this.salt = b64dec(pairSalt);
								askSalt = false;
							} catch (e) {
								console.error('Failed to decode pairSalt', e);
							}
						}
						if (askToken) {
							if (!bootstrapEndpoint) {
								this.modal.setFeedback(
									`<p class="tiddlypwa-form-error">Server is misconfigured: missing endpoint for state '${
										$tw.utils.htmlEncode(state || '')
									}'.</p>`,
								);
							}
							let initialToken = bootstrapEndpoint?.token;
							if (!initialToken) {
								initialToken = searchToken;
							}
							if (initialToken) {
								bootstrapEndpoint.token = initialToken;
							}
							this.modal.addTokenInput(
								(e) => {
									if (!bootstrapEndpoint) bootstrapEndpoint = {};
									bootstrapEndpoint.token = e.target.value.trim();
								},
								initialToken,
								isPaired && !!pairToken,
							);
						}
						if (askSalt) {
							const validateSaltText = (rawSalt) => {
								const saltText = String(rawSalt || '').trim();
								if (saltText.length === 0) return '';
								if (saltText.length < 16) return 'The salt is too short';
								try {
									b64dec(saltText);
									return '';
								} catch (_e) {
									return 'Could not decode the salt';
								}
							};
							this.modal.setSaltValidator(validateSaltText);
							this.modal.addSaltInput((e) => {
								const saltText = e.target.value.trim();
								const errMsg = validateSaltText(saltText);
								if (saltText.length === 0) {
									this.salt = null;
									this.modal.setFeedback('');
								} else if (errMsg) {
									this.salt = null;
									this.modal.setFeedback(`<p class="tiddlypwa-form-error">${$tw.utils.htmlEncode(errMsg)}</p>`);
								} else {
									this.salt = b64dec(saltText);
									this.modal.setFeedback('');
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
				// Waiting on the user from here on: let the page render behind the prompt meanwhile
				this.releaseBoot();
				const AW = require('$:/plugins/mblackman/tiddlypwa/argon2ian.js').ArgonWorker;
				const argon = new AW();
				try {
					await argon.ready;
					let checked = false;
					while (!checked) {
						const password = await this.modal.formSubmitted();
						this.modal.setProgress(null, 'Deriving encryption keys…');
						if (!this.salt) this.salt = crypto.getRandomValues(new Uint8Array(32));
						try {
							console.time('hash');
							const basebits = await argon.hash(utfenc.encode(password), this.salt, { m: 1 << 17, t: 2 });
							console.timeEnd('hash');
							this.basebits = basebits;
							await this.deriveKeysFromBasebits(this.basebits);
							if (freshDb && bootstrapEndpoint?.url && bootstrapEndpoint?.token && serverState === 'existing') {
								this.modal.setProgress(null, 'Verifying credentials with sync server…');
								const authRes = await this.verifyAuthWithServer(bootstrapEndpoint.url, bootstrapEndpoint.token);
								if (!authRes.ok) {
									this.enckeys = null;
									this.mackey = null;
									this.basebits = null;
									const errMsg = authRes.reason === 'EAUTH'
										? 'Wrong password or sync token!'
										: `Could not verify password with sync server (${
											$tw.utils.htmlEncode(authRes.reason)
										}). Check your connection and try again.`;
									this.modal.setFeedback(`<p class="tiddlypwa-form-error">${errMsg}</p>`);
									checked = false;
									continue;
								}
							}
							checked = await this.initialRead();
							if (!checked) {
								this.enckeys = null;
								this.mackey = null;
								this.basebits = null;
								this.modal.setFeedback('<p class="tiddlypwa-form-error">Wrong password!</p>');
							}
						} catch (e) {
							console.error('Unlock failed:', e);
							this.enckeys = null;
							this.mackey = null;
							this.basebits = null;
							this.modal.setFeedback(
								`<p class="tiddlypwa-form-error">Unlock failed: ${$tw.utils.htmlEncode(e?.message || String(e))}</p>`,
							);
							checked = false;
						}
					}
				} finally {
					argon.terminate();
				}
				if (freshDb) {
					await adb(this.db.transaction('metadata', 'readwrite').objectStore('metadata').put({ salt: this.salt }));
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
				this.modal.setProgress(0, 'Unlocking your wiki…');
				await this.initialRead();
			}
			this.afterUnlock(freshDb);
		}

		// Closes the unlock modal right away; the status reflections below only feed the settings UI,
		// so they run in the background instead of keeping the wiki hidden.
		afterUnlock(freshDb) {
			this.reflectSplashCache();
			if (this.modal) {
				this.modal.close();
				delete this.modal;
			}
			this.releaseBoot();
			(async () => {
				await this.reflectSyncServers();
				await this.reflectStorageInfo();
				this.wiki.addTiddler({
					title: '$:/status/TiddlyPWASalt',
					text: await b64enc(this.salt),
				});
				this.wiki.addTiddler({
					title: '$:/status/TiddlyPWABiometricAvailable',
					text: (typeof window !== 'undefined' && window.PublicKeyCredential && window.isSecureContext) ? 'yes' : 'no',
				});
				this.wiki.addTiddler({
					title: '$:/status/TiddlyPWABiometricConfigured',
					text: this.biometricSession ? 'yes' : 'no',
				});
				this.wiki.addTiddler({
					title: '$:/status/TiddlyPWAMasterKeyInMemory',
					text: this.basebits ? 'yes' : 'no',
				});
				await this.updatePairUrl();
			})().catch((e) => console.error(e));
			this.ensureSaverHydrationWrapper();
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
			}).finally(() => this.releaseBoot()); // whatever happened (docs mode, errors), never keep the page unrendered
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

		registerTitleHash(title, thash, b64) {
			if (!title || typeof title !== 'string' || !thash) return;
			const b64Key = b64 || b64encSync(thash);
			this.titleToHashBuf.set(title, thash);
			this.titleToHashB64.set(title, b64Key);
			this.hashB64ToTitle.set(b64Key, title);
		}

		markAppWikiDirty() {
			if (!this.origSyncerIsDirty && $tw.syncer && typeof $tw.syncer.isDirty === 'function') {
				const origIsDirty = $tw.syncer.isDirty.bind($tw.syncer);
				this.origSyncerIsDirty = origIsDirty;
				$tw.syncer.isDirty = () => this.appWikiDirty || origIsDirty();
			}
			this.appWikiDirty = true;
			$tw.syncer?.updateDirtyStatus?.();
		}

		titlehash(x) {
			// keyed (hmac) because sync servers don't need to be able to compare contents between different users
			return crypto.subtle.sign('HMAC', this.mackey, utfenc.encode(x));
		}

		/** @param {ArrayBuffer|ArrayBufferView} thash */
		enckey(thash) {
			const byte0 = (thash instanceof Uint8Array || ArrayBuffer.isView(thash))
				? thash[0]
				: new DataView(thash.buffer || thash, thash.byteOffset || 0).getUint8(0);
			return this.enckeys[byte0 % this.enckeys.length];
		}

		async _saveTiddler(tiddler) {
			const thash = await this.titlehash(tiddler.fields.title);
			const b64thash = await b64enc(thash);
			const key = this.enckey(thash);
			const isBin = this.isBinaryContentType(tiddler.fields.type) ||
				this.wiki.isBinaryTiddler(tiddler.fields.title);
			const isSepBody = tiddler.fields.text && (isBin || tiddler.fields.text.length > 256);
			const isBlobUrl = typeof tiddler.fields._canonical_uri === 'string' &&
				tiddler.fields._canonical_uri.startsWith('blob:');
			const blobEntry = isBlobUrl ? this.blobRegistry.get(tiddler.fields._canonical_uri) : null;
			const json = JSON.stringify(
				Object.keys(tiddler.fields).reduce((o, k) => {
					if (k === 'text' && isSepBody) return o;
					if (k === '_canonical_uri' && isBlobUrl) return o;
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
			let sbiv, sbct, newBlobSha;
			if (isSepBody) {
				sbiv = crypto.getRandomValues(new Uint8Array(12));
				sbct = await crypto.subtle.encrypt(
					{ name: 'AES-GCM', iv: sbiv },
					key,
					await encodeData(tiddler.fields.text, isBin, 256),
				);
				this.savedBlobSha.delete(b64thash);
				if (!isBlobUrl) {
					this.releaseBlobForTitle(tiddler.fields.title);
				}
			} else if (blobEntry && this.savedBlobSha.get(b64thash) !== blobEntry.sha256B64) {
				sbiv = crypto.getRandomValues(new Uint8Array(12));
				sbct = await crypto.subtle.encrypt(
					{ name: 'AES-GCM', iv: sbiv },
					key,
					await encodeBinaryBytes(blobEntry.rawBytes, 256),
				);
				newBlobSha = blobEntry.sha256B64;
			}
			await new Promise((resolve, reject) => {
				const txn = this.db.transaction('tiddlers', 'readwrite');
				const store = txn.objectStore('tiddlers');
				const getReq = store.get(thash);
				getReq.onsuccess = () => {
					const existing = getReq.result;
					let finalSbiv = sbiv;
					let finalSbct = sbct;
					if (!isSepBody && !finalSbiv && isBlobUrl && existing) {
						finalSbiv = existing.sbiv;
						finalSbct = existing.sbct;
					}
					const baseMtime = existing ? (existing.baseMtime !== undefined ? existing.baseMtime : existing.mtime) : null;
					const serverSyncState = existing?.serverSyncState ? structuredClone(existing.serverSyncState) : undefined;
					let minTime = Date.now();
					if (baseMtime instanceof Date && baseMtime.getTime() >= minTime) {
						minTime = baseMtime.getTime() + 1;
					}
					const maxServerBm = this.maxServerBaseMtimeMs(existing);
					if (maxServerBm >= minTime) {
						minTime = maxServerBm + 1;
					}
					if (existing?.mtime instanceof Date && existing.mtime.getTime() >= minTime) {
						minTime = existing.mtime.getTime() + 1;
					}
					store.put({
						thash, // The title hash is the primary key
						iv,
						ct,
						sbiv: finalSbiv,
						sbct: finalSbct,
						mtime: new Date(minTime), // Has to be unencrypted for sync conflict resolution
						// also, *not* using the tiddler's modified field allows for importing tiddlers last modified in the past
						baseMtime,
						...(serverSyncState ? { serverSyncState } : {}),
					});
				};
				txn.oncomplete = () => resolve();
				txn.onerror = () => reject(txn.error);
			});
			if (newBlobSha) {
				this.savedBlobSha.set(b64thash, newBlobSha);
			}
			this.registerTitleHash(tiddler.fields.title, thash, b64thash);
			await this.reflectStorageInfo();
			await this.refreshUnsyncedCount();
		}

		saveTiddler(tiddler, cb) {
			if (isDraftTiddler(tiddler)) {
				return cb(null, '', 1);
			}
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
				(tiddler.fields.type === 'application/javascript' &&
					tiddler.fields['module-type'] &&
					tiddler.fields['module-type'] !== 'pwa-watcher')
			) {
				this.markAppWikiDirty(); // make the UI insist on a save which would be the app save
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
			if (!obj) return null;
			const tid = await this.parseEncryptedTiddler(obj);
			this.registerTitleHash(title, thash, await b64enc(thash));
			if (obj.sbiv && obj.sbct) {
				const decryptedBuf = await crypto.subtle.decrypt(
					{ name: 'AES-GCM', iv: obj.sbiv },
					this.enckey(thash),
					obj.sbct,
				);
				if (this.isBinaryContentType(tid.type)) {
					const blobUrl = await this.registerBinaryBlob(tid.title, decryptedBuf, tid.type);
					tid._canonical_uri = blobUrl;
					const entry = this.blobRegistry.get(blobUrl);
					if (entry) this.savedBlobSha.set(await b64enc(thash), entry.sha256B64);
				} else {
					tid.text = await decodeData(decryptedBuf);
				}
			}
			return tid;
		}

		loadTiddler(title, cb) {
			this._loadTiddler(title).then((tid) => {
				cb(null, tid);
				if (title === $tw.syncer.titleSyncFilter && tid && tid.text) {
					// XXX: syncer should itself monitor for changes and recompile
					$tw.syncer.filterFn = this.wiki.compileFilter(tid.text);
				}
			}).catch((e) => {
				console.error(e);
				cb(e);
			});
		}

		async _deleteTiddler(title) {
			const thash = await this.titlehash(title);
			const b64thash = await b64enc(thash);
			this.registerTitleHash(title, thash, b64thash);
			this.savedBlobSha.delete(b64thash);
			this.releaseBlobForTitle(title);
			await new Promise((resolve, reject) => {
				const txn = this.db.transaction('tiddlers', 'readwrite');
				const store = txn.objectStore('tiddlers');
				const getReq = store.get(thash);
				getReq.onsuccess = () => {
					const existing = getReq.result;
					const baseMtime = existing ? (existing.baseMtime !== undefined ? existing.baseMtime : existing.mtime) : null;
					const serverSyncState = existing?.serverSyncState ? structuredClone(existing.serverSyncState) : undefined;
					let minTime = Date.now();
					if (baseMtime instanceof Date && baseMtime.getTime() >= minTime) {
						minTime = baseMtime.getTime() + 1;
					}
					const maxServerBm = this.maxServerBaseMtimeMs(existing);
					if (maxServerBm >= minTime) {
						minTime = maxServerBm + 1;
					}
					if (existing?.mtime instanceof Date && existing.mtime.getTime() >= minTime) {
						minTime = existing.mtime.getTime() + 1;
					}
					store.put({
						thash,
						iv: undefined,
						ct: undefined,
						sbiv: undefined,
						sbct: undefined,
						mtime: new Date(minTime),
						deleted: true,
						baseMtime,
						...(serverSyncState ? { serverSyncState } : {}),
					});
				};
				txn.oncomplete = () => resolve();
				txn.onerror = () => reject(txn.error);
			});
			await this.reflectStorageInfo();
			await this.refreshUnsyncedCount();
		}

		deleteTiddler(title, cb, _options) {
			if (typeof title === 'string' && title.startsWith("Draft of '")) {
				return cb(null);
			}
			this._deleteTiddler(title).then((_) => {
				if (this.tiddlersInFile.has(title)) {
					this.markAppWikiDirty();
					this.logger.alert(
						`You have deleted the tiddler <code>${
							$tw.utils.htmlEncode(title)
						}</code> which was in the app wiki file. If you want it gone, you must also save the app wiki; conversely, you can refresh the page to restore it.`,
					);
				}
				cb(null);
				this.changesChannel.postMessage({ title, del: true });
				this.backgroundSync();
			}).catch((e) => {
				console.error(e);
				cb(e);
			});
		}

		async uploadAppWiki(variables = {}) {
			if (!this.wiki.getTiddler('$:/core') || !this.wiki.getTiddler('$:/plugins/mblackman/tiddlypwa')) {
				this.logger.alert(
					'You have deleted the TiddlyPWA plugin and tried to save the app HTML to the server! Refusing to self-destruct.',
				);
				return;
			}
			this.wiki.addTiddler({ title: '$:/status/TiddlyPWAUploadResult', text: 'Upload in progress.' });
			this.wiki.addTiddler({ title: '$:/status/TiddlyPWAUploading', text: 'yes' });
			// Unpack any newly imported, updated, or deleted plugins so their shadow tiddlers (such as sw.js and app-filter)
			// are up to date before rendering the app wiki and service worker.
			try {
				const prevPlugins = this.wiki.unregisterPluginTiddlers(null);
				this.wiki.readPluginInfo(Array.from(new Set([...prevPlugins, ...this.wiki.allTitles()])));
				this.wiki.registerPluginTiddlers();
				this.wiki.unpackPluginTiddlers();
			} catch (e) {
				console.warn('Failed to unpack plugin tiddlers before app wiki render:', e);
			}
			const effectiveVars = {
				...variables,
				publishFilter: variables.publishFilter || this.wiki.getTiddlerText('$:/plugins/mblackman/tiddlypwa/app-filter'),
			};
			const apphtml = $tw.wiki.renderTiddler(
				'text/plain',
				$tw.wiki.getTiddlerText('$:/config/SaveWikiButton/Template', '$:/core/save/all'),
				{ variables: effectiveVars },
			);
			const swjs = $tw.wiki.renderTiddler('text/plain', '$:/plugins/mblackman/tiddlypwa/sw.js', {});
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
				let uploadedCurrent = false;
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
					const respData = await resp.json();
					const rawPrefix = typeof respData.urlprefix === 'string' ? respData.urlprefix : '';
					const cleanPrefix = rawPrefix.replace(/^\/+|\/+$/g, '');
					const endpointUrl = new URL(url, document.location);
					if (cleanPrefix && endpointUrl.pathname.endsWith(`/${cleanPrefix}/tid.dly`)) {
						endpointUrl.pathname = endpointUrl.pathname.slice(0, -(`/${cleanPrefix}/tid.dly`.length)) + '/tid.dly';
					}
					const href = new URL((cleanPrefix ? cleanPrefix + '/' : '') + 'app.html', endpointUrl).href;
					const isCurrent = isCurrentUrl(href);
					urls.push(
						href + (isCurrent ? ' {{$:/plugins/mblackman/tiddlypwa/cur-page-reload}}' : ''),
					);
					if (isCurrent) {
						uploadedCurrent = true;
						// This makes sure we instantly reload into the new version!
						// The ServiceWorker will refetch from the server in the background again,
						// so this should not cause any trouble. E.g. a concurrent update that
						// happened in between upload and refresh would arrive as a new refresh prompt.
						// The ETag is generated using Base64URL to match the reference server (assuming Brotli is working).
						// If the ETag is different, sync will notice the mismatch and request the worker to reload.
						try {
							const etag = typeof respData.etag === 'string' && respData.etag
								? respData.etag
								: `"${await b64urlEnc(await crypto.subtle.digest('SHA-1', utfenc.encode(apphtml)))}-b"`;
							const makeResp = () =>
								new Response(apphtml, {
									headers: {
										'content-type': 'text/html;charset=utf-8',
										etag,
									},
								});
							const cache = await caches.open(this.getScopedCacheName());
							const curPageUrl = new URL(location.pathname, location.origin).href;
							let matchedCurrentPage = false;
							for (const req of await cache.keys()) {
								if (isCurrentUrl(req.url)) {
									await cache.put(req, makeResp());
									if (req.url === curPageUrl) matchedCurrentPage = true;
								}
							}
							if (!matchedCurrentPage) {
								await cache.put(curPageUrl, makeResp());
							}
							if (href !== curPageUrl && !isCurrentUrl(href)) {
								await cache.put(href, makeResp());
							}
						} catch (e) {
							this.logger.alert('Failed to update local cache!');
							console.error(e);
						}
					}
				}
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWAUploadResult', text: 'Uploaded:\n\n* ' + urls.join('\n* ') });
				if (uploadedCurrent) {
					this.appWikiDirty = false;
					$tw.syncer?.updateDirtyStatus?.();
					if (variables.autoReload === 'yes') {
						$tw.syncer.isDirty = () => false;
						location.reload();
					}
				}
			} catch (e) {
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWAUploadResult', text: 'Upload error: ' + e });
				console.error(e);
			} finally {
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWAUploading', text: 'no' });
			}
		}

		async _syncOneUnlocked(server, all = false) {
			const { url, token, lastSync = new Date(0) } = server;
			const serverKey = this.getServerSyncKey(server);
			this.logger.log('sync started', url, lastSync, all);
			this.wiki.addTiddler({ title: '$:/status/TiddlyPWASyncingWith', text: url });
			const changes = [];
			const it = adbiter(this.db.transaction('tiddlers').objectStore('tiddlers').openCursor());
			for await (const tid of it) {
				const isDirty = this.isTiddlerDirtyForServer(tid, serverKey);
				if (all || isDirty || (!tid.serverSyncState && tid.mtime > lastSync)) changes.push(tid);
			}
			const clientChanges = [];
			const localChangesByHash = new Map();
			let newestChg = new Date(0);
			for (const tid of changes) {
				const { thash, iv, ct, sbiv, sbct, mtime, deleted } = tid;
				if (arrayEq(thash, this.storyListHash)) continue;
				const b64hash = await b64enc(thash);
				const serverBaseMtime = this.getBaseMtimeForServer(tid, serverKey);
				const tidjson = {
					thash: b64hash,
					ct: ct && (await b64enc(ct)),
					iv: iv && (await b64enc(iv)),
					sbct: sbct && (await b64enc(sbct)),
					sbiv: sbiv && (await b64enc(sbiv)),
					mtime,
					deleted,
					baseMtime: serverBaseMtime instanceof Date
						? serverBaseMtime.toISOString()
						: (serverBaseMtime ? new Date(serverBaseMtime).toISOString() : null),
				};
				clientChanges.push(tidjson);
				localChangesByHash.set(b64hash, tid);
				this.logger.log('local change', tidjson.thash);
			}
			this.syncAbort = new AbortController();
			const timeoutSignal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(30000) : null;
			const syncSignal = (typeof AbortSignal.any === 'function' && timeoutSignal)
				? AbortSignal.any([this.syncAbort.signal, timeoutSignal])
				: this.syncAbort.signal;
			let syncTimeoutTimer = null;
			if (!AbortSignal.any || !timeoutSignal) {
				syncTimeoutTimer = setTimeout(() => this.syncAbort?.abort(), 30000);
			}
			let resp;
			let respJson;
			const ackPatchesPayload = this.ackedPatchIds.size > 0 ? [...this.ackedPatchIds] : undefined;
			try {
				resp = await fetch(url, {
					signal: syncSignal,
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
						ackPatches: ackPatchesPayload,
					}),
				});
				if (!resp.ok) {
					throw new Error(
						await resp
							.json()
							.then(({ error }) => knownErrors[error] || error)
							.catch((_e) => 'Server returned error ' + resp.status),
					);
				}
				respJson = await resp.json();
				if (ackPatchesPayload) {
					for (const pId of ackPatchesPayload) {
						this.ackedPatchIds.delete(pId);
					}
				}
			} catch (e) {
				if (e.name === 'AbortError') throw e;
				if (e.message && Object.values(knownErrors).includes(e.message)) throw e;
				throw new FetchError(e); // so silly that fetch throws inconsistent stuff across browsers
			} finally {
				if (syncTimeoutTimer) clearTimeout(syncTimeoutTimer);
			}
			const serverTimeHdr = resp.headers.get('x-server-time');
			const { serverChanges, appEtag, conflicts, successes, pendingPatches } = respJson;
			const conflictSet = new Set(conflicts || []);
			const successMap = new Map();
			if (successes) {
				for (const { thash, mtime } of successes) {
					successMap.set(thash, new Date(mtime));
				}
			}
			const toDecrypt = [];
			const titleHashesToDelete = new Set();
			const idbWrites = [];
			const conflictTiddlersToAdd = [];
			const conflictedTitlesInPass = new Set();

			for (const { thash, iv, ct, sbiv, sbct, mtime, deleted } of serverChanges) {
				const dhash = b64dec(thash);
				if (!dhash || arrayEq(dhash, this.storyListHash)) continue;
				const serverMtime = new Date(mtime);
				const remotetid = {
					thash: dhash.buffer,
					ct: ct && b64dec(ct).buffer,
					iv: iv && b64dec(iv).buffer,
					sbct: sbct && b64dec(sbct).buffer,
					sbiv: sbiv && b64dec(sbiv).buffer,
					mtime: serverMtime,
					baseMtime: serverMtime,
					deleted: !!deleted,
				};
				this.logger.log('remote change', thash);

				const ourtid = localChangesByHash.get(thash);
				const isServerConflict = conflictSet.has(thash);

				if (ourtid || isServerConflict) {
					const ourMtime = ourtid
						? (ourtid.mtime instanceof Date ? ourtid.mtime : new Date(ourtid.mtime))
						: new Date(0);
					this.logger.log(
						'conflict detected:',
						thash,
						'server:',
						remotetid.mtime,
						'local:',
						ourMtime,
						'serverConflict:',
						isServerConflict,
					);

					if (ourtid && ourtid.deleted && remotetid.deleted) {
						// Both deleted: no-op, retain deletion
						idbWrites.push(remotetid);
						titleHashesToDelete.add(thash);
					} else if (ourtid && !ourtid.deleted && !remotetid.deleted) {
						// Both edited concurrently
						const ourDecrypted = await this.decryptRawTiddler(ourtid);
						const remoteDecrypted = await this.decryptRawTiddler(remotetid);

						if (this.tiddlersAreEqual(ourDecrypted, remoteDecrypted)) {
							this.logger.log('False conflict suppressed (identical payload):', thash);
							this.revokeTempBlob(ourDecrypted);
							this.revokeTempBlob(remoteDecrypted);
							idbWrites.push(remotetid);
							toDecrypt.push(remotetid);
						} else {
							const originalTitle = ourDecrypted?.title || remoteDecrypted?.title || 'Untitled';
							if (isServerConflict || remotetid.mtime.getTime() >= ourMtime.getTime()) {
								// Server canonical version wins; preserve local edit in conflict copy
								this.logger.log('Server is canonical; preserving local conflict copy');
								if (ourDecrypted) {
									const conflictTid = this.createConflictTiddler(ourDecrypted, originalTitle, 'local', ourMtime);
									if (
										typeof conflictTid.fields._canonical_uri === 'string' &&
										conflictTid.fields._canonical_uri.startsWith('blob:')
									) {
										this.bindBlobTitle(conflictTid.fields.title, conflictTid.fields._canonical_uri);
									}
									conflictTiddlersToAdd.push(conflictTid);
									conflictedTitlesInPass.add(originalTitle);
								}
								this.revokeTempBlob(remoteDecrypted);
								idbWrites.push(remotetid);
								toDecrypt.push(remotetid);
							} else {
								// Local is newer and was accepted by server: local remains canonical, preserve remote copy
								this.logger.log('Local is newer; keeping local canonical and saving remote conflict copy');
								if (remoteDecrypted) {
									const conflictTid = this.createConflictTiddler(
										remoteDecrypted,
										originalTitle,
										'remote',
										remotetid.mtime,
									);
									if (
										typeof conflictTid.fields._canonical_uri === 'string' &&
										conflictTid.fields._canonical_uri.startsWith('blob:')
									) {
										this.bindBlobTitle(conflictTid.fields.title, conflictTid.fields._canonical_uri);
									}
									conflictTiddlersToAdd.push(conflictTid);
									conflictedTitlesInPass.add(originalTitle);
								}
								this.revokeTempBlob(ourDecrypted);
							}
						}
					} else if (ourtid && !ourtid.deleted && remotetid.deleted) {
						// Local edit vs Remote delete
						const ourDecrypted = await this.decryptRawTiddler(ourtid);
						const originalTitle = ourDecrypted?.title || 'Untitled';
						if (isServerConflict || remotetid.mtime.getTime() > ourMtime.getTime()) {
							// Remote delete is canonical: Apply deletion, preserve local edits in conflict copy
							this.logger.log('Remote delete is canonical; preserving local edit in conflict copy');
							if (ourDecrypted) {
								const conflictTid = this.createConflictTiddler(ourDecrypted, originalTitle, 'local', ourMtime);
								if (
									typeof conflictTid.fields._canonical_uri === 'string' &&
									conflictTid.fields._canonical_uri.startsWith('blob:')
								) {
									this.bindBlobTitle(conflictTid.fields.title, conflictTid.fields._canonical_uri);
								}
								conflictTiddlersToAdd.push(conflictTid);
								conflictedTitlesInPass.add(originalTitle);
							}
							idbWrites.push(remotetid);
							titleHashesToDelete.add(thash);
						} else {
							// Local edit is newer: Local edit resurrects tiddler
							this.revokeTempBlob(ourDecrypted);
							this.logger.log('Local edit is newer than remote delete; resurrecting local');
						}
					} else if (ourtid && ourtid.deleted && !remotetid.deleted) {
						// Local delete vs Remote edit
						const remoteDecrypted = await this.decryptRawTiddler(remotetid);
						const originalTitle = remoteDecrypted?.title || 'Untitled';
						if (isServerConflict || remotetid.mtime.getTime() > ourMtime.getTime()) {
							// Remote edit is newer: Remote edit resurrects tiddler
							this.revokeTempBlob(remoteDecrypted);
							this.logger.log('Remote edit is canonical; applying remote edit');
							idbWrites.push(remotetid);
							toDecrypt.push(remotetid);
						} else {
							// Local delete is newer: Delete wins, preserve remote edit in conflict copy
							this.logger.log('Local delete is newer than remote edit; preserving remote edit in conflict copy');
							if (remoteDecrypted) {
								const conflictTid = this.createConflictTiddler(
									remoteDecrypted,
									originalTitle,
									'remote',
									remotetid.mtime,
								);
								if (
									typeof conflictTid.fields._canonical_uri === 'string' &&
									conflictTid.fields._canonical_uri.startsWith('blob:')
								) {
									this.bindBlobTitle(conflictTid.fields.title, conflictTid.fields._canonical_uri);
								}
								conflictTiddlersToAdd.push(conflictTid);
								conflictedTitlesInPass.add(originalTitle);
							}
						}
					} else {
						idbWrites.push(remotetid);
						if (remotetid.deleted) {
							titleHashesToDelete.add(thash);
						} else {
							toDecrypt.push(remotetid);
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

			// Batch commit canonical updates to IndexedDB in one synchronous transaction.
			// Use read-modify-write to avoid overwriting local edits made during the fetch.
			const skippedByNewerLocalEdit = new Set();
			if (idbWrites.length > 0) {
				const txn = this.db.transaction('tiddlers', 'readwrite');
				const store = txn.objectStore('tiddlers');
				for (const tid of idbWrites) {
					const getReq = store.get(tid.thash);
					getReq.onsuccess = () => {
						const current = getReq.result;
						const nextState = {};
						if (current?.serverSyncState && typeof current.serverSyncState === 'object') {
							for (const [sk, sv] of Object.entries(current.serverSyncState)) {
								nextState[sk] = {
									baseMtime: sv?.baseMtime ?? null,
									syncedLocalMtime: null,
								};
							}
						}
						// If a local edit happened during the fetch, its mtime will be newer
						// than what we snapshotted. Don't overwrite content - it'll sync next cycle,
						// but MUST advance baseMtime to the server's canonical mtime so the next
						// sync doesn't repeatedly fail OCC with a stale baseMtime (snowball loop).
						if (current && current.mtime instanceof Date) {
							const snapshotEntry = localChangesByHash.get(
								[...localChangesByHash.keys()].find((k) => arrayEq(localChangesByHash.get(k).thash, tid.thash)),
							);
							if (snapshotEntry && current.mtime.getTime() > snapshotEntry.mtime.getTime()) {
								nextState[serverKey] = { baseMtime: tid.mtime, syncedLocalMtime: null };
								current.serverSyncState = nextState;
								current.baseMtime = tid.mtime;
								if (current.mtime.getTime() <= tid.mtime.getTime()) {
									current.mtime = new Date(tid.mtime.getTime() + 1);
								}
								store.put(current);
								skippedByNewerLocalEdit.add(tid);
								return;
							}
						}
						nextState[serverKey] = {
							baseMtime: tid.mtime,
							syncedLocalMtime: tid.mtime instanceof Date ? tid.mtime.getTime() : null,
						};
						tid.serverSyncState = nextState;
						store.put(tid);
					};
				}
				await new Promise((resolve, reject) => {
					txn.oncomplete = resolve;
					txn.onerror = () => reject(txn.error);
				});
			}

			if (respJson.tombstoneReset) {
				const serverChangedSet = new Set(serverChanges.map((c) => c.thash));
				const allLocal = await adb(this.db.transaction('tiddlers').objectStore('tiddlers').getAll());
				const resetTombstones = [];
				for (const localTid of allLocal) {
					if (localTid.deleted || (this.storyListHash && arrayEq(localTid.thash, this.storyListHash))) continue;
					const b64hash = await b64enc(localTid.thash);
					if (serverChangedSet.has(b64hash) || localChangesByHash.has(b64hash)) continue;
					if (this.isTiddlerDirtyForServer(localTid, serverKey)) continue;
					resetTombstones.push({ localTid, b64hash });
				}
				if (resetTombstones.length > 0) {
					const txn = this.db.transaction('tiddlers', 'readwrite');
					const store = txn.objectStore('tiddlers');
					for (const { localTid, b64hash } of resetTombstones) {
						const nowDate = new Date(
							Math.max(Date.now(), (localTid.mtime instanceof Date ? localTid.mtime.getTime() : 0) + 1),
						);
						const nextState = localTid.serverSyncState ? { ...localTid.serverSyncState } : {};
						nextState[serverKey] = { baseMtime: nowDate, syncedLocalMtime: nowDate.getTime() };
						store.put({
							thash: localTid.thash,
							iv: undefined,
							ct: undefined,
							sbiv: undefined,
							sbct: undefined,
							mtime: nowDate,
							deleted: true,
							baseMtime: nowDate,
							serverSyncState: nextState,
						});
						titleHashesToDelete.add(b64hash);
					}
					await new Promise((resolve, reject) => {
						txn.oncomplete = resolve;
						txn.onerror = () => reject(txn.error);
					});
				}
			}

			// Update baseMtime for successfully synced local changes that did not conflict.
			// Read-modify-write: only touch baseMtime and per-server sync state, keeping local mtime monotonic.
			const nonConflictedLocalHashes = [];
			for (const [b64hash, tid] of localChangesByHash) {
				if (!conflictSet.has(b64hash)) {
					const newBaseMtime = successMap.get(b64hash) || tid.mtime;
					if (newBaseMtime > newestChg) newestChg = newBaseMtime;
					nonConflictedLocalHashes.push({ thash: tid.thash, newBaseMtime, oldMtime: tid.mtime });
				}
			}
			if (nonConflictedLocalHashes.length > 0) {
				const txn = this.db.transaction('tiddlers', 'readwrite');
				const store = txn.objectStore('tiddlers');
				for (const { thash, newBaseMtime, oldMtime } of nonConflictedLocalHashes) {
					const getReq = store.get(thash);
					getReq.onsuccess = () => {
						const current = getReq.result;
						if (current) {
							const nextState = current.serverSyncState ? structuredClone(current.serverSyncState) : {};
							const oldMs = oldMtime instanceof Date ? oldMtime.getTime() : new Date(oldMtime).getTime();
							const curMs = current.mtime instanceof Date ? current.mtime.getTime() : 0;
							const unchangedDuringFetch = curMs === oldMs;
							nextState[serverKey] = {
								baseMtime: newBaseMtime,
								syncedLocalMtime: unchangedDuringFetch ? curMs : null,
							};
							current.serverSyncState = nextState;
							current.baseMtime = newBaseMtime;
							store.put(current);
						}
					};
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
				this.wiki.deleteTiddler('$:/temp/HideConflictBanner');
				this.logger.log(`Sync conflict detected: ${conflictTiddlersToAdd.length} conflict copies preserved.`);
			}
			if (titleHashesToDelete.size > 0) {
				const unresolved = new Set();
				for (const h of titleHashesToDelete) {
					const cachedTitle = this.hashB64ToTitle.get(h);
					if (cachedTitle) {
						this.deletedQueue.add(cachedTitle);
						this.changesChannel.postMessage({ title: cachedTitle, del: true });
					} else {
						unresolved.add(h);
					}
				}
				if (unresolved.size > 0) {
					for (const title of $tw.wiki.allTitles()) {
						const thashBuf = await this.titlehash(title);
						const h = await b64enc(thashBuf);
						if (unresolved.has(h)) {
							this.registerTitleHash(title, thashBuf, h);
							this.deletedQueue.add(title);
							this.changesChannel.postMessage({ title, del: true });
						}
					}
				}
			}
			for (const x of toDecrypt) {
				if (skippedByNewerLocalEdit.has(x)) continue;
				const tid = await this.parseEncryptedTiddler(x);
				const title = tid?.title;
				if (!title || isDraftTiddler(tid)) continue;
				this.registerTitleHash(title, x.thash, await b64enc(x.thash));
				if (title !== '$:/StoryList') {
					let resolvedTid = tid;
					if (x.sbiv && x.sbct) {
						if (mustEagerLoad(tid)) {
							resolvedTid = (await this.decryptRawTiddler(x, { registerForTitle: true })) || tid;
						} else {
							resolvedTid = { ...tid, _is_skinny: true };
						}
					}
					const draftTitle = this.wiki.findDraft?.(title) || `Draft of '${title}'`;
					if (this.wiki.tiddlerExists(draftTitle) && !conflictedTitlesInPass.has(title)) {
						this.checkDraftCollision(title, resolvedTid, x.mtime);
					}
					if (
						!resolvedTid._is_skinny && typeof resolvedTid._canonical_uri === 'string' &&
						resolvedTid._canonical_uri.startsWith('blob:')
					) {
						this.bindBlobTitle(title, resolvedTid._canonical_uri);
					} else if (!resolvedTid._is_skinny) {
						this.releaseBlobForTitle(title);
					}
					$tw.syncer.storeTiddler(resolvedTid);
					this.changesChannel.postMessage({ title });
				}
			}
			if (appEtag && navigator.serviceWorker.controller) {
				const stripWeak = (x) => x && (x.startsWith('W/') ? x.slice(2) : x);
				const cache = await caches.open(this.getScopedCacheName());
				for (const req of await cache.keys()) {
					if (!isCurrentUrl(req.url)) continue;
					const resp = await cache.match(req);
					const cachedEtag = stripWeak(resp?.headers?.get('etag'));
					if (!cachedEtag || cachedEtag === stripWeak(appEtag)) continue;
					navigator.serviceWorker.controller.postMessage({ op: 'update', url: req.url });
				}
			}
			if (pendingPatches && Array.isArray(pendingPatches) && pendingPatches.length > 0) {
				await this.applyPendingWatcherPatches(pendingPatches);
			}
			this.logger.log('sync done', url);
			if (serverTimeHdr) {
				const sDate = new Date(serverTimeHdr);
				if (Number.isFinite(sDate.getTime()) && sDate > newestChg) {
					newestChg = sDate;
				}
			}
			if (lastSync > newestChg) {
				newestChg = lastSync;
			}
			return newestChg;
		}

		async _syncManyUnlocked(all) {
			let hadSuccess = false;
			let lastError = '';
			try {
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
						const wasFirstSync = !server.lastSync || new Date(server.lastSync).getTime() === 0;
						server.lastSync = await this._syncOneUnlocked(server, all);
						await adb(this.db.transaction('syncservers', 'readwrite').objectStore('syncservers').put(server, key));
						if (wasFirstSync && this.monitorStream && !this.monitorUsingHalftoken) {
							this.monitorStream.close();
							this.monitorStream = null;
							this.startedMonitor = false;
						}
						hadSuccess = true;
					} catch (e) {
						if (e.name === 'AbortError') {
							lastError = 'Sync cancelled or timed out';
						} else if (e.name === 'FetchError') {
							lastError = `Could not reach sync server "${server.url}"`;
							if (!this.hadFetchError) {
								this.logger.alert(
									`Could not sync with server "${server.url}"! You might be offline (or the server is).`,
								);
								console.error(e);
								this.hadFetchError = true;
							}
						} else {
							lastError = e?.message || String(e);
							this.logger.alert(`Could not sync with server "${server.url}"!`, e);
							console.error(e);
						}
					}
				}
				if (!lastError && hadSuccess) {
					this.hadFetchError = false;
				}
				$tw.syncer.syncFromServer(); // "server" being our local DB that we just updated, actually
				await this.reflectSyncServers();
				await this.reflectStorageInfo();
				if (this.afterSyncOnceHook && hadSuccess) {
					this.afterSyncOnceHook();
					delete this.afterSyncOnceHook;
				}
				if (Array.isArray(this.deferredPushClicks) && this.deferredPushClicks.length > 0) {
					await this.firstChange();
				}
				await this.drainPendingPushClicks(true);
				this.scheduleNotificationRuleSync();
				this.scheduleWatcherSync();
			} finally {
				this.wiki.addTiddler({ title: '$:/status/TiddlyPWASyncing', text: 'no' });
				$tw.utils.removeClass(document.body, 'tiddlypwa-syncing');
				this.isSyncing = false;
				await this.refreshUnsyncedCount({ syncing: false, error: lastError });
				if (this.wantResync) {
					this.wantResync = false;
					this.backgroundSync();
				}
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
			this.updateSyncUiStatus({ syncing: true });
			return navigator.locks.request(`tiddlypwa:${location.pathname}`, (_lck) => this._syncManyUnlocked(all));
		}

		backgroundSync() {
			if (!navigator.onLine || !this.isReady()) return;
			// debounced to handle multiple saves in quick succession
			clearTimeout(this.syncTimer);
			this.syncTimer = setTimeout(() => {
				this.syncTimer = null;
				this.sync(false);
			}, 1000);
		}
	}

	exports.adaptorClass = PWAStorage;
})();
