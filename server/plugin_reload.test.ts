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
	const bootPath = findTiddlyWikiBoot();
	const $tw = require(bootPath).TiddlyWiki();
	$tw.boot.argv = ['.'];
	$tw.boot.boot();

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
