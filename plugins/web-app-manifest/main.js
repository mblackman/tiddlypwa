/*\
title: $:/plugins/mblackman/web-app-manifest/main.js
type: application/javascript
module-type: startup

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/
/// <reference types="npm:tw5-typed" />
(function () {
	'use strict';

	if (!$tw.browser) return;

	exports.startup = function () {
		let link = document.querySelector('head > link[rel=manifest]');
		if (!link) {
			link = document.createElement('link');
			link.rel = 'manifest';
			document.head.appendChild(link);
		}

		function isTiddlerMaybeRelevant(x) {
			return x !== '$:/StoryList' && x !== '$:/HistoryList' && x.startsWith('$:/') && !x.startsWith('$:/state') &&
				!x.startsWith('$:/temp') &&
				!x.startsWith('$:/status');
		}

		function parseIconTiddler(x) {
			const fields = $tw.wiki.getTiddler(x).fields;

			return {
				src: $tw.wiki.isBinaryTiddler(x)
					? `data:${fields.type};base64,${fields.text}`
					: `data:${fields.type},${encodeURIComponent(fields.text)}`,
				type: fields.type,
				sizes: fields.sizes || 'any',
				purpose: fields.purpose || 'any',
			};
		}

		function render() {
			try {
				URL.revokeObjectURL(link.href);
			} catch (_e) { /* probably was initial/empty */ }
			const manifest = {
				name: $tw.wiki.renderTiddler('text/plain', '$:/plugins/mblackman/web-app-manifest/name'),
				display: 'standalone',
				theme_color: $tw.wiki.renderTiddler(
					'text/plain',
					'$:/plugins/mblackman/web-app-manifest/theme-color',
				),
				background_color: $tw.wiki.renderTiddler(
					'text/plain',
					'$:/plugins/mblackman/web-app-manifest/background-color',
				),
				icons: [],
			};
			const iconTids = $tw.wiki.getTiddlersWithTag('$:/tags/ManifestIcon');
			if (iconTids.length == 0 && $tw.wiki.getTiddler('$:/favicon.ico')) {
				iconTids.push('$:/favicon.ico');
			}
			for (const x of iconTids) {
				if (!$tw.wiki.getTiddler(x).isDraft()) {
					manifest.icons.push(parseIconTiddler(x));
				}
			}
			const json = JSON.stringify(manifest);
			link.href = URL.createObjectURL(new Blob([json], { type: 'application/manifest+json' }));
			$tw.__tiddlypwa_manifest__ = json;
		}

		$tw.__update_tiddlypwa_manifest__ = render;
		render();
		$tw.wiki.addEventListener('change', (chg) => {
			if (Object.keys(chg).some(isTiddlerMaybeRelevant)) render();
		});
		$tw.rootWidget.addEventListener('tiddlypwa-get-manifest', (_evt) => {
			const a = document.createElement('a');
			a.href = link.href;
			a.download = 'manifest.json';
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
		});
	};
})();
