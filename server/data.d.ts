export type Wiki = {
	token: string;
	authcode?: string;
	salt?: string;
	note?: string;
	watcher_pubkey?: string;
	tombstone_horizon?: number;
	last_mtime?: number;
};

export type WikiSummary = {
	token: string;
	hasAuthcode: boolean;
	salt?: string;
	note?: string;
	watcher_pubkey?: string;
	tidsize: number;
	appsize: number;
};

export type File = {
	etag: Uint8Array;
	rawsize: number;
	ctype: string;
	body: Uint8Array;
};

export type Tiddler = {
	thash: Uint8Array;
	iv?: Uint8Array;
	ct?: Uint8Array;
	sbiv?: Uint8Array;
	sbct?: Uint8Array;
	mtime: Date;
	deleted: boolean;
	baseMtime?: Date | null;
};

export type PushSubscriptionRow = {
	token: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	ua_hint?: string | null;
	created_at: number;
};

export type WatcherModuleRow = {
	token: string;
	watcher_id: string;
	code_hash: string;
	code_source: string;
	allowed_hosts: string;
	schedule_cron: string;
	timezone: string;
	watched_items: string;
	signature: string;
	state_json: string;
	last_run_at: number;
	last_error?: string | null;
};

export type PendingWatcherPatchRow = {
	patch_id: string;
	token: string;
	watcher_id: string;
	patch_json: string;
	created_at: number;
};

export type ScheduledNotificationRow = {
	token: string;
	schedule_id: string;
	trigger_at: number;
	payload_json: string;
	target_endpoint?: string | null;
	created_at: number;
};

export interface Datastore {
	transaction(f: () => void): void;
	getServerConfig(key: string): string | undefined;
	setServerConfig(key: string, value: string): void;
	getWiki(token: string): Wiki | undefined;
	getWikiByPrefix(halftoken: string): Wiki | undefined;
	listWikis(): Array<WikiSummary>;
	createWiki(token: string, note?: string): void;
	updateWikiAuthcode(token: string, authcode?: string | null): void;
	updateWikiSalt(token: string, salt: string): void;
	updateWikiWatcherPubKey(token: string, pubkey?: string | null): void;
	bindWikiAuthcodeIfUnset(token: string, authcode: string): boolean;
	bindWikiSaltIfUnset(token: string, salt: string): boolean;
	bindWikiWatcherPubKeyIfUnset(token: string, pubkey: string): boolean;
	clearWikiAuth(token: string): void;
	deleteWiki(token: string): void;
	fileExists(etag: Uint8Array): boolean;
	storeFile(file: File): void;
	associateFile(token: string, etag: Uint8Array, name: string): void;
	dissociateFiles(token: string): void;
	dissociateAllFiles(): void;
	getWikiFile(halftoken: string, name: string): File | undefined;
	getExactWikiFile(token: string, name: string): File | undefined;
	getTiddler(token: string, thash: Uint8Array): Tiddler | undefined;
	getNextMtime(token: string): number;
	maxMtime(token: string): number;
	tiddlersChangedSince(token: string, since: Date): Generator<Tiddler>;
	tiddlersChangedPage(
		token: string,
		afterMtimeMs: number,
		afterThash: Uint8Array | null,
		upperBoundMs: number,
		limit: number,
	): Tiddler[];
	healthCheck(): boolean;
	checkpointAndClose(): void;
	upsertTiddler(token: string, tiddler: Tiddler, writeMtimeMs?: number): { success: boolean; conflict?: boolean };
	getTombstoneHorizon(): number;
	getWikiTombstoneHorizon(token: string): number;
	pruneTombstones(cutoffMs: number): number;
	upsertPushSubscription(sub: PushSubscriptionRow): void;
	enforcePushSubscriptionCap(token: string, maxSubs?: number): void;
	deletePushSubscription(token: string, endpoint: string): void;
	deleteAllPushSubscriptions(token: string): void;
	listPushSubscriptions(token: string): Array<PushSubscriptionRow>;
	upsertWatcherModule(watcher: Omit<WatcherModuleRow, 'state_json' | 'last_run_at' | 'last_error'>): void;
	deleteWatcherModule(token: string, watcherId: string): void;
	getWatcherModule(token: string, watcherId: string): WatcherModuleRow | undefined;
	listWatcherModules(token: string): Array<WatcherModuleRow>;
	getAllWatcherModules(): Array<WatcherModuleRow>;
	updateWatcherRunState(
		token: string,
		watcherId: string,
		stateJson: string,
		lastRunAt: number,
		lastError?: string | null,
	): void;
	upsertPendingPatch(patch: PendingWatcherPatchRow): void;
	listPendingPatches(token: string): Array<PendingWatcherPatchRow>;
	deletePendingPatches(token: string, patchIds: string[]): void;
	upsertScheduledNotification(row: ScheduledNotificationRow): void;
	deleteScheduledNotifications(token: string, scheduleIds: string[]): void;
	deleteScheduledNotificationIfUnchanged(token: string, scheduleId: string, createdAt: number): boolean;
	runMaintenance(nowMs: number): { prunedPatches: number; prunedFiles: number };
	listDueScheduledNotifications(nowMs: number): Array<ScheduledNotificationRow>;
	listScheduledNotifications(token: string): Array<ScheduledNotificationRow>;
}
