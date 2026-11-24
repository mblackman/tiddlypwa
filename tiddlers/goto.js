/*\
title: $:/goto.js
tags: [[TiddlyPWA Docs]]
type: application/javascript
module-type: widget

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/
/// <reference types="npm:tw5-typed" />
(function () {
	'use strict';

	if (!$tw.browser) return;

	const Widget = require('$:/core/modules/widgets/widget.js').widget;

	exports['goto-form'] = class extends Widget {
		#parent;
		render(parent, nextSibling) {
			this.computeAttributes();
			if (parent) this.#parent = parent;
			const link = this.document.createElement('a');
			link.className = 'tc-btn-primary';
			link.href = new URL('app/app.html', location.href).href;
			link.textContent = 'Open Local Demo Wiki';
			link.style.display = 'inline-block';
			link.style.marginTop = '0.75rem';
			link.style.padding = '0.5rem 1rem';
			link.style.borderRadius = '4px';
			link.style.background = '#ffedda';
			link.style.color = '#333';
			link.style.border = '1px solid #49411f';
			link.style.textDecoration = 'none';
			this.#parent.insertBefore(link, nextSibling);
			this.domNodes.push(link);
		}

		refresh(_chg) {
			return false;
		}
	};
})();
