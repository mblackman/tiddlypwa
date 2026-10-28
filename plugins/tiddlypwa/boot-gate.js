/*\
title: $:/plugins/mblackman/tiddlypwa/boot-gate.js
type: application/javascript
module-type: startup

Defers the core "story" and "render" startup tasks until the sync adaptor has loaded the
stored tiddlers (or needs to show interactive UI), so the page is rendered once with the
real wiki content instead of first rendering the app file's tiddlers and then re-rendering.

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/
/// <reference types="npm:tw5-typed" />
(function () {
	'use strict';

	exports.name = 'tiddlypwa-boot-gate';
	exports.platforms = ['browser'];
	exports.after = ['startup', 'rootwidget'];
	exports.before = ['story'];
	exports.synchronous = false;

	// Safety net: never hold the UI back for longer than this, whatever happens.
	const MAX_WAIT_MS = 15000;

	exports.startup = function (callback) {
		const gate = $tw.syncadaptor && $tw.syncadaptor.bootGate;
		if (!gate) return callback();
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			clearTimeout(timer);
			// Mark the adaptor as released too (matters if we got here via the timeout)
			$tw.syncadaptor.releaseBoot?.();
			callback();
		};
		const timer = setTimeout(release, MAX_WAIT_MS);
		gate.then(release, release);
	};
})();
