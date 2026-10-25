import { assertEquals } from '@std/assert';
import * as path from 'node:path';
import * as fs from 'node:fs';

function findTiddlyWikiBoot(): string {
	const homedir = Deno.env.get('HOME') || '';
	const candidates: string[] = [
		path.join(Deno.cwd(), 'node_modules/tiddlywiki/boot/boot.js'),
	];
	const npxDir = path.join(homedir, '.npm/_npx');
	if (fs.existsSync(npxDir)) {
		for (const entry of fs.readdirSync(npxDir)) {
			candidates.push(path.join(npxDir, entry, 'node_modules/tiddlywiki/boot/boot.js'));
		}
	}
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}
	throw new Error('Could not find tiddlywiki boot.js. Ensure tiddlywiki is installed or cached via npx.');
}

function setupTiddlyWiki(require: (id: string) => any) {
	Deno.env.set('TIDDLYWIKI_PLUGIN_PATH', 'plugins');
	Deno.env.set('TIDDLYWIKI_THEME_PATH', 'themes');
	const bootPath = findTiddlyWikiBoot();
	const $tw = require(bootPath).TiddlyWiki();
	$tw.boot.argv = ['.'];
	$tw.boot.boot();

	if ($tw.modules?.titles?.['$:/core/modules/upgraders/plugins.js']) {
		const pluginUpgrader = $tw.modules.execute('$:/core/modules/upgraders/plugins.js');
		const origUpgrade = pluginUpgrader.upgrade;
		if (typeof origUpgrade === 'function') {
			pluginUpgrader.upgrade = function (wiki: any, titles: string[], tiddlers: Record<string, any>) {
				const origCheckVersions = $tw.utils.checkVersions;
				$tw.utils.checkVersions = (vA: string, vB: string) => $tw.utils.compareVersions(vA, vB) === 1;
				try {
					return origUpgrade.call(this, wiki, titles, tiddlers);
				} finally {
					$tw.utils.checkVersions = origCheckVersions;
				}
			};
		}
	}

	const origDoesPluginRequireReload = $tw.wiki.doesPluginRequireReload;
	$tw.wiki.doesPluginRequireReload = function (title: string) {
		if (title === '$:/temp/info-plugin' || (typeof title === 'string' && title.startsWith('$:/temp/'))) {
			return false;
		}
		const tiddler = this.getTiddler(title);
		if (tiddler && tiddler.fields.type === 'application/json' && tiddler.fields['plugin-type']) {
			if (tiddler.fields['plugin-type'] === 'import' || tiddler.fields['plugin-type'] === 'info') {
				return false;
			}
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

	$tw.wiki.doesPluginInfoRequireReload = (x: Record<string, unknown> | null) => {
		if (!x || typeof x !== 'object' || !('tiddlers' in x)) return false;
		if (x['plugin-type'] === 'import' || x['plugin-type'] === 'info') return false;
		return true;
	};

	return $tw;
}

Deno.test('Plugin Reload Detection: $:/temp/info-plugin updates do NOT trigger reload warning', async () => {
	const { createRequire } = await import('node:module');
	const require = createRequire(import.meta.url);
	const $tw = setupTiddlyWiki(require);

	// Reset status tiddler to "no" as core startup does
	$tw.wiki.addTiddler({ title: '$:/status/RequireReloadDueToPluginChange', text: 'no' });
	assertEquals($tw.wiki.getTiddlerText('$:/status/RequireReloadDueToPluginChange'), 'no');

	// 1. Simulate dimensions.js / mediaquerytracker.js updating $:/temp/info-plugin
	$tw.wiki.addTiddler(
		new $tw.Tiddler({
			title: '$:/temp/info-plugin',
			type: 'application/json',
			'plugin-type': 'info',
			text: JSON.stringify({ tiddlers: { '$:/info/browser/window/width': { text: '1920' } } }),
		}),
	);

	await new Promise((r) => setTimeout(r, 60));
	assertEquals($tw.wiki.doesPluginRequireReload('$:/temp/info-plugin'), false);
	assertEquals($tw.wiki.getTiddlerText('$:/status/RequireReloadDueToPluginChange'), 'no');

	// 2. Normal content tiddlers do not trigger reload
	$tw.wiki.addTiddler(new $tw.Tiddler({ title: 'MyNote', text: 'Hello World' }));
	await new Promise((r) => setTimeout(r, 60));
	assertEquals($tw.wiki.doesPluginRequireReload('MyNote'), false);
	assertEquals($tw.wiki.getTiddlerText('$:/status/RequireReloadDueToPluginChange'), 'no');

	// 3. Import payloads (plugin-type: import) do not trigger reload
	$tw.wiki.addTiddler(
		new $tw.Tiddler({
			title: '$:/Import',
			type: 'application/json',
			'plugin-type': 'import',
			text: JSON.stringify({ tiddlers: {} }),
		}),
	);
	await new Promise((r) => setTimeout(r, 60));
	assertEquals($tw.wiki.doesPluginRequireReload('$:/Import'), false);
	assertEquals($tw.wiki.getTiddlerText('$:/status/RequireReloadDueToPluginChange'), 'no');

	// 3.5. Server-side pwa-watcher JS tiddlers do NOT trigger reload
	$tw.wiki.addTiddler(
		new $tw.Tiddler({
			title: '$:/config/push-test/hn-rss-watcher.js',
			type: 'application/javascript',
			'module-type': 'pwa-watcher',
			text: 'export async function evaluate() { return []; }',
		}),
	);
	await new Promise((r) => setTimeout(r, 60));
	assertEquals($tw.wiki.doesPluginRequireReload('$:/config/push-test/hn-rss-watcher.js'), false);
	assertEquals($tw.wiki.getTiddlerText('$:/status/RequireReloadDueToPluginChange'), 'no');

	// 4. Real plugin addition triggers reload warning
	$tw.wiki.addTiddler(
		new $tw.Tiddler({
			title: '$:/plugins/example/testplugin',
			type: 'application/json',
			'plugin-type': 'plugin',
			text: JSON.stringify({ tiddlers: { '$:/plugins/example/testplugin/readme': { text: 'Readme' } } }),
		}),
	);
	await new Promise((r) => setTimeout(r, 60));
	assertEquals($tw.wiki.doesPluginRequireReload('$:/plugins/example/testplugin'), true);
	assertEquals($tw.wiki.getTiddlerText('$:/status/RequireReloadDueToPluginChange'), 'yes');
});

Deno.test('Plugin Reload Detection: Themes, JS modules, and plugin deletions trigger reload warning', async () => {
	const { createRequire } = await import('node:module');
	const require = createRequire(import.meta.url);
	const $tw = setupTiddlyWiki(require);

	// 1. Theme tiddler triggers reload
	const themeTid = new $tw.Tiddler({
		title: '$:/themes/example/cooltheme',
		type: 'application/json',
		'plugin-type': 'theme',
		text: JSON.stringify({ tiddlers: {} }),
	});
	$tw.wiki.addTiddler(themeTid);
	assertEquals($tw.wiki.doesPluginRequireReload('$:/themes/example/cooltheme'), true);

	// 2. Standalone JS module triggers reload
	const jsModTid = new $tw.Tiddler({
		title: '$:/my-widget.js',
		type: 'application/javascript',
		'module-type': 'widget',
		text: 'exports.name = "mywidget";',
	});
	$tw.wiki.addTiddler(jsModTid);
	assertEquals($tw.wiki.doesPluginRequireReload('$:/my-widget.js'), true);

	// 3. Deleting $:/temp/info-plugin does NOT trigger reload
	assertEquals($tw.wiki.doesPluginRequireReload('$:/temp/info-plugin'), false);

	// 4. Deleting a real plugin triggers reload
	const realPlugin = new $tw.Tiddler({
		title: '$:/plugins/test/installed',
		type: 'application/json',
		'plugin-type': 'plugin',
		text: JSON.stringify({ tiddlers: { '$:/plugins/test/installed/file': { text: '123' } } }),
	});
	$tw.wiki.addTiddler(realPlugin);
	$tw.wiki.readPluginInfo(['$:/plugins/test/installed']);
	$tw.wiki.registerPluginTiddlers('plugin', ['$:/plugins/test/installed']);
	$tw.wiki.addTiddler({ title: '$:/status/RequireReloadDueToPluginChange', text: 'no' });

	$tw.wiki.deleteTiddler('$:/plugins/test/installed');
	await new Promise((r) => setTimeout(r, 60));
	assertEquals($tw.wiki.getTiddlerText('$:/status/RequireReloadDueToPluginChange'), 'yes');
});

Deno.test('Plugin Upgrade Flow: same-version plugin re-import is allowed while older version is blocked', async () => {
	const { createRequire } = await import('node:module');
	const require = createRequire(import.meta.url);
	const $tw = setupTiddlyWiki(require);

	const existingPlugin = $tw.wiki.getTiddler('$:/plugins/mblackman/tiddlypwa');
	const currentVersion = existingPlugin.fields.version;

	// 1. Re-importing same version (e.g. rebuilt plugin during development/hotfix) is NOT suppressed
	const sameVerMap: Record<string, any> = {
		'$:/plugins/mblackman/tiddlypwa': {
			...existingPlugin.fields,
			version: currentVersion,
			text: JSON.stringify({ tiddlers: { '$:/plugins/mblackman/tiddlypwa/readme': { text: 'Updated same version' } } }),
		},
	};
	const msgsSame = $tw.wiki.invokeUpgraders(['$:/plugins/mblackman/tiddlypwa'], sameVerMap);
	assertEquals(Object.keys(sameVerMap['$:/plugins/mblackman/tiddlypwa']).length > 0, true);
	assertEquals(msgsSame['$:/plugins/mblackman/tiddlypwa'].includes('Blocked'), false);

	// 2. Importing an older version IS suppressed
	const olderVerMap: Record<string, any> = {
		'$:/plugins/mblackman/tiddlypwa': {
			...existingPlugin.fields,
			version: '0.0.1',
			text: JSON.stringify({ tiddlers: {} }),
		},
	};
	const msgsOlder = $tw.wiki.invokeUpgraders(['$:/plugins/mblackman/tiddlypwa'], olderVerMap);
	assertEquals(Object.keys(olderVerMap['$:/plugins/mblackman/tiddlypwa']).length, 0);
	assertEquals(msgsOlder['$:/plugins/mblackman/tiddlypwa'].includes('Blocked'), true);
});

Deno.test('Plugin Upgrade Flow: unpacking before uploadAppWiki updates shadow tiddlers and ETag matches server', async () => {
	const { createRequire } = await import('node:module');
	const require = createRequire(import.meta.url);
	const $tw = setupTiddlyWiki(require);
	const { SQLiteDatastore } = await import('./sqlite.ts');
	const { TiddlyPWASyncApp } = await import('./app.ts');

	const db = new SQLiteDatastore();
	const app = new TiddlyPWASyncApp(
		db,
		'q6kQ8SNKeaVVQDbhb7TgyqdTp8KAO31rU-6AGT1xG0o',
		'ZnPOVo2E_oWm71aQ-eOX9U3-gIE2hR6nfksboNcLNPQ',
	);
	await app.loadDefaultApp();

	const createResp = await app.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			body: JSON.stringify({ tiddlypwa: 1, op: 'create', atoken: 'test' }),
		}),
	);
	const { token } = await createResp.json();

	// Simulate importing an updated plugin with modified sw.js and app-filter shadow tiddlers
	const existingPlugin = $tw.wiki.getTiddler('$:/plugins/mblackman/tiddlypwa');
	const pluginData = JSON.parse(existingPlugin.fields.text);
	pluginData.tiddlers['$:/plugins/mblackman/tiddlypwa/sw.js'].text += '\n// UPGRADED_SW_MARKER\n';
	$tw.wiki.addTiddler(new $tw.Tiddler(existingPlugin, { version: '99.0.0', text: JSON.stringify(pluginData) }));

	// Unpack plugin tiddlers as uploadAppWiki now does before rendering
	$tw.wiki.readPluginInfo();
	$tw.wiki.registerPluginTiddlers();
	$tw.wiki.unpackPluginTiddlers();

	const publishFilter = $tw.wiki.getTiddlerText('$:/plugins/mblackman/tiddlypwa/app-filter');
	const apphtml = $tw.wiki.renderTiddler('text/plain', '$:/core/save/all', { variables: { publishFilter } });
	const swjs = $tw.wiki.renderTiddler('text/plain', '$:/plugins/mblackman/tiddlypwa/sw.js', {});

	assertEquals(swjs.includes('UPGRADED_SW_MARKER'), true);
	assertEquals(apphtml.includes('UPGRADED_SW_MARKER'), true);

	// Upload to server
	const uploadResp = await app.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				tiddlypwa: 1,
				op: 'uploadapp',
				token,
				authcode: 'test',
				browserToken: 'tab1',
				files: {
					'app.html': { body: apphtml, ctype: 'text/html;charset=utf-8' },
					'sw.js': { body: swjs, ctype: 'application/javascript' },
				},
			}),
		}),
	);
	assertEquals(uploadResp.status, 200);

	// Verify client Base64URL ETag calculation matches server's appEtag in sync response
	const encodingSource = Deno.readTextFileSync('./plugins/tiddlypwa/encoding.js');
	const moduleFn = new Function(
		'$tw',
		'module',
		'atob',
		encodingSource.replace('(function () {', '').replace('})();', ''),
	);
	const encMod: any = { exports: {} };
	moduleFn({ browser: true }, encMod, atob);

	const utfenc = new TextEncoder();
	const clientEtag = `"${await encMod.exports.b64urlEnc(
		await crypto.subtle.digest('SHA-1', utfenc.encode(apphtml)),
	)}-b"`;

	const syncResp = await app.handle(
		new Request('http://example.com/tid.dly', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip, deflate, br' },
			body: JSON.stringify({
				tiddlypwa: 1,
				op: 'sync',
				token,
				authcode: 'test',
				browserToken: 'tab1',
				now: new Date().toISOString(),
				lastSync: new Date(0).toISOString(),
				clientChanges: [],
			}),
		}),
	);
	const syncJson = await syncResp.json();
	assertEquals(clientEtag, syncJson.appEtag);
});
