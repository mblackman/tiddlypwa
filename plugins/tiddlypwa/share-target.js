/*\
title: $:/plugins/mblackman/tiddlypwa/share-target.js
type: application/javascript
module-type: startup

Licensed under 0BSD, see license.tid.
\*/
(function () {
	'use strict';

	exports.name = "tiddlypwa-share-target";
	exports.platforms = ["browser"];
	exports.after = ["startup"];
	exports.synchronous = true;

	exports.startup = function () {
		if (typeof window === "undefined" || !window.location) return;

		const params = new URLSearchParams(window.location.search);
		if (params.get('share-target') === '1') {
			const sharedTitle = params.get('title') || '';
			const sharedText = params.get('text') || '';
			const sharedUrl = params.get('url') || '';

			let content = sharedText;
			if (sharedUrl) {
				content += (content ? '\n\n' : '') + sharedUrl;
			}

			const title = "Shared Note: " + (sharedTitle || new $tw.utils.formatDateString(new Date(), "YYYY-0MM-0DD 0hh:0mm:0ss"));

			// Create the new tiddler
			$tw.wiki.addTiddler(new $tw.Tiddler({
				title: title,
				text: content,
				tags: ['Shared', 'Inbox'],
				created: new Date(),
				modified: new Date()
			}));

			// Open it in the story list
			const story = new $tw.Story({ wiki: $tw.wiki });
			story.navigateTiddler(title);

			// Clean up the URL without reloading the page
			const cleanUrl = window.location.pathname + window.location.hash;
			window.history.replaceState({}, document.title, cleanUrl);
		}
	};
})();
