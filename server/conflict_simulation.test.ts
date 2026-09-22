// deno-lint-ignore-file no-explicit-any
import { assertEquals, assertNotEquals } from '@std/assert';
import { decodeBase64, encodeBase64 } from '@std/encoding/base64';
import { SQLiteDatastore } from './sqlite.ts';
import { TiddlyPWASyncApp } from './app.ts';

const utfenc = new TextEncoder();
const utfdec = new TextDecoder();

// Helper to derive simulated client crypto keys
async function createClientCrypto() {
	const rawKey = new Uint8Array(32);
	rawKey.fill(42);
	const encKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
	const hmacKey = await crypto.subtle.importKey(
		'raw',
		rawKey,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	);

	const titleHash = async (title: string): Promise<Uint8Array> => {
		const sig = await crypto.subtle.sign('HMAC', hmacKey, utfenc.encode(title));
		return new Uint8Array(sig);
	};

	const encrypt = async (data: Record<string, unknown>): Promise<{ iv: Uint8Array; ct: Uint8Array }> => {
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const json = JSON.stringify(data);
		const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as any }, encKey, utfenc.encode(json));
		return { iv, ct: new Uint8Array(ct) };
	};

	const decrypt = async (iv: Uint8Array, ct: Uint8Array): Promise<Record<string, unknown> | null> => {
		try {
			const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as any }, encKey, ct as any);
			return JSON.parse(utfdec.decode(dec));
		} catch {
			return null;
		}
	};

	return { titleHash, encrypt, decrypt };
}

let lastMonotonicTime = Date.now();
function getMonotonicTime(): Date {
	let now = Date.now();
	if (now <= lastMonotonicTime) {
		now = lastMonotonicTime + 50;
	}
	lastMonotonicTime = now;
	return new Date(now);
}

// Simulated Client Device (modeling IndexedDB + PWAStorage sync logic)
class SimulatedDevice {
	name: string;
	crypto: any;
	localDb: Map<string, any> = new Map(); // thashB64 -> local record
	lastSync: Date = new Date(0);
	conflictTiddlers: any[] = [];
	activeDrafts: Map<string, string> = new Map(); // originalTitle -> draftText

	constructor(name: string, clientCrypto: any) {
		this.name = name;
		this.crypto = clientCrypto;
	}

	openDraft(originalTitle: string, draftText: string) {
		this.activeDrafts.set(originalTitle, draftText);
	}

	discardDraft(originalTitle: string) {
		this.activeDrafts.delete(originalTitle);
	}

	isDraft(title: string, fields?: any): boolean {
		if (fields?.['draft.of']) return true;
		if (typeof title === 'string' && title.startsWith("Draft of '")) return true;
		return false;
	}

	async saveTiddler(title: string, text: string, fields?: any) {
		if (this.isDraft(title, fields)) {
			return;
		}
		const thash = await this.crypto.titleHash(title);
		const thashB64 = encodeBase64(thash);
		const existing = this.localDb.get(thashB64);
		const baseMtime = existing ? (existing.baseMtime || existing.mtime) : null;
		const { iv, ct } = await this.crypto.encrypt({ title, text });

		const record = {
			title,
			text,
			thash,
			thashB64,
			iv,
			ct,
			mtime: getMonotonicTime(),
			baseMtime,
			deleted: false,
		};
		this.localDb.set(thashB64, record);
	}

	async deleteTiddler(title: string) {
		if (this.isDraft(title)) {
			return;
		}
		const thash = await this.crypto.titleHash(title);
		const thashB64 = encodeBase64(thash);
		const existing = this.localDb.get(thashB64);
		const baseMtime = existing ? (existing.baseMtime || existing.mtime) : null;

		const record = {
			title,
			thash,
			thashB64,
			iv: null,
			ct: null,
			mtime: getMonotonicTime(),
			baseMtime,
			deleted: true,
		};
		this.localDb.set(thashB64, record);
	}

	async sync(app: TiddlyPWASyncApp, token: string) {
		const clientChanges: any[] = [];
		const localChangesByHash = new Map<string, any>();
		let newestChg = this.lastSync;

		for (const [thashB64, tid] of this.localDb) {
			if (tid.mtime > this.lastSync) {
				if (tid.mtime > newestChg) {
					newestChg = tid.mtime;
				}
				const change = {
					thash: thashB64,
					iv: tid.iv ? encodeBase64(tid.iv) : null,
					ct: tid.ct ? encodeBase64(tid.ct) : null,
					mtime: tid.mtime.toISOString(),
					baseMtime: tid.baseMtime ? tid.baseMtime.toISOString() : undefined,
					deleted: tid.deleted,
				};
				clientChanges.push(change);
				localChangesByHash.set(thashB64, tid);
			}
		}

		const authcode = encodeBase64(await this.crypto.titleHash(token));
		const req = new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({
				tiddlypwa: 1,
				op: 'sync',
				token,
				authcode,
				now: new Date().toISOString(),
				lastSync: this.lastSync.toISOString(),
				clientChanges,
			}),
		});

		const resp = await app.handle(req);
		const serverTimeHdr = resp.headers.get('x-server-time');
		const data = await resp.json();
		const serverChanges = data.serverChanges || [];
		const conflictSet = new Set<string>(data.conflicts || []);

		for (const serverTid of serverChanges) {
			const thashB64 = serverTid.thash;
			const remoteMtime = new Date(serverTid.mtime);
			const ourtid = localChangesByHash.get(thashB64);
			const isServerConflict = conflictSet.has(thashB64);

			if (ourtid || isServerConflict) {
				const ourDecrypted = ourtid && ourtid.ct ? await this.crypto.decrypt(ourtid.iv, ourtid.ct) : null;
				const remoteDecrypted = serverTid.ct
					? await this.crypto.decrypt(decodeBase64(serverTid.iv), decodeBase64(serverTid.ct))
					: null;

				// Check payload equality
				const isEqual = ourDecrypted && remoteDecrypted && ourDecrypted.text === remoteDecrypted.text;

				if (isEqual) {
					// False conflict suppressed
					this.localDb.set(thashB64, {
						title: remoteDecrypted.title,
						text: remoteDecrypted.text,
						thash: decodeBase64(thashB64),
						thashB64,
						iv: decodeBase64(serverTid.iv),
						ct: decodeBase64(serverTid.ct),
						mtime: remoteMtime,
						baseMtime: remoteMtime,
						deleted: serverTid.deleted,
					});
				} else {
					// Concurrency conflict! Server canonical is applied, local edit preserved as conflict tiddler
					if (ourDecrypted) {
						const conflictTitle = `${ourDecrypted.title} (Conflict ${ourMtime(ourtid.mtime)})`;
						await this.saveTiddler(conflictTitle, ourDecrypted.text);
						this.conflictTiddlers.push({ title: conflictTitle, of: ourDecrypted.title, text: ourDecrypted.text });
					}
					if (remoteDecrypted) {
						this.localDb.set(thashB64, {
							title: remoteDecrypted.title,
							text: remoteDecrypted.text,
							thash: decodeBase64(thashB64),
							thashB64,
							iv: decodeBase64(serverTid.iv),
							ct: decodeBase64(serverTid.ct),
							mtime: remoteMtime,
							baseMtime: remoteMtime,
							deleted: serverTid.deleted,
						});
					}
				}
			} else {
				// Normal clean incoming update from server
				if (serverTid.deleted) {
					this.localDb.delete(thashB64);
				} else {
					const remoteDecrypted = await this.crypto.decrypt(decodeBase64(serverTid.iv), decodeBase64(serverTid.ct));
					const title = remoteDecrypted ? remoteDecrypted.title : 'Untitled';
					const text = remoteDecrypted ? remoteDecrypted.text : '';

					if (this.activeDrafts.has(title)) {
						const draftText = this.activeDrafts.get(title) || '';
						if (draftText !== text) {
							const conflictTitle = `${title} (Conflict ${ourMtime(remoteMtime)})`;
							await this.saveTiddler(conflictTitle, text);
							this.conflictTiddlers.push({
								title: conflictTitle,
								of: title,
								source: 'remote',
								text,
								tags: ['$:/tags/TiddlyPWA/Conflict'],
							});
						}
					}

					this.localDb.set(thashB64, {
						title,
						text,
						thash: decodeBase64(thashB64),
						thashB64,
						iv: decodeBase64(serverTid.iv),
						ct: decodeBase64(serverTid.ct),
						mtime: remoteMtime,
						baseMtime: remoteMtime,
						deleted: false,
					});
				}
			}

			if (remoteMtime > newestChg) newestChg = remoteMtime;
		}

		// Update baseMtime on non-conflicted local changes
		for (const [thashB64, tid] of localChangesByHash) {
			if (!conflictSet.has(thashB64)) {
				tid.baseMtime = tid.mtime;
			}
		}

		if (serverTimeHdr) {
			const sDate = new Date(serverTimeHdr);
			if (sDate > newestChg) newestChg = sDate;
		}
		this.lastSync = newestChg;

		return {
			serverChanges,
			conflicts: data.conflicts || [],
			clientChangesSent: clientChanges.length,
			serverChangesReceived: serverChanges.length,
		};
	}
}

function ourMtime(d: Date) {
	return d.toISOString().replace(/[:.]/g, '-');
}

// ---------------------------------------------------------------------------
// TEST SUITE: MULTI-DEVICE CONFLICT SIMULATION
// ---------------------------------------------------------------------------

Deno.test('Multi-Device: Concurrent Divergent Writes trigger OCC conflict and preserve both versions', async () => {
	const db = new SQLiteDatastore();
	const app = new TiddlyPWASyncApp(
		db,
		'q6kQ8SNKeaVVQDbhb7TgyqdTp8KAO31rU-6AGT1xG0o',
		'ZnPOVo2E_oWm71aQ-eOX9U3-gIE2hR6nfksboNcLNPQ',
	);
	const crypto = await createClientCrypto();

	// 1. Setup wiki
	const tok = 'test-token-sim-1';
	db.createWiki(tok, 'Simulation Test Wiki');

	const alice = new SimulatedDevice('Alice (Laptop)', crypto);
	const bob = new SimulatedDevice('Bob (Phone)', crypto);

	// 2. Initial state: Alice creates "MeetingNotes" = "Version 0: Agenda"
	await alice.saveTiddler('MeetingNotes', 'Version 0: Agenda');
	await alice.sync(app, tok);

	// Bob syncs to catch up to V0
	await bob.sync(app, tok);
	const bobMeetingNotesV0 = [...bob.localDb.values()].find((t) => t.title === 'MeetingNotes');
	assertEquals(bobMeetingNotesV0.text, 'Version 0: Agenda');

	// 3. Concurrent edits:
	// Alice edits to "Alice: Discussion on Architecture"
	await alice.saveTiddler('MeetingNotes', 'Alice: Discussion on Architecture');

	// Bob edits to "Bob: Budget Allocations" (offline / before syncing)
	await bob.saveTiddler('MeetingNotes', 'Bob: Budget Allocations');

	// 4. Alice syncs first
	const aliceSync1 = await alice.sync(app, tok);
	assertEquals(aliceSync1.conflicts.length, 0);

	// 5. Bob syncs second -> SERVER OCC DETECTS CONFLICT!
	const bobSync1 = await bob.sync(app, tok);
	assertEquals(bobSync1.conflicts.length, 1); // Server rejected Bob's canonical overwrite!

	// 6. Verify Bob's conflict handling:
	// - Canonical 'MeetingNotes' on Bob is now Alice's version
	const bobMeetingNotesCanonical = [...bob.localDb.values()].find((t) => t.title === 'MeetingNotes');
	assertEquals(bobMeetingNotesCanonical.text, 'Alice: Discussion on Architecture');

	// - Bob created a conflict copy preserving his edit
	assertEquals(bob.conflictTiddlers.length, 1);
	assertEquals(bob.conflictTiddlers[0].of, 'MeetingNotes');
	assertEquals(bob.conflictTiddlers[0].text, 'Bob: Budget Allocations');

	// 7. Bob syncs the newly generated conflict copy to the server
	const bobSync2 = await bob.sync(app, tok);
	assertEquals(bobSync2.conflicts.length, 0);

	// 8. Alice syncs and receives Bob's conflict copy
	await alice.sync(app, tok);

	// 9. FINAL VERIFICATION:
	// Both devices have identical data:
	// Canonical: 'MeetingNotes' with Alice's text
	// Conflict copy: 'MeetingNotes (Conflict ...)' with Bob's text
	const aliceCanonical = [...alice.localDb.values()].find((t) => t.title === 'MeetingNotes');
	const bobCanonical = [...bob.localDb.values()].find((t) => t.title === 'MeetingNotes');
	assertEquals(aliceCanonical.text, 'Alice: Discussion on Architecture');
	assertEquals(bobCanonical.text, 'Alice: Discussion on Architecture');

	const aliceConflicts = [...alice.localDb.values()].filter((t) => t.title.startsWith('MeetingNotes (Conflict'));
	const bobConflicts = [...bob.localDb.values()].filter((t) => t.title.startsWith('MeetingNotes (Conflict'));
	assertEquals(aliceConflicts.length, 1);
	assertEquals(bobConflicts.length, 1);
	assertEquals(aliceConflicts[0].text, 'Bob: Budget Allocations');
	assertEquals(bobConflicts[0].text, 'Bob: Budget Allocations');

	// ZERO DATA LOSS!
	db.deleteWiki(tok);
});

Deno.test('Multi-Device: False Conflict Suppression when edits have identical text', async () => {
	const db = new SQLiteDatastore();
	const app = new TiddlyPWASyncApp(
		db,
		'q6kQ8SNKeaVVQDbhb7TgyqdTp8KAO31rU-6AGT1xG0o',
		'ZnPOVo2E_oWm71aQ-eOX9U3-gIE2hR6nfksboNcLNPQ',
	);
	const crypto = await createClientCrypto();

	const tok = 'test-token-sim-2';
	db.createWiki(tok);

	const alice = new SimulatedDevice('Alice', crypto);
	const bob = new SimulatedDevice('Bob', crypto);

	// Initial tiddler
	await alice.saveTiddler('SharedDoc', 'Initial text');
	await alice.sync(app, tok);
	await bob.sync(app, tok);

	// Both save identical text concurrently
	await alice.saveTiddler('SharedDoc', 'Updated identically');
	await bob.saveTiddler('SharedDoc', 'Updated identically');

	await alice.sync(app, tok);
	await bob.sync(app, tok);

	// Verify false conflict was suppressed: no conflict copies generated on Bob
	assertEquals(bob.conflictTiddlers.length, 0);
	const bobDoc = [...bob.localDb.values()].find((t) => t.title === 'SharedDoc');
	assertEquals(bobDoc.text, 'Updated identically');

	db.deleteWiki(tok);
});

Deno.test('Multi-Device: Concurrent Edit vs Delete rejects delete and preserves edit', async () => {
	const db = new SQLiteDatastore();
	const app = new TiddlyPWASyncApp(
		db,
		'q6kQ8SNKeaVVQDbhb7TgyqdTp8KAO31rU-6AGT1xG0o',
		'ZnPOVo2E_oWm71aQ-eOX9U3-gIE2hR6nfksboNcLNPQ',
	);
	const crypto = await createClientCrypto();

	const tok = 'test-token-sim-3';
	db.createWiki(tok);

	const alice = new SimulatedDevice('Alice', crypto);
	const bob = new SimulatedDevice('Bob', crypto);

	await alice.saveTiddler('ProjectX', 'Project Details V1');
	await alice.sync(app, tok);
	await bob.sync(app, tok);

	// Alice edits to V2
	await alice.saveTiddler('ProjectX', 'Project Details V2 with Important Data');
	await alice.sync(app, tok);

	// Bob deleted ProjectX based on V1
	await bob.deleteTiddler('ProjectX');
	const bobSync = await bob.sync(app, tok);

	// Server rejects Bob's delete because baseMtime was V1 and server is at V2!
	assertEquals(bobSync.conflicts.length, 1);

	// Bob's local state adopts Alice's canonical version
	const bobProject = [...bob.localDb.values()].find((t) => t.title === 'ProjectX');
	assertEquals(bobProject.text, 'Project Details V2 with Important Data');

	db.deleteWiki(tok);
});

Deno.test('Multi-Device: Sequential non-conflicting edits succeed cleanly', async () => {
	const db = new SQLiteDatastore();
	const app = new TiddlyPWASyncApp(
		db,
		'q6kQ8SNKeaVVQDbhb7TgyqdTp8KAO31rU-6AGT1xG0o',
		'ZnPOVo2E_oWm71aQ-eOX9U3-gIE2hR6nfksboNcLNPQ',
	);
	const crypto = await createClientCrypto();

	const tok = 'test-token-sim-4';
	db.createWiki(tok);

	const alice = new SimulatedDevice('Alice', crypto);
	const bob = new SimulatedDevice('Bob', crypto);

	// 1. Alice creates and syncs
	await alice.saveTiddler('SharedDoc', 'Alice version 1');
	const aSync1 = await alice.sync(app, tok);
	assertEquals(aSync1.conflicts.length, 0);

	// 2. Bob syncs and pulls Alice's edit
	const bSync1 = await bob.sync(app, tok);
	assertEquals(bSync1.conflicts.length, 0);

	// 3. Bob edits on top of Alice's edit
	await bob.saveTiddler('SharedDoc', 'Bob version 2 (based on Alice v1)');
	const bSync2 = await bob.sync(app, tok);
	assertEquals(bSync2.conflicts.length, 0);

	// 4. Alice syncs and receives Bob's version cleanly
	const aSync2 = await alice.sync(app, tok);
	assertEquals(aSync2.conflicts.length, 0);

	const aliceDoc = [...alice.localDb.values()].find((t) => t.title === 'SharedDoc');
	const bobDoc = [...bob.localDb.values()].find((t) => t.title === 'SharedDoc');
	assertEquals(aliceDoc.text, 'Bob version 2 (based on Alice v1)');
	assertEquals(bobDoc.text, 'Bob version 2 (based on Alice v1)');
	assertEquals(alice.conflictTiddlers.length, 0);
	assertEquals(bob.conflictTiddlers.length, 0);

	db.deleteWiki(tok);
});

Deno.test('Draft isolation: In-flight drafts are never synced across devices', async () => {
	const db = new SQLiteDatastore();
	const app = new TiddlyPWASyncApp(
		db,
		'q6kQ8SNKeaVVQDbhb7TgyqdTp8KAO31rU-6AGT1xG0o',
		'ZnPOVo2E_oWm71aQ-eOX9U3-gIE2hR6nfksboNcLNPQ',
	);
	const crypto = await createClientCrypto();

	const tok = 'test-token-sim-drafts';
	db.createWiki(tok);

	const alice = new SimulatedDevice('Alice', crypto);
	const bob = new SimulatedDevice('Bob', crypto);

	// 1. Alice is actively typing in a draft editor.
	// TiddlyWiki triggers saveTiddler on the draft.
	await alice.saveTiddler("Draft of 'New Note'", 'Partial typed text...', { 'draft.of': 'New Note' });

	// Alice syncs to the server while the draft is active.
	const aSyncDraft = await alice.sync(app, tok);
	assertEquals(aSyncDraft.clientChangesSent, 0); // No client changes should be queued for drafts

	// Verify server has no tiddler records stored
	const serverTiddlersBefore = [...db.tiddlersChangedSince(tok, new Date(0))];
	assertEquals(serverTiddlersBefore.length, 0);

	// 2. Bob syncs and should receive NOTHING (no drafts)
	const bSync1 = await bob.sync(app, tok);
	assertEquals(bSync1.serverChangesReceived, 0);
	assertEquals(bob.localDb.size, 0);

	// 3. Alice finishes typing and saves the canonical tiddler.
	// TiddlyWiki deletes the draft and saves the real tiddler.
	await alice.deleteTiddler("Draft of 'New Note'");
	await alice.saveTiddler('New Note', 'Complete finished content');

	const aSyncFinal = await alice.sync(app, tok);
	assertEquals(aSyncFinal.clientChangesSent, 1); // Only 'New Note', not the draft deletion

	// 4. Bob syncs and receives the canonical tiddler cleanly
	const bSync2 = await bob.sync(app, tok);
	assertEquals(bSync2.serverChangesReceived, 1);

	const bobNote = [...bob.localDb.values()].find((t) => t.title === 'New Note');
	assertNotEquals(bobNote, undefined);
	assertEquals(bobNote.text, 'Complete finished content');
	assertEquals(bobNote.deleted, false);

	// Ensure no draft tiddlers exist on either device or the server
	const aliceDraft = [...alice.localDb.values()].find((t) => t.title.startsWith("Draft of '"));
	const bobDraft = [...bob.localDb.values()].find((t) => t.title.startsWith("Draft of '"));
	assertEquals(aliceDraft, undefined);
	assertEquals(bobDraft, undefined);

	db.deleteWiki(tok);
});

Deno.test('Draft collision: Remote update preserves conflict copy when local draft is open', async () => {
	const db = new SQLiteDatastore();
	const app = new TiddlyPWASyncApp(
		db,
		'q6kQ8SNKeaVVQDbhb7TgyqdTp8KAO31rU-6AGT1xG0o',
		'ZnPOVo2E_oWm71aQ-eOX9U3-gIE2hR6nfksboNcLNPQ',
	);
	const crypto = await createClientCrypto();

	const tok = 'test-token-sim-draft-collision';
	db.createWiki(tok);

	const alice = new SimulatedDevice('Alice', crypto);
	const bob = new SimulatedDevice('Bob', crypto);

	// 1. Initial shared state
	await alice.saveTiddler('MeetingNotes', 'Version 1 initial notes');
	await alice.sync(app, tok);
	await bob.sync(app, tok);

	// 2. Alice opens an in-memory draft to edit MeetingNotes
	alice.openDraft('MeetingNotes', 'Alice unfinished draft changes...');

	// 3. Bob concurrently updates MeetingNotes and syncs to server
	await bob.saveTiddler('MeetingNotes', 'Bob completed version 2 notes');
	await bob.sync(app, tok);

	// 4. Alice syncs while her draft is still open
	await alice.sync(app, tok);

	// Alice must now have:
	// - Her active draft preserved
	assertEquals(alice.activeDrafts.get('MeetingNotes'), 'Alice unfinished draft changes...');
	// - A preserved conflict copy containing Bob's remote update
	assertEquals(alice.conflictTiddlers.length, 1);
	const conflict = alice.conflictTiddlers[0];
	assertEquals(conflict.of, 'MeetingNotes');
	assertEquals(conflict.source, 'remote');
	assertEquals(conflict.text, 'Bob completed version 2 notes');
	assertEquals(conflict.tags, ['$:/tags/TiddlyPWA/Conflict']);

	// 5. Alice resolves the conflict by keeping her draft and discarding the conflict
	alice.conflictTiddlers = []; // Discard conflict copy
	await alice.saveTiddler('MeetingNotes', 'Alice finished version');
	alice.discardDraft('MeetingNotes');
	await alice.sync(app, tok);

	// Bob syncs and receives Alice's final resolution
	await bob.sync(app, tok);
	const bobFinal = [...bob.localDb.values()].find((t) => t.title === 'MeetingNotes');
	assertEquals(bobFinal.text, 'Alice finished version');

	db.deleteWiki(tok);
});
