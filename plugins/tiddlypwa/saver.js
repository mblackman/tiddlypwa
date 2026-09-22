/*\
title: $:/plugins/mblackman/tiddlypwa/saver.js
type: application/javascript
module-type: saver

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/
/// <reference types="npm:tw5-typed" />
(function () {
	'use strict';

	if (!$tw.browser) return;

	class PWASaver {
		info = {
			name: 'TiddlyPWA',
			priority: 6969,
			capabilities: ['save'],
		};

		constructor(wiki) {
			this.wiki = wiki;
		}

		save(_text, _method, _cb, _options) {
			if ($tw.syncadaptor.isReady()) {
				$tw.modal.display('$:/plugins/mblackman/tiddlypwa/save-dialog', {});
			} else {
				alert('No saving in TiddlyPWA installer/documentation mode!');
			}
			return true;
		}
	}

	exports.canSave = (_wiki) => (location.protocol === 'https:' || location.hostname === 'localhost');
	exports.create = (wiki) => new PWASaver(wiki);
})();
