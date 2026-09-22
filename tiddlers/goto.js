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
			const form = this.document.createElement('form');
			const input = this.document.createElement('input');
			input.placeholder = 'test';
			form.appendChild(input);
			const button = this.document.createElement('button');
			button.textContent = 'Go!';
			form.appendChild(button);
			let visited = [];
			try {
				visited = JSON.parse(localStorage.visitedWikis || '[]');
				if (!Array.isArray(visited)) visited = [];
			} catch (_e) {
				visited = [];
			}
			if (visited.length > 0) {
				const vdiv = this.document.createElement('div');
				vdiv.textContent = 'Recently visited: ';
				for (const slug of visited) {
					const wlink = this.document.createElement('a');
					wlink.className = 'tpwa-visited-wiki';
					wlink.href = `/w/${slug}/app.html`;
					wlink.textContent = decodeURIComponent(slug);
					const del = this.document.createElement('button');
					del.textContent = '✗';
					del.onclick = (e) => {
						e.stopPropagation();
						e.preventDefault();
						visited = visited.filter((x) => x !== slug);
						localStorage.visitedWikis = JSON.stringify(visited);
						vdiv.removeChild(wlink);
					};
					wlink.appendChild(del);
					vdiv.appendChild(wlink);
				}
				form.appendChild(vdiv);
			}
			form.onsubmit = (e) => {
				e.preventDefault();
				if (input.value.length < 1) input.value = 'test';
				const slug = encodeURIComponent(input.value);
				if (!visited.find((x) => x === slug)) {
					visited.push(slug);
					localStorage.visitedWikis = JSON.stringify(visited);
				}
				location.href = `/w/${slug}/app.html`;
			};
			this.#parent.insertBefore(form, nextSibling);
			this.domNodes.push(form);
		}

		refresh(_chg) {
			return false;
		}
	};
})();
