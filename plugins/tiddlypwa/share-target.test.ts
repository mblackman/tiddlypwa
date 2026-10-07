import { assertEquals } from 'https://deno.land/std@0.192.0/testing/asserts.ts';

const shareTargetSource = Deno.readTextFileSync('./plugins/tiddlypwa/share-target.js');

Deno.test('share-target creates a tiddler and navigates when query params are present', () => {
    // Mock $tw environment
    const tiddlers: any[] = [];
    const navigated: any[] = [];
    const _tw = {
        wiki: {
            addTiddler: (t: any) => tiddlers.push(t)
        },
        Tiddler: class { constructor(fields: any) { Object.assign(this, fields); } },
        Story: class {
            constructor() {}
            navigateTiddler(t: any) { navigated.push(t); }
        },
        utils: {
            formatDateString: class { constructor() { return "DATE"; } }
        }
    };
    
    // Mock window environment
    const _window: any = {
        location: {
            search: '?share-target=1&title=Hello&text=World&url=https://example.com',
            pathname: '/app.html',
            hash: '#hash',
            replaced: ''
        },
        history: {
            replaceState: (state: any, title: any, url: any) => {
                _window.location.replaced = url;
            }
        }
    };

    const moduleFn = new Function('$tw', 'window', 'document', 'exports', shareTargetSource.replace('(function () {', '').replace('})();', ''));
    const exports: any = {};
    moduleFn(_tw, _window, { title: 'Test Doc' }, exports);
    
    exports.startup();

    assertEquals(tiddlers.length, 1);
    assertEquals(tiddlers[0].title, 'Shared Note: Hello');
    assertEquals(tiddlers[0].text, 'World\n\nhttps://example.com');
    assertEquals(tiddlers[0].tags, ['Shared', 'Inbox']);

    assertEquals(navigated.length, 1);
    assertEquals(navigated[0], 'Shared Note: Hello');

    assertEquals(_window.location.replaced, '/app.html#hash');
});

Deno.test('share-target does nothing if share-target=1 is missing', () => {
    const tiddlers: any[] = [];
    const _tw = { wiki: { addTiddler: (t: any) => tiddlers.push(t) } };
    const _window: any = { location: { search: '?title=Hello' } };
    
    const moduleFn = new Function('$tw', 'window', 'document', 'exports', shareTargetSource.replace('(function () {', '').replace('})();', ''));
    const exports: any = {};
    moduleFn(_tw, _window, {}, exports);
    
    exports.startup();
    
    assertEquals(tiddlers.length, 0);
});
