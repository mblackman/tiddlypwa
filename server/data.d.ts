export type Wiki = {
	token: string;
	authcode?: string;
	salt?: string;
	note?: string;
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
	baseMtime?: Date;
};

export interface Datastore {
	transaction(f: () => void): void;
	getWiki(token: string): Wiki | undefined;
	getWikiByPrefix(halftoken: string): Wiki | undefined;
	listWikis(): Array<Wiki>;
	createWiki(token: string, note?: string): void;
	updateWikiAuthcode(token: string, authcode?: string): void;
	updateWikiSalt(token: string, salt: string): void;
	deleteWiki(token: string): void;
	fileExists(etag: Uint8Array): boolean;
	storeFile(file: File): void;
	associateFile(token: string, etag: Uint8Array, name: string): void;
	getWikiFile(halftoken: string, name: string): File | undefined;
	getTiddler(token: string, thash: Uint8Array): Tiddler | undefined;
	tiddlersChangedSince(token: string, since: Date): Generator<Tiddler>;
	upsertTiddler(token: string, tiddler: Tiddler): { success: boolean; conflict?: boolean };
}
