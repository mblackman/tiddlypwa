/*\
title: $:/plugins/valpackett/tiddlypwa/filters.js
type: application/javascript
module-type: isfilteroperator

Filter function for TiddlyPWA-managed tiddler identification

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/

'use strict';

exports.tiddlypwa = function (source, prefix, options) {
	const results = [];

	const pwaStorage = $tw.syncer.syncadaptor;
	if (!pwaStorage || !pwaStorage.tiddlersInFile) {
		return ['Error: TiddlyPWA not available'];
	}

	if (prefix === '!') {
		source(function (tiddler, title) {
			if (pwaStorage.tiddlersInFile.has(title)) {
				results.push(title);
			}
		});
	} else {
		source(function (tiddler, title) {
			if (!pwaStorage.tiddlersInFile.has(title)) {
				results.push(title);
			}
		});
	}
	return results;
};
