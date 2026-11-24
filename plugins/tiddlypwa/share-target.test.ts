import { assert, assertEquals } from '@std/assert';

const shareTargetSource = Deno.readTextFileSync('./plugins/tiddlypwa/share-target.js');

Deno.test('share-target runs after story and creates/deduplicates tiddlers cleanly', () => {
	const existingTitles = new Set<string>(['Shared Note: Hello']);
	const tiddlers: any[] = [];
	const navigated: any[] = [];
	const _tw = {
		wiki: {
			addTiddler: (t: any) => {
				tiddlers.push(t);
				existingTitles.add(t.title);
			},
			generateNewTitle: (baseTitle: string) => {
				if (!existingTitles.has(baseTitle)) return baseTitle;
				let i = 1;
				while (existingTitles.has(`${baseTitle} ${i}`)) i++;
				return `${baseTitle} ${i}`;
			},
		},
		Tiddler: class {
			constructor(fields: any) {
				Object.assign(this, fields);
			}
		},
		Story: class {
			constructor() {}
			navigateTiddler(t: any) {
				navigated.push(t);
			}
		},
		utils: {
			formatDateString: (_d: Date, _fmt: string) => '2026-11-23 12:00:00',
		},
	};

	const _window: any = {
		location: {
			search: '?share-target=1&title=Hello&text=World&url=https://example.com',
			pathname: '/app.html',
			hash: '#hash',
			replaced: '',
		},
		history: {
			replaceState: (_state: any, _title: any, url: any) => {
				_window.location.replaced = url;
			},
		},
	};

	const moduleFn = new Function(
		'$tw',
		'window',
		'document',
		'exports',
		shareTargetSource.replace('(function () {', '').replace('})();', ''),
	);
	const exports: any = {};
	moduleFn(_tw, _window, { title: 'Test Doc' }, exports);

	assert(Array.isArray(exports.after) && exports.after.includes('story'));

	// Duplicate title should deduplicate via generateNewTitle
	exports.startup();
	assertEquals(tiddlers.length, 1);
	assertEquals(tiddlers[0].title, 'Shared Note: Hello 1');
	assertEquals(tiddlers[0].text, 'World\n\nhttps://example.com');
	assertEquals(tiddlers[0].tags, ['Shared', 'Inbox']);
	assertEquals(navigated[0], 'Shared Note: Hello 1');
	assertEquals(_window.location.replaced, '/app.html#hash');

	// Titleless share should call formatDateString as a function (never return [object Object])
	_window.location.search = '?share-target=1&text=QuickNote';
	exports.startup();
	assertEquals(tiddlers.length, 2);
	assertEquals(tiddlers[1].title, 'Shared Note: 2026-11-23 12:00:00');
	assertEquals(tiddlers[1].title.includes('[object Object]'), false);
});

Deno.test('share-target does nothing if share-target=1 is missing', () => {
	const tiddlers: any[] = [];
	const _tw = { wiki: { addTiddler: (t: any) => tiddlers.push(t) } };
	const _window: any = { location: { search: '?title=Hello' } };

	const moduleFn = new Function(
		'$tw',
		'window',
		'document',
		'exports',
		shareTargetSource.replace('(function () {', '').replace('})();', ''),
	);
	const exports: any = {};
	moduleFn(_tw, _window, {}, exports);

	exports.startup();

	assertEquals(tiddlers.length, 0);
});
